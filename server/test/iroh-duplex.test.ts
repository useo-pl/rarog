/**
 * `IrohDuplex` (`server/src/iroh/duplex.ts`) na atrapie transportu: wymagania (1)–(9) z pomiaru transportu po kolei,
 * zamknięcie natywne z miejscem strumienia i `http.Server`/`ws` po wstrzykniętym gnieździe.
 *
 * Sandbox: testy z `http.Server` wołają `listen()`, więc w sandboksie Claude Code idą poza nim.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { IrohDuplex } from '../src/iroh/duplex.ts';
import type { IrohCloseOp, IrohStreamSlot } from '../src/iroh/duplex.ts';
import {
  FakeClientSocket, FakeConnection, ManualClock, fakeClientId, settle, until,
} from './helpers/fake-iroh.ts';
import type { FakeBiStream } from './helpers/fake-iroh.ts';

function streamPair(window?: number): { conn: FakeConnection; server: FakeBiStream; client: FakeBiStream } {
  const conn = new FakeConnection(fakeClientId(1), window === undefined ? {} : { window });
  const client = conn.openBi();
  const server = conn.pairs[0]?.server;
  if (server === undefined) throw new Error('brak końca serwera');
  return { conn, server, client };
}

interface SlotLog {
  readonly slot: IrohStreamSlot;
  readonly closing: Array<readonly IrohCloseOp[]>;
  readonly late: Array<{ ops: readonly IrohCloseOp[]; deadlineMs: number }>;
  readonly released: Array<{ ops: readonly IrohCloseOp[]; elapsedMs: number }>;
}

function slotLog(): SlotLog {
  const log: SlotLog = {
    closing: [], late: [], released: [],
    slot: {
      closing: (ops) => { log.closing.push(ops); },
      late: (ops, deadlineMs) => { log.late.push({ ops, deadlineMs }); },
      release: (ops, elapsedMs) => { log.released.push({ ops, elapsedMs }); },
    },
  };
  return log;
}

/** Cała treść od klienta atrapy do FIN. */
async function readAll(client: FakeBiStream): Promise<string> {
  const parts: Buffer[] = [];
  for (;;) {
    const chunk = await client.read(64 * 1024);
    if (chunk === null) return Buffer.concat(parts).toString('utf8');
    parts.push(chunk);
  }
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
});

async function listening(server: http.Server): Promise<http.Server> {
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return server;
}

/** Żądanie HTTP klienta Node po atrapie (`createConnection`). */
function request(
  client: FakeBiStream, options: http.RequestOptions = {}, body?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      // Bez `agent`: tylko wtedy `http` bierze gniazdo z `createConnection` (z `agent: false` robi własnego agenta).
      host: 'iroh.rarog.invalid', path: '/', ...options,
      createConnection: () => new FakeClientSocket(client),
    }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { parts.push(chunk); });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8'), headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('IrohDuplex: wymagania z pomiaru transportu', () => {
  it('(1) setTimeout: licznik bezczynności liczy odczyt i zapis, `0` go wyłącza', async () => {
    const clock = new ManualClock();
    const { server, client } = streamPair();
    const duplex = new IrohDuplex(server, { clock });
    const timeouts = vi.fn();
    duplex.on('timeout', timeouts);
    duplex.resume();
    expect(duplex.setTimeout(1_000)).toBe(duplex);

    await clock.advance(900);
    await client.write(Buffer.from('a'));
    await settle();
    await clock.advance(900);
    expect(timeouts, 'odczyt nie przesunął licznika').not.toHaveBeenCalled();
    duplex.write('b');
    await settle();
    await clock.advance(900);
    expect(timeouts, 'zapis nie przesunął licznika').not.toHaveBeenCalled();
    await clock.advance(200);
    expect(timeouts).toHaveBeenCalledTimes(1);

    const callback = vi.fn();
    duplex.setTimeout(500, callback);
    duplex.setTimeout(0, callback);
    await clock.advance(5_000);
    expect(callback).not.toHaveBeenCalled();
    expect(timeouts).toHaveBeenCalledTimes(1);
    duplex.destroy();
  });

  it('(2) `headersTimeout` działa na wstrzykniętym gnieździe tylko po `listen`', async () => {
    const options = { headersTimeout: 150, requestTimeout: 0, connectionsCheckingInterval: 25 };
    const make = (): { server: http.Server; client: FakeBiStream; duplex: IrohDuplex } => {
      const server = http.createServer(options, (_req, res) => { res.end('ok'); });
      const { server: end, client } = streamPair();
      const duplex = new IrohDuplex(end);
      return { server, client, duplex };
    };

    const bound = make();
    await listening(bound.server);
    bound.server.emit('connection', bound.duplex);
    await bound.client.write(Buffer.from('GET / HTTP/1.1\r\nHost: iroh.rarog.invalid\r\n'));
    // Node pisze 408 i od razu niszczy gniazdo; `destroy()` to `reset`, więc odpowiedź po iroh nie dochodzi
    // (na TCP dochodzi). Sprawdzamy to, co jest granicą: serwer zamyka gniazdo po `headersTimeout`.
    await until(() => bound.duplex.destroyed, 2_000, 'zamknięcie po headersTimeout');
    await expect(readAll(bound.client)).rejects.toThrow(/Reset\(0\)/);

    const unbound = make();
    unbound.server.emit('connection', unbound.duplex);
    await unbound.client.write(Buffer.from('GET / HTTP/1.1\r\nHost: iroh.rarog.invalid\r\n'));
    await new Promise<void>((resolve) => { setTimeout(resolve, 400); });
    expect(unbound.duplex.destroyed, 'bez `listen` niedokończone nagłówki wiszą (pomiar I0a)').toBe(false);
    unbound.duplex.destroy();
  });

  it('(3) `write` potwierdza dopiero po przyjęciu bajtów przez strumień', async () => {
    const { server, client } = streamPair(4);
    const duplex = new IrohDuplex(server);
    const done = vi.fn();
    duplex.write(Buffer.alloc(16, 0x61), done);
    await settle();
    expect(done, 'potwierdzenie przed przyjęciem przez strumień').not.toHaveBeenCalled();
    expect(duplex.writableLength).toBe(16);
    expect(await client.read(64)).toEqual(Buffer.alloc(16, 0x61));
    await until(() => done.mock.calls.length === 1, 1_000, 'potwierdzenie zapisu');
    expect(duplex.writableLength).toBe(0);
    duplex.destroy();
  });

  it('(4) odczyt z backpressure: pełny bufor wstrzymuje czytanie strumienia do `_read()`', async () => {
    const { server, client } = streamPair(8 * 1024 * 1024);
    const duplex = new IrohDuplex(server);
    const total = 1024 * 1024;
    await client.write(Buffer.alloc(total, 0x62));
    await client.finish();
    duplex.read(0);
    await settle(10);
    expect(server.ops.read, 'czytanie mimo pełnego bufora').toBeLessThanOrEqual(2);
    expect(server.inboundBuffered).toBeGreaterThan(total - 2 * 64 * 1024);

    let received = 0;
    duplex.on('data', (chunk: Buffer) => { received += chunk.length; });
    await new Promise<void>((resolve) => { duplex.once('end', resolve); });
    expect(received).toBe(total);
    expect(server.ops.read).toBeGreaterThan(total / (64 * 1024));
    duplex.destroy();
  });

  it('(5) `allowHalfOpen`: FIN klienta kończy odczyt, a wysyłka działa dalej i kończy się FIN', async () => {
    const { server, client } = streamPair();
    const duplex = new IrohDuplex(server);
    duplex.resume();
    const ended = new Promise<void>((resolve) => { duplex.once('end', resolve); });
    await client.finish();
    await ended;
    expect(duplex.writable).toBe(true);
    duplex.end('po FIN klienta');
    expect(await readAll(client)).toBe('po FIN klienta');
    expect(server.ops.finish).toBe(1);
  });

  it('(6) `destroy()` resetuje oba niedokończone kierunki, a `close` przychodzi od razu', async () => {
    const log = slotLog();
    const { server, client } = streamPair();
    const duplex = new IrohDuplex(server, { slot: log.slot });
    duplex.resume();
    await settle();
    const closed = new Promise<void>((resolve) => { duplex.once('close', resolve); });
    duplex.destroy();
    await closed;
    expect(server.ops.reset).toBe(1);
    expect(server.ops.stop).toBe(1);
    expect(log.closing).toEqual([['reset', 'stop']]);
    await expect(client.read(10)).rejects.toThrow(/Reset\(0\)/);
    // `stop` czeka na wiszący odczyt (mutex odbioru): miejsce wraca, gdy klient zareaguje na reset.
    expect(server.ops.stopDone).toBe(0);
    expect(log.released).toEqual([]);
    await client.reset(0);
    await until(() => log.released.length === 1, 1_000, 'zwolnienie miejsca');
    expect(log.released[0]?.ops).toEqual(['reset', 'stop']);
  });

  it('(6) błąd odczytu niszczy gniazdo z tym błędem', async () => {
    const { server } = streamPair();
    const duplex = new IrohDuplex(server);
    duplex.resume();
    await settle();
    const failed = new Promise<Error>((resolve) => { duplex.once('error', resolve); });
    server.failRead(new Error('ConnectionLost(TimedOut)'));
    expect((await failed).message).toBe('ConnectionLost(TimedOut)');
    expect(duplex.destroyed).toBe(true);
  });

  it('(6) zamknięcie czyste (FIN w obie strony) nie resetuje niczego i od razu zwalnia miejsce', async () => {
    const log = slotLog();
    const { server, client } = streamPair();
    const duplex = new IrohDuplex(server, { slot: log.slot });
    duplex.resume();
    const closed = new Promise<void>((resolve) => { duplex.once('close', resolve); });
    await client.finish();
    duplex.end('koniec');
    await closed;
    expect(await readAll(client)).toBe('koniec');
    expect(server.ops.reset + server.ops.stop).toBe(0);
    expect(log.closing).toEqual([]);
    expect(log.released).toEqual([{ ops: [], elapsedMs: 0 }]);
  });

  it('(7) zwykły rozszerzalny obiekt: `http` zapisuje na nim swoje pola, trasa widzi własne pole gniazda', async () => {
    const server = await listening(http.createServer((req, res) => {
      const socket = req.socket as unknown as { znacznik?: string };
      res.end(JSON.stringify({ iroh: req.socket instanceof IrohDuplex, znacznik: socket.znacznik ?? null }));
    }));
    const { server: end, client } = streamPair();
    const duplex = new IrohDuplex(end);
    expect(Object.isExtensible(duplex)).toBe(true);
    (duplex as unknown as { znacznik: string }).znacznik = 'próbka';
    server.emit('connection', duplex);
    const reply = await request(client, { path: '/x' });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ iroh: true, znacznik: 'próbka' });
  });

  it('(8) i (9) nie udaje gniazda TCP: bez `setNoDelay`, `setKeepAlive` i `remoteAddress`, a `ws` działa', async () => {
    const { server: end, client } = streamPair();
    const duplex = new IrohDuplex(end);
    for (const name of ['setNoDelay', 'setKeepAlive', 'remoteAddress', 'remotePort', 'bytesRead', 'bytesWritten']) {
      expect(name in duplex, name).toBe(false);
    }
    const server = await listening(http.createServer());
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data: Buffer) => { ws.send(`echo:${data.toString('utf8')}`); });
      });
    });
    server.emit('connection', duplex);
    const ws = new WebSocket('ws://iroh.rarog.invalid/term', { createConnection: () => new FakeClientSocket(client) });
    const echo = await new Promise<string>((resolve, reject) => {
      ws.once('open', () => { ws.send('ping'); });
      ws.once('message', (data: Buffer) => { resolve(data.toString('utf8')); });
      ws.once('error', reject);
    });
    expect(echo).toBe('echo:ping');
    const closed = new Promise<void>((resolve) => { duplex.once('close', resolve); });
    ws.close();
    await closed;
    wss.close();
  });
});

describe('IrohDuplex: zamknięcie natywne i miejsce strumienia', () => {
  it('zablokowany `reset` nie blokuje zamknięcia gniazda, ale nie zwalnia miejsca; po terminie `late`', async () => {
    const clock = new ManualClock();
    const log = slotLog();
    const { conn, server } = streamPair(4);
    const duplex = new IrohDuplex(server, { slot: log.slot, clock });
    duplex.resume();
    duplex.write(Buffer.alloc(64, 0x63)); // klient nie czyta: zapis trzyma mutex wysyłki
    await settle();
    const closed = new Promise<void>((resolve) => { duplex.once('close', resolve); });
    duplex.destroy();
    await closed;
    expect(log.closing).toEqual([['reset', 'stop']]);
    expect(server.sendLock.held).toBe(true);
    await clock.advance(1_999);
    expect(log.late).toEqual([]);
    await clock.advance(1);
    expect(log.late).toEqual([{ ops: ['reset', 'stop'], deadlineMs: 2_000 }]);
    expect(log.released, 'miejsce wróciło przed końcem operacji natywnych').toEqual([]);

    // Eskalacja (fakt 4): zamknięcie połączenia kończy wiszące operacje, a z nimi `reset` i `stop`.
    conn.close(5, 'close-timeout');
    await until(() => log.released.length === 1, 1_000, 'zwolnienie po eskalacji');
    expect(server.ops.resetDone).toBe(1);
    expect(server.ops.stopDone).toBe(1);
    expect(log.late).toHaveLength(1);
  });

  it('operacje, które kończą się przed terminem, nie dają `late`, a termin nie zostaje w zegarze', async () => {
    const clock = new ManualClock();
    const log = slotLog();
    const { server, client } = streamPair();
    const duplex = new IrohDuplex(server, { slot: log.slot, clock });
    await client.finish();
    duplex.resume();
    await new Promise<void>((resolve) => { duplex.once('end', resolve); });
    duplex.destroy();
    await until(() => log.released.length === 1, 1_000, 'zwolnienie');
    expect(log.released[0]?.ops).toEqual(['reset']);
    expect(clock.pending).toBe(0);
    await clock.advance(10_000);
    expect(log.late).toEqual([]);
  });
});

describe('IrohDuplex: błędy w trakcie pracy zwalniają miejsce raz', () => {
  it('błąd zapisu (klient zatrzymał odbiór) niszczy gniazdo; miejsce wraca raz, bez operacji w toku', async () => {
    const { server, client } = streamPair(1024);
    const log = slotLog();
    const duplex = new IrohDuplex(server, { slot: log.slot, clock: new ManualClock() });
    const errors: Error[] = [];
    duplex.on('error', (err: Error) => { errors.push(err); });
    duplex.on('data', () => {});
    await until(() => server.recvLock.held, 2_000, 'odczyt w toku');
    await client.stop(7);
    duplex.write(Buffer.alloc(4096));
    await until(() => errors.length === 1, 2_000, 'błąd zapisu');
    expect(errors.map((err) => err.message)).toEqual(['Stopped(7)']);
    expect(log.closing).toEqual([['reset', 'stop']]);
    // `stop` czeka na odczyt w toku (fakt 3), więc miejsce wraca dopiero z FIN klienta.
    await settle(10);
    expect(log.released).toEqual([]);
    await client.finish();
    await until(() => log.released.length === 1, 2_000, 'zwolnienie miejsca');
    await settle(10);
    expect(log.released).toHaveLength(1);
    expect(log.late).toEqual([]);
  });

  it('`destroy()` w trakcie `finish()`: jedno zwolnienie miejsca', async () => {
    const { server } = streamPair();
    const log = slotLog();
    const duplex = new IrohDuplex(server, { slot: log.slot, clock: new ManualClock() });
    duplex.on('error', () => {});
    duplex.on('data', () => {});
    duplex.end();
    duplex.destroy();
    await until(() => log.released.length === 1, 2_000, 'zwolnienie miejsca');
    await settle(10);
    expect(log.released).toHaveLength(1);
  });
});

describe('IrohDuplex w `http.Server`', () => {
  it('keep-alive: dwa żądania jednym strumieniem, potem `server.close()` zamyka bezczynne gniazdo', async () => {
    const server = await listening(http.createServer((req, res) => { res.end(`odpowiedź ${req.url ?? ''}`); }));
    const { server: end, client } = streamPair();
    const duplex = new IrohDuplex(end);
    server.emit('connection', duplex);
    await client.write(Buffer.from('GET /a HTTP/1.1\r\nHost: iroh.rarog.invalid\r\n\r\n'));
    await client.write(Buffer.from('GET /b HTTP/1.1\r\nHost: iroh.rarog.invalid\r\n\r\n'));
    let text = '';
    while (!text.includes('odpowiedź /b')) {
      const chunk = await client.read(64 * 1024);
      if (chunk === null) break;
      text += chunk.toString('utf8');
    }
    expect(text.match(/HTTP\/1\.1 200 /g)).toHaveLength(2);
    const closed = new Promise<void>((resolve) => { duplex.once('close', resolve); });
    servers.splice(servers.indexOf(server), 1);
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    await closed;
  });

  it('ciało POST przechodzi, a odpowiedź kończy się FIN po `Connection: close`', async () => {
    const server = await listening(http.createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (chunk: Buffer) => { parts.push(chunk); });
      req.on('end', () => { res.end(`bajtów ${String(Buffer.concat(parts).length)}`); });
    }));
    const { server: end, client } = streamPair(16 * 1024);
    server.emit('connection', new IrohDuplex(end));
    const body = 'x'.repeat(300_000);
    const reply = await request(client, { method: 'POST', path: '/upload', headers: { Connection: 'close' } }, body);
    expect(reply).toMatchObject({ status: 200, body: 'bajtów 300000' });
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
  });
});
