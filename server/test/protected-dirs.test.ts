/**
 * macOS-protected folders under the home directory (`config/protected-dirs.ts`): which paths a walk that nobody on
 * the phone asked for must not enter, and the exception for a root the owner placed inside such a folder.
 * Pure path logic, no disk.
 */
import { describe, expect, it } from 'vitest';
import { PROTECTED_HOME_DIRS, isProtectedPath } from '../src/config/protected-dirs.ts';

const HOME = '/Users/demo';

describe('isProtectedPath', () => {
  it('lists the folders macOS guards with a privacy prompt', () => {
    expect([...PROTECTED_HOME_DIRS].sort()).toEqual(
      ['Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures'],
    );
  });

  it.each([
    ['protected folder itself, root = home', `${HOME}/Desktop`, [HOME], true],
    ['inside a protected folder, root = home', `${HOME}/Documents/x/y`, [HOME], true],
    ['Library, root = home', `${HOME}/Library`, [HOME], true],
    ['every listed folder', `${HOME}/Pictures`, ['/'], true],
    ['other case on a case-insensitive disk', `${HOME}/desktop/x`, [HOME], true],
    ['a letter that disk folds to s (long s)', `${HOME}/De\u017fktop/x`, [HOME], true],
    ['ordinary folder under home', `${HOME}/Projects/x`, [HOME], false],
    ['home itself', HOME, [HOME], false],
    ['root inside Documents covers its subtree', `${HOME}/Documents/Projects/a`, [`${HOME}/Documents/Projects`], false],
    ['root inside Documents covers itself', `${HOME}/Documents/Projects`, [`${HOME}/Documents/Projects`], false],
    ['root = Documents covers Documents', `${HOME}/Documents/x`, [`${HOME}/Documents`], false],
    ['sibling of a root inside Documents stays protected', `${HOME}/Documents/Other`, [`${HOME}/Documents/Projects`], true],
    ['a root named with a letter only the disk fold maps opens nothing', `${HOME}/Document\u017f/p/x`,
      [`${HOME}/Document\u017f/p`], true],
    ['Documents itself above a root inside it stays protected', `${HOME}/Documents`, [`${HOME}/Documents/Projects`], true],
    ['same name under another user', '/Users/x/Desktop', ['/Users'], false],
    ['no roots at all', `${HOME}/Downloads/a`, [], true],
    ['relative path is never judged protected', 'Desktop', [HOME], false],
  ] as const)('%s', (_label, candidate, roots, expected) => {
    expect(isProtectedPath(candidate, roots, HOME)).toBe(expected);
  });

  it('a trailing slash on home or path does not change the answer', () => {
    expect(isProtectedPath(`${HOME}/Desktop/`, [HOME], `${HOME}/`)).toBe(true);
    expect(isProtectedPath(`${HOME}/Projects/`, [HOME], `${HOME}/`)).toBe(false);
  });
});
