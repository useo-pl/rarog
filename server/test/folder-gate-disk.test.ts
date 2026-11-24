/**
 * The work-area disk port (`server/src/folder-gate/disk.ts`) on a temporary directory: every operation, sync and
 * async, gives what `node:fs` (and `safe-read.ts`) gives for the same call, fails with the same error code, and its
 * value survives the helper line codec unchanged. `FolderGateError` carries its code and one sentence per closed state.
 */
import type { BigIntStats, Dirent } from 'node:fs';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isServerSentence } from '@rarog/shared/sentences';
import type { AreaDisk, WalkDisk } from '../src/config/work-area.ts';
import { DIRECT_DISK, runDisk, runDiskSync } from '../src/folder-gate/disk.ts';
import {
  CLOSED_STATES, type DiskArgs, type DiskDirent, type DiskStats, type DiskValue, FolderGateError, type SyncDiskOp,
} from '../src/folder-gate/types.ts';
import { fromWire, toWire } from '../src/folder-gate/wire.ts';
import { readRegularFileSync } from '../src/safe-read.ts';

const viaWire = <T>(value: T): T => {
  const tree = toWire(value);
  return (tree === undefined ? undefined : fromWire(JSON.parse(JSON.stringify(tree)))) as T;
};

let dir = '';
let file = '';
let link = '';
let sub = '';

beforeAll(async () => {
  dir = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'fgd-')));
  file = path.join(dir, 'a.txt');
  link = path.join(dir, 'link');
  sub = path.join(dir, 'Sub');
  writeFileSync(file, 'hello world');
  symlinkSync(file, link);
  mkdirSync(sub);
  writeFileSync(path.join(sub, 'b.bin'), Buffer.from([1, 2, 3]));
});

/** The sync and the async form of one operation, each also through the wire. */
async function bothForms<K extends SyncDiskOp>(op: K, args: DiskArgs[K]): Promise<DiskValue[K][]> {
  const sync = runDiskSync(op, args);
  const async = await runDisk(op, args);
  return [sync, async, viaWire(sync), viaWire(async)];
}

function sameStats(got: DiskStats, want: BigIntStats): void {
  expect([got.dev, got.ino, got.mode, got.nlink, got.size, got.mtimeNs, got.birthtimeNs])
    .toEqual([want.dev, want.ino, want.mode, want.nlink, want.size, want.mtimeNs, want.birthtimeNs]);
  expect([got.isFile(), got.isDirectory(), got.isSymbolicLink(), got.isFIFO(), got.isSocket()])
    .toEqual([want.isFile(), want.isDirectory(), want.isSymbolicLink(), want.isFIFO(), want.isSocket()]);
  expect(got.mtime.getTime()).toBe(want.mtime.getTime());
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
}

async function asyncCodeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
}

const kinds = (entries: readonly DiskDirent[]): [string, boolean, boolean, boolean][] => entries
  .map((entry): [string, boolean, boolean, boolean] =>
    [entry.name.toString(), entry.isFile(), entry.isDirectory(), entry.isSymbolicLink()])
  .sort((a, b) => (a[0] < b[0] ? -1 : 1));

describe('folder gate disk port: same results as node:fs', () => {
  it('lstat and stat: the bigint stats of node:fs, for a file, a directory and a symlink', async () => {
    for (const target of [file, sub, link]) {
      for (const got of await bothForms('lstat', { path: target })) sameStats(got, lstatSync(target, { bigint: true }));
      for (const got of await bothForms('stat', { path: target })) sameStats(got, statSync(target, { bigint: true }));
    }
  });

  it('readlink, realpath and realpathNative: the strings of node:fs; native gives the disk letter case', async () => {
    expect(await bothForms('readlink', { path: link })).toEqual(Array(4).fill(readlinkSync(link)));
    const lowered = path.join(dir, 'sub');
    // A disk that folds letter case (the macOS default) reaches `Sub` through `sub` too; there both forms differ.
    const typed = existsSync(lowered) ? lowered : sub;
    for (const target of [sub, typed]) {
      expect(await bothForms('realpath', { path: target })).toEqual(Array(4).fill(realpathSync(target)));
      expect(await bothForms('realpathNative', { path: target })).toEqual(Array(4).fill(realpathSync.native(target)));
    }
  });

  it('readdir: names and types of node:fs, as strings or as bytes', async () => {
    const want = readdirSync(dir, { withFileTypes: true })
      .map((entry): [string, boolean, boolean, boolean] =>
        [entry.name, entry.isFile(), entry.isDirectory(), entry.isSymbolicLink()])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const got of await bothForms('readdir', { path: dir, encoding: 'utf8' })) {
      expect(kinds(got)).toEqual(want);
      expect(got.every((entry) => typeof entry.name === 'string' && entry.parentPath === dir)).toBe(true);
    }
    for (const got of await bothForms('readdir', { path: dir, encoding: 'buffer' })) {
      expect(kinds(got)).toEqual(want);
      expect(got.every((entry) => Buffer.isBuffer(entry.name))).toBe(true);
    }
  });

  it('readHead: the head of safe-read.ts, with the cut and the symlink rule', async () => {
    const want = readRegularFileSync(file, { maxBytes: 5, followSymlink: false });
    for (const got of await bothForms('readHead', { path: file, maxBytes: 5, followSymlink: false })) {
      expect(got?.bytes.equals(want?.bytes ?? Buffer.alloc(1))).toBe(true);
      expect(got?.truncated).toBe(true);
    }
    expect(codeOf(() => runDiskSync('readHead', { path: link, maxBytes: 5, followSymlink: false }))).toBe('ELOOP');
    expect(runDiskSync('readHead', { path: link, maxBytes: 64, followSymlink: true })?.bytes.toString())
      .toBe('hello world');
    expect(runDiskSync('readHead', { path: sub, maxBytes: 64, followSymlink: false })).toBeNull();
  });

  it('readdirByIdentity: the entries of the directory with that dev and ino', async () => {
    const { dev, ino } = statSync(sub, { bigint: true });
    const got = await runDisk('readdirByIdentity', { path: sub, dev, ino });
    expect(got === null ? null : kinds(viaWire(got))).toEqual([['b.bin', true, false, false]]);
  });

  it('openRead, read and close: the bytes and the descriptor stats of the file; a closed handle is gone', async () => {
    const opened = viaWire(await runDisk('openRead', { path: file, followSymlink: false }));
    expect(opened).not.toBeNull();
    if (opened === null) return;
    expect(opened.stats.ino).toBe(statSync(file, { bigint: true }).ino);
    expect(typeof opened.handle).toBe('number');
    const head = viaWire(await runDisk('read', { handle: opened.handle, length: 5, position: 0 }));
    const tail = await runDisk('read', { handle: opened.handle, length: 64, position: 6 });
    expect([head.toString(), tail.toString()]).toEqual(['hello', 'world']);
    expect(await runDisk('close', { handle: opened.handle })).toBeUndefined();
    expect(await asyncCodeOf(() => runDisk('read', { handle: opened.handle, length: 1, position: 0 }))).toBe('EBADF');
    expect(await runDisk('openRead', { path: sub, followSymlink: false })).toBeNull();
    expect(await asyncCodeOf(() => runDisk('openRead', { path: link, followSymlink: false }))).toBe('ELOOP');
  });

  it('readdirNames: the names alone, so an entry whose type cannot be read does not fail the listing', async () => {
    // `/dev/fd` on macOS lists names, but `withFileTypes` fails with EBADF on the lstat of an entry.
    const std = expect.arrayContaining(['0', '1', '2']);
    expect(await bothForms('readdirNames', { path: '/dev/fd' })).toEqual([std, std, std, std]);
    expect(await bothForms('readdirNames', { path: sub })).toEqual([['b.bin'], ['b.bin'], ['b.bin'], ['b.bin']]);
  });

  it('appendRegular: appends to a regular file or creates it; a directory gives EISDIR, a link ELOOP', async () => {
    const target = path.join(dir, 'append.txt');
    expect(await runDisk('appendRegular', { path: target, text: 'one\n' })).toBe(true);
    expect(await runDisk('appendRegular', { path: target, text: 'two\n' })).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('one\ntwo\n');
    expect(await asyncCodeOf(() => runDisk('appendRegular', { path: sub, text: 'x' }))).toBe('EISDIR');
    expect(await asyncCodeOf(() => runDisk('appendRegular', { path: link, text: 'x' }))).toBe('ELOOP');
  });

  it('mkdir, writeFile, chmod and unlink: the effects and the return values of node:fs', async () => {
    const deep = path.join(dir, 'm1', 'm2');
    expect(runDiskSync('mkdir', { path: deep, recursive: true, mode: 0o700 })).toBe(path.join(dir, 'm1'));
    expect(await runDisk('mkdir', { path: path.join(dir, 'm3'), recursive: false })).toBeUndefined();
    expect(codeOf(() => runDiskSync('mkdir', { path: deep }))).toBe('EEXIST');
    const target = path.join(deep, 'f.bin');
    expect(await runDisk('writeFile', { path: target, data: Buffer.from('abc'), mode: 0o600, flag: 'wx' }))
      .toBeUndefined();
    expect(readFileSync(target, 'utf8')).toBe('abc');
    expect(codeOf(() => runDiskSync('writeFile', { path: target, data: Buffer.from('x'), flag: 'wx' }))).toBe('EEXIST');
    runDiskSync('chmod', { path: target, mode: 0o640 });
    expect(statSync(target).mode & 0o777).toBe(0o640);
    await runDisk('chmod', { path: target, mode: 0o600 });
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(runDiskSync('unlink', { path: target })).toBeUndefined();
    expect(await asyncCodeOf(() => runDisk('unlink', { path: target }))).toBe('ENOENT');
    chmodSync(deep, 0o700);
  });

  it('check: a readable directory answers; a missing one and a file fail like opendir', async () => {
    expect(await bothForms('check', { path: dir })).toEqual([undefined, undefined, undefined, undefined]);
    expect(codeOf(() => runDiskSync('check', { path: path.join(dir, 'missing') }))).toBe('ENOENT');
    expect(await asyncCodeOf(() => runDisk('check', { path: file }))).toBe('ENOTDIR');
  });

  it('errors keep the code, syscall and path of node:fs, also through the wire', async () => {
    const missing = path.join(dir, 'missing');
    const want = (() => {
      try {
        lstatSync(missing);
      } catch (error) {
        return error as NodeJS.ErrnoException;
      }
      throw new Error('lstat did not throw');
    })();
    const runs = [() => runDisk('lstat', { path: missing }), async () => runDiskSync('lstat', { path: missing })];
    for (const run of runs) {
      const got = await run().then(() => null, (error: unknown) => viaWire(error as NodeJS.ErrnoException));
      expect({ code: got?.code, syscall: got?.syscall, path: got?.path })
        .toEqual({ code: want.code, syscall: want.syscall, path: want.path });
    }
  });

  it('DIRECT_DISK runs the same operations', async () => {
    expect(DIRECT_DISK.sync('readlink', { path: link })).toBe(readlinkSync(link));
    expect(await DIRECT_DISK.call('realpathNative', { path: sub })).toBe(sub);
  });

  it('the work-area walk and area disks are views of the port', () => {
    const walk: WalkDisk = {
      lstat: (p) => DIRECT_DISK.sync('lstat', { path: p }), readlink: (p) => DIRECT_DISK.sync('readlink', { path: p }),
    };
    const area: AreaDisk = { ...walk, realpath: (p) => DIRECT_DISK.sync('realpath', { path: p }) };
    expect(area.lstat(link).isSymbolicLink()).toBe(true);
    expect(area.realpath(link)).toBe(realpathSync(link));
    const stats: BigIntStats = DIRECT_DISK.sync('stat', { path: file });
    const listed = DIRECT_DISK.sync('readdir', { path: sub, encoding: 'buffer' }) as readonly DiskDirent<Buffer>[];
    const names: readonly Dirent<Buffer>[] = listed;
    expect([stats.isFile(), names[0]?.name.toString()]).toEqual([true, 'b.bin']);
  });
});

describe('FolderGateError', () => {
  it('has the code EFOLDERGATE and a server sentence for every closed state', () => {
    const codes = CLOSED_STATES.map((state) => {
      const error = new FolderGateError('/h/Desktop', state);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('EFOLDERGATE');
      expect([error.folder, error.state]).toEqual(['/h/Desktop', state]);
      expect(isServerSentence(error.sentence)).toBe(true);
      return [state, error.sentence.ref.code];
    });
    expect(Object.fromEntries(codes)).toEqual({
      waiting: 'rest.cwd-folder-waiting',
      denied: 'rest.cwd-folder-denied',
      absent: 'rest.cwd-not-found',
      unchecked: 'rest.cwd-folder-unchecked',
    });
  });
});
