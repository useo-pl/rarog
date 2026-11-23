/**
 * The directory browser (`server/src/fs-browse.ts`) with the root `~`: the macOS-protected folders of home
 * neither appear on the list nor get a single read, a path into them is refused before the disk, and a listing says
 * whether the listed directory itself is a repository and has CLI history. Separate file, because the test wraps
 * `node:fs/promises` to record every path the browser touched.
 */
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Whether the disk of the temporary directory ignores letter case, like the default APFS of macOS. */
const CASE_BLIND = existsSync(tmpdir().toUpperCase()) && tmpdir().toUpperCase() !== tmpdir();

const touched = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const record = <F extends (...args: never[]) => unknown>(fn: F): F => ((...args: Parameters<F>) => {
    touched.push(String(args[0]));
    return fn(...args);
  }) as F;
  return {
    ...real,
    readdir: record(real.readdir),
    stat: record(real.stat),
    lstat: record(real.lstat),
    realpath: record(real.realpath),
  };
});

const { browseDirectory } = await import('../src/fs-browse.ts');
const { projectSlug } = await import('../src/cli-store.ts');
type Result = Awaited<ReturnType<typeof browseDirectory>>;

let base = '';
let home = '';
let store = '';

const walk = {
  lstat: (file: string) => {
    touched.push(file);
    return lstatSync(file);
  },
  readlink: (file: string) => {
    touched.push(file);
    return readlinkSync(file);
  },
};

const browse = (path: string | null, roots: readonly string[] = [home]): Promise<Result> =>
  browseDirectory(path, { roots, storeRoot: store, home, walk });

/** Paths touched in `<home>/<folder>` or at it. */
const at = (folder: string): string[] => touched.filter((file) => file === join(home, folder)
  || file.startsWith(`${join(home, folder)}/`));

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'rarog-fs-area-')));
  home = join(base, 'demo');
  store = join(base, 'store');
  for (const dir of ['inne/repo/.git', 'inne/plain', 'Desktop/y/.git', 'Documents/Projects/p', 'Library/z', '.cache/x']) {
    await mkdir(join(home, dir), { recursive: true });
  }
  await mkdir(join(store, projectSlug(join(home, 'inne', 'repo'))), { recursive: true });
  touched.length = 0;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('browseDirectory with the root ~', () => {
  it('home lists its folders without the protected ones and without a read inside them', async () => {
    const result = await browse(home);
    expect(result.ok && result.listing.entries.map((entry) => entry.name)).toEqual(['inne']);
    for (const folder of ['Desktop', 'Documents', 'Library']) {
      expect(touched.filter((file) => file.startsWith(`${join(home, folder)}/`)), folder).toEqual([]);
    }
  });

  it('~/Desktop and a path inside it are refused before any disk access', async () => {
    for (const path of [join(home, 'Desktop'), join(home, 'Desktop', 'y'), '~/Library/z']) {
      const result = await browse(path);
      expect(result.ok === false && result.sentence.ref.code, path).toBe('rest.cwd-protected');
    }
    expect(touched).toEqual([]);
  });

  it('~/De\u017fktop/sub, which the default macOS disk reads as ~/Desktop/sub, is refused before any disk access',
    async () => {
      // On a case-sensitive disk the long s spelling is a folder of its own; it exists either way.
      await mkdir(join(home, 'De\u017fktop', 'sub'), { recursive: true });
      touched.length = 0;
      const result = await browse('~/De\u017fktop/sub');
      expect(result.ok === false && result.sentence.ref.code).toBe('rest.cwd-protected');
      expect(touched).toEqual([]);
    });

  it('a symlink into ~/Desktop is refused and nothing in Desktop is touched', async () => {
    await symlink(join(home, 'Desktop', 'y'), join(home, 'inne', 'link'));
    const result = await browse(join(home, 'inne', 'link'));
    expect(result.ok === false && result.sentence.ref.code).toBe('rest.cwd-symlink-escape');
    expect(at('Desktop')).toEqual([]);
  });

  it('a root inside ~/Documents is listed, the folder around it is not', async () => {
    const roots = [home, join(home, 'Documents', 'Projects')];
    const inside = await browse(join(home, 'Documents', 'Projects'), roots);
    expect(inside.ok && inside.listing.entries.map((entry) => entry.name)).toEqual(['p']);
    const around = await browse(join(home, 'Documents'), roots);
    expect(around.ok === false && around.sentence.ref.code).toBe('rest.cwd-protected');
    const top = await browse(null, roots);
    expect(top.ok && top.listing.entries.map((entry) => entry.path)).toEqual(roots);
  });

  it('a root that is a symlink to home lists home without the protected folders and refuses them unread', async () => {
    const dom = join(base, 'dom');
    await symlink(home, dom);
    const top = await browse(dom, [dom]);
    expect(top.ok && top.listing.entries.map((entry) => entry.path)).toEqual([join(dom, 'inne')]);
    for (const path of [join(dom, 'Desktop'), join(dom, 'Desktop', 'y'), join(dom, 'Library', 'z')]) {
      const result = await browse(path, [dom]);
      expect(result.ok === false && result.sentence.ref.code, path).toBe('rest.cwd-symlink-escape');
    }
    for (const folder of ['Desktop', 'Documents', 'Library']) expect(at(folder), folder).toEqual([]);
  });

  /*
   * The walk keeps the letter case of the request and `realpath` gives the roots in the case stored on disk, so a root
   * written in another case than on disk refused its own folders as a symlink escape.
   */
  it('a root written in another letter case than on disk lists its folders '
    + '(skipped when the temporary directory is case-sensitive)', async (ctx) => {
    if (!CASE_BLIND) ctx.skip('the temporary directory is on a case-sensitive volume');
    await mkdir(join(base, 'Case', 'Projects', 'app'), { recursive: true });
    const written = join(base, 'case', 'projects');
    const root = await browse(written, [written]);
    expect(root.ok && root.listing.entries.map((entry) => entry.path)).toEqual([join(written, 'app')]);
    const inside = await browse(join(written, 'app'), [written]);
    expect(inside.ok && inside.listing.path).toBe(join(written, 'app'));
  });
});

describe('the listing carries git and history of the listed directory', () => {
  it('a repository with history: both true; a plain directory: both false', async () => {
    const repo = await browse(join(home, 'inne', 'repo'));
    expect(repo.ok && { git: repo.listing.git, history: repo.listing.history }).toEqual({ git: true, history: true });
    const plain = await browse(join(home, 'inne', 'plain'));
    expect(plain.ok && { git: plain.listing.git, history: plain.listing.history })
      .toEqual({ git: false, history: false });
  });

  it('the roots level has neither field', async () => {
    const top = await browse(null);
    expect(top.ok && Object.keys(top.listing).sort()).toEqual(['entries', 'parent', 'path', 'truncated']);
  });
});
