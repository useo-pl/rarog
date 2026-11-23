/**
 * The update lock `<config directory>/update.lock`: one update run at a time, from installing the package to the end
 * of `rarog update --finish`. It has the shape of the CLI lock (`lock.ts`: created with `wx`, the owner's PID on the
 * first line, a dead owner taken over under a takeover file) with a body: `token=<32 hex>` and, written only by the
 * run that has just installed the package, `installed.version=<version>` and `installed.root=<absolute path>`.
 *
 * A child process (`rarog update --finish` of the new version) inherits the lock through {@link UPDATE_LOCK_TOKEN}: it
 * checks the token, not the PID, and neither takes nor releases the lock. A second run while the lock is alive gets a
 * refusal in one sentence. `rarog restart` keeps taking its own lock inside a run. Nothing here writes outside the lock
 * file; the format is the contract with the owner's update script.
 */
import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readRegularFileSync } from '../safe-read.ts';
import { Refusal } from './io.ts';
import { acquireLock } from './lock.ts';

/** File name of the update lock in the config directory. */
export const UPDATE_LOCK_FILENAME = 'update.lock';

/** Variable through which a child process of an update run inherits the lock: the token of its body. */
export const UPDATE_LOCK_TOKEN = 'RAROG_UPDATE_LOCK_TOKEN';

/** Shape of a token: 32 lowercase hex characters. */
const TOKEN = /^[0-9a-f]{32}$/u;

/** Shape of a package version in the body (as `package.json` versions, without spaces). */
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/u;

/** Ceiling of the lock read: the PID line and the body with one path. */
const MAX_BYTES = 8192;

/** The package a run has just installed: its version and its root (the directory over `bin/rarog.mjs`). */
export interface InstalledPackage {
  readonly version: string;
  readonly root: string;
}

/** The body of the lock: the token and, after an install, what was installed. */
export interface UpdateLockBody {
  readonly token: string;
  readonly installed: InstalledPackage | null;
}

export interface UpdateLock extends UpdateLockBody {
  readonly file: string;
  /** Taken from a parent through {@link UPDATE_LOCK_TOKEN}: this process does not release it. */
  readonly inherited: boolean;
  /** Removes the lock when this process took it; nothing for an inherited one. */
  release(): void;
}

/** The body lines of a lock, each ending in a line end. A root with a line end has no line form: an error. */
export function updateLockBody(body: UpdateLockBody): string {
  if (!TOKEN.test(body.token)) throw new Error('update lock: the token is not 32 hex characters');
  const lines = [`token=${body.token}`];
  if (body.installed !== null) {
    const { version, root } = body.installed;
    if (!VERSION.test(version) || !path.isAbsolute(root) || /[\n\r]/u.test(root)) {
      throw new Error('update lock: the installed version or root has no line form');
    }
    lines.push(`installed.version=${version}`, `installed.root=${root}`);
  }
  return lines.map((line) => `${line}\n`).join('');
}

/**
 * The body of a lock text (the PID line first, then `key=value` lines), or `null` when it does not have the shape:
 * no token, an unknown or repeated key, or only one of the two `installed.*` lines.
 */
export function parseUpdateLock(text: string): UpdateLockBody | null {
  const [, ...rest] = text.split('\n');
  const values = new Map<string, string>();
  for (const line of rest) {
    if (line === '') continue;
    const at = line.indexOf('=');
    const key = at === -1 ? '' : line.slice(0, at);
    if (!['token', 'installed.version', 'installed.root'].includes(key) || values.has(key)) return null;
    values.set(key, line.slice(at + 1));
  }
  const token = values.get('token');
  if (token === undefined || !TOKEN.test(token)) return null;
  const version = values.get('installed.version');
  const root = values.get('installed.root');
  if (version === undefined && root === undefined) return { token, installed: null };
  if (version === undefined || root === undefined || !VERSION.test(version) || !path.isAbsolute(root)) return null;
  return { token, installed: { version, root } };
}

/** A new token for a lock this process takes. */
export function newUpdateToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Takes the update lock in `dir` (the config directory, created 0700 when missing) with a new token and, after an
 * install, `installed`. A live owner = {@link Refusal} in one sentence; a dead one is taken over (`lock.ts`).
 */
export function takeUpdateLock(
  dir: string, what: string, installed: InstalledPackage | null = null, now: () => number = Date.now,
): UpdateLock {
  const token = newUpdateToken();
  const lock = acquireLock(dir, what, now, {}, {
    filename: UPDATE_LOCK_FILENAME,
    body: updateLockBody({ token, installed }),
    busy: (pid, file) => `${what}: another update is running (PID ${String(pid)}, lock ${file}); wait until it ends.`,
  });
  return { file: lock.file, token, installed, inherited: false, release: () => { lock.release(); } };
}

/**
 * The lock of a parent run, inherited by its token: the lock file must exist, have the shape of {@link parseUpdateLock}
 * and carry this token. Anything else = {@link Refusal}; nothing is written.
 */
export function inheritUpdateLock(dir: string, token: string, what: string): UpdateLock {
  const file = path.join(dir, UPDATE_LOCK_FILENAME);
  let text: string | null;
  try {
    const read = readRegularFileSync(file, { maxBytes: MAX_BYTES, followSymlink: false });
    text = read === null || read.truncated ? null : read.bytes.toString('utf8');
  } catch {
    text = null;
  }
  const body = text === null ? null : parseUpdateLock(text);
  if (body === null) {
    throw new Refusal(`${what}: ${UPDATE_LOCK_TOKEN} is set, but there is no readable update lock ${file} to`
      + ' inherit; run it without that variable.');
  }
  if (body.token !== token) {
    throw new Refusal(`${what}: ${UPDATE_LOCK_TOKEN} does not match the update lock ${file}, which another update`
      + ' holds; wait until it ends.');
  }
  return { file, token, installed: body.installed, inherited: true, release: () => {} };
}

/**
 * Writes `installed` into a lock this process took, after it installed the package: the same PID line and token, the
 * body replaced through a new file (`wx`, 0600) and `rename`, so a reader sees the old body or the new one. A lock
 * that is not this process's any more (another PID or token in the file) = {@link Refusal}; nothing is written.
 */
export function markInstalled(lock: UpdateLock, installed: InstalledPackage, what: string): UpdateLock {
  if (lock.inherited) throw new Error('update lock: only the process that took the lock marks the install');
  let text: string | null;
  try {
    const read = readRegularFileSync(lock.file, { maxBytes: MAX_BYTES, followSymlink: false });
    text = read === null || read.truncated ? null : read.bytes.toString('utf8');
  } catch {
    text = null;
  }
  if (text?.split('\n')[0] !== String(process.pid) || parseUpdateLock(text)?.token !== lock.token) {
    throw new Refusal(`${what}: the update lock ${lock.file} is no longer this run's; nothing was finished.`);
  }
  const next = `${lock.file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(next, `${String(process.pid)}\n${updateLockBody({ token: lock.token, installed })}`,
    { flag: 'wx', mode: 0o600 });
  try {
    renameSync(next, lock.file);
  } catch (failure) {
    rmSync(next, { force: true });
    throw failure;
  }
  return { ...lock, installed };
}

/**
 * The lock of this run: inherited when `env` carries {@link UPDATE_LOCK_TOKEN} (a child of an update run), otherwise
 * taken by this process without `installed` (it installed nothing).
 */
export function updateLockOf(dir: string, env: NodeJS.ProcessEnv, what: string): UpdateLock {
  const token = env[UPDATE_LOCK_TOKEN];
  return token === undefined || token === '' ? takeUpdateLock(dir, what) : inheritUpdateLock(dir, token, what);
}
