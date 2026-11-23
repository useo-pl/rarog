/**
 * The work tree of Rarog's git reads: `core.worktree` in repository config, which the agent writes, does not
 * move a read outside the session directory and its repository. The runner passes `--work-tree=<T>` and
 * `--git-dir=<T>/.git`, where `T` is the session directory or its nearest ancestor with a `.git` entry, and starts no
 * git when there is no such directory.
 *
 * Every case runs the production runner on real git in a temporary directory. A hostile case first shows, with plain
 * git (no guards), that the layout really hands out the file from outside the project. `spawn` is wrapped in a spy,
 * so a case can count the git processes a read starts.
 *
 * Git config is cut off from the machine (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM`), as in
 * `git-konfiguracja-repo.test.ts`.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFile, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { collectDiffFile } from '../src/git-diff.ts';
import {
  collectDiff, gitArgv, gitReadEnv, parseGitStatusV2, spawnGitArgs, spawnGitStatus,
} from '../src/git-status.ts';
import type { GitCommand } from '../src/git-status.ts';
import { gitWorkTree } from '../src/git-work-tree.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

/** Content of the file next to the project; no read of Rarog may hand it out. */
const SECRET = 'KEY-OUTSIDE-PROJECT';

let root = '';
/** Directory next to the projects with `key.txt`: the target of every hostile `core.worktree`. */
let secret = '';

const plainEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
});

/** Environment of Rarog's reads, as the manager builds it. */
const env = (): NodeJS.ProcessEnv => gitReadEnv({
  PATH: process.env['PATH'] ?? '', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
});

/** Git that prepares a repository (unsigned commits, fixed identity, local submodules allowed). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Rarog', '-c', 'user.email=rarog@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always', ...args,
  ], { cwd, env: plainEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Plain git as an agent's shell would run it: its stdout, whatever the exit code. */
function plainGit(cwd: string, ...args: string[]): string {
  return spawnSync('git', args, { cwd, env: { ...plainEnv(), GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8' }).stdout;
}

/** A repository with `b.txt` and `sub/a.txt` committed, and one change in `sub/a.txt`. */
async function project(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, 'sub'), { recursive: true });
  git(dir, 'init', '-q');
  await writeFile(join(dir, 'b.txt'), 'b\n');
  await writeFile(join(dir, 'sub', 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'start');
  await appendFile(join(dir, 'sub', 'a.txt'), 'a2\n');
  return dir;
}

/** Files of `git status --porcelain=v2` from the production status runner in `cwd`. */
async function statusFiles(cwd: string): Promise<string[]> {
  const result = await spawnGitStatus(env())(cwd);
  expect(result.ok, `status in ${cwd}`).toBe(true);
  return parseGitStatusV2(result.stdout).files;
}

/** Git processes started so far (every `spawn` of the runner, with or without `sandbox-exec`). */
const spawned = (): number => vi.mocked(spawn).mock.calls.length;

const STATUS: GitCommand = { sub: 'status', rest: ['--porcelain=v2'] };

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'rarog-git-wt-')));
  secret = join(root, 'secret');
  await mkdir(secret);
  await writeFile(join(secret, 'key.txt'), `${SECRET}\n`);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('gitWorkTree: the nearest directory with a `.git` entry, from the resolved path', () => {
  it.each([
    ['directory', (path: string) => mkdir(path)],
    ['file', (path: string) => writeFile(path, 'gitdir: /nowhere\n')],
    ['dangling symlink', (path: string) => symlink(join(root, 'nowhere'), path)],
  ])('`.git` as a %s counts, seen from a subdirectory', async (kind, make) => {
    const dir = join(root, `kind-${kind.replace(' ', '-')}`);
    await mkdir(join(dir, 'inner'), { recursive: true });
    await make(join(dir, '.git'));
    expect(await gitWorkTree(join(dir, 'inner'))).toBe(dir);
  });

  it('a session directory reached through a symlink walks up its real parents, not the link\'s', async () => {
    const repo = join(root, 'link-real', 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'inner'));
    await mkdir(join(root, 'link-from'));
    await symlink(join(repo, 'inner'), join(root, 'link-from', 'session'));
    expect(await gitWorkTree(join(root, 'link-from', 'session'))).toBe(repo);
  });
});

describe('core.worktree in repository config does not move a read (cases 1, 2, 4, 12)', () => {
  it('case 1: status lists the project change and not the file next to it', async () => {
    const proj = await project('c1');
    git(proj, 'config', 'core.worktree', secret);
    expect(plainGit(proj, 'status', '--porcelain', '--untracked-files=all'), 'control').toContain('?? key.txt');

    const files = await statusFiles(proj);
    expect(files).toEqual(['sub/a.txt']);
    const top = await spawnGitArgs(env())({ sub: 'rev-parse', rest: ['--show-toplevel'] }, proj);
    expect(top.stdout.trim()).toBe(proj);
  });

  it('case 2: with an index entry for the file, `diff HEAD` and the session diff omit its content', async () => {
    const proj = await project('c2');
    // The agent cannot read the file, so the entry carries no content: the empty blob under that name.
    const empty = git(proj, 'hash-object', '-w', '/dev/null').trim();
    git(proj, 'update-index', '--add', '--cacheinfo', `100644,${empty},key.txt`);
    git(proj, 'config', 'core.worktree', secret);
    expect(plainGit(proj, 'diff', 'HEAD'), 'control').toContain(SECRET);

    const run = spawnGitArgs(env());
    const diff = await run({ sub: 'diff', rest: ['HEAD'] }, proj);
    expect(diff.ok).toBe(true);
    expect(diff.stdout).toContain('+a2');
    expect(diff.stdout).not.toContain(SECRET);

    const whole = await collectDiff(proj, { run });
    expect(whole.files.map((file) => file.path)).toContain('sub/a.txt');
    expect(JSON.stringify(whole)).not.toContain(SECRET);
    const one = await collectDiffFile(proj, 'key.txt', { run }).then((file) => file.patch, () => '');
    expect(one).not.toContain(SECRET);
  });

  it('case 4: a nested `.git/` with core.worktree, cwd = that directory: status stays in it', async () => {
    const proj = await project('c4');
    const nest = join(proj, 'nest');
    await mkdir(nest);
    git(nest, 'init', '-q');
    await writeFile(join(nest, 'n.txt'), 'n\n');
    git(nest, 'config', 'core.worktree', secret);
    expect(plainGit(nest, 'status', '--porcelain', '--untracked-files=all'), 'control').toContain('?? key.txt');

    expect(await statusFiles(nest)).toEqual(['n.txt']);
  });

  it('case 12: a `.git` file that points to a git directory with core.worktree: status stays in the project', async () => {
    const proj = join(root, 'c12');
    await mkdir(proj);
    // The git directory lies in the project under another name; `.git` is the file that points to it.
    git(proj, 'init', '-q', `--separate-git-dir=${join(proj, 'meta')}`);
    await writeFile(join(proj, 'n.txt'), 'n\n');
    git(proj, 'config', 'core.worktree', secret);
    expect((await lstat(join(proj, '.git'))).isFile()).toBe(true);
    expect(plainGit(proj, 'status', '--porcelain', '--untracked-files=all'), 'control').toContain('?? key.txt');

    const files = await statusFiles(proj);
    expect(files).toContain('n.txt');
    expect(files).not.toContain('key.txt');
  });
});

describe('a `.git` entry git does not take for a repository does not widen a read to the repository above', () => {
  /** Content committed in the repository above the session directory, outside that directory. */
  const ABOVE = 'COMMITTED-OUTSIDE-SESSION-DIRECTORY';

  it.each([
    ['empty directory', (path: string) => mkdir(path)],
    ['dangling symlink', (path: string) => symlink(join(root, 'nowhere'), path)],
  ])('`.git` as a %s in a repository subdirectory: no read hands out a file from outside it', async (kind, make) => {
    const proj = await project(`above-${kind.replace(' ', '-')}`);
    await mkdir(join(proj, 'private'));
    await mkdir(join(proj, 'public'));
    await writeFile(join(proj, 'private', 'secret.txt'), `${ABOVE}\n`);
    await writeFile(join(proj, 'public', 'p.txt'), 'p\n');
    git(proj, 'add', '-A');
    git(proj, 'commit', '-qm', 'more');
    const session = join(proj, 'public');
    // Before the entry, a read from the subdirectory stays in it (`--relative`).
    expect(plainGit(session, 'diff', '--relative', 'HEAD'), 'control').not.toContain(ABOVE);
    await make(join(session, '.git'));

    const run = spawnGitArgs(env());
    const diff = await run({ sub: 'diff', rest: ['--relative', 'HEAD'] }, session);
    expect(diff.stdout).not.toContain(ABOVE);
    const whole = await collectDiff(session, { run });
    expect(JSON.stringify(whole)).not.toContain(ABOVE);
    const one = await collectDiffFile(session, 'private/secret.txt', { run }).then((file) => file.patch, () => '');
    expect(one).not.toContain(ABOVE);
    const status = await spawnGitStatus(env())(session);
    expect(status).toMatchObject({ ok: false, exitCode: 128 });
  });

  it('every git process of a read, the config names read included, names the repository directory', async () => {
    const proj = await project('pinned');
    const before = spawned();
    expect((await spawnGitArgs(env())(STATUS, join(proj, 'sub'))).ok).toBe(true);

    // The runner's own probes (`--exec-path`, `version`) read no repository; they run once per process, so they
    // show up here only when this test is the first read.
    const started = vi.mocked(spawn).mock.calls.slice(before)
      .map((call) => call[1] as readonly string[])
      .filter((argv) => argv.at(-1) !== '--exec-path' && argv.at(-1) !== 'version');
    expect(started.map((argv) => argv.at(-1))).toEqual(['--list', '--porcelain=v2']);
    for (const argv of started) {
      expect(argv).toContain(`--git-dir=${join(proj, '.git')}`);
      expect(argv).toContain(`--work-tree=${proj}`);
    }
  });
});

describe('reads that already worked keep working (cases 3, 5, 6)', () => {
  it('case 3: cwd in a repository subdirectory: status and `diff --relative HEAD` as from plain git', async () => {
    const proj = await project('c3');
    await appendFile(join(proj, 'b.txt'), 'b2\n');
    const sub = join(proj, 'sub');

    const plainStatus = plainGit(sub, 'status', '--porcelain=v2', '--branch', '--untracked-files=all');
    expect(await statusFiles(sub)).toEqual(parseGitStatusV2(plainStatus).files);
    expect(await statusFiles(sub)).toEqual(['../b.txt', 'a.txt']);
    const diff = await spawnGitArgs(env())({ sub: 'diff', rest: ['--relative', 'HEAD'] }, sub);
    expect(diff.stdout).toContain('diff --git a/a.txt b/a.txt');
    expect(diff.stdout).toBe(plainGit(sub, 'diff', '--relative', 'HEAD'));
  });

  it('case 5: linked worktree (`.git` is a file): status lists the new file', async () => {
    const proj = await project('c5');
    const linked = join(root, 'c5-linked');
    git(proj, 'worktree', 'add', '-q', '-b', 'linked', linked);
    await writeFile(join(linked, 'x.txt'), 'x\n');

    expect((await lstat(join(linked, '.git'))).isFile()).toBe(true);
    expect(await statusFiles(linked)).toEqual(['x.txt']);
  });

  it('case 6: cwd = submodule (its own core.worktree): status lists the change in the submodule', async () => {
    const lib = join(root, 'c6-lib');
    await mkdir(lib);
    git(lib, 'init', '-q');
    await writeFile(join(lib, 'l.txt'), 'l\n');
    git(lib, 'add', '-A');
    git(lib, 'commit', '-qm', 'lib');
    const proj = await project('c6');
    git(proj, 'submodule', '-q', 'add', lib, 'vendor/lib');
    git(proj, 'commit', '-qm', 'submodule');
    const module = join(proj, 'vendor', 'lib');
    await appendFile(join(module, 'l.txt'), 'l2\n');

    expect(git(module, 'config', '--get', 'core.worktree').trim()).not.toBe('');
    expect(await statusFiles(module)).toEqual(['l.txt']);
  });
});

describe('no git starts without a work tree or with a work tree from the caller (cases 7, 8, 9)', () => {
  it('case 7: a directory without a repository: exit code 128 and no git process', async () => {
    const plain = join(root, 'c7');
    await mkdir(plain);
    for (let dir = plain; dir !== dirname(dir); dir = dirname(dir)) {
      await expect(lstat(join(dir, '.git')), `precondition: no .git in ${dir}`).rejects.toThrow();
    }

    const before = spawned();
    expect(await spawnGitArgs(env())(STATUS, plain)).toEqual({ ok: false, stdout: '', exitCode: 128 });
    expect(spawned() - before).toBe(0);
  });

  it('case 8: a session directory that does not exist: `spawnFailed` and no git process', async () => {
    const before = spawned();
    expect(await spawnGitArgs(env())(STATUS, join(root, 'c8-missing')))
      .toEqual({ ok: false, stdout: '', spawnFailed: 'ENOENT' });
    expect(spawned() - before).toBe(0);
  });

  it('case 9: `--work-tree` from the caller is refused before any git process', async () => {
    const proj = await project('c9');
    const bypass = { global: [`--work-tree=${secret}`], sub: 'status', rest: [] } as unknown as GitCommand;
    expect(() => gitArgv(bypass)).toThrow(/opcja globalna spoza listy/);

    const before = spawned();
    expect(await spawnGitArgs(env())(bypass, proj)).toEqual({ ok: false, stdout: '', spawnFailed: 'UNKNOWN' });
    expect(spawned() - before).toBe(0);
  });
});
