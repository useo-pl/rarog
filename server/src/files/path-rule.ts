/**
 * The path rule of the session file routes: one definition for the listing of a directory and for the open of a
 * file, on a path relative to the session directory. It never follows a symlink below that directory, never opens
 * a special file, and refuses what the text alone settles before any disk call for the path. It does not list a
 * directory (`listing.ts`), send bytes, nor check the session (`session-gate.ts` gives the area it works in).
 *
 * The steps, in this order:
 * 1. shape (`validateDiffPath` plus no empty segment) → 400 `bad-path`;
 * 2. text: a segment that starts with a dot, `node_modules` in any letter case, and the work area of
 *    `RAROG_HERDR_ROOTS` on `cwd + path`, as written and on disk (a macOS-protected folder) → 404, no disk call;
 * 3. the walk from `cwd`, one segment at a time: the parent's `readdir` holds the segment byte for byte (letter case
 *    and Unicode form too), and its `lstat` is a directory (the last one a directory or a regular file), never a
 *    symlink; then `resolveInWorkArea`, and `realpath`, which must be exactly the session directory on disk plus the
 *    path, inside the work area;
 * 4. a file opens through `safe-read.ts` with `O_NOFOLLOW` and `fstat` on the descriptor: not a regular file, or more
 *    than one hard link (one to a file outside the session directory passes the walk) → 404;
 * 5. after the open, `realpath` once more and the `stat` of its result must carry the descriptor's `dev` and `ino`;
 *    otherwise 404. This narrows a swap of an intermediate directory for a symlink between steps 3 and 4.
 */
import type { BigIntStats, Dirent } from 'node:fs';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { type AreaDisk, insideWorkArea, resolveInWorkArea } from '../config/work-area.ts';
import { validateDiffPath } from '../git-diff.ts';
import { type OpenedRegularFile, openRegularFile, readDirectoryByIdentity } from '../safe-read.ts';
import { BAD_PATH, type FilesRefusal, NOT_FOUND } from './refusals.ts';

/** Every disk call of the rule and the listing; tests count them and swap a directory between two of them. */
export interface FilesDisk {
  /** Entries of a directory by its path, names as bytes (the walk compares them byte for byte). */
  readonly readdir: (dir: string) => Promise<Dirent<Buffer>[]>;
  /**
   * Entries of a directory that passed the walk, read through its `dev` and `ino` and not through its path
   * (`readDirectoryByIdentity` of `safe-read.ts`); `null` when the read cannot be bound to that directory.
   */
  readonly readdirByIdentity: (dir: Pick<SessionDir, 'real' | 'dev' | 'ino'>) => Promise<Dirent<Buffer>[] | null>;
  readonly lstat: (file: string) => Promise<BigIntStats>;
  readonly stat: (file: string) => Promise<BigIntStats>;
  readonly realpath: (file: string) => Promise<string>;
  /** `openRegularFile` of `safe-read.ts` without following a symlink in the last segment. */
  readonly open: (file: string) => Promise<OpenedRegularFile | null>;
  /** The synchronous calls of the work-area walk (`config/work-area.ts`). */
  readonly area: AreaDisk;
}

export const FILES_DISK: FilesDisk = {
  readdir: (dir) => readdir(dir, { withFileTypes: true, encoding: 'buffer' }),
  readdirByIdentity: (dir) => readDirectoryByIdentity(dir.real, dir),
  lstat: (file) => lstat(file, { bigint: true }),
  stat: (file) => stat(file, { bigint: true }),
  realpath: (file) => realpath(file),
  open: (file) => openRegularFile(file, { followSymlink: false }),
  area: {
    lstat: (file) => lstatSync(file), readlink: (file) => readlinkSync(file), realpath: (file) => realpathSync(file),
  },
};

/**
 * Where a session's files are read: its directory as the pane reports it and on disk (`realpath`), and the roots and
 * home as configured and on disk. `session-gate.ts` builds it after the session's own checks.
 */
export interface FilesArea {
  readonly cwd: string;
  readonly realCwd: string;
  readonly roots: readonly string[];
  readonly realRoots: readonly string[];
  readonly home: string;
  readonly realHome: string;
}

/** A value or the refusal to send. */
export type Ruled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: FilesRefusal };

/** A directory of the session that passed the walk: the request's path, its segments and the directory on disk. */
export interface SessionDir {
  readonly rel: string;
  readonly segments: readonly string[];
  /** `cwd` plus the path, as the walk went. */
  readonly path: string;
  /** The directory on disk, exactly `realCwd` plus the path. */
  readonly real: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

/** A file of the session, open: the caller sends it and closes the handle. `size` is the `fstat` of the descriptor. */
export interface SessionFile {
  readonly handle: FileHandle;
  readonly size: number;
  readonly stats: BigIntStats;
}

const refused = (refusal: FilesRefusal): Ruled<never> => ({ ok: false, refusal });

/** Step 1: the segments of the path, or `null` for 400. `''` is the session directory where `allowEmpty`. */
function segmentsOf(rel: string, allowEmpty: boolean): string[] | null {
  if (rel === '') return allowEmpty ? [] : null;
  if (validateDiffPath(rel) === null) return null;
  const segments = rel.split('/');
  return segments.includes('') ? null : segments;
}

/**
 * Step 1 alone, for the demo, which has no disk: the refusal of a path that fails the shape check, or `null`. `''`
 * is the session directory where `allowEmpty`.
 */
export function shapeRefusal(rel: string, allowEmpty: boolean): FilesRefusal | null {
  return segmentsOf(rel, allowEmpty) === null ? BAD_PATH : null;
}

/** The text of a name the server never shows: it starts with a dot, or it is `node_modules` in any letter case. */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || name.toLowerCase() === 'node_modules';
}

/**
 * Whether `file` lies in the work area, as text, against the roots in both forms and the configured home, as the
 * session gate asks about the session directory (`inWorkAreaOnDisk`). No disk call.
 */
export function inAreaText(area: FilesArea, file: string): boolean {
  return insideWorkArea(file, [...area.roots, ...area.realRoots], area.home);
}

/** Steps 1 and 2: the segments of a path that may go to the disk, or the refusal. */
function checkText(area: FilesArea, rel: string, allowEmpty: boolean): Ruled<string[]> {
  const segments = segmentsOf(rel, allowEmpty);
  if (segments === null) return refused(BAD_PATH);
  if (segments.some(isHiddenName)) return refused(NOT_FOUND);
  if (!inAreaText(area, path.join(area.cwd, ...segments))) return refused(NOT_FOUND);
  // The on-disk form against the on-disk home, so a home reached through a symlink keeps its protected folders.
  if (!insideWorkArea(path.join(area.realCwd, ...segments), area.realRoots, area.realHome)) return refused(NOT_FOUND);
  return { ok: true, value: segments };
}

async function attempt<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}

/** Step 3: the walk down from `cwd` and the path on disk, or `null` for 404. */
async function walk(
  area: FilesArea, segments: readonly string[], last: 'dir' | 'file', disk: FilesDisk,
): Promise<{ readonly path: string; readonly real: string } | null> {
  let current = area.cwd;
  for (const [index, segment] of segments.entries()) {
    const entries = await attempt(() => disk.readdir(current));
    const wanted = Buffer.from(segment, 'utf8');
    if (entries?.some((entry) => entry.name.equals(wanted)) !== true) return null;
    const next = path.join(current, segment);
    const info = await attempt(() => disk.lstat(next));
    if (info === null || info.isSymbolicLink()) return null;
    const isLast = index === segments.length - 1;
    if (isLast && last === 'file' ? !info.isFile() : !info.isDirectory()) return null;
    current = next;
  }
  if (resolveInWorkArea(current, area.realRoots, area.realHome, disk.area).kind !== 'resolved') return null;
  const real = await attempt(() => disk.realpath(current));
  if (real !== path.join(area.realCwd, ...segments)) return null;
  if (!insideWorkArea(real, area.realRoots, area.realHome)) return null;
  return { path: current, real };
}

/** Steps 1 to 3 for a directory: the listing's directory (`''` = the session directory) or the refusal. */
export async function resolveSessionDir(
  area: FilesArea, rel: string, disk: FilesDisk = FILES_DISK,
): Promise<Ruled<SessionDir>> {
  const text = checkText(area, rel, true);
  if (!text.ok) return text;
  const segments = text.value;
  const walked = await walk(area, segments, 'dir', disk);
  if (walked === null) return refused(NOT_FOUND);
  const info = await attempt(() => disk.stat(walked.real));
  if (info === null || !info.isDirectory()) return refused(NOT_FOUND);
  return { ok: true, value: { rel, segments, path: walked.path, real: walked.real, dev: info.dev, ino: info.ino } };
}

/**
 * Whether `dir` is still the directory the walk found: `realpath` of its path gives the same directory on disk with
 * the same `dev` and `ino`. The listing asks after its read of the entries, as the open does after the open.
 */
export async function stillSessionDir(dir: SessionDir, disk: FilesDisk = FILES_DISK): Promise<boolean> {
  const real = await attempt(() => disk.realpath(dir.path));
  if (real !== dir.real) return false;
  const info = await attempt(() => disk.stat(real));
  return info !== null && info.isDirectory() && info.dev === dir.dev && info.ino === dir.ino;
}

/** Steps 1 to 5 for a file: the open file, or the refusal with no descriptor left open. */
export async function openSessionFile(
  area: FilesArea, rel: string, disk: FilesDisk = FILES_DISK,
): Promise<Ruled<SessionFile>> {
  const text = checkText(area, rel, false);
  if (!text.ok) return text;
  const walked = await walk(area, text.value, 'file', disk);
  if (walked === null) return refused(NOT_FOUND);
  const opened = await attempt(() => disk.open(walked.real));
  if (opened === null) return refused(NOT_FOUND);
  const { handle, stats } = opened;
  if (stats.nlink > 1n || !(await sameFileAgain(walked, stats, disk))) {
    await handle.close();
    return refused(NOT_FOUND);
  }
  return { ok: true, value: { handle, size: Number(stats.size), stats } };
}

/** Step 5: the path resolves to the same place, and that place is the file the descriptor holds. */
async function sameFileAgain(
  walked: { readonly path: string; readonly real: string }, opened: BigIntStats, disk: FilesDisk,
): Promise<boolean> {
  const real = await attempt(() => disk.realpath(walked.path));
  if (real !== walked.real) return false;
  const info = await attempt(() => disk.stat(real));
  return info !== null && info.dev === opened.dev && info.ino === opened.ino;
}
