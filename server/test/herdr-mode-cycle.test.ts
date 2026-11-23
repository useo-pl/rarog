/**
 * Ścieżka `shift+tab`: osobna asercja, decyzja kroku pętli, zdania do transkryptu.
 *
 * Test istnieje po to, żeby klawisz cyklujący tryb CAŁEJ sesji nie wszedł „przy okazji" ani na
 * wspólną allow-listę (`ALLOWED_KEYS` ma własny test), ani jako sekwencja dwóch klawiszy. Pętla
 * jest testowana na wartościach: kolejność cyklu CLI nie jest kontraktem, więc jedyne, co wolno
 * obiecać, to „zatrzymaj się na pierwszym odczycie z celem i nigdy nie naciskaj w ciemno".
 */
import { describe, expect, it } from 'vitest';
import { isServerSentence } from '@rarog/shared/sentences';
import { readFileSync } from 'node:fs';
import { HerdrKeyNotAllowedError } from '../src/herdr/dialogs/send/keys.ts';
import { collapseFooterMode, parseMode, parseModeFooter } from '../src/herdr/dialogs/screen/mode-footer.ts';
import {
  MODE_CYCLE_KEY, MODE_CYCLE_MAX_PRESSES, assertModeCycleKeys, modeCycleDoneMessage,
  modeCycleStartAllowed, modeCycleStoppedMessage, nextModeCycleStep,
} from '../src/herdr/mode-cycle.ts';

describe('assertModeCycleKeys', () => {
  it('przepuszcza DOKŁADNIE ["shift+tab"]', () => {
    expect(MODE_CYCLE_KEY).toBe('shift+tab');
    expect(() => assertModeCycleKeys(['shift+tab'])).not.toThrow();
  });

  for (const keys of [[], ['shift+tab', 'shift+tab'], ['tab'], ['escape'], ['S-Tab'], ['backtab']]) {
    it(`odrzuca ${JSON.stringify(keys)}`, () => {
      expect(() => assertModeCycleKeys(keys)).toThrow(HerdrKeyNotAllowedError);
    });
  }
});

describe('modeCycleStartAllowed', () => {
  it('rusza z plan/auto/manual, nigdy z bypass ani unknown', () => {
    expect(modeCycleStartAllowed('plan')).toBe(true);
    expect(modeCycleStartAllowed('auto')).toBe(true);
    expect(modeCycleStartAllowed('manual')).toBe(true);
    expect(modeCycleStartAllowed('bypass')).toBe(false);
    expect(modeCycleStartAllowed('unknown')).toBe(false);
  });
});

describe('nextModeCycleStep', () => {
  it('cel na stopce = koniec bez klawisza, także przy zerze naciśnięć', () => {
    expect(nextModeCycleStep('plan', 'plan', 0)).toEqual({ kind: 'done' });
    expect(nextModeCycleStep('auto', 'auto', 3)).toEqual({ kind: 'done' });
  });

  it('inny znany tryb = naciśnij', () => {
    expect(nextModeCycleStep('auto', 'plan', 0)).toEqual({ kind: 'press' });
    expect(nextModeCycleStep('manual', 'auto', 2)).toEqual({ kind: 'press' });
    // Przejście przez `bypass` w środku cyklu nie zatrzymuje pętli — cel jest dalej.
    expect(nextModeCycleStep('bypass', 'plan', 1)).toEqual({ kind: 'press' });
  });

  it('`acceptEdits` nie jest celem `auto` (chip zlewa je, pętla nie)', () => {
    expect(nextModeCycleStep('acceptEdits', 'auto', 1)).toEqual({ kind: 'press' });
    expect(parseModeFooter('⏵⏵ accept edits on (shift+tab to cycle) · ← 1 agent')).toBe('acceptEdits');
    expect(parseMode('⏵⏵ accept edits on (shift+tab to cycle) · ← 1 agent')).toBe('auto');
    expect(collapseFooterMode('acceptEdits')).toBe('auto');
  });

  it('stopki nie widać = stop, bez względu na licznik', () => {
    expect(nextModeCycleStep('unknown', 'plan', 0)).toEqual({ kind: 'stop', reason: 'unknown' });
  });

  it('sufit naciśnięć zatrzymuje pętlę PRZED kolejnym klawiszem', () => {
    expect(nextModeCycleStep('auto', 'plan', MODE_CYCLE_MAX_PRESSES - 1)).toEqual({ kind: 'press' });
    expect(nextModeCycleStep('auto', 'plan', MODE_CYCLE_MAX_PRESSES))
      .toEqual({ kind: 'stop', reason: 'exhausted' });
  });
});

describe('zdania do transkryptu', () => {
  it('sukces nazywa cel i liczbę naciśnięć', () => {
    const done = modeCycleDoneMessage('plan', 3);
    expect(isServerSentence(done) ? done.ref : null).toEqual({ code: 'commands.mode-cycle-done', args: ['plan', '3'] });
    expect(done.text).toContain('plan mode');
    expect(done.text).toContain('3 shift+tab presses');
  });

  it('każda odmowa mówi, GDZIE panel stoi, i ma ostrzeżenie', () => {
    for (const reason of ['unknown', 'exhausted', 'send-failed', 'busy'] as const) {
      const stopped = modeCycleStoppedMessage('auto', reason, 'manual', 2);
      expect(stopped.text.startsWith('⚠')).toBe(true);
      expect(stopped.text).toContain('manual mode');
      expect(stopped.text).toContain('auto');
      expect(isServerSentence(stopped) ? stopped.ref.args : null).toContain('manual');
    }
    const unknown = modeCycleStoppedMessage('plan', 'unknown', 'unknown', 1);
    expect(isServerSentence(unknown) ? unknown.ref.code : null).toBe('commands.mode-cycle-no-footer.mode-unknown');
    expect(unknown.text).toContain('an unknown mode');
    expect(modeCycleStoppedMessage('plan', 'exhausted', 'acceptEdits', 6).text).toContain('accept edits');
  });
});

describe('okablowanie produkcyjne', () => {
  it('fabryka drivera w index.ts przekazuje `refreshMode` — bez tego wpis nadzorcy stoi 15 s', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toContain('refreshMode: () => ctx.refreshMode(),');
  });
});
