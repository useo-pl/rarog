/**
 * The listing route of the session files (`GET /api/sessions/:id/files?dir=`) around its listing: the switch
 * `RAROG_FILES` and the limit `RAROG_FILES_MAX_MB` (parsed at start, refused by `rarog serve --check` out of range),
 * the capability `files` in `GET /api/version`, the route behind the router's gate (a manager stub records the call),
 * and the demo, which lists its fixed data with no disk call and no git. The listing on real directories and git is
 * in `session-files-repo.test.ts`; the gate and the path rule in `files-sciezka.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, compareFileEntries } from '@rarog/shared';
import type { FileListing } from '@rarog/shared';
import { fileListingSchema } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import type { CliIo } from '../src/cli/io.ts';
import { main } from '../src/cli/main.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { DEMO_DIFF_FILES } from '../src/drivers/mock-driver.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';
import { demoFileEntries } from '../src/demo/files.ts';
import type { FilesDisk } from '../src/files/path-rule.ts';
import { CODEX, NO_PANE, OUT_OF_SCOPE } from '../src/files/refusals.ts';
import { type SessionFilesPort, listSessionFiles } from '../src/files/session-files.ts';
import type { GitArgsRunner } from '../src/git-status.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { NotFoundError } from '../src/sessions/errors.ts';
import { type Manager, createManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import type { SessionInit } from '../src/sessions/session.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { type TestDevice, createTestDevice } from './helpers/urzadzenie.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

const MIB = 1024 * 1024;
const AT = new Date(1_756_000_000_000).toISOString();
const silent: Logger = { info: () => {}, error: () => {} };

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const configWith = (env: NodeJS.ProcessEnv = {}): ReturnType<typeof loadConfig> =>
  loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: tempDir('rarog-files-cfg-'), ...env });

describe('files configuration: `RAROG_FILES` and `RAROG_FILES_MAX_MB`', () => {
  it('without the variables: the routes on, the limit 50 MiB', () => {
    const config = configWith();
    expect([config.filesEnabled, config.filesMaxBytes]).toEqual([true, 50 * MIB]);
  });

  it('the limit is whole megabytes from 1 to 1024, in bytes', () => {
    expect(configWith({ RAROG_FILES_MAX_MB: '5' }).filesMaxBytes).toBe(5 * MIB);
    expect(configWith({ RAROG_FILES_MAX_MB: '1' }).filesMaxBytes).toBe(MIB);
    expect(configWith({ RAROG_FILES_MAX_MB: '1024' }).filesMaxBytes).toBe(1024 * MIB);
    expect(configWith({ RAROG_FILES_MAX_MB: ' 7 ' }).filesMaxBytes).toBe(7 * MIB);
  });

  it.each(['0', '2000', 'abc', '1.5', '-3', '1e2', '0x10', '1025'])(
    '`RAROG_FILES_MAX_MB=%s` stops the start with the name of the variable', (value) => {
      expect(() => configWith({ RAROG_FILES_MAX_MB: value })).toThrow(ConfigError);
      expect(() => configWith({ RAROG_FILES_MAX_MB: value })).toThrow(/RAROG_FILES_MAX_MB/);
    },
  );

  it('`RAROG_FILES=0` turns the routes off; a value other than 1 or 0 stops the start', () => {
    expect(configWith({ RAROG_FILES: '0' }).filesEnabled).toBe(false);
    expect(configWith({ RAROG_FILES: '1' }).filesEnabled).toBe(true);
    expect(() => configWith({ RAROG_FILES: 'yes' })).toThrow(/RAROG_FILES/);
  });
});

describe('files configuration: `rarog serve --check`', () => {
  let home: TempHome;
  beforeEach(() => { home = tempHome('rarog-files-serve-'); });
  afterEach(() => { home.cleanup(); });
  afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

  async function check(value: string): Promise<{ code: number; stderr: string }> {
    const dir = path.join(home.home, '.config', 'rarog');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      version: 1, env: { RAROG_ORIGINS: 'https://rarog.example.net', RAROG_FILES_MAX_MB: value },
    }));
    let stderr = '';
    const io: CliIo = {
      stdout: () => {}, stderr: (text) => { stderr += text; }, cwd: home.home,
      env: { PATH: home.env['PATH'], HOME: home.home, XDG_DATA_HOME: path.join(home.home, 'xdg') },
    };
    return { code: await main(['serve', '--check'], io), stderr };
  }

  it.each(['0', '2000', 'abc'])('`RAROG_FILES_MAX_MB=%s` in `config.json`: the check refuses and names it', async (value) => {
    const result = await check(value);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('RAROG_FILES_MAX_MB');
  });

  it('`RAROG_FILES_MAX_MB=5` passes the check', async () => {
    expect(await check('5')).toEqual({ code: 0, stderr: '' });
  });
});

/** A disk port that fails the test on any call: the demo and a refused session never touch the disk. */
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

function portOf(one: Session, opts: { demo?: boolean; runs?: string[] } = {}): SessionFilesPort {
  const run: GitArgsRunner = (command) => {
    opts.runs?.push(command.sub);
    return Promise.resolve({ ok: false, stdout: '', exitCode: 128 });
  };
  return {
    require: (id: string): Session => {
      if (id !== one.id) throw new NotFoundError(say('rest.session-not-found'));
      return one;
    },
    config: { demo: opts.demo ?? false, herdrRoots: ['/Users/demo/Projects'], home: '/Users/demo' },
    run,
    demoEntries: demoFileEntries,
  };
}

function sessionOf(extra: Partial<SessionInit> = {}): Session {
  return new Session({
    id: 's1', cwd: '/Users/demo/Projects/willow', title: 'willow', state: 'running', stateSince: AT, createdAt: AT,
    lastActivityAt: AT, ...extra,
  });
}

describe('files listing: refused sessions and the demo', () => {
  it.each([
    ['a Codex entry', { engine: 'codex', herdrKey: 'k1' }, CODEX],
    ['a pane out of scope', { outOfScope: true, herdrKey: 'k1' }, OUT_OF_SCOPE],
    ['a session without a herdr pane', {}, NO_PANE],
  ] as const)('%s → 400 with the refusal of the gate, no disk call and no git', async (_, extra, refusal) => {
    const calls: string[] = [];
    const runs: string[] = [];
    const result = await listSessionFiles('s1', '', 50 * MIB, portOf(sessionOf(extra), { runs }), untouchedDisk(calls));
    expect(result).toEqual({ ok: false, refusal });
    expect(result.ok ? 0 : result.refusal.status).toBe(400);
    expect([calls, runs]).toEqual([[], []]);
  });

  it('the demo lists its fixed data, with no disk call and no git: directories first, `dist` ignored', async () => {
    const calls: string[] = [];
    const runs: string[] = [];
    const port = portOf(sessionOf(), { demo: true, runs });
    const root = await listSessionFiles('s1', '', 5 * MIB, port, untouchedDisk(calls));
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(fileListingSchema.parse(root.value)).toEqual(root.value);
    expect(root.value).toMatchObject({ dir: '', truncated: false, maxBytes: 5 * MIB });
    expect([...root.value.entries].sort(compareFileEntries)).toEqual(root.value.entries);
    expect(root.value.entries.find((entry) => entry.name === 'dist')).toEqual({ name: 'dist', kind: 'dir', ignored: true });
    const dist = await listSessionFiles('s1', 'dist', 5 * MIB, port, untouchedDisk(calls));
    expect(dist.ok && dist.value.entries.length > 0 && dist.value.entries.every((entry) => entry.ignored === true))
      .toBe(true);
    expect([calls, runs]).toEqual([[], []]);
  });

  it('the demo tree agrees with the demo diff: changed files listed in their directory, the deleted one absent',
    async () => {
      const port = portOf(sessionOf(), { demo: true });
      for (const file of DEMO_DIFF_FILES) {
        const dir = path.posix.dirname(file.path);
        const listing = await listSessionFiles('s1', dir === '.' ? '' : dir, MIB, port, untouchedDisk([]));
        const names = listing.ok ? listing.value.entries.map((entry) => entry.name) : [];
        expect(names.includes(path.posix.basename(file.path)), file.path).toBe(file.status !== 'D');
      }
    });

  it('the demo refuses as the server does: a bad path 400, a hidden or unknown directory 404', async () => {
    const port = portOf(sessionOf(), { demo: true });
    const codeOf = async (dir: string): Promise<string> => {
      const result = await listSessionFiles('s1', dir, MIB, port, untouchedDisk([]));
      return result.ok ? 'ok' : result.refusal.code;
    };
    expect(await codeOf('../x')).toBe('bad-path');
    expect(await codeOf('src/')).toBe('bad-path');
    expect(await codeOf('.git')).toBe('not-found');
    expect(await codeOf('nope')).toBe('not-found');
    expect(await codeOf('README.md')).toBe('not-found');
  });

  it('an unknown session throws the manager 404', async () => {
    await expect(listSessionFiles('other', '', MIB, portOf(sessionOf({ herdrKey: 'k1' })))).rejects
      .toBeInstanceOf(NotFoundError);
  });
});

describe('files listing: the demo manager', () => {
  let manager: Manager | undefined;
  afterEach(async () => { await manager?.dispose(); manager = undefined; });

  it('`listFiles` of a demo session gives the demo data with the limit it got', async () => {
    manager = await createManager({ demo: true, demoContent: demoContentPl, dataDir: tempDir('rarog-files-demo-') });
    await manager.ready;
    const result = await manager.listFiles('demo-willow', 'src', 3 * MIB);
    expect(result).toEqual({
      ok: true, value: { dir: 'src', entries: demoFileEntries('src'), truncated: false, maxBytes: 3 * MIB },
    });
  });
});

interface Harness {
  readonly base: string;
  readonly device: TestDevice;
  readonly manager: FakeManager;
  close(): Promise<void>;
}

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function start(env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const dir = tempDir('rarog-files-route-');
  const config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: dir, ...env });
  const device = createTestDevice(dir, { epoch: config.epoch });
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger: silent, devices: device.identity,
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

const LISTING: FileListing = {
  dir: 'src', entries: [{ name: 'lib', kind: 'dir' }, { name: 'a.ts', kind: 'file', size: 3, ignored: true }],
  truncated: false, maxBytes: 50 * MIB,
};

describe('GET /api/sessions/:id/files', () => {
  it('no `dir` → the session directory: the manager gets an empty path and the limit of the server', async () => {
    const h = await start();
    expect(await call(h, '/api/sessions/s1/files')).toMatchObject({ status: 200 });
    expect(h.manager.calls.filter((c) => c.method === 'listFiles')).toEqual([
      { method: 'listFiles', args: ['s1', '', 50 * MIB] },
    ]);
  });

  it('`dir` goes to the manager decoded and the listing goes out as the manager gave it', async () => {
    const h = await start({ RAROG_FILES_MAX_MB: '5' });
    h.manager.listFilesResult = { ok: true, value: LISTING };
    const reply = await call(h, '/api/sessions/s1/files?dir=src%2Fdeep%20x');
    expect(reply).toEqual({ status: 200, body: LISTING });
    expect(h.manager.calls.filter((c) => c.method === 'listFiles')).toEqual([
      { method: 'listFiles', args: ['s1', 'src/deep x', 5 * MIB] },
    ]);
  });

  it('a refusal goes out with its status, code and sentence', async () => {
    const h = await start();
    h.manager.listFilesResult = { ok: false, refusal: OUT_OF_SCOPE };
    const reply = await call(h, '/api/sessions/s1/files');
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ error: 'out-of-scope', messageRef: { code: 'rest.files-out-of-scope' } });
  });

  it('an unknown session → 404 `session-not-found`, as on the diff routes', async () => {
    const h = await start();
    const reply = await call(h, '/api/sessions/nope/files');
    expect(reply).toMatchObject({ status: 404, body: { error: 'session-not-found' } });
  });

  it('another method → 405 with `Allow: GET`', async () => {
    const h = await start();
    const res = await fetch(`${h.base}/api/sessions/s1/files`, {
      method: 'POST', headers: { ...h.device.headers, Origin: 'http://localhost:8930' },
    });
    expect([res.status, res.headers.get('allow')]).toEqual([405, 'GET']);
  });

  it('a device unpaired while the directory is read gets 401 and no listing', async () => {
    const h = await start();
    let release = (): void => {};
    h.manager.listFilesWait = new Promise((resolve) => { release = resolve; });
    h.manager.listFilesResult = { ok: true, value: LISTING };
    const reply = call(h, '/api/sessions/s1/files');
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.device.store.revoke(h.device.id, 'admin');
    release();
    expect(await reply).toMatchObject({ status: 401, body: { error: 'device-revoked' } });
  });

  it('`RAROG_FILES=0`: 404 as an unknown route for every method, and no capability `files`', async () => {
    const h = await start({ RAROG_FILES: '0' });
    for (const method of ['GET', 'POST']) {
      expect(await call(h, '/api/sessions/s1/files', method), method)
        .toMatchObject({ status: 404, body: { error: 'not-found', messageRef: { code: 'rest.endpoint-not-found' } } });
    }
    expect(h.manager.calls.filter((c) => c.method === 'listFiles')).toEqual([]);
    const version = await call(h, '/api/version');
    expect((version.body as { capabilities: string[] }).capabilities).not.toContain('files');
  });

  it('the routes on: `GET /api/version` announces the capability `files`', async () => {
    const h = await start();
    const version = await call(h, '/api/version');
    expect((version.body as { capabilities: string[] }).capabilities).toContain('files');
  });
});
