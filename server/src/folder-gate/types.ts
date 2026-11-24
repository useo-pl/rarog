/**
 * Shared shapes of the folder gate: the states of a macOS-guarded folder in the home directory, the error a call in a
 * closed folder fails with, the disk operations of the work-area port with their arguments and values, and the client
 * and gate interfaces. Values are plain data (`DiskStats` and `DiskDirent` are snapshots, not `node:fs` objects), so
 * the same value can cross the line codec of a helper process (`wire.ts`). The module never touches the disk.
 */
import { type OwnText, say } from '@rarog/shared/sentences';

export const FOLDER_STATES = ['unknown', 'open', 'waiting', 'denied', 'absent', 'unchecked'] as const;
export type FolderState = (typeof FOLDER_STATES)[number];

/** The states in which a call in the folder is refused without a disk call. */
export const CLOSED_STATES = ['waiting', 'denied', 'absent', 'unchecked'] as const;
export type ClosedState = Exclude<FolderState, 'unknown' | 'open'>;

/** The sentence of a refusal for each closed state; a missing folder reads like any missing directory. */
const CLOSED_SENTENCE: Readonly<Record<ClosedState, () => OwnText>> = {
  waiting: () => say('rest.cwd-folder-waiting'),
  denied: () => say('rest.cwd-folder-denied'),
  absent: () => say('rest.cwd-not-found'),
  unchecked: () => say('rest.cwd-folder-unchecked'),
};

/**
 * A disk call refused because its folder is closed. A consumer that treats a file system error as an unreadable path
 * treats this one the same way; `sentence` is what the user reads.
 */
export class FolderGateError extends Error {
  readonly code = 'EFOLDERGATE';
  override readonly name = 'FolderGateError';
  readonly folder: string;
  readonly state: ClosedState;
  readonly sentence: OwnText;

  constructor(folder: string, state: ClosedState) {
    const sentence = CLOSED_SENTENCE[state]();
    super(sentence.text);
    this.folder = folder;
    this.state = state;
    this.sentence = sentence;
  }
}

/** One blocked folder as the gate reports it: its name under home, its path, its state and since when. */
export interface FolderBlock {
  readonly name: string;
  readonly path: string;
  readonly state: Exclude<ClosedState, 'absent'>;
  /** ISO 8601: when the folder entered this state. */
  readonly since: string;
}

// ---------------------------------------------------------------------------
// Values of the disk operations
// ---------------------------------------------------------------------------

const S_IFMT = 0o170000;
const FILE_TYPES = {
  file: 0o100000, dir: 0o040000, link: 0o120000, fifo: 0o010000, socket: 0o140000, block: 0o060000, char: 0o020000,
} as const;

/** The type of a directory entry or a stats snapshot; `unknown` for one the system does not name. */
export type DiskEntryType = keyof typeof FILE_TYPES | 'unknown';

/** The numeric fields of a `stat` with `bigint: true`, the form the port always gives. */
export const STATS_FIELDS = [
  'dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks',
  'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs',
] as const;
export type StatsField = (typeof STATS_FIELDS)[number];

// A plain function, not a private member: callers wrap stats in a `Proxy`, which cannot reach private fields.
const hasType = (mode: bigint, type: keyof typeof FILE_TYPES): boolean => (Number(mode) & S_IFMT) === FILE_TYPES[type];

/** A snapshot of `BigIntStats`: the same fields, type checks and dates, as plain data. */
export class DiskStats {
  readonly dev!: bigint;
  readonly ino!: bigint;
  readonly mode!: bigint;
  readonly nlink!: bigint;
  readonly uid!: bigint;
  readonly gid!: bigint;
  readonly rdev!: bigint;
  readonly size!: bigint;
  readonly blksize!: bigint;
  readonly blocks!: bigint;
  readonly atimeMs!: bigint;
  readonly mtimeMs!: bigint;
  readonly ctimeMs!: bigint;
  readonly birthtimeMs!: bigint;
  readonly atimeNs!: bigint;
  readonly mtimeNs!: bigint;
  readonly ctimeNs!: bigint;
  readonly birthtimeNs!: bigint;

  constructor(fields: Readonly<Record<StatsField, bigint>>) {
    for (const field of STATS_FIELDS) (this as Record<StatsField, bigint>)[field] = fields[field];
  }

  isFile(): boolean { return hasType(this.mode, 'file'); }
  isDirectory(): boolean { return hasType(this.mode, 'dir'); }
  isSymbolicLink(): boolean { return hasType(this.mode, 'link'); }
  isFIFO(): boolean { return hasType(this.mode, 'fifo'); }
  isSocket(): boolean { return hasType(this.mode, 'socket'); }
  isBlockDevice(): boolean { return hasType(this.mode, 'block'); }
  isCharacterDevice(): boolean { return hasType(this.mode, 'char'); }
  get atime(): Date { return new Date(Number(this.atimeMs)); }
  get mtime(): Date { return new Date(Number(this.mtimeMs)); }
  get ctime(): Date { return new Date(Number(this.ctimeMs)); }
  get birthtime(): Date { return new Date(Number(this.birthtimeMs)); }
}

/** The snapshot of a `stat` result taken with `bigint: true`. */
export function diskStats(stats: Readonly<Record<StatsField, bigint>>): DiskStats {
  const fields = {} as Record<StatsField, bigint>;
  for (const field of STATS_FIELDS) fields[field] = stats[field];
  return new DiskStats(fields);
}

/** A snapshot of a `Dirent`: the name (string or bytes, as asked), the parent path and the type. */
export class DiskDirent<N extends string | Buffer = string | Buffer> {
  readonly name: N;
  readonly parentPath: string;
  readonly type: DiskEntryType;

  constructor(name: N, parentPath: string, type: DiskEntryType) {
    this.name = name;
    this.parentPath = parentPath;
    this.type = type;
  }

  /** The parent path under the name `node:fs` also gives it. */
  get path(): string { return this.parentPath; }
  isFile(): boolean { return this.type === 'file'; }
  isDirectory(): boolean { return this.type === 'dir'; }
  isSymbolicLink(): boolean { return this.type === 'link'; }
  isFIFO(): boolean { return this.type === 'fifo'; }
  isSocket(): boolean { return this.type === 'socket'; }
  isBlockDevice(): boolean { return this.type === 'block'; }
  isCharacterDevice(): boolean { return this.type === 'char'; }
}

export function diskDirent<N extends string | Buffer>(name: N, parentPath: string, type: DiskEntryType): DiskDirent<N> {
  return new DiskDirent(name, parentPath, type);
}

/** The head of a regular file as `safe-read.ts` reads it. */
export interface DiskHead {
  readonly bytes: Buffer;
  readonly truncated: boolean;
}

/** A regular file left open: the number of its handle and the stats of that descriptor. */
export interface DiskOpened {
  readonly handle: number;
  readonly stats: DiskStats;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** The arguments of each disk operation; every one but the handle calls names the path it touches. */
export interface DiskArgs {
  lstat: { readonly path: string };
  stat: { readonly path: string };
  readlink: { readonly path: string };
  /** `realpathSync` and `fs.realpath`: letter case as written. */
  realpath: { readonly path: string };
  /** `realpathSync.native` and `fs.promises.realpath`: letter case of the disk. */
  realpathNative: { readonly path: string };
  readdir: { readonly path: string; readonly encoding: 'utf8' | 'buffer' };
  /** `readdir` without `withFileTypes`: an entry whose type cannot be read does not fail the listing. */
  readdirNames: { readonly path: string };
  readHead: { readonly path: string; readonly maxBytes: number; readonly followSymlink: boolean };
  readdirByIdentity: { readonly path: string; readonly dev: bigint; readonly ino: bigint };
  openRead: { readonly path: string; readonly followSymlink: boolean };
  read: { readonly handle: number; readonly length: number; readonly position: number };
  close: { readonly handle: number };
  mkdir: { readonly path: string; readonly recursive?: boolean; readonly mode?: number };
  writeFile: { readonly path: string; readonly data: Buffer; readonly mode?: number; readonly flag?: string };
  /** `appendRegularFile` of `safe-read.ts`: append to a regular file, created when absent, never through a link. */
  appendRegular: { readonly path: string; readonly text: string };
  chmod: { readonly path: string; readonly mode: number };
  unlink: { readonly path: string };
  /** `opendir` of the folder and its first entry: whether the folder can be read at all. */
  check: { readonly path: string };
}

export type DiskOp = keyof DiskArgs;

/** The operations that also run synchronously; the rest exist only as promises. */
export type SyncDiskOp = Exclude<DiskOp, 'readdirByIdentity' | 'openRead' | 'read' | 'close' | 'appendRegular'>;

export interface DiskValue {
  lstat: DiskStats;
  stat: DiskStats;
  readlink: string;
  realpath: string;
  realpathNative: string;
  /** Names as strings for `encoding: 'utf8'`, as bytes for `'buffer'`. */
  readdir: readonly DiskDirent[];
  readdirNames: readonly string[];
  /** `null`: not a regular file. */
  readHead: DiskHead | null;
  /** `null`: another directory stands under the path, or the platform cannot read by identity. */
  readdirByIdentity: readonly DiskDirent<Buffer>[] | null;
  /** `null`: not a regular file. */
  openRead: DiskOpened | null;
  /** The bytes read, shorter than asked at the end of the file. */
  read: Buffer;
  close: void;
  /** With `recursive`, the first directory created, as `node:fs` gives it. */
  mkdir: string | undefined;
  writeFile: void;
  /** `false`: the path is not a regular file (a FIFO, a socket); nothing was written. */
  appendRegular: boolean;
  chmod: void;
  unlink: void;
  check: void;
}

// ---------------------------------------------------------------------------
// Client and gate
// ---------------------------------------------------------------------------

/** What a helper gave for one call. `gone`: it did not start, crashed, or was killed while the call was in flight. */
export type HelperAnswer<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'fs-error'; readonly error: NodeJS.ErrnoException }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'gone' };

export interface FolderClient {
  callSync<K extends SyncDiskOp>(folder: string, op: K, args: DiskArgs[K]): HelperAnswer<DiskValue[K]>;
  /**
   * `gen`, for `read` and `close`: the generation whose helper gave the handle. A handle names a file only in that
   * generation, so a call for another one fails with `EBADF` and reaches no helper; without `gen` the folder's current
   * generation is meant.
   */
  call<K extends DiskOp>(folder: string, op: K, args: DiskArgs[K], gen?: number): Promise<HelperAnswer<DiskValue[K]>>;
  /** Kills the folder's helper with SIGKILL and starts a new generation; returns its number. */
  restart(folder: string): number;
  /** The generation of the folder's current helper: the number a port call passes to `FolderGate.report`. */
  generationOf(folder: string): number;
  onLate(listener: (folder: string, gen: number, answer: HelperAnswer<unknown>) => void): () => void;
  /** SIGKILL to every helper; never waits. */
  dispose(): void;
}

export interface FolderGate {
  /** `false`: Linux, demo, the kill switch, tests. */
  readonly enabled: boolean;
  /** Sync, no disk. */
  stateOf(path: string): { folder: string; state: FolderState } | null;
  /**
   * An event of a call in the folder on helper generation `gen`: no answer in the bound, `EPERM`, a late success,
   * a helper gone, or `ok`, a listing or read the helper answered in the folder on disk.
   */
  report(folder: string, gen: number, event: 'timeout' | 'eperm' | 'late-ok' | 'gone' | 'ok'): void;
  /** Joins a check already running for the folder. */
  check(folder: string, waitMs: number): Promise<FolderState>;
  /** Waiting, denied and unchecked folders, sorted by name. */
  blocked(): FolderBlock[];
  onChange(listener: (folder: string, state: FolderState) => void): () => void;
  dispose(): void;
}
