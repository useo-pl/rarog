/**
 * macOS-protected folders under the home directory: the one definition of where a walk over the project roots must
 * not go on its own. Reading `~/Desktop`, `~/Documents` and the rest makes macOS ask for access (TCC); on a Mac used
 * remotely nobody sees the prompt and the read waits for an answer. API: `isProtectedPath(path, explicitRoots, home)`,
 * its two halves `inProtectedFolder` and `openedByRoot`, the list `PROTECTED_HOME_DIRS` and `foldCase`, the name
 * comparison of the disk. The module only judges paths; it never touches the disk.
 */
import path from 'node:path';

/** Folders directly in the home directory that macOS guards with a privacy prompt. */
export const PROTECTED_HOME_DIRS: readonly string[] = [
  'Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures',
];

/**
 * A name or path folded the way the default macOS disk (APFS, case-insensitive) compares names, so spellings that disk
 * reads as one name fold alike: decomposed form (NFD), then lower, upper and lower case, then composed form (NFC).
 * Upper case carries the long s (U+017F), the Kelvin sign, `ß` and the ligatures `ﬀ`–`ﬆ` to the ASCII letters that disk
 * reads them as, and the first lower case carries `ẞ` to `ß` on the way. The case mapping can leave a string out of
 * normal form (`ẖ` upper-cases to `H` and a combining macron below), so it runs on the decomposed form and the result
 * is composed again; two canonically equal spellings then fold alike. The dotless i (U+0131) stays out of the case
 * mapping, because upper case would make it `I` while that disk keeps it apart from `i`. The fold only finds a
 * protected folder, where folding too much refuses more; whether a root opens a path compares in plain lower case
 * ({@link openedByRoot}). The hook copy (`scripts/hooks/work-area.mjs`) folds alike;
 * `server/test/hook-work-area.test.ts` pins both on one table.
 */
export function foldCase(value: string): string {
  return value.normalize('NFD').replace(/[^\u0131]+/gu, (run) => run.toLowerCase().toUpperCase().toLowerCase())
    .normalize('NFC');
}

const PROTECTED_FOLDED = new Set(PROTECTED_HOME_DIRS.map(foldCase));

const PROTECTED_LOWER = new Set(PROTECTED_HOME_DIRS.map((name) => name.toLowerCase()));

/** The first segment of `candidate` below `home`, or `null` for home itself and for a path outside it. */
function firstSegmentBelow(candidate: string, home: string): string | null {
  const relative = path.relative(home, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep)[0] ?? '';
}

/** Whether `candidate` is `root` or lies inside it, by path segments. */
function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Whether `candidate` is one of {@link PROTECTED_HOME_DIRS} directly in `home` or lies inside one, the folder name
 * compared by {@link foldCase}. A relative `candidate` or `home` is never in one.
 */
export function inProtectedFolder(candidate: string, home: string): boolean {
  if (!path.isAbsolute(candidate) || !path.isAbsolute(home)) return false;
  const first = firstSegmentBelow(path.resolve(candidate), path.resolve(home));
  return first !== null && PROTECTED_FOLDED.has(foldCase(first));
}

/**
 * Whether a root in `explicitRoots` that itself lies in a protected folder of `home` (or is one) contains `candidate`.
 * The folder name of the root compares in lower case and the paths as given, never by {@link foldCase}: a root opens
 * no path the disk could keep apart from its own spelling.
 */
export function openedByRoot(candidate: string, explicitRoots: readonly string[], home: string): boolean {
  if (!path.isAbsolute(candidate) || !path.isAbsolute(home)) return false;
  const resolved = path.resolve(candidate);
  const resolvedHome = path.resolve(home);
  return explicitRoots.some((raw) => {
    if (!path.isAbsolute(raw)) return false;
    const root = path.resolve(raw);
    const first = firstSegmentBelow(root, resolvedHome);
    return first !== null && PROTECTED_LOWER.has(first.toLowerCase()) && isWithin(resolved, root);
  });
}

/**
 * `true` when `candidate` lies in a protected folder ({@link inProtectedFolder}) and no root opens it
 * ({@link openedByRoot}). A root such as `~/Documents/Projects` is the owner's deliberate choice, so its subtree stays
 * open; a root above the folder (`~`, `/`) does not open it. A relative `candidate` or `home` is never judged
 * protected.
 */
export function isProtectedPath(candidate: string, explicitRoots: readonly string[], home: string): boolean {
  return inProtectedFolder(candidate, home) && !openedByRoot(candidate, explicitRoots, home);
}
