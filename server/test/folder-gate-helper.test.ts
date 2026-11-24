/**
 * The folder helper as a real child process started by its own command: every operation of the port on a temporary
 * directory gives what the disk of this process gives, a call on a FIFO waits without stopping the other calls,
 * SIGKILL and the end of stdin end the helper, and it runs from `/` with an empty environment.
 */
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runDisk } from '../src/folder-gate/disk.ts';
import {
  FOLDER_HELPER_BOOTSTRAP, FOLDER_HELPER_SPAWN, folderHelperCommand,
} from '../src/folder-gate/helper.ts';
import type { DiskArgs, DiskOp, DiskStats } from '../src/folder-gate/types.ts';
import { type WireResponse, decodeResponse, encodeRequest } from '../src/folder-gate/wire.ts';
import { type HangingFifo, hangingFifo } from './helpers/hanging-fifo.ts';

type Child = ChildProcessByStdio<Writable, Readable, null>;

interface Helper {
  readonly child: Child;
  /** One request; the promise settles with the helper's answer to its id. */
  send<K extends DiskOp>(op: K, args: DiskArgs[K]): Promise<WireResponse>;
  /** A raw line as the helper reads it. */
  sendLine(line: string): void;
  /** The answer with this id, for a request sent as a raw line. */
  answer(id: number): Promise<WireResponse>;
  /** Resolves with how the process ended. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children: Child[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function startHelper(): Helper {
  const command = folderHelperCommand();
  const child = spawn(command.file, [...command.args], {
    cwd: command.cwd, env: { ...command.env }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  children.push(child);
  const waiting = new Map<number, (answer: WireResponse) => void>();
  const early = new Map<number, WireResponse>();
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    let end = buffered.indexOf('\n');
    while (end >= 0) {
      const answer = decodeResponse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      const resolve = waiting.get(answer.id);
      if (resolve === undefined) early.set(answer.id, answer);
      else {
        waiting.delete(answer.id);
        resolve(answer);
      }
      end = buffered.indexOf('\n');
    }
  });
  child.stdin.on('error', () => { /* the helper is gone; the test reads the exit */ });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => { resolve({ code, signal }); });
  });
  const answer = (id: number): Promise<WireResponse> => {
    const ready = early.get(id);
    if (ready !== undefined) {
      early.delete(id);
      return Promise.resolve(ready);
    }
    return new Promise((resolve) => { waiting.set(id, resolve); });
  };
  let nextId = 1;
  return {
    child,
    exited,
    sendLine: (line) => { child.stdin.write(`${line}\n`); },
    answer,
    send: (op, args) => {
      const id = nextId++;
      child.stdin.write(`${encodeRequest(id, op, args)}\n`);
      return answer(id);
    },
  };
}

const value = (answer: WireResponse): unknown => {
  if (!answer.ok) throw answer.error;
  return answer.value;
};

const errorOf = (answer: WireResponse): NodeJS.ErrnoException => {
  if (answer.ok) throw new Error('expected an error answer');
  return answer.error;
};

/** What the disk of this process gives for the same call: the value, or the error. */
async function direct<K extends DiskOp>(op: K, args: DiskArgs[K]): Promise<WireResponse> {
  try {
    return { id: 0, ok: true, value: await runDisk(op, args) };
  } catch (error) {
    return { id: 0, ok: false, error: error as NodeJS.ErrnoException };
  }
}

/** Stats without the access times, which a read in between may move. */
const stable = (stats: unknown): Record<string, unknown> => {
  const { atimeMs: _a, atimeNs: _b, ...rest } = { ...(stats as DiskStats) };
  return rest;
};

const comparable = (answer: WireResponse): unknown => {
  if (!answer.ok) {
    const { code, errno, syscall, path, message } = answer.error;
    return { error: { code, errno, syscall, path, message } };
  }
  const one = answer.value;
  if (one !== null && typeof one === 'object' && 'atimeMs' in one) return stable(one);
  return one;
};

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rarog-helper-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fifo(): Promise<HangingFifo> {
  const made = await hangingFifo();
  cleanups.push(() => made.dispose());
  return made;
}

const NO_ANSWER = Symbol('no answer');
const within = <T>(promise: Promise<T>, ms: number): Promise<T | typeof NO_ANSWER> =>
  Promise.race([promise, new Promise<typeof NO_ANSWER>((resolve) => setTimeout(() => { resolve(NO_ANSWER); }, ms))]);

describe('folderHelperCommand', () => {
  it('starts the built JavaScript in the package and the TypeScript with type stripping in the clone', () => {
    expect(folderHelperCommand('/opt/rarog', 'package', false)).toEqual({
      file: process.execPath,
      args: ['--input-type=module', '-e', FOLDER_HELPER_BOOTSTRAP, '--', '/opt/rarog/server/src/folder-gate/helper.js'],
      ...FOLDER_HELPER_SPAWN,
    });
    expect(folderHelperCommand('/src/rarog', 'clone', false).args).toEqual([
      '--experimental-strip-types', '--input-type=module', '-e', FOLDER_HELPER_BOOTSTRAP, '--',
      '/src/rarog/server/src/folder-gate/helper.ts',
    ]);
    expect(folderHelperCommand('/src/rarog', 'clone', 'strip').args[0]).toBe('--input-type=module');
  });

  it('runs from / with an empty environment', () => {
    expect(FOLDER_HELPER_SPAWN).toEqual({ cwd: '/', env: {} });
  });
});

describe('folder helper process', () => {
  it('gives what the disk of this process gives for every operation on a temporary directory', async () => {
    const dir = await tempDir();
    const file = join(dir, 'note.txt');
    writeFileSync(file, 'hello helper\n');
    mkdirSync(join(dir, 'sub'));
    symlinkSync('note.txt', join(dir, 'link'));
    writeFileSync(join(dir, 'Zażółć.txt'), '');
    const helper = startHelper();

    const identity = lstatSync(dir, { bigint: true });
    const reads: { [K in DiskOp]?: DiskArgs[K] }[] = [
      { lstat: { path: join(dir, 'link') } },
      { stat: { path: join(dir, 'link') } },
      { readlink: { path: join(dir, 'link') } },
      { realpath: { path: join(dir, 'link') } },
      { realpathNative: { path: join(dir, 'link') } },
      { readdir: { path: dir, encoding: 'utf8' } },
      { readdir: { path: dir, encoding: 'buffer' } },
      { readdirNames: { path: dir } },
      { readHead: { path: file, maxBytes: 5, followSymlink: false } },
      { readHead: { path: join(dir, 'link'), maxBytes: 64, followSymlink: false } },
      { readHead: { path: join(dir, 'sub'), maxBytes: 64, followSymlink: true } },
      { readdirByIdentity: { path: dir, dev: identity.dev, ino: identity.ino } },
      { readdirByIdentity: { path: dir, dev: identity.dev, ino: identity.ino + 1n } },
      { check: { path: dir } },
      { stat: { path: join(dir, 'missing') } },
      { readdir: { path: file, encoding: 'utf8' } },
      { check: { path: join(dir, 'missing') } },
    ];
    for (const one of reads) {
      const [op, args] = Object.entries(one)[0] as [DiskOp, never];
      const [fromHelper, fromHere] = await Promise.all([helper.send(op, args), direct(op, args)]);
      expect(comparable(fromHelper), `${op} ${JSON.stringify(args, (_k, v: unknown) => (
        typeof v === 'bigint' ? v.toString() : v))}`).toEqual(comparable(fromHere));
    }
    const byIdentity = value(await helper.send('readdirByIdentity', { path: dir, dev: identity.dev, ino: identity.ino }));
    expect((byIdentity as { name: Buffer }[]).map((entry) => entry.name.toString()).sort())
      .toEqual(['Zażółć.txt', 'link', 'note.txt', 'sub'].sort());
  });

  it('reads through a handle it keeps open and refuses the handle after close', async () => {
    const dir = await tempDir();
    const file = join(dir, 'data.bin');
    writeFileSync(file, Buffer.from('0123456789'));
    const helper = startHelper();

    const opened = value(await helper.send('openRead', { path: file, followSymlink: false })) as {
      handle: number; stats: DiskStats;
    };
    expect(stable(opened.stats)).toEqual(stable(value(await direct('lstat', { path: file }))));
    expect(value(await helper.send('read', { handle: opened.handle, length: 4, position: 3 })))
      .toEqual(Buffer.from('3456'));
    expect(value(await helper.send('read', { handle: opened.handle, length: 8, position: 6 })))
      .toEqual(Buffer.from('6789'));
    expect(value(await helper.send('close', { handle: opened.handle }))).toBeUndefined();
    expect(errorOf(await helper.send('read', { handle: opened.handle, length: 1, position: 0 })).code).toBe('EBADF');
    expect(value(await helper.send('openRead', { path: dir, followSymlink: true }))).toBeNull();
  });

  it('writes, appends, changes the mode and removes on the disk', async () => {
    const dir = await tempDir();
    const helper = startHelper();

    expect(value(await helper.send('mkdir', { path: join(dir, 'a', 'b'), recursive: true }))).toBe(join(dir, 'a'));
    expect(errorOf(await helper.send('mkdir', { path: join(dir, 'a') })).code).toBe('EEXIST');
    const target = join(dir, 'a', 'b', 'f.bin');
    const payload = Buffer.alloc(300_000, 7);
    expect(value(await helper.send('writeFile', { path: target, data: payload, mode: 0o600 }))).toBeUndefined();
    expect(readFileSync(target).equals(payload)).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(value(await helper.send('chmod', { path: target, mode: 0o640 }))).toBeUndefined();
    expect(statSync(target).mode & 0o777).toBe(0o640);
    const log = join(dir, 'log.txt');
    expect(value(await helper.send('appendRegular', { path: log, text: 'one\n' }))).toBe(true);
    expect(value(await helper.send('appendRegular', { path: log, text: 'two\n' }))).toBe(true);
    expect(readFileSync(log, 'utf8')).toBe('one\ntwo\n');
    expect(value(await helper.send('unlink', { path: target }))).toBeUndefined();
    expect(existsSync(target)).toBe(false);
  });

  it('answers a malformed request by its id and keeps serving', async () => {
    const dir = await tempDir();
    const helper = startHelper();

    helper.sendLine('not json');
    helper.sendLine(JSON.stringify({ id: 41, op: 'format', args: {} }));
    expect(errorOf(await helper.answer(41)).code).toBe('EINVAL');
    helper.sendLine(JSON.stringify({ id: 42, op: 'lstat', args: null }));
    expect(errorOf(await helper.answer(42)).message).toMatch(/\S/u);
    expect(value(await helper.send('check', { path: dir }))).toBeUndefined();
  });

  it('starts from / under the empty environment of its command', async () => {
    const helper = startHelper();

    expect(value(await helper.send('realpath', { path: '.' }))).toBe('/');
    expect(stable(value(await helper.send('lstat', { path: '.' })))).toEqual(stable(value(await direct('lstat', {
      path: '/',
    }))));
  });

  it('keeps answering while one call waits on a FIFO, and answers that call once the other end opens', async () => {
    const pipe = await fifo();
    const helper = startHelper();

    const hung = helper.send('writeFile', { path: pipe.path, data: Buffer.from('late\n') });
    expect(await within(hung, 300)).toBe(NO_ANSWER);
    expect(value(await helper.send('check', { path: pipe.dir }))).toBeUndefined();
    pipe.release();
    expect(value(await hung)).toBeUndefined();
  });

  it('ends at once on SIGKILL while a call waits on a FIFO', async () => {
    const pipe = await fifo();
    const helper = startHelper();
    const hung = helper.send('writeFile', { path: pipe.path, data: Buffer.from('x') });
    expect(await within(hung, 300)).toBe(NO_ANSWER);

    const start = performance.now();
    helper.child.kill('SIGKILL');
    expect(await helper.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('exits with 0 at the end of stdin when no call is in flight', async () => {
    const dir = await tempDir();
    const helper = startHelper();
    expect(value(await helper.send('check', { path: dir }))).toBeUndefined();

    const start = performance.now();
    helper.child.stdin.end();
    expect(await helper.exited).toEqual({ code: 0, signal: null });
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('ends at the end of stdin even while a call waits on a FIFO', async () => {
    const pipe = await fifo();
    const helper = startHelper();
    const hung = helper.send('writeFile', { path: pipe.path, data: Buffer.from('x') });
    expect(await within(hung, 300)).toBe(NO_ANSWER);

    const start = performance.now();
    helper.child.stdin.end();
    expect(await helper.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
