/**
 * The vitest run directory (`server/test/helpers/run-tmpdir.ts`): `vitest.config.ts` points `TMPDIR` of the run at
 * a directory of its own, the global teardown removes it, and the next start removes directories of runs whose
 * process is gone.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RUN_TMPDIR_MARKER, RUN_TMPDIR_NAME, randomRunTmpdirName, removeRunTmpdir, startRunTmpdir, sweepDeadRunTmpdirs,
} from './helpers/run-tmpdir.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

const made: string[] = [];
function base(): string {
  const directory = mkdtempSync(join(tmpdir(), 'run-tmpdir-'));
  made.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A run directory `name` owned by `pid`, with a file inside, as a killed run leaves it. */
function leftover(root: string, name: string, pid: number): string {
  const directory = join(root, name);
  mkdirSync(join(directory, 'nested'), { recursive: true });
  writeFileSync(join(directory, RUN_TMPDIR_MARKER), String(pid));
  writeFileSync(join(directory, 'nested', 'file.txt'), 'x');
  return directory;
}

/** Names handed out in order, for a predictable `randomName`. */
function names(...list: string[]): () => string {
  return () => {
    const next = list.shift();
    if (next === undefined) throw new Error('no more names');
    return next;
  };
}

describe('run tmpdir', () => {
  it('the name is short (`vt` and two base36 characters): a socket path in it has to fit in 104 bytes', () => {
    for (let i = 0; i < 200; i++) expect(randomRunTmpdirName()).toMatch(/^vt[0-9a-z]{2}$/);
    expect(RUN_TMPDIR_NAME.test('vtk3')).toBe(true);
  });

  it('start creates the run directory inside the base and points TMPDIR of the given env at it', () => {
    const root = base();
    const env: NodeJS.ProcessEnv = { TMPDIR: '/elsewhere' };
    const directory = startRunTmpdir(env, { base: root, pid: 4242, isAlive: () => false, randomName: names('vtk3') });
    expect(directory).toBe(join(root, 'vtk3'));
    expect(env.TMPDIR).toBe(directory);
    // The marker holds the owner pid and the TMPDIR to put back.
    expect(readFileSync(join(directory, RUN_TMPDIR_MARKER), 'utf8')).toBe('4242\n/elsewhere');
    // The process env of this test stays as it was.
    expect(process.env.TMPDIR).not.toBe(directory);
  });

  it('a name that exists already is drawn again, and the existing directory stays untouched', () => {
    const root = base();
    const live = leftover(root, 'vtaa', 1002);
    mkdirSync(join(root, 'vtbb'));
    const env: NodeJS.ProcessEnv = {};
    const directory = startRunTmpdir(env, {
      base: root, pid: 4242, isAlive: (pid) => pid === 1002, randomName: names('vtaa', 'vtbb', 'vtcc'),
    });
    expect(directory).toBe(join(root, 'vtcc'));
    expect(readFileSync(join(live, RUN_TMPDIR_MARKER), 'utf8')).toBe('1002');
    expect(existsSync(join(live, 'nested', 'file.txt'))).toBe(true);
    expect(readdirSync(join(root, 'vtbb'))).toEqual([]);
  });

  it('start keeps the run directory of the same process when the config is loaded twice', () => {
    const root = base();
    const env: NodeJS.ProcessEnv = {};
    const first = startRunTmpdir(env, { base: root, pid: 4242, isAlive: () => false, randomName: names('vtk3') });
    writeFileSync(join(first, 'kept'), '');
    const second = startRunTmpdir(env, { pid: 4242, isAlive: () => true, randomName: names('vtzz') });
    expect(second).toBe(first);
    expect(env.TMPDIR).toBe(first);
    expect(existsSync(join(first, 'kept'))).toBe(true);
  });

  it('teardown removes the run directory with its contents', () => {
    const root = base();
    const env: NodeJS.ProcessEnv = {};
    const directory = startRunTmpdir(env, { base: root, pid: 4242, isAlive: () => false });
    mkdirSync(join(directory, 'a', 'b'), { recursive: true });
    writeFileSync(join(directory, 'a', 'b', 'c.sock'), '');
    removeRunTmpdir(env, 4242);
    expect(existsSync(directory)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('teardown leaves TMPDIR alone when it is not the run directory of this process', () => {
    const root = base();
    const other = leftover(root, 'vtaa', 777);
    const unmarked = join(root, 'vtbb');
    mkdirSync(unmarked);
    const foreign = join(root, 'foreign');
    mkdirSync(foreign);
    for (const directory of [other, unmarked, foreign]) removeRunTmpdir({ TMPDIR: directory }, 4242);
    removeRunTmpdir({}, 4242);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(unmarked)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });

  it('the sweep removes a directory of a dead pid and keeps a live pid, no marker and entries with other names', () => {
    const root = base();
    const dead = leftover(root, 'vt01', 1001);
    const live = leftover(root, 'vt02', 1002);
    const unmarked = join(root, 'vt03');
    mkdirSync(unmarked);
    const garbled = leftover(root, 'vt04', 1004);
    writeFileSync(join(garbled, RUN_TMPDIR_MARKER), 'not a pid');
    const others = ['rarog-usage-abc123', 'vt1', 'vtABC', 'vt12x', 'xvt01'];
    for (const name of others) leftover(root, name, 1001);
    writeFileSync(join(root, 'vt05'), 'a file, not a directory');
    sweepDeadRunTmpdirs(root, (pid) => pid === 1002);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(join(live, 'nested', 'file.txt'))).toBe(true);
    expect(readdirSync(root).sort()).toEqual(['vt02', 'vt03', 'vt04', 'vt05', ...others].sort());
  });

  it('start sweeps dead runs before it creates its own directory', () => {
    const root = base();
    const dead = leftover(root, 'vt01', 1001);
    const directory = startRunTmpdir({}, { base: root, pid: 4242, isAlive: () => false, randomName: names('vt01') });
    expect(existsSync(join(dead, 'nested'))).toBe(false);
    expect(directory).toBe(dead);
    expect(dirname(directory)).toBe(root);
  });

  it('teardown puts TMPDIR back, so a second start in the same process works (a config reload in watch mode)', () => {
    const root = base();
    const env: NodeJS.ProcessEnv = { TMPDIR: root };
    const first = startRunTmpdir(env, { pid: 4242, isAlive: () => false, randomName: names('vtk3') });
    expect(first).toBe(join(root, 'vtk3'));
    removeRunTmpdir(env, 4242);
    expect(env.TMPDIR).toBe(root);
    const second = startRunTmpdir(env, { pid: 4242, isAlive: () => false, randomName: names('vtk4') });
    expect(second).toBe(join(root, 'vtk4'));
    removeRunTmpdir(env, 4242);
    expect(env.TMPDIR).toBe(root);
    expect(readdirSync(root)).toEqual([]);

    const unset: NodeJS.ProcessEnv = {};
    startRunTmpdir(unset, { base: root, pid: 4242, isAlive: () => false, randomName: names('vtk5') });
    removeRunTmpdir(unset, 4242);
    expect('TMPDIR' in unset).toBe(false);
  });

  it('the sweep leaves a symlink, a marker that is not a regular file and a directory of another user', () => {
    const root = base();
    const target = leftover(base(), 'vt01', 1001);
    symlinkSync(target, join(root, 'vt01'));
    const linked = join(root, 'vt02');
    mkdirSync(linked);
    writeFileSync(join(root, 'pid'), '1001');
    symlinkSync(join(root, 'pid'), join(linked, RUN_TMPDIR_MARKER));
    sweepDeadRunTmpdirs(root, () => false);
    expect(existsSync(join(target, 'nested', 'file.txt'))).toBe(true);
    expect(readdirSync(root).sort()).toEqual(['pid', 'vt01', 'vt02']);

    const foreign = leftover(root, 'vt03', 1001);
    sweepDeadRunTmpdirs(root, () => false, (process.getuid?.() ?? 0) + 1);
    expect(existsSync(join(foreign, 'nested', 'file.txt'))).toBe(true);
  });

  it('a directory that a live run took between the check and the removal stays (two starts at once)', () => {
    const root = base();
    const directory = leftover(root, 'vt01', 1001);
    let swapped = false;
    sweepDeadRunTmpdirs(root, (pid) => {
      if (pid === 1001 && !swapped) {
        // Another start removes the dead directory and draws the same name, right after this sweep read the marker.
        swapped = true;
        rmSync(directory, { recursive: true });
        leftover(root, 'vt01', 2002);
        return false;
      }
      return pid === 2002;
    });
    expect(readFileSync(join(directory, RUN_TMPDIR_MARKER), 'utf8')).toBe('2002');
    expect(existsSync(join(directory, 'nested', 'file.txt'))).toBe(true);
    expect(readdirSync(root)).toEqual(['vt01']);
  });

  it('the sweep removes a directory that a killed sweep left half removed, unless its owner is alive', () => {
    const root = base();
    leftover(root, '.vt-999-abc-0', 1001);
    leftover(root, '.vt-999-abc-1', 1002);
    sweepDeadRunTmpdirs(root, (pid) => pid === 1002);
    expect(readdirSync(root)).toEqual(['.vt-999-abc-1']);
  });

  it('a process that loads the config and closes vitest without running tests leaves no run directory', () => {
    const root = base();
    const script = "import { createVitest } from 'vitest/node';"
      + "const vitest = await createVitest('test', { watch: false, root: process.cwd() }, {}, {});"
      + 'console.log(process.env.TMPDIR); await vitest.close();';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO, env: { ...process.env, TMPDIR: root }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    // The config ran: while vitest was open, TMPDIR was a run directory inside the base.
    expect(dirname(result.stdout.trim())).toBe(root);
    expect(basename(result.stdout.trim())).toMatch(RUN_TMPDIR_NAME);
    expect(readdirSync(root).filter((name) => name.includes('vt'))).toEqual([]);
  }, 60_000);

  it('this run works in its own run directory', () => {
    expect(basename(tmpdir())).toMatch(RUN_TMPDIR_NAME);
    expect(readFileSync(join(tmpdir(), RUN_TMPDIR_MARKER), 'utf8')).toMatch(/^\d+(\n|$)/);
  });
});
