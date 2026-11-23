/**
 * Inbox cards on the real file path: the real herdr driver and follower over a conversation file in a temporary
 * Claude Code store, a real session manager without push notifications, the herdr socket and supervisor faked.
 * Late text of a turn, a re-attach that appends the history a second time, and a server restart (a new manager,
 * follower and tracker over the same file and `inbox.json`).
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HerdrStatus } from '@rarog/shared';
import { startInbox } from '../src/bootstrap/inbox.ts';
import { projectSlug } from '../src/cli-store.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import { assertSendable } from '../src/herdr/commands/guard.ts';
import { sessionIdFor } from '../src/herdr/identity.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { locateTranscript } from '../src/herdr/transcript-path.ts';
import type { HerdrAgent, HerdrLifecycleEvent, HerdrPaneEvent, HerdrSupervisor } from '../src/herdr/types.ts';
import type { Inbox, InboxCard } from '../src/inbox/index.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { FakeClient, TIMING } from './helpers/herdr-driver-atrapy.ts';
import { agentLine, toolLines, userLine } from './helpers/plik-rozmowy.ts';

const PANE = 'w9:p73';
const CONVERSATION = '7d2dd80f-012c-5c17-b97d-cf436a305158';

let base = '';
let dataDir = '';
let storeRoot = '';
let cwd = '';
let transcript = '';
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-inbox-follow-'));
  dataDir = join(base, 'data');
  storeRoot = join(base, 'store');
  cwd = join(base, 'project');
  await mkdir(dataDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(join(storeRoot, projectSlug(cwd)), { recursive: true });
  transcript = join(storeRoot, projectSlug(cwd), `${CONVERSATION}.jsonl`);
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(base, { recursive: true, force: true });
});

const flush = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
};

async function waitFor(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
}

const herdrDeps: HerdrManagerDeps = {
  sessionIdFor, aliasFor: () => undefined, rememberAlias: () => undefined,
  assertSendable: (text) => ({ text, slash: null }), takeSendSlot: () => true,
  writeUploads: () => Promise.resolve([]), writeUploadFiles: () => Promise.resolve([]),
  sweepUploads: () => Promise.resolve(),
};

interface Server {
  readonly manager: Manager;
  readonly inbox: Inbox;
  readonly id: string;
  /** Durations of the card reads so far, in ms. */
  readonly reads: number[];
  /** A pane status from herdr, as the supervisor relays it to the driver. */
  status(status: 'working' | 'done'): Promise<void>;
  /** The driver died and a new one attaches to the same pane: the follower reads the history again. */
  reattach(): Promise<void>;
  card(test: (card: InboxCard | null) => boolean, label: string): Promise<InboxCard | null>;
  stop(): Promise<void>;
}

/** One server process: supervisor fake, real driver and follower, manager and Inbox over the shared directories. */
async function startServer(): Promise<Server> {
  const lifecycle = new AsyncEventQueue<HerdrLifecycleEvent>();
  const listeners = new Set<(ev: HerdrPaneEvent) => void>();
  let seq = 1;
  const agent: HerdrAgent = {
    key: PANE, paneId: PANE, agentSessionId: CONVERSATION, cwd, status: 'idle', title: 'inbox', stateChangeSeq: seq,
    mode: 'auto', modeReadAt: 0, inScope: true, engine: 'claude', termId: null, tabId: 'w9:t3',
    launchedByRarog: false, interactiveReady: true,
  };
  const client = new FakeClient();
  client.screenText = '';
  const supervisor: HerdrSupervisor = {
    events: lifecycle,
    status: (): HerdrStatus => ({ available: true, agentCount: 1, readOnly: false, canLaunch: false }),
    attach: () => createHerdrDriver({
      agent,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }, {
      client, audit: { log: () => undefined }, guard: assertSendable, yoloRoots: [], now: () => Date.now(),
      sessionId: sessionIdFor(agent.key),
      follow: (o) => createJsonlFollower({ ...o, root: storeRoot, watch: false, timing: TIMING }),
      readAgentFiles: false,
    }),
    markSent: () => undefined,
    ensureFreshMode: () => Promise.resolve(agent.mode),
    focus: () => Promise.resolve(),
    launch: () => Promise.reject(new Error('launch: unused')),
    closeTab: () => Promise.reject(new Error('closeTab: unused')),
    rarogPaneCount: () => 0,
    liveEngineSessions: () => Promise.resolve(new Set([CONVERSATION])),
    dispose: () => { lifecycle.close(); },
  };
  const manager = await createManager({
    demo: false, dataDir, projects: [{ path: cwd, name: 'project' }], projectRoots: [], gitStatus: null,
    gitWatcher: null, liveSessionsReader: () => Promise.resolve(null), herdrSupervisor: supervisor,
    herdrRoots: [cwd], herdrSend: false, herdrDeps,
  });
  const reads: number[] = [];
  const inbox = startInbox({
    manager, ready: manager.ready, dataDir, promptBlock: true, log: () => undefined,
    locate: (dir, conversation) => locateTranscript(storeRoot, dir, conversation),
    debounceMs: 20, timing: (_id, ms) => { reads.push(ms); },
  });
  await manager.ready;
  lifecycle.push({ type: 'appeared', agent });
  await flush();
  const id = manager.list().find((s) => s.paneId === PANE)?.id ?? '';
  expect(id).not.toBe('');
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    inbox.dispose();
    await inbox.flush();
    await manager.dispose();
  };
  closers.push(stop);
  return {
    manager, inbox, id, reads, stop,
    async status(status) {
      seq += 1;
      agent.status = status;
      agent.stateChangeSeq = seq;
      for (const listener of listeners) listener({ type: 'status', status, stateChangeSeq: seq, title: 'inbox' });
      await flush();
    },
    async reattach() {
      lifecycle.push({ type: 're-attached', agent });
      await flush();
    },
    async card(test, label) {
      await waitFor(() => test(inbox.card(id)), label);
      return inbox.card(id);
    },
  };
}

/** The first turn, finished before the server starts. */
const TURN_1 = userLine('prompt 1', 1) + toolLines(1) + agentLine('answer 1', 2);

/** Waits until the reads of the card stop for a while after at least one more read than `from`. */
async function readsSettle(server: Server, from: number): Promise<void> {
  await waitFor(() => server.reads.length > from, 'a card read');
  let count = -1;
  while (count !== server.reads.length) {
    count = server.reads.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

describe('inbox over the real follower', () => {
  it('the end of a turn gives its card; text that lands later joins it under the same turn', async () => {
    await writeFile(transcript, TURN_1);
    const server = await startServer();
    const first = await server.card((c) => c?.text === 'answer 1', 'card of the first turn');
    expect(first?.kind).toBe('result');

    await server.status('working');
    await appendFile(transcript, userLine('prompt 2', 3) + toolLines(3) + agentLine('first half', 4));
    await server.status('done');
    const ended = await server.card((c) => c?.text === 'first half', 'card at the end of the turn');
    expect(server.manager.get(server.id)?.state).toBe('waiting-input');
    expect(ended?.turnId).not.toBe(first?.turnId);

    // The last entry of the turn reaches the file after the card was read.
    await appendFile(transcript, agentLine('second half', 5));
    const late = await server.card((c) => c?.text === 'first half\n\nsecond half', 'card with the late text');
    expect(late?.turnId).toBe(ended?.turnId);
    expect(late?.version).not.toBe(ended?.version);
  });

  it('a re-attach that reads the history again leaves the card as it was', async () => {
    await writeFile(transcript, TURN_1);
    const server = await startServer();
    const before = await server.card((c) => c?.text === 'answer 1', 'card');
    await readsSettle(server, 0);
    const from = server.reads.length;
    await server.reattach();
    await readsSettle(server, from);
    expect(server.inbox.card(server.id)).toEqual(before);
  });

  it('a restart gives the same card and turn; a card removed before it stays hidden', async () => {
    await writeFile(transcript, TURN_1);
    const first = await startServer();
    const card = await first.card((c) => c?.text === 'answer 1', 'card before the restart');
    expect(await first.inbox.remove(first.id, { turnId: card!.turnId, version: card!.version }))
      .toEqual({ kind: 'done', changed: true });
    await first.stop();

    const second = await startServer();
    expect(second.id).toBe(first.id);
    const again = await second.card((c) => c !== null, 'card after the restart');
    expect(again).toMatchObject({ turnId: card?.turnId, version: card?.version, text: 'answer 1', kind: 'result' });
    expect(second.inbox.removed(second.id)).toBe(true);
    expect(second.inbox.visibleCards()).toEqual([]);
  });

  it('late text keeps a removed card hidden; the next turn with a result brings the session back', async () => {
    await writeFile(transcript, TURN_1);
    const server = await startServer();
    await server.card((c) => c?.text === 'answer 1', 'card of the first turn');
    await server.status('working');
    await appendFile(transcript, userLine('prompt 2', 3) + toolLines(3) + agentLine('first half', 4));
    await server.status('done');
    const ended = await server.card((c) => c?.text === 'first half', 'card at the end of the turn');
    expect(await server.inbox.remove(server.id, { turnId: ended!.turnId, version: ended!.version }))
      .toEqual({ kind: 'done', changed: true });

    await appendFile(transcript, agentLine('second half', 5));
    await server.card((c) => c?.text === 'first half\n\nsecond half', 'card with the late text');
    expect(server.inbox.removed(server.id)).toBe(true);

    await server.status('working');
    await appendFile(transcript, userLine('prompt 3', 6) + agentLine('answer 3', 7));
    await server.status('done');
    const next = await server.card((c) => c?.text === 'answer 3', 'card of the next turn');
    expect(next?.turnId).not.toBe(ended?.turnId);
    expect(server.inbox.removed(server.id)).toBe(false);
    expect(server.inbox.visibleCards().map((c) => c.text)).toEqual(['answer 3']);
  });
});
