/**
 * Consumers of the work-area port while a guarded home folder is closed: each one refuses with the sentence of the
 * folder's state or answers as for a path it cannot read, without waiting and without the folder's helper. A start of
 * a session, the project list, the session file routes, attachments (with a write whose answer comes too late), the
 * start sweep of attachments, the trust check, the hook list and the command catalog. A fake gate and a client that
 * runs each call in this process stand in for the gate, the relay and the helpers; the last part fails single disk
 * calls of modules that only read metadata of a session directory and compares the answer with that of `EACCES`.
 */
import { mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILES_NOT_FOUND_ERROR } from '@rarog/shared';
import { type ServerSentence, say } from '@rarog/shared/sentences';
import type { RarogConfig } from '../src/config.ts';
import { validateProjectCwd } from '../src/config/roots.ts';
import { routeWorkAreaDisk, runDisk, runDiskSync } from '../src/folder-gate/disk.ts';
import { gatedFolderOf } from '../src/folder-gate/folders.ts';
import { installFolderGate } from '../src/folder-gate/install.ts';
import {
  type ClosedState, type DiskArgs, type DiskOp, type DiskValue, type FolderBlock, type FolderClient,
  type FolderGate, FolderGateError, type FolderState, type HelperAnswer, type SyncDiskOp,
} from '../src/folder-gate/types.ts';
import { SessionFileIndex } from '../src/files/file-index.ts';
import { openSessionDownload } from '../src/files/session-download.ts';
import { listSessionFiles } from '../src/files/session-files.ts';
import { makeDirectory } from '../src/fs-mkdir.ts';
import { gitWorkTree } from '../src/git-work-tree.ts';
import { createCommandCatalogs } from '../src/herdr/commands/catalog.ts';
import { discoverCommands } from '../src/herdr/commands/discover.ts';
import { nodeHookListIo } from '../src/herdr/dialogs/layer1/hook-list/hook-list.ts';
import { realProjectPath } from '../src/herdr/provenance.ts';
import { createTrustCheck } from '../src/herdr/trust.ts';
import { UploadError, createUploads } from '../src/herdr/uploads.ts';
import { createUploadsRegistry } from '../src/herdr/uploads-registry.ts';
import { notesPath } from '../src/notes/store.ts';
import { checkCwd } from '../src/routes/projects.ts';
import type { ManagerApi } from '../src/sessions/manager-api.ts';
import { scanProjectRoots } from '../src/sessions/project-scan.ts';
import { Session } from '../src/sessions/session.ts';

/** A failure the last part puts on single port calls: the error for an operation on a path, or `null`. */
const fault = vi.hoisted(() => ({ of: null as ((op: string, file: string) => Error | null) | null }));

vi.mock('../src/folder-gate/disk.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/folder-gate/disk.ts')>();
  const failed = (op: string, args: unknown): Error | null => {
    const file = (args as { path?: unknown }).path;
    return fault.of === null || typeof file !== 'string' ? null : fault.of(op, file);
  };
  return {
    ...real,
    DIRECT_DISK: {
      sync: (op: SyncDiskOp, args: never) => {
        const error = failed(op, args);
        if (error !== null) throw error;
        return real.DIRECT_DISK.sync(op, args);
      },
      call: async (op: DiskOp, args: never) => {
        const error = failed(op, args);
        if (error !== null) throw error;
        return real.DIRECT_DISK.call(op, args);
      },
    },
  };
});

const AT = new Date(1_756_000_000_000).toISOString();
const TTL = 48 * 3600 * 1000;
const CLOSED: readonly ClosedState[] = ['waiting', 'denied', 'absent', 'unchecked'];
const SENTENCE: Readonly<Record<ClosedState, ServerSentence>> = {
  waiting: say('rest.cwd-folder-waiting'),
  denied: say('rest.cwd-folder-denied'),
  absent: say('rest.cwd-not-found'),
  unchecked: say('rest.cwd-folder-unchecked'),
};

const dirs: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  fault.of = null;
  for (const undo of cleanups.splice(0).reverse()) undo();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A fake gate and a client that runs each call in this process
// ---------------------------------------------------------------------------

class FakeGate implements FolderGate {
  readonly enabled = true;
  readonly states = new Map<string, FolderState>();
  readonly #home: string;
  readonly #listeners = new Set<(folder: string, state: FolderState) => void>();

  constructor(home: string) {
    this.#home = home;
  }

  set(folder: string, state: FolderState): void {
    this.states.set(folder, state);
    for (const listener of [...this.#listeners]) listener(folder, state);
  }

  stateOf(candidate: string): { folder: string; state: FolderState } | null {
    const folder = gatedFolderOf(candidate, this.#home);
    return folder === null ? null : { folder, state: this.states.get(folder) ?? 'unknown' };
  }

  report(folder: string, _gen: number, event: 'timeout' | 'eperm' | 'late-ok' | 'gone' | 'ok'): void {
    if (event === 'timeout') this.set(folder, 'waiting');
  }

  check(): Promise<FolderState> {
    return Promise.resolve('unknown');
  }

  blocked(): FolderBlock[] {
    return [];
  }

  onChange(listener: (folder: string, state: FolderState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  dispose(): void {}
}

type Scripted = (args: unknown) => HelperAnswer<unknown> | Promise<HelperAnswer<unknown>>;

/** A helper of every folder in this process: each call runs on the disk here unless the test scripts its answer. */
class PassClient implements FolderClient {
  readonly calls: { readonly folder: string; readonly op: DiskOp }[] = [];
  readonly answers = new Map<DiskOp, Scripted>();

  callSync<K extends SyncDiskOp>(folder: string, op: K, args: DiskArgs[K]): HelperAnswer<DiskValue[K]> {
    this.calls.push({ folder, op });
    try {
      return { kind: 'ok', value: runDiskSync(op, args) };
    } catch (error) {
      return { kind: 'fs-error', error: error as NodeJS.ErrnoException };
    }
  }

  async call<K extends DiskOp>(folder: string, op: K, args: DiskArgs[K]): Promise<HelperAnswer<DiskValue[K]>> {
    this.calls.push({ folder, op });
    const scripted = this.answers.get(op);
    if (scripted !== undefined) return await scripted(args) as HelperAnswer<DiskValue[K]>;
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

interface Home {
  readonly home: string;
  readonly documents: string;
  /** A project in Documents with a file, `a.txt`. */
  readonly inDocuments: string;
  readonly projects: string;
  /** A project outside the guarded folders. */
  readonly plain: string;
  readonly desktop: string;
  /** `RAROG_PROJECT_ROOTS` and `RAROG_HERDR_ROOTS`: Projects, and Documents, which a root opens that way. */
  readonly roots: readonly string[];
  readonly data: string;
}

async function homeLayout(): Promise<Home> {
  const base = realpathSync(await mkdtemp(path.join(tmpdir(), 'fgr-')));
  dirs.push(base);
  const home = path.join(base, 'home');
  const documents = path.join(home, 'Documents');
  const inDocuments = path.join(documents, 'p');
  const projects = path.join(home, 'Projects');
  const plain = path.join(projects, 'q');
  const desktop = path.join(home, 'Desktop', 'd');
  const data = path.join(base, 'data');
  for (const dir of [inDocuments, plain, desktop, data]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(inDocuments, 'a.txt'), 'gated bytes');
  return { home, documents, inDocuments, projects, plain, desktop, roots: [projects, documents], data };
}

function routed(home: string): { gate: FakeGate; client: PassClient } {
  const gate = new FakeGate(home);
  const client = new PassClient();
  cleanups.push(routeWorkAreaDisk({ gate, client, home }));
  cleanups.push(installFolderGate(gate));
  return { gate, client };
}

const sessionIn = (cwd: string): Session => new Session({
  id: 's1', cwd, title: 'p', state: 'running', stateSince: AT, createdAt: AT, lastActivityAt: AT, herdrKey: 'k1',
});

function filesPort(session: Session, layout: Home) {
  return {
    require: () => session,
    config: { demo: false, herdrRoots: layout.roots, home: layout.home },
    run: () => Promise.reject(new Error('git does not run in this test')),
    demoEntries: () => null,
    demoFile: () => null,
  };
}

const notFoundWith = (sentence: ServerSentence): unknown => ({
  ok: false, refusal: { status: 404, code: FILES_NOT_FOUND_ERROR, sentence },
});

const fileOf = (dataUrlText: string): { name: string; dataUrl: string } => ({
  name: 'note.txt', dataUrl: `data:text/plain;base64,${Buffer.from(dataUrlText).toString('base64')}`,
});

/** Whether `file` is there, by `lstat` in this process. */
const exists = (file: string): boolean => {
  try {
    runDiskSync('lstat', { path: file });
    return true;
  } catch {
    return false;
  }
};

async function uploadErrorOf(run: () => Promise<unknown>): Promise<UploadError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof UploadError) return error;
    throw error;
  }
  throw new Error('expected an UploadError');
}

// ---------------------------------------------------------------------------
// Start of a session and the project list
// ---------------------------------------------------------------------------

describe('a start in a closed folder', () => {
  it.each(CLOSED)('is refused with the sentence of %s, before any read in the folder', async (state) => {
    const layout = await homeLayout();
    const { gate, client } = routed(layout.home);
    gate.set(layout.documents, state);
    expect(validateProjectCwd(layout.inDocuments, layout.roots, { home: layout.home }))
      .toEqual({ ok: false, sentence: SENTENCE[state] });
    expect(client.calls).toEqual([]);
  });

  it('a link in a root that leads into the closed folder gets the same sentence', async () => {
    const layout = await homeLayout();
    const link = path.join(layout.projects, 'link');
    symlinkSync(layout.inDocuments, link);
    const { gate, client } = routed(layout.home);
    gate.set(layout.documents, 'waiting');
    expect(validateProjectCwd(link, layout.roots, { home: layout.home }))
      .toEqual({ ok: false, sentence: SENTENCE.waiting });
    expect(client.calls).toEqual([]);
  });

  it('a folder no root opens stays a protected folder in every state', async () => {
    const layout = await homeLayout();
    const { gate } = routed(layout.home);
    const roots = [layout.home, layout.documents];
    for (const state of ['unknown', ...CLOSED] as const) {
      gate.set(path.join(layout.home, 'Desktop'), state);
      expect(validateProjectCwd(layout.desktop, roots, { home: layout.home }), state)
        .toEqual({ ok: false, sentence: say('rest.cwd-protected') });
    }
  });

  it('an open folder starts as before', async () => {
    const layout = await homeLayout();
    const { gate } = routed(layout.home);
    gate.set(layout.documents, 'open');
    expect(validateProjectCwd(layout.inDocuments, layout.roots, { home: layout.home }))
      .toEqual({ ok: true, cwd: layout.inDocuments });
  });

  describe('a directory from the configured project list', () => {
    const listed = (dir: string): ManagerApi =>
      ({ projects: () => [{ name: 'p', path: dir }] }) as unknown as ManagerApi;
    const config = (layout: Home, demo: boolean): RarogConfig =>
      ({ demo, projectRoots: layout.roots }) as unknown as RarogConfig;

    it.each(CLOSED)('is refused with the sentence of %s by its text, without the helper; the demo starts',
      async (state) => {
        const layout = await homeLayout();
        const { gate, client } = routed(layout.home);
        gate.set(layout.documents, state);
        expect(checkCwd(layout.inDocuments, config(layout, false), listed(layout.inDocuments)))
          .toEqual({ ok: false, sentence: SENTENCE[state] });
        expect(checkCwd(layout.inDocuments, config(layout, true), listed(layout.inDocuments)))
          .toEqual({ ok: true, cwd: layout.inDocuments });
        expect(client.calls).toEqual([]);
      },
    );

    it.each(['unknown', 'open'] as const)('starts as before in a folder that is %s', async (state) => {
      const layout = await homeLayout();
      const { gate } = routed(layout.home);
      gate.set(layout.documents, state);
      expect(checkCwd(layout.inDocuments, config(layout, false), listed(layout.inDocuments)))
        .toEqual({ ok: true, cwd: layout.inDocuments });
    });
  });
});

describe('the project list with a closed folder', () => {
  it('leaves out the closed folder and the root inside it, without the helper', async () => {
    const layout = await homeLayout();
    const { gate, client } = routed(layout.home);
    const roots = [layout.home, layout.documents];
    const open = scanProjectRoots(roots, layout.home).map((entry) => entry.path);
    expect(open).toEqual(expect.arrayContaining([layout.documents, layout.inDocuments]));
    gate.set(layout.documents, 'waiting');
    client.calls.length = 0;
    const closed = scanProjectRoots(roots, layout.home).map((entry) => entry.path);
    expect(closed).toEqual(open.filter((entry) => entry !== layout.documents && entry !== layout.inDocuments));
    expect(client.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Session file routes
// ---------------------------------------------------------------------------

describe('session files in a closed folder', () => {
  it.each(CLOSED)('the listing and the download are 404 with the sentence of %s, without the helper', async (state) => {
    const layout = await homeLayout();
    const { gate, client } = routed(layout.home);
    gate.set(layout.documents, state);
    const port = filesPort(sessionIn(layout.inDocuments), layout);
    expect(await listSessionFiles('s1', '', 1024, port)).toEqual(notFoundWith(SENTENCE[state]));
    expect(await openSessionDownload('s1', 'a.txt', 1024, port)).toEqual(notFoundWith(SENTENCE[state]));
    expect(client.calls).toEqual([]);
  });

  it('a folder that stops answering in the middle of a listing refuses with the waiting sentence', async () => {
    const layout = await homeLayout();
    const { client } = routed(layout.home);
    client.answers.set('readdirByIdentity', () => ({ kind: 'timeout' }));
    const port = filesPort(sessionIn(layout.inDocuments), layout);
    expect(await listSessionFiles('s1', '', 1024, port)).toEqual(notFoundWith(SENTENCE.waiting));
  });

  it('an index of the session files ends with the refusal when the folder closes during its walk', async () => {
    const layout = await homeLayout();
    mkdirSync(path.join(layout.inDocuments, 'sub'));
    writeFileSync(path.join(layout.inDocuments, 'sub', 'b.txt'), 'b');
    const { client } = routed(layout.home);
    let reads = 0;
    client.answers.set('readdirByIdentity', async (args) => {
      reads += 1;
      if (reads > 1) return { kind: 'timeout' };
      return { kind: 'ok', value: await runDisk('readdirByIdentity', args as DiskArgs['readdirByIdentity']) };
    });
    const port = filesPort(sessionIn(layout.inDocuments), layout);
    expect(await new SessionFileIndex().index('s1', 1024, port)).toEqual(notFoundWith(SENTENCE.waiting));
  });

  it('a download in an open folder opens, reads and closes through the folder helper', async () => {
    const layout = await homeLayout();
    const { client } = routed(layout.home);
    const answer = await openSessionDownload('s1', 'a.txt', 1024, filesPort(sessionIn(layout.inDocuments), layout));
    if (!answer.ok) throw new Error(`refused: ${answer.refusal.code}`);
    const first = await answer.value.read();
    expect(await answer.value.read()).toEqual({ kind: 'done' });
    await answer.value.close();
    expect(first).toEqual({ kind: 'piece', bytes: Buffer.from('gated bytes') });
    expect(client.calls.filter((call) => ['openRead', 'read', 'close'].includes(call.op)))
      .toEqual(['openRead', 'read', 'close'].map((op) => ({ folder: layout.documents, op })));
  });

  it('a read the helper does not answer rejects with the refusal, and the close still settles', async () => {
    const layout = await homeLayout();
    const { client } = routed(layout.home);
    client.answers.set('read', () => ({ kind: 'timeout' }));
    const answer = await openSessionDownload('s1', 'a.txt', 1024, filesPort(sessionIn(layout.inDocuments), layout));
    if (!answer.ok) throw new Error(`refused: ${answer.refusal.code}`);
    await expect(answer.value.read()).rejects.toMatchObject({ code: 'EFOLDERGATE', state: 'waiting' });
    await expect(answer.value.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

describe('attachments with a closed folder', () => {
  it.each(CLOSED)('a write in a %s folder is refused with its sentence, without the helper', async (state) => {
    const layout = await homeLayout();
    const { gate, client } = routed(layout.home);
    gate.set(layout.documents, state);
    const uploads = createUploads({ home: layout.home });
    const error = await uploadErrorOf(() => uploads.writeFiles(layout.inDocuments, [fileOf('x')]));
    expect(error.sentence).toEqual(SENTENCE[state]);
    expect(client.calls).toEqual([]);
  });

  it('a write answered too late: refused, its directory registered, the late file swept next time', async () => {
    const layout = await homeLayout();
    const { gate, client } = routed(layout.home);
    // The bytes land, but the answer misses the bound: a write that finished after its caller gave up.
    client.answers.set('writeFile', async (args) => {
      await runDisk('writeFile', args as DiskArgs['writeFile']);
      return { kind: 'timeout' };
    });
    let now = Date.now();
    const registry = createUploadsRegistry({ dataDir: layout.data });
    await registry.rebuild([]);
    const uploads = createUploads({ home: layout.home, registry, now: () => now });
    const error = await uploadErrorOf(() => uploads.writeFiles(layout.inDocuments, [fileOf('late')]));
    expect(error.sentence).toEqual(SENTENCE.waiting);
    expect(await registry.load()).toEqual({ kind: 'ok', dirs: [layout.inDocuments] });
    const uploadDir = path.join(layout.inDocuments, '.rarog-uploads');
    expect(await runDisk('readdirNames', { path: uploadDir })).toHaveLength(1);

    client.answers.delete('writeFile');
    gate.set(layout.documents, 'open');
    now += TTL + 60_000;
    await uploads.sweepAll(layout.roots);
    expect(await runDisk('readdirNames', { path: uploadDir })).toEqual([]);
  });

  it('the start sweep enters no guarded folder before it opens, then sweeps it', async () => {
    const layout = await homeLayout();
    const old = (dir: string): string => {
      const file = path.join(dir, '.rarog-uploads', '1-0123abcd-old.txt');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'old');
      return file;
    };
    const gated = old(layout.inDocuments);
    const plain = old(layout.plain);
    const { gate, client } = routed(layout.home);
    const now = Date.now() + TTL + 60_000;
    // No registry file yet: the sweep walks the roots.
    const registry = createUploadsRegistry({ dataDir: layout.data });
    const uploads = createUploads({ home: layout.home, registry, now: () => now });
    await uploads.sweepAll(layout.roots);
    expect(client.calls).toEqual([]);
    expect([exists(plain), exists(gated)]).toEqual([false, true]);
    gate.set(layout.documents, 'open');
    await vi.waitFor(() => { expect(exists(gated)).toBe(false); });
  });

  it('a deferred part of the start walk whose directory became a symlink meanwhile sweeps nothing there', async () => {
    const layout = await homeLayout();
    const { gate, client } = routed(layout.home);
    const registry = createUploadsRegistry({ dataDir: layout.data });
    const uploads = createUploads({ home: layout.home, registry, now: () => Date.now() + TTL + 60_000 });
    await uploads.sweepAll([layout.projects, layout.inDocuments]);
    // Another project, outside every root, takes the place of the deferred directory before the folder opens.
    const other = path.join(path.dirname(layout.home), 'other');
    const foreign = path.join(other, '.rarog-uploads', '1-0123abcd-old.txt');
    mkdirSync(path.dirname(foreign), { recursive: true });
    writeFileSync(foreign, 'old');
    await rm(layout.inDocuments, { recursive: true });
    symlinkSync(other, layout.inDocuments);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    cleanups.push(() => { warn.mockRestore(); });
    gate.set(layout.documents, 'open');
    // The deferred part has run once it left a log line or removed the file.
    await vi.waitFor(() => { expect(warn.mock.calls.length > 0 || !exists(foreign)).toBe(true); });
    expect([exists(foreign), client.calls]).toEqual([true, []]);
    // The skipped part still counts as run, so the walk ends and writes the registry.
    await vi.waitFor(async () => { expect(await registry.load()).toEqual({ kind: 'ok', dirs: [] }); });
  });

  it.each(['unknown', 'waiting'] as const)(
    'a walk that deferred a root in a %s folder writes the registry only after it swept that root', async (state) => {
      const layout = await homeLayout();
      const put = (dir: string, name: string, old: boolean): string => {
        const file = path.join(dir, '.rarog-uploads', name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, name);
        const past = new Date(Date.now() - TTL - 60_000);
        if (old) utimesSync(file, past, past);
        return file;
      };
      const stale = put(layout.inDocuments, '1-0123abcd-old.txt', true);
      put(layout.inDocuments, '2-0123abcd-new.txt', false);
      put(layout.plain, '2-0123abcd-new.txt', false);
      const roots = [layout.projects, layout.inDocuments];
      const first = routed(layout.home);
      first.gate.set(layout.documents, state);
      await createUploads({ home: layout.home, registry: createUploadsRegistry({ dataDir: layout.data }) })
        .sweepAll(roots);
      expect(await createUploadsRegistry({ dataDir: layout.data }).load()).toEqual({ kind: 'missing' });
      expect(exists(stale)).toBe(true);

      // A restart before the folder opened: the first server's gate and route go with it, and the next start walks.
      for (const undo of cleanups.splice(0).reverse()) undo();
      const second = routed(layout.home);
      const registry = createUploadsRegistry({ dataDir: layout.data });
      await createUploads({ home: layout.home, registry }).sweepAll(roots);
      expect(await registry.load()).toEqual({ kind: 'missing' });
      second.gate.set(layout.documents, 'open');
      await vi.waitFor(async () => {
        expect(await registry.load()).toEqual({ kind: 'ok', dirs: [layout.plain, layout.inDocuments] });
      });
      expect(exists(stale)).toBe(false);
    },
  );

  it('a registered directory in a guarded folder waits for it to open and stays registered until then', async () => {
    const layout = await homeLayout();
    const file = path.join(layout.inDocuments, '.rarog-uploads', '1-0123abcd-old.txt');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'old');
    const registry = createUploadsRegistry({ dataDir: layout.data });
    await registry.rebuild([layout.inDocuments]);
    const { gate, client } = routed(layout.home);
    gate.set(layout.documents, 'waiting');
    const now = Date.now() + TTL + 60_000;
    const uploads = createUploads({ home: layout.home, registry, now: () => now });
    await uploads.sweepAll(layout.roots);
    expect(client.calls).toEqual([]);
    expect(await registry.load()).toEqual({ kind: 'ok', dirs: [layout.inDocuments] });
    gate.set(layout.documents, 'open');
    await vi.waitFor(async () => { expect(await registry.load()).toEqual({ kind: 'ok', dirs: [] }); });
    expect(await runDisk('readdirNames', { path: path.dirname(file) })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Trust, the hook list and the command catalog
// ---------------------------------------------------------------------------

describe('trust, hook list and commands of a session in a closed folder', () => {
  it('trust: a folder closed after the start check gives the untrusted answer, never an error', async () => {
    const layout = await homeLayout();
    // A linked worktree: its trust key is the main checkout, named in the `.git` file only a read can see.
    writeFileSync(path.join(layout.inDocuments, '.git'), 'gitdir: ../main/.git/worktrees/p\n');
    const claudeJson = path.join(layout.data, 'claude.json');
    const main = path.join(layout.documents, 'main');
    writeFileSync(claudeJson, JSON.stringify({ projects: { [main]: { hasTrustDialogAccepted: true } } }));
    const { gate, client } = routed(layout.home);
    const trust = () => createTrustCheck({ claudeJsonPath: claudeJson, home: layout.home, logger: () => undefined });
    await expect(trust().isTrusted(layout.inDocuments)).resolves.toBe(true);
    gate.set(layout.documents, 'waiting');
    client.calls.length = 0;
    await expect(trust().isTrusted(layout.inDocuments)).resolves.toBe(false);
    expect(client.calls).toEqual([]);
  });

  it('hook list: a settings file in a closed folder is no proof, never an absent file', async () => {
    const layout = await homeLayout();
    const settings = path.join(layout.inDocuments, '.claude', 'settings.json');
    mkdirSync(path.dirname(settings), { recursive: true });
    writeFileSync(settings, '{}');
    const { gate } = routed(layout.home);
    gate.set(layout.documents, 'waiting');
    await expect(nodeHookListIo.readFile(settings)).rejects.toMatchObject({ code: 'EFOLDERGATE' });
    await expect(nodeHookListIo.readdir(path.dirname(settings))).rejects.toMatchObject({ code: 'EFOLDERGATE' });
  });

  it('commands: project commands leave the catalog with a note, user commands stay', async () => {
    const layout = await homeLayout();
    const write = (file: string): void => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '---\ndescription: x\n---\n');
    };
    write(path.join(layout.inDocuments, '.claude', 'commands', 'proj.md'));
    write(path.join(layout.home, '.claude', 'commands', 'mine.md'));
    const { gate, client } = routed(layout.home);
    const scan = () => discoverCommands({
      home: layout.home, cwd: layout.inDocuments, roots: layout.roots, reserved: new Set(),
    });
    expect(scan().commands.map((command) => command.name).sort()).toEqual(['mine', 'proj']);
    gate.set(layout.documents, 'waiting');
    client.calls.length = 0;
    const closed = scan();
    expect(closed.commands.map((command) => command.name)).toEqual(['mine']);
    expect(closed.notes.join('\n')).toContain(`${path.join(layout.inDocuments, '.claude', 'commands')} (EFOLDERGATE)`);
    expect(client.calls).toEqual([]);
  });
});

describe('a new directory in a closed folder', () => {
  it('is refused like a listing there: 404 with the sentence of the state, and no child starts', async () => {
    const layout = await homeLayout();
    const { gate, client } = routed(layout.home);
    gate.set(layout.documents, 'waiting');
    const children: string[] = [];
    const result = await makeDirectory({ parent: layout.inDocuments, name: 'new' }, {
      config: { demo: false, herdrLaunch: true, herdrSend: true, projectRoots: layout.roots },
      recheckDevice: () => true,
      log: () => undefined,
      secrets: [],
      home: layout.home,
      runChild: (file) => {
        children.push(file);
        return Promise.reject(new Error('no child in this test'));
      },
    });
    expect(result).toEqual({ ok: false, status: 404, error: 'not-found', sentence: SENTENCE.waiting });
    expect([children, client.calls]).toEqual([[], []]);
  });
});

// ---------------------------------------------------------------------------
// Modules that only read metadata of a session directory
// ---------------------------------------------------------------------------

const unreadable = (file: string): NodeJS.ErrnoException => Object.assign(
  new Error(`EACCES: permission denied, ${file}`), { code: 'EACCES', errno: -13, syscall: 'open', path: file },
);

/** What a call gave, with a rejection by the injected failure counted as one answer whatever its code. */
async function outcome(run: () => unknown): Promise<unknown> {
  try {
    return { value: await run() };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'EACCES' || code === 'EFOLDERGATE') return { rejected: 'the failed call' };
    const sentence = (error as { sentence?: unknown }).sentence;
    return { rejected: error instanceof Error ? error.name : String(error), sentence };
  }
}

describe('a call refused by the gate answers like an unreadable path', () => {
  const rows: readonly { readonly name: string; readonly run: (layout: Home) => unknown }[] = [
    {
      name: 'command catalog (the send gate keeps the user commands)',
      run: (layout) => [...createCommandCatalogs({ home: layout.home, roots: layout.roots })
        .get(layout.inDocuments, null).commands.keys()].sort(),
    },
    { name: 'notes file of a project', run: (layout) => notesPath(layout.data, layout.inDocuments) },
    { name: 'git work tree', run: (layout) => gitWorkTree(layout.inDocuments) },
    { name: 'project path of a pane', run: (layout) => realProjectPath(layout.inDocuments) },
  ];

  it.each(rows)('$name', async ({ run }) => {
    const layout = await homeLayout();
    const inFolder = (file: string): boolean => file.startsWith(layout.documents);
    fault.of = (_op, file) => (inFolder(file) ? unreadable(file) : null);
    const asUnreadable = await outcome(() => run(layout));
    fault.of = (_op, file) => (inFolder(file) ? new FolderGateError(layout.documents, 'waiting') : null);
    const started = Date.now();
    const asClosed = await outcome(() => run(layout));
    expect(asClosed).toEqual(asUnreadable);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
