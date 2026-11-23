/**
 * Limity planu dla Live Activity: odczyt zrzutów paska statusu przez
 * wstrzyknięty czytnik; każdy odczyt zastępuje poprzedni w całości (jedno konto), okno po resecie
 * znika (reset bez nowego zrzutu nie dowodzi zera), klamra procentów, `onChange` tylko przy zmianie
 * widocznych liczb.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS_POLL_MS, contractPercent, createLimitsPoller } from '../src/notify/live-activity-limits.ts';
import { scanFreshestRateLimits } from '../src/herdr/statusline.ts';
import type { StatuslineRateLimits } from '../src/herdr/statusline.ts';

/** Odczyt z dysku idzie przez pulę wątków — czekamy na wynik, nie na obroty pętli zdarzeń. */
const settled = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 2_000, interval: 5 });

const NOW = Date.parse('2026-10-08T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** Tile readings without weekly windows: the harness adds an empty list (the weekly windows have their own rig). */
type TileReading = Omit<StatuslineRateLimits, 'weeklyWindows'>;

function harness(reads: (TileReading | null | Error)[]): {
  poller: ReturnType<typeof createLimitsPoller>;
  tick: () => Promise<void>;
  setNow: (ms: number) => void;
  changes: () => number;
  interval: number | undefined;
  stopped: () => boolean;
} {
  let at = NOW;
  let changes = 0;
  let timer: (() => void) | undefined;
  let interval: number | undefined;
  let stopped = false;
  const queue = [...reads];
  const poller = createLimitsPoller({
    now: () => at,
    read: () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next === null || next === undefined ? null : { ...next, weeklyWindows: [] });
    },
    onChange: () => { changes += 1; },
    setInterval: (cb, ms) => {
      timer = cb;
      interval = ms;
      return 1;
    },
    clearInterval: () => { stopped = true; },
  });
  return {
    poller,
    interval,
    tick: async () => {
      if (!stopped) timer?.();
      await flush();
    },
    setNow: (ms) => { at = ms; },
    changes: () => changes,
    stopped: () => stopped,
  };
}

describe('createLimitsPoller', () => {
  it('pierwszy odczyt od razu, potem co minutę; procenty zaokrąglone w klamrze; ta sama liczba — cisza', async () => {
    const h = harness([{
      fiveHour: { percent: 41.6, resetsAt: iso(NOW + 3_600_000) },
      weekly: { percent: 104, resetsAt: iso(NOW + 86_400_000) },
      at: NOW,
    }]);
    await flush();
    expect(h.interval).toBe(LIMITS_POLL_MS);
    expect(h.poller.current()).toEqual({ fiveHour: 42, weekly: 100 });
    expect(h.changes()).toBe(1);
    await h.tick();
    expect(h.changes()).toBe(1);
  });

  it('okno po resecie znika (nie 0 %) — także między odczytami — i budzi przeliczenie', async () => {
    const h = harness([
      {
        fiveHour: { percent: 92, resetsAt: iso(NOW + 60_000) },
        weekly: { percent: 30, resetsAt: iso(NOW + 86_400_000) },
        at: NOW,
      },
      new Error('EIO'),
    ]);
    await flush();
    expect(h.poller.current()).toEqual({ fiveHour: 92, weekly: 30 });
    h.setNow(NOW + 61_000);
    expect(h.poller.current()).toEqual({ weekly: 30 });
    await h.tick();
    expect(h.changes()).toBe(2);
  });

  it('nowy odczyt zastępuje poprzedni w całości — okna z dwóch zrzutów się nie sklejają', async () => {
    const h = harness([
      {
        fiveHour: { percent: 10, resetsAt: iso(NOW + 3_600_000) },
        weekly: { percent: 70, resetsAt: iso(NOW + 86_400_000) },
        at: NOW,
      },
      { fiveHour: { percent: 55, resetsAt: iso(NOW + 7_200_000) }, at: NOW + 60_000 },
    ]);
    await flush();
    await h.tick();
    expect(h.poller.current()).toEqual({ fiveHour: 55 });
  });

  it('brak zrzutów: „nie wiem" bez zgłoszenia; błąd czytnika zostawia poprzedni odczyt', async () => {
    const empty = harness([null]);
    await flush();
    expect(empty.poller.current()).toBeUndefined();
    expect(empty.changes()).toBe(0);

    const h = harness([{ weekly: { percent: 30, resetsAt: iso(NOW + 86_400_000) }, at: NOW }, new Error('EIO')]);
    await flush();
    await h.tick();
    expect(h.poller.current()).toEqual({ weekly: 30 });
    expect(h.changes()).toBe(1);
  });

  it('`close` zatrzymuje timer; odczyt w locie po zamknięciu niczego nie zgłasza', async () => {
    let release: ((value: StatuslineRateLimits | null) => void) | undefined;
    let changes = 0;
    let stopped = false;
    const poller = createLimitsPoller({
      now: () => NOW,
      read: () => new Promise((resolve) => { release = resolve; }),
      onChange: () => { changes += 1; },
      setInterval: () => 1,
      clearInterval: () => { stopped = true; },
    });
    poller.close();
    release?.({ weekly: { percent: 30, resetsAt: iso(NOW + 86_400_000) }, at: NOW, weeklyWindows: [] });
    await flush();
    expect(stopped).toBe(true);
    expect(changes).toBe(0);
  });

  it('prawdziwy czytnik: nieczytelny katalog zrzutów zostawia poprzedni odczyt (bez `onChange`), pusty go zastępuje', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rarog-la-limits-'));
    const resets = Math.floor((NOW + 86_400_000) / 1000);
    await writeFile(join(root, 'sesja.json'), JSON.stringify({
      rate_limits: { seven_day: { used_percentage: 70, resets_at: resets } },
    }));
    let dir = root;
    let changes = 0;
    let timer: (() => void) | undefined;
    const poller = createLimitsPoller({
      now: () => NOW,
      read: (at) => scanFreshestRateLimits(dir, at),
      onChange: () => { changes += 1; },
      setInterval: (cb) => {
        timer = cb;
        return 1;
      },
      clearInterval: () => {},
    });
    try {
      await settled(() => { expect(poller.current()).toEqual({ weekly: 70 }); });
      expect(changes).toBe(1);
      dir = join(root, 'nie-ma');
      let failed = false;
      const scan = scanFreshestRateLimits(dir, NOW).catch(() => { failed = true; });
      timer?.();
      await scan;
      expect(failed).toBe(true);
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      expect(poller.current()).toEqual({ weekly: 70 });
      expect(changes).toBe(1);
      // Katalog czytelny, ale bez żywego okna — to PRAWDA o braku limitów, więc pasek znika.
      const empty = join(root, 'pusty');
      await mkdir(empty);
      dir = empty;
      timer?.();
      await settled(() => { expect(poller.current()).toBeUndefined(); });
      expect(changes).toBe(2);
    } finally {
      poller.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('klamra procentu kontraktu', () => {
    expect(contractPercent(-1)).toBe(0);
    expect(contractPercent(99.5)).toBe(100);
    expect(contractPercent(12.4)).toBe(12);
  });
});

/*
 * The poller hands the weekly windows of every live reset to the weekly-limit signal (`weeklyWindows()`) and
 * calls `onPoll` after every read, also when the visible percentages did not change and after a failed read. The
 * tile (`current()`, `onChange`) does not depend on them.
 */
describe('createLimitsPoller — weekly windows and `onPoll`', () => {
  const X = iso(NOW + 86_400_000);
  const Y = iso(NOW + 2 * 86_400_000);

  function rig(reads: (StatuslineRateLimits | null | Error)[]): {
    poller: ReturnType<typeof createLimitsPoller>;
    tick: () => Promise<void>;
    setNow: (ms: number) => void;
    events: string[];
  } {
    let at = NOW;
    let timer: (() => void) | undefined;
    const events: string[] = [];
    const queue = [...reads];
    const poller = createLimitsPoller({
      now: () => at,
      read: () => {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? null);
      },
      onChange: () => { events.push('change'); },
      onPoll: () => { events.push('poll'); },
      setInterval: (cb) => {
        timer = cb;
        return 1;
      },
      clearInterval: () => {},
    });
    return {
      poller,
      events,
      tick: async () => {
        timer?.();
        await flush();
      },
      setNow: (ms) => { at = ms; },
    };
  }

  it('`onPoll` after every read, after `onChange`; unchanged percent with a new `at` or `resetsAt` still polls', async () => {
    const h = rig([
      { weekly: { percent: 97, resetsAt: X }, weeklyWindows: [{ percent: 97, resetsAt: X, at: NOW }], at: NOW },
      {
        weekly: { percent: 97, resetsAt: X },
        weeklyWindows: [{ percent: 97, resetsAt: X, at: NOW + 60_000 }],
        at: NOW + 60_000,
      },
      { weekly: { percent: 97, resetsAt: Y }, weeklyWindows: [{ percent: 97, resetsAt: Y, at: NOW }], at: NOW },
    ]);
    await flush();
    expect(h.events).toEqual(['change', 'poll']);
    expect(h.poller.weeklyWindows()).toEqual([{ percent: 97, resetsAt: X, at: NOW }]);
    await h.tick();
    expect(h.events).toEqual(['change', 'poll', 'poll']);
    expect(h.poller.weeklyWindows()).toEqual([{ percent: 97, resetsAt: X, at: NOW + 60_000 }]);
    await h.tick();
    expect(h.events).toEqual(['change', 'poll', 'poll', 'poll']);
    expect(h.poller.weeklyWindows()).toEqual([{ percent: 97, resetsAt: Y, at: NOW }]);
    // The tile saw one change: the visible percentages never moved.
    expect(h.poller.current()).toEqual({ weekly: 97 });
  });

  it('a failed read still polls, with the windows of the previous read', async () => {
    const h = rig([
      { weekly: { percent: 50, resetsAt: X }, weeklyWindows: [{ percent: 98, resetsAt: Y, at: NOW }], at: NOW },
      new Error('EIO'),
    ]);
    await flush();
    await h.tick();
    expect(h.events).toEqual(['change', 'poll', 'poll']);
    expect(h.poller.weeklyWindows()).toEqual([{ percent: 98, resetsAt: Y, at: NOW }]);
  });

  it('windows: percent in the contract shape, a window past its reset dropped on every call', async () => {
    const h = rig([{
      weekly: { percent: 40, resetsAt: Y },
      weeklyWindows: [
        { percent: 96.6, resetsAt: iso(NOW + 60_000), at: NOW - 5_000 },
        { percent: 104, resetsAt: Y, at: NOW },
      ],
      at: NOW,
    }]);
    await flush();
    expect(h.poller.weeklyWindows()).toEqual([
      { percent: 97, resetsAt: iso(NOW + 60_000), at: NOW - 5_000 },
      { percent: 100, resetsAt: Y, at: NOW },
    ]);
    h.setNow(NOW + 60_000);
    expect(h.poller.weeklyWindows()).toEqual([{ percent: 100, resetsAt: Y, at: NOW }]);
  });

  it('no reading: no windows; no dump: polls anyway', async () => {
    const h = rig([null]);
    expect(h.poller.weeklyWindows()).toEqual([]);
    await flush();
    expect(h.events).toEqual(['poll']);
    expect(h.poller.weeklyWindows()).toEqual([]);
  });

  it('no `onPoll` after `close`, also for a read in flight; an `onPoll` exception does not stop the poller', async () => {
    let release: ((value: StatuslineRateLimits | null) => void) | undefined;
    let polls = 0;
    const poller = createLimitsPoller({
      now: () => NOW,
      read: () => new Promise((resolve) => { release = resolve; }),
      onPoll: () => { polls += 1; },
      setInterval: () => 1,
      clearInterval: () => {},
    });
    poller.close();
    release?.({ weeklyWindows: [{ percent: 99, resetsAt: X, at: NOW }], at: NOW });
    await flush();
    expect(polls).toBe(0);

    let timer: (() => void) | undefined;
    let calls = 0;
    const throwing = createLimitsPoller({
      now: () => NOW,
      read: () => Promise.resolve(null),
      onPoll: () => {
        calls += 1;
        throw new Error('boom');
      },
      setInterval: (cb) => {
        timer = cb;
        return 1;
      },
      clearInterval: () => {},
    });
    await flush();
    timer?.();
    await flush();
    expect(calls).toBe(2);
    throwing.close();
  });
});
