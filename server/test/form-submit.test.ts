/**
 * Ścieżka `enter` formularza z preview — asercja klawisza i weryfikacja przed wysyłką.
 *
 * Fixture'y: `dialog-askuserquestion-preview.txt` (zrzut żywy, ❯ na opcji 1) oraz
 * `dialog-askuserquestion-notes.txt` (zrzut żywy trybu edycji notatki). Wszystkie warianty
 * odmowy są fail-closed: żaden nie może skończyć się `ok`, bo `ok` znaczy „enter wychodzi".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FORM_SUBMIT_KEY, assertFormSubmitKeys, confirmFormSubmit,
} from '../src/herdr/dialogs/send/form-submit.ts';
import { HerdrKeyNotAllowedError } from '../src/herdr/dialogs/send/keys.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const preview = read('dialog-askuserquestion-preview.txt');
const notes = read('dialog-askuserquestion-notes.txt');

/** Opcja podświetlona na fixture preview + pytanie z jego ekranu. */
const EXPECTED = {
  option: { digit: '1', label: 'Płaski zasobowy' },
  question: 'Który schemat ścieżek URL wolisz dla API Raroga?',
};

describe('assertFormSubmitKeys', () => {
  it('przepuszcza DOKŁADNIE ["enter"] i nic innego', () => {
    expect(() => { assertFormSubmitKeys([FORM_SUBMIT_KEY]); }).not.toThrow();
    for (const bad of [[], ['enter', 'enter'], ['1'], ['escape'], ['1', 'enter']]) {
      expect(() => { assertFormSubmitKeys(bad); }).toThrow(HerdrKeyNotAllowedError);
    }
  });
});

describe('confirmFormSubmit', () => {
  it('zgoda: formularz stoi, to samo pytanie, jeden `❯` na wybranej etykiecie', () => {
    expect(confirmFormSubmit(preview, EXPECTED)).toEqual({ ok: true });
  });

  it('karta bez treści pytania (ścieżka jsonl/hooka) pomija porównanie pytania', () => {
    expect(confirmFormSubmit(preview, { ...EXPECTED, question: null })).toEqual({ ok: true });
  });

  it('ekran bez formularza = `not-a-form` (null, composer, zgoda na narzędzie)', () => {
    expect(confirmFormSubmit(null, EXPECTED)).toEqual({ ok: false, reason: 'not-a-form' });
    expect(confirmFormSubmit('❯\n  Fable 5 | 0m', EXPECTED))
      .toEqual({ ok: false, reason: 'not-a-form' });
    expect(confirmFormSubmit(read('dialog-permission.txt'), EXPECTED))
      .toEqual({ ok: false, reason: 'not-a-form' });
  });

  it('inne pytanie pod tym samym kształtem = `question-changed` (zakładki formularza)', () => {
    // Formularz wielopytaniowy przełącza zakładkę BEZ mignięcia statusu — etykiety potrafią
    // się powtarzać między pytaniami, więc dowodem tożsamości jest treść pytania.
    const swapped = preview.replace(
      'Który schemat ścieżek URL wolisz dla API Raroga?',
      'Które pytanie stoi teraz na ekranie?',
    );
    expect(confirmFormSubmit(swapped, EXPECTED))
      .toEqual({ ok: false, reason: 'question-changed' });
  });

  it('tryb edycji notatki = `notes-editing` — zrzut żywy', () => {
    expect(confirmFormSubmit(notes, {
      option: { digit: '2', label: 'Wariant Y' },
      question: null,
    })).toEqual({ ok: false, reason: 'notes-editing' });
  });

  it('zero albo dwa podświetlenia = `no-single-highlight`', () => {
    expect(confirmFormSubmit(preview.replace('❯ 1.', '  1.'), EXPECTED))
      .toEqual({ ok: false, reason: 'no-single-highlight' });
    expect(confirmFormSubmit(preview.replace('  2. Zagnieżdżony', '❯ 2. Zagnieżdżony'), EXPECTED))
      .toEqual({ ok: false, reason: 'no-single-highlight' });
  });

  it('`❯` na innej opcji niż wybrana = `wrong-option` (cyfra połknięta przez TUI)', () => {
    // Dokładnie zmierzony najgorszy scenariusz: cyfra ginie, podświetlenie zostaje na
    // domyślnej opcji 1 — enter zatwierdziłby nie to, w co tapnięto.
    expect(confirmFormSubmit(preview, {
      ...EXPECTED, option: { digit: '2', label: 'Zagnieżdżony po projekcie' },
    })).toEqual({ ok: false, reason: 'wrong-option' });
  });
});
