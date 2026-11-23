/**
 * Scheduled task list refresh of the herdr driver (`drivers/herdr/scheduled-task-poll.ts`), on a manual clock: the
 * signal window, the first payout also when empty, payout only from a whole read of a located file, the retry of a
 * failed read without a new signal, the slow re-read after a whole read (a file swapped at the same size), a late read
 * of the previous conversation, the re-send after the driver's first `init`, and the follower's file for the reader.
 * The facade wiring is `scheduled-tasks-integration.test.ts`.
 */
import { appendFile, chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionScheduledTask } from '@rarog/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectSlug } from '../src/cli-store.ts';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import {
  createScheduledTaskPollState, followerFileLocation, noteScheduledTasksProcessStart, readScheduledTasks,
  repointScheduledTasks, scheduleScheduledTasks, scheduledTasksAfterInit, stopScheduledTasks,
} from '../src/drivers/herdr/scheduled-task-poll.ts';
import type { ScheduledTaskPollDeps, ScheduledTaskPollState } from '../src/drivers/herdr/scheduled-task-poll.ts';
import {
  SCHEDULED_TASKS_BACKLOG_MS, SCHEDULED_TASKS_POLL_MS, createScheduledTaskFileReader,
} from '../src/herdr/background/index.ts';
import type { ScheduledTaskFileReader, ScheduledTasksRead } from '../src/herdr/background/index.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { FollowEvent, JsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { cronCreate, cronDelete } from './helpers/cron-lines.ts';

const CWD = '/Users/demo/Projects/crons';
const SESSION = '5b1f0c2e-8d3a-4e71-9a62-1c4d7e0f2b93';

const task = (id: string): SessionScheduledTask => ({ id, cron: '*/5 * * * *', recurring: true, prompt: `p ${id}` });
const whole = (tasks: SessionScheduledTask[]): ScheduledTasksRead => ({ tasks, more: false, failed: false, unknown: false });

/** Manual clock: timers fire only on `fire()`, so every delay is visible. */
class ManualScheduler implements Scheduler {
  readonly timers = new Map<number, { fn: () => void; ms: number }>();
  #next = 1;
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#next++;
    this.timers.set(id, { fn, ms });
    return id;
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }
  now(): number { return 0; }
  delays(): number[] { return [...this.timers.values()].map((t) => t.ms); }
  fire(): void {
    const all = [...this.timers.values()];
    this.timers.clear();
    for (const t of all) t.fn();
  }
}

/** Reader whose reads wait until the test settles them, one by one. */
class ManualReader implements ScheduledTaskFileReader {
  reads = 0;
  repoints: string[] = [];
  started: number | null = null;
  readonly pending: ((read: ScheduledTasksRead | null) => void)[] = [];
  read(): Promise<ScheduledTasksRead | null> {
    this.reads += 1;
    return new Promise((resolve) => { this.pending.push(resolve); });
  }
  async settle(read: ScheduledTasksRead | null): Promise<void> {
    const resolve = this.pending.shift();
    if (resolve === undefined) throw new Error('no read in progress');
    resolve(read);
    for (let n = 0; n < 5; n += 1) await Promise.resolve();
  }
  repoint(id: string): void { this.repoints.push(id); }
  relocated(): void {}
  processStarted(atMs: number): boolean {
    if (atMs === this.started) return false;
    this.started = atMs;
    return true;
  }
  close(): void {}
}

function setup<R extends ScheduledTaskFileReader>(reader: R, pollMs = SCHEDULED_TASKS_POLL_MS): {
  state: ScheduledTaskPollState; deps: ScheduledTaskPollDeps; scheduler: ManualScheduler; reader: R;
  sent: string[][];
} {
  const scheduler = new ManualScheduler();
  const sent: string[][] = [];
  const state = createScheduledTaskPollState(reader, pollMs);
  const deps: ScheduledTaskPollDeps = {
    scheduler, disposed: () => false, emit: (list) => { sent.push(list.map((item) => item.id)); },
  };
  return { state, deps, scheduler, reader, sent };
}

/** Fires the timers and waits for a read of a real file to finish. */
async function fireAndRead(t: { scheduler: ManualScheduler; state: ScheduledTaskPollState }): Promise<void> {
  t.scheduler.fire();
  for (let n = 0; n < 200 && t.state.reading; n += 1) await new Promise((resolve) => setTimeout(resolve, 2));
}

describe('scheduled task poll over a real file', () => {
  let root = '';
  const file = (): string => join(root, projectSlug(CWD), `${SESSION}.jsonl`);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rarog-cron-poll-'));
    await mkdir(join(root, projectSlug(CWD)), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('cron created → a payout with the entry within 5 s of the signal; deleting the last → empty payout', async () => {
    await writeFile(file(), '');
    const t = setup(createScheduledTaskFileReader({ root, cwd: CWD, agentSessionId: SESSION }));
    scheduleScheduledTasks(t.state, t.deps, 0);
    await fireAndRead(t);
    // The first payout goes out also when empty.
    expect(t.sent).toEqual([[]]);

    await appendFile(file(), cronCreate(SESSION, 'a1b2c3d4'));
    scheduleScheduledTasks(t.state, t.deps);
    scheduleScheduledTasks(t.state, t.deps);
    expect(t.scheduler.delays()).toHaveLength(1);
    expect(Math.max(...t.scheduler.delays())).toBeLessThanOrEqual(5_000);
    await fireAndRead(t);
    expect(t.sent).toEqual([[], ['a1b2c3d4']]);

    await appendFile(file(), cronDelete(SESSION, 'a1b2c3d4', 5));
    scheduleScheduledTasks(t.state, t.deps);
    await fireAndRead(t);
    expect(t.sent).toEqual([[], ['a1b2c3d4'], []]);
  });

  it('a read error orders the next read by itself, without a signal; after the fix the list goes out', async () => {
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4'));
    await chmod(file(), 0o000);
    const t = setup(createScheduledTaskFileReader({ root, cwd: CWD, agentSessionId: SESSION }));
    scheduleScheduledTasks(t.state, t.deps, 0);
    await fireAndRead(t);
    expect(t.sent).toEqual([]);
    expect(t.scheduler.delays()).toEqual([SCHEDULED_TASKS_POLL_MS]);
    await chmod(file(), 0o600);
    await fireAndRead(t);
    expect(t.sent).toEqual([['a1b2c3d4']]);
    // A whole read keeps the slow re-read armed.
    expect(t.scheduler.delays()).toEqual([SCHEDULED_TASKS_POLL_MS]);
  });

  it('a file replaced by another inode of the same size is rebuilt without a signal', async () => {
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4'));
    const t = setup(createScheduledTaskFileReader({ root, cwd: CWD, agentSessionId: SESSION }));
    scheduleScheduledTasks(t.state, t.deps, 0);
    await fireAndRead(t);
    expect(t.sent).toEqual([['a1b2c3d4']]);

    // Written beside and renamed over: the old inode is alive during the swap, so the new one differs.
    await writeFile(`${file()}.next`, cronCreate(SESSION, 'e5f6a7b8'));
    const before = await stat(file());
    await rename(`${file()}.next`, file());
    const after = await stat(file());
    expect(after.size).toBe(before.size);
    expect(after.ino).not.toBe(before.ino);
    expect(t.scheduler.delays()).toEqual([SCHEDULED_TASKS_POLL_MS]);
    await fireAndRead(t);
    expect(t.sent).toEqual([['a1b2c3d4'], ['e5f6a7b8']]);
  });
});

describe('the follower\'s file for the reader', () => {
  const TIMING = { batchMs: 10, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };
  let root = '';
  let follower: JsonlFollower | null = null;
  const file = (): string => join(root, projectSlug(CWD), `${SESSION}.jsonl`);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rarog-cron-locate-'));
    await mkdir(join(root, projectSlug(CWD)), { recursive: true });
  });

  afterEach(async () => {
    follower?.close();
    follower = null;
    await rm(root, { recursive: true, force: true });
  });

  /** A real follower over the file; `events` collects what it emits. */
  function follow(): { follower: JsonlFollower; events: FollowEvent[] } {
    const created = createJsonlFollower({ cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING });
    follower = created;
    const events: FollowEvent[] = [];
    void (async () => {
      for await (const event of created.events) events.push(event);
    })();
    return { follower: created, events };
  }

  const settle = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
  };

  it('a known file truncated to zero is still the path, not "not known yet"', async () => {
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4'));
    const f = follow();
    await settle(() => (f.follower.transcriptOffset?.() ?? null) !== null, 'first read');
    expect(followerFileLocation(f.follower)).toBe(file());
    const from = f.events.length;
    await writeFile(file(), '');
    // The follower tells a truncation with a system message.
    await settle(() => f.events.slice(from).some((event) => event.type === 'message'), 'truncation seen');
    expect(f.follower.transcriptOffset?.()).toBeNull();
    expect(f.follower.hasTranscript()).toBe('yes');
    expect(followerFileLocation(f.follower)).toBe(file());
  });

  it('a known empty file is the path', async () => {
    await writeFile(file(), '');
    const f = follow();
    await settle(() => f.follower.hasTranscript() === 'yes', 'file found');
    expect(followerFileLocation(f.follower)).toBe(file());
  });
});

describe('scheduled task poll rules', () => {
  it('the same list again does not go out; a stale read repeats at once, a backlog after the pause', async () => {
    const t = setup(new ManualReader());
    scheduleScheduledTasks(t.state, t.deps, 0);
    t.scheduler.fire();
    await t.reader.settle(whole([task('a')]));
    scheduleScheduledTasks(t.state, t.deps);
    t.scheduler.fire();
    await t.reader.settle(whole([task('a')]));
    expect(t.sent).toEqual([['a']]);

    scheduleScheduledTasks(t.state, t.deps);
    t.scheduler.fire();
    await t.reader.settle(null);
    expect(t.scheduler.delays()).toEqual([0]);
    t.scheduler.fire();
    await t.reader.settle({ ...whole([]), more: true });
    expect(t.sent).toEqual([['a']]);
    expect(t.scheduler.delays()).toEqual([SCHEDULED_TASKS_BACKLOG_MS]);
  });

  it('a file not located yet pays out nothing and orders nothing; the next signal does', async () => {
    const t = setup(new ManualReader());
    scheduleScheduledTasks(t.state, t.deps, 0);
    t.scheduler.fire();
    await t.reader.settle({ ...whole([]), unknown: true });
    expect(t.sent).toEqual([]);
    expect(t.scheduler.delays()).toEqual([]);
    scheduleScheduledTasks(t.state, t.deps, 0);
    t.scheduler.fire();
    await t.reader.settle(whole([]));
    expect(t.sent).toEqual([[]]);
  });

  it('an order for now replaces a pending later timer', () => {
    const t = setup(new ManualReader());
    scheduleScheduledTasks(t.state, t.deps);
    scheduleScheduledTasks(t.state, t.deps, 0);
    expect(t.scheduler.delays()).toEqual([0]);
  });

  it('a late read of the previous conversation has no effect; the new one pays out its list, even an equal one', async () => {
    const t = setup(new ManualReader());
    scheduleScheduledTasks(t.state, t.deps, 0);
    t.scheduler.fire();
    await t.reader.settle(whole([task('a')]));
    scheduleScheduledTasks(t.state, t.deps);
    t.scheduler.fire();
    // `/clear` while the read runs: the read of the old file comes back stale.
    repointScheduledTasks(t.state, t.deps, 'new-session');
    expect(t.reader.repoints).toEqual(['new-session']);
    await t.reader.settle(null);
    expect(t.sent).toEqual([['a']]);
    t.scheduler.fire();
    // The new file starts with a carry of the same task: the list goes out again after the manager dropped it.
    await t.reader.settle(whole([task('a')]));
    expect(t.sent).toEqual([['a'], ['a']]);
  });

  it('the first `init` after a payout sends the list once more; later ones and an early one do not', async () => {
    const early = setup(new ManualReader());
    scheduledTasksAfterInit(early.state, early.deps);
    expect(early.scheduler.delays()).toEqual([]);

    const t = setup(new ManualReader());
    scheduleScheduledTasks(t.state, t.deps, 0);
    t.scheduler.fire();
    await t.reader.settle(whole([task('a')]));
    scheduledTasksAfterInit(t.state, t.deps);
    expect(t.scheduler.delays()).toEqual([0]);
    t.scheduler.fire();
    await t.reader.settle(whole([task('a')]));
    expect(t.sent).toEqual([['a'], ['a']]);
    scheduledTasksAfterInit(t.state, t.deps);
    // Only the slow re-read after the whole read, no read for now.
    expect(t.scheduler.delays()).toEqual([SCHEDULED_TASKS_POLL_MS]);
  });

  it('a new process start orders a read; a repeat does not', () => {
    const t = setup(new ManualReader());
    noteScheduledTasksProcessStart(t.state, t.deps, 1_000);
    expect(t.scheduler.delays()).toEqual([SCHEDULED_TASKS_POLL_MS]);
    t.scheduler.timers.clear();
    noteScheduledTasksProcessStart(t.state, t.deps, 1_000);
    expect(t.scheduler.delays()).toEqual([]);
  });

  it('without a reader or after stop nothing is scheduled', async () => {
    const none = setup(null as unknown as ManualReader);
    scheduleScheduledTasks(none.state, none.deps, 0);
    await readScheduledTasks(none.state, none.deps);
    expect(none.scheduler.delays()).toEqual([]);

    const t = setup(new ManualReader());
    scheduleScheduledTasks(t.state, t.deps);
    stopScheduledTasks(t.state, t.scheduler);
    expect(t.scheduler.delays()).toEqual([]);
  });
});
