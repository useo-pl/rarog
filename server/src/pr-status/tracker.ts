/**
 * PR status tracker: the URL → state map of the PRs that current sessions list, kept fresh by a state source on a
 * fixed rhythm, only while at least one client is connected. It does not touch sessions or send frames: the caller
 * reads `stateOf` when it builds a session summary and gets the URLs whose state changed through `onChange`.
 *
 * Rhythm: a new URL is asked {@link NEW_URL_DELAY_MS} after it first appears (configurable); then `open`, `draft`
 * and `closed` every {@link OPEN_REFRESH_MS}, no state every {@link UNKNOWN_REFRESH_MS}; `merged` is final. A connecting
 * client gets everything overdue at once. One read at a time, at most `PR_BATCH_MAX` PRs per read.
 *
 * Failures: `missing-gh` turns the tracker off until restart; a rate limit pauses every read until `resetAt`, at most
 * {@link RATE_LIMIT_PAUSE_MAX_MS}; any other failure pauses every read (new URLs too) for {@link FAILURE_PAUSE_MS}.
 * A known state stays through a failure. Log lines name the failure category and the PR count, nothing else.
 * Nothing here throws; timers are `unref`.
 */
import type { PullRequestState } from '@rarog/shared';
import type { Scheduler, TimerHandle } from '../drivers/runtime.ts';
import { PR_BATCH_MAX } from './gh.ts';
import { parsePrUrl } from './source.ts';
import type { PrReadResult, PrRef, PrStateSource } from './source.ts';

export const NEW_URL_DELAY_MS = 5_000;
export const OPEN_REFRESH_MS = 5 * 60_000;
export const UNKNOWN_REFRESH_MS = 30 * 60_000;
export const FAILURE_PAUSE_MS = 30 * 60_000;
export const RATE_LIMIT_PAUSE_MAX_MS = 60 * 60_000;
const RATE_LIMIT_PAUSE_MIN_MS = 60_000;

export interface PrStatusTrackerOptions {
  readonly source: PrStateSource;
  /** URLs whose state changed after a read (also from or to no state). Called after the map is updated. */
  readonly onChange: (urls: ReadonlySet<string>) => void;
  /** Timers and wall-clock time (`resetAt` of GitHub is compared with `now()`). Default: real timers, `unref`. */
  readonly scheduler?: Scheduler;
  readonly log?: (line: string) => void;
  /**
   * Delay of the first read of a new URL. Default {@link NEW_URL_DELAY_MS}; a source without cost (the fixed map of
   * the demo) may take `0`, so the state comes with the list.
   */
  readonly newUrlDelayMs?: number;
}

export interface PrStatusTracker {
  /** Last read state of a tracked URL; `undefined` = unknown or not tracked. */
  stateOf(url: string): PullRequestState | undefined;
  /** The whole current PR list of a session (replaces the previous one); addresses outside the grammar are ignored. */
  setSessionUrls(sessionId: string, urls: Iterable<string>): void;
  /** Forgets a session; URLs no other session lists leave the map. */
  dropSession(sessionId: string): void;
  /** Whether at least one client is connected; reads run only while it is `true`. */
  setClientConnected(connected: boolean): void;
  /** Stops timers, aborts the read in flight; later calls are no-ops. */
  close(): void;
}

interface Entry {
  readonly ref: PrRef;
  state: PullRequestState | undefined;
  /** When the next read is due (epoch ms); `Infinity` for `merged`. */
  dueAt: number;
}

const unrefScheduler: Scheduler = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
  now: () => Date.now(),
};

const plural = (count: number): string => `${count} PR${count === 1 ? '' : 's'}`;
const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

export function createPrStatusTracker(opts: PrStatusTrackerOptions): PrStatusTracker {
  const scheduler = opts.scheduler ?? unrefScheduler;
  const log = opts.log ?? ((line: string): void => { console.log(line); });
  const newUrlDelayMs = Math.max(0, opts.newUrlDelayMs ?? NEW_URL_DELAY_MS);
  const entries = new Map<string, Entry>();
  const sessions = new Map<string, ReadonlySet<string>>();
  let connected = false;
  let disabled = false;
  let closed = false;
  let pausedUntil = 0;
  let timer: TimerHandle | null = null;
  let reading: AbortController | null = null;

  const safeLog = (line: string): void => {
    try {
      log(line);
    } catch {
      // A broken logger must not stop the rhythm.
    }
  };

  const clearTimer = (): void => {
    if (timer === null) return;
    scheduler.clearTimeout(timer);
    timer = null;
  };

  const schedule = (): void => {
    clearTimer();
    if (closed || disabled || !connected || reading !== null) return;
    let next = Infinity;
    for (const entry of entries.values()) if (entry.dueAt < next) next = entry.dueAt;
    if (next === Infinity) return;
    const at = Math.max(next, pausedUntil);
    timer = scheduler.setTimeout(run, Math.max(0, at - scheduler.now()));
  };

  const pause = (ms: number): void => {
    pausedUntil = scheduler.now() + ms;
  };

  const apply = (batch: readonly Entry[], result: PrReadResult): void => {
    if (!result.ok) {
      if (result.failure === 'missing-gh') {
        disabled = true;
        safeLog('pr-status: gh not found in the known directories, status off until restart');
        return;
      }
      const ms = result.failure === 'rate-limited'
        ? rateLimitPause(result.resetAt)
        : FAILURE_PAUSE_MS;
      pause(ms);
      const count = plural(batch.length);
      safeLog(`pr-status: gh call failed (${result.failure}) for ${count}, paused for ${minutes(ms)} min`);
      return;
    }
    const now = scheduler.now();
    const changed = new Set<string>();
    for (const entry of batch) {
      if (entries.get(entry.ref.url) !== entry) continue;
      const state = result.states.get(entry.ref.url) ?? undefined;
      if (state !== entry.state) changed.add(entry.ref.url);
      entry.state = state;
      if (state === 'merged') entry.dueAt = Infinity;
      else entry.dueAt = now + (state === undefined ? UNKNOWN_REFRESH_MS : OPEN_REFRESH_MS);
    }
    if (result.limitReached !== undefined) {
      const ms = rateLimitPause(result.limitReached.resetAt);
      pause(ms);
      safeLog(`pr-status: GitHub rate limit reached, paused for ${minutes(ms)} min`);
    }
    if (changed.size === 0) return;
    try {
      opts.onChange(changed);
    } catch {
      // The caller's failure must not stop the rhythm.
    }
  };

  /** Until `resetAt`, at least a minute (a stale `resetAt` must not spin) and at most the ceiling. */
  const rateLimitPause = (resetAt: number | null): number => {
    if (resetAt === null) return RATE_LIMIT_PAUSE_MAX_MS;
    return Math.min(RATE_LIMIT_PAUSE_MAX_MS, Math.max(RATE_LIMIT_PAUSE_MIN_MS, resetAt - scheduler.now()));
  };

  function run(): void {
    timer = null;
    if (closed || disabled || !connected || reading !== null) return;
    const now = scheduler.now();
    if (now < pausedUntil) {
      schedule();
      return;
    }
    const batch = [...entries.values()]
      .filter((entry) => entry.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, PR_BATCH_MAX);
    if (batch.length === 0) {
      schedule();
      return;
    }
    const controller = new AbortController();
    reading = controller;
    let read: Promise<PrReadResult>;
    try {
      read = opts.source.read(batch.map((entry) => entry.ref), controller.signal);
    } catch {
      read = Promise.resolve({ ok: false, failure: 'error' });
    }
    read
      .catch((): PrReadResult => ({ ok: false, failure: 'error' }))
      .then((result) => {
        reading = null;
        if (!closed) apply(batch, result);
      })
      .catch(() => {
        reading = null;
      })
      .finally(() => {
        if (!closed) schedule();
      });
  }

  const sync = (): void => {
    const wanted = new Set<string>();
    for (const urls of sessions.values()) for (const url of urls) wanted.add(url);
    for (const url of entries.keys()) if (!wanted.has(url)) entries.delete(url);
    const now = scheduler.now();
    for (const url of wanted) {
      if (entries.has(url)) continue;
      const ref = parsePrUrl(url);
      if (ref !== null) entries.set(url, { ref, state: undefined, dueAt: now + newUrlDelayMs });
    }
    schedule();
  };

  return {
    stateOf: (url) => entries.get(url)?.state,
    setSessionUrls: (sessionId, urls) => {
      if (closed) return;
      try {
        sessions.set(sessionId, new Set(urls));
        sync();
      } catch {
        // Keeps the previous list; nothing to undo.
      }
    },
    dropSession: (sessionId) => {
      if (closed) return;
      if (sessions.delete(sessionId)) sync();
    },
    setClientConnected: (value) => {
      if (closed) return;
      connected = value;
      schedule();
    },
    close: () => {
      if (closed) return;
      closed = true;
      clearTimer();
      reading?.abort();
      reading = null;
    },
  };
}
