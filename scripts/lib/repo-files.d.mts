/**
 * Typy `repo-files.mjs` (lista plików repo z gitem albo spacerem z regułami `.gitignore`). Osobny plik, bo
 * `tsconfig.base.json` nie ma `allowJs`, a moduł musi zostać czystym ESM dla gołego `node`.
 */

export type RepoFilesMode = 'git' | 'walk';

export interface GitignoreRule {
  /** Katalog pliku `.gitignore` względem korzenia (`''` dla korzenia). */
  readonly base: string;
  readonly negate: boolean;
  readonly dirOnly: boolean;
  readonly regex: RegExp;
}

/** `git`, gdy w korzeniu jest `.git` (katalog albo plik worktree), inaczej `walk`. */
export declare function repoFilesMode(root: string): RepoFilesMode;

export declare function parseGitignore(text: string, base?: string): GitignoreRule[];

export declare function isIgnored(relPath: string, isDir: boolean, stack: readonly GitignoreRule[]): boolean;

/** Spacer po drzewie z regułami `.gitignore` (bez gita); kolejność wpisów katalogu. */
export declare function walkRepoFiles(root: string): string[];

/**
 * Pliki repo względem `root` (`/`, posortowane, bez powtórzeń, tylko istniejące na dysku), opcjonalnie pod `sub`.
 * Nazwa spoza UTF-8 (z gita albo ze spaceru) to wyjątek, nie pominięcie.
 */
export declare function repoFiles(root: string, sub?: string): string[];
