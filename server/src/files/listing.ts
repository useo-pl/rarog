/**
 * The listing of one directory of a session (`GET /api/sessions/:id/files?dir=`): the directory goes through the path
 * rule, the whole directory is read through its `dev` and `ino` (never through its path, which a symlink could take
 * over after the rule), entries the server never shows are left out, the rest is sorted by the contract's order and
 * cut to the ceiling. It does not label ignored entries and does not touch git.
 *
 * Left out: a name that starts with a dot, `node_modules` in any letter case, a symlink, a special file (FIFO,
 * socket, device), a file with more than one hard link, an entry whose `lstat` under the directory's path is not of
 * the kind read, a name outside the work area (a protected folder of home under the root `~`) and a name that is not
 * valid UTF-8, which no request could name back byte for byte. A mount point stays: its device is not compared.
 */
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { MAX_FILE_ENTRIES, compareFileEntries } from '@rarog/shared';
import type { FileEntry, FileListing } from '@rarog/shared';
import { insideWorkArea } from '../config/work-area.ts';
import { FolderGateError } from '../folder-gate/types.ts';
import {
  FILES_DISK, type FilesArea, type FilesDisk, type Ruled, type SessionDir, inAreaText, isHiddenName,
  resolveSessionDir, stillSessionDir,
} from './path-rule.ts';
import { NOT_FOUND, closedFolder } from './refusals.ts';

export interface ListingOptions {
  /** The largest file the server sends, announced in the listing (`RAROG_FILES_MAX_MB` in bytes). */
  readonly maxBytes: number;
  /** Ceiling of the entries; default {@link MAX_FILE_ENTRIES}. */
  readonly maxEntries?: number;
}

/** The name as a string when its bytes are valid UTF-8, otherwise `null`. */
function utf8Name(bytes: Buffer): string | null {
  const name = bytes.toString('utf8');
  return Buffer.from(name, 'utf8').equals(bytes) ? name : null;
}

/**
 * The entries of the directory, read through its identity: `[]` for a directory the server may not read (`EACCES`,
 * `EPERM`), as in the directory browser; `null` (404) when the read cannot be bound to the directory the walk found
 * (another platform, another directory under the path now) or fails otherwise; the refusal of a guarded folder the
 * folder gate holds closed, never an empty listing. Never a read by path.
 */
async function entriesOf(
  dir: SessionDir, disk: FilesDisk,
): Promise<readonly Dirent<Buffer>[] | null | FolderGateError> {
  try {
    return await disk.readdirByIdentity(dir);
  } catch (error) {
    if (error instanceof FolderGateError) return error;
    const code = (error as { code?: unknown } | null)?.code;
    return code === 'EACCES' || code === 'EPERM' ? [] : null;
  }
}

/**
 * An entry of the listing, or `null` for one the server leaves out. Its `lstat` under the directory's path must show
 * the kind the read gave: an entry swapped for a symlink since the read drops. The device is not compared, because a
 * mount point under the session directory is a directory the path rule allows, on a device of its own.
 */
async function entryOf(
  area: FilesArea, dir: SessionDir, name: string, kind: 'dir' | 'file', disk: FilesDisk,
): Promise<FileEntry | null> {
  if (isHiddenName(name)) return null;
  if (!inAreaText(area, path.join(dir.path, name))) return null;
  if (!insideWorkArea(path.join(dir.real, name), area.realRoots, area.realHome)) return null;
  try {
    const info = await disk.lstat(path.join(dir.real, name));
    if (kind === 'dir') return info.isDirectory() ? { name, kind } : null;
    return info.isFile() && info.nlink === 1n ? { name, kind, size: Number(info.size) } : null;
  } catch {
    return null;
  }
}

/**
 * Lists the directory `rel` of the session (`''` = the session directory). A directory the server may not read gives
 * an empty listing, as in the directory browser; a directory swapped while it was read gives 404.
 */
export async function listSessionDir(
  area: FilesArea, rel: string, opts: ListingOptions, disk: FilesDisk = FILES_DISK,
): Promise<Ruled<FileListing>> {
  const dir = await resolveSessionDir(area, rel, disk);
  if (!dir.ok) return dir;
  const read = await entriesOf(dir.value, disk);
  if (read === null) return { ok: false, refusal: NOT_FOUND };
  if (read instanceof FolderGateError) return { ok: false, refusal: closedFolder(read) };
  const pending: Promise<FileEntry | null>[] = [];
  for (const entry of read) {
    const name = utf8Name(entry.name);
    if (name === null) continue;
    if (entry.isDirectory()) pending.push(entryOf(area, dir.value, name, 'dir', disk));
    else if (entry.isFile()) pending.push(entryOf(area, dir.value, name, 'file', disk));
  }
  const entries = (await Promise.all(pending)).filter((entry) => entry !== null).sort(compareFileEntries);
  if (!(await stillSessionDir(dir.value, disk))) return { ok: false, refusal: NOT_FOUND };
  const max = opts.maxEntries ?? MAX_FILE_ENTRIES;
  return {
    ok: true,
    value: { dir: rel, entries: entries.slice(0, max), truncated: entries.length > max, maxBytes: opts.maxBytes },
  };
}
