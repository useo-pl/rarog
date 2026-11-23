/**
 * Weekly-limit signal: a `weekly-limit` push at least once for every weekly window of the plan that reached
 * {@link WEEKLY_LIMIT_ALERT_PERCENT} in a fresh status line reading, and never again for that window. It evaluates on
 * every read of the limits poller (`live-activity-limits.ts`, `onPoll`), without a timer or a scan of its own, and
 * sends straight through `ApnsSink.send`, past the session scheduler and presence (like `version-changed`).
 * It does not read the status line, the account or the Anthropic API, and it lives only with the APNs channel.
 *
 * Rules:
 *
 * - A window qualifies at ≥ 97 %, with a reset in the future, without a key in the file and with a reading at most
 *   `CLI_USAGE_STALE_MS` old. Freshness is checked only then: a queued window retries without the freshness gate and
 *   without the threshold, so a reading that grew stale during the retries does not stop it.
 * - The first try goes at once; after `failed` or `no-receiver` the next ones not earlier than
 *   {@link WEEKLY_LIMIT_RETRY_MS} after the previous one, then every 15 min, until `delivered` or until the reset.
 * - The key (the reset instant) goes to `<dataDir>/weekly-limit-alerts.json` after `delivered`. A failed write keeps
 *   the key in memory and is retried on every reading without a second send. A crash between the 200 and the write
 *   can repeat the push after a restart: accepted.
 * - A file that cannot be read or has another shape: one line, an empty set, the file written again at the next
 *   `delivered`. The queue lives in memory only: after a restart a window qualifies again.
 * - Never throws. Evaluations, sends and writes go on one chain, in order.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readRegularFile } from '../safe-read.ts';
import { CLI_USAGE_STALE_MS } from '../usage.ts';
import { buildWeeklyLimitContent } from './content.ts';
import type { PushContent, SendOutcome } from './content.ts';
import type { WeeklyLimitReading } from './live-activity-limits.ts';

/** The threshold, compared with the contract percent (the rounding of the tile and the list footer). */
export const WEEKLY_LIMIT_ALERT_PERCENT = 97;

/** Name of the state file in `dataDir`. */
export const WEEKLY_LIMIT_ALERTS_FILENAME = 'weekly-limit-alerts.json';

/** Gaps before the 2nd, 3rd and 4th try after `failed` or `no-receiver`; then every last value. */
export const WEEKLY_LIMIT_RETRY_MS = [60_000, 300_000, 900_000] as const;

/** How long `close()` waits for the chain (a send in flight and its write), so the process still exits in ≤ 5 s. */
export const WEEKLY_LIMIT_CLOSE_MS = 3_000;

/** Version of the state file. */
const FORMAT = 1;

/** Read ceiling of the state file: 16 ISO instants are about 450 B; a longer file is not ours. */
const ALERTS_MAX_BYTES = 4096;

/** How many keys the file keeps at most (the newest). */
const MAX_KEYS = 16;

const PREFIX = 'weekly-limit:';

export interface WeeklyLimitAlertOptions {
  readonly dataDir: string;
  /** Push to the devices (`ApnsSink.send`). */
  readonly send: (content: PushContent) => Promise<SendOutcome>;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export interface WeeklyLimitAlert {
  /** One reading of the weekly windows. Never throws; the work goes onto one chain. */
  check(windows: readonly WeeklyLimitReading[]): void;
  /** Stops evaluating; resolves when the chain ends, at the latest after {@link WEEKLY_LIMIT_CLOSE_MS}. */
  close(): Promise<void>;
  /** Resolves when everything checked so far is done (tests). */
  idle(): Promise<void>;
}

/** A window waiting for `delivered`. */
interface Pending {
  /** Percent of the qualifying reading: the banner says what crossed the threshold. */
  readonly percent: number;
  tries: number;
  /** Earliest instant of the next try (ms epoch). */
  nextAt: number;
}

/** State file → reset instants; `null` = a file of another shape. */
function parseAlerts(text: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sent = record['sent'];
  if (record['format'] !== FORMAT || !Array.isArray(sent)) return null;
  const keys: string[] = [];
  for (const key of sent) {
    if (typeof key !== 'string' || !Number.isFinite(Date.parse(key))) return null;
    keys.push(key);
  }
  return keys;
}

/** File system error code for the log line (no path, no content). */
const codeOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'error';
};

/** Gap after the try number `tries` (1-based) that did not deliver. */
const retryGap = (tries: number): number =>
  WEEKLY_LIMIT_RETRY_MS[Math.min(tries, WEEKLY_LIMIT_RETRY_MS.length) - 1] ?? WEEKLY_LIMIT_RETRY_MS[2];

export function createWeeklyLimitAlert(options: WeeklyLimitAlertOptions): WeeklyLimitAlert {
  const now = options.now ?? ((): number => Date.now());
  const file = join(options.dataDir, WEEKLY_LIMIT_ALERTS_FILENAME);
  /** Reset instants with a delivered push. */
  let sent = new Set<string>();
  /** Keys differ from the file and wait for a write. */
  let dirty = false;
  let loaded = false;
  let closed = false;
  const pending = new Map<string, Pending>();
  let chain: Promise<void> = Promise.resolve();

  const load = async (): Promise<void> => {
    loaded = true;
    let text: string | null;
    try {
      // File gate: a FIFO, a device or a symlink under this name is an unreadable file, not a hung read.
      const read = await readRegularFile(file, { maxBytes: ALERTS_MAX_BYTES, followSymlink: false });
      text = read === null || read.truncated ? null : read.bytes.toString('utf8');
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') options.log(`${PREFIX} ${WEEKLY_LIMIT_ALERTS_FILENAME} unreadable — starting over`);
      return;
    }
    const keys = text === null ? null : parseAlerts(text);
    if (keys === null) {
      options.log(`${PREFIX} ${WEEKLY_LIMIT_ALERTS_FILENAME} unreadable — starting over`);
      return;
    }
    sent = new Set(keys);
  };

  /**
   * Writes the keys; past resets drop out, the file keeps at most {@link MAX_KEYS} newest. The cap is on the file
   * only: memory keeps every delivered window until its reset, or a capped-out window would send on every reading.
   * `false` = not written.
   */
  const write = async (): Promise<boolean> => {
    const at = now();
    const live = [...sent].filter((key) => Date.parse(key) > at).sort((a, b) => Date.parse(b) - Date.parse(a));
    sent = new Set(live);
    const keys = live.slice(0, MAX_KEYS);
    const body = `${JSON.stringify({ format: FORMAT, sent: keys })}\n`;
    const tmp = join(options.dataDir, `.${WEEKLY_LIMIT_ALERTS_FILENAME}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(tmp, file);
      return true;
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      options.log(`${PREFIX} ${WEEKLY_LIMIT_ALERTS_FILENAME} not written (${codeOf(err)})`);
      return false;
    }
  };

  /** One try for one queued window; a window past its reset leaves the queue without a send. */
  const attempt = async (resetsAt: string, item: Pending): Promise<void> => {
    const at = now();
    const content = buildWeeklyLimitContent(item.percent, resetsAt, at);
    if (content === undefined) {
      pending.delete(resetsAt);
      return;
    }
    if (at < item.nextAt) return;
    let outcome: SendOutcome;
    try {
      outcome = await options.send(content);
    } catch {
      outcome = 'failed';
    }
    item.tries += 1;
    if (outcome !== 'no-receiver' || item.tries === 1) {
      options.log(`${PREFIX} ${String(item.percent)}%, resets ${resetsAt} (push: ${outcome})`);
    }
    if (outcome !== 'delivered') {
      // The gap counts from the outcome: a slow send must not shorten the wait before the next try.
      item.nextAt = now() + retryGap(item.tries);
      return;
    }
    pending.delete(resetsAt);
    sent.add(resetsAt);
    dirty = !(await write());
  };

  const evaluate = async (windows: readonly WeeklyLimitReading[]): Promise<void> => {
    if (!loaded) await load();
    if (closed) return;
    // A write that failed earlier: retried on every reading, without a second send.
    if (dirty) dirty = !(await write());
    const at = now();
    for (const window of windows) {
      if (window.percent < WEEKLY_LIMIT_ALERT_PERCENT || !(Date.parse(window.resetsAt) > at)) continue;
      if (sent.has(window.resetsAt) || pending.has(window.resetsAt)) continue;
      // Freshness only at qualification: an old dump of an unused account does not count.
      if (at - window.at > CLI_USAGE_STALE_MS) continue;
      pending.set(window.resetsAt, { percent: window.percent, tries: 0, nextAt: at });
    }
    for (const [resetsAt, item] of [...pending]) {
      if (closed) return;
      await attempt(resetsAt, item);
    }
  };

  return {
    check(windows) {
      if (closed) return;
      const snapshot = [...windows];
      chain = chain.then(() => evaluate(snapshot)).catch((err: unknown) => {
        options.log(`${PREFIX} internal error — ${(err as Error).message}`);
      });
    },
    close() {
      closed = true;
      let timer: NodeJS.Timeout | undefined;
      // A referenced timer: the APNs sender unrefs its socket and timers, so without it the process could exit
      // before a send in flight and its key write finish. `finally` clears it as soon as the chain ends.
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, WEEKLY_LIMIT_CLOSE_MS);
      });
      return Promise.race([chain, deadline]).finally(() => { clearTimeout(timer); });
    },
    idle: () => chain,
  };
}
