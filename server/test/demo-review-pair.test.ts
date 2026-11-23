/**
 * Kod recenzenta w `POST /api/pair` na prawdziwym routerze, prawdziwym
 * magazynie `devices.json` w katalogu tymczasowym i prawdziwym parowaniu; zegar parowania i magazynu steruje test.
 *
 * Kod recenzenta (`RAROG_DEMO_REVIEW_CODE`) jest stały: nie zużywa się, nie wygasa i nie odpina innych urządzeń.
 * Sufit 10 aktywnych urządzeń daje 429 `demo-review-full` bez `Retry-After` i bez porażki w dławiku, a log odmów
 * sufitu ma budżet jednej linii na okno dławika. Inny kod idzie dzisiejszą drogą `redeem`.
 *
 * Wartość kodu losuje każdy test w czasie biegu; szpieg loggera po każdym teście sprawdza, że nie ma jej w żadnej
 * linii logu (także w błędzie zapisu, który ją cytuje).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { DEMO_REVIEW_FULL_ERROR } from '@rarog/shared/rest';
import {
  LOGIN_FAILURE_BUDGET, LOGIN_WINDOW_MS, createDeviceStore, createLoginLimiter, createPairing, deviceAuthorization,
} from '../src/auth/index.ts';
import type { DeviceStore, DeviceStoreWrite, Pairing } from '../src/auth/index.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';

const ORIGIN = 'https://demo.rarog.example';
const T0 = Date.parse('2026-11-07T09:00:00.000Z');
const REFUSED_LINE = 'devices: review code refused, 10 active devices (limit 10)';

/** Kod w kształcie kodu parowania (32 losowe bajty base64url), inny w każdym wywołaniu. */
const freshCode = (): string => randomBytes(32).toString('base64url');

interface Harness {
  base: string;
  dir: string;
  store: DeviceStore;
  pairing: Pairing;
  logs: string[];
  setClock(ms: number): void;
  now(): number;
  close(): Promise<void>;
}

interface HarnessOptions {
  /** Kod recenzenta; `null` = bez trybu recenzji. */
  code: string | null;
  /** `production` = serwer poza demo; domyślnie demo. */
  mode?: 'demo' | 'production';
  dir?: string;
  epoch?: string;
  write?: DeviceStoreWrite;
}

const harnesses: Harness[] = [];
/** Wszystkie kody recenzenta użyte w teście — żadnego nie może być w logu. */
const codesInTest: string[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    for (const line of h.logs) {
      for (const code of codesInTest) expect(line.includes(code), `kod recenzenta w logu: ${line}`).toBe(false);
    }
  }
  codesInTest.splice(0);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(opts: HarnessOptions): Promise<Harness> {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), 'a5-recenzja-par-'));
  if (opts.dir === undefined) dirs.push(dir);
  if (opts.code !== null) codesInTest.push(opts.code);
  let clock = T0;
  const logs: string[] = [];
  const logger: Logger = { info: (line) => { logs.push(line); }, error: (line) => { logs.push(line); } };
  const env: NodeJS.ProcessEnv = { RAROG_DATA_DIR: dir, RAROG_ORIGINS: ORIGIN, RAROG_AUTH_EPOCH: opts.epoch ?? '1' };
  if (opts.mode !== 'production') env['RAROG_DEMO'] = '1';
  if (opts.code !== null) env['RAROG_DEMO_REVIEW_CODE'] = opts.code;
  const config = loadConfig(env);
  const store = createDeviceStore({
    dataDir: dir, epoch: config.epoch, now: () => clock, log: (line) => { logs.push(line); },
    ...(opts.write === undefined ? {} : { write: opts.write }),
  });
  const pairing = createPairing({ store, epoch: config.epoch, now: () => clock });
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: T0, logger, loginLimiter: createLoginLimiter(),
    devices: { store, pairing, serverName: 'demo', now: () => clock },
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const h: Harness = {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    dir, store, pairing, logs,
    setClock: (ms) => { clock = ms; },
    now: () => clock,
    close: async () => {
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await store.flush();
    },
  };
  harnesses.push(h);
  return h;
}

/** Zamyka uprząż przed końcem testu (restart na tym samym katalogu); log sprawdza dalej `afterEach`. */
async function stop(h: Harness): Promise<void> {
  await h.close();
  h.close = () => Promise.resolve();
}

interface Reply {
  status: number;
  body: Record<string, unknown> | null;
  headers: Headers;
}

async function call(
  h: Harness, method: 'GET' | 'POST', route: string, body?: unknown, auth?: string,
): Promise<Reply> {
  const res = await fetch(`${h.base}${route}`, {
    method,
    headers: {
      ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}),
      ...(auth === undefined ? {} : { Authorization: auth }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) as Record<string, unknown>, headers: res.headers };
}

const pair = (h: Harness, code: string, label = 'iPhone·Rarog'): Promise<Reply> =>
  call(h, 'POST', '/api/pair', { v: 1, code, label, build: '1700' });

/** Klucz urządzenia z odpowiedzi parowania 200. */
function keyOf(reply: Reply): string {
  expect(reply.status).toBe(200);
  return deviceAuthorization(reply.body?.['deviceId'] as string, reply.body?.['secret'] as string);
}

/** Paruje `count` urządzeń kodem recenzenta i oddaje ich klucze. */
async function fill(h: Harness, code: string, count: number): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) keys.push(keyOf(await pair(h, code, `iPhone·${String(i)}`)));
  return keys;
}

const refusedLines = (h: Harness): string[] => h.logs.filter((line) => line.includes('review code refused'));

describe('kod recenzenta: parowanie', () => {
  it('kod dwa razy → 200 i 200; pierwsze urządzenie dalej 200; rekord `admin` z bieżącą epoką i linia logu', async () => {
    const code = freshCode();
    const h = await start({ code, epoch: '3' });
    const first = await pair(h, code);
    const firstKey = keyOf(first);
    const second = await pair(h, code, 'iPad·Rarog');
    keyOf(second);
    expect((await call(h, 'GET', '/api/version', undefined, firstKey)).status).toBe(200);
    expect(h.store.active()).toHaveLength(2);
    const record = h.store.get(first.body?.['deviceId'] as string);
    expect(record?.creator).toBe('admin');
    expect(record?.epoch).toBe('3');
    for (const reply of [first, second]) {
      expect(h.logs).toContain(`devices: paired ${reply.body?.['deviceId'] as string} (review code)`);
    }
  });

  it('inny kod idzie dzisiejszą drogą: kod z gniazda przy zerze urządzeń 200, zły kod 404 `pair-unknown`', async () => {
    const code = freshCode();
    const h = await start({ code });
    const fromMac = await pair(h, h.pairing.issue('admin', h.now()).code);
    expect(h.logs).toContain(`devices: paired ${fromMac.body?.['deviceId'] as string} (code from the admin socket)`);
    const wrong = await pair(h, freshCode());
    expect(wrong.status).toBe(404);
    expect(wrong.body?.['error']).toBe('pair-unknown');
    expect(h.logs.some((line) => line.startsWith('failed pairing attempt'))).toBe(true);
  });

  it('10 aktywnych + kod → 429 `demo-review-full` bez `Retry-After`; sufit nie zjada budżetu dławika', async () => {
    const code = freshCode();
    const h = await start({ code });
    await fill(h, code, 10);
    const full = await pair(h, code);
    expect(full.status).toBe(429);
    expect(full.body).toEqual({
      error: DEMO_REVIEW_FULL_ERROR,
      message: 'Too many devices are paired with the demo. Try again later.',
      messageRef: { code: 'demo.review-device-limit' },
    });
    expect(DEMO_REVIEW_FULL_ERROR).toBe('demo-review-full');
    expect(full.headers.get('retry-after')).toBeNull();
    for (let i = 0; i < LOGIN_FAILURE_BUDGET; i += 1) {
      const wrong = await pair(h, freshCode());
      expect(wrong.status, `zła próba ${String(i + 1)}`).toBe(404);
    }
    const limited = await pair(h, freshCode());
    expect(limited.status).toBe(429);
    expect(limited.body?.['error']).toBe('too-many-requests');
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(h.store.active()).toHaveLength(10);
  });

  it('pełny sufit: 50 odmów w oknie = 1 linia; po oknie linia z liczbą pominiętych; zwolnione miejsce paruje', async () => {
    const code = freshCode();
    const h = await start({ code });
    const keys = await fill(h, code, 10);
    h.setClock(T0 + 1_000);
    for (let i = 0; i < 50; i += 1) expect((await pair(h, code)).status, `próba ${String(i + 1)}`).toBe(429);
    expect(refusedLines(h)).toEqual([REFUSED_LINE]);
    h.setClock(T0 + 1_000 + LOGIN_WINDOW_MS);
    expect((await pair(h, code)).status).toBe(429);
    expect(refusedLines(h)).toEqual([REFUSED_LINE, `${REFUSED_LINE}, 49 more since the last line`]);
    // Budżet dotyczy tylko linii logu: miejsce zwolnione w tym samym oknie paruje od razu.
    const forgotten = await call(h, 'POST', '/api/devices/forget', {}, keys[0]);
    expect(forgotten.status).toBe(204);
    const again = await pair(h, code);
    expect(again.status).toBe(200);
    expect(h.logs).toContain(`devices: paired ${again.body?.['deviceId'] as string} (review code)`);
    expect(h.store.active()).toHaveLength(10);
  });

  it('9 aktywnych + dwa parowania naraz → dokładnie jedno 200 i jedno 429', async () => {
    const code = freshCode();
    const h = await start({ code });
    await fill(h, code, 9);
    const replies = await Promise.all([pair(h, code, 'iPhone·A'), pair(h, code, 'iPhone·B')]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 429]);
    expect(h.store.active()).toHaveLength(10);
  });

  it('błąd zapisu po przydziale → 500, rekordu nie ma w `store.active`, kod dalej działa; log bez kodu', async () => {
    const code = freshCode();
    let fail = false;
    const h = await start({
      code,
      write: async (target, contents) => {
        // Błąd, który cytuje kod (np. biblioteka wkleja kontekst): `logSecrets` ma go wymazać z linii logu.
        if (fail) throw Object.assign(new Error(`dysk pełny przy ${code}`), { code: 'ENOSPC' });
        await writeFile(target, contents, { mode: 0o600 });
      },
    });
    await h.store.flush();
    fail = true;
    const res = await pair(h, code);
    expect(res.status).toBe(500);
    expect(res.body?.['error']).toBe('internal');
    expect(res.body?.['messageRef']).toEqual({ code: 'rest.pair-save-failed' });
    expect(h.store.active()).toEqual([]);
    expect(h.logs.some((line) => line.includes('record rolled back'))).toBe(true);
    fail = false;
    keyOf(await pair(h, code));
    expect(h.store.active()).toHaveLength(1);
  });

  it('dławik przekroczony złymi kodami → kod recenzenta dalej 200, a dławik zostaje (sukces go nie zeruje)', async () => {
    const code = freshCode();
    const h = await start({ code });
    for (let i = 0; i < LOGIN_FAILURE_BUDGET; i += 1) expect((await pair(h, freshCode())).status).toBe(404);
    expect((await pair(h, freshCode())).status).toBe(429);
    keyOf(await pair(h, code));
    // Kod recenzenta zna więcej niż jedna osoba, więc jego użycie nie legitymuje właściciela jak kod z gniazda.
    expect((await pair(h, freshCode())).status).toBe(429);
  });
});

describe('kod recenzenta: epoka i rotacja', () => {
  it('nowy kod bez nowej epoki → stare klucze 200, stary kod 404; nowa epoka → stare klucze 401', async () => {
    const oldCode = freshCode();
    const a = await start({ code: oldCode, epoch: '1' });
    const firstKey = keyOf(await pair(a, oldCode));
    await stop(a);

    const newCode = freshCode();
    const b = await start({ code: newCode, epoch: '1', dir: a.dir });
    expect((await call(b, 'GET', '/api/version', undefined, firstKey)).status).toBe(200);
    expect((await pair(b, oldCode)).status).toBe(404);
    const secondKey = keyOf(await pair(b, newCode));
    await stop(b);

    const c = await start({ code: freshCode(), epoch: '2', dir: a.dir });
    for (const key of [firstKey, secondKey]) {
      const res = await call(c, 'GET', '/api/version', undefined, key);
      expect(res.status).toBe(401);
    }
  });
});

describe('kod recenzenta: sekret poza logiem i bez trybu recenzji', () => {
  it('`ConfigError` nie niesie kodu, a odmowa sufitu i parowanie nie piszą go do logu', async () => {
    const code = freshCode();
    let message = '';
    try {
      loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_DATA_DIR: tmpdir(), RAROG_DEMO_REVIEW_CODE: code });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('RAROG_DEMO_REVIEW_CODE');
    expect(message.includes(code)).toBe(false);
    const h = await start({ code });
    await fill(h, code, 10);
    expect((await pair(h, code)).status).toBe(429);
    expect(h.logs.length).toBeGreaterThan(10);
  });

  it('bez trybu recenzji kod o tym samym kształcie → 404 `pair-unknown` (demo i serwer)', async () => {
    for (const mode of ['demo', 'production'] as const) {
      const h = await start({ code: null, mode });
      const res = await pair(h, freshCode());
      expect(res.status, mode).toBe(404);
      expect(res.body?.['error'], mode).toBe('pair-unknown');
      expect(h.store.active(), mode).toEqual([]);
    }
  });
});
