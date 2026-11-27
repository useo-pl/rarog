/**
 * `merge.ts` and the wait stage of a subagent on its own command (`BackgroundTask.ownCommandWait`, rules in
 * `work.ts`). The stage grows with the clock while the files stay the same, so the emission has to compare the list
 * with the stage in it: a list compared without the clock would never show a threshold passing.
 *
 * The replay runs the fixture `fixtures/herdr/tasks/endless-wait-loop-2.1.332/` (a reconstruction with neutral
 * content) through the real chain: the task reducer of the main file, the subagent file reader and `merge.ts` with its
 * 5 s timer. The subagent waits on `until ! pgrep -f '…'; do sleep 30; done`, a loop that never ends, because
 * `pgrep -f` also matches the loop's own shell.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackgroundTask } from '@rarog/shared';
import { projectSlug } from '../src/cli-store.ts';
import { createAgentFileReader } from '../src/herdr/background/agent-file.ts';
import type { AgentFileFacts, AgentFileReader } from '../src/herdr/background/agent-file.ts';
import { TASKS_POLL_MS, createTasksState, noteTasks } from '../src/herdr/background/merge.ts';
import type { TasksDeps, TasksState } from '../src/herdr/background/merge.ts';
import { createBackgroundTasksTracker } from '../src/herdr/background/reducer.ts';
import { WAIT_LONG_MS, WAIT_STUCK_MS } from '../src/herdr/background/work.ts';

/** A fake clock with a timer queue: `advance` fires every timer due on the way, in order. */
function harness(reader: AgentFileReader, start: number) {
  let now = start;
  let nextId = 1;
  const timers: { at: number; id: number; fn: () => void }[] = [];
  const lists: { at: number; tasks: BackgroundTask[] }[] = [];
  const state: TasksState = createTasksState();
  const deps: TasksDeps = {
    reader: null, agentReader: reader, pollMs: TASKS_POLL_MS, disposed: () => false,
    scheduler: {
      setTimeout: (fn, ms) => { timers.push({ at: now + ms, id: nextId, fn }); return nextId++; },
      clearTimeout: (handle) => {
        const index = timers.findIndex((timer) => timer.id === handle);
        if (index !== -1) timers.splice(index, 1);
      },
      now: () => now,
    },
    emit: (tasks) => { lists.push({ at: now, tasks: [...tasks] }); },
  };
  const settle = async (): Promise<void> => {
    for (let spins = 0; spins < 3 || state.polling; spins += 1) {
      if (spins > 10_000) throw new Error('the subagent file read does not finish');
      await new Promise((resolve) => { setImmediate(resolve); });
    }
  };
  const advance = async (until: number): Promise<void> => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const due = timers[0];
      if (due === undefined || due.at > until) break;
      timers.shift();
      now = due.at;
      due.fn();
      await settle();
    }
    now = Math.max(now, until);
  };
  return { state, deps, lists, settle, advance, now: () => now };
}

describe('merge.ts: the wait stage goes out with the clock, not only with the files', () => {
  const STANDBY = '2026-11-20T10:00:00.000Z';
  const standby = Date.parse(STANDBY);
  const facts: AgentFileFacts = {
    lastEntryAt: '2026-11-20T09:59:58.000Z',
    commands: [{ id: 'b0000007', command: "until ! pgrep -f 'vitest run'; do sleep 30; done",
      startedAt: '2026-11-20T09:40:00.000Z' }],
  };
  const unchanged: AgentFileReader = {
    read: () => Promise.resolve(facts), repoint: () => undefined, relocated: () => undefined, close: () => undefined,
  };
  const agent: BackgroundTask = { id: 'a7', kind: 'agent', description: 'Final tests', waitingSince: STANDBY };

  it('a list without file changes goes out with `long` on the first tick after the clock moved 30 min', async () => {
    const h = harness(unchanged, standby + 1_000);
    noteTasks(h.state, h.deps, { tasks: [agent], since: '2026-11-20T09:00:00.000Z' });
    await h.settle();
    expect(h.lists.at(-1)?.tasks[0]?.ownCommandWait).toBe('short');
    const before = h.lists.length;
    await h.advance(h.now() + 3 * TASKS_POLL_MS);
    expect(h.lists.length, 'ticks without a change send nothing').toBe(before);

    await h.advance(standby + WAIT_LONG_MS - 1);
    expect(h.lists.length, 'nothing before the threshold').toBe(before);
    await h.advance(standby + WAIT_LONG_MS + TASKS_POLL_MS);
    expect(h.lists.length, 'one emission past the threshold').toBe(before + 1);
    expect(h.lists.at(-1)?.tasks[0]?.ownCommandWait).toBe('long');
    expect(h.lists.at(-1)?.at).toBeGreaterThanOrEqual(standby + WAIT_LONG_MS);
    expect(h.lists.at(-1)?.at).toBeLessThan(standby + WAIT_LONG_MS + TASKS_POLL_MS);
  });
});

describe('replay: a subagent on an endless wait loop goes `short`, `long`, `stuck` and never goes dormant', () => {
  const FIXTURE = join(import.meta.dirname, 'fixtures/herdr/tasks/endless-wait-loop-2.1.332');
  const AGENT = 'a5e1c0de7b2f49a13';
  const SESSION = '00000000-0000-4000-8000-000000000001';
  const CWD = '/Users/u/project';
  const MAIN = readFileSync(join(FIXTURE, 'main.jsonl'), 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rarog-wait-loop-'));
    mkdirSync(join(root, projectSlug(CWD), SESSION, 'subagents'), { recursive: true });
    writeFileSync(join(root, projectSlug(CWD), `${SESSION}.jsonl`), '{}\n');
    writeFileSync(join(root, projectSlug(CWD), SESSION, 'subagents', `agent-${AGENT}.jsonl`),
      readFileSync(join(FIXTURE, 'subagents', `agent-${AGENT}.jsonl`)));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('the stage follows `waitingSince` on the clock, one emission per stage, the agent stays on the list', async () => {
    const reader = createAgentFileReader({ cwd: CWD, agentSessionId: SESSION, root, logger: () => undefined });
    const time = (entry: Record<string, unknown>): number => Date.parse(String(entry['timestamp']));
    const h = harness(reader, time(MAIN[0] ?? {}));
    const tracker = createBackgroundTasksTracker();
    let sent = JSON.stringify(tracker.tasks);
    for (const entry of MAIN) {
      await h.advance(time(entry));
      tracker.note(entry);
      const key = JSON.stringify(tracker.tasks);
      if (key === sent) continue;
      sent = key;
      noteTasks(h.state, h.deps, { tasks: [...tracker.tasks], since: tracker.firstEntryAt });
      await h.settle();
    }
    const end = Date.parse('2026-01-01T09:10:52.000Z') + WAIT_STUCK_MS + 10 * 60_000;
    await h.advance(end);

    const agentIn = (tasks: readonly BackgroundTask[]): BackgroundTask | undefined =>
      tasks.find((task) => task.id === AGENT);
    const shown = h.lists.filter(({ tasks }) => agentIn(tasks) !== undefined);
    expect(shown.length).toBeGreaterThan(0);
    const firstShown = h.lists.indexOf(shown[0] ?? { at: 0, tasks: [] });
    expect(h.lists.slice(firstShown).every(({ tasks }) => agentIn(tasks) !== undefined), 'the agent went dormant')
      .toBe(true);

    const waiting = shown.map(({ at, tasks }) => ({ at, task: agentIn(tasks) }))
      .filter(({ task }) => task?.waitingSince !== undefined);
    const since = Date.parse(waiting[0]?.task?.waitingSince ?? '');
    expect(new Date(since).toISOString(), 'the clock starts at the standby notification')
      .toBe('2026-01-01T09:10:52.000Z');
    expect(waiting.every(({ task }) => task?.ownTasks?.map((own) => own.id).join() === 'b00000003')).toBe(true);
    // The working agent before the standby carries its open command but no stage.
    const working = shown.slice(0, shown.length - waiting.length).map(({ tasks }) => agentIn(tasks));
    expect(working.some((task) => task?.ownTasks !== undefined)).toBe(true);
    expect(working.every((task) => task?.ownCommandWait === undefined)).toBe(true);
    expect(waiting.map(({ task }) => task?.ownCommandWait)).toEqual(['short', 'long', 'stuck']);
    const [, long, stuck] = waiting;
    expect(long?.at).toBeGreaterThanOrEqual(since + WAIT_LONG_MS);
    expect(long?.at).toBeLessThan(since + WAIT_LONG_MS + TASKS_POLL_MS);
    expect(stuck?.at).toBeGreaterThanOrEqual(since + WAIT_STUCK_MS);
    expect(stuck?.at).toBeLessThan(since + WAIT_STUCK_MS + TASKS_POLL_MS);
  });
});
