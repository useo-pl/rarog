/**
 * Dialog zaufania folderu BEZ cyfr: osobny parser, bo cała ścieżka cyfrowa (`parseOptions`) wymaga
 * numerowanych opcji, a ten dialog ma `❯` przed jedną z dwóch etykiet i stopkę „Enter to confirm · Esc to cancel”
 * (pomiar na CLI 2.1.319: `down` przenosi `❯` z „No, exit” na „Yes, I trust this folder”).
 *
 * Parser rozpoznaje WYŁĄCZNIE pełny render: goła kreska bloku, tytuł „Accessing workspace:”, zdanie zaufania
 * w treści bloku, folder w jednej linii pod tytułem, dokładnie dwie opcje w kolejności „No…”, „Yes…” z dokładnie
 * jednym `❯` i stopka jako ostatnia linia ekranu. Wcięcia są te z pomiaru: treść bloku ma margines jednej spacji,
 * opcja ma po nim kolumnę kursora. Poza parą opcji blok nie ma żadnego `❯` ani linii w kształcie opcji (wcięcie
 * kolumny kursora, etykieta opcji, cyfra), także oddzielonej pustą linią. Każdy inny kształt (trzecia opcja, ucięta
 * góra albo dół, cyfry, zawinięty folder) daje `null`, czyli kartę bez przycisku. Moduł jest czysty: decyzję
 * o klawiszu podejmuje `send/trust-step.ts`.
 *
 * One exception to the option-shaped line rule: the warning about permissions the folder pre-approves (Claude Code
 * 2.1.332). Between its opening line "⚠ This folder pre-approves …:" and its closing sentence "These will apply
 * without asking." a line may carry the three-space margin of the permission list, which is the indent of an option
 * line. The folder's settings write that list, so it still may not hold `❯`, an option label or a numbered option,
 * and a warning without its closing sentence gives `null`.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { dialogBlock } from './block.ts';
import { unbox } from './options.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';
import { trimmedLines } from './text.ts';

/** Gdzie stoi `❯`: na opcji odmowy albo na opcji zgody. */
export type TrustCursor = 'no' | 'yes';

/** Dialog zaufania bez cyfr odczytany z ekranu. */
export interface TrustArrowDialog {
  /**
   * Folder z jednej linii pod tytułem bez marginesu CLI (jednej spacji); pozostałe znaki, także spacje w nazwie,
   * zostają. Folderu zawiniętego na więcej linii parser nie składa (patrz {@link parseTrustArrowDialog}).
   */
  readonly folder: string;
  /**
   * Odcisk bloku: linie od kreski do stopki, SHA-256, 16 znaków hex. Linie opcji wchodzą jako same etykiety, więc
   * ruch `❯` odcisku nie zmienia (ten sam przed `down` i po nim), a podmiana folderu albo treści go zmienia.
   */
  readonly bodyPrint: string;
  readonly cursor: TrustCursor;
  /** Etykieta opcji zgody z ekranu — do dziennika (`optionLabel`). */
  readonly yesLabel: string;
}

const NO_OPTION = SCREEN_SIGNATURES.trustArrowNoOption.pattern;
const YES_OPTION = SCREEN_SIGNATURES.trustArrowYesOption.pattern;
const OPTION_LINE = SCREEN_SIGNATURES.trustArrowOptionLine.pattern;
const CURSOR_MARK = SCREEN_SIGNATURES.trustArrowCursorMark.pattern;
const CONTENT_LINE = SCREEN_SIGNATURES.trustArrowContentLine.pattern;
const DIGIT_OPTION = SCREEN_SIGNATURES.optionLine.pattern;
const FOOTER = SCREEN_SIGNATURES.trustArrowFooter.pattern;
const WARNING_OPEN = SCREEN_SIGNATURES.trustArrowWarningOpen.pattern;
const WARNING_CLOSE = SCREEN_SIGNATURES.trustArrowWarningClose.pattern;
const WARNING_LIST_LINE = SCREEN_SIGNATURES.trustArrowWarningListLine.pattern;

const blank = (line: string | undefined): boolean => (line ?? '').trim() === '';

/** Opcja z dokładnym wcięciem z pomiaru albo `null`: linia bez kolumny kursora opcją nie jest. */
function optionOf(line: string): { label: string; cursor: boolean } | null {
  const match = OPTION_LINE.exec(line);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { label: match[2], cursor: CURSOR_MARK.test(match[1]) };
}

/**
 * Linia bloku poza parą opcji, która nie może być drugą pozycją listy: pusta albo treść z marginesem jednej spacji,
 * bez `❯` i bez etykiety opcji (z cyfrą albo bez).
 */
function plainLine(line: string): boolean {
  return blank(line) || textOf(line, CONTENT_LINE) !== null;
}

/** Text of a block line with the given margin, or `null`: no such margin, `❯`, an option label or a numbered option. */
function textOf(line: string, margin: RegExp): string | null {
  const text = margin.exec(line)?.[1];
  if (text === undefined || CURSOR_MARK.test(line)) return null;
  return NO_OPTION.test(text) || YES_OPTION.test(text) || DIGIT_OPTION.test(text) ? null : text;
}

/**
 * Whether the block lines outside the option pair hold no further list position. A line is blank or block text with
 * the one-space margin. Inside the pre-approved permissions warning a line is never blank and may carry the
 * three-space margin of the permission list instead; the warning must close before the option pair.
 */
function onlyPlainLines(lines: readonly string[], from: number, to: number, first: number, last: number): boolean {
  let inWarning = false;
  for (let index = from; index < to; index += 1) {
    const line = lines[index] ?? '';
    if (index === first || index === last) {
      if (inWarning) return false;
    } else if (inWarning) {
      const text = textOf(line, CONTENT_LINE);
      if (text === null && textOf(line, WARNING_LIST_LINE) === null) return false;
      if (text !== null && WARNING_CLOSE.test(text)) inWarning = false;
    } else {
      if (!plainLine(line)) return false;
      inWarning = WARNING_OPEN.test(textOf(line, CONTENT_LINE) ?? '');
    }
  }
  return !inWarning;
}

/**
 * Dialog zaufania bez cyfr albo `null`, gdy ekran nie pokazuje go w całości.
 *
 * Folder musi mieścić się w jednej linii, bo zawinięcie chowa spację na granicy linii: zdania treści tego bloku
 * łamią się na spacji, a żadna z dwóch linii jej nie pokazuje (`kontrolny/zaufanie-2.1.319.txt`). Linie
 * „/Users/u/My” i „project” to więc równie dobrze `/Users/u/Myproject`, jak `/Users/u/My project`, i parser odmawia,
 * zamiast zgadywać.
 *
 * @param screenText surowy ekran z `agent.read`
 */
export function parseTrustArrowDialog(screenText: string): TrustArrowDialog | null {
  const lines = trimmedLines(screenText);
  const footer = lines.length - 1;
  if (footer < 0 || !FOOTER.test((lines[footer] ?? '').trim())) return null;
  let at = footer - 1;
  while (at >= 0 && blank(lines[at])) at -= 1;
  const last = at;
  while (at >= 0 && !blank(lines[at])) at -= 1;
  const first = at + 1;
  if (last - first + 1 !== 2) return null;
  const no = optionOf(lines[first] ?? '');
  const yes = optionOf(lines[last] ?? '');
  if (no === null || yes === null) return null;
  if (!NO_OPTION.test(no.label) || !YES_OPTION.test(yes.label) || no.cursor === yes.cursor) return null;

  const block = dialogBlock(lines, first);
  if (block.ambiguous || block.top === -1 || block.title?.kind !== 'known' || block.title.id !== 'trust') return null;
  // Od kreski do stopki jedyną listą jest para opcji: pusta linia nie chowa dodatkowej pozycji.
  if (!onlyPlainLines(lines, block.top + 1, footer, first, last)) return null;
  const content = lines.slice(block.top + 1, first).map(unbox).join(' ');
  if (!SCREEN_SIGNATURES.knownDialogTrust.pattern.test(content)) return null;

  let line = block.titleLine + 1;
  while (line < first && blank(lines[line])) line += 1;
  // Ucinamy wyłącznie margines CLI; niepusta linia tuż pod folderem to możliwe zawinięcie, czyli odmowa.
  const folder = line < first ? CONTENT_LINE.exec(lines[line] ?? '')?.[1] : undefined;
  if (folder === undefined || !blank(lines[line + 1])) return null;
  if (!(folder.startsWith('/') || folder === '~' || folder.startsWith('~/'))) return null;

  const body = lines.slice(block.top + 1).map((text, k) => {
    const index = block.top + 1 + k;
    if (index === first) return no.label;
    if (index === last) return yes.label;
    return text;
  }).join('\n');
  return {
    folder,
    bodyPrint: createHash('sha256').update(body).digest('hex').slice(0, 16),
    cursor: no.cursor ? 'no' : 'yes',
    yesLabel: yes.label,
  };
}

/**
 * Czy folder z dialogu to `cwd` sesji? CLI pokazuje folder pod katalogiem domowym z `~` (zrzut odmowy z CLI
 * 2.1.311), więc `~` rozwijamy katalogiem domowym serwera. Inny katalog domowy panelu daje `false`: odmowę, nigdy
 * klawisz w cudzy folder.
 */
export function trustFolderIs(folder: string, cwd: string, home: string): boolean {
  const expanded = folder === '~' ? home : folder.startsWith('~/') ? path.join(home, folder.slice(2)) : folder;
  if (!path.isAbsolute(expanded) || !path.isAbsolute(cwd)) return false;
  return path.resolve(expanded) === path.resolve(cwd);
}
