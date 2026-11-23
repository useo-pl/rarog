/**
 * The `cwd` filter of both Rarog hooks with the work area rule: a session directory counts when it lies
 * in a root of `roots.json` by its path on disk, not in a hidden entry of that root, and not in an excluded folder of
 * `exclude` (the macOS-protected folders of home) unless a root lies in that folder. The path is resolved one segment
 * at a time and the walk stops before a segment in an excluded folder, so a link into `~/Desktop` or a root that is a
 * symlink to home never makes the hook read there (macOS would wait on a privacy prompt nobody sees).
 *
 * A copy of the server's walk (`resolveInWorkArea` in `server/src/config/work-area.ts`): the hooks run from their copy
 * in `~/.claude/hooks/rarog/` and import nothing but `node:` and the files of that copy. One table of cases keeps both
 * walks equal (`server/test/hook-work-area.test.ts`). Both hooks load this module dynamically in `try`; a missing or
 * broken module means the `cwd` is outside, so the hook does nothing.
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Symlinks followed in one walk before it gives up, as `ELOOP` of the system. */
const MAX_LINKS = 40;

/** The disk calls of the filter; tests record them. */
const DISK = {
  lstat: (file) => lstatSync(file),
  readlink: (file) => readlinkSync(file),
  realpath: (file) => realpathSync(file),
};

/**
 * A name or path folded the way the default macOS disk compares names: a copy of `foldCase` in
 * `server/src/config/protected-dirs.ts`, which says why each step is there; the same table pins both.
 */
export function foldCase(value) {
  return value.normalize('NFD').replace(/[^\u0131]+/gu, (run) => run.toLowerCase().toUpperCase().toLowerCase())
    .normalize('NFC');
}

const low = (value) => value.toLowerCase();

/** Whether `candidate` is `root` or lies inside it, by path segments. */
function isInside(candidate, root) {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

/**
 * `path` in an excluded folder that no root lies in (a root `~/Documents/Projects` opens its own subtree). Finding the
 * folder compares names the way the default macOS disk folds them ({@link foldCase}), where folding too much only
 * refuses more; a root lying in the folder and opening `path` compares in lower case only, as on the server.
 */
export function inExcluded(path, roots, exclude) {
  const folded = foldCase(path);
  return exclude.some((folder) => isInside(folded, foldCase(folder))
    && !roots.some((root) => isInside(low(root), low(folder)) && isInside(low(path), low(root))));
}

/** Whether `path` (inside `root`) enters a hidden entry of the root itself (`<root>/.cache/…`). */
function inHiddenEntry(path, root) {
  if (path === root) return false;
  const rest = path.slice(root.endsWith(sep) ? root.length : root.length + 1);
  return rest.startsWith('.');
}

/**
 * The on-disk path of `candidate`, resolved like `realpath`, but one segment at a time: before each `lstat` the path
 * built so far is checked, and one in an excluded folder ends the walk (`excluded`) without a read there. A
 * symlink's target is walked the same way. An excluded folder that holds a root may be passed on the way to it.
 * `missing`: a segment does not exist, cannot be checked, or the links loop. `roots` in on-disk form.
 */
export function resolveInWorkArea(candidate, roots, exclude, disk = DISK) {
  if (!isAbsolute(candidate)) return { kind: 'missing' };
  // The way to a root compares in lower case, like a root opening a path (`inExcluded`).
  const lowRoots = roots.map(low);
  const blocked = (dir) => inExcluded(dir, roots, exclude) && !lowRoots.some((root) => isInside(root, low(dir)));
  let pending = resolve(candidate).split(sep).filter((part) => part !== '');
  let current = sep;
  let links = 0;
  while (pending.length > 0) {
    const [part, ...rest] = pending;
    pending = rest;
    if (part === undefined || part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    if (blocked(next)) return { kind: 'excluded' };
    let link = null;
    try {
      if (disk.lstat(next).isSymbolicLink()) link = disk.readlink(next);
    } catch {
      return { kind: 'missing' };
    }
    if (link === null) {
      current = next;
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) return { kind: 'missing' };
    if (isAbsolute(link)) current = sep;
    pending = [...link.split(sep).filter((piece) => piece !== ''), ...pending];
  }
  return { kind: 'resolved', path: current };
}

/**
 * Whether the session's `cwd` lies in Rarog's roots, compared on disk on both sides: on macOS `/tmp` is a link to
 * `/private/tmp`, and a link in a root can lead out of it. A `cwd` outside the roots as written that resolves into
 * them is the same directory and counts. Fail-closed: a `cwd` that does not resolve is outside; a root that does not
 * resolve stays as written, so a missing root cannot widen the boundary. Only the roots go through `realpath`.
 *
 * `exclude` `null` (a `roots.json` without an exclusion list): the roots only, the `cwd` through `realpath`. A list:
 * the work area rule, first on `cwd` as given against the roots as written and resolved (a root that is a symlink into
 * a protected folder opens the physical path a session reports; no disk access for `cwd` in an excluded folder), then
 * the walk, then the rule once more on the resolved path against the resolved roots.
 */
export function insideRoots(cwd, roots, exclude, disk = DISK) {
  const realRoots = roots.map((root) => {
    try {
      return disk.realpath(root);
    } catch {
      return root;
    }
  });
  if (exclude !== null && inExcluded(cwd, [...roots, ...realRoots], exclude)) return false;
  if (exclude === null) {
    let real;
    try {
      real = disk.realpath(cwd);
    } catch {
      return false;
    }
    return realRoots.some((root) => isInside(real, root));
  }
  const walked = resolveInWorkArea(cwd, realRoots, exclude, disk);
  if (walked.kind !== 'resolved') return false;
  const real = walked.path;
  return realRoots.some((root) => isInside(real, root) && !inHiddenEntry(real, root))
    && !inExcluded(real, realRoots, exclude);
}
