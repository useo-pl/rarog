/**
 * Budżet linii logu odmów iroh (`server/src/iroh/log-budget.ts`): pierwsza linia rodzaju w oknie,
 * reszta do liczników, jedna linia podsumowania na koniec okna z pominiętymi liniami.
 */
import { describe, expect, it } from 'vitest';
import { IROH_REFUSALS, createLogBudget } from '../src/iroh/log-budget.ts';
import { ManualClock } from './helpers/fake-iroh.ts';

function budget(): { lines: string[]; clock: ManualClock; note: ReturnType<typeof createLogBudget> } {
  const lines: string[] = [];
  const clock = new ManualClock();
  return { lines, clock, note: createLogBudget((line) => { lines.push(line); }, clock, 60_000) };
}

describe('budżet logów iroh', () => {
  it('zalew jednego rodzaju: jedna linia ze szczegółem, potem podsumowanie z liczbami', async () => {
    const { lines, clock, note } = budget();
    for (let i = 0; i < 1000; i += 1) note.note('busy', `klient-${String(i)}`);
    note.note('alpn', '"h3" od abc');
    note.note('alpn', '"h3" od abd');
    expect(lines).toEqual(['iroh: busy klient-0', 'iroh: alpn "h3" od abc']);
    await clock.advance(59_999);
    expect(lines).toHaveLength(2);
    await clock.advance(1);
    expect(lines.at(-1)).toBe('iroh: refusals in a 60 s window: alpn 2, busy 1000 (suppressed lines: 1000)');
    expect(note.totals()).toMatchObject({ busy: 1000, alpn: 2, evicted: 0 });
  });

  it('okno bez pominiętych linii nie daje podsumowania; nowe okno znów loguje pierwszą linię', async () => {
    const { lines, clock, note } = budget();
    note.note('auth-timeout', 'a');
    await clock.advance(60_000);
    expect(lines).toEqual(['iroh: auth-timeout a']);
    note.note('auth-timeout', 'b');
    expect(lines).toEqual(['iroh: auth-timeout a', 'iroh: auth-timeout b']);
    expect(note.totals()['auth-timeout']).toBe(2);
  });

  it('`flush` podsumowuje bieżące okno od razu i zatrzymuje jego termin', async () => {
    const { lines, clock, note } = budget();
    note.note('stream-limit', 'x');
    note.note('stream-limit', 'y');
    note.flush();
    expect(lines.at(-1)).toBe('iroh: refusals in a 60 s window: stream-limit 2 (suppressed lines: 1)');
    expect(clock.pending).toBe(0);
    await clock.advance(60_000);
    expect(lines).toHaveLength(2);
  });

  it('a detail from outside reaches the line without terminal control and within 120 units', () => {
    const { lines, note } = budget();
    note.note('handshake-error', `bad${String.fromCodePoint(0x1b)}[2Jcert\r\n${String.fromCodePoint(0x202e)}x`);
    note.note('alpn', 'y'.repeat(300));
    expect(lines).toEqual(['iroh: handshake-error bad?[2Jcert???x', `iroh: alpn ${'y'.repeat(120)}`]);
  });

  it('sumy mają każdy rodzaj, także zerowe', () => {
    const { note } = budget();
    expect(Object.keys(note.totals())).toEqual([...IROH_REFUSALS]);
  });
});
