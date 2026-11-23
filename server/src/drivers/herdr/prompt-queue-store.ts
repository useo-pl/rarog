/**
 * The paste queue on disk: a message accepted while a turn runs survives a server restart
 * until its first paste, and a message whose paste or Enter has no known outcome comes back only as a note.
 *
 * The module owns `prompt-queue.json` in the data directory: entries `queued` (engine session id, text) and `pasted`
 * (engine session id, no text: from the first paste the text lives in the CLI field, not in the file); both keep the
 * sender of a voice agent message (`source`), and a queued one is dropped at load while the voice agent's sends are
 * off ({@link PromptQueueStoreOptions.voiceAgentSends}). It does not paste, check or send; the queue
 * (`prompt-queue.ts`) calls it and lets a message out only after a write this module reports as done. Writes are atomic
 * (tmp + rename, `0o600`) and serialized; a corrupt or unknown file is moved aside to `prompt-queue.json.bad`, never
 * read as a queue and never thrown on.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MessageSource } from '@rarog/shared/rest';
import { readRegularFileSync } from '../../safe-read.ts';
import { systemScheduler } from '../runtime.ts';
import type { Scheduler } from '../runtime.ts';

/** File name in `dataDir`. `server/test/docs-zgodnosc.test.ts` checks the data directory list in the docs. */
export const PROMPT_QUEUE_FILENAME = 'prompt-queue.json';

/** File format. Any other value = a file of a newer (or foreign) Rarog: moved aside, the queue starts empty. */
export const PROMPT_QUEUE_FORMAT = 1;

/**
 * Oldest entry that still goes out after a restart: the echo window of the follower (`ECHO_TTL_MS`, 6 h). An older
 * message pasted into the pane now would surprise more than it helps; it is dropped with a log line.
 */
export const PROMPT_QUEUE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

/**
 * How long after the first full resync a pane of the same engine session may still claim its restored entries. The
 * resync tick is 30 s; a session no pane runs by then is gone and its messages are dropped with a log line.
 */
export const PROMPT_QUEUE_CLAIM_GRACE_MS = 30_000;

/** File read cap: a queue of a few messages of at most 64 KiB each fits with a wide margin. */
const READ_MAX_BYTES = 8 * 1024 * 1024;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const ID_MAX_LENGTH = 128;

/**
 * `session` is the engine session id (Claude Code): a pane address is positional and moves. `source` is the sender of
 * a voice agent message (`MessageBody.source`), absent for any other message; a file without it reads as before.
 */
type Entry =
  | {
    readonly session: string; readonly state: 'queued'; readonly text: string; readonly at: number;
    readonly source?: MessageSource;
  }
  | { readonly session: string; readonly state: 'pasted'; readonly at: number; readonly source?: MessageSource };

/** A restored queued message: its id, text and, for a voice agent message, its sender. */
export interface RestoredPrompt {
  readonly id: string;
  readonly text: string;
  readonly source?: MessageSource;
}

/** Entries of one engine session from the file read at start: queued messages in order and pasted marks. */
export interface RestoredPrompts {
  readonly queued: readonly RestoredPrompt[];
  readonly pasted: readonly string[];
}

/** Write results: `true` = a write holding the change succeeded; `false` = it failed (log line) or the store closed. */
export interface PromptQueueStore {
  /** A new `queued` entry of the engine session `session`, written at once; `source` = the sender, if known. */
  add(session: string, text: string, source?: MessageSource): { readonly id: string; readonly written: Promise<boolean> };
  /**
   * The first paste is about to start: the entry loses its text. Only `true` lets the paste go: after `false` the
   * text may still be on disk, and a restart would paste it a second time.
   */
  pasted(id: string): Promise<boolean>;
  /** The paste did not start after all: a `pasted` entry gets its text back, so a restart sends it. */
  requeue(id: string, text: string): Promise<boolean>;
  /** The entry's outcome is known (sent, refused, confirmed, noted): it leaves the file. Unknown id = no-op. */
  settle(id: string): void;
  /**
   * The entries were taken back from the queue: they leave the file, and the caller awaits the write. After `false`
   * the entries are back with their id, state and place, so the next write holds them again. Unknown ids are skipped.
   */
  remove(ids: readonly string[]): Promise<boolean>;
  /** Entries of the engine session `session` read from the file at start, handed out once. */
  restore(session: string): RestoredPrompts;
  /**
   * {@link PROMPT_QUEUE_CLAIM_GRACE_MS} after `ready` (the first full resync), restored entries no driver claimed
   * leave the file with one "not sent" log line per engine session.
   */
  expireUnclaimedAfter(ready: Promise<unknown>, graceMs?: number): void;
  /** Server shutdown: no more changes, so the file stays for the next start; settles after the write in flight. */
  close(): Promise<void>;
}

export interface PromptQueueStoreOptions {
  readonly dataDir: string;
  readonly now?: () => number;
  readonly scheduler?: Scheduler;
  /** Read and write failures: file names, counts and engine session ids only, never message text. */
  readonly logger?: (line: string) => void;
  /**
   * The voice agent's sends are on at this start: the voice agent and its mode across sessions, the condition of the
   * message route's gate for a body with `source`. Otherwise a `queued` entry with a sender leaves the file at load
   * with one log line, so the flags that refuse the agent's sends also take its queued messages; a `pasted` mark
   * stays, because it sends no key and its note is the owner's trace. Absent = off.
   */
  readonly voiceAgentSends?: boolean;
}

export function promptQueuePath(dataDir: string): string {
  return join(dataDir, PROMPT_QUEUE_FILENAME);
}

const isText = (value: unknown, max = Infinity): value is string =>
  typeof value === 'string' && value !== '' && value.length <= max;

/** `{source}` of a known sender, otherwise nothing: an entry with another value restores as a message without one. */
const sourceField = (source: unknown): { source?: MessageSource } =>
  (source === 'voice-agent' ? { source } : {});

/** One file entry or `null` (an entry without a complete set of fields is skipped). */
function entryOf(item: unknown): [string, Entry] | null {
  if (typeof item !== 'object' || item === null) return null;
  const raw = item as { id?: unknown; session?: unknown; state?: unknown; text?: unknown; at?: unknown; source?: unknown };
  if (!isText(raw.id, ID_MAX_LENGTH) || !isText(raw.session, ID_MAX_LENGTH)) return null;
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null;
  if (raw.state === 'queued' && isText(raw.text)) {
    return [raw.id, { session: raw.session, state: 'queued', text: raw.text, at: raw.at, ...sourceField(raw.source) }];
  }
  if (raw.state === 'pasted') {
    return [raw.id, { session: raw.session, state: 'pasted', at: raw.at, ...sourceField(raw.source) }];
  }
  return null;
}

/** Parsed entries, or `null` for a file that is not a format-1 queue. */
function parse(text: string): [string, Entry][] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as { format?: unknown; entries?: unknown };
  if (body.format !== PROMPT_QUEUE_FORMAT || !Array.isArray(body.entries)) return null;
  return body.entries.map(entryOf).filter((entry): entry is [string, Entry] => entry !== null);
}

const codeOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'error';
};

export function createPromptQueueStore(opts: PromptQueueStoreOptions): PromptQueueStore {
  const file = promptQueuePath(opts.dataDir);
  const now = opts.now ?? ((): number => Date.now());
  const scheduler = opts.scheduler ?? systemScheduler;
  const log = (line: string): void => {
    try {
      opts.logger?.(line);
    } catch {
      // The log does not stop the queue.
    }
  };
  const entries = new Map<string, Entry>();
  /** Entries read at start, by engine session, until a driver claims them ({@link restore}) or they expire. */
  const pool = new Map<string, string[]>();
  let closed = false;
  let chain: Promise<unknown> = Promise.resolve();
  let next: Promise<boolean> | null = null;

  const moveAside = (why: string): void => {
    try {
      renameSync(file, `${file}.bad`);
      log(`prompt-queue: ${why} — moved to ${PROMPT_QUEUE_FILENAME}.bad, the queue starts empty`);
    } catch (err) {
      log(`prompt-queue: ${why} (${codeOf(err)} on move) — the queue starts empty`);
    }
  };

  const load = (): void => {
    let text: string;
    try {
      // The regular-file gate: a FIFO or a device under this name is an unreadable file, not a hung read.
      const read = readRegularFileSync(file, { maxBytes: READ_MAX_BYTES, followSymlink: false });
      if (read === null || read.truncated) {
        moveAside(read === null ? 'not a regular file' : 'file over the size cap');
        return;
      }
      text = read.bytes.toString('utf8');
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') log(`prompt-queue: read failed (${codeOf(err)}) — the queue starts empty`);
      return;
    }
    const list = parse(text);
    if (list === null) {
      moveAside('corrupt file or unknown format');
      return;
    }
    const at = now();
    let stale = 0;
    let marked = 0;
    for (const [id, entry] of list) {
      if (entry.state === 'queued' && at - entry.at >= PROMPT_QUEUE_MAX_AGE_MS) {
        stale += 1;
        continue;
      }
      if (entry.state === 'queued' && entry.source !== undefined && opts.voiceAgentSends !== true) {
        marked += 1;
        continue;
      }
      entries.set(id, entry);
      const ids = pool.get(entry.session) ?? [];
      ids.push(id);
      pool.set(entry.session, ids);
    }
    if (stale > 0) log(`prompt-queue: ${String(stale)} message(s) older than the restore cap not sent`);
    if (marked > 0) {
      log(`prompt-queue: ${String(marked)} voice agent message(s) not sent: the voice agent's sends are off`);
    }
    if (stale + marked > 0) void persist();
  };

  /*
   * The snapshot is taken when a write STARTS, as in the send registry: a write waiting in the chain covers every
   * change made before it starts, and each caller's promise settles with the result of a write that contains its change.
   */
  function persist(): Promise<boolean> {
    if (closed) return Promise.resolve(false);
    if (next !== null) return next;
    const write = chain.then(async (): Promise<boolean> => {
      next = null;
      const payload = `${JSON.stringify({
        format: PROMPT_QUEUE_FORMAT,
        entries: [...entries].map(([id, entry]) => ({ id, ...entry })),
      })}\n`;
      const tmp = join(opts.dataDir, `.${PROMPT_QUEUE_FILENAME}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        await mkdir(opts.dataDir, { recursive: true, mode: DIR_MODE });
        await writeFile(tmp, payload, { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' });
        await rename(tmp, file);
        return true;
      } catch (err) {
        await unlink(tmp).catch(() => undefined);
        log(`prompt-queue: write failed (${codeOf(err)}) — ${String(entries.size)} entr(y/ies) kept in RAM only`);
        return false;
      }
    });
    next = write;
    chain = write;
    return write;
  }

  load();

  const store: PromptQueueStore = {
    add(session, text, source) {
      const id = randomUUID();
      if (!closed) entries.set(id, { session, state: 'queued', text, at: now(), ...sourceField(source) });
      return { id, written: persist() };
    },
    pasted(id) {
      const entry = entries.get(id);
      if (entry?.state === 'queued') {
        entries.set(id, { session: entry.session, state: 'pasted', at: entry.at, ...sourceField(entry.source) });
      }
      return persist(); // Also after a failed write of the same change: no paste until the file has no text.
    },
    requeue(id, text) {
      const entry = entries.get(id);
      if (closed || entry?.state !== 'pasted') return Promise.resolve(false);
      entries.set(id, { session: entry.session, state: 'queued', text, at: entry.at, ...sourceField(entry.source) });
      return persist();
    },
    settle(id) {
      if (closed || !entries.delete(id)) return;
      void persist();
    },
    async remove(ids) {
      if (closed) return false;
      const order = [...entries.keys()];
      const taken = new Map<string, Entry>();
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry === undefined) continue;
        taken.set(id, entry);
        entries.delete(id);
      }
      const written = await persist();
      if (!written && taken.size > 0) {
        // Back in the order they had, around entries changed meanwhile; entries added meanwhile stay at the end.
        const now = new Map(entries);
        entries.clear();
        for (const id of order) {
          const entry = taken.get(id) ?? now.get(id);
          if (entry === undefined) continue;
          entries.set(id, entry);
          now.delete(id);
        }
        for (const [id, entry] of now) entries.set(id, entry);
      }
      return written;
    },
    restore(session) {
      const ids = pool.get(session) ?? [];
      pool.delete(session);
      const queuedOut: RestoredPrompt[] = [];
      const pastedOut: string[] = [];
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry === undefined) continue;
        if (entry.state === 'queued') queuedOut.push({ id, text: entry.text, ...sourceField(entry.source) });
        else pastedOut.push(id);
      }
      return { queued: queuedOut, pasted: pastedOut };
    },
    expireUnclaimedAfter(ready, graceMs = PROMPT_QUEUE_CLAIM_GRACE_MS) {
      const expire = (): void => {
        for (const [session, ids] of pool) {
          const live = ids.filter((id) => entries.delete(id));
          if (live.length > 0) log(`prompt-queue: ${String(live.length)} message(s) for session ${session} not sent: `
            + 'no pane runs it after the restart');
        }
        pool.clear();
        void persist();
      };
      if (pool.size === 0) return;
      void ready.catch(() => undefined).then(() => {
        const timer = scheduler.setTimeout(() => { if (!closed) expire(); }, graceMs);
        // The grace timer does not keep a stopping server alive.
        (timer as { unref?: () => void }).unref?.();
      });
    },
    close() {
      closed = true;
      return chain.then(() => undefined);
    },
  };
  return store;
}
