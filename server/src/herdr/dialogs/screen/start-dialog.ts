/**
 * Start dialog: a screen herdr reads as ready (`idle`, `interactive_ready`) while Claude Code has not reached its
 * prompt field, because a dialog stands before it. The predicate says whether such a screen stands and, for the
 * measured external imports dialog, which one. It is pure: what the launcher does with the answer (the wait, the
 * stable screen over time) lives in `herdr/start-dialog-wait.ts`; no key ever comes from here.
 *
 * The external imports dialog is proven from the bottom of the screen: its key footer as the last line and, above
 * it, the closed pair of its two options with exactly one `❯`. A long import list pushes the block's rule, title and
 * first paths above the pane edge, so neither the rule nor the title is required; when the rule is on the screen,
 * the line under it must be the measured title.
 */
import { composerRegionState } from '../../../drivers/herdr/commands.ts';
import { blockTopOf } from './region.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';
import { MEANINGFUL_PATTERN, trimmedLines } from './text.ts';

/** Start dialogs recognised by their whole signature. */
export type StartDialogId = 'external-imports';

/** A start dialog read from the screen. */
export interface StartDialog {
  /** The recognised dialog; `null` = a screen without the prompt field that matches no signature. */
  readonly id: StartDialogId | null;
  /** The first line under the block's bare rule, trimmed; `null` when no rule is on the screen. */
  readonly title: string | null;
}

const TITLE = SCREEN_SIGNATURES.startDialogImportsTitle.pattern;
const NO_OPTION = SCREEN_SIGNATURES.startDialogImportsNoOption.pattern;
const YES_OPTION = SCREEN_SIGNATURES.startDialogImportsYesOption.pattern;
const OPTION_LINE = SCREEN_SIGNATURES.startDialogImportsOptionLine.pattern;
const FOOTER = SCREEN_SIGNATURES.startDialogImportsFooter.pattern;

const blank = (line: string | undefined): boolean => (line ?? '').trim() === '';

/** The first non-blank line under the nearest bare block rule above line `end`, trimmed; `null` without a rule. */
function blockTitle(lines: readonly string[], end: number): string | null {
  const top = blockTopOf(lines, end, { kinds: ['bare'] });
  if (top === null) return null;
  for (let at = top.line + 1; at < end; at += 1) {
    if (!blank(lines[at])) return (lines[at] ?? '').trim();
  }
  return null;
}

/**
 * Index of the "No" line of the external imports option pair, or `null`: the footer is the last line, only blank
 * lines stand between it and the pair, the pair is "No" then "Yes" with the measured margin and exactly one `❯`, and
 * the line above the pair is blank (or above the pane edge), so no third option hides there.
 */
function importsPairAt(lines: readonly string[]): number | null {
  const footer = lines.length - 1;
  if (footer < 0 || !FOOTER.test((lines[footer] ?? '').trim())) return null;
  let at = footer - 1;
  while (at >= 0 && blank(lines[at])) at -= 1;
  const yes = OPTION_LINE.exec(lines[at] ?? '');
  const no = OPTION_LINE.exec(lines[at - 1] ?? '');
  if (yes === null || no === null || !blank(lines[at - 2])) return null;
  if (!NO_OPTION.test(no[2] ?? '') || !YES_OPTION.test(yes[2] ?? '')) return null;
  return (no[1] === undefined) === (yes[1] === undefined) ? null : at - 1;
}

/**
 * The start dialog on `screenText`, or `null` when the screen shows no start dialog: the prompt field is visible
 * (Claude Code reached its prompt) or the screen has no text at all (nothing was drawn or read).
 *
 * @param screenText raw pane screen (ANSI allowed)
 */
export function startDialogOf(screenText: string): StartDialog | null {
  const lines = trimmedLines(screenText);
  if (!lines.some((line) => MEANINGFUL_PATTERN.test(line))) return null;
  if (composerRegionState(screenText) !== 'unknown') return null;
  const pair = importsPairAt(lines);
  if (pair !== null) {
    const title = blockTitle(lines, pair);
    if (title === null || TITLE.test(title)) return { id: 'external-imports', title };
  }
  return { id: null, title: blockTitle(lines, lines.length) };
}
