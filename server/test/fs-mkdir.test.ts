/**
 * Creating a directory from the directory browser (`server/src/fs-mkdir.ts`): the gate, the name rule, the single
 * slot, the parent steps shared with the listing, the child process that makes the directory relative to its own
 * working directory, and the log line. Every case runs on a real temporary tree with real symlinks; the child is the
 * real `node` process unless a case swaps the runner to script an exit. The test wraps `node:fs/promises` and passes
 * a recording walk, so it sees every path the module touched in the parent process.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Whether the disk of the temporary directory ignores letter case, like the default APFS of macOS. */
const CASE_BLIND = existsSync(tmpdir().toUpperCase()) && tmpdir().toUpperCase() !== tmpdir();

const touched = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const record = <F extends (...args: never[]) => unknown>(fn: F): F => ((...args: Parameters<F>) => {
    touched.push(String(args[0]));
    return fn(...args);
  }) as F;
  return {
    ...real,
    readdir: record(real.readdir),
    stat: record(real.stat),
    lstat: record(real.lstat),
    realpath: record(real.realpath),
  };
});

const { makeDirectory, mkdirRefusal } = await import('../src/fs-mkdir.ts');
const { CHILD_SOURCE, runMkdirChild } = await import('../src/fs-mkdir-child.ts');
const { browseDirectory, resolveListedDir } = await import('../src/fs-browse.ts');
const { validateProjectCwd } = await import('../src/config.ts');
const { projectSlug } = await import('../src/cli-store.ts');

type Deps = Parameters<typeof makeDirectory>[1];
type Result = Awaited<ReturnType<typeof makeDirectory>>;
type Runner = NonNullable<Deps['runChild']>;
type Exit = Awaited<ReturnType<Runner>>;

let base = '';
let root = '';
let outside = '';
let home = '';
let store = '';
let lines: string[] = [];
let runs: { file: string; args: readonly string[]; options: Parameters<Runner>[2] }[] = [];

const walk = {
  lstat: (file: string) => {
    touched.push(file);
    return lstatSync(file);
  },
  readlink: (file: string) => {
    touched.push(file);
    return readlinkSync(file);
  },
};

/** The real child, with every call recorded. */
const realRunner: Runner = (file, args, options) => {
  runs.push({ file, args, options });
  return runMkdirChild(file, args, options);
};

/** A runner that answers with a scripted exit and starts nothing. */
const scripted = (exit: Exit): Runner => (file, args, options) => {
  runs.push({ file, args, options });
  return Promise.resolve(exit);
};

const deps = (over: Partial<Deps> = {}): Deps => ({
  config: { demo: false, herdrLaunch: true, herdrSend: true, projectRoots: [root] },
  recheckDevice: () => true,
  log: (line) => { lines.push(line); },
  secrets: [],
  home,
  storeRoot: store,
  walk,
  runChild: realRunner,
  ...over,
});

const make = (parent: string, name: string, over: Partial<Deps> = {}): Promise<Result> =>
  makeDirectory({ parent, name }, deps(over));

/** Status, error code and sentence code of a result, for one-line assertions. */
function outcome(result: Result): { status: number; error?: string; code?: string } {
  if (result.ok) return { status: 200 };
  if (result.status === 401) return { status: 401 };
  return { status: result.status, error: result.error, code: result.sentence.ref.code };
}

const isDir = (file: string): boolean => existsSync(file) && lstatSync(file).isDirectory();

/** Folds letters the way the default macOS disk compares names, for spotting a touch in a protected folder. */
const fold = (value: string): string => value.normalize('NFC').toUpperCase().toLowerCase();

/** Paths touched in `<home>/<folder>` or at it, under any spelling the disk reads as that folder. */
const touchedIn = (folder: string): string[] => touched.filter((file) => {
  const rel = relative(home, file);
  return !rel.startsWith('..') && fold(rel.split(sep)[0] ?? '') === fold(folder);
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'rarog-mkdir-')));
  root = join(base, 'root');
  outside = join(base, 'outside');
  home = join(base, 'home');
  store = join(base, 'store');
  for (const dir of [join(root, 'a'), outside, store, join(home, 'Desktop', 'x'), join(home, 'inne')]) {
    await mkdir(dir, { recursive: true });
  }
  touched.length = 0;
  lines = [];
  runs = [];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('the gate', () => {
  it('mkdirRefusal: off in the demo (also with both switches on) and with either switch off', () => {
    expect(mkdirRefusal({ demo: false, herdrLaunch: true, herdrSend: true })).toBeNull();
    expect(mkdirRefusal({ demo: true, herdrLaunch: true, herdrSend: true })).toBe('disabled');
    expect(mkdirRefusal({ demo: false, herdrLaunch: false, herdrSend: true })).toBe('disabled');
    expect(mkdirRefusal({ demo: false, herdrLaunch: true, herdrSend: false })).toBe('disabled');
  });

  it.each([
    ['demo', { demo: true, herdrLaunch: true, herdrSend: true }],
    ['herdrLaunch off', { demo: false, herdrLaunch: false, herdrSend: true }],
    ['herdrSend off', { demo: false, herdrLaunch: true, herdrSend: false }],
  ])('%s: 409 mkdir-disabled before the disk and without a child', async (_label, switches) => {
    const result = await make(join(root, 'a'), 'nowy', { config: { ...switches, projectRoots: [root] } });
    expect(outcome(result)).toEqual({ status: 409, error: 'mkdir-disabled', code: 'rest.mkdir-disabled' });
    expect(touched).toEqual([]);
    expect(runs).toEqual([]);
    expect(isDir(join(root, 'a', 'nowy'))).toBe(false);
  });
});

describe('a directory is created', () => {
  it('in a directory of the root: 200, the directory exists, the path in the form of the configured root', async () => {
    const result = await make(join(root, 'a'), 'nowy');
    expect(result).toEqual({
      ok: true, entry: { name: 'nowy', path: join(root, 'a', 'nowy'), git: false, history: false },
    });
    expect(isDir(join(root, 'a', 'nowy'))).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it('history comes from the CLI store of the new path', async () => {
    await mkdir(join(store, projectSlug(join(root, 'a', 'nowy'))), { recursive: true });
    const result = await make(join(root, 'a'), 'nowy');
    expect(result.ok && result.entry.history).toBe(true);
    expect(result.ok && result.entry.git).toBe(false);
  });

  it('under a root that is a symlink: the returned path lists and passes the session start check', async () => {
    await mkdir(join(base, 'real', 'p'), { recursive: true });
    await symlink(join(base, 'real'), join(base, 'link'));
    const linked = join(base, 'link');
    const result = await make(join(linked, 'p'), 'nowy', {
      config: { demo: false, herdrLaunch: true, herdrSend: true, projectRoots: [linked] },
    });
    expect(result.ok && result.entry.path).toBe(join(linked, 'p', 'nowy'));
    expect(isDir(join(base, 'real', 'p', 'nowy'))).toBe(true);
    const path = result.ok ? result.entry.path : '';
    const listed = await browseDirectory(path, { roots: [linked], storeRoot: store, home });
    expect(listed.ok && listed.listing.path).toBe(path);
    expect(validateProjectCwd(path, [linked], { home })).toEqual({ ok: true, cwd: path });
  });

  it('under the temporary directory as configured (on macOS through /var -> /private/var)', async () => {
    const given = await mkdtemp(join(tmpdir(), 'rarog-mkdir-given-'));
    try {
      await mkdir(join(given, 'p'));
      const result = await make(join(given, 'p'), 'nowy', {
        config: { demo: false, herdrLaunch: true, herdrSend: true, projectRoots: [given] },
      });
      const path = result.ok ? result.entry.path : '';
      expect(path).toBe(join(given, 'p', 'nowy'));
      expect(isDir(path)).toBe(true);
      const listed = await browseDirectory(path, { roots: [given], storeRoot: store, home });
      expect(listed.ok && listed.listing.path).toBe(path);
      expect(validateProjectCwd(path, [given], { home })).toEqual({ ok: true, cwd: path });
    } finally {
      await rm(given, { recursive: true, force: true });
    }
  });
});

describe('something is already there', () => {
  it.each([
    ['a directory', (target: string) => { mkdirSync(target); }],
    ['a file', (target: string) => { writeFileSync(target, 'keep'); }],
    ['a symlink to a directory outside', (target: string) => { symlinkSync(outside, target); }],
    ['a dangling symlink', (target: string) => { symlinkSync(join(outside, 'gone'), target); }],
  ])('%s: 409 dir-exists, nothing overwritten', async (_label, plant) => {
    const target = join(root, 'a', 'nowy');
    plant(target);
    const before = lstatSync(target);
    const linkBefore = before.isSymbolicLink() ? readlinkSync(target) : null;
    const result = await make(join(root, 'a'), 'nowy');
    expect(outcome(result)).toEqual({ status: 409, error: 'dir-exists', code: 'rest.dir-exists' });
    const after = lstatSync(target);
    expect([after.ino, after.mode, after.size]).toEqual([before.ino, before.mode, before.size]);
    if (after.isFile()) expect(readFileSync(target, 'utf8')).toBe('keep');
    if (after.isSymbolicLink()) expect(readlinkSync(target)).toBe(linkBefore);
    expect(existsSync(join(outside, 'gone'))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('two requests at once: one 200, the other 429 or 409', async () => {
    const results = await Promise.all([make(join(root, 'a'), 'nowy'), make(join(root, 'a'), 'nowy')]);
    const statuses = results.map((result) => outcome(result).status).sort();
    expect(statuses[0]).toBe(200);
    expect([409, 429]).toContain(statuses[1]);
    expect(isDir(join(root, 'a', 'nowy'))).toBe(true);
  });
});

describe('the name rule', () => {
  const multibyte256 = 'ą'.repeat(128);
  it.each([
    ['..', 'rest.cwd-hidden'],
    ['.', 'rest.cwd-hidden'],
    ['.ukryty', 'rest.cwd-hidden'],
    ['a/b', 'rest.dir-name-chars'],
    ['a:b', 'rest.dir-name-chars'],
    ['a\u0000b', 'rest.dir-name-chars'],
    ['a\nb', 'rest.dir-name-chars'],
    ['\u{202E}', 'rest.dir-name-chars'],
    ['\u{200B}', 'rest.dir-name-chars'],
    ['\u{2028}', 'rest.dir-name-chars'],
    [' x', 'rest.dir-name-chars'],
    ['x ', 'rest.dir-name-chars'],
    ['x\u{A0}', 'rest.dir-name-chars'],
    ['', 'rest.dir-name-empty'],
    ['ab\uD800cd', 'rest.dir-name-invalid'],
    [multibyte256, 'rest.dir-name-too-long'],
  ])('%j: 400 dir-name-invalid before the disk, no child', async (name, code) => {
    const result = await make(join(root, 'a'), name);
    expect(outcome(result)).toEqual({ status: 400, error: 'dir-name-invalid', code });
    expect(touched).toEqual([]);
    expect(runs).toEqual([]);
    expect(readdirSync(join(root, 'a'))).toEqual([]);
  });

  it('node_modules: 400 dir-name-invalid, the listing never shows it, no child', async () => {
    const result = await make(join(root, 'a'), 'node_modules');
    expect(outcome(result)).toEqual({ status: 400, error: 'dir-name-invalid', code: 'rest.dir-name-invalid' });
    expect(runs).toEqual([]);
    expect(readdirSync(join(root, 'a'))).toEqual([]);
  });

  it('255 bytes of UTF-8: 200 and the directory exists', async () => {
    const name = `${'ą'.repeat(127)}a`;
    expect(Buffer.byteLength(name)).toBe(255);
    const result = await make(join(root, 'a'), name);
    expect(outcome(result)).toEqual({ status: 200 });
    expect(isDir(join(root, 'a', name))).toBe(true);
  });

  it('an NFD name counts after NFC and is created and returned in NFC', async () => {
    const nfd = 'ą'.normalize('NFD').repeat(100);
    const nfc = nfd.normalize('NFC');
    expect([Buffer.byteLength(nfd), Buffer.byteLength(nfc)]).toEqual([300, 200]);
    const result = await make(join(root, 'a'), nfd);
    expect(result.ok && [result.entry.name, result.entry.path]).toEqual([nfc, join(root, 'a', nfc)]);
    expect(readdirSync(join(root, 'a'))).toEqual([nfc]);
    expect(runs[0]?.args.at(-1)).toBe(nfc);
  });

  it('an ill-formed parent: 400 path-not-allowed before the disk, no child', async () => {
    const result = await make(`${root}/a\uDC00`, 'nowy');
    expect(outcome(result)).toEqual({ status: 400, error: 'path-not-allowed', code: 'rest.bad-request' });
    expect(touched).toEqual([]);
    expect(runs).toEqual([]);
  });
});

describe('the root ~ and the macOS-protected folders of home', () => {
  const tilde = (over: Partial<Deps> = {}): Partial<Deps> => ({
    config: { demo: false, herdrLaunch: true, herdrSend: true, projectRoots: ['~'] }, ...over,
  });

  it('parent ~/Desktop/x: 400 without a disk call in Desktop', async () => {
    const result = await make('~/Desktop/x', 'nowy', tilde());
    expect(outcome(result).status).toBe(400);
    expect(touchedIn('Desktop')).toEqual([]);
    expect(runs).toEqual([]);
    expect(isDir(join(home, 'Desktop', 'x', 'nowy'))).toBe(false);
  });

  it('parent ~/Deſktop/x (long s, the same folder on the default macOS disk): 400 without a disk call in Desktop',
    async () => {
      const result = await make('~/De\u{17F}ktop/x', 'nowy', tilde());
      expect(outcome(result).status).toBe(400);
      expect(touchedIn('Desktop')).toEqual([]);
      expect(runs).toEqual([]);
      expect(isDir(join(home, 'Desktop', 'x', 'nowy'))).toBe(false);
    });

  it('parent ~, name Movies (no such folder): 400 path-not-allowed, no child', async () => {
    const result = await make('~', 'Movies', tilde());
    expect(outcome(result)).toEqual({ status: 400, error: 'path-not-allowed', code: 'rest.cwd-protected' });
    expect(runs).toEqual([]);
    expect(readdirSync(home).sort()).toEqual(['Desktop', 'inne']);
  });

  it('parent ~, name Movieſ (long s, no such folder): 400, no child', async () => {
    const result = await make('~', 'Movie\u{17F}', tilde());
    expect(outcome(result).status).toBe(400);
    expect(runs).toEqual([]);
    expect(readdirSync(home).sort()).toEqual(['Desktop', 'inne']);
  });

  it('parent ~, an ordinary name: 200 in home', async () => {
    const result = await make('~', 'nowy', tilde());
    expect(result.ok && result.entry.path).toBe(join(home, 'nowy'));
    expect(isDir(join(home, 'nowy'))).toBe(true);
  });
});

describe('the parent steps', () => {
  it('a parent that is a symlink out of the roots: 400 path-not-allowed, nothing outside, no child', async () => {
    await symlink(outside, join(root, 'link'));
    const result = await make(join(root, 'link'), 'nowy');
    expect(outcome(result)).toEqual({ status: 400, error: 'path-not-allowed', code: 'rest.cwd-symlink-escape' });
    expect(readdirSync(outside)).toEqual([]);
    expect(runs).toEqual([]);
  });

  it('a parent that does not exist: 404 not-found, no child', async () => {
    const result = await make(join(root, 'nie-ma'), 'nowy');
    expect(outcome(result)).toEqual({ status: 404, error: 'not-found', code: 'rest.cwd-not-found' });
    expect(runs).toEqual([]);
    expect(existsSync(join(root, 'nie-ma'))).toBe(false);
  });

  it('a parent that is a regular file reaches the child, whose ENOTDIR is 404 not-found', async () => {
    await writeFile(join(root, 'plik'), 'x');
    const result = await make(join(root, 'plik'), 'nowy');
    expect(outcome(result)).toEqual({ status: 404, error: 'not-found', code: 'rest.cwd-not-found' });
    expect(runs).toHaveLength(1);
    expect(readFileSync(join(root, 'plik'), 'utf8')).toBe('x');
  });
});

describe('the real child against a parent swapped after the checks', () => {
  it('the parent turned into a symlink out of the tree: 400, nothing created outside; argv carries realDir as is',
    async () => {
      const parent = join(root, 'a');
      const checked = await resolveListedDir(parent, { roots: [root], home });
      if (!checked.ok) throw new Error('the parent must pass the checks');
      let argv: readonly string[] = [];
      const swapping: Runner = (file, args, options) => {
        argv = args;
        renameSync(parent, join(root, 'a-old'));
        symlinkSync(outside, parent);
        return realRunner(file, args, options);
      };
      const result = await make(parent, 'nowy', { runChild: swapping });
      expect(outcome(result)).toEqual({ status: 400, error: 'path-not-allowed', code: 'rest.mkdir-moved' });
      expect(readdirSync(outside)).toEqual([]);
      expect(readdirSync(join(root, 'a-old'))).toEqual([]);
      expect(argv).toEqual(['--input-type=module', '-e', CHILD_SOURCE, '--', checked.realDir, 'nowy']);
      expect(argv[4] === checked.realDir).toBe(true);
      expect(runs[0]?.file).toBe(process.execPath);
    });

  it('the name planted as a symlink out of the tree before the child: 409, nothing created outside', async () => {
    const planting: Runner = (file, args, options) => {
      symlinkSync(join(outside, 'x'), join(root, 'a', 'nowy'));
      return realRunner(file, args, options);
    };
    const result = await make(join(root, 'a'), 'nowy', { runChild: planting });
    expect(outcome(result)).toEqual({ status: 409, error: 'dir-exists', code: 'rest.dir-exists' });
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(root, 'a', 'nowy')).isSymbolicLink()).toBe(true);
  });

  it.each(['-p', '--help', '--inspect-brk=0', '--', '-e'])('name %j is an ordinary directory', async (name) => {
    const result = await make(join(root, 'a'), name);
    expect(result.ok && result.entry.path).toBe(join(root, 'a', name));
    expect(readdirSync(join(root, 'a'))).toEqual([name]);
  });

  it.skipIf(!CASE_BLIND)('parent in another case: 200, path as asked, argv as on disk (requires a case-blind volume)',
    async () => {
      await mkdir(join(root, 'Proj'));
      const result = await make(join(root, 'proj'), 'nowy');
      expect(result.ok && result.entry.path).toBe(join(root, 'proj', 'nowy'));
      expect(readdirSync(join(root, 'Proj'))).toEqual(['nowy']);
      expect(runs[0]?.args[4]).toBe(join(root, 'Proj'));
    });

  it('NODE_OPTIONS and a poisoned PATH of the server never reach the child', async () => {
    const preload = join(base, 'preload.cjs');
    const preloaded = join(base, 'preloaded');
    const fakeBin = join(base, 'bin');
    const fakeRan = join(base, 'fake-node-ran');
    writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(preloaded)}, 'x');\n`);
    await mkdir(fakeBin);
    writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\ntouch ${JSON.stringify(fakeRan)}\n`, { mode: 0o755 });
    // Control: with the inherited environment the preload runs, so its absence below means something.
    spawnSync(process.execPath, ['-e', ''], { env: { ...process.env, NODE_OPTIONS: `--require=${preload}` } });
    expect(existsSync(preloaded)).toBe(true);
    rmSync(preloaded);

    const saved = { NODE_OPTIONS: process.env['NODE_OPTIONS'], PATH: process.env['PATH'] };
    process.env['NODE_OPTIONS'] = `--require=${preload}`;
    process.env['PATH'] = `${fakeBin}:${saved.PATH ?? ''}`;
    try {
      const result = await make(join(root, 'a'), 'nowy');
      expect(outcome(result)).toEqual({ status: 200 });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(existsSync(preloaded)).toBe(false);
    expect(existsSync(fakeRan)).toBe(false);
    expect(runs[0]?.options).toEqual({
      cwd: '/', env: {}, stdio: ['ignore', 'pipe', 'ignore'], timeout: expect.any(Number) as number,
      killSignal: 'SIGKILL',
    });
  });
});

describe('every child answer has its response', () => {
  it.each<[string, Exit, { status: number; error?: string; code?: string }]>([
    ['OK', { code: 0, signal: null, stdout: 'OK\n' }, { status: 200 }],
    ['MOVED', { code: 0, signal: null, stdout: 'MOVED\n' },
      { status: 400, error: 'path-not-allowed', code: 'rest.mkdir-moved' }],
    ['EEXIST', { code: 0, signal: null, stdout: 'EEXIST\n' }, { status: 409, error: 'dir-exists', code: 'rest.dir-exists' }],
    ['ENOENT', { code: 0, signal: null, stdout: 'ENOENT\n' },
      { status: 404, error: 'not-found', code: 'rest.cwd-not-found' }],
    ['ENOTDIR', { code: 0, signal: null, stdout: 'ENOTDIR\n' },
      { status: 404, error: 'not-found', code: 'rest.cwd-not-found' }],
    ['EACCES', { code: 0, signal: null, stdout: 'EACCES\n' }, { status: 500, error: 'internal', code: 'rest.mkdir-failed' }],
    ['OTHER', { code: 0, signal: null, stdout: 'OTHER\n' }, { status: 500, error: 'internal', code: 'rest.mkdir-failed' }],
    ['empty output', { code: 0, signal: null, stdout: '' }, { status: 500, error: 'internal', code: 'rest.mkdir-failed' }],
    ['unknown output', { code: 0, signal: null, stdout: 'WHAT\n' },
      { status: 500, error: 'internal', code: 'rest.mkdir-failed' }],
    ['OK with a non-zero exit', { code: 1, signal: null, stdout: 'OK\n' },
      { status: 500, error: 'internal', code: 'rest.mkdir-failed' }],
    ['killed by the time limit', { code: null, signal: 'SIGKILL', stdout: '' },
      { status: 500, error: 'internal', code: 'rest.mkdir-failed' }],
  ])('%s', async (_label, exit, expected) => {
    const result = await make(join(root, 'a'), 'nowy', { runChild: scripted(exit) });
    expect(outcome(result)).toEqual(expected);
    expect(runs).toHaveLength(1);
  });

  it('a runner that rejects or throws: 500, and the slot is free again', async () => {
    const rejecting: Runner = () => Promise.reject(new Error('spawn EAGAIN'));
    const throwing: Runner = () => { throw new Error('spawn EAGAIN'); };
    for (const runChild of [rejecting, throwing]) {
      const result = await make(join(root, 'a'), 'nowy', { runChild });
      expect(outcome(result)).toEqual({ status: 500, error: 'internal', code: 'rest.mkdir-failed' });
    }
    expect(outcome(await make(join(root, 'a'), 'nowy'))).toEqual({ status: 200 });
  });

  it('the default runner kills a child that outlives the time limit', async () => {
    const exit = await runMkdirChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: '/', env: {}, stdio: ['ignore', 'pipe', 'ignore'], timeout: 300, killSignal: 'SIGKILL',
    });
    expect(exit).toEqual({ code: null, signal: 'SIGKILL', stdout: '' });
  });

  it('the default runner reports a child that cannot start', async () => {
    const exit = await runMkdirChild(join(base, 'no-such-node'), [], {
      cwd: '/', env: {}, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, killSignal: 'SIGKILL',
    });
    expect(exit).toEqual({ code: null, signal: null, stdout: '' });
  });
});

describe('the single slot and the device recheck', () => {
  it('a second request while the first child runs: 429 mkdir-busy without the disk; free again afterwards',
    async () => {
      let release: () => void = () => undefined;
      let entered: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const inRunner = new Promise<void>((resolve) => { entered = resolve; });
      const slow: Runner = async (file, args, options) => {
        entered();
        await gate;
        return realRunner(file, args, options);
      };
      const first = make(join(root, 'a'), 'nowy', { runChild: slow });
      await inRunner;
      touched.length = 0;
      const second = await make(join(root, 'a'), 'inny');
      expect(outcome(second)).toEqual({ status: 429, error: 'mkdir-busy', code: 'rest.mkdir-busy' });
      expect(touched).toEqual([]);
      release();
      expect(outcome(await first)).toEqual({ status: 200 });
      expect(outcome(await make(join(root, 'a'), 'inny'))).toEqual({ status: 200 });
    });

  it('a revoked device: no child, nothing created, and the slot is free again', async () => {
    const result = await make(join(root, 'a'), 'nowy', { recheckDevice: () => false });
    expect(outcome(result)).toEqual({ status: 401 });
    expect(runs).toEqual([]);
    expect(readdirSync(join(root, 'a'))).toEqual([]);
    expect(outcome(await make(join(root, 'a'), 'nowy'))).toEqual({ status: 200 });
  });

  it('the recheck runs after the parent steps and the spawn follows it in the same tick', async () => {
    const order: string[] = [];
    const result = await make(join(root, 'a'), 'nowy', {
      recheckDevice: () => {
        order.push(`recheck after ${String(touched.length)} disk calls`);
        queueMicrotask(() => { order.push('microtask'); });
        return true;
      },
      runChild: (file, args, options) => {
        order.push('spawn');
        return realRunner(file, args, options);
      },
    });
    expect(outcome(result)).toEqual({ status: 200 });
    expect(order[0]).toMatch(/^recheck after [1-9]\d* disk calls$/);
    expect(order.slice(1)).toEqual(['spawn', 'microtask']);
  });
});

describe('the log line', () => {
  it('a parent with LF, CR, ESC, U+202E and U+2028 in its name gives one physical line', async () => {
    const odd = 'a\nb\rc\u001Bd\u{202E}e\u{2028}f';
    await mkdir(join(root, odd));
    const result = await make(join(root, odd), 'nowy');
    expect(outcome(result)).toEqual({ status: 200 });
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line).not.toMatch(/[\n\r\u001B\u0085\u{2028}\u{2029}]/u);
    const quoted = /(".*")/.exec(line)?.[1] ?? '""';
    expect(JSON.parse(quoted)).toBe(join(root, odd, 'nowy'));
  });

  it('a refusal logs its code, never the raw parent or name', async () => {
    await make(join(root, 'tajny-rodzic'), 'tajna:nazwa');
    await make(join(root, 'tajny-rodzic'), 'tajna-nazwa');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain('tajn');
      expect(line).not.toMatch(/[\n\r]/);
    }
    expect(lines[0]).toContain('dir-name-invalid');
    expect(lines[1]).toContain('not-found');
  });

  it('a failed child logs neither its output nor its argv', async () => {
    await make(join(root, 'a'), 'nowy', { runChild: scripted({ code: 3, signal: null, stdout: 'leak me\n' }) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('leak me');
    expect(lines[0]).not.toContain('--input-type');
    expect(lines[0]).toContain('exit 3');
  });
});
