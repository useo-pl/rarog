/**
 * The voice agent's pick-up of a result (`markSeen` with a pick-up in `server/src/sessions/seen-marks.ts`) through the
 * manager, on the supervisor and driver fakes of `helpers/manager-herdr-atrapy.ts`: `seenBy` on the card, the 409 for
 * a result the agent did not read (a newer message in the session's memory or another `stateSince` than the read mark
 * names, another engine conversation, no result standing in `waiting-input` or a decision card over it), what a later
 * human receipt, a late herdr `done`, a new turn, "mark as unread" and a Rarog restart do to it, and when herdr gets
 * `agent.focus`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent, SessionSummary, TranscriptNotice } from '@rarog/shared';
import { foreign } from '@rarog/shared/sentences';
import type { DriverEvent, InternalBlock } from '../src/drivers/types.ts';
import type { NotifierLike } from '../src/notify/index.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager, ManagerConfig } from '../src/sessions/manager.ts';
import {
  ENGINE_SESSION, FakeSupervisor, PROJECT, flush, makeAgent, makeDeps,
} from './helpers/manager-herdr-atrapy.ts';
import type { FakeSeenMark } from './helpers/manager-herdr-atrapy.ts';

type Marks = Map<string, FakeSeenMark>;
const KEY = 'w9:p72';
/** The engine conversation the pane writes after `/resume` or `/clear`. */
const OTHER_CONVERSATION = '33333333-3333-4333-8333-333333333333';
const STANDBY: TranscriptNotice = { kind: 'agent', outcome: 'waiting', name: 'E5 shared views' };

const working = (stateChangeSeq: number): DriverEvent => ({ type: 'agent-state', state: 'working', stateChangeSeq });
const idle = (stateChangeSeq: number, seen?: boolean): DriverEvent => ({
  type: 'agent-state', state: 'idle', stateChangeSeq, ...(seen === undefined ? {} : { seen }),
});
const text = (value: string): InternalBlock[] => [{ type: 'text', text: foreign(value) }];

describe('the voice agent picks up a result', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];
  /** Push dismissals the notifier got (`notifier.seen`). */
  let dismissed: string[];
  let clock: number;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-pick-up-'));
    dismissed = [];
    clock = Date.parse('2026-11-20T10:00:00.000Z');
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  const notifier: NotifierLike = {
    note: () => undefined, seen: (id) => { dismissed.push(id); }, forget: () => undefined, quiet: () => undefined,
  };

  async function build(
    deps: HerdrManagerDeps, overrides: Partial<ManagerConfig> = {}, autoSettle = false,
  ): Promise<{ manager: Manager; supervisor: FakeSupervisor }> {
    const supervisor = new FakeSupervisor();
    supervisor.autoSettle = autoSettle;
    supervisors.push(supervisor);
    // Every state change gets its own `stateSince`: a second per reading of the clock.
    const manager = await createManager({
      demo: false, dataDir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
      maxPanes: 6, herdrSupervisor: supervisor, herdrDeps: deps, herdrRoots: [PROJECT], herdrSend: true, notifier,
      now: () => (clock += 1000),
      ...overrides,
    });
    managers.push(manager);
    await manager.ready;
    return { manager, supervisor };
  }

  /** A pane whose result nobody received: herdr shows `done` at state number 12. */
  async function withDone(marks: Marks = new Map(), overrides: Partial<ManagerConfig> = {}): Promise<{
    manager: Manager; supervisor: FakeSupervisor; id: string; feed: (...e: DriverEvent[]) => Promise<void>;
  }> {
    const { manager, supervisor } = await build(makeDeps(marks), overrides);
    supervisor.appear(makeAgent({ status: 'done', stateChangeSeq: 12 }));
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(manager.get(id)?.seen).toBe(false);
    const feed = async (...list: DriverEvent[]): Promise<void> => {
      for (const event of list) {
        supervisor.driver(KEY).queue.push(event);
        await flush();
      }
    };
    return { manager, supervisor, id, feed };
  }

  /** Frames of the global stream (each also goes to the session's own stream). */
  function record(manager: Manager): ServerEvent[] {
    const out: ServerEvent[] = [];
    manager.onEvent((scope, _seq, event) => { if (scope === 'global') out.push(event); });
    return out;
  }

  /** Session cards the clients got in `session-changed` frames. */
  function cards(events: ServerEvent[]): SessionSummary[] {
    return events.flatMap((e) => (e.type === 'session-changed' ? [e.session] : []));
  }

  /** The read mark the turns route takes of the session now (`readMark` of its answer). */
  const markOf = (manager: Manager, id: string): string => manager.companionTarget(id)?.readMark ?? '';
  /**
   * The voice agent's pick-up of the result it read: the read mark and the engine conversation of that read (the route
   * turns the body's token into this check, as for a send).
   */
  const pickUp = (
    manager: Manager, id: string, readMark = markOf(manager, id), read: string = ENGINE_SESSION,
  ): void => {
    manager.markSeen(id, {
      by: 'voice-agent', readMark, conversation: (agentSessionId) => agentSessionId === read,
    });
  };
  const refused = expect.objectContaining({
    code: 'bad-state', sentence: expect.objectContaining({ ref: { code: 'session.seen-result-changed' } }),
  });
  const bash: DriverEvent = {
    type: 'permission-request', reqId: 'tool-1', toolName: 'Bash', input: { command: 'ls' }, displayText: 'ls',
  };
  const question: DriverEvent = {
    type: 'question-request', reqId: 'q-1',
    questions: [{ question: 'Which file?', header: 'File', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] }],
  };

  it('the current result: `seen: true` and `seenBy` on the card, the push goes, `agent.focus` clears `done`',
    async () => {
      const marks: Marks = new Map();
      const { manager, supervisor, id } = await withDone(marks);
      const events = record(manager);

      pickUp(manager, id);
      await flush();

      expect(manager.get(id)?.seen).toBe(true);
      expect(manager.get(id)?.seenBy).toBe('voice-agent');
      expect(cards(events).at(-1)?.seenBy).toBe('voice-agent');
      expect(dismissed).toEqual([id]);
      // The same receipt as from the phone: herdr switches its view to the pane to clear the `done` badge.
      expect(supervisor.focusCalls).toEqual([KEY]);
      expect(marks.get(KEY)).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 12, by: 'voice-agent' });
    });

  it('the read mark of an older result or any other value: 409 with its sentence, the result stays unreceived',
    async () => {
      const marks: Marks = new Map();
      const { manager, supervisor, id, feed } = await withDone(marks);
      const read = markOf(manager, id);
      // A new turn after the agent read the session: its prompt and answer reach the session's memory.
      await feed(
        { type: 'message', role: 'user', blocks: text('and the docs?') }, working(13),
        { type: 'message', role: 'assistant', blocks: text('Updated.') }, idle(14, false),
      );
      expect(markOf(manager, id)).not.toBe(read);
      const events = record(manager);

      for (const stale of [read, 'not-a-mark']) {
        let refusal: unknown;
        try {
          pickUp(manager, id, stale);
        } catch (err) {
          refusal = err;
        }
        expect(refusal, stale).toMatchObject({
          code: 'bad-state', sentence: { ref: { code: 'session.seen-result-changed' } },
        });
      }
      await flush();

      expect(manager.get(id)?.seen).toBe(false);
      expect(manager.get(id)?.seenBy).toBeUndefined();
      expect(events).toEqual([]);
      expect(dismissed).toEqual([]);
      expect(supervisor.focusCalls).toEqual([]);
      expect(marks.size).toBe(0);
    });

  it('a turn that runs with the read mark the agent read: 409, nothing changes, the push stays', async () => {
    const { manager, id, feed } = await withDone();
    await feed(working(13));
    expect(manager.get(id)?.state).toBe('running');
    expect(() => { pickUp(manager, id); }).toThrow(expect.objectContaining({ code: 'bad-state' }));
    expect(manager.get(id)?.seen).toBeUndefined();
    expect(dismissed).toEqual([]);
  });

  /*
   * A decision inside a turn is no result: the answer from the phone (`permission-resolved`, `question-resolved`)
   * goes back to the running turn without a turn start, so a receipt taken there would cover the turn's real result.
   */
  it.each([
    { state: 'waiting-permission', card: bash, answer: (m: Manager, id: string) => m.resolvePermission(id, 'tool-1', 'allow', 'iPhone') },
    { state: 'waiting-question', card: question, answer: (m: Manager, id: string) => m.answerQuestion(id, 'q-1', [['a']]) },
  ] as const)('a turn in $state with the read mark the agent read: 409; the turn\'s result stays unreceived',
    async ({ state, card, answer }) => {
      const marks: Marks = new Map();
      const { manager, supervisor, id, feed } = await withDone(marks);
      await feed(working(13), card);
      expect(manager.get(id)?.state).toBe(state);
      const events = record(manager);

      expect(() => { pickUp(manager, id); }).toThrow(refused);
      expect(events).toEqual([]);
      expect(dismissed).toEqual([]);

      await expect(answer(manager, id)).resolves.toEqual({ outcome: 'ok' });
      await flush();
      expect(manager.get(id)?.state).toBe('running');
      await feed({ type: 'result', subtype: 'success' }, idle(14, false));
      expect(manager.get(id)?.state).toBe('waiting-input');
      expect(manager.get(id)?.seen).toBe(false);
      expect(manager.get(id)?.seenBy).toBeUndefined();
      expect(dismissed).toEqual([]);
      expect(supervisor.focusCalls).toEqual([]);
      expect(marks.size).toBe(0);
    });

  /*
   * A permission card or a question that reaches a session whose turn ended moves no state (both requests move only
   * from `running`), so the card stands over the result in `waiting-input`.
   */
  it.each([
    { kind: 'a permission card', card: bash, list: 'pendingPermissions' },
    { kind: 'a question', card: question, list: 'pendingQuestions' },
  ] as const)('$kind standing over the result in `waiting-input`: 409, nothing changes, the push stays',
    async ({ card, list }) => {
      const marks: Marks = new Map();
      const { manager, supervisor, id, feed } = await withDone(marks);
      await feed(card);
      expect(manager.get(id)?.state).toBe('waiting-input');
      expect(manager.transcript(id)[list]).toHaveLength(1);
      const events = record(manager);

      expect(() => { pickUp(manager, id); }).toThrow(refused);
      await flush();
      expect(manager.get(id)?.seen).toBe(false);
      expect(manager.get(id)?.seenBy).toBeUndefined();
      expect(events).toEqual([]);
      expect(dismissed).toEqual([]);
      expect(supervisor.focusCalls).toEqual([]);
      expect(marks.size).toBe(0);
    });

  /*
   * `/resume` and `/clear` in the pane bring the driver's `init` with another conversation while the session stays in
   * `waiting-input` with the same `stateSince` and nothing new in its memory, before the history of the new
   * conversation comes in.
   */
  it('the session moved to another conversation with the same state and read mark: 409 for the token of the one '
    + 'the agent read, nothing changes; the token of the new one picks up', async () => {
    const marks: Marks = new Map();
    const { manager, supervisor, id, feed } = await withDone(marks);
    const read = markOf(manager, id);
    const since = manager.get(id)?.stateSince;
    await feed({ type: 'init', engineSessionId: OTHER_CONVERSATION, model: 'claude-opus-5' });
    expect(manager.get(id)?.state).toBe('waiting-input');
    expect(manager.get(id)?.stateSince).toBe(since);
    expect(markOf(manager, id)).toBe(read);
    const events = record(manager);

    expect(() => { pickUp(manager, id, read, ENGINE_SESSION); }).toThrow(refused);
    await flush();
    expect(manager.get(id)?.seen).toBe(false);
    expect(manager.get(id)?.seenBy).toBeUndefined();
    expect(events).toEqual([]);
    expect(dismissed).toEqual([]);
    expect(supervisor.focusCalls).toEqual([]);
    expect(marks.size).toBe(0);

    pickUp(manager, id, read, OTHER_CONVERSATION);
    await flush();
    expect(manager.get(id)?.seenBy).toBe('voice-agent');
    expect(dismissed).toEqual([id]);
    expect(marks.get(KEY)).toEqual({ agentSessionId: OTHER_CONVERSATION, stateChangeSeq: 12, by: 'voice-agent' });
  });

  it('the history of the new conversation comes in after `/resume`: another read mark, 409 for the one read before '
    + 'it, the mark taken after it picks up', async () => {
    const { manager, id, feed } = await withDone();
    await feed({ type: 'init', engineSessionId: OTHER_CONVERSATION, model: 'claude-opus-5' });
    const beforeImport = markOf(manager, id);
    await feed({
      type: 'history', engineSessionId: OTHER_CONVERSATION, messages: [
        { role: 'user', blocks: text('Summarise the plan.'), at: '2026-11-20T09:00:00.000Z' },
        { role: 'assistant', blocks: text('Three stages.'), at: '2026-11-20T09:00:05.000Z' },
      ],
    });
    expect(manager.get(id)?.state).toBe('waiting-input');
    expect(markOf(manager, id)).not.toBe(beforeImport);

    expect(() => { pickUp(manager, id, beforeImport, OTHER_CONVERSATION); }).toThrow(refused);
    expect(manager.get(id)?.seen).toBe(false);
    expect(dismissed).toEqual([]);

    pickUp(manager, id, markOf(manager, id), OTHER_CONVERSATION);
    expect(manager.get(id)?.seenBy).toBe('voice-agent');
  });

  it('the driver runs another conversation before the manager heard its `init`: 409, nothing changes', async () => {
    const { manager, supervisor, id } = await withDone();
    // `/resume` reached the driver; its `init` still waits in the event queue.
    Object.assign(supervisor.driver(KEY), { agentSessionId: OTHER_CONVERSATION });
    expect(() => { pickUp(manager, id); }).toThrow(refused);
    expect(manager.get(id)?.seen).toBe(false);
    expect(dismissed).toEqual([]);
    // The same conversation on both sides picks up.
    Object.assign(supervisor.driver(KEY), { agentSessionId: ENGINE_SESSION });
    pickUp(manager, id);
    expect(manager.get(id)?.seenBy).toBe('voice-agent');
  });

  it('a session without an engine conversation yet: 409 for any token, also the token of no conversation',
    async () => {
      const { manager, supervisor } = await build(makeDeps());
      supervisor.appear(makeAgent({ status: 'done', stateChangeSeq: 12, agentSessionId: '' }));
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      expect(manager.get(id)?.state).toBe('waiting-input');
      for (const read of ['', ENGINE_SESSION]) {
        expect(() => {
          manager.markSeen(id, {
            by: 'voice-agent', readMark: markOf(manager, id),
            conversation: (agentSessionId) => (agentSessionId ?? '') === read,
          });
        }, read).toThrow(refused);
      }
      expect(manager.get(id)?.seen).toBe(false);
      expect(dismissed).toEqual([]);
    });

  it('a human opens the picked-up result: `seenBy` goes in one frame, `seen` stays, herdr gets no `agent.focus`',
    async () => {
      const marks: Marks = new Map();
      const { manager, supervisor, id } = await withDone(marks);
      pickUp(manager, id);
      await flush();
      expect(supervisor.focusCalls).toEqual([KEY]);
      const events = record(manager);

      manager.markSeen(id);
      await flush();

      expect(manager.get(id)?.seen).toBe(true);
      expect(manager.get(id)?.seenBy).toBeUndefined();
      expect(cards(events)).toHaveLength(1);
      expect(cards(events)[0]?.seen).toBe(true);
      expect(cards(events)[0]).not.toHaveProperty('seenBy');
      // Only the agent's own pick-up switched the herdr view.
      expect(supervisor.focusCalls).toEqual([KEY]);
      expect(marks.get(KEY)).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 12 });

      manager.markSeen(id);
      await flush();
      expect(cards(events)).toHaveLength(1);
    });

  it('a late `done` from herdr after the pick-up keeps it; the entry moves to the `done` number', async () => {
    const marks: Marks = new Map();
    const { manager, supervisor } = await build(makeDeps(marks));
    supervisor.appear(makeAgent({ status: 'idle', stateChangeSeq: 12 }));
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    const driver = supervisor.driver(KEY);
    driver.queue.push(working(13));
    await flush();
    // The end of the turn comes from the conversation file first; herdr knows nothing yet.
    driver.queue.push({ type: 'result', subtype: 'success' });
    await flush();
    expect(manager.get(id)?.seen).toBeUndefined();

    pickUp(manager, id);
    await flush();
    // No standing `done` known yet, so nothing to clear in herdr.
    expect(supervisor.focusCalls).toEqual([]);

    driver.queue.push(idle(14, false));
    await flush();
    expect(manager.get(id)?.seen).toBe(true);
    expect(manager.get(id)?.seenBy).toBe('voice-agent');
    expect(marks.get(KEY)).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 14, by: 'voice-agent' });
  });

  it('herdr\'s late `done` and its repeat after the read: the session stands in `waiting-input`, the mark holds, the '
    + 'pick-up goes through and clears `done`', async () => {
    const marks: Marks = new Map();
    const { manager, supervisor } = await build(makeDeps(marks));
    supervisor.appear(makeAgent({ status: 'idle', stateChangeSeq: 12 }));
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    const driver = supervisor.driver(KEY);
    driver.queue.push(working(13));
    await flush();
    // The end of the turn comes from the conversation file first; the agent reads the result then.
    for (const event of [
      { type: 'message', role: 'assistant', blocks: text('Done.') }, { type: 'result', subtype: 'success' },
    ] satisfies DriverEvent[]) {
      driver.queue.push(event);
      await flush();
    }
    expect(manager.get(id)?.state).toBe('waiting-input');
    const read = markOf(manager, id);

    for (const event of [idle(14, false), idle(14, false)]) {
      driver.queue.push(event);
      await flush();
    }
    expect(manager.get(id)?.seen).toBe(false);
    expect(markOf(manager, id)).toBe(read);

    pickUp(manager, id, read);
    await flush();
    expect(manager.get(id)?.seenBy).toBe('voice-agent');
    expect(supervisor.focusCalls).toEqual([KEY]);
    expect(marks.get(KEY)).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 14, by: 'voice-agent' });
  });

  it('a new turn takes away both `seen` and `seenBy`', async () => {
    const { manager, id, feed } = await withDone();
    pickUp(manager, id);
    await flush();
    expect(manager.get(id)?.seenBy).toBe('voice-agent');
    const events = record(manager);

    await feed(working(13));
    expect(manager.get(id)?.seen).toBeUndefined();
    expect(manager.get(id)?.seenBy).toBeUndefined();
    expect(cards(events).at(-1)).not.toHaveProperty('seen');
    expect(cards(events).at(-1)).not.toHaveProperty('seenBy');

    await feed(idle(14, false));
    expect(manager.get(id)?.seen).toBe(false);
    expect(manager.get(id)?.seenBy).toBeUndefined();
  });

  describe('a Rarog restart', () => {
    async function restart(marks: Marks, status: 'idle' | 'done', stateChangeSeq: number, overrides = {}):
      Promise<SessionSummary | undefined> {
      const { manager, supervisor } = await build(makeDeps(marks), overrides);
      supervisor.appear(makeAgent({ status, stateChangeSeq }));
      await flush();
      return manager.list().find((s) => s.paneId !== undefined);
    }

    it('keeps the pick-up after herdr answered its focus with `idle` at a higher number', async () => {
      const marks: Marks = new Map();
      const { manager, feed, id } = await withDone(marks);
      pickUp(manager, id);
      await feed(idle(13, true));
      expect(manager.get(id)?.seenBy).toBe('voice-agent');
      expect(marks.get(KEY)).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 13, by: 'voice-agent' });
      await manager.dispose();

      const card = await restart(marks, 'idle', 13);
      expect(card?.seen).toBe(true);
      expect(card?.seenBy).toBe('voice-agent');
    });

    it('keeps the pick-up of a pane still on `done` (focus off); another state number is another result', async () => {
      const marks: Marks = new Map();
      const { manager, id } = await withDone(marks, { herdrSeenFocus: false });
      pickUp(manager, id);
      await manager.dispose();

      const card = await restart(marks, 'done', 12, { herdrSeenFocus: false });
      expect(card?.seen).toBe(true);
      expect(card?.seenBy).toBe('voice-agent');

      // The pane idle at a later number: received by herdr's rule, but nobody picked up that result.
      const later = await restart(marks, 'idle', 15);
      expect(later?.seen).toBe(true);
      expect(later?.seenBy).toBeUndefined();
    });
  });

  it('a result a human received already: the pick-up changes nothing and adds no `seenBy`', async () => {
    const { manager, supervisor, id } = await withDone();
    manager.markSeen(id);
    await flush();
    const events = record(manager);
    pickUp(manager, id);
    await flush();
    expect(manager.get(id)?.seen).toBe(true);
    expect(manager.get(id)?.seenBy).toBeUndefined();
    expect(events).toEqual([]);
    expect(supervisor.focusCalls).toEqual([KEY]);
  });

  it('a repeated pick-up gives no second frame and no second focus', async () => {
    const { manager, supervisor, id } = await withDone();
    pickUp(manager, id);
    await flush();
    expect(manager.get(id)?.seenBy).toBe('voice-agent');
    const events = record(manager);
    pickUp(manager, id);
    await flush();
    expect(events).toEqual([]);
    expect(supervisor.focusCalls).toEqual([KEY]);
  });

  it('"mark as unread" after the pick-up: `seenBy` goes, `markedUnseen` comes, also after a restart', async () => {
    const marks: Marks = new Map();
    const { manager, id, feed } = await withDone(marks);
    pickUp(manager, id);
    await feed(idle(13, true));
    expect(manager.get(id)?.seenBy).toBe('voice-agent');
    expect(marks.get(KEY)).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 13, by: 'voice-agent' });

    manager.markUnseen(id);
    await flush();
    expect(manager.get(id)?.seen).toBeUndefined();
    expect(manager.get(id)?.seenBy).toBeUndefined();
    expect(manager.get(id)?.markedUnseen).toBe(true);
    expect(marks.get(KEY)).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 13, unseen: true });
    await manager.dispose();

    const { manager: manager2, supervisor: supervisor2 } = await build(makeDeps(marks));
    supervisor2.appear(makeAgent({ status: 'idle', stateChangeSeq: 13 }));
    await flush();
    const card = manager2.list().find((s) => s.paneId !== undefined);
    expect(card?.markedUnseen).toBe(true);
    expect(card?.seenBy).toBeUndefined();
  });

  it('a turn without a result after the pick-up keeps `seen` and `seenBy`', async () => {
    const marks: Marks = new Map();
    const { manager, supervisor } = await build(makeDeps(marks), {}, true);
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    const feed = async (...list: DriverEvent[]): Promise<void> => {
      for (const event of list) {
        supervisor.driver(KEY).queue.push(event);
        await flush();
      }
    };
    // One ordinary turn first: the turn tally is complete only after a seen turn end.
    await feed({ type: 'message', role: 'user', blocks: text('do it') }, working(10), idle(11));
    pickUp(manager, id);
    expect(manager.get(id)?.seenBy).toBe('voice-agent');

    await feed(
      { type: 'message', role: 'user', blocks: text('<task-notification>…</task-notification>'), notice: STANDBY },
      working(12), idle(13),
    );
    expect(manager.get(id)?.state).toBe('waiting-input');
    expect(manager.get(id)?.seen).toBe(true);
    expect(manager.get(id)?.seenBy).toBe('voice-agent');
    expect(marks.get(KEY)).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 13, by: 'voice-agent' });
  });

  /*
   * A turn after the read that ends while the result the agent read still stands. A context compaction alone adds no
   * message to the session's memory, but its state changes move `stateSince`, and the mark with it: the server cannot
   * tell such a turn from one whose messages have not reached the memory yet, so the agent reads again. A subagent
   * standby notice is a message: the mark moves and the agent reads again.
   */
  describe('a turn without a result after the read', () => {
    async function afterOrdinaryTurn(marks: Marks): Promise<{
      manager: Manager; id: string; feed: (...e: DriverEvent[]) => Promise<void>;
    }> {
      const { manager, supervisor } = await build(makeDeps(marks), {}, true);
      supervisor.appear(makeAgent());
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      const feed = async (...list: DriverEvent[]): Promise<void> => {
        for (const event of list) {
          supervisor.driver(KEY).queue.push(event);
          await flush();
        }
      };
      // One ordinary turn first: the turn tally is complete only after a seen turn end.
      await feed(
        { type: 'message', role: 'user', blocks: text('do it') }, working(10),
        { type: 'message', role: 'assistant', blocks: text('Done.') }, idle(11, false),
      );
      expect(manager.get(id)?.seen).toBe(false);
      return { manager, id, feed };
    }

    it('a context compaction alone: 409 for the read before it, the result stays unreceived; a read after it picks up',
      async () => {
        const marks: Marks = new Map();
        const { manager, id, feed } = await afterOrdinaryTurn(marks);
        const read = markOf(manager, id);
        const since = manager.get(id)?.stateSince;

        await feed({ type: 'turn-input', kind: 'compaction' }, working(12), idle(13, false));
        expect(manager.get(id)?.state).toBe('waiting-input');
        expect(manager.get(id)?.stateSince).not.toBe(since);
        expect(markOf(manager, id)).not.toBe(read);

        expect(() => { pickUp(manager, id, read); }).toThrow(refused);
        expect(manager.get(id)?.seen).toBe(false);
        expect(manager.get(id)?.seenBy).toBeUndefined();
        expect(dismissed).toEqual([]);
        expect(marks.size).toBe(0);

        pickUp(manager, id, markOf(manager, id));
        expect(manager.get(id)?.seenBy).toBe('voice-agent');
        expect(dismissed).toEqual([id]);
        expect(marks.get(KEY)).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 13, by: 'voice-agent' });
      });

    it('a subagent standby notice: 409, the result stays unreceived', async () => {
      const marks: Marks = new Map();
      const { manager, id, feed } = await afterOrdinaryTurn(marks);
      const read = markOf(manager, id);

      await feed(
        { type: 'message', role: 'user', blocks: text('<task-notification>…</task-notification>'), notice: STANDBY },
        working(12), idle(13, false),
      );
      expect(manager.get(id)?.state).toBe('waiting-input');

      expect(() => { pickUp(manager, id, read); }).toThrow(refused);
      expect(manager.get(id)?.seen).toBe(false);
      expect(manager.get(id)?.seenBy).toBeUndefined();
      expect(dismissed).toEqual([]);
      expect(marks.size).toBe(0);
    });
  });

  it('"Show in herdr" after the pick-up is a human receipt: `seenBy` goes in a frame', async () => {
    const marks: Marks = new Map();
    const { manager, id } = await withDone(marks);
    pickUp(manager, id);
    await flush();
    const events = record(manager);
    await manager.focus(id);
    expect(manager.get(id)?.seenBy).toBeUndefined();
    expect(cards(events).at(-1)).not.toHaveProperty('seenBy');
    expect(marks.get(KEY)).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 12 });
  });
});
