/**
 * Inbox cards (`server/src/inbox/`) through a real session manager on the herdr supervisor and driver fakes, without
 * push notifications: the card kind by session state, the dialog of a decision card, sessions without a card, and
 * remove and restore with their effect on the receipt of the result. The tracker reads a synthetic conversation file
 * on disk; the driver fake moves the session's state.
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startInbox } from '../src/bootstrap/inbox.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { INBOX_FILENAME } from '../src/inbox/index.ts';
import type { Inbox, InboxCard } from '../src/inbox/index.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { ENGINE_SESSION, FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';
import type { FakeHerdrDriver } from './helpers/manager-herdr-atrapy.ts';
import {
  agentLine, artifactWatchLine, lineTime, localCommandLines, toolLines, userLine,
} from './helpers/plik-rozmowy.ts';

const PANE = 'w9:p72';
/** The engine conversation the pane writes after `/clear` or `/resume`. */
const OTHER_CONVERSATION = '33333333-3333-4333-8333-333333333333';

let base = '';
let dataDir = '';
let file = '';
/** Conversation files by engine conversation id; a conversation without an entry has no file yet. */
const files = new Map<string, string>();
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-inbox-'));
  dataDir = join(base, 'data');
  file = join(base, `${ENGINE_SESSION}.jsonl`);
  files.clear();
  files.set(ENGINE_SESSION, file);
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(base, { recursive: true, force: true });
});

interface Rig {
  readonly manager: Manager;
  readonly supervisor: FakeSupervisor;
  readonly driver: FakeHerdrDriver;
  readonly inbox: Inbox;
  readonly id: string;
  /** Feeds driver events and lets the manager digest them. */
  feed(...events: DriverEvent[]): Promise<void>;
  /** Waits until the session's card satisfies `test`; returns it. */
  cardWhere(test: (card: InboxCard | null) => boolean, label: string): Promise<InboxCard | null>;
  /** Waits for at least one more card read of the session than when it was called, then for the reads to settle. */
  nextRead(): Promise<void>;
  /** Stops this server: the Inbox, the manager and the supervisor. */
  stop(): Promise<void>;
}

async function waitFor(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

async function build(agent: HerdrAgent = makeAgent()): Promise<Rig> {
  const supervisor = new FakeSupervisor();
  const manager = await createManager({
    demo: false, dataDir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
    gitWatcher: null, liveSessionsReader: () => Promise.resolve(null), herdrSupervisor: supervisor,
    herdrDeps: makeDeps(), herdrRoots: [PROJECT], herdrSend: true,
  });
  let reads = 0;
  const inbox = startInbox({
    manager, ready: manager.ready, dataDir, promptBlock: true, log: () => undefined,
    locate: (_cwd, conversation) => Promise.resolve(files.get(conversation) ?? null),
    debounceMs: 5, timing: () => { reads += 1; },
  });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    inbox.dispose();
    await manager.dispose();
    supervisor.dispose();
  };
  closers.push(stop);
  await manager.ready;
  supervisor.appear(agent);
  await flush();
  const id = manager.list().find((s) => s.paneId === agent.paneId)?.id ?? '';
  expect(id).not.toBe('');
  const driver = supervisor.driver(agent.key);
  return {
    manager, supervisor, driver, inbox, id, stop,
    async feed(...events) {
      for (const event of events) driver.queue.push(event);
      await flush();
    },
    async cardWhere(test, label) {
      await waitFor(() => test(inbox.card(id)), label);
      return inbox.card(id);
    },
    async nextRead() {
      const from = reads;
      await waitFor(() => reads > from, 'a card read');
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  };
}

const WORKING: DriverEvent = { type: 'agent-state', state: 'working' };
/** herdr reports the end of a turn with the `done` badge standing. */
const DONE: DriverEvent = { type: 'agent-state', state: 'idle', seen: false };

const PERMISSION: DriverEvent = {
  type: 'permission-request', reqId: 'tool-1', toolName: 'Bash', input: { command: 'pnpm test' },
  displayText: 'pnpm test',
};
const QUESTION: DriverEvent = {
  type: 'question-request', reqId: 'q-1',
  questions: [{ question: 'Which file?', header: 'File', multiSelect: false, options: [{ label: 'a.ts' }, { label: 'b.ts' }] }],
};

/** One finished turn with a tool call: the card shows the text after the tool call. */
const FIRST_TURN = userLine('prompt 1', 1) + agentLine('reading the file', 1) + toolLines(2) + agentLine('answer 1', 3);

describe('inbox: card kind by session state', () => {
  it('the end of a turn with a result gives a result card with the text after the last tool call', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = await build();
    await rig.feed(WORKING, DONE);
    const card = await rig.cardWhere((c) => c?.state === 'waiting-input', 'result card');
    expect(card).toMatchObject({ kind: 'result', text: 'answer 1', at: lineTime(3), truncated: false });
    expect(card?.dialog).toBeUndefined();
    expect(rig.inbox.visibleCards().map((c) => c.sessionId)).toEqual([rig.id]);
  });

  it('a decision card carries the dialog the session waits for; the end of the turn makes it a result', async () => {
    await writeFile(file, FIRST_TURN + userLine('run the tests', 4) + agentLine('running the tests', 5));
    const rig = await build();
    await rig.feed(WORKING, PERMISSION);
    const permission = await rig.cardWhere((c) => c?.kind === 'decision', 'permission card');
    expect(permission).toMatchObject({
      state: 'waiting-permission', text: 'running the tests', at: rig.manager.get(rig.id)?.stateSince,
      dialog: { kind: 'permission', waitingFor: { kind: 'permission', tool: 'Bash', text: 'pnpm test' } },
    });

    // The card leaves the screen and a dialog the pane shows without a card stands in its place.
    await rig.feed({ type: 'permission-cleared', reqId: 'tool-1' }, { type: 'screen-dialog', knownDialog: 'trust' });
    const panel = await rig.cardWhere((c) => c?.dialog?.kind === 'panel', 'panel dialog');
    expect(panel?.dialog).toEqual({ kind: 'panel', herdrDialog: 'trust' });
    expect(panel?.turnId).toBe(permission?.turnId);
    expect(panel?.version).not.toBe(permission?.version);

    await rig.feed({ type: 'permission-cleared' }, WORKING, QUESTION);
    const question = await rig.cardWhere((c) => c?.state === 'waiting-question', 'question card');
    expect(question?.dialog).toMatchObject({ kind: 'question', waitingFor: { kind: 'question', text: 'Which file?' } });

    await appendFile(file, toolLines(6) + agentLine('all tests pass', 7));
    await rig.feed({ type: 'permission-cleared' }, WORKING, DONE);
    const result = await rig.cardWhere((c) => c?.kind === 'result', 'result after the decision');
    expect(result).toMatchObject({ turnId: permission?.turnId, text: 'all tests pass', at: lineTime(7) });
  });

  /** The input of an `Edit` permission, whose description is the input as JSON. */
  const EDIT_INPUT = { file_path: '/w/src/a.ts', old_string: 'a', new_string: 'b' };

  it.each([
    ['a shell command', PERMISSION],
    ['an Edit described by its JSON input', {
      type: 'permission-request', reqId: 'tool-e', toolName: 'Edit', input: EDIT_INPUT,
      displayText: JSON.stringify(EDIT_INPUT, null, 2),
    }],
    ['a plan', {
      type: 'permission-request', reqId: 'tool-p', toolName: 'ExitPlanMode', input: { plan: '# Plan\n\nstep one' },
      displayText: '# Plan\n\nstep one',
    }],
    ['a command whose first line is longer than the summary line', {
      ...PERMISSION, reqId: 'tool-l', input: { command: `echo ${'x'.repeat(200)}\nls` },
      displayText: `  echo ${'x'.repeat(200)}  \nls`,
    }],
    ['a card without an allow button', { ...PERMISSION, reqId: 'tool-d', canAllow: false }],
    ['one question', QUESTION],
    ['two questions', {
      ...QUESTION, questions: [...(QUESTION as Extract<DriverEvent, { type: 'question-request' }>).questions, {
        question: 'Why?', header: 'Why', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }],
      }],
    }],
  ] as const)('a decision card for %s carries the id of the card the summary describes', async (_name, event) => {
    await writeFile(file, FIRST_TURN + userLine('run the tests', 4) + agentLine('running the tests', 5));
    const rig = await build();
    await rig.feed(WORKING, event as DriverEvent);
    const card = await rig.cardWhere((c) => c?.kind === 'decision', 'decision card');
    expect(card?.dialog).toMatchObject({ requestId: (event as { reqId: string }).reqId });
  });

  it.each([
    ['error', { type: 'result', subtype: 'error' }],
    ['limit-reached', { type: 'limit-reached' }],
    ['interrupted', { type: 'result', subtype: 'error_max_turns' }],
  ] as const)('%s before the first assistant message gives a failed card', async (state, event) => {
    await writeFile(file, userLine('first prompt', 1));
    const rig = await build();
    await rig.feed(WORKING, event as DriverEvent);
    const card = await rig.cardWhere((c) => c?.state === state, `${state} card`);
    expect(card).toMatchObject({ kind: 'failed', text: '', at: rig.manager.get(rig.id)?.stateSince });
  });

  it.each([
    ['a Codex pane', { engine: 'codex' }],
    ['a pane out of scope', { inScope: false }],
  ] as const)('%s has no card', async (_name, overrides) => {
    await writeFile(file, FIRST_TURN);
    const rig = await build(makeAgent(overrides));
    await rig.feed(WORKING, DONE);
    await rig.nextRead();
    expect(rig.inbox.card(rig.id)).toBeNull();
  });

  it('a closed session has no card', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = await build();
    await rig.feed(WORKING, DONE);
    await rig.cardWhere((c) => c?.kind === 'result', 'result card');
    // The pane's process ended: the session stays in the list, closed.
    rig.supervisor.emit({ type: 'gone', key: makeAgent().key });
    await flush();
    await rig.cardWhere((c) => c === null, 'no card after the close');
    expect(rig.manager.get(rig.id)?.state).toBe('done');
    expect(rig.inbox.visibleCards()).toEqual([]);
  });

  it.each([
    ['/clear before the new conversation has a file', null],
    ['/clear with the command lines in the new file', localCommandLines('clear', '', 10)],
    ['/resume of a conversation whose only prompt got no answer', userLine('prompt from before', 0)],
  ] as const)('%s leaves the session without a card', async (_name, content) => {
    await writeFile(file, FIRST_TURN);
    const rig = await build();
    await rig.feed(WORKING, DONE);
    await rig.cardWhere((c) => c?.kind === 'result', 'card of the first conversation');
    if (content !== null) {
      const other = join(base, `${OTHER_CONVERSATION}.jsonl`);
      await writeFile(other, content);
      files.set(OTHER_CONVERSATION, other);
    }
    // The pane writes another conversation; the state and the model stay as they were.
    await rig.feed({ type: 'init', engineSessionId: OTHER_CONVERSATION, model: '' });
    await rig.cardWhere((c) => c === null, 'no card in the new conversation');
    expect(rig.manager.get(rig.id)?.state).toBe('waiting-input');
  });

  it('a turn with a result and no text, as a manual /compact leaves it, keeps the previous card', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = await build();
    await rig.feed(WORKING, DONE);
    const before = await rig.cardWhere((c) => c?.kind === 'result' && c.state === 'waiting-input', 'result card');
    await rig.feed(WORKING);
    await rig.cardWhere((c) => c?.state === 'running', 'card while the turn runs');
    await appendFile(file, userLine('/compact', 10) + toolLines(10, 'toolu_compact'));
    await rig.feed(DONE);
    const after = await rig.cardWhere((c) => c?.state === 'waiting-input', 'card after the turn');
    expect(after).toEqual(before);
  });

  it('a turn without a result keeps the previous card in place', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = await build();
    await rig.feed(WORKING, DONE);
    const before = await rig.cardWhere((c) => c?.kind === 'result', 'result card');
    await appendFile(file, artifactWatchLine(8) + agentLine('nothing to do', 8));
    await rig.feed(WORKING, DONE);
    await rig.nextRead();
    expect(rig.inbox.card(rig.id)).toEqual(before);
  });
});

describe('inbox: remove and restore', () => {
  async function withResult(): Promise<{ rig: Rig; card: InboxCard }> {
    await writeFile(file, FIRST_TURN);
    const rig = await build();
    await rig.feed(WORKING, DONE);
    const card = await rig.cardWhere((c) => c?.kind === 'result' && c.state === 'waiting-input', 'result card');
    expect(card).not.toBeNull();
    expect(rig.manager.get(rig.id)?.seen).not.toBe(true);
    return { rig, card: card! };
  }

  it('removing a result receives it with the herdr focus; the same request again does nothing more', async () => {
    const { rig, card } = await withResult();
    const ref = { turnId: card.turnId, version: card.version };
    expect(await rig.inbox.remove(rig.id, ref)).toEqual({ kind: 'done', changed: true });
    expect(rig.inbox.removed(rig.id)).toBe(true);
    expect(rig.inbox.visibleCards()).toEqual([]);
    expect(rig.manager.get(rig.id)?.seen).toBe(true);
    expect(rig.supervisor.focusCalls).toEqual([PANE]);

    expect(await rig.inbox.remove(rig.id, ref)).toEqual({ kind: 'done', changed: false });
    expect(rig.supervisor.focusCalls).toEqual([PANE]);
  });

  it('restore after removing a result brings the card back unread; the same request again does nothing more', async () => {
    const { rig, card } = await withResult();
    const ref = { turnId: card.turnId, version: card.version };
    await rig.inbox.remove(rig.id, ref);
    expect(await rig.inbox.restore(rig.id, ref)).toEqual({ kind: 'done', changed: true });
    expect(rig.inbox.removed(rig.id)).toBe(false);
    expect(rig.manager.get(rig.id)).toMatchObject({ markedUnseen: true });
    expect(rig.manager.get(rig.id)?.seen).toBeUndefined();
    expect(await rig.inbox.restore(rig.id, ref)).toEqual({ kind: 'done', changed: false });
  });

  it('restore leaves a result received before the removal received', async () => {
    const { rig, card } = await withResult();
    rig.manager.markSeen(rig.id);
    const ref = { turnId: card.turnId, version: card.version };
    await rig.inbox.remove(rig.id, ref);
    await rig.inbox.restore(rig.id, ref);
    expect(rig.manager.get(rig.id)?.seen).toBe(true);
  });

  it('a request for another turn or an older version is refused without effect', async () => {
    const { rig, card } = await withResult();
    expect(await rig.inbox.remove(rig.id, { turnId: card.turnId, version: 'older' })).toEqual({ kind: 'stale' });
    expect(await rig.inbox.remove(rig.id, { turnId: 'another', version: card.version })).toEqual({ kind: 'stale' });
    expect(await rig.inbox.restore(rig.id, { turnId: 'another', version: card.version })).toEqual({ kind: 'stale' });
    expect(await rig.inbox.remove('unknown', { turnId: card.turnId, version: card.version })).toEqual({ kind: 'stale' });
    expect(rig.inbox.removed(rig.id)).toBe(false);
    expect(rig.manager.get(rig.id)?.seen).not.toBe(true);
  });

  it('removing a decision only hides it; the result of that turn comes unread and visible', async () => {
    await writeFile(file, FIRST_TURN + userLine('run the tests', 4) + agentLine('running the tests', 5));
    const rig = await build();
    await rig.feed(WORKING, PERMISSION);
    const decision = await rig.cardWhere((c) => c?.kind === 'decision', 'decision card');
    const seen = rig.manager.get(rig.id)?.seen;
    expect(await rig.inbox.remove(rig.id, { turnId: decision!.turnId, version: decision!.version }))
      .toEqual({ kind: 'done', changed: true });
    expect(rig.inbox.removed(rig.id)).toBe(true);
    expect(rig.manager.get(rig.id)?.seen).toBe(seen);
    expect(rig.supervisor.focusCalls).toEqual([]);

    await rig.manager.resolvePermission(rig.id, 'tool-1', 'allow', 'iPhone');
    await appendFile(file, toolLines(6) + agentLine('all tests pass', 7));
    await rig.feed(WORKING, DONE);
    const result = await rig.cardWhere((c) => c?.kind === 'result', 'result after the approval');
    expect(result?.turnId).toBe(decision?.turnId);
    expect(rig.inbox.removed(rig.id)).toBe(false);
    expect(rig.manager.get(rig.id)?.seen).not.toBe(true);
  });

  it('a removed result hides neither a later failure nor a later decision that show its text', async () => {
    const { rig, card } = await withResult();
    await rig.inbox.remove(rig.id, { turnId: card.turnId, version: card.version });
    await appendFile(file, userLine('second prompt', 9));
    await rig.feed(WORKING, PERMISSION);
    const decision = await rig.cardWhere((c) => c?.kind === 'decision', 'decision card');
    expect(decision?.turnId).toBe(card.turnId);
    expect(rig.inbox.removed(rig.id)).toBe(false);

    await rig.feed({ type: 'result', subtype: 'error' });
    const failed = await rig.cardWhere((c) => c?.kind === 'failed', 'failed card');
    expect(failed?.turnId).toBe(card.turnId);
    expect(rig.inbox.removed(rig.id)).toBe(false);
  });

  it('two permissions in a row with the same command are two decisions: removing the first keeps the second', async () => {
    await writeFile(file, FIRST_TURN + userLine('run the tests', 4) + agentLine('running the tests', 5));
    const rig = await build();
    // Both cards stand at once; the session summary describes the first one, and then the second, the same way.
    await rig.feed(WORKING, PERMISSION, { ...PERMISSION, reqId: 'tool-2' });
    const first = await rig.cardWhere((c) => c?.kind === 'decision', 'first decision');
    expect(await rig.inbox.remove(rig.id, { turnId: first!.turnId, version: first!.version }))
      .toEqual({ kind: 'done', changed: true });

    await rig.manager.resolvePermission(rig.id, 'tool-1', 'allow', 'iPhone');
    expect(rig.manager.get(rig.id)).toMatchObject({ state: 'waiting-permission', stateSince: first?.at });
    const second = await rig.cardWhere((c) => c !== null && c.version !== first?.version, 'second decision');
    expect(second).toMatchObject({ kind: 'decision', turnId: first?.turnId, text: first?.text });
    expect(rig.inbox.removed(rig.id)).toBe(false);
  });

  it('two pane dialogs without a card in a row are two decisions: removing the first keeps the second', async () => {
    await writeFile(file, FIRST_TURN + userLine('run the tests', 4) + agentLine('running the tests', 5));
    const rig = await build();
    await rig.feed(WORKING, PERMISSION, { type: 'permission-cleared', reqId: 'tool-1' });
    await rig.feed({ type: 'screen-dialog', reason: 'multi-select' });
    const first = await rig.cardWhere((c) => c?.dialog?.kind === 'panel', 'first pane dialog');
    expect(await rig.inbox.remove(rig.id, { turnId: first!.turnId, version: first!.version }))
      .toEqual({ kind: 'done', changed: true });

    await rig.feed({ type: 'screen-dialog', reason: 'no-digit' });
    const second = await rig.cardWhere((c) => c !== null && c.version !== first?.version, 'second pane dialog');
    expect(second).toMatchObject({ kind: 'decision', turnId: first?.turnId, dialog: { kind: 'panel' } });
    expect(rig.inbox.removed(rig.id)).toBe(false);
  });

  it('a removed decision whose dialog still stands after a server restart stays removed', async () => {
    await writeFile(file, FIRST_TURN + userLine('run the tests', 4) + agentLine('running the tests', 5));
    const before = await build();
    await before.feed(WORKING, PERMISSION);
    const decision = await before.cardWhere((c) => c?.kind === 'decision', 'decision before the restart');
    expect(await before.inbox.remove(before.id, { turnId: decision!.turnId, version: decision!.version }))
      .toEqual({ kind: 'done', changed: true });
    await before.inbox.flush();
    await before.stop();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The new server finds the pane blocked on the same dialog; the session entered its state at another moment.
    const after = await build();
    await after.feed(WORKING, PERMISSION);
    const again = await after.cardWhere((c) => c?.kind === 'decision', 'decision after the restart');
    expect(again?.at).not.toBe(decision?.at);
    expect(again?.turnId).toBe(decision?.turnId);
    expect(after.inbox.removed(after.id)).toBe(true);
  });

  it('a failed write of inbox.json fails the removal: the card stays visible and the result unreceived', async () => {
    const { rig, card } = await withResult();
    const ref = { turnId: card.turnId, version: card.version };
    // A directory where the write's temporary file goes makes the write fail.
    await mkdir(join(dataDir, `${INBOX_FILENAME}.tmp`));
    expect(await rig.inbox.remove(rig.id, ref)).toEqual({ kind: 'write-failed' });
    expect(rig.inbox.removed(rig.id)).toBe(false);
    expect(rig.inbox.visibleCards()).toHaveLength(1);
    expect(rig.manager.get(rig.id)?.seen).not.toBe(true);

    await rm(join(dataDir, `${INBOX_FILENAME}.tmp`), { recursive: true });
    expect(await rig.inbox.remove(rig.id, ref)).toEqual({ kind: 'done', changed: true });
  });
});
