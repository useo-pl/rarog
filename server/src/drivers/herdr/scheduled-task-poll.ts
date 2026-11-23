/**
 * Refreshing the session's scheduled task (cron) list, a module of the herdr driver.
 *
 * The module holds the explicit read state (the main file reader, timer, read in progress, next read ordered,
 * signature of the sent list) and functions over it: ordering a read, the read with the list payout, and the
 * reader's life events (another conversation, a new address, the process start, the driver's first `init`, stop).
 * Creating the reader and the signals that order a read stay in the facade `drivers/herdr-driver.ts`.
 *
 * Unlike pull requests, a task can go away (deleted, run once, gone with the process), so the first payout after the
 * attach and after a conversation change goes out also when empty: it replaces the list the card kept from before.
 * Only a read that reached the end of a located file without an error pays out; a failed read orders the next one
 * itself, and a file not located yet waits for the follower's next signal. After a whole read the next one comes in
 * the signal delay anyway: a file replaced by another of the same size gives the follower no new content to signal.
 */
import type { SessionScheduledTask } from '@rarog/shared';
import type { Scheduler, TimerHandle } from '../runtime.ts';
import type { JsonlFollower } from '../../herdr/jsonl-follow.ts';
import { SCHEDULED_TASKS_BACKLOG_MS } from '../../herdr/background/index.ts';
import type { ScheduledTaskFileReader } from '../../herdr/background/index.ts';

export interface ScheduledTaskPollState {
  /** The main file reader; `null` = pane out of scope. */
  readonly reader: ScheduledTaskFileReader | null;
  /** Delay of a read after a signal, and of the retry after a failed read. */
  readonly pollMs: number;
  timer: TimerHandle | null;
  /** A read is running; a signal meanwhile orders the next one (`again`). */
  reading: boolean;
  again: boolean;
  /** Signature of the last list sent; `null` = nothing sent since the attach or the last re-arm. */
  sent: string | null;
  /** The driver has emitted an `init` since the attach. */
  initSeen: boolean;
}

/** Contact with the facade, built at every call, like the pull request poll's. */
export interface ScheduledTaskPollDeps {
  readonly scheduler: Scheduler;
  readonly disposed: () => boolean;
  readonly emit: (scheduledTasks: readonly SessionScheduledTask[]) => void;
}

export function createScheduledTaskPollState(
  reader: ScheduledTaskFileReader | null, pollMs: number,
): ScheduledTaskPollState {
  return { reader, pollMs, timer: null, reading: false, again: false, sent: null, initSeen: false };
}

/**
 * Orders a read in `delayMs`. Signals before the timer fires fold into that read; a signal during a read orders the
 * next one after it. An order for right now (`0`) replaces a pending later timer.
 */
export function scheduleScheduledTasks(
  state: ScheduledTaskPollState, deps: ScheduledTaskPollDeps, delayMs = state.pollMs,
): void {
  if (deps.disposed() || state.reader === null) return;
  if (state.reading) {
    state.again = true;
    return;
  }
  if (state.timer !== null) {
    if (delayMs !== 0) return;
    deps.scheduler.clearTimeout(state.timer);
  }
  state.timer = deps.scheduler.setTimeout(() => {
    state.timer = null;
    void readScheduledTasks(state, deps);
  }, delayMs);
}

/**
 * One read and the payout of the list when it differs from the sent one (the first always). A stale read repeats at
 * once, a backlog after a short pause, a failed read after the signal delay; none of them pays out, and neither does
 * a read of a file not located yet, which orders nothing. A whole read orders the next one after the signal delay.
 */
export async function readScheduledTasks(state: ScheduledTaskPollState, deps: ScheduledTaskPollDeps): Promise<void> {
  const reader = state.reader;
  if (deps.disposed() || reader === null) return;
  state.reading = true;
  state.again = false;
  let retryMs: number | null = null;
  try {
    const read = await reader.read();
    if (deps.disposed()) return;
    if (read === null) retryMs = 0;
    else if (read.more) retryMs = SCHEDULED_TASKS_BACKLOG_MS;
    else if (read.failed) retryMs = state.pollMs;
    else if (!read.unknown) {
      retryMs = state.pollMs;
      const signature = JSON.stringify(read.tasks);
      if (signature !== state.sent) {
        state.sent = signature;
        deps.emit(read.tasks);
      }
    }
  } finally {
    state.reading = false;
    const again = state.again;
    state.again = false;
    if (retryMs !== null) scheduleScheduledTasks(state, deps, retryMs);
    else if (again) scheduleScheduledTasks(state, deps);
  }
}

/**
 * Another conversation in the pane (`/clear`, `/resume`): the reader starts over and the first list of the new
 * conversation goes out also when empty. The facade emits the `init` of the new conversation itself, before this.
 */
export function repointScheduledTasks(
  state: ScheduledTaskPollState, deps: ScheduledTaskPollDeps, agentSessionId: string,
): void {
  state.reader?.repoint(agentSessionId);
  state.sent = null;
  state.initSeen = true;
  scheduleScheduledTasks(state, deps, 0);
}

/** The same file under a new address: the read goes on from its offset. */
export function relocateScheduledTasks(state: ScheduledTaskPollState, deps: ScheduledTaskPollDeps): void {
  state.reader?.relocated();
  scheduleScheduledTasks(state, deps, 0);
}

/** The start of the current Claude Code process; a new value can drop one-shot tasks without file growth. */
export function noteScheduledTasksProcessStart(
  state: ScheduledTaskPollState, deps: ScheduledTaskPollDeps, atMs: number,
): void {
  if (state.reader?.processStarted(atMs) === true) scheduleScheduledTasks(state, deps);
}

/**
 * The driver emitted an `init`. The first one after a driver swap to another conversation can come after the first
 * list, and the manager drops the list on a conversation change: the list goes out once more after it.
 */
export function scheduledTasksAfterInit(state: ScheduledTaskPollState, deps: ScheduledTaskPollDeps): void {
  if (state.initSeen) return;
  state.initSeen = true;
  if (state.sent === null) return;
  state.sent = null;
  scheduleScheduledTasks(state, deps, 0);
}

/**
 * Where the follower's main file is, for the reader's `locate`: the path once the follower found it (also an empty
 * file or one truncated to zero), `false` when it looked and found no file, `null` while it does not know (its next
 * event orders a read).
 */
export function followerFileLocation(
  follower: Pick<JsonlFollower, 'hasTranscript' | 'transcriptOffset' | 'transcriptPath'> | null,
): string | false | null {
  if (follower === null) return false;
  const file = follower.transcriptPath?.() ?? follower.transcriptOffset?.()?.file;
  if (file !== undefined && file !== null) return file;
  return follower.hasTranscript() === 'no' ? false : null;
}

/** Driver dispose: no timer and no reader after it. */
export function stopScheduledTasks(state: ScheduledTaskPollState, scheduler: Scheduler): void {
  if (state.timer !== null) {
    scheduler.clearTimeout(state.timer);
    state.timer = null;
  }
  state.reader?.close();
}
