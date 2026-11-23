/**
 * Layer 2 rule (`layer2Verdict`): the buttons a CLI dialog block of class `dialog` gets, or the reason it gets none.
 *
 * Pure function over the block from `readBlock` (raw `rows`), no I/O and no clock. Buttons come straight from the
 * literal block: one per numbered option, labelled with the whole option text (continuation lines joined with one
 * space, the gaps within a line kept), plus Esc when the footer names it; a block without digits gets one button per
 * footer segment that names a dialog key. A digit comes from the same line as its whole label, a key from the footer
 * segment that names it. A measured picker (`PICKER_SHAPES`) may have its own lines between the options and the
 * footer. When the block does not prove which key does what, the verdict is `none` with a reason from the closed list
 * `LAYER2_WHYS` (`card.ts`).
 *
 * It does not send keys, does not know the session and does not decide whether layer 2 runs at all (flag, engine,
 * cards that today's decision already gives buttons): the caller does. Rule: `docs/dialogs.md`, "Dialog block".
 */
import type { CliDialogClass } from '@rarog/shared';
import type { Layer2Why } from './card.ts';
import { shapeOf } from './match.ts';
import type { Block, BlockRow } from './read-block.ts';
import { PICKER_SHAPES } from './shapes.ts';
import { TERMINAL_DIALOGS, matchTerminalDialog } from '../policy/terminal.ts';
import type { TerminalDialogId } from '../policy/terminal.ts';
import { canonicalLabel, foldApostrophes } from '../screen/options.ts';
import { HORIZONTAL_RULE_PATTERN, blockTopOf } from '../screen/region.ts';
import { SCREEN_SIGNATURES } from '../screen/signatures.ts';

/** Keys a layer 2 card may send: Esc, Enter, Tab and the arrows; letter keys never. */
export type DialogKey = 'up' | 'down' | 'left' | 'right' | 'tab' | 'enter' | 'escape';

/** One button: the literal label the card shows and what the server sends for it. */
export type Layer2Choice = { label: string; send: { digit: number } | { key: DialogKey } };

/**
 * What proves the block ends where the screen shows it: a key footer under the options, a shape from the registry
 * (`shapes.ts`), or the closed match of a `TERMINAL_DIALOGS` entry with confirmed keys (title and the whole set of
 * options). A block without that proof may have more options under the screen edge.
 */
export type Layer2Proof = 'footer' | 'shape' | 'terminal-dialog';

export type Layer2Verdict =
  | { kind: 'choices'; title: string; block: string; choices: Layer2Choice[]; print: string; proof: Layer2Proof }
  | { kind: 'none'; why: Layer2Why };

export interface Layer2VerdictOptions {
  /**
   * `TERMINAL_DIALOGS` entries whose keys a measurement confirmed. Default: the entries with `keysMeasured`. Only a
   * test passes another set.
   */
  readonly confirmedTerminal?: ReadonlySet<TerminalDialogId>;
}

/** One numbered option read from the rows: its digit, its whole label and the screen lines the label stands on. */
export interface ReadOption {
  readonly digit: number;
  readonly label: string;
  readonly lines: readonly string[];
}

/**
 * Options of a block: the whole labels and the footer rows under them, or a reading error with the options read
 * before it (all of them when the error stands under the last option), or no digits at all.
 */
export type OptionReading =
  | { readonly kind: 'options'; readonly options: readonly ReadOption[]; readonly footer: readonly BlockRow[] }
  | { readonly kind: 'digitless' }
  | { readonly kind: 'error'; readonly why: Layer2Why; readonly options: readonly ReadOption[] };

const OPTION_ROW = SCREEN_SIGNATURES.dialogOptionRow.pattern;
const FRAME_GLYPH = SCREEN_SIGNATURES.dialogFrameGlyph.pattern;
const SCROLL_MARKER = SCREEN_SIGNATURES.listScrollMarker.pattern;
const LABEL_CUT = SCREEN_SIGNATURES.optionLabelCut.pattern;
const TRAILING_ARROW = SCREEN_SIGNATURES.optionTrailingArrow.pattern;
const CHECKBOX = SCREEN_SIGNATURES.optionCheckbox.pattern;
const KEY_LINE = SCREEN_SIGNATURES.dialogKeyFooter.pattern;
const KEY_SEGMENT = SCREEN_SIGNATURES.dialogKeySegment.pattern;
const SEGMENT_SEPARATOR = SCREEN_SIGNATURES.footerSegmentSeparator.pattern;
const PAUSE_TITLE = SCREEN_SIGNATURES.sessionPausedTitle.pattern;
const PAUSE_RETRY = SCREEN_SIGNATURES.sessionPausedRetryOption.pattern;
const SETS_DEFAULT_FOOTER = SCREEN_SIGNATURES.footerSetsDefault.pattern;

/** Fewest and most options a card takes: one option is no choice, ten would need a two-key digit. */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 9;

const DEFAULT_CONFIRMED: ReadonlySet<TerminalDialogId> = new Set(
  TERMINAL_DIALOGS.filter((dialog) => dialog.keysMeasured !== null).map((dialog) => dialog.id),
);

/** Keys a footer segment names; a pair (`←/→`) gives two buttons, each with its own arrow in the label. */
const SEGMENT_KEYS: Readonly<Record<string, readonly (readonly [string | null, DialogKey])[]>> = {
  esc: [[null, 'escape']],
  enter: [[null, 'enter']],
  tab: [[null, 'tab']],
  '←/→': [['←', 'left'], ['→', 'right']],
  '↑/↓': [['↑', 'up'], ['↓', 'down']],
};

/**
 * The verdict for one block. Order of the checks: the class of the CLI registry, the block and its top, a footer
 * that says Enter sets a default (`sets-default`), the option rows (numbering, continuation, foreign lines, labels),
 * labels the server could confuse, the pause and `TERMINAL_DIALOGS`, agreement with the digits `readBlock` read, the
 * scroll marker, the submit mode and the end proof. The first failed check is the reason.
 */
export function layer2Verdict(
  block: Block | null, cliClass: CliDialogClass | null, options: Layer2VerdictOptions = {},
): Layer2Verdict {
  if (cliClass === null) return none('class-unknown');
  if (cliClass !== 'dialog') return none('class-not-dialog');
  if (block === null) return none('no-block');
  if (block.ruleAbove) return none('rule-above');
  // A digit in such a dialog acts as Enter, and Enter saves a default for new sessions (the `/model`
  // picker). No button label says that, so the block gets none, whatever its options read as.
  if (block.footer !== null && SETS_DEFAULT_FOOTER.test(block.footer)) return none('sets-default');
  const reading = readOptions(block);
  if (reading.kind === 'error') return none(reading.why);
  if (reading.kind === 'digitless') return digitlessVerdict(block);

  const labels = reading.options.map((option) => option.label);
  const paused = PAUSE_TITLE.test(block.title) || labels.some((label) => PAUSE_RETRY.test(label));
  const footerKeys = footerChoices(reading.footer);
  if (footerKeys === 'cut') return none('cut-bottom');
  // Esc on a pause is unmeasured (a safeguard of the model), so the pause never offers it.
  const escape = paused ? [] : footerKeys.filter((choice) => isKey(choice, 'escape'));
  const choices = [
    ...reading.options.map((option): Layer2Choice => ({ label: option.label, send: { digit: option.digit } })),
    ...escape,
  ];
  if (ambiguous(choices)) return none('label-ambiguous');

  const confirmed = options.confirmedTerminal ?? DEFAULT_CONFIRMED;
  const terminal = matchTerminalDialog(
    block.title, reading.options.map((option) => ({ digit: String(option.digit), label: option.label })),
  );
  if ((paused || terminal !== null) && (terminal === null || !confirmed.has(terminal))) return none('terminal-dialog');

  const read = block.options.map((option) => option.digit);
  if (read.length !== reading.options.length || read.some((d, i) => d !== String(i + 1))) return none('numbering');
  const footerStart = reading.footer[0]?.index ?? Infinity;
  if (block.rows.some((row) => row.index < footerStart && SCROLL_MARKER.test(row.text.trim()))) return none('scroll');
  if (block.submit !== 'digit') return none('submit-unknown');

  const proof: Layer2Proof | null = reading.footer.length > 0 ? 'footer'
    : shapeOf(block) !== null ? 'shape'
      : terminal !== null ? 'terminal-dialog'
        : null;
  if (proof === null) return none('cut-bottom');
  return { kind: 'choices', title: block.title, block: blockText(block), choices, print: block.print, proof };
}

/**
 * Numbered options read from the raw rows under the title, with their continuation lines, and the footer rows under
 * them. An option row is a whole line `N. label`; the digits run 1..N in screen order. A non-empty line under an option
 * is its continuation when it follows without a blank line and is indented at least to the label column; any other
 * line between options is foreign, any other line under the last one (before a key footer) is extra, except a setting
 * line of the measured picker with the block's title (`PICKER_SHAPES`), once each, after a blank line. A footer row
 * that is a rule (a block under the block) is extra too. A label is its lines joined with one space; the gap between a
 * picker name and its description column stays as on the screen.
 */
export function readOptions(block: Block): OptionReading {
  const rows = block.rows.filter((row) => row.index > block.titleLine);
  const kinds = rows.map((row) => optionRow(row.text));
  const options: { digit: number; lines: string[]; column: number }[] = [];
  const settings = [...(PICKER_SHAPES.find((picker) => picker.title === block.title)?.settings ?? [])];
  const read = (): ReadOption[] => options.map((option) => ({
    digit: option.digit, label: option.lines.join(' '), lines: option.lines,
  }));
  const error = (why: Layer2Why): OptionReading => ({ kind: 'error', why, options: read() });
  if (kinds.includes('frame')) return error('frame');
  const lastOption = kinds.findLastIndex((kind) => kind !== null);
  if (lastOption === -1) return { kind: 'digitless' };

  let open = false;
  let footerAt = rows.length;
  for (const [k, row] of rows.entries()) {
    const text = row.text.trim();
    const kind = kinds[k];
    if (text === '') {
      open = false;
      continue;
    }
    if (kind !== null && kind !== undefined && kind !== 'frame') {
      if (kind.digit !== options.length + 1) return error('numbering');
      options.push({ digit: kind.digit, lines: [kind.label], column: kind.column });
      open = true;
      continue;
    }
    const current = options.at(-1);
    if (current === undefined) continue;
    if (k > lastOption && KEY_LINE.test(text)) {
      footerAt = k;
      break;
    }
    if (open && !KEY_LINE.test(text) && indentOf(row.text) >= current.column) {
      current.lines.push(text);
      continue;
    }
    const setting = k > lastOption && !open ? settings.findIndex((pattern) => pattern.test(text)) : -1;
    if (setting !== -1) {
      settings.splice(setting, 1);
      continue;
    }
    return error(k < lastOption ? 'foreign-line' : 'extra-below');
  }
  const footer = rows.slice(footerAt).filter((row) => row.text.trim() !== '');
  if (footer.some((row) => isRule(block.rows, row))) return error('extra-below');
  if (options.length < MIN_OPTIONS) return error('numbering');
  if (options.length > MAX_OPTIONS) return error('too-many');
  const labels = read();
  for (const option of labels) {
    const why = labelProblem(option.label, option.lines);
    if (why !== null) return error(why);
  }
  return { kind: 'options', options: labels, footer };
}

/** A block without digits: one button per footer segment that names a dialog key, end proof from the footer. */
function digitlessVerdict(block: Block): Layer2Verdict {
  if (PAUSE_TITLE.test(block.title)) return none('terminal-dialog');
  const rows = block.rows.filter((row) => row.index > block.titleLine);
  const start = rows.findIndex((row) => KEY_LINE.test(row.text.trim()));
  if (start === -1) return none('block-no-digits');
  const footer = rows.slice(start).filter((row) => row.text.trim() !== '');
  if (footer.some((row) => isRule(block.rows, row))) return none('extra-below');
  const choices = footerChoices(footer);
  if (choices === 'cut') return none('cut-bottom');
  if (choices.length === 0) return none('block-no-digits');
  if (ambiguous(choices)) return none('label-ambiguous');
  return { kind: 'choices', title: block.title, block: blockText(block), choices, print: block.print, proof: 'footer' };
}

/** An option row: digit, label start and its column; `'frame'` = an option row behind frame glyphs; `null` = none. */
function optionRow(text: string): { digit: number; label: string; column: number } | 'frame' | null {
  const hit = OPTION_ROW.exec(text);
  if (hit === null) {
    const bare = [...text].map((char) => (FRAME_GLYPH.test(char) ? ' ' : char)).join('');
    return OPTION_ROW.test(bare) ? 'frame' : null;
  }
  const label = (hit[2] ?? '').trim();
  return { digit: Number(hit[1]), label, column: text.length - (hit[2] ?? '').trimStart().length };
}

/**
 * Why a whole label cannot be a button; `null` = it can. The label is never empty: an option row needs text after
 * `N. ` and the rows come from `trimmedLines`.
 */
function labelProblem(label: string, lines: readonly string[]): Layer2Why | null {
  if (FRAME_GLYPH.test(label)) return 'frame';
  if (CHECKBOX.test(label)) return 'multi-select';
  if (TRAILING_ARROW.test(label)) return 'submenu';
  if (LABEL_CUT.test(label) || lines.some((line) => LABEL_CUT.test(line))) return 'label-cut';
  return null;
}

/**
 * Footer segments in screen order. Segments are split at the separator; a footer row that starts with a key starts a
 * new segment even without a separator before it (a wrapped footer breaks lines between segments), any other row
 * continues the open segment.
 */
function segmentsOf(footer: readonly BlockRow[]): string[] {
  const segments: string[] = [];
  let open = false;
  for (const row of footer) {
    const text = row.text.trim();
    const parts = text.split(SEGMENT_SEPARATOR);
    parts.forEach((part, i) => {
      const last = segments.length - 1;
      if (i === 0 && open && last >= 0 && !KEY_LINE.test(text)) segments[last] = `${segments[last]} ${part}`;
      else segments.push(part);
    });
    open = parts.at(-1) !== '';
  }
  return segments.map(collapse).filter((segment) => segment !== '');
}

/**
 * Buttons for the footer segments that name a dialog key; other segments (letters, `shift+tab`, `space`) give none.
 * `'cut'` = a key segment with no action after "to" (`Esc to`): the wrapped footer goes on under the screen edge, so
 * the block end is unproven.
 */
function footerChoices(footer: readonly BlockRow[]): Layer2Choice[] | 'cut' {
  const segments = segmentsOf(footer);
  const cut = segments.some((segment) => {
    const hit = KEY_SEGMENT.exec(segment);
    return hit !== null && segment.slice(hit[0].length).trim() === '';
  });
  if (cut) return 'cut';
  return segments.flatMap((segment) => {
    const token = KEY_SEGMENT.exec(segment)?.[1];
    if (token === undefined) return [];
    const keys = SEGMENT_KEYS[token.toLowerCase()] ?? [];
    return keys.map(([arrow, key]): Layer2Choice => ({
      label: arrow === null ? segment : `${arrow}${segment.slice(token.length)}`,
      send: { key },
    }));
  });
}

function isKey(choice: Layer2Choice, key: DialogKey): boolean {
  return 'key' in choice.send && choice.send.key === key;
}

/**
 * Two buttons the server could not tell apart by label: equal in full or in the part the label key keeps
 * (`canonicalLabel`, first `OPTION_LABEL_MAX_CHARS` characters), ignoring case and apostrophe forms.
 */
function ambiguous(choices: readonly Layer2Choice[]): boolean {
  const fold = (text: string): string => foldApostrophes(text).toLowerCase();
  const whole = new Set(choices.map((choice) => fold(collapse(choice.label))));
  const keys = new Set(choices.map((choice) => fold(canonicalLabel(choice.label))));
  return whole.size < choices.length || keys.size < choices.length;
}

/** A row that is a rule: a region rule or a block top rule (another block below this one). */
function isRule(rows: readonly BlockRow[], row: BlockRow): boolean {
  const texts = rows.map((r) => r.text);
  const k = rows.indexOf(row);
  return HORIZONTAL_RULE_PATTERN.test(row.text.trim()) || blockTopOf(texts, k + 1)?.line === k;
}

/** The literal block from its title to the bottom (the footer included), lines joined with `\n`. */
function blockText(block: Block): string {
  return block.rows.filter((row) => row.index >= block.titleLine).map((row) => row.text).join('\n');
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function none(why: Layer2Why): Layer2Verdict {
  return { kind: 'none', why };
}
