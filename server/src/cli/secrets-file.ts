/**
 * One secret written into the secrets file `~/.config/rarog/secret/private.env`, which `rarog serve` reads
 * (`serve.ts`). The shared path of `rarog dictation set-key` (`SONIOX_API_KEY`), `rarog voice-agent set-key`
 * (`OPENAI_API_KEY`) and the iroh server key of `rarog setup` (`RAROG_IROH_KEY`); the caller gives the name of the
 * secret and the question, and prints the result itself.
 *
 * {@link saveSecret}, step by step:
 * 1. no arguments: the value never comes from argv (`ps`, shell history); the input from `CliIo` (`askSecret` in a
 *    terminal, `readStdin` from a pipe, `secret-input.ts`), none of them = refusal;
 * 2. `config.json` (`readRarogConfig`); `service.wrapper` = refusal BEFORE the question: a name the wrapper exports
 *    overrides the file (`buildServeEnv`: the parent wins), and the command cannot know what the secrets manager
 *    exports;
 * 3. the `secret` directory (`checkEntry` 0700; missing = created as in `rarog setup`) and the file
 *    (`readPrivateEnv`): every server refusal comes before the question;
 * 4. the value (`readKey` in `voice-keys.ts`): at most `SECRET_MAX_BYTES` of input, trimmed, one line without white
 *    or control characters; the command does not guess the key format;
 * 5. the Rarog lock of the config directory (`lock.ts`, {@link lockSecrets}), taken only now, AFTER the question,
 *    so the command never holds it while waiting for a human; a live other holder (`rarog setup` writing the iroh
 *    key and `config.json`, another `set-key`) = refusal with its PID, nothing written;
 * 6. under the lock ({@link writeSecretLine}): the file read AGAIN and the new content built from that read, so a
 *    change made during the question is kept: lines byte for byte except the secret's line (line ending kept),
 *    without such a line it is appended; the new content checked in memory (the `MAX_FILE_BYTES` ceiling and the
 *    server parser `parsePrivateEnv`) before a temporary file exists;
 * 7. atomic write: `.private.env.<16 hex>.tmp` in the same directory (`wx`, 0600, `fsync`), `chmod 0600`, `rename`;
 *    a failure removes the temporary file and leaves the secrets file untouched; after `rename` a read-back
 *    `readPrivateEnv`, still under the lock.
 *
 * What the module does not do: it does not restart the server, start processes or log anything; `rename` is atomic
 * against `rarog serve`, which only reads the file. The value never reaches stdout, stderr or any file other than
 * the secrets file.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ServerEnvName } from '../config-env.ts';
import { REPAIR, rarogCli } from '../install/repair.ts';
import { readRegularFileSync } from '../safe-read.ts';
import { Refusal } from './io.ts';
import type { CliIo } from './io.ts';
import { LOCK_FILENAME, acquireLock } from './lock.ts';
import type { Lock } from './lock.ts';
import {
  MAX_FILE_BYTES, PRIVATE_ENV_FILENAME, SECRET_DIRNAME, checkEntry, parsePrivateEnv, rarogConfigDir, readPrivateEnv,
  readRarogConfig,
} from './serve.ts';
import { INTERRUPTED, readKey } from './voice-keys.ts';

/** The write steps of the secrets file; tests inject a failure into each of them. */
export interface SecretWrites {
  /** A new file with the content: `wx` (a taken name, a symlink too, = error), mode `mode`, `fsync` before close. */
  readonly create: (file: string, data: Buffer, mode: number) => void;
  readonly chmod: (file: string, mode: number) => void;
  readonly rename: (from: string, to: string) => void;
}

export const SECRET_WRITES: SecretWrites = {
  create: (file, data, mode) => { writeFileSync(file, data, { flag: 'wx', mode, flush: true }); },
  chmod: (file, mode) => { chmodSync(file, mode); },
  rename: (from, to) => { renameSync(from, to); },
};

/** A secret to save: the registry name, the terminal question and the `status` command the read-back points to. */
export interface SecretSpec {
  readonly name: ServerEnvName;
  readonly prompt: string;
  /** `rarog …` subcommand without the program name, e.g. `dictation status`. */
  readonly statusCommand: string;
}

/** A saved secret: the file and whether the line was there ("replaced") or was appended ("added"). */
export interface SavedSecret {
  readonly file: string;
  readonly replaced: boolean;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const NOTHING_CHANGED = 'nothing changed';
const LF = 0x0a;
const CR = 0x0d;
const EQUALS = 0x3d;

const errnoCode = (failure: unknown, fallback = 'error'): string => {
  const code = typeof failure === 'object' && failure !== null ? (failure as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : fallback;
};

/** `fn` with every error as a {@link Refusal}: a file system error names the path and the code, never content. */
function guarded<T>(target: string, fn: () => T): T {
  try {
    return fn();
  } catch (failure) {
    if (failure instanceof Refusal) throw failure;
    throw new Refusal(`${target}: ${errnoCode(failure)}; ${NOTHING_CHANGED}.`);
  }
}

/** The entry exists (`lstat`: a symlink too). */
function exists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (failure) {
    if (errnoCode(failure) === 'ENOENT') return false;
    throw new Refusal(`Cannot read ${target} (${errnoCode(failure)}); ${NOTHING_CHANGED}.`);
  }
}

/** The directory with mode `mode` when missing (parents with defaults); an existing one stays (as in `rarog setup`). */
function ensureDir(dir: string, mode: number): void {
  guarded(dir, () => {
    mkdirSync(path.dirname(dir), { recursive: true });
    try {
      mkdirSync(dir, { mode });
      chmodSync(dir, mode);
    } catch (failure) {
      if (errnoCode(failure) !== 'EEXIST') throw failure;
    }
  });
}

/** The secrets file to change: paths and raw bytes (`null` = no file). */
interface SecretsFile {
  readonly dir: string;
  readonly file: string;
  readonly bytes: Buffer | null;
}

/**
 * The secrets file as `rarog serve` sees it: the directory (`checkEntry` 0700) and the file (`readPrivateEnv`) with the
 * server's refusals, then the raw bytes (`O_NOFOLLOW`, a regular file, the ceiling) the new content is built from byte
 * for byte.
 */
function readSecretsFile(env: NodeJS.ProcessEnv): SecretsFile {
  const dir = path.join(rarogConfigDir(env), SECRET_DIRNAME);
  const file = path.join(dir, PRIVATE_ENV_FILENAME);
  guarded(dir, () => { checkEntry(dir, 'dir', DIR_MODE); });
  if (!guarded(file, () => readPrivateEnv(env)).present) return { dir, file, bytes: null };
  const changed = (): Refusal => new Refusal(`${file} changed while it was being read; ${NOTHING_CHANGED}. Run the`
    + ' command again.');
  let read: ReturnType<typeof readRegularFileSync>;
  try {
    read = readRegularFileSync(file, { maxBytes: MAX_FILE_BYTES, followSymlink: false });
  } catch {
    throw changed();
  }
  if (read === null || read.truncated) throw changed();
  return { dir, file, bytes: read.bytes };
}

/** The new content: the `name` line replaced with its line ending kept, or appended; the rest byte for byte. */
function withKey(
  old: Buffer | null, name: string, value: string,
): { readonly bytes: Buffer; readonly replaced: boolean } {
  const line = Buffer.from(`${name}=${value}`, 'utf8');
  const source = old ?? Buffer.alloc(0);
  const parts: Buffer[] = [];
  let replaced = false;
  let start = 0;
  while (start < source.length) {
    const lf = source.indexOf(LF, start);
    const end = lf === -1 ? source.length : lf + 1;
    const segment = source.subarray(start, end);
    let body = lf === -1 ? segment : segment.subarray(0, -1);
    let ending = lf === -1 ? '' : '\n';
    if (body.length > 0 && body[body.length - 1] === CR) {
      body = body.subarray(0, -1);
      ending = `\r${ending}`;
    }
    // The name as in the server parser: before the first `=`, trimmed (`=` is ASCII, so a UTF-8 boundary).
    const eq = body.indexOf(EQUALS);
    if (eq > 0 && body.subarray(0, eq).toString('utf8').trim() === name) {
      parts.push(line, Buffer.from(ending));
      replaced = true;
    } else {
      parts.push(segment);
    }
    start = end;
  }
  if (!replaced) {
    if (source.length > 0 && source[source.length - 1] !== LF) parts.push(Buffer.from('\n'));
    parts.push(line, Buffer.from('\n'));
  }
  return { bytes: Buffer.concat(parts), replaced };
}

/** Atomic write through a temporary file in the same directory; a failure removes the temporary file. */
function writeAtomically(target: SecretsFile, bytes: Buffer, writes: SecretWrites): void {
  const tmp = path.join(target.dir, `.${PRIVATE_ENV_FILENAME}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writes.create(tmp, bytes, FILE_MODE);
    writes.chmod(tmp, FILE_MODE);
    writes.rename(tmp, target.file);
  } catch (failure) {
    // `EEXIST` = the name is taken by a foreign entry: not our file, so it stays.
    if (errnoCode(failure) !== 'EEXIST') {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Best-effort cleanup: the temporary file has mode 0600 in a 0700 directory.
      }
    }
    throw new Refusal(`Cannot write ${target.file} (${errnoCode(failure)}); the secrets file is unchanged.`);
  }
}

/** A line about the name in this command's environment (without the value); `null` = the name is not there. */
export function shellEnvLine(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  if (value === undefined) return null;
  return `${name} is set in this shell's environment (${value === '' ? 'empty' : 'not empty'});`
    + ` \`${rarogCli('serve')}\` started from this shell uses it instead of the file.`;
}

/**
 * The `secret` directory with mode 0700 when it is missing (its parents too, as in `rarog setup`); an existing one is
 * left as it is and checked by {@link writeSecretLine}.
 */
export function ensureSecretDir(env: NodeJS.ProcessEnv): void {
  const configDir = rarogConfigDir(env);
  const dir = path.join(configDir, SECRET_DIRNAME);
  if (!exists(dir)) {
    ensureDir(configDir, DIR_MODE);
    ensureDir(dir, DIR_MODE);
  }
}

/** Config directory whose lock this process holds now (`null` = none); see {@link lockSecrets}. */
let heldDir: string | null = null;

/**
 * The Rarog lock of the config directory (`lock.ts`), the lock `rarog setup` holds around the iroh server key and
 * `config.json`. A live other holder = {@link Refusal} with its PID; `what` names the caller in that refusal. A
 * process takes the lock once and passes the held lock to {@link writeSecretLine}: the lock ignores its own PID, so
 * a second acquire would take the held lock over and the inner release would drop it for the outer caller. Such a
 * nested call is a bug and throws.
 */
export function lockSecrets(env: NodeJS.ProcessEnv, what: string): Lock {
  const dir = rarogConfigDir(env);
  if (heldDir !== null) throw new Error(`lockSecrets: this process already holds the lock of ${heldDir}`);
  const lock = acquireLock(dir, what);
  heldDir = dir;
  return lock;
}

/** Releases a lock from {@link lockSecrets}. */
export function unlockSecrets(lock: Lock): void {
  heldDir = null;
  lock.release();
}

/** `fn` under {@link lockSecrets}; the lock is released when `fn` returns or throws. */
export function withSecretsLock<T>(env: NodeJS.ProcessEnv, what: string, fn: (held: Lock) => T): T {
  const lock = lockSecrets(env, what);
  try {
    return fn(lock);
  } finally {
    unlockSecrets(lock);
  }
}

/** A secret to write under a held lock: its name, the value and the `rarog …` command the read-back points to. */
export interface SecretLine {
  readonly name: ServerEnvName;
  readonly value: string;
  /** `rarog …` subcommand without the program name, e.g. `dictation status`. */
  readonly statusCommand: string;
}

/**
 * Steps 6 and 7 of the module header under a lock the caller already holds (`held` from {@link lockSecrets}, the
 * lock of this `env`'s config directory): read again, new content, checks, atomic write, read-back.
 */
export function writeSecretLine(held: Lock, env: NodeJS.ProcessEnv, writes: SecretWrites, secret: SecretLine):
  SavedSecret {
  if (held.file !== path.join(rarogConfigDir(env), LOCK_FILENAME) || heldDir === null) {
    throw new Error(`writeSecretLine: ${held.file} is not the held lock of this config directory`);
  }
  const current = readSecretsFile(env);
  const next = withKey(current.bytes, secret.name, secret.value);
  if (next.bytes.length > MAX_FILE_BYTES) {
    throw new Refusal(`${current.file}: with the new key the file would be larger than ${String(MAX_FILE_BYTES)} B;`
      + ` ${NOTHING_CHANGED}.`);
  }
  parsePrivateEnv(next.bytes.toString('utf8'), current.file);
  writeAtomically(current, next.bytes, writes);
  let readBack: string | undefined;
  try {
    readBack = readPrivateEnv(env).values[secret.name];
  } catch (failure) {
    throw new Refusal(`${current.file} was written, but reading it back failed (${failure instanceof Refusal
      ? failure.message : errnoCode(failure)}).`);
  }
  if (readBack !== secret.value) {
    throw new Refusal(`${current.file} was written, but reading it back gave another value; check it with`
      + ` \`${rarogCli(secret.statusCommand)}\`.`);
  }
  return { file: current.file, replaced: next.replaced };
}

/** Steps 1–7 of the module header; {@link INTERRUPTED} = Ctrl-C during the question, nothing written. */
export async function saveSecret(
  io: CliIo, writes: SecretWrites, spec: SecretSpec,
): Promise<SavedSecret | typeof INTERRUPTED> {
  if (io.askSecret === undefined && io.readStdin === undefined) {
    throw new Refusal('Standard input is a terminal, but standard output is not, so the key cannot be asked for:'
      + ` run it in a terminal or pipe the key into it; ${NOTHING_CHANGED}.`);
  }
  const config = readRarogConfig(io.env);
  if (config !== null && config.wrapper !== null) {
    throw new Refusal(`${config.file} has service.wrapper: the server gets its secrets from the secrets manager behind`
      + ` it, and a name it exports overrides the secrets file. Add ${spec.name} in that secrets manager and restart`
      + ` the server (${REPAIR.restart}); ${NOTHING_CHANGED}.`);
  }
  ensureSecretDir(io.env);
  // Read only to refuse before the question; the new content comes from the read under the lock.
  readSecretsFile(io.env);
  const value = await readKey(io, spec.prompt);
  if (value === INTERRUPTED) return INTERRUPTED;
  let lock: Lock;
  try {
    lock = lockSecrets(io.env, 'cannot save now');
  } catch (failure) {
    if (!(failure instanceof Refusal)) throw failure;
    throw new Refusal(`${failure.message} The key was not saved; run the command again.`);
  }
  try {
    return writeSecretLine(lock, io.env, writes, { name: spec.name, value, statusCommand: spec.statusCommand });
  } finally {
    unlockSecrets(lock);
  }
}
