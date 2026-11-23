/**
 * Ground-truth manifest for layer 2 (`fixtures/herdr/warstwa2-prawda.json`): one hand-written entry per corpus
 * screen with its category, CLI registry class, expected rule-v2 verdict and the digit pairs read from the screen.
 *
 * The first blocks check the manifest against the screens only, without the card decision or the layer 2 rule, so the
 * manifest stays independent of the code it judges. What they check:
 *
 * - every `.txt` screen of the corpus has exactly one entry, and the split is 55 layer 2, 240 consents, 57 forms
 *   and 43 non-dialogs;
 * - the class agrees with the measured class where one exists (capture header `cliDialog`, control-set `waitingFor`);
 * - 74 digit pairs, each label standing verbatim on the screen line with that digit (wrapped labels line by line), and
 *   every digit option line of a layer 2 screen is a pair;
 * - every digit choice of an expected verdict is a pair, every key choice names a key from its own footer segment;
 * - the `TERMINAL_DIALOGS` screens carry both verdicts (without and with a key confirmation);
 * - the coverage table of the layer 2 plan (today, with the card step, after the terminal dialogs) follows from the
 *   entries.
 *
 * The last block runs `layer2Verdict` on every screen and compares it with the manifest: 395 verdicts plus 4 with a
 * key confirmation, no digit button outside the pairs, no card on the 43 non-dialogs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_DIALOG_CLASSES } from '../../shared/src/protocol.ts';
import type { CliDialogClass } from '../../shared/src/protocol.ts';
import { LAYER2_WHYS } from '../src/herdr/dialogs/layer2/card.ts';
import { readBlock } from '../src/herdr/dialogs/layer2/read-block.ts';
import { layer2Verdict } from '../src/herdr/dialogs/layer2/verdict.ts';
import type { Layer2Choice, Layer2Proof, Layer2Verdict } from '../src/herdr/dialogs/layer2/verdict.ts';
import { TERMINAL_DIALOG_IDS } from '../src/herdr/dialogs/policy/terminal.ts';
import type { TerminalDialogId } from '../src/herdr/dialogs/policy/terminal.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const MANIFEST = join(DIR, 'warstwa2-prawda.json');
const MARK = '\n--- ekran ---\n';

/** Corpus directories relative to `fixtures/herdr/`: every directory that holds pane captures. */
const DIRS = ['', 'measured/', 'refusals/', 'queue/measured/', 'kontrolny/', 'ultracode/'] as const;

const CORPUS = DIRS.flatMap((sub) => readdirSync(join(DIR, sub))
  .filter((name) => name.endsWith('.txt'))
  .map((name) => `${sub}${name}`))
  .sort();

type Category = 'layer2' | 'consent' | 'form' | 'non-dialog';
type DialogKey = 'up' | 'down' | 'left' | 'right' | 'tab' | 'enter' | 'escape';

interface Pair { readonly line: number; readonly digit: number; readonly label: string; readonly wrap?: string[] }
type Choice =
  | { readonly digit: number; readonly label: string }
  | { readonly key: DialogKey; readonly label: string; readonly segment?: string };
type Verdict =
  | { readonly kind: 'none'; readonly why: string }
  | { readonly kind: 'choices'; readonly end: 'shape' | 'footer' | 'terminal-match'; readonly choices: Choice[] };

interface Entry {
  readonly category: Category;
  readonly class: string | null;
  readonly today?: 'buttons' | 'unreadable' | 'no-jsonl' | 'terminal-only';
  readonly terminalDialog?: string;
  readonly v2: Verdict;
  readonly v2Confirmed?: Verdict;
  readonly planned?: string;
  readonly pairs?: Pair[];
  readonly note?: string;
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
  version: number; about: string[]; screens: Record<string, Entry>;
};
const entries = Object.entries(manifest.screens);
const layer2 = entries.filter(([, entry]) => entry.category === 'layer2');

/**
 * Closed list of layer 2 reasons from the plan contract (reading errors, caution refusals, refusals on tap). It
 * mirrors `LAYER2_WHYS` once that list is complete; until then the manifest is checked against this copy.
 */
const WHYS: readonly string[] = [
  'no-block', 'numbering', 'foreign-line', 'extra-below', 'submit-unknown', 'frame', 'multi-select', 'submenu',
  'block-no-digits', 'label-ambiguous',
  'unstable', 'class-not-dialog', 'class-unknown', 'terminal-dialog', 'too-many', 'label-cut', 'scroll', 'cut-bottom',
  'rule-above', 'engine-not-claude', 'layer2-off', 'sets-default',
  'screen-changed', 'stale-card', 'hook', 'session-moved',
];

/** Option line of rule v2: optional indent and focus marker, `N. `, label. */
const OPTION_LINE = /^( *(?:❯ +)?)(\d{1,2})\. (.*)$/;

/** Screen text of a capture; a refusal dump (`refusals/`) has a `key: value` header above the screen. */
function screenOf(name: string): string {
  const raw = readFileSync(join(DIR, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at < 0 ? raw : raw.slice(at + MARK.length);
}

const linesOf = (name: string): string[] => screenOf(name).split('\n').map((line) => line.trimEnd());

/** Screen text with every line trimmed and joined by one space: a footer wrapped over lines reads as one line. */
const flatOf = (name: string): string => linesOf(name).map((line) => line.trim()).filter((line) => line !== '')
  .join(' ');

const fullLabel = (pair: Pair): string => [pair.label, ...(pair.wrap ?? [])].join(' ');

/** Column where the label starts on an option line (after `N. ` and any extra spaces). */
function labelColumn(line: string): number {
  const match = OPTION_LINE.exec(line);
  if (match === null) throw new Error(`not an option line: ${line}`);
  const [, lead = '', digit = '', tail = ''] = match;
  return lead.length + digit.length + 2 + (tail.length - tail.trimStart().length);
}

/** Key a footer label starts with, as the plan contract names it. */
function keyOfLabel(label: string): DialogKey | null {
  const first = label.split(' ')[0];
  const keys: Record<string, DialogKey> = {
    '←': 'left', '→': 'right', '↑': 'up', '↓': 'down', Tab: 'tab', Enter: 'enter', Esc: 'escape',
  };
  return first === undefined ? null : keys[first] ?? null;
}

const verdictsOf = (entry: Entry): Verdict[] => [entry.v2, ...(entry.v2Confirmed ? [entry.v2Confirmed] : [])];

describe('layer 2 truth manifest: corpus and split', () => {
  it('one entry per corpus screen: 395 screens, no entry without a screen', () => {
    expect(manifest.version).toBe(1);
    expect(CORPUS).toHaveLength(395);
    expect(Object.keys(manifest.screens).sort()).toEqual(CORPUS);
  });

  it('split: 55 layer 2, 240 consents, 57 forms, 43 non-dialogs', () => {
    const count = (category: Category): number => entries.filter(([, entry]) => entry.category === category).length;
    expect({
      layer2: count('layer2'), consent: count('consent'), form: count('form'), nonDialog: count('non-dialog'),
    }).toEqual({ layer2: 55, consent: 240, form: 57, nonDialog: 43 });
  });

  it('class per category: consents permission or sandbox, forms input, non-dialogs none', () => {
    for (const [name, entry] of entries) {
      expect(entry.class === null || (CLI_DIALOG_CLASSES as readonly string[]).includes(entry.class), name).toBe(true);
      if (entry.category === 'consent') expect(['permission', 'sandbox'], name).toContain(entry.class);
      if (entry.category === 'form') expect(entry.class, name).toBe('input');
      if (entry.category === 'non-dialog') expect(entry.class, name).toBeNull();
      if (entry.category === 'layer2') expect([null, 'dialog'], name).toContain(entry.class);
    }
  });

  it('class agrees with the measured class: capture header `cliDialog` and control-set `waitingFor`', () => {
    const measured = new Map<string, string | null>();
    for (const name of CORPUS.filter((file) => file.startsWith('refusals/'))) {
      const header = /^cliDialog: (.+)$/m.exec(readFileSync(join(DIR, name), 'utf8').split(MARK)[0] ?? '')?.[1];
      if (header !== undefined && header !== 'brak') measured.set(name, header);
    }
    const waiting: Record<string, string> = {
      'permission prompt': 'permission', 'input needed': 'input', 'sandbox request': 'sandbox',
      'worker request': 'worker', 'dialog open': 'dialog',
    };
    const control = JSON.parse(readFileSync(join(DIR, 'kontrolny', 'manifest.json'), 'utf8')) as {
      shapes: { file: string; waitingFor: { status: string | null; value: string | null } | null }[];
    };
    for (const shape of control.shapes) {
      if (shape.waitingFor === null) continue;
      measured.set(shape.file, shape.waitingFor.value === null ? null : waiting[shape.waitingFor.value] ?? 'other');
    }
    expect(measured.size).toBeGreaterThan(60);
    for (const [name, cls] of measured) {
      if (manifest.screens[name] !== undefined) expect(manifest.screens[name].class, name).toBe(cls);
    }
  });

  it('screens outside layer 2 expect no choices, with the class reason, and carry no layer 2 fields', () => {
    for (const [name, entry] of entries.filter(([, item]) => item.category !== 'layer2')) {
      expect(entry.v2, name).toEqual({ kind: 'none', why: entry.class === null ? 'class-unknown' : 'class-not-dialog' });
      expect([entry.today, entry.pairs, entry.v2Confirmed, entry.terminalDialog, entry.planned], name)
        .toEqual([undefined, undefined, undefined, undefined, undefined]);
    }
  });

  it('every reason comes from the closed list, every layer 2 entry has a note', () => {
    for (const [name, entry] of entries) {
      for (const verdict of verdictsOf(entry)) {
        if (verdict.kind === 'none') expect(WHYS, name).toContain(verdict.why);
        else expect(verdict.choices.length, name).toBeGreaterThan(0);
      }
    }
    for (const [name, entry] of layer2) expect(entry.note?.length ?? 0, name).toBeGreaterThan(0);
  });
});

describe('layer 2 truth manifest: pairs stand verbatim on the screen', () => {
  it('74 pairs, all on layer 2 screens', () => {
    expect(entries.filter(([, entry]) => entry.pairs !== undefined).every(([, entry]) => entry.category === 'layer2'))
      .toBe(true);
    expect(entries.reduce((sum, [, entry]) => sum + (entry.pairs?.length ?? 0), 0)).toBe(74);
  });

  it.each(layer2.filter(([, entry]) => entry.pairs !== undefined).map(([name]) => name))(
    '%s: digit and label on the same line, continuation lines verbatim at the label column',
    (name) => {
      const lines = linesOf(name);
      const pairs = manifest.screens[name]?.pairs ?? [];
      expect(pairs.map((pair) => pair.digit)).toEqual(pairs.map((_, index) => index + 1));
      for (const pair of pairs) {
        const line = lines[pair.line] ?? '';
        const match = OPTION_LINE.exec(line);
        expect(match?.[2], `${name}:${pair.line}`).toBe(String(pair.digit));
        expect(match?.[3]?.trim(), `${name}:${pair.line}`).toBe(pair.label);
        const column = labelColumn(line);
        (pair.wrap ?? []).forEach((text, offset) => {
          const next = lines[pair.line + 1 + offset] ?? '';
          expect(next.trim(), `${name}:${pair.line + 1 + offset}`).toBe(text);
          expect(next.length - next.trimStart().length, `${name}:${pair.line + 1 + offset}`)
            .toBeGreaterThanOrEqual(column);
        });
        const after = lines[pair.line + 1 + (pair.wrap?.length ?? 0)] ?? '';
        const continues = after.trim() !== '' && !OPTION_LINE.test(after)
          && after.length - after.trimStart().length >= column;
        expect(continues, `${name}: continuation after line ${pair.line} missing from wrap`).toBe(false);
      }
    },
  );

  it('every digit option line of a layer 2 screen is a pair', () => {
    for (const [name, entry] of layer2) {
      const lines = linesOf(name);
      const optionLines = lines.flatMap((line, index) => (OPTION_LINE.test(line) ? [index] : []));
      expect((entry.pairs ?? []).map((pair) => pair.line), name).toEqual(optionLines);
    }
  });
});

describe('layer 2 truth manifest: expected verdicts', () => {
  it('a digit choice is a pair of its screen: same digit, full label', () => {
    for (const [name, entry] of layer2) {
      const pairs = new Map((entry.pairs ?? []).map((pair) => [pair.digit, fullLabel(pair)]));
      for (const verdict of verdictsOf(entry)) {
        if (verdict.kind !== 'choices') continue;
        for (const choice of verdict.choices) {
          if ('digit' in choice) expect(pairs.get(choice.digit), `${name} ${choice.digit}`).toBe(choice.label);
        }
      }
    }
  });

  it('a key choice names its key and comes from a footer segment on the screen', () => {
    for (const [name, entry] of layer2) {
      const flat = flatOf(name);
      for (const verdict of verdictsOf(entry)) {
        if (verdict.kind !== 'choices') continue;
        const keys = verdict.choices.filter((choice) => 'key' in choice);
        expect(new Set(keys.map((choice) => choice.label)).size, name).toBe(keys.length);
        for (const choice of keys) {
          expect(keyOfLabel(choice.label), `${name}: ${choice.label}`).toBe(choice.key);
          const segment = choice.segment ?? choice.label;
          expect(flat, `${name}: ${segment}`).toContain(segment);
          if (choice.segment !== undefined) {
            const [pair, rest] = [segment.slice(0, 3), segment.slice(3)];
            expect(['←/→', '↑/↓'], name).toContain(pair);
            expect(choice.label, name).toBe(`${keyOfLabel(choice.label) === 'left' || keyOfLabel(choice.label) === 'up'
              ? pair[0] : pair[2]}${rest}`);
          }
        }
        if (verdict.choices.some((choice) => 'digit' in choice)) {
          expect(keys.every((choice) => choice.key === 'escape'), `${name}: digits with keys other than Esc`)
            .toBe(true);
        }
      }
    }
  });

  it('the TERMINAL_DIALOGS screens: terminal-dialog without a confirmation, choices with one', () => {
    const terminal = layer2.filter(([, entry]) => entry.terminalDialog !== undefined);
    expect([...new Set(terminal.map(([, entry]) => entry.terminalDialog))].sort())
      .toEqual([...TERMINAL_DIALOG_IDS].sort());
    expect(terminal).toHaveLength(4);
    for (const [name, entry] of terminal) {
      expect(entry.v2, name).toEqual({ kind: 'none', why: 'terminal-dialog' });
      expect(entry.v2Confirmed?.kind, name).toBe('choices');
      // The background work exit under the status rule reads `no-jsonl` today (control-set measurement).
      expect(['terminal-only', 'no-jsonl'], name).toContain(entry.today);
    }
    expect(layer2.filter(([, entry]) => entry.v2Confirmed !== undefined)).toHaveLength(4);
    const exit = manifest.screens['dialog-background-work-exit-2.1.309.txt'];
    const pause = manifest.screens['dialog-session-paused-2.1.309.txt'];
    expect(exit?.v2Confirmed).toMatchObject({ end: 'footer' });
    expect(exit?.v2Confirmed?.kind === 'choices' && exit.v2Confirmed.choices.map((choice) => choice.label))
      .toEqual(['Exit and stop tasks', 'Move to background and exit', 'Stay', 'Esc to cancel']);
    expect(pause?.v2Confirmed).toMatchObject({ end: 'terminal-match' });
    expect(pause?.v2Confirmed?.kind === 'choices' && pause.v2Confirmed.choices.every((choice) => 'digit' in choice))
      .toBe(true);
  });

  it('today: 13 with buttons, 22 unreadable, 17 without a transcript entry, 3 terminal-only', () => {
    const today: Record<string, number> = {};
    for (const [, entry] of layer2) today[entry.today ?? 'missing'] = (today[entry.today ?? 'missing'] ?? 0) + 1;
    expect(today).toEqual({ buttons: 13, unreadable: 22, 'no-jsonl': 17, 'terminal-only': 3 });
  });

  it('coverage table: today 13/13, with the card step 35/43, after terminal dialogs 39/47', () => {
    type State = 'decision' | 'esc-only' | 'none';
    const stateOf = (verdict: Verdict): State => {
      if (verdict.kind === 'none') return 'none';
      return verdict.choices.some((choice) => !('key' in choice) || choice.key !== 'escape') ? 'decision' : 'esc-only';
    };
    const row = (state: (entry: Entry) => State): [number, number] => {
      const states = layer2.map(([, entry]) => state(entry));
      const decision = states.filter((item) => item === 'decision').length;
      return [decision, decision + states.filter((item) => item === 'esc-only').length];
    };
    // Layer 2 never takes buttons away: a screen with today's buttons keeps them whatever rule v2 says.
    const withRule = (entry: Entry): State => (entry.today === 'buttons' ? 'decision' : stateOf(entry.v2));
    const afterTerminal = (entry: Entry): State => (entry.v2Confirmed === undefined
      ? withRule(entry) : stateOf(entry.v2Confirmed));
    expect(row((entry) => (entry.today === 'buttons' ? 'decision' : 'none'))).toEqual([13, 13]);
    expect(row(withRule)).toEqual([35, 43]);
    expect(row(afterTerminal)).toEqual([39, 47]);
    // No screen waits for a plan task and none is `extra-below`. The four wide `/model` pickers are the only
    // `sets-default` screens: their footer says Enter sets the default model for new sessions, and a digit acts as
    // Enter.
    expect(layer2.filter(([, entry]) => entry.planned !== undefined).map(([name]) => name)).toEqual([]);
    expect(layer2.filter(([, entry]) => entry.v2.kind === 'none' && entry.v2.why === 'extra-below')
      .map(([name]) => name)).toEqual([]);
    expect(layer2.filter(([, entry]) => entry.v2.kind === 'none' && entry.v2.why === 'sets-default')
      .map(([name]) => name)).toEqual([
      'kontrolny/picker-model-klucz-api-2.1.314.txt',
      'kontrolny/picker-model-klucz-api-2.1.316.txt',
      'kontrolny/picker-model-klucz-api-2.1.319.txt',
      'kontrolny/picker-model-klucz-api-2.1.322.txt',
    ]);
    expect(layer2.filter(([, entry]) => afterTerminal(entry) === 'none')
      .map(([name, entry]) => [name, entry.v2.kind === 'none' ? entry.v2.why : null]))
      .toEqual([
        ['ekran-login-2.1.293.txt', 'class-unknown'],
        ['kontrolny/picker-model-klucz-api-2.1.314.txt', 'sets-default'],
        ['kontrolny/picker-model-klucz-api-2.1.316.txt', 'sets-default'],
        ['kontrolny/picker-model-klucz-api-2.1.319.txt', 'sets-default'],
        ['kontrolny/picker-model-klucz-api-2.1.322.txt', 'sets-default'],
        ['kontrolny/tryb-bypass-2.1.319.txt', 'class-unknown'],
        ['measured/picker-model-2.1.312-26kol.txt', 'scroll'],
        ['refusals/widok-skills-2.1.310.txt', 'block-no-digits'],
      ]);
  });
});

/** The manifest's verdict in the shape `layer2Verdict` returns: the end proof under its code name, choices with `send`. */
function codeShapeOf(verdict: Verdict): { kind: 'none'; why: string } | {
  kind: 'choices'; proof: Layer2Proof; choices: Layer2Choice[];
} {
  if (verdict.kind === 'none') return verdict;
  const proof: Record<typeof verdict.end, Layer2Proof> = {
    footer: 'footer', shape: 'shape', 'terminal-match': 'terminal-dialog',
  };
  return {
    kind: 'choices',
    proof: proof[verdict.end],
    choices: verdict.choices.map((choice): Layer2Choice => ('digit' in choice
      ? { label: choice.label, send: { digit: choice.digit } }
      : { label: choice.label, send: { key: choice.key } })),
  };
}

/** What `layer2Verdict` gave, without the fields the manifest does not pin (title, block text, print). */
function comparable(verdict: Layer2Verdict): ReturnType<typeof codeShapeOf> {
  return verdict.kind === 'none' ? verdict : { kind: 'choices', proof: verdict.proof, choices: verdict.choices };
}

/**
 * Rule v2 against the manifest: `layer2Verdict(readBlock(screen), class)` on every corpus screen, once with no
 * `TERMINAL_DIALOGS` entry confirmed and once more, for the 4 screens with `v2Confirmed`, with the entry named by
 * `terminalDialog` confirmed. The manifest was written from the screens, so this block is where the code meets it.
 */
describe('layer 2 truth manifest: layer2Verdict agrees on every screen', () => {
  const NONE_CONFIRMED: ReadonlySet<TerminalDialogId> = new Set();
  const verdictOf = (name: string, cliClass: string | null, confirmed: ReadonlySet<TerminalDialogId>): Layer2Verdict =>
    layer2Verdict(readBlock(screenOf(name)), cliClass as CliDialogClass | null, { confirmedTerminal: confirmed });

  it('the closed list of reasons in this file is `LAYER2_WHYS`', () => {
    expect([...WHYS]).toEqual([...LAYER2_WHYS]);
  });

  it.each(entries.map(([name]) => name))('%s: the verdict equals the manifest', (name) => {
    const entry = manifest.screens[name];
    if (entry === undefined) throw new Error(`no entry: ${name}`);
    expect(comparable(verdictOf(name, entry.class, NONE_CONFIRMED))).toEqual(codeShapeOf(entry.v2));
    if (entry.v2Confirmed !== undefined) {
      const confirmed = new Set([entry.terminalDialog as TerminalDialogId]);
      expect(comparable(verdictOf(name, entry.class, confirmed)), `${name} confirmed`)
        .toEqual(codeShapeOf(entry.v2Confirmed));
    }
  });

  it('399 comparisons: 395 screens and 4 with a key confirmation', () => {
    expect(entries.length + entries.filter(([, entry]) => entry.v2Confirmed !== undefined).length).toBe(399);
  });

  it('no digit outside the truth: every digit button stands on its screen line with its whole label', () => {
    let digits = 0;
    for (const [name, entry] of entries) {
      const pairs = new Map((entry.pairs ?? []).map((pair) => [pair.digit, fullLabel(pair)]));
      const confirmations = entry.v2Confirmed === undefined ? [NONE_CONFIRMED]
        : [NONE_CONFIRMED, new Set([entry.terminalDialog as TerminalDialogId])];
      for (const confirmed of confirmations) {
        const verdict = verdictOf(name, entry.class, confirmed);
        if (verdict.kind !== 'choices') continue;
        for (const choice of verdict.choices) {
          if (!('digit' in choice.send)) continue;
          digits += 1;
          expect(pairs.get(choice.send.digit), `${name} ${choice.send.digit}`).toBe(choice.label);
        }
      }
    }
    expect(digits).toBeGreaterThan(0);
  });

  it('the 43 non-dialogs give no card, even read as class `dialog`', () => {
    const nonDialogs = entries.filter(([, entry]) => entry.category === 'non-dialog').map(([name]) => name);
    expect(nonDialogs).toHaveLength(43);
    for (const name of nonDialogs) {
      expect(verdictOf(name, null, NONE_CONFIRMED), name).toEqual({ kind: 'none', why: 'class-unknown' });
      expect(verdictOf(name, 'dialog', NONE_CONFIRMED).kind, `${name} as dialog`).toBe('none');
    }
  });
});
