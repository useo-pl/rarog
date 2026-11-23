/**
 * Wycinek BLOKU dialogu na kartę bez przycisków: ekran od kreski dialogu w dół, bez ogona poprzedniej tury.
 *
 * Dotyczy wyłącznie ekranu bez opcji z cyframi (widok slash-komendy `/help`, `/status`, dialog zaufania bez cyfr,
 * ekran logowania): taki ekran nie ma przycisków, więc karta pokazuje sam tekst, a ogon ekranu (`snippet.ts`)
 * zaczyna się zwykle od końca poprzedniej odpowiedzi i ucina górę dialogu. Blok zaczyna się od pierwszej
 * niepustej linii pod NAJNIŻSZĄ kreską dialogu (`▔▔▔`, także ze statusem sesji, albo `───` z linią klawiszy
 * pod nią; kreskę daje `blockTopOf` z `region.ts`, oba rodzaje) i kończy na dole ekranu. Pierwsza linia bloku
 * to jego tytuł: decyzja (`decide/decide.ts`) wkłada go do `reqId` karty, żeby nowy widok w tej samej blokadzie
 * dostał nową kartę.
 *
 * `null`, gdy kreski nie ma, gdy kreska `───` nie ma pod sobą linii klawiszy (zwykła kreska pola promptu albo
 * ramki), gdy blok jest pusty, bez litery albo przekracza sufit wycinka (`SNIPPET_MAX_LINES`,
 * `SNIPPET_MAX_CHARS`) — wtedy karta zostaje przy ogonie ekranu.
 *
 * Wycinek i tytuł trafiają WYŁĄCZNIE na kartę tej jednej sesji, nigdy do dziennika ani logów (reguła prywatności
 * w nagłówku `parse.ts`); tytuł w `reqId` jest skrócony do hasha (`cards/ids.ts`).
 */
import { blockTopOf } from './region.ts';
import { SNIPPET_MAX_CHARS, SNIPPET_MAX_LINES } from './snippet.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';
import { MEANINGFUL_PATTERN, trimmedLines } from './text.ts';

const DIALOG_TOP_RULE_PATTERN = SCREEN_SIGNATURES.dialogTopRule.pattern;
const DIALOG_KEY_FOOTER_PATTERN = SCREEN_SIGNATURES.dialogKeyFooter.pattern;

export interface BlockExcerpt {
  /** Blok gotowy do wstawienia na kartę (bez ANSI, linie przycięte z prawej). */
  readonly text: string;
  /** Pierwsza linia bloku bez białych znaków na brzegach — do `reqId` karty, nigdy do dziennika. */
  readonly title: string;
}

/** Blok dialogu z ekranu albo `null` (patrz nagłówek modułu). */
export function blockExcerpt(text: string): BlockExcerpt | null {
  const lines = trimmedLines(text);
  const top = blockTopOf(lines, lines.length);
  if (top === null) return null;

  const rule = top.line;
  const below = lines.slice(rule + 1);
  // Kreska `▔▔▔` sama jest sygnałem dialogu; kreska `───` dopiero z linią klawiszy pod nią, bo tak samo
  // wygląda kreska pola promptu i ramki tabeli.
  const dialog = !DIALOG_TOP_RULE_PATTERN.test((lines[rule] ?? '').trim())
    || below.some((line) => DIALOG_KEY_FOOTER_PATTERN.test(line.trim()));
  if (!dialog) return null;

  const start = below.findIndex((line) => line.trim() !== '');
  if (start < 0) return null;
  const block = below.slice(start);
  const out = block.join('\n');
  if (block.length > SNIPPET_MAX_LINES || out.length > SNIPPET_MAX_CHARS || !MEANINGFUL_PATTERN.test(out)) {
    return null;
  }
  return { text: out, title: (block[0] ?? '').trim() };
}
