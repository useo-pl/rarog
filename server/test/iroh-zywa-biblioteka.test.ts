/**
 * Żywa biblioteka iroh: serwer (`startIroh` z prawdziwym `openEndpoint`) i klient w jednym procesie,
 * połączenie po adresie pętli bez relaya. Sprawdza fakty z rejestru w `server/src/iroh/adapter.ts`: postać
 * EndpointId, zamknięcie połączenia kończy zablokowane `reset`/`stop` (eskalacja), żądanie HTTP przez
 * `emit('connection')`, zajęty port i zamknięcie w terminie. Also fact 13 (path events) and the path log lines.
 *
 * Domyślnie pomijany: włącza go `RAROG_TEST_IROH=1` (Apple silicon albo Linux z paczką platformy). Poza sandboksem:
 * `bind()` w sandboksie pada na `Failed to create netmon monitor`.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IROH_ALPN } from '@rarog/shared/iroh';
import { loadIroh, openEndpoint } from '../src/iroh/adapter.ts';
import type { IrohModule } from '../src/iroh/adapter.ts';
import { IROH_LIMITS, startIroh } from '../src/iroh/listener.ts';
import type { IrohListener } from '../src/iroh/listener.ts';
import { irohPeerLabel, isIrohSocket, markAuthenticated } from '../src/iroh/socket.ts';
import { until } from './helpers/fake-iroh.ts';

const LIVE = process.env.RAROG_TEST_IROH === '1';
const ALPN = Array.from(Buffer.from(IROH_ALPN));

type ClientEndpoint = Awaited<ReturnType<ReturnType<IrohModule['Endpoint']['builder']>['bind']>>;
type ClientConnection = Awaited<ReturnType<ClientEndpoint['connect']>>;
type ClientBi = Awaited<ReturnType<ClientConnection['openBi']>>;

/** Wynik obietnicy albo napis `PENDING` po `ms` (fakt, że operacja wisi). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'PENDING'> {
  return Promise.race([promise, new Promise<'PENDING'>((resolve) => { setTimeout(() => { resolve('PENDING'); }, ms); })]);
}

describe.skipIf(!LIVE)('żywa biblioteka iroh (only with RAROG_TEST_IROH=1)', () => {
  let lib: IrohModule;
  let server: http.Server;
  let listener: IrohListener;
  let clientEndpoint: ClientEndpoint;
  const lines: string[] = [];
  const key = new Uint8Array(randomBytes(32));

  beforeAll(async () => {
    lib = await loadIroh();
    server = http.createServer((req, res) => {
      if (req.url === '/big') {
        // Klient nie czyta: zapis staje na kontroli przepływu, a gniazdo ginie z `reset` i `stop` w toku.
        res.write(Buffer.alloc(8 * 1024 * 1024, 0x62));
        setImmediate(() => { req.socket.destroy(); });
        return;
      }
      // Authentication like the auth gate (the path log starts at the first device).
      if (req.url === '/auth') markAuthenticated(req.socket, 'live-device');
      res.setHeader('connection', 'close');
      res.end(JSON.stringify({ iroh: isIrohSocket(req.socket), label: irohPeerLabel(req.socket) }));
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    listener = await startIroh({ secretKey: key, relay: null, port: null }, server, {
      info: (line) => { lines.push(line); },
      error: (line) => { lines.push(`BŁĄD ${line}`); },
    }, { open: (options) => openEndpoint(options, lib), onFatal: (reason) => { lines.push(`FATAL ${reason}`); } });
    const builder = lib.Endpoint.builder();
    lib.presetMinimal(builder);
    builder.alpns([ALPN]);
    builder.relayMode(lib.RelayMode.disabled());
    builder.bindAddr('127.0.0.1:0');
    clientEndpoint = await builder.bind();
  });

  afterAll(async () => {
    await listener.close();
    await clientEndpoint.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });

  /** Adres pętli serwera z gniazda IPv4 endpointu (port od systemu). */
  function loopback(): string {
    const v4 = listener.snapshot().boundSockets.find((addr) => addr.startsWith('0.0.0.0:'));
    if (v4 === undefined) throw new Error(`brak gniazda IPv4: ${listener.snapshot().boundSockets.join(' ')}`);
    return `127.0.0.1:${v4.slice('0.0.0.0:'.length)}`;
  }

  async function connect(): Promise<ClientConnection> {
    const id = lib.EndpointId.fromBytes(Array.from(Buffer.from(listener.endpointId, 'hex')));
    return clientEndpoint.connect(new lib.EndpointAddr(id, null, [loopback()]), ALPN);
  }

  /** Library endpoint without the listener, on loopback, with the protocol ALPN: raw path API. */
  async function openRawServer(): Promise<ClientEndpoint> {
    const builder = lib.Endpoint.builder();
    lib.presetMinimal(builder);
    builder.alpns([ALPN]);
    builder.relayMode(lib.RelayMode.disabled());
    builder.bindAddr('127.0.0.1:0');
    return builder.bind();
  }

  async function readAll(bi: ClientBi): Promise<string> {
    const recv = bi.recv;
    const parts: Buffer[] = [];
    for (;;) {
      const bytes = await recv.read(64 * 1024);
      if (bytes.length === 0) return Buffer.concat(parts).toString('utf8');
      parts.push(Buffer.from(bytes));
    }
  }

  it('EndpointId to 64 znaki hex, ten sam co klucz publiczny i ten sam po ponownym otwarciu', async () => {
    expect(listener.endpointId).toMatch(/^[0-9a-f]{64}$/);
    expect(listener.endpointId).toBe(lib.SecretKey.fromBytes(Array.from(key)).public().toString());
    expect(lib.EndpointId.fromString(listener.endpointId).toString()).toBe(listener.endpointId);
    const again = await openEndpoint({ secretKey: key, relay: null, port: null }, lib);
    try {
      expect(again.endpointId).toBe(listener.endpointId);
    } finally {
      await again.close();
    }
    expect(clientEndpoint.id().toString()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('żądanie HTTP po strumieniu iroh trafia do `http.Server` jako gniazdo iroh z etykietą klienta', async () => {
    const conn = await connect();
    const bi = await conn.openBi();
    const send = bi.send;
    await send.writeAll(Array.from(Buffer.from('GET /x HTTP/1.1\r\nHost: iroh.rarog.invalid\r\n\r\n')));
    await send.finish();
    const response = await readAll(bi);
    expect(response).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    const body = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as { iroh: boolean; label: string };
    expect(body).toEqual({ iroh: true, label: `iroh:${clientEndpoint.id().toString().slice(0, 12)}` });
    await until(() => listener.snapshot().streams === 0, 5_000, 'miejsce strumienia wolne');
    expect(listener.snapshot()).toMatchObject({ pendingCloseOps: 0, connections: { unauthenticated: 1 } });
    expect(lines.some((line) => line.startsWith('FATAL') || line.startsWith('BŁĄD'))).toBe(false);
    conn.close(0n, []);
  });

  it('zablokowane `reset` i `stop` kończą się po zamknięciu połączenia; eskalacja po 2 s', async () => {
    const conn = await connect();
    const bi = await conn.openBi();
    await bi.send.writeAll(Array.from(Buffer.from('GET /big HTTP/1.1\r\nHost: iroh.rarog.invalid\r\n\r\n')));
    await until(() => listener.snapshot().pendingCloseOps === 2, 5_000, 'reset i stop w toku');
    const blockedAt = Date.now();
    const reason = await within(conn.closed(), 5_000);
    const escalatedAfter = Date.now() - blockedAt;
    expect(reason, 'połączenie nie zamknięte po terminie').not.toBe('PENDING');
    expect(String(reason)).toContain('close-timeout');
    expect(escalatedAfter).toBeGreaterThanOrEqual(1_500);
    expect(escalatedAfter).toBeLessThan(4_000);
    await until(() => listener.snapshot().pendingCloseOps === 0, 1_000, 'operacje zamknięcia skończone');
    expect(listener.snapshot()).toMatchObject({ streams: 0, refusals: { 'close-escalation': 1 } });
  }, 15_000);

  it('fact 13: path events come as `(null, event)`, without a replay of the path selected in the handshake', async () => {
    const raw = await openRawServer();
    try {
      const accepted = (async () => {
        const incoming = await raw.acceptNext();
        if (incoming === null) throw new Error('no incoming connection');
        return (await incoming.accept()).connect();
      })();
      const id = lib.EndpointId.fromString(raw.id().toString());
      const port = raw.boundSockets()[0]?.split(':').pop() ?? '';
      const conn = await clientEndpoint.connect(new lib.EndpointAddr(id, null, [`127.0.0.1:${port}`]), ALPN);
      const serverConn = await accepted;
      const atAccept = serverConn.paths();
      expect(atAccept.filter((path) => path.isSelected)).toEqual([
        expect.objectContaining({ isIp: true, isRelay: false, remoteAddr: expect.stringMatching(/^127\.0\.0\.1:\d+$/) }),
      ]);
      const calls: unknown[][] = [];
      const watch = serverConn.watchPathEvents((...args: unknown[]) => { calls.push(args); });
      await new Promise<void>((resolve) => { setTimeout(resolve, 300); });
      expect(calls, 'no replay of the selection made in the handshake').toEqual([]);
      conn.close(0n, []);
      await serverConn.closed();
      await until(() => calls.length > 0, 2_000, 'Closed event');
      expect(calls[0]).toEqual([null, expect.objectContaining({ kind: 'Closed', id: atAccept[0]?.id })]);
      expect(serverConn.paths().length, '`paths()` after close').toBeGreaterThan(0);
      expect(serverConn.stats().lostPackets, '`stats()` after close').toBeGreaterThanOrEqual(0);
      await watch.stop();
    } finally {
      await raw.close();
    }
  });

  it('path log: nothing before authentication; the direct path at authentication, the summary at close', async () => {
    const from = lines.length;
    const fresh = (): string[] => lines.slice(from).filter((line) => line.startsWith('iroh: path '));
    const conn = await connect();
    const short = clientEndpoint.id().toString().slice(0, 12);
    const bi = await conn.openBi();
    await bi.send.writeAll(Array.from(Buffer.from('GET /x HTTP/1.1\r\nHost: iroh.rarog.invalid\r\n\r\n')));
    await bi.send.finish();
    expect(await readAll(bi)).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(fresh(), 'no path line before authentication').toEqual([]);
    const auth = await conn.openBi();
    await auth.send.writeAll(Array.from(Buffer.from('GET /auth HTTP/1.1\r\nHost: iroh.rarog.invalid\r\n\r\n')));
    await auth.send.finish();
    expect(await readAll(auth)).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    await until(() => fresh().length > 0, 5_000, 'path line');
    expect(fresh()).toEqual([
      expect.stringMatching(new RegExp(`^iroh: path ${short} direct 127\\.0\\.0\\.1:\\d+ rtt \\d+ ms$`)),
    ]);
    conn.close(0n, []);
    await until(() => fresh().length > 1, 5_000, 'summary');
    expect(fresh()[1]).toMatch(new RegExp(
      `^iroh: path ${short} summary \\d+ s: direct \\d+ s, relay 0 s, switches 0, lost packets \\d+$`,
    ));
  });

  it('zajęty port UDP: błąd z portem i przyczyną w jednej linii', async () => {
    const port = Number(loopback().split(':').pop());
    await expect(openEndpoint({ secretKey: key, relay: null, port }, lib))
      .rejects.toThrow(new RegExp(`^iroh: endpoint did not start \\(UDP port ${String(port)}\\): .*Address already in use`));
  });

  it('zamknięcie w terminie: połączenia kodem 0, endpoint zamknięty przed 3 s', async () => {
    const conn = await connect();
    await until(() => listener.snapshot().connections.unauthenticated >= 1, 5_000, 'połączenie w tabeli');
    const started = Date.now();
    await listener.close();
    expect(Date.now() - started).toBeLessThan(IROH_LIMITS.endpointCloseMs);
    expect(lines).toContain('iroh: endpoint closed');
    expect(String(await within(conn.closed(), 2_000))).toContain('bye');
    expect(lines.some((line) => line.startsWith('FATAL'))).toBe(false);
  });
});
