/**
 * The `ExitPlanMode` dialog with its question wrapped by a narrow pane. The plan signatures match one sentence of the
 * dialog region; a pane narrower than that sentence breaks it onto two lines, and the dialog has to keep the name
 * `ExitPlanMode` and the options of a wide pane (`docs/implementation-spec.md`, "Dialogs and cards in a herdr pane").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const screen = (name: string): string => readFileSync(join(DIR, name), 'utf8');

function replaced(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`no anchor: ${from}`);
  return text.replace(from, to);
}

/** 50 columns: "…and is ready to" and "execute. Would you like to proceed?" on two lines. */
const NARROW = screen('dialog-exitplanmode-50kol-2.1.331.txt');
const WIDE = screen('measured/exitplanmode-2.1.258.txt');
const NO_PLAN = screen('measured/exitplanmode-bez-planu-2.1.328.txt');
/** "Exit plan mode?" with its sentence broken after "exit", as a pane narrower than the sentence shows it. */
const NO_PLAN_WRAPPED = replaced(
  NO_PLAN, '    Claude wants to exit plan mode\n', '    Claude wants to exit\n    plan mode\n',
);

/** A single-choice question form whose author quotes the plan sentence, wrapped like a narrow pane wraps it. */
const QUESTION = screen('measured/pytanie-jednokrotne.txt');
const QUESTION_QUOTING_PLAN = replaced(
  QUESTION, 'Jaki smak lodów?\n',
  'Does this message read correctly?\nClaude has written up a plan and is ready to\nexecute.\n',
);

const optionsOf = (text: string): unknown => {
  const resolved = resolveOptions(text, { toolName: 'ExitPlanMode' });
  return resolved.status === 'ok' ? resolved.options : resolved;
};

describe('plan dialog with its question wrapped by a narrow pane', () => {
  it.each([
    ['plan with a file, 50 columns', NARROW, WIDE],
    ['exit without a plan, sentence wrapped', NO_PLAN_WRAPPED, NO_PLAN],
  ])('%s: the name and the buttons of the wide pane', (_shape, narrow, wide) => {
    expect(parseOptions(narrow)).toMatchObject({ kind: 'tool', toolName: 'ExitPlanMode' });
    expect(optionsOf(narrow)).toEqual(optionsOf(wide));
  });

  it('the plan file name comes from the footer broken after `~/.claude/plans/`', () => {
    expect(parseOptions(NARROW)?.planFile).toBe('demo-plan.md');
  });
});

describe('plan sentence quoted inside a question form', () => {
  it('the form keeps its kind and its options', () => {
    expect(parseOptions(QUESTION_QUOTING_PLAN)).toMatchObject({ kind: 'question' });
    const quoting = resolveOptions(QUESTION_QUOTING_PLAN, { toolName: 'AskUserQuestion' });
    const plain = resolveOptions(QUESTION, { toolName: 'AskUserQuestion' });
    expect(quoting.status).toBe('ok');
    expect(quoting.status === 'ok' && plain.status === 'ok' ? quoting.options : quoting)
      .toEqual(plain.status === 'ok' ? plain.options : plain);
  });
});
