/**
 * The work-area disk port: one operation of `DiskOp`, sync or async, in the form of `node:fs` (and of `safe-read.ts`
 * for regular files and the read by identity). Values are plain snapshots (`DiskStats`, `DiskDirent`, a handle
 * number) that the line codec (`wire.ts`) carries unchanged. `runDisk` and `runDiskSync` run a call on the disk of
 * this process; the helper serves its calls with them. `DIRECT_DISK`, the port the consumers use, runs every call
 * here until a folder gate is routed in (`routeWorkAreaDisk`); then a call whose target lies in a guarded folder of
 * home goes to that folder's helper or is refused while the folder is closed. The port knows no folder state itself;
 * it tells the gate what a helper answered, also a listing or read that shows the folder can be read.
 */
import type { Dirent } from 'node:fs';
import {
  chmodSync, lstatSync, mkdirSync, opendirSync, readdirSync, readlinkSync, realpath as realpathCallback,
  realpathSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  chmod, lstat, mkdir, opendir, readdir, readlink, realpath as realpathNative, stat, unlink, writeFile,
} from 'node:fs/promises';
import { constants } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { foldCase } from '../config/protected-dirs.ts';
import {
  appendRegularFile, openRegularFile, readDirectoryByIdentity, readRegularFile, readRegularFileSync,
} from '../safe-read.ts';
import {
  CLOSED_STATES, type ClosedState, type DiskArgs, type DiskDirent, type DiskEntryType, type DiskOp, type DiskStats,
  type DiskValue, type FolderClient, type FolderGate, FolderGateError, type FolderState, type HelperAnswer,
  type SyncDiskOp, diskDirent, diskStats,
} from './types.ts';

/** The port: one call of an operation, sync where `SyncDiskOp` allows it, or as a promise. */
export interface WorkAreaDisk {
  sync<K extends SyncDiskOp>(op: K, args: DiskArgs[K]): DiskValue[K];
  call<K extends DiskOp>(op: K, args: DiskArgs[K]): Promise<DiskValue[K]>;
}

/** `fs.realpath` with a callback is the JavaScript walk, like `realpathSync`; the promise form is the native one. */
const realpathJs = promisify(realpathCallback);

function typeOf(entry: Dirent<string | Buffer>): DiskEntryType {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'dir';
  if (entry.isSymbolicLink()) return 'link';
  if (entry.isFIFO()) return 'fifo';
  if (entry.isSocket()) return 'socket';
  if (entry.isBlockDevice()) return 'block';
  if (entry.isCharacterDevice()) return 'char';
  return 'unknown';
}

const entries = (list: readonly Dirent<string | Buffer>[]): DiskDirent[] =>
  list.map((entry) => diskDirent(entry.name, entry.parentPath, typeOf(entry)));

const bufferEntries = (list: readonly Dirent<Buffer>[]): DiskDirent<Buffer>[] =>
  list.map((entry) => diskDirent(entry.name, entry.parentPath, typeOf(entry)));

const mkdirOptions = (args: DiskArgs['mkdir']): { recursive: boolean; mode?: number } => ({
  recursive: args.recursive === true,
  ...(args.mode === undefined ? {} : { mode: args.mode }),
});

const writeOptions = (args: DiskArgs['writeFile']): { mode?: number; flag?: string } => ({
  ...(args.mode === undefined ? {} : { mode: args.mode }),
  ...(args.flag === undefined ? {} : { flag: args.flag }),
});

/** Files left open by `openRead`, by the descriptor number the caller holds as its handle. */
const OPEN_FILES = new Map<number, FileHandle>();

function badHandle(syscall: string): NodeJS.ErrnoException {
  const error = new Error(`EBADF: bad file descriptor, ${syscall}`) as NodeJS.ErrnoException;
  error.code = 'EBADF';
  error.errno = -constants.errno.EBADF;
  error.syscall = syscall;
  return error;
}

function openFile(handle: number, syscall: string): FileHandle {
  const file = OPEN_FILES.get(handle);
  if (file !== undefined) return file;
  throw badHandle(syscall);
}

type SyncTable = { readonly [K in SyncDiskOp]: (args: DiskArgs[K]) => DiskValue[K] };
type AsyncTable = { readonly [K in DiskOp]: (args: DiskArgs[K]) => Promise<DiskValue[K]> };

const SYNC: SyncTable = {
  lstat: (args) => diskStats(lstatSync(args.path, { bigint: true })),
  stat: (args) => diskStats(statSync(args.path, { bigint: true })),
  readlink: (args) => readlinkSync(args.path),
  realpath: (args) => realpathSync(args.path),
  realpathNative: (args) => realpathSync.native(args.path),
  readdir: (args) => entries(readdirSync(args.path, { withFileTypes: true, encoding: args.encoding as 'buffer' })),
  readdirNames: (args) => readdirSync(args.path),
  readHead: (args) => readRegularFileSync(args.path, { maxBytes: args.maxBytes, followSymlink: args.followSymlink }),
  mkdir: (args) => mkdirSync(args.path, mkdirOptions(args)),
  writeFile: (args) => writeFileSync(args.path, args.data, writeOptions(args)),
  chmod: (args) => chmodSync(args.path, args.mode),
  unlink: (args) => unlinkSync(args.path),
  check: (args) => {
    const dir = opendirSync(args.path);
    try {
      dir.readSync();
    } finally {
      dir.closeSync();
    }
    return undefined;
  },
};

const ASYNC: AsyncTable = {
  lstat: async (args) => diskStats(await lstat(args.path, { bigint: true })),
  stat: async (args) => diskStats(await stat(args.path, { bigint: true })),
  readlink: (args) => readlink(args.path),
  realpath: (args) => realpathJs(args.path),
  realpathNative: (args) => realpathNative(args.path),
  readdir: async (args) =>
    entries(await readdir(args.path, { withFileTypes: true, encoding: args.encoding as 'buffer' })),
  readdirNames: (args) => readdir(args.path),
  readHead: (args) => readRegularFile(args.path, { maxBytes: args.maxBytes, followSymlink: args.followSymlink }),
  readdirByIdentity: async (args) => {
    const list = await readDirectoryByIdentity(args.path, { dev: args.dev, ino: args.ino });
    return list === null ? null : bufferEntries(list);
  },
  openRead: async (args) => {
    const opened = await openRegularFile(args.path, { followSymlink: args.followSymlink });
    if (opened === null) return null;
    OPEN_FILES.set(opened.handle.fd, opened.handle);
    return { handle: opened.handle.fd, stats: diskStats(opened.stats) };
  },
  read: async (args) => {
    const buffer = Buffer.alloc(args.length);
    const { bytesRead } = await openFile(args.handle, 'read').read(buffer, 0, args.length, args.position);
    return bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  },
  close: async (args) => {
    const file = openFile(args.handle, 'close');
    OPEN_FILES.delete(args.handle);
    await file.close();
    return undefined;
  },
  mkdir: (args) => mkdir(args.path, mkdirOptions(args)),
  writeFile: (args) => writeFile(args.path, args.data, writeOptions(args)),
  appendRegular: (args) => appendRegularFile(args.path, args.text),
  chmod: (args) => chmod(args.path, args.mode),
  unlink: (args) => unlink(args.path),
  check: async (args) => {
    const dir = await opendir(args.path);
    try {
      await dir.read();
    } finally {
      await dir.close();
    }
    return undefined;
  },
};

/** One operation, synchronously, on the disk of this process. Throws the error `node:fs` throws. */
export function runDiskSync<K extends SyncDiskOp>(op: K, args: DiskArgs[K]): DiskValue[K] {
  return (SYNC[op] as (one: DiskArgs[K]) => DiskValue[K])(args);
}

/** One operation as a promise on the disk of this process. Rejects with the error `node:fs` gives. */
export function runDisk<K extends DiskOp>(op: K, args: DiskArgs[K]): Promise<DiskValue[K]> {
  return (ASYNC[op] as (one: DiskArgs[K]) => Promise<DiskValue[K]>)(args);
}

// ---------------------------------------------------------------------------
// Routing through the folder gate
// ---------------------------------------------------------------------------

/** What the port needs to send a call to a folder helper: the gate, its client and the home the gate judges. */
export interface DiskRoute {
  readonly gate: FolderGate;
  readonly client: FolderClient;
  readonly home: string;
}

interface Route extends DiskRoute {
  /** Home as written and on disk, as folded segments: the other spellings of a path in a guarded folder. */
  readonly homes: readonly (readonly string[])[];
}

let routed: Route | null = null;

const segmentsOf = (file: string): string[] => file.split(path.sep).filter((part) => part !== '');

/**
 * Sends the port's calls through the gate of `route` and returns the removal, which gives this process the calls
 * back. Home goes through `realpath` once here, so a path that reaches a guarded folder through the on-disk form of
 * home still finds it. A second route while one stands is a programming error and throws.
 */
export function routeWorkAreaDisk(route: DiskRoute): () => void {
  if (routed !== null) throw new Error('the work-area disk is already routed through a folder gate');
  const home = path.resolve(route.home);
  let onDisk = home;
  try {
    onDisk = runDiskSync('realpathNative', { path: home });
  } catch {
    // Home stays as written.
  }
  const homes = [...new Set([home, onDisk])].map((form) => segmentsOf(form).map(foldCase));
  const installed: Route = { ...route, home, homes };
  routed = installed;
  return () => {
    if (routed === installed) routed = null;
  };
}

/**
 * Metadata of a path in a guarded folder never waits for a macOS consent window, so these calls stay in this
 * process in every state of the folder, also while it is closed.
 */
const METADATA: ReadonlySet<DiskOp> = new Set<DiskOp>(['lstat', 'stat', 'readlink', 'realpath', 'realpathNative']);

/** Whether a call acts on what a symlink in the last segment points to, not on the link itself. */
function followsLast(op: DiskOp, args: unknown): boolean {
  if (op === 'unlink' || op === 'appendRegular') return false;
  if (op === 'readHead' || op === 'openRead') return (args as DiskArgs['readHead' | 'openRead']).followSymlink;
  return true;
}

type Target = { readonly folder: string; readonly state: FolderState };

/**
 * The guarded folder `candidate` lies in by its text, with the folder's state, or `null`. Besides the gate's own
 * judgement, a path under another spelling of home (on disk, another letter case, as the default macOS disk folds it)
 * counts as the same path under home.
 */
function folderOf(route: Route, candidate: string): Target | null {
  const byGate = route.gate.stateOf(candidate);
  if (byGate !== null) return byGate;
  const parts = segmentsOf(path.resolve(candidate));
  for (const home of route.homes) {
    if (parts.length <= home.length || !home.every((part, index) => part === foldCase(parts[index] ?? ''))) continue;
    return route.gate.stateOf(path.join(route.home, ...parts.slice(home.length)));
  }
  return null;
}

/** Symlinks followed in one walk before it gives up, as `ELOOP` of the system. */
const MAX_LINKS = 40;

/**
 * The guarded folder that holds the target of a call on `file`: by its text first, then by a walk from `/` one
 * segment at a time with `lstat` and `readlink` in this process, so a symlink anywhere on the way into a guarded
 * folder sends the call there. The walk stops at the first segment in a guarded folder and never reads inside it.
 * `..` climbs from where the walk stands, as the system does after a link. A segment that cannot be read counts as a
 * plain directory, so a path a call is about to create is judged by its text. The last segment is followed only for
 * a call that follows it. `null`: the call stays in this process.
 */
function targetFolder(route: Route, file: string, followLast: boolean): Target | null {
  const byText = folderOf(route, file);
  if (byText !== null) return byText;
  let pending = segmentsOf(path.isAbsolute(file) ? file : `${process.cwd()}${path.sep}${file}`);
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
    const found = folderOf(route, next);
    if (found !== null) return found;
    current = next;
    if (pending.length === 0 && !followLast) break;
    let link: string | null = null;
    try {
      if (runDiskSync('lstat', { path: next }).isSymbolicLink()) link = runDiskSync('readlink', { path: next });
    } catch {
      continue;
    }
    if (link === null) continue;
    links += 1;
    if (links > MAX_LINKS) return null;
    current = path.isAbsolute(link) ? path.sep : path.dirname(next);
    pending = [...segmentsOf(link), ...pending];
  }
  return null;
}

const isClosed = (state: FolderState): state is ClosedState => (CLOSED_STATES as readonly string[]).includes(state);

/**
 * The guarded folder `file` lies in by its text, under any spelling of home, with the gate's state of that folder;
 * `null` without a route and outside the guarded folders. Text only, without the disk.
 */
export function guardedFolderOf(file: string): { readonly folder: string; readonly state: FolderState } | null {
  const route = routed;
  return route === null ? null : folderOf(route, file);
}

/**
 * The refusal a call on `file` meets for its folder alone, by its text and without the disk: the guarded folder it
 * lies in, under any spelling of home, while the gate holds that folder closed. `null` without a route, outside the
 * guarded folders and in a folder that is open or unknown. Metadata passes a closed folder, so a walk that must not
 * enter one asks here before each segment.
 */
export function closedFolderOf(file: string): FolderGateError | null {
  const target = guardedFolderOf(file);
  return target !== null && isClosed(target.state) ? new FolderGateError(target.folder, target.state) : null;
}

/** Codes of an `lstat` that finds no directory to read under the path. */
const NOTHING_UNDER_PATH: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Whether the directory a read by identity names stands under its path now. On macOS that read goes through
 * `/.vol/<dev>/<ino>` and follows the directory wherever it went, so a directory moved into a guarded folder after
 * its path was judged would be read there, by whichever process runs the read. The check is metadata in this process
 * and runs in the same turn that starts the read; a move that lands between the two is not seen. An `lstat` that
 * finds nothing gives `false`; any other error of it is the error of the read.
 */
function standsUnderPath(args: DiskArgs['readdirByIdentity']): boolean {
  let info: DiskStats;
  try {
    info = runDiskSync('lstat', { path: args.path });
  } catch (error) {
    if (NOTHING_UNDER_PATH.has((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
  return info.isDirectory() && info.dev === args.dev && info.ino === args.ino;
}

/**
 * Calls whose success shows that macOS lets the helper read the folder: a listing, or a regular file opened and read
 * (`null`, no regular file opened, proves nothing). Metadata passes without consent. For a write, a change of mode, a
 * removal and a read by identity it is not known whether macOS asks first, so they prove nothing either.
 */
const PROVES_ACCESS: ReadonlySet<DiskOp> = new Set<DiskOp>(['readdir', 'readdirNames', 'readHead', 'openRead']);

/**
 * Tells the gate that a folder nobody judged yet (`unknown`) answered a listing or a read, so it opens without a check
 * of its own. Only when what was read lies in the folder on disk: a lookup in the folder never waits for consent, so
 * a path that leaves it through a symlink inside it was read elsewhere and proves nothing. `realpath` is metadata.
 */
function reportAccess(route: Route, target: Target, gen: number, op: DiskOp, args: unknown): void {
  if (target.state !== 'unknown' || !PROVES_ACCESS.has(op)) return;
  let real: string;
  try {
    real = runDiskSync('realpathNative', { path: (args as { readonly path: string }).path });
  } catch {
    return;
  }
  if (folderOf(route, real)?.folder === target.folder) route.gate.report(target.folder, gen, 'ok');
}

/** The refusal of a call in `folder` the helper did not answer: the folder's closed state, else `fallback`. */
function refusal(route: Route, folder: string, fallback: ClosedState): FolderGateError {
  const state = route.gate.stateOf(folder)?.state;
  return new FolderGateError(folder, state !== undefined && isClosed(state) ? state : fallback);
}

/**
 * A helper's answer as a caller of `node:fs` sees it. A timeout, a helper that is gone and `EPERM` go to the gate
 * first, with the generation the call went to; a call the helper did not answer is refused with the folder's state.
 * A success goes to the gate from {@link settleCall}, which knows what the call read.
 */
function settle<T>(route: Route, folder: string, gen: number, answer: HelperAnswer<T>): T {
  switch (answer.kind) {
    case 'ok':
      return answer.value;
    case 'fs-error':
      if (answer.error.code === 'EPERM') route.gate.report(folder, gen, 'eperm');
      throw answer.error;
    case 'timeout':
      route.gate.report(folder, gen, 'timeout');
      throw refusal(route, folder, 'waiting');
    case 'gone':
      route.gate.report(folder, gen, 'gone');
      throw refusal(route, folder, 'unchecked');
  }
}

/** {@link settle} for a call that names a path in `target`: a listing or read that succeeded may open the folder. */
function settleCall<T>(
  route: Route, target: Target, gen: number, op: DiskOp, args: unknown, answer: HelperAnswer<T>,
): T {
  if (answer.kind === 'ok' && answer.value !== null) reportAccess(route, target, gen, op, args);
  return settle(route, target.folder, gen, answer);
}

/** The target of a call that names a path; a closed folder refuses it here, without the disk. */
function openTarget(route: Route | null, op: DiskOp, args: unknown): Target | null {
  if (route === null || METADATA.has(op)) return null;
  const target = targetFolder(route, (args as { readonly path: string }).path, followsLast(op, args));
  if (target !== null && isClosed(target.state)) throw new FolderGateError(target.folder, target.state);
  return target;
}

function gatedSync<K extends SyncDiskOp>(op: K, args: DiskArgs[K]): DiskValue[K] {
  const route = routed;
  const target = openTarget(route, op, args);
  if (route === null || target === null) return runDiskSync(op, args);
  const gen = route.client.generationOf(target.folder);
  return settleCall(route, target, gen, op, args, route.client.callSync(target.folder, op, args));
}

/**
 * A file the port opened, by the number given where it is open: in this process (`helper` is `null`) or in a folder's
 * helper, with the route and the helper generation it was opened through. A helper's numbers are its descriptors, so
 * the next helper of the folder may give the same number to another file.
 */
interface PortFile {
  readonly handle: number;
  readonly helper: { readonly route: Route; readonly folder: string; readonly gen: number } | null;
}

/**
 * Files open through the port, by the port's own handle number: a descriptor here and the handles of two helpers
 * can carry the same number, so `read` and `close` find their file by the port's number.
 */
const PORT_FILES = new Map<number, PortFile>();
let nextPortHandle = 1;

async function openPortFile(args: DiskArgs['openRead']): Promise<DiskValue['openRead']> {
  const route = routed;
  const target = openTarget(route, 'openRead', args);
  let helper: PortFile['helper'] = null;
  let opened: DiskValue['openRead'];
  if (route === null || target === null) {
    opened = await runDisk('openRead', args);
  } else {
    // Read once, before the call: a helper of a later generation did not open the file.
    helper = { route, folder: target.folder, gen: route.client.generationOf(target.folder) };
    const answer = await route.client.call(helper.folder, 'openRead', args);
    opened = settleCall(route, target, helper.gen, 'openRead', args, answer);
  }
  if (opened === null) return null;
  const handle = nextPortHandle++;
  PORT_FILES.set(handle, { handle: opened.handle, helper });
  return { handle, stats: opened.stats };
}

/**
 * `close` of a file in a helper. A helper that no longer holds the file (killed, so the handle is stale, or gone) or
 * does not answer (the gate kills it) closes nothing more, so the close succeeds: a caller that closes in `finally`
 * keeps the refusal it is handling. The gate still hears of a timeout, `gone` and `EPERM`.
 */
function settleClose(route: Route, folder: string, gen: number, answer: HelperAnswer<void>): void {
  if (answer.kind === 'ok' || (answer.kind === 'fs-error' && answer.error.code === 'EBADF')) return;
  if (answer.kind === 'timeout' || answer.kind === 'gone') {
    route.gate.report(folder, gen, answer.kind);
    return;
  }
  settle(route, folder, gen, answer);
}

/**
 * `read` and `close` of a port handle, where the file was opened; a closed folder refuses a read. A file in a helper
 * that ended (its generation is over, or the route was removed) went with it: a read gives `EBADF` and a close has
 * nothing left to close, and neither reaches the folder's next helper, which may hold another file under that number.
 */
async function onPortFile<K extends 'read' | 'close'>(op: K, args: DiskArgs[K]): Promise<DiskValue[K]> {
  const file = PORT_FILES.get(args.handle);
  if (file === undefined) throw badHandle(op);
  if (op === 'close') PORT_FILES.delete(args.handle);
  const inner = { ...args, handle: file.handle };
  if (file.helper === null) return runDisk(op, inner);
  const { route, folder, gen } = file.helper;
  const ended = (): DiskValue[K] => {
    if (op === 'close') return undefined as DiskValue[K];
    throw badHandle(op);
  };
  if (routed !== route) return ended();
  if (op === 'read') {
    // Before the generation: a folder that enters `waiting` gets a new helper, and its refusal names the state.
    const state = route.gate.stateOf(folder)?.state;
    if (state !== undefined && isClosed(state)) throw new FolderGateError(folder, state);
  }
  if (route.client.generationOf(folder) !== gen) return ended();
  const answer = await route.client.call(folder, op, inner, gen);
  if (op === 'close') {
    settleClose(route, folder, gen, answer as HelperAnswer<void>);
    return undefined as DiskValue[K];
  }
  return settle(route, folder, gen, answer);
}

async function gatedCall<K extends DiskOp>(op: K, args: DiskArgs[K]): Promise<DiskValue[K]> {
  if (op === 'openRead') return await openPortFile(args as DiskArgs['openRead']) as DiskValue[K];
  if (op === 'read' || op === 'close') {
    return await onPortFile(op as 'read' | 'close', args as DiskArgs['read' | 'close']) as DiskValue[K];
  }
  const route = routed;
  const target = openTarget(route, op, args);
  if (route === null) return runDisk(op, args);
  // Checked after the walk and in the turn that starts the read, so nothing waits between the check and the read.
  if (op === 'readdirByIdentity' && !standsUnderPath(args as DiskArgs['readdirByIdentity'])) {
    return null as DiskValue[K];
  }
  if (target === null) return runDisk(op, args);
  const gen = route.client.generationOf(target.folder);
  return settleCall(route, target, gen, op, args, await route.client.call(target.folder, op, args));
}

/**
 * The port of the work area. Without a route, every call on the disk of this process. With one, metadata and paths
 * outside the guarded folders stay here, a closed folder refuses with `FolderGateError`, and the rest goes to the
 * folder's helper; a read by identity runs only while the directory still stands under its path. A handle from
 * `openRead` is the port's own number, valid only for `read` and `close` of the port, and only while the helper that
 * opened the file lives.
 */
export const DIRECT_DISK: WorkAreaDisk = { sync: gatedSync, call: gatedCall };
