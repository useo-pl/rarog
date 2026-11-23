/**
 * Wycinek dialogu na kartę bez przycisków: ostatnie linie ekranu, przycięte, z hashem prefiksu.
 *
 * Wycinek trafia WYŁĄCZNIE na kartę tej jednej sesji (`SessionSummary.herdrDialogScreen`), nigdy do dziennika
 * ani logów (reguła prywatności w nagłówku `parse.ts`).
 */
import { createHash } from 'node:crypto';
import { MEANINGFUL_PATTERN, trimmedLines } from './text.ts';

/** Ile linii dialogu trafia na kartę. */
export const SNIPPET_MAX_LINES = 40;

/** Twardy sufit znaków wycinka — telefon i ring buffer SSE nie są miejscem na cały ekran. */
export const SNIPPET_MAX_CHARS = 2000;

/**
 * Ile pierwszych znaków wycinka wchodzi do hasha.
 *
 * Hash służy DEDUPLIKACJI przy miganiu `blocked → working → blocked`: ten sam dialog nie ma
 * prawa wpaść do transkryptu dwa razy. Liczymy z prefiksu, bo ogon dialogu bywa animowany
 * (spinner, licznik sekund), a nagłówek z treścią decyzji jest stabilny.
 */
export const SNIPPET_HASH_CHARS = 512;

export interface HerdrSnippet {
  /** Tekst wycinka gotowy do wstawienia na kartę dialogu (bez ANSI, przycięty). */
  text: string;
  /**
   * sha256 prefiksu — NIE jest pokazywany użytkownikowi. Wycinek żyje na karcie
   * i nikt hasha nie czyta, ale
   * pole zostaje w kontrakcie (`ScreenSnippet` w driverze) — patrz komentarz tam.
   */
  hash: string;
}

/**
 * Wycinek dialogu na kartę bez przycisków przy `blocked`.
 *
 * Bierzemy OSTATNIE linie ekranu, nie pierwsze: dialog zgody stoi na dole panelu, a górę
 * zajmuje ogon poprzedniej tury, który Rarog i tak ma z jsonl.
 *
 * @returns wycinek albo `null`, gdy ekran jest pusty lub nie ma w nim ani jednej litery/cyfry
 *          (sama ramka box-drawing to nie jest informacja dla człowieka)
 */
export function snippet(text: string): HerdrSnippet | null {
  const lines = trimmedLines(text);
  if (lines.length === 0) return null;

  const tail = lines.slice(Math.max(0, lines.length - SNIPPET_MAX_LINES));
  let out = tail.join('\n');
  if (out.length > SNIPPET_MAX_CHARS) {
    // Ucinamy od GÓRY (zostaje koniec dialogu z opcjami), a niepełną pierwszą linię
    // wyrzucamy w całości — połówka linii na karcie wygląda jak uszkodzone dane.
    out = out.slice(out.length - SNIPPET_MAX_CHARS);
    const firstBreak = out.indexOf('\n');
    if (firstBreak >= 0) out = out.slice(firstBreak + 1);
  }
  out = out.trim();
  if (out === '' || !MEANINGFUL_PATTERN.test(out)) return null;

  const hash = createHash('sha256').update(out.slice(0, SNIPPET_HASH_CHARS), 'utf8').digest('hex');
  return { text: out, hash };
}
