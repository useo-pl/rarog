/**
 * The task list swap of a session card (`sessions/conversation-lists.ts`) and the stalled wait alarm behind it: list
 * after list, how many `stalled` pushes go out. The chain is real (the swap, `stuckWaits` from `work.ts`, the session
 * facts from `bootstrap/push.ts` and `notify/stalled-wait.ts`); the APNs sink is a fake that delivers. The edge table
 * is in `herdr-background-work.test.ts`, the tries and the memory of one wait in `notify-stalled-wait.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { BackgroundTask, OwnCommandWait, SessionState } from '@rarog/shared';
import { stalledWaitListener } from '../src/bootstrap/push.ts';
import type { AgentFileReader } from '../src/herdr/background/agent-file.ts';
import { TASKS_POLL_MS, createTasksState, noteTasks } from '../src/herdr/background/merge.ts';
import type { TasksDeps } from '../src/herdr/background/merge.ts';
import { WAIT_STUCK_MS } from '../src/herdr/background/work.ts';
import { stalledTopicFor, topicFor } from '../src/notify/content.ts';
import type { PushContent, SendOutcome } from '../src/notify/content.ts';
import { Notifier } from '../src/notify/index.ts';
import { Presence } from '../src/notify/presence.ts';
import { createStalledWaitAlert } from '../src/notify/stalled-wait.ts';
import { applyConversationList } from '../src/sessions/conversation-lists.ts';
import type { ConversationListsPort } from '../src/sessions/conversation-lists.ts';
import { applyInitEvent } from '../src/sessions/driver-events.ts';
import type { InitPort } from '../src/sessions/driver-events.ts';
import { Session } from '../src/sessions/session.ts';

const AT = '2026-11-20T09:00:00.000Z';
const STANDBY = '2026-11-20T10:00:00.000Z';
const COMMAND = "until ! pgrep -f 'vitest run'; do sleep 30; done";

/** A subagent in standby on its own command, at a stage (`undefined`: before its file was read, no command known). */
function agent(stage: OwnCommandWait | undefined, extra: Partial<BackgroundTask> = {}): BackgroundTask {
  const base: BackgroundTask = { id: 'a7', kind: 'agent', description: 'Final tests', waitingSince: STANDBY, ...extra };
  return stage === undefined
    ? base
    : { ...base, ownTasks: [{ id: 'b0000007', command: COMMAND }], ownCommandWait: stage };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

function rig(state: SessionState = 'waiting-input', testSession = false) {
  const sent: PushContent[] = [];
  const quiets: string[] = [];
  const send = (content: PushContent): Promise<SendOutcome> => {
    sent.push(content);
    return Promise.resolve('delivered');
  };
  const alert = createStalledWaitAlert({
    send, presence: { active: () => false }, log: () => undefined,
    scheduler: { setTimeout: () => 0, clearTimeout: () => undefined, now: () => 0 },
  });
  const listener = stalledWaitListener(alert, () => testSession);
  const session = new Session({
    id: 's1', cwd: '/home/demo/atlas', title: 'atlas', label: 'tests', state, stateSince: AT, createdAt: AT,
    lastActivityAt: AT,
  });
  const port: ConversationListsPort = {
    emitSessionChanged: () => undefined,
    quiet: (id) => { quiets.push(id); },
    stuckWaits: listener.stuckWaits,
    prStatus: { applyList: () => undefined, clear: () => undefined },
  };
  const list = async (...tasks: BackgroundTask[]): Promise<void> => {
    applyConversationList(session, { type: 'background-tasks', tasks }, port);
    await settle();
  };
  return { session, sent, quiets, send, port, list, stalled: () => sent.filter((c) => c.kind === 'stalled').length };
}

describe('task list swap → `stalled` pushes', () => {
  it.each([
    { name: '`long`, then the same wait `stuck`', lists: [[agent('long')], [agent('stuck')]], pushes: 1 },
    { name: '`short`, then `stuck`', lists: [[agent('short')], [agent('stuck')]], pushes: 1 },
    { name: '`stuck` on the next lists', lists: [[agent('long')], [agent('stuck')], [agent('stuck')]], pushes: 1 },
    { name: 'clock set back: `stuck` → `long` → `stuck`',
      lists: [[agent('long')], [agent('stuck')], [agent('long')], [agent('stuck')]], pushes: 1 },
    { name: 'agent before its file was read, then `stuck`', lists: [[agent(undefined)], [agent('stuck')]], pushes: 0 },
    { name: 'the first list of the session already `stuck`', lists: [[agent('stuck')]], pushes: 0 },
    { name: 'driver swap: `long`, the new driver\'s first list without commands, then `stuck`',
      lists: [[agent('long')], [agent(undefined)], [agent('stuck')]], pushes: 0 },
    { name: 'two agents on the edge in one list',
      lists: [[agent('long'), agent('short', { id: 'a8' })], [agent('stuck'), agent('stuck', { id: 'a8' })]], pushes: 1 },
    { name: 'the same agent, a new standby, `long` → `stuck` again',
      lists: [[agent('long')], [agent('stuck')], [agent('short', { waitingSince: '2026-11-20T12:00:00.000Z' })],
        [agent('long', { waitingSince: '2026-11-20T12:00:00.000Z' })],
        [agent('stuck', { waitingSince: '2026-11-20T12:00:00.000Z' })]],
      pushes: 2 },
  ])('$name → $pushes', async ({ lists, pushes }) => {
    const r = rig();
    for (const tasks of lists) await r.list(...tasks);
    expect(r.stalled()).toBe(pushes);
  });

  it.each([
    { state: 'running', pushes: 1 },
    { state: 'waiting-permission', pushes: 1 },
    { state: 'done', pushes: 0 },
    { state: 'resumable', pushes: 0 },
  ] as const)('session $state → $pushes', async ({ state, pushes }) => {
    const r = rig(state);
    await r.list(agent('long'));
    await r.list(agent('stuck'));
    expect(r.stalled()).toBe(pushes);
  });

  it('a test session → 0', async () => {
    const r = rig('waiting-input', true);
    await r.list(agent('long'));
    await r.list(agent('stuck'));
    expect(r.stalled()).toBe(0);
  });

  it('the push names the subagent, never its command, and has its own key, not the session topic', async () => {
    const r = rig();
    await r.list(agent('long'));
    await r.list(agent('stuck'));
    const [push] = r.sent;
    expect(push).toMatchObject({ kind: 'stalled', sessionId: 's1', topic: stalledTopicFor('s1') });
    expect(push?.topic).not.toBe(topicFor('s1'));
    expect(push?.bodyRef?.args).toEqual(['Final tests']);
    expect(push?.titleRef?.args, 'the project is the session title').toEqual(['atlas']);
    expect(JSON.stringify(push)).not.toContain('pgrep');
  });

  it('a pending decision banner still goes out next to the alarm', async () => {
    const r = rig('waiting-permission');
    const timers: (() => void)[] = [];
    const notifier = new Notifier({
      presence: new Presence(),
      sink: { send: (content) => r.send(content).then((outcome) => ({ channels: { apns: outcome } })) },
      look: () => ({ state: 'waiting-permission', seen: false, backgroundTasks: 0, waitingOnOwnCommand: true }),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => undefined,
    });
    notifier.note({ sessionId: 's1', event: { type: 'permission-requested' }, backgroundTasks: 0, project: 'atlas' });
    await r.list(agent('long'));
    await r.list(agent('stuck'));
    for (const fire of timers.splice(0)) fire();
    await settle();
    expect(r.sent.map((c) => c.kind)).toEqual(['stalled', 'permission']);
    expect(new Set(r.sent.map((c) => c.topic)).size).toBe(2);
  });

  it('an owed "done": `quiet` does not fire on the edge, and once after the wait ends', async () => {
    const r = rig();
    await r.list(agent('long'));
    await r.list(agent('stuck'));
    expect(r.quiets).toEqual([]);
    await r.list(agent(undefined));
    await r.list(agent(undefined));
    expect(r.quiets).toEqual(['s1']);
    expect(r.stalled()).toBe(1);
  });

  it('a new conversation in the pane (`init` with another engine session) drops the alarm of the previous one', () => {
    const forgotten: string[] = [];
    const session = new Session({
      id: 's1', cwd: '/home/demo/atlas', title: 'atlas', state: 'waiting-input', stateSince: AT, createdAt: AT,
      lastActivityAt: AT, engineSessionId: '00000000-0000-4000-8000-000000000001',
    });
    const port = {
      config: { stalledWait: { forget: (id: string) => { forgotten.push(id); } } },
      customTitled: new WeakSet(), conversationChanged: () => undefined, indexEngineSession: () => undefined,
      applyTransition: () => false, emitSessionChanged: () => undefined,
      claimWindows: { holdBlocked: () => false, herdrMoved: () => undefined, conversationChanged: () => undefined },
    } as unknown as InitPort;
    applyInitEvent(session, { type: 'init', engineSessionId: '00000000-0000-4000-8000-000000000001', model: '' }, port);
    expect(forgotten).toEqual([]);
    applyInitEvent(session, { type: 'init', engineSessionId: '00000000-0000-4000-8000-000000000002', model: '' }, port);
    expect(forgotten).toEqual(['s1']);
  });

  /*
   * The real emission chain of `merge.ts` (`noteTasks`, then the subagent file read): the first list after an attach
   * (a Rarog restart or a driver swap, a fresh `TasksState`) carries the agent without its own commands, the next
   * one, after the file read, at `stuck`. No missing field before counts as an edge.
   */
  it('the first lists of a fresh attach (`noteTasks`, then the file read) → 0', async () => {
    const r = rig();
    const reader: AgentFileReader = {
      read: () => Promise.resolve({
        lastEntryAt: '2026-11-20T09:59:58.000Z',
        commands: [{ id: 'b0000007', command: COMMAND, startedAt: '2026-11-20T09:40:00.000Z' }],
      }),
      repoint: () => undefined, relocated: () => undefined, close: () => undefined,
    };
    const emitted: BackgroundTask[][] = [];
    const deps: TasksDeps = {
      reader: null, agentReader: reader, pollMs: TASKS_POLL_MS, disposed: () => false,
      scheduler: {
        setTimeout: () => 0, clearTimeout: () => undefined, now: () => Date.parse(STANDBY) + WAIT_STUCK_MS + 60_000,
      },
      emit: (tasks) => {
        emitted.push([...tasks]);
        applyConversationList(r.session, { type: 'background-tasks', tasks }, r.port);
      },
    };
    noteTasks(createTasksState(), deps, { tasks: [agent(undefined)], since: AT });
    await settle();
    expect(emitted.map((tasks) => tasks.map((task) => task.ownCommandWait))).toEqual([[undefined], ['stuck']]);
    expect(r.stalled()).toBe(0);
  });
});
