/**
 * Rewrite of an existing `config.json` (`rarog voice-agent set-model`, the voice agent flag of `set-key` and the
 * Tailscale address of `rarog setup --tailscale`). It reads only a file in the exact layout `rarog setup` writes
 * (`configFileText` in `serve.ts`) and refuses any other one; the new text goes through a temporary file next to the
 * target and `rename`, and right before `rename` the target is read again: other bytes, another inode or another
 * link target is a refusal, the temporary file removed.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { REPAIR, rarogCli } from '../install/repair.ts';
import { readRegularFileSync } from '../safe-read.ts';
import { Refusal } from './io.ts';
import { MAX_FILE_BYTES, configFileText, readRarogConfig } from './serve.ts';

/** Steps of the `config.json` write; tests inject a failure or a change made in between. */
export interface ConfigWrites {
  /** A new file (`wx`) with mode `mode`, the content and `fsync`; on an error after opening the file is removed. */
  readonly create: (file: string, bytes: Buffer, mode: number) => void;
  readonly rename: (from: string, to: string) => void;
}

function unlinkQuiet(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Gone already (after `rename`) or not removable: best-effort cleanup.
  }
}

export const CONFIG_WRITES: ConfigWrites = {
  create: (file, bytes, mode) => {
    const fd = openSync(file, 'wx', mode);
    let done = false;
    try {
      fchmodSync(fd, mode);
      let at = 0;
      while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
      fsyncSync(fd);
      done = true;
    } finally {
      closeSync(fd);
      if (!done) unlinkQuiet(file);
    }
  },
  rename: (from, to) => { renameSync(from, to); },
};

export const NOTHING_CHANGED = 'nothing changed';

const errnoCode = (failure: unknown): string => {
  const code = typeof failure === 'object' && failure !== null ? (failure as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : 'error';
};

/** `config.json` as it lies on disk: the file holding the bytes, the link, identity, mode and bytes. */
export interface Snapshot {
  readonly file: string;
  readonly real: string;
  readonly link: string | null;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly bytes: Buffer;
}

function snapshotOf(file: string): Snapshot {
  let info: Stats;
  try {
    info = lstatSync(file);
  } catch (failure) {
    if (errnoCode(failure) === 'ENOENT') {
      throw new Refusal(`${file} does not exist; create it with ${rarogCli('setup')} first; ${NOTHING_CHANGED}.`);
    }
    throw new Refusal(`Cannot check ${file} (${errnoCode(failure)}); ${NOTHING_CHANGED}.`);
  }
  let real = file;
  let link: string | null = null;
  if (info.isSymbolicLink()) {
    try {
      link = readlinkSync(file);
      real = realpathSync(file);
      info = lstatSync(real);
    } catch (failure) {
      throw new Refusal(`${file} is a symlink${link === null ? '' : ` to ${link}`} that leads to no file`
        + ` (${errnoCode(failure)}); ${NOTHING_CHANGED}.`);
    }
  }
  if (!info.isFile()) throw new Refusal(`${real} is not a regular file; ${NOTHING_CHANGED}.`);
  let read: ReturnType<typeof readRegularFileSync>;
  try {
    read = readRegularFileSync(real, { maxBytes: MAX_FILE_BYTES, followSymlink: false });
  } catch (failure) {
    throw new Refusal(`Cannot read ${real} (${errnoCode(failure)}); ${NOTHING_CHANGED}.`);
  }
  if (read === null) throw new Refusal(`${real} is not a regular file; ${NOTHING_CHANGED}.`);
  if (read.truncated) {
    throw new Refusal(`${real} is larger than ${String(MAX_FILE_BYTES / 1024)} KiB; ${NOTHING_CHANGED}.`);
  }
  return { file, real, link, dev: info.dev, ino: info.ino, mode: info.mode & 0o777, bytes: read.bytes };
}

const sameSnapshot = (a: Snapshot, b: Snapshot): boolean => a.real === b.real && a.link === b.link
  && a.dev === b.dev && a.ino === b.ino && a.bytes.equals(b.bytes);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** `config.json` in the layout `rarog setup` writes: what lies on disk, the parsed object and its `env`. */
export interface SetupConfig {
  readonly first: Snapshot;
  readonly parsed: Record<string, unknown>;
  readonly env: Record<string, unknown>;
}

/**
 * `config.json` to rewrite: refused when missing, when `rarog serve` would refuse it, or when it is not in the exact
 * layout `rarog setup` writes; `handEdit` is what the refusal tells the human to set by hand.
 */
export function readSetupConfig(file: string, env: NodeJS.ProcessEnv, handEdit: string): SetupConfig {
  const first = snapshotOf(file);
  // The checks of `rarog serve`: a file it would refuse is not changed here either.
  readRarogConfig(env);
  const text = first.bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Refusal(`${file}: not valid JSON; ${NOTHING_CHANGED}.`);
  }
  if (!isRecord(parsed) || !Buffer.from(text, 'utf8').equals(first.bytes) || configFileText(parsed) !== text) {
    throw new Refusal(`${file} is not in the layout rarog setup writes (two-space JSON ending with a newline), so the`
      + ` command does not rewrite it. Set ${handEdit} in its "env" object by hand, then restart the server`
      + ` (${REPAIR.restart}); ${NOTHING_CHANGED}.`);
  }
  return { first, parsed, env: isRecord(parsed['env']) ? parsed['env'] : {} };
}

/** Replaces `config.json` with `next` in the layout of `rarog setup`; a change since `first` is a refusal. */
export function replaceConfig(first: Snapshot, next: Record<string, unknown>, writes: ConfigWrites, what: string): void {
  const { file } = first;
  const bytes = Buffer.from(configFileText(next), 'utf8');
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Refusal(`${file}: with ${what} the file would be larger than ${String(MAX_FILE_BYTES / 1024)} KiB;`
      + ` ${NOTHING_CHANGED}.`);
  }
  const tmp = path.join(path.dirname(first.real), `.${path.basename(first.real)}.${randomBytes(8).toString('hex')}.tmp`);
  let created = false;
  try {
    writes.create(tmp, bytes, first.mode);
    created = true;
    let now: Snapshot;
    try {
      now = snapshotOf(file);
    } catch {
      throw new Refusal(`${file} changed meanwhile; ${NOTHING_CHANGED}. Run the command again.`);
    }
    if (!sameSnapshot(first, now)) {
      throw new Refusal(`${file} changed meanwhile; ${NOTHING_CHANGED}. Run the command again.`);
    }
    writes.rename(tmp, first.real);
    created = false;
  } catch (failure) {
    if (created || errnoCode(failure) !== 'EEXIST') unlinkQuiet(tmp);
    if (failure instanceof Refusal) throw failure;
    throw new Refusal(`Cannot write ${first.real} (${errnoCode(failure)}); ${NOTHING_CHANGED}.`);
  }
}
