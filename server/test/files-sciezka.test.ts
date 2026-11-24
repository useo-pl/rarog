/**
 * The path rule of the session file routes (`server/src/files/`): the session gate, the shape and text checks, the
 * walk segment by segment, the open and the check after it, and the listing of one directory, on a real directory
 * under the run's temporary directory. A counting disk port shows which checks happen before any disk call and lets
 * a test swap a directory for a symlink between the walk and the open, or during the read of a listed directory.
 */
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FILE_ENTRIES, compareFileEntries } from '@rarog/shared';
import type { FileListing } from '@rarog/shared';
import { fileListingSchema } from '@rarog/shared/rest';
import { FILES_DISK, openSessionFile, resolveSessionDir } from '../src/files/path-rule.ts';
import type { FilesArea, FilesDisk, Ruled, SessionFile } from '../src/files/path-rule.ts';
import { listSessionDir } from '../src/files/listing.ts';
import { filesArea, filesSession } from '../src/files/session-gate.ts';
import { say } from '@rarog/shared/sentences';
import { NotFoundError } from '../src/sessions/errors.ts';
import { Session } from '../src/sessions/session.ts';
import type { SessionInit } from '../src/sessions/session.ts';
import { IS_MAC, macOnly } from './platform.ts';

const MAX_BYTES = 50 * 1024 * 1024;
const AT = new Date(1_756_000_000_000).toISOString();

let base = '';
let home = '';
let root = '';
let cwd = '';

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'rarog-files-'));
  home = path.join(base, 'home');
  root = path.join(home, 'Projects');
  cwd = path.join(root, 'app');
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(rel: string, text = rel): Promise<string> {
  const file = path.join(cwd, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

/** The area of `dir` under `roots` (default: the session directory under `~/Projects`). */
function areaOf(dir = cwd, roots = [root]): FilesArea {
  const area = filesArea(dir, { demo: false, herdrRoots: roots, home });
  if (!area.ok) throw new Error(`${dir}: ${area.refusal.code}`);
  return area.value;
}

interface Counted {
  readonly disk: FilesDisk;
  readonly calls: string[];
  /** Runs before the real `open`; a test swaps a directory there. */
  beforeOpen?: () => Promise<void>;
  /** Runs after the real `open`, before the rule checks it again. */
  afterOpen?: () => Promise<void>;
  /** Steps around the read of the directory `target` (its path on disk), by path or by identity alike. */
  aroundRead?: { readonly target: string; readonly before: () => Promise<void>; readonly after: () => Promise<void> };
  readonly closed: string[];
}

/**
 * The real disk with every call recorded, the hooks around `open` and around the read of one directory, and the
 * closes of opened handles.
 */
function counting(): Counted {
  const calls: string[] = [];
  const closed: string[] = [];
  const around = async <T>(dir: string, read: () => Promise<T>): Promise<T> => {
    const hook = counted.aroundRead;
    if (hook?.target !== dir) return read();
    await hook.before();
    try {
      return await read();
    } finally {
      await hook.after();
    }
  };
  const counted: Counted = {
    calls,
    closed,
    disk: {
      readdir: async (dir) => { calls.push(`readdir ${dir}`); return around(dir, () => FILES_DISK.readdir(dir)); },
      readdirByIdentity: async (dir) => {
        calls.push(`readdirByIdentity ${dir.real}`);
        return around(dir.real, () => FILES_DISK.readdirByIdentity(dir));
      },
      lstat: async (file) => { calls.push(`lstat ${file}`); return FILES_DISK.lstat(file); },
      stat: async (file) => { calls.push(`stat ${file}`); return FILES_DISK.stat(file); },
      realpath: async (file) => { calls.push(`realpath ${file}`); return FILES_DISK.realpath(file); },
      open: async (file) => {
        calls.push(`open ${file}`);
        await counted.beforeOpen?.();
        const opened = await FILES_DISK.open(file);
        await counted.afterOpen?.();
        if (opened === null) return null;
        const close = opened.handle.close.bind(opened.handle);
        opened.handle.close = async () => { closed.push(file); return close(); };
        return opened;
      },
      area: {
        lstat: (file) => { calls.push(`area.lstat ${file}`); return FILES_DISK.area.lstat(file); },
        readlink: (file) => { calls.push(`area.readlink ${file}`); return FILES_DISK.area.readlink(file); },
        realpath: (file) => { calls.push(`area.realpath ${file}`); return FILES_DISK.area.realpath(file); },
      },
    },
  };
  return counted;
}

const codeOf = <T>(result: Ruled<T>): string => (result.ok ? 'ok' : result.refusal.code);

/** Reads the opened file whole and closes it; a refusal gives its code. */
async function contentOf(result: Ruled<SessionFile>): Promise<string> {
  if (!result.ok) return `refused ${result.refusal.code}`;
  try {
    return (await result.value.handle.readFile()).toString('utf8');
  } finally {
    await result.value.handle.close();
  }
}

describe('files path rule: shape of the path (400 bad-path, no disk call)', () => {
  const BAD = ['../x', '/etc', 'a/./b', 'a//b', 'a\0b', 'a/', '.', '..', 'a/../b', `${'a/'.repeat(2048)}b`];

  it.each(BAD.map((rel) => [JSON.stringify(rel).slice(0, 40), rel]))('%s', async (_label, rel) => {
    const counted = counting();
    const area = areaOf();
    expect(codeOf(await openSessionFile(area, rel, counted.disk))).toBe('bad-path');
    expect(codeOf(await resolveSessionDir(area, rel, counted.disk))).toBe('bad-path');
    expect(counted.calls).toEqual([]);
  });

  it('an empty path is the session directory for a listing and a bad path for a file', async () => {
    const counted = counting();
    expect(codeOf(await openSessionFile(areaOf(), '', counted.disk))).toBe('bad-path');
    expect(counted.calls).toEqual([]);
    expect(codeOf(await resolveSessionDir(areaOf(), '', counted.disk))).toBe('ok');
  });

  it('the refusal carries the status and the sentence of the contract', async () => {
    const result = await openSessionFile(areaOf(), '../x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toMatchObject({ status: 400, code: 'bad-path' });
    expect(result.refusal.sentence.ref).toEqual({ code: 'rest.diff-bad-path' });
  });
});

describe('files path rule: refused on the text (404 not-found, no disk call)', () => {
  it.each(['.env', '.git/config', 'a/.x/b', 'node_modules/p/i.js', 'Node_Modules/p'])('%s', async (rel) => {
    await put(rel);
    const counted = counting();
    const result = await openSessionFile(areaOf(), rel, counted.disk);
    expect(codeOf(result)).toBe('not-found');
    if (!result.ok) expect(result.refusal.status).toBe(404);
    expect(codeOf(await resolveSessionDir(areaOf(), rel, counted.disk))).toBe('not-found');
    expect(counted.calls).toEqual([]);
  });

  it('session directory `~` with the root `~`: `Documents/x` is refused before any disk call', async () => {
    await mkdir(path.join(home, 'Documents'), { recursive: true });
    await writeFile(path.join(home, 'Documents', 'x'), 'private');
    await mkdir(path.join(home, 'Desktop'), { recursive: true });
    const area = areaOf(home, [home]);
    const counted = counting();
    expect(codeOf(await openSessionFile(area, 'Documents/x', counted.disk))).toBe('not-found');
    expect(codeOf(await resolveSessionDir(area, 'Desktop', counted.disk))).toBe('not-found');
    expect(codeOf(await resolveSessionDir(area, 'documents', counted.disk))).toBe('not-found');
    expect(counted.calls).toEqual([]);
  });

  it('home configured through a symlink, the pane in its physical directory: `Documents/x` → 404, no disk call', async () => {
    const physical = path.join(base, 'physical-home');
    await mkdir(path.join(physical, 'Documents'), { recursive: true });
    await writeFile(path.join(physical, 'Documents', 'x'), 'private');
    const linked = path.join(base, 'linked-home');
    await symlink(physical, linked);
    const area = filesArea(realpathSync(physical), { demo: false, herdrRoots: [linked], home: linked });
    expect(area.ok).toBe(true);
    if (!area.ok) return;
    const counted = counting();
    expect(codeOf(await openSessionFile(area.value, 'Documents/x', counted.disk))).toBe('not-found');
    expect(codeOf(await resolveSessionDir(area.value, 'Documents', counted.disk))).toBe('not-found');
    expect(counted.calls).toEqual([]);
  });

  it('`Desktop` and `Documents` are on no listing of `~`, and nothing is read inside them', async () => {
    for (const name of ['Desktop', 'Documents', 'Library']) await mkdir(path.join(home, name, 'inner'), { recursive: true });
    await writeFile(path.join(home, 'notes.txt'), 'n');
    const counted = counting();
    const listed = await listSessionDir(areaOf(home, [home]), '', { maxBytes: MAX_BYTES }, counted.disk);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.entries.map((entry) => entry.name)).toEqual(['Projects', 'notes.txt']);
    const touched = counted.calls.filter((call) => /\/(?:Desktop|Documents|Library)(?:\/|$)/u.test(call));
    expect(touched).toEqual([]);
  });
});

describe('files path rule: the walk on disk', () => {
  it('the name compares byte for byte with the directory: `README.MD` does not open `README.md`', async () => {
    await put('README.md', 'readme');
    expect(await contentOf(await openSessionFile(areaOf(), 'README.MD'))).toBe('refused not-found');
    expect(await contentOf(await openSessionFile(areaOf(), 'README.md'))).toBe('readme');
    await put('Docs/a.txt', 'a');
    expect(codeOf(await resolveSessionDir(areaOf(), 'docs'))).toBe('not-found');
    expect(await contentOf(await openSessionFile(areaOf(), 'docs/a.txt'))).toBe('refused not-found');
  });

  it('a symlinked file, a file under a symlinked directory and the symlinked directory itself → 404', async () => {
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(path.join(outside, 'secret.txt'), path.join(cwd, 'link.txt'));
    await symlink(outside, path.join(cwd, 'linked'));
    await mkdir(path.join(cwd, 'real'));
    await writeFile(path.join(cwd, 'real', 'target.txt'), 'inside');
    await symlink('target.txt', path.join(cwd, 'real', 'near.txt'));
    for (const rel of ['link.txt', 'linked/secret.txt', 'real/near.txt']) {
      expect(await contentOf(await openSessionFile(areaOf(), rel)), rel).toBe('refused not-found');
    }
    expect(codeOf(await resolveSessionDir(areaOf(), 'linked'))).toBe('not-found');
    expect(await contentOf(await openSessionFile(areaOf(), 'real/target.txt'))).toBe('inside');
  });

  it('a FIFO is refused at once, without waiting for a writer', async () => {
    execFileSync('mkfifo', [path.join(cwd, 'pipe')]);
    const started = Date.now();
    expect(await contentOf(await openSessionFile(areaOf(), 'pipe'))).toBe('refused not-found');
    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);

  it('a file with a second hard link is refused under both names', async () => {
    const file = await put('a.txt', 'shared');
    await link(file, path.join(cwd, 'b.txt'));
    expect(await contentOf(await openSessionFile(areaOf(), 'a.txt'))).toBe('refused not-found');
    expect(await contentOf(await openSessionFile(areaOf(), 'b.txt'))).toBe('refused not-found');
  });

  it('a missing path, a directory asked as a file and a file asked as a directory → 404', async () => {
    await put('src/a.ts', 'a');
    expect(codeOf(await openSessionFile(areaOf(), 'src/missing.ts'))).toBe('not-found');
    expect(codeOf(await openSessionFile(areaOf(), 'src'))).toBe('not-found');
    expect(codeOf(await resolveSessionDir(areaOf(), 'src/a.ts'))).toBe('not-found');
    expect(codeOf(await resolveSessionDir(areaOf(), 'gone'))).toBe('not-found');
    expect(codeOf(await resolveSessionDir(areaOf(), 'src'))).toBe('ok');
  });

  it('the opened file brings its size from the descriptor', async () => {
    await put('docs/brief.txt', 'twelve bytes');
    const result = await openSessionFile(areaOf(), 'docs/brief.txt');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.size).toBe(12);
    await result.value.handle.close();
  });
});

describe('files path rule: the check after the open', () => {
  async function swapForLink(): Promise<string> {
    const outside = path.join(base, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'b.txt'), 'outside');
    await rename(path.join(cwd, 'a'), path.join(cwd, 'a-old'));
    await symlink(outside, path.join(cwd, 'a'));
    return outside;
  }

  it('an intermediate directory swapped for a symlink between the walk and the open → 404, handle closed', async () => {
    await put('a/b.txt', 'inside');
    const counted = counting();
    counted.beforeOpen = async () => { await swapForLink(); };
    expect(await contentOf(await openSessionFile(areaOf(), 'a/b.txt', counted.disk))).toBe('refused not-found');
    expect(counted.closed).toHaveLength(1);
  });

  it('swapped before the open and back before the check → 404 by the inode, handle closed', async () => {
    await put('a/b.txt', 'inside');
    const counted = counting();
    counted.beforeOpen = async () => { await swapForLink(); };
    counted.afterOpen = async () => {
      await rm(path.join(cwd, 'a'));
      await rename(path.join(cwd, 'a-old'), path.join(cwd, 'a'));
    };
    expect(await contentOf(await openSessionFile(areaOf(), 'a/b.txt', counted.disk))).toBe('refused not-found');
    expect(counted.closed).toHaveLength(1);
  });

  it('a second hard link made after the walk is refused after the open, handle closed', async () => {
    const file = await put('c.txt', 'c');
    const counted = counting();
    counted.beforeOpen = async () => { await link(file, path.join(base, 'elsewhere.txt')); };
    expect(await contentOf(await openSessionFile(areaOf(), 'c.txt', counted.disk))).toBe('refused not-found');
    expect(counted.closed).toHaveLength(1);
  });
});

describe('files path rule: names', () => {
  const NAMES = ['a+b.txt', '100%.txt', '#x.txt', 'tab\there.txt', 'spaces in name.txt', 'na\u00efve-\u65e5\u672c.txt'];

  it.each(NAMES)('%j opens its own file', async (name) => {
    await put(name, `body of ${name}`);
    expect(await contentOf(await openSessionFile(areaOf(), name))).toBe(`body of ${name}`);
    const listed = await listSessionDir(areaOf(), '', { maxBytes: MAX_BYTES });
    expect(listed.ok && listed.value.entries.map((entry) => entry.name)).toEqual([name]);
  });

  it('NFC and NFD: each name opens only the file stored under it, the other form is 404', async () => {
    const nfc = 'café.txt';
    const nfd = 'café.txt';
    await put(`nfc/${nfc}`, 'composed');
    await put(`nfd/${nfd}`, 'decomposed');
    expect(await contentOf(await openSessionFile(areaOf(), `nfc/${nfc}`))).toBe('composed');
    expect(await contentOf(await openSessionFile(areaOf(), `nfd/${nfd}`))).toBe('decomposed');
    expect(await contentOf(await openSessionFile(areaOf(), `nfc/${nfd}`))).toBe('refused not-found');
    expect(await contentOf(await openSessionFile(areaOf(), `nfd/${nfc}`))).toBe('refused not-found');
    const listed = await listSessionDir(areaOf(), 'nfd', { maxBytes: MAX_BYTES });
    expect(listed.ok && listed.value.entries.map((entry) => entry.name)).toEqual([nfd]);
  });
});

describe('files listing', () => {
  it('directories first, then files, by name without letter case; skipped entries never listed', async () => {
    await put('src/a.ts', 'a');
    await put('Docs/b.md', 'b');
    await put('zeta.txt', 'zz');
    await put('Alpha.txt', 'a');
    await put('beta.txt', 'bbb');
    await put('.env', 'x');
    await put('.git/config', 'x');
    await put('Node_Modules/q/i.js', 'x');
    await symlink(path.join(cwd, 'zeta.txt'), path.join(cwd, 'link.txt'));
    await symlink(path.join(cwd, 'src'), path.join(cwd, 'link-dir'));
    execFileSync('mkfifo', [path.join(cwd, 'pipe')]);
    await link(path.join(cwd, 'beta.txt'), path.join(cwd, 'beta-again.txt'));
    const listed = await listSessionDir(areaOf(), '', { maxBytes: MAX_BYTES });
    expect(listed).toEqual({
      ok: true,
      value: {
        dir: '',
        entries: [
          { name: 'Docs', kind: 'dir' },
          { name: 'src', kind: 'dir' },
          { name: 'Alpha.txt', kind: 'file', size: 1 },
          { name: 'zeta.txt', kind: 'file', size: 2 },
        ],
        truncated: false,
        maxBytes: MAX_BYTES,
      },
    });
    if (listed.ok) expect(fileListingSchema.parse(listed.value)).toEqual(listed.value);
  });

  it('a subdirectory lists under its relative path; the order is the contract comparator', async () => {
    for (const name of ['b.ts', 'A.ts', 'C', '_x.ts', '10.ts', '9.ts']) await put(`src/${name}`, name);
    await mkdir(path.join(cwd, 'src', 'lib'));
    const listed = await listSessionDir(areaOf(), 'src', { maxBytes: 1024 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.dir).toBe('src');
    expect(listed.value.maxBytes).toBe(1024);
    const names = listed.value.entries.map((entry) => entry.name);
    expect(names).toEqual(['lib', '10.ts', '9.ts', '_x.ts', 'A.ts', 'b.ts', 'C']);
    expect([...listed.value.entries].sort(compareFileEntries)).toEqual(listed.value.entries);
  });

  it(`${String(MAX_FILE_ENTRIES + 1)} files → the first ${String(MAX_FILE_ENTRIES)} by order and \`truncated\``, async () => {
    const dir = path.join(cwd, 'many');
    await mkdir(dir);
    const names = Array.from({ length: MAX_FILE_ENTRIES + 1 }, (_, i) => `f${String(i).padStart(4, '0')}.txt`);
    await Promise.all(names.map((name) => writeFile(path.join(dir, name), '')));
    const listed = await listSessionDir(areaOf(), 'many', { maxBytes: MAX_BYTES });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.truncated).toBe(true);
    expect(listed.value.entries.map((entry) => entry.name)).toEqual(names.slice(0, MAX_FILE_ENTRIES));
  });

  it('a listing of a path the rule refuses gives the same refusal', async () => {
    await put('.git/config');
    expect(codeOf(await listSessionDir(areaOf(), '.git', { maxBytes: MAX_BYTES }))).toBe('not-found');
    expect(codeOf(await listSessionDir(areaOf(), '../app', { maxBytes: MAX_BYTES }))).toBe('bad-path');
    expect(codeOf(await listSessionDir(areaOf(), 'gone', { maxBytes: MAX_BYTES }))).toBe('not-found');
  });
});

describe('files listing: the entries come from the directory the walk found, not from its path', () => {
  /** Names of the directory `outside` that the listing of `a` must never show. */
  const FOREIGN: ReadonlySet<string> = new Set(['secret-dir', 'secret.txt']);

  /** `a` with one directory and one file of its own, `outside` with the foreign names; `a` on disk. */
  async function twoDirectories(): Promise<{ readonly outside: string; readonly target: string }> {
    await put('a/own.txt', 'own');
    await mkdir(path.join(cwd, 'a', 'own-dir'));
    const outside = path.join(base, 'outside');
    await mkdir(path.join(outside, 'secret-dir'), { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    return { outside, target: path.join(realpathSync(cwd), 'a') };
  }

  const OWN: FileListing = {
    dir: 'a',
    entries: [{ name: 'own-dir', kind: 'dir' }, { name: 'own.txt', kind: 'file', size: 3 }],
    truncated: false,
    maxBytes: MAX_BYTES,
  };

  it('a path that leads elsewhere for the whole read: only the own entries, the directory never read by path', async () => {
    const { outside, target } = await twoDirectories();
    const counted = counting();
    const byPath: string[] = [];
    // As with a symlink to `outside` held in place of `a` from before the read until after the `lstat` of the
    // entries: every call by path under `a` leads into `outside`. The read by identity gives `a` itself.
    const disk: FilesDisk = {
      ...counted.disk,
      readdir: async (dir) => {
        if (dir !== target) return counted.disk.readdir(dir);
        byPath.push(dir);
        return FILES_DISK.readdir(outside);
      },
      lstat: async (file) => (path.dirname(file) === target && FOREIGN.has(path.basename(file))
        ? FILES_DISK.lstat(path.join(outside, path.basename(file)))
        : counted.disk.lstat(file)),
      readdirByIdentity: async (dir) => (dir.real === target ? FILES_DISK.readdir(target) : null),
    };
    expect(await listSessionDir(areaOf(), 'a', { maxBytes: MAX_BYTES }, disk)).toEqual({ ok: true, value: OWN });
    expect(byPath).toEqual([]);
  });

  it.skipIf(!IS_MAC)(macOnly(
    'macOS disk: `a` swapped for a symlink to another directory during its read and back after it → its own entries',
    'the directory read by identity'),
    async () => {
      const { outside, target } = await twoDirectories();
      const counted = counting();
      counted.aroundRead = {
        target,
        before: async () => {
          await rename(path.join(cwd, 'a'), path.join(cwd, 'a-old'));
          await symlink(outside, path.join(cwd, 'a'));
        },
        after: async () => {
          await rm(path.join(cwd, 'a'));
          await rename(path.join(cwd, 'a-old'), path.join(cwd, 'a'));
        },
      };
      expect(await listSessionDir(areaOf(), 'a', { maxBytes: MAX_BYTES }, counted.disk)).toEqual({ ok: true, value: OWN });
    },
  );

  const failure = (code: string): Error => Object.assign(new Error(code), { code });

  it.each([
    ['the read cannot be bound to the directory (another platform, another directory there)', 'not-found', null],
    ['the directory is gone by the read (`ENOENT`)', 'not-found', failure('ENOENT')],
    ['the identity is no directory now (`ENOTDIR`)', 'not-found', failure('ENOTDIR')],
    ['a symlink stands in its place (`ELOOP`)', 'not-found', failure('ELOOP')],
    ['the server may not read the directory (`EACCES`)', 'empty', failure('EACCES')],
    ['the server may not read the directory (`EPERM`)', 'empty', failure('EPERM')],
  ] as const)('%s → %s', async (_label, expected, outcome) => {
    await put('a/own.txt', 'own');
    const disk: FilesDisk = {
      ...FILES_DISK,
      readdirByIdentity: async () => {
        if (outcome === null) return null;
        throw outcome;
      },
    };
    const listed = await listSessionDir(areaOf(), 'a', { maxBytes: MAX_BYTES }, disk);
    expect(listed.ok ? (listed.value.entries.length === 0 ? 'empty' : 'entries') : listed.refusal.code).toBe(expected);
  });

  it('a directory its `lstat` under the path shows as a symlink drops; entries on another device stay', async () => {
    for (const name of ['keep', 'moved', 'linked']) await mkdir(path.join(cwd, 'a', name), { recursive: true });
    await put('a/moved.txt', 'm');
    await symlink(path.join(cwd, 'a', 'keep'), path.join(base, 'link'));
    const target = path.join(realpathSync(cwd), 'a');
    const onAnotherDevice = async (file: string): Promise<BigIntStats> => {
      const info = await FILES_DISK.lstat(file);
      return new Proxy(info, { get: (stats, key) => (key === 'dev' ? stats.dev + 1n : Reflect.get(stats, key)) });
    };
    const disk: FilesDisk = {
      ...FILES_DISK,
      lstat: async (file) => {
        if (path.dirname(file) !== target) return FILES_DISK.lstat(file);
        if (path.basename(file) === 'linked') return FILES_DISK.lstat(path.join(base, 'link'));
        return path.basename(file).startsWith('moved') ? onAnotherDevice(file) : FILES_DISK.lstat(file);
      },
    };
    const listed = await listSessionDir(areaOf(), 'a', { maxBytes: MAX_BYTES }, disk);
    // A directory on another device is a mount point the path rule allows; a file on another device is a lower-layer
    // file of overlayfs over two file systems. Both stay.
    expect(listed.ok && listed.value.entries).toEqual([
      { name: 'keep', kind: 'dir' }, { name: 'moved', kind: 'dir' }, { name: 'moved.txt', kind: 'file', size: 1 },
    ]);
  });
});

describe('files session gate', () => {
  function session(extra: Partial<SessionInit> = {}, pane = true): Session {
    return new Session({
      id: 's1', cwd, title: 'app', state: 'running', stateSince: AT, createdAt: AT, lastActivityAt: AT,
      ...(pane ? { herdrKey: 'k1' } : {}), ...extra,
    });
  }
  const port = (one: Session, demo = false): Parameters<typeof filesSession>[1] => ({
    require: (id: string): Session => {
      if (id !== one.id) throw new NotFoundError(say('rest.session-not-found'));
      return one;
    },
    config: { demo, herdrRoots: [root], home },
  });

  it('a pane under the roots gets the area of its directory in both forms', () => {
    const gate = filesSession('s1', port(session()));
    expect(gate.kind).toBe('area');
    if (gate.kind !== 'area') return;
    expect(gate.area).toMatchObject({ cwd, realCwd: realpathSync(cwd), roots: [root], home });
  });

  it('Codex → 400 `codex`; out of scope, no pane, a directory outside the roots → 400 `out-of-scope`', () => {
    const refusal = (one: Session): unknown => {
      const gate = filesSession('s1', port(one));
      return gate.kind === 'refused' ? [gate.refusal.status, gate.refusal.code, gate.refusal.sentence.ref.code] : gate.kind;
    };
    expect(refusal(session({ engine: 'codex' }))).toEqual([400, 'codex', 'rest.files-codex']);
    expect(refusal(session({ outOfScope: true }))).toEqual([400, 'out-of-scope', 'rest.files-out-of-scope']);
    expect(refusal(session({}, false))).toEqual([400, 'out-of-scope', 'rest.files-no-pane']);
    expect(refusal(session({ cwd: base }))).toEqual([400, 'out-of-scope', 'rest.files-out-of-scope']);
  });

  it('the demo reads nothing from disk, also for a session without a pane', () => {
    const gate = filesSession('s1', port(session({ cwd: '/Users/demo/Projects/x' }, false), true));
    expect(gate.kind).toBe('demo');
  });

  it('an unknown session throws the manager 404', () => {
    expect(() => filesSession('other', port(session()))).toThrow(NotFoundError);
  });

  it('a root that is a symlink: the physical directory of the pane opens its files', async () => {
    const physical = path.join(base, 'physical');
    await mkdir(path.join(physical, 'app'), { recursive: true });
    await writeFile(path.join(physical, 'app', 'f.txt'), 'via link');
    const linkRoot = path.join(home, 'Linked');
    await symlink(physical, linkRoot);
    const area = areaOf(path.join(realpathSync(physical), 'app'), [linkRoot]);
    expect(await contentOf(await openSessionFile(area, 'f.txt'))).toBe('via link');
  });
});
