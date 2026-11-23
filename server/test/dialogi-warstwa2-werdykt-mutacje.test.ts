/**
 * Layer 2 rule (`layer2Verdict`) on mutated screens: the five families of damage a pane read can show (cut bottom,
 * wrapped label, shifted numbering, two dialogs, foreign line between options), each made from the same 20 measured
 * dialogs with digits. The rule must never give a pair (digit, label) that the measured dialog does not have, never
 * give buttons without proof of the block end, and never carry half a label.
 *
 * The truth is written out by hand from the screens (`TRUTH`): one map digit → whole label per base screen, with the
 * gap between a picker name and its description column kept, as the rule reports it. A wrap made at such a gap turns
 * it into one space, so the wrapped variants compare labels with whitespace runs collapsed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shapeOf } from '../src/herdr/dialogs/layer2/match.ts';
import { readBlock } from '../src/herdr/dialogs/layer2/read-block.ts';
import { layer2Verdict, readOptions } from '../src/herdr/dialogs/layer2/verdict.ts';
import type { Layer2Verdict } from '../src/herdr/dialogs/layer2/verdict.ts';
import { trimmedLines } from '../src/herdr/dialogs/screen/text.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');

const confirm = (model: string): readonly string[] => [`Yes, switch to ${model}`, 'No, go back'];

/** An option of the wide `/model` picker: the name padded to the description column, as on the screen. */
const pickerRow = (name: string, description: string): string => `${name.padEnd(23)}${description}`;

const PICKER_WIDE = [
  pickerRow('Default (recommended)', 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok'),
  pickerRow('Opus', 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok'),
  pickerRow('Fable', 'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok'),
  pickerRow('Sonnet ✔', 'Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok'),
  pickerRow('Haiku',
    'Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok ($0.50/$2.50 for prompts over 100k)'),
];

/** Base screens and their whole labels in digit order (digit = index + 1), read off the screens by hand. */
const TRUTH: Readonly<Record<string, readonly string[]>> = {
  'kontrolny/potwierdzenie-model-2.1.314.txt': confirm('Opus 5.5'),
  'kontrolny/potwierdzenie-model-2.1.316.txt': confirm('Opus 5.5'),
  'kontrolny/potwierdzenie-model-2.1.319.txt': confirm('Opus 5.5'),
  'kontrolny/potwierdzenie-model-fable-2.1.316.txt': confirm('Fable 5.1'),
  'kontrolny/potwierdzenie-model-fable-2.1.319.txt': confirm('Fable 5.1'),
  'kontrolny/potwierdzenie-model-haiku-2.1.316.txt': confirm('Haiku 5.5'),
  'kontrolny/potwierdzenie-model-haiku-2.1.319.txt': confirm('Haiku 5.5'),
  'kontrolny/potwierdzenie-model-opus-1m-2.1.316.txt': confirm('Opus 5.5'),
  'kontrolny/potwierdzenie-model-opus-1m-2.1.319.txt': confirm('Opus 5.5'),
  'kontrolny/potwierdzenie-model-opus-2.1.316.txt': confirm('Opus 5.5'),
  'kontrolny/potwierdzenie-model-opus-2.1.319.txt': confirm('Opus 5.5'),
  'kontrolny/potwierdzenie-model-sonnet-2.1.316.txt': confirm('Sonnet 5.5'),
  'kontrolny/potwierdzenie-model-sonnet-2.1.319.txt': confirm('Sonnet 5.5'),
  'dialog-resume-summary-2.1.258.txt': [
    'Resume from summary (recommended)', 'Resume full session as-is', "Don't ask me again",
  ],
  'dialog-effort-change.txt': ['Yes, switch to high', 'No, go back'],
  'dialog-model-switch.txt': ['Yes, switch to Opus 5', 'No, go back'],
  'kontrolny/picker-model-klucz-api-2.1.314.txt': PICKER_WIDE,
  'kontrolny/picker-model-klucz-api-2.1.316.txt': PICKER_WIDE,
  'kontrolny/picker-model-klucz-api-2.1.319.txt': PICKER_WIDE,
  'measured/picker-model-2.1.312-26kol.txt': [
    'Defau…  Opus 5.5 · Best for every day, compl ex tasks',
    'Opus …  For compl ex work and every day tasks',
    'Fable…  For your tough est chall enges',
    'Sonne…  Most effic ient for simpl er tasks',
    'Hai… ✔  Faste st for quick answ ers',
    'Haiku…  Faste st for quick answ ers',
    'Sonne…  Effic ient for routi ↓',
  ],
};
const BASES = Object.keys(TRUTH);

const linesOf = (name: string): string[] => trimmedLines(readFileSync(join(DIR, name), 'utf8'));
const verdictOf = (lines: readonly string[]): Layer2Verdict => layer2Verdict(readBlock(lines.join('\n')), 'dialog');

/** Base screens whose footer says "Enter to set as default": the rule refuses them before it reads the options. */
const SETS_DEFAULT_BASES: ReadonlySet<string> = new Set([
  'kontrolny/picker-model-klucz-api-2.1.314.txt',
  'kontrolny/picker-model-klucz-api-2.1.316.txt',
  'kontrolny/picker-model-klucz-api-2.1.319.txt',
]);

/**
 * The refusal a variant of `base` must give: `readerWhy`, or `sets-default` under a footer that sets a default. There
 * the reader must still find `readerWhy`, so the mutation stays checked; a different reading returns a mismatch.
 */
function refusalOf(base: string, lines: readonly string[], readerWhy: string): string {
  if (!SETS_DEFAULT_BASES.has(base)) return readerWhy;
  const block = readBlock(lines.join('\n'));
  const reading = block === null ? null : readOptions(block);
  if (reading?.kind === 'error' && reading.why === readerWhy) return 'sets-default';
  return `reader gave ${reading?.kind ?? 'no block'}`;
}

/** A raw option row: indentation, optional focus marker, digit, label (own pattern, not the module's). */
const ROW = /^( *(?:❯ +)?)(\d{1,2})\. (.*)$/u;
const optionRows = (lines: readonly string[]): number[] =>
  lines.flatMap((line, i) => (ROW.test(line) ? [i] : []));
const labelColumn = (line: string): number => {
  const hit = ROW.exec(line);
  return hit === null ? -1 : line.length - (hit[3] ?? '').trimStart().length;
};

/** Pairs a verdict gives that the base screen does not have, as `digit: label`. */
function badPairs(verdict: Layer2Verdict, base: string): string[] {
  if (verdict.kind !== 'choices') return [];
  const truth = TRUTH[base] ?? [];
  return verdict.choices.flatMap((choice) => ('digit' in choice.send && truth[choice.send.digit - 1] !== choice.label
    ? [`${choice.send.digit}: ${choice.label}`]
    : []));
}

/** Digits of the base a verdict with buttons leaves out: buttons over a part of the list. */
function missingDigits(verdict: Layer2Verdict, base: string): number[] {
  if (verdict.kind !== 'choices') return [];
  const given = new Set(verdict.choices.flatMap((choice) => ('digit' in choice.send ? [choice.send.digit] : [])));
  return (TRUTH[base] ?? []).map((_, i) => i + 1).filter((digit) => !given.has(digit));
}

describe('bases: 20 measured dialogs with digits, 55 option lines', () => {
  it('each base has the truth labels on its option lines, digit by digit', () => {
    expect(BASES).toHaveLength(20);
    let pairs = 0;
    for (const base of BASES) {
      const lines = linesOf(base);
      const reading = readOptions(readBlock(lines.join('\n')) ?? (() => { throw new Error(base); })());
      if (reading.kind === 'digitless') throw new Error(`${base}: no digits`);
      expect(reading.options.map((option) => option.label), base).toEqual(TRUTH[base]);
      pairs += reading.options.length;
    }
    expect(pairs).toBe(55);
  });
});

describe('cut bottom: 220 variants (11 per base) give buttons only with proof of the end, 0 bad pairs', () => {
  const variants = BASES.flatMap((base) => Array.from({ length: 11 }, (_, i) => {
    const lines = linesOf(base);
    return { base, k: i + 1, lines: lines.slice(0, lines.length - (i + 1)) };
  }));

  it('220 variants; every one with buttons has the whole list, the truth pairs and an end proof', () => {
    expect(variants).toHaveLength(220);
    const failures: string[] = [];
    let withButtons = 0;
    for (const { base, k, lines } of variants) {
      const verdict = verdictOf(lines);
      if (verdict.kind !== 'choices') continue;
      withButtons += 1;
      const block = readBlock(lines.join('\n'));
      const proven = verdict.proof === 'footer' ? block?.footer !== null : shapeOf(block) !== null;
      if (!proven) failures.push(`${base} -${k}: no end proof`);
      for (const bad of badPairs(verdict, base)) failures.push(`${base} -${k}: bad pair ${bad}`);
      if (missingDigits(verdict, base).length > 0) failures.push(`${base} -${k}: part of the list`);
    }
    expect(failures).toEqual([]);
    // Cutting one line takes the footer or the last option away: no cut variant keeps its buttons.
    expect(withButtons).toBe(0);
  });
});

describe('wrapped label: 55 variants (each option line wrapped once) read back the whole label', () => {
  /** The option line `row` wrapped at its last space, the tail on its own line at the label column. */
  function wrapped(lines: readonly string[], row: number): string[] | null {
    const line = lines[row] ?? '';
    const column = labelColumn(line);
    const cut = line.lastIndexOf(' ');
    if (column < 0 || cut <= column) return null;
    return [...lines.slice(0, row), line.slice(0, cut), `${' '.repeat(column)}${line.slice(cut + 1)}`,
      ...lines.slice(row + 1)];
  }

  const variants = BASES.flatMap((base) => {
    const lines = linesOf(base);
    return optionRows(lines).map((row) => ({ base, row, lines: wrapped(lines, row) }));
  });

  it('55 variants, each a real wrap', () => {
    expect(variants).toHaveLength(55);
    expect(variants.filter((variant) => variant.lines === null).map((variant) => variant.base)).toEqual([]);
  });

  it('the reader joins every wrapped label back whole', () => {
    const collapse = (labels: readonly string[]): string => JSON.stringify(labels.map((l) => l.replace(/\s+/gu, ' ')));
    const failures: string[] = [];
    for (const { base, row, lines } of variants) {
      const block = readBlock((lines ?? []).join('\n'));
      const reading = block === null ? null : readOptions(block);
      const labels = reading === null || reading.kind === 'digitless' ? [] : reading.options.map((o) => o.label);
      if (collapse(labels) !== collapse(TRUTH[base] ?? [])) failures.push(`${base} line ${row}: ${labels}`);
    }
    expect(failures).toEqual([]);
  });

  it('buttons only where the base has them, with the same whole labels; a confirmation may lose its shape proof', () => {
    const failures: string[] = [];
    const outcomes = new Map<string, number>();
    for (const { base, row, lines } of variants) {
      const verdict = verdictOf(lines ?? []);
      const before = verdictOf(linesOf(base));
      for (const bad of badPairs(verdict, base)) failures.push(`${base} line ${row}: bad pair ${bad}`);
      const outcome = verdict.kind === 'choices' ? 'choices' : verdict.why;
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      if (verdict.kind === 'none') {
        // A wrapped confirmation is no longer the registry shape, so its end is unproven (`cut-bottom`); a wrap that
        // leaves `…` at a line end is `label-cut`. Both are refusals.
        continue;
      }
      if (before.kind !== 'choices' || JSON.stringify(verdict.choices) !== JSON.stringify(before.choices)) {
        failures.push(`${base} line ${row}: ${JSON.stringify(verdict)}`);
      }
    }
    expect(failures).toEqual([]);
    // Resume summary keeps its buttons (footer proof); confirmations lose the shape; the pickers stay refused (the
    // wide `/model` picker on its "Enter to set as default" footer, the narrow one on its scroll marker).
    expect(Object.fromEntries(outcomes)).toEqual({
      choices: 3, 'cut-bottom': 26 + 4, 'sets-default': 15, 'label-cut': 6, scroll: 1,
    });
  });
});

describe('shifted numbering: 40 variants (+1 and from 0) are always `numbering`', () => {
  function shifted(lines: readonly string[], by: number): string[] {
    return lines.map((line) => line.replace(ROW, (_, lead: string, digit: string, rest: string) =>
      `${lead}${Number(digit) + by}. ${rest}`));
  }
  const variants = BASES.flatMap((base) => [1, -1].map((by) => ({ base, by, lines: shifted(linesOf(base), by) })));

  it('40 variants, each `numbering` (`sets-default` first under that footer), never keys from the footer', () => {
    expect(variants).toHaveLength(40);
    const failures = variants
      .map(({ base, by, lines }) => ({
        name: `${base} ${by > 0 ? '+1' : 'from 0'}`,
        verdict: verdictOf(lines),
        want: refusalOf(base, lines, 'numbering'),
      }))
      .filter(({ verdict, want }) => verdict.kind !== 'none' || verdict.why !== want)
      .map(({ name, verdict }) => `${name}: ${JSON.stringify(verdict)}`);
    expect(failures).toEqual([]);
  });
});

describe('two dialogs: 20 variants count only the bottom block', () => {
  const variants = BASES.map((upper, i) => {
    const lower = BASES[(i + 1) % BASES.length] ?? '';
    return { upper, lower, lines: [...linesOf(upper), '', ...linesOf(lower)] };
  });

  it('20 variants: the verdict of the bottom dialog alone or a refusal, never a pair of the upper one', () => {
    expect(variants).toHaveLength(20);
    const failures: string[] = [];
    const refused: string[] = [];
    for (const { upper, lower, lines } of variants) {
      const verdict = verdictOf(lines);
      for (const bad of badPairs(verdict, lower)) failures.push(`${upper} over ${lower}: bad pair ${bad}`);
      if (JSON.stringify(verdict) === JSON.stringify(verdictOf(linesOf(lower)))) continue;
      if (verdict.kind === 'none') refused.push(`${upper} over ${lower}: ${verdict.why}`);
      else failures.push(`${upper} over ${lower}: ${JSON.stringify(verdict)}`);
    }
    expect(failures).toEqual([]);
    // The seven-option list above a confirmation hides its digits from `readBlock` (the region search sees both
    // lists), so the rule finds options the reader did not and refuses: fail-closed. A list above a wide `/model`
    // picker gives the picker's own refusal (`sets-default`).
    expect(refused).toEqual([
      'measured/picker-model-2.1.312-26kol.txt over kontrolny/potwierdzenie-model-2.1.314.txt: numbering',
    ]);
  });
});

describe('foreign line: 20 variants (a line left of the label column after option 1) are `foreign-line`', () => {
  function withForeign(lines: readonly string[]): string[] {
    const rows = optionRows(lines);
    const first = rows[0] ?? -1;
    const second = rows[1] ?? -1;
    // After option 1 and its continuation lines, right above option 2.
    const at = second > first ? second : first + 1;
    const column = labelColumn(lines[first] ?? '');
    return [...lines.slice(0, at), `${' '.repeat(Math.max(0, column - 4))}A line from elsewhere`, ...lines.slice(at)];
  }
  const variants = BASES.map((base) => ({ base, lines: withForeign(linesOf(base)) }));

  it('20 variants, each `foreign-line` (`sets-default` first under that footer)', () => {
    expect(variants).toHaveLength(20);
    const failures = variants
      .map(({ base, lines }) => ({ base, verdict: verdictOf(lines), want: refusalOf(base, lines, 'foreign-line') }))
      .filter(({ verdict, want }) => verdict.kind !== 'none' || verdict.why !== want)
      .map(({ base, verdict }) => `${base}: ${JSON.stringify(verdict)}`);
    expect(failures).toEqual([]);
  });
});

describe('cut wrapped footer: a key segment without its action ("Esc to", "Enter to") is `cut-bottom`', () => {
  const PICKER = 'measured/picker-effort-2.1.312-26kol.txt';
  const picker = linesOf(PICKER);
  const adjustAt = picker.findIndex((line) => line.trim() === '←/→ to adjust ·');
  const cases: { name: string; lines: string[] }[] = [
    // The measured footer ends "only · Esc to" / "cancel": cutting the last line leaves "Esc to".
    { name: `${PICKER} without its last line`, lines: picker.slice(0, -1) },
    // The same footer wrapped one column narrower ("Enter to" / "confirm ·"), cut after "Enter to".
    { name: `${PICKER} cut after "Enter to"`, lines: [...picker.slice(0, adjustAt + 1), '   Enter to'] },
    // A dialog with digits under a wrapped footer cut after "Esc to".
    {
      name: 'kontrolny/potwierdzenie-model-2.1.319.txt with a footer cut after "Esc to"',
      lines: [...linesOf('kontrolny/potwierdzenie-model-2.1.319.txt'), '', '   Enter to confirm ·', '   Esc to'],
    },
  ];

  it('the whole measured footer still gives the Esc button (control)', () => {
    expect(adjustAt).toBeGreaterThan(0);
    const verdict = verdictOf(picker);
    expect(verdict.kind).toBe('choices');
    if (verdict.kind !== 'choices') return;
    expect(verdict.choices).toContainEqual({ label: 'Esc to cancel', send: { key: 'escape' } });
  });

  for (const { name, lines } of cases) {
    it(name, () => {
      expect(verdictOf(lines)).toEqual({ kind: 'none', why: 'cut-bottom' });
    });
  }
});
