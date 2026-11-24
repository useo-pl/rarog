/**
 * The folder gate wired in: the work-area port (`DIRECT_DISK`) sends a call in a guarded home folder to the helper of
 * that folder, refuses a call in a closed folder without the disk, and leaves metadata and every other path to this
 * process; the walk, the directory browser and the kill switch follow. The first part runs in this process on a fake
 * gate and client. The second runs a server process with the real bootstrap, relay thread and helper processes,
 * where a FIFO without a reader stands in for a read that waits on a macOS consent window (only an open for writing,
 * `writeFile`, waits on it), and measures `/health` of that process from this one. Time assertions carry only an
 * upper bound.
 */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderRelayUrl, startFolderGate } from '../src/bootstrap/folder-gate.ts';
import { ConfigError, loadConfig, parseFolderGate } from '../src/config.ts';
import { type WalkDisk, inExcludedOnDisk, inWorkAreaOnDisk, resolveInWorkArea } from '../src/config/work-area.ts';
import { RelayFolderClient } from '../src/folder-gate/client.ts';
import { DIRECT_DISK, type WorkAreaDisk, routeWorkAreaDisk } from '../src/folder-gate/disk.ts';
import { gatedFolderOf } from '../src/folder-gate/folders.ts';
import { MacFolderGate } from '../src/folder-gate/gate.ts';
import { folderGate, installFolderGate } from '../src/folder-gate/install.ts';
import {
  type DiskArgs, type DiskOp, type DiskValue, type FolderBlock, type FolderClient, type FolderGate,
  FolderGateError, type FolderState, type HelperAnswer, type SyncDiskOp,
} from '../src/folder-gate/types.ts';
import { browseDirectory } from '../src/fs-browse.ts';

/** Directories this process read by identity (`readDirectoryByIdentity` of `safe-read.ts`), by the path given. */
const identityReads = vi.hoisted((): string[] => []);
vi.mock('../src/safe-read.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/safe-read.ts')>();
  return {
    ...real,
    readDirectoryByIdentity: (...args: Parameters<typeof real.readDirectoryByIdentity>) => {
      identityReads.push(args[0]);
      return real.readDirectoryByIdentity(...args);
    },
  };
});

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BOOTSTRAP = new URL('../src/bootstrap/folder-gate.ts', import.meta.url);
const DISK = new URL('../src/folder-gate/disk.ts', import.meta.url);
const INSTALL = new URL('../src/folder-gate/install.ts', import.meta.url);
const RELAY = new URL('../src/folder-gate/relay-worker.ts', import.meta.url);
/** A stand-in helper that answers every `openRead` with handle 7 and logs each request line. */
const STUB = fileURLToPath(new URL('./helpers/stub-folder-helper.mjs', import.meta.url));
/** The bounds of the client (`FOLDER_SYNC_BOUND_MS`, `FOLDER_CALL_BOUND_MS`). */
const BOUND = 1000;
/** A bound no call reaches on a loaded machine, for a client whose helper always answers. */
const WIDE = 10_000;

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
const servers: ServerProcess[] = [];

afterEach(async () => {
  for (const undo of cleanups.splice(0).reverse()) undo();
  for (const server of servers.splice(0)) server.kill();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
};

const gateErrorOf = (run: () => unknown): FolderGateError => {
  try {
    run();
  } catch (error) {
    if (error instanceof FolderGateError) return error;
    throw error;
  }
  throw new Error('expected a FolderGateError');
};

// ---------------------------------------------------------------------------
// In this process: a fake gate and a recording client
// ---------------------------------------------------------------------------

interface Call {
  readonly folder: string;
  readonly op: DiskOp;
  readonly args: unknown;
  readonly gen: number;
}

class FakeClient implements FolderClient {
  readonly calls: Call[] = [];
  readonly generations = new Map<string, number>();
  answer: (folder: string, op: DiskOp, args: unknown) => HelperAnswer<unknown> = () => ({ kind: 'ok', value: [] });

  callSync<K extends SyncDiskOp>(folder: string, op: K, args: DiskArgs[K]): HelperAnswer<DiskValue[K]> {
    this.calls.push({ folder, op, args, gen: this.generationOf(folder) });
    return this.answer(folder, op, args) as HelperAnswer<DiskValue[K]>;
  }

  call<K extends DiskOp>(folder: string, op: K, args: DiskArgs[K]): Promise<HelperAnswer<DiskValue[K]>> {
    this.calls.push({ folder, op, args, gen: this.generationOf(folder) });
    return Promise.resolve(this.answer(folder, op, args) as HelperAnswer<DiskValue[K]>);
  }

  restart(folder: string): number {
    const gen = this.generationOf(folder) + 1;
    this.generations.set(folder, gen);
    return gen;
  }

  generationOf(folder: string): number {
    return this.generations.get(folder) ?? 1;
  }

  onLate(): () => void {
    return () => undefined;
  }

  dispose(): void {}
}

class FakeGate implements FolderGate {
  readonly enabled = true;
  readonly states = new Map<string, FolderState>();
  readonly reports: [string, number, string][] = [];
  readonly #home: string;

  constructor(home: string) {
    this.#home = home;
  }

  stateOf(candidate: string): { folder: string; state: FolderState } | null {
    const folder = gatedFolderOf(candidate, this.#home);
    return folder === null ? null : { folder, state: this.states.get(folder) ?? 'unknown' };
  }

  report(folder: string, gen: number, event: 'timeout' | 'eperm' | 'late-ok' | 'gone' | 'ok'): void {
    this.reports.push([folder, gen, event]);
    if (event === 'timeout') this.states.set(folder, 'waiting');
  }

  check(): Promise<FolderState> {
    return Promise.resolve('unknown');
  }

  blocked(): FolderBlock[] {
    return [];
  }

  onChange(): () => void {
    return () => undefined;
  }

  dispose(): void {}
}

/**
 * A home behind a symlink: `home` is the spelling the gate knows, `real` the directory it points to. Documents holds
 * `sub` with one file; `Projects` holds a plain directory and a link into Documents; `.claude/skills/x` links there
 * too.
 */
async function homeLayout(): Promise<{ home: string; real: string; documents: string; sub: string; projects: string }> {
  const base = await scratch('fge-');
  const real = path.join(base, 'real-home');
  const home = path.join(base, 'home');
  mkdirSync(path.join(real, 'Documents', 'sub'), { recursive: true });
  writeFileSync(path.join(real, 'Documents', 'sub', 'a.txt'), 'gated');
  mkdirSync(path.join(real, 'Projects', 'p'), { recursive: true });
  writeFileSync(path.join(real, 'Projects', 'p', 'b.txt'), 'plain');
  mkdirSync(path.join(real, '.claude', 'skills'), { recursive: true });
  symlinkSync(real, home);
  const documents = path.join(home, 'Documents');
  const sub = path.join(documents, 'sub');
  symlinkSync(sub, path.join(real, 'Projects', 'link'));
  symlinkSync(sub, path.join(real, '.claude', 'skills', 'x'));
  return { home, real, documents, sub, projects: path.join(home, 'Projects') };
}

function routed(home: string): { gate: FakeGate; client: FakeClient } {
  const gate = new FakeGate(home);
  const client = new FakeClient();
  cleanups.push(routeWorkAreaDisk({ gate, client, home }));
  return { gate, client };
}

describe('the work-area port routes by folder', () => {
  it('without a route every call goes to this process', async () => {
    const { sub } = await homeLayout();
    expect(DIRECT_DISK.sync('readdirNames', { path: sub })).toEqual(['a.txt']);
  });

  it('a call in an open folder goes to its helper with the generation read before the call', async () => {
    const { home, documents, sub } = await homeLayout();
    const { client } = routed(home);
    client.generations.set(documents, 4);
    client.answer = () => ({ kind: 'ok', value: ['from-helper'] });
    expect(DIRECT_DISK.sync('readdirNames', { path: sub })).toEqual(['from-helper']);
    expect(await DIRECT_DISK.call('readdir', { path: sub, encoding: 'utf8' })).toEqual(['from-helper']);
    expect(client.calls).toEqual([
      { folder: documents, op: 'readdirNames', args: { path: sub }, gen: 4 },
      { folder: documents, op: 'readdir', args: { path: sub, encoding: 'utf8' }, gen: 4 },
    ]);
  });

  it('a call in a closed folder is refused without the disk and without the helper, sync and async', async () => {
    const { home, documents, sub } = await homeLayout();
    const { gate, client } = routed(home);
    gate.states.set(documents, 'denied');
    const error = gateErrorOf(() => DIRECT_DISK.sync('readdirNames', { path: sub }));
    expect({ folder: error.folder, state: error.state, code: error.code }).toEqual({
      folder: documents, state: 'denied', code: 'EFOLDERGATE',
    });
    await expect(DIRECT_DISK.call('readHead', { path: path.join(sub, 'a.txt'), maxBytes: 10, followSymlink: true }))
      .rejects.toMatchObject({ code: 'EFOLDERGATE', state: 'denied' });
    expect(client.calls).toEqual([]);
  });

  it('metadata goes to this process in every state', async () => {
    const { home, documents, sub } = await homeLayout();
    const { gate, client } = routed(home);
    gate.states.set(documents, 'waiting');
    const file = path.join(sub, 'a.txt');
    expect(DIRECT_DISK.sync('lstat', { path: file }).isFile()).toBe(true);
    expect(DIRECT_DISK.sync('stat', { path: file }).isFile()).toBe(true);
    expect(DIRECT_DISK.sync('realpath', { path: file })).toBe(realpathSync(file));
    expect(await DIRECT_DISK.call('realpathNative', { path: file })).toBe(realpathSync.native(file));
    const link = path.join(home, 'Projects', 'link');
    expect((await DIRECT_DISK.call('lstat', { path: link })).isSymbolicLink()).toBe(true);
    expect(await DIRECT_DISK.call('readlink', { path: link })).toBe(sub);
    expect(client.calls).toEqual([]);
  });

  it('a path outside the guarded folders goes to this process', async () => {
    const { home, projects } = await homeLayout();
    const { client } = routed(home);
    expect(DIRECT_DISK.sync('readdirNames', { path: path.join(projects, 'p') })).toEqual(['b.txt']);
    expect(client.calls).toEqual([]);
  });

  it('a symlink into a guarded folder sends the call to that folder, also in a parent segment', async () => {
    const { home, documents, projects } = await homeLayout();
    const { client } = routed(home);
    client.answer = () => ({ kind: 'ok', value: null });
    DIRECT_DISK.sync('readdirNames', { path: path.join(home, '.claude', 'skills', 'x') });
    const inLinked = path.join(projects, 'link', 'a.txt');
    await DIRECT_DISK.call('readHead', { path: inLinked, maxBytes: 5, followSymlink: false });
    // `..` after a link climbs from where the link leads, not from the text.
    DIRECT_DISK.sync('readdirNames', { path: `${projects}/link/..` });
    expect(client.calls.map((call) => [call.folder, call.op])).toEqual([
      [documents, 'readdirNames'], [documents, 'readHead'], [documents, 'readdirNames'],
    ]);
  });

  it('a call that does not follow the last segment stays here for a link into a guarded folder', async () => {
    const { home, projects, sub } = await homeLayout();
    const { client } = routed(home);
    const link = path.join(projects, 'link');
    await DIRECT_DISK.call('unlink', { path: link });
    expect(readdirSync(projects)).toEqual(['p']);
    expect(readdirSync(sub)).toEqual(['a.txt']);
    expect(client.calls).toEqual([]);
  });

  it('other spellings of home reach the same folder: on disk, through a link, in another letter case', async () => {
    const { home, real, documents } = await homeLayout();
    const { gate, client } = routed(home);
    gate.states.set(documents, 'unchecked');
    const realBase = realpathSync.native(path.dirname(home));
    const spellings = [
      path.join(real, 'Documents', 'sub'),
      path.join(realBase, 'home', 'Documents', 'sub'),
      path.join(home.toUpperCase(), 'documents', 'sub'),
    ];
    for (const spelling of spellings) {
      expect(gateErrorOf(() => DIRECT_DISK.sync('readdirNames', { path: spelling })).folder, spelling).toBe(documents);
    }
    expect(client.calls).toEqual([]);
  });

  it('a missing tail is judged by its text, so a write that creates it still reaches the folder', async () => {
    const { home, documents, projects } = await homeLayout();
    const { client } = routed(home);
    client.answer = () => ({ kind: 'ok', value: undefined });
    DIRECT_DISK.sync('mkdir', { path: path.join(projects, 'link', 'new', 'deeper'), recursive: true });
    DIRECT_DISK.sync('mkdir', { path: `${projects}/missing/../link/n2`, recursive: true });
    expect(client.calls.map((call) => call.folder)).toEqual([documents, documents]);
  });

  it('a listing or a read the helper answers opens an unknown folder; metadata, a write and a path that leaves the '
    + 'folder through a link inside it do not', async () => {
    const { home, real, documents, sub } = await homeLayout();
    symlinkSync(path.join(real, 'Projects', 'p'), path.join(real, 'Documents', 'out'));
    const client = new FakeClient();
    const gate = new MacFolderGate({ home, client, boundMs: BOUND });
    const changes: [string, FolderState][] = [];
    gate.onChange((folder, state) => { changes.push([folder, state]); });
    cleanups.push(() => { gate.dispose(); }, routeWorkAreaDisk({ gate, client, home }));
    client.answer = () => ({ kind: 'ok', value: undefined });
    DIRECT_DISK.sync('mkdir', { path: path.join(sub, 'new'), recursive: true });
    await DIRECT_DISK.call('writeFile', { path: path.join(sub, 'w.txt'), data: Buffer.from('x') });
    expect(DIRECT_DISK.sync('stat', { path: sub }).isDirectory()).toBe(true);
    client.answer = () => ({ kind: 'ok', value: null });
    // No regular file was opened, so nothing was read.
    await DIRECT_DISK.call('readHead', { path: path.join(sub, 'a.txt'), maxBytes: 5, followSymlink: false });
    client.answer = () => ({ kind: 'ok', value: [] });
    // A lookup in the folder never waits for consent, so a listing through the link there proves nothing.
    DIRECT_DISK.sync('readdirNames', { path: path.join(documents, 'out') });
    expect(gate.stateOf(documents)?.state).toBe('unknown');
    await DIRECT_DISK.call('readdir', { path: sub, encoding: 'utf8' });
    expect(gate.stateOf(documents)?.state).toBe('open');
    expect(changes).toEqual([[documents, 'open']]);
    expect(gate.blocked()).toEqual([]);
    expect(client.calls.map((call) => call.op)).toEqual(['mkdir', 'writeFile', 'readHead', 'readdirNames', 'readdir']);
  });

  it('timeout, gone and EPERM go to the gate; the caller gets the state or the error', async () => {
    const { home, documents, sub } = await homeLayout();
    const { gate, client } = routed(home);
    client.generations.set(documents, 7);
    const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });

    client.answer = () => ({ kind: 'fs-error', error: eperm });
    expect(codeOf(() => DIRECT_DISK.sync('readdirNames', { path: sub }))).toBe('EPERM');
    client.answer = () => ({ kind: 'fs-error', error: enoent });
    await expect(DIRECT_DISK.call('readdirNames', { path: sub })).rejects.toBe(enoent);
    client.answer = () => ({ kind: 'gone' });
    expect(gateErrorOf(() => DIRECT_DISK.sync('readdirNames', { path: sub })).state).toBe('unchecked');
    client.answer = () => ({ kind: 'timeout' });
    await expect(DIRECT_DISK.call('readdirNames', { path: sub })).rejects.toMatchObject({ state: 'waiting' });
    expect(gate.reports).toEqual([[documents, 7, 'eperm'], [documents, 7, 'gone'], [documents, 7, 'timeout']]);
  });

  it('handles of the port name one file each: here or in a helper, read and close go where it was opened', async () => {
    const { home, documents, projects, sub } = await homeLayout();
    const { gate, client } = routed(home);
    const stats = DIRECT_DISK.sync('stat', { path: path.join(sub, 'a.txt') });
    client.answer = (_folder, op, args) => {
      if (op === 'openRead') return { kind: 'ok', value: { handle: 3, stats } };
      const { handle } = args as { readonly handle?: number };
      if (op === 'read') return { kind: 'ok', value: Buffer.from(`helper ${String(handle)}`) };
      return { kind: 'ok', value: undefined };
    };
    const local = await DIRECT_DISK.call('openRead', { path: path.join(projects, 'p', 'b.txt'), followSymlink: false });
    const first = await DIRECT_DISK.call('openRead', { path: path.join(sub, 'a.txt'), followSymlink: false });
    const second = await DIRECT_DISK.call('openRead', { path: path.join(sub, 'a.txt'), followSymlink: false });
    const handles = [local?.handle, first?.handle, second?.handle];
    expect(new Set(handles).size).toBe(3);
    expect(String(await DIRECT_DISK.call('read', { handle: local?.handle ?? -1, length: 5, position: 0 })))
      .toBe('plain');
    expect(String(await DIRECT_DISK.call('read', { handle: second?.handle ?? -1, length: 5, position: 0 })))
      .toBe('helper 3');
    gate.states.set(documents, 'waiting');
    await expect(DIRECT_DISK.call('read', { handle: first?.handle ?? -1, length: 5, position: 0 }))
      .rejects.toMatchObject({ code: 'EFOLDERGATE' });
    for (const handle of handles) await DIRECT_DISK.call('close', { handle: handle ?? -1 });
    await expect(DIRECT_DISK.call('read', { handle: local?.handle ?? -1, length: 1, position: 0 }))
      .rejects.toMatchObject({ code: 'EBADF' });
    expect(client.calls.map((call) => [call.op, call.args])).toEqual([
      ['openRead', { path: path.join(sub, 'a.txt'), followSymlink: false }],
      ['openRead', { path: path.join(sub, 'a.txt'), followSymlink: false }],
      ['read', { handle: 3, length: 5, position: 0 }],
      ['close', { handle: 3 }],
      ['close', { handle: 3 }],
    ]);
  });

  it('close of a file in a helper that no longer holds it succeeds, and the gate hears of a timeout', async () => {
    const { home, documents, sub } = await homeLayout();
    const { gate, client } = routed(home);
    // Open already, so the opens report nothing and the list holds what the closes told.
    gate.states.set(documents, 'open');
    const stats = DIRECT_DISK.sync('stat', { path: path.join(sub, 'a.txt') });
    const ebadf = Object.assign(new Error('EBADF: bad file descriptor, close'), { code: 'EBADF' });
    const closeAnswers: HelperAnswer<unknown>[] = [
      { kind: 'fs-error', error: ebadf }, { kind: 'gone' }, { kind: 'timeout' },
    ];
    client.answer = (_folder, op) => (op === 'openRead'
      ? { kind: 'ok', value: { handle: 5, stats } }
      : closeAnswers.shift() ?? { kind: 'ok', value: undefined });
    for (let round = 0; round < 3; round += 1) {
      const opened = await DIRECT_DISK.call('openRead', { path: path.join(sub, 'a.txt'), followSymlink: true });
      await expect(DIRECT_DISK.call('close', { handle: opened?.handle ?? -1 })).resolves.toBeUndefined();
    }
    expect(gate.reports).toEqual([[documents, 1, 'gone'], [documents, 1, 'timeout']]);
  });

  it('a read by identity runs only while the directory stands under its path, so a move into a closed folder '
    + 'reads nothing', async () => {
    const { home, real, documents, projects } = await homeLayout();
    const { gate, client } = routed(home);
    const dir = path.join(projects, 'p');
    const { dev, ino } = statSync(dir, { bigint: true });
    identityReads.length = 0;
    const here = await DIRECT_DISK.call('readdirByIdentity', { path: dir, dev, ino });
    expect(here?.map((entry) => String(entry.name))).toEqual(['b.txt']);
    expect(identityReads).toEqual([dir]);
    // On macOS the read goes through `/.vol/<dev>/<ino>`, which follows the directory wherever it went.
    renameSync(path.join(real, 'Projects', 'p'), path.join(real, 'Documents', 'p'));
    gate.states.set(documents, 'waiting');
    expect(await DIRECT_DISK.call('readdirByIdentity', { path: dir, dev, ino })).toBeNull();
    mkdirSync(dir);
    expect(await DIRECT_DISK.call('readdirByIdentity', { path: dir, dev, ino })).toBeNull();
    expect(identityReads).toEqual([dir]);
    expect(client.calls).toEqual([]);
  });

  it('a handle names its file only in the helper generation that opened it: after a restart read is EBADF and '
    + 'close sends nothing', async () => {
    const home = await scratch('fgr-');
    const documents = path.join(home, 'Documents');
    const log = path.join(home, 'requests.log');
    const client = new RelayFolderClient({
      relay: RELAY, helper: { file: process.execPath, args: [STUB, log] }, syncBoundMs: WIDE, callBoundMs: WIDE,
    });
    const gate = new FakeGate(home);
    cleanups.push(() => { client.dispose(); }, routeWorkAreaDisk({ gate, client, home }));
    const first = await DIRECT_DISK.call('openRead', { path: path.join(documents, 'a.txt'), followSymlink: false });
    expect(client.restart(documents)).toBe(2);
    // The new helper gives the same number again, as a new process gives the lowest free descriptor.
    const second = await DIRECT_DISK.call('openRead', { path: path.join(documents, 'b.txt'), followSymlink: false });
    const read = (handle: number | undefined): Promise<Buffer> =>
      DIRECT_DISK.call('read', { handle: handle ?? -1, length: 1, position: 0 });
    // A closed folder refuses a read with its state first, also one of a handle whose helper is gone.
    gate.states.set(documents, 'waiting');
    await expect(read(first?.handle)).rejects.toMatchObject({ code: 'EFOLDERGATE', state: 'waiting' });
    gate.states.delete(documents);
    await expect(read(first?.handle)).rejects.toMatchObject({ code: 'EBADF' });
    await expect(DIRECT_DISK.call('close', { handle: first?.handle ?? -1 })).resolves.toBeUndefined();
    // The stub answers a read with its arguments: the read reached the new helper with its own handle.
    await expect(read(second?.handle)).resolves.toEqual({ handle: 7, length: 1, position: 0 });
    await DIRECT_DISK.call('close', { handle: second?.handle ?? -1 });
    const ops = readFileSync(log, 'utf8').split('\n').filter(Boolean)
      .map((line) => (JSON.parse(line) as { readonly op: string }).op);
    expect(ops).toEqual(['openRead', 'openRead', 'read', 'close']);
  });
});

// ---------------------------------------------------------------------------
// The walk and the directory browser on a closed folder
// ---------------------------------------------------------------------------

describe('a closed folder in the walk and in the directory browser', () => {
  const closedAt = (folder: string, state: 'waiting' | 'denied', inner: WalkDisk): WalkDisk => ({
    lstat: (file) => {
      if (file === folder || file.startsWith(`${folder}${path.sep}`)) throw new FolderGateError(folder, state);
      return inner.lstat(file);
    },
    readlink: inner.readlink,
  });
  const direct: WalkDisk = {
    lstat: (file) => DIRECT_DISK.sync('lstat', { path: file }),
    readlink: (file) => DIRECT_DISK.sync('readlink', { path: file }),
  };

  it('the walk stops at a closed folder: never missing, out of the work area, excluded from git', async () => {
    const base = realpathSync.native(await scratch('fgw-'));
    const documents = path.join(base, 'Documents');
    mkdirSync(path.join(documents, 'p'), { recursive: true });
    const walk = closedAt(documents, 'waiting', direct);
    const area = { ...walk, realpath: (file: string) => realpathSync(file) };
    const walked = resolveInWorkArea(path.join(documents, 'p'), [documents], base, walk);
    expect(walked.kind).toBe('excluded');
    expect(walked.kind === 'excluded' ? walked.closed?.state : null).toBe('waiting');
    expect(inWorkAreaOnDisk(path.join(documents, 'p'), [documents], base, area)).toBe(false);
    expect(inExcludedOnDisk(path.join(documents, 'p'), [documents], base, area)).toBe(true);
  });

  it('with the gate routed in, the walk stops at a waiting folder although its metadata passes', async () => {
    const { home, documents, sub } = await homeLayout();
    const client = new FakeClient();
    client.answer = () => ({ kind: 'timeout' });
    const gate = new MacFolderGate({ home, client, boundMs: BOUND });
    cleanups.push(() => { gate.dispose(); }, installFolderGate(gate), routeWorkAreaDisk({ gate, client, home }));
    gate.report(documents, client.generationOf(documents), 'timeout');
    expect(gate.stateOf(documents)?.state).toBe('waiting');
    expect(DIRECT_DISK.sync('lstat', { path: sub }).isDirectory()).toBe(true);
    const onDisk = (file: string): string => realpathSync.native(file);
    const walked = resolveInWorkArea(onDisk(sub), [onDisk(documents)], onDisk(home));
    expect(walked.kind).toBe('excluded');
    const closed = walked.kind === 'excluded' ? walked.closed : undefined;
    expect({ folder: closed?.folder, state: closed?.state }).toEqual({ folder: documents, state: 'waiting' });
    // A missing tail is out too: the walk stops at the folder before a missing segment could keep the text's verdict.
    for (const cwd of [sub, path.join(sub, 'gone', 'deeper')]) {
      expect(inWorkAreaOnDisk(cwd, [documents], home), cwd).toBe(false);
      expect(inExcludedOnDisk(cwd, [documents], home), cwd).toBe(true);
    }
  });

  it('the browser refuses a closed folder with the sentence of its state, from the walk and the listing', async () => {
    const base = realpathSync.native(await scratch('fgf-'));
    const documents = path.join(base, 'Documents');
    mkdirSync(path.join(documents, 'p', 'q'), { recursive: true });
    const store = path.join(base, 'store');
    const fromWalk = await browseDirectory(path.join(documents, 'p'), {
      roots: [documents], home: base, storeRoot: store, walk: closedAt(documents, 'denied', direct),
    });
    expect(fromWalk).toEqual({
      ok: false, status: 404, error: 'not-found', sentence: new FolderGateError(documents, 'denied').sentence,
    });
    const listingRefused: WorkAreaDisk = {
      sync: DIRECT_DISK.sync,
      call: (op, args) => (op === 'readdir'
        ? Promise.reject(new FolderGateError(documents, 'waiting'))
        : DIRECT_DISK.call(op, args)) as never,
    };
    const fromListing = await browseDirectory(path.join(documents, 'p'), {
      roots: [documents], home: base, storeRoot: store, disk: listingRefused,
    });
    expect(fromListing).toEqual({
      ok: false, status: 404, error: 'not-found', sentence: new FolderGateError(documents, 'waiting').sentence,
    });
  });
});

// ---------------------------------------------------------------------------
// The kill switch and the bootstrap
// ---------------------------------------------------------------------------

describe('the kill switch', () => {
  it('RAROG_FOLDER_GATE: the platform picks the default, 1 and 0 decide, anything else stops the start', () => {
    expect(parseFolderGate(undefined, 'darwin')).toBe(true);
    expect(parseFolderGate('', 'darwin')).toBe(true);
    expect(parseFolderGate(undefined, 'linux')).toBe(false);
    expect(parseFolderGate('1', 'linux')).toBe(true);
    expect(parseFolderGate(' 0 ', 'darwin')).toBe(false);
    expect(() => parseFolderGate('yes', 'darwin')).toThrow(ConfigError);
  });

  it('the demo never runs the gate; a wrong value stops it too', () => {
    const origins = { RAROG_ORIGINS: 'https://rarog.example' };
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_FOLDER_GATE: '1' }).folderGate).toBe(false);
    expect(loadConfig({ ...origins, RAROG_FOLDER_GATE: '0' }).folderGate).toBe(false);
    expect(loadConfig({ ...origins, RAROG_FOLDER_GATE: '1' }).folderGate).toBe(true);
    expect(() => loadConfig({ RAROG_DEMO: '1', RAROG_FOLDER_GATE: 'on' })).toThrow(ConfigError);
  });

  it('off: no gate, no client, no relay; the port stays on this process', async () => {
    const { home, sub } = await homeLayout();
    expect(startFolderGate({ enabled: false, home, roots: [home], log: () => undefined })).toBeNull();
    expect(folderGate().enabled).toBe(false);
    expect(DIRECT_DISK.sync('readdirNames', { path: sub })).toEqual(['a.txt']);
  });

  it('the relay thread module: TypeScript in a clone, JavaScript in the package', () => {
    expect(folderRelayUrl('/opt/r', 'clone').href)
      .toBe(pathToFileURL('/opt/r/server/src/folder-gate/relay-worker.ts').href);
    expect(folderRelayUrl('/opt/r', 'package').href)
      .toBe(pathToFileURL('/opt/r/server/src/folder-gate/relay-worker.js').href);
  });
});

// ---------------------------------------------------------------------------
// A server process with the real bootstrap, relay thread and helpers
// ---------------------------------------------------------------------------

interface StepResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly code?: string;
  readonly state?: string;
  readonly folder?: string;
  readonly ms: number;
}

type Answer = { readonly results?: StepResult[] } & Record<string, unknown>;

interface ServerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly port: number;
  /** Lines the gate logged and the states it entered, in order. */
  readonly logs: string[];
  readonly changes: [string, string][];
  send(command: Record<string, unknown>, ms?: number): Promise<Answer>;
  kill(): void;
}

/** The server process: the bootstrap with `home` and `roots`, `/health`, and steps read from stdin. */
const SERVER_SOURCE = `
import http from 'node:http';
import { createInterface } from 'node:readline';
import { startFolderGate } from ${JSON.stringify(BOOTSTRAP.href)};
import { DIRECT_DISK } from ${JSON.stringify(DISK.href)};
import { folderGate } from ${JSON.stringify(INSTALL.href)};
const [home, enabled, roots] = process.argv.slice(2);
const plain = (key, value) => (typeof value === 'bigint' ? String(value) : value);
const print = (message) => { process.stdout.write(JSON.stringify(message, plain) + '\\n'); };
const runtime = startFolderGate({
  enabled: enabled === '1', home, roots: JSON.parse(roots), log: (line) => { print({ log: line }); },
});
folderGate().onChange((folder, state) => { print({ change: [folder, state] }); });
const argsOf = (args) => (typeof args.data === 'string' ? { ...args, data: Buffer.from(args.data) } : args);
const failed = (error, started) => ({
  ok: false, code: error.code, state: error.state, folder: error.folder, ms: performance.now() - started,
});
async function run(command) {
  if (command.exit) process.exit(0);
  if (command.blocked) return { blocked: folderGate().blocked(), runtime: runtime !== null };
  const results = [];
  for (const step of command.steps) {
    const started = performance.now();
    try {
      const value = step.mode === 'sync'
        ? DIRECT_DISK.sync(step.op, argsOf(step.args)) : await DIRECT_DISK.call(step.op, argsOf(step.args));
      results.push({ ok: true, value, ms: performance.now() - started });
    } catch (error) {
      results.push(failed(error, started));
    }
  }
  return { results };
}
const server = http.createServer((req, res) => { res.end('{"ok":true}'); });
server.listen(0, '127.0.0.1', () => { print({ port: server.address().port }); });
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  void run(command).then((answer) => { print({ id: command.id, ...answer }); });
});
process.on('SIGTERM', () => { process.exit(0); });
`;

async function startServer(
  home: string, enabled: boolean, roots: readonly string[] = [path.join(home, 'Documents')],
): Promise<ServerProcess> {
  const dir = await scratch('fgs-');
  const script = path.join(dir, 'server.mjs');
  await writeFile(script, SERVER_SOURCE);
  const child = spawn(process.execPath, ['--import', 'tsx', script, home, enabled ? '1' : '0', JSON.stringify(roots)], {
    cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  const changes: [string, string][] = [];
  const waiting = new Map<number, (answer: Record<string, unknown>) => void>();
  let nextId = 1;
  let stderr = '';
  let buffer = '';
  const port = new Promise<number>((resolve, reject) => {
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('exit', (code) => { reject(new Error(`server exited with ${String(code)}: ${stderr}`)); });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
        buffer = buffer.slice(end + 1);
        if (typeof message.port === 'number') resolve(message.port);
        if (typeof message.log === 'string') logs.push(message.log);
        if (Array.isArray(message.change)) changes.push(message.change as [string, string]);
        if (typeof message.id === 'number') waiting.get(message.id)?.(message);
      }
    });
  });
  const server: ServerProcess = {
    child,
    port: await port,
    logs,
    changes,
    send: (command, ms = 10_000) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { reject(new Error(`no answer in ${String(ms)} ms: ${stderr}`)); }, ms);
      waiting.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    }),
    kill: () => {
      for (const pid of childPids(child.pid)) killQuietly(pid);
      child.kill('SIGKILL');
    },
  };
  servers.push(server);
  return server;
}

/** The helpers the relay thread of a server process started: its children that run the helper module. */
function childPids(pid: number | undefined): number[] {
  if (pid === undefined) return [];
  try {
    return execFileSync('pgrep', ['-P', String(pid), '-f', 'folder-gate/helper'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function eventually(check: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  return check();
}

interface HealthSample {
  readonly startedAt: number;
  readonly ms: number;
}

/** One `/health` request after another on a fresh connection each, from this process, until `stop` resolves. */
async function pollHealth(port: number, stop: Promise<unknown>): Promise<HealthSample[]> {
  const samples: HealthSample[] = [];
  let stopped = false;
  void stop.finally(() => { stopped = true; });
  while (!stopped) {
    const startedAt = performance.now();
    await new Promise<void>((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/health', agent: false }, (res) => {
        res.resume();
        res.on('end', () => { resolve(); });
      });
      request.on('error', reject);
    });
    samples.push({ startedAt, ms: performance.now() - startedAt });
    await new Promise((done) => setTimeout(done, 10));
  }
  return samples;
}

/** A real home with Documents, Downloads and Projects, and a FIFO without a reader in each guarded folder. */
async function fifoHome(): Promise<{ home: string; fifo: (folder: string) => string }> {
  const home = await scratch('fgh-');
  for (const folder of ['Documents', 'Downloads']) {
    mkdirSync(path.join(home, folder, 'x'), { recursive: true });
    execFileSync('mkfifo', [path.join(home, folder, 'fifo')]);
  }
  mkdirSync(path.join(home, 'Projects', 'p'), { recursive: true });
  mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(path.join(home, 'Documents', 'x'), path.join(home, '.claude', 'skills', 'x'));
  return { home, fifo: (folder) => path.join(home, folder, 'fifo') };
}

describe('a server process with the gate', () => {
  it('a sync call that hangs: refused within the bound, the folder waits, /health stalls at most once', async () => {
    const { home, fifo } = await fifoHome();
    const server = await startServer(home, true);
    const documents = path.join(home, 'Documents');
    let answeredAt = Number.POSITIVE_INFINITY;
    const answer = server.send({
      steps: [
        { mode: 'sync', op: 'writeFile', args: { path: fifo('Documents'), data: 'x' } },
        { mode: 'sync', op: 'readdirNames', args: { path: documents } },
      ],
    }).then((reply) => {
      answeredAt = performance.now();
      return reply;
    });
    const health = pollHealth(server.port, answer.then(() => new Promise((done) => setTimeout(done, 300))));
    const [first, second] = (await answer).results ?? [];
    expect(first).toMatchObject({ ok: false, code: 'EFOLDERGATE', state: 'waiting', folder: documents });
    expect(first?.ms).toBeLessThan(BOUND + 500);
    // The next call in the folder, in the same tick: refused without waiting.
    expect(second).toMatchObject({ ok: false, code: 'EFOLDERGATE', state: 'waiting' });
    expect(second?.ms).toBeLessThan(200);
    const samples = await health;
    expect(Math.max(...samples.map((sample) => sample.ms))).toBeLessThan(BOUND + 500);
    const after = samples.filter((sample) => sample.startedAt > answeredAt);
    expect(after.length).toBeGreaterThan(0);
    expect(Math.max(...after.map((sample) => sample.ms))).toBeLessThan(200);
    expect(server.logs).toContain(`folder gate: Documents waiting (no answer in ${String(BOUND)} ms)`);
    // The FIFO only hangs a write: a new helper reads the folder at once, so the wait was a slow read.
    // The check runs on a new helper that starts cold, which can take a few seconds on a loaded machine.
    expect(await eventually(() => server.changes.some(([, state]) => state === 'open'), 10_000)).toBe(true);
    expect(server.changes.map(([folder, state]) => [path.basename(folder), state]).slice(0, 2))
      .toEqual([['Documents', 'waiting'], ['Documents', 'open']]);
  });

  it('an async call that hangs: refused at the bound, /health never stalls, the process exits at once', async () => {
    const { home, fifo } = await fifoHome();
    const server = await startServer(home, true);
    const write = { mode: 'async', op: 'writeFile', args: { path: fifo('Downloads'), data: 'x' } };
    const answer = server.send({ steps: [write] });
    const samples = await pollHealth(server.port, answer);
    const [result] = (await answer).results ?? [];
    expect(result).toMatchObject({ ok: false, code: 'EFOLDERGATE', state: 'waiting' });
    expect(result?.ms).toBeLessThan(BOUND + 500);
    expect(Math.max(...samples.map((sample) => sample.ms))).toBeLessThan(200);
    // A write to the FIFO left on a thread of this process would hold `process.exit` until the FIFO opens.
    const exited = new Promise<number | null>((done) => { server.child.on('exit', (code) => { done(code); }); });
    const exitAsked = performance.now();
    void server.send({ exit: true }).catch(() => undefined);
    expect(await exited).toBe(0);
    expect(performance.now() - exitAsked).toBeLessThan(2000);
  });

  it('a project folder stays in this process; a skill linked into Documents starts its helper', async () => {
    const { home } = await fifoHome();
    const server = await startServer(home, true, [path.join(home, 'Projects')]);
    const documents = path.join(home, 'Documents');
    const projects = await server.send({
      steps: [{ mode: 'sync', op: 'readdirNames', args: { path: path.join(home, 'Projects') } }],
    });
    expect(projects.results).toMatchObject([{ ok: true, value: ['p'] }]);
    expect(childPids(server.child.pid)).toEqual([]);
    const skill = { mode: 'sync', op: 'readdirNames', args: { path: path.join(home, '.claude', 'skills', 'x') } };
    const [first] = (await server.send({ steps: [skill] })).results ?? [];
    // A helper that starts cold on a loaded machine can miss the bound. Its refusal names Documents, which only a call
    // routed there gives, and the check on a new helper opens the folder again.
    if (first?.ok !== true) {
      expect(first, JSON.stringify(first)).toMatchObject({ code: 'EFOLDERGATE', folder: documents });
    }
    let listed = first;
    const deadline = Date.now() + 5000;
    while (listed?.ok !== true && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
      [listed] = (await server.send({ steps: [skill] })).results ?? [];
    }
    expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true, value: [] });
    expect(childPids(server.child.pid)).toHaveLength(1);
  });

  it('a root in a guarded folder starts the helper of that folder at once, before any call', async () => {
    const { home } = await fifoHome();
    const server = await startServer(home, true, [path.join(home, 'Documents', 'x')]);
    expect(await eventually(() => childPids(server.child.pid).length === 1)).toBe(true);
    expect(server.changes).toEqual([]);
  });

  it('process.exit and SIGTERM with a hanging helper end in under 2 s and kill the helper', async () => {
    for (const ending of ['exit', 'SIGTERM'] as const) {
      const { home, fifo } = await fifoHome();
      const server = await startServer(home, true);
      void server.send({ steps: [{ mode: 'async', op: 'writeFile', args: { path: fifo('Documents'), data: 'x' } }] })
        .catch(() => undefined);
      expect(await eventually(() => childPids(server.child.pid).length > 0)).toBe(true);
      // The write reaches the helper and waits there; the client's bound is still far.
      await new Promise((done) => setTimeout(done, 300));
      const helpers = childPids(server.child.pid);
      const exited = new Promise<number | null>((done) => { server.child.on('exit', (code) => { done(code); }); });
      const asked = performance.now();
      if (ending === 'exit') void server.send({ exit: true }).catch(() => undefined);
      else server.child.kill('SIGTERM');
      expect(await exited, ending).toBe(0);
      expect(performance.now() - asked, ending).toBeLessThan(2000);
      expect(await eventually(() => helpers.every((pid) => !alive(pid))), ending).toBe(true);
    }
  });

  it('kill switch 0: no gate, no helper; a guarded folder is read by this process', async () => {
    const { home } = await fifoHome();
    const server = await startServer(home, false);
    const listing = await server.send({
      steps: [{ mode: 'sync', op: 'readdirNames', args: { path: path.join(home, 'Documents') } }],
    });
    const [result] = listing.results ?? [];
    expect(result?.ok).toBe(true);
    expect([...(result?.value as string[])].sort()).toEqual(['fifo', 'x']);
    expect(await server.send({ blocked: true })).toMatchObject({ blocked: [], runtime: false });
    expect(childPids(server.child.pid)).toEqual([]);
    expect(server.changes).toEqual([]);
  });
});
