/**
 * The work area: where Rarog starts a session, lists directories, reads a pane in full, runs a diff or a
 * command list, and where the hook writes. One rule for every consumer: inside a root, not in a hidden entry of the
 * root itself (`~/.cache`, `~/.config` under the root `~`), and not in a macOS-protected folder of the home directory
 * unless a root lies in that folder (`protected-dirs.ts`). `insideWorkArea` judges text only; `resolveInWorkArea`
 * resolves symlinks one segment at a time and stops before it would touch an excluded folder; `inWorkAreaOnDisk`
 * puts the two together for a directory that already exists, and `inExcludedOnDisk` asks only about the excluded
 * folders, for a directory that may lie outside the roots. A guarded folder the folder gate holds closed is out of the
 * work area too, unless the caller asks to ignore the gate (`WalkOptions`). The module never lists a directory and
 * never reads a file.
 */
import path from 'node:path';
import { DIRECT_DISK, type WorkAreaDisk, closedFolderOf } from '../folder-gate/disk.ts';
import { FolderGateError } from '../folder-gate/types.ts';
import { PROTECTED_HOME_DIRS, foldCase, inProtectedFolder, openedByRoot } from './protected-dirs.ts';

const lower = (value: string): string => value.toLowerCase();

/** Whether `candidate` is `root` or lies inside it, by path segments. */
function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Whether the first segment of `candidate` below `root` starts with a dot (`<root>/.cache/x`). */
function inHiddenEntryOf(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && (relative.split(path.sep)[0] ?? '').startsWith('.');
}

/**
 * `true` when `candidate` lies in a macOS-protected folder of `home` that no root in `roots` opens. Finding the folder
 * compares names the way the default macOS disk folds them ({@link foldCase}), so `/users/<name>/desktop` and
 * `<home>/De\u017fktop` (long s) reach the same folder as the stored form; folding too much there only refuses more.
 * Whether a root opens `candidate` compares in lower case only, so on a case-sensitive disk the root
 * `~/Documents/strasse` does not open its sibling `~/Documents/stra\u00dfe`.
 */
export function isExcludedPath(candidate: string, roots: readonly string[], home: string): boolean {
  return inProtectedFolder(foldCase(candidate), foldCase(home))
    && !openedByRoot(lower(candidate), roots.map(lower), lower(home));
}

/**
 * The folders the work area leaves out, as absolute paths under `home` (`<home>/Desktop`…). The hook gets them in
 * `roots.json`; a root inside one of them still opens its own subtree there.
 */
export function excludedFolders(home: string): string[] {
  return PROTECTED_HOME_DIRS.map((name) => path.join(home, name));
}

/**
 * Whether `cwd` lies in the work area of `roots`. Text only, no disk: the path must be absolute and inside a root,
 * must not enter a hidden entry of that root, and must not lie in an excluded folder ({@link isExcludedPath}).
 * Callers pass home and roots in the same form as `cwd` (configured paths for a typed path, on-disk forms for a
 * resolved one). A consumer with a stricter rule of its own (hidden segments at any depth for a start) applies it
 * on top.
 */
export function insideWorkArea(cwd: string, roots: readonly string[], home: string): boolean {
  if (!path.isAbsolute(cwd)) return false;
  const resolved = path.resolve(cwd);
  const inRoot = roots.some((raw) => {
    if (!path.isAbsolute(raw)) return false;
    const root = path.resolve(raw);
    return isWithin(resolved, root) && !inHiddenEntryOf(resolved, root);
  });
  return inRoot && !isExcludedPath(resolved, roots, home);
}

/** The two disk calls the walk makes; tests record them. */
export interface WalkDisk {
  readonly lstat: (file: string) => { isSymbolicLink(): boolean };
  readonly readlink: (file: string) => string;
}

/** The walk's view of the work-area disk port. */
export function walkDiskOf(disk: WorkAreaDisk): WalkDisk {
  return {
    lstat: (file) => disk.sync('lstat', { path: file }),
    readlink: (file) => disk.sync('readlink', { path: file }),
  };
}

const DISK: WalkDisk = walkDiskOf(DIRECT_DISK);

/** Symlinks followed in one walk before it gives up, as `ELOOP` of the system. */
const MAX_LINKS = 40;

/**
 * `gate: 'ignore'`: the walk does not ask the folder gate, so a closed guarded folder counts like an open one. Only for
 * a verdict that must not change with the folder's state (the scope of a pane); the walk still reads metadata only.
 */
export interface WalkOptions {
  readonly gate?: 'ignore';
}

export type WalkResult =
  | { readonly kind: 'resolved'; readonly path: string }
  /** `closed`: the walk met a guarded folder the folder gate holds closed; it is never `missing`. */
  | { readonly kind: 'excluded'; readonly closed?: FolderGateError }
  | { readonly kind: 'missing' };

/**
 * The on-disk path of `candidate`, resolved like `realpath`, but one segment at a time: before each `lstat` the path
 * built so far is checked, and one in an excluded folder ends the walk (`excluded`) without a read there. A
 * symlink's target is walked the same way, so `<root>/link -> ~/Desktop/x` never reaches `Desktop`. An excluded
 * folder that holds a root (`~/Documents` on the way to the root `~/Documents/Projects`) may be passed.
 * `missing`: a segment does not exist, cannot be checked, or the links loop. A segment in a guarded folder the folder
 * gate holds closed ends the walk as `excluded` with the refusal in `closed`, before its `lstat`: the folder cannot be
 * entered now, and a missing segment would keep the verdict of the text. The walk asks the port for it
 * (`closedFolderOf`), because metadata passes a closed folder; a disk that refuses a segment with `FolderGateError`
 * ends the walk the same way. With `gate: 'ignore'` the walk does not ask the gate. `roots` and `home` in on-disk form.
 */
export function resolveInWorkArea(
  candidate: string, roots: readonly string[], home: string, disk: WalkDisk = DISK, options: WalkOptions = {},
): WalkResult {
  if (!path.isAbsolute(candidate)) return { kind: 'missing' };
  // The way to a root compares in lower case, like a root opening a path (`isExcludedPath`).
  const lowerRoots = roots.map(lower);
  const blocked = (dir: string): boolean => isExcludedPath(dir, roots, home)
    && !lowerRoots.some((root) => isWithin(root, lower(dir)));
  let pending = path.resolve(candidate).split(path.sep).filter((part) => part !== '');
  let current: string = path.sep;
  let links = 0;
  while (pending.length > 0) {
    const [part, ...rest] = pending;
    pending = rest;
    if (part === undefined || part === '.') continue;
    if (part === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    if (blocked(next)) return { kind: 'excluded' };
    const closed = options.gate === 'ignore' ? null : closedFolderOf(next);
    if (closed !== null) return { kind: 'excluded', closed };
    let link: string | null = null;
    try {
      if (disk.lstat(next).isSymbolicLink()) link = disk.readlink(next);
    } catch (error) {
      return error instanceof FolderGateError ? { kind: 'excluded', closed: error } : { kind: 'missing' };
    }
    if (link === null) {
      current = next;
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) return { kind: 'missing' };
    if (path.isAbsolute(link)) current = path.sep;
    pending = [...link.split(path.sep).filter((piece) => piece !== ''), ...pending];
  }
  return { kind: 'resolved', path: current };
}

/** The walk's disk calls plus `realpath` for the roots and home; tests record them. */
export interface AreaDisk extends WalkDisk {
  readonly realpath: (file: string) => string;
}

/** The area's view of the work-area disk port: `realpath` is the JavaScript walk of `realpathSync`. */
export function areaDiskOf(disk: WorkAreaDisk): AreaDisk {
  return { ...walkDiskOf(disk), realpath: (file) => disk.sync('realpath', { path: file }) };
}

const AREA_DISK: AreaDisk = areaDiskOf(DIRECT_DISK);

/**
 * Roots and home in on-disk form, the reference points of a walk: a root that is a symlink (`/srv/home -> ~`) counts
 * where it leads. Only they go through `realpath`, never a folder inside them; one that does not resolve stays as given.
 */
export function onDiskForms(
  roots: readonly string[], home: string, realpath: (file: string) => string = AREA_DISK.realpath,
): { readonly roots: string[]; readonly home: string } {
  const onDisk = (entry: string): string => {
    try {
      return realpath(entry);
    } catch {
      return entry;
    }
  };
  return { roots: roots.map(onDisk), home: onDisk(home) };
}

/**
 * Whether the directory `cwd` of a pane or a session lies in the work area of `roots` as written and on disk. Only the
 * roots and home resolve first, never `cwd`. The text comes next ({@link insideWorkArea}) against the roots in both
 * forms, so a root that is a symlink into a protected folder (`/srv/code -> ~/Desktop/project`) opens the physical
 * path a pane reports, and the rest of that folder is refused before any disk call for `cwd`, as in the hook. Then
 * the walk ({@link resolveInWorkArea}) from the roots and home in on-disk form. A path that resolves into the roots
 * meets the whole rule once more there, so `<root>/link -> ~/Desktop/x`, `<root ~>/visible -> ~/.cache/x` and a root
 * that is a symlink to home (`/srv/home/Desktop`) stay out without a read in the excluded folder. A path the walk
 * cannot resolve (deleted, unreadable, a loop of links) keeps the verdict of its text, because nothing can be read
 * through it; a link that leads out of every root keeps it too, unless it ends in an excluded folder. A guarded folder
 * the folder gate holds closed on the way puts the path out of the work area until the folder opens, unless `options`
 * ignore the gate ({@link WalkOptions}).
 */
export function inWorkAreaOnDisk(
  cwd: string, roots: readonly string[], home: string, disk: AreaDisk = AREA_DISK, options: WalkOptions = {},
): boolean {
  const real = onDiskForms(roots, home, disk.realpath);
  if (!insideWorkArea(cwd, [...roots, ...real.roots], home)) return false;
  const walked = resolveInWorkArea(cwd, real.roots, real.home, disk, options);
  if (walked.kind !== 'resolved') return walked.kind === 'missing';
  const inRoots = real.roots.some((root) => path.isAbsolute(root) && isWithin(walked.path, path.resolve(root)));
  return inRoots
    ? insideWorkArea(walked.path, real.roots, real.home)
    : !isExcludedPath(walked.path, real.roots, real.home);
}

/**
 * Whether the directory `cwd`, inside the roots or not, lies in an excluded folder, as written or on disk: the git
 * row of a pane outside the roots stays, but git never runs in a protected folder. Only the roots and home
 * resolve before the text check, never `cwd`, and a root counts in both forms: one that is a symlink into a protected
 * folder (`/srv/code -> ~/Desktop/project`) opens the physical path a pane reports. Then the walk
 * ({@link resolveInWorkArea}), which stops before an excluded folder, and the excluded folders once more on the path
 * it resolves to. A path the walk cannot resolve is not excluded: nothing can be read through it. A guarded folder
 * the folder gate holds closed on the way counts as excluded, so git does not run there.
 */
export function inExcludedOnDisk(
  cwd: string, roots: readonly string[], home: string, disk: AreaDisk = AREA_DISK,
): boolean {
  const real = onDiskForms(roots, home, disk.realpath);
  if (isExcludedPath(cwd, [...roots, ...real.roots], home)) return true;
  const walked = resolveInWorkArea(cwd, real.roots, real.home, disk);
  return walked.kind === 'excluded'
    || (walked.kind === 'resolved' && isExcludedPath(walked.path, real.roots, real.home));
}
