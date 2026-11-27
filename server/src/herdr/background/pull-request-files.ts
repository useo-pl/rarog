/**
 * Reader of the MAIN conversation file `<uuid>.jsonl` for pull requests: the linked set and the window's lower bound
 * (`pull-requests.ts`), bound to one conversation. Whole picture: `docs/pull-requests.md`.
 *
 * Why a reader of its own and not the follower: the follower reads a tail window, and the linked set covers the whole
 * file and must hold after a server restart. The reader goes through the file incrementally with a prefilter before
 * `JSON.parse` ({@link mayCarryPullRequestLink}); until the window is known it parses every line. Subagent and
 * workflow agent files are not read: the link entry stands in the main file.
 *
 * One read takes at most {@link PULL_REQUEST_SCAN_BUDGET_BYTES}; the rest waits for the next one (`backlog`), nothing
 * is skipped. A read from {@link PULL_REQUEST_SCAN_LOG_BYTES} leaves a cost line in the log. One file's read (byte
 * chunks, lines through `jsonl-lines.ts` with an over-ceiling line skipped whole, a file shorter than the offset or
 * with another inode read from the start) is `incremental-read.ts`. The module never throws; a missing file is a
 * normal state.
 */
import { defaultStoreRoot } from '../../cli-store.ts';
import { locateTranscript } from '../transcript-path.ts';
import { parseJsonlEntry } from '../jsonl-pending.ts';
import { cursorAt, readIncrement } from './incremental-read.ts';
import type { FileCursor } from './incremental-read.ts';
import {
  createLinkedPullRequests, entryTimeOf, mayCarryPullRequestLink, pullRequestLinkOf,
} from './pull-requests.ts';
import type { LinkedPullRequests, PullRequestLinks } from './pull-requests.ts';

/**
 * How long after a signal the driver reads the conversation file (the main file grew, a PR link entry). Signals in
 * this window fold into one read.
 */
export const PULL_REQUESTS_POLL_MS = 5_000;
/** Przerwa między odczytami, gdy poprzedni zostawił zaległość (budżet się skończył). */
export const PULL_REQUESTS_BACKLOG_MS = 1_000;
/** How many bytes one read takes at most. */
export const PULL_REQUEST_SCAN_BUDGET_BYTES = 256 * 1024 * 1024;
/** Jedna porcja odczytu. */
export const PULL_REQUEST_CHUNK_BYTES = 1024 * 1024;
/** Sufit długości jednej linii; dłuższa (wynik `Read` z obrazem) jest pomijana w całości. */
export const PULL_REQUEST_LINE_MAX_BYTES = 8 * 1024 * 1024;
/** Od tylu przeczytanych bajtów odczyt zostawia w logu linię z kosztem. */
export const PULL_REQUEST_SCAN_LOG_BYTES = 8 * 1024 * 1024;
/** Fraza linii logu z kosztem odczytu. */
export const PULL_REQUEST_SCAN_LOG = 'pull request scan';

/** Wynik jednego odczytu. */
export interface PullRequestRead {
  /** The linked set and the window of the current conversation. */
  readonly links: PullRequestLinks;
  /** The read budget ran out and part of the file waits for the next read. */
  readonly backlog: boolean;
}

export interface PullRequestFilesReader {
  /**
   * Reads the conversation file on from the remembered place and gives the links; `null` = a stale read (`repoint`,
   * `close` meanwhile). The caller reads one at a time: parallel reads are not supported.
   */
  read(): Promise<PullRequestRead | null>;
  /** `/clear`, `/resume`: another conversation, another file — the set, the window and the offset from zero. */
  repoint(agentSessionId: string): void;
  /** The same file under a new path (`EnterWorktree`): only the path is dropped, the offset stays. */
  relocated(): void;
  close(): void;
}

export interface PullRequestFilesReaderOptions {
  cwd: string;
  agentSessionId: string;
  /**
   * Ścieżka pliku głównego, który czyta follower; `null` = jeszcze go nie zna. Driver podaje ją z followera, więc
   * czytnik patrzy w ten sam plik (także po przeniesieniu i w testach z magazynem tymczasowym) i nie szuka go sam.
   * Bez niej czytnik szuka pliku globem po uuid w `root`.
   */
  locate?: () => string | null;
  /** Korzeń magazynu CLI dla szukania bez `locate`. Domyślnie `~/.claude/projects`. */
  root?: string;
  /** Sufity odczytu; testy zmniejszają je do bajtów. */
  budgetBytes?: number;
  chunkBytes?: number;
  lineMaxBytes?: number;
  now?: () => number;
  logger?: (message: string) => void;
}

class Reader implements PullRequestFilesReader {
  readonly #root: string;
  readonly #cwd: string;
  readonly #budgetBytes: number;
  readonly #chunkBytes: number;
  readonly #lineMaxBytes: number;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #locate: (() => string | null) | undefined;
  #uuid: string;
  /** Ścieżka pliku głównego; `null` = trzeba jej szukać (pierwszy odczyt, `repoint`, `relocated`). */
  #mainPath: string | null = null;
  #cursor: FileCursor | undefined;
  #set: LinkedPullRequests = createLinkedPullRequests();
  /** The window's lower bound; found again when the file is read from the start. */
  #windowStart: string | null = null;
  /** Rośnie przy `repoint()` i `relocated()`; odczyt rozpoczęty wcześniej niczego nie oddaje. */
  #generation = 0;
  #closed = false;

  constructor(opts: PullRequestFilesReaderOptions) {
    this.#root = opts.root ?? defaultStoreRoot();
    this.#cwd = opts.cwd;
    this.#uuid = opts.agentSessionId;
    this.#locate = opts.locate;
    this.#chunkBytes = Math.max(1, opts.chunkBytes ?? PULL_REQUEST_CHUNK_BYTES);
    this.#budgetBytes = Math.max(this.#chunkBytes, opts.budgetBytes ?? PULL_REQUEST_SCAN_BUDGET_BYTES);
    this.#lineMaxBytes = Math.max(1, opts.lineMaxBytes ?? PULL_REQUEST_LINE_MAX_BYTES);
    this.#now = opts.now ?? Date.now;
    this.#log = opts.logger ?? ((message) => { console.warn(message); });
  }

  get #links(): PullRequestLinks {
    return { linked: this.#set.linked, windowStart: this.#windowStart };
  }

  async read(): Promise<PullRequestRead | null> {
    if (this.#closed) return null;
    const generation = this.#generation;
    const stale = (): boolean => this.#closed || generation !== this.#generation;
    if (this.#locate !== undefined) this.#mainPath = this.#locate();
    else if (this.#mainPath === null) {
      const found = await locateTranscript(this.#root, this.#cwd, this.#uuid);
      if (stale()) return null;
      this.#mainPath = found;
    }
    const mainPath = this.#mainPath;
    if (mainPath === null) return { links: this.#links, backlog: false };

    const startedAt = this.#now();
    const outcome = await this.#advance(mainPath, stale);
    if (stale()) return null;
    if (outcome.bytes >= PULL_REQUEST_SCAN_LOG_BYTES) {
      this.#log(
        `rarog: ${PULL_REQUEST_SCAN_LOG} ${this.#uuid}: ${String(outcome.bytes)} B `
        + `in ${String(Math.round(this.#now() - startedAt))} ms${outcome.more ? ', more in the next read' : ''}`,
      );
    }
    return { links: this.#links, backlog: outcome.more };
  }

  repoint(agentSessionId: string): void {
    this.#generation += 1;
    this.#uuid = agentSessionId;
    this.#mainPath = null;
    this.#cursor = undefined;
    this.#set = createLinkedPullRequests();
    this.#windowStart = null;
  }

  relocated(): void {
    this.#generation += 1;
    this.#mainPath = null;
  }

  close(): void {
    this.#closed = true;
    this.#cursor = undefined;
  }

  /**
   * Reads the file on by at most the byte budget. `bytes` = how much was read, `more` = the file has an unread part.
   * An error midway leaves the offset after the last handled chunk.
   */
  #advance(path: string, stale: () => boolean): Promise<{ bytes: number; more: boolean }> {
    const set = this.#set;
    return readIncrement<FileCursor>(path, {
      cursor: this.#cursor,
      // Other content under the same name, or a shorter file: read from the start. The set stays (the same URL again
      // adds nothing); the window is found again from the first lines.
      restart: (identity) => {
        const cursor = cursorAt(identity);
        this.#cursor = cursor;
        this.#windowStart = null;
        return cursor;
      },
      budgetBytes: this.#budgetBytes,
      chunkBytes: this.#chunkBytes,
      lineMaxBytes: this.#lineMaxBytes,
      stale,
      onLines: (lines) => {
        for (const line of lines) {
          if (this.#windowStart !== null && !mayCarryPullRequestLink(line)) continue;
          const entry = parseJsonlEntry(line.toString('utf8'));
          this.#windowStart ??= entryTimeOf(entry);
          const pr = pullRequestLinkOf(entry);
          if (pr !== null) set.add(pr);
        }
      },
    });
  }
}

export function createPullRequestFilesReader(opts: PullRequestFilesReaderOptions): PullRequestFilesReader {
  return new Reader(opts);
}
