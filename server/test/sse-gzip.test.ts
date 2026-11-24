/**
 * Kompresja strumienia SSE: prawdziwa trasa HTTP (`createRouter` na `node:http`), atrapa ManagerApi.
 *
 * Serwer kompresuje gzipem tylko przy włączonej fladze i `Accept-Encoding` z `gzip` o wadze większej od zera.
 * Bufor kompresora jest opróżniany po każdej ramce i każdym pingu, a kompresor zamyka się przy rozłączeniu
 * i przy odpięciu urządzenia. Klient testu czyta surowe bajty (`http.get` niczego nie rozpakowuje sam).
 * Edge cases with the flag on: a compressor error mid-stream, `closeAll` with frames still in the compressors,
 * backpressure, the write buffer ceiling, and a stream injected through the iroh listener (fake transport,
 * `helpers/fake-iroh.ts`).
 */
import { randomBytes } from 'node:crypto';
import type { TranscriptMessage } from '@rarog/shared';
import { PROTOCOL_VERSION } from '@rarog/shared';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { type Gzip, createGunzip, createGzip } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import { type IrohListener, startIroh } from '../src/iroh/listener.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { RING_MAX_BYTES } from '../src/sessions/ring-buffer.ts';
import {
  REPLAY_SNAPSHOT_LOG, SNAPSHOT_IMAGE_BUDGET_BYTES, SSE_WRITE_BUFFER_MAX, SseHub, type SseResponse,
  WRITE_BUFFER_CUT_LOG, acceptsGzip,
} from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { FakeClientSocket, FakeEndpoint, ManualClock, fakeClientId } from './helpers/fake-iroh.ts';
import { TEST_DEVICE_ID, createTestDevice } from './helpers/urzadzenie.ts';

const silentLogger: Logger = { info: () => {}, error: () => {} };

/** Kompresor z licznikiem: test sprawdza, że każdy utworzony się zamknął. */
interface TrackedGzip {
  readonly stream: Gzip;
  closed: boolean;
}

interface Harness {
  readonly base: string;
  readonly hub: SseHub;
  readonly manager: FakeManager;
  readonly auth: string;
  readonly compressors: TrackedGzip[];
  readonly lines: string[];
  readonly server: http.Server;
  /** Server-side responses in arrival order, with the request path. */
  readonly responses: Array<{ readonly url: string; readonly res: http.ServerResponse }>;
  /** iroh listener on a fake transport, attached to the same `http.Server`; `null` without `iroh`. */
  readonly iroh: { readonly endpoint: FakeEndpoint; readonly listener: IrohListener } | null;
  close(): Promise<void>;
}

const open: Harness[] = [];

async function startHarness(gzip: boolean, options: { iroh?: boolean } = {}): Promise<Harness> {
  const config = loadConfig({ RAROG_DEMO: '1' });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const compressors: TrackedGzip[] = [];
  const lines: string[] = [];
  const hub = new SseHub({
    manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0, gzip,
    logger: (line) => { lines.push(line); },
    createGzip: () => {
      const tracked: TrackedGzip = { stream: createGzip(), closed: false };
      tracked.stream.once('close', () => { tracked.closed = true; });
      compressors.push(tracked);
      return tracked.stream;
    },
  });
  hub.start();
  const server = http.createServer();
  const responses: Array<{ url: string; res: http.ServerResponse }> = [];
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    responses.push({ url: req.url ?? '', res });
  });
  server.on('request', createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now() - 5_000,
    logger: silentLogger, devices: device.identity,
  }));
  let iroh: Harness['iroh'] = null;
  if (options.iroh === true) {
    const endpoint = new FakeEndpoint();
    const listener = await startIroh(
      { secretKey: new Uint8Array(32), relay: 'https://relay.example./', port: null }, server, silentLogger,
      { open: async () => endpoint, clock: new ManualClock(), onFatal: () => {} },
    );
    iroh = { endpoint, listener };
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const { port } = server.address() as AddressInfo;
  const harness: Harness = {
    base: `http://127.0.0.1:${String(port)}`, hub, manager, auth: device.authorization, compressors, lines,
    server, responses, iroh,
    close: async () => {
      hub.closeAll();
      await iroh?.listener.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

/** Otwarty strumień: nagłówki odpowiedzi i tekst po rozpakowaniu, dopisywany w miarę przychodzenia bajtów. */
interface Stream {
  readonly headers: http.IncomingHttpHeaders;
  text: string;
  ended: boolean;
  error: Error | null;
  /** The raw response (before decompression) has ended: the server closed the stream. */
  rawEnded: boolean;
  readonly req: http.ClientRequest;
  /** Starts reading a stream opened with `paused`; a no-op otherwise. */
  read(): void;
}

interface OpenOptions {
  /** Socket of the request (a stream injected through the iroh listener); missing = TCP to the harness port. */
  readonly connection?: () => Duplex;
  /** Do not read the body until `read()`: the socket fills up and the server meets backpressure. */
  readonly paused?: boolean;
}

async function openStream(
  h: Harness, path: string, acceptEncoding?: string, options: OpenOptions = {},
): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Authorization: h.auth };
    if (acceptEncoding !== undefined) headers['Accept-Encoding'] = acceptEncoding;
    const connection = options.connection;
    const target = connection === undefined
      ? { headers }
      : { headers, createConnection: () => connection() };
    const url = connection === undefined ? `${h.base}${path}` : `http://iroh.rarog.invalid${path}`;
    const req = http.get(url, target, (res) => {
      let reading = false;
      const stream: Stream = {
        headers: res.headers, text: '', ended: false, error: null, rawEnded: false, req,
        read: () => {
          if (reading) return;
          reading = true;
          const body = res.headers['content-encoding'] === 'gzip' ? res.pipe(createGunzip()) : res;
          body.setEncoding('utf8');
          body.on('data', (chunk: string) => { stream.text += chunk; });
          body.on('end', () => { stream.ended = true; });
          body.on('error', (err: Error) => {
            stream.error = err;
            // A broken gzip body unpipes the response; keep draining it so the raw end is visible.
            res.resume();
          });
        },
      };
      res.on('end', () => { stream.rawEnded = true; });
      // The server may cut the stream (write buffer ceiling): the raw response then fails with `aborted`.
      res.on('error', (err: Error) => { stream.error ??= err; });
      if (options.paused !== true) stream.read();
      resolve(stream);
    });
    req.on('error', (err) => {
      // Zerwanie z naszej strony (`req.destroy()`) to część testu, nie błąd.
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
    });
  });
}

async function waitFor(what: string, predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const SNAPSHOT_DONE = (s: Stream): boolean => s.text.includes('"sessions-snapshot"') && s.text.endsWith('\n\n');

function message(seq: number): TranscriptMessage {
  return {
    seq, role: 'assistant', at: '2026-11-10T10:00:00.000Z',
    blocks: [{ type: 'text', text: `wiadomość ${String(seq)}: ${'ten sam akapit się powtarza '.repeat(20)}` }],
  };
}

describe('acceptsGzip', () => {
  it.each([
    ['gzip', true],
    ['gzip, deflate, br', true],
    ['br;q=1.0, gzip;q=0.8, *;q=0.1', true],
    ['GZIP', true],
    ['gzip; q=0.001', true],
    ['gzip;q=0', false],
    ['gzip; q=0.000', false],
    ['deflate, gzip;q=0', false],
    ['gzip;q=nie', false],
    ['br', false],
    ['*', false],
    ['', false],
    [undefined, false],
  ])('%j → %s', (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });
});

describe('RAROG_SSE_GZIP', () => {
  it('on by default: missing, empty and `1` turn it on, `0` turns it off', () => {
    expect(loadConfig({ RAROG_DEMO: '1' }).sseGzip).toBe(true);
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_SSE_GZIP: '' }).sseGzip).toBe(true);
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_SSE_GZIP: '  ' }).sseGzip).toBe(true);
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_SSE_GZIP: '1' }).sseGzip).toBe(true);
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_SSE_GZIP: ' 1 ' }).sseGzip).toBe(true);
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_SSE_GZIP: '0' }).sseGzip).toBe(false);
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_SSE_GZIP: ' 0 ' }).sseGzip).toBe(false);
  });

  it.each(['yes', '2'])('`%s` stops the start with the same sentence', (value) => {
    const load = (): unknown => loadConfig({ RAROG_DEMO: '1', RAROG_SSE_GZIP: value });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(`RAROG_SSE_GZIP takes 1 or 0 (got: ${value}).`);
  });

  it.each([
    ['missing', {}, 'gzip', 'gzip'],
    ['empty', { RAROG_SSE_GZIP: '' }, 'gzip', 'gzip'],
    ['`0`', { RAROG_SSE_GZIP: '0' }, 'gzip', undefined],
    ['missing, client without gzip', {}, undefined, undefined],
    ['`0`, client without gzip', { RAROG_SSE_GZIP: '0' }, undefined, undefined],
  ])('flag %s, the configured hub over the HTTP route', async (_name, env, acceptEncoding, encoding) => {
    const h = await startHarness(loadConfig({ RAROG_DEMO: '1', ...env }).sseGzip);
    const stream = await openStream(h, '/api/stream', acceptEncoding);

    expect(stream.headers['content-encoding']).toBe(encoding);
    await waitFor('start frames', () => SNAPSHOT_DONE(stream));
    expect(stream.text.startsWith('retry: 3000\n\n')).toBe(true);
    expect(h.compressors).toHaveLength(encoding === undefined ? 0 : 1);
  });
});

describe('strumień SSE przez trasę HTTP z kompresją', () => {
  it('flaga włączona i `Accept-Encoding: gzip` → `Content-Encoding: gzip`, po rozpakowaniu te same ramki', async () => {
    const h = await startHarness(true);
    const plain = await openStream(h, '/api/stream');
    const packed = await openStream(h, '/api/stream', 'gzip, deflate, br');

    expect(packed.headers['content-encoding']).toBe('gzip');
    expect(packed.headers['vary']).toBe('Accept-Encoding');
    expect(packed.headers['cache-control']).toBe('no-cache, no-transform');
    expect(packed.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    await waitFor('ramki startowe', () => SNAPSHOT_DONE(plain) && SNAPSHOT_DONE(packed));
    expect(packed.text).toBe(plain.text);

    // Ramka na żywo dochodzi bez czekania na następną.
    h.manager.emit('global', null, { type: 'session-changed', session: makeSummary({ id: 's1', title: 'na żywo' }) });
    await waitFor('ramka na żywo', () => packed.text.includes('na żywo') && plain.text.includes('na żywo'));
    await waitFor('koniec ramki', () => packed.text.endsWith('\n\n') && packed.text.length === plain.text.length);
    expect(packed.text).toBe(plain.text);
  });

  it('migawka transkryptu: po rozpakowaniu ta sama ramka', async () => {
    const h = await startHarness(true);
    h.manager.transcriptResult = {
      messages: Array.from({ length: 30 }, (_, i) => message(i + 1)), pendingPermissions: [], pendingQuestions: [],
    };
    const plain = await openStream(h, '/api/sessions/s1/stream');
    const packed = await openStream(h, '/api/sessions/s1/stream', 'gzip');

    expect(packed.headers['content-encoding']).toBe('gzip');
    const done = (s: Stream): boolean => s.text.includes('"transcript-snapshot"') && s.text.endsWith('\n\n');
    await waitFor('migawka', () => done(plain) && done(packed));
    expect(packed.text).toBe(plain.text);
  });

  it('pojedynczy ping dochodzi do klienta bez czekania na następną ramkę', async () => {
    const h = await startHarness(true);
    const packed = await openStream(h, '/api/stream', 'gzip');
    await waitFor('ramki startowe', () => SNAPSHOT_DONE(packed));

    h.hub.sendHeartbeat();
    await waitFor('ping', () => packed.text.endsWith(': ping\nevent: ping\ndata: {}\n\n'));
  });

  it.each([
    ['gzip;q=0', 'gzip;q=0'],
    ['brak nagłówka', undefined],
  ])('`Accept-Encoding`: %s → strumień jak dziś', async (_name, header) => {
    const h = await startHarness(true);
    const stream = await openStream(h, '/api/stream', header);

    expect(stream.headers['content-encoding']).toBeUndefined();
    await waitFor('ramki startowe', () => SNAPSHOT_DONE(stream));
    expect(stream.text.startsWith('retry: 3000\n\n')).toBe(true);
    expect(h.compressors).toHaveLength(0);
  });

  it('flaga wyłączona → strumień jak dziś, także przy `Accept-Encoding: gzip`', async () => {
    const h = await startHarness(false);
    const stream = await openStream(h, '/api/stream', 'gzip');

    expect(stream.headers['content-encoding']).toBeUndefined();
    expect(stream.headers['vary']).toBeUndefined();
    await waitFor('ramki startowe', () => SNAPSHOT_DONE(stream));
    expect(stream.text.startsWith('retry: 3000\n\n')).toBe(true);
    expect(h.compressors).toHaveLength(0);
  });

  it('rozłączenie klienta → kompresor zamknięty', async () => {
    const h = await startHarness(true);
    const packed = await openStream(h, '/api/stream', 'gzip');
    await waitFor('ramki startowe', () => SNAPSHOT_DONE(packed));
    expect(h.compressors).toHaveLength(1);

    packed.req.destroy();
    await waitFor('zamknięty kompresor', () => h.compressors.every((c) => c.closed));
    await waitFor('klient wyrejestrowany', () => h.hub.clientCount === 0);
  });

  it('odpięcie urządzenia → strumień domknięty poprawnym gzipem i kompresor zamknięty', async () => {
    const h = await startHarness(true);
    const packed = await openStream(h, '/api/stream', 'gzip');
    const session = await openStream(h, '/api/sessions/s1/stream', 'gzip');
    await waitFor('ramki startowe', () => SNAPSHOT_DONE(packed) && session.text.endsWith('\n\n'));

    expect(h.hub.closeOwner(TEST_DEVICE_ID)).toBe(2);
    await waitFor('koniec strumieni', () => packed.ended && session.ended);
    expect(packed.error).toBeNull();
    expect(session.error).toBeNull();
    await waitFor('zamknięte kompresory', () => h.compressors.length === 2 && h.compressors.every((c) => c.closed));
  });

  it('linia logu `sse: replay … → snapshot` podaje też bajty po kompresji', async () => {
    const h = await startHarness(true);
    h.manager.eventsSinceResult = {
      tooOld: false,
      events: [4, 5, 6].map((seq) => ({ seq, event: { type: 'message', sessionId: 's1', message: message(seq) } })),
    };
    h.manager.transcriptResult = {
      messages: Array.from({ length: 30 }, (_, i) => message(i + 1)), pendingPermissions: [], pendingQuestions: [],
    };
    const packed = await openStream(h, '/api/sessions/s1/stream?since=start-1:3', 'gzip');
    await waitFor('linia logu', () => h.lines.length === 1);

    const match = /^sse: replay 3 messages → snapshot (\d+\.\d) kB, gzip (\d+\.\d) kB \(session s1\)$/.exec(
      h.lines[0] ?? '',
    );
    expect(match, h.lines[0]).not.toBeNull();
    const raw = Number(match?.[1]);
    const packedKb = Number(match?.[2]);
    expect(packedKb).toBeGreaterThan(0);
    expect(packedKb).toBeLessThan(raw / 3);
    expect(h.lines[0]?.startsWith(REPLAY_SNAPSHOT_LOG)).toBe(true);
    await waitFor('migawka', () => packed.text.includes('"transcript-snapshot"'));

    // Bez kompresji linia jak dziś, bez części `gzip`.
    await openStream(h, '/api/sessions/s1/stream?since=start-1:3');
    await waitFor('druga linia logu', () => h.lines.length === 2);
    expect(h.lines[1]).toMatch(/^sse: replay 3 messages → snapshot \d+\.\d kB \(session s1\)$/);
  });
});

/** Random base64 text: gzip barely shrinks it, so frames really fill the socket. */
function noise(bytes: number): string {
  return randomBytes(Math.ceil((bytes * 3) / 4)).toString('base64').slice(0, bytes);
}

/** Titles of complete `session-changed` frames in the order they arrived (a frame still arriving is skipped). */
function liveTitles(text: string): string[] {
  return text
    .split('\n\n')
    .slice(0, -1)
    .filter((raw) => raw.includes('"session-changed"'))
    .map((raw) => {
      const data = /^data: (.*)$/m.exec(raw)?.[1] ?? '';
      const event = JSON.parse(data) as { session: { title: string } };
      return event.session.title;
    });
}

describe('SSE compression edge cases (flag on)', () => {
  it('(a) compressor error mid-stream: client stream closed, compressor closed, hub keeps serving', async () => {
    const h = await startHarness(true);
    const packed = await openStream(h, '/api/stream', 'gzip');
    await waitFor('start frames', () => SNAPSHOT_DONE(packed));
    const broken = h.compressors[0];
    if (broken === undefined) throw new Error('no compressor');

    broken.stream.destroy(new Error('simulated zlib failure'));
    await waitFor('client stream closed', () => packed.rawEnded);
    await waitFor('compressor closed', () => broken.closed);
    expect(h.hub.clientCount).toBe(0);

    // Frames after the failure reach nobody and throw nothing; a new client gets a working stream.
    expect(() => {
      h.manager.emit('global', null, { type: 'session-changed', session: makeSummary({ id: 's1', title: 'after' }) });
      h.hub.sendHeartbeat();
    }).not.toThrow();
    const next = await openStream(h, '/api/stream', 'gzip');
    await waitFor('start frames of the new stream', () => SNAPSHOT_DONE(next));
    expect(next.error).toBeNull();
    expect(h.hub.clientCount).toBe(1);
  });

  it('(b) closeAll with frames still in the compressors: complete gzip, compressors closed, no throw', async () => {
    const h = await startHarness(true);
    const global = await openStream(h, '/api/stream', 'gzip');
    const session = await openStream(h, '/api/sessions/s1/stream', 'gzip');
    await waitFor('start frames', () => SNAPSHOT_DONE(global) && session.text.endsWith('\n\n'));

    const titles = Array.from({ length: 8 }, (_, i) => `pending-${String(i)}-${noise(32 * 1024)}`);
    for (const title of titles) {
      h.manager.emit('global', null, { type: 'session-changed', session: makeSummary({ id: 's1', title }) });
      h.manager.emit('s1', null, { type: 'session-changed', session: makeSummary({ id: 's1', title }) });
    }
    // zlib works off the main thread, so the frames above are still inside the compressors here.
    expect(h.compressors.some((c) => c.stream.writableLength > 0)).toBe(true);
    expect(() => { h.hub.closeAll(); }).not.toThrow();
    expect(h.hub.clientCount).toBe(0);

    await waitFor('end of both streams', () => global.ended && session.ended, 5_000);
    expect(global.error).toBeNull();
    expect(session.error).toBeNull();
    expect(liveTitles(global.text)).toEqual(titles);
    expect(liveTitles(session.text)).toEqual(titles);
    await waitFor('closed compressors', () => h.compressors.length === 2 && h.compressors.every((c) => c.closed));
    expect(h.responses.filter((r) => r.url.includes('stream')).every((r) => r.res.writableFinished)).toBe(true);
    // No response left open: the server closes without forcing connections.
    await new Promise<void>((resolve) => { h.server.close(() => { resolve(); }); });
  });

  it('(c) backpressure: frames written while `write()` returns false arrive whole and in order', async () => {
    const h = await startHarness(true);
    const packed = await openStream(h, '/api/stream', 'gzip', { paused: true });
    const response = h.responses.find((r) => r.url === '/api/stream')?.res;
    const compressor = h.compressors[0]?.stream;
    if (response === undefined || compressor === undefined) throw new Error('no stream');
    let drains = 0;
    response.on('drain', () => { drains += 1; });

    const titles: string[] = [];
    let raw = 0;
    const emit = (): void => {
      const title = `frame-${String(titles.length)}-${noise(64 * 1024)}`;
      titles.push(title);
      raw += title.length;
      h.manager.emit('global', null, { type: 'session-changed', session: makeSummary({ id: 's1', title }) });
    };
    // Write until the socket of the response is full (`write()` returned false), then a few frames more.
    while (!response.writableNeedDrain) {
      if (titles.length >= 400) throw new Error('the socket never filled up');
      emit();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (let i = 0; i < 5; i += 1) emit();

    // The compressor holds nothing back: every frame is compressed and handed to the response, whose buffer stays
    // below the raw size of the frames (the uncompressed path would buffer all of it, the hub does not drop frames).
    const idle = (): boolean => compressor.writableLength === 0 && compressor.readableLength === 0;
    await waitFor('compressor drained', idle, 5_000);
    expect(response.writableNeedDrain).toBe(true);
    expect(response.writableLength).toBeLessThan(raw);

    packed.read();
    await waitFor('every frame', () => liveTitles(packed.text).length === titles.length, 10_000);
    expect(liveTitles(packed.text)).toEqual(titles);
    expect(packed.error).toBeNull();
    await waitFor('drain', () => drains > 0);
  });

  it('(d) through the iroh listener: `Content-Encoding: gzip`, the same frames as over TCP', async () => {
    const h = await startHarness(true, { iroh: true });
    const endpoint = h.iroh?.endpoint;
    if (endpoint === undefined) throw new Error('no iroh');
    const incoming = endpoint.incoming(fakeClientId(1));
    await waitFor('iroh connection accepted', () => incoming.connection.biLimits.length > 0);

    const tcp = await openStream(h, '/api/stream');
    const viaIroh = await openStream(h, '/api/stream', 'gzip', {
      connection: () => new FakeClientSocket(incoming.connection.openBi()),
    });
    expect(viaIroh.headers['content-encoding']).toBe('gzip');
    expect(viaIroh.headers['vary']).toBe('Accept-Encoding');
    await waitFor('start frames', () => SNAPSHOT_DONE(tcp) && SNAPSHOT_DONE(viaIroh));
    expect(viaIroh.text).toBe(tcp.text);

    h.manager.emit('global', null, { type: 'session-changed', session: makeSummary({ id: 's1', title: 'live' }) });
    h.hub.sendHeartbeat();
    const done = (s: Stream): boolean => s.text.endsWith(': ping\nevent: ping\ndata: {}\n\n');
    await waitFor('live frame and ping', () => done(tcp) && done(viaIroh));
    expect(viaIroh.text).toBe(tcp.text);
    expect(h.compressors).toHaveLength(1);
  });
});

/** Response whose socket never drains: every compressed byte stays counted in `writableLength`. */
class StalledSink implements SseResponse {
  writableLength = 0;
  destroyed = false;
  writeHead(): unknown { return this; }
  write(chunk: string | Uint8Array): boolean {
    this.writableLength += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
    return false;
  }
  end(): unknown { return this; }
  on(): unknown { return this; }
  destroy(): unknown {
    this.destroyed = true;
    return this;
  }
}

/** A hub with compression on and tracked compressors, without HTTP: streams go to {@link StalledSink}. */
function compressingHub(manager: FakeManager): { hub: SseHub; compressors: TrackedGzip[]; lines: string[] } {
  const compressors: TrackedGzip[] = [];
  const lines: string[] = [];
  const hub = new SseHub({
    manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0, gzip: true,
    logger: (line) => { lines.push(line); },
    createGzip: () => {
      const tracked: TrackedGzip = { stream: createGzip(), closed: false };
      tracked.stream.once('close', () => { tracked.closed = true; });
      compressors.push(tracked);
      return tracked.stream;
    },
  });
  hub.start();
  return { hub, compressors, lines };
}

/** The compressor took every byte written to it and handed its output on, or it is gone. */
async function compressorSettled(tracked: TrackedGzip | undefined): Promise<void> {
  if (tracked === undefined) throw new Error('no compressor');
  const { stream } = tracked;
  await waitFor('compressor settled', () => stream.destroyed
    || (stream.writableLength === 0 && stream.readableLength === 0), 10_000);
  // The flush callback and the last `data` event run after the buffers empty.
  await new Promise((resolve) => setImmediate(resolve));
}

const cutLines = (lines: string[]): string[] => lines.filter((line) => line.startsWith(WRITE_BUFFER_CUT_LOG));

describe('SSE write buffer ceiling with compression', () => {
  it('a compressed stream that never drains is cut near the ceiling, with one log line; the compressor closes', async () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    const { hub, compressors, lines } = compressingHub(manager);
    const sink = new StalledSink();
    hub.openGlobal(sink, 'device-1', 'gzip');
    const frame = 1024 * 1024;
    for (let i = 0; i < 60 && !sink.destroyed; i += 1) {
      manager.emit('global', null, {
        type: 'session-changed', session: makeSummary({ id: 's1', title: `SECRET-TITLE-${noise(frame)}` }),
      });
      await compressorSettled(compressors[0]);
    }
    expect(sink.destroyed).toBe(true);
    expect(sink.writableLength).toBeGreaterThan(SSE_WRITE_BUFFER_MAX);
    expect(hub.clientCount).toBe(0);
    await waitFor('compressor closed', () => compressors[0]?.closed === true);
    expect(cutLines(lines)).toHaveLength(1);
    expect(cutLines(lines)[0]).toContain('device-1');
    expect(lines.join('\n')).not.toContain('SECRET-TITLE');

    const written = sink.writableLength;
    hub.sendHeartbeat();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink.writableLength).toBe(written);
  });

  it('a maximum-size compressed snapshot to a slowly draining client, then a heartbeat, is not cut', async () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    const head = 'data:image/png;base64,';
    // Random base64 barely compresses, so the compressor input and its output are both close to the frame size.
    manager.transcriptResult = {
      messages: [
        { seq: 1, role: 'assistant', at: '2026-11-10T10:00:00.000Z', blocks: [{ type: 'text', text: noise(RING_MAX_BYTES) }] },
        {
          seq: 2, role: 'user', at: '2026-11-10T10:00:00.000Z',
          blocks: [{ type: 'image', dataUrl: head + noise(SNAPSHOT_IMAGE_BUDGET_BYTES - head.length) }],
        },
      ],
      pendingPermissions: [], pendingQuestions: [],
    };
    const { hub, compressors, lines } = compressingHub(manager);
    const sink = new StalledSink();
    hub.openSession('s1', sink, null, undefined, 'gzip');
    await compressorSettled(compressors[0]);
    expect(sink.writableLength).toBeGreaterThan(RING_MAX_BYTES);
    sink.writableLength = Math.floor(sink.writableLength * 0.9);
    hub.sendHeartbeat();
    await compressorSettled(compressors[0]);
    expect(sink.destroyed).toBe(false);
    expect(hub.clientCount).toBe(1);
    expect(cutLines(lines)).toHaveLength(0);
    hub.closeAll();
  });

  it('one compressed snapshot larger than the ceiling is not cut on its write', async () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    // Random base64 compresses to about three quarters, so the output alone still passes the ceiling.
    manager.transcriptResult = {
      messages: [{
        seq: 1, role: 'assistant', at: '2026-11-10T10:00:00.000Z',
        blocks: [{ type: 'text', text: noise(Math.floor(SSE_WRITE_BUFFER_MAX * 1.5)) }],
      }],
      pendingPermissions: [], pendingQuestions: [],
    };
    const { hub, compressors, lines } = compressingHub(manager);
    const sink = new StalledSink();
    hub.openSession('s1', sink, null, undefined, 'gzip');
    await compressorSettled(compressors[0]);
    hub.sendHeartbeat();
    await compressorSettled(compressors[0]);
    expect(sink.writableLength).toBeGreaterThan(SSE_WRITE_BUFFER_MAX);
    expect(sink.destroyed).toBe(false);
    expect(hub.clientCount).toBe(1);
    expect(cutLines(lines)).toHaveLength(0);
    hub.closeAll();
  });

  it.each([true, false])('over HTTP (compression %s): a client that stops reading is cut, and reconnecting gets a snapshot',
    async (gzip) => {
      const h = await startHarness(gzip);
      const stalled = await openStream(h, '/api/stream', gzip ? 'gzip' : undefined, { paused: true });
      for (let i = 0; i < 100 && h.hub.clientCount > 0; i += 1) {
        h.manager.emit('global', null, {
          type: 'session-changed', session: makeSummary({ id: 's1', title: `frame-${String(i)}-${noise(1024 * 1024)}` }),
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(h.hub.clientCount).toBe(0);
      expect(cutLines(h.lines)).toHaveLength(1);
      // A paused client sees the closed connection only once it reads again.
      stalled.read();
      await waitFor('stalled stream closed', () => stalled.error !== null || stalled.rawEnded, 10_000);
      if (gzip) await waitFor('compressor closed', () => h.compressors[0]?.closed === true);

      const again = await openStream(h, '/api/stream', gzip ? 'gzip' : undefined);
      await waitFor('snapshot after reconnect', () => SNAPSHOT_DONE(again));
      expect(h.hub.clientCount).toBe(1);
    }, 30_000);
});
