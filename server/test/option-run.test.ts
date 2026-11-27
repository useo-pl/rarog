/**
 * Which numbered run is the option list (`screen/option-run.ts`): the run above the key footer, not a numbered list in
 * the dialog body, and not a numbered line behind the question gutter. Cases from the workflow approval captures
 * (CLI 2.1.322) and synthetic screens for the fail-closed edges; description: `docs/dialogs.md`, "Dialog block".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBlock } from '../src/herdr/dialogs/layer2/read-block.ts';
import { routeScreenOf } from '../src/herdr/dialogs/router.ts';
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

/**
 * A question form whose question wraps, each of its lines behind a `│` gutter (the geometry of the fixture
 * `dialog-askuserquestion-multiq-pytanie-w-ramce.txt`). `wrapped` is the line of the question that the wrap starts
 * with a digit and a dot.
 */
function gutterForm(wrapped: string): string {
  const wide = '─'.repeat(83);
  return [
    '', '  Searched for 1 pattern, ran 3 shell commands', wide, ' ☐ Counter', '',
    '│ The review found one thing the older app shows differently: the counter on the',
    '│ tile. The server counts a stalled session as waiting, the app does not, so the',
    '│ app overwrites the number with its own and the next push from the server restores',
    `│ ${wrapped}`,
    '│ opens the session. Do you accept this difference for the older app?',
    '',
    '❯ 1. Accept (Recommended)',
    '     No entry stays in the review and the release goes on. The case is rare and',
    '     goes away with the next app update.',
    '  2. Block the release',
    '     The review ends with a verdict that stops the release until the server',
    '     counts the session the way the older app does.',
    '  3. Type something.',
    wide,
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
    `${'─'.repeat(59)} [A] App review ─`,
    '',
  ].join('\n');
}

describe('option run: a numbered line behind the question gutter', () => {
  const labels = ['Accept (Recommended)', 'Block the release', 'Type something.', 'Chat about this'];

  it('a wrapped question line that repeats an option digit stays question text; the form keeps its options', () => {
    const screen = gutterForm('1. The banner is drawn correctly and a tap on it');
    const parsed = parseOptions(screen);
    expect(parsed?.kind).toBe('question');
    expect(parsed?.options.map((option) => [option.digit, option.label]))
      .toEqual(labels.map((label, i) => [String(i + 1), label]));
    expect(parsed?.options[0]?.description).toContain('No entry stays in the review');
    expect(parsed?.question?.header).toBe('Counter');
    expect(parsed?.question?.question).toContain('restores\n1. The banner is drawn correctly and a tap on it\nopens');
    expect(parsed?.question?.question).not.toContain('│');
    expect(parsed?.bodyPrint).not.toBeNull();
    expect(routeScreenOf(screen)).toBe('form');
    const resolution = resolveOptions(screen, { toolName: 'AskUserQuestion' });
    expect(resolution.status).toBe('ok');
    if (resolution.status !== 'ok') throw new Error('unreachable');
    expect([...resolution.digitByLabel]).toEqual(labels.map((label, i) => [label, String(i + 1)]));
  });

  it('a wrapped question line with the next free digit does not become a fifth option', () => {
    const parsed = parseOptions(gutterForm('5. The banner is drawn correctly and a tap on it'));
    expect(parsed?.options.map((option) => option.digit)).toEqual(['1', '2', '3', '4']);
    expect(parsed?.question?.question).toContain('\n5. The banner is drawn correctly and a tap on it\n');
  });

  it('a numbered question line indented behind the gutter goes on the card without the gutter', () => {
    const parsed = parseOptions(gutterForm('  1. The banner is drawn correctly and a tap on it'));
    expect(parsed?.options.map((option) => option.digit)).toEqual(['1', '2', '3', '4']);
    expect(parsed?.question?.question).toContain('\n1. The banner is drawn correctly and a tap on it\n');
  });

  it('options inside a frame with both edges are still read', () => {
    const screen = ['╭──────────────────╮', '│ Apply changes?   │', '│                  │', '│ ❯ 1. Yes         │',
      '│   2. No          │', '╰──────────────────╯'].join('\n');
    expect(digits(screen)).toEqual(['1', '2']);
  });
});

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
