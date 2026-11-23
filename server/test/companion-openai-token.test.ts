/**
 * Short-lived OpenAI key of the voice agent: the minter
 * `server/src/companion/openai-token.ts` and the route `POST /api/companion/token` behind the real router.
 *
 * OpenAI is always a `fetch` stand-in: no test reaches the network. The redirect case uses the real `fetch` against a
 * local server that answers 307, and checks that the redirect target never sees a request.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { companionTokenSchema, versionResponseSchema } from '@rarog/shared/rest';
import { deviceAuthorization, hashSecret, pushKeyId, redact } from '../src/auth/index.ts';
import {
  COMPANION_TOKEN_EXPIRES_IN_SECONDS, COMPANION_TOKEN_TIMEOUT_MS, OPENAI_CLIENT_SECRETS_URL,
  createCompanionTokenMinter,
} from '../src/companion/openai-token.ts';
import type { CompanionTokenFetch, CompanionTokenMinter } from '../src/companion/openai-token.ts';
import { companionEnv } from '../src/companion/cli.ts';
import { COMPANION_MODEL_DEFAULT, ConfigError, loadConfig, logSecrets, parseCompanionModel } from '../src/config.ts';
import type { RarogConfig } from '../src/config.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager } from './fake-manager.ts';
import { type TestDevice, createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';
const REVIEW_ORIGIN = 'https://demo.example';
/** Synthetic key: the tests know no real one. */
const KEY = `sk-proj-test-${'Q7w'.repeat(10)}`;
/** Synthetic Soniox key: the voice agent needs the Soniox voice next to the OpenAI key. */
const SONIOX_KEY = `snx-test-${'K4v'.repeat(10)}`;
/** Synthetic short-lived key, as OpenAI would return it. */
const EPHEMERAL = `ek_test_${'Z9y'.repeat(8)}`;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const EXPIRES_AT_S = NOW / 1000 + 60;


interface Call {
  readonly url: string;
  readonly init: Parameters<CompanionTokenFetch>[1];
}

/** `fetch` stand-in: records every call, answers with `reply` (status and JSON, or a thrown error). */
function fakeFetch(
  reply: (call: Call) => Promise<{ status: number; json: () => Promise<unknown> }>,
): { fetch: CompanionTokenFetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      const call = { url, init };
      calls.push(call);
      return reply(call);
    },
  };
}

const ok = (body: unknown = { value: EPHEMERAL, expires_at: EXPIRES_AT_S, session: { type: 'realtime' } }) =>
  (): Promise<{ status: number; json: () => Promise<unknown> }> =>
    Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
const status = (code: number) => (): Promise<{ status: number; json: () => Promise<unknown> }> =>
  Promise.resolve({ status: code, json: () => Promise.resolve({ error: { message: `upstream ${KEY}` } }) });

interface MinterSetup {
  readonly key?: string;
  readonly flag?: '0' | '1';
  readonly model?: string;
  readonly fetch: CompanionTokenFetch;
  readonly timeoutMs?: number;
  readonly minIntervalMs?: number;
}

function minterOf(setup: MinterSetup, logs: string[] = []): CompanionTokenMinter {
  const config = loadConfig({
    RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: tmpdir(), RAROG_COMPANION: setup.flag ?? '1',
    ...(setup.key === undefined ? {} : { OPENAI_API_KEY: setup.key }),
    ...(setup.model === undefined ? {} : { RAROG_COMPANION_MODEL: setup.model }),
  });
  return createCompanionTokenMinter({
    config, fetchImpl: setup.fetch, now: () => NOW, log: (line) => { logs.push(line); },
    ...(setup.timeoutMs === undefined ? {} : { timeoutMs: setup.timeoutMs }),
    ...(setup.minIntervalMs === undefined ? {} : { minIntervalMs: setup.minIntervalMs }),
  });
}

describe('companion token: configuration', () => {
  it('`RAROG_COMPANION_MODEL`: default model; a name outside the pattern stops the start', () => {
    expect(COMPANION_MODEL_DEFAULT).toBe('gpt-realtime-2.1');
    expect(parseCompanionModel(undefined)).toBe(COMPANION_MODEL_DEFAULT);
    expect(parseCompanionModel(' ')).toBe(COMPANION_MODEL_DEFAULT);
    expect(parseCompanionModel('gpt-realtime-2.1-mini')).toBe('gpt-realtime-2.1-mini');
    expect(parseCompanionModel('gpt-realtime')).toBe('gpt-realtime');
    for (const bad of ['gpt-4o', 'GPT-realtime', 'gpt-realtime 2', 'gpt-realtime/x', 'gpt-realtime_2']) {
      expect(() => parseCompanionModel(bad), bad).toThrow(ConfigError);
    }
    expect(() => loadConfig({ RAROG_DEMO: '1', RAROG_COMPANION_MODEL: 'whisper-1' })).toThrow(/RAROG_COMPANION_MODEL/u);
  });

  it('the key is in `logSecrets` also with the flag `0`; `redact` masks it in a message and in a string', () => {
    const config = loadConfig({
      RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: tmpdir(), RAROG_COMPANION: '0', OPENAI_API_KEY: ` ${KEY} `,
    });
    expect(config.openaiApiKey).toBe(KEY);
    expect(logSecrets(config)).toContain(KEY);
    const secrets = logSecrets(config);
    expect(redact(new Error(`fetch failed: Authorization: Bearer ${KEY}`), secrets)).not.toContain(KEY);
    expect(redact(`request with ${KEY} refused`, secrets)).not.toContain(KEY);
  });

  it('`OPENAI_API_KEY` reaches neither `claude -p` nor the terminal nor git', () => {
    const config = loadConfig({
      RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: tmpdir(), HOME: '/Users/demo', USER: 'demo', PATH: '/usr/bin',
      OPENAI_API_KEY: KEY,
    });
    for (const env of [config.companionEnvBase, config.termEnvBase, config.gitEnvBase, companionEnv(config.companionEnvBase)]) {
      expect(Object.keys(env)).not.toContain('OPENAI_API_KEY');
      expect(Object.values(env)).not.toContain(KEY);
    }
  });
});

describe('companion token: minter', () => {
  it('flag `1` without a key → 503 `companion-disabled` with the key sentence, no network', async () => {
    const f = fakeFetch(ok());
    const minter = minterOf({ fetch: f.fetch });
    expect(minter.available).toBe(false);
    const result = await minter.mint();
    expect(result).toMatchObject({ kind: 'refused', status: 503, error: 'companion-disabled' });
    expect(result.kind === 'refused' ? result.sentence.ref.code : '').toBe('rest.companion-openai-key-missing');
    expect(f.calls).toEqual([]);
  });

  it('flag `0` with a key → 503 `companion-disabled`, no network', async () => {
    const f = fakeFetch(ok());
    const minter = minterOf({ key: KEY, flag: '0', fetch: f.fetch });
    expect(minter.available).toBe(false);
    const result = await minter.mint();
    expect(result).toMatchObject({ kind: 'refused', status: 503, error: 'companion-disabled' });
    expect(result.kind === 'refused' ? result.sentence.ref.code : '').toBe('rest.companion-disabled');
    expect(f.calls).toEqual([]);
  });

  it('with a key → `{value, expiresAt, model}`; the request carries the model from the config and `Bearer`', async () => {
    const f = fakeFetch(ok());
    const logs: string[] = [];
    const minter = minterOf({ key: KEY, model: 'gpt-realtime-2.1-mini', fetch: f.fetch }, logs);
    expect(minter.available).toBe(true);
    const result = await minter.mint();
    expect(result).toEqual({
      kind: 'token',
      token: { value: EPHEMERAL, expiresAt: new Date(EXPIRES_AT_S * 1000).toISOString(), model: 'gpt-realtime-2.1-mini' },
    });
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0];
    expect(call?.url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(OPENAI_CLIENT_SECRETS_URL).toBe(call?.url);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(call?.init.body ?? '{}')).toEqual({
      expires_after: { anchor: 'created_at', seconds: COMPANION_TOKEN_EXPIRES_IN_SECONDS },
      session: { type: 'realtime', model: 'gpt-realtime-2.1-mini' },
    });
    expect(COMPANION_TOKEN_EXPIRES_IN_SECONDS).toBe(60);
    for (const line of logs) {
      expect(line).not.toContain(KEY);
      expect(line).not.toContain(EPHEMERAL);
    }
  });

  it('the default model when `RAROG_COMPANION_MODEL` is missing', async () => {
    const f = fakeFetch(ok());
    const result = await minterOf({ key: KEY, fetch: f.fetch }).mint();
    expect(result.kind === 'token' ? result.token.model : '').toBe(COMPANION_MODEL_DEFAULT);
  });

  it.each([
    [401, 503, 'companion-openai-key'],
    [403, 503, 'companion-openai-key'],
    [429, 429, 'companion-openai-limit'],
    [400, 502, 'companion-openai'],
    [500, 502, 'companion-openai'],
    [503, 502, 'companion-openai'],
    [307, 502, 'companion-openai'],
  ])('OpenAI %i → %i `%s`; the log has neither the key nor the upstream body', async (upstream, code, error) => {
    const logs: string[] = [];
    const f = fakeFetch(status(upstream));
    const result = await minterOf({ key: KEY, fetch: f.fetch }, logs).mint();
    expect(result).toMatchObject({ kind: 'refused', status: code, error });
    expect(logs.join('\n')).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain('upstream');
  });

  it.each([
    ['invalid JSON', (): Promise<unknown> => Promise.reject(new SyntaxError(`Unexpected token in ${KEY}`))],
    ['no `value`', (): Promise<unknown> => Promise.resolve({ expires_at: EXPIRES_AT_S })],
    ['empty `value`', (): Promise<unknown> => Promise.resolve({ value: '', expires_at: EXPIRES_AT_S })],
    ['`expires_at` in the past', (): Promise<unknown> => Promise.resolve({ value: EPHEMERAL, expires_at: NOW / 1000 - 1 })],
    ['`expires_at` not a number', (): Promise<unknown> => Promise.resolve({ value: EPHEMERAL, expires_at: '2026' })],
  ])('OpenAI 200 with %s → 502 `companion-openai`', async (_name, json) => {
    const logs: string[] = [];
    const f = fakeFetch(() => Promise.resolve({ status: 200, json }));
    const result = await minterOf({ key: KEY, fetch: f.fetch }, logs).mint();
    expect(result).toMatchObject({ kind: 'refused', status: 502, error: 'companion-openai' });
    expect(logs.join('\n')).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain(EPHEMERAL);
  });

  it('a second request in the throttle window → 429 `companion-throttled` without the network', async () => {
    const f = fakeFetch(ok());
    const minter = minterOf({ key: KEY, fetch: f.fetch });
    expect((await minter.mint()).kind).toBe('token');
    expect(await minter.mint()).toMatchObject({ kind: 'refused', status: 429, error: 'companion-throttled' });
    expect(f.calls).toHaveLength(1);
  });

  it('the throttle counts attempts, not successes', async () => {
    const f = fakeFetch(status(500));
    const minter = minterOf({ key: KEY, fetch: f.fetch });
    expect((await minter.mint()).kind).toBe('refused');
    expect(await minter.mint()).toMatchObject({ status: 429, error: 'companion-throttled' });
    expect(f.calls).toHaveLength(1);
  });

  it('timeout → 502 `companion-openai`; the default timeout is 5 s', async () => {
    expect(COMPANION_TOKEN_TIMEOUT_MS).toBe(5_000);
    const f = fakeFetch((call) => new Promise((_resolve, reject) => {
      call.init.signal.addEventListener('abort', () => { reject(new Error('aborted')); });
    }));
    const logs: string[] = [];
    const result = await minterOf({ key: KEY, fetch: f.fetch, timeoutMs: 20 }, logs).mint();
    expect(result).toMatchObject({ kind: 'refused', status: 502, error: 'companion-openai' });
    expect(logs.some((line) => line.includes('timeout'))).toBe(true);
  });

  it('a `fetch` error with `Bearer <key>` in its text → 502, the log without the key', async () => {
    const logs: string[] = [];
    const f = fakeFetch(() => Promise.reject(new Error(`connect failed; Authorization: Bearer ${KEY}`)));
    const result = await minterOf({ key: KEY, fetch: f.fetch }, logs).mint();
    expect(result).toMatchObject({ kind: 'refused', status: 502, error: 'companion-openai' });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('a cancelled request cancels `fetch` and yields no key', async () => {
    const f = fakeFetch((call) => new Promise((_resolve, reject) => {
      call.init.signal.addEventListener('abort', () => { reject(new Error('aborted')); });
    }));
    const controller = new AbortController();
    const pending = minterOf({ key: KEY, fetch: f.fetch }).mint(controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: 'cancelled' });
    expect(f.calls[0]?.init.signal.aborted).toBe(true);
  });

  it('a redirect with the real `fetch`: an error, and the key never reaches the redirect target', async () => {
    const hits: string[] = [];
    const target = http.createServer((req, res) => {
      hits.push(String(req.headers.authorization));
      res.end('{}');
    });
    await new Promise<void>((resolve) => { target.listen(0, '127.0.0.1', resolve); });
    const targetUrl = `http://127.0.0.1:${String((target.address() as AddressInfo).port)}/stolen`;
    const origin = http.createServer((_req, res) => {
      res.writeHead(307, { Location: targetUrl });
      res.end();
    });
    await new Promise<void>((resolve) => { origin.listen(0, '127.0.0.1', resolve); });
    const originUrl = `http://127.0.0.1:${String((origin.address() as AddressInfo).port)}/v1/realtime/client_secrets`;
    try {
      const realFetch: CompanionTokenFetch = (_url, init) => fetch(originUrl, init);
      const result = await minterOf({ key: KEY, fetch: realFetch }).mint();
      expect(result).toMatchObject({ kind: 'refused', status: 502, error: 'companion-openai' });
      expect(hits).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => { target.close(() => { resolve(); }); });
      await new Promise<void>((resolve) => { origin.close(() => { resolve(); }); });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The route behind the real router
// ---------------------------------------------------------------------------------------------------------------

const SECOND_DEVICE_ID = 'e5f6a7b8'.repeat(4);
const SECOND_DEVICE_SECRET = Buffer.alloc(32, 9).toString('base64url');

interface Harness {
  readonly base: string;
  /** `Origin` the server allows (review mode takes one https origin). */
  readonly origin: string;
  readonly device: TestDevice;
  readonly second: string;
  readonly config: RarogConfig;
  readonly logs: string[];
  readonly calls: Call[];
  close(): Promise<void>;
}

interface HarnessOptions {
  readonly key?: boolean;
  readonly flag?: '0' | '1';
  readonly demo?: 'demo' | 'review';
  readonly reply?: (call: Call) => Promise<{ status: number; json: () => Promise<unknown> }>;
  readonly minIntervalMs?: number;
  /** Replaces the real minter (a route failure the router has to log). */
  readonly minter?: CompanionTokenMinter;
}

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function start(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'rarog-companion-token-'));
  const env = {
    RAROG_COMPANION: opts.flag ?? '1', RAROG_DATA_DIR: dir,
    ...(opts.key === false ? {} : { OPENAI_API_KEY: KEY }),
    // The voice agent speaks only with the Soniox voice: without this key there is no agent (synthetic value).
    SONIOX_API_KEY: SONIOX_KEY,
  };
  const config = opts.demo === undefined
    ? loadConfig({ ...env, RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: dir })
    : loadConfig({
      ...env, RAROG_DEMO: '1',
      ...(opts.demo === 'review'
        ? { RAROG_DEMO_REVIEW_CODE: randomBytes(32).toString('base64url'), RAROG_ORIGINS: REVIEW_ORIGIN }
        : {}),
    });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const at = new Date().toISOString();
  const secondPush = Buffer.alloc(32, 4).toString('base64url');
  device.store.add({
    id: SECOND_DEVICE_ID, secretHash: hashSecret(SECOND_DEVICE_SECRET), pushKey: secondPush, kid: pushKeyId(secondPush),
    label: 'iPad·test', build: null, createdAt: at, lastSeenAt: at, epoch: config.epoch, creator: 'admin',
  });
  const logs: string[] = [];
  const logger: Logger = { info: (line) => { logs.push(line); }, error: (line) => { logs.push(line); } };
  const f = fakeFetch(opts.reply ?? ok({ value: EPHEMERAL, expires_at: Date.now() / 1000 + 60 }));
  const companionToken = opts.minter ?? createCompanionTokenMinter({
    config, fetchImpl: f.fetch, log: (line) => { logs.push(line); },
    ...(opts.minIntervalMs === undefined ? {} : { minIntervalMs: opts.minIntervalMs }),
  });
  const manager = new FakeManager([]);
  const hub = new SseHub({ manager, serverStartId: 'start', protocolVersion: 1, heartbeatMs: 0 });
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start', startedAtMs: Date.now(), logger, devices: device.identity,
    companionToken, companion: { ask: () => Promise.reject(new Error('not used')) },
  }));
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const h: Harness = {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    origin: opts.demo === 'review' ? REVIEW_ORIGIN : ORIGIN,
    device, second: deviceAuthorization(SECOND_DEVICE_ID, SECOND_DEVICE_SECRET), config, logs, calls: f.calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      hub.closeAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  open.push(h);
  return h;
}

function token(
  h: Harness, opts: { auth?: string | null; origin?: string; body?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  const auth = opts.auth === undefined ? h.device.authorization : opts.auth;
  return fetch(`${h.base}/api/companion/token`, {
    method: 'POST',
    headers: {
      Origin: opts.origin ?? h.origin, 'Content-Type': 'application/json', ...(auth === null ? {} : { Authorization: auth }),
    },
    body: opts.body ?? '{}',
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
}

async function errorOf(res: Response): Promise<{ error: string; code: string | undefined }> {
  const body = await res.json() as { error: string; messageRef?: { code: string } };
  return { error: body.error, code: body.messageRef?.code };
}

async function companionEnabled(h: Harness): Promise<boolean> {
  const res = await fetch(`${h.base}/api/version`, { headers: { Authorization: h.device.authorization } });
  return versionResponseSchema.parse(await res.json()).companionEnabled;
}

describe('companion token: `POST /api/companion/token`', () => {
  it('flag `1` without a key → 503 `companion-disabled` and `companionEnabled: false`', async () => {
    const h = await start({ key: false });
    const res = await token(h);
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toEqual({ error: 'companion-disabled', code: 'rest.companion-openai-key-missing' });
    expect(await companionEnabled(h)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('flag `0` with a key → 503 and `companionEnabled: false`', async () => {
    const h = await start({ flag: '0' });
    expect((await token(h)).status).toBe(503);
    expect(await companionEnabled(h)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('with a key → 200 `{value, expiresAt, model}` with `no-store`, and `companionEnabled: true`', async () => {
    const h = await start();
    expect(await companionEnabled(h)).toBe(true);
    const res = await token(h);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = companionTokenSchema.parse(await res.json());
    expect(body.value).toBe(EPHEMERAL);
    expect(body.model).toBe(COMPANION_MODEL_DEFAULT);
    expect(h.calls[0]?.init.headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(h.logs.join('\n')).not.toContain(KEY);
    expect(h.logs.join('\n')).not.toContain(EPHEMERAL);
  });

  it('no credential → 401, a wrong credential → 401, a foreign `Origin` → 403, extra body fields → 400; no network',
    async () => {
      const h = await start();
      expect((await token(h, { auth: null })).status).toBe(401);
      expect((await token(h, { auth: deviceAuthorization('f'.repeat(32), 'x'.repeat(43)) })).status).toBe(401);
      expect((await token(h, { origin: 'https://evil.example' })).status).toBe(403);
      const extra = await token(h, { body: JSON.stringify({ model: 'gpt-realtime-mini' }) });
      expect(extra.status).toBe(400);
      expect((await token(h, { body: '[]' })).status).toBe(400);
      expect(h.calls).toEqual([]);
    });

  it.each(['demo', 'review'] as const)('demo mode (%s) with a key and flag `1` → 404 without the network', async (demo) => {
    const h = await start({ demo });
    const res = await token(h);
    expect(res.status).toBe(404);
    expect((await errorOf(res)).error).toBe('not-found');
    expect(await companionEnabled(h)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('two devices in the throttle window: the second one gets 429 `companion-throttled`', async () => {
    const h = await start();
    expect((await token(h)).status).toBe(200);
    const second = await token(h, { auth: h.second });
    expect(second.status).toBe(429);
    expect((await errorOf(second)).error).toBe('companion-throttled');
    expect(h.calls).toHaveLength(1);
  });

  it('the device is revoked while `fetch` waits → 401, the key does not leave', async () => {
    let release: (() => void) | undefined;
    const h = await start({
      reply: () => new Promise((resolve) => {
        release = () => {
          resolve({ status: 200, json: () => Promise.resolve({ value: EPHEMERAL, expires_at: Date.now() / 1000 + 60 }) });
        };
      }),
    });
    const pending = token(h);
    await waitFor(() => h.calls.length === 1);
    h.device.store.revoke(h.device.id, 'admin');
    release?.();
    const res = await pending;
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(EPHEMERAL);
    expect(JSON.parse(text)).toMatchObject({ error: 'device-revoked' });
  });

  it('a closed request cancels `fetch`', async () => {
    const h = await start({
      reply: (call) => new Promise((_resolve, reject) => {
        call.init.signal.addEventListener('abort', () => { reject(new Error('aborted')); });
      }),
    });
    const controller = new AbortController();
    const pending = token(h, { signal: controller.signal }).catch(() => null);
    await waitFor(() => h.calls.length === 1);
    controller.abort();
    await pending;
    await waitFor(() => h.calls[0]?.init.signal.aborted === true);
  });

  it('a `fetch` error with the key in its text: neither the log nor the error body has the key', async () => {
    const h = await start({ reply: () => Promise.reject(new Error(`boom Bearer ${KEY}`)) });
    const res = await token(h);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ error: 'companion-openai' });
    expect(h.logs.join('\n')).not.toContain(KEY);
  });

  it.each([
    ['an `Error` message', (): Promise<never> => Promise.reject(new Error(`request failed for ${KEY}`))],
    ['a thrown string', (): Promise<never> => Promise.reject(`request with ${KEY} refused`)],
  ])('the key verbatim in %s that reaches the router → the log line masked, also with the flag `0`', async (_name, mint) => {
    const h = await start({ flag: '0', minter: { available: false, mint } });
    const res = await token(h);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(KEY);
    const logged = h.logs.join('\n');
    expect(logged).toContain('unhandled router error');
    expect(logged).not.toContain(KEY);
  });

  it('OpenAI 401 → 503 `companion-openai-key`, the body without the key', async () => {
    const h = await start({ reply: status(401) });
    const res = await token(h);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ error: 'companion-openai-key' });
  });
});

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
}
