/**
 * The update lock (`server/src/cli/update-lock.ts`): `<config directory>/update.lock` with the PID line and the body
 * (`token`, after an install `installed.version` and `installed.root`), a refusal in one sentence while another update
 * is alive, a dead owner taken over, and the inheritance by token (`RAROG_UPDATE_LOCK_TOKEN`) for a child process:
 * a good token passes, a bad one or no lock is refused, nothing is written either way. The CLI lock of
 * `rarog restart` (`lock`) stays a separate file. Everything runs in a temporary directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Refusal } from '../src/cli/io.ts';
import { LOCK_FILENAME, acquireLock } from '../src/cli/lock.ts';
import {
  UPDATE_LOCK_FILENAME, UPDATE_LOCK_TOKEN, inheritUpdateLock, parseUpdateLock, takeUpdateLock, updateLockBody,
  updateLockOf,
} from '../src/cli/update-lock.ts';
import { tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

const WHAT = 'rarog update --finish';
const TOKEN = 'abababababababababababababababab';
const OTHER = 'fedcba9876543210fedcba9876543210';

let t: TempHome;
let dir = '';
const lockFile = (): string => path.join(dir, UPDATE_LOCK_FILENAME);

beforeEach(() => {
  t = tempHome('ul-');
  dir = path.join(t.home, 'config');
});

afterEach(() => {
  t.cleanup();
});

/** The refusal sentence of `run`, or a marker when it did not refuse. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (failure) {
    if (failure instanceof Refusal) return failure.message;
    throw failure;
  }
  return '(no refusal)';
}

/** A lock written by another live process (the test runner's parent) with `body`. */
function heldByParent(body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockFile(), `${String(process.ppid)}\n${body}`, { mode: 0o600 });
}

describe('the update lock: take and release', () => {
  it('takes update.lock with the PID line and a 32-hex token, without installed; release removes it', () => {
    const lock = takeUpdateLock(dir, WHAT);
    expect(lock.file).toBe(lockFile());
    expect(lock.inherited).toBe(false);
    expect(lock.installed).toBeNull();
    expect(lock.token).toMatch(/^[0-9a-f]{32}$/u);
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${String(process.pid)}\ntoken=${lock.token}\n`);
    lock.release();
    expect(existsSync(lockFile())).toBe(false);
  });

  it('after an install the body carries installed.version and installed.root, and parses back', () => {
    const root = path.join(t.home, 'store', 'rarog@1.4.0', 'node_modules', 'rarog');
    const lock = takeUpdateLock(dir, WHAT, { version: '1.4.0', root });
    const text = readFileSync(lockFile(), 'utf8');
    expect(text).toBe(`${String(process.pid)}\ntoken=${lock.token}\ninstalled.version=1.4.0\ninstalled.root=${root}\n`);
    expect(parseUpdateLock(text)).toEqual({ token: lock.token, installed: { version: '1.4.0', root } });
    lock.release();
  });

  it('a second live lock: a refusal in one sentence with the PID and the lock file, the lock unchanged', () => {
    heldByParent(`token=${OTHER}\n`);
    const said = refusal(() => takeUpdateLock(dir, WHAT));
    expect(said).toBe(`${WHAT}: another update is running (PID ${String(process.ppid)}, lock ${lockFile()});`
      + ' wait until it ends.');
    expect(said.split(/[.;:] /u).length).toBeLessThanOrEqual(3);
    expect(said).not.toContain('\n');
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${String(process.ppid)}\ntoken=${OTHER}\n`);
  });

  it('a lock of a dead process is taken over with a new token', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(lockFile(), `999999999\ntoken=${OTHER}\n`);
    const lock = takeUpdateLock(dir, WHAT);
    expect(lock.token).not.toBe(OTHER);
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${String(process.pid)}\ntoken=${lock.token}\n`);
    lock.release();
  });

  it('the restart lock is another file: rarog restart takes it while the update lock is held', () => {
    const update = takeUpdateLock(dir, WHAT);
    const restart = acquireLock(dir, 'rarog restart');
    expect(restart.file).toBe(path.join(dir, LOCK_FILENAME));
    expect(readFileSync(restart.file, 'utf8')).toBe(`${String(process.pid)}\n`);
    restart.release();
    expect(existsSync(lockFile())).toBe(true);
    update.release();
  });
});

describe('the update lock: inheritance by token', () => {
  it('a child process with the good token inherits the lock: installed from the body, release leaves the file', () => {
    const root = path.join(t.home, 'lib', 'node_modules', 'rarog');
    heldByParent(updateLockBody({ token: TOKEN, installed: { version: '2.0.0', root } }));
    const lock = updateLockOf(dir, { [UPDATE_LOCK_TOKEN]: TOKEN }, WHAT);
    expect(lock.inherited).toBe(true);
    expect(lock.installed).toEqual({ version: '2.0.0', root });
    lock.release();
    expect(existsSync(lockFile())).toBe(true);
  });

  it('a bad token: refused in one sentence, the lock unchanged', () => {
    heldByParent(`token=${TOKEN}\n`);
    const before = readFileSync(lockFile(), 'utf8');
    expect(refusal(() => updateLockOf(dir, { [UPDATE_LOCK_TOKEN]: OTHER }, WHAT))).toBe(`${WHAT}:`
      + ` ${UPDATE_LOCK_TOKEN} does not match the update lock ${lockFile()}, which another update holds; wait until`
      + ' it ends.');
    expect(readFileSync(lockFile(), 'utf8')).toBe(before);
  });

  it('a token, but no lock to inherit: refused, nothing created', () => {
    expect(refusal(() => inheritUpdateLock(dir, TOKEN, WHAT))).toBe(`${WHAT}: ${UPDATE_LOCK_TOKEN} is set, but there`
      + ` is no readable update lock ${lockFile()} to inherit; run it without that variable.`);
    expect(existsSync(dir)).toBe(false);
  });

  it('an empty token variable takes the lock as without it', () => {
    const lock = updateLockOf(dir, { [UPDATE_LOCK_TOKEN]: '' }, WHAT);
    expect(lock.inherited).toBe(false);
    lock.release();
  });
});

describe('the update lock: body shape', () => {
  const pid = '123\n';
  for (const [name, text] of [
    ['no token', `${pid}installed.version=1.0.0\ninstalled.root=/opt/rarog\n`],
    ['a short token', `${pid}token=abc\n`],
    ['an unknown key', `${pid}token=${TOKEN}\nroot=/opt/rarog\n`],
    ['a repeated key', `${pid}token=${TOKEN}\ntoken=${TOKEN}\n`],
    ['only installed.root', `${pid}token=${TOKEN}\ninstalled.root=/opt/rarog\n`],
    ['a relative root', `${pid}token=${TOKEN}\ninstalled.version=1.0.0\ninstalled.root=opt/rarog\n`],
  ] as const) {
    it(`${name}: no body`, () => {
      expect(parseUpdateLock(text)).toBeNull();
    });
  }

  it('a root with a line end has no line form', () => {
    expect(() => updateLockBody({ token: TOKEN, installed: { version: '1.0.0', root: '/opt/ra\nrog' } })).toThrow();
  });
});
