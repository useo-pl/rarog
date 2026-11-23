/**
 * Layer 2 rule (`layer2Verdict`, `server/src/herdr/dialogs/layer2/verdict.ts`) on measured screens and on small
 * synthetic blocks, plus the reader fields it stands on (`readBlock`: raw `rows`, wrapped footer).
 *
 * The verdict is the only place that turns a dialog block into keys, so every case pins the whole outcome: the
 * choice labels, the digit or key each one sends, and the end proof, or the reason for no buttons. The cases follow
 * `docs/dialogs.md`, "Dialog block". Measured screens come from `fixtures/herdr/`; the class of the CLI registry is
 * passed in, as the driver will pass it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYER2_WHYS } from '../src/herdr/dialogs/layer2/card.ts';
import { readBlock } from '../src/herdr/dialogs/layer2/read-block.ts';
import { PICKER_SHAPES } from '../src/herdr/dialogs/layer2/shapes.ts';
import { layer2Verdict } from '../src/herdr/dialogs/layer2/verdict.ts';
import type { Layer2Choice, Layer2Verdict } from '../src/herdr/dialogs/layer2/verdict.ts';
import { sessionPausedDialog } from '../src/herdr/dialogs/policy/pause.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { trimmedLines } from '../src/herdr/dialogs/screen/text.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const MARK = '\n--- ekran ---\n';

/** Screen of a fixture; a refusal dump carries a `key: value` header above the screen. */
function screenOf(name: string): string {
  const raw = readFileSync(join(DIR, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at < 0 ? raw : raw.slice(at + MARK.length);
}

const verdictOf = (text: string, cliClass: Parameters<typeof layer2Verdict>[1] = 'dialog'): Layer2Verdict =>
  layer2Verdict(readBlock(text), cliClass);

/** The verdict with no `TERMINAL_DIALOGS` entry confirmed (the code confirms both from the control set). */
const unconfirmedVerdictOf = (text: string): Layer2Verdict =>
  layer2Verdict(readBlock(text), 'dialog', { confirmedTerminal: new Set() });

const digit = (label: string, n: number): Layer2Choice => ({ label, send: { digit: n } });
const key = (label: string, k: Extract<Layer2Choice['send'], { key: unknown }>['key']): Layer2Choice =>
  ({ label, send: { key: k } });
const ESC = key('Esc to cancel', 'escape');

function choicesOf(verdict: Layer2Verdict): readonly Layer2Choice[] | null {
  return verdict.kind === 'choices' ? verdict.choices : null;
}

/** Synthetic block under a bare rule: title, body, the given rows. */
function synthetic(rows: readonly string[], title = 'Pick one?'): string {
  return ['some scrollback', '', '─'.repeat(40), `  ${title}`, '  The body of the dialog.', '', ...rows].join('\n');
}

const CONFIRMS: readonly (readonly [string, string])[] = [
  ['kontrolny/potwierdzenie-model-2.1.314.txt', 'Opus 5.5'],
  ['kontrolny/potwierdzenie-model-2.1.316.txt', 'Opus 5.5'],
  ['kontrolny/potwierdzenie-model-2.1.319.txt', 'Opus 5.5'],
  ['kontrolny/potwierdzenie-model-fable-2.1.316.txt', 'Fable 5.1'],
  ['kontrolny/potwierdzenie-model-fable-2.1.319.txt', 'Fable 5.1'],
  ['kontrolny/potwierdzenie-model-haiku-2.1.316.txt', 'Haiku 5.5'],
  ['kontrolny/potwierdzenie-model-haiku-2.1.319.txt', 'Haiku 5.5'],
  ['kontrolny/potwierdzenie-model-opus-1m-2.1.316.txt', 'Opus 5.5'],
  ['kontrolny/potwierdzenie-model-opus-1m-2.1.319.txt', 'Opus 5.5'],
  ['kontrolny/potwierdzenie-model-opus-2.1.316.txt', 'Opus 5.5'],
  ['kontrolny/potwierdzenie-model-opus-2.1.319.txt', 'Opus 5.5'],
  ['kontrolny/potwierdzenie-model-sonnet-2.1.316.txt', 'Sonnet 5.5'],
  ['kontrolny/potwierdzenie-model-sonnet-2.1.319.txt', 'Sonnet 5.5'],
];

const SLIDERS = [
  'kontrolny/picker-effort-2.1.314.txt',
  'kontrolny/picker-effort-2.1.316.txt',
  'kontrolny/picker-effort-2.1.319.txt',
  'kontrolny/picker-effort-ultracode-on-2.1.317.txt',
  'kontrolny/picker-effort-ultracode-status-2.1.318.txt',
] as const;
const SLIDER_NARROW = 'measured/picker-effort-2.1.312-26kol.txt';

/** Views whose footer names only Esc: `/help`, both `/status` captures and the usage limits. */
const ESC_ONLY = [
  'refusals/widok-help-2.1.310.txt',
  'refusals/widok-status-2.1.310.txt',
  'refusals/widok-status-stechly-zrzut-2.1.310.txt',
  'kontrolny/usage-klucz-api-2.1.314.txt',
  'kontrolny/usage-klucz-api-2.1.316.txt',
  'kontrolny/usage-klucz-api-2.1.319.txt',
] as const;

const PICKERS_WIDE = [
  'kontrolny/picker-model-klucz-api-2.1.314.txt',
  'kontrolny/picker-model-klucz-api-2.1.316.txt',
  'kontrolny/picker-model-klucz-api-2.1.319.txt',
  'kontrolny/picker-model-klucz-api-2.1.322.txt',
] as const;
const PICKER_NARROW = 'measured/picker-model-2.1.312-26kol.txt';
const PICKER_EFFORT_LINE = '◐ Medium effort (default) ←/→ to adjust';
const PAUSE = 'dialog-session-paused-2.1.309.txt';
const EXIT = 'dialog-background-work-exit-2.1.309.txt';
const RESUME = 'dialog-resume-summary-2.1.258.txt';

describe('readBlock: raw rows and the wrapped footer', () => {
  it('rows are every line under the top rule to the screen bottom, with the line index and the raw text', () => {
    const text = screenOf(RESUME);
    const block = readBlock(text);
    const lines = trimmedLines(text);
    expect(block).not.toBeNull();
    const rows = block?.rows ?? [];
    expect(rows.map((row) => row.index)).toEqual(lines.map((_, i) => i).slice((block?.top.line ?? 0) + 1));
    for (const row of rows) expect(row.text).toBe(lines[row.index]);
    expect(rows.find((row) => row.text.includes('2. Resume full'))?.text).toBe('    2. Resume full session as-is');
  });

  it('the slider footer starts with `←/→` and is read as a footer', () => {
    for (const name of SLIDERS) {
      expect(readBlock(screenOf(name))?.footer, name)
        .toBe('←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel');
    }
  });

  it('a footer wrapped over five lines is joined with a space from its first key line', () => {
    expect(readBlock(screenOf(SLIDER_NARROW))?.footer)
      .toBe('Tab to toggle ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel');
  });

  it('a footer under the options runs to the bottom of the block, not only its first line', () => {
    const text = synthetic(['  ❯ 1. Yes', '    2. No', '', '  Enter to confirm ·', '  Esc to cancel']);
    expect(readBlock(text)?.footer).toBe('Enter to confirm · Esc to cancel');
  });
});

describe('layer2Verdict on measured screens', () => {
  it.each(CONFIRMS)('%s: the two confirmation options, end proof from the shape', (name, model) => {
    const verdict = verdictOf(screenOf(name));
    expect(verdict).toMatchObject({ kind: 'choices', title: 'Switch model?', proof: 'shape' });
    expect(choicesOf(verdict)).toEqual([digit(`Yes, switch to ${model}`, 1), digit('No, go back', 2)]);
  });

  it('resume summary: options 1, 2, 3 and Esc, end proof from the footer', () => {
    const verdict = verdictOf(screenOf(RESUME));
    expect(verdict).toMatchObject({ kind: 'choices', title: 'This session is 5d 8h old and 778.9k tokens.' });
    expect(verdict).toMatchObject({ proof: 'footer' });
    expect(choicesOf(verdict)).toEqual([
      digit('Resume from summary (recommended)', 1),
      digit('Resume full session as-is', 2),
      digit("Don't ask me again", 3),
      ESC,
    ]);
  });

  it('the verdict carries the block from its title to the footer and the block print', () => {
    const text = screenOf(RESUME);
    const block = readBlock(text);
    const verdict = verdictOf(text);
    if (verdict.kind !== 'choices' || block === null) throw new Error('expected choices');
    const lines = trimmedLines(text);
    expect(verdict.block).toBe(lines.slice(block.titleLine).join('\n'));
    expect(verdict.block.split('\n').at(-1)).toBe('  Enter to confirm · Esc to cancel');
    expect(verdict.print).toBe(block.print);
  });

  it('effort change and the old „Switch model” (no footer, no shape) have no end proof', () => {
    expect(verdictOf(screenOf('dialog-effort-change.txt'))).toEqual({ kind: 'none', why: 'cut-bottom' });
    expect(verdictOf(screenOf('dialog-model-switch.txt'))).toEqual({ kind: 'none', why: 'cut-bottom' });
  });

  it.each(SLIDERS)('%s: slider keys from the footer, no letter key `s`', (name) => {
    const verdict = verdictOf(screenOf(name));
    expect(verdict).toMatchObject({ kind: 'choices', title: 'Effort', proof: 'footer' });
    expect(choicesOf(verdict)).toEqual([
      key('← to adjust', 'left'), key('→ to adjust', 'right'), key('Enter to confirm', 'enter'), ESC,
    ]);
  });

  it('slider on 26 columns (footer on five lines): the same keys and „Tab to toggle”', () => {
    const verdict = verdictOf(screenOf(SLIDER_NARROW));
    expect(verdict).toMatchObject({ kind: 'choices', title: 'Effort', proof: 'footer' });
    expect(choicesOf(verdict)).toEqual([
      key('Tab to toggle', 'tab'),
      key('← to adjust', 'left'), key('→ to adjust', 'right'), key('Enter to confirm', 'enter'), ESC,
    ]);
  });

  it.each(ESC_ONLY)('%s: a card with Esc alone', (name) => {
    const verdict = verdictOf(screenOf(name));
    expect(verdict).toMatchObject({ kind: 'choices', proof: 'footer' });
    expect(choicesOf(verdict)).toEqual([ESC]);
  });

  it('narrow picker with the `↓` indicator: `scroll`', () => {
    expect(verdictOf(screenOf(PICKER_NARROW))).toEqual({ kind: 'none', why: 'scroll' });
  });

  it('`/skills` with the list past the footer: `block-no-digits`', () => {
    expect(verdictOf(screenOf('refusals/widok-skills-2.1.310.txt'))).toEqual({ kind: 'none', why: 'block-no-digits' });
  });

  it('pause and exit with work in the background without a key confirmation: `terminal-dialog`', () => {
    expect(unconfirmedVerdictOf(screenOf(PAUSE))).toEqual({ kind: 'none', why: 'terminal-dialog' });
    expect(unconfirmedVerdictOf(screenOf(EXIT))).toEqual({ kind: 'none', why: 'terminal-dialog' });
  });

  it('a pause with another set of options and a footer: `terminal-dialog`', () => {
    const lines = trimmedLines(screenOf(PAUSE));
    const first = lines.findIndex((line) => line.includes('1. Switch to Opus 4.8'));
    const other = [
      ...lines.slice(0, first),
      '  ❯ 1. Switch to Opus 4.8',
      '    2. Keep going with Opus 5.5',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');
    expect(parseOptions(other)?.terminalDialog).toBeNull();
    expect(verdictOf(other)).toEqual({ kind: 'none', why: 'terminal-dialog' });
  });

  it('with the key confirmation given: exit has 3 options and Esc from the footer, pause 2 options without Esc', () => {
    const confirmed = new Set(['session-paused-safeguards', 'background-work-exit'] as const);
    const exit = layer2Verdict(readBlock(screenOf(EXIT)), 'dialog', { confirmedTerminal: confirmed });
    expect(exit).toMatchObject({ kind: 'choices', title: 'Background work is running', proof: 'footer' });
    expect(choicesOf(exit)).toEqual([
      digit('Exit and stop tasks', 1), digit('Move to background and exit', 2), digit('Stay', 3), ESC,
    ]);
    const pause = layer2Verdict(readBlock(screenOf(PAUSE)), 'dialog', { confirmedTerminal: confirmed });
    expect(pause).toMatchObject({ kind: 'choices', title: 'Session paused', proof: 'terminal-dialog' });
    expect(choicesOf(pause)).toEqual([
      digit('Switch to Opus 4.8', 1), digit('Edit prompt and retry with Opus 5.5 (1M context)', 2),
    ]);
  });

  it('the confirmation of one dialog does not open the other', () => {
    const onlyExit = new Set(['background-work-exit'] as const);
    expect(layer2Verdict(readBlock(screenOf(PAUSE)), 'dialog', { confirmedTerminal: onlyExit }))
      .toEqual({ kind: 'none', why: 'terminal-dialog' });
  });

  it('a confirmed pause never offers Esc, even under a footer that names it', () => {
    const confirmed = new Set(['session-paused-safeguards'] as const);
    const text = [...trimmedLines(screenOf(PAUSE)), '', '  Enter to confirm · Esc to cancel'].join('\n');
    const pause = layer2Verdict(readBlock(text), 'dialog', { confirmedTerminal: confirmed });
    expect(pause).toMatchObject({ kind: 'choices', proof: 'footer' });
    expect(choicesOf(pause)).toEqual([
      digit('Switch to Opus 4.8', 1), digit('Edit prompt and retry with Opus 5.5 (1M context)', 2),
    ]);
  });
});

/**
 * The `/model` picker gets no layer 2 buttons. A digit there acts as Enter, and the footer says what Enter does: "Enter
 * to set as default" (CLI 2.1.323, account with a subscription). A digit button would change the default model of every
 * new session under a label that does not say so. The rule refuses any block whose footer names "Enter to set as
 * default" (`sets-default`), before it reads the options, so the refusal does not hang on the effort line.
 */
describe('layer2Verdict on the `/model` picker: no buttons', () => {
  const PICKER_322 = 'kontrolny/picker-model-klucz-api-2.1.322.txt';
  const SETS_DEFAULT = { kind: 'none', why: 'sets-default' };
  const withoutEffortLine = (): string[] => trimmedLines(screenOf(PICKER_322))
    .filter((line) => line.trim() !== PICKER_EFFORT_LINE);

  it.each(PICKERS_WIDE)('%s: `sets-default`, no buttons', (name) => {
    expect(verdictOf(screenOf(name))).toEqual(SETS_DEFAULT);
  });

  it('the block names Enter as "set as default" and carries the effort line', () => {
    const text = screenOf(PICKER_322);
    expect(readBlock(text)?.title).toBe('Select model');
    expect(readBlock(text)?.footer).toBe('Enter to set as default · s to use this session only · Esc to cancel');
    expect(text).toContain(PICKER_EFFORT_LINE);
  });

  it('another effort level in the effort line: still `sets-default`', () => {
    const swapped = trimmedLines(screenOf(PICKER_322))
      .map((line) => line.replace(PICKER_EFFORT_LINE, '● High effort ←/→ to adjust')).join('\n');
    expect(verdictOf(swapped)).toEqual(SETS_DEFAULT);
  });

  it('without the effort line, the footer alone refuses: `sets-default`', () => {
    const lines = withoutEffortLine();
    expect(lines.join('\n')).not.toContain('to adjust');
    expect(verdictOf(lines.join('\n'))).toEqual(SETS_DEFAULT);
  });

  it('without the effort line and with another footer, the picker gets its digits: the footer refuses', () => {
    const text = withoutEffortLine()
      .map((line) => line.replace('Enter to set as default', 'Enter to confirm')).join('\n');
    const verdict = verdictOf(text);
    expect(verdict).toMatchObject({ kind: 'choices', title: 'Select model', proof: 'footer' });
    expect(choicesOf(verdict)?.map((choice) => choice.send)).toEqual([
      { digit: 1 }, { digit: 2 }, { digit: 3 }, { digit: 4 }, { digit: 5 }, { key: 'escape' },
    ]);
  });

  it('a wrapped footer still names "set as default": `sets-default`', () => {
    const text = withoutEffortLine()
      .flatMap((line) => (line.includes('Enter to set as default')
        ? ['   Enter to set as', '   default · s to use this session only · Esc to cancel'] : [line])).join('\n');
    expect(verdictOf(text)).toEqual(SETS_DEFAULT);
  });

  it('the `/effort` picker ("Enter to confirm · s for this session only") keeps its choices', () => {
    const text = screenOf('kontrolny/picker-effort-2.1.322.txt');
    expect(readBlock(text)?.footer).toContain('Enter to confirm · s for this session only');
    expect(verdictOf(text).kind).toBe('choices');
  });

  it('the picker registry is empty; an entry would need a capture of class `dialog open` with its title', () => {
    expect(PICKER_SHAPES).toEqual([]);
    const control = JSON.parse(readFileSync(join(DIR, 'kontrolny', 'manifest.json'), 'utf8')) as {
      shapes: { file: string; cli: string; waitingFor: { value: string | null } | null }[];
    };
    for (const shape of PICKER_SHAPES) {
      const entry = control.shapes.find((candidate) => candidate.file === shape.fixture);
      expect(entry?.cli, shape.id).toBe(shape.cli);
      expect(entry?.waitingFor?.value, shape.id).toBe('dialog open');
      expect(readBlock(screenOf(shape.fixture))?.title, shape.id).toBe(shape.title);
      expect(verdictOf(screenOf(shape.fixture)).kind, shape.id).toBe('choices');
    }
  });
});

describe('layer2Verdict: class of the CLI registry', () => {
  it('a full block of class `permission` or `sandbox`: `class-not-dialog`; no class: `class-unknown`', () => {
    const block = readBlock(screenOf(RESUME));
    expect(layer2Verdict(block, 'permission')).toEqual({ kind: 'none', why: 'class-not-dialog' });
    expect(layer2Verdict(block, 'sandbox')).toEqual({ kind: 'none', why: 'class-not-dialog' });
    expect(layer2Verdict(block, 'input')).toEqual({ kind: 'none', why: 'class-not-dialog' });
    expect(layer2Verdict(block, null)).toEqual({ kind: 'none', why: 'class-unknown' });
    expect(layer2Verdict(null, 'dialog')).toEqual({ kind: 'none', why: 'no-block' });
  });
});

describe('layer2Verdict on synthetic blocks', () => {
  const FOOTER = '  Enter to confirm · Esc to cancel';

  it('two labels with the same first 200 characters: `label-ambiguous`', () => {
    const head = 'a'.repeat(200);
    const text = synthetic([`  ❯ 1. ${head} one`, `    2. ${head} two`, '', FOOTER]);
    expect(verdictOf(text)).toEqual({ kind: 'none', why: 'label-ambiguous' });
  });

  it('wrong numbering on a block with a footer: `numbering`, never keys from the footer', () => {
    const lines = trimmedLines(screenOf(RESUME)).map((line) => line.replace('3. Don', '4. Don'));
    expect(verdictOf(lines.join('\n'))).toEqual({ kind: 'none', why: 'numbering' });
    const shifted = synthetic(['  ❯ 2. Yes', '    3. No', '', FOOTER]);
    expect(verdictOf(shifted)).toEqual({ kind: 'none', why: 'numbering' });
  });

  it('one option or more than nine: `numbering` and `too-many`', () => {
    expect(verdictOf(synthetic(['  ❯ 1. Yes', '', FOOTER]))).toEqual({ kind: 'none', why: 'numbering' });
    const ten = Array.from({ length: 10 }, (_, i) => `    ${i + 1}. Option ${i + 1}`);
    expect(verdictOf(synthetic([...ten, '', FOOTER]))).toEqual({ kind: 'none', why: 'too-many' });
  });

  it('continuation at label column 7: 5 spaces is `foreign-line`, 8 spaces joins into the whole label', () => {
    const five = synthetic(['    1. Yes, switch', '     to Opus 5.5', '    2. No', '', FOOTER]);
    expect(verdictOf(five)).toEqual({ kind: 'none', why: 'foreign-line' });
    const eight = synthetic(['    1. Yes, switch', '        to Opus 5.5', '    2. No', '', FOOTER]);
    expect(choicesOf(verdictOf(eight))).toEqual([digit('Yes, switch to Opus 5.5', 1), digit('No', 2), ESC]);
  });

  it('labels with `…` at the end, a frame glyph, a checkbox or a submenu arrow get no buttons', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['Yes, switch to Opus 5…', 'label-cut'],
      ['Yes │ switch', 'frame'],
      ['[ ] Yes', 'multi-select'],
      ['☐ Yes', 'multi-select'],
      ['More options  →', 'submenu'],
      ['More options ›', 'submenu'],
    ];
    for (const [label, why] of cases) {
      expect(verdictOf(synthetic([`  ❯ 1. ${label}`, '    2. No', '', FOOTER])), label).toEqual({ kind: 'none', why });
    }
    const boxed = synthetic(['  │ ❯ 1. Yes', '  │   2. No', '', FOOTER]);
    expect(verdictOf(boxed)).toEqual({ kind: 'none', why: 'frame' });
  });

  it('a rule right above the block top: `rule-above`', () => {
    const text = ['─'.repeat(40), '', '─'.repeat(40), '  Pick one?', '  ❯ 1. Yes', '    2. No', '', FOOTER].join('\n');
    expect(verdictOf(text)).toEqual({ kind: 'none', why: 'rule-above' });
  });

  it('a digitless block without a footer is `block-no-digits`; a footer without known keys too', () => {
    const noFooter = ['▔'.repeat(40), '  View', '  some text'].join('\n');
    expect(verdictOf(noFooter)).toEqual({ kind: 'none', why: 'block-no-digits' });
    const letters = ['▔'.repeat(40), '  View', '  some text', '', '  space to select · ctrl+o to expand'].join('\n');
    expect(verdictOf(letters)).toEqual({ kind: 'none', why: 'block-no-digits' });
  });

  it('a digitless footer with `↑/↓` gives two keys and drops `shift+tab` and letter keys', () => {
    const footer = '  ↑/↓ to navigate · shift+tab to cycle · t to sort · Esc to close';
    const text = ['▔'.repeat(40), '  View', '  text', '', footer].join('\n');
    expect(choicesOf(verdictOf(text))).toEqual([
      key('↑ to navigate', 'up'), key('↓ to navigate', 'down'), key('Esc to close', 'escape'),
    ]);
  });

  it('with two dialogs on the screen only the bottom one counts', () => {
    const upper = trimmedLines(screenOf(RESUME));
    const lower = trimmedLines(screenOf('kontrolny/potwierdzenie-model-fable-2.1.316.txt'));
    const verdict = verdictOf([...upper, '', ...lower].join('\n'));
    expect(choicesOf(verdict)).toEqual([digit('Yes, switch to Fable 5.1', 1), digit('No, go back', 2)]);
  });

  it('labels equal up to case or the apostrophe form: `label-ambiguous`', () => {
    const AMBIGUOUS = { kind: 'none', why: 'label-ambiguous' };
    expect(verdictOf(synthetic(['  ❯ 1. Yes', '    2. Yes', '', FOOTER]))).toEqual(AMBIGUOUS);
    expect(verdictOf(synthetic(['  ❯ 1. Yes', '    2. yes', '', FOOTER]))).toEqual(AMBIGUOUS);
    expect(verdictOf(synthetic(["  ❯ 1. Don't ask", '    2. Don’t ask', '', FOOTER]))).toEqual(AMBIGUOUS);
  });

  it('an indented line after a blank line under an option is not its continuation: `foreign-line`', () => {
    const text = synthetic(['    1. Yes, switch', '', '        to Opus 5.5', '    2. No', '', FOOTER]);
    expect(verdictOf(text)).toEqual({ kind: 'none', why: 'foreign-line' });
  });

  it('a rule under the footer (another region below the block): `extra-below`, with or without digits', () => {
    expect(verdictOf(synthetic(['  ❯ 1. Yes', '    2. No', '', FOOTER, '─'.repeat(40)])))
      .toEqual({ kind: 'none', why: 'extra-below' });
    const digitless = ['▔'.repeat(40), '  View', '  text', '', '  Esc to close', '-'.repeat(40)].join('\n');
    expect(verdictOf(digitless)).toEqual({ kind: 'none', why: 'extra-below' });
  });

  it('a footer with `n to add notes` (preview variant, Enter after the digit): `submit-unknown`', () => {
    const text = synthetic(['  ❯ 1. Yes', '    2. No', '', '  Enter to select · n to add notes · Esc to cancel']);
    expect(readBlock(text)?.submit).toBe('digit-enter');
    expect(verdictOf(text)).toEqual({ kind: 'none', why: 'submit-unknown' });
  });

  it('a pause cut above its options (no digits on the screen): `terminal-dialog`', () => {
    const text = ['▔'.repeat(40), '  Session paused', '  text', '', '  Esc to cancel'].join('\n');
    expect(verdictOf(text)).toEqual({ kind: 'none', why: 'terminal-dialog' });
  });

  it('a digitless footer that names the same key twice: `label-ambiguous`', () => {
    const text = ['▔'.repeat(40), '  View', '  text', '', '  Esc to close · esc to close'].join('\n');
    expect(verdictOf(text)).toEqual({ kind: 'none', why: 'label-ambiguous' });
  });
});

describe('unconfirmed: a pause in any variant is no layer 2 decision (rule of `sessionPausedDialog`)', () => {
  const verdictOf = unconfirmedVerdictOf;
  const PAUSE_TEXT = trimmedLines(screenOf(PAUSE));
  const variants: readonly (readonly [string, readonly string[]])[] = [
    ['measured pause', PAUSE_TEXT],
    ['other options', PAUSE_TEXT.map((line) => line.replace('Switch to Opus 4.8', 'Continue with Opus 4.8'))],
    ['other title', PAUSE_TEXT.map((line) => line.replace('Session paused', 'Session on hold'))],
  ];

  it.each(variants)('%s: `sessionPausedDialog` and the verdict agree', (_, lines) => {
    const text = lines.join('\n');
    const dialog = parseOptions(text);
    expect(dialog === null ? false : sessionPausedDialog(dialog)).toBe(true);
    expect(verdictOf(text)).toEqual({ kind: 'none', why: 'terminal-dialog' });
  });
});

describe('`LAYER2_WHYS`: one closed list in three groups', () => {
  it('every reason the cases above produce is on the list', () => {
    for (const why of ['no-block', 'numbering', 'foreign-line', 'extra-below', 'frame', 'multi-select', 'submenu',
      'block-no-digits', 'label-ambiguous', 'class-not-dialog', 'class-unknown', 'terminal-dialog', 'too-many',
      'label-cut', 'scroll', 'cut-bottom', 'rule-above', 'submit-unknown', 'sets-default'] as const) {
      expect(LAYER2_WHYS).toContain(why);
    }
    expect(new Set(LAYER2_WHYS).size).toBe(LAYER2_WHYS.length);
  });
});
