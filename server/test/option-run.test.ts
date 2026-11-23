/**
 * Which numbered run is the option list (`screen/option-run.ts`): the run above the key footer, not a numbered list in
 * the dialog body. Cases from the workflow approval captures (CLI 2.1.322) and synthetic screens for the fail-closed
 * edges; description: `docs/dialogs.md`, "Dialog block".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBlock } from '../src/herdr/dialogs/layer2/read-block.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr', 'kontrolny');
const read = (name: string): string => readFileSync(join(DIR, name), 'utf8');
const digits = (screen: string): string[] | undefined => parseOptions(screen)?.options.map((option) => option.digit);

const RULE = '─'.repeat(40);

/** A dialog with a numbered list in its body, options under it and a key footer. */
function dialog(options: readonly string[], body: readonly string[] = ['  1. First step', '  2. Second step']): string {
  return [RULE, ' Run it?', '', '  Steps:', ...body, '', '  Plain text under the list.', '', ...options, '',
    '  Esc to cancel · Tab to amend'].join('\n');
}

describe('option run: a numbered list in the dialog body', () => {
  it('phase summary: options 1–3, the phase list stays in the card text', () => {
    for (const name of ['zatwierdzenie-workflow-2.1.322.txt', 'zatwierdzenie-workflow-waski-2.1.322.txt']) {
      const parsed = parseOptions(read(name));
      expect(parsed?.options.map((option) => [option.digit, option.label]), name).toEqual([
        ['1', 'Yes, run it'], ['2', 'View raw script'], ['3', 'No'],
      ]);
      expect(parsed?.question?.question, name).toContain('2. Report');
      expect(readBlock(read(name))?.options.map((option) => option.digit), name).toEqual(['1', '2', '3']);
    }
  });

  it('auto variant: phase lines above a digitless choice give no options', () => {
    const screen = read('zatwierdzenie-workflow-auto-bez-kontroli-2.1.322.txt');
    expect(parseOptions(screen)).toBeNull();
    const block = readBlock(screen);
    expect(block?.title).toBe('Run a dynamic workflow?');
    expect(block?.options).toEqual([]);
  });

  it('a synthetic body list above the options: the options are the run above the footer', () => {
    expect(digits(dialog(['  ❯ 1. Yes', '    2. No']))).toEqual(['1', '2']);
  });

  it('a digit repeated inside the bottom run (repaint) stays unreadable, also with a wrapped label', () => {
    expect(digits(dialog(['  ❯ 1. Yes', '    2. Yes, and do not ask again for', '       this command', '    1. No'])))
      .toBeUndefined();
    expect(digits(dialog(['  ❯ 1. Yes', '    2. Yes, and do not ask again', '    1. No'], []))).toBeUndefined();
  });

  it('text under the bottom run (not footer chrome) keeps the region unreadable', () => {
    const screen = dialog(['  ❯ 1. Yes', '    2. No']).replace('  Esc to cancel', '  Some sentence\n  Esc to cancel');
    expect(digits(screen)).toBeUndefined();
  });

  it('a digitless choice under a lone numbered list, without a key footer, keeps the digits', () => {
    const screen = [RULE, ' Pick one', '', '  1. Alpha', '  2. Beta', '', '  ❯ Other'].join('\n');
    expect(digits(screen)).toEqual(['1', '2']);
    expect(digits(`${screen}\n\n  Enter to confirm · Esc to cancel`)).toBeUndefined();
  });

  it('a description in the digit column belongs to its option: a digit repeated under it stays unreadable', () => {
    const options = ['  ❯ 1. Yes', '    2. Something else', '    A description', '    1. No'];
    for (const screen of [dialog(options), dialog(options, [])]) {
      expect(digits(screen)).toBeUndefined();
      const resolution = resolveOptions(screen, null);
      expect(resolution.status).toBe('no-jsonl');
      if (resolution.status !== 'no-jsonl') throw new Error('unreachable');
      expect(resolution.questionForm).toBeNull();
    }
  });

  it('a wrapped label in the option run under the phase list comes back whole', () => {
    const screen = read('zatwierdzenie-workflow-2.1.322.txt')
      .replace('    2. View raw script', '    2. View raw\n       script');
    expect(parseOptions(screen)?.options).toEqual([
      { digit: '1', label: 'Yes, run it' }, { digit: '2', label: 'View raw script' }, { digit: '3', label: 'No' },
    ]);
  });

  it('a confirmation keeps its numbered list and the sentence under it in the card text', () => {
    const screen = [RULE, ' Apply changes?', '', '  Changes:', '  1. Alpha', '  2. Beta', '',
      '  This discards the pending work.', '', '  ❯ 1. Yes', '    2. No', '', '  Enter to confirm · Esc to cancel'].join('\n');
    const parsed = parseOptions(screen);
    expect(parsed?.kind).toBe('confirm');
    const text = 'Apply changes?\nChanges:\n1. Alpha\n2. Beta\nThis discards the pending work.';
    expect(parsed?.question?.question).toBe(text);
    expect(parsed?.options.map((option) => option.label)).toEqual(['Yes', 'No']);
    const resolution = resolveOptions(screen, null);
    if (resolution.status !== 'no-jsonl') throw new Error('unreachable');
    expect(resolution.questionForm?.question).toBe(text);
  });
});
