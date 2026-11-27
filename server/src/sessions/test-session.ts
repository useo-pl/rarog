/**
 * Test session rule: a session whose working directory lies in a temporary directory. Agents that run tests and
 * measurements start helper sessions in the Claude Code scratchpad (`/tmp/claude-<uid>/`, on macOS also written
 * `/private/tmp/claude-<uid>/`) or in the temporary directory of this process (`os.tmpdir()`, `$TMPDIR`; on macOS
 * also its on-disk form under `/private`). One function over a path, without state;
 * the manager passes the fact to the notification scheduler, which keeps the rule for "done".
 */
import os from 'node:os';
import path from 'node:path';
import { DIRECT_DISK } from '../folder-gate/disk.ts';

/** What the rule reads from the system; tests pass their own. */
export interface TempDirEnv {
  /** User id of the server process; absent where the platform has none (then only `tmpdir` counts). */
  readonly uid: number | undefined;
  /** Temporary directory of the server process (`os.tmpdir()`). */
  readonly tmpdir: string;
  /** `realpath`; may throw (missing path, closed folder), then the path is compared as written. */
  readonly realpath: (file: string) => string;
}

/** The server process: `process.getuid()`, `os.tmpdir()` and `realpath` through the work-area disk port. */
export function systemTempDirEnv(): TempDirEnv {
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    tmpdir: os.tmpdir(),
    realpath: (file) => DIRECT_DISK.sync('realpath', { path: file }),
  };
}

/** The path as written and, when it resolves, on disk; both normalized without a trailing slash. */
function spellings(file: string, realpath: TempDirEnv['realpath']): string[] {
  const written = path.resolve(file);
  try {
    const real = path.resolve(realpath(written));
    return real === written ? [written] : [written, real];
  } catch {
    return [written];
  }
}

/**
 * Whether `cwd` is the scratchpad root of Claude Code for this user, the temporary directory of the server, or lies
 * below one of them. A prefix matches on a directory boundary only: `/tmp/claude-501-other/` is not under
 * `/tmp/claude-501/`. Never throws: it runs on every state transition of every session.
 */
export function inTemporaryDirectory(cwd: string, env: TempDirEnv = systemTempDirEnv()): boolean {
  if (cwd === '') return false;
  try {
    const scratchpad = env.uid === undefined ? undefined : `claude-${String(env.uid)}`;
    const written = scratchpad === undefined ? [] : [`/tmp/${scratchpad}`, `/private/tmp/${scratchpad}`];
    if (env.tmpdir !== '') written.push(env.tmpdir);
    // The filesystem root would make every path temporary.
    const roots = written.flatMap((root) => spellings(root, env.realpath)).filter((root) => root !== path.sep);
    return spellings(cwd, env.realpath).some((candidate) =>
      roots.some((root) => candidate === root || candidate.startsWith(root + path.sep)));
  } catch {
    return false;
  }
}
