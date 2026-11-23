/**
 * Whether an agent message asks the owner something, for the `asksOwner` field of the voice agent's session catalog:
 * a paragraph of the top level of a text block that starts with a bold marker (`**Do Ciebie:**`, `**To you:**`). The
 * block structure follows the app's markdown parser line by line, so the server flags a message when the app marks its
 * question in the transcript; the shared table `shared/fixtures/companion/asks-owner.json` keeps the two equal on its
 * rows. The bold marker is checked without the app's inline parser, so an unusual opening or closing of the bold can
 * differ (`docs/companion.md`, "Session catalog"). A marker inside a code block, a list item, a quote, a heading or
 * a table, or after a single line break inside a paragraph, does not count. It reads text only; which message and
 * which session state count is the catalog's matter.
 */
import type { TranscriptMessage } from '@rarog/shared';

/** The markers literally, with the colon and the case: the Polish one and the English one for agents writing English. */
export const ASKS_OWNER_MARKERS: readonly string[] = ['Do Ciebie:', 'To you:'];

/** A paragraph that opens a question: 2–3 equal emphasis characters, the marker, and a closing pair of them later. */
const QUESTION_OPENING = /^([*_])\1{1,2}(?:Do Ciebie:|To you:)/u;
const HEADING = /^ {0,3}#{1,6}[ \t]/u;
const BULLET_ITEM = /^[-*+][ \t]/u;
const ORDERED_ITEM = /^\d{1,9}[.)][ \t]/u;
const DELIMITER_CELL = /^:?-+:?$/u;

interface Fence {
  readonly char: string;
  readonly count: number;
  readonly indent: number;
}

const leadingSpaces = (line: string): number => line.length - line.replace(/^ +/u, '').length;
const isBlank = (line: string): boolean => /^[ \t]*$/u.test(line);

/** Width of the indentation, a tab as four columns. */
function indentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

/** An opening fence: 3 or more equal backticks or tildes, indented at most 3 spaces; backtick info has no backtick. */
function fenceOf(line: string): Fence | null {
  const indent = leadingSpaces(line);
  if (indent > 3) return null;
  const body = line.slice(indent);
  const char = body[0];
  if (char !== '`' && char !== '~') return null;
  const run = body.length - body.replace(char === '`' ? /^`+/u : /^~+/u, '').length;
  if (run < 3) return null;
  if (char === '`' && body.slice(run).includes('`')) return null;
  return { char, count: run, indent };
}

/** A closing fence: the same character, a run at least as long as the opening one, nothing after it but blanks. */
function closes(fence: Fence, line: string): boolean {
  const indent = leadingSpaces(line);
  if (indent > 3) return false;
  const body = line.slice(indent);
  let run = 0;
  while (body[run] === fence.char) run += 1;
  return run >= fence.count && isBlank(body.slice(run));
}

/** `---`, `***`, `___`, also with blanks between the characters, indented at most 3 spaces. */
function isRule(line: string): boolean {
  if (leadingSpaces(line) > 3) return false;
  const body = line.replace(/[ \t]/gu, '');
  const first = body[0];
  return (first === '-' || first === '*' || first === '_') && body.length >= 3 && [...body].every((c) => c === first);
}

const isQuote = (line: string): boolean => leadingSpaces(line) <= 3 && line.slice(leadingSpaces(line)).startsWith('>');
const isListItem = (line: string): boolean => {
  const body = line.replace(/^[ \t]+/u, '');
  return BULLET_ITEM.test(body) || ORDERED_ITEM.test(body);
};

/** Cells of a table row: `\|` is a bar inside a cell; empty outer cells of `| a |` drop. */
function tableCells(line: string): string[] {
  const cells = line.split(/(?<!\\)\|/u).map((cell) => cell.trim());
  if (cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** The delimiter row of a table (`| --- | :-: |`): its column count, or `null`. */
function delimiterColumns(line: string): number | null {
  if (!line.includes('-')) return null;
  const cells = tableCells(line);
  if (cells.length === 0 || !cells.every((cell) => DELIMITER_CELL.test(cell))) return null;
  // One column without a bar is a rule or a setext underline, not a table.
  return cells.length === 1 && !line.includes('|') ? null : cells.length;
}

function isTableStart(line: string, next: string | undefined): boolean {
  if (next === undefined || !line.includes('|')) return false;
  const columns = delimiterColumns(next);
  const head = tableCells(line).length;
  return columns !== null && head > 0 && head === columns;
}

/** A line that starts a new block: it ends a paragraph and a list item without a blank line. */
function startsBlock(line: string, next: string | undefined): boolean {
  return fenceOf(line) !== null || HEADING.test(line) || isRule(line) || isQuote(line) || isTableStart(line, next);
}

/** The paragraphs of the top level of a text block, as the app's parser cuts them (leading blanks of a line dropped). */
function topLevelParagraphs(lines: readonly string[]): string[] {
  const out: string[] = [];
  let paragraph: string[] = [];
  // An open list: its items since the last code block inside it, and a blank line since the last item.
  let list: { items: number; sawBlank: boolean } | null = null;
  const flush = (): void => {
    if (paragraph.length > 0) out.push(paragraph.join('\n'));
    paragraph = [];
  };
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? '';
    const next = lines[at + 1];
    if (isBlank(line)) {
      flush();
      if (list !== null) list.sawBlank = true;
      at += 1;
      continue;
    }
    const fence = fenceOf(line);
    if (fence !== null) {
      flush();
      // A block indented under a list item belongs to it, and the list goes on after it; one at the margin ends it.
      list = fence.indent >= 2 && list !== null ? { items: 0, sawBlank: false } : null;
      at += 1;
      while (at < lines.length && !closes(fence, lines[at] ?? '')) at += 1;
      at += 1;
      continue;
    }
    if (list !== null) {
      if (!isRule(line) && isListItem(line)) {
        list = { items: list.items + 1, sawBlank: false };
        at += 1;
        continue;
      }
      if (list.items === 0) {
        list = null;
      } else if (list.sawBlank) {
        if (indentWidth(line) >= 2 && !startsBlock(line, next)) {
          list.sawBlank = false;
          at += 1;
          continue;
        }
        list = null;
      } else if (!startsBlock(line, next)) {
        // A continuation line of the item, also without indentation.
        at += 1;
        continue;
      } else {
        list = null;
      }
    }
    if (HEADING.test(line) || isRule(line)) {
      flush();
      at += 1;
      continue;
    }
    if (isQuote(line)) {
      flush();
      while (at < lines.length && isQuote(lines[at] ?? '')) at += 1;
      continue;
    }
    if (isTableStart(line, next)) {
      flush();
      at += 2;
      while (at < lines.length) {
        const row = lines[at] ?? '';
        if (row.trim() === '' || !row.includes('|') || startsBlock(row, lines[at + 1])) break;
        at += 1;
      }
      continue;
    }
    if (isListItem(line)) {
      flush();
      list = { items: 1, sawBlank: false };
      at += 1;
      continue;
    }
    paragraph.push(line.replace(/^[ \t]+/u, ''));
    at += 1;
  }
  flush();
  return out;
}

function opensQuestion(paragraph: string): boolean {
  const opening = paragraph.match(QUESTION_OPENING);
  if (opening === null) return false;
  // The bold has to close, or the app shows the stars as text and sees no marker.
  return paragraph.slice(opening[0].length).includes((opening[1] ?? '*').repeat(2));
}

/** Whether one text block asks the owner: a paragraph of its top level opens with a bold marker. */
export function textAsksOwner(text: string): boolean {
  if (!ASKS_OWNER_MARKERS.some((marker) => text.includes(marker))) return false;
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  return topLevelParagraphs(lines).some(opensQuestion);
}

/** Whether a message is an agent message with a text block that asks the owner; `undefined` (no message) does not. */
export function messageAsksOwner(message: TranscriptMessage | undefined): boolean {
  return message?.role === 'assistant'
    && message.blocks.some((block) => block.type === 'text' && textAsksOwner(block.text));
}
