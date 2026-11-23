/**
 * Nasłuch iroh podpięty do serwera: prawdziwy router, prawdziwe klucze urządzeń i parowanie,
 * prawdziwy terminal z atrapą herdr, a transport iroh na atrapie (`helpers/fake-iroh.ts`). TCP i iroh trafiają do
 * TEGO SAMEGO `http.Server`, więc test różnicowy porównuje odpowiedzi jednego routera po obu drogach.
 *
 * Tabela różnic — wszystko inne identyczne (także cookie bez klucza: 401 po obu drogach):
 * - `POST /api/login`: TCP 410 `login-retired`, iroh 404 (po bramce `Origin`);
 * - mutacja z `Origin` z `RAROG_ORIGINS`: TCP przechodzi, iroh 403;
 * - mutacja z `Origin` = `IROH_ORIGIN`: TCP 403, iroh przechodzi;
 * - etykieta w linii dławika: TCP adres IP (albo `X-Forwarded-For`), iroh `iroh:<12 znaków EndpointId>`;
 * - `GET /health`: TCP with the loopback `Host` gets the fields, iroh only `{"ok":true}`.
 * Statusów 400 i 408, które Node pisze tuż przed `destroy()`, po iroh nie widać (`duplex.ts`); żaden
 * wiersz tabeli ich nie wymaga.
 *
 * Do tego: odpięcie zdejmuje ochronę połączenia, a nowe urządzenie dostaje miejsce; zalew 64 połączeń
 * nieuwierzytelnionych nie rusza połączenia z kluczem; odmowy warstwy HTTP na iroh idą do budżetu logów nasłuchu.
 * Sandbox: `listen()`, więc poza nim.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { IROH_ORIGIN } from '@rarog/shared/iroh';
import {
  createDeviceStore, createLoginLimiter, createPairing, deviceAuthorization, loginPeer,
} from '../src/auth/index.ts';
import type { DeviceStore, LoginLimiter, Pairing } from '../src/auth/index.ts';
import { loadConfig } from '../src/config.ts';
import { attachDeactivation } from '../src/device-effects.ts';
import { IROH_LIMITS, startIroh } from '../src/iroh/listener.ts';
import type { IrohListener } from '../src/iroh/listener.ts';
import { registerIrohPeer } from '../src/iroh/socket.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { createTermFeature } from '../src/term/index.ts';
import type { TermFeature } from '../src/term/index.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { FakeController, FakeHerdr } from './fake-term-herdr.ts';
import { FakeClientSocket, FakeEndpoint, ManualClock, fakeClientId, until } from './helpers/fake-iroh.ts';
import type { FakeConnection } from './helpers/fake-iroh.ts';

/** Ciało dawnego logowania tokenem: serwer go nie czyta (`/api/login` po TCP to stałe 410). */
const LOGIN_BODY = { token: 'token-testowy-iroh-serwer-1' };
/** Nagłówek `Cookie` w kształcie dawnego logowania: niczego nie otwiera. */
const OLD_COOKIE = `rarog_auth=1.1700000000000.${'a'.repeat(64)}`;
const ORIGIN = 'http://localhost:8930';
const RELAY = 'https://relay.example./';
const SERVER_ID = 'e'.repeat(64);
const SERVER_IROH = { endpointId: SERVER_ID, relay: RELAY };

interface Harness {
  readonly root: string;
  readonly store: DeviceStore;
  readonly pairing: Pairing;
  readonly limiter: LoginLimiter;
  readonly term: TermFeature;
  readonly endpoint: FakeEndpoint;
  readonly clock: ManualClock;
  readonly listener: IrohListener;
  readonly logs: string[];
  /** Żądania, które dotarły do serwera (`METODA ścieżka`), w kolejności nagłówków. */
  readonly requests: string[];
  /** Nowe połączenie TCP na port serwera. */
  readonly tcp: () => Duplex;
  /** TCP port of the server (the loopback `Host` of `/health`). */
  readonly port: number;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function start(): Promise<Harness> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'iroh-serwer-')));
  const config = loadConfig({
    RAROG_ORIGINS: ORIGIN,
    RAROG_DATA_DIR: path.join(root, '.dane'),
    RAROG_PROJECT_ROOTS: root,
    RAROG_TERM: '1',
    RAROG_HERDR_LAUNCH: '1',
    RAROG_HERDR_BIN: '/usr/bin/true',
    HOME: root,
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    TMPDIR: tmpdir(),
    RAROG_IROH: '1',
    RAROG_IROH_KEY: randomBytes(32).toString('hex'),
    RAROG_IROH_RELAY: RELAY,
  });
  if (config.iroh === null || config.iroh.key === null) throw new Error('konfiguracja bez iroh');
  const logs: string[] = [];
  const logger: Logger = { info: (line) => { logs.push(line); }, error: (line) => { logs.push(`BŁĄD ${line}`); } };
  const store = createDeviceStore({ dataDir: config.dataDir, epoch: config.epoch, log: (line) => { logs.push(line); } });
  const pairing = createPairing({ store, epoch: config.epoch });
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const controllers: FakeController[] = [];
  const term = await createTermFeature(config, logger, {
    herdrLaunchClient: () => new FakeHerdr(),
    herdrSpawn: () => {
      const controller = new FakeController();
      controllers.push(controller);
      return controller;
    },
    devices: store,
  });
  if (term === null) throw new Error('terminal nie wstał');
  attachDeactivation(store, { pairing, hub, term, log: (line) => { logs.push(line); } });
  const limiter = createLoginLimiter();
  const server = http.createServer();
  const endpoint = new FakeEndpoint(SERVER_ID);
  const clock = new ManualClock();
  const listener = await startIroh(
    { secretKey: Buffer.from(config.iroh.key, 'hex'), relay: config.iroh.relay, port: config.iroh.port },
    server, logger, { open: async () => endpoint, clock, onFatal: (reason) => { logs.push(`FATAL ${reason}`); } },
  );
  const requests: string[] = [];
  server.on('request', (req: http.IncomingMessage) => { requests.push(`${req.method ?? ''} ${req.url ?? ''}`); });
  server.on('request', createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger, loginLimiter: limiter, term,
    iroh: { endpointId: listener.endpointId, relay: config.iroh.relay },
    devices: { store, pairing, serverName: 'mac-test' },
  }));
  server.on('upgrade', (req, socket, head) => { term.handleUpgrade(req, socket, head); });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  const h: Harness = {
    root, store, pairing, limiter, term, endpoint, clock, listener, logs, requests, port,
    tcp: () => net.connect(port, '127.0.0.1'),
    close: async () => {
      await listener.close();
      term.dispose();
      for (const controller of controllers) controller.kill();
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await store.flush();
      rmSync(root, { recursive: true, force: true });
    },
  };
  harnesses.push(h);
  return h;
}

/** Połączenie iroh klienta `n`, przyjęte przez nasłuch. */
async function connect(h: Harness, n: number): Promise<FakeConnection> {
  const incoming = h.endpoint.incoming(fakeClientId(n));
  await until(() => incoming.connection.biLimits.length > 0 || incoming.connection.closeCalls.length > 0,
    2_000, `rozstrzygnięcie połączenia ${String(n)}`);
  return incoming.connection;
}

/** Każde żądanie po iroh to nowy strumień dwukierunkowy tego połączenia. */
const viaIroh = (conn: FakeConnection) => (): Duplex => new FakeClientSocket(conn.openBi());

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: unknown;
}

function call(
  open: () => Duplex, method: string, route: string, headers: Record<string, string> = {}, body?: unknown,
): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: 'serwer.test', path: route, method,
      headers: payload === undefined ? headers : {
        'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)), ...headers,
      },
      createConnection: () => open(),
    }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { parts.push(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let parsed: unknown = text;
        try {
          parsed = text === '' ? null : JSON.parse(text) as unknown;
        } catch {
          parsed = text;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

interface Device {
  readonly id: string;
  readonly auth: Record<string, string>;
  readonly response: Record<string, unknown>;
}

async function pairOver(open: () => Duplex, origin: string, code: string): Promise<Device> {
  const reply = await call(open, 'POST', '/api/pair', { Origin: origin }, { v: 1, code, label: 'iPhone', build: '1700' });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  const body = reply.body as { deviceId: string; secret: string };
  return {
    id: body.deviceId, auth: { Authorization: deviceAuthorization(body.deviceId, body.secret) },
    response: reply.body as Record<string, unknown>,
  };
}

/** Odpowiedź bez pól zależnych od chwili (`uptime`). */
function stable(reply: Reply): { status: number; body: unknown } {
  const body = reply.body !== null && typeof reply.body === 'object' && !Array.isArray(reply.body)
    ? Object.fromEntries(Object.entries(reply.body).filter(([key]) => key !== 'uptime'))
    : reply.body;
  return { status: reply.status, body };
}

/** Strumień SSE do pierwszej linii `data:` (albo do końca odpowiedzi) i jego koniec. */
function openSse(open: () => Duplex, headers: Record<string, string>): Promise<{
  status: number; first: string; ended: Promise<void>; abort(): void;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'serwer.test', path: '/api/stream', headers, createConnection: () => open() }, (res) => {
      const ended = new Promise<void>((done) => { res.once('end', done); res.once('close', done); });
      let text = '';
      const onData = (chunk: Buffer): void => {
        text += chunk.toString('utf8');
        if (!text.split('\n').some((line) => line.startsWith('data: ')) || !text.includes('\n\n')) return;
        res.off('data', onData);
        resolve({ status: res.statusCode ?? 0, first: text, ended, abort: () => { req.destroy(); } });
      };
      res.on('data', onData);
      res.once('end', () => { resolve({ status: res.statusCode ?? 0, first: text, ended, abort: () => {} }); });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Typ pierwszego zdarzenia SSE (`data: {"type": …}`). */
const firstType = (chunk: string): unknown => {
  const line = chunk.split('\n').find((part) => part.startsWith('data: '));
  return line === undefined ? null : (JSON.parse(line.slice(6)) as { type?: unknown }).type;
};

describe('iroh na serwerze: test różnicowy TCP ↔ iroh', () => {
  it('te same odpowiedzi poza tabelą różnic; `iroh` w `/api/version` i w parowaniu', async () => {
    const h = await start();
    const conn = await connect(h, 1);
    const tcp = { open: h.tcp, origin: ORIGIN };
    const iroh = { open: viaIroh(conn), origin: IROH_ORIGIN };

    // Parowanie dobrym kodem po obu drogach: ta sama odpowiedź poza tożsamością nowego urządzenia.
    const first = await pairOver(tcp.open, tcp.origin, h.pairing.issue('admin').code);
    const second = await pairOver(iroh.open, iroh.origin, h.pairing.issue(first.id).code);
    expect(Object.keys(second.response).sort()).toEqual(Object.keys(first.response).sort());
    expect(second.response['server']).toEqual(first.response['server']);
    expect(first.response['server']).toMatchObject({ iroh: SERVER_IROH });

    // Odpięty i nieznany klucz.
    const revoked = await pairOver(tcp.open, tcp.origin, h.pairing.issue(first.id).code);
    expect(h.store.revoke(revoked.id, 'admin', Date.now())).toBeDefined();
    const unknown = { Authorization: deviceAuthorization(first.id, 'Z'.repeat(43)) };

    const same: Array<[string, (via: typeof tcp) => Promise<Reply>]> = [
      ['POST /api/pair zły kod', (via) => call(via.open, 'POST', '/api/pair', { Origin: via.origin },
        { v: 1, code: 'Q'.repeat(43), label: 'x' })],
      ['GET /api/version z kluczem', (via) => call(via.open, 'GET', '/api/version', first.auth)],
      ['GET /api/version bez poświadczeń', (via) => call(via.open, 'GET', '/api/version')],
      ['GET /api/version z kluczem odpiętym', (via) => call(via.open, 'GET', '/api/version', revoked.auth)],
      ['GET /api/version z kluczem nieznanym', (via) => call(via.open, 'GET', '/api/version', unknown)],
      ['GET z obcym Origin', (via) => call(via.open, 'GET', '/api/version', { ...first.auth, Origin: 'https://obcy.example' })],
      ['POST bez Origin', (via) => call(via.open, 'POST', '/api/presence', first.auth,
        { clientId: 'c1', visible: true })],
      ['POST z obcym Origin', (via) => call(via.open, 'POST', '/api/presence', { ...first.auth, Origin: 'https://obcy.example' },
        { clientId: 'c1', visible: true })],
      ['PUT z obcym Origin', (via) => call(via.open, 'PUT', '/api/notes', { ...first.auth, Origin: 'https://obcy.example' },
        { cwd: h.root, text: 'x', baseVersion: null })],
      ['DELETE bez Origin', (via) => call(via.open, 'DELETE', '/api/term/0123456789abcdef', first.auth)],
    ];
    for (const [label, run] of same) {
      const overTcp = stable(await run(tcp));
      const overIroh = stable(await run(iroh));
      expect(overIroh, label).toEqual(overTcp);
    }
    const version = await call(iroh.open, 'GET', '/api/version', first.auth);
    expect((version.body as { iroh: unknown }).iroh).toEqual(SERVER_IROH);
    expect((await call(iroh.open, 'GET', '/api/version', revoked.auth)).body).toMatchObject({ error: 'device-revoked' });
    expect((await call(iroh.open, 'GET', '/api/version', unknown)).body).toMatchObject({ error: 'device-unknown' });

    // Cookie dawnego logowania niczego nie otwiera po żadnej drodze.
    for (const [label, via] of [['TCP', tcp], ['iroh', iroh]] as const) {
      const viaCookie = await call(via.open, 'GET', '/api/version', { Cookie: OLD_COOKIE });
      expect(viaCookie.status, `cookie po ${label}`).toBe(401);
      expect(viaCookie.body).toMatchObject({ error: 'unauthorized' });
    }

    // Tabela różnic.
    expect(await call(tcp.open, 'POST', '/api/login', { Origin: ORIGIN }, LOGIN_BODY))
      .toMatchObject({ status: 410, body: { error: 'login-retired' } });
    const loginIroh = await call(iroh.open, 'POST', '/api/login', { Origin: IROH_ORIGIN }, LOGIN_BODY);
    expect(loginIroh.status).toBe(404);
    expect(loginIroh.body).toMatchObject({ error: 'not-found' });
    expect(loginIroh.headers['set-cookie']).toBeUndefined();
    expect((await call(iroh.open, 'POST', '/api/login', { Origin: ORIGIN }, LOGIN_BODY)).status,
      'login po iroh z Origin z RAROG_ORIGINS: bramka Origin przed trasą').toBe(403);

    const presence = { clientId: 'c1', visible: true };
    expect((await call(tcp.open, 'POST', '/api/presence', { ...first.auth, Origin: ORIGIN }, presence)).status).toBe(204);
    expect((await call(iroh.open, 'POST', '/api/presence', { ...first.auth, Origin: ORIGIN }, presence)).status).toBe(403);
    expect((await call(tcp.open, 'POST', '/api/presence', { ...first.auth, Origin: IROH_ORIGIN }, presence)).status)
      .toBe(403);
    expect((await call(iroh.open, 'POST', '/api/presence', { ...first.auth, Origin: IROH_ORIGIN }, presence)).status)
      .toBe(204);
  });

  it('`/health` over iroh: only {"ok":true}, even with the loopback `Host` that opens the fields over TCP',
    async () => {
      const h = await start();
      const conn = await connect(h, 4);
      const loopback = { Host: `127.0.0.1:${String(h.port)}` };
      const overTcp = await call(h.tcp, 'GET', '/health', loopback);
      expect(overTcp.status).toBe(200);
      expect(overTcp.body).toMatchObject({ ok: true, herdr: false, authStore: 'ok' });
      const overIroh = await call(viaIroh(conn), 'GET', '/health', loopback);
      expect({ status: overIroh.status, body: overIroh.body }).toEqual({ status: 200, body: { ok: true } });
    });

  it('SSE bez Origin i z obcym: pierwsza ramka ta sama; odpięcie zamyka strumień po obu drogach', async () => {
    const h = await start();
    const conn = await connect(h, 2);
    const device = await pairOver(h.tcp, ORIGIN, h.pairing.issue('admin').code);
    for (const headers of [device.auth, { ...device.auth, Origin: 'https://obcy.example' }]) {
      const overTcp = await openSse(h.tcp, headers);
      const overIroh = await openSse(viaIroh(conn), headers);
      expect([overIroh.status, firstType(overIroh.first)]).toEqual([overTcp.status, firstType(overTcp.first)]);
      expect(firstType(overTcp.first)).toBe('hello');
      overTcp.abort();
      overIroh.abort();
    }
    const overTcp = await openSse(h.tcp, device.auth);
    const overIroh = await openSse(viaIroh(conn), device.auth);
    h.store.revoke(device.id, 'admin', Date.now());
    await Promise.all([overTcp.ended, overIroh.ended]);
  });

  it('upgrade terminala po iroh: klucz i `IROH_ORIGIN` przechodzą, `Origin` z `RAROG_ORIGINS` nie', async () => {
    const h = await start();
    const conn = await connect(h, 3);
    const device = await pairOver(viaIroh(conn), IROH_ORIGIN, h.pairing.issue('admin').code);
    const opened = h.term.open(h.root);
    if (!opened.ok) throw new Error('terminal się nie otworzył');
    const socket = (origin: string): WebSocket => new WebSocket(`ws://serwer.test/api/term/${opened.id}`, {
      headers: { ...device.auth, Origin: origin }, createConnection: viaIroh(conn),
    });
    const ok = socket(IROH_ORIGIN);
    const hello = await new Promise<unknown>((resolve, reject) => {
      ok.once('message', (data: Buffer) => { resolve(JSON.parse(data.toString('utf8'))); });
      ok.once('error', reject);
    });
    expect(hello).toEqual({ t: 'hello', backend: 'herdr' });
    ok.close();
    const denied = socket(ORIGIN);
    await new Promise<void>((resolve) => { denied.once('error', () => { resolve(); }); });
    expect(h.logs.filter((line) => line.startsWith('term: upgrade refused')), 'odmowa po iroh w zwykłej linii')
      .toEqual([]);
    expect(h.listener.snapshot().refusals['upgrade-refused']).toBe(1);
    expect(h.logs).toContain(`iroh: upgrade-refused ${fakeClientId(3).slice(0, 12)} origin not on the allow-list`);
    // Ta sama odmowa po TCP zostaje zwykłą linią.
    const overTcp = new WebSocket(`ws://serwer.test/api/term/${opened.id}`, {
      headers: { ...device.auth, Origin: IROH_ORIGIN }, createConnection: h.tcp,
    });
    await new Promise<void>((resolve) => { overTcp.once('error', () => { resolve(); }); });
    expect(h.logs).toContain('term: upgrade refused (origin not on the allow-list)');
  });

  it('odpięcie w trakcie ciała po iroh: 401 `device-revoked` dochodzi do klienta', async () => {
    const h = await start();
    const conn = await connect(h, 4);
    const device = await pairOver(viaIroh(conn), IROH_ORIGIN, h.pairing.issue('admin').code);
    const payload = JSON.stringify({ clientId: 'c1', visible: true });
    let release = (): void => {};
    const reply = new Promise<Reply>((resolve, reject) => {
      const req = http.request({
        host: 'serwer.test', path: '/api/presence', method: 'POST', createConnection: viaIroh(conn),
        headers: {
          ...device.auth, Origin: IROH_ORIGIN, 'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
        },
      }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { parts.push(chunk); });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(Buffer.concat(parts).toString('utf8')) });
        });
      });
      req.on('error', reject);
      req.write(payload.slice(0, 5));
      release = () => { req.end(payload.slice(5)); };
    });
    // Nagłówki doszły i przeszły bramkę klucza; ciało jeszcze nie.
    await until(() => h.requests.includes('POST /api/presence'), 2_000, 'nagłówki żądania');
    h.store.revoke(device.id, 'admin', Date.now());
    release();
    const result = await reply;
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: 'device-revoked' });
  });
});

describe('iroh na serwerze: granica uwierzytelnienia i limity połączenia', () => {
  it('klucz i parowanie uwierzytelniają połączenie; odpięcie zdejmuje ochronę, nowe urządzenie dostaje miejsce', async () => {
    const h = await start();
    const conn = await connect(h, 5);
    expect(h.listener.snapshot().connections).toEqual({ authenticated: 0, unauthenticated: 1 });
    const device = await pairOver(viaIroh(conn), IROH_ORIGIN, h.pairing.issue('admin').code);
    // Udane `POST /api/pair` uwierzytelnia połączenie, którym przyszło.
    expect(h.listener.snapshot().connections).toEqual({ authenticated: 1, unauthenticated: 0 });
    expect(conn.biLimits.at(-1)).toBe(IROH_LIMITS.biStreamsAfterAuth);

    h.store.revoke(device.id, 'admin', Date.now());
    expect(h.listener.snapshot().connections).toEqual({ authenticated: 0, unauthenticated: 1 });
    expect(conn.biLimits.at(-1)).toBe(IROH_LIMITS.biStreamsBeforeAuth);
    expect((await call(viaIroh(conn), 'GET', '/api/version', device.auth)).body)
      .toMatchObject({ error: 'device-revoked' });

    // Nowe urządzenie (kod `admin`, bo aktywnych już nie ma) na nowym połączeniu.
    const other = await pairOver(h.tcp, ORIGIN, h.pairing.issue('admin').code);
    const fresh = await connect(h, 6);
    expect((await call(viaIroh(fresh), 'GET', '/api/devices/me', other.auth)).status).toBe(200);
    expect(h.listener.snapshot().connections).toEqual({ authenticated: 1, unauthenticated: 1 });
    // Połączenie odpiętego urządzenia ma znów termin: po 60 s bez klucza zamknięte.
    await h.clock.advance(IROH_LIMITS.authTimeoutMs);
    expect(conn.closeCalls.at(-1)).toEqual({ code: 4, reason: 'auth-timeout' });
    expect(fresh.closeCalls).toEqual([]);
  });

  // Odpięcie w trakcie `persist()` parowania wysyła zdarzenie, zanim urządzenie trafi do
  // połączenia; dopisane później zostałoby tam na zawsze (ochrona przed wyparciem, 32 strumienie, bez terminu).
  it('odpięcie nowego urządzenia w trakcie zapisu parowania: połączenie zostaje nieuwierzytelnione z terminem 60 s', async () => {
    const h = await start();
    const conn = await connect(h, 7);
    const persist = h.store.persist.bind(h.store);
    let entered!: () => void;
    const inPersist = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    h.store.persist = async () => {
      entered();
      await held;
      await persist();
    };
    const reply = call(viaIroh(conn), 'POST', '/api/pair', { Origin: IROH_ORIGIN },
      { v: 1, code: h.pairing.issue('admin').code, label: 'iPhone', build: '1700' });
    await inPersist;
    expect(h.store.revokeAll('admin', Date.now())).toHaveLength(1);
    release();
    // Odpowiedź jak po TCP przy tym samym wyścigu: parowanie zapisane, odpięcie to osobne zdarzenie po nim.
    expect((await reply).status).toBe(200);
    expect(h.listener.snapshot().connections).toEqual({ authenticated: 0, unauthenticated: 1 });
    expect(conn.biLimits.at(-1)).toBe(IROH_LIMITS.biStreamsBeforeAuth);
    await h.clock.advance(IROH_LIMITS.authTimeoutMs);
    expect(conn.closeCalls.at(-1)).toEqual({ code: 4, reason: 'auth-timeout' });
  });

  it('zalew 64 połączeń bez klucza nie rusza połączenia z kluczem; wyparte także przed pierwszym żądaniem', async () => {
    const h = await start();
    const owner = await connect(h, 10);
    const device = await pairOver(viaIroh(owner), IROH_ORIGIN, h.pairing.issue('admin').code);
    expect((await call(viaIroh(owner), 'GET', '/api/devices/me', device.auth)).status).toBe(200);
    const flood: FakeConnection[] = [];
    for (let n = 0; n < IROH_LIMITS.connections; n += 1) flood.push(await connect(h, 100 + n));
    // 1 z kluczem + 63 bez = limit; 64. zalewu wyparł najstarsze nieuwierzytelnione, zanim wysłało cokolwiek.
    expect(flood[0]?.closeCalls).toEqual([{ code: 3, reason: 'evicted' }]);
    expect(flood.slice(1).every((conn) => conn.closeCalls.length === 0)).toBe(true);
    expect(owner.closeCalls).toEqual([]);
    expect(h.listener.snapshot().connections).toEqual({ authenticated: 1, unauthenticated: IROH_LIMITS.connections - 1 });
    expect((await call(viaIroh(owner), 'GET', '/api/version', device.auth)).status).toBe(200);
  });

  it('`loginPeer` na gnieździe iroh: etykieta z EndpointId, `X-Forwarded-For` pominięty', () => {
    const handle = registerIrohPeer(fakeClientId(7), () => {});
    const socket = {};
    handle.attach(socket);
    const req = { headers: { 'x-forwarded-for': '203.0.113.9' }, socket } as unknown as http.IncomingMessage;
    expect(loginPeer(req)).toBe(`iroh:${fakeClientId(7).slice(0, 12)}`);
    const tcp = { headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' } };
    expect(loginPeer(tcp as unknown as http.IncomingMessage)).toBe('203.0.113.9');
    handle.dispose();
  });

  it('linia dławika: po TCP adres, po iroh `iroh:<id>` mimo `X-Forwarded-For`', async () => {
    const h = await start();
    const conn = await connect(h, 8);
    const bad = { Authorization: deviceAuthorization('d0123456789abcdef', 'Z'.repeat(43)) };
    await call(h.tcp, 'GET', '/api/version', bad);
    expect(h.logs).toContain('failed device key attempt (127.0.0.1)');
    h.limiter.succeed();
    await call(viaIroh(conn), 'GET', '/api/version', { ...bad, 'X-Forwarded-For': '203.0.113.9' });
    expect(h.logs).toContain(`failed device key attempt (iroh:${fakeClientId(8).slice(0, 12)})`);
    expect(h.logs.join('\n')).not.toContain('203.0.113.9');
  });

  it('odmowy `Origin` i `/api/login` po iroh idą do budżetu logów nasłuchu, po TCP zostają zwykłą linią', async () => {
    const h = await start();
    const conn = await connect(h, 9);
    const short = fakeClientId(9).slice(0, 12);
    for (let i = 0; i < 3; i += 1) await call(viaIroh(conn), 'POST', '/api/presence', { Origin: ORIGIN }, {});
    await call(viaIroh(conn), 'POST', '/api/login', { Origin: IROH_ORIGIN }, LOGIN_BODY);
    await call(viaIroh(conn), 'GET', '/api/login');
    expect(h.listener.snapshot().refusals).toMatchObject({ origin: 3, login: 2 });
    expect(h.logs.filter((line) => line.startsWith('refused '))).toEqual([]);
    expect(h.logs.filter((line) => line.startsWith('iroh: origin '))).toEqual([`iroh: origin ${short} POST /api/presence`]);
    expect(h.logs.filter((line) => line.startsWith('iroh: login '))).toEqual([`iroh: login ${short} POST /api/login`]);
    await call(h.tcp, 'POST', '/api/presence', { Origin: IROH_ORIGIN }, {});
    expect(h.logs).toContain('refused POST /api/presence: origin outside the allow-list');
    expect(h.listener.snapshot().refusals.origin).toBe(3);
  });
});
