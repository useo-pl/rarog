/**
 * A request target that `new URL` cannot parse (`//:/`, `//[`, `//@/`, `//x:99999/`): Node's HTTP parser delivers it
 * as `req.url`, so the server meets it before any credential. Over TCP, over the iroh listener (fake transport,
 * `helpers/fake-iroh.ts`) and through the demo control, a plain request gets `400 rest.bad-request`, a WebSocket
 * upgrade gets a closed socket, and the process keeps answering the next request. On iroh the refusals go to the
 * listener's log budget (`bad-url`, `upgrade-refused`) instead of ordinary lines. An `upgrade` listener that throws on
 * an iroh stream closes that stream, not the process.
 * Sandbox: `listen()`, so run outside it.
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
import { PROTOCOL_VERSION } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import { loadConfig } from '../src/config.ts';
import { createDemoControl } from '../src/demo/control.ts';
import type { ScenarioPanels } from '../src/demo/scenarios.ts';
import { startIroh } from '../src/iroh/listener.ts';
import type { IrohListener } from '../src/iroh/listener.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { createTermFeature } from '../src/term/index.ts';
import type { TermFeature } from '../src/term/index.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { FakeController, FakeHerdr } from './fake-term-herdr.ts';
import { FakeClientSocket, FakeEndpoint, ManualClock, fakeClientId, until } from './helpers/fake-iroh.ts';

const BAD_URLS = ['//:/', '//[', '//@/', '//x:99999/'] as const;
const ORIGIN = 'http://localhost:8930';
const RELAY = 'https://relay.example./';
const SERVER_ID = 'e'.repeat(64);
const BAD_REQUEST_BODY = { error: 'bad-request', message: 'Request rejected.', messageRef: say('rest.bad-request').ref };

interface Harness {
  readonly listener: IrohListener;
  readonly endpoint: FakeEndpoint;
  readonly logs: string[];
  readonly tcp: () => Duplex;
  close(): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function start(): Promise<Harness> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bad-url-')));
  const config = loadConfig({
    RAROG_ORIGINS: ORIGIN,
    RAROG_DATA_DIR: path.join(root, '.data'),
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
  if (config.iroh === null || config.iroh.key === null) throw new Error('config without iroh');
  const logs: string[] = [];
  const logger: Logger = { info: (line) => { logs.push(line); }, error: (line) => { logs.push(`ERROR ${line}`); } };
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const controllers: FakeController[] = [];
  const term: TermFeature | null = await createTermFeature(config, logger, {
    herdrLaunchClient: () => new FakeHerdr(),
    herdrSpawn: () => {
      const controller = new FakeController();
      controllers.push(controller);
      return controller;
    },
  });
  if (term === null) throw new Error('terminal did not start');
  const server = http.createServer();
  const endpoint = new FakeEndpoint(SERVER_ID);
  const listener = await startIroh(
    { secretKey: Buffer.from(config.iroh.key, 'hex'), relay: config.iroh.relay, port: config.iroh.port },
    server, logger, { open: async () => endpoint, clock: new ManualClock(), onFatal: (reason) => { logs.push(`FATAL ${reason}`); } },
  );
  server.on('request', createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger, term,
    iroh: { endpointId: listener.endpointId, relay: config.iroh.relay },
  }));
  server.on('upgrade', (req, socket, head) => { term.handleUpgrade(req, socket, head); });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  const h: Harness = {
    listener, endpoint, logs,
    tcp: () => net.connect(port, '127.0.0.1'),
    close: async () => {
      await listener.close();
      term.dispose();
      for (const controller of controllers) controller.kill();
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      rmSync(root, { recursive: true, force: true });
    },
  };
  cleanups.push(h.close);
  return h;
}

interface RawReply {
  /** Status from the first response line, `null` when the socket closed without a response. */
  readonly status: number | null;
  readonly body: unknown;
}

/** Sends `head` byte for byte (no client-side URL handling) and reads until the server ends or closes the socket. */
function raw(socket: Duplex, head: string): Promise<RawReply> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => { parts.push(chunk); });
    // A refused upgrade resets the stream; the reset is the expected end, not a test failure.
    socket.on('error', () => {});
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const text = Buffer.concat(parts).toString('utf8');
      const status = /^HTTP\/1\.1 (\d{3}) /.exec(text)?.[1];
      const bodyText = text.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      let body: unknown = bodyText;
      try {
        body = bodyText === '' ? null : JSON.parse(bodyText) as unknown;
      } catch {
        body = bodyText;
      }
      resolve({ status: status === undefined ? null : Number(status), body });
    };
    // An iroh stream is half-open: the server's end of the response is `end`, not `close`.
    socket.once('end', done);
    socket.once('close', done);
    socket.write(head);
  });
}

const plainGet = (target: string): string => `GET ${target} HTTP/1.1\r\nHost: server.test\r\nConnection: close\r\n\r\n`;
const upgradeGet = (target: string): string => `GET ${target} HTTP/1.1\r\nHost: server.test\r\n`
  + 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n'
  + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`;

/** Each request over iroh is a new bidirectional stream of one accepted connection. */
async function irohOpener(h: Pick<Harness, 'endpoint'>, n: number): Promise<() => Duplex> {
  const incoming = h.endpoint.incoming(fakeClientId(n));
  await until(() => incoming.connection.biLimits.length > 0 || incoming.connection.closeCalls.length > 0,
    2_000, `connection ${String(n)} settled`);
  const conn = incoming.connection;
  return () => new FakeClientSocket(conn.openBi());
}

async function expectAlive(open: () => Duplex): Promise<void> {
  const reply = await raw(open(), plainGet('/health'));
  expect(reply.status).toBe(200);
}

describe('request URL that does not parse', () => {
  it('over TCP a plain request gets 400 rest.bad-request and the server keeps answering', async () => {
    const h = await start();
    for (const target of BAD_URLS) {
      const reply = await raw(h.tcp(), plainGet(target));
      expect({ target, status: reply.status, body: reply.body })
        .toEqual({ target, status: 400, body: BAD_REQUEST_BODY });
    }
    await expectAlive(h.tcp);
    expect(h.logs.filter((line) => line.includes('unhandled router error'))).toEqual([]);
  });

  it('over TCP a WebSocket upgrade gets a closed socket and the server keeps answering', async () => {
    const h = await start();
    for (const target of BAD_URLS) {
      const reply = await raw(h.tcp(), upgradeGet(target));
      expect({ target, status: reply.status }).toEqual({ target, status: null });
    }
    await expectAlive(h.tcp);
  });

  it('over iroh a plain request gets 400 and counts as `bad-url` in the log budget', async () => {
    const h = await start();
    const open = await irohOpener(h, 1);
    for (const target of BAD_URLS) {
      const reply = await raw(open(), plainGet(target));
      expect({ target, status: reply.status, body: reply.body })
        .toEqual({ target, status: 400, body: BAD_REQUEST_BODY });
    }
    expect(h.listener.snapshot().refusals['bad-url']).toBe(BAD_URLS.length);
    // One line per kind in the window; the rest stay in the counters.
    expect(h.logs.filter((line) => line.startsWith('iroh: bad-url '))).toHaveLength(1);
    expect(h.logs.filter((line) => line.startsWith('refused '))).toEqual([]);
    await expectAlive(open);
  });

  it('over iroh a WebSocket upgrade gets a closed stream and counts as `upgrade-refused`', async () => {
    const h = await start();
    const open = await irohOpener(h, 2);
    for (const target of BAD_URLS) {
      const reply = await raw(open(), upgradeGet(target));
      expect({ target, status: reply.status }).toEqual({ target, status: null });
    }
    expect(h.listener.snapshot().refusals['upgrade-refused']).toBe(BAD_URLS.length);
    expect(h.logs.filter((line) => line.startsWith('term: upgrade refused'))).toEqual([]);
    await expectAlive(open);
  });

  it('over iroh an `upgrade` listener that throws closes the stream and the process keeps answering', async () => {
    // Node removes its own `'error'` listener from the socket before `'upgrade'`, so the throw comes back as the
    // stream's `'error'`; the listener must hear it, or the event alone would end the process.
    const server = http.createServer((_req, res) => { res.end('ok'); });
    server.on('upgrade', () => { throw new Error('upgrade listener failed'); });
    const endpoint = new FakeEndpoint(SERVER_ID);
    const logs: string[] = [];
    const listener = await startIroh(
      { secretKey: randomBytes(32), relay: RELAY, port: null },
      server, { info: (line) => { logs.push(line); }, error: (line) => { logs.push(`ERROR ${line}`); } },
      { open: async () => endpoint, clock: new ManualClock(), onFatal: (reason) => { logs.push(`FATAL ${reason}`); } },
    );
    // The accept loop starts at the server's `listening`.
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    cleanups.push(async () => {
      await listener.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    });
    const open = await irohOpener({ endpoint }, 3);
    const reply = await raw(open(), upgradeGet('/api/term/abc'));
    expect(reply.status).toBeNull();
    await expectAlive(open);
    expect(logs.filter((line) => line.startsWith('FATAL'))).toEqual([]);
  });

  it('the demo control answers 400 and the server keeps answering', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bad-url-demo-')));
    const config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: path.join(root, '.data'), RAROG_ORIGINS: ORIGIN });
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
    hub.start();
    const router = createRouter({
      config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger: { info() {}, error() {} },
    });
    // Nothing reaches the scenario panels on these paths.
    const control = createDemoControl(router, config, manager, {} as ScenarioPanels);
    const server = http.createServer(control.handler);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    cleanups.push(async () => {
      control.dispose();
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      rmSync(root, { recursive: true, force: true });
    });
    const { port } = server.address() as AddressInfo;
    const tcp = (): Duplex => net.connect(port, '127.0.0.1');
    for (const target of BAD_URLS) {
      const reply = await raw(tcp(), plainGet(target));
      expect({ target, status: reply.status, body: reply.body })
        .toEqual({ target, status: 400, body: BAD_REQUEST_BODY });
    }
    await expectAlive(tcp);
  });
});
