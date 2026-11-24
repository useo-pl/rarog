/**
 * Which macOS-guarded folder of the home directory a path lies in: `gatedFolderOf`. The folder gate keys its state,
 * its helpers and its refusals by that folder. The module only judges path text; it never touches the disk and never
 * follows a symbolic link (the port walks links before it asks).
 */
import path from 'node:path';
import { PROTECTED_HOME_DIRS, foldCase } from '../config/protected-dirs.ts';

const BY_FOLDED_NAME: ReadonlyMap<string, string> = new Map(PROTECTED_HOME_DIRS.map((name) => [foldCase(name), name]));

/**
 * The absolute path of the folder from `PROTECTED_HOME_DIRS` directly in `home` that `candidate` is or lies in, spelled
 * as the list spells it (`H/DESKTOP/p` gives `H/Desktop`), or `null`. The name compares by `foldCase`, the same rule as
 * `inProtectedFolder`; a relative `candidate` or `home`, home itself and a path outside home give `null`.
 */
export function gatedFolderOf(candidate: string, home: string): string | null {
  if (!path.isAbsolute(candidate) || !path.isAbsolute(home)) return null;
  const resolvedHome = path.resolve(home);
  const relative = path.relative(resolvedHome, path.resolve(candidate));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const name = BY_FOLDED_NAME.get(foldCase(relative.split(path.sep)[0] ?? ''));
  return name === undefined ? null : path.join(resolvedHome, name);
}
