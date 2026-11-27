/**
 * Which numbered run of a region is the option list: the one that stands directly above the key footer.
 *
 * A dialog body can carry its own numbered list above the options (a plan's phases, a summary), and a wrapped
 * question can start a line with a digit and a dot. Three rules keep those lines off the buttons. Pure functions over
 * region lines; they know no dialog titles or tool names, the CLI look comes from `SCREEN_SIGNATURES`. `optionRegion`
 * (`parse.ts`) calls them; `questionFrom` (`form.ts`) calls `gutterText` for the card text.
 */
import { OPTION_LINE_PATTERN, inOptionDescription, optionsCloseRegion, unbox, unframe } from './options.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';

const KEY_FOOTER_PATTERN = SCREEN_SIGNATURES.dialogKeyFooter.pattern;
const DIGITLESS_FOCUS_PATTERN = SCREEN_SIGNATURES.digitlessFocusLine.pattern;
const OPTION_NUMBER_PATTERN = SCREEN_SIGNATURES.optionNumber.pattern;
const LEFT_EDGE_PATTERN = SCREEN_SIGNATURES.boxEdgeStart.pattern;
const RIGHT_EDGE_PATTERN = SCREEN_SIGNATURES.boxEdgeEnd.pattern;

/**
 * A region line for shape recognition: `unbox`, except that a numbered line behind a left edge with no right edge
 * keeps that edge and so is not an option line. The CLI draws a wrapped question behind such a gutter (fixture
 * `dialog-askuserquestion-multiq-pytanie-w-ramce.txt`), and the wrap can start a line with a digit and a dot
 * ("…restores" / "1. The banner…"); read as an option it would repeat a digit and void the form, or add a button the
 * form does not have. Options inside a dialog frame carry both edges.
 */
export function regionLine(line: string): string {
  const text = unbox(line);
  const trimmed = line.trim();
  if (!OPTION_LINE_PATTERN.test(text)) return text;
  return LEFT_EDGE_PATTERN.test(trimmed) && !RIGHT_EDGE_PATTERN.test(trimmed) ? trimmed : text;
}

/** The text of a region line for the card: a numbered line that kept its gutter ({@link regionLine}) loses it here. */
export function gutterText(line: string): string {
  const text = line.replace(LEFT_EDGE_PATTERN, '').trim();
  return text !== line && OPTION_LINE_PATTERN.test(text) ? text : line;
}

/**
 * Start (index in the region) of the last numbered run, when that run ends the dialog; `-1` otherwise.
 *
 * Called only for a region whose numbered lines contradict each other (a digit or label repeats). The run is the
 * bottom option line and every option line above it, walking up over blank lines, lines indented deeper than its
 * digit (wrapped labels) and descriptions of an option above (`inOptionDescription`, also in the digit's column); the
 * first other line at the digit's column or left of it (body text) ends the walk. Under the run there may be only
 * blank lines and footer chrome, and above it the region must hold other numbered lines: else the contradiction is
 * inside one form (a repaint, a repeated digit under a description), and the region stays unreadable. A wrong digit
 * on a button is worse than no button, so a line that may be a description never splits a form.
 *
 * @param region region lines after `unbox`
 * @param raw the same lines after `unframe` (indentation kept); indices match `region`
 */
export function lastRunStart(region: readonly string[], raw: readonly string[]): number {
  const last = region.findLastIndex((line) => OPTION_LINE_PATTERN.test(line));
  if (last === -1) return -1;
  if (!optionsCloseRegion(region)) return -1;
  const column = (raw[last] ?? '').search(OPTION_NUMBER_PATTERN);
  let start = last;
  for (let i = last - 1; i >= 0; i -= 1) {
    const line = raw[i] ?? '';
    if (line.trim() === '') continue;
    if (OPTION_LINE_PATTERN.test(region[i] ?? '')) {
      start = i;
      continue;
    }
    if (line.search(/\S/) > column || inOptionDescription(region, raw, i)) continue;
    return region.slice(0, i).some((above) => OPTION_LINE_PATTERN.test(above)) ? start : -1;
  }
  return -1;
}

/**
 * Whether a digitless choice stands under the numbered lines: a line with the cursor `❯` and no digit below the last
 * numbered line, and a key footer below it. The dialog is then answered with arrows, and the numbered lines above
 * are its body, so they must not become buttons.
 *
 * @param lines raw region lines (cursor kept)
 */
export function digitlessChoiceBelow(lines: readonly string[]): boolean {
  const last = lines.findLastIndex((line) => OPTION_LINE_PATTERN.test(unbox(line)));
  if (last === -1) return false;
  const focus = lines.findIndex((line, i) => i > last && DIGITLESS_FOCUS_PATTERN.test(unframe(line).trim()));
  return focus !== -1 && lines.slice(focus + 1).some((line) => KEY_FOOTER_PATTERN.test(unbox(line)));
}
