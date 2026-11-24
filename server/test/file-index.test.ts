/**
 * The file index of a session (`server/src/files/file-index.ts`, `GET /api/sessions/:id/files/index`) on real
 * directories under the run's temporary directory, outside git: every walked directory goes through the listing of
 * the path rule, so what a listing leaves out the index leaves out too; the ceilings and the budget cut it with
 * `truncated`; two requests at once share one walk; the gate refuses before any disk call; the demo gives its data.
 * Then the route behind the router's gate. The index on real git is in `file-index-repo.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FILE_ENTRIES, PROTOCOL_VERSION } from '@rarog/shared';
import type { FileIndex } from '@rarog/shared';
import { fileIndexSchema } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import { loadConfig } from '../src/config.ts';
import { DEMO_FILES } from '../src/demo/files.ts';
import { demoFileEntries } from '../src/demo/files.ts';
import { type FileIndexAnswer, SessionFileIndex } from '../src/files/file-index.ts';
import { FILES_DISK, type FilesDisk } from '../src/files/path-rule.ts';
import { CODEX, NO_PANE, OUT_OF_SCOPE } from '../src/files/refusals.ts';
import type { SessionFilesPort } from '../src/files/session-files.ts';
import type { GitArgsRunner } from '../src/git-status.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { NotFoundError } from '../src/sessions/errors.ts';
import { Session } from '../src/sessions/session.ts';
import type { SessionInit } from '../src/sessions/session.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';
import type { TestDevice } from './helpers/urzadzenie.ts';

const MAX_BYTES = 50 * 1024 * 1024;
const AT = new Date(1_756_000_000_000).toISOString();
const silent: Logger = { info: () => {}, error: () => {} };

let base = '';
let home = '';
let root = '';
let cwd = '';

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'rarog-index-'));
  home = path.join(base, 'home');
  root = path.join(home, 'Projects');
  cwd = path.join(root, 'app');
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(rel: string, text = rel, dir = cwd): Promise<string> {
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

/** Git outside a repository: the walk keeps every file the rule allows. */
const noRepo = (runs: string[] = []): GitArgsRunner => (command) => {
  runs.push(command.sub);
  return Promise.resolve({ ok: false, stdout: '', exitCode: 128 });
};

function sessionOf(extra: Partial<SessionInit> = {}): Session {
  return new Session({
    id: 's1', cwd, title: 'app', state: 'running', stateSince: AT, createdAt: AT, lastActivityAt: AT, herdrKey: 'k1',
    ...extra,
  });
}

function portOf(
  one: Session = sessionOf(), opts: { demo?: boolean; run?: GitArgsRunner; roots?: string[] } = {},
): SessionFilesPort {
  return {
    require: (id: string): Session => {
      if (id !== one.id) throw new NotFoundError(say('rest.session-not-found'));
      return one;
    },
    config: { demo: opts.demo ?? false, herdrRoots: opts.roots ?? [root], home },
    run: opts.run ?? noRepo(),
    demoEntries: demoFileEntries,
  };
}

/** The real disk with every directory read recorded (its path on disk) and a hook after the read of one directory. */
function recording(): { disk: FilesDisk; reads: string[]; afterRead: Map<string, () => Promise<void>> } {
  const reads: string[] = [];
  const afterRead = new Map<string, () => Promise<void>>();
  const disk: FilesDisk = {
    ...FILES_DISK,
    readdirByIdentity: async (dir) => {
      reads.push(dir.real);
      const entries = await FILES_DISK.readdirByIdentity(dir);
      await afterRead.get(dir.real)?.();
      return entries;
    },
  };
  return { disk, reads, afterRead };
}

function valueOf(answer: FileIndexAnswer): FileIndex {
  if (!answer.ok) throw new Error(`refused: ${answer.refusal.code}`);
  expect(fileIndexSchema.parse(answer.value)).toEqual(answer.value);
  return answer.value;
}

async function indexOf(
  opts: ConstructorParameters<typeof SessionFileIndex>[0] = {}, port: SessionFilesPort = portOf(),
): Promise<FileIndex> {
  return valueOf(await new SessionFileIndex(opts).index('s1', MAX_BYTES, port));
}

const real = (rel = ''): string => path.join(FILES_DISK.area.realpath(cwd), rel);

describe('file index: the walk through the listing rule', () => {
  it('files of every directory, breadth first in listing order, relative and joined with `/`', async () => {
    await put('README.md');
    await put('a.ts');
    await put('src/main.ts');
    await put('src/lib/util.ts');
    await put('docs/guide.md');
    expect(await indexOf()).toEqual({
      paths: ['a.ts', 'README.md', 'docs/guide.md', 'src/main.ts', 'src/lib/util.ts'],
      truncated: false,
      maxBytes: MAX_BYTES,
    });
  });

  it('hidden names, `node_modules` in any letter case, symlinks, a FIFO and a second hard link are left out',
    async () => {
      const outside = path.join(base, 'outside');
      await put('secret.txt', 'secret', outside);
      await put('kept.ts');
      await put('.git/config');
      await put('.env');
      await put('node_modules/x/index.js');
      await put('NODE_MODULES/y/index.js');
      await put('src/.cache/c.js');
      await symlink(outside, path.join(cwd, 'linked'));
      await symlink(path.join(outside, 'secret.txt'), path.join(cwd, 'link.txt'));
      execFileSync('mkfifo', [path.join(cwd, 'pipe')]);
      const shared = await put('one.txt');
      await link(shared, path.join(cwd, 'two.txt'));
      const recorded = recording();
      expect((await indexOf({ disk: recorded.disk })).paths).toEqual(['kept.ts']);
      expect(recorded.reads).toEqual([real(), real('src')]);
    });

  it('a name that is not valid UTF-8 is left out', async () => {
    await put('ok.txt');
    const odd = { name: Buffer.from([0x6f, 0xff, 0x2e, 0x74]), isDirectory: () => false, isFile: () => true };
    const disk: FilesDisk = {
      ...FILES_DISK,
      readdirByIdentity: async (dir) => [
        ...(await FILES_DISK.readdirByIdentity(dir) ?? []), odd as unknown as Dirent<Buffer>,
      ],
    };
    expect((await indexOf({ disk })).paths).toEqual(['ok.txt']);
  });

  it('the session directory `~` with the root `~`: protected folders of home are on no path and never read',
    async () => {
      for (const name of ['Desktop', 'Documents', 'Library']) await put(`${name}/inner/x.txt`, 'private', home);
      await put('notes.txt', 'n', home);
      const recorded = recording();
      const index = await indexOf({ disk: recorded.disk }, portOf(sessionOf({ cwd: home }), { roots: [home] }));
      expect(index.paths).toEqual(['notes.txt']);
      expect(recorded.reads.filter((dir) => /\/(?:Desktop|Documents|Library)(?:\/|$)/u.test(dir))).toEqual([]);
    });

  it('a directory swapped for a symlink after its parent was read: skipped, nothing from under the symlink',
    async () => {
      const outside = path.join(base, 'outside');
      await put('secret.txt', 'secret', outside);
      await put('a/inner.ts');
      await put('top.ts');
      const recorded = recording();
      let swapped = false;
      // The walk to `a` starts with the read of the session directory by path: the swap lands right before it,
      // after the listing of the session directory took `a` as a directory.
      const disk: FilesDisk = {
        ...recorded.disk,
        readdir: async (dir) => {
          if (dir === cwd && !swapped) {
            swapped = true;
            await rename(path.join(cwd, 'a'), path.join(cwd, 'moved'));
            await symlink(outside, path.join(cwd, 'a'));
          }
          return FILES_DISK.readdir(dir);
        },
      };
      const index = await indexOf({ disk });
      expect(swapped).toBe(true);
      expect(index.paths).toEqual(['top.ts']);
      expect(recorded.reads.filter((dir) => !dir.startsWith(real()))).toEqual([]);
    });

  it('a directory swapped while it was read: skipped (its listing is 404), the rest stays', async () => {
    await put('a/inner.ts');
    await put('b/other.ts');
    const recorded = recording();
    recorded.afterRead.set(real('a'), async () => {
      await rename(path.join(cwd, 'a'), path.join(cwd, 'moved'));
      await mkdir(path.join(cwd, 'a'));
    });
    expect((await indexOf({ disk: recorded.disk })).paths).toEqual(['b/other.ts']);
  });

  it('the session directory swapped while it was read: 404', async () => {
    await put('top.ts');
    const recorded = recording();
    recorded.afterRead.set(real(), async () => {
      await rename(cwd, `${cwd}-moved`);
      await mkdir(cwd);
    });
    const answer = await new SessionFileIndex({ disk: recorded.disk }).index('s1', MAX_BYTES, portOf());
    expect(answer.ok ? 'ok' : answer.refusal.code).toBe('not-found');
  });

  it(`a directory with ${String(MAX_FILE_ENTRIES + 500)} entries → its first ${String(MAX_FILE_ENTRIES)} and `
    + '`truncated`',
    async () => {
      const names = Array.from({ length: MAX_FILE_ENTRIES + 500 }, (_, i) => `f${String(i).padStart(4, '0')}.txt`);
      await mkdir(path.join(cwd, 'big'));
      await Promise.all(names.map((name) => writeFile(path.join(cwd, 'big', name), '')));
      await put('z.ts');
      const index = await indexOf();
      expect(index.truncated).toBe(true);
      expect(index.paths).toEqual(['z.ts', ...names.slice(0, MAX_FILE_ENTRIES).map((name) => `big/${name}`)]);
    });
});

describe('file index: git names against disk names', () => {
  /** Git that lists `names`, NUL-separated, as `ls-files -z` does. */
  const listing = (...names: string[]): GitArgsRunner => () =>
    Promise.resolve({ ok: true, stdout: names.map((name) => `${name}\0`).join(''), exitCode: 0 });

  it('two names on disk that differ only in Unicode form: only the one git lists is in the index', async () => {
    const composed = 'CAF\u00c9.ts';
    const decomposed = 'CAFE\u0301.ts';
    await put(composed);
    await put('other.ts');
    // A volume that tells the two forms apart holds both; here the listing gets the second name injected, and its
    // `lstat` lands on the same file on a volume that does not.
    const extra = { name: Buffer.from(decomposed, 'utf8'), isDirectory: () => false, isFile: () => true };
    const disk: FilesDisk = {
      ...FILES_DISK,
      readdirByIdentity: async (dir) => [
        ...(await FILES_DISK.readdirByIdentity(dir) ?? []), extra as unknown as Dirent<Buffer>,
      ],
    };
    const index = await indexOf({ disk }, portOf(sessionOf(), { run: listing(composed) }));
    expect(index.paths).toEqual([composed]);
  });

  it('a git name with no exact match takes the one disk name with the same folded key, for files and directories',
    async () => {
      await put('Readme.md');
      await put('notes/a.md');
      await put('other.md');
      const index = await indexOf({}, portOf(sessionOf(), { run: listing('README.md', 'Notes/a.md') }));
      expect(index.paths).toEqual(['Readme.md', 'notes/a.md']);
    });

  it('two disk names with the folded key of a git name and neither exact: neither is in the index', async () => {
    await put('Data.csv');
    const extra = { name: Buffer.from('DATA.csv', 'utf8'), isDirectory: () => false, isFile: () => true };
    const disk: FilesDisk = {
      ...FILES_DISK,
      readdirByIdentity: async (dir) => [
        ...(await FILES_DISK.readdirByIdentity(dir) ?? []), extra as unknown as Dirent<Buffer>,
      ],
    };
    expect((await indexOf({ disk }, portOf(sessionOf(), { run: listing('data.csv') }))).paths).toEqual([]);
  });
});

describe('file index: ceilings and budget', () => {
  beforeEach(async () => {
    for (const name of ['a.ts', 'b.ts', 'c.ts', 'd/e.ts', 'd/f.ts', 'g/h.ts']) await put(name);
  });

  it('without a ceiling reached: every file, `truncated: false`', async () => {
    expect(await indexOf()).toMatchObject({
      paths: ['a.ts', 'b.ts', 'c.ts', 'd/e.ts', 'd/f.ts', 'g/h.ts'], truncated: false,
    });
  });

  it('the ceiling of files → the first ones and `truncated`', async () => {
    expect(await indexOf({ limits: { maxFiles: 4 } })).toMatchObject({
      paths: ['a.ts', 'b.ts', 'c.ts', 'd/e.ts'], truncated: true,
    });
  });

  it('the ceiling of the body: the serialized index stays under it, `truncated`', async () => {
    const full = JSON.stringify(await indexOf());
    const ceiling = Buffer.byteLength(full) - 3;
    const cut = await indexOf({ limits: { maxBodyBytes: ceiling } });
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(ceiling);
    expect(cut.paths).toEqual(['a.ts', 'b.ts', 'c.ts', 'd/e.ts', 'd/f.ts']);
  });

  it('a body exactly at the ceiling is whole', async () => {
    const full = await indexOf();
    expect(await indexOf({ limits: { maxBodyBytes: Buffer.byteLength(JSON.stringify(full)) } })).toEqual(full);
  });

  it('the budget, checked between directories: past it the walk stops with `truncated`', async () => {
    let clock = 0;
    const recorded = recording();
    recorded.afterRead.set(real(), () => { clock += 3_001; return Promise.resolve(); });
    const index = await indexOf({ disk: recorded.disk, now: () => clock, limits: { budgetMs: 3_000 } });
    expect(index).toMatchObject({ paths: ['a.ts', 'b.ts', 'c.ts'], truncated: true });
    expect(recorded.reads).toEqual([real()]);
  });

  it('the budget counts the git read too; the session directory is listed all the same', async () => {
    let clock = 0;
    const run: GitArgsRunner = () => {
      clock += 3_001;
      return Promise.resolve({ ok: false, stdout: '', exitCode: 128 });
    };
    const recorded = recording();
    const index = await indexOf({ disk: recorded.disk, now: () => clock }, portOf(sessionOf(), { run }));
    expect(index).toEqual({ paths: ['a.ts', 'b.ts', 'c.ts'], truncated: true, maxBytes: MAX_BYTES });
    expect(recorded.reads).toEqual([real()]);
  });
});

describe('file index: one walk at a time per session', () => {
  it('two requests at once share one walk and one git read; a request after it walks again', async () => {
    await put('a.ts');
    await put('src/b.ts');
    const runs: string[] = [];
    const recorded = recording();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    recorded.afterRead.set(real(), () => held);
    const indexer = new SessionFileIndex({ disk: recorded.disk });
    const port = portOf(sessionOf(), { run: noRepo(runs) });
    const first = indexer.index('s1', MAX_BYTES, port);
    const second = indexer.index('s1', MAX_BYTES, port);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(two).toEqual(one);
    expect(valueOf(one).paths).toEqual(['a.ts', 'src/b.ts']);
    expect([recorded.reads.filter((dir) => dir === real()).length, runs.length]).toEqual([1, 1]);
    await indexer.index('s1', MAX_BYTES, port);
    expect([recorded.reads.filter((dir) => dir === real()).length, runs.length]).toEqual([2, 2]);
  });

  it('a session that moved to another directory does not get the walk of the old one', async () => {
    await put('a.ts');
    await put('b.ts', 'b', path.join(root, 'other'));
    const recorded = recording();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    recorded.afterRead.set(real(), () => held);
    const indexer = new SessionFileIndex({ disk: recorded.disk });
    const first = indexer.index('s1', MAX_BYTES, portOf());
    const second = indexer.index('s1', MAX_BYTES, portOf(sessionOf({ cwd: path.join(root, 'other') })));
    release();
    expect([valueOf(await first).paths, valueOf(await second).paths]).toEqual([['a.ts'], ['b.ts']]);
  });

  it('a failed walk is not kept: the next request walks again', async () => {
    await put('a.ts');
    let fail = true;
    const disk: FilesDisk = {
      ...FILES_DISK,
      readdirByIdentity: (dir) => (fail ? Promise.reject(new Error('EIO')) : FILES_DISK.readdirByIdentity(dir)),
    };
    const indexer = new SessionFileIndex({ disk });
    const failed = await indexer.index('s1', MAX_BYTES, portOf());
    expect(failed.ok ? 'ok' : failed.refusal.code).toBe('not-found');
    fail = false;
    expect(valueOf(await indexer.index('s1', MAX_BYTES, portOf())).paths).toEqual(['a.ts']);
  });
});

/** A disk port that fails the test on any call. */
function untouchedDisk(calls: string[]): FilesDisk {
  const no = (name: string) => (): never => {
    calls.push(name);
    throw new Error(`disk call ${name}`);
  };
  return {
    readdir: no('readdir'), readdirByIdentity: no('readdirByIdentity'), lstat: no('lstat'), stat: no('stat'),
    realpath: no('realpath'), open: no('open'),
    area: { lstat: no('area.lstat'), readlink: no('area.readlink'), realpath: no('area.realpath') },
  };
}

describe('file index: the gate and the demo', () => {
  it.each([
    ['a Codex entry', { engine: 'codex' }, CODEX],
    ['a pane out of scope', { outOfScope: true }, OUT_OF_SCOPE],
    ['a session without a herdr pane', { herdrKey: undefined }, NO_PANE],
  ] as const)('%s → 400 with the refusal of the gate, no disk call and no git', async (_, extra, refusal) => {
    const calls: string[] = [];
    const runs: string[] = [];
    const port = portOf(sessionOf(extra), { run: noRepo(runs) });
    const answer = await new SessionFileIndex({ disk: untouchedDisk(calls) }).index('s1', MAX_BYTES, port);
    expect(answer).toEqual({ ok: false, refusal });
    expect([calls, runs]).toEqual([[], []]);
  });

  it('an unknown session throws the manager 404', async () => {
    await expect(new SessionFileIndex().index('other', MAX_BYTES, portOf())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('the demo: the files of the demo data git does not ignore, with no disk call and no git', async () => {
    const calls: string[] = [];
    const runs: string[] = [];
    const port = portOf(sessionOf(), { demo: true, run: noRepo(runs) });
    const index = valueOf(await new SessionFileIndex({ disk: untouchedDisk(calls) }).index('s1', 3 * MAX_BYTES, port));
    expect(index.paths.sort()).toEqual(Object.keys(DEMO_FILES).filter((file) => !file.startsWith('dist/')).sort());
    expect(index).toMatchObject({ truncated: false, maxBytes: 3 * MAX_BYTES });
    expect([calls, runs]).toEqual([[], []]);
  });
});

interface Harness {
  readonly base: string;
  readonly device: TestDevice;
  readonly manager: FakeManager;
  close(): Promise<void>;
}

const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(
  env: NodeJS.ProcessEnv = {}, fileIndex?: Pick<SessionFileIndex, 'index'>,
): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'rarog-index-route-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  const config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: dir, ...env });
  const device = createTestDevice(dir, { epoch: config.epoch });
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger: silent, devices: device.identity,
    ...(fileIndex === undefined ? {} : { fileIndex }),
  }));
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const h: Harness = {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    device, manager,
    close: async () => {
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
  open.push(h);
  return h;
}

async function call(h: Harness, route: string, method = 'GET'): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${h.base}${route}`, {
    method, headers: { ...h.device.headers, ...(method === 'GET' ? {} : { Origin: 'http://localhost:8930' }) },
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
}

const INDEX: FileIndex = { paths: ['src/a.ts', 'README.md'], truncated: false, maxBytes: 5 * 1024 * 1024 };

describe('GET /api/sessions/:id/files/index', () => {
  it('the index goes out as the indexer gave it, for the session and the limit of the server', async () => {
    const asked: [string, number][] = [];
    const h = await start({ RAROG_FILES_MAX_MB: '5' }, {
      index: (id, maxBytes) => { asked.push([id, maxBytes]); return Promise.resolve({ ok: true, value: INDEX }); },
    });
    expect(await call(h, '/api/sessions/s1/files/index')).toEqual({ status: 200, body: INDEX });
    expect(asked).toEqual([['s1', 5 * 1024 * 1024]]);
  });

  it('the default indexer over the manager port: the demo index', async () => {
    const h = await start();
    const reply = await call(h, '/api/sessions/s1/files/index');
    expect(reply.status).toBe(200);
    expect(fileIndexSchema.parse(reply.body).paths).toContain('src/index.ts');
  });

  it('a refusal goes out with its status, code and sentence', async () => {
    const h = await start({}, { index: () => Promise.resolve({ ok: false, refusal: CODEX }) });
    const reply = await call(h, '/api/sessions/s1/files/index');
    expect(reply).toMatchObject({ status: 400, body: { error: 'codex', messageRef: { code: 'rest.files-codex' } } });
  });

  it('an unknown session → 404 `session-not-found`', async () => {
    const h = await start();
    expect(await call(h, '/api/sessions/nope/files/index')).toMatchObject({
      status: 404, body: { error: 'session-not-found' },
    });
  });

  it('another method → 405 with `Allow: GET`', async () => {
    const h = await start();
    const res = await fetch(`${h.base}/api/sessions/s1/files/index`, {
      method: 'POST', headers: { ...h.device.headers, Origin: 'http://localhost:8930' },
    });
    expect([res.status, res.headers.get('allow')]).toEqual([405, 'GET']);
  });

  it('a device unpaired during the walk gets 401 and no index', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = await start({}, { index: async () => { await held; return { ok: true, value: INDEX }; } });
    const reply = call(h, '/api/sessions/s1/files/index');
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.device.store.revoke(h.device.id, 'admin');
    release();
    expect(await reply).toMatchObject({ status: 401, body: { error: 'device-revoked' } });
  });

  it('`RAROG_FILES=0`: 404 for every method, no walk, and neither `files` nor `file-index` announced', async () => {
    const asked: string[] = [];
    const h = await start({ RAROG_FILES: '0' }, {
      index: (id) => { asked.push(id); return Promise.resolve({ ok: true, value: INDEX }); },
    });
    for (const method of ['GET', 'POST']) {
      expect(await call(h, '/api/sessions/s1/files/index', method), method)
        .toMatchObject({ status: 404, body: { error: 'not-found', messageRef: { code: 'rest.endpoint-not-found' } } });
    }
    expect(asked).toEqual([]);
    const capabilities = ((await call(h, '/api/version')).body as { capabilities: string[] }).capabilities;
    expect(capabilities.filter((one) => one.startsWith('file'))).toEqual([]);
  });

  it('the routes on: `GET /api/version` announces `file-index` next to `files`', async () => {
    const h = await start();
    const capabilities = ((await call(h, '/api/version')).body as { capabilities: string[] }).capabilities;
    expect(capabilities).toEqual(expect.arrayContaining(['files', 'file-index']));
  });
});
