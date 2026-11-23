/**
 * Scan of the project roots: the project list behind `GET /api/projects` outside demo mode and without
 * a configured `projects` list. Reads one directory level per root and nothing else; the allow-list check
 * of a launch directory lives in `validateProjectCwd`, not here. This module does not import `manager.ts`.
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { insideWorkArea, onDiskForms } from '../config/work-area.ts';

/**
 * Skan korzeni projektów — lista w pickerze „Nowa sesja" poza trybem demo.
 *
 * Brak katalogu = pusta lista (fail-closed). Przy wielu korzeniach nazwy mogą się powtórzyć,
 * więc deduplikujemy po ŚCIEŻCE, a nie po nazwie.
 *
 * An entry of this list passes the directory gate without `validateProjectCwd`, so only folders in the work area
 * get on it: with the root `~` the macOS-protected folders of home stay off. Each folder is judged as written
 * and by its path on disk, from the roots and home in on-disk form: a root that is a symlink to home
 * (`/srv/home -> ~`) lists the folders of home under its own prefix, and the text alone would let `Desktop` through.
 * A folder is a real directory, never a symlink, so its path on disk is its name under the resolved root; the entry
 * keeps the path as written.
 */
export function scanProjectRoots(roots: readonly string[], home: string = homedir()): { path: string; name: string }[] {
  const real = onDiskForms(roots, home);
  const found = new Map<string, { path: string; name: string }>();
  for (const [index, root] of roots.entries()) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const realRoot = real.roots[index] ?? root;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const path = join(root, entry.name);
      if (!insideWorkArea(path, roots, home)) continue;
      if (!insideWorkArea(join(realRoot, entry.name), real.roots, real.home)) continue;
      if (!found.has(path)) found.set(path, { path, name: entry.name });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
