/**
 * The thread of the consent dialog standing on screen (`dialogThreadOnScreen` in `herdr/dialogs/screen/parse.ts`),
 * read from the title line of its block: `subagent` with the subagent suffix, `main` without it, `null` when no title
 * line can be read. A subagent dialog whose title is above the pane edge must never read as the main thread's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dialogThreadOnScreen } from '../src/herdr/dialogs/index.ts';

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', 'herdr', name), 'utf8');

describe('dialogThreadOnScreen', () => {
  it.each([
    'dialog-permission-subagent.txt',
    'dialog-bash-subagent-naglowek-2.1.302.txt',
    'dialog-permission-cd-advisory-2.1.265.txt',
    'measured/zgoda-webfetch-2.1.322.txt',
    'measured/zgoda-webfetch-prompt-wieloliniowy-2.1.322.txt',
    'measured/zgoda-webfetch-waski-2.1.322.txt',
  ])('title with the subagent suffix: %s → subagent', (name) => {
    expect(dialogThreadOnScreen(fixture(name))).toBe('subagent');
  });

  it.each([
    'dialog-permission.txt',
    'dialog-permission-unsandboxed.txt',
    'measured/zgoda-bash-2.1.293.txt',
  ])('title without the suffix: %s → main', (name) => {
    expect(dialogThreadOnScreen(fixture(name))).toBe('main');
  });

  it.each([
    'dialog-bash-subagent-telefon-2.1.302.txt',
    'dialog-bash-subagent-uciety-62x29-2.1.309.txt',
    'dialog-bash-uciety-naglowek-2.1.294.txt',
  ])('title above the pane edge: %s → null, never main', (name) => {
    expect(dialogThreadOnScreen(fixture(name))).toBeNull();
  });

  it('the same dialog with its rule and title lines cut off → null', () => {
    const lines = fixture('dialog-permission-subagent.txt').split('\n');
    const title = lines.findIndex((line) => / · from the .* agent/.test(line));
    expect(title).toBeGreaterThan(0);
    expect(dialogThreadOnScreen(lines.slice(title + 1).join('\n'))).toBeNull();
  });

  it('a suffix line with no option list under it is no dialog → null', () => {
    expect(dialogThreadOnScreen('Bash command · from the general-purpose agent\n')).toBeNull();
  });
});
