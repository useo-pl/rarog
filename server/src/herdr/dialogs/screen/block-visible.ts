/**
 * Czy CAŁY blok dialogu stoi w jednym odczycie ekranu: górna kreska bloku, linia tytułu pod nią, komplet
 * opcji `1…N` i stopka klawiszowa pod opcjami. Wynik idzie wyłącznie do dziennika (`blockVisible`
 * w kształcie przypadku, `audit.ts`); żadna karta ani cyfra na nim nie stoi.
 *
 * Tytuł liczy się tu po kształcie (pierwsza niepusta linia pod kreską), nie z zamkniętej listy tytułów
 * `block.ts`: pytanie formularza i dialog CLI spoza listy też mają tytuł. Opis: `docs/dialogs.md`,
 * „Case shape in the log”.
 */
import { dialogBlock, lineBelow } from './block.ts';
import { OPTION_LINE_PATTERN } from './options.ts';
import { optionRegion } from './parse.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';
import { trimmedLines } from './text.ts';

/**
 * Stopka klawiszowa: linia, która ZACZYNA SIĘ od klawisza. Wzorzec chrome'u formularza (`formChrome`) tu nie
 * wystarcza, bo trafia też w opis opcji z „ctrl+c to cancel” w środku — ucięty formularz dostawałby wtedy
 * `true`.
 */
const DIALOG_KEY_FOOTER_PATTERN = SCREEN_SIGNATURES.dialogKeyFooter.pattern;

/**
 * Czy pod OSTATNIĄ opcją regionu stoi stopka klawiszowa ({@link DIALOG_KEY_FOOTER_PATTERN}). Zawinięta stopka
 * wąskiego panelu („Esc to cancel · Tab to” + „amend”) rozpoznaje się po pierwszej linii. Dialog bez stopki (pauza
 * „Session paused”, sieć sandboksa, „Switch model?” starszego CLI) daje `false`: bez niej odczyt nie dowodzi,
 * że pod ostatnią widoczną opcją nie ma następnej.
 */
function footerBelowOptions(region: readonly string[]): boolean {
  let last = -1;
  region.forEach((line, index) => {
    if (OPTION_LINE_PATTERN.test(line)) last = index;
  });
  if (last === -1) return false;
  return region.slice(last + 1).some((line) => DIALOG_KEY_FOOTER_PATTERN.test(line.trim()));
}

/**
 * Cały blok dialogu w tym jednym odczycie:
 *
 * 1. komplet opcji `1…N` w regionie, z którego czyta `parseOptions` (`optionRegion`);
 * 2. górna kreska bloku nad pierwszą opcją (`dialogBlock`, czyli `blockTopOf` z filtrem gołej kreski) i blok
 *    jednoznaczny — dialog ucięty u góry (nagłówek nad krawędzią panelu) kreski nie ma, a kreska ze statusem sesji
 *    górą bloku tu nie jest;
 * 3. tytuł: niepusta linia między tą kreską a pierwszą opcją;
 * 4. stopka klawiszowa pod ostatnią opcją ({@link footerBelowOptions}).
 *
 * Ekran bez dialogu (widok przewinięty w górę, pole promptu) daje `false`.
 */
export function blockVisible(text: string): boolean {
  const lines = trimmedLines(text);
  const found = optionRegion(lines);
  if (found === null) return false;
  const block = dialogBlock(lines, found.firstOption);
  if (block.ambiguous || block.top === -1) return false;
  if (lineBelow(lines, block.top, found.firstOption) === -1) return false;
  return footerBelowOptions(found.region);
}
