/**
 * The scheduler (`notify/index.ts`) and a test session (`NoteInput.testSession`): a session working in a temporary
 * directory, started by another agent for tests or measurements. Its "done" sends neither the badge nor the Live
 * Activity chime, now or later as an owed result; dialogs and errors call as for any session. Which paths count is
 * `server/test/test-session.test.ts`; the manager passing the fact is `server/test/manager-test-session.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { SessionState } from '@rarog/shared';
import type { SmEvent } from '../src/sessions/state-machine.ts';
import { Notifier, PUSH_QUIET_LOG } from '../src/notify/index.ts';
import type { NoteInput, SessionLook } from '../src/notify/index.ts';
import { FIRST_CHECK_MS } from '../src/notify/policy.ts';
import { Presence } from '../src/notify/presence.ts';
import type { PushContent, SendOutcome } from '../src/notify/content.ts';
import { createFanoutSink } from '../src/notify/fanout.ts';

const SESSION = 's1';
const QUIET_LINE = `${PUSH_QUIET_LOG} proj (done, test session in a temporary directory)`;
const HUMAN = { standbyNotices: 0, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 };

interface Rig {
  readonly notifier: Notifier;
  readonly sent: PushContent[];
  readonly logs: string[];
  /** Chime orders of the Live Activity tile (`FanoutOptions.chime`). */
  chimes(): number;
  /** Armed checks waiting for their timer. */
  timers(): number;
  setState(state: SessionState): void;
  setBackground(tasks: number): void;
  /** Runs every armed check. */
  fire(): Promise<void>;
  note(event: SmEvent, extra?: Partial<NoteInput>): void;
}

/** Real fanout sink with a chime counter; APNs is a fake that delivers. Nobody watches Rarog. */
function rig(): Rig {
  const sent: PushContent[] = [];
  const logs: string[] = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  let chimes = 0;
  let look: SessionLook = { state: 'waiting-input', seen: false, backgroundTasks: 0, waitingOnOwnCommand: false };
  const notifier = new Notifier({
    presence: new Presence(),
    sink: createFanoutSink({
      apns: {
        send(content: PushContent): Promise<SendOutcome> {
          sent.push(content);
          return Promise.resolve('delivered');
        },
      },
      chime: () => { chimes += 1; return 1; },
    }),
    badge: () => 0,
    look: (id) => (id === SESSION ? look : undefined),
    log: (line) => { logs.push(line); },
    setTimeout: (cb) => {
      const handle = next++;
      timers.set(handle, cb);
      return handle;
    },
    clearTimeout: (handle) => { timers.delete(handle as number); },
  });
  return {
    notifier, sent, logs,
    chimes: () => chimes,
    timers: () => timers.size,
    setState: (state) => { look = { ...look, state }; },
    setBackground: (tasks) => { look = { ...look, backgroundTasks: tasks }; },
    fire: async () => {
      const due = [...timers.values()];
      timers.clear();
      for (const cb of due) cb();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    note: (event, extra = {}) => {
      notifier.note({ sessionId: SESSION, event, backgroundTasks: 0, project: 'proj', ...extra });
    },
  };
}

describe('test session: no "done"', () => {
  it.each<[string, SmEvent]>([
    ['herdr idle', { type: 'agent-idle' }],
    ['result success', { type: 'result', subtype: 'success' }],
  ])('end of turn (%s), nobody watching: nothing armed, the quiet line, no badge, no chime', async (_label, event) => {
    const r = rig();
    r.note(event, { testSession: true, turnInput: HUMAN });
    expect(r.notifier.pending).toBe(0);
    expect(r.logs).toEqual([QUIET_LINE]);
    await r.fire();
    expect(r.sent).toEqual([]);
    expect(r.chimes()).toBe(0);
  });

  it('no owed result: the background going quiet later sends nothing', async () => {
    const r = rig();
    r.setBackground(1);
    r.note({ type: 'agent-idle' }, { testSession: true, turnInput: HUMAN, backgroundTasks: 1 });
    r.setBackground(0);
    r.notifier.quiet(SESSION);
    expect(r.timers()).toBe(0);
    await r.fire();
    expect(r.sent).toEqual([]);
    expect(r.chimes()).toBe(0);
  });

  it('the same session outside a temporary directory: the usual armed "done" with the chime', async () => {
    const r = rig();
    r.note({ type: 'agent-idle' }, { turnInput: HUMAN });
    expect(r.logs).toEqual([`push: armed done for proj (check in ${String(FIRST_CHECK_MS.done / 1_000)} s)`]);
    await r.fire();
    expect(r.sent.map((content) => content.kind)).toEqual(['done']);
    expect(r.chimes()).toBe(1);
  });

  it.each<[string, SmEvent, SessionState, string]>([
    ['permission', { type: 'permission-requested' }, 'waiting-permission', 'permission'],
    ['question', { type: 'question-requested' }, 'waiting-question', 'question'],
    ['dialog seen in the terminal', { type: 'agent-blocked' }, 'waiting-permission', 'blocked'],
    ['turn error', { type: 'result', subtype: 'error' }, 'error', 'error'],
  ])('%s still calls the owner', async (_label, event, state, kind) => {
    const r = rig();
    r.setState(state);
    r.note(event, { testSession: true });
    expect(r.notifier.pending).toBe(1);
    await r.fire();
    expect(r.sent.map((content) => content.kind)).toEqual([kind]);
    expect(r.chimes()).toBe(0);
  });
});
