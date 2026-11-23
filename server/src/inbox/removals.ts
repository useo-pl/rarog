/**
 * Removals of Inbox cards in `<dataDir>/inbox.json`: which card a person removed, never what it said. An entry is a
 * removal key (`card.ts`) with the session it belongs to and whether the removal received the result. Writes are
 * atomic (temporary file and `rename`, `0o600`) and run one after another; each write tells its caller whether it
 * landed, and the entries in memory change only after a landed write. A missing or broken file, or one of another
 * format, is an empty store.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readRegularFileSync } from '../safe-read.ts';
import type { InboxCardKind, InboxDialog, RemovalKey } from './card.ts';

/** Name of the store file in `config.dataDir`. */
export const INBOX_FILENAME = 'inbox.json';

/**
 * Format of the file. Another value (or none) = a file of a newer or foreign Rarog: it reads as an empty store with one
 * log line, and the first write replaces it with this format. The cost is removed cards that come back.
 */
export const INBOX_FORMAT = 1;

/** Entries of closed or vanished sessions kept for a resume; past this the oldest go first. */
export const INBOX_CLOSED_LIMIT = 500;

/** Read ceiling of the file; a longer file counts as broken (a full store is far below it). */
const FILE_MAX_BYTES = 1024 * 1024;
const FILE_MODE = 0o600;

const CARD_KINDS: readonly InboxCardKind[] = ['result', 'decision', 'failed'];
const DIALOG_KINDS: readonly InboxDialog['kind'][] = ['permission', 'question', 'panel'];

export interface RemovalEntry extends RemovalKey {
  readonly sessionId: string;
  /** The removal received the result of a `waiting-input` session; a restore takes that receipt back. */
  readonly seen?: true;
}

export interface RemovalStoreOptions {
  readonly dataDir: string;
  /** Whether a session is open; entries of the other sessions count against {@link INBOX_CLOSED_LIMIT}. */
  readonly isOpen: (sessionId: string) => boolean;
  readonly log: (line: string) => void;
}

/** Map key of a removal key. */
function slot(key: RemovalKey): string {
  return JSON.stringify([key.turnId, key.card, key.dialog ?? '', key.dialogId ?? '', key.since ?? '']);
}

function entryOf(raw: unknown): RemovalEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e['sessionId'] !== 'string' || e['sessionId'] === '') return null;
  if (typeof e['turnId'] !== 'string' || e['turnId'] === '') return null;
  const card = CARD_KINDS.find((kind) => kind === e['card']);
  if (card === undefined) return null;
  const dialog = DIALOG_KINDS.find((kind) => kind === e['dialog']);
  return {
    sessionId: e['sessionId'], turnId: e['turnId'], card,
    ...(dialog === undefined ? {} : { dialog }),
    ...(typeof e['dialogId'] === 'string' && e['dialogId'] !== '' ? { dialogId: e['dialogId'] } : {}),
    ...(typeof e['since'] === 'string' ? { since: e['since'] } : {}),
    ...(e['seen'] === true ? { seen: true as const } : {}),
  };
}

/** The entries of the file; anything wrong with it gives an empty store, never an exception. */
function load(file: string, log: (line: string) => void): Map<string, RemovalEntry> {
  const entries = new Map<string, RemovalEntry>();
  let parsed: unknown;
  try {
    const read = readRegularFileSync(file, { maxBytes: FILE_MAX_BYTES, followSymlink: false });
    if (read === null || read.truncated) return entries;
    parsed = JSON.parse(read.bytes.toString('utf8'));
  } catch {
    // No file yet, or a broken one: an empty store costs at most removed cards that come back.
    return entries;
  }
  const body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as { format?: unknown; removed?: unknown }
    : null;
  if (body?.format !== INBOX_FORMAT || !Array.isArray(body.removed)) {
    log(`inbox: unknown ${INBOX_FILENAME} format, removals start empty`);
    return entries;
  }
  for (const raw of body.removed) {
    const entry = entryOf(raw);
    if (entry !== null) entries.set(slot(entry), entry);
  }
  return entries;
}

/** Outcome of {@link RemovalStore.delete}: the entry it removed, `absent`, or `failed` (nothing changed). */
export type RemovalDelete = { readonly entry: RemovalEntry } | 'absent' | 'failed';

export class RemovalStore {
  readonly #file: string;
  readonly #isOpen: (sessionId: string) => boolean;
  readonly #log: (line: string) => void;
  #entries: Map<string, RemovalEntry>;
  #chain: Promise<void> = Promise.resolve();

  constructor(opts: RemovalStoreOptions) {
    this.#file = path.join(opts.dataDir, INBOX_FILENAME);
    this.#isOpen = opts.isOpen;
    this.#log = opts.log;
    this.#entries = load(this.#file, opts.log);
  }

  has(key: RemovalKey): boolean {
    return this.#entries.has(slot(key));
  }

  /** Stores a removal; `present` when the key is already stored (nothing written). */
  add(entry: RemovalEntry): Promise<'added' | 'present' | 'failed'> {
    return this.#step((current) => {
      if (current.has(slot(entry))) return { result: 'present' as const };
      const next = new Map(current);
      next.set(slot(entry), entry);
      return { next, result: 'added' as const };
    });
  }

  /** Stores `entry` under its key in place of the entry there; `absent` when there is none (nothing written). */
  replace(entry: RemovalEntry): Promise<'replaced' | 'absent' | 'failed'> {
    return this.#step((current) => {
      if (!current.has(slot(entry))) return { result: 'absent' as const };
      const next = new Map(current);
      next.set(slot(entry), entry);
      return { next, result: 'replaced' as const };
    });
  }

  /** Removes a removal. */
  delete(key: RemovalKey): Promise<RemovalDelete> {
    return this.#step<RemovalDelete>((current) => {
      const entry = current.get(slot(key));
      if (entry === undefined) return { result: 'absent' };
      const next = new Map(current);
      next.delete(slot(key));
      return { next, result: { entry } };
    });
  }

  /** Drops the session's entries of every turn but `turnId`: its card moved on, so they can never match again. */
  keepTurn(sessionId: string, turnId: string): Promise<void> {
    return this.#step((current) => {
      const stale = [...current].filter(([, e]) => e.sessionId === sessionId && e.turnId !== turnId);
      if (stale.length === 0) return { result: undefined };
      const next = new Map(current);
      for (const [key] of stale) next.delete(key);
      return { next, result: undefined };
    }).then(() => undefined);
  }

  /** Settles once every write asked for so far has landed or failed. */
  flush(): Promise<void> {
    return this.#chain;
  }

  /**
   * One step of the write chain: `plan` reads the entries in memory when the step runs and returns the next entries
   * (or none: nothing to write). The chain never rejects, so a failed write does not stop the next one, yet the
   * caller of this step gets `failed`.
   */
  #step<T>(
    plan: (current: ReadonlyMap<string, RemovalEntry>) => { readonly next?: Map<string, RemovalEntry>; readonly result: T },
  ): Promise<T | 'failed'> {
    const run = this.#chain.then(async (): Promise<T | 'failed'> => {
      const { next, result } = plan(this.#entries);
      if (next === undefined) return result;
      const capped = this.#capClosed(next);
      try {
        await this.#write(capped);
      } catch (err) {
        this.#log(`inbox: ${INBOX_FILENAME} write failed (${err instanceof Error ? err.message : String(err)}),`
          + ' removals stay as they were');
        return 'failed';
      }
      this.#entries = capped;
      return result;
    });
    this.#chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Keeps at most {@link INBOX_CLOSED_LIMIT} entries of sessions that are not open, the newest ones. */
  #capClosed(entries: Map<string, RemovalEntry>): Map<string, RemovalEntry> {
    const closed = [...entries].filter(([, e]) => !this.#isOpen(e.sessionId));
    if (closed.length <= INBOX_CLOSED_LIMIT) return entries;
    const capped = new Map(entries);
    for (const [key] of closed.slice(0, closed.length - INBOX_CLOSED_LIMIT)) capped.delete(key);
    return capped;
  }

  async #write(entries: ReadonlyMap<string, RemovalEntry>): Promise<void> {
    const payload = `${JSON.stringify({ format: INBOX_FORMAT, removed: [...entries.values()] })}\n`;
    const tmp = `${this.#file}.tmp`;
    await mkdir(path.dirname(this.#file), { recursive: true });
    await writeFile(tmp, payload, { encoding: 'utf8', mode: FILE_MODE });
    await rename(tmp, this.#file);
  }
}
