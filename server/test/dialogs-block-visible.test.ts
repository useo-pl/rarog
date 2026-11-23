/**
 * `blockVisible` (pole kształtu przypadku w dzienniku): czy CAŁY blok dialogu — górna kreska, tytuł, komplet
 * opcji `1…N`, stopka klawiszowa — stoi w jednym odczycie ekranu. Fixture'y z panelu: widok pełny, dialog ucięty
 * u góry (zrzut odmowy z `refusals/`), widok przewinięty w górę, formularz pytania, dialog bez stopki, zawinięta
 * stopka wąskiego panelu. Predykat idzie wyłącznie do dziennika; decyzji ani karty nie zmienia.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockVisible } from '../src/herdr/dialogs/screen/block-visible.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const MARK = '\n--- ekran ---\n';

/** Ekran fixture'u; zrzut odmowy (`refusals/`) ma przed ekranem nagłówek, który tu odcinamy. */
function screen(name: string): string {
  const raw = readFileSync(join(DIR, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at === -1 ? raw : raw.slice(at + MARK.length);
}

describe('blockVisible: cały blok dialogu w jednym odczycie', () => {
  it.each([
    ['measured/zgoda-bash-2.1.293.txt', 'pełna zgoda na Bash: kreska, tytuł, opcje, stopka'],
    ['measured/zgoda-edit-2.1.293.txt', 'pełna zgoda na edycję'],
    ['measured/pytanie-jednokrotne-2.1.293.txt', 'formularz pytania: tytuł to pytanie, stopka formularza'],
    ['measured/wielopytaniowy-multiselect-2.1.293.txt', 'formularz z paskiem zakładek, pozycja „Submit” nie jest stopką'],
    ['measured/zgoda-skill-waski-2.1.311.txt', 'wąski panel: stopka zawinięta na dwie linie'],
    ['dialog-resume-summary-2.1.258.txt', 'dialog CLI ze stopką'],
  ])('%s → true (%s)', (name) => {
    expect(blockVisible(screen(name))).toBe(true);
  });

  it.each([
    ['refusals/zgoda-edit-uciety-naglowek-63x28.txt', 'dialog ucięty u góry: bez kreski bloku nad tytułem'],
    ['dialog-bash-uciety-naglowek-2.1.294.txt', 'nagłówek zgody nad krawędzią panelu'],
    ['measured/zgoda-bash-wysoka.txt', 'wysoka zgoda: początek bloku poza ekranem'],
    ['dialog-bash-przewiniety-widok-2.1.295.txt', 'widok przewinięty w górę: dialogu nie ma w odczycie'],
    ['dialog-model-switch.txt', 'dialog bez stopki: odczyt nie dowodzi, że pod ostatnią opcją nic nie ma'],
    ['dialog-session-paused-2.1.309.txt', 'pauza „Session paused” bez stopki'],
    ['measured/zgoda-siec-2.1.293.txt', 'prośba sieci sandboksa bez stopki'],
    ['composer-empty-2.1.258.ansi.txt', 'samo pole promptu'],
  ])('%s → false (%s)', (name) => {
    expect(blockVisible(screen(name))).toBe(false);
  });

  it('pusty ekran → false', () => {
    expect(blockVisible('')).toBe(false);
  });

  it('opis opcji z „ctrl+c to cancel” nie jest stopką: ucięty formularz → false', () => {
    const lines = screen('measured/pytanie-jednokrotne-2.1.293.txt').split('\n');
    const cut = lines.findIndex((line) => line.includes('2. Czekolada'));
    expect(cut).toBeGreaterThan(0);
    const truncated = [...lines.slice(0, cut), '     Use ctrl+c to cancel the operation'].join('\n');
    expect(blockVisible(truncated)).toBe(false);
  });

  it('stopka zaczynająca się od strzałek („↑/↓ to navigate · enter to select”) → true', () => {
    expect(blockVisible(screen('dialog-askuserquestion.txt'))).toBe(true);
  });
});
