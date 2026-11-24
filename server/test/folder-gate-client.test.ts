/**
 * The folder client and its relay thread against a stub helper (`helpers/stub-folder-helper.mjs`): bounded sync and
 * async calls, late answers, restarts with a new generation, a helper that does not start, the exit hook and dispose.
 * Time assertions carry only an upper bound.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FolderClientOptions, RelayFolderClient } from '../src/folder-gate/client.ts';
import type { HelperAnswer } from '../src/folder-gate/types.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RELAY = new URL('../src/folder-gate/relay-worker.ts', import.meta.url);
const CLIENT = new URL('../src/folder-gate/client.ts', import.meta.url);
const STUB = fileURLToPath(new URL('./helpers/stub-folder-helper.mjs', import.meta.url));
const FOLDER = '/project/Documents';
/** Generous bound for calls that must not time out on a loaded machine. */
const WIDE = 10_000;
const SHORT = 300;

const clients: RelayFolderClient[] = [];
const children: ChildProcess[] = [];
const strayPids: number[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function makeClient(options: Partial<FolderClientOptions> & { readonly log?: string } = {}): RelayFolderClient {
  const client = new RelayFolderClient({
    relay: RELAY,
    helper: { file: process.execPath, args: options.log === undefined ? [STUB] : [STUB, options.log] },
    syncBoundMs: WIDE,
    callBoundMs: WIDE,
    ...options,
  });
  clients.push(client);
  return client;
}

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fgc-'));
  dirs.push(dir);
  return dir;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls until `check` holds or `ms` pass; SIGKILL and reaping are asynchronous. */
async function eventually(check: () => boolean, ms = 1000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 10));
  }
  return check();
}

/**
 * The stub helper's pid, through a call that also starts the relay and the helper; `sync` when the client has the
 * short bound on its async calls, so the cold start never meets a short bound.
 */
async function helperPid(client: RelayFolderClient, sync = false): Promise<number> {
  const answer = sync
    ? client.callSync(FOLDER, 'lstat', { path: 'pid' })
    : await client.call(FOLDER, 'lstat', { path: 'pid' });
  expect(answer.kind).toBe('ok');
  const pid = (answer as { value: unknown }).value as number;
  strayPids.push(pid);
  return pid;
}

/** The longest gap between ticks of a 10 ms interval over `ms`. */
async function longestTickGap(ms: number): Promise<number> {
  let last = Date.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 10);
  await new Promise((done) => setTimeout(done, ms));
  clearInterval(timer);
  return longest;
}

describe('folder client', () => {
  it('passes a call and its answer, sync and async, values and file system errors', async () => {
    const client = makeClient();
    expect(client.callSync(FOLDER, 'stat', { path: 'echo' })).toEqual({ kind: 'ok', value: { path: 'echo' } });
    expect(await client.call(FOLDER, 'readdir', { path: 'echo', encoding: 'buffer' }))
      .toEqual({ kind: 'ok', value: { path: 'echo', encoding: 'buffer' } });
    const refused = client.callSync(FOLDER, 'lstat', { path: 'eperm' });
    expect(refused.kind).toBe('fs-error');
    const error = (refused as { error: NodeJS.ErrnoException }).error;
    expect(error).toBeInstanceOf(Error);
    expect({ code: error.code, syscall: error.syscall, path: error.path })
      .toEqual({ code: 'EPERM', syscall: 'lstat', path: 'eperm' });
  });

  it('a sync call to a hanging helper gives up within the bound, and the main thread runs on', async () => {
    const client = makeClient({ syncBoundMs: SHORT });
    await helperPid(client);
    const started = Date.now();
    expect(client.callSync(FOLDER, 'readdirNames', { path: 'hang' })).toEqual({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(SHORT + 500);
    const timer = Date.now();
    await new Promise((done) => setTimeout(done, 10));
    expect(Date.now() - timer).toBeLessThan(200);
  });

  it('an async call to a hanging helper never stops the main thread and ends in a timeout', async () => {
    const client = makeClient({ callBoundMs: 2 * SHORT });
    await helperPid(client, true);
    const pending = client.call(FOLDER, 'readdirNames', { path: 'hang' });
    expect(await longestTickGap(SHORT)).toBeLessThan(50);
    const started = Date.now();
    expect(await pending).toEqual({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2 * SHORT + 500);
  });

  it('an answer after the bound goes to onLate with its generation, not to the caller', async () => {
    const client = makeClient({ syncBoundMs: SHORT });
    await helperPid(client);
    const late = new Promise<[string, number, HelperAnswer<unknown>]>((done) => {
      client.onLate((folder, gen, answer) => { done([folder, gen, answer]); });
    });
    expect(client.callSync(FOLDER, 'lstat', { path: 'sleep:600' })).toEqual({ kind: 'timeout' });
    expect(await late).toEqual([FOLDER, 1, { kind: 'ok', value: { path: 'sleep:600' } }]);
  });

  it('a late answer that opened a file gets a close at once', async () => {
    const log = join(await scratch(), 'requests.log');
    const client = makeClient({ callBoundMs: SHORT, log });
    await helperPid(client, true);
    const late = new Promise<HelperAnswer<unknown>>((done) => {
      client.onLate((_folder, _gen, answer) => { done(answer); });
    });
    expect(await client.call(FOLDER, 'openRead', { path: 'sleep:600', followSymlink: false }))
      .toEqual({ kind: 'timeout' });
    expect(await late).toEqual({ kind: 'ok', value: { handle: 7, stats: null } });
    const closed = (): boolean => readFileSync(log, 'utf8').split('\n')
      .some((line) => line.includes('"op":"close"') && line.includes('"handle":7'));
    expect(await eventually(closed)).toBe(true);
  });

  it('a write over a megabyte gets the bound once per started megabyte', async () => {
    const client = makeClient({ syncBoundMs: SHORT });
    await helperPid(client);
    const data = Buffer.alloc(4 * 1024 * 1024, 1);
    const answer = client.callSync(FOLDER, 'writeFile', { path: `sleep:${String(2 * SHORT)}`, data });
    expect(answer.kind).toBe('ok');
  });

  it('restart kills the helper, calls in flight end as gone, and the next call starts a new generation', async () => {
    const client = makeClient();
    const first = await helperPid(client);
    const pending = client.call(FOLDER, 'readdirNames', { path: 'hang' });
    expect(client.generationOf(FOLDER)).toBe(1);
    expect(client.restart(FOLDER)).toBe(2);
    expect(await pending).toEqual({ kind: 'gone' });
    expect(await eventually(() => !alive(first))).toBe(true);
    const second = await helperPid(client);
    expect(second).not.toBe(first);
    expect(client.generationOf(FOLDER)).toBe(2);
    expect(client.generationOf('/project/Desktop')).toBe(1);
  });

  it('a helper that dies idle ends its generation: a handle it gave is refused, not sent to the next helper', async () => {
    const client = makeClient();
    const opened = await client.call(FOLDER, 'openRead', { path: 'echo', followSymlink: false });
    expect(opened).toEqual({ kind: 'ok', value: { handle: 7, stats: null } });
    const pid = await helperPid(client);
    process.kill(pid, 'SIGKILL');
    expect(await eventually(() => client.generationOf(FOLDER) === 2)).toBe(true);
    const read = await client.call(FOLDER, 'read', { handle: 7, length: 1, position: 0 });
    expect(read.kind === 'fs-error' ? read.error.code : read.kind).toBe('EBADF');
    expect(client.callSync(FOLDER, 'stat', { path: 'echo' })).toEqual({ kind: 'ok', value: { path: 'echo' } });
  });

  it('a handle names its file only in the generation that gave it, also when the next helper gives the same number',
    async () => {
      const log = join(await scratch(), 'requests.log');
      const client = makeClient({ log });
      const open = { path: 'echo', followSymlink: false } as const;
      const opened = { kind: 'ok', value: { handle: 7, stats: null } };
      expect(await client.call(FOLDER, 'openRead', open)).toEqual(opened);
      expect(client.restart(FOLDER)).toBe(2);
      expect(await client.call(FOLDER, 'openRead', open)).toEqual(opened);
      const codeOf = (answer: HelperAnswer<unknown>): string | undefined =>
        (answer.kind === 'fs-error' ? answer.error.code : answer.kind);
      expect(codeOf(await client.call(FOLDER, 'read', { handle: 7, length: 1, position: 0 }, 1))).toBe('EBADF');
      expect(codeOf(await client.call(FOLDER, 'close', { handle: 7 }, 1))).toBe('EBADF');
      expect(codeOf(await client.call(FOLDER, 'read', { handle: 7, length: 1, position: 0 }, 2))).toBe('ok');
      const ops = readFileSync(log, 'utf8').split('\n').filter(Boolean)
        .map((line) => (JSON.parse(line) as { readonly op: string }).op);
      expect(ops).toEqual(['openRead', 'openRead', 'read']);
    });

  it('a sync call keeps its bound when the wall clock steps back', async () => {
    const client = makeClient({ syncBoundMs: SHORT });
    await helperPid(client);
    const wall = Date.now.bind(Date);
    let calls = 0;
    const stepped = vi.spyOn(Date, 'now').mockImplementation(() => wall() - (calls++ > 0 ? 2000 : 0));
    const started = performance.now();
    try {
      expect(client.callSync(FOLDER, 'readdirNames', { path: 'hang' })).toEqual({ kind: 'timeout' });
    } finally {
      stepped.mockRestore();
    }
    expect(performance.now() - started).toBeLessThan(SHORT + 500);
  });

  it('a helper that crashes or never starts gives gone, not a timeout', async () => {
    const crashing = makeClient();
    expect(crashing.callSync(FOLDER, 'lstat', { path: 'crash' })).toEqual({ kind: 'gone' });

    const missing = makeClient({ helper: { file: join(await scratch(), 'no-such-node'), args: [] } });
    const started = Date.now();
    expect(missing.callSync(FOLDER, 'lstat', { path: 'echo' })).toEqual({ kind: 'gone' });
    expect(await missing.call(FOLDER, 'lstat', { path: 'echo' })).toEqual({ kind: 'gone' });
    expect(Date.now() - started).toBeLessThan(WIDE / 2);
  });

  it('dispose returns at once with a hanging helper, kills it and ends calls in flight', async () => {
    const client = makeClient();
    const pid = await helperPid(client);
    const pending = client.call(FOLDER, 'readdirNames', { path: 'hang' });
    await new Promise((done) => setTimeout(done, 50));
    const started = Date.now();
    client.dispose();
    expect(Date.now() - started).toBeLessThan(100);
    expect(await pending).toEqual({ kind: 'gone' });
    expect(await eventually(() => !alive(pid))).toBe(true);
    expect(client.callSync(FOLDER, 'lstat', { path: 'echo' })).toEqual({ kind: 'gone' });
  });

  it('process.exit in a process with a hanging helper ends at once and kills the helper', async () => {
    const dir = await scratch();
    const script = join(dir, 'exit-child.mjs');
    await writeFile(script, [
      `import { RelayFolderClient } from ${JSON.stringify(CLIENT.href)};`,
      'const client = new RelayFolderClient({',
      `  relay: new URL(${JSON.stringify(RELAY.href)}),`,
      `  helper: { file: process.execPath, args: [${JSON.stringify(STUB)}] },`,
      '  syncBoundMs: 10000, callBoundMs: 60000,',
      '});',
      `const pid = client.callSync(${JSON.stringify(FOLDER)}, 'lstat', { path: 'pid' });`,
      `void client.call(${JSON.stringify(FOLDER)}, 'readdirNames', { path: 'hang' });`,
      'setTimeout(() => {',
      "  process.stdout.write(`${JSON.stringify(pid)}\\n`);",
      '  process.exit(0);',
      '}, 200);',
      '',
    ].join('\n'));
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    let err = '';
    let printedAt = 0;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
      if (printedAt === 0 && out.includes('\n')) printedAt = Date.now();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { err += chunk; });
    const code = await new Promise<number | null>((done) => { child.on('close', (exit) => { done(exit); }); });
    const exitedAt = Date.now();
    expect({ code, err }).toEqual({ code: 0, err: '' });
    const answer = JSON.parse(out.trim()) as HelperAnswer<number>;
    expect(answer.kind).toBe('ok');
    const pid = (answer as { value: number }).value;
    strayPids.push(pid);
    expect(exitedAt - printedAt).toBeLessThan(1000);
    expect(await eventually(() => !alive(pid))).toBe(true);
  });
});
