/**
 * The index of a session's files (`GET /api/sessions/:id/files/index`): the session gate of the file routes, then a
 * breadth-first walk from the session directory in which every directory is read by the listing of the path rule
 * (`listing.ts`), so the index leaves out what a listing leaves out. In a repository `git ls-files` narrows the walk
 * to the files git does not ignore; git never adds a path, every path comes from a listing. Ceilings of files, body
 * bytes and time cut the walk with `truncated`. One walk at a time per session and directory: requests during it
 * get its answer. The module matches no query, reads no file and starts git only through the port's runner.
 */
import type { FileIndex } from '@rarog/shared';
import { MAX_FILE_ENTRIES } from '@rarog/shared';
import type { GitArgsResult, GitArgsRunner, GitCommand } from '../git-status.ts';
import { listSessionDir } from './listing.ts';
import { FILES_DISK, type FilesArea, type FilesDisk, type Ruled } from './path-rule.ts';
import { isClosedFolder } from './refusals.ts';
import { filesSession } from './session-gate.ts';
import type { SessionFilesPort } from './session-files.ts';

/** The answer of an index: the index, or the refusal the route sends. */
export type FileIndexAnswer = Ruled<FileIndex>;

/** The ceilings of one walk; past any of them the index comes cut, with `truncated: true`. */
export interface FileIndexLimits {
  /** Most paths in the index. */
  readonly maxFiles: number;
  /** Most bytes of the JSON body. */
  readonly maxBodyBytes: number;
  /** Soft time budget of the walk, the git read included, checked between two directories. */
  readonly budgetMs: number;
  /** Most entries taken from one directory (the ceiling of a listing). */
  readonly maxEntries: number;
}

export const FILE_INDEX_LIMITS: FileIndexLimits = {
  maxFiles: 20_000, maxBodyBytes: 2 * 1024 * 1024, budgetMs: 3_000, maxEntries: MAX_FILE_ENTRIES,
};

export interface FileIndexOptions {
  readonly limits?: Partial<FileIndexLimits>;
  /** Clock of the budget; default `Date.now`. */
  readonly now?: () => number;
  readonly disk?: FilesDisk;
}

/**
 * The files git does not ignore under the directory it runs in: tracked ones (`--cached`) and untracked ones that no
 * ignore rule matches (`--others --exclude-standard`), NUL-separated (`-z`), so a name is never quoted. A submodule
 * comes as one path (its gitlink) and an untracked nested repository as its path with a trailing `/`: git lists
 * neither's files.
 */
export const LS_FILES_COMMAND: GitCommand = {
  sub: 'ls-files', rest: ['-z', '--cached', '--others', '--exclude-standard'],
};

/**
 * What git keeps of one directory, by git's spelling of each name: the paths it listed there (files, and the
 * gitlink of a submodule), the untracked nested repositories (a path it printed with a trailing `/`), and the
 * directories above them.
 */
export interface GitDir {
  readonly listed: Set<string>;
  readonly repos: Set<string>;
  readonly dirs: Map<string, GitDir>;
}

const emptyDir = (): GitDir => ({ listed: new Set(), repos: new Set(), dirs: new Map() });

/** The tree from one `ls-files` read, or `null` when git did not answer it whole (then the walk keeps every file). */
export function gitScope(result: GitArgsResult): GitDir | null {
  if (result.exitCode !== 0 || result.capped === true || result.timedOut === true) return null;
  const top = emptyDir();
  for (const record of result.stdout.split('\0')) {
    if (record === '') continue;
    const repo = record.endsWith('/');
    const segments = (repo ? record.slice(0, -1) : record).split('/');
    const last = segments.pop() ?? '';
    let dir = top;
    for (const segment of segments) {
      const known = dir.dirs.get(segment);
      const next = known ?? emptyDir();
      if (known === undefined) dir.dirs.set(segment, next);
      dir = next;
    }
    (repo ? dir.repos : dir.listed).add(last);
  }
  return top;
}

/**
 * The key two spellings of one name share: the Unicode form (git on macOS reports a decomposed name composed,
 * `core.precomposeunicode`) and the letter case (`core.ignorecase` keeps a name renamed only in case under its old
 * spelling).
 */
const folded = (name: string): string => name.normalize('NFC').toLowerCase();

/**
 * The git names of one directory mapped to the names of its listing: a git name goes to the entry with exactly its
 * bytes, else to the one entry that no git name matched exactly and has the same folded key; with two or more such
 * entries, to none. An entry no git name maps to stays out, so two names on disk that one key would merge never
 * both enter on one git name.
 */
function matchNames(gitNames: Iterable<string>, diskNames: readonly string[]): Map<string, string[]> {
  const onDisk = new Set(diskNames);
  const mapped = new Map<string, string[]>();
  const add = (disk: string, name: string): void => {
    const names = mapped.get(disk);
    if (names === undefined) mapped.set(disk, [name]);
    else names.push(name);
  };
  const loose: string[] = [];
  for (const name of gitNames) {
    if (onDisk.has(name)) add(name, name);
    else loose.push(name);
  }
  if (loose.length === 0) return mapped;
  const byKey = new Map<string, string[]>();
  for (const disk of diskNames) {
    if (mapped.has(disk)) continue;
    const key = folded(disk);
    byKey.set(key, [...(byKey.get(key) ?? []), disk]);
  }
  for (const name of loose) {
    const candidates = byKey.get(folded(name)) ?? [];
    if (candidates.length === 1) add(candidates[0] as string, name);
  }
  return mapped;
}

/** Every git name of the directories `git` mapped to the names of a listing ({@link matchNames}). */
function namesOf(git: readonly GitDir[], diskNames: readonly string[]): Map<string, string[]> {
  const gitNames = new Set<string>();
  for (const one of git) for (const name of [...one.listed, ...one.repos, ...one.dirs.keys()]) gitNames.add(name);
  return matchNames(gitNames, diskNames);
}

/**
 * A directory waiting in the walk: the git directories it stands for, by git's spelling (`[]` when it is not
 * narrowed: inside a nested repository, or outside git).
 */
interface Pending {
  readonly rel: string;
  readonly narrowed: boolean;
  readonly git: readonly GitDir[];
}

/**
 * How a directory of a narrowed listing goes on, from the git names mapped to it: walked whole when git named it as a
 * path (a submodule's gitlink) or as a nested repository, walked narrowed when git has files under it, else not.
 */
function nextDir(git: readonly GitDir[], gitNames: readonly string[], rel: string): Pending | null {
  const below: GitDir[] = [];
  for (const one of git) {
    for (const name of gitNames) {
      if (one.listed.has(name) || one.repos.has(name)) return { rel, narrowed: false, git: [] };
      const dir = one.dirs.get(name);
      if (dir !== undefined) below.push(dir);
    }
  }
  return below.length === 0 ? null : { rel, narrowed: true, git: below };
}

/** The index under construction: the paths, the bytes of the body they make, and whether a ceiling cut it. */
class IndexBody {
  readonly paths: string[] = [];
  truncated = false;
  readonly #limits: FileIndexLimits;
  readonly #maxBytes: number;
  #bytes: number;

  constructor(limits: FileIndexLimits, maxBytes: number) {
    this.#limits = limits;
    this.#maxBytes = maxBytes;
    // The body with no path, `"truncated":false` being the longer of the two values.
    this.#bytes = Buffer.byteLength(JSON.stringify({ paths: [], truncated: false, maxBytes }));
  }

  /** Adds `rel`, or marks the body cut and returns `false` when it would pass a ceiling. */
  add(rel: string): boolean {
    const cost = Buffer.byteLength(JSON.stringify(rel)) + (this.paths.length === 0 ? 0 : 1);
    if (this.paths.length >= this.#limits.maxFiles || this.#bytes + cost > this.#limits.maxBodyBytes) {
      this.truncated = true;
      return false;
    }
    this.paths.push(rel);
    this.#bytes += cost;
    return true;
  }

  value(): FileIndex {
    return { paths: this.paths, truncated: this.truncated, maxBytes: this.#maxBytes };
  }
}

/**
 * The walk of the session directory of `area`. A directory whose listing is refused (swapped, gone) is skipped; a
 * refused session directory is the answer, and so is a guarded folder that closes during the walk: an index cut
 * there would read as complete. The budget runs from before the git read and is checked between two directories, so
 * the session directory is always listed.
 */
async function walk(
  area: FilesArea, maxBytes: number, run: GitArgsRunner, limits: FileIndexLimits, now: () => number, disk: FilesDisk,
): Promise<FileIndexAnswer> {
  const startedAt = now();
  let scope: GitDir | null;
  try {
    scope = gitScope(await run(LS_FILES_COMMAND, area.realCwd));
  } catch {
    scope = null;
  }
  const body = new IndexBody(limits, maxBytes);
  const queue: Pending[] = [{ rel: '', narrowed: scope !== null, git: scope === null ? [] : [scope] }];
  for (let next = 0; next < queue.length; next += 1) {
    if (next > 0 && now() - startedAt > limits.budgetMs) {
      body.truncated = true;
      break;
    }
    const dir = queue[next] as Pending;
    const listing = await listSessionDir(area, dir.rel, { maxBytes, maxEntries: limits.maxEntries }, disk);
    if (!listing.ok) {
      if (dir.rel === '' || isClosedFolder(listing.refusal)) return listing;
      continue;
    }
    if (listing.value.truncated) body.truncated = true;
    const names = dir.narrowed ? namesOf(dir.git, listing.value.entries.map((entry) => entry.name)) : null;
    for (const entry of listing.value.entries) {
      const rel = dir.rel === '' ? entry.name : `${dir.rel}/${entry.name}`;
      const gitNames = names?.get(entry.name);
      if (names !== null && gitNames === undefined) continue;
      if (entry.kind === 'dir') {
        const pending = gitNames === undefined ? { rel, narrowed: false, git: [] } : nextDir(dir.git, gitNames, rel);
        if (pending !== null) queue.push(pending);
        continue;
      }
      if (gitNames !== undefined && !dir.git.some((one) => gitNames.some((name) => one.listed.has(name)))) continue;
      if (!body.add(rel)) return { ok: true, value: body.value() };
    }
  }
  return { ok: true, value: body.value() };
}

/** The demo index: every file of the demo data its git does not ignore, breadth first as on a server. */
function demoIndex(maxBytes: number, entriesOf: SessionFilesPort['demoEntries']): FileIndexAnswer {
  const paths: string[] = [];
  const queue = [''];
  for (let next = 0; next < queue.length; next += 1) {
    const dir = queue[next] as string;
    for (const entry of entriesOf(dir) ?? []) {
      if (entry.ignored === true) continue;
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.kind === 'dir') queue.push(rel);
      else paths.push(rel);
    }
  }
  return { ok: true, value: { paths, truncated: false, maxBytes } };
}

/** What the index route asks of the indexer; a test of the route puts its own. */
export type FileIndexer = Pick<SessionFileIndex, 'index'>;

/** The index route's walks: one per session and directory at a time, never kept after it answers. */
export class SessionFileIndex {
  readonly #limits: FileIndexLimits;
  readonly #now: () => number;
  readonly #disk: FilesDisk;
  readonly #walks = new Map<string, Promise<FileIndexAnswer>>();

  constructor(opts: FileIndexOptions = {}) {
    this.#limits = { ...FILE_INDEX_LIMITS, ...opts.limits };
    this.#now = opts.now ?? (() => Date.now());
    this.#disk = opts.disk ?? FILES_DISK;
  }

  /**
   * The index of the session `id` with `maxBytes` announced. The gate runs for every request, before any disk call:
   * an unknown session throws the manager's 404 (`port.require`), a Codex entry, a pane out of scope and a session
   * without a pane are refused. A request while a walk of the same session directory runs gets that walk's answer.
   */
  index(id: string, maxBytes: number, port: SessionFilesPort): Promise<FileIndexAnswer> {
    let gate: ReturnType<typeof filesSession>;
    try {
      gate = filesSession(id, port, this.#disk.area);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (gate.kind === 'refused') return Promise.resolve({ ok: false, refusal: gate.refusal });
    if (gate.kind === 'demo') return Promise.resolve(demoIndex(maxBytes, port.demoEntries));
    const key = JSON.stringify([id, gate.area.realCwd, maxBytes]);
    const running = this.#walks.get(key);
    if (running !== undefined) return running;
    const started = walk(gate.area, maxBytes, port.run, this.#limits, this.#now, this.#disk).finally(() => {
      if (this.#walks.get(key) === started) this.#walks.delete(key);
    });
    this.#walks.set(key, started);
    return started;
  }
}
