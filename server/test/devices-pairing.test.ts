/**
 * Parowanie kodem i klucze urządzeń na prawdziwym routerze.
 *
 * Prawdziwy router na porcie efemerycznym, prawdziwy magazyn `devices.json` w katalogu tymczasowym,
 * prawdziwe parowanie; zegar parowania sterowany z testu. Sprawdza:
 * - jednorazowość kodu, dwa równoległe zużycia, termin (także na granicy i po opóźnionym ciele), złe próby
 *   nie palą oczekującego kodu, sierotę po zgubionej odpowiedzi, restart w trakcie, błąd zapisu;
 * - kod z urządzenia: nowy unieważnia poprzedni, odpięcie twórcy (także w trakcie odbierania ciała),
 *   `forget` i `revoke --all` unieważniają kody, kod `admin` odmówiony przy aktywnym urządzeniu — także gdy
 *   zapis pierwszego parowania jeszcze trwa;
 * - macierz uprawnień `POST /api/pairings` i `GET /api/devices` (cookie niczego nie otwiera), Origin bez
 *   zmian, trasy `/api/admin/*` niedostępne na porcie, dławik, 401 `device-revoked` z datą;
 * - odpięcie zamyka trwający strumień SSE; push `device-paired` po odpowiedzi i tylko do pozostałych;
 * - gniazdo administracyjne: prawa `0o700`/`0o600`, żywe gniazdo innego procesu nietknięte, martwe zastąpione.
 *
 * WebSocket terminala z kluczem urządzenia i jego zamknięcie przy odpięciu: `term-integration.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import {
  ADMIN_SOCKET_FILENAME, DEVICE_ORPHAN_MS, PAIRING_CODE_TTL_MS, adminSocketPath, createAdminHandler,
  createDeviceStore, createLoginLimiter, createPairing, deviceAuthorization, pairingLink, publicUrlOf, redact,
  startAdminSocket,
} from '../src/auth/index.ts';
import type { AdminSocket, DeviceRecord, DeviceStore, DeviceStoreWrite, LoginLimiter, Pairing } from '../src/auth/index.ts';
import { DEVICE_AUTH_SCHEME } from '../src/auth/device.ts';
import { loadConfig } from '../src/config.ts';
import { CONSENT_ADMIN_ROUTES, CONSENT_REGISTER_ROUTE } from '../src/herdr/dialogs/layer1/contract.ts';
import { attachDeactivation, devicePairedNotifier } from '../src/device-effects.ts';
import { createApnsDeviceStore } from '../src/notify/apns-devices.ts';
import type { ApnsDeviceStore } from '../src/notify/apns-devices.ts';
import type { ApnsSink } from '../src/notify/apns-sink.ts';
import type { PushContent } from '../src/notify/content.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { scan } from './source-scan.ts';

/** Nagłówek `Cookie` w kształcie dawnego logowania tokenem: serwer go nie czyta, więc niczego nie otwiera. */
const OLD_COOKIE = { Cookie: `rarog_auth=1.${String(Date.parse('2026-10-21T09:00:00.000Z'))}.${'a'.repeat(64)}` };
const ORIGIN = 'http://localhost:8930';
const T0 = Date.parse('2026-10-21T09:00:00.000Z');

interface Harness {
  base: string;
  dir: string;
  store: DeviceStore;
  pairing: Pairing;
  apns: ApnsDeviceStore;
  manager: FakeManager;
  logs: string[];
  setClock(ms: number): void;
  now(): number;
  close(): Promise<void>;
}

interface HarnessOptions {
  write?: DeviceStoreWrite;
  sink?: Pick<ApnsSink, 'sendWhere'>;
  limiter?: LoginLimiter;
  /** Restart: ten sam katalog danych co poprzednia instancja (nowe parowanie w pamięci). */
  dir?: string;
  /** Serwer poza demo (konfiguracja produkcyjna z `RAROG_ORIGINS`), nie demo. */
  production?: boolean;
}

const harnesses: Harness[] = [];

async function start(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), 'p2-par-'));
  let clock = T0;
  const logs: string[] = [];
  const logger: Logger = { info: (line) => { logs.push(line); }, error: (line) => { logs.push(line); } };
  const config = loadConfig(opts.production === true
    ? { RAROG_DEMO: '', RAROG_ORIGINS: ORIGIN, RAROG_DATA_DIR: dir }
    : { RAROG_DEMO: '1', RAROG_DATA_DIR: dir });
  const store = createDeviceStore({
    dataDir: dir, epoch: config.epoch, now: () => clock, log: (line) => { logs.push(line); },
    ...(opts.write === undefined ? {} : { write: opts.write }),
  });
  const pairing = createPairing({ store, epoch: config.epoch, now: () => clock });
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const apns = createApnsDeviceStore({ dataDir: path.join(dir, 'apns'), now: () => clock });
  attachDeactivation(store, { pairing, hub, log: (line) => { logs.push(line); }, apns: {
    devices: apns, liveActivity: { forgetDevice: () => {} },
  } });
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: T0, logger,
    loginLimiter: opts.limiter ?? createLoginLimiter(),
    // Kanał APNs z atrapami nadajnika i Live Activity: rejestr tokenów jest prawdziwy (odpięcie go czyści).
    apns: {
      devices: apns, sink: { sendTo: () => Promise.resolve('delivered') }, sender: {
        statusOf: (record) => ({ degradedSince: record.degradedSince }), awaitRoute: () => Promise.resolve('direct'),
        awaitPending: () => Promise.resolve(),
      },
      liveActivity: { register: () => 'started', end: () => true, forgetDevice: () => {} }, now: () => clock,
      topic: 'ai.rarog.app',
    },
    devices: {
      store, pairing, serverName: 'mac-test', now: () => clock,
      onPaired: devicePairedNotifier(store, opts.sink, (line) => { logs.push(line); }),
    },
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const h: Harness = {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    dir, store, pairing, apns, manager, logs,
    setClock: (ms) => { clock = ms; },
    now: () => clock,
    close: async () => {
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await store.flush();
      await apns.flush();
    },
  };
  harnesses.push(h);
  return h;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    dirs.push(h.dir);
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Reply { status: number; body: unknown; headers: Headers }

async function call(
  h: Harness, method: string, route: string, headers: Record<string, string> = {}, body?: unknown,
): Promise<Reply> {
  const res = await fetch(`${h.base}${route}`, {
    method,
    headers: { ...(method === 'GET' ? {} : { Origin: ORIGIN, 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown, headers: res.headers };
}

interface Paired { id: string; secret: string; auth: Record<string, string>; pushKey: string }

async function pair(h: Harness, code: string, label = 'iPhone·Rarog'): Promise<Paired> {
  const res = await call(h, 'POST', '/api/pair', {}, { v: 1, code, label, build: '1700', pushFormats: [1, 2] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const body = res.body as { deviceId: string; secret: string; pushKey: string };
  return {
    id: body.deviceId, secret: body.secret, pushKey: body.pushKey,
    auth: { Authorization: deviceAuthorization(body.deviceId, body.secret) },
  };
}

/** Pierwsze urządzenie z kodu `admin` (jak `rarog pair`) i jego pierwsze żądanie. */
async function firstDevice(h: Harness, label = 'iPhone·Rarog'): Promise<Paired> {
  const device = await pair(h, h.pairing.issue('admin').code, label);
  expect((await call(h, 'GET', '/api/devices/me', device.auth)).status).toBe(200);
  return device;
}

/**
 * `POST /api/pair` z ciałem wysłanym DOPIERO po `release()` — kontrolowane zatrzymanie przed zużyciem
 * kodu (router czyta całe ciało, zanim zrobi krok zużycia).
 */
function slowPair(h: Harness, body: unknown): { release(): void; reply: Promise<Reply> } {
  const url = new URL(`${h.base}/api/pair`);
  const payload = JSON.stringify(body);
  let release = (): void => {};
  const reply = new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) as unknown, headers: new Headers() });
      });
    });
    req.on('error', reject);
    req.write(payload.slice(0, 5));
    release = () => { req.end(payload.slice(5)); };
  });
  return { release: () => { release(); }, reply };
}

/**
 * Dowolne żądanie z ciałem wysłanym DOPIERO po `release()` (pierwsze 5 bajtów od razu) — odpięcie urządzenia
 * w trakcie odbierania ciała.
 */
function slowRequest(
  h: Harness, method: string, route: string, headers: Record<string, string>, body: unknown,
): { release(): void; reply: Promise<Reply> } {
  const url = new URL(`${h.base}${route}`);
  const payload = JSON.stringify(body);
  let release = (): void => {};
  const reply = new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname, method,
      headers: {
        Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) as unknown, headers: new Headers() });
      });
    });
    req.on('error', reject);
    req.write(payload.slice(0, 5));
    release = () => { req.end(payload.slice(5)); };
  });
  return { release: () => { release(); }, reply };
}

/** Czeka, aż router zacznie czytać ciało (pierwszy fragment doszedł) — krótki, stały odstęp. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 50); });

describe('POST /api/pair — kod jednorazowy, termin, wyścigi', () => {
  it('pierwsze urządzenie z kodu z Maca: odpowiedź raz z sekretem, ten sam kod drugi raz → 404 `pair-unknown`', async () => {
    const h = await start();
    const code = h.pairing.issue('admin').code;
    const device = await pair(h, code);
    expect(h.store.get(device.id)?.creator).toBe('admin');
    const again = await call(h, 'POST', '/api/pair', {}, { v: 1, code, label: 'x' });
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject({ error: 'pair-unknown' });
    // Sekret zostaje u klienta: w pliku jest tylko skrót.
    await h.store.flush();
    const disk = JSON.stringify(h.store.active());
    expect(disk).not.toContain(device.secret);
  });

  it('dwa równoległe zużycia tego samego kodu: jedno 200, drugie 404 — rekord jeden', async () => {
    const h = await start();
    const code = h.pairing.issue('admin').code;
    const replies = await Promise.all([1, 2].map((n) => call(h, 'POST', '/api/pair', {}, { v: 1, code, label: `u${String(n)}` })));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(h.store.active()).toHaveLength(1);
  });

  it('termin: kod ważny do `expiresAt` - 1 ms, od `expiresAt` — 404, także po OPÓŹNIONYM ciele', async () => {
    const h = await start();
    const early = h.pairing.issue('admin');
    const late = slowPair(h, { v: 1, code: early.code, label: 'spóźnione' });
    await settle();
    h.setClock(early.expiresAt);
    late.release();
    expect((await late.reply).status).toBe(404);
    h.setClock(T0);
    const edge = h.pairing.issue('admin');
    const onTime = slowPair(h, { v: 1, code: edge.code, label: 'na granicy' });
    await settle();
    h.setClock(edge.expiresAt - 1);
    onTime.release();
    expect((await onTime.reply).status).toBe(200);
    expect(edge.expiresAt - T0).toBe(PAIRING_CODE_TTL_MS);
  });

  it('złe próby nie palą oczekującego kodu; zły kształt kodu to też 404, nieznane `v` — 400 `pair-version`', async () => {
    const h = await start();
    const code = h.pairing.issue('admin').code;
    for (const bad of ['A'.repeat(43), 'krótki', `${code.slice(0, -1)}x`]) {
      expect((await call(h, 'POST', '/api/pair', {}, { v: 1, code: bad, label: 'x' })).status, bad).toBe(404);
    }
    const future = await call(h, 'POST', '/api/pair', {}, { v: 2, code, label: 'x', nowe: true });
    expect(future).toMatchObject({ status: 400, body: { error: 'pair-version' } });
    await pair(h, code);
  });

  it('sierota po zgubionej odpowiedzi: rekord bez żądania wygasa po 10 min, a kod z gniazda znów przysługuje', async () => {
    const h = await start();
    const admin = createAdminHandler({ store: h.store, pairing: h.pairing, publicUrl: null, log: () => {}, now: h.now });
    const issued = await adminCall(admin, 'POST', '/api/admin/pairings');
    await pair(h, (issued.body as { code: string }).code);
    expect((await adminCall(admin, 'POST', '/api/admin/pairings')).status).toBe(409);
    h.setClock(T0 + DEVICE_ORPHAN_MS);
    expect(h.store.active()).toEqual([]);
    const status = await adminCall(admin, 'GET', `/api/admin/pairings/${(issued.body as { pairingId: string }).pairingId}`);
    expect(status.body).toMatchObject({ state: 'lost' });
    expect((await adminCall(admin, 'POST', '/api/admin/pairings')).status).toBe(200);
  });

  it('restart w trakcie: kod wydany przed restartem nie istnieje po nim (404), rekordy zostają', async () => {
    const h = await start();
    const device = await firstDevice(h);
    const code = h.pairing.issue(device.id).code;
    await h.close();
    harnesses.splice(harnesses.indexOf(h), 1);
    const after = await start({ dir: h.dir });
    expect((await call(after, 'POST', '/api/pair', {}, { v: 1, code, label: 'x' })).status).toBe(404);
    expect(after.store.get(device.id)?.label).toBe('iPhone·Rarog');
  });

  it('błąd zapisu cofa rekord: 500, urządzenie nieaktywne, kod spalony', async () => {
    let fail = false;
    const h = await start({
      write: async (target, contents) => {
        if (fail) throw Object.assign(new Error('dysk pełny'), { code: 'ENOSPC' });
        const { writeFile } = await import('node:fs/promises');
        await writeFile(target, contents, { mode: 0o600 });
      },
    });
    await h.store.flush();
    fail = true;
    const code = h.pairing.issue('admin').code;
    const res = await call(h, 'POST', '/api/pair', {}, { v: 1, code, label: 'x' });
    expect(res.status).toBe(500);
    expect(h.store.active()).toEqual([]);
    fail = false;
    expect((await call(h, 'POST', '/api/pair', {}, { v: 1, code, label: 'x' })).status).toBe(404);
    expect(h.logs.some((line) => line.includes('record rolled back'))).toBe(true);
  });
});

describe('kod dla nowego urządzenia wydaje sparowane urządzenie', () => {
  it('drugie urządzenie z kodu wydanego na pierwszym; `creator` w rekordzie i na liście', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const issued = await call(h, 'POST', '/api/pairings', phone.auth, {});
    expect(issued.status).toBe(200);
    const pad = await pair(h, (issued.body as { code: string }).code, 'iPad·Rarog');
    const list = await call(h, 'GET', '/api/devices', phone.auth);
    expect((list.body as { devices: { id: string; creator: string; current: boolean }[] }).devices).toEqual([
      expect.objectContaining({ id: phone.id, creator: 'admin', current: true }),
      expect.objectContaining({ id: pad.id, creator: phone.id, current: false }),
    ]);
    expect(JSON.stringify(list.body)).not.toMatch(/secretHash|pushKey|"kid"/);
  });

  it('nowy kod unieważnia poprzedni tego samego twórcy', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const first = (await call(h, 'POST', '/api/pairings', phone.auth, {})).body as { code: string };
    const second = (await call(h, 'POST', '/api/pairings', phone.auth, {})).body as { code: string };
    expect((await call(h, 'POST', '/api/pair', {}, { v: 1, code: first.code, label: 'x' })).status).toBe(404);
    await pair(h, second.code, 'iPad·Rarog');
  });

  it('odpięcie twórcy między wydaniem a zużyciem (zatrzymanie przed zużyciem) → 404', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const code = ((await call(h, 'POST', '/api/pairings', phone.auth, {})).body as { code: string }).code;
    const pending = slowPair(h, { v: 1, code, label: 'iPad·Rarog' });
    await settle();
    h.store.revoke(phone.id, 'admin');
    pending.release();
    expect((await pending.reply).status).toBe(404);
  });

  it('kod twórcy, który wygasł (30 dni bez użycia) w czasie odbierania ciała, też 404', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const code = h.pairing.issue(phone.id).code;
    // Twórca nadal ma rekord, ale zegar przeskakuje za jego termin — krok zużycia sprawdza aktywność.
    const store = h.store.get(phone.id) as DeviceRecord;
    const pending = slowPair(h, { v: 1, code, label: 'x' });
    await settle();
    h.setClock(Date.parse(store.lastSeenAt ?? store.createdAt) + 30 * 24 * 60 * 60 * 1000);
    pending.release();
    expect((await pending.reply).status).toBe(404);
  });

  it('`forget` i `revoke --all` unieważniają kody jak `revoke`', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const viaForget = ((await call(h, 'POST', '/api/pairings', phone.auth, {})).body as { code: string }).code;
    expect((await call(h, 'POST', '/api/devices/forget', phone.auth, {})).status).toBe(204);
    expect((await call(h, 'POST', '/api/pair', {}, { v: 1, code: viaForget, label: 'x' })).status).toBe(404);
    expect(h.store.tombstone(phone.id)?.revokedBy).toBe('forget');

    const second = await firstDevice(h, 'iPad·Rarog');
    const viaAll = ((await call(h, 'POST', '/api/pairings', second.auth, {})).body as { code: string }).code;
    h.store.revokeAll('admin');
    expect((await call(h, 'POST', '/api/pair', {}, { v: 1, code: viaAll, label: 'x' })).status).toBe(404);
  });

  it('kod z gniazda przy aktywnym urządzeniu: odmowa przy wydaniu i przy zużyciu', async () => {
    const h = await start();
    const admin = createAdminHandler({ store: h.store, pairing: h.pairing, publicUrl: null, log: () => {}, now: h.now });
    const stale = h.pairing.issue('admin');
    await pair(h, stale.code);
    const refused = await adminCall(admin, 'POST', '/api/admin/pairings');
    expect(refused).toMatchObject({ status: 409, body: { error: 'device-active' } });
    expect((refused.body as { message: string }).message).toContain('Settings → Pairing → Pair New Device');
    // Krok zużycia sprawdza aktywnych także sam (obrona, gdyby kod `admin` przeżył parowanie).
    const sneaky = h.pairing.issue('admin');
    expect((await call(h, 'POST', '/api/pair', {}, { v: 1, code: sneaky.code, label: 'x' })).status).toBe(404);
  });

  it('dwa kody z gniazda przy pustym magazynie: paruje się najwyżej jedno urządzenie', async () => {
    const h = await start();
    const a = h.pairing.issue('admin');
    const b = h.pairing.issue('admin');
    const replies = await Promise.all([a, b].map((code) => call(h, 'POST', '/api/pair', {}, { v: 1, code: code.code, label: 'x' })));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(h.store.active()).toHaveLength(1);
  });

  it('zatrzymanie po zużyciu kodu A przed końcem zapisu: wydanie i zużycie kodu B odmówione', async () => {
    let unblock = (): void => {};
    let blocked = false;
    const h = await start({
      write: async (target, contents) => {
        if (blocked) await new Promise<void>((resolve) => { unblock = resolve; });
        const { writeFile } = await import('node:fs/promises');
        await writeFile(target, contents, { mode: 0o600 });
      },
    });
    await h.store.flush();
    const admin = createAdminHandler({ store: h.store, pairing: h.pairing, publicUrl: null, log: () => {}, now: h.now });
    const a = ((await adminCall(admin, 'POST', '/api/admin/pairings')).body as { code: string }).code;
    blocked = true;
    const first = call(h, 'POST', '/api/pair', {}, { v: 1, code: a, label: 'pierwsze' });
    await settle();
    // Zapis A wisi, ale rekord A już jest aktywny: kod B z gniazda nie przysługuje…
    expect((await adminCall(admin, 'POST', '/api/admin/pairings')).status).toBe(409);
    // …a kod `admin` wydany obok bramki gniazda nie przejdzie kroku zużycia.
    const b = h.pairing.issue('admin').code;
    blocked = false;
    expect((await call(h, 'POST', '/api/pair', {}, { v: 1, code: b, label: 'drugie' })).status).toBe(404);
    unblock();
    expect((await first).status).toBe(200);
    expect(h.store.active().map((r) => r.label)).toEqual(['pierwsze']);
  });
});

describe('the creator of a pairing code cancels it at once', () => {
  /** A code from a paired device (`POST /api/pairings`). */
  const codeFrom = async (h: Harness, device: Paired): Promise<string> =>
    ((await call(h, 'POST', '/api/pairings', device.auth, {})).body as { code: string }).code;
  const redeem = (h: Harness, code: string): Promise<Reply> =>
    call(h, 'POST', '/api/pair', {}, { v: 1, code, label: 'x' });

  it('`DELETE /api/pairings`: 204 without a body, the code then gives 404 `pair-unknown`; 204 also with no code', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const code = await codeFrom(h, phone);
    expect(await call(h, 'DELETE', '/api/pairings', phone.auth)).toMatchObject({ status: 204, body: null });
    expect(await redeem(h, code)).toMatchObject({ status: 404, body: { error: 'pair-unknown' } });
    expect(await call(h, 'DELETE', '/api/pairings', phone.auth)).toMatchObject({ status: 204, body: null });
  });

  it('`DELETE /api/pairings` leaves the codes of other creators alone', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const pad = await pair(h, await codeFrom(h, phone), 'iPad·Rarog');
    const fromPhone = await codeFrom(h, phone);
    const fromPad = await codeFrom(h, pad);
    expect((await call(h, 'DELETE', '/api/pairings', pad.auth)).status).toBe(204);
    expect((await redeem(h, fromPad)).status).toBe(404);
    await pair(h, fromPhone, 'Mac·Rarog');
  });

  it('`DELETE /api/pairings` needs the key, the Origin and an empty body; a refusal leaves the code alive', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const code = await codeFrom(h, phone);
    expect((await call(h, 'DELETE', '/api/pairings')).status).toBe(401);
    expect((await call(h, 'DELETE', '/api/pairings', OLD_COOKIE)).status).toBe(401);
    const noOrigin = await fetch(`${h.base}/api/pairings`, { method: 'DELETE', headers: phone.auth });
    expect(noOrigin.status).toBe(403);
    expect(await call(h, 'DELETE', '/api/pairings', phone.auth, { all: true }))
      .toMatchObject({ status: 400, body: { error: 'bad-request' } });
    const other = await call(h, 'GET', '/api/pairings', phone.auth);
    expect(other.status).toBe(405);
    expect(other.headers.get('allow')).toBe('POST, DELETE');
    await pair(h, code, 'iPad·Rarog');
  });

  it('admin socket `DELETE /api/admin/pairings/:id`: 204 for a pending or expired code, 404 unknown, 409 redeemed', async () => {
    const h = await start();
    const admin = createAdminHandler({ store: h.store, pairing: h.pairing, publicUrl: null, log: () => {}, now: h.now });
    const issue = async (): Promise<{ pairingId: string; code: string }> =>
      (await adminCall(admin, 'POST', '/api/admin/pairings')).body as { pairingId: string; code: string };
    const route = (issued: { pairingId: string }): string => `/api/admin/pairings/${issued.pairingId}`;

    const pending = await issue();
    expect(await adminCall(admin, 'DELETE', route(pending))).toMatchObject({ status: 204, body: null });
    expect((await adminCall(admin, 'GET', route(pending))).body).toEqual({ state: 'expired' });
    expect((await redeem(h, pending.code)).status).toBe(404);
    expect((await adminCall(admin, 'DELETE', route(pending))).status).toBe(204);

    // A code replaced by a newer one is expired: cancelling it leaves the newer code alive.
    const replaced = await issue();
    const newer = await issue();
    expect((await adminCall(admin, 'DELETE', route(replaced))).status).toBe(204);
    expect((await adminCall(admin, 'GET', route(newer))).body).toMatchObject({ state: 'pending' });
    h.setClock(h.now() + PAIRING_CODE_TTL_MS);
    expect((await adminCall(admin, 'DELETE', route(newer))).status).toBe(204);

    expect(await adminCall(admin, 'DELETE', '/api/admin/pairings/unknown'))
      .toMatchObject({ status: 404, body: { error: 'pairing-unknown' } });
    expect((await adminCall(admin, 'POST', route(newer))).status).toBe(405);

    const used = await issue();
    const device = await pair(h, used.code);
    expect(await adminCall(admin, 'DELETE', route(used))).toMatchObject({ status: 409, body: { error: 'pairing-redeemed' } });
    expect(h.store.get(device.id)).toBeDefined();
    expect((await adminCall(admin, 'GET', route(used))).body).toMatchObject({ state: 'redeemed', deviceId: device.id });
  });
});

/** Text direction override U+202E and ESC, from code points: an escape in the source may be expanded to a raw one. */
const RLO = String.fromCodePoint(0x202e);
const ESC = String.fromCodePoint(0x1b);

describe('label and build of a device on the way in and out', () => {
  it('pairing keeps a build only as digits; the device list cleans a record written before the rule', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const res = await call(h, 'POST', '/api/pair', {}, {
      v: 1, code: h.pairing.issue(phone.id).code, label: `iPad${RLO}x`, build: `${ESC}[31m1`,
    });
    expect(res.status).toBe(200);
    expect(h.store.get((res.body as { deviceId: string }).deviceId)).toMatchObject({ label: 'iPadx', build: null });

    const template = h.store.get(phone.id);
    if (template === undefined) throw new Error('no record');
    h.store.add({ ...template, id: 'e'.repeat(32), label: `old${RLO}label`, build: '1.2' });
    const list = await call(h, 'GET', '/api/devices', phone.auth);
    expect((list.body as { devices: unknown[] }).devices)
      .toContainEqual(expect.objectContaining({ id: 'e'.repeat(32), label: 'oldlabel', build: null }));
    expect(JSON.stringify(list.body)).not.toContain(RLO);
  });
});

describe('macierz uprawnień: trasy tylko dla klucza urządzenia, cookie niczego nie otwiera', () => {
  it('`POST /api/pairings` i `GET /api/devices`: brak, samo cookie, odpięte, wygasłe, zły klucz obok cookie', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const pad = await pair(h, ((await call(h, 'POST', '/api/pairings', phone.auth, {})).body as { code: string }).code, 'iPad');
    await call(h, 'GET', '/api/devices/me', pad.auth);
    const routes: [string, string, unknown][] = [['POST', '/api/pairings', {}], ['GET', '/api/devices', undefined]];
    for (const [method, route, body] of routes) {
      expect((await call(h, method, route, {}, body)).status, `${route}: brak`).toBe(401);
      expect((await call(h, method, route, OLD_COOKIE, body)), `${route}: cookie`)
        .toMatchObject({ status: 401, body: { error: 'unauthorized' } });
      const wrong = { Authorization: deviceAuthorization(phone.id, 'Q'.repeat(43)), ...OLD_COOKIE };
      expect((await call(h, method, route, wrong, body)), `${route}: zły klucz + cookie`)
        .toMatchObject({ status: 401, body: { error: 'device-unknown' } });
    }
    h.store.revoke(pad.id, 'admin');
    for (const [method, route, body] of routes) {
      const res = await call(h, method, route, { ...pad.auth, ...OLD_COOKIE }, body);
      expect(res, `${route}: odpięte`).toMatchObject({ status: 401, body: { error: 'device-revoked', revokedBy: 'admin' } });
      expect((res.body as { revokedAt: string }).revokedAt).toBe(new Date(h.now()).toISOString());
    }
    h.setClock(T0 + 31 * 24 * 60 * 60 * 1000);
    for (const [method, route, body] of routes) {
      expect((await call(h, method, route, phone.auth, body)), `${route}: wygasłe`)
        .toMatchObject({ status: 401, body: { error: 'device-revoked', revokedBy: 'expired' } });
    }
  });

  it('`/api/devices/me` i `forget` też tylko z kluczem; klucz działa w zwykłym REST (`/api/version`)', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    expect((await call(h, 'GET', '/api/devices/me', OLD_COOKIE)).status).toBe(401);
    expect((await call(h, 'POST', '/api/devices/forget', OLD_COOKIE, {})).status).toBe(401);
    const me = await call(h, 'GET', '/api/devices/me', phone.auth);
    expect(me.body).toMatchObject({ device: { id: phone.id, current: true }, serverId: h.store.serverId });
    expect((await call(h, 'GET', '/api/version', phone.auth)).status).toBe(200);
  });

  it('Origin bez zmian: mutacja z kluczem urządzenia bez Origin → 403, także `POST /api/pair`', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const noOrigin = await fetch(`${h.base}/api/pairings`, {
      method: 'POST', headers: { ...phone.auth, 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(noOrigin.status).toBe(403);
    const pairNoOrigin = await fetch(`${h.base}/api/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, code: h.pairing.issue(phone.id).code, label: 'x' }),
    });
    expect(pairNoOrigin.status).toBe(403);
  });

  it('trasy `/api/admin/*` i rejestracji kanału zgód nie istnieją na porcie: bez klucza (także z samym cookie) 401, z kluczem 404', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const consentRoutes = [...CONSENT_ADMIN_ROUTES, CONSENT_REGISTER_ROUTE].map((route) => ['POST', route]);
    for (const [method, route] of [['POST', '/api/admin/pairings'], ['GET', '/api/admin/devices'], ['POST', '/api/admin/devices/revoke'], ...consentRoutes]) {
      expect((await call(h, method as string, route as string, {}, method === 'POST' ? {} : undefined)).status).toBe(401);
      expect((await call(h, method as string, route as string, OLD_COOKIE, method === 'POST' ? {} : undefined)).status).toBe(401);
      expect((await call(h, method as string, route as string, phone.auth, method === 'POST' ? { all: true } : undefined)).status).toBe(404);
    }
    expect(h.store.active()).toHaveLength(1);
  });
});

/*
 * Serwer poza demo: jedynym poświadczeniem jest klucz urządzenia. Parowanie, REST, SSE i rejestracja APNs
 * działają nim, a cookie niczego nie otwiera. Terminal (WebSocket) w tym samym ustawieniu: `term-integration.test.ts`.
 */
describe('serwer poza demo: klucz urządzenia jedynym poświadczeniem', () => {
  it('parowanie, REST, SSE, drugie urządzenie i rejestracja APNs kluczem; cookie → 401', async () => {
    const h = await start({ production: true });
    const phone = await firstDevice(h);
    expect((await call(h, 'GET', '/api/version', phone.auth)).status).toBe(200);
    const stream = await fetch(`${h.base}/api/stream`, { headers: phone.auth });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    await stream.body?.cancel();
    const code = ((await call(h, 'POST', '/api/pairings', phone.auth, {})).body as { code: string }).code;
    const pad = await pair(h, code, 'iPad');
    expect((await call(h, 'GET', '/api/devices/me', pad.auth)).status).toBe(200);
    const register = {
      token: 'c'.repeat(64), environment: 'development', label: 'iPhone', alerts: true, topic: 'ai.rarog.app',
    };
    expect((await call(h, 'POST', '/api/push/apns', phone.auth, register)).status).toBe(204);
    expect(h.apns.list()).toMatchObject([{ token: 'c'.repeat(64), deviceId: phone.id, topic: 'ai.rarog.app' }]);
    for (const [method, route, body] of [['GET', '/api/version', undefined], ['GET', '/api/stream', undefined],
      ['POST', '/api/push/apns', register], ['POST', '/api/pairings', {}]] as [string, string, unknown][]) {
      expect((await call(h, method, route, OLD_COOKIE, body)).status, `${route}: cookie`).toBe(401);
    }
  });
});

describe('dławik, log i `redact`', () => {
  it('nieznany klucz i zły kod liczą się do jednego budżetu; poprawny kod przechodzi także przy 429', async () => {
    const h = await start({ limiter: createLoginLimiter({ budget: 3, windowMs: 60_000 }) });
    const code = h.pairing.issue('admin').code;
    const bogus = { Authorization: deviceAuthorization('a'.repeat(32), 'B'.repeat(43)) };
    expect((await call(h, 'GET', '/api/version', bogus)).status).toBe(401);
    expect((await call(h, 'POST', '/api/pair', {}, { v: 1, code: 'C'.repeat(43), label: 'x' })).status).toBe(404);
    expect((await call(h, 'GET', '/api/version', bogus)).status).toBe(401);
    const limited = await call(h, 'GET', '/api/version', bogus);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect((await call(h, 'POST', '/api/pair', {}, { v: 1, code: 'D'.repeat(43), label: 'x' })).status).toBe(429);
    await pair(h, code);
    expect(h.logs.filter((line) => line.startsWith('failed '))).toEqual([
      'failed device key attempt (127.0.0.1)',
      expect.stringContaining('budget 3'),
    ]);
  });

  it('log parowania niesie identyfikator i twórcę, nigdy sekret, klucz push ani kod; `redact` zakrywa nagłówek', async () => {
    const h = await start();
    const code = h.pairing.issue('admin').code;
    const device = await pair(h, code);
    const all = h.logs.join('\n');
    expect(all).toContain(`paired ${device.id}`);
    for (const secret of [device.secret, device.pushKey, code]) expect(all).not.toContain(secret);
    const header = deviceAuthorization(device.id, device.secret);
    const err = new Error(`fetch failed: ${header}`);
    expect(redact(err)).not.toContain(device.secret);
    expect(redact({ headers: { authorization: header }, pushKey: device.pushKey, secret: device.secret }))
      .not.toMatch(new RegExp(`${device.secret}|${device.pushKey}`));
    expect(redact(`Authorization: ${header}`)).toBe(`Authorization: ${DEVICE_AUTH_SCHEME} [ukryte]`);
    expect(redact(`a ${header.toLowerCase()} b`)).not.toContain(device.secret.toLowerCase());
  });
});

describe('odpięcie w trakcie odbierania ciała: akcja się nie wykonuje', () => {
  const token = 'e'.repeat(64);
  const registration = { token, environment: 'development', label: 'iPhone', alerts: true, topic: 'ai.rarog.app' };

  it('`POST /api/push/apns`: ciało dokończone po odpięciu → 401 `device-revoked`, token NIE wraca do rejestru', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const pending = slowRequest(h, 'POST', '/api/push/apns', phone.auth, registration);
    await settle();
    h.store.revoke(phone.id, 'admin');
    pending.release();
    const res = await pending.reply;
    expect(res).toMatchObject({ status: 401, body: { error: 'device-revoked', revokedBy: 'admin' } });
    expect(h.apns.list()).toEqual([]);
    expect(h.logs.some((line) => line.includes('unpaired while receiving the body of POST /api/push/apns'))).toBe(true);
  });

  it('decyzja na karcie zgody: ciało dokończone po odpięciu → 401, manager nie dostaje decyzji', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const pending = slowRequest(h, 'POST', '/api/sessions/s1/permission', phone.auth, { decision: 'deny' });
    await settle();
    h.store.revoke(phone.id, 'admin');
    pending.release();
    expect((await pending.reply).status).toBe(401);
    expect(h.manager.calls.filter((call) => call.method === 'resolvePermission')).toEqual([]);
  });

  it('strażnik: router czyta ciało WYŁĄCZNIE przez `readJsonBody`, w którym stoi ponowne sprawdzenie', () => {
    const code = scan(readFileSync(path.resolve(import.meta.dirname, '../src/router.ts'), 'utf8')).code;
    // `export function readBody(` i jedno wywołanie — w `readJsonBody`; strumień ciała czyta tylko `readBody`.
    expect(code.match(/\breadBody\(/g)).toHaveLength(2);
    expect(code.match(/\.on\('data'/g)).toHaveLength(1);
    const reader = code.slice(code.indexOf('async function readJsonBody('), code.indexOf('function parseBody'));
    expect(reader).toMatch(/await readBody\(req, maxBytes\);\s*const recheck = bodyRechecks\.get\(req\);\s*if \(recheck/);
  });

  it('bez odpięcia te same wolne żądania przechodzą; odpięcie innego urządzenia ich nie zatrzymuje', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const padCode = ((await call(h, 'POST', '/api/pairings', phone.auth, {})).body as { code: string }).code;
    const pad = await pair(h, padCode, 'iPad');
    const viaDevice = slowRequest(h, 'POST', '/api/push/apns', phone.auth, registration);
    await settle();
    viaDevice.release();
    expect((await viaDevice.reply).status).toBe(204);
    expect(h.apns.get(token)?.deviceId).toBe(phone.id);
    const viaPad = slowRequest(h, 'POST', '/api/sessions/s1/permission', pad.auth, { decision: 'deny' });
    await settle();
    h.store.revoke(phone.id, 'admin');
    viaPad.release();
    // Decyzja doszła do managera (atrapa oddaje `gone`, czyli 410): ponowne sprawdzenie dotyczy klucza TEGO żądania.
    expect((await viaPad.reply).status).toBe(410);
    expect(h.manager.calls.some((call) => call.method === 'resolvePermission')).toBe(true);
    // Odpięcie skasowało token zarejestrowany kluczem urządzenia.
    expect(h.apns.get(token)).toBeUndefined();
  });
});

describe('odpięcie zamyka trwające połączenia i kasuje tokeny APNs', () => {
  it('strumień SSE otwarty kluczem urządzenia kończy się przy odpięciu; strumień drugiego urządzenia płynie dalej', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const padCode = ((await call(h, 'POST', '/api/pairings', phone.auth, {})).body as { code: string }).code;
    const pad = await pair(h, padCode, 'iPad');
    const deviceStream = await fetch(`${h.base}/api/stream`, { headers: phone.auth });
    const padStream = await fetch(`${h.base}/api/stream`, { headers: pad.auth });
    expect(deviceStream.status).toBe(200);
    const reader = deviceStream.body?.getReader();
    if (reader === undefined) throw new Error('brak strumienia');
    await reader.read();
    h.store.revoke(phone.id, 'admin');
    let done = false;
    for (let i = 0; i < 20 && !done; i += 1) done = (await reader.read()).done;
    expect(done).toBe(true);
    expect(h.logs.some((line) => line.includes(`${phone.id} revoked (admin) — streams: 1`))).toBe(true);
    // Ponowne otwarcie tym kluczem: 401 `device-revoked`.
    expect((await call(h, 'GET', '/api/stream', phone.auth)).body).toMatchObject({ error: 'device-revoked' });
    expect(padStream.status).toBe(200);
    await padStream.body?.cancel();
  });

  it('rejestracja APNs kluczem urządzenia niesie `deviceId`; odpięcie kasuje tylko jego tokeny', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    h.apns.upsert({ token: 'a'.repeat(64), environment: 'development', label: 'iPhone', alerts: true, deviceId: phone.id, topic: 'ai.rarog.app' });
    h.apns.upsert({ token: 'b'.repeat(64), environment: 'development', label: 'iPad', alerts: true, deviceId: 'b'.repeat(32), topic: 'ai.rarog.app' });
    h.store.revoke(phone.id, 'admin');
    expect(h.apns.list().map((r) => r.token)).toEqual(['b'.repeat(64)]);
  });
});

describe('revoking a device revokes the devices paired through it', () => {
  /** Phone from the Mac, iPad with a code from the phone, Mac app with a code from the iPad. */
  async function family(h: Harness): Promise<{ phone: Paired; pad: Paired; desk: Paired }> {
    const phone = await firstDevice(h);
    const padCode = ((await call(h, 'POST', '/api/pairings', phone.auth, {})).body as { code: string }).code;
    const pad = await pair(h, padCode, 'iPad·Rarog');
    const deskCode = ((await call(h, 'POST', '/api/pairings', pad.auth, {})).body as { code: string }).code;
    const desk = await pair(h, deskCode, 'Mac·Rarog');
    return { phone, pad, desk };
  }

  it('admin route: every descendant gets the same effects (stream, APNs, unused codes); the reply lists them', async () => {
    const h = await start();
    const { phone, pad, desk } = await family(h);
    const admin = createAdminHandler({ store: h.store, pairing: h.pairing, publicUrl: null, log: () => {}, now: h.now });
    h.apns.upsert({
      token: 'c'.repeat(64), environment: 'development', label: 'Mac', alerts: true, deviceId: desk.id,
      topic: 'ai.rarog.app',
    });
    const deskStream = await fetch(`${h.base}/api/stream`, { headers: desk.auth });
    const reader = deskStream.body?.getReader();
    if (reader === undefined) throw new Error('no stream');
    await reader.read();
    // An unused code issued by the iPad: revoking the iPad through the cascade burns it.
    const unused = ((await call(h, 'POST', '/api/pairings', pad.auth, {})).body as { code: string }).code;

    const reply = await adminCall(admin, 'POST', '/api/admin/devices/revoke', { id: phone.id });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      revoked: [phone, pad, desk].map((d) => expect.objectContaining({ id: d.id, revokedBy: 'admin' }) as unknown),
    });
    const rows = (reply.body as { revoked: { createdAt: string }[] }).revoked;
    for (const row of rows) expect(row.createdAt).toBe(new Date(T0).toISOString());
    expect(h.store.active()).toEqual([]);

    let done = false;
    for (let i = 0; i < 20 && !done; i += 1) done = (await reader.read()).done;
    expect(done).toBe(true);
    expect(h.apns.list()).toEqual([]);
    expect((await call(h, 'POST', '/api/pair', {}, { v: 1, code: unused, label: 'x' })).status).toBe(404);
    for (const d of [phone, pad, desk]) {
      expect(h.logs.some((line) => line.startsWith(`devices: ${d.id} revoked (admin)`)), d.id).toBe(true);
      expect((await call(h, 'GET', '/api/devices/me', d.auth)).body).toMatchObject({ error: 'device-revoked' });
    }
    expect(h.logs.some((line) => line.includes(`devices: ${desk.id} revoked (admin) — streams: 1`))).toBe(true);
  });

  it('admin route with the id of a device that already did `forget`: its descendants go; the reply has only them', async () => {
    const h = await start();
    const { phone, pad, desk } = await family(h);
    const admin = createAdminHandler({ store: h.store, pairing: h.pairing, publicUrl: null, log: () => {}, now: h.now });
    expect((await call(h, 'POST', '/api/devices/forget', phone.auth, {})).status).toBe(204);
    const reply = await adminCall(admin, 'POST', '/api/admin/devices/revoke', { id: phone.id });
    expect(reply.status).toBe(200);
    expect((reply.body as { revoked: { id: string }[] }).revoked.map((r) => r.id)).toEqual([pad.id, desk.id]);
    expect(h.store.tombstone(phone.id)?.revokedBy).toBe('forget');
    expect(h.store.active()).toEqual([]);
    const again = await adminCall(admin, 'POST', '/api/admin/devices/revoke', { id: phone.id });
    expect(again).toEqual(expect.objectContaining({ status: 200, body: { revoked: [], alreadyRevoked: true } }));
  });

  it('`POST /api/devices/forget` by the phone leaves the iPad and the Mac app paired', async () => {
    const h = await start();
    const { phone, pad, desk } = await family(h);
    expect((await call(h, 'POST', '/api/devices/forget', phone.auth, {})).status).toBe(204);
    expect(h.store.active().map((r) => r.id)).toEqual([pad.id, desk.id]);
    expect((await call(h, 'GET', '/api/devices/me', desk.auth)).status).toBe(200);
  });
});

describe('repeating a revoke after `persist-failed` writes it to devices.json', () => {
  /** Store whose writes fail with ENOSPC while `failing.on` is true. */
  async function startFailing(): Promise<{ h: Harness; failing: { on: boolean } }> {
    const failing = { on: false };
    const h = await start({
      write: async (target, contents) => {
        if (failing.on) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        const { writeFile } = await import('node:fs/promises');
        await writeFile(target, contents, { mode: 0o600 });
      },
    });
    return { h, failing };
  }

  /** Server restart on the same data dir: a fresh store reads only what reached the files. */
  async function restart(h: Harness): Promise<Harness> {
    await h.close();
    harnesses.splice(harnesses.indexOf(h), 1);
    return start({ dir: h.dir });
  }

  const adminOf = (h: Harness): ReturnType<typeof createAdminHandler> =>
    createAdminHandler({ store: h.store, pairing: h.pairing, publicUrl: null, log: () => {}, now: h.now });

  it('device with a descendant: failed write → 500; the repeat → 200 already revoked; after a restart both stay revoked', async () => {
    const { h, failing } = await startFailing();
    const phone = await firstDevice(h);
    const padCode = ((await call(h, 'POST', '/api/pairings', phone.auth, {})).body as { code: string }).code;
    const pad = await pair(h, padCode, 'iPad·Rarog');
    await h.store.flush();
    const admin = adminOf(h);
    failing.on = true;
    const failed = await adminCall(admin, 'POST', '/api/admin/devices/revoke', { id: phone.id });
    expect(failed).toMatchObject({ status: 500, body: { error: 'persist-failed' } });
    failing.on = false;
    const again = await adminCall(admin, 'POST', '/api/admin/devices/revoke', { id: phone.id });
    expect(again).toEqual(expect.objectContaining({ status: 200, body: { revoked: [], alreadyRevoked: true } }));
    const after = await restart(h);
    expect(after.store.active()).toEqual([]);
    expect([phone.id, pad.id].map((id) => after.store.tombstone(id)?.revokedBy)).toEqual(['admin', 'admin']);
  });

  it('single device: failed write → 500; the repeat → 200; devices.json holds the tombstone', async () => {
    const { h, failing } = await startFailing();
    const phone = await firstDevice(h);
    await h.store.flush();
    const admin = adminOf(h);
    failing.on = true;
    expect((await adminCall(admin, 'POST', '/api/admin/devices/revoke', { id: phone.id })).status).toBe(500);
    failing.on = false;
    const again = await adminCall(admin, 'POST', '/api/admin/devices/revoke', { id: phone.id });
    expect(again).toEqual(expect.objectContaining({ status: 200, body: { revoked: [], alreadyRevoked: true } }));
    await h.store.flush();
    expect(readFileSync(path.join(h.dir, 'devices.json'), 'utf8')).toContain(phone.id);
    const after = await restart(h);
    expect(after.store.active()).toEqual([]);
    expect(after.store.tombstone(phone.id)?.revokedBy).toBe('admin');
  });

  it('parent with 200 descendants: its tombstone falls off the cap; the repeat still writes, nothing comes back', async () => {
    const { h, failing } = await startFailing();
    const phone = await firstDevice(h);
    for (let i = 0; i < 200; i += 1) {
      const redeemed = h.pairing.redeem({ code: h.pairing.issue(phone.id).code, label: `pad-${String(i)}` });
      if (!redeemed.ok) throw new Error('code not accepted');
    }
    await h.store.persist();
    expect(h.store.active()).toHaveLength(201);
    const admin = adminOf(h);
    failing.on = true;
    expect((await adminCall(admin, 'POST', '/api/admin/devices/revoke', { id: phone.id })).status).toBe(500);
    // 201 tombstones over the cap of 200: the parent, oldest and on no active chain, is trimmed from memory.
    expect(h.store.tombstone(phone.id)).toBeUndefined();
    failing.on = false;
    const again = await adminCall(admin, 'POST', '/api/admin/devices/revoke', { id: phone.id });
    expect(again).toEqual(expect.objectContaining({ status: 200, body: { revoked: [], alreadyRevoked: true } }));
    const after = await restart(h);
    expect(after.store.active()).toEqual([]);
  });

  it('repeat on a healthy disk → 200 already revoked; the file stays valid', async () => {
    const h = await start();
    const phone = await firstDevice(h);
    const admin = adminOf(h);
    expect((await adminCall(admin, 'POST', '/api/admin/devices/revoke', { id: phone.id })).status).toBe(200);
    const again = await adminCall(admin, 'POST', '/api/admin/devices/revoke', { id: phone.id });
    expect(again).toEqual(expect.objectContaining({ status: 200, body: { revoked: [], alreadyRevoked: true } }));
    const after = await restart(h);
    expect(after.store.status).toBe('ok');
    expect(after.store.active()).toEqual([]);
    expect(after.store.tombstone(phone.id)?.revokedBy).toBe('admin');
  });

  it('unknown id → 404 `device-not-found`', async () => {
    const h = await start();
    await firstDevice(h);
    const reply = await adminCall(adminOf(h), 'POST', '/api/admin/devices/revoke', { id: 'f'.repeat(32) });
    expect(reply).toMatchObject({ status: 404, body: { error: 'device-not-found' } });
  });
});

describe('push `device-paired`', () => {
  it('po WYSŁANIU odpowiedzi, tylko do tokenów innych aktywnych urządzeń; wolny APNs nie opóźnia `/api/pair`', async () => {
    const sent: { content: PushContent; tokens: string[] }[] = [];
    let h: Harness | undefined;
    const sink: Pick<ApnsSink, 'sendWhere'> = {
      sendWhere: (content, filter) => {
        sent.push({ content, tokens: (h?.apns.list() ?? []).filter(filter).map((r) => r.token) });
        // APNs, który nie odpowiada nigdy — odpowiedź parowania i tak ma dojść.
        return new Promise(() => {});
      },
    };
    h = await start({ sink });
    const phone = await firstDevice(h);
    expect(sent).toEqual([]);
    h.apns.upsert({ token: 'a'.repeat(64), environment: 'development', label: 'iPhone', alerts: true, deviceId: phone.id, topic: 'ai.rarog.app' });
    // Token urządzenia spoza aktywnych (np. odpiętego, którego wpis przetrwał): `device-paired` do niego nie idzie.
    h.apns.upsert({ token: 'c'.repeat(64), environment: 'development', label: 'odpięte', alerts: true, deviceId: 'c'.repeat(32), topic: 'ai.rarog.app' });
    const code = ((await call(h, 'POST', '/api/pairings', phone.auth, {})).body as { code: string }).code;
    const started = Date.now();
    const pad = await pair(h, code, 'iPad·Rarog');
    expect(Date.now() - started).toBeLessThan(2_000);
    h.apns.upsert({ token: 'd'.repeat(64), environment: 'development', label: 'iPad', alerts: true, deviceId: pad.id, topic: 'ai.rarog.app' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toMatchObject({ kind: 'device-paired', body: expect.stringContaining('iPad·Rarog') as unknown });
    expect(sent[0]?.tokens).toEqual(['a'.repeat(64)]);
  });
});

/** Żądanie do handlera gniazda administracyjnego bez gniazda (serwer HTTP na porcie efemerycznym). */
async function adminCall(
  handler: ReturnType<typeof createAdminHandler>, method: string, route: string, body?: unknown,
): Promise<Reply> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const res = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}${route}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown, headers: res.headers };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
}

/** Żądanie przez gniazdo Unix. */
function socketCall(socketPath: string, method: string, route: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ socketPath, path: route, method, headers: { 'Content-Length': String(Buffer.byteLength(payload)) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) as unknown, headers: new Headers() });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('gniazdo administracyjne `<dataDir>/run/admin.sock`', () => {
  let dir = '';
  const sockets: AdminSocket[] = [];
  /** Magazyny testu: nowy zapisuje `devices.json` w tle od razu, więc przed `rmSync` czekamy na zapis. */
  const stores: DeviceStore[] = [];
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'p2-adm-')); });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) await socket.close();
    for (const store of stores.splice(0)) await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const setup = (): { store: DeviceStore; pairing: Pairing; handler: ReturnType<typeof createAdminHandler> } => {
    const store = createDeviceStore({ dataDir: dir, epoch: '1' });
    stores.push(store);
    const pairing = createPairing({ store, epoch: '1' });
    const handler = createAdminHandler({
      store, pairing, publicUrl: publicUrlOf(['http://127.0.0.1:8930', 'https://rarog.example.net']), log: () => {},
    });
    return { store, pairing, handler };
  };

  it('prawa: katalog 0o700, gniazdo 0o600; pełny przebieg `rarog pair` i `rarog devices`', async () => {
    const { store, pairing, handler } = setup();
    const socket = await startAdminSocket(dir, handler, () => {});
    if (socket === null) throw new Error('gniazdo nie wstało');
    sockets.push(socket);
    expect(socket.path).toBe(adminSocketPath(dir));
    expect(path.basename(socket.path)).toBe(ADMIN_SOCKET_FILENAME);
    expect(statSync(path.dirname(socket.path)).mode & 0o777).toBe(0o700);
    expect(statSync(socket.path).mode & 0o777).toBe(0o600);

    const issued = await socketCall(socket.path, 'POST', '/api/admin/pairings');
    const body = issued.body as { pairingId: string; code: string; url: string; link: string; expiresAt: string };
    expect(issued.status).toBe(200);
    expect(body.url).toBe('https://rarog.example.net');
    expect(body.link).toBe(pairingLink('https://rarog.example.net', null, body.code));
    expect(body.link).toMatch(/^https:\/\/rarog\.ai\/pair#v=1&u=https%3A%2F%2Frarog\.example\.net&c=[A-Za-z0-9_-]{43}$/);
    expect((await socketCall(socket.path, 'GET', `/api/admin/pairings/${body.pairingId}`)).body).toMatchObject({ state: 'pending' });
    const redeemed = pairing.redeem({ code: body.code, label: 'iPhone·Rarog' });
    if (!redeemed.ok) throw new Error('parowanie');
    expect((await socketCall(socket.path, 'GET', `/api/admin/pairings/${body.pairingId}`)).body)
      .toEqual({ state: 'redeemed', deviceId: redeemed.record.id, label: 'iPhone·Rarog', confirmed: false });
    store.touch(redeemed.record.id);
    expect((await socketCall(socket.path, 'GET', `/api/admin/pairings/${body.pairingId}`)).body).toMatchObject({ confirmed: true });
    expect((await socketCall(socket.path, 'POST', '/api/admin/pairings')).status).toBe(409);

    const list = await socketCall(socket.path, 'GET', '/api/admin/devices');
    expect(list.body).toMatchObject({ serverId: store.serverId, authStore: 'ok', devices: [{ id: redeemed.record.id }], revoked: [] });
    expect(JSON.stringify(list.body)).not.toMatch(/secretHash|pushKey/);
    expect((await socketCall(socket.path, 'POST', '/api/admin/devices/revoke', { id: 'f'.repeat(32) })).status).toBe(404);
    const revoked = await socketCall(socket.path, 'POST', '/api/admin/devices/revoke', { id: redeemed.record.id });
    expect(revoked.body).toMatchObject({ revoked: [{ id: redeemed.record.id, revokedBy: 'admin' }] });
    expect(store.active()).toEqual([]);
    expect((await socketCall(socket.path, 'GET', '/api/admin/pairings/nieznane')).status).toBe(404);
    // Macierz uprawnień, wiersz „gniazdo”: trasy urządzenia (kod z urządzenia, lista dla apki) tu nie istnieją.
    for (const [method, route] of [['POST', '/api/pairings'], ['GET', '/api/devices'], ['GET', '/api/devices/me']]) {
      expect((await socketCall(socket.path, method as string, route as string, method === 'POST' ? {} : undefined)).status,
        route).toBe(404);
    }
    expect((await socketCall(socket.path, 'POST', '/api/admin/devices/revoke', { all: true })).body).toEqual({ revoked: [] });
  });

  it('the admin device list cleans the label and build of a record written before the rule', async () => {
    const { store, pairing, handler } = setup();
    const socket = await startAdminSocket(dir, handler, () => {});
    if (socket === null) throw new Error('socket did not start');
    sockets.push(socket);
    const redeemed = pairing.redeem({ code: pairing.issue('admin').code, label: 'iPhone' });
    if (!redeemed.ok) throw new Error('code not accepted');
    store.add({ ...redeemed.record, id: 'e'.repeat(32), label: `old${RLO}label`, build: ` 1700${ESC}` });
    const list = await socketCall(socket.path, 'GET', '/api/admin/devices');
    expect((list.body as { devices: unknown[] }).devices)
      .toContainEqual(expect.objectContaining({ id: 'e'.repeat(32), label: 'oldlabel', build: null }));
  });

  it('żywe gniazdo innego procesu zostaje nietknięte; martwe (po awarii procesu) jest zastępowane', async () => {
    const { handler } = setup();
    const first = await startAdminSocket(dir, handler, () => {});
    if (first === null) throw new Error('gniazdo nie wstało');
    const logs: string[] = [];
    expect(await startAdminSocket(dir, handler, (line) => { logs.push(line); })).toBeNull();
    expect(logs.some((line) => line.includes('another live process'))).toBe(true);
    // Żywe gniazdo dalej odpowiada — drugi start go nie skasował.
    expect((await socketCall(first.path, 'GET', '/api/admin/devices')).status).toBe(200);
    await first.close();
    // Martwe gniazdo: proces potomny zakłada je i ginie od SIGKILL — plik zostaje bez słuchacza
    // (zwykłe `close()` w Node kasuje plik sam, więc awarię trzeba zrobić naprawdę).
    const target = adminSocketPath(dir);
    spawnSync(process.execPath, ['-e',
      `require('node:net').createServer().listen(${JSON.stringify(target)}, () => process.kill(process.pid, 'SIGKILL'))`]);
    expect(lstatSync(target).isSocket()).toBe(true);
    const replaced = await startAdminSocket(dir, handler, () => {});
    if (replaced === null) throw new Error('martwe gniazdo nie zostało zastąpione');
    sockets.push(replaced);
    expect((await socketCall(replaced.path, 'GET', '/api/admin/devices')).status).toBe(200);
  });

  it('plik, który nie jest gniazdem, i za długa ścieżka: gniazda nie ma, serwer działa dalej', async () => {
    const { handler } = setup();
    const target = adminSocketPath(dir);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'nie gniazdo');
    const logs: string[] = [];
    expect(await startAdminSocket(dir, handler, (line) => { logs.push(line); })).toBeNull();
    expect(logs.some((line) => line.includes('is not a socket'))).toBe(true);
    const deep = path.join(dir, 'x'.repeat(120));
    expect(await startAdminSocket(deep, handler, (line) => { logs.push(line); })).toBeNull();
    expect(logs.some((line) => line.includes('longer than'))).toBe(true);
  });
});
