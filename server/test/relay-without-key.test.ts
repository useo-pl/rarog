/**
 * Serwer BEZ klucza APNs na atrapie przekaźnika push: klucz właściciela maskuje te ścieżki na żywo, więc
 * dowodzi ich ten plik.
 *
 * Prawdziwy router na porcie efemerycznym i PRAWDZIWY kanał (`createApnsChannel`: rejestr w katalogu tymczasowym,
 * nadajnik złożony, sink, Live Activity, przepustki); przekaźnik to atrapa `fetch` z kontraktem `/v1/pass`
 * i `/v1/push` (wydaje przepustki, sprawdza je przy wysyłce, umie wstrzymać odpowiedź). Sprawdza: pierwszy push
 * próbny (czeka na przepustkę, bez niej `pass-missing`), koniec Live Activity przez przekaźnik po skasowaniu bloku,
 * `401` i nowe zamówienie, spóźnioną odpowiedź po wyrejestrowaniu, jedno zamówienie w locie, `env-mismatch`,
 * `pass-missing` bez podbijania porażek, status per token, rejestrację bez klucza urządzenia (401) i bez tematu
 * (400) — bez wpisu i bez przekaźnika, puste `RAROG_PUSH_RELAY_URL` = droga kluczem, zmianę przekaźnika i to, że
 * przepustki nie trafiają do logu. Rejestracje idą kluczem sparowanego urządzenia z `pushFormats: [3]`:
 * push próbny to baner formatu 3 w kształcie polityki `v2` przekaźnika, a wpis bez deklaracji banerów
 * nie dostaje.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { RELAY_ALERT_PLACEHOLDER } from '@rarog/shared/relay';
import {
  createDeviceStore, createPairing, deviceAuthorization, hashSecret, pushKeyId,
} from '../src/auth/index.ts';
import type { DeviceIdentity } from '../src/router.ts';
import { loadConfig } from '../src/config.ts';
import type { ApnsSender } from '../src/notify/apns.ts';
import { createApnsChannel } from '../src/notify/apns-channel.ts';
import type { ApnsChannel } from '../src/notify/apns-channel.ts';
import { createApnsDeviceStore } from '../src/notify/apns-devices.ts';
import { buildContent } from '../src/notify/content.ts';
import { RELAY_PASS_RETRY_MS, STATUS_PASS_WAIT_MS } from '../src/notify/relay-pass.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { foreign } from '@rarog/shared/sentences';

const ORIGIN = 'http://localhost:8930';
const RELAY = 'https://push.rarog.ai';
const T0 = Date.parse('2026-11-02T10:00:00.000Z');
const DEVICE = 'a1b2c3d4'.repeat(8);
const OTHER = 'e5f6a7b8'.repeat(8);
const UPDATE = '0f1e2d3c'.repeat(10);
const RAROG = {
  environment: 'development', label: 'iPhone·Rarog', alerts: true, topic: 'ai.rarog.app', pushFormats: [3],
} as const;
const content = buildContent({
  cls: 'blocking', kind: 'permission', project: 'willow', label: 'zapis notatek', sessionId: 's1', detail: foreign('Edit'),
  badge: 1,
});

interface RelayCall {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** Atrapa przekaźnika: wydaje przepustki, przyjmuje tylko swoje, odpowiedź można podmienić albo wstrzymać. */
class MockRelay {
  readonly calls: RelayCall[] = [];
  readonly issued = new Map<string, string>();
  seq = 0;
  /** Podmiana odpowiedzi `/v1/pass`; `undefined` = zwykłe wydanie. */
  pass: ((body: Record<string, unknown>) => Reply | Promise<Reply> | undefined) | undefined;
  /** Podmiana odpowiedzi `/v1/push`; `undefined` = lustro 200 Apple po sprawdzeniu przepustki. */
  push: ((body: Record<string, unknown>) => Reply | undefined) | undefined;

  constructor(private readonly now: () => number) {}

  readonly fetch: typeof globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    this.calls.push({ path: target.pathname, body });
    const reply = target.pathname === '/v1/pass' ? await this.passReply(body) : this.pushReply(body);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };

  private async passReply(body: Record<string, unknown>): Promise<Reply> {
    const custom = await this.pass?.(body);
    if (custom !== undefined) return custom;
    this.seq += 1;
    const pass = `v1.k1.${String(body['environment'])}.${String(body['type'])}.${String(this.seq)}.TAJNA-przepustka`;
    this.issued.set(pass, String(body['token']));
    return { status: 200, body: { v: 1, pass, expiresAt: new Date(this.now() + 90 * 86_400_000).toISOString() } };
  }

  private pushReply(body: Record<string, unknown>): Reply {
    const custom = this.push?.(body);
    if (custom !== undefined) return custom;
    if (this.issued.get(String(body['pass'])) !== body['token']) return { status: 401, body: { v: 1, error: 'pass-invalid' } };
    return { status: 200, body: { v: 1, apnsStatus: 200 } };
  }

  paths(): string[] {
    return this.calls.map((c) => c.path);
  }

  pushes(): RelayCall[] {
    return this.calls.filter((c) => c.path === '/v1/push');
  }
}

interface Harness {
  readonly channel: ApnsChannel;
  readonly relay: MockRelay;
  readonly logs: string[];
  readonly dir: string;
  clock: number;
  /** POST z kluczem urządzenia `PAIRED`, z `'other'` — urządzenia `PAIRED_OTHER`, z `'none'` — bez klucza. */
  post(route: string, body: unknown, as?: 'device' | 'other' | 'none'): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

/**
 * Sparowane urządzenia harnessu: id, sekret i klucz push. Token `OTHER` rejestruje drugie urządzenie,
 * bo jedno urządzenie ma jeden wpis na temat.
 */
const PAIRED = 'f0e1d2c3'.repeat(4);
const PAIRED_SECRET = Buffer.alloc(32, 9).toString('base64url');
const PAIRED_PUSH_KEY = Buffer.alloc(32, 5).toString('base64url');
const PAIRED_OTHER = 'c3d2e1f0'.repeat(4);
const PAIRED_OTHER_SECRET = Buffer.alloc(32, 8).toString('base64url');
const PAIRED_OTHER_PUSH_KEY = Buffer.alloc(32, 6).toString('base64url');

const harnesses: Harness[] = [];
/** Wszystkie linie logu wszystkich przebiegów — przepustki nie mają prawa w nim stanąć (sprawdza `afterEach`). */
const allLogs: string[] = [];

async function start(opts: {
  relayOrigin?: string | undefined; direct?: ApnsSender; dir?: string; noRelay?: boolean;
} = {}): Promise<Harness> {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), 'rarog-przekaznik-'));
  const logs: string[] = [];
  const h = { clock: T0 } as Harness & { clock: number };
  const relay = new MockRelay(() => h.clock);
  const log = (line: string): void => { logs.push(line); allLogs.push(line); };
  const config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: dir });
  // Magazyn kluczy z dwoma sparowanymi urządzeniami: źródło klucza push banera.
  const store = createDeviceStore({ dataDir: dir, epoch: config.epoch, now: () => h.clock });
  for (const [id, secret, pushKey] of [
    [PAIRED, PAIRED_SECRET, PAIRED_PUSH_KEY], [PAIRED_OTHER, PAIRED_OTHER_SECRET, PAIRED_OTHER_PUSH_KEY],
  ] as const) {
    store.add({
      id, secretHash: hashSecret(secret), pushKey, kid: pushKeyId(pushKey), label: 'iPhone·Rarog', build: null,
      createdAt: new Date(T0).toISOString(), lastSeenAt: new Date(T0).toISOString(), epoch: config.epoch, creator: 'admin',
    });
  }
  const identity: DeviceIdentity = {
    store, pairing: createPairing({ store, epoch: config.epoch, now: () => h.clock }), serverName: 'mac-test',
    now: () => h.clock,
  };
  const channel = createApnsChannel({
    pushEnabled: true, pushE2e: true, dataDir: dir,
    ...(opts.noRelay === true ? {} : { pushRelay: { origin: opts.relayOrigin ?? RELAY } }),
    ...(opts.direct === undefined ? {} : {
      apns: { privateKey: 'atrapa', keyId: 'ABC123DEFG', teamId: 'TEAM123456', topic: 'ai.rarog.app' },
    }),
  }, {
    sessions: () => [makeSummary({ id: 's1', state: 'waiting-permission' })], log, mac: () => ({}),
    pairedDevices: identity.store,
    limitsPoller: () => ({ current: () => ({}), weeklyWindows: () => [], close: () => {} }),
    relayFetch: relay.fetch, now: () => h.clock,
    ...(opts.direct === undefined ? {} : { direct: () => opts.direct as ApnsSender }),
  });
  if (channel === undefined) throw new Error('kanał nie powstał');
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const logger: Logger = { info: log, error: log };
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: T0, logger, apns: channel, devices: identity,
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const credentials = {
    device: { Authorization: deviceAuthorization(PAIRED, PAIRED_SECRET) },
    other: { Authorization: deviceAuthorization(PAIRED_OTHER, PAIRED_OTHER_SECRET) },
    none: {},
  } as const;
  Object.assign(h, {
    channel, relay, logs, dir,
    async post(route: string, body: unknown, as: 'device' | 'other' | 'none' = 'device') {
      const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: {
          ...credentials[as],
          Origin: ORIGIN, 'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
    },
    async close() {
      channel.passes?.close();
      channel.liveActivity.close();
      channel.sender.close();
      hub.closeAll();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await channel.devices.flush();
      await identity.store.flush();
      if (opts.dir === undefined) rmSync(dir, { recursive: true, force: true });
    },
  });
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  const text = allLogs.join('\n');
  expect(text).not.toContain('TAJNA');
  for (const token of [DEVICE, OTHER, UPDATE]) expect(text).not.toContain(token.slice(0, 16));
  allLogs.length = 0;
});

const status = async (h: Harness, token = DEVICE): Promise<Record<string, unknown>> =>
  (await h.post('/api/push/apns/status', { token })).body as Record<string, unknown>;

describe('serwer bez klucza: push próbny i status', () => {
  it('pierwszy push próbny: 204 od razu, potem `/v1/pass`, potem `/v1/push` z przepustką; status zdrowy', async () => {
    const h = await start();
    let release: (r: Reply) => void = () => {};
    h.relay.pass = () => new Promise<Reply>((resolve) => { release = resolve; });
    const res = await h.post('/api/push/apns', { token: DEVICE, ...RAROG, test: true });
    expect(res.status).toBe(204);
    await vi.waitFor(() => { expect(h.relay.paths()).toEqual(['/v1/pass']); });
    // Status w trakcie zamówienia czeka na jego rozstrzygnięcie (apka czyta go raz, zaraz po rejestracji).
    const during = status(h);
    h.relay.pass = undefined;
    h.relay.issued.set('v1.k1.development.alert.0.TAJNA-pierwsza', DEVICE);
    release({ status: 200, body: { v: 1, pass: 'v1.k1.development.alert.0.TAJNA-pierwsza', expiresAt: '2027-01-31T10:00:00.000Z' } });
    expect(await during).toEqual({ enabled: true, registered: true, alerts: true, degradedSince: null });
    await vi.waitFor(() => { expect(h.logs).toContain('push: APNs test push → delivered'); });
    const [push] = h.relay.pushes();
    expect(push?.body).toMatchObject({ v: 1, pass: 'v1.k1.development.alert.0.TAJNA-pierwsza', token: DEVICE, environment: 'development' });
    expect(JSON.parse(String(push?.body['payload'])) as unknown).toMatchObject({ rarog: { v: 3 } });
    expect(await status(h)).toEqual({ enabled: true, registered: true, alerts: true, degradedSince: null });
    expect(h.channel.devices.get(DEVICE)?.lastOkAt).not.toBeNull();
  });

  it('przekaźnik nie wydał przepustki (502): push próbny kończy się `pass-missing`, status mówi przyczynę', async () => {
    const h = await start();
    h.relay.pass = () => ({ status: 502, body: { v: 1, error: 'apns-unreachable' } });
    expect((await h.post('/api/push/apns', { token: DEVICE, ...RAROG, test: true })).status).toBe(204);
    await vi.waitFor(() => {
      expect(h.logs).toContain('push: APNs test push → pass-missing (entry without a push relay pass and without a key route)');
    });
    expect(h.relay.paths()).toEqual(['/v1/pass']);
    expect(await status(h)).toEqual({
      enabled: true, registered: true, alerts: true, degradedSince: new Date(T0).toISOString(), degradedReason: 'pass-missing',
    });
  });

  it('`pass-missing` w banerach nie podbija licznika porażek (brak próby)', async () => {
    const h = await start();
    h.relay.pass = () => ({ status: 503, body: { v: 1, error: 'environment-unavailable' } });
    await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    await vi.waitFor(() => { expect(h.relay.paths()).toEqual(['/v1/pass']); });
    for (let i = 0; i < 4; i += 1) expect(await h.channel.sink.send(content)).toBe('failed');
    expect(h.channel.devices.get(DEVICE)).toMatchObject({ failures: 0, degradedSince: null });
    expect(h.relay.pushes()).toEqual([]);
  });

  it('`env-mismatch`: 422 `BadDeviceToken` dla tokenu bez żadnego 200 — wpis zostaje, status z przyczyną', async () => {
    const h = await start();
    h.relay.pass = () => ({ status: 422, body: { v: 1, error: 'token-rejected', apnsStatus: 400, reason: 'BadDeviceToken' } });
    await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    await vi.waitFor(() => { expect(h.channel.devices.get(DEVICE)?.relayMismatch).toBeDefined(); });
    expect(await status(h)).toEqual({
      enabled: true, registered: true, alerts: true, degradedSince: new Date(T0).toISOString(), degradedReason: 'env-mismatch',
    });
    // Kolejne rejestracje z tym samym środowiskiem nie zamawiają w kółko.
    await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    expect(h.relay.paths()).toEqual(['/v1/pass']);
  });

  it('status per TOKEN: wpis z przepustką zdrowy, wpis bez drogi obok — `pass-missing`', async () => {
    const h = await start();
    h.relay.pass = (body) => (body['token'] === OTHER ? { status: 502, body: { v: 1, error: 'apns-error', apnsStatus: 500, reason: 'InternalServerError' } } : undefined);
    await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    await vi.waitFor(() => { expect(h.channel.devices.get(DEVICE)?.relayPass).toBeDefined(); });
    await h.post('/api/push/apns', { token: OTHER, ...RAROG }, 'other');
    await vi.waitFor(() => { expect(h.relay.paths()).toHaveLength(2); });
    await vi.waitFor(async () => { expect((await status(h, OTHER))['degradedReason']).toBe('pass-missing'); });
    expect(await status(h, DEVICE)).toEqual({ enabled: true, registered: true, alerts: true, degradedSince: null });
  });

  /**
   * Ładunek `n`-tej wysyłki przez przekaźnik (łańcuch JSON z ciała `/v1/push`): `aps` i blok `rarog` formatu 3 (brak =
   * pusty obiekt).
   */
  const relayed = (h: Harness, index: number): { aps: Record<string, unknown>; block: Record<string, unknown> } => {
    const parsed = JSON.parse(String(h.relay.pushes()[index]?.body['payload'])) as
      Record<string, Record<string, unknown> | undefined>;
    return { aps: parsed['aps'] ?? {}, block: parsed['rarog'] ?? {} };
  };

  it('push próbny: rejestracja kluczem urządzenia z `pushFormats: [3]` → szyfrogram przez przekaźnik', async () => {
    const h = await start();
    expect((await h.post('/api/push/apns', { token: DEVICE, ...RAROG, test: true })).status).toBe(204);
    await vi.waitFor(() => { expect(h.logs).toContain('push: APNs test push → delivered'); });
    expect(h.channel.devices.get(DEVICE)).toMatchObject({ deviceId: PAIRED, pushFormats: [3] });
    const sent = relayed(h, 0);
    // Kształt polityki `v2` przekaźnika dosłownie: tekst zastępczy, `mutable-content`, dźwięk; bez wątku (push próbny).
    expect(sent.aps).toEqual({ alert: { ...RELAY_ALERT_PLACEHOLDER }, 'mutable-content': 1, sound: 'default' });
    expect(Object.keys(sent.block).sort()).toEqual(['c', 'kid', 'n', 'v']);
    expect(sent.block).toMatchObject({ v: 3, kid: pushKeyId(PAIRED_PUSH_KEY) });
    expect(h.logs).toContain('push: APNs test — v3: 1');

    // Ponowna rejestracja BEZ pola kasuje deklarację: następny baner pominięty, przekaźnik nie dostaje nic.
    const { pushFormats: _formats, ...undeclared } = RAROG;
    void _formats;
    await h.post('/api/push/apns', { token: DEVICE, ...undeclared });
    expect(h.channel.devices.get(DEVICE)?.pushFormats).toBeUndefined();
    expect(await h.channel.sink.send(content)).toBe('no-receiver');
    expect(h.relay.pushes()).toHaveLength(1);
    expect(h.logs).toContain('push: APNs the app did not declare format 3 — entry skipped');
    for (const call of h.relay.pushes()) {
      for (const secret of ['willow', 'zapis notatek', 'Edit', 'Powiadomienia działają']) {
        expect(String(call.body['payload'])).not.toContain(secret);
      }
    }
  });

  it('rejestracja bez klucza urządzenia: 401 `unauthorized` na bramce, wpisu nie ma, przekaźnik nie widzi nic', async () => {
    const h = await start();
    const res = await h.post('/api/push/apns', { token: DEVICE, ...RAROG, test: true }, 'none');
    expect(res).toMatchObject({ status: 401, body: { error: 'unauthorized' } });
    expect(h.channel.devices.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.relay.calls).toEqual([]);
  });
});

describe('serwer bez klucza: status czeka na zamówienie w toku (apka czyta go raz po rejestracji)', () => {
  const delayed = (ms: number, reply: Reply): Promise<Reply> =>
    new Promise((resolve) => { setTimeout(() => { resolve(reply); }, ms); });

  it('zamówienie kończy się po 1 s porażką (502): przyczyna `pass-missing` w TEJ SAMEJ odpowiedzi statusu', async () => {
    const h = await start();
    h.relay.pass = () => delayed(1_000, { status: 502, body: { v: 1, error: 'apns-unreachable' } });
    await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    const started = Date.now();
    expect(await status(h)).toEqual({
      enabled: true, registered: true, alerts: true, degradedSince: new Date(T0).toISOString(), degradedReason: 'pass-missing',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
  });

  it('zamówienie kończy się po 1 s odmową `BadDeviceToken`: `env-mismatch` w tej samej odpowiedzi', async () => {
    const h = await start();
    h.relay.pass = () => delayed(1_000, {
      status: 422, body: { v: 1, error: 'token-rejected', apnsStatus: 400, reason: 'BadDeviceToken' },
    });
    await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    expect((await status(h))['degradedReason']).toBe('env-mismatch');
  });

  it('zamówienie wisi dłużej niż 5 s: odpowiedź po ~5 s, bez przyczyny (zamówienie wciąż w toku)', async () => {
    const h = await start();
    h.relay.pass = () => new Promise<Reply>(() => {});
    await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    const started = Date.now();
    expect(await status(h)).toEqual({ enabled: true, registered: true, alerts: true, degradedSince: null });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(STATUS_PASS_WAIT_MS - 200);
    expect(took).toBeLessThan(STATUS_PASS_WAIT_MS + 2_000);
  }, 15_000);

  it('bez zamówienia w toku status odpowiada od razu', async () => {
    const h = await start();
    await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    await vi.waitFor(() => { expect(h.channel.devices.get(DEVICE)?.relayPass).toBeDefined(); });
    const started = Date.now();
    await status(h);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('serwer bez klucza: zamówienia', () => {
  it('jedno zamówienie w locie na token: rejestracje w trakcie nie zamawiają drugi raz', async () => {
    const h = await start();
    let release: (r: Reply | undefined) => void = () => {};
    h.relay.pass = () => new Promise<Reply | undefined>((resolve) => { release = resolve; }) as Promise<Reply>;
    for (let i = 0; i < 3; i += 1) await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    await vi.waitFor(() => { expect(h.relay.paths()).toEqual(['/v1/pass']); });
    h.relay.pass = undefined;
    release(undefined);
    await vi.waitFor(() => { expect(h.channel.devices.get(DEVICE)?.relayPass).toBeDefined(); });
    expect(h.relay.paths()).toEqual(['/v1/pass']);
  });

  it('spóźniona przepustka po wyrejestrowaniu nie odtwarza wpisu', async () => {
    const h = await start();
    let release: (r: Reply | undefined) => void = () => {};
    h.relay.pass = () => new Promise<Reply | undefined>((resolve) => { release = resolve; }) as Promise<Reply>;
    await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    await vi.waitFor(() => { expect(h.relay.paths()).toEqual(['/v1/pass']); });
    expect((await h.post('/api/push/apns/unregister', { token: DEVICE })).status).toBe(204);
    h.relay.pass = undefined;
    release(undefined);
    await vi.waitFor(() => { expect(h.logs.some((l) => l.includes('during the request — skipped'))).toBe(true); });
    expect(h.channel.devices.get(DEVICE)).toBeUndefined();
    expect(h.channel.devices.size).toBe(0);
  });

  it('`401` z `/v1/push`: przepustka zdjęta, nowe zamówienie po odczekaniu, następny baner nową przepustką', async () => {
    const h = await start();
    await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    await vi.waitFor(() => { expect(h.channel.devices.get(DEVICE)?.relayPass).toBeDefined(); });
    const first = h.channel.devices.get(DEVICE)?.relayPass?.pass;
    h.relay.issued.clear();
    expect(await h.channel.sink.send(content)).toBe('failed');
    expect(h.channel.devices.get(DEVICE)?.relayPass).toBeUndefined();
    expect(h.channel.devices.get(DEVICE)).toMatchObject({ failures: 0 });
    // Odczekanie: przed nim zamówienie nie idzie.
    h.channel.passes?.ensure(DEVICE);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.relay.paths()).toEqual(['/v1/pass', '/v1/push']);
    h.clock += RELAY_PASS_RETRY_MS[0] ?? 0;
    h.channel.passes?.ensure(DEVICE);
    await vi.waitFor(() => { expect(h.channel.devices.get(DEVICE)?.relayPass).toBeDefined(); });
    const second = h.channel.devices.get(DEVICE)?.relayPass?.pass;
    expect(second).not.toBe(first);
    expect(await h.channel.sink.send(content)).toBe('delivered');
    expect(h.relay.pushes().at(-1)?.body['pass']).toBe(second);
    expect(h.logs.some((l) => /refused the (?:device )?pass/u.test(l))).toBe(true);
  });

  it('rejestracja bez `topic`: 400 `topic-mismatch`, wpisu nie ma, przekaźnik nie widzi nic', async () => {
    const h = await start();
    const { topic: _t, ...noTopic } = RAROG;
    void _t;
    const res = await h.post('/api/push/apns', { token: DEVICE, ...noTopic, test: true });
    expect(res).toMatchObject({ status: 400, body: { error: 'topic-mismatch' } });
    expect(h.channel.devices.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.relay.calls).toEqual([]);
    expect(await status(h)).toEqual({ enabled: true, registered: false, alerts: false, degradedSince: null });
  });

  it('zmiana adresu przekaźnika: przepustka innego originu to brak — start zamawia nową', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rarog-przekaznik-origin-'));
    try {
      const store = createApnsDeviceStore({ dataDir: dir, now: () => T0 });
      store.upsert({ token: DEVICE, deviceId: PAIRED, ...RAROG });
      store.setRelayPass({
        pass: 'v1.k1.development.alert.9.TAJNA-stary-adres', expiresAt: '2027-01-31T10:00:00.000Z', origin: RELAY,
        environment: 'development', topic: 'ai.rarog.app', token: DEVICE,
      });
      await store.flush();
      const h = await start({ dir, relayOrigin: 'https://relay.example.net' });
      expect(h.channel.sender.routeOf(h.channel.devices.get(DEVICE) as never)).toBe('none');
      h.channel.passes?.start();
      await vi.waitFor(() => { expect(h.channel.devices.get(DEVICE)?.relayPass?.origin).toBe('https://relay.example.net'); });
      expect(h.relay.paths()).toEqual(['/v1/pass']);
    } finally {
      // Serwer z tym katalogiem zapisuje w tle do końca `close`, więc zamknięcie idzie przed `rmSync`.
      for (const h of harnesses.splice(0)) await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('serwer bez klucza: Live Activity', () => {
  it('kafel przez przekaźnik z przepustką aktywności; koniec z trasy (blok skasowany przed `end`) też przez przekaźnik', async () => {
    const h = await start();
    await h.post('/api/push/apns', { token: DEVICE, ...RAROG });
    await vi.waitFor(() => { expect(h.channel.devices.get(DEVICE)?.relayPass).toBeDefined(); });
    expect((await h.post('/api/push/live-activity', { deviceToken: DEVICE, activityId: 'akt-1', updateToken: UPDATE })).status)
      .toBe(204);
    await vi.waitFor(() => { expect(h.channel.devices.get(DEVICE)?.liveActivity?.relayPass).toBeDefined(); });
    const laPass = h.channel.devices.get(DEVICE)?.liveActivity?.relayPass?.pass;
    // Pierwsza aktualizacja bez przepustki aktywności to `pass-missing`; zapisana przepustka budzi tor od razu.
    await vi.waitFor(() => {
      expect(h.relay.pushes().some((c) => c.body['token'] === UPDATE && c.body['pass'] === laPass)).toBe(true);
    });
    const passCall = h.relay.calls.find((c) => c.body['type'] === 'liveactivity');
    expect(passCall?.body).toMatchObject({ token: UPDATE, devicePass: h.channel.devices.get(DEVICE)?.relayPass?.pass });
    expect((await h.post('/api/push/live-activity/end', { deviceToken: DEVICE, activityId: 'akt-1' })).status).toBe(204);
    expect(h.channel.devices.get(DEVICE)?.liveActivity).toBeUndefined();
    await vi.waitFor(() => {
      const end = h.relay.pushes().find((c) => (JSON.parse(String(c.body['payload'])) as { aps: { event?: string } }).aps.event === 'end');
      expect(end?.body).toMatchObject({ token: UPDATE, pass: laPass });
    });
    expect(h.logs).toContain('live-activity: end (app) → delivered');
  });
});

describe('puste `RAROG_PUSH_RELAY_URL` = droga sprzed przekaźnika', () => {
  it('klucz bez przekaźnika: przepustki w pliku leżą martwe, wszystko kluczem, żadnego `/v1/*`', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rarog-przekaznik-pusty-'));
    try {
      const store = createApnsDeviceStore({ dataDir: dir, now: () => T0 });
      store.upsert({ token: DEVICE, deviceId: PAIRED, ...RAROG });
      store.setRelayPass({
        pass: 'v1.k1.development.alert.9.TAJNA-martwa', expiresAt: '2027-01-31T10:00:00.000Z', origin: RELAY,
        environment: 'development', topic: 'ai.rarog.app', token: DEVICE,
      });
      await store.flush();
      const sent: string[] = [];
      const direct: ApnsSender = {
        send: (_env, token) => { sent.push(token); return Promise.resolve({ kind: 'ok' }); },
        disabledSince: () => null, close: () => {},
      };
      const h = await start({ dir, direct, noRelay: true });
      expect(h.channel.passes).toBeUndefined();
      await h.post('/api/push/apns', { token: DEVICE, ...RAROG, test: true });
      await vi.waitFor(() => { expect(h.logs).toContain('push: APNs test push → delivered'); });
      expect(await h.channel.sink.send(content)).toBe('delivered');
      expect(sent).toEqual([DEVICE, DEVICE]);
      expect(h.relay.calls).toEqual([]);
    } finally {
      // Serwer z tym katalogiem zapisuje w tle do końca `close`, więc zamknięcie idzie przed `rmSync`.
      for (const h of harnesses.splice(0)) await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
