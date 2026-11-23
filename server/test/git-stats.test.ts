/**
 * Linia kosztu gita w `server.log` (`git-stats.ts`) — jedna na okno 5 min, zamykane leniwie.
 *
 * Z tej linii robi się pomiar przed/po szczegółach plików: czas odczytu (`#collect`) i liczba
 * ramek `git-status`. Test pilnuje, że okno liczy to, co ma, i że bez ruchu nie pisze niczego.
 */
import { describe, expect, it } from 'vitest';
import { GIT_STATS_WINDOW_LOG, GIT_STATS_WINDOW_MS, GitReadStats } from '../src/git-stats.ts';

describe('GitReadStats', () => {
  it('okno zbiera odczyty i ramki, a linię oddaje pierwsze zdarzenie PO jego końcu', () => {
    let now = 0;
    const stats = new GitReadStats(() => now);
    expect(stats.noteRead(80, 'ok')).toBeNull();
    for (const ms of [20, 40, 60, 1_200]) {
      now += 1_000;
      expect(stats.noteRead(ms, ms > 1_000 ? 'timeout' : 'skipped')).toBeNull();
    }
    expect(stats.noteRead(30, 'failed')).toBeNull();
    expect(stats.noteFrame()).toBeNull();
    expect(stats.noteFrame()).toBeNull();

    now = GIT_STATS_WINDOW_MS + 30_000;
    expect(stats.noteFrame()).toBe(
      `${GIT_STATS_WINDOW_LOG} 330 s — reads 6 (median 60 ms, p95 1200 ms, max 1200 ms),`
      + ' numstat ok 1 / skipped 3 / timeout 1 / error 1, git-status frames 2',
    );
  });

  it('zdarzenie zamykające okno liczy się już do NASTĘPNEGO okna', () => {
    let now = 0;
    const stats = new GitReadStats(() => now, 1_000);
    expect(stats.noteFrame()).toBeNull();
    now = 1_000;
    expect(stats.noteRead(10, 'ok')).toMatch(/reads 0 .*git-status frames 1$/);
    now = 1_500;
    expect(stats.noteRead(10, 'ok')).toBeNull();
    now = 2_000;
    expect(stats.noteFrame())
      .toMatch(new RegExp(`^${GIT_STATS_WINDOW_LOG} 1 s — reads 2 \\(median 10 ms.*git-status frames 0$`));
  });
});
