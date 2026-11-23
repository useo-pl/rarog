/**
 * Weekly-limit signal (`server/src/notify/weekly-limit.ts`): a `weekly-limit` push at least once for every
 * weekly window that reached 97 % in a fresh reading, and never again for that window — not on later readings, not
 * after a restart (the key is the window's reset instant in `<dataDir>/weekly-limit-alerts.json`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWeeklyLimitContent } from '../src/notify/content.ts';
import type { PushContent, SendOutcome } from '../src/notify/content.ts';
import type { WeeklyLimitReading } from '../src/notify/live-activity-limits.ts';
import {
  WEEKLY_LIMIT_ALERT_PERCENT,
  WEEKLY_LIMIT_ALERTS_FILENAME,
  WEEKLY_LIMIT_CLOSE_MS,
  WEEKLY_LIMIT_RETRY_MS,
  createWeeklyLimitAlert,
} from '../src/notify/weekly-limit.ts';
import type { WeeklyLimitAlert } from '../src/notify/weekly-limit.ts';
import { createApnsChannel } from '../src/notify/apns-channel.ts';
import { CLI_USAGE_STALE_MS } from '../src/usage.ts';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const X = '2026-11-18T15:00:00.000Z';
const Y = '2026-11-19T01:00:00.000Z';
const Z = '2026-11-20T15:00:00.000Z';
const MIN = 60_000;

let dataDir = '';
let alerts: WeeklyLimitAlert[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-weekly-limit-'));
  alerts = [];
});

afterEach(async () => {
  vi.useRealTimers();
  for (const alert of alerts) await alert.close();
  await chmod(dataDir, 0o700).catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
});

interface Rig {
  readonly alert: WeeklyLimitAlert;
  readonly sent: PushContent[];
  readonly lines: string[];
  /** Moves the module clock. */
  set: (ms: number) => void;
  /** One reading: `check` and wait for its chain. */
  poll: (windows: readonly WeeklyLimitReading[]) => Promise<void>;
}

function rig(
  outcomes: readonly (SendOutcome | Error)[] = ['delivered'],
  opts: { send?: (content: PushContent) => Promise<SendOutcome>; start?: number } = {},
): Rig {
  let t = opts.start ?? NOW;
  const sent: PushContent[] = [];
  const lines: string[] = [];
  const queue = [...outcomes];
  const alert = createWeeklyLimitAlert({
    dataDir,
    log: (line) => { lines.push(line); },
    now: () => t,
    send: opts.send ?? ((content) => {
      sent.push(content);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? 'delivered');
    }),
  });
  alerts.push(alert);
  return {
    alert, sent, lines,
    set: (ms) => { t = ms; },
    poll: async (windows) => {
      alert.check(windows);
      await alert.idle();
    },
  };
}

const win = (percent: number, resetsAt = X, at = NOW): WeeklyLimitReading => ({ percent, resetsAt, at });
const file = (): string => join(dataDir, WEEKLY_LIMIT_ALERTS_FILENAME);
const stored = async (): Promise<unknown> => JSON.parse(await readFile(file(), 'utf8')) as unknown;
const line = (percent: number, resetsAt: string, outcome: SendOutcome): string =>
  `weekly-limit: ${String(percent)}%, resets ${resetsAt} (push: ${outcome})`;

describe('createWeeklyLimitAlert', () => {
  it('constants of the contract', () => {
    expect(WEEKLY_LIMIT_ALERT_PERCENT).toBe(97);
    expect(WEEKLY_LIMIT_ALERTS_FILENAME).toBe('weekly-limit-alerts.json');
    expect(WEEKLY_LIMIT_RETRY_MS).toEqual([60_000, 300_000, 900_000]);
    expect(WEEKLY_LIMIT_CLOSE_MS).toBe(3_000);
  });

  it('96 %, fresh → no push, no file', async () => {
    const r = rig();
    await r.poll([win(96)]);
    expect(r.sent).toEqual([]);
    expect(r.lines).toEqual([]);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('97 %, fresh, no key → a push right away; `delivered` → the key in the file (0o600), one log line', async () => {
    const r = rig();
    await r.poll([win(97)]);
    expect(r.sent).toEqual([buildWeeklyLimitContent(97, X, NOW)]);
    expect(r.lines).toEqual([line(97, X, 'delivered')]);
    expect(await stored()).toEqual({ format: 1, sent: [X] });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect((await readdir(dataDir)).filter((name) => name.endsWith('.tmp')), 'no temp files').toEqual([]);
  });

  it('later readings of 97–100 % of that window, also with a new `at` at the same percent → nothing', async () => {
    const r = rig();
    await r.poll([win(97)]);
    r.set(NOW + MIN);
    await r.poll([win(97, X, NOW + MIN)]);
    await r.poll([win(98, X, NOW + MIN)]);
    await r.poll([win(100, X, NOW + MIN)]);
    expect(r.sent).toHaveLength(1);
    expect(r.lines).toHaveLength(1);
  });

  it('restart with the key in the file, 99 % → nothing', async () => {
    await writeFile(file(), `${JSON.stringify({ format: 1, sent: [X] })}\n`, { mode: 0o600 });
    const r = rig();
    await r.poll([win(99)]);
    expect(r.sent).toEqual([]);
    expect(r.lines).toEqual([]);
  });

  it('97 %, stale → nothing and no queue; the next reading with the same percent and a fresh `at` → a push', async () => {
    const r = rig();
    await r.poll([win(97, X, NOW - CLI_USAGE_STALE_MS - 1)]);
    r.set(NOW + MIN);
    await r.poll([]);
    expect(r.sent).toEqual([]);
    await r.poll([win(97, X, NOW + MIN - CLI_USAGE_STALE_MS)]);
    expect(r.sent).toEqual([buildWeeklyLimitContent(97, X, NOW + MIN)]);
  });

  it('`failed` → tries after 1, 5 and 15 min, then every 15 min, without the freshness gate → `delivered` ends', async () => {
    const r = rig(['failed', new Error('boom'), 'failed', 'failed', 'delivered']);
    await r.poll([win(97)]);
    expect(r.sent).toHaveLength(1);
    // The reading grows stale; the queued window does not need it, nor any reading at all.
    const tries: [number, number][] = [
      [MIN - 1, 1], [MIN, 2],
      [MIN + 5 * MIN - 1, 2], [MIN + 5 * MIN, 3],
      [6 * MIN + 15 * MIN - 1, 3], [6 * MIN + 15 * MIN, 4],
      [21 * MIN + 15 * MIN - 1, 4], [21 * MIN + 15 * MIN, 5],
      [36 * MIN + 15 * MIN, 5],
    ];
    for (const [offset, count] of tries) {
      r.set(NOW + offset);
      await r.poll(offset % 2 === 0 ? [win(97)] : []);
      expect(r.sent, `after ${String(offset / MIN)} min`).toHaveLength(count);
    }
    // TTL and expiry are counted at each try.
    expect(r.sent[4]).toEqual(buildWeeklyLimitContent(97, X, NOW + 36 * MIN));
    expect(r.lines).toEqual([
      line(97, X, 'failed'), line(97, X, 'failed'), line(97, X, 'failed'), line(97, X, 'failed'),
      line(97, X, 'delivered'),
    ]);
    expect(await stored()).toEqual({ format: 1, sent: [X] });
  });

  it('`no-receiver` → the same retries; a log line only at the first try', async () => {
    const r = rig(['no-receiver', 'no-receiver', 'delivered']);
    await r.poll([win(98)]);
    r.set(NOW + MIN);
    await r.poll([]);
    r.set(NOW + 6 * MIN);
    await r.poll([]);
    expect(r.sent).toHaveLength(3);
    expect(r.lines).toEqual([line(98, X, 'no-receiver'), line(98, X, 'delivered')]);
  });

  it('the window resets while it waits in the queue → it drops out without a send and without a line', async () => {
    const soon = new Date(NOW + 90_000).toISOString();
    const r = rig(['failed']);
    await r.poll([win(97, soon)]);
    r.set(NOW + 120_000);
    await r.poll([]);
    r.set(NOW + 10 * MIN);
    await r.poll([]);
    expect(r.sent).toHaveLength(1);
    expect(r.lines).toEqual([line(97, soon, 'failed')]);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('a window that resets during another window\'s send is skipped before its try', async () => {
    const soon = new Date(NOW + 30_000).toISOString();
    let t = NOW;
    const sent: string[] = [];
    const alert = createWeeklyLimitAlert({
      dataDir, log: () => {}, now: () => t,
      send: (content) => {
        sent.push(content.topic ?? '');
        // A slow send: the clock passes the second window's reset.
        t += MIN;
        return Promise.resolve('delivered');
      },
    });
    alerts.push(alert);
    alert.check([win(97, X), win(99, soon)]);
    await alert.idle();
    expect(sent).toEqual([buildWeeklyLimitContent(97, X, NOW)?.topic]);
    expect(await stored()).toEqual({ format: 1, sent: [X] });
  });

  it('three windows in one reading, A 97 %, B 40 %, C 99 % → a try for A and C, each once, different collapse ids', async () => {
    const r = rig();
    await r.poll([win(97, X), win(40, Y), win(99, Z)]);
    await r.poll([win(97, X), win(40, Y), win(99, Z)]);
    expect(r.sent).toEqual([buildWeeklyLimitContent(97, X, NOW), buildWeeklyLimitContent(99, Z, NOW)]);
    expect(r.sent[0]?.topic).not.toBe(r.sent[1]?.topic);
    expect(await stored()).toEqual({ format: 1, sent: [Z, X] });
  });

  it('after the reset a new window ≥ 97 % → a push; keys at or before now drop out at the write', async () => {
    const r = rig();
    await r.poll([win(97, X)]);
    const after = Date.parse(X) + MIN;
    const next = '2026-11-25T15:00:00.000Z';
    r.set(after);
    await r.poll([win(98, next, after)]);
    expect(r.sent).toEqual([buildWeeklyLimitContent(97, X, NOW), buildWeeklyLimitContent(98, next, after)]);
    expect(await stored()).toEqual({ format: 1, sent: [next] });
  });

  it('the file keeps at most the 16 newest keys', async () => {
    const keys = Array.from({ length: 16 }, (_, i) => new Date(Date.parse(Y) + (i + 1) * 86_400_000).toISOString());
    await writeFile(file(), JSON.stringify({ format: 1, sent: keys }), { mode: 0o600 });
    const r = rig();
    await r.poll([win(97, X)]);
    expect(r.sent).toHaveLength(1);
    expect(await stored()).toEqual({ format: 1, sent: [...keys].reverse() });
    // The cap is on the file only: the delivered window stays known in memory until its reset.
    await r.poll([win(99, X)]);
    await r.poll([win(100, X)]);
    expect(r.sent).toHaveLength(1);
  });

  it('the gap before a retry counts from the outcome, not from the start of a slow send', async () => {
    let t = NOW;
    const sent: number[] = [];
    const outcomes: SendOutcome[] = ['failed', 'delivered'];
    const alert = createWeeklyLimitAlert({
      dataDir,
      log: () => undefined,
      now: () => t,
      send: () => {
        sent.push(t);
        t += 10_000; // the send takes 10 s on the module clock
        return Promise.resolve(outcomes.shift() ?? 'delivered');
      },
    });
    alerts.push(alert);
    alert.check([win(97)]);
    await alert.idle();
    expect(sent).toEqual([NOW]);
    t = NOW + MIN; // 50 s after the failure
    alert.check([]);
    await alert.idle();
    expect(sent).toHaveLength(1);
    t = NOW + 10_000 + MIN;
    alert.check([]);
    await alert.idle();
    expect(sent).toEqual([NOW, NOW + 10_000 + MIN]);
  });

  it('a reading without weekly windows → nothing', async () => {
    const r = rig();
    await r.poll([]);
    expect(r.sent).toEqual([]);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('after a restart a redrawn dump of an old account at 98 % (fresh `mtime`), no key → one push for its window', async () => {
    const r = rig();
    await r.poll([win(98, Y, NOW)]);
    await r.poll([win(98, Y, NOW)]);
    expect(r.sent).toEqual([buildWeeklyLimitContent(98, Y, NOW)]);
  });

  it.each([
    ['broken JSON', '{"format": 1, "sent": ['],
    ['format 2', JSON.stringify({ format: 2, sent: [X] })],
    ['a key that is not a date', JSON.stringify({ format: 1, sent: [X, 'tomorrow'] })],
    ['a key that is not a string', JSON.stringify({ format: 1, sent: [X, 7] })],
    ['over the read ceiling', JSON.stringify({ format: 1, sent: [X], pad: 'x'.repeat(5000) })],
  ])('an unreadable file (%s) → one line, an empty set, the file written again at the next `delivered`', async (_name, text) => {
    await writeFile(file(), text, { mode: 0o600 });
    const r = rig();
    await r.poll([win(97, X)]);
    await r.poll([win(97, X)]);
    expect(r.lines).toEqual([
      'weekly-limit: weekly-limit-alerts.json unreadable — starting over', line(97, X, 'delivered'),
    ]);
    expect(r.sent).toHaveLength(1);
    expect(await stored()).toEqual({ format: 1, sent: [X] });
  });

  it('a FIFO or a symlink under the file name → unreadable, without hanging; replaced at `delivered`', async () => {
    execFileSync('mkfifo', [file()]);
    const fifo = rig();
    await fifo.poll([win(97, X)]);
    expect(fifo.lines[0]).toBe('weekly-limit: weekly-limit-alerts.json unreadable — starting over');
    expect(await stored()).toEqual({ format: 1, sent: [X] });

    await rm(file());
    const target = join(dataDir, 'target.json');
    await writeFile(target, JSON.stringify({ format: 1, sent: [Y] }));
    await symlink(target, file());
    const link = rig();
    await link.poll([win(97, Y)]);
    expect(link.lines[0]).toBe('weekly-limit: weekly-limit-alerts.json unreadable — starting over');
    expect(link.sent).toHaveLength(1);
    expect((await stat(file())).isFile()).toBe(true);
    expect(await readFile(target, 'utf8'), 'the symlink target stays untouched').toBe(JSON.stringify({ format: 1, sent: [Y] }));
  });

  it('a failed write after `delivered` → a line with the code, the key held, the write retried on each reading without a second send', async () => {
    if (process.getuid?.() === 0) return;
    await chmod(dataDir, 0o500);
    const r = rig();
    await r.poll([win(97, X)]);
    expect(r.lines).toEqual([line(97, X, 'delivered'), 'weekly-limit: weekly-limit-alerts.json not written (EACCES)']);
    r.set(NOW + MIN);
    await r.poll([win(98, X, NOW + MIN)]);
    expect(r.sent).toHaveLength(1);
    expect(r.lines.at(-1)).toBe('weekly-limit: weekly-limit-alerts.json not written (EACCES)');
    await chmod(dataDir, 0o700);
    await r.poll([]);
    expect(await stored()).toEqual({ format: 1, sent: [X] });
    expect(r.sent).toHaveLength(1);

    // A restart without a new crossing sends nothing.
    const restarted = rig();
    await restarted.poll([win(99, X, NOW + MIN)]);
    expect(restarted.sent).toEqual([]);
  });

  it('a close during a send → the send and the write finish before `close` resolves; then nothing is evaluated', async () => {
    let finish: ((outcome: SendOutcome) => void) | undefined;
    let calls = 0;
    const r = rig([], {
      send: () => {
        calls += 1;
        return new Promise((resolve) => { finish = resolve; });
      },
    });
    r.alert.check([win(97, X)]);
    await vi.waitFor(() => { expect(finish).toBeDefined(); }, { timeout: 2_000, interval: 5 });
    let closed = false;
    const closing = r.alert.close().then(() => { closed = true; });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(closed).toBe(false);
    finish?.('delivered');
    await closing;
    expect(await stored()).toEqual({ format: 1, sent: [X] });
    r.alert.check([win(99, Y)]);
    await r.alert.idle();
    expect(calls).toBe(1);
  });

  it('a chain hanging longer than 3 s does not hold the exit', async () => {
    let calls = 0;
    const r = rig([], { send: () => { calls += 1; return new Promise<SendOutcome>(() => {}); } });
    r.alert.check([win(97, X)]);
    await vi.waitFor(() => { expect(calls).toBe(1); }, { timeout: 2_000, interval: 5 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let closed = false;
    const closing = r.alert.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(WEEKLY_LIMIT_CLOSE_MS - 1);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(closed).toBe(true);
    alerts = [];
  });

  it('the close deadline keeps the event loop alive while a send is still running', async () => {
    let calls = 0;
    const r = rig([], { send: () => { calls += 1; return new Promise<SendOutcome>(() => {}); } });
    r.alert.check([win(97, X)]);
    await vi.waitFor(() => { expect(calls).toBe(1); }, { timeout: 2_000, interval: 5 });
    const timers: NodeJS.Timeout[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const handle = real(fn, ms);
      timers.push(handle);
      return handle;
    }) as typeof setTimeout);
    const closing = r.alert.close();
    spy.mockRestore();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.hasRef()).toBe(true);
    clearTimeout(timers[0]);
    void closing;
    alerts = [];
  });

  it('no APNs channel (`RAROG_PUSH=0`) → no poller, no file, no push', async () => {
    let pollers = 0;
    const channel = createApnsChannel({ pushEnabled: false, pushE2e: true, pushRelay: { origin: 'https://push.rarog.ai' }, dataDir }, {
      sessions: () => [], log: () => {}, mac: () => ({ cpu: 1 }), pairedDevices: { active: () => [] },
      limitsPoller: () => {
        pollers += 1;
        return { current: () => undefined, weeklyWindows: () => [win(99)], close: () => {} };
      },
    });
    expect(channel).toBeUndefined();
    expect(pollers).toBe(0);
    expect(await readdir(dataDir)).toEqual([]);
  });
});
