/**
 * Git of a session whose directory lies in a macOS-guarded folder while the folder gate is on. `fs.watch` waits for the
 * consent window in the server process, so the `.git` watcher there runs only while the folder is open: it waits for
 * a check while the state is unknown, stops when the folder closes and comes back, with one fresh read, when it opens.
 * `git status` and the watcher of a session refused while the folder was closed come back on `open` without a
 * restart, and the git runner starts no process for a directory in a closed folder. The gate is a stand-in whose
 * state the test sets; the guarded folder is a directory under a scratch home, so no real home folder is touched.
 */
import { EventEmitter } from 'node:events';
import type { watch } from 'node:fs';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routeWorkAreaDisk, runDisk, runDiskSync } from '../src/folder-gate/disk.ts';
import { gatedFolderOf } from '../src/folder-gate/folders.ts';
import { installFolderGate } from '../src/folder-gate/install.ts';
import type {
  DiskArgs, DiskOp, DiskValue, FolderBlock, FolderClient, FolderGate, FolderState, HelperAnswer, SyncDiskOp,
} from '../src/folder-gate/types.ts';
import { spawnGitArgs } from '../src/git-status.ts';
import type { GitStatusWatcher } from '../src/git-status.ts';
import { GitRepoWatcher } from '../src/git-watch.ts';
import { SessionGit } from '../src/sessions/session-git.ts';
import type { Session } from '../src/sessions/session.ts';

/** A gate whose folder states the test sets; `set` tells the listeners as the real gate does. */
class StubGate implements FolderGate {
  readonly enabled = true;
  readonly checks: string[] = [];
  readonly #states = new Map<string, FolderState>();
  readonly #listeners = new Set<(folder: string, state: FolderState) => void>();

  constructor(readonly home: string) {}

  get listeners(): number {
    return this.#listeners.size;
  }

  stateOf(candidate: string): { folder: string; state: FolderState } | null {
    const folder = gatedFolderOf(candidate, this.home);
    return folder === null ? null : { folder, state: this.#states.get(folder) ?? 'unknown' };
  }

  report(): void {}

  check(folder: string): Promise<FolderState> {
    this.checks.push(folder);
    return Promise.resolve(this.#states.get(folder) ?? 'unknown');
  }

  blocked(): FolderBlock[] {
    return [];
  }

  onChange(listener: (folder: string, state: FolderState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  set(folder: string, state: FolderState): void {
    this.#states.set(folder, state);
    for (const listener of [...this.#listeners]) listener(folder, state);
  }

  dispose(): void {}
}

/** A helper client that serves every call in this process and records it; with `hang` no call gets an answer. */
class InProcessClient implements FolderClient {
  readonly calls: string[] = [];
  hang = false;

  callSync<K extends SyncDiskOp>(folder: string, op: K, args: DiskArgs[K]): HelperAnswer<DiskValue[K]> {
    this.calls.push(`${op} ${folder}`);
    if (this.hang) return { kind: 'timeout' };
    try {
      return { kind: 'ok', value: runDiskSync(op, args) };
    } catch (error) {
      return { kind: 'fs-error', error: error as NodeJS.ErrnoException };
    }
  }

  async call<K extends DiskOp>(folder: string, op: K, args: DiskArgs[K]): Promise<HelperAnswer<DiskValue[K]>> {
    this.calls.push(`${op} ${folder}`);
    if (this.hang) return { kind: 'timeout' };
    try {
      return { kind: 'ok', value: await runDisk(op, args) };
    } catch (error) {
      return { kind: 'fs-error', error: error as NodeJS.ErrnoException };
    }
  }

  restart(): number {
    return 1;
  }

  generationOf(): number {
    return 1;
  }

  onLate(): () => void {
    return () => undefined;
  }

  dispose(): void {}
}

/** `fs.watch` stand-in: records the watched directories and how many watchers were closed. */
function fakeWatch(): { fn: typeof watch; watched: string[]; closed: { count: number } } {
  const watched: string[] = [];
  const closed = { count: 0 };
  const fn = ((dir: string) => {
    watched.push(dir);
    const watcher = new EventEmitter() as EventEmitter & { close: () => void };
    watcher.close = () => { closed.count += 1; };
    return watcher;
  }) as unknown as typeof watch;
  return { fn, watched, closed };
}

const settle = (ms = 20): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

let home = '';
let documents = '';
const cleanups: (() => void)[] = [];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sgfg-')));
  const scratch = home;
  cleanups.push(() => { rmSync(scratch, { recursive: true, force: true }); });
  documents = join(home, 'Documents');
  mkdirSync(join(documents, 'p', '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(documents, 'p', '.git', 'HEAD'), 'ref: refs/heads/main\n');
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('the .git watcher in a guarded folder', () => {
  /** The gate routed into the disk port, as in the server: pointer files in the folder are read through its helper. */
  function watcherOn(gate: StubGate, client = new InProcessClient()): {
    watcher: GitRepoWatcher; fake: ReturnType<typeof fakeWatch>; fired: string[][];
  } {
    cleanups.push(routeWorkAreaDisk({ gate, client, home: gate.home }));
    const fake = fakeWatch();
    const fired: string[][] = [];
    const watcher = new GitRepoWatcher({
      onChange: (cwds) => { fired.push([...cwds]); }, watchFn: fake.fn, debounceMs: 1, minIntervalMs: 0, gate,
    });
    cleanups.push(() => { watcher.close(); });
    return { watcher, fake, fired };
  }

  it('waits for a check while the folder is unknown and starts only when it opens, with one fresh read', async () => {
    const gate = new StubGate(home);
    const { watcher, fake, fired } = watcherOn(gate);
    const cwd = join(documents, 'p');
    watcher.watch(cwd);
    expect(fake.watched).toEqual([]);
    expect(watcher.watching(cwd)).toBe(false);
    expect(gate.checks).toEqual([documents]);

    gate.set(documents, 'open');
    expect(fake.watched).toEqual([join(cwd, '.git')]);
    expect(watcher.watching(cwd)).toBe(true);
    await settle();
    expect(fired).toEqual([[cwd]]);
  });

  it('stops when the folder closes and comes back with a fresh read on open, without a new registration', async () => {
    const gate = new StubGate(home);
    gate.set(documents, 'open');
    const { watcher, fake, fired } = watcherOn(gate);
    const cwd = join(documents, 'p');
    watcher.watch(cwd);
    expect(fake.watched).toHaveLength(1);
    expect(gate.checks).toEqual([]);

    gate.set(documents, 'waiting');
    expect(fake.closed.count).toBe(1);
    expect(watcher.watching(cwd)).toBe(false);
    await settle();
    expect(fired).toEqual([]);

    gate.set(documents, 'open');
    expect(fake.watched).toHaveLength(2);
    expect(watcher.watching(cwd)).toBe(true);
    await settle();
    expect(fired).toEqual([[cwd]]);
  });

  it('a worktree outside the folder whose shared refs lie in a closed folder is not watched at all', () => {
    const gate = new StubGate(home);
    gate.set(documents, 'waiting');
    const common = join(documents, 'main', '.git');
    const linked = join(common, 'worktrees', 'wt');
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, 'commondir'), '../..\n');
    const tree = join(home, 'Projects', 'wt');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, '.git'), `gitdir: ${linked}\n`);
    const { watcher, fake } = watcherOn(gate);
    watcher.watch(tree);
    expect(fake.watched).toEqual([]);
    gate.set(documents, 'open');
    expect([...fake.watched].sort()).toEqual([common, linked].sort());
  });

  it('a worktree inside the folder registered before its helper answers is found and watched on open', () => {
    const gate = new StubGate(home);
    const common = join(documents, 'main', '.git');
    const linked = join(common, 'worktrees', 'wt');
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, 'commondir'), '../..\n');
    const tree = join(documents, 'wt');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, '.git'), `gitdir: ${linked}\n`);
    const client = new InProcessClient();
    client.hang = true;
    const { watcher, fake, fired } = watcherOn(gate, client);
    watcher.watch(tree);
    expect(fake.watched).toEqual([]);
    client.hang = false;
    gate.set(documents, 'open');
    expect([...fake.watched].sort()).toEqual([common, linked].sort());
    expect(watcher.watching(tree)).toBe(true);
    return settle().then(() => { expect(fired).toEqual([[tree]]); });
  });

  it('a worktree whose .git file names the folder in another spelling of home waits like the folder', () => {
    // The gate and the port know home in upper case; the worktree file names the folder as the disk spells home.
    const spelled = join(dirname(home), basename(home).toUpperCase());
    const folder = join(spelled, 'Documents');
    const gate = new StubGate(spelled);
    gate.set(folder, 'waiting');
    const common = join(documents, 'main', '.git');
    const linked = join(common, 'worktrees', 'wt');
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, 'commondir'), '../..\n');
    const tree = join(home, 'Projects', 'wt');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, '.git'), `gitdir: ${linked}\n`);
    const { watcher, fake } = watcherOn(gate);
    watcher.watch(tree);
    expect(fake.watched).toEqual([]);
    gate.set(folder, 'open');
    expect([...fake.watched].sort()).toEqual([common, linked].sort());
  });

  it('a directory reached through a symlink into the folder counts as the folder', () => {
    const gate = new StubGate(home);
    gate.set(documents, 'denied');
    const link = join(home, 'link');
    symlinkSync(join(documents, 'p'), link);
    const { watcher, fake } = watcherOn(gate);
    watcher.watch(link);
    expect(fake.watched).toEqual([]);
  });

  it('after close the gate has no listener of the watcher', () => {
    const gate = new StubGate(home);
    const { watcher, fake } = watcherOn(gate);
    expect(gate.listeners).toBe(1);
    watcher.watch(join(documents, 'p'));
    watcher.close();
    expect(gate.listeners).toBe(0);
    gate.set(documents, 'open');
    expect(fake.watched).toEqual([]);
  });
});

describe('the git row of a session in a closed folder comes back on open', () => {
  it('no git status and no watcher while waiting; on open both, without a restart', async () => {
    const gate = new StubGate(home);
    gate.set(documents, 'waiting');
    const client = new InProcessClient();
    cleanups.push(installFolderGate(gate), routeWorkAreaDisk({ gate, client, home }));
    const reads: string[] = [];
    const watched: string[] = [];
    const status = {
      status: (cwd: string, force: boolean) => {
        reads.push(`${cwd} force=${String(force)}`);
        return Promise.resolve(null);
      },
    } as unknown as GitStatusWatcher;
    const fakeWatcher = {
      watch: (cwd: string) => { watched.push(cwd); },
      unwatch: () => undefined,
      close: () => undefined,
    } as unknown as GitRepoWatcher;
    const cwd = join(documents, 'p');
    const session = { id: 's1', cwd } as unknown as Session;
    const sessions = new Map<string, Session>([[session.id, session]]);
    const git = new SessionGit(
      { demo: false, gitStatus: status, gitWatcher: () => fakeWatcher, herdrRoots: [home, documents], home },
      { sessions, now: () => 0, gitEnv: {}, emitSession: () => undefined, emitSessionChanged: () => undefined },
    );
    cleanups.push(() => { git.close(); });

    git.watch(session);
    git.requestGitStatus(session, true);
    await settle(1);
    expect(watched).toEqual([]);
    expect(reads).toEqual([]);

    gate.set(documents, 'open');
    await settle(1);
    expect(watched).toEqual([cwd]);
    expect(reads).toEqual([`${cwd} force=true`]);

    // A second open registers nothing twice.
    gate.set(documents, 'waiting');
    gate.set(documents, 'open');
    await settle(1);
    expect(watched).toEqual([cwd]);
  });
});

describe('the git runner in a closed folder', () => {
  /** A `git` on `PATH` that only notes that it ran. */
  function fakeGit(): { env: NodeJS.ProcessEnv; marker: string } {
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    const marker = join(home, 'git-ran');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${marker}'\nexit 1\n`);
    chmodSync(join(bin, 'git'), 0o755);
    return { env: { PATH: `${bin}:/usr/bin:/bin` }, marker };
  }

  it('starts no git process for a directory in a closed folder', async () => {
    const gate = new StubGate(home);
    gate.set(documents, 'waiting');
    cleanups.push(routeWorkAreaDisk({ gate, client: new InProcessClient(), home }));
    const { env, marker } = fakeGit();
    const result = await spawnGitArgs(env, 2_000)({ sub: 'status', rest: [] }, join(documents, 'p'));
    expect(result.ok).toBe(false);
    expect(result.spawnFailed).toBe('EFOLDERGATE');
    expect(existsSync(marker)).toBe(false);
  });

  it('the same directory in an open folder reaches git', async () => {
    const gate = new StubGate(home);
    gate.set(documents, 'open');
    cleanups.push(routeWorkAreaDisk({ gate, client: new InProcessClient(), home }));
    const { env, marker } = fakeGit();
    await spawnGitArgs(env, 2_000)({ sub: 'status', rest: [] }, join(documents, 'p'));
    expect(existsSync(marker)).toBe(true);
  });
});
