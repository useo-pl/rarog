/**
 * Start cleanup of `.rarog-uploads` (`sweepAll` in `server/src/herdr/uploads.ts`) and the macOS-protected folders
 * under the home directory (`config/protected-dirs.ts`). Reading a folder such as `~/Desktop` makes macOS show a
 * privacy prompt that nobody sees on a remote machine, and the read waits for it. The walk therefore never touches
 * those folders, unless the root itself lies in one. Separate file, because the test wraps `readdir` and `lstat`
 * from `node:fs/promises` to record every path the walk touched.
 */
import { mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const touched = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readdir: ((...args: Parameters<typeof real.readdir>) => {
      touched.push(String(args[0]));
      return real.readdir(...args);
    }) as typeof real.readdir,
    lstat: ((...args: Parameters<typeof real.lstat>) => {
      touched.push(String(args[0]));
      return real.lstat(...args);
    }) as typeof real.lstat,
  };
});

const { UPLOAD_DIR_NAME, createUploads } = await import('../src/herdr/uploads.ts');

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const STALE = '1-dddddddddddddddd.png';

let base = '';
/** A fake home one level below `base`, so a root above home stays inside the temporary directory. */
let home = '';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-uploads-tcc-'));
  home = join(base, 'demo');
  await mkdir(home);
  touched.length = 0;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A stale attachment in `<home>/<rel>/.rarog-uploads/`; returns its path. */
async function stale(rel: string): Promise<string> {
  const dir = join(home, rel, UPLOAD_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const file = join(dir, STALE);
  await writeFile(file, 'x');
  const when = new Date(NOW - 72 * HOUR);
  await utimes(file, when, when);
  return file;
}

const exists = async (file: string): Promise<boolean> => stat(file).then(() => true, () => false);
const uploads = (): ReturnType<typeof createUploads> => createUploads({ now: () => NOW, home });
/**
 * Paths the walk touched in `<home>/<name>`, under any spelling: the lexical home, its real path, and without case
 * (the default macOS disk is case-insensitive, so `/users/demo/Desktop` reaches the same folder).
 */
async function under(name: string): Promise<string[]> {
  const dirs = [join(home, name), join(await realpath(home), name)].map((d) => d.toLowerCase());
  return touched.filter((p) => {
    const lower = p.toLowerCase();
    return dirs.some((d) => lower === d || lower.startsWith(`${d}${sep}`));
  });
}

/** Whether the volume of `dir` ignores case: the same directory reached with the last segment's case swapped. */
async function caseInsensitive(dir: string): Promise<boolean> {
  const swapped = join(dirname(dir), basename(dir).toUpperCase());
  return swapped !== dir && exists(swapped);
}

describe('sweepAll and the macOS-protected folders', () => {
  it('root = home: cleans Projects, never reads Desktop, Documents or Library', async () => {
    const desktop = await stale('Desktop/x');
    const documents = await stale('Documents/x');
    const library = await stale('Library/x');
    const projects = await stale('Projects/x');
    touched.length = 0;

    await uploads().sweepAll([home]);

    expect(await exists(projects)).toBe(false);
    expect(await exists(desktop)).toBe(true);
    expect(await exists(documents)).toBe(true);
    expect(await exists(library)).toBe(true);
    for (const name of ['Desktop', 'Documents', 'Library']) {
      expect(await under(name)).toEqual([]);
    }
  });

  it('root inside Documents: its attachments are cleaned', async () => {
    const inRoot = await stale('Documents/Projects/a');
    const atRoot = await stale('Documents/Projects');
    await uploads().sweepAll([join(home, 'Documents', 'Projects')]);
    expect(await exists(inRoot)).toBe(false);
    expect(await exists(atRoot)).toBe(false);
  });

  it('root = Documents itself: cleaned as well', async () => {
    const file = await stale('Documents/x');
    await uploads().sweepAll([join(home, 'Documents')]);
    expect(await exists(file)).toBe(false);
  });

  it('root above home: the protected folders of that home stay unread', async () => {
    const desktop = await stale('Desktop');
    touched.length = 0;
    await uploads().sweepAll([base]);
    expect(await exists(desktop)).toBe(true);
    expect(await under('Desktop')).toEqual([]);
  });

  it('root naming home with another case: Desktop stays unread '
    + '(skipped when the temporary directory is case-sensitive)', async (ctx) => {
    if (!(await caseInsensitive(home))) ctx.skip('the temporary directory is on a case-sensitive volume');
    const desktop = await stale('Desktop/x');
    const projects = await stale('Projects/x');
    touched.length = 0;
    await uploads().sweepAll([join(dirname(home), basename(home).toUpperCase())]);
    expect(await exists(projects)).toBe(false);
    expect(await exists(desktop)).toBe(true);
    expect(await under('Desktop')).toEqual([]);
  });

  it('root that is a symlink to home: Desktop stays unread', async () => {
    const desktop = await stale('Desktop/x');
    const projects = await stale('Projects/x');
    const link = join(base, 'home-link');
    await symlink(home, link);
    touched.length = 0;
    await uploads().sweepAll([link]);
    expect(await exists(projects)).toBe(false);
    expect(await exists(desktop)).toBe(true);
    expect(await under('Desktop')).toEqual([]);
    expect(touched.filter((p) => p.startsWith(join(link, 'Desktop')))).toEqual([]);
  });

  it('home given through a symlink, root = its physical path: Desktop stays unread', async () => {
    const desktop = await stale('Desktop/x');
    const projects = await stale('Projects/x');
    const link = join(base, 'home-link');
    await symlink(home, link);
    touched.length = 0;
    await createUploads({ now: () => NOW, home: link }).sweepAll([await realpath(home)]);
    expect(await exists(projects)).toBe(false);
    expect(await exists(desktop)).toBe(true);
    expect(await under('Desktop')).toEqual([]);
  });
});
