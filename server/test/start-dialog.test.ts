/**
 * Start dialog predicate: a screen herdr reads as ready (`idle`, `interactive_ready`) while Claude Code has not reached
 * its prompt field yet.
 *
 * Captures measured on CLI 2.1.332 at 139 columns: `kontrolny/importy-zewnetrzne-*-2.1.332.txt` (cursor on "No", after
 * `down`, after the trust dialog, and a long import list whose top is above the pane edge). The negative captures are
 * start dialogs herdr already reports as `blocked` (trust, bypass mode, resume summary) and a ready prompt field.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startDialogOf } from '../src/herdr/dialogs/screen/start-dialog.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const read = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');

const IMPORTS = read('kontrolny/importy-zewnetrzne-2.1.332.txt');
const TITLE = 'Allow external CLAUDE.md file imports?';
const NO_LINE = '  ❯ No, disable external imports';
const YES_LINE = '    Yes, allow external imports';
const FOOTER = '  Enter to confirm · Esc to disable';

describe('startDialogOf: the external imports dialog', () => {
  it.each([
    ['cursor on "No"', 'kontrolny/importy-zewnetrzne-2.1.332.txt'],
    ['cursor on "Yes" after `down`', 'kontrolny/importy-zewnetrzne-po-down-2.1.332.txt'],
    ['after the trust dialog', 'kontrolny/importy-zewnetrzne-po-zaufaniu-2.1.332.txt'],
  ])('%s: recognised with the measured title', (_name, file) => {
    expect(startDialogOf(read(file))).toEqual({ id: 'external-imports', title: TITLE });
  });

  it('a long import list with the rule, the title and the first path above the pane edge is still recognised', () => {
    expect(startDialogOf(read('kontrolny/importy-zewnetrzne-dluga-lista-2.1.332.txt')))
      .toEqual({ id: 'external-imports', title: null });
  });

  it.each([
    ['both options marked', IMPORTS.replace(YES_LINE, '  ❯ Yes, allow external imports')],
    ['no option marked', IMPORTS.replace(NO_LINE, '    No, disable external imports')],
    ['options in the other order',
      IMPORTS.replace(NO_LINE, 'SWAP').replace(YES_LINE, NO_LINE).replace('SWAP', YES_LINE)],
    ['a third option under the pair', IMPORTS.replace(YES_LINE, `${YES_LINE}\n    Ask me later`)],
    ['a third option above the pair', IMPORTS.replace(NO_LINE, `    Ask me later\n${NO_LINE}`)],
    ['a line under the footer', `${IMPORTS.trimEnd()}\n  something else`],
    ['the footer of a cancel dialog', IMPORTS.replace('Esc to disable', 'Esc to cancel')],
    ['another title under the rule', IMPORTS.replace(TITLE, 'Allow something else?')],
    ['options without the measured margin',
      IMPORTS.replace(NO_LINE, NO_LINE.slice(1)).replace(YES_LINE, YES_LINE.slice(1))],
  ])('%s: a start dialog without the imports id', (_name, screen) => {
    expect(startDialogOf(screen)?.id).toBeNull();
  });

  it('the footer alone is no proof: the pair above it must be the closed option pair', () => {
    expect(startDialogOf(`\n${FOOTER}\n`)).toEqual({ id: null, title: null });
  });
});

describe('startDialogOf: other start screens', () => {
  it.each([
    ['trust', 'kontrolny/zaufanie-2.1.319.txt', 'Accessing workspace:'],
    ['bypass mode', 'kontrolny/tryb-bypass-2.1.319.txt', 'WARNING: Claude Code running in Bypass Permissions mode'],
    ['resume summary', 'dialog-resume-summary-2.1.258.txt', 'This session is 5d 8h old and 778.9k tokens.'],
  ])('%s: a start dialog without an id, titled from its block', (_name, file, title) => {
    expect(startDialogOf(read(file))).toEqual({ id: null, title });
  });

  it('an empty prompt field is no start dialog', () => {
    expect(startDialogOf(read('composer-region-empty-2.1.283.ansi.txt'))).toBeNull();
  });

  it('a screen without any text is no start dialog', () => {
    expect(startDialogOf('')).toBeNull();
    expect(startDialogOf('\n   \n\u001b[0m\n')).toBeNull();
  });

  it('a screen without a prompt field and without a rule is a start dialog without a title', () => {
    expect(startDialogOf('$ claude --session-id 00000000-0000-4000-9000-000000000001\n'))
      .toEqual({ id: null, title: null });
  });
});
