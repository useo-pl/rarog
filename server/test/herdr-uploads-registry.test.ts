/**
 * Registry of upload directories (`server/src/herdr/uploads-registry.ts`) and the start sweep that reads it
 * (`sweepAll` in `server/src/herdr/uploads.ts`). The start sweep cleans only the directories where the server wrote
 * attachments itself; it walks the project roots once, when the registry is missing or unreadable, and writes the
 * registry from what it found. The test wraps `readdir` from `node:fs/promises` to record every directory listed,
 * so "the roots were not read" is a fact, not an inference from deleted files, and `rename` to hold one registry
 * write while another one starts.
 */
import {
  lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listed = vi.hoisted(() => [] as string[]);
/**
 * `beforeRename` runs once before the next `rename`, then clears itself. `deniedReaddir`: paths whose `readdir`
 * fails with `EACCES`. `failRealpath`: paths whose `realpath` fails with `EACCES`.
 */
const hooks = vi.hoisted(() => ({
  beforeRename: null as (() => Promise<void>) | null,
  deniedReaddir: new Set<string>(),
  failRealpath: new Set<string>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const denied = (path: string): Error => Object.assign(new Error(`EACCES: permission denied, ${path}`), {
    code: 'EACCES',
  });
  return {
    ...real,
    readdir: ((...args: Parameters<typeof real.readdir>) => {
      listed.push(String(args[0]));
      if (hooks.deniedReaddir.has(String(args[0]))) return Promise.reject(denied(String(args[0])));
      return real.readdir(...args);
    }) as typeof real.readdir,
    realpath: ((...args: Parameters<typeof real.realpath>) => {
      if (hooks.failRealpath.has(String(args[0]))) return Promise.reject(denied(String(args[0])));
      return real.realpath(...args);
    }) as typeof real.realpath,
    rename: (async (...args: Parameters<typeof real.rename>) => {
      const hook = hooks.beforeRename;
      hooks.beforeRename = null;
      if (hook !== null) await hook();
      return real.rename(...args);
    }) as typeof real.rename,
  };
});

const { UPLOAD_DIR_NAME, createUploads } = await import('../src/herdr/uploads.ts');
const { UPLOADS_REGISTRY_FILENAME, createUploadsRegistry } = await import('../src/herdr/uploads-registry.ts');

/** PNG 1×1, the shape `IMAGE_DATA_URL_PATTERN` accepts. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'
  + 'DUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';
const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const STALE = '1-aaaaaaaaaaaaaaaa.png';
const FRESH = '2-bbbbbbbbbbbbbbbb.png';

let base = '';
let dataDir = '';
let home = '';
let root = '';

beforeEach(async () => {
  // Real path: the walk resolves roots with `realpath`, and `/var` on macOS is a symlink to `/private/var`.
  base = await realpath(await mkdtemp(join(tmpdir(), 'rarog-uploads-registry-')));
  dataDir = join(base, 'data');
  home = join(base, 'home');
  root = join(home, 'Projects');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(root, { recursive: true });
  listed.length = 0;
  hooks.beforeRename = null;
  hooks.deniedReaddir.clear();
  hooks.failRealpath.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

const registryFile = (): string => join(dataDir, UPLOADS_REGISTRY_FILENAME);

/** One server process: a registry over `dataDir` and the uploads module that uses it. */
function server(): ReturnType<typeof createUploads> {
  return createUploads({ now: () => NOW, home, registry: createUploadsRegistry({ dataDir }) });
}

/** Registry file as a previous start left it. */
async function seed(dirs: readonly string[]): Promise<void> {
  await writeFile(registryFile(), `${JSON.stringify({ format: 1, dirs })}\n`, { mode: 0o600 });
}

async function registered(): Promise<unknown> {
  return (JSON.parse(await readFile(registryFile(), 'utf8')) as { dirs: unknown }).dirs;
}

/** A file in `<cwd>/.rarog-uploads/` with the given age; returns its path. */
async function put(cwd: string, name: string, ageMs: number): Promise<string> {
  const dir = join(cwd, UPLOAD_DIR_NAME);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  await writeFile(file, 'x');
  const when = new Date(NOW - ageMs);
  await utimes(file, when, when);
  return file;
}

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

describe('a successful attachment write registers its cwd', () => {
  it('two writes in one cwd (photo, then file) leave one entry', async () => {
    await seed([]);
    const cwd = join(root, 'atlas');
    await mkdir(cwd);
    const uploads = server();

    await uploads.write(cwd, [PNG]);
    await uploads.writeFiles(cwd, [{ name: 'report.pdf', dataUrl: PDF }]);

    expect(await registered()).toEqual([cwd]);
  });

  it('two parallel writes in different cwds: both entries survive', async () => {
    await seed([]);
    const atlas = join(root, 'atlas');
    const birch = join(base, 'elsewhere', 'birch');
    await mkdir(atlas, { recursive: true });
    await mkdir(birch, { recursive: true });
    const uploads = server();

    await Promise.all([uploads.write(atlas, [PNG]), uploads.writeFiles(birch, [{ name: 'a.log', dataUrl: PDF }])]);

    expect(new Set(await registered() as string[])).toEqual(new Set([atlas, birch]));
  });

  it('the registry file is 0600', async () => {
    await seed([]);
    const cwd = join(root, 'atlas');
    await mkdir(cwd);
    await server().write(cwd, [PNG]);
    expect((await stat(registryFile())).mode & 0o777).toBe(0o600);
  });

  it('a write before the first-start walk does not create the file; the walk then keeps the entry', async () => {
    const outside = join(base, 'elsewhere', 'cedar');
    await mkdir(outside, { recursive: true });
    const uploads = server();

    await uploads.write(outside, [PNG]);
    expect(await exists(registryFile())).toBe(false);

    await uploads.sweepAll([root]);
    expect(await registered()).toEqual([outside]);
  });

  it('a cwd given through a symlink is registered as its real path', async () => {
    await seed([]);
    const project = join(base, 'real', 'proj');
    await mkdir(project, { recursive: true });
    const link = join(root, 'proj-link');
    await symlink(project, link);

    await server().write(link, [PNG]);

    expect(await registered()).toEqual([project]);
  });

  it('a cwd whose real path cannot be resolved is not registered; the file is still written', async () => {
    await seed([]);
    const cwd = join(root, 'atlas');
    await mkdir(cwd);
    hooks.failRealpath.add(cwd);

    const paths = await server().write(cwd, [PNG]);

    expect(paths).toHaveLength(1);
    expect(await exists(paths[0] ?? '')).toBe(true);
    expect(await registered()).toEqual([]);
  });
});

describe('start with a registry', () => {
  it('cleans only registered directories, also outside the roots, and never lists a root', async () => {
    const atlas = join(base, 'elsewhere', 'atlas');
    const birch = join(root, 'birch');
    const inRegistry = await put(atlas, STALE, 72 * HOUR);
    const notInRegistry = await put(birch, STALE, 72 * HOUR);
    await put(atlas, FRESH, HOUR);
    await seed([atlas]);

    await server().sweepAll([root, home]);

    expect(await exists(inRegistry)).toBe(false);
    expect(await exists(notInRegistry)).toBe(true);
    expect(listed).toEqual([join(atlas, UPLOAD_DIR_NAME)]);
    expect(await registered()).toEqual([atlas]);
  });

  it('an entry whose .rarog-uploads is gone, or empty after the sweep, leaves the registry', async () => {
    const gone = join(root, 'gone');
    const emptied = join(root, 'emptied');
    const kept = join(root, 'kept');
    await mkdir(gone, { recursive: true });
    await put(emptied, STALE, 72 * HOUR);
    await put(kept, FRESH, HOUR);
    await seed([gone, emptied, kept]);

    await server().sweepAll([root]);

    expect(await registered()).toEqual([kept]);
  });

  it('a missing project directory does not stop the other entries', async () => {
    const missing = join(base, 'deleted-project');
    const atlas = join(root, 'atlas');
    const stale = await put(atlas, STALE, 72 * HOUR);
    await put(atlas, FRESH, HOUR);
    await seed([missing, atlas]);

    await server().sweepAll([root]);

    expect(await exists(stale)).toBe(false);
    expect(await registered()).toEqual([atlas]);
  });

  it('an entry whose .rarog-uploads is a symlink: skipped, its target untouched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const victim = join(base, 'victim');
    await mkdir(victim);
    const secret = join(victim, 'notes.txt');
    await writeFile(secret, 'secret');
    const when = new Date(NOW - 72 * HOUR);
    await utimes(secret, when, when);
    const trap = join(root, 'hostile-repo');
    await mkdir(trap, { recursive: true });
    await symlink(victim, join(trap, UPLOAD_DIR_NAME));
    await seed([trap]);

    await server().sweepAll([root]);

    expect(await readdir(victim)).toEqual(['notes.txt']);
    expect((await lstat(join(trap, UPLOAD_DIR_NAME))).isSymbolicLink()).toBe(true);
    expect(listed).not.toContain(join(trap, UPLOAD_DIR_NAME));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(UPLOAD_DIR_NAME));
    expect(await registered()).toEqual([]);
  });

  it.each([
    { replaced: 'app', entry: 'app' },
    { replaced: 'client', entry: join('client', 'app') },
  ])('a registered cwd later reached through a symlink ($replaced replaced): no file touched, entry dropped',
    async ({ replaced, entry }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const outside = join(base, 'outside', 'project');
      const cwd = join(root, entry);
      // The other tree is laid out so that `<cwd>/.rarog-uploads` lands in it once `replaced` is a symlink.
      const notes = await put(join(outside, relative(join(root, replaced), cwd)), 'notes.txt', 72 * HOUR);
      await symlink(outside, join(root, replaced));
      const atlas = join(root, 'atlas');
      const stale = await put(atlas, STALE, 72 * HOUR);
      await put(atlas, FRESH, HOUR);
      await seed([cwd, atlas]);

      await server().sweepAll([root]);

      expect(await exists(notes)).toBe(true);
      expect(listed).toEqual([join(atlas, UPLOAD_DIR_NAME)]);
      expect(await exists(stale)).toBe(false);
      expect(await registered()).toEqual([atlas]);
      const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(cwd));
      expect(lines).toHaveLength(1);
    });
});

describe('start without a registry: one walk of the roots, then the registry', () => {
  it('walks once with today\'s exclusions, registers directories that still hold files; the next start does not walk',
    async () => {
      const staleOnly = join(root, 'client', 'old');
      const withFresh = join(root, 'client', 'app');
      const stale = await put(staleOnly, STALE, 72 * HOUR);
      const staleNext = await put(withFresh, STALE, 72 * HOUR);
      await put(withFresh, FRESH, HOUR);
      const hidden = await put(join(root, 'node_modules', 'pkg'), STALE, 72 * HOUR);

      await server().sweepAll([root]);

      expect(await exists(stale)).toBe(false);
      expect(await exists(staleNext)).toBe(false);
      expect(await exists(hidden)).toBe(true);
      expect(listed).toContain(root);
      expect(await registered()).toEqual([withFresh]);
      expect((await stat(registryFile())).mode & 0o777).toBe(0o600);

      listed.length = 0;
      await server().sweepAll([root]);
      expect(listed).toEqual([join(withFresh, UPLOAD_DIR_NAME)]);
    });

  it('the walk still skips the macOS-protected folders in home', async () => {
    const desktop = await put(join(home, 'Desktop', 'x'), STALE, 72 * HOUR);
    const projects = await put(join(root, 'x'), STALE, 72 * HOUR);

    await server().sweepAll([home]);

    expect(await exists(projects)).toBe(false);
    expect(await exists(desktop)).toBe(true);
    expect(listed.filter((p) => p.startsWith(join(home, 'Desktop')))).toEqual([]);
  });

  it('a .rarog-uploads the walk cannot list stays registered until a later start sweeps it', async () => {
    const app = join(root, 'app');
    const stale = await put(app, STALE, 72 * HOUR);
    hooks.deniedReaddir.add(join(app, UPLOAD_DIR_NAME));

    await server().sweepAll([root]);
    expect(await exists(stale)).toBe(true);
    expect(await registered()).toEqual([app]);

    // Still denied at the next start: the entry stays for another try.
    await server().sweepAll([root]);
    expect(await registered()).toEqual([app]);

    hooks.deniedReaddir.clear();
    await server().sweepAll([root]);
    expect(await exists(stale)).toBe(false);
    expect(await registered()).toEqual([]);
  });

  it('nothing found: an empty registry, and the next start does not walk', async () => {
    await server().sweepAll([root]);
    expect(await registered()).toEqual([]);

    listed.length = 0;
    await server().sweepAll([root]);
    expect(listed).toEqual([]);
  });

  it('a corrupt registry: one log line, one walk, a new valid registry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(registryFile(), 'not json {', { mode: 0o600 });
    const app = join(root, 'app');
    await put(app, FRESH, HOUR);

    await server().sweepAll([root]);

    const lines = warn.mock.calls.map((call) => String(call[0])).filter((l) => l.includes(UPLOADS_REGISTRY_FILENAME));
    expect(lines).toHaveLength(1);
    expect(listed).toContain(root);
    expect(await registered()).toEqual([app]);
  });

  it('an entry that is not an absolute path makes the file unreadable, never a sweep target', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(registryFile(), JSON.stringify({ format: 1, dirs: ['relative/dir'] }), { mode: 0o600 });

    await server().sweepAll([root]);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(UPLOADS_REGISTRY_FILENAME));
    expect(listed.some((p) => p.includes('relative'))).toBe(false);
    expect(await registered()).toEqual([]);
  });
});

describe('the registry queue', () => {
  it('a directory added after the start sweep took its mark is not dropped', async () => {
    const atlas = join(root, 'atlas');
    await seed([atlas]);
    const registry = createUploadsRegistry({ dataDir });
    const mark = registry.mark();

    await registry.add(atlas);
    await registry.drop([atlas], mark);

    expect(await registered()).toEqual([atlas]);
  });

  it('a directory added before the mark is dropped', async () => {
    const atlas = join(root, 'atlas');
    const birch = join(root, 'birch');
    await seed([atlas, birch]);
    const registry = createUploadsRegistry({ dataDir });
    await registry.add(atlas);
    const mark = registry.mark();

    await registry.drop([atlas], mark);

    expect(await registered()).toEqual([birch]);
  });

  it('many parallel adds lose none', async () => {
    await seed([]);
    const registry = createUploadsRegistry({ dataDir });
    const dirs = Array.from({ length: 12 }, (_, i) => join(root, `p${String(i)}`));

    await Promise.all(dirs.map((dir) => registry.add(dir)));

    expect(new Set(await registered() as string[])).toEqual(new Set(dirs));
  });

  it('a write that lands late does not overwrite a later add: the second waits for the first', async () => {
    await seed([]);
    const atlas = join(root, 'atlas');
    const birch = join(root, 'birch');
    const registry = createUploadsRegistry({ dataDir });
    let release = (): void => undefined;
    let renaming = (): void => undefined;
    const renameStarted = new Promise<void>((resolve) => { renaming = resolve; });
    hooks.beforeRename = () => {
      renaming();
      return new Promise<void>((resolve) => { release = resolve; });
    };

    const first = registry.add(atlas);
    await renameStarted;
    const second = registry.add(birch);
    // Time for a second write that does not wait to land before the held one.
    await new Promise<void>((resolve) => { setTimeout(resolve, 30); });
    release();
    await Promise.all([first, second]);

    expect(new Set(await registered() as string[])).toEqual(new Set([atlas, birch]));
  });
});
