/**
 * The state of each macOS-guarded folder: whether a call in it goes to its helper or is refused without the disk.
 * The gate takes the events of the port's calls (`report`) and the late answers of the client, checks a folder with
 * a helper, kills a hung helper and checks again on a new one, rechecks a closed folder on a timer and tells
 * listeners about each change. A folder nobody judged yet opens on the first listing or read its helper answers, so a
 * folder with consent needs no check of its own. It never touches the disk itself and starts no helper on its own:
 * the client does.
 */
import path from 'node:path';
import { gatedFolderOf } from './folders.ts';
import type { FolderBlock, FolderClient, FolderGate, FolderState, HelperAnswer } from './types.ts';

/** How often a waiting folder is checked again on a new helper. */
export const FOLDER_RECHECK_MS = 60_000;
/** How often a denied, absent or unchecked folder is checked again; after a refusal macOS answers at once. */
export const FOLDER_RECHECK_SLOW_MS = 5 * 60_000;

export interface MacFolderGateOptions {
  /** The home directory the guarded folders lie in. */
  readonly home: string;
  readonly client: FolderClient;
  /** The client's bound on one call, named in the log line of a folder that did not answer. */
  readonly boundMs: number;
  readonly log?: (line: string) => void;
}

/** Why a check runs: right after a timeout (an OK then means a slow read), on the recheck timer, or on request. */
type RunKind = 'after-timeout' | 'recheck' | 'request';

interface Run {
  readonly kind: RunKind;
}

interface Entry {
  readonly folder: string;
  readonly name: string;
  state: FolderState;
  since: string;
  /** The newest helper generation the gate started; `undefined` until its first restart. */
  gen: number | undefined;
  /** The check in flight; its answer counts only while it is still this one. */
  run: Run | undefined;
  timer: NodeJS.Timeout | undefined;
  /** Callers of `check` waiting for a settled state. */
  readonly waiters: Set<() => void>;
}

const BLOCKED_STATES: ReadonlySet<FolderState> = new Set(['waiting', 'denied', 'unchecked']);
const DENIED_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES']);
const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/** The state a check answer leads to, with the reason for the log line. */
function checkOutcome(answer: HelperAnswer<unknown>, boundMs: number): { state: FolderState; reason: string } {
  switch (answer.kind) {
    case 'ok':
      return { state: 'open', reason: '' };
    case 'timeout':
      return { state: 'waiting', reason: `no answer in ${boundMs} ms` };
    case 'gone':
      return { state: 'unchecked', reason: 'helper gone' };
    case 'fs-error': {
      const code = answer.error.code ?? 'no code';
      if (DENIED_CODES.has(code)) return { state: 'denied', reason: code };
      if (ABSENT_CODES.has(code)) return { state: 'absent', reason: code };
      return { state: 'unchecked', reason: code };
    }
  }
}

export class MacFolderGate implements FolderGate {
  readonly enabled = true;
  readonly #home: string;
  readonly #client: FolderClient;
  readonly #boundMs: number;
  readonly #log: (line: string) => void;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<(folder: string, state: FolderState) => void>();
  readonly #offLate: () => void;
  #disposed = false;

  constructor(options: MacFolderGateOptions) {
    this.#home = options.home;
    this.#client = options.client;
    this.#boundMs = options.boundMs;
    this.#log = options.log ?? (() => undefined);
    // The gate's own check times out at the client's bound while the helper keeps waiting on the macOS window; the
    // answer to the click arrives only as a late answer.
    this.#offLate = this.#client.onLate((folder, gen, answer) => {
      if (answer.kind === 'ok') this.report(folder, gen, 'late-ok');
      else if (answer.kind === 'fs-error' && DENIED_CODES.has(answer.error.code ?? '')) this.report(folder, gen, 'eperm');
    });
  }

  stateOf(candidate: string): { folder: string; state: FolderState } | null {
    const folder = gatedFolderOf(candidate, this.#home);
    if (folder === null) return null;
    return { folder, state: this.#entries.get(folder)?.state ?? 'unknown' };
  }

  report(folder: string, gen: number, event: 'timeout' | 'eperm' | 'late-ok' | 'gone' | 'ok'): void {
    if (this.#disposed) return;
    const entry = this.#entry(folder);
    if (entry.gen !== undefined && gen < entry.gen) {
      this.#log(`folder gate: ${entry.name} ignores ${event} of helper generation ${gen} (current ${entry.gen})`);
      return;
    }
    const passable = entry.state === 'unknown' || entry.state === 'open';
    switch (event) {
      case 'timeout':
        // Only the first timeout kills and retries; later ones of calls already in flight change nothing.
        if (!passable) return;
        this.#enter(entry, 'waiting', `no answer in ${this.#boundMs} ms`);
        this.#startRun(entry, 'after-timeout', true);
        return;
      case 'eperm':
        if (entry.run === undefined) this.#startRun(entry, 'request', true);
        return;
      case 'gone':
        if (passable && entry.run === undefined) this.#startRun(entry, 'request', true);
        return;
      case 'ok':
        // An answer proves access only where no one judged the folder; a closed folder opens by a check or a late
        // answer, and a check in flight still settles its callers.
        if (entry.state !== 'unknown') return;
        this.#enter(entry, 'open', 'a call answered');
        return;
      case 'late-ok':
        if (entry.state === 'open') return;
        // A check still in flight would answer for a moment that has passed.
        entry.run = undefined;
        this.#enter(entry, 'open', 'a late answer');
        this.#settle(entry);
        this.#schedule(entry);
        return;
    }
  }

  check(folder: string, waitMs: number): Promise<FolderState> {
    const entry = this.#entry(folder);
    if (this.#disposed) return Promise.resolve(entry.state);
    // A helper of a closed folder may hang on a window or be gone, so a check there starts a new one.
    if (entry.run === undefined) this.#startRun(entry, 'request', entry.state !== 'unknown' && entry.state !== 'open');
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        entry.waiters.delete(done);
        resolve(entry.state);
      };
      const timer = setTimeout(done, waitMs);
      timer.unref();
      entry.waiters.add(done);
    });
  }

  blocked(): FolderBlock[] {
    const out: FolderBlock[] = [];
    for (const entry of this.#entries.values()) {
      if (!BLOCKED_STATES.has(entry.state)) continue;
      out.push({ name: entry.name, path: entry.folder, state: entry.state as FolderBlock['state'], since: entry.since });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  onChange(listener: (folder: string, state: FolderState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Stops timers and listening; the client and its helpers belong to whoever made them. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#offLate();
    for (const entry of this.#entries.values()) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.run = undefined;
      this.#settle(entry);
    }
    this.#listeners.clear();
  }

  #entry(folder: string): Entry {
    let entry = this.#entries.get(folder);
    if (entry === undefined) {
      entry = {
        folder, name: path.basename(folder), state: 'unknown', since: new Date().toISOString(), gen: undefined,
        run: undefined, timer: undefined, waiters: new Set(),
      };
      this.#entries.set(folder, entry);
    }
    return entry;
  }

  /** Starts a check of the folder, on a new helper generation when `fresh`; it replaces any check in flight. */
  #startRun(entry: Entry, kind: RunKind, fresh: boolean): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (fresh) entry.gen = this.#client.restart(entry.folder);
    const run: Run = { kind };
    entry.run = run;
    this.#client.call(entry.folder, 'check', { path: entry.folder }).then(
      (answer) => { this.#finish(entry, run, answer); },
      () => { this.#finish(entry, run, { kind: 'gone' }); },
    );
  }

  #finish(entry: Entry, run: Run, answer: HelperAnswer<unknown>): void {
    if (this.#disposed) return;
    if (entry.run !== run) {
      this.#log(`folder gate: ${entry.name} drops the answer of a superseded check`);
      return;
    }
    entry.run = undefined;
    const outcome = checkOutcome(answer, this.#boundMs);
    const slowRead = outcome.state === 'open' && run.kind === 'after-timeout' && entry.state === 'waiting';
    this.#enter(entry, outcome.state, slowRead ? 'slow read: a new helper answered at once' : outcome.reason);
    // A timeout keeps the callers of `check` waiting: the answer to the window may still come late.
    if (outcome.state !== 'waiting') this.#settle(entry);
    this.#schedule(entry);
  }

  #enter(entry: Entry, state: FolderState, reason: string): void {
    if (entry.state === state) return;
    entry.state = state;
    entry.since = new Date().toISOString();
    this.#log(`folder gate: ${entry.name} ${state}${reason === '' ? '' : ` (${reason})`}`);
    for (const listener of [...this.#listeners]) listener(entry.folder, state);
  }

  #settle(entry: Entry): void {
    for (const done of [...entry.waiters]) done();
  }

  /** Arms the recheck of a closed folder; an open or unknown folder has none. */
  #schedule(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const delay = entry.state === 'waiting' ? FOLDER_RECHECK_MS
      : BLOCKED_STATES.has(entry.state) || entry.state === 'absent' ? FOLDER_RECHECK_SLOW_MS : undefined;
    if (delay === undefined) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (entry.run === undefined) this.#startRun(entry, 'recheck', true);
    }, delay);
    entry.timer.unref();
  }
}
