/**
 * Decyzje strażnika `relay-vps/relay-watch.mjs` (cron co 5 min): średni ruch wychodzący przez godzinę wobec 80 %
 * sufitu `tc`, ruch w miesiącu wobec 15 TB (także przez reboot, gdy licznik jądra wraca do zera), liczba połączeń
 * i 401 Workera w dzienniku adaptera; powtórka tego samego alertu najwyżej raz na godzinę.
 */
import { describe, expect, it } from 'vitest';
import { countMatching, countUnauthorized, emptyState, evaluate, LINK_BYTES_PER_S } from '../relay-watch.mjs';
import type { WatchInput, WatchState } from '../relay-watch.mjs';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const quiet: Omit<WatchInput, 'txBytes'> = { conns: 3, unauthorized: 0 };

/** Przebiegi co 5 min ze stałym tempem `bytesPerS`; zwraca stan i wszystkie alerty. */
function run(steps: number, bytesPerS: number, from: { state: WatchState | null; tx: number; t: number }) {
  let state = from.state;
  let tx = from.tx;
  const alerts: string[] = [];
  let t = from.t;
  for (let i = 0; i < steps; i++) {
    const res = evaluate(state, { txBytes: tx, ...quiet }, t);
    state = res.state;
    alerts.push(...res.alerts);
    t += 5 * MIN;
    tx += bytesPerS * 300;
  }
  return { state: state as WatchState, alerts, tx, t };
}

describe('relay-watch.mjs: ruch wychodzący', () => {
  it('pierwszy przebieg niczego nie alarmuje i zapisuje próbkę', () => {
    const { state, alerts } = evaluate(null, { txBytes: 123, ...quiet }, T0);
    expect(alerts).toEqual([]);
    expect(state.samples).toEqual([[T0, 123]]);
    expect(state.monthBytes).toBe(123);
  });

  it('85 % łącza przez godzinę = alert (okno od 55 min); ten sam alert najwyżej raz na godzinę', () => {
    const early = run(11, 0.85 * LINK_BYTES_PER_S, { state: null, tx: 0, t: T0 });
    expect(early.alerts).toEqual([]);
    const hot = run(13, 0.85 * LINK_BYTES_PER_S, { state: null, tx: 0, t: T0 });
    expect(hot.alerts).toHaveLength(1);
    expect(hot.alerts[0]).toMatch(/outbound traffic 10\.6 MB\/s on average over 55 min/);
    const later = run(12, 0.85 * LINK_BYTES_PER_S, { state: hot.state, tx: hot.tx, t: hot.t });
    expect(later.alerts).toHaveLength(1);
  });

  it('75 % łącza albo krótki szczyt ponad 80 % bez alertu (średnia z godziny)', () => {
    expect(run(14, 0.75 * LINK_BYTES_PER_S, { state: null, tx: 0, t: T0 }).alerts).toEqual([]);
    const calm = run(11, 0.1 * LINK_BYTES_PER_S, { state: null, tx: 0, t: T0 });
    const peak = run(2, LINK_BYTES_PER_S, { state: calm.state, tx: calm.tx, t: calm.t });
    expect(peak.alerts).toEqual([]);
  });

  it('reboot (licznik jądra mniejszy): okno godzinowe od nowa, do miesiąca dochodzi stan licznika', () => {
    const before = run(6, 0.9 * LINK_BYTES_PER_S, { state: null, tx: 0, t: T0 });
    const monthBefore = before.state.monthBytes;
    const { state, alerts } = evaluate(before.state, { txBytes: 1000, ...quiet }, before.t);
    expect(alerts).toEqual([]);
    expect(state.samples).toEqual([[before.t, 1000]]);
    expect(state.monthBytes).toBe(monthBefore + 1000);
  });

  it('15 TB w miesiącu = jeden alert na miesiąc; nowy miesiąc liczy od zera', () => {
    const start: WatchState = { ...emptyState(), month: '2026-11', monthBytes: 14.9e12, lastTx: 1e9 };
    const first = evaluate(start, { txBytes: 1e9 + 2e11, ...quiet }, T0);
    expect(first.alerts).toEqual([expect.stringMatching(/in 2026-11: 15\.10 TB \(threshold 15 TB\)/)]);
    const second = evaluate(first.state, { txBytes: 1e9 + 3e11, ...quiet }, T0 + 5 * MIN);
    expect(second.alerts).toEqual([]);
    const december = evaluate(second.state, { txBytes: 1e9 + 4e11, ...quiet }, Date.UTC(2026, 11, 1, 0, 1));
    expect(december.state.month).toBe('2026-12');
    expect(december.state.monthBytes).toBe(1e11);
    expect(december.alerts).toEqual([]);
  });
});

describe('relay-watch.mjs: połączenia i 401 Workera', () => {
  it('ponad 6000 połączeń = alert, 6000 nie', () => {
    expect(evaluate(null, { txBytes: 0, conns: 6000, unauthorized: 0 }, T0).alerts).toEqual([]);
    expect(evaluate(null, { txBytes: 0, conns: 6001, unauthorized: 0 }, T0).alerts)
      .toEqual([expect.stringMatching(/6001 TCP connections on 443/)]);
  });

  it('401 w dzienniku adaptera = alert o fail-open przy złym bearerze', () => {
    const journal = [
      '2026-11-10T12:00:00.000Z decision=allow src=worker id=abababab ms=3.1 why=200',
      '2026-11-10T12:00:01.000Z decision=allow src=failopen id=abababab ms=3.0 why=status:401:body:"bearer"',
      '2026-11-10T12:00:02.000Z decision=allow src=failopen id=cdcdcdcd ms=3001.0 why=fetch:TimeoutError:',
    ].join('\n');
    expect(countUnauthorized(journal)).toBe(1);
    const { alerts } = evaluate(null, { txBytes: 0, conns: 0, unauthorized: 1 }, T0);
    expect(alerts).toEqual([expect.stringMatching(/the Worker rejected the relay bearer \(1× 401/)]);
  });
});

describe('relay-watch.mjs: odczyt dziennika', () => {
  it('liczy strumieniowo wyjście większe niż bufor spawnSync (1 MiB)', async () => {
    // 20 000 linii po ok. 100 B (ok. 2 MB), co setna z 401: zalew 50 decyzji/s przez ponad 5 min
    const script = [
      "const line = (i) => '2026-11-10T12:00:00.000Z decision=allow src=failopen id=abababab ms=3.0 why='",
      "  + (i % 100 === 0 ? 'status:401:body:x' : 'fetch:TimeoutError:') + ' '.repeat(20);",
      "let out = ''; for (let i = 0; i < 20000; i++) out += line(i) + '\\n'; process.stdout.write(out);",
    ].join('\n');
    expect(await countMatching(process.execPath, ['-e', script], /\bwhy=status:401\b/)).toBe(200);
  });

  it('porażka polecenia = wyjątek z kodem; brak programu = wyjątek', async () => {
    await expect(countMatching(process.execPath, ['-e', 'process.exit(3)'], /x/)).rejects.toThrow(/exit 3/);
    await expect(countMatching('/nie/ma/journalctl', [], /x/)).rejects.toThrow(/ENOENT/);
  });

  it('porażka odczytu = alert raz na godzinę, a ruch i połączenia liczą się dalej', () => {
    const input = { txBytes: 1e6, conns: 6001, unauthorized: 0, journalError: 'journalctl: exit 1' };
    const first = evaluate(null, input, T0);
    expect(first.alerts).toEqual([
      expect.stringMatching(/6001 TCP connections/),
      expect.stringMatching(/reading the relay-access journal failed.*journalctl: exit 1/),
    ]);
    expect(first.state.lastRunMs).toBe(T0);
    expect(first.state.lastTx).toBe(1e6);
    const again = evaluate(first.state, { ...input, txBytes: 2e6 }, T0 + 5 * MIN);
    expect(again.alerts).toEqual([]);
  });
});

describe('relay-watch.mjs: daily connection peak (read by relay-stats)', () => {
  const at = (iso: string): number => Date.parse(iso);
  const conns = (n: number): WatchInput => ({ txBytes: 0, conns: n, unauthorized: 0 });

  it('keeps the highest count of the UTC day; a lower count does not lower it', () => {
    const first = evaluate(null, conns(7), at('2026-11-13T10:00:00Z'));
    expect(first.state.connPeaks).toEqual({ '2026-11-13': 7 });
    const second = evaluate(first.state, conns(3), at('2026-11-13T10:05:00Z'));
    expect(second.state.connPeaks).toEqual({ '2026-11-13': 7 });
    const third = evaluate(second.state, conns(9), at('2026-11-13T23:55:00Z'));
    expect(third.state.connPeaks).toEqual({ '2026-11-13': 9 });
  });

  it('a new day starts its own peak and keeps the old one as yesterday; older days are dropped', () => {
    const prev: WatchState = { ...emptyState(), connPeaks: { '2026-11-12': 40, '2026-11-13': 12 } };
    const next = evaluate(prev, conns(2), at('2026-11-14T00:00:30Z'));
    expect(next.state.connPeaks).toEqual({ '2026-11-13': 12, '2026-11-14': 2 });
    const gap = evaluate(next.state, conns(5), at('2026-11-16T08:00:00Z'));
    expect(gap.state.connPeaks).toEqual({ '2026-11-16': 5 });
  });

  it('an old state file without the peak field loads and gets one; alerts stay the same', () => {
    const old: Partial<WatchState> = { samples: [], month: '2026-11', monthBytes: 5, lastTx: 0, monthAlerted: '',
      lastRunMs: null, alertedAt: {} };
    const res = evaluate(old, conns(6001), at('2026-11-13T10:00:00Z'));
    expect(res.state.connPeaks).toEqual({ '2026-11-13': 6001 });
    expect(res.alerts).toEqual([expect.stringMatching(/6001 TCP connections on 443/)]);
    expect(res.state.monthBytes).toBe(5);
  });

  it('the previous state object is not mutated', () => {
    const prev: WatchState = { ...emptyState(), connPeaks: { '2026-11-13': 1 } };
    evaluate(prev, conns(4), at('2026-11-13T10:00:00Z'));
    expect(prev.connPeaks).toEqual({ '2026-11-13': 1 });
  });
});
