/**
 * Prose a command prints outside the step screen, made to fit a terminal: the usage text of `--help`
 * and one-line refusals. On a terminal a line wider than the layout width is wrapped at word boundaries (a path breaks
 * after a `/`); without a terminal the text stays as written, so a pipe or a script gets the same lines everywhere.
 * Pure functions over strings and the terminal description; nothing here writes.
 */
import { terminalOf } from '../io.ts';
import type { CliIo } from '../io.ts';
import { layoutOf, visibleWidth, wrapWords } from './style.ts';

/** Indent of the description lines of a usage text (the command lines have less). */
const DESCRIPTION_INDENT = 6;

/** Extra indent of the continuation of a wrapped command line, so it does not read as a new command. */
const COMMAND_CONTINUATION = 4;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Stands for a space inside a `<placeholder>` while it wraps, so `<data directory>` never breaks in two: a private-use
 * character, which no whitespace pattern matches (a no-break space would).
 */
const KEEP = '\ue000';

/** Words of `body` wrapped to `width`, the first line under `first` and the rest under `rest` columns of indent. */
function wrapAt(body: string, first: number, rest: number, width: number): string[] {
  const kept = body.replace(/<[^<>]*>/gu, (inside) => inside.replaceAll(' ', KEEP));
  return wrapWords(kept, width - first, width - rest)
    .map((part, index) => `${' '.repeat(index === 0 ? first : rest)}${part.replaceAll(KEEP, ' ')}`);
}

/**
 * A usage text laid out for `width` columns. The description lines of one block (indent of at least
 * {@link DESCRIPTION_INDENT}) are one paragraph: when one of them is too wide, the paragraph reflows at word
 * boundaries under its indent, so no word is left alone on a line. A description line that starts with `--` (an
 * option, `--verbose: …`) starts a new paragraph, so it never runs into the sentence before it. A command line that
 * is too wide wraps {@link COMMAND_CONTINUATION} deeper, so it does not read as a new command. A `<placeholder>` never
 * breaks; a block that fits stays as written.
 */
export function wrapUsage(text: string, width: number): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    const first = paragraph[0];
    if (first === undefined) return;
    if (paragraph.every((line) => visibleWidth(line) <= width)) out.push(...paragraph);
    else out.push(...wrapAt(paragraph.map((line) => line.trim()).join(' '), indentOf(first), indentOf(first), width));
    paragraph = [];
  };
  for (const line of text.split('\n')) {
    const indent = indentOf(line);
    const body = line.trim();
    if (indent >= DESCRIPTION_INDENT && body !== '') {
      const open = paragraph[0];
      if (open === undefined || indentOf(open) !== indent || body.startsWith('--')) flush();
      paragraph.push(line);
      continue;
    }
    flush();
    out.push(...(visibleWidth(line) <= width ? [line] : wrapAt(body, indent, indent + COMMAND_CONTINUATION, width)));
  }
  flush();
  return out.join('\n');
}

/** The usage text for the terminal of `io`: wrapped to its layout width, or as written without a terminal. */
export function usageFor(io: CliIo, text: string): string {
  const terminal = terminalOf(io);
  return terminal.tty ? wrapUsage(text, layoutOf(terminal.columns).width) : text;
}

/** A one-line sentence (a refusal) for the terminal of `io`: wrapped to its layout width, or one line without one. */
export function sentenceFor(io: CliIo, text: string): string {
  const terminal = terminalOf(io);
  if (!terminal.tty) return text;
  const { width } = layoutOf(terminal.columns);
  return wrapWords(text, width, width).join('\n');
}
