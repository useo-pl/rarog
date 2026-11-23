/**
 * The temporary directory of one vitest run. `vitest.config.ts` calls {@link startRunTmpdir} in the main vitest
 * process before the pools start, so every worker (forks and threads) and every subprocess of a test inherits
 * `TMPDIR` pointing at the run directory: `os.tmpdir()`, `mkdtemp` and `mktemp` in tests land there without any
 * change in the test files. The directory goes after the run, also when tests failed, so a test that does not
 * clean up after itself leaves nothing in the system temporary directory. Two paths remove it: the global teardown
 * (`server/test/helpers/run-tmpdir-teardown.ts`) and, for a process that loads the config and never runs tests
 * (`scripts/gdzie-testy.mjs`, a filter without a match), the exit hook of {@link removeRunTmpdirAtExit}. Both put
 * `TMPDIR` back, so the config can load again in the same process (a config reload in watch mode).
 *
 * A run killed before either path (SIGKILL, a time limit) leaves its directory. The next start removes run
 * directories whose owner process is gone: the marker file inside holds the owner's pid and tells our directories
 * apart from a stranger's entry with a similar name. Directories of live runs (another session running vitest at
 * the same time), entries of another user, symlinks and directories without a readable marker stay.
 *
 * The name is as short as possible (`vt` and two random base36 characters, the pid lives only in the marker):
 * a Unix socket path on macOS has at most 104 bytes, the user `TMPDIR` already takes about 49 of them, and tests
 * create sockets in temporary directories. Proof: `server/test/run-tmpdir.test.ts`.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/** Marker file inside every run directory: the pid of the owner run, then a line with the `TMPDIR` to put back. */
export const RUN_TMPDIR_MARKER = '.vitest-run';

/** Names of run directories: `vt` and two base36 characters. */
export const RUN_TMPDIR_NAME = /^vt[0-9a-z]{2}$/;

/** Names a sweep gives a directory it is about to remove; a killed sweep leaves one behind. */
const CLAIMED_NAME = /^\.vt-\d+-[0-9a-z]+-\d+$/;

const ATTEMPTS = 200;
const MARKER_LIMIT = 8192;

/** A random run directory name, `vt` and two base36 characters. */
export function randomRunTmpdirName(): string {
  return `vt${Math.floor(Math.random() * 36 * 36).toString(36).padStart(2, '0')}`;
}

/** Whether process `pid` exists; `EPERM` means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The user id of this process; `undefined` where the platform has none, and then ownership is not checked. */
function ownUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

interface Marker {
  pid: number;
  /** `TMPDIR` before the run directory replaced it; `undefined` when it was not set. */
  original: string | undefined;
}

/**
 * The marker of `directory`, or `undefined` when the entry is not a run directory of user `uid`. Nothing here
 * follows a symlink or opens a special file: in a temporary directory shared between users (`/tmp` on Linux)
 * anyone can create an entry with our name, and reading a FIFO would block the config load for good.
 */
function markerOf(directory: string, uid: number | undefined): Marker | undefined {
  const ours = (stat: Stats): boolean => uid === undefined || stat.uid === uid;
  try {
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || !ours(entry)) return undefined;
    const file = join(directory, RUN_TMPDIR_MARKER);
    const stat = lstatSync(file);
    if (!stat.isFile() || !ours(stat) || stat.size > MARKER_LIMIT) return undefined;
    const [first = '', ...rest] = readFileSync(file, 'utf8').split('\n');
    if (!/^\d+$/.test(first)) return undefined;
    return { pid: Number(first), original: rest.length > 0 ? rest.join('\n') : undefined };
  } catch {
    return undefined;
  }
}

/** The marker of `directory` when it is a run directory by its name as well. */
function runMarkerOf(directory: string): Marker | undefined {
  return RUN_TMPDIR_NAME.test(basename(directory)) ? markerOf(directory, ownUid()) : undefined;
}

let claims = 0;

/**
 * Removes run directories in `base` whose owner pid is not alive, and what a killed sweep left of them.
 *
 * Between reading a marker and removing the directory another start may remove the same dead directory and draw
 * the same name for itself. The sweep therefore first renames the directory to a name of its own, which fixes
 * what it holds, reads the marker again there and removes only a directory whose owner is still dead; a live one
 * goes back under its name. Errors (a concurrent sweep took the entry) are ignored.
 */
export function sweepDeadRunTmpdirs(
  base: string, isAlive: (pid: number) => boolean = pidAlive, uid: number | undefined = ownUid(),
): void {
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return;
  }
  const dead = (directory: string): boolean => {
    const marker = markerOf(directory, uid);
    return marker !== undefined && !isAlive(marker.pid);
  };
  for (const name of entries) {
    if (!RUN_TMPDIR_NAME.test(name) && !CLAIMED_NAME.test(name)) continue;
    const directory = join(base, name);
    if (!dead(directory)) continue;
    const claimed = join(base, `.vt-${String(process.pid)}-${Date.now().toString(36)}-${String(claims++)}`);
    try {
      renameSync(directory, claimed);
    } catch {
      continue;
    }
    try {
      if (dead(claimed)) rmSync(claimed, { recursive: true, force: true });
      else renameSync(claimed, directory);
    } catch {
      // The name was taken again or another sweep got here first; a later sweep removes what stays.
    }
  }
}

export interface RunTmpdirOptions {
  /** Directory the run directory goes into; the temporary directory of `env` by default. */
  base?: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  randomName?: () => string;
}

/**
 * Sweeps dead runs in `base`, creates a run directory there owned by `pid` and points `env.TMPDIR` at it. A name
 * that already exists is drawn again. When `env.TMPDIR` already is a run directory of `pid` (the config loaded
 * twice in one process), it stays. Returns the directory.
 */
export function startRunTmpdir(env: NodeJS.ProcessEnv, options: RunTmpdirOptions = {}): string {
  const pid = options.pid ?? process.pid;
  if (env.TMPDIR !== undefined && runMarkerOf(env.TMPDIR)?.pid === pid) return env.TMPDIR;
  const base = options.base ?? env.TMPDIR ?? tmpdir();
  const isAlive = options.isAlive ?? pidAlive;
  const randomName = options.randomName ?? randomRunTmpdirName;
  sweepDeadRunTmpdirs(base, isAlive);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const directory = join(base, randomName());
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    const original = env.TMPDIR === undefined ? '' : `\n${env.TMPDIR}`;
    writeFileSync(join(directory, RUN_TMPDIR_MARKER), `${String(pid)}${original}`);
    env.TMPDIR = directory;
    return directory;
  }
  throw new Error(`run tmpdir: no free name in ${base} after ${String(ATTEMPTS)} attempts`);
}

/**
 * Removes the run directory of `pid` that `env.TMPDIR` points at and puts back the `TMPDIR` from before the run;
 * any other `TMPDIR` stays untouched.
 */
export function removeRunTmpdir(env: NodeJS.ProcessEnv, pid: number = process.pid): void {
  const directory = env.TMPDIR;
  if (directory === undefined) return;
  const marker = runMarkerOf(directory);
  if (marker?.pid !== pid) return;
  if (marker.original === undefined) delete env.TMPDIR;
  else env.TMPDIR = marker.original;
  rmSync(directory, { recursive: true, force: true });
}

const EXIT_HOOK = Symbol.for('rarog.vitest.run-tmpdir.exit');

/**
 * Removes the run directory when this process exits, once per process however often the config loads. It covers
 * a process that loads the config and closes vitest without running tests, where the global teardown never runs;
 * after a teardown it finds nothing to do.
 */
export function removeRunTmpdirAtExit(env: NodeJS.ProcessEnv): void {
  const registry = globalThis as { [EXIT_HOOK]?: boolean };
  if (registry[EXIT_HOOK] === true) return;
  registry[EXIT_HOOK] = true;
  process.once('exit', () => { removeRunTmpdir(env); });
}
