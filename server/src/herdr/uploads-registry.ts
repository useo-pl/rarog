/**
 * Registry of the project directories where the server wrote attachments: `<dataDir>/uploads-dirs.json`.
 *
 * The start sweep of `.rarog-uploads` (`sweepAll` in `uploads.ts`) reads this list instead of walking the project
 * roots. The module only keeps the list: it neither reads nor deletes attachments. An entry is the real path of the
 * `<cwd>` of a write (the caller resolves it), and the sweep appends `.rarog-uploads` itself and skips an entry that
 * no longer resolves to itself, so an entry cannot point the sweep at another directory.
 * The file exists only after one complete walk of the roots, a part deferred until a guarded folder opens included: a
 * write that finds no file waits in memory until that walk writes it, so a server stopped before the walk ended walks
 * again at the next start.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { readRegularFile } from '../safe-read.ts';

/** Registry file name in `dataDir`. */
export const UPLOADS_REGISTRY_FILENAME = 'uploads-dirs.json';

/** File format version. */
const FORMAT = 1;

/** Read cap: a list of project paths stays far below it, a longer file is not ours. */
export const UPLOADS_REGISTRY_MAX_BYTES = 1024 * 1024;

/** Longest path an entry may hold; macOS `PATH_MAX` is 1024, Linux 4096. */
const MAX_ENTRY_CHARS = 4096;

/**
 * What the start sweep finds: `ok` with the entries, `missing` (no file yet) or `unreadable` (not a regular file,
 * over the cap, not JSON, another format, or an entry that is not an absolute path).
 */
export type UploadsRegistryState =
  | { readonly kind: 'ok'; readonly dirs: readonly string[] }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' };

export interface UploadsRegistry {
  /** Records `cwd`, the real path of a directory, after a successful attachment write. Never throws. */
  add(cwd: string): Promise<void>;
  /** Reads the registry for the start sweep; an unreadable file gives one log line. Never throws. */
  load(): Promise<UploadsRegistryState>;
  /** Number of the latest `add`; `drop` keeps a directory added after this mark. */
  mark(): number;
  /** Removes `dirs` from the file, except those added after `since`. Never throws. */
  drop(dirs: readonly string[], since: number): Promise<void>;
  /** Writes the file once the walk of the roots ended: `found`, plus every directory added meanwhile. Never throws. */
  rebuild(found: readonly string[]): Promise<void>;
}

export interface UploadsRegistryOptions {
  /** Server data directory (`config.dataDir`). */
  readonly dataDir: string;
}

/** File text → entries; `null` = not the registry's shape. Duplicates collapse. */
function parseRegistry(text: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const dirs = record['dirs'];
  if (record['format'] !== FORMAT || !Array.isArray(dirs)) return null;
  const out = new Set<string>();
  for (const dir of dirs) {
    if (!isEntry(dir)) return null;
    out.add(dir);
  }
  return [...out];
}

/** An entry is an absolute path without NUL: a relative one would resolve against the server's own cwd. */
function isEntry(dir: unknown): dir is string {
  return typeof dir === 'string' && dir.length <= MAX_ENTRY_CHARS && isAbsolute(dir) && !dir.includes('\0');
}

/** File system error code for a log line (no path, no content). */
function codeOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'error';
}

class Registry implements UploadsRegistry {
  readonly #dataDir: string;
  readonly #file: string;
  /** Directories not yet in the file: added while it was missing or unreadable, or after a failed write. */
  readonly #pending = new Set<string>();
  /** Number of the latest `add` per directory, compared with a `mark`. */
  readonly #addedAt = new Map<string, number>();
  #seq = 0;
  /** One chain for every read-modify-write of the file, so parallel uploads do not lose entries. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(opts: UploadsRegistryOptions) {
    this.#dataDir = opts.dataDir;
    this.#file = join(opts.dataDir, UPLOADS_REGISTRY_FILENAME);
  }

  add(cwd: string): Promise<void> {
    if (!isEntry(cwd)) return Promise.resolve();
    this.#seq += 1;
    this.#addedAt.set(cwd, this.#seq);
    this.#pending.add(cwd);
    return this.#enqueue(async () => {
      // An earlier step of the chain already wrote it.
      if (!this.#pending.has(cwd)) return;
      const state = await this.#read();
      // No file yet: the entry waits for the first-start walk, which writes the file with it.
      if (state.kind !== 'ok') return;
      const known = new Set(state.dirs);
      if ([...this.#pending].every((dir) => known.has(dir))) {
        this.#pending.clear();
        return;
      }
      await this.#write(state.dirs);
    }, undefined);
  }

  load(): Promise<UploadsRegistryState> {
    return this.#enqueue(async () => {
      const state = await this.#read();
      if (state.kind === 'unreadable') {
        console.warn(`rarog: uploads registry ${UPLOADS_REGISTRY_FILENAME} is unreadable; `
          + 'walking the project roots once to rebuild it.');
      }
      return state;
    }, { kind: 'unreadable' });
  }

  mark(): number {
    return this.#seq;
  }

  drop(dirs: readonly string[], since: number): Promise<void> {
    return this.#enqueue(async () => {
      const state = await this.#read();
      if (state.kind !== 'ok') return;
      // A directory added after the mark may hold a file the sweep did not see yet.
      const leaving = new Set(dirs.filter((dir) => (this.#addedAt.get(dir) ?? 0) <= since));
      const next = state.dirs.filter((dir) => !leaving.has(dir));
      if (next.length === state.dirs.length && this.#pending.size === 0) return;
      await this.#write(next);
    }, undefined);
  }

  rebuild(found: readonly string[]): Promise<void> {
    return this.#enqueue(async () => {
      const state = await this.#read();
      const current = state.kind === 'ok' ? state.dirs : [];
      await this.#write([...current, ...found.filter(isEntry)]);
    }, undefined);
  }

  /**
   * One step of the chain. Steps catch their own file errors; anything else becomes one log line and `fallback`,
   * so neither the chain nor the caller (an upload, the start sweep) sees an exception.
   */
  #enqueue<T>(step: () => Promise<T>, fallback: T): Promise<T> {
    const run = this.#chain.then(step).catch((err: unknown) => {
      console.warn(`rarog: uploads registry step failed (${codeOf(err)}).`);
      return fallback;
    });
    this.#chain = run;
    return run;
  }

  async #read(): Promise<UploadsRegistryState> {
    let text: string;
    try {
      // Regular files only: a FIFO, a device or a symlink under this name is an unreadable registry.
      const read = await readRegularFile(this.#file, { maxBytes: UPLOADS_REGISTRY_MAX_BYTES, followSymlink: false });
      if (read === null || read.truncated) return { kind: 'unreadable' };
      text = read.bytes.toString('utf8');
    } catch (err) {
      return codeOf(err) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
    }
    const dirs = parseRegistry(text);
    return dirs === null ? { kind: 'unreadable' } : { kind: 'ok', dirs };
  }

  /** Atomic write (temporary file, then `rename`) of `dirs` plus the pending entries; `0600` in a `0700` directory. */
  async #write(dirs: readonly string[]): Promise<void> {
    const entries = [...new Set([...dirs, ...this.#pending])];
    const body = `${JSON.stringify({ format: FORMAT, dirs: entries })}\n`;
    const tmp = join(this.#dataDir, `.${UPLOADS_REGISTRY_FILENAME}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(tmp, this.#file);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      console.warn(`rarog: uploads registry ${UPLOADS_REGISTRY_FILENAME} not written (${codeOf(err)}).`);
      return;
    }
    // Only what this write carried: an `add` that arrived during the write stays pending for its own step.
    for (const dir of entries) this.#pending.delete(dir);
  }
}

export function createUploadsRegistry(opts: UploadsRegistryOptions): UploadsRegistry {
  return new Registry(opts);
}
