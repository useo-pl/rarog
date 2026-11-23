/**
 * Layer 2 of the git guard on macOS: every git process of the runner starts under `sandbox-exec` with a profile
 * that lets it start no program other than the git binaries and denies the network. A program from repository config
 * then does not start on any path, known or not, and a driver written between the config names read and the start of
 * git does not run either. This module resolves the git binaries, writes the profile and decides whether the probe
 * passed; the runner in `git-status.ts` runs the two probe commands and every git process. Linux has layer 1 only.
 */
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** The macOS program that starts a command under a sandbox profile. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** How the runner starts git under the sandbox: `file`, then `args`, then git's own argv. */
export interface GitSandbox {
  readonly file: string;
  /** `-p <profile>` and the git binary of git's exec path. */
  readonly args: readonly string[];
}

/** Result of the probe: the sandbox for every git process, or why git runs with layer 1 only. */
export type GitSandboxState = { readonly sandbox: GitSandbox } | { readonly unavailable: string };

/** What the probe needs from one git process (a subset of the runner's result). */
export interface GitProbeRun {
  readonly ok: boolean;
  readonly stdout: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly spawnFailed?: string;
  readonly capped?: boolean;
}

/** The two git processes of the probe, run by the runner. */
export interface GitSandboxPort {
  /** `git --exec-path` without the sandbox, from `/`. */
  execPath(): Promise<GitProbeRun>;
  /** `git version` under `sandbox`, from `/`. */
  version(sandbox: GitSandbox): Promise<GitProbeRun>;
}

/**
 * The profile: everything stays allowed except starting a program and the network. `process-exec*` covers the script
 * interpreter too, so a script, even one named git, does not start. The paths are literal real paths: the kernel
 * checks the resolved file, so a symlink to an allowed binary (the `git` in the exec path) passes and nothing else.
 */
export function gitSandboxProfile(binaries: readonly string[]): string {
  const allowed = binaries.map((binary) => `(literal "${binary}")`).join(' ');
  return `(version 1) (allow default) (deny process-exec*) (allow process-exec ${allowed}) (deny network*)`;
}

/** A path the profile can carry inside `"…"`: absolute, without a quote, a backslash or a control character. */
function quotable(path: string): boolean {
  return isAbsolute(path) && !/["\\\p{Cc}]/u.test(path);
}

/** An executable regular file, as `execvp` would take it. */
async function executable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first executable git on `PATH`, as `execvp` finds it; relative entries are skipped (they follow the cwd). */
async function gitOnPath(path: string): Promise<string | null> {
  for (const dir of path.split(':')) {
    if (!isAbsolute(dir)) continue;
    const candidate = `${dir.replace(/\/+$/, '')}/git`;
    if (await executable(candidate)) return candidate;
  }
  return null;
}

/** Why a probe run failed, for the log line. */
function failure(run: GitProbeRun): string {
  if (run.timedOut === true) return 'timed out';
  if (run.spawnFailed !== undefined) return `did not start: ${run.spawnFailed}`;
  if (run.capped === true) return 'answered past the read cap';
  return run.exitCode === undefined ? 'ended without an exit status' : `exit status ${String(run.exitCode)}`;
}

/**
 * Probe of layer 2 for one environment. The allowed binaries are the git that `PATH` gives (on macOS the `/usr/bin/git`
 * shim) and the `git` in git's exec path (the git of the selected developer directory, which git also starts for its
 * own child processes). The sandbox starts the second one, not the shim: the shim starts `xcodebuild` to find the
 * developer directory whenever its cache is cold (a new `HOME`, an Xcode update), the profile denies that, and every
 * read would end with exit code 71. The probe passes only when `git version` under the profile answers; otherwise git
 * runs with layer 1 only, and the reason goes to the log line.
 */
export async function probeGitSandbox(
  platform: NodeJS.Platform, path: string, sandboxExec: string, port: GitSandboxPort,
): Promise<GitSandboxState> {
  if (platform !== 'darwin') return { unavailable: `there is no sandbox-exec on ${platform}` };
  const onPath = await gitOnPath(path);
  if (onPath === null) return { unavailable: 'no git on PATH' };
  const execPath = await port.execPath();
  const dir = execPath.stdout.trim();
  if (!execPath.ok || execPath.capped === true || !isAbsolute(dir)) {
    return { unavailable: `git --exec-path ${execPath.ok ? 'gave no absolute path' : failure(execPath)}` };
  }
  let started: string;
  let binaries: string[];
  try {
    started = await realpath(`${dir}/git`);
    binaries = [...new Set([await realpath(onPath), started])];
  } catch {
    return { unavailable: `no git in git's exec path ${dir}` };
  }
  if (!binaries.every(quotable)) return { unavailable: 'a git path the profile cannot quote' };
  const sandbox: GitSandbox = { file: sandboxExec, args: ['-p', gitSandboxProfile(binaries), started] };
  const check = await port.version(sandbox);
  if (!check.ok || !check.stdout.startsWith('git version ')) {
    return { unavailable: `git version under the profile ${check.ok ? 'gave no version' : failure(check)}` };
  }
  return { sandbox };
}

/** The start log line when git runs without layer 2. */
export function gitSandboxLogLine(reason: string): string {
  return `git: sandbox-exec is not applied (${reason}); git reads run with layer 1 only`
    + ' (flags, environment, emptied filter drivers)';
}
