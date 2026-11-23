/**
 * Style and width rules of the step screen: colours, visible width, truncation of the live line, word wrap of
 * finished lines, short paths and short local versions. Pure functions over strings; nothing here touches the
 * terminal or the environment (the terminal description comes from `CliIo.terminal`). Widths are terminal columns:
 * a wide character (CJK, full width, emoji) takes two.
 */
import { displayWidth } from '../../herdr/dialogs/screen/operation.ts';

/** Layout width when the terminal does not report its columns (pipe, `script` without a window size). */
export const LAYOUT_DEFAULT = 60;
/** Widest layout, also on a wide terminal: long lines are hard to read. */
export const LAYOUT_MAX = 72;

export interface Layout {
  /** Columns the terminal reports (or {@link LAYOUT_DEFAULT}). */
  readonly columns: number;
  /** Width the screen lays its lines out for: `min(columns, LAYOUT_MAX)`. */
  readonly width: number;
  /** Widest live line: one column less than the terminal, so a redrawn line never wraps. */
  readonly liveMax: number;
}

/** Layout for a terminal with `columns` columns; `0` or a missing value means {@link LAYOUT_DEFAULT}. */
export function layoutOf(columns: number | undefined): Layout {
  const cols = columns !== undefined && Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : LAYOUT_DEFAULT;
  const width = Math.min(cols, LAYOUT_MAX);
  return { columns: cols, width, liveMax: Math.max(1, Math.min(width, cols - 1)) };
}

/** Colours of the step screen; `gray` is the dimmed text (paths, `Log:`, times), `bold` the labels and the header. */
export type Tone = 'green' | 'red' | 'yellow' | 'gray' | 'cyan' | 'bold';

/** SGR codes: the attribute on, and its default back. */
const SGR: Readonly<Record<Tone, readonly [number, number]>> = {
  green: [32, 39],
  red: [31, 39],
  yellow: [33, 39],
  gray: [90, 39],
  cyan: [36, 39],
  bold: [1, 22],
};

/** `text` in colour `tone` when `color` is on; otherwise unchanged (no escape bytes at all). */
export function paint(text: string, tone: Tone, color: boolean): string {
  if (!color || text === '') return text;
  const [on, off] = SGR[tone];
  return `\x1b[${String(on)}m${text}\x1b[${String(off)}m`;
}

/** Visible width in terminal columns: two for a wide character, one for any other code point. */
export function visibleWidth(text: string): number {
  return displayWidth(text);
}

/** The longest start of `text` that fits in `max` columns, and the rest. */
function takeColumns(text: string, max: number): readonly [string, string] {
  let used = 0;
  let taken = '';
  for (const char of text) {
    const width = displayWidth(char);
    if (used + width > max) break;
    used += width;
    taken += char;
  }
  return [taken, text.slice(taken.length)];
}

/** The longest end of `text` that fits in `max` columns. */
function lastColumns(text: string, max: number): string {
  const chars = [...text];
  let used = 0;
  let start = chars.length;
  while (start > 0) {
    const width = displayWidth(chars[start - 1] ?? '');
    if (used + width > max) break;
    used += width;
    start -= 1;
  }
  return chars.slice(start).join('');
}

/**
 * Text from outside (a result, a path, a child's line) made safe for one screen line: escape sequences and control
 * characters go away, tabs become spaces. A stray `\r` or `ESC` would break the redraw of the live line.
 */
export function clean(text: string): string {
  return text
    // Terminal escape sequences (CSI), then the remaining C0 controls and DEL.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\t/gu, ' ')
    .replace(/[\x00-\x1f\x7f]/gu, '');
}

/** `text` cut to `max` visible columns, the last one `…` when something was cut. */
export function truncate(text: string, max: number): string {
  if (visibleWidth(text) <= max) return text;
  if (max <= 0) return '';
  return `${takeColumns(text, max - 1)[0]}…`;
}

/**
 * Greedy word wrap: the first line at most `first` columns, the next ones at most `rest`. A word longer than a line
 * is split, so no line is ever wider than its limit: a path after its last `/` that fits (the next line starts with a
 * whole name), any other word hard.
 */
export function wrapWords(text: string, first: number, rest: number): string[] {
  const lines: string[] = [];
  let line = '';
  const limit = (): number => Math.max(1, lines.length === 0 ? first : rest);
  for (const word of text.split(/\s+/u).filter((w) => w !== '')) {
    let piece = word;
    for (;;) {
      const sep = line === '' ? '' : ' ';
      if (visibleWidth(line) + sep.length + visibleWidth(piece) <= limit()) {
        line += sep + piece;
        break;
      }
      if (line !== '') {
        lines.push(line);
        line = '';
        continue;
      }
      // At least one character per line, so a wide character on a one-column line cannot loop forever.
      const [head] = takeColumns(piece, limit());
      const slash = head.lastIndexOf('/');
      const taken = slash > 0 && slash < piece.length - 1 ? head.slice(0, slash + 1) : head;
      const cut = taken === '' ? [...piece].slice(0, 1).join('') : taken;
      lines.push(cut);
      piece = piece.slice(cut.length);
      if (piece === '') break;
    }
  }
  if (line !== '' || lines.length === 0) lines.push(line);
  return lines;
}

/** A path in a result: starts with `~/` or `/` and has a second `/`; trailing punctuation stays outside. */
const PATH_TOKEN = /(?<=^|[\s(])(?:~|)\/[^\s/]*\/\S*?(?=[:,;)]?(?:\s|$))/gu;

/** `text` with every path in it dimmed (`gray`) when `color` is on; widths are unchanged. */
export function dimPaths(text: string, color: boolean): string {
  return color ? text.replace(PATH_TOKEN, (found) => paint(found, 'gray', true)) : text;
}

/**
 * Path for the screen: the home directory as `~`, and a path longer than `max` columns shortened in the middle
 * (`…`), keeping more of the end, where the file name is. The log keeps full paths.
 */
export function shortPath(file: string, home: string, max: number): string {
  let shown = clean(file);
  if (home !== '' && home !== '/' && (shown === home || shown.startsWith(`${home}/`))) {
    shown = `~${shown.slice(home.length)}`;
  }
  if (visibleWidth(shown) <= max) return shown;
  if (max < 3) return truncate(shown, max);
  const keep = max - 1;
  const head = Math.floor(keep / 3);
  const start = takeColumns(shown, head)[0];
  return `${start}…${lastColumns(shown, keep - visibleWidth(start))}`;
}

/**
 * Short form of a local build version (`0.1.1-local.<stamp>.<commit>` → `…<7 commit chars>`); the full version is
 * shown once in the header. Any other version stays as it is.
 */
export function shortVersion(version: string): string {
  const match = /^.+-local\.[0-9]+\.([0-9a-f]{7,40})$/u.exec(version);
  return match?.[1] === undefined ? version : `…${match[1].slice(0, 7)}`;
}

/** Duration for a step line: empty below 1 s, `3 s`, `1 min 5 s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)} s`;
  return `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`;
}
