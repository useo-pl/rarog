/**
 * Path log of an iroh connection (`server/src/iroh/path-log.ts`): one line per selected path (relay or direct, with
 * the RTT), a cap per connection, the summary at close with the time on each path (manual clock), a `Lagged` event
 * resynced from `paths()`, and in the listener: only connections that authenticated get a path log, its watcher
 * stopped exactly once on connection close and on listener close. The adapter part (`watchSelectedPath`) runs on a
 * stand-in for the library connection, in both callback shapes (fact 7 and 13 in `adapter.ts`).
 * Authentication goes through the test route `/auth?device=…`, which calls `markAuthenticated` like the auth gate.
 * Sandbox: the listener cases call `listen()`, so outside it.
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { watchSelectedPath } from '../src/iroh/adapter.ts';
import type { IrohPathUpdate } from '../src/iroh/endpoint.ts';
import { startIroh } from '../src/iroh/listener.ts';
import type { IrohListener } from '../src/iroh/listener.ts';
import { PATH_LINES_PER_CONNECTION, startPathLog } from '../src/iroh/path-log.ts';
import { markAuthenticated } from '../src/iroh/socket.ts';
import {
  FakeClientSocket, FakeConnection, FakeEndpoint, ManualClock, fakeClientId, settle, until,
} from './helpers/fake-iroh.ts';

const RELAY = { relay: true, remoteAddr: 'https://relay.example./', rttMs: 40 } as const;
const DIRECT = { relay: false, remoteAddr: '192.168.1.30:5000', rttMs: 4 } as const;
const ID = fakeClientId(7);
const SHORT = ID.slice(0, 12);

function setup(): { conn: FakeConnection; clock: ManualClock; lines: string[]; close: () => Promise<void> } {
  const conn = new FakeConnection(ID);
  const clock = new ManualClock();
  const lines: string[] = [];
  const log = startPathLog(conn, SHORT, (line) => { lines.push(line); }, clock);
  return { conn, clock, lines, close: () => log.close() };
}

describe('path log: lines per selected path', () => {
  it('relay, then a direct address: two lines with the RTT', () => {
    const { conn, lines } = setup();
    conn.selectPath(RELAY);
    conn.selectPath(DIRECT);
    expect(lines).toEqual([
      `iroh: path ${SHORT} relay rtt 40 ms`,
      `iroh: path ${SHORT} direct 192.168.1.30:5000 rtt 4 ms`,
    ]);
  });

  it('RTT the library does not know: `rtt n/a`', () => {
    const { conn, lines } = setup();
    conn.selectPath({ ...DIRECT, rttMs: null });
    expect(lines).toEqual([`iroh: path ${SHORT} direct 192.168.1.30:5000 rtt n/a`]);
  });

  it(`40 switches: ${String(PATH_LINES_PER_CONNECTION)} lines, the summary counts 8 suppressed`, async () => {
    const { conn, lines, close } = setup();
    for (let i = 0; i < 40; i += 1) conn.selectPath(i % 2 === 0 ? RELAY : DIRECT);
    expect(lines).toHaveLength(32);
    await close();
    expect(lines).toHaveLength(33);
    expect(lines[32]).toMatch(/, switches 40, lost packets 0, suppressed 8$/);
  });
});

describe('path log: summary at close', () => {
  it('10 s on the relay and 50 s direct: total, time per path, switches and lost packets', async () => {
    const { conn, clock, lines, close } = setup();
    conn.lost = 3;
    conn.selectPath(RELAY);
    await clock.advance(10_000);
    conn.selectPath(DIRECT);
    await clock.advance(50_000);
    await close();
    expect(lines.at(-1)).toBe(
      `iroh: path ${SHORT} summary 60 s: direct 50 s, relay 10 s, switches 2, lost packets 3`,
    );
  });

  it('the path in use at accept is not a switch; unknown lost packets read `n/a`', async () => {
    const { conn, clock, lines, close } = setup();
    conn.lost = null;
    conn.selectPath(DIRECT, 'initial');
    await clock.advance(5_000);
    await close();
    expect(lines).toEqual([
      `iroh: path ${SHORT} direct 192.168.1.30:5000 rtt 4 ms`,
      `iroh: path ${SHORT} summary 5 s: direct 5 s, relay 0 s, switches 0, lost packets n/a`,
    ]);
  });

  it('`Lagged` with the selected path changed: a switch with its line, the summary marked `lagged`', async () => {
    const { conn, clock, lines, close } = setup();
    conn.selectPath(RELAY, 'initial');
    await clock.advance(10_000);
    conn.lagPaths(2, DIRECT);
    await clock.advance(50_000);
    conn.lagPaths(null, DIRECT);
    await close();
    expect(lines).toEqual([
      `iroh: path ${SHORT} relay rtt 40 ms`,
      `iroh: path ${SHORT} direct 192.168.1.30:5000 rtt 4 ms`,
      `iroh: path ${SHORT} summary 60 s: direct 50 s, relay 10 s, switches 1, lost packets 0, lagged ?`,
    ]);
  });

  it('close stops the watcher once; a second close and a late event write nothing', async () => {
    const { conn, lines, close } = setup();
    await close();
    await close();
    conn.selectPath(RELAY);
    expect(conn.pathWatchStops).toBe(1);
    expect(lines).toHaveLength(1);
  });
});

/**
 * Stand-in for the library connection: `paths()` and `watchPathEvents` with the callback kept by the test. `paths()`
 * reads the array passed in at each call, so the test can change it in place.
 */
function libConnection(paths: Array<{ id: string; isSelected: boolean; remoteAddr: string; isRelay: boolean;
  rttMs: number }>): { conn: Parameters<typeof watchSelectedPath>[0]; emit: (...args: unknown[]) => void;
  stops: () => number } {
  let callback: (...args: unknown[]) => void = () => {};
  let stops = 0;
  const conn = {
    paths: () => paths.map((path) => ({ ...path, isIp: !path.isRelay, stats: {} })),
    watchPathEvents: (cb: (...args: unknown[]) => void) => {
      callback = cb;
      return { stop: async () => { stops += 1; } };
    },
  } as unknown as Parameters<typeof watchSelectedPath>[0];
  return { conn, emit: (...args) => { callback(...args); }, stops: () => stops };
}

describe('adapter: selected path from the library', () => {
  const paths = [
    { id: '0', isSelected: true, remoteAddr: 'https://relay.example./', isRelay: true, rttMs: 40 },
    { id: '1', isSelected: false, remoteAddr: '192.168.1.30:5000', isRelay: false, rttMs: 4 },
  ];
  const selected = { kind: 'Selected', id: '1', remoteAddr: '192.168.1.30:5000', localAddr: '192.168.1.2' };

  for (const [shape, args] of [['(null, event)', [null, selected]], ['(event)', [selected]]] as const) {
    it(`callback ${shape}: the path in use at start, then the selected one, relay and RTT from \`paths()\``, () => {
      const lib = libConnection(paths);
      const seen: IrohPathUpdate[] = [];
      const watch = watchSelectedPath(lib.conn, (path) => { seen.push(path); });
      lib.emit(...args);
      lib.emit(null, { kind: 'Opened', id: '2', remoteAddr: '10.0.0.5:5000' });
      expect(seen).toEqual([
        { kind: 'initial', relay: true, remoteAddr: 'https://relay.example./', rttMs: 40 },
        { kind: 'selected', relay: false, remoteAddr: '192.168.1.30:5000', rttMs: 4 },
      ]);
      void watch.stop();
      expect(lib.stops()).toBe(1);
    });

    it(`callback ${shape}: the same path lines through the path log`, () => {
      const lib = libConnection(paths);
      const lines: string[] = [];
      startPathLog({ watchSelectedPath: (cb) => watchSelectedPath(lib.conn, cb), lostPackets: () => 0 }, SHORT,
        (line) => { lines.push(line); }, new ManualClock());
      lib.emit(...args);
      expect(lines).toEqual([
        `iroh: path ${SHORT} relay rtt 40 ms`,
        `iroh: path ${SHORT} direct 192.168.1.30:5000 rtt 4 ms`,
      ]);
    });
  }

  it('initial relay, 10 s, `Lagged` with `paths()` now direct, 50 s: one switch, `lagged 1`', async () => {
    const now = paths.map((path) => ({ ...path }));
    const lib = libConnection(now);
    const clock = new ManualClock();
    const lines: string[] = [];
    const log = startPathLog({ watchSelectedPath: (cb) => watchSelectedPath(lib.conn, cb), lostPackets: () => 0 },
      SHORT, (line) => { lines.push(line); }, clock);
    await clock.advance(10_000);
    for (const path of now) path.isSelected = path.id === '1';
    lib.emit(null, { kind: 'Lagged', missed: 1 });
    await clock.advance(50_000);
    await log.close();
    expect(lines).toEqual([
      `iroh: path ${SHORT} relay rtt 40 ms`,
      `iroh: path ${SHORT} direct 192.168.1.30:5000 rtt 4 ms`,
      `iroh: path ${SHORT} summary 60 s: direct 50 s, relay 10 s, switches 1, lost packets 0, lagged 1`,
    ]);
  });

  it('a selected path `paths()` no longer lists: relay from the URL form of the address, RTT unknown', () => {
    const lib = libConnection([]);
    const seen: IrohPathUpdate[] = [];
    watchSelectedPath(lib.conn, (path) => { seen.push(path); });
    lib.emit(null, { kind: 'Selected', id: '5', remoteAddr: 'https://relay.example./' });
    lib.emit(null, { kind: 'Selected', id: '6', remoteAddr: '[fd00::1]:5000' });
    expect(seen).toEqual([
      { kind: 'selected', relay: true, remoteAddr: 'https://relay.example./', rttMs: null },
      { kind: 'selected', relay: false, remoteAddr: '[fd00::1]:5000', rttMs: null },
    ]);
  });
});

/** GET over a fake client stream; `/auth?device=X` authenticates the connection. */
function get(conn: FakeConnection, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: 'iroh.rarog.invalid', path, createConnection: () => new FakeClientSocket(conn.openBi()),
    }, (res) => { res.resume(); res.on('end', () => { resolve(res.statusCode ?? 0); }); });
    req.on('error', reject);
    req.end();
  });
}

const pathLines = (lines: readonly string[]): string[] => lines.filter((line) => line.startsWith('iroh: path '));

describe('listener: path log only for authenticated connections', () => {
  const opened: Array<{ server: http.Server; listener: IrohListener }> = [];
  afterEach(async () => {
    for (const { server, listener } of opened.splice(0)) {
      await listener.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  });

  async function start(): Promise<{ endpoint: FakeEndpoint; listener: IrohListener; lines: string[] }> {
    const endpoint = new FakeEndpoint();
    const lines: string[] = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://iroh.rarog.invalid');
      const device = url.searchParams.get('device');
      if (url.pathname === '/auth' && device !== null) markAuthenticated(req.socket, device);
      res.end();
    });
    const listener = await startIroh({ secretKey: new Uint8Array(32), relay: null, port: null }, server,
      { info: (line) => { lines.push(line); }, error: (line) => { lines.push(`ERROR ${line}`); } },
      { open: async () => endpoint, clock: new ManualClock(), onFatal: () => {} });
    opened.push({ server, listener });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    return { endpoint, listener, lines };
  }

  it('100 sequential connections that never authenticate: no watcher, no path line', async () => {
    const { endpoint, lines } = await start();
    for (let n = 0; n < 100; n += 1) {
      const conn = endpoint.incoming(fakeClientId(1000 + n)).connection;
      await until(() => conn.biLimits.length > 0, 2_000, `connection ${String(n)} accepted`);
      expect(await get(conn, '/x')).toBe(200);
      conn.peerClose();
      await settle(2);
      expect(conn.pathWatches).toBe(0);
    }
    expect(pathLines(lines)).toEqual([]);
  });

  it('authenticated: the path at authentication, the summary when the client closes, the watcher stops once',
    async () => {
      const { endpoint, listener, lines } = await start();
      const conn = endpoint.incoming(ID).connection;
      await until(() => conn.biLimits.length > 0, 2_000, 'connection accepted');
      expect(await get(conn, '/x')).toBe(200);
      expect(conn.pathWatches, 'no watcher before authentication').toBe(0);
      expect(await get(conn, '/auth?device=dev-a')).toBe(200);
      expect(conn.pathWatches).toBe(1);
      conn.selectPath(DIRECT, 'initial');
      expect(await get(conn, '/auth?device=dev-b')).toBe(200);
      expect(conn.pathWatches, 'a second device does not restart it').toBe(1);
      conn.peerClose();
      await until(() => conn.pathWatchStops === 1, 2_000, 'path watcher stopped');
      expect(pathLines(lines)).toEqual([
        `iroh: path ${SHORT} direct 192.168.1.30:5000 rtt 4 ms`,
        `iroh: path ${SHORT} summary 0 s: direct 0 s, relay 0 s, switches 0, lost packets 0`,
      ]);
      await listener.close();
      await settle();
      expect(conn.pathWatchStops).toBe(1);
    });

  it('the listener closes: watchers of authenticated connections stop once, none for the others', async () => {
    const { endpoint, listener, lines } = await start();
    const first = endpoint.incoming(fakeClientId(1)).connection;
    const second = endpoint.incoming(fakeClientId(2)).connection;
    const third = endpoint.incoming(fakeClientId(3)).connection;
    await until(() => [first, second, third].every((conn) => conn.biLimits.length > 0), 2_000, 'accepted');
    expect(await get(first, '/auth?device=dev-1')).toBe(200);
    expect(await get(second, '/auth?device=dev-2')).toBe(200);
    await listener.close();
    await settle();
    expect([first.pathWatchStops, second.pathWatchStops, third.pathWatches]).toEqual([1, 1, 0]);
    expect(pathLines(lines).filter((line) => / summary /.test(line))).toHaveLength(2);
  });
});
