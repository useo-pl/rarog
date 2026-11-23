/**
 * Blok dialogu warstwy 2 (`readBlock`): kreska, tytuł, treść, opcje i to, co pod nimi, odczytane w jednym miejscu.
 *
 * Funkcja jest czysta, nad tekstem ekranu po `trimmedLines`. Nie zna tytułów dialogów ani nazw narzędzi: górę bloku
 * daje `blockTopOf` (`screen/region.ts`), cyfry `optionRegion` (`screen/parse.ts`), a odcisk dzisiejsza formuła
 * odcisku bloku (`blockPrint`). Czy blok jest kompletny i czy dostaje przyciski, rozstrzyga dopiero reguła warstwy 2
 * (`verdict.ts`, z kształtem z rejestru `match.ts`). Serwer woła ten moduł przy fladze warstwy 2 z karty bloku bez
 * cyfr (`card.ts`), z karty i kroku warstwy 2 (`drivers/herdr/layer2-card.ts`, `drivers/herdr/layer2-step.ts`), a bez
 * flagi z potwierdzenia „Switch model?” po `/model` (`drivers/herdr/commands.ts`).
 *
 * Dwa rodzaje bloku:
 *
 * - **z opcjami** — region opcji z kompletem cyfr `1…N` (`optionRegion`, ten sam co w parserze); góra to
 *   NAJBLIŻSZA kreska nad pierwszą opcją, o ile jest kreską bloku (goła albo ze statusem). Inna kreska bliżej opcji
 *   (ramka operacji `╌╌╌`, `═══`) albo brak kreski = brak bloku;
 * - **bez cyfr** (widok slash-komendy, zaufanie bez numerów) — góra to najniższa kreska bloku na ekranie, jak w
 *   wycinku na kartę bez przycisków (`screen/excerpt.ts`): goła kreska `────` liczy się tylko ze stopką klawiszową
 *   pod sobą, bo tak samo wygląda kreska pola promptu i ramki tabeli.
 *
 * Lista numerowana w scrollbacku nad widokiem bez cyfr wygrywa region opcji, jak w parserze: blok czyta się wtedy
 * od niej, a linie widoku stoją pod opcjami (`below`), więc kształtu taki blok nie dostaje.
 *
 * The block also carries its raw lines (`rows`, indentation kept) for the layer 2 rule (`verdict.ts`), which reads
 * option labels with their continuation lines from them. The footer runs from its first key line to the bottom of the
 * block, so a footer wrapped by a narrow pane is read whole.
 */
import { blockPrint, optionRegion } from '../screen/parse.ts';
import type { OptionRegion } from '../screen/parse.ts';
import { OPTION_LINE_PATTERN, unbox } from '../screen/options.ts';
import type { ScreenOption } from '../screen/options.ts';
import { HORIZONTAL_RULE_PATTERN, blockTopOf } from '../screen/region.ts';
import type { BlockTop } from '../screen/region.ts';
import { SCREEN_SIGNATURES } from '../screen/signatures.ts';
import { trimmedLines } from '../screen/text.ts';

/** Stopka klawiszowa: linia, która zaczyna się od klawisza („Esc to cancel”, „Enter to confirm · …”). */
const KEY_FOOTER_PATTERN = SCREEN_SIGNATURES.dialogKeyFooter.pattern;

/** Ciągła kreska `────` (górna kreska dialogu i kreska pola promptu). */
const DASH_RULE_PATTERN = SCREEN_SIGNATURES.dialogTopRule.pattern;

/** One line of the block: its index in the screen lines and its raw text. */
export interface BlockRow {
  readonly index: number;
  /** The line as on screen: indentation, focus marker and frame glyphs kept, trailing spaces trimmed. */
  readonly text: string;
}

/** Blok dialogu z jednego odczytu ekranu. Indeksy linii liczą się w liniach po `trimmedLines`. */
export interface Block {
  /** Góra bloku: linia kreski i jej rodzaj (`bare` albo `status`). */
  readonly top: BlockTop;
  /** Najbliższa niepusta linia nad górą jest kreską (blokiem nad blokiem): kształt takiego bloku nie dostaje. */
  readonly ruleAbove: boolean;
  /** Tytuł: pierwsza niepusta linia pod górą, bez białych znaków na brzegach, poza tym dosłownie. */
  readonly title: string;
  readonly titleLine: number;
  /**
   * Treść: niepuste linie między tytułem a pierwszą opcją po `unbox`, sklejone spacją, z białymi znakami zwiniętymi
   * do jednej spacji. W bloku bez cyfr: linie od tytułu do stopki (albo do dołu ekranu).
   */
  readonly bodyText: string;
  /** Surowe linie opcji (z wcięciem i markerem fokusu), w kolejności ekranu; `[]` w bloku bez cyfr. */
  readonly optionLines: readonly string[];
  /** Opcje z `optionRegion` (cyfry z tych samych linii), w kolejności ekranu. */
  readonly options: readonly ScreenOption[];
  /** Niepuste linie między pierwszą a ostatnią linią opcji, które same opcjami nie są (bez brzegowych spacji). */
  readonly between: readonly string[];
  /** Niepuste linie pod ostatnią opcją, do dołu ekranu (bez brzegowych spacji); `[]` w bloku bez cyfr. */
  readonly below: readonly string[];
  /**
   * Footer: every non-empty line from the first key line under the options (in a block without digits: under the
   * title) to the bottom of the block, trimmed and joined with a space, so a wrapped footer reads whole; `null` = none.
   */
  readonly footer: string | null;
  /** Every line under the top rule to the bottom of the screen, top to bottom (blank lines included). */
  readonly rows: readonly BlockRow[];
  /** Tryb zatwierdzania z `optionRegion`; `null` w bloku bez cyfr. */
  readonly submit: 'digit' | 'digit-enter' | null;
  /** Odcisk bloku: linie od góry w dół ekranu, formuła `blockPrint` (16 znaków hex). */
  readonly print: string;
}

/** Blok dialogu z ekranu albo `null`, gdy ekran nie ma bloku z tytułem (patrz nagłówek modułu). */
export function readBlock(text: string): Block | null {
  const lines = trimmedLines(text);
  if (lines.length === 0) return null;
  const found = optionRegion(lines);
  if (found !== null) return blockWithOptions(lines, found);
  const top = blockTopOf(lines, lines.length);
  return top === null ? null : blockWithoutDigits(lines, top);
}

/** Blok z regionem opcji: góra to najbliższa kreska bloku nad pierwszą opcją, tytuł pierwsza niepusta linia pod nią. */
function blockWithOptions(lines: readonly string[], found: OptionRegion): Block | null {
  const top = blockTopOf(lines, found.firstOption, { nearest: true });
  if (top === null) return null;
  const titleLine = firstFilled(lines, top.line + 1, found.firstOption);
  if (titleLine === -1) return null;
  const last = found.regionStart + found.region.findLastIndex((line) => OPTION_LINE_PATTERN.test(line));
  const optionLines: string[] = [];
  const between: string[] = [];
  for (let i = found.firstOption; i <= last; i += 1) {
    const line = lines[i] ?? '';
    if (OPTION_LINE_PATTERN.test(found.region[i - found.regionStart] ?? '')) optionLines.push(line);
    else if (line.trim() !== '') between.push(line.trim());
  }
  const below = filled(lines.slice(last + 1));
  const footerAt = lines.findIndex((line, i) => i > last && KEY_FOOTER_PATTERN.test(line.trim()));
  return {
    top,
    ruleAbove: ruleAbove(lines, top.line),
    title: (lines[titleLine] ?? '').trim(),
    titleLine,
    bodyText: joined(lines.slice(titleLine + 1, found.firstOption)),
    optionLines,
    options: found.options,
    between,
    below,
    footer: footerAt === -1 ? null : footerText(lines, footerAt),
    rows: rowsUnder(lines, top.line),
    submit: found.submit,
    print: blockPrint(lines, top.line, found),
  };
}

function blockWithoutDigits(lines: readonly string[], top: BlockTop): Block | null {
  const under = lines.slice(top.line + 1);
  const footerAt = under.findIndex((line) => KEY_FOOTER_PATTERN.test(line.trim()));
  if (DASH_RULE_PATTERN.test((lines[top.line] ?? '').trim()) && footerAt === -1) return null;
  const titleLine = firstFilled(lines, top.line + 1, lines.length);
  if (titleLine === -1) return null;
  const footerLine = footerAt === -1 ? -1 : top.line + 1 + footerAt;
  return {
    top,
    ruleAbove: ruleAbove(lines, top.line),
    title: (lines[titleLine] ?? '').trim(),
    titleLine,
    bodyText: joined(lines.slice(titleLine + 1, footerLine > titleLine ? footerLine : lines.length)),
    optionLines: [],
    options: [],
    between: [],
    below: [],
    footer: footerLine > titleLine ? footerText(lines, footerLine) : null,
    rows: rowsUnder(lines, top.line),
    submit: null,
    print: blockPrint(lines, top.line, null),
  };
}

/** Non-empty lines from `from` to the bottom of the screen, trimmed and joined with a space. */
function footerText(lines: readonly string[], from: number): string {
  return filled(lines.slice(from)).join(' ');
}

/** Lines under the top rule to the bottom of the screen, with their indexes. */
function rowsUnder(lines: readonly string[], top: number): BlockRow[] {
  return lines.slice(top + 1).map((text, k) => ({ index: top + 1 + k, text }));
}

/** Indeks pierwszej niepustej linii w `[from, to)`; `-1` = brak. */
function firstFilled(lines: readonly string[], from: number, to: number): number {
  for (let i = from; i < to; i += 1) {
    if ((lines[i] ?? '').trim() !== '') return i;
  }
  return -1;
}

/** Niepuste linie bez brzegowych spacji. */
function filled(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * Niepuste linie po `unbox`, sklejone spacją, białe znaki zwinięte do jednej spacji. Linia, z której `unbox` zdjąłby
 * wszystko (sama krawędź ramki `│`), zostaje dosłownie: znika z treści tylko linia pusta, więc wstawiona kreska
 * ramki zmienia treść i kształt jej nie przyjmie.
 */
function joined(lines: readonly string[]): string {
  return lines
    .map((line) => unbox(line) || line.trim())
    .filter((line) => line !== '')
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Czy najbliższa niepusta linia nad górą bloku jest kreską: kreską bloku (`blockTopOf` wskazuje tę właśnie linię)
 * albo kreską regionu (`HORIZONTAL_RULE_PATTERN`). Kreska wstawiona między górę a tytuł staje się górą, a tytuł
 * zostaje pod nią; ta flaga to odróżnia.
 */
function ruleAbove(lines: readonly string[], top: number): boolean {
  let above = top - 1;
  while (above >= 0 && (lines[above] ?? '').trim() === '') above -= 1;
  if (above < 0) return false;
  return blockTopOf(lines, above + 1)?.line === above || HORIZONTAL_RULE_PATTERN.test((lines[above] ?? '').trim());
}
