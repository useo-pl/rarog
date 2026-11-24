/**
 * Protocol contract, session files area: the listing of one directory of a session (`GET /api/sessions/:id/files`),
 * the index of its files (`GET /api/sessions/:id/files/index`) and the refusals of the routes over the session's
 * directory, the listing, the index and the raw bytes of one file (`GET /api/sessions/:id/files/raw?path=…`). Paths are relative to the session directory (`cwd`), segments
 * joined with `/`. The zod schemas of the responses stand in `rest.ts`; this file holds the types, the limits and
 * the codes, and the order of a listing, which the app repeats when it adds rows the listing does not have.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import type { SentenceRef } from '../sentences/index.ts';

/** Most entries one listing carries; a directory with more comes cut, with `truncated: true`. */
export const MAX_FILE_ENTRIES = 1000;

/** Kinds of a listing entry. Symlinks and special files (FIFO, socket, device) are never listed. */
export const FILE_ENTRY_KINDS = ['dir', 'file'] as const;
export type FileEntryKind = (typeof FILE_ENTRY_KINDS)[number];

/** One entry of a listing: its name in the listed directory, never a path. */
export interface FileEntry {
  name: string;
  kind: FileEntryKind;
  /** Size in bytes, files only (from `lstat` at the time of the listing). */
  size?: number;
  /** Git ignores this entry. A label only: an ignored file is listed and fetched like any other. */
  ignored?: true;
}

/**
 * 200 of `GET /api/sessions/:id/files?dir=<rel>`. `dir` is the listed directory as requested, `''` for the session
 * directory itself. `entries` are sorted with {@link compareFileEntries} and cut to {@link MAX_FILE_ENTRIES} after
 * the server read the whole directory (`truncated: true`). `maxBytes` is the largest file the server sends
 * (`RAROG_FILES_MAX_MB` in bytes): the app takes the limit from the latest listing of the session and keeps no limit
 * of its own.
 */
export interface FileListing {
  dir: string;
  entries: FileEntry[];
  truncated: boolean;
  maxBytes: number;
}

/**
 * 200 of `GET /api/sessions/:id/files/index`: the regular files under the session directory, relative to it, segments
 * joined with `/`, in the order of a breadth-first walk (each directory's files in the order of its listing). Every
 * directory is walked through the rule of a listing, so the index leaves out what a listing leaves out. In a git
 * repository only the files git does not ignore are walked (`git ls-files --cached --others --exclude-standard`), with
 * a nested repository or a submodule walked whole; outside a repository, or when git fails, every file the rule
 * allows. `truncated: true` when a directory had more than {@link MAX_FILE_ENTRIES} entries or the walk stopped at
 * one of the server's ceilings (files, body bytes, time). `maxBytes` as in {@link FileListing}.
 */
export interface FileIndex {
  paths: string[];
  truncated: boolean;
  maxBytes: number;
}

/**
 * Order of a listing: directories before files, then by name without letter case (`toLowerCase`), then by the name
 * itself, both compared by UTF-16 code units (no locale), so every client sorts the same way.
 */
export function compareFileEntries(a: Pick<FileEntry, 'name' | 'kind'>, b: Pick<FileEntry, 'name' | 'kind'>): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  return byCodeUnits(a.name.toLowerCase(), b.name.toLowerCase()) || byCodeUnits(a.name, b.name);
}

function byCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/* Codes of the refusals of both file routes (field `error` of a 4xx body). */
/** 400: the path failed the shape check (empty segment, `.` or `..`, a leading or trailing `/`, NUL, over 4096 B). */
export const FILES_BAD_PATH_ERROR = 'bad-path';
/** 400: the session's directory is outside the work area, or the session has no pane: its files stay on the server. */
export const FILES_OUT_OF_SCOPE_ERROR = 'out-of-scope';
/** 400: a Codex entry, which Rarog only observes. */
export const FILES_CODEX_ERROR = 'codex';
/**
 * 404: nothing to list or send under this path: it does not exist, or the server never shows it (a segment that
 * starts with a dot, `node_modules`, a symlink, a special file, a file with more than one hard link, a path outside
 * the session directory or the work area). The app reads it as "this directory or file is gone".
 */
export const FILES_NOT_FOUND_ERROR = 'not-found';
/** 413: the file is larger than `maxBytes`; refused before the first byte, the body is {@link FileTooLargeBody}. */
export const FILE_TOO_LARGE_ERROR = 'file-too-large';

/** 413 of `GET /api/sessions/:id/files/raw`: the error body plus the file's size and the limit, both in bytes. */
export interface FileTooLargeBody {
  error: typeof FILE_TOO_LARGE_ERROR;
  message: string;
  messageRef?: SentenceRef;
  size: number;
  maxBytes: number;
}
