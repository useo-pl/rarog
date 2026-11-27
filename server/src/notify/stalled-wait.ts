/**
 * Stalled wait alarm: one `stalled` push for each wait of a subagent on its own command that crossed into `stuck`.
 * The edge comes from `stuckWaits` in `herdr/background/work.ts`, which the session's list swap
 * (`sessions/conversation-lists.ts`) asks; this module only delivers. It sends straight through the APNs sink, next to
 * the banner scheduler (`notify/index.ts`) and never through it, so the alarm neither replaces a pending decision
 * banner nor is disarmed by a state change. It never reads a task list or the command; memory lives in the process.
 *
 * Rules (`docs/subagent-long-wait.md`, "The alarm cycle"):
 *
 * - A new edge sends at once, or is skipped with one log line: the owner is watching Rarog, the session works in a
 *   temporary directory, or this wait already had its alarm. Several waits on the edge in one swap give one push,
 *   named after the first; the outcome counts for every wait in it.
 * - After `failed` or `no-receiver` the next tries go {@link STALLED_WAIT_RETRY_MS} after the previous outcome, then
 *   every 15 min, while the wait stays `stuck` and less than {@link STALLED_WAIT_WINDOW_MS} has passed since its first
 *   edge; then one log line. Before each retry the owner's presence is checked again.
 * - A wait keeps its record (first edge, outcome) while its key is on the session's list in any stage, so a Mac clock
 *   set back (`stuck` → `long` → `stuck`) neither repeats the alarm nor renews its window. A wait that leaves `stuck`
 *   stops its tries; an outcome that comes back afterwards marks nothing.
 * - `forget` drops the session (removed, another conversation, driver detached); `close` stops every timer.
 * - Never throws.
 */
import type { StuckWait, StuckWaits } from '../herdr/background/work.ts';
import { buildStalledContent } from './content.ts';
import type { PushContent, SendOutcome } from './content.ts';
import { PUSH_QUIET_LOG } from './index.ts';
import type { Presence } from './presence.ts';

/** Gaps before the 2nd, 3rd and 4th try after `failed` or `no-receiver`; then every last value. */
export const STALLED_WAIT_RETRY_MS = [60_000, 300_000, 900_000] as const;

/** How long after the first edge of a wait its alarm may still go out (the push's own lifetime in APNs). */
export const STALLED_WAIT_WINDOW_MS = 3_600_000;

/** Facts of the session for the push and the skip rules, assembled from the session in `bootstrap/push.ts`. */
export interface StalledWaitFacts {
  readonly sessionId: string;
  readonly project: string;
  readonly label?: string;
  readonly termId?: string;
  /** The session works in a temporary directory (`sessions/test-session.ts`): no alarm. */
  readonly testSession: boolean;
}

/** Timers and clock; the default is the process timers (unref'd) and a monotonic clock. */
export interface StalledWaitScheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface StalledWaitAlertOptions {
  /** Push to the devices (`ApnsSink.send`). */
  readonly send: (content: PushContent) => Promise<SendOutcome>;
  readonly presence: Pick<Presence, 'active'>;
  /** Icon badge at send time, the same count as the scheduler's banners. */
  readonly badge?: () => number;
  readonly log: (line: string) => void;
  readonly scheduler?: StalledWaitScheduler;
}

export interface StalledWaitAlert {
  /**
   * Called on every list swap of the session. New edges are sent, or skipped with one log line. Pending tries of
   * waits no longer `stuck` stop; the record of a wait lives while its key is in `waitKeys`.
   */
  update(facts: StalledWaitFacts, waits: StuckWaits): void;
  /** The session is gone, changed its conversation or lost its driver: every record of the session is dropped. */
  forget(sessionId: string): void;
  /** Stops every timer; a send in flight finishes without effect. */
  close(): Promise<void>;
}

/** One wait of a session: the instant of its first edge and where its alarm stands. */
interface Wait {
  readonly edgeAt: number;
  /** `pending`: in a batch; `settled`: delivered, skipped or given up; `idle`: left `stuck` before an outcome. */
  state: 'pending' | 'settled' | 'idle';
}

/** One push and its tries: the waits it speaks for (key → description), in list order. */
interface Batch {
  readonly keys: Map<string, string | undefined>;
  tries: number;
  timer: unknown;
}

interface Entry {
  facts: StalledWaitFacts;
  readonly waits: Map<string, Wait>;
  readonly batches: Set<Batch>;
}

const defaultScheduler: StalledWaitScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (handle) => { clearTimeout(handle as NodeJS.Timeout); },
  now: () => performance.now(),
};

/** Gap after the try number `tries` (1-based) that did not deliver. */
const retryGap = (tries: number): number =>
  STALLED_WAIT_RETRY_MS[Math.min(tries, STALLED_WAIT_RETRY_MS.length) - 1] ?? STALLED_WAIT_RETRY_MS[2];

const OUTCOME_LABEL: Readonly<Record<SendOutcome, string>> = {
  delivered: 'SENT',
  failed: 'FAILED',
  'no-receiver': 'NO RECEIVER',
};

export function createStalledWaitAlert(options: StalledWaitAlertOptions): StalledWaitAlert {
  const scheduler = options.scheduler ?? defaultScheduler;
  const sessions = new Map<string, Entry>();
  let closed = false;

  const quiet = (entry: Entry, why: string): void => {
    options.log(`${PUSH_QUIET_LOG} ${entry.facts.project} (stalled, ${why})`);
  };

  const drop = (entry: Entry, batch: Batch): void => {
    if (batch.timer !== undefined) scheduler.clearTimeout(batch.timer);
    batch.timer = undefined;
    entry.batches.delete(batch);
  };

  /** Ends a batch for good: its waits never alarm again while they stay on the list. */
  const settle = (entry: Entry, batch: Batch): void => {
    for (const key of batch.keys.keys()) {
      const wait = entry.waits.get(key);
      if (wait !== undefined) wait.state = 'settled';
    }
    drop(entry, batch);
  };

  /**
   * Settles the waits of a batch whose own window (one hour from the first edge) is over at `at`; the other waits
   * keep their tries. False when no wait is left and the batch is gone.
   */
  const expire = (entry: Entry, batch: Batch, at: number): boolean => {
    for (const key of [...batch.keys.keys()]) {
      const wait = entry.waits.get(key);
      if (wait !== undefined && at < wait.edgeAt + STALLED_WAIT_WINDOW_MS) continue;
      if (wait !== undefined) wait.state = 'settled';
      batch.keys.delete(key);
    }
    if (batch.keys.size > 0) return true;
    options.log(`push: stalled for ${entry.facts.project} — not delivered within 1 h, no more tries`);
    drop(entry, batch);
    return false;
  };

  const attempt = async (entry: Entry, batch: Batch): Promise<void> => {
    batch.timer = undefined;
    if (closed || !entry.batches.has(batch)) return;
    // A timer that fires late (the process was suspended) must not send after the window.
    if (batch.tries > 0 && !expire(entry, batch, scheduler.now())) return;
    if (batch.tries > 0 && options.presence.active()) {
      quiet(entry, 'you are watching Rarog, retry dropped');
      settle(entry, batch);
      return;
    }
    const [agent] = batch.keys.values();
    const { facts } = entry;
    const badge = options.badge?.();
    const content = buildStalledContent({
      project: facts.project, sessionId: facts.sessionId,
      ...(facts.label === undefined ? {} : { label: facts.label }),
      ...(facts.termId === undefined ? {} : { termId: facts.termId }),
      ...(agent === undefined ? {} : { agent }),
      ...(badge === undefined ? {} : { badge }),
    });
    let outcome: SendOutcome;
    try {
      outcome = await options.send(content);
    } catch {
      outcome = 'failed';
    }
    batch.tries += 1;
    // Forgotten, closed or every wait left `stuck` during the send: the outcome marks nothing.
    if (closed || !entry.batches.has(batch)) return;
    if (outcome !== 'no-receiver' || batch.tries === 1) {
      options.log(`push: stalled for ${facts.project} — APNs: ${OUTCOME_LABEL[outcome]} (try ${String(batch.tries)})`);
    }
    if (outcome === 'delivered') {
      settle(entry, batch);
      return;
    }
    // The gap counts from the outcome: a slow send must not shorten the wait before the next try.
    const gap = retryGap(batch.tries);
    if (!expire(entry, batch, scheduler.now() + gap)) return;
    batch.timer = scheduler.setTimeout(() => { run(entry, batch); }, gap);
  };

  const run = (entry: Entry, batch: Batch): void => {
    attempt(entry, batch).catch((err: unknown) => {
      options.log(`push: stalled — internal error ${(err as Error).message}`);
    });
  };

  /** New edges of one swap: the waits that may still alarm, each with its first edge. */
  const candidates = (entry: Entry, newly: readonly StuckWait[]): StuckWait[] => {
    const now = scheduler.now();
    const fresh: StuckWait[] = [];
    let already = false;
    let late = false;
    for (const edge of newly) {
      const wait = entry.waits.get(edge.key);
      if (wait === undefined) {
        entry.waits.set(edge.key, { edgeAt: now, state: 'pending' });
        fresh.push(edge);
      } else if (wait.state === 'idle' && now < wait.edgeAt + STALLED_WAIT_WINDOW_MS) {
        wait.state = 'pending';
        fresh.push(edge);
      } else if (wait.state === 'idle') {
        wait.state = 'settled';
        late = true;
      } else {
        already = true;
      }
    }
    if (already) quiet(entry, 'this wait already had its alarm');
    if (late) quiet(entry, 'over 1 h since the first edge of this wait');
    return fresh;
  };

  const update = (facts: StalledWaitFacts, waits: StuckWaits): void => {
    const entry = sessions.get(facts.sessionId) ?? { facts, waits: new Map(), batches: new Set() };
    sessions.set(facts.sessionId, entry);
    entry.facts = facts;
    const listed = new Set(waits.waitKeys);
    const stuck = new Set(waits.stuckKeys);
    for (const key of [...entry.waits.keys()]) if (!listed.has(key)) entry.waits.delete(key);
    for (const batch of [...entry.batches]) {
      for (const key of [...batch.keys.keys()]) {
        if (stuck.has(key)) continue;
        batch.keys.delete(key);
        const wait = entry.waits.get(key);
        if (wait?.state === 'pending') wait.state = 'idle';
      }
      if (batch.keys.size === 0) drop(entry, batch);
    }
    const fresh = candidates(entry, waits.newly);
    if (fresh.length > 0) {
      const batch: Batch = {
        keys: new Map(fresh.map((edge) => [edge.key, edge.description])),
        tries: 0,
        timer: undefined,
      };
      entry.batches.add(batch);
      if (facts.testSession) {
        quiet(entry, 'test session in a temporary directory');
        settle(entry, batch);
      } else if (options.presence.active()) {
        quiet(entry, 'you are watching Rarog');
        settle(entry, batch);
      } else {
        run(entry, batch);
      }
    }
    if (entry.waits.size === 0 && entry.batches.size === 0) sessions.delete(facts.sessionId);
  };

  return {
    update(facts, waits) {
      if (closed) return;
      try {
        update(facts, waits);
      } catch (err) {
        options.log(`push: stalled — internal error ${(err as Error).message}`);
      }
    },
    forget(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) return;
      for (const batch of [...entry.batches]) drop(entry, batch);
      sessions.delete(sessionId);
    },
    close() {
      closed = true;
      for (const entry of sessions.values()) for (const batch of [...entry.batches]) drop(entry, batch);
      sessions.clear();
      return Promise.resolve();
    },
  };
}
