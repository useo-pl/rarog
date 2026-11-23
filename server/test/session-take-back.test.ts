/**
 * The queue take-back route (`POST /api/sessions/:id/queue/take-back`) and its manager module
 * (`server/src/sessions/session-take-back.ts`): the session gates, one driver take-back per `operationId`, the held
 * echoes of the taken messages and the refusal → status map.
 *
 * Boundary: a stub herdr supervisor and a driver driven by the test (no socket, no file), the real manager and the
 * real router on an ephemeral port. The driver's take-back itself (keys, the file, the field) has its own tests
 * (`queue-take-back.test.ts`); here the driver hands over a result and the test checks what the app gets.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import type { HerdrStatus } from '@rarog/shared';
import { queueTakeBackResponseSchema } from '@rarog/shared/rest';
import { foreign } from '@rarog/shared/sentences';
import { loadConfig } from '../src/config.ts';
import type {
  DriverEvent, HeldLeftover, HeldLeftoverItem, QueueTakeBackResult, TakeBackRefusal,
} from '../src/drivers/types.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { createManager } from '../src/sessions/manager.ts';
import { TAKE_BACK_RESULTS_MAX } from '../src/sessions/session-take-back.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { SseHub } from '../src/sse.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const ROOT = '/Users/demo/Projects';
const KEY = 'w1:p1';
const CODEX_KEY = 'w1:p2';
const T0 = Date.parse('2026-11-19T10:00:00.000Z');
const ORIGIN = 'http://localhost:8930';
const silent: Logger = { info: () => {}, error: () => {} };

class TakeBackDriver extends AtrapaDrivera {
  /** The driver's take-back: the test sets the next result; `undefined` = a driver without a queue. */
  takeBackQueue: ((onFirstKey?: () => void) => Promise<QueueTakeBackResult>) | undefined = () => {
    this.takeBacks += 1;
    return this.nextTakeBack;
  };
  nextTakeBack: Promise<QueueTakeBackResult> = Promise.resolve({ cli: [], rarog: [], fieldCleanup: 'done' });
  takeBacks = 0;

  push(...events: DriverEvent[]): void {
    for (const event of events) this.queue.push(event);
  }

  defersEcho(): boolean {
    return true;
  }

  /** The field read after the turn: always empty, so a flush looks as it does without the read. */
  checkHeldLeftover(
    items: readonly HeldLeftoverItem[], valid: () => boolean,
  ): Promise<ReadonlyMap<string, HeldLeftover> | null> {
    return Promise.resolve(valid() ? new Map(items.map((item) => [item.token, 'empty'] as const)) : null);
  }

  /** The deferred echo token of each send, in order. */
  get tokens(): string[] {
    return this.calls.flatMap((call) => (call.method === 'send' && call.opts?.echo !== undefined ? [call.opts.echo] : []));
  }
}

class Supervisor extends AtrapaNadzorcy<TakeBackDriver> {
  /** herdr in read-only mode: the write channel to panes is closed. */
  readOnly = false;

  override status(): HerdrStatus {
    return { available: true, agentCount: this.drivers.size, readOnly: this.readOnly, canLaunch: false };
  }

  protected nowyDriver(key: string): TakeBackDriver {
    return new TakeBackDriver(key, { dziennik: this.log });
  }
}

function agent(key: string, engine: 'claude' | 'codex' = 'claude'): HerdrAgent {
  return {
    key, paneId: key, tabId: 'w1:t1', agentSessionId: randomUUID(), engine, termId: null, cwd: `${ROOT}/atlas`,
    status: 'idle', title: 'atlas', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: engine === 'claude',
    launchedByRarog: true, interactiveReady: engine === 'claude',
  };
}

const idOf = (key: string): string => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`;

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
}

interface Rig {
  manager: Manager;
  supervisor: Supervisor;
  id: string;
  driver: TakeBackDriver;
  logs: string[];
}

let dataDir: string;
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-tb-'));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const close of closers.splice(0).reverse()) await close();
  await rm(dataDir, { recursive: true, force: true });
});

async function open(now: () => number = () => T0): Promise<Rig> {
  const logs: string[] = [];
  const supervisor = new Supervisor();
  const deps: HerdrManagerDeps = {
    sessionIdFor: idOf,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: () => Promise.resolve([]),
    writeUploadFiles: () => Promise.resolve([]),
    sweepUploads: () => Promise.resolve(),
  };
  const manager = await createManager({
    demo: false, dataDir, herdrSupervisor: supervisor, herdrDeps: deps, herdrRoots: [ROOT],
    now, gitStatus: null, gitWatcher: null, queueEcho: true,
    liveSessionsReader: () => Promise.resolve(null),
    logger: (line) => { logs.push(line); },
  });
  await manager.ready;
  closers.push(async () => {
    await manager.dispose();
    supervisor.dispose();
  });
  supervisor.lifecycle.push({ type: 'appeared', agent: agent(KEY) });
  await flush();
  const driver = supervisor.drivers.get(KEY);
  if (driver === undefined) throw new Error('the driver did not attach');
  driver.push({ type: 'agent-state', state: 'working', seen: false, mode: 'auto', stateChangeSeq: 2 });
  await flush();
  return { manager, supervisor, id: idOf(KEY), driver, logs };
}

/** A message from an app that can wait for the echo, sent during the turn: its echo is held. */
async function sendQueued(r: Rig, text: string): Promise<string> {
  const cid = randomUUID();
  await expect(r.manager.sendMessage(r.id, text, undefined, undefined, cid, { queueAware: true }))
    .resolves.toEqual({ replayed: false, queued: true });
  return cid;
}

async function serve(manager: Manager): Promise<(sessionId: string, body: unknown) => Promise<Response>> {
  const config = loadConfig({ RAROG_DEMO: '1' });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const hub = new SseHub({ manager, serverStartId: 's-tb', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 's-tb', startedAtMs: T0, logger: silent, devices: device.identity,
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  closers.push(async () => {
    hub.closeAll();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });
  const { port } = server.address() as AddressInfo;
  return (sessionId, body) => fetch(`http://127.0.0.1:${String(port)}/api/sessions/${sessionId}/queue/take-back`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: device.authorization },
    body: JSON.stringify(body),
  });
}

const userTexts = (r: Rig): string[] => r.manager.transcript(r.id).messages
  .filter((m) => m.role === 'user')
  .map((m) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''));

describe('take-back: 200 and the held echoes', () => {
  it('a held message comes back with its `clientMessageId`, a Mac prompt and a draft-joined message without it', async () => {
    const r = await open();
    const post = await serve(r.manager);
    const first = await sendQueued(r, 'first');
    const joined = await sendQueued(r, 'joined');
    const third = await sendQueued(r, 'third');
    const [t1, t2, t3] = r.driver.tokens;
    r.driver.nextTakeBack = Promise.resolve({
      cli: [
        { text: 'first', echo: t1 },
        { text: 'typed at the Mac' },
        // The follower matched the field in which the message was pasted after a draft at the desk.
        { text: 'a desk draft joined', echo: t2 },
      ],
      rarog: [{ text: 'third', echo: t3 }],
      fieldCleanup: 'done',
    });

    const res = await post(r.id, { operationId: randomUUID() });
    expect(res.status).toBe(200);
    const body = queueTakeBackResponseSchema.parse(await res.json());
    expect(body).toEqual({
      items: [
        { text: 'first', clientMessageId: first },
        { text: 'typed at the Mac' },
        { text: 'a desk draft joined' },
        { text: 'third', clientMessageId: third },
      ],
    });
    expect(body.items.some((item) => item.clientMessageId === joined)).toBe(false);
    expect(r.logs.some((line) => line === `take-back: ${r.id} gave back 4 prompt(s) in 0 ms (no key)`)).toBe(true);
  });

  it('`cliLeft` from the driver is `incomplete: true`; an empty queue is an empty list', async () => {
    const r = await open();
    const post = await serve(r.manager);
    expect(await (await post(r.id, { operationId: randomUUID() })).json()).toEqual({ items: [] });
    r.driver.nextTakeBack = Promise.resolve({ cli: [], rarog: [], fieldCleanup: 'pending', cliLeft: true });
    const res = await post(r.id, { operationId: randomUUID() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], incomplete: true });
  });

  it('the log line gives the time from the request to the first key and to the answer, or says no key went',
    async () => {
      let clock = T0;
      const r = await open(() => clock);
      let answer: (result: QueueTakeBackResult) => void = () => {};
      r.driver.takeBackQueue = (onFirstKey) => {
        clock += 140;
        onFirstKey?.();
        clock += 30;
        // A second key of the same take-back does not move the first.
        onFirstKey?.();
        return new Promise((resolve) => { answer = resolve; });
      };
      const taken = r.manager.takeBackQueue(r.id, randomUUID());
      clock += 1450;
      answer({ cli: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], rarog: [{ text: 'd' }], fieldCleanup: 'done' });
      await taken;
      r.driver.takeBackQueue = () => {
        clock += 12;
        return Promise.resolve({ cli: [], rarog: [{ text: 'e' }], fieldCleanup: 'pending', cliLeft: true });
      };
      await r.manager.takeBackQueue(r.id, randomUUID());
      expect(r.logs.filter((line) => line.startsWith(`take-back: ${r.id} gave back`))).toEqual([
        `take-back: ${r.id} gave back 4 prompt(s) in 1620 ms (first key after 140 ms)`,
        `take-back: ${r.id} gave back 1 prompt(s) in 12 ms (no key); part of the CLI queue stayed`,
      ]);
    });

  it('a taken message, own text or joined with a draft, is not flushed after the turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = await open();
    await sendQueued(r, 'taken');
    await sendQueued(r, 'joined');
    const kept = await sendQueued(r, 'kept');
    const [t1, t2] = r.driver.tokens;
    r.driver.nextTakeBack = Promise.resolve({
      cli: [{ text: 'taken', echo: t1 }, { text: 'draft joined', echo: t2 }], rarog: [], fieldCleanup: 'done',
    });
    await r.manager.takeBackQueue(r.id, randomUUID());

    r.driver.push({ type: 'agent-state', state: 'idle', seen: false, mode: 'auto', stateChangeSeq: 3 });
    await flush();
    vi.advanceTimersByTime(10_500);
    await flush();
    const user = r.manager.transcript(r.id).messages.filter((m) => m.role === 'user');
    expect(user.map((m) => m.clientMessageId)).toEqual([kept]);
    expect(userTexts(r)).toEqual(['kept']);
  });
});

describe('take-back: one take-back per `operationId`', () => {
  it('a retry gets the same body without a second take-back; a retry during it joins it', async () => {
    const r = await open();
    const post = await serve(r.manager);
    const cid = await sendQueued(r, 'once');
    let settle: (result: QueueTakeBackResult) => void = () => {};
    r.driver.nextTakeBack = new Promise((resolve) => { settle = resolve; });
    const operationId = randomUUID();

    const during = [post(r.id, { operationId }), post(r.id, { operationId })];
    await vi.waitFor(() => { expect(r.driver.takeBacks).toBe(1); });
    settle({ cli: [{ text: 'once', echo: r.driver.tokens[0] }], rarog: [], fieldCleanup: 'done' });
    const expected = { items: [{ text: 'once', clientMessageId: cid }] };
    for (const res of await Promise.all(during)) expect(await res.json()).toEqual(expected);

    r.driver.nextTakeBack = Promise.resolve({ cli: [], rarog: [], fieldCleanup: 'done' });
    const retry = await post(r.id, { operationId });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(expected);
    expect(r.driver.takeBacks).toBe(1);
    // Another id is another take-back.
    expect(await (await post(r.id, { operationId: randomUUID() })).json()).toEqual({ items: [] });
    expect(r.driver.takeBacks).toBe(2);
  });

  it('a refusal frees the id: a retry with it takes back again', async () => {
    const r = await open();
    const post = await serve(r.manager);
    const operationId = randomUUID();
    r.driver.nextTakeBack = Promise.resolve({ refused: 'dialog' });
    expect((await post(r.id, { operationId })).status).toBe(409);
    r.driver.nextTakeBack = Promise.resolve({ cli: [{ text: 'after the dialog' }], rarog: [], fieldCleanup: 'done' });
    const res = await post(r.id, { operationId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ text: 'after the dialog' }] });
    expect(r.driver.takeBacks).toBe(2);
  });

  it('finished results stay within the cap; a take-back that still runs stays joinable', async () => {
    const r = await open();
    const settles: ((result: QueueTakeBackResult) => void)[] = [];
    r.driver.takeBackQueue = () => {
      r.driver.takeBacks += 1;
      return new Promise((resolve) => { settles.push(resolve); });
    };
    const ids = Array.from({ length: TAKE_BACK_RESULTS_MAX + 2 }, () => randomUUID());
    const running = ids.map((id) => r.manager.takeBackQueue(r.id, id));
    // Every take-back but the last finishes, all of them started before the first finished.
    for (const settle of settles.slice(0, -1)) settle({ cli: [], rarog: [], fieldCleanup: 'done' });
    await Promise.all(running.slice(0, -1));
    const started = r.driver.takeBacks;

    // The running take-back and a newer finished result are still there: a retry joins, no new take-back.
    void r.manager.takeBackQueue(r.id, ids.at(-1) ?? '');
    void r.manager.takeBackQueue(r.id, ids[2] ?? '');
    expect(r.driver.takeBacks).toBe(started);
    // The oldest finished result left the registry: its id is a new take-back.
    void r.manager.takeBackQueue(r.id, ids[0] ?? '');
    expect(r.driver.takeBacks).toBe(started + 1);
  });
});

describe('take-back: a send during it waits for its answer', () => {
  it('a send after the turn goes out after a take-back that takes a held message; that message stays out of the '
    + 'transcript and comes back with its id', async () => {
    const r = await open();
    const cid = await sendQueued(r, 'taken');
    const [token] = r.driver.tokens;
    let settle: (result: QueueTakeBackResult) => void = () => {};
    r.driver.nextTakeBack = new Promise((resolve) => { settle = resolve; });
    const pending = r.manager.takeBackQueue(r.id, randomUUID());

    r.driver.push({ type: 'agent-state', state: 'idle', seen: false, mode: 'auto', stateChangeSeq: 3 });
    await flush();
    const sending = r.manager.sendMessage(r.id, 'after the turn');
    await flush();
    expect(userTexts(r)).toEqual([]);
    expect(r.driver.sent).toEqual(['taken']);

    settle({ cli: [{ text: 'taken', echo: token }], rarog: [], fieldCleanup: 'done' });
    await expect(pending).resolves.toEqual({ items: [{ text: 'taken', clientMessageId: cid }] });
    await expect(sending).resolves.toEqual({ replayed: false });
    expect(r.driver.sent).toEqual(['taken', 'after the turn']);
    expect(userTexts(r)).toEqual(['after the turn']);
  });

  it('a held message placed by its file entry during the take-back: a send meanwhile lands after it, in prompt order',
    async () => {
      const r = await open();
      await sendQueued(r, 'A');
      const [token] = r.driver.tokens;
      let settle: (result: QueueTakeBackResult) => void = () => {};
      r.driver.nextTakeBack = new Promise((resolve) => { settle = resolve; });
      r.driver.push({ type: 'agent-state', state: 'idle', seen: false, mode: 'auto', stateChangeSeq: 3 });
      await flush();
      const pending = r.manager.takeBackQueue(r.id, randomUUID());

      const sending = r.manager.sendMessage(r.id, 'B');
      await flush();
      // A went through in the instant before the take-back's keys: its file entry places it.
      r.driver.push({
        type: 'message', role: 'user', blocks: [{ type: 'text', text: foreign('A') }], echoToken: token,
      });
      await flush();
      settle({ cli: [], rarog: [], fieldCleanup: 'done' });

      await expect(pending).resolves.toEqual({ items: [] });
      await expect(sending).resolves.toEqual({ replayed: false });
      expect(userTexts(r)).toEqual(['A', 'B']);
      expect(r.driver.sent).toEqual(['A', 'B']);
    });

  it('two take-backs: a send waits for the last one; the held echo nobody took is flushed before it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = await open();
    const kept = await sendQueued(r, 'kept');
    const settles: ((result: QueueTakeBackResult) => void)[] = [];
    r.driver.takeBackQueue = () => new Promise((resolve) => { settles.push(resolve); });
    r.driver.push({ type: 'agent-state', state: 'idle', seen: false, mode: 'auto', stateChangeSeq: 3 });
    await flush();
    const first = r.manager.takeBackQueue(r.id, randomUUID());
    const last = r.manager.takeBackQueue(r.id, randomUUID());
    const sending = r.manager.sendMessage(r.id, 'B');
    await flush();

    settles[0]?.({ refused: 'busy' });
    await expect(first).rejects.toMatchObject({ sentence: { ref: { code: 'session.take-back.busy' } } });
    await flush();
    vi.advanceTimersByTime(10_500);
    await flush();
    expect(userTexts(r)).toEqual([]);
    expect(r.driver.sent).toEqual(['kept']);

    settles[1]?.({ cli: [], rarog: [], fieldCleanup: 'done' });
    await expect(last).resolves.toEqual({ items: [] });
    await expect(sending).resolves.toEqual({ replayed: false });
    const user = r.manager.transcript(r.id).messages.filter((m) => m.role === 'user');
    expect(user.map((m) => m.clientMessageId)).toEqual([kept, undefined]);
    expect(userTexts(r)).toEqual(['kept', 'B']);
  });
});

describe('take-back: held echoes are not flushed while it runs', () => {
  it('the end-of-turn flush waits; what the take-back did not take is flushed after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = await open();
    const taken = await sendQueued(r, 'taken');
    const kept = await sendQueued(r, 'kept');
    const [token] = r.driver.tokens;
    let settle: (result: QueueTakeBackResult) => void = () => {};
    r.driver.nextTakeBack = new Promise((resolve) => { settle = resolve; });
    const pending = r.manager.takeBackQueue(r.id, randomUUID());

    r.driver.push({ type: 'agent-state', state: 'idle', seen: false, mode: 'auto', stateChangeSeq: 3 });
    await flush();
    vi.advanceTimersByTime(10_500);
    await flush();
    expect(userTexts(r)).toEqual([]);

    settle({ cli: [{ text: 'taken', echo: token }], rarog: [], fieldCleanup: 'done' });
    await expect(pending).resolves.toEqual({ items: [{ text: 'taken', clientMessageId: taken }] });
    await flush();
    vi.advanceTimersByTime(10_500);
    await flush();
    const user = r.manager.transcript(r.id).messages.filter((m) => m.role === 'user');
    expect(user.map((m) => m.clientMessageId)).toEqual([kept]);
  });
});

describe('take-back: refusals', () => {
  const refusals: readonly [TakeBackRefusal, number, string][] = [
    ['pane', 410, 'gone'],
    ['dialog', 409, 'bad-state'],
    ['draft', 409, 'bad-state'],
    ['unknown', 409, 'bad-state'],
    ['queue', 409, 'bad-state'],
    ['busy', 409, 'bad-state'],
    ['disk', 409, 'bad-state'],
  ];

  it.each(refusals)('driver refusal `%s` → %i `%s` with its own sentence; the held echo stays', async (reason, status, error) => {
    const r = await open();
    const post = await serve(r.manager);
    await sendQueued(r, 'stays');
    r.driver.nextTakeBack = Promise.resolve({ refused: reason });
    const res = await post(r.id, { operationId: randomUUID() });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error, messageRef: { code: `session.take-back.${reason}` } });
    // Nothing was taken: the message still waits for its file entry.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    r.driver.push({ type: 'agent-state', state: 'idle', seen: false, mode: 'auto', stateChangeSeq: 3 });
    await flush();
    vi.advanceTimersByTime(10_500);
    await flush();
    expect(userTexts(r)).toEqual(['stays']);
  });

  it('a missing session → 410; a Codex pane, a closed write channel, a driver without a queue → 400; no take-back '
    + 'runs', async () => {
    const r = await open();
    const post = await serve(r.manager);
    const missing = await post('herdr-nope', { operationId: randomUUID() });
    expect(missing.status).toBe(410);
    expect(await missing.json()).toMatchObject({ error: 'gone', messageRef: { code: 'rest.session-not-found' } });

    r.supervisor.lifecycle.push({ type: 'appeared', agent: agent(CODEX_KEY, 'codex') });
    await flush();
    expect(r.manager.get(idOf(CODEX_KEY))?.engine).toBe('codex');
    const codex = await post(idOf(CODEX_KEY), { operationId: randomUUID() });
    expect(codex.status).toBe(400);
    expect(await codex.json()).toMatchObject({ error: 'bad-request', messageRef: { code: 'session.out-of-scope' } });

    r.supervisor.readOnly = true;
    const readOnly = await post(r.id, { operationId: randomUUID() });
    expect(readOnly.status).toBe(400);
    expect(await readOnly.json())
      .toMatchObject({ error: 'bad-request', messageRef: { code: 'session.herdr-read-only' } });
    r.supervisor.readOnly = false;

    r.driver.takeBackQueue = undefined;
    const none = await post(r.id, { operationId: randomUUID() });
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: 'bad-request', messageRef: { code: 'session.take-back.no-queue' } });
    expect(r.driver.takeBacks).toBe(0);
  });

  it('a body without a UUID `operationId` → 400 before the manager', async () => {
    const r = await open();
    const post = await serve(r.manager);
    expect((await post(r.id, {})).status).toBe(400);
    expect((await post(r.id, { operationId: 'not-a-uuid' })).status).toBe(400);
    expect(r.driver.takeBacks).toBe(0);
  });
});
