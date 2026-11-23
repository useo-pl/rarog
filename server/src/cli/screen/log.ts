/**
 * Run log of a `rarog` command: detail lines with their time, kept in memory until the command decides to write
 * (`open`), then in `<dataDir>/logs/<command>-<yyyymmdd-hhmmss>.log` (directory 0700, file 0600 created with `wx`);
 * another run in the same second gets `-01`, `-02`… after the time. Ten newest logs stay per command; older ones are
 * removed by their full name, never by a pattern. Without `open` nothing touches the disk. The callers decide what
 * goes in: never a secret, never the text of a foreign file.
 */
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clean } from './style.ts';

/** Logs kept per command, the new one included. */
export const LOGS_KEPT = 10;

export interface RunLogOptions {
  /** Command name in the file name (`setup`, `update`); letters, digits and `-` only. */
  readonly command: string;
  /** Clock for the line times and the file name (tests pass a fixed one). */
  readonly now?: () => Date;
  /** How many logs of this command stay; default {@link LOGS_KEPT}. */
  readonly keep?: number;
}

const pad = (value: number, size = 2): string => String(value).padStart(size, '0');

/** Highest sequence after the time in one second (`-99`); a 100th run in the same second fails. */
const MAX_SEQUENCE = 99;

/** A log name of this command: its time and its sequence (`0` without a suffix), or `null` for any other file. */
function parseName(name: string, prefix: string): { readonly stamp: string; readonly sequence: number } | null {
  if (!name.startsWith(prefix)) return null;
  const match = /^([0-9]{8}-[0-9]{6})(?:-([0-9]{1,2}))?\.log$/u.exec(name.slice(prefix.length));
  if (match?.[1] === undefined) return null;
  return { stamp: match[1], sequence: match[2] === undefined ? 0 : Number(match[2]) };
}

/** Local `yyyymmdd-hhmmss` for the file name. */
function stamp(date: Date): string {
  return `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Local `hh:mm:ss.mmm` in front of each log line. */
function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}`;
}

export class RunLog {
  readonly #command: string;
  readonly #now: () => Date;
  readonly #keep: number;
  #pending: string[] = [];
  #file: string | null = null;
  #broken = false;

  constructor(options: RunLogOptions) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(options.command)) throw new Error(`bad log command name: ${options.command}`);
    this.#command = options.command;
    this.#now = options.now ?? ((): Date => new Date());
    this.#keep = Math.max(1, options.keep ?? LOGS_KEPT);
  }

  /** Full path of the log file once `open` succeeded, otherwise `null`. */
  get path(): string | null {
    return this.#file;
  }

  /**
   * One detail line (several when `text` has line breaks), each with its time. Before `open` it waits in memory;
   * after a write failure the log stops quietly, because a lost log line must not break the command.
   */
  line(text: string): void {
    const time = clock(this.#now());
    const lines = text.split(/\r?\n/u).map((part) => `${time} ${clean(part)}\n`);
    if (this.#file === null) {
      this.#pending.push(...lines);
      return;
    }
    if (this.#broken) return;
    try {
      appendFileSync(this.#file, lines.join(''));
    } catch {
      this.#broken = true;
    }
  }

  /**
   * Creates the log file under `<dataDir>/logs`, writes the lines collected so far and removes the oldest logs of
   * this command beyond the limit. Returns the full path; a second call returns the same path. Throws when the
   * directory is not a real directory or the file cannot be created.
   */
  open(dataDir: string): string {
    if (this.#file !== null) return this.#file;
    const dir = path.join(dataDir, 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A symlink or a file under the log name would send the log somewhere else.
    if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
    chmodSync(dir, 0o700);
    const prefix = `${this.#command}-`;
    const when = stamp(this.#now());
    const body = this.#pending.join('');
    // After the highest sequence of this second, never a lower one: a pruned older name must not come back and sort
    // before the newer logs of the same second.
    const taken = readdirSync(dir).flatMap((name) => {
      const log = parseName(name, prefix);
      return log?.stamp === when ? [log.sequence] : [];
    });
    for (let sequence = taken.length === 0 ? 0 : Math.max(...taken) + 1; ; sequence += 1) {
      if (sequence > MAX_SEQUENCE) throw new Error(`too many ${this.#command} logs in one second in ${dir}`);
      const file = path.join(dir, sequence === 0 ? `${prefix}${when}.log` : `${prefix}${when}-${pad(sequence)}.log`);
      try {
        writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
        this.#file = file;
        break;
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
      }
    }
    this.#pending = [];
    this.#prune(dir);
    return this.#file;
  }

  /**
   * Removes this command's older logs beyond the limit, oldest first by time and sequence. The current log is never
   * a candidate, so exactly `keep` logs stay, the current one included.
   */
  #prune(dir: string): void {
    const prefix = `${this.#command}-`;
    const current = this.#file === null ? '' : path.basename(this.#file);
    const older = readdirSync(dir)
      .flatMap((name) => {
        const log = parseName(name, prefix);
        return log === null || name === current ? [] : [{ name, ...log }];
      })
      .sort((a, b) => (a.stamp === b.stamp ? a.sequence - b.sequence : a.stamp < b.stamp ? -1 : 1));
    for (const { name } of older.slice(0, Math.max(0, older.length - (this.#keep - 1)))) {
      try {
        unlinkSync(path.join(dir, name));
      } catch {
        // A log that is already gone or cannot be removed does not stop the command.
      }
    }
  }
}
