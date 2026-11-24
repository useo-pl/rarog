/**
 * The download of one file of a session (`GET /api/sessions/:id/files/raw?path=`): the download module over a real
 * directory (the gate, the path rule's refusals, the limit from `RAROG_FILES_MAX_MB` before any byte, the demo bytes
 * with no disk call), the route behind the router's gate (headers, exact bytes from one descriptor, a file appended
 * or cut while it is sent, a client gone, a device unpaired over TCP and over iroh) and the registry of downloads by
 * device. The path rule itself is in `files-sciezka.test.ts`, the exact reader in `safe-read.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, link, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { fileTooLargeBodySchema } from '@rarog/shared/rest';
import { loadConfig } from '../src/config.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';
import { DEMO_FILES, demoFileBytes } from '../src/demo/files.ts';
import { attachDeactivation } from '../src/device-effects.ts';
import { FILES_DISK, type FilesDisk } from '../src/files/path-rule.ts';
import { CODEX, NO_PANE, OUT_OF_SCOPE, fileTooLarge } from '../src/files/refusals.ts';
import { FileDownloads } from '../src/files/send-file.ts';
import {
  type FileDownload, type FileDownloadAnswer, type SessionDownloadPort, openSessionDownload,
} from '../src/files/session-download.ts';
import { startIroh } from '../src/iroh/listener.ts';
import type { IrohListener } from '../src/iroh/listener.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { NotFoundError } from '../src/sessions/errors.ts';
import { type Manager, createManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import type { SessionInit } from '../src/sessions/session.ts';
import { SseHub } from '../src/sse.ts';
import { say } from '@rarog/shared/sentences';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { FakeClientSocket, FakeEndpoint, ManualClock, fakeClientId, until } from './helpers/fake-iroh.ts';
import { type TestDevice, createTestDevice } from './helpers/urzadzenie.ts';

const MIB = 1024 * 1024;
const PIECE = 64 * 1024;
const AT = new Date(1_756_000_000_000).toISOString();

let base = '';
let home = '';
let root = '';
let cwd = '';

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'rarog-raw-'));
  home = path.join(base, 'home');
  root = path.join(home, 'Projects');
  cwd = path.join(root, 'app');
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(rel: string, bytes: Buffer | string = rel): Promise<string> {
  const file = path.join(cwd, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return file;
}

function sessionOf(extra: Partial<SessionInit> = {}): Session {
  return new Session({
    id: 's1', cwd, title: 'app', state: 'running', stateSince: AT, createdAt: AT, lastActivityAt: AT, herdrKey: 'k1',
    ...extra,
  });
}

function portOf(one: Session, opts: { demo?: boolean } = {}): SessionDownloadPort {
  return {
    require: (id: string): Session => {
      if (id !== one.id) throw new NotFoundError(say('rest.session-not-found'));
      return one;
    },
    config: { demo: opts.demo ?? false, herdrRoots: [root], home },
    demoFile: demoFileBytes,
  };
}

/** A disk port that fails the test on any call: the demo and a refused session never touch the disk. */
function untouchedDisk(calls: string[]): FilesDisk {
  const no = (name: string) => (): never => {
    calls.push(name);
    throw new Error(`disk call ${name}`);
  };
  return {
    readdir: no('readdir'), readdirByIdentity: no('readdirByIdentity'), lstat: no('lstat'), stat: no('stat'),
    realpath: no('realpath'), open: no('open'),
    area: { lstat: no('area.lstat'), readlink: no('area.readlink'), realpath: no('area.realpath') },
  };
}

interface Watched {
  readonly disk: FilesDisk;
  /** Files opened and handles closed, counted on the real handles. */
  readonly counts: { opens: number; closes: number };
  /**
   * Holds the read number `at` (from 1) of the next opened file: `reached` settles when the sender waits there, and
   * the read goes on after `release()`.
   */
  hold(at: number): { readonly reached: Promise<void>; release(): void };
}

/** The real disk, with the opens and closes counted and one read of a file held while the test acts. */
function watched(): Watched {
  const counts = { opens: 0, closes: 0 };
  let held: { at: number; reach: () => void; gate: Promise<void> } | null = null;
  const disk: FilesDisk = {
    ...FILES_DISK,
    open: async (file) => {
      const opened = await FILES_DISK.open(file);
      if (opened === null) return null;
      counts.opens += 1;
      const { handle } = opened;
      const close = handle.close.bind(handle);
      const read = handle.read.bind(handle);
      const hold = held;
      let reads = 0;
      handle.close = async () => {
        counts.closes += 1;
        return close();
      };
      handle.read = async (length, position) => {
        reads += 1;
        if (hold !== null && reads === hold.at) {
          hold.reach();
          await hold.gate;
        }
        return read(length, position);
      };
      return opened;
    },
  };
  return {
    disk,
    counts,
    hold: (at) => {
      let reach = (): void => {};
      let release = (): void => {};
      const reached = new Promise<void>((resolve) => { reach = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      held = { at, reach, gate };
      return { reached, release };
    },
  };
}

/** Every byte of a download, as the sender would read it; closes the download. */
async function bytesOf(download: FileDownload): Promise<Buffer> {
  const parts: Buffer[] = [];
  try {
    for (;;) {
      const piece = await download.read();
      if (piece.kind !== 'piece') break;
      parts.push(piece.bytes);
    }
  } finally {
    await download.close();
  }
  return Buffer.concat(parts);
}

const codeOf = (answer: FileDownloadAnswer): string => (answer.ok ? 'ok' : answer.refusal.code);

describe('file download: the module over a real directory', () => {
  it('a file of the session: its size from `fstat` and its bytes, the descriptor closed by the caller', async () => {
    const bytes = randomBytes(3 * MIB);
    await put('docs/brief.pdf', bytes);
    const w = watched();
    const answer = await openSessionDownload('s1', 'docs/brief.pdf', 50 * MIB, portOf(sessionOf()), w.disk);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.size).toBe(bytes.length);
    expect((await bytesOf(answer.value)).equals(bytes)).toBe(true);
    expect(w.counts).toEqual({ opens: 1, closes: 1 });
  });

  it.each([
    ['exactly the limit', MIB, 'ok'],
    ['one byte over it', MIB + 1, 'file-too-large'],
  ] as const)('%s → %s; a refused file leaves no descriptor open', async (_, size, code) => {
    await put('out.bin', Buffer.alloc(size, 1));
    const w = watched();
    const answer = await openSessionDownload('s1', 'out.bin', MIB, portOf(sessionOf()), w.disk);
    expect(codeOf(answer)).toBe(code);
    if (answer.ok) await answer.value.close();
    else expect(answer.refusal).toEqual(fileTooLarge(size, MIB));
    expect(w.counts).toEqual({ opens: 1, closes: 1 });
  });

  it('the path rule refuses as on the listing, with nothing left open', async () => {
    await put('.env', 'SECRET=1');
    await put('a.txt', 'a');
    await symlink(path.join(cwd, 'a.txt'), path.join(cwd, 'link.txt'));
    execFileSync('mkfifo', [path.join(cwd, 'pipe')]);
    const outside = path.join(base, 'outside.txt');
    await writeFile(outside, 'outside');
    await link(outside, path.join(cwd, 'hard.txt'));
    const w = watched();
    const codes: Record<string, string> = {};
    for (const rel of ['.env', '../x', 'link.txt', 'pipe', 'hard.txt', 'src/', 'missing.txt']) {
      codes[rel] = codeOf(await openSessionDownload('s1', rel, MIB, portOf(sessionOf()), w.disk));
    }
    expect(codes).toEqual({
      '.env': 'not-found', '../x': 'bad-path', 'link.txt': 'not-found', pipe: 'not-found', 'hard.txt': 'not-found',
      'src/': 'bad-path', 'missing.txt': 'not-found',
    });
    expect(w.counts.opens).toBe(w.counts.closes);
  });

  it.each([
    ['a Codex entry', { engine: 'codex' }, CODEX],
    ['a pane out of scope', { outOfScope: true }, OUT_OF_SCOPE],
    ['a session without a herdr pane', { herdrKey: undefined }, NO_PANE],
  ] as const)('%s → 400 with the refusal of the gate, no disk call', async (_, extra, refusal) => {
    const calls: string[] = [];
    const answer = await openSessionDownload('s1', 'a.txt', MIB, portOf(sessionOf(extra)), untouchedDisk(calls));
    expect(answer).toEqual({ ok: false, refusal });
    expect(calls).toEqual([]);
  });

  it('an unknown session throws the manager 404', async () => {
    await expect(openSessionDownload('other', 'a.txt', MIB, portOf(sessionOf()))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('file download: the demo', () => {
  it('sends the fixed bytes of the demo data, with no disk call', async () => {
    const calls: string[] = [];
    const port = portOf(sessionOf(), { demo: true });
    const answer = await openSessionDownload('s1', 'src/notes.ts', MIB, port, untouchedDisk(calls));
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const text = DEMO_FILES['src/notes.ts'] ?? '';
    expect(answer.value.size).toBe(Buffer.byteLength(text, 'utf8'));
    expect((await bytesOf(answer.value)).toString('utf8')).toBe(text);
    expect(calls).toEqual([]);
  });

  it('refuses as the server does: a bad path 400, a directory, a hidden or unknown name 404, the limit 413',
    async () => {
      const port = portOf(sessionOf(), { demo: true });
      const codes: Record<string, string> = {};
      for (const rel of ['../x', '', 'src', '.env', 'nope.ts', 'constructor', '__proto__', 'toString']) {
        codes[rel] = codeOf(await openSessionDownload('s1', rel, MIB, port, untouchedDisk([])));
      }
      expect(codes).toEqual({
        '../x': 'bad-path', '': 'bad-path', src: 'not-found', '.env': 'not-found', 'nope.ts': 'not-found',
        constructor: 'not-found', __proto__: 'not-found', toString: 'not-found',
      });
      expect(codeOf(await openSessionDownload('s1', 'README.md', 10, port, untouchedDisk([])))).toBe('file-too-large');
    });

  it('the demo manager answers `openFile` from the demo data', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'rarog-raw-demo-'));
    let manager: Manager | undefined;
    try {
      manager = await createManager({ demo: true, demoContent: demoContentPl, dataDir });
      await manager.ready;
      const answer = await manager.openFile('demo-willow', 'README.md', MIB);
      expect(answer.ok && (await bytesOf(answer.value)).toString('utf8')).toBe(DEMO_FILES['README.md']);
    } finally {
      await manager?.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('file downloads: the registry by device', () => {
  it('stops the downloads of one device and counts them; a finished download leaves the registry', () => {
    const downloads = new FileDownloads();
    const stopped: string[] = [];
    downloads.track('dev-a', () => { stopped.push('a1'); });
    const untrack = downloads.track('dev-a', () => { stopped.push('a2'); });
    downloads.track('dev-b', () => { stopped.push('b1'); });
    untrack();
    expect(downloads.closeOwner('dev-a')).toBe(1);
    expect(downloads.closeOwner('dev-a')).toBe(0);
    expect(stopped).toEqual(['a1']);
    expect(downloads.closeOwner('dev-b')).toBe(1);
    expect(stopped).toEqual(['a1', 'b1']);
  });
});

const silent: Logger = { info: () => {}, error: () => {} };

interface Harness {
  readonly device: TestDevice;
  readonly manager: FakeManager;
  readonly downloads: FileDownloads;
  readonly logs: string[];
  /** A new TCP connection to the server. */
  readonly tcp: () => Duplex;
  /** A new bidirectional stream of one iroh connection (`iroh: true` only). */
  readonly iroh: (() => Duplex) | null;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function start(env: NodeJS.ProcessEnv = {}, opts: { iroh?: boolean } = {}): Promise<Harness> {
  const dataDir = path.join(base, 'data');
  const config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: dataDir, ...env });
  const device = createTestDevice(dataDir, { epoch: config.epoch });
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const logs: string[] = [];
  const downloads = new FileDownloads();
  attachDeactivation(device.store, {
    pairing: device.identity.pairing, hub, files: downloads, log: (line) => { logs.push(line); },
  });
  const logger: Logger = { info: (line) => { logs.push(line); }, error: (line) => { logs.push(`ERROR ${line}`); } };
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger, devices: device.identity,
    fileDownloads: downloads,
  }));
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  let listener: IrohListener | null = null;
  let iroh: (() => Duplex) | null = null;
  if (opts.iroh === true) {
    const endpoint = new FakeEndpoint('e'.repeat(64));
    listener = await startIroh(
      { secretKey: randomBytes(32), relay: 'https://relay.example./', port: 0 }, server, silent,
      { open: async () => endpoint, clock: new ManualClock(), onFatal: (reason) => { logs.push(`FATAL ${reason}`); } },
    );
    const incoming = endpoint.incoming(fakeClientId(1));
    await until(() => incoming.connection.biLimits.length > 0, 2_000, 'iroh connection');
    iroh = () => new FakeClientSocket(incoming.connection.openBi());
  }
  const h: Harness = {
    device, manager, downloads, logs, iroh,
    tcp: () => net.connect(port, '127.0.0.1'),
    close: async () => {
      await listener?.close();
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
  harnesses.push(h);
  return h;
}

interface Fetched {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
  /** The body reached its end; `false` = the response was cut. */
  readonly complete: boolean;
}

interface FetchOptions {
  readonly method?: string;
  readonly via?: () => Duplex;
  /** Runs once, at the first chunk of the body, with a way to drop the connection. */
  readonly onFirstChunk?: (abort: () => void) => void;
}

function fetchRaw(h: Harness, route: string, opts: FetchOptions = {}): Promise<Fetched> {
  const via = opts.via ?? h.tcp;
  const method = opts.method ?? 'GET';
  // A mutation needs an allowed `Origin` to reach the route at all.
  const headers = method === 'GET' ? { ...h.device.headers } : { ...h.device.headers, Origin: 'http://localhost:8930' };
  return new Promise((resolve, reject) => {
    let responded = false;
    const req = http.request({
      host: 'server.test', path: route, method, headers, createConnection: () => via(),
    }, (res) => {
      responded = true;
      const parts: Buffer[] = [];
      let first = true;
      res.on('data', (chunk: Buffer) => {
        parts.push(chunk);
        if (first) {
          first = false;
          opts.onFirstChunk?.(() => { req.destroy(); });
        }
      });
      res.on('error', () => {});
      res.once('close', () => {
        const body = Buffer.concat(parts);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, complete: res.complete });
      });
    });
    req.on('error', (err) => { if (!responded) reject(err); });
    req.end();
  });
}

const raw = (rel: string): string => `/api/sessions/s1/files/raw?path=${encodeURIComponent(rel)}`;

/** The route answers from the download module over the test directory, through `disk`. */
function serveFrom(h: Harness, disk: FilesDisk = FILES_DISK): void {
  h.manager.openFileAnswer = (id, rel, maxBytes) => openSessionDownload(id, rel, maxBytes, portOf(sessionOf()), disk);
}

const json = (reply: Fetched): unknown => JSON.parse(reply.body.toString('utf8'));

describe('GET /api/sessions/:id/files/raw', () => {
  it('`docs/brief.pdf` of 3 MB → 200 with the headers of the contract and exactly its bytes', async () => {
    const h = await start();
    const bytes = randomBytes(3 * MIB);
    await put('docs/brief.pdf', bytes);
    const w = watched();
    serveFrom(h, w.disk);
    const reply = await fetchRaw(h, raw('docs/brief.pdf'));
    expect(reply.status).toBe(200);
    expect(reply.headers).toMatchObject({
      'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(reply.complete).toBe(true);
    expect(reply.body.equals(bytes)).toBe(true);
    expect(h.manager.calls.filter((c) => c.method === 'openFile')).toEqual([
      { method: 'openFile', args: ['s1', 'docs/brief.pdf', 50 * MIB] },
    ]);
    await until(() => w.counts.closes === 1, 2_000, 'descriptor closed');
    expect(w.counts).toEqual({ opens: 1, closes: 1 });
  });

  it('an empty file → 200 with `Content-Length: 0`', async () => {
    const h = await start();
    await put('empty.txt', '');
    serveFrom(h);
    const reply = await fetchRaw(h, raw('empty.txt'));
    expect([reply.status, reply.headers['content-length'], reply.body.length, reply.complete])
      .toEqual([200, '0', 0, true]);
  });

  it('`RAROG_FILES_MAX_MB=1`: exactly 1 MiB → 200, one byte more → 413 with `size` and `maxBytes`', async () => {
    const h = await start({ RAROG_FILES_MAX_MB: '1' });
    await put('exact.bin', Buffer.alloc(MIB, 3));
    await put('over.bin', Buffer.alloc(MIB + 1, 4));
    serveFrom(h);
    const exact = await fetchRaw(h, raw('exact.bin'));
    expect([exact.status, exact.body.length]).toEqual([200, MIB]);
    const over = await fetchRaw(h, raw('over.bin'));
    expect(over.status).toBe(413);
    expect(over.headers['content-type']).toMatch(/^application\/json/u);
    const body = fileTooLargeBodySchema.parse(json(over));
    expect(body).toMatchObject({ error: 'file-too-large', size: MIB + 1, maxBytes: MIB });
    expect(body.messageRef).toEqual({ code: 'rest.file-too-large', args: ['2', '1'] });
    expect(over.body.includes(Buffer.alloc(64, 4))).toBe(false);
  });

  it('`RAROG_FILES_MAX_MB=1`: a file of 2 MiB → 413, the limit comes from the variable', async () => {
    const h = await start({ RAROG_FILES_MAX_MB: '1' });
    await put('two.bin', Buffer.alloc(2 * MIB, 5));
    serveFrom(h);
    const reply = await fetchRaw(h, raw('two.bin'));
    expect([reply.status, json(reply)]).toMatchObject([413, { size: 2 * MIB, maxBytes: MIB }]);
  });

  it('a file appended while it is sent → exactly `Content-Length` bytes, the ones of its `fstat`', async () => {
    const h = await start();
    const bytes = randomBytes(4 * PIECE);
    const file = await put('log.txt', bytes);
    const w = watched();
    const hold = w.hold(2);
    serveFrom(h, w.disk);
    const reply = fetchRaw(h, raw('log.txt'));
    await hold.reached;
    await appendFile(file, randomBytes(2 * PIECE));
    hold.release();
    const done = await reply;
    expect([done.status, done.headers['content-length'], done.complete]).toEqual([200, String(bytes.length), true]);
    expect(done.body.equals(bytes)).toBe(true);
    await until(() => w.counts.closes === 1, 2_000, 'descriptor closed');
  });

  it('a file cut while it is sent → the response is destroyed, the client gets fewer bytes and no end', async () => {
    const h = await start();
    const file = await put('log.txt', randomBytes(4 * PIECE));
    const w = watched();
    const hold = w.hold(2);
    serveFrom(h, w.disk);
    const reply = fetchRaw(h, raw('log.txt'));
    await hold.reached;
    await truncate(file, 10);
    hold.release();
    const done = await reply;
    expect([done.status, done.headers['content-length'], done.complete]).toEqual([200, String(4 * PIECE), false]);
    expect(done.body.length).toBeLessThan(4 * PIECE);
    await until(() => w.counts.closes === 1, 2_000, 'descriptor closed');
    expect(h.logs.some((line) => line.includes('got shorter'))).toBe(true);
  });

  it('a client gone in the middle → the descriptor is closed once', async () => {
    const h = await start();
    await put('big.bin', randomBytes(8 * PIECE));
    const w = watched();
    const hold = w.hold(2);
    serveFrom(h, w.disk);
    const reply = await fetchRaw(h, raw('big.bin'), { onFirstChunk: (abort) => { abort(); } });
    expect(reply.complete).toBe(false);
    await until(() => w.counts.closes === 1, 2_000, 'descriptor closed after the client left');
    hold.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.counts).toEqual({ opens: 1, closes: 1 });
    expect(h.downloads.closeOwner(h.device.id)).toBe(0);
  });

  it.each(['TCP', 'iroh'] as const)('a device unpaired in the middle (%s) → the response cut, the descriptor closed',
    async (transport) => {
      const h = await start({}, { iroh: transport === 'iroh' });
      const via = transport === 'iroh' ? h.iroh ?? undefined : h.tcp;
      await put('big.bin', randomBytes(8 * PIECE));
      const w = watched();
      const hold = w.hold(2);
      serveFrom(h, w.disk);
      let firstChunk = (): void => {};
      const gotFirst = new Promise<void>((resolve) => { firstChunk = resolve; });
      const reply = fetchRaw(h, raw('big.bin'), {
        ...(via === undefined ? {} : { via }), onFirstChunk: () => { firstChunk(); },
      });
      await Promise.all([hold.reached, gotFirst]);
      h.device.store.revoke(h.device.id, 'admin');
      const done = await reply;
      expect([done.status, done.complete]).toEqual([200, false]);
      expect(done.body.length).toBeLessThan(8 * PIECE);
      await until(() => w.counts.closes === 1, 2_000, 'descriptor closed after the unpair');
      hold.release();
      const revoked = h.logs.filter((line) => line.includes(`${h.device.id} revoked (admin)`));
      expect(revoked.map((line) => line.endsWith('file downloads: 1'))).toEqual([true]);
    });

  it('a device unpaired while the file is opened → 401 and no byte, the descriptor closed', async () => {
    const h = await start();
    await put('a.txt', 'secret bytes');
    const w = watched();
    serveFrom(h, w.disk);
    let release = (): void => {};
    h.manager.openFileWait = new Promise((resolve) => { release = resolve; });
    const reply = fetchRaw(h, raw('a.txt'));
    await until(() => w.counts.opens === 1, 2_000, 'file opened');
    h.device.store.revoke(h.device.id, 'admin');
    release();
    const done = await reply;
    expect([done.status, json(done)]).toMatchObject([401, { error: 'device-revoked' }]);
    expect(done.body.toString('utf8')).not.toContain('secret bytes');
    await until(() => w.counts.closes === 1, 2_000, 'descriptor closed');
  });

  it('a file git ignores → 200 like any other', async () => {
    const h = await start();
    execFileSync('git', ['init', '-q'], { cwd });
    await put('.gitignore', 'dist/\n');
    const bytes = randomBytes(1000);
    await put('dist/report.pdf', bytes);
    serveFrom(h);
    const reply = await fetchRaw(h, raw('dist/report.pdf'));
    expect([reply.status, reply.body.equals(bytes)]).toEqual([200, true]);
  });

  it('the path rule answers through the route: a hidden name 404, `../x` 400, no byte of a file', async () => {
    const h = await start();
    await put('.env', 'SECRET=1');
    serveFrom(h);
    const hidden = await fetchRaw(h, raw('.env'));
    expect([hidden.status, json(hidden)]).toMatchObject([404, { error: 'not-found' }]);
    const up = await fetchRaw(h, raw('../x'));
    expect([up.status, json(up)]).toMatchObject([400, { error: 'bad-path' }]);
    expect(`${hidden.body.toString('utf8')}${up.body.toString('utf8')}`).not.toContain('SECRET');
  });

  it('`path` is decoded from the query: `%2B` is a plus, a bare `+` a space', async () => {
    const h = await start();
    await put('a+b.txt', 'plus');
    await put('a b.txt', 'space');
    serveFrom(h);
    expect((await fetchRaw(h, '/api/sessions/s1/files/raw?path=a%2Bb.txt')).body.toString('utf8')).toBe('plus');
    expect((await fetchRaw(h, '/api/sessions/s1/files/raw?path=a+b.txt')).body.toString('utf8')).toBe('space');
  });

  it('an unknown session → 404 `session-not-found`; another method → 405 with `Allow: GET`', async () => {
    const h = await start();
    const unknown = await fetchRaw(h, '/api/sessions/nope/files/raw?path=a.txt');
    expect([unknown.status, json(unknown)]).toMatchObject([404, { error: 'session-not-found' }]);
    const post = await fetchRaw(h, raw('a.txt'), { method: 'POST' });
    expect([post.status, post.headers['allow']]).toEqual([405, 'GET']);
    expect(h.manager.calls.filter((c) => c.method === 'openFile')).toEqual([]);
  });

  it('`RAROG_FILES=0`: 404 as an unknown route for every method, the manager never asked', async () => {
    const h = await start({ RAROG_FILES: '0' });
    for (const method of ['GET', 'POST']) {
      const reply = await fetchRaw(h, raw('a.txt'), { method });
      expect([reply.status, json(reply)], method)
        .toMatchObject([404, { error: 'not-found', messageRef: { code: 'rest.endpoint-not-found' } }]);
    }
    expect(h.manager.calls.filter((c) => c.method === 'openFile')).toEqual([]);
  });
});
