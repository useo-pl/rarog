/**
 * The question zone of a `Bash` dialog: the lines between the bottom rule of the operation frame and the first option.
 * Under the `Bash` frame the CLI draws the question "Do you want to proceed?" and sometimes explanation lines above it
 * (an `ask` rule, a permission rule, a parser warning, "This command requires approval", the auto-deny countdown;
 * measured on CLI 2.1.294–2.1.328, a fixture next to each `bashZone…` entry of the signature registry). The read serves
 * ONLY the top proof of the consent channel (`layer1/top.ts`), for both `Bash` top paths: a title with a queue counter
 * does not carry the tool name, and the agent can type a listed title and a frame into the content of another dialog,
 * so the tail the CLI draws decides that the block is a `Bash` dialog, not the lines above it that the agent writes.
 *
 * The zone passes only when:
 *
 * - the last non-empty line is the question "Do you want to proceed?" itself (exact, without the bar), the only one in
 *   the zone;
 * - the screen lines above it split into logical lines from the closed list of the signature registry
 *   ({@link BASH_ZONE_LINES}): an exact string or a pattern matched against the WHOLE logical line; empty lines between
 *   logical lines do not count, and every screen line belongs to exactly one logical line;
 * - a logical line takes one screen line, or consecutive screen lines joined with a space: up to
 *   {@link BASH_ZONE_BARRED_RUN_MAX} lines that all carry the callout bar (`│ `), or two lines that both lack it. That
 *   is how the CLI wraps zone lines in a narrow pane (two lines measured on 2.1.302, 2.1.309, 2.1.311, the countdown on
 *   2.1.294; a barred paragraph over four lines on 2.1.328). An empty line or a change of the bar ends a run.
 *
 * Any other line (another tool's question, an MCP tool description, a `Read(…)` line, text appended to a listed line,
 * a second frame, an explanation off the list) gives `false`. The list has no free-text line except the rule in the
 * parentheses of the `Ask rule Bash(…)`, `Permission rule Bash(…)` and `Rule Bash(…) from …` lines (a rule from the
 * user's settings; the rule's source after `from` only from a closed list of measured phrases): a classifier reason
 * joins it only as a measured sentence, word for word, so any other reason stays a cost (approval at the desk).
 */
import { SCREEN_SIGNATURES } from './signatures.ts';

/** Zone lines above the question: the closed list from the signature registry, each with a `Bash` dialog fixture. */
export const BASH_ZONE_LINES: readonly (RegExp | string)[] = [
  SCREEN_SIGNATURES.bashZoneAskRule.pattern,
  SCREEN_SIGNATURES.bashZoneAskRuleHint.pattern,
  SCREEN_SIGNATURES.bashZonePermissionRule.pattern,
  SCREEN_SIGNATURES.bashZonePermissionsHint.pattern,
  SCREEN_SIGNATURES.bashZoneParserSkipped.pattern,
  SCREEN_SIGNATURES.bashZoneBraceQuote.pattern,
  SCREEN_SIGNATURES.bashZoneTildeAssignment.pattern,
  SCREEN_SIGNATURES.bashZoneVariableUnchecked.pattern,
  SCREEN_SIGNATURES.bashZoneQuotedUnchecked.pattern,
  SCREEN_SIGNATURES.bashZoneShellScriptRm.pattern,
  SCREEN_SIGNATURES.bashZoneDangerousRm.pattern,
  SCREEN_SIGNATURES.bashZoneShellExpansion.pattern,
  SCREEN_SIGNATURES.bashZoneApprovalRequired.pattern,
  SCREEN_SIGNATURES.bashZoneRuleOverridesAuto.pattern,
  SCREEN_SIGNATURES.bashZoneRuleSaysAsk.pattern,
  SCREEN_SIGNATURES.bashZoneDangerousRemoval.pattern,
  SCREEN_SIGNATURES.autoDenyCountdown.pattern,
];

/**
 * Most screen lines one logical zone line may take when every line carries the callout bar. The CLI flows a barred
 * paragraph to the pane width: the longest listed line, the removal warning (181 characters), takes four lines in
 * a 62-column (phone) and a 57-column pane on CLI 2.1.328. Six leave a margin of two lines for a narrower pane (by
 * word count about 40 columns for that paragraph; not measured). A longer run gives no match.
 */
export const BASH_ZONE_BARRED_RUN_MAX = 6;

/** Most screen lines one logical zone line may take without the bar (measured wraps take two). */
const PLAIN_RUN_MAX = 2;

const PROCEED_QUESTION = SCREEN_SIGNATURES.proceedQuestion.pattern;
const CALLOUT_BAR = SCREEN_SIGNATURES.bashZoneCalloutBar.pattern;

/** A zone screen line: the text without the margin and the callout bar, and whether the bar stood there. */
interface ZoneLine {
  readonly text: string;
  readonly bar: boolean;
}

function zoneLineOf(raw: string): ZoneLine {
  const line = raw.trim();
  const bar = CALLOUT_BAR.test(line);
  return { text: (bar ? line.replace(CALLOUT_BAR, '') : line).trim(), bar };
}

/** The pattern covers the whole text (not a part of it). */
function wholeMatch(pattern: RegExp, text: string): boolean {
  const found = pattern.exec(text);
  return found !== null && found.index === 0 && found[0].length === text.length;
}

/** The logical zone line is on the closed list. */
export function bashZoneLineListed(text: string): boolean {
  return BASH_ZONE_LINES.some((entry) => (typeof entry === 'string' ? text === entry : wholeMatch(entry, text)));
}

/** A zone screen line off the list (diagnostics): the text length in characters and the callout bar, no content. */
export interface BashZoneUnlistedLine {
  /** Characters (code points) of the text without the margin and the bar. */
  readonly chars: number;
  readonly bar: boolean;
}

/**
 * Why the zone does not pass ({@link bashZoneMiss}): `question` = the last non-empty line is not the question "Do you
 * want to proceed?" alone without the bar; `unlisted` = screen lines above the question that no listed line covers,
 * in screen order (diagnostics only, see {@link walkZone}).
 */
export type BashZoneMiss =
  | { readonly kind: 'question' }
  | { readonly kind: 'unlisted'; readonly lines: readonly BashZoneUnlistedLine[] };

/** A listed logical line that starts at a screen line: its joined text and the number of screen lines it takes. */
interface ZoneRun {
  readonly text: string;
  readonly length: number;
}

/**
 * Listed runs that start at the non-empty screen line `start`, shortest first: the line alone, then the line joined
 * with the following ones of the same bar while none is empty, up to the cap of that bar.
 */
function listedRuns(lines: readonly ZoneLine[], start: number): readonly ZoneRun[] {
  const first = lines[start];
  if (first === undefined) return [];
  const max = first.bar ? BASH_ZONE_BARRED_RUN_MAX : PLAIN_RUN_MAX;
  const runs: ZoneRun[] = [];
  let text = '';
  for (let length = 1; length <= max && start + length <= lines.length; length += 1) {
    const line = lines[start + length - 1];
    if (line === undefined || line.text === '' || line.bar !== first.bar) break;
    text = length === 1 ? line.text : `${text} ${line.text}`;
    if (bashZoneLineListed(text)) runs.push({ text, length });
  }
  return runs;
}

/**
 * One pass over the zone for {@link bashZoneLines} and {@link bashZoneMiss}. The zone passes when its lines above the
 * question split into listed runs; the split is decided from the end (whether the lines from each position on can be
 * split), so a shorter run never blocks a longer one that the rest needs. Of the splits, the one with the shortest run
 * at each position is taken, so a zone that splits into single lines and two-line wraps keeps those lines.
 *
 * Without a split, `unlisted` lists the screen lines that a walk from the top, taking the shortest listed run at each
 * line, leaves uncovered. That walk covering every line would itself be a split, so the list is never empty.
 */
function walkZone(zone: readonly string[]): { readonly logical: readonly string[] } | BashZoneMiss {
  const lines = zone.map(zoneLineOf);
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.text === '') end -= 1;
  const question = lines[end - 1];
  if (question === undefined || question.bar || question.text !== PROCEED_QUESTION) return { kind: 'question' };
  const above = lines.slice(0, end - 1);
  const runs = above.map((line, index) => (line.text === '' ? [] : listedRuns(above, index)));
  // `splits[i]`: the lines from `i` to the question split into empty lines and listed runs.
  const splits: boolean[] = new Array<boolean>(above.length + 1).fill(false);
  splits[above.length] = true;
  for (let i = above.length - 1; i >= 0; i -= 1) {
    splits[i] = above[i]?.text === '' ? splits[i + 1] === true
      : (runs[i] ?? []).some((run) => splits[i + run.length] === true);
  }
  const logical: string[] = [];
  const unlisted: BashZoneUnlistedLine[] = [];
  for (let i = 0; i < above.length;) {
    const line = above[i] ?? { text: '', bar: false };
    if (line.text === '') {
      i += 1;
      continue;
    }
    const at = runs[i] ?? [];
    const run = splits[0] === true ? at.find((one) => splits[i + one.length] === true) : at[0];
    if (run === undefined) {
      unlisted.push({ chars: [...line.text].length, bar: line.bar });
      i += 1;
      continue;
    }
    logical.push(run.text);
    i += run.length;
  }
  return splits[0] === true ? { logical } : { kind: 'unlisted', lines: unlisted };
}

/**
 * The logical zone lines above the question "Do you want to proceed?" (wraps joined with a space) when the zone (the
 * screen lines from the line under the bottom rule of the frame to the line above the first option) holds only lines
 * from the closed list and one question at the end; `null` for any other zone.
 */
export function bashZoneLines(zone: readonly string[]): readonly string[] | null {
  const walked = walkZone(zone);
  return 'logical' in walked ? walked.logical : null;
}

/** Whether the question zone is a `Bash` dialog zone from the closed list ({@link bashZoneLines}). */
export function bashZoneListed(zone: readonly string[]): boolean {
  return bashZoneLines(zone) !== null;
}

/**
 * Why the zone does not pass ({@link BashZoneMiss}), or `null` when it passes ({@link bashZoneListed}). Only for the
 * consent channel log line: counts and the bar, no line content.
 */
export function bashZoneMiss(zone: readonly string[]): BashZoneMiss | null {
  const walked = walkZone(zone);
  return 'logical' in walked ? null : walked;
}
