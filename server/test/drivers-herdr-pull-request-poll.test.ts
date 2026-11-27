/**
 * Pull request list refresh of the herdr driver (`drivers/herdr/pull-request-poll.ts`): signals that arrive
 * before the timer fires fold into one read, a signal during a read orders the next one, a stale read repeats at
 * once, a backlog repeats after `PULL_REQUESTS_BACKLOG_MS`, and only changed links (the set or the window) go out.
 *
 * The facade wiring (which events order a read) is covered end to end in `herdr-pull-requests.test.ts`.
 */
import type { SessionPullRequest } from '@rarog/shared';
import { describe, expect, it } from 'vitest';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import {
  createPullRequestPollState, readPullRequests, schedulePullRequests,
} from '../src/drivers/herdr/pull-request-poll.ts';
import type { PullRequestPollDeps, PullRequestPollState } from '../src/drivers/herdr/pull-request-poll.ts';
import { PULL_REQUESTS_BACKLOG_MS } from '../src/herdr/background/index.ts';
import type { PullRequestFilesReader, PullRequestRead } from '../src/herdr/background/pull-request-files.ts';
import type { PullRequestLinks } from '../src/herdr/background/pull-requests.ts';

const POLL_MS = 50;

const pr = (n: number): SessionPullRequest => ({
  url: `https://github.com/example/atlas/pull/${String(n)}`, repo: 'example/atlas', number: n,
  createdAt: '2026-11-10T10:00:00.000Z',
});
const START = '2026-11-10T09:00:00.000Z';
/** One read with the linked set `linked` and the window `windowStart`. */
const read = (linked: SessionPullRequest[], backlog = false, windowStart: string | null = START): PullRequestRead => ({
  links: { linked, windowStart }, backlog,
});

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
    const all = [...this.timers.entries()];
    this.timers.clear();
    for (const [, t] of all) t.fn();
  }
}

/** Reader whose reads wait until the test settles them, one by one. */
class ManualReader implements PullRequestFilesReader {
  reads = 0;
  readonly pending: ((read: PullRequestRead | null) => void)[] = [];
  read(): Promise<PullRequestRead | null> {
    this.reads += 1;
    return new Promise((resolve) => { this.pending.push(resolve); });
  }
  async settle(read: PullRequestRead | null): Promise<void> {
    const resolve = this.pending.shift();
    if (resolve === undefined) throw new Error('no read in progress');
    resolve(read);
    for (let n = 0; n < 5; n += 1) await Promise.resolve();
  }
  repoint(): void {}
  relocated(): void {}
  close(): void {}
}

function setup(reader: ManualReader | null = new ManualReader()): {
  state: PullRequestPollState; deps: PullRequestPollDeps; scheduler: ManualScheduler; reader: ManualReader | null;
  sent: PullRequestLinks[]; dispose: () => void;
} {
  const scheduler = new ManualScheduler();
  const sent: PullRequestLinks[] = [];
  let disposed = false;
  const state = createPullRequestPollState(reader, POLL_MS);
  const deps: PullRequestPollDeps = {
    scheduler, disposed: () => disposed, emit: (list) => { sent.push(list); },
  };
  return { state, deps, scheduler, reader, sent, dispose: () => { disposed = true; } };
}

describe('pull request poll of the herdr driver', () => {
  it('signals before the timer fires fold into one read with the signal delay', () => {
    const t = setup();
    schedulePullRequests(t.state, t.deps);
    schedulePullRequests(t.state, t.deps);
    schedulePullRequests(t.state, t.deps, 0);
    expect(t.scheduler.delays()).toEqual([POLL_MS]);
    t.scheduler.fire();
    expect(t.reader?.reads).toBe(1);
    expect(t.state.prTimer).toBeNull();
  });

  it('the empty list after attach does not go out; a changed list does, the same list again does not', async () => {
    const t = setup();
    const reader = t.reader as ManualReader;
    schedulePullRequests(t.state, t.deps, 0);
    t.scheduler.fire();
    await reader.settle(read([]));
    expect(t.sent).toEqual([]);

    schedulePullRequests(t.state, t.deps);
    t.scheduler.fire();
    await reader.settle(read([pr(1)]));
    expect(t.sent).toEqual([read([pr(1)]).links]);

    schedulePullRequests(t.state, t.deps);
    t.scheduler.fire();
    await reader.settle(read([pr(1)]));
    expect(t.sent).toEqual([read([pr(1)]).links]);
    expect(t.scheduler.delays()).toEqual([]);
  });

  it('only the set or only the window changes → a new payout', async () => {
    const t = setup();
    const reader = t.reader as ManualReader;
    const next = async (linked: SessionPullRequest[], windowStart: string | null): Promise<void> => {
      schedulePullRequests(t.state, t.deps, 0);
      t.scheduler.fire();
      await reader.settle(read(linked, false, windowStart));
    };
    await next([pr(1)], START);
    await next([pr(1)], '2026-11-10T08:00:00.000Z');
    await next([pr(1), pr(2)], '2026-11-10T08:00:00.000Z');
    await next([pr(1), pr(2)], '2026-11-10T08:00:00.000Z');
    expect(t.sent.map((links) => [links.linked.length, links.windowStart])).toEqual([
      [1, START], [1, '2026-11-10T08:00:00.000Z'], [2, '2026-11-10T08:00:00.000Z'],
    ]);
  });

  it('a window without links after attach does not go out', async () => {
    const t = setup();
    schedulePullRequests(t.state, t.deps, 0);
    t.scheduler.fire();
    await (t.reader as ManualReader).settle(read([], false, START));
    expect(t.sent).toEqual([]);
  });

  it('a signal during a read orders the next read after it, with the signal delay', async () => {
    const t = setup();
    const reader = t.reader as ManualReader;
    schedulePullRequests(t.state, t.deps, 0);
    t.scheduler.fire();
    expect(t.state.prReading).toBe(true);
    schedulePullRequests(t.state, t.deps, 0);
    expect(t.state.prAgain).toBe(true);
    expect(t.scheduler.delays()).toEqual([]);
    await reader.settle(read([]));
    expect(t.state.prReading).toBe(false);
    expect(t.state.prAgain).toBe(false);
    expect(t.scheduler.delays()).toEqual([POLL_MS]);
  });

  it('a stale read (`null`) repeats at once; a backlog repeats after the backlog delay', async () => {
    const t = setup();
    const reader = t.reader as ManualReader;
    schedulePullRequests(t.state, t.deps, 0);
    t.scheduler.fire();
    await reader.settle(null);
    expect(t.sent).toEqual([]);
    expect(t.scheduler.delays()).toEqual([0]);

    t.scheduler.fire();
    await reader.settle(read([pr(2)], true));
    expect(t.sent).toEqual([read([pr(2)]).links]);
    expect(t.scheduler.delays()).toEqual([PULL_REQUESTS_BACKLOG_MS]);
  });

  it('without a reader (pane out of scope) or after dispose nothing is scheduled or read', async () => {
    const none = setup(null);
    schedulePullRequests(none.state, none.deps, 0);
    await readPullRequests(none.state, none.deps);
    expect(none.scheduler.delays()).toEqual([]);

    const t = setup();
    t.dispose();
    schedulePullRequests(t.state, t.deps, 0);
    await readPullRequests(t.state, t.deps);
    expect(t.scheduler.delays()).toEqual([]);
    expect(t.reader?.reads).toBe(0);
  });

  it('dispose during a read drops its list', async () => {
    const t = setup();
    const reader = t.reader as ManualReader;
    schedulePullRequests(t.state, t.deps, 0);
    t.scheduler.fire();
    t.dispose();
    await reader.settle(read([pr(3)]));
    expect(t.sent).toEqual([]);
    expect(t.state.prReading).toBe(false);
  });
});
