/**
 * The reader of the main conversation file for the session's scheduled tasks (crons). It reads `<uuid>.jsonl`
 * incrementally from byte zero through `incremental-read.ts`, passes each line through the tracker's prefilter before
 * `JSON.parse` and hands out the list of `scheduled-tasks.ts`. A file shorter than the offset or with another inode
 * rebuilds the list from zero with a new tracker. Overview: `docs/scheduled-tasks.md`.
 *
 * It reads only the main file, never subagents' files (their crons are not the session's), and never throws: a file
 * confirmed missing is an empty list (the next file found is read from zero), a file not located yet says nothing
 * (`unknown`), and another read error comes back as `failed`, so the caller can read again without a new signal. When
 * to read, the first payout and the signature of the sent list stay with the caller
 * (`drivers/herdr/scheduled-task-poll.ts`).
 */
import type { SessionScheduledTask } from '@rarog/shared';
import { defaultStoreRoot } from '../../cli-store.ts';
import { parseJsonlEntry } from '../jsonl-pending.ts';
import { locateTranscript } from '../transcript-path.ts';
import { cursorAt, readIncrement } from './incremental-read.ts';
import type { FileCursor } from './incremental-read.ts';
import { createScheduledTasksTracker } from './scheduled-tasks.ts';
import type { ScheduledTasksTracker } from './scheduled-tasks.ts';

/** Delay of a read after a signal (the main file grew); signals inside it fold into one read. */
export const SCHEDULED_TASKS_POLL_MS = 5_000;
/** Pause before the next read when the previous one left part of the file for later (the budget ended). */
export const SCHEDULED_TASKS_BACKLOG_MS = 1_000;
/** At most this many bytes in one read. */
export const SCHEDULED_TASKS_SCAN_BUDGET_BYTES = 256 * 1024 * 1024;
/** One read chunk. */
export const SCHEDULED_TASKS_CHUNK_BYTES = 1024 * 1024;
/** Ceiling of one line; a longer one (a `Read` result with an image) is skipped whole. */
export const SCHEDULED_TASKS_LINE_MAX_BYTES = 8 * 1024 * 1024;

/** The result of one read. */
export interface ScheduledTasksRead {
  /** The list as far as the file was read (`scheduled-tasks.ts` orders and caps it). */
  readonly tasks: readonly SessionScheduledTask[];
  /** The file has an unread part (the budget ended first): the list is not whole yet. */
  readonly more: boolean;
  /** The read hit an error other than a missing file: the list may lag behind the file. */
  readonly failed: boolean;
  /** Nobody knows the file yet (the follower is still looking for it): the list says nothing about the file. */
  readonly unknown: boolean;
}

export interface ScheduledTaskFileReader {
  /**
   * Reads the main file on from the remembered offset; `null` = the read went stale (`repoint`, `relocated` or
   * `close` meanwhile). The caller reads one at a time.
   */
  read(): Promise<ScheduledTasksRead | null>;
  /** `/clear`, `/resume`: another conversation, another file; the list, the offset and the process start go. */
  repoint(agentSessionId: string): void;
  /** The same file under a new address (`EnterWorktree`): only the address is forgotten, the offset stays. */
  relocated(): void;
  /**
   * The start of the current Claude Code process of this conversation (epoch ms). `true` = a new value, which can
   * change the list without file growth (a one-shot task due before the start is gone).
   */
  processStarted(atMs: number): boolean;
  close(): void;
}

export interface ScheduledTaskFileReaderOptions {
  cwd: string;
  agentSessionId: string;
  /**
   * Where the main file the follower reads is: its path, `false` = the follower looked and there is no file, `null`
   * = not known yet. The driver gives it from the follower, so the reader looks into the same file (also after a
   * move and in tests with a temporary store). Without it the reader looks for the file by uuid under `root`.
   */
  locate?: () => string | false | null;
  /** Root of the CLI store for the lookup without `locate`. Default `~/.claude/projects`. */
  root?: string;
  /** Read ceilings; tests shrink them to bytes. */
  budgetBytes?: number;
  chunkBytes?: number;
  lineMaxBytes?: number;
}

class Reader implements ScheduledTaskFileReader {
  readonly #root: string;
  readonly #cwd: string;
  readonly #locate: (() => string | false | null) | undefined;
  readonly #budgetBytes: number;
  readonly #chunkBytes: number;
  readonly #lineMaxBytes: number;
  #uuid: string;
  #cursor: FileCursor | undefined;
  #tracker: ScheduledTasksTracker = createScheduledTasksTracker();
  #processStartedAt: number | null = null;
  /** Grows on `repoint()` and `relocated()`; a read started before hands out nothing. */
  #generation = 0;
  #closed = false;

  constructor(opts: ScheduledTaskFileReaderOptions) {
    this.#root = opts.root ?? defaultStoreRoot();
    this.#cwd = opts.cwd;
    this.#uuid = opts.agentSessionId;
    this.#locate = opts.locate;
    this.#chunkBytes = Math.max(1, opts.chunkBytes ?? SCHEDULED_TASKS_CHUNK_BYTES);
    this.#budgetBytes = Math.max(this.#chunkBytes, opts.budgetBytes ?? SCHEDULED_TASKS_SCAN_BUDGET_BYTES);
    this.#lineMaxBytes = Math.max(1, opts.lineMaxBytes ?? SCHEDULED_TASKS_LINE_MAX_BYTES);
  }

  async read(): Promise<ScheduledTasksRead | null> {
    if (this.#closed) return null;
    const generation = this.#generation;
    const stale = (): boolean => this.#closed || generation !== this.#generation;
    let path: string | false | null;
    if (this.#locate !== undefined) path = this.#locate();
    else {
      path = await locateTranscript(this.#root, this.#cwd, this.#uuid) ?? false;
      if (stale()) return null;
    }
    if (path === null) return { tasks: this.#tracker.tasks, more: false, failed: false, unknown: true };
    if (path === false) {
      // No file now: the list built from it is gone, and a file found later is read again from zero.
      this.#cursor = undefined;
      this.#tracker = this.#newTracker();
      return { tasks: this.#tracker.tasks, more: false, failed: false, unknown: false };
    }
    const outcome = await readIncrement<FileCursor>(path, {
      cursor: this.#cursor,
      // Another content under the name, or a shorter file: the list is rebuilt from the whole file.
      restart: (identity) => {
        this.#cursor = cursorAt(identity);
        this.#tracker = this.#newTracker();
        return this.#cursor;
      },
      budgetBytes: this.#budgetBytes,
      chunkBytes: this.#chunkBytes,
      lineMaxBytes: this.#lineMaxBytes,
      stale,
      onLines: (lines) => {
        const tracker = this.#tracker;
        for (const line of lines) {
          // Every literal and id the prefilter looks for is ASCII: `latin1` keeps one byte per character, cheaper
          // than UTF-8 for a line that is then dropped.
          if (!tracker.mayMatter(line.toString('latin1'))) continue;
          tracker.note(parseJsonlEntry(line.toString('utf8')));
        }
      },
    });
    if (stale()) return null;
    return { tasks: this.#tracker.tasks, more: outcome.more, failed: outcome.failed === true, unknown: false };
  }

  repoint(agentSessionId: string): void {
    this.#generation += 1;
    this.#uuid = agentSessionId;
    this.#cursor = undefined;
    // The start belonged to the previous conversation; the caller gives it again for the new uuid.
    this.#processStartedAt = null;
    this.#tracker = createScheduledTasksTracker();
  }

  relocated(): void {
    this.#generation += 1;
  }

  processStarted(atMs: number): boolean {
    if (this.#closed || atMs === this.#processStartedAt) return false;
    this.#processStartedAt = atMs;
    this.#tracker.processStarted(atMs);
    return true;
  }

  close(): void {
    this.#closed = true;
    this.#cursor = undefined;
  }

  #newTracker(): ScheduledTasksTracker {
    const tracker = createScheduledTasksTracker();
    if (this.#processStartedAt !== null) tracker.processStarted(this.#processStartedAt);
    return tracker;
  }
}

export function createScheduledTaskFileReader(opts: ScheduledTaskFileReaderOptions): ScheduledTaskFileReader {
  return new Reader(opts);
}
