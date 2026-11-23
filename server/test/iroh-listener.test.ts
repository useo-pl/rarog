/**
 * Nasłuch iroh (`server/src/iroh/listener.ts`) na atrapie transportu i zegarze ręcznym: start po `listen`,
 * wstrzykiwanie strumieni do `http.Server`, ALPN, miejsca handshake'ów, limity (połączenia,
 * wyparcie, `auth-timeout`, strumienie), eskalacja zamknięcia, budżet logów, śmierć pętli i zamknięcie.
 *
 * Uwierzytelnienie udaje trasa `/auth?device=…`, która woła `markAuthenticated` tak, jak zrobi to granica auth.
 * Sandbox: `listen()`, więc poza nim.
 */
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IROH_LIMITS, IROH_LISTENING_LOG, IROH_STREAM_REFUSED, startIroh } from '../src/iroh/listener.ts';
import type { IrohListener } from '../src/iroh/listener.ts';
import { irohPeerLabel, isIrohSocket, markAuthenticated, revokeDevice } from '../src/iroh/socket.ts';
import {
  FakeClientSocket, FakeEndpoint, ManualClock, fakeClientId, settle, until,
} from './helpers/fake-iroh.ts';
import type { FakeBiStream, FakeConnection, FakeIncoming, FakeIncomingOptions } from './helpers/fake-iroh.ts';

interface Harness {
  readonly endpoint: FakeEndpoint;
  readonly clock: ManualClock;
  readonly server: http.Server;
  readonly listener: IrohListener;
  readonly lines: string[];
  readonly fatal: string[];
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.listener.close();
    h.server.closeAllConnections();
    await new Promise<void>((resolve) => { h.server.close(() => { resolve(); }); });
  }
});

/** Trasa testowa: `/auth?device=X` uwierzytelnia połączenie, `/big` pisze 1 MiB, reszta oddaje etykietę gniazda. */
function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://iroh.rarog.invalid');
  const device = url.searchParams.get('device');
  if (url.pathname === '/auth' && device !== null) markAuthenticated(req.socket, device);
  if (url.pathname === '/hold') return; // ani odczytu ciała, ani odpowiedzi: gniazdo stoi na backpressure
  if (url.pathname === '/big') {
    res.write(Buffer.alloc(1024 * 1024, 0x64));
    setImmediate(() => { req.socket.destroy(); });
    return;
  }
  res.end(JSON.stringify({ iroh: isIrohSocket(req.socket), label: irohPeerLabel(req.socket) }));
}

async function harness(options: { listen?: boolean; relay?: string | null } = {}): Promise<Harness> {
  const endpoint = new FakeEndpoint();
  const clock = new ManualClock();
  const lines: string[] = [];
  const fatal: string[] = [];
  const server = http.createServer(handler);
  const listener = await startIroh(
    { secretKey: new Uint8Array(32), relay: options.relay === undefined ? 'https://relay.example./' : options.relay,
      port: null }, server,
    { info: (line) => { lines.push(line); }, error: (line) => { lines.push(`BŁĄD ${line}`); } },
    { open: async () => endpoint, clock, onFatal: (reason) => { fatal.push(reason); } },
  );
  const h = { endpoint, clock, server, listener, lines, fatal };
  harnesses.push(h);
  if (options.listen !== false) await listen(server);
  return h;
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
}

/** Próba połączenia i czekanie, aż nasłuch ją rozstrzygnie (przyjęcie albo zamknięcie). */
async function connect(h: Harness, n: number, options: FakeIncomingOptions = {}): Promise<FakeConnection> {
  const incoming = h.endpoint.incoming(fakeClientId(n), options);
  await until(() => incoming.connection.biLimits.length > 0 || incoming.connection.closeCalls.length > 0,
    2_000, `rozstrzygnięcie połączenia ${String(n)}`);
  return incoming.connection;
}

function get(client: FakeBiStream, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: 'iroh.rarog.invalid', path, createConnection: () => new FakeClientSocket(client),
    }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { parts.push(chunk); });
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') }); });
    });
    req.on('error', reject);
    req.end();
  });
}

async function authenticate(conn: FakeConnection, device: string): Promise<void> {
  const reply = await get(conn.openBi(), `/auth?device=${device}`);
  expect(reply.status).toBe(200);
}

const isOpen = (conn: FakeConnection): boolean => conn.closeCalls.length === 0 && !conn.isClosed;

describe('nasłuch iroh: start i strumienie', () => {
  it('pętla przyjmowania rusza dopiero przy `listening` serwera HTTP', async () => {
    const h = await harness({ listen: false });
    const incoming = h.endpoint.incoming(fakeClientId(1));
    await settle(10);
    expect(incoming.connection.biLimits, 'połączenie przyjęte przed `listen`').toEqual([]);
    await listen(h.server);
    await until(() => incoming.connection.biLimits.length > 0, 2_000, 'przyjęcie po listen');
    expect(h.lines.some((line) => line.startsWith(`${IROH_LISTENING_LOG} (EndpointId ${'e'.repeat(64)}`)))
      .toBe(true);
  });

  it('strumień trafia do `http.Server` jako gniazdo iroh z etykietą klienta', async () => {
    const h = await harness();
    const conn = await connect(h, 7);
    const reply = await get(conn.openBi(), '/x');
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ iroh: true, label: `iroh:${fakeClientId(7).slice(0, 12)}` });
    expect(conn.biLimits).toEqual([IROH_LIMITS.biStreamsBeforeAuth]);
    expect(conn.uniLimits).toEqual([0]);
    // `Connection: close`: oba kierunki kończą się FIN, więc miejsce wraca bez `reset` i `stop`.
    await until(() => h.listener.snapshot().streams === 0, 2_000, 'miejsce strumienia wolne');
    expect(conn.pairs[0]?.server.ops).toMatchObject({ reset: 0, stop: 0 });
    expect(h.listener.snapshot()).toMatchObject({
      connections: { authenticated: 0, unauthenticated: 1 }, handshakes: 0, pendingCloseOps: 0,
    });
  });

  it('strumień bez żądania zamyka bezczynność `keepAliveTimeout` + 1 s', async () => {
    const h = await harness();
    h.server.keepAliveTimeout = 5_000;
    const conn = await connect(h, 2);
    const client = conn.openBi();
    await until(() => h.listener.snapshot().streams === 1, 2_000, 'strumień w nasłuchu');
    await h.clock.advance(5_999);
    expect(conn.pairs[0]?.server.ops.reset).toBe(0);
    await h.clock.advance(1);
    await expect(client.read(10)).rejects.toThrow(/Reset\(0\)/);
  });

  it('inny ALPN: połączenie zamknięte kodem 1, bez wpisu w tabeli, miejsce handshake\'u wolne', async () => {
    const h = await harness();
    const conn = await connect(h, 3, { alpn: 'h3' });
    expect(conn.closeCalls).toEqual([{ code: 1, reason: 'alpn' }]);
    expect(h.listener.snapshot()).toMatchObject({ connections: { authenticated: 0, unauthenticated: 0 }, handshakes: 0 });
    expect(h.lines.filter((line) => line.startsWith('iroh: alpn "h3" from '))).toHaveLength(1);
  });

  it('strumień jednokierunkowy dostaje od razu `stop`', async () => {
    const h = await harness();
    const conn = await connect(h, 4);
    conn.openUni();
    await until(() => conn.uniStops[0] === IROH_STREAM_REFUSED, 2_000, 'stop strumienia jednokierunkowego');
    expect(h.listener.snapshot().refusals['uni-stream']).toBe(1);
  });
});

describe('nasłuch iroh: handshake\'i w toku', () => {
  it(`ponad ${String(IROH_LIMITS.handshakes)} handshake'ów w toku: nadmiar dostaje \`refuse()\``, async () => {
    const h = await harness();
    const held: FakeIncoming[] = [];
    for (let i = 0; i < IROH_LIMITS.handshakes; i += 1) held.push(h.endpoint.incoming(fakeClientId(100 + i), { hold: true }));
    await until(() => h.listener.snapshot().handshakes === IROH_LIMITS.handshakes, 2_000, 'handshake\'i w toku');
    const extra = h.endpoint.incoming(fakeClientId(200));
    await until(() => extra.refused, 2_000, 'odmowa nadmiaru');
    for (const incoming of held) incoming.release();
    await until(() => h.listener.snapshot().handshakes === 0, 2_000, 'miejsca wolne');
    expect(h.listener.snapshot().connections.unauthenticated).toBe(IROH_LIMITS.handshakes);
  });

  it.each(['accept', 'alpn', 'connect'] as const)('błąd na etapie `%s` zwalnia miejsce handshake\'u', async (fail) => {
    const h = await harness();
    const incoming = h.endpoint.incoming(fakeClientId(5), { fail });
    await until(() => h.listener.snapshot().refusals['handshake-error'] === 1, 2_000, 'błąd handshake\'u');
    expect(h.listener.snapshot().handshakes).toBe(0);
    expect(incoming.connection.biLimits).toEqual([]);
  });

  it('a handshake error reason from the peer reaches the log without terminal control', async () => {
    const h = await harness();
    const incoming = h.endpoint.incoming(fakeClientId(6));
    vi.spyOn(incoming, 'accept').mockRejectedValue(
      new Error(`bad${String.fromCodePoint(0x1b)}[2Jcert\nCaused by:\n    peer${String.fromCodePoint(0x9b)}2J`),
    );
    await until(() => h.listener.snapshot().refusals['handshake-error'] === 1, 2_000, 'handshake error');
    expect(h.lines).toContain('iroh: handshake-error bad?[2Jcert: peer?2J');
  });
});

describe('nasłuch iroh: limit połączeń i wyparcie', () => {
  it('ponad limit: najstarsze NIEuwierzytelnione wypada, uwierzytelnione zostaje', async () => {
    const h = await harness();
    const device = await connect(h, 1);
    await authenticate(device, 'urz-1');
    const others: FakeConnection[] = [];
    for (let i = 2; i <= IROH_LIMITS.connections; i += 1) others.push(await connect(h, i));
    expect(h.listener.snapshot().connections).toEqual({ authenticated: 1, unauthenticated: IROH_LIMITS.connections - 1 });

    const newcomer = await connect(h, 1000);
    expect(isOpen(device)).toBe(true);
    expect(others[0]?.closeCalls).toEqual([{ code: 3, reason: 'evicted' }]);
    expect(isOpen(newcomer)).toBe(true);
    expect(h.listener.snapshot().connections).toEqual({ authenticated: 1, unauthenticated: IROH_LIMITS.connections - 1 });
  });

  it('wszystkie uwierzytelnione: nowe połączenie zamknięte jako `busy`', async () => {
    const h = await harness();
    for (let i = 1; i <= IROH_LIMITS.connections; i += 1) await authenticate(await connect(h, i), `urz-${String(i)}`);
    const newcomer = await connect(h, 1000);
    expect(newcomer.closeCalls).toEqual([{ code: 2, reason: 'busy' }]);
    expect(h.listener.snapshot().connections.authenticated).toBe(IROH_LIMITS.connections);
  });

  it('nowe urządzenie przechodzi, gdy jego żądanie zdąży przed 64 nowszymi; inaczej zalew je wypiera', async () => {
    const h = await harness();
    const fast = await connect(h, 1);
    await authenticate(fast, 'nowe-szybkie');
    const slow = await connect(h, 2);
    for (let i = 0; i < IROH_LIMITS.connections; i += 1) await connect(h, 500 + i);
    expect(isOpen(fast), 'uwierzytelnione wyparte przez zalew').toBe(true);
    expect(slow.closeCalls, 'połączenie bez żądania przeżyło 64 nowsze').toEqual([{ code: 3, reason: 'evicted' }]);
    expect(h.listener.snapshot().refusals.evicted).toBeGreaterThanOrEqual(1);
  });
});

describe('nasłuch iroh: termin uwierzytelnienia i odpięcie', () => {
  it('połączenie bez urządzenia żyje 60 s; urządzenie zdejmuje termin, odpięcie daje nowe 60 s', async () => {
    const h = await harness();
    const idle = await connect(h, 1);
    const device = await connect(h, 2);
    await h.clock.advance(IROH_LIMITS.authTimeoutMs - 1_000);
    await authenticate(device, 'urz-a');
    expect(device.biLimits).toEqual([IROH_LIMITS.biStreamsBeforeAuth, IROH_LIMITS.biStreamsAfterAuth]);
    await h.clock.advance(1_000);
    expect(idle.closeCalls).toEqual([{ code: 4, reason: 'auth-timeout' }]);
    expect(isOpen(device)).toBe(true);

    await h.clock.advance(10 * IROH_LIMITS.authTimeoutMs);
    expect(isOpen(device)).toBe(true);
    revokeDevice('urz-a');
    expect(device.biLimits.at(-1)).toBe(IROH_LIMITS.biStreamsBeforeAuth);
    expect(h.listener.snapshot().connections).toEqual({ authenticated: 0, unauthenticated: 1 });
    await h.clock.advance(IROH_LIMITS.authTimeoutMs - 1);
    expect(isOpen(device)).toBe(true);
    await h.clock.advance(1);
    expect(device.closeCalls).toEqual([{ code: 4, reason: 'auth-timeout' }]);
  });

  it('dwa urządzenia na jednym połączeniu: odpięcie jednego zostawia uwierzytelnienie', async () => {
    const h = await harness();
    const conn = await connect(h, 1);
    await authenticate(conn, 'urz-a');
    await authenticate(conn, 'urz-b');
    revokeDevice('urz-a');
    expect(h.listener.snapshot().connections.authenticated).toBe(1);
    revokeDevice('urz-b');
    expect(h.listener.snapshot().connections.authenticated).toBe(0);
  });
});

describe('nasłuch iroh: limit strumieni dwukierunkowych', () => {
  const before = String(IROH_LIMITS.biStreamsBeforeAuth);
  const after = String(IROH_LIMITS.biStreamsAfterAuth);
  it(`${before} przed uwierzytelnieniem, ${after} po; nadmiar dostaje reset i stop`, async () => {
    const h = await harness();
    const conn = await connect(h, 1);
    for (let i = 0; i < IROH_LIMITS.biStreamsBeforeAuth + 1; i += 1) conn.openBi();
    const extra = conn.pairs[IROH_LIMITS.biStreamsBeforeAuth]?.server;
    await until(() => extra?.ops.reset === 1 && extra.ops.stop === 1, 2_000, 'odmowa strumienia ponad limit');
    expect(h.listener.snapshot().streams).toBe(IROH_LIMITS.biStreamsBeforeAuth);
    expect(h.listener.snapshot().refusals['stream-limit']).toBe(1);

    // Uwierzytelnienie idzie jednym z otwartych strumieni (żądanie na strumieniu 0).
    const first = conn.pairs[0]?.client;
    if (first === undefined) throw new Error('brak strumienia');
    expect((await get(first, '/auth?device=urz-s')).status).toBe(200);
    const open = IROH_LIMITS.biStreamsBeforeAuth - 1;
    await until(() => h.listener.snapshot().streams === open, 2_000, 'strumień żądania zamknięty');
    for (let i = 0; i < IROH_LIMITS.biStreamsAfterAuth - open + 1; i += 1) conn.openBi();
    await until(() => h.listener.snapshot().refusals['stream-limit'] === 2, 2_000, 'drugi strumień ponad limit');
    expect(h.listener.snapshot().streams).toBe(IROH_LIMITS.biStreamsAfterAuth);
  });
});

describe('nasłuch iroh: koniec połączenia niszczy jego gniazda', () => {
  it('zerwane połączenie zamyka gniazdo, które nie czeka na odczyt (pełny bufor, ciało nieczytane)', async () => {
    const h = await harness();
    const conn = await connect(h, 30);
    const client = conn.openBi();
    const head = 'POST /hold HTTP/1.1\r\nHost: iroh.rarog.invalid\r\nContent-Length: 1048576\r\n\r\n';
    void client.write(Buffer.concat([Buffer.from(head), Buffer.alloc(1024 * 1024, 0x61)])).catch(() => {});
    const server = conn.pairs[0]?.server;
    if (server === undefined) throw new Error('brak końca serwera');
    // Pętla odczytu stoi na backpressure: dane czekają w strumieniu, a odczytu natywnego w toku nie ma.
    await until(() => server.ops.read > 1 && server.inboundBuffered > 0 && !server.recvLock.held, 2_000, 'backpressure');
    await settle(10);
    expect(server.recvLock.held).toBe(false);
    conn.peerClose();
    await until(() => h.listener.snapshot().streams === 0, 2_000, 'gniazdo zamknięte po zerwaniu połączenia');
    expect(h.listener.snapshot()).toMatchObject({ pendingCloseOps: 0, connections: { unauthenticated: 0 } });
  });

  it('wyparcie zamyka gniazda wypartego połączenia', async () => {
    const h = await harness();
    const victim = await connect(h, 1);
    victim.openBi();
    await until(() => h.listener.snapshot().streams === 1, 2_000, 'strumień ofiary');
    for (let i = 2; i <= IROH_LIMITS.connections + 1; i += 1) await connect(h, i);
    expect(victim.closeCalls).toEqual([{ code: 3, reason: 'evicted' }]);
    await until(() => h.listener.snapshot().streams === 0, 2_000, 'gniazdo wypartego połączenia');
  });
});

describe('nasłuch iroh: eskalacja zamknięcia', () => {
  it('zablokowany `reset` po 2 s zamyka połączenie; wiele cykli bez przyrostu zaległych operacji', async () => {
    const h = await harness();
    const cycles = 5;
    for (let i = 0; i < cycles; i += 1) {
      const conn = await connect(h, 10 + i, { window: 4 * 1024 });
      const client = conn.openBi();
      void client.write(Buffer.from('GET /big HTTP/1.1\r\nHost: iroh.rarog.invalid\r\n\r\n'));
      // Trasa pisze 1 MiB, klient nie czyta, trasa niszczy gniazdo: `reset` czeka na zapis, `stop` na odczyt.
      await until(() => h.listener.snapshot().pendingCloseOps === 2, 2_000, `operacje zamknięcia, cykl ${String(i)}`);
      expect(isOpen(conn)).toBe(true);
      await h.clock.advance(1_999);
      expect(isOpen(conn), 'eskalacja przed terminem').toBe(true);
      await h.clock.advance(1);
      expect(conn.closeCalls).toEqual([{ code: 5, reason: 'close-timeout' }]);
      await until(() => h.listener.snapshot().pendingCloseOps === 0, 2_000, `koniec operacji, cykl ${String(i)}`);
    }
    expect(h.listener.snapshot()).toMatchObject({
      streams: 0, pendingCloseOps: 0, connections: { authenticated: 0, unauthenticated: 0 },
    });
    expect(h.listener.snapshot().refusals['close-escalation']).toBe(cycles);
  });
});

describe('nasłuch iroh: budżet logów', () => {
  it('pierwsza linia rodzaju w oknie 60 s, potem jedna linia podsumowania', async () => {
    const h = await harness();
    for (let i = 0; i < 3; i += 1) await connect(h, 20 + i, { alpn: 'h3' });
    expect(h.lines.filter((line) => line.startsWith('iroh: alpn '))).toHaveLength(1);
    await h.clock.advance(60_000);
    expect(h.lines).toContain('iroh: refusals in a 60 s window: alpn 3 (suppressed lines: 2)');
    expect(h.listener.snapshot().refusals.alpn).toBe(3);
  });
});

describe('nasłuch iroh: śmierć pętli i zamknięcie', () => {
  it('`acceptNext` oddające `null` poza zamykaniem woła `onFatal`', async () => {
    const h = await harness();
    h.endpoint.breakAccept(null);
    await until(() => h.fatal.length === 1, 2_000, 'onFatal');
    expect(h.fatal).toEqual(['acceptNext oddało null']);
  });

  it('`acceptNext` rzucające poza zamykaniem woła `onFatal` z przyczyną', async () => {
    const h = await harness();
    h.endpoint.breakAccept(new Error('Endpoint closed\nCaused by:\n    io'));
    await until(() => h.fatal.length === 1, 2_000, 'onFatal');
    expect(h.fatal).toEqual(['acceptNext rzuciło: Endpoint closed: io']);
  });

  it('zamknięcie: połączenia kodem 0, obserwator relaya zatrzymany, endpoint zamknięty, bez `onFatal`', async () => {
    const h = await harness();
    const conn = await connect(h, 1);
    const closing = h.listener.close();
    expect(h.listener.close()).toBe(closing);
    await closing;
    expect(conn.closeCalls).toEqual([{ code: 0, reason: 'bye' }]);
    expect(h.endpoint.watchStops).toBe(1);
    expect(h.endpoint.closeCalls).toBe(1);
    await settle(10);
    expect(h.fatal).toEqual([]);
    expect(h.lines).toContain('iroh: endpoint closed');
  });

  it('wiszące `Endpoint.close()` kończy się po terminie 3 s z linią błędu', async () => {
    const h = await harness();
    h.endpoint.closeHangs = true;
    let done = false;
    void h.listener.close().then(() => { done = true; });
    await h.clock.advance(IROH_LIMITS.endpointCloseMs - 1);
    expect(done).toBe(false);
    await h.clock.advance(1);
    expect(done).toBe(true);
    expect(h.lines).toContain('BŁĄD iroh: Endpoint.close() timed out after 3000 ms');
  });

  it('relay domowy z obserwatora trafia do migawki; zdarzenie z tą samą listą przesuwa tylko `since`', async () => {
    const h = await harness();
    const relay = 'https://relay.example./';
    expect(h.listener.snapshot().homeRelay).toEqual({ relays: [], since: null });
    h.endpoint.emitRelays([relay]);
    expect(h.listener.snapshot().homeRelay).toEqual({ relays: [relay], since: h.clock.now() });
    expect(h.lines.filter((line) => line === `iroh: home relay ${relay}`)).toHaveLength(1);
    // Wiązanie gubi stan relaya (fakt 7): zmiana stanu przy tym samym adresie to drugie zdarzenie z tą samą listą.
    await h.clock.advance(5_000);
    h.endpoint.emitRelays([relay]);
    expect(h.listener.snapshot().homeRelay).toEqual({ relays: [relay], since: h.clock.now() });
    expect(h.lines.filter((line) => line === `iroh: home relay ${relay}`)).toHaveLength(1);
    h.endpoint.emitRelays([]);
    expect(h.lines).toContain('iroh: no home relay');
  });

  it('the first contact with the relay (`online()`) goes into the snapshot: start and contact time; `null` without a relay', async () => {
    const h = await harness();
    const started = h.clock.now();
    expect(h.listener.snapshot().relayContact).toEqual({ startedAt: started, firstContactAt: null });
    await h.clock.advance(4_000);
    h.endpoint.resolveOnline();
    await until(() => h.listener.snapshot().relayContact?.firstContactAt !== null, 2_000, 'first contact');
    expect(h.listener.snapshot().relayContact).toEqual({ startedAt: started, firstContactAt: started + 4_000 });
    expect(h.lines).toContain('iroh: first contact with the relay after 4000 ms');
    const bare = await harness({ relay: null });
    expect(bare.listener.snapshot().relayContact).toBeNull();
  });
});
