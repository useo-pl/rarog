/**
 * Temporary Soniox speech key of the voice agent: the kind `COMPANION_SPEECH_KEY` of the minter
 * `server/src/voice/soniox.ts` and the route `POST /api/companion/speech-token` behind the real router, with the
 * `companionEnabled` and `companionSpeech` fields of `GET /api/version`. The voice agent speaks only with the Soniox
 * voice: without it the server does not offer the agent, and the short-lived OpenAI key route refuses too.
 *
 * Soniox is always a stand-in: the router is built while `globalThis.fetch` is stubbed, so the minters it makes by
 * default (dictation and speech) keep the stand-in, and the stub is removed before the test talks to the server.
 * No test reaches the network.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { companionSpeechTokenSchema, versionResponseSchema } from '@rarog/shared/rest';
import { voiceTokenSchema } from '@rarog/shared';
import { VOICE_TOKEN_HOURLY_CAP, VOICE_TOKEN_MIN_INTERVAL_MS, loadConfig } from '../src/config.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import {
  COMPANION_SPEECH_KEY, SONIOX_API_ORIGIN, SONIOX_TEMP_KEY_PATH, type FetchLike, createVoiceMinter,
} from '../src/voice/soniox.ts';
import { FakeManager } from './fake-manager.ts';
import { type TestDevice, createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';
const REVIEW_ORIGIN = 'https://demo.example';
/** Synthetic keys: the tests know no real one. */
const SONIOX_KEY = `snx-test-${'K4v'.repeat(10)}`;
const OPENAI_KEY = `sk-proj-test-${'Q7w'.repeat(10)}`;
const TEMPORARY = `snx_temp_${'T2t'.repeat(8)}`;
const EXPIRES_AT = '2026-11-11T12:10:00.000Z';

/** The real `fetch`, taken before any stub: the tests talk to the server with it. */
const httpFetch: typeof fetch = globalThis.fetch.bind(globalThis);

interface SonioxCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

type SonioxReply = (call: SonioxCall) => Promise<{ status: number; json: () => Promise<unknown> }>;

const minted: SonioxReply = () => Promise.resolve({
  status: 201, json: () => Promise.resolve({ api_key: TEMPORARY, expires_at: EXPIRES_AT }),
});
const status = (code: number): SonioxReply => () => Promise.resolve({
  status: code, json: () => Promise.resolve({ error: `upstream ${SONIOX_KEY}` }),
});

describe('companion speech: `RAROG_COMPANION_SPEECH` is withdrawn', () => {
  it('the server never reads the name; any value starts and changes nothing', () => {
    const base = { RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: tmpdir(), RAROG_COMPANION: '1' };
    const reads = new Set<string>();
    // Reads by name only: no key listing, so the bulk read of git variables does not count as a read of every name.
    const spy = (values: NodeJS.ProcessEnv): NodeJS.ProcessEnv => new Proxy({ ...values }, {
      get(target, key, receiver) {
        if (typeof key === 'string') reads.add(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
      ownKeys: () => [],
    });
    const without = loadConfig(spy(base));
    for (const value of ['0', '1', 'on']) {
      const config = loadConfig(spy({ ...base, RAROG_COMPANION_SPEECH: value }));
      expect(config, value).toEqual(without);
      expect(Object.keys(config), value).not.toContain('companionSpeech');
    }
    expect(reads.has('RAROG_COMPANION_SPEECH')).toBe(false);
    expect(() => loadConfig({ RAROG_DEMO: '1', RAROG_COMPANION_SPEECH: 'on' })).not.toThrow();
  });
});

describe('companion speech: the minter kind', () => {
  it('asks Soniox for a plain `tts_rt` key: 600 s, 180 s per stream, not `single_use`; the token is pinned', async () => {
    const calls: SonioxCall[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      return minted(calls[calls.length - 1] as SonioxCall);
    };
    const logs: string[] = [];
    const minter = createVoiceMinter({
      apiKey: SONIOX_KEY, fetchImpl, minIntervalMs: VOICE_TOKEN_MIN_INTERVAL_MS, hourlyCap: VOICE_TOKEN_HOURLY_CAP,
      log: (line) => { logs.push(line); },
    }, COMPANION_SPEECH_KEY);
    const result = await minter.mint();
    expect(result).toEqual({
      ok: true,
      token: {
        apiKey: TEMPORARY, expiresAt: EXPIRES_AT, webSocketUri: 'wss://tts-rt.eu.soniox.com/tts-websocket',
        model: 'tts-rt-v2', voice: 'Maya', sampleRate: 24000,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SONIOX_API_ORIGIN}${SONIOX_TEMP_KEY_PATH}`);
    expect(calls[0]?.headers['Authorization']).toBe(`Bearer ${SONIOX_KEY}`);
    const { client_reference_id: reference, ...body } = calls[0]?.body ?? {};
    expect(body).toEqual({
      usage_type: 'tts_rt', expires_in_seconds: 600, single_use: false, max_session_duration_seconds: 180,
    });
    expect(typeof reference).toBe('string');
    expect(logs).toEqual([`companion speech: temporary key valid until ${EXPIRES_AT}`]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The route behind the real router
// ---------------------------------------------------------------------------------------------------------------

interface Harness {
  readonly base: string;
  readonly origin: string;
  readonly device: TestDevice;
  readonly logs: string[];
  readonly calls: SonioxCall[];
  close(): Promise<void>;
}

interface HarnessOptions {
  /** `RAROG_COMPANION_SPEECH` in the environment; missing = not set (the name is withdrawn, the value is ignored). */
  readonly speechFlag?: string;
  readonly sonioxKey?: boolean;
  readonly sonioxHost?: string;
  readonly openaiKey?: boolean;
  readonly demo?: 'demo' | 'review';
  readonly reply?: SonioxReply;
}

const open: Harness[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const h of open.splice(0)) await h.close();
});

async function start(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'rarog-companion-speech-'));
  const env = {
    RAROG_COMPANION: '1', RAROG_DATA_DIR: dir,
    ...(opts.speechFlag === undefined ? {} : { RAROG_COMPANION_SPEECH: opts.speechFlag }),
    ...(opts.sonioxKey === false ? {} : { SONIOX_API_KEY: SONIOX_KEY }),
    ...(opts.sonioxHost === undefined ? {} : { SONIOX_API_HOST: opts.sonioxHost }),
    ...(opts.openaiKey === false ? {} : { OPENAI_API_KEY: OPENAI_KEY }),
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
  const logs: string[] = [];
  const logger: Logger = { info: (line) => { logs.push(line); }, error: (line) => { logs.push(line); } };
  const calls: SonioxCall[] = [];
  const reply = opts.reply ?? minted;
  // The router's default minters take `globalThis.fetch` when they are built; the stub goes away right after.
  vi.stubGlobal('fetch', (url: string, init: { headers: Record<string, string>; body: string }) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> };
    calls.push(call);
    return reply(call);
  });
  const manager = new FakeManager([]);
  const hub = new SseHub({ manager, serverStartId: 'start', protocolVersion: 1, heartbeatMs: 0 });
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start', startedAtMs: Date.now(), logger, devices: device.identity,
    companion: { ask: () => Promise.reject(new Error('not used')) },
  }));
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const h: Harness = {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    origin: opts.demo === 'review' ? REVIEW_ORIGIN : ORIGIN,
    device, logs, calls,
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

function post(
  h: Harness, route: string, opts: { auth?: string | null; origin?: string; body?: string } = {},
): Promise<Response> {
  const auth = opts.auth === undefined ? h.device.authorization : opts.auth;
  return httpFetch(`${h.base}${route}`, {
    method: 'POST',
    headers: {
      Origin: opts.origin ?? h.origin, 'Content-Type': 'application/json', ...(auth === null ? {} : { Authorization: auth }),
    },
    body: opts.body ?? '{}',
  });
}

const speechToken = (h: Harness, opts?: Parameters<typeof post>[2]): Promise<Response> =>
  post(h, '/api/companion/speech-token', opts);

async function errorOf(res: Response): Promise<{ status: number; error: string; code: string | undefined }> {
  const body = await res.json() as { error: string; messageRef?: { code: string } };
  return { status: res.status, error: body.error, code: body.messageRef?.code };
}

async function versionOf(h: Harness): Promise<{ companionSpeech: boolean; companionEnabled: boolean }> {
  const res = await httpFetch(`${h.base}/api/version`, { headers: { Authorization: h.device.authorization } });
  const version = versionResponseSchema.parse(await res.json());
  return { companionSpeech: version.companionSpeech, companionEnabled: version.companionEnabled };
}

const unconfigured = (code: string): { status: number; error: string; code: string } => ({
  status: 503, error: 'companion-speech-unconfigured', code,
});

describe('companion speech: `POST /api/companion/speech-token`', () => {
  it.each(['demo', 'review'] as const)('demo mode (%s) with keys and flag `1` → 404 without the network', async (demo) => {
    const h = await start({ demo });
    const res = await speechToken(h);
    expect(res.status).toBe(404);
    expect((await errorOf(res)).error).toBe('not-found');
    expect((await versionOf(h)).companionSpeech).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it.each(['0', '1'])('`RAROG_COMPANION_SPEECH=%s` in the environment changes nothing: both keys → both fields true',
    async (speechFlag) => {
      const h = await start({ speechFlag });
      expect(await versionOf(h)).toEqual({ companionSpeech: true, companionEnabled: true });
    });

  it('the voice agent off (no OpenAI key) → 503 off and `companionSpeech: false`, without the network', async () => {
    const h = await start({ openaiKey: false });
    expect(await errorOf(await speechToken(h))).toEqual(unconfigured('rest.companion-speech-disabled'));
    expect(await versionOf(h)).toEqual({ companionSpeech: false, companionEnabled: false });
    expect(h.calls).toEqual([]);
  });

  it('no Soniox key → 503 with the key sentence and no voice agent at all, without the network', async () => {
    const h = await start({ sonioxKey: false });
    expect(await errorOf(await speechToken(h))).toEqual(unconfigured('rest.companion-speech-key-missing'));
    expect(await versionOf(h)).toEqual({ companionSpeech: false, companionEnabled: false });
    expect(h.calls).toEqual([]);
  });

  it('a Soniox host outside the EU → 503 with the region sentence and no voice agent at all, without the network',
    async () => {
      const h = await start({ sonioxHost: 'https://api.soniox.com' });
      expect(await errorOf(await speechToken(h))).toEqual(unconfigured('rest.companion-speech-foreign-region'));
      expect(await versionOf(h)).toEqual({ companionSpeech: false, companionEnabled: false });
      expect(h.calls).toEqual([]);
    });

  it('everything set → `companionSpeech: true`, 200 with the contract body and `no-store`; logs without keys',
    async () => {
      const h = await start();
      expect(await versionOf(h)).toEqual({ companionSpeech: true, companionEnabled: true });
      const res = await speechToken(h);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const text = await res.text();
      expect(text).not.toContain(SONIOX_KEY);
      const body = JSON.parse(text) as unknown;
      expect(companionSpeechTokenSchema.strict().parse(body)).toEqual({
        apiKey: TEMPORARY, expiresAt: EXPIRES_AT, webSocketUri: 'wss://tts-rt.eu.soniox.com/tts-websocket',
        model: 'tts-rt-v2', voice: 'Maya', sampleRate: 24000,
      });
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]?.body).toMatchObject({
        usage_type: 'tts_rt', expires_in_seconds: 600, single_use: false, max_session_duration_seconds: 180,
      });
      const logged = h.logs.join('\n');
      expect(logged).not.toContain(SONIOX_KEY);
      expect(logged).not.toContain(TEMPORARY);
    });

  it('no credential → 401, a foreign `Origin` → 403, a field in the body → 400, GET → 405; no network', async () => {
    const h = await start();
    expect((await speechToken(h, { auth: null })).status).toBe(401);
    expect((await speechToken(h, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await speechToken(h, { body: JSON.stringify({ voice: 'Other' }) })).status).toBe(400);
    expect((await speechToken(h, { body: '[]' })).status).toBe(400);
    const get = await httpFetch(`${h.base}/api/companion/speech-token`, { headers: { Authorization: h.device.authorization } });
    expect(get.status).toBe(405);
    expect(h.calls).toEqual([]);
  });

  it('Soniox 401 → 503 with the sentence that says to fix the key; the body without the key', async () => {
    const h = await start({ reply: status(401) });
    const res = await speechToken(h);
    const text = await res.text();
    expect(text).not.toContain(SONIOX_KEY);
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({
      error: 'companion-speech-unconfigured', messageRef: { code: 'rest.companion-speech-key-rejected' },
    });
  });

  it('Soniox 500 → 502 `companion-speech-upstream`', async () => {
    const h = await start({ reply: status(500) });
    expect(await errorOf(await speechToken(h))).toEqual({
      status: 502, error: 'companion-speech-upstream', code: 'rest.companion-speech-upstream',
    });
  });

  it('a second attempt within 3 s → 429 `companion-speech-throttled` without the network', async () => {
    const h = await start({ reply: status(500) });
    expect((await speechToken(h)).status).toBe(502);
    expect(await errorOf(await speechToken(h))).toEqual({
      status: 429, error: 'companion-speech-throttled', code: 'rest.companion-throttled',
    });
    expect(h.calls).toHaveLength(1);
  });

  it('the dictation throttle is apart: a speech key and a dictation key in the same second both pass', async () => {
    const h = await start();
    expect((await speechToken(h)).status).toBe(200);
    const dictation = await post(h, '/api/voice/token');
    expect(dictation.status).toBe(200);
    expect(voiceTokenSchema.parse(await dictation.json()).apiKey).toBe(TEMPORARY);
    expect(h.calls.map((call) => [call.body['usage_type'], call.body['single_use']])).toEqual([
      ['tts_rt', false], ['transcribe_websocket', true],
    ]);
    // Each minter still throttles its own next attempt.
    expect((await post(h, '/api/voice/token')).status).toBe(429);
    expect((await speechToken(h)).status).toBe(429);
  });

  it('dictation first: the speech key in the same second still passes', async () => {
    const h = await start();
    expect((await post(h, '/api/voice/token')).status).toBe(200);
    expect((await speechToken(h)).status).toBe(200);
    expect(h.calls).toHaveLength(2);
  });

  it('the device is revoked while Soniox answers → 401, the key does not leave', async () => {
    let release: (() => void) | undefined;
    const h = await start({
      reply: () => new Promise((resolve) => {
        release = () => {
          resolve({ status: 201, json: () => Promise.resolve({ api_key: TEMPORARY, expires_at: EXPIRES_AT }) });
        };
      }),
    });
    const pending = speechToken(h);
    await waitFor(() => h.calls.length === 1);
    h.device.store.revoke(h.device.id, 'admin');
    release?.();
    const res = await pending;
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(TEMPORARY);
    expect(JSON.parse(text)).toMatchObject({ error: 'device-revoked' });
  });
});

describe('companion speech: no Soniox voice, no voice agent', () => {
  const openaiToken = (h: Harness): Promise<Response> => post(h, '/api/companion/token');

  it('the OpenAI key without a Soniox key → the short-lived OpenAI key route refuses, without the network', async () => {
    const h = await start({ sonioxKey: false });
    expect(await errorOf(await openaiToken(h))).toEqual({
      status: 503, error: 'companion-disabled', code: 'rest.companion-speech-key-missing',
    });
    expect(await versionOf(h)).toEqual({ companionSpeech: false, companionEnabled: false });
    expect(h.calls).toEqual([]);
  });

  it('a Soniox key outside the EU → the short-lived OpenAI key route refuses, without the network', async () => {
    const h = await start({ sonioxHost: 'https://api.soniox.com' });
    expect(await errorOf(await openaiToken(h))).toEqual({
      status: 503, error: 'companion-disabled', code: 'rest.companion-speech-disabled',
    });
    expect(h.calls).toEqual([]);
  });

  it('without the OpenAI key the refusal names the OpenAI key, as before', async () => {
    const h = await start({ openaiKey: false });
    expect(await errorOf(await openaiToken(h))).toEqual({
      status: 503, error: 'companion-disabled', code: 'rest.companion-openai-key-missing',
    });
    expect(h.calls).toEqual([]);
  });
});

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
}
