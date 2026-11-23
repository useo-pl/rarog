/**
 * Formularz pytania `AskUserQuestion` na ekranie: stopka (podgląd, notatki), tryb zatwierdzania, nagłówek i treść
 * pytania spod paska zakładek, sygnatury formularza wielokrotnego wyboru.
 */
import { BOX_EDGE_PATTERN, OPTION_BOX_GLYPH_PATTERN, OPTION_LINE_PATTERN } from './options.ts';
import type { ScreenOption } from './options.ts';
import { HORIZONTAL_RULE_PATTERN } from './region.ts';
import { isReviewScreen } from './review.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';

/** Marker wariantu preview w STOPCE formularza (drugi ślad obok glifu ramki). */
const PREVIEW_NOTES_MARKER = SCREEN_SIGNATURES.previewNotes.pattern;

/** Starsza stopka formularza wielokrotnego (`space to toggle`) — trzecia sygnatura formularza wielokrotnego. */
const MULTI_SELECT_SPACE_FOOTER = SCREEN_SIGNATURES.multiSelectSpaceFooter.pattern;

/**
 * Ile OSTATNICH linii regionu liczy się jako stopka formularza — jedyne miejsce, w którym
 * szukamy markerów `n to add notes` i `ctrl+g` (znalezisko #6): najszerszy
 * kandydat regionu (`bounded: false`) niesie scrollback, a agent, który wypisał w odpowiedzi
 * „ctrl+g", nie ma prawa zamienić karty w fallback ani przełączyć trybu zatwierdzania.
 * Cztery linie, nie jedna: wąski panel zawija stopkę (zmierzone „ctrl+g to\nedit in Nvim"),
 * a nad nią potrafi stać jeszcze `Chat about this`.
 */
const FORM_FOOTER_LINES = 4;

/** Stopka formularza (ostatnie linie regionu), złączona i zbita do małych liter. */
export function formFooter(region: readonly string[]): string {
  return region.slice(Math.max(0, region.length - FORM_FOOTER_LINES)).join('\n').toLowerCase();
}

/**
 * Sygnatura trybu edycji notatki — stopka rysuje `ctrl+g to edit in Nvim` WYŁĄCZNIE po wejściu
 * w pole (`n`). Marker celowo krótki: wąski panel zawija stopkę w środku frazy (zmierzone —
 * „ctrl+g to\nedit in Nvim"), a `ctrl+g` poza tym trybem nie występuje na ekranie w ogóle.
 */
export const NOTES_EDITING_MARKER = SCREEN_SIGNATURES.notesEditing.pattern;

/**
 * Tryb zatwierdzania formularza PYTANIA — patrz {@link ScreenDialog.submit}.
 *
 * Dwa niezależne ślady wariantu preview, wystarczy jeden: glif ramki podglądu w LINII OPCJI
 * (ramka stoi obok listy, więc przecina jej linie) albo marker notatek w STOPCE (formularz
 * bez preview go nie rysuje — zmierzone na obu wariantach; stopka zamiast całego
 * regionu, żeby „n to add notes" w scrollbacku nie przełączało trybu).
 */
export function formSubmitMode(region: readonly string[]): 'digit' | 'digit-enter' {
  if (formFooter(region).includes(PREVIEW_NOTES_MARKER)) return 'digit-enter';
  for (const line of region) {
    const match = OPTION_LINE_PATTERN.exec(line);
    if (match !== null && OPTION_BOX_GLYPH_PATTERN.test(match[2] ?? '')) return 'digit-enter';
  }
  return 'digit';
}

/**
 * Marker nagłówka pytania w formularzu — zakładka z nazwą pytania.
 *
 * Dwa zmierzone brzmienia, oba muszą działać:
 *
 * - `☐ Architektura` — sama zakładka;
 * - `← ☒ Dodatki ✔ Submit →` (zrzut z iPada) — PASEK zakładek: strzałki
 *   przewijania po bokach i przycisk „Submit" formularza wielokrotnego w ogonie.
 *
 * Gdyby drugie brzmienie nie trafiało, cała linia weszłaby do TREŚCI pytania — karta na
 * telefonie zaczynałaby się od „← ☒ Dodatki ✔ Submit →”, czyli od chrome'u TUI.
 *
 * Nazwa kończy się na NASTĘPNYM glifie zakładki (klasa negatywna zamiast `.+`): pasek
 * formularza wielopytaniowego niesie kilka zakładek, a wzorzec do końca linii wkładałby na
 * kartę nazwę CUDZEGO pytania razem z glifem (`Dodatki ☐ Kolor`).
 */
const QUESTION_HEADER_PATTERN = SCREEN_SIGNATURES.questionHeader.pattern;

/** Glif zakładki w pasku — liczymy je, żeby poznać pasek WIELOZAKŁADKOWY. */
const TAB_GLYPH_PATTERN = SCREEN_SIGNATURES.tabGlyph.pattern;

/** Strzałka przewijania paska zakładek — na początku linii. */
const TAB_BAR_START_PATTERN = SCREEN_SIGNATURES.tabBarStart.pattern;

/** Strzałka przewijania paska zakładek — na końcu linii. */
const TAB_BAR_END_PATTERN = SCREEN_SIGNATURES.tabBarEnd.pattern;

/** Przycisk „Submit" w ogonie paska zakładek (formularz wielokrotnego wyboru). */
const TAB_BAR_SUBMIT_PATTERN = SCREEN_SIGNATURES.tabBarSubmit.pattern;

/** Pasek zakładek po zdjęciu strzałek przewijania i ogona „✔ Submit". */
function tabBarBody(line: string): string {
  return line
    .replace(TAB_BAR_START_PATTERN, '')
    .replace(TAB_BAR_END_PATTERN, '')
    .replace(TAB_BAR_SUBMIT_PATTERN, '')
    .trim();
}

/**
 * Nazwa zakładki z linii paska; `null`, gdy to nie jest pasek zakładek.
 *
 * Kolejność zdejmowania jest wiążąca: najpierw strzałka końcowa, potem „✔ Submit" (bo stoi
 * PRZED nią). Zdejmujemy WYŁĄCZNIE chrome — nazwa jedzie na kartę dosłownie.
 *
 * Pasek z KILKOMA zakładkami oddaje `''`, nie pierwszą nazwę: która zakładka jest aktywna,
 * nie zostało zmierzone, a nagłówek opisujący cudze pytanie jest gorszy niż brak nagłówka
 * (treść pytania i tak niesie właściwe zdanie). `''` to dalej „to JEST pasek",
 * więc linia znika z treści pytania tak samo jak przy jednej zakładce.
 */
function tabHeaderFrom(line: string): string | null {
  const bare = tabBarBody(line);
  const tab = QUESTION_HEADER_PATTERN.exec(bare);
  if (tab === null) return null;
  if (TAB_GLYPH_PATTERN.test(bare.slice(1))) return '';
  return (tab[1] ?? '').trim();
}

/**
 * Przycisk „✔ Submit" w PASKU ZAKŁADEK — trzecia sygnatura formularza wielokrotnego.
 *
 * Warunek „to naprawdę pasek" (`tabHeaderFrom !== null`) jest tu istotny: samo słowo „Submit"
 * potrafi stać w scrollbacku albo w treści podglądu, a sygnatura multi-select gasi kartę
 * decyzji dla całego dialogu.
 */
function tabBarSubmit(line: string): boolean {
  return tabHeaderFrom(line) !== null
    && TAB_BAR_SUBMIT_PATTERN.test(
      line.replace(TAB_BAR_START_PATTERN, '').replace(TAB_BAR_END_PATTERN, ''),
    );
}

/**
 * Nagłówek i treść pytania z regionu formularza `AskUserQuestion`.
 *
 * Treść to wszystko, co stoi NAD pierwszą opcją (bez kresek i pustych linii); nagłówek to
 * linia paska zakładek (`☐ …`, `← ☒ … ✔ Submit →` — patrz `tabHeaderFrom`).
 *
 * `null` dla formularza ze starą stopką multi-select (`space to …`): „zaznacz i potwierdź
 * osobno" nie da się uczciwie zrobić jedną cyfrą. Guard stoi TUTAJ, a nie tylko przy
 * wołającym, bo `questionFrom` obsługuje też `tool` i `confirm` — a sygnatura z checkboxów
 * (dzisiejsze CLI) jest już decyzją wołającego (`multiSelect` w `parseOptions`).
 *
 * `optionsAt` (index of the first option line in `region`) ends the text there instead of at the first numbered line,
 * so a numbered list in the dialog body above the options stays on the card (`screen/option-run.ts`).
 */
export function questionFrom(
  region: readonly string[], optionsAt?: number,
): { header: string; question: string } | null {
  if (region.some((line) => line.toLowerCase().includes(MULTI_SELECT_SPACE_FOOTER))) return null;
  let header = '';
  const lines: string[] = [];
  for (const line of optionsAt === undefined ? region : region.slice(0, optionsAt)) {
    if (optionsAt === undefined && OPTION_LINE_PATTERN.test(line)) break;
    if (line === '' || HORIZONTAL_RULE_PATTERN.test(line)) continue;
    // Górna/dolna krawędź ramki (`╭────╮`) nie jest kreską poziomą z HORIZONTAL_RULE
    // i wchodziła do treści jako pierwsza „linia pytania" — ściana box-drawing na karcie,
    // która zjadała sufit znaków (reprodukcja na dialog-permission.txt).
    if (BOX_EDGE_PATTERN.test(line)) continue;
    const tab = tabHeaderFrom(line);
    if (tab !== null) {
      header = tab;
      continue;
    }
    lines.push(line);
  }
  return { header, question: lines.join('\n').trim() };
}

/**
 * Pozycja „Submit"/„Next" POD listą opcji — element formularza bez własnej cyfry.
 *
 * Zmierzone („Submit", a w formularzu wielopytaniowym „Next"): pozycja
 * stoi w kolumnie opisów, ale jest samodzielnym słowem, a nie zdaniem autora pytania.
 */
const FORM_SUBMIT_ROW_PATTERN = SCREEN_SIGNATURES.formSubmitRow.pattern;

/** Czy pod którąś opcją stoi pozycja „Submit"/„Next" — drugi dowód wielokrotności. */
function formSubmitRow(region: readonly string[]): boolean {
  let afterOption = false;
  for (const line of region) {
    if (OPTION_LINE_PATTERN.test(line)) {
      afterOption = true;
      continue;
    }
    if (afterOption && FORM_SUBMIT_ROW_PATTERN.test(line.trim())) return true;
  }
  return false;
}

/**
 * Is this a MULTI-select form? Three signatures, one is enough.
 *
 * 1. **A checkbox in the option line** (`1. [✔] Posypka`, `1. ☑ Posypka`) — measured.
 * 2. **The "✔ Submit" button in the TAB BAR TOGETHER with the "Submit"/"Next" row under the options**
 *    — two pieces of evidence.
 * 3. **`space to …` in the region** — an older footer (`space to toggle`) that today's CLI no longer
 *    draws; it stays because fixtures and older versions have it.
 *
 * Without signature 1 a checkbox form looks to the parser like a plain single-choice one, so the
 * phone card would offer a one-tap answer and ONE digit would go into a dialog that waits for
 * a selection + Submit.
 *
 * Signature 2 needs two pieces of evidence because the tab bar with "✔ Submit" is drawn by EVERY
 * form with more than one question (`dialog-askuserquestion-multiq-tab1-…`), so on its own it
 * would turn the card of every single-choice tab into the "answer in the terminal" fallback. The
 * second piece (`formSubmitRow`) is present in EVERY measured multi-select form and in no
 * single-choice tab — the fail-closed direction stays with the checkboxes.
 */
export function formMultiSelect(region: readonly string[], options: readonly ScreenOption[]): boolean {
  if (isReviewScreen(region, options)) return false;
  if (options.some((option) => option.checked !== undefined)) return true;
  if (region.some(tabBarSubmit) && formSubmitRow(region)) return true;
  return region.some((line) => line.toLowerCase().includes(MULTI_SELECT_SPACE_FOOTER));
}
