/**
 * The listing of a session directory on real git (`server/src/files/session-files.ts`): the production runner
 * (`spawnGitArgs`) labels ignored entries with `git check-ignore` in the listed directory, on repositories made in
 * the run's temporary directory: a plain repository, a nested repository with its own `.gitignore` and
 * `info/exclude`, a submodule, a session directory without git that holds a repository, a broken `.git`, and names
 * git quotes in its output. A failed git read drops the labels and keeps the listing.
 *
 * Git config is cut off from the machine (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM`), as in
 * `git-diff-repo.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_FILE_ENTRIES } from '@rarog/shared';
import type { FileEntry, FileListing } from '@rarog/shared';
import { fileListingSchema } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import { CHECK_IGNORE_BATCH } from '../src/files/ignored.ts';
import type { Ruled } from '../src/files/path-rule.ts';
import { type SessionFilesPort, listSessionFiles } from '../src/files/session-files.ts';
import { gitReadEnv, spawnGitArgs } from '../src/git-status.ts';
import type { GitArgsResult, GitArgsRunner, GitCommand } from '../src/git-status.ts';
import { NotFoundError } from '../src/sessions/errors.ts';
import { Session } from '../src/sessions/session.ts';
import { IS_MAC, macOnly } from './platform.ts';

const MAX_BYTES = 50 * 1024 * 1024;
const AT = new Date(1_756_000_000_000).toISOString();

let base = '';
let home = '';
let root = '';

/** Git cut off from the machine's config. */
const plainEnv = (): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
});

/** The environment of the server's reads (no transport at all, so it would not clone a submodule). */
const env = (): NodeJS.ProcessEnv => gitReadEnv(plainEnv());

/** Git that prepares a repository (commits without a signature, a fixed identity, a local submodule). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Rarog', '-c', 'user.email=rarog@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always', ...args,
  ], { cwd, env: plainEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'rarog-files-git-'));
  home = path.join(base, 'home');
  root = path.join(home, 'Projects');
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(dir: string, rel: string, text = rel): Promise<void> {
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function project(name: string, withGit = true): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  if (withGit) git(dir, 'init', '-q');
  return dir;
}

function commitAll(dir: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'start');
}

/** Every git command the listing ran, with its directory, on top of the production runner (or `run`). */
function recorded(run: GitArgsRunner = spawnGitArgs(env())): { run: GitArgsRunner; calls: [GitCommand, string][] } {
  const calls: [GitCommand, string][] = [];
  return { calls, run: (command, cwd) => { calls.push([command, cwd]); return run(command, cwd); } };
}

/** The port of a pane session in `cwd` under the roots, with the git runner `run`. */
function portOf(cwd: string, run: GitArgsRunner = spawnGitArgs(env())): SessionFilesPort {
  const session = new Session({
    id: 's1', cwd, title: path.basename(cwd), state: 'running', stateSince: AT, createdAt: AT, lastActivityAt: AT,
    herdrKey: 'k1',
  });
  return {
    require: (id: string): Session => {
      if (id !== session.id) throw new NotFoundError(say('rest.session-not-found'));
      return session;
    },
    config: { demo: false, herdrRoots: [root], home },
    run,
    demoEntries: () => { throw new Error('a pane session never asks the demo data'); },
  };
}

function valueOf(result: Ruled<FileListing>): FileListing {
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
  expect(fileListingSchema.parse(result.value)).toEqual(result.value);
  return result.value;
}

async function listed(cwd: string, dir = '', run?: GitArgsRunner): Promise<FileListing> {
  return valueOf(await listSessionFiles('s1', dir, MAX_BYTES, portOf(cwd, run)));
}

const ignoredOf = (listing: FileListing): string[] =>
  listing.entries.filter((entry) => entry.ignored === true).map((entry) => entry.name);

describe('files listing on git: the session directory', () => {
  let cwd = '';

  beforeAll(async () => {
    cwd = await project('app');
    await put(cwd, '.gitignore', 'dist/\n*.log\n');
    await put(cwd, 'README.md', 'hello');
    await put(cwd, 'src/a.ts', 'a');
    await put(cwd, 'dist/out.js', 'out');
    await put(cwd, 'dist/maps/out.js.map', 'map');
    await put(cwd, 'app.log', 'log');
    await put(cwd, 'kept.log', 'kept');
    await put(cwd, '.env', 'SECRET=x');
    await put(cwd, '.github/workflows/ci.yml', 'ci');
    await put(cwd, 'node_modules/x/i.js', 'x');
    await symlink(path.join(cwd, 'README.md'), path.join(cwd, 'link.md'));
    execFileSync('mkfifo', [path.join(cwd, 'pipe')]);
    git(cwd, 'add', '.gitignore', 'README.md', 'src/a.ts');
    // A tracked file that matches an ignore rule: git does not report it, so it carries no label.
    git(cwd, 'add', '-f', 'kept.log');
    git(cwd, 'commit', '-qm', 'start');
  });

  it('no `dir`: the entries of the session directory, directories first; hidden, special and linked entries left out',
    async () => {
      expect(await listed(cwd)).toEqual({
        dir: '',
        entries: [
          { name: 'dist', kind: 'dir', ignored: true },
          { name: 'src', kind: 'dir' },
          { name: 'app.log', kind: 'file', size: 3, ignored: true },
          { name: 'kept.log', kind: 'file', size: 4 },
          { name: 'README.md', kind: 'file', size: 5 },
        ],
        truncated: false,
        maxBytes: MAX_BYTES,
      });
    });

  it('`dist/` in `.gitignore`: the ignored directory lists, its entries labelled too', async () => {
    expect((await listed(cwd, 'dist')).entries).toEqual([
      { name: 'maps', kind: 'dir', ignored: true },
      { name: 'out.js', kind: 'file', size: 3, ignored: true },
    ]);
    expect(ignoredOf(await listed(cwd, 'dist/maps'))).toEqual(['out.js.map']);
    expect(ignoredOf(await listed(cwd, 'src'))).toEqual([]);
  });

  it('check-ignore runs in the listed directory, on the names of the listing only, after `--` and `./`', async () => {
    const spy = recorded();
    await listed(cwd, 'dist', spy.run);
    expect(spy.calls.map(([command, dir]) => [command.global, command.sub, command.rest, dir])).toEqual([
      [undefined, 'check-ignore', ['--', './maps', './out.js'], path.join(realpathSync(cwd), 'dist')],
    ]);
  });
});

describe('files listing on git: many entries', () => {
  it(`${String(MAX_FILE_ENTRIES + 1)} files → ${String(MAX_FILE_ENTRIES)} and \`truncated\`, labels in batches of ${
    String(CHECK_IGNORE_BATCH)}`, async () => {
    const cwd = await project('many');
    const names = Array.from({ length: MAX_FILE_ENTRIES + 1 }, (_, i) => `f${String(i).padStart(4, '0')}.txt`);
    await Promise.all(names.map((name) => writeFile(path.join(cwd, name), '')));
    // One ignored name in the first and in a later batch, the last one past the cut.
    await put(cwd, '.gitignore', 'f0150.txt\nf0450.txt\nf0999.txt\nf1000.txt\n');
    const spy = recorded();
    const listing = await listed(cwd, '', spy.run);
    expect(listing.truncated).toBe(true);
    expect(listing.entries.map((entry) => entry.name)).toEqual(names.slice(0, MAX_FILE_ENTRIES));
    expect(ignoredOf(listing)).toEqual(['f0150.txt', 'f0450.txt', 'f0999.txt']);
    const batches = spy.calls.map(([command]) => command.rest.length - 1);
    expect(batches).toEqual(Array.from({ length: MAX_FILE_ENTRIES / CHECK_IGNORE_BATCH }, () => CHECK_IGNORE_BATCH));
  });
});

describe('files listing on git: the label comes from the repository of the listed directory', () => {
  it('a nested repository: its own `.gitignore` and `info/exclude`, never the rules of the outer one', async () => {
    const cwd = await project('outer');
    await put(cwd, '.gitignore', '*.tmp\n');
    await put(cwd, 'top.tmp', 't');
    const nested = path.join(cwd, 'nested');
    await mkdir(nested);
    git(nested, 'init', '-q');
    await put(nested, '.gitignore', 'gen/\n');
    await put(nested, 'gen/g.js', 'g');
    await put(nested, 'secret.txt', 's');
    await put(nested, 'inner.tmp', 'i');
    await put(nested, 'main.ts', 'm');
    await writeFile(path.join(nested, '.git', 'info', 'exclude'), 'secret.txt\n');
    expect(ignoredOf(await listed(cwd))).toEqual(['top.tmp']);
    expect(ignoredOf(await listed(cwd, 'nested'))).toEqual(['gen', 'secret.txt']);
  });

  it('a submodule: inside it the rules of the submodule; its directory in the outer listing breaks no batch',
    async () => {
      const source = await project('sub-source');
      await put(source, '.gitignore', 'build/\n');
      await put(source, 'lib.ts', 'l');
      commitAll(source);
      const cwd = await project('with-sub');
      await put(cwd, '.gitignore', '*.out\n');
      await put(cwd, 'run.out', 'o');
      git(cwd, 'submodule', 'add', '-q', source, 'sub');
      commitAll(cwd);
      await put(path.join(cwd, 'sub'), 'build/b.js', 'b');
      await put(path.join(cwd, 'sub'), 'x.out', 'x');
      const outer = await listed(cwd);
      expect(outer.entries.map((entry) => entry.name)).toEqual(['sub', 'run.out']);
      expect(ignoredOf(outer)).toEqual(['run.out']);
      expect(ignoredOf(await listed(cwd, 'sub'))).toEqual(['build']);
    });

  it('a session directory without git that holds a repository: labels only inside the repository', async () => {
    const cwd = await project('plain', false);
    await put(cwd, 'x.log', 'x');
    const inner = path.join(cwd, 'repo');
    await mkdir(inner);
    git(inner, 'init', '-q');
    await put(inner, '.gitignore', '*.log\n');
    await put(inner, 'y.log', 'y');
    const spy = recorded();
    const top = await listed(cwd, '', spy.run);
    expect(top.entries.map((entry) => entry.name)).toEqual(['repo', 'x.log']);
    expect(ignoredOf(top)).toEqual([]);
    expect(ignoredOf(await listed(cwd, 'repo', spy.run))).toEqual(['y.log']);
    expect(spy.calls.map(([, dir]) => dir)).toEqual([realpathSync(cwd), realpathSync(inner)]);
  });
});

describe('files listing on git: names git quotes, and failures', () => {
  it('names with non-ASCII letters, quotes, a backslash, a tab, a newline, a leading `-` or `:`, a `*` are labelled',
    async () => {
      const cwd = await project('names');
      const odd = ['zażółć.log', 'say "hi".log', 'back\\slash.log', 'tab\there.log', 'new\nline.log', '-dash.log',
        ':(top)magic.log', ':!x.log', 'with space.log', '*.log'];
      await put(cwd, '.gitignore', '*.log\n');
      for (const name of odd) await writeFile(path.join(cwd, name), 'n');
      await put(cwd, 'plain.txt', 'p');
      const listing = await listed(cwd);
      expect(ignoredOf(listing).sort()).toEqual([...odd].sort());
      expect(listing.entries.find((entry) => entry.name === 'plain.txt'))
        .toEqual({ name: 'plain.txt', kind: 'file', size: 1 });
    });

  it.skipIf(!IS_MAC)(macOnly(
    'macOS: a decomposed name git reports composed (`core.precomposeunicode`) is labelled',
    'a disk that keeps decomposed names'), async () => {
      const cwd = await project('nfd');
      git(cwd, 'config', 'core.precomposeunicode', 'true');
      const decomposed = 'review-café.pem';
      await put(cwd, '.gitignore', '*.pem\n');
      await writeFile(path.join(cwd, decomposed), 'k');
      const listing = await listed(cwd);
      const entry = listing.entries.find((one) => one.name.normalize('NFC') === decomposed.normalize('NFC'));
      expect(entry?.ignored).toBe(true);
    });

  it('a `.git` git cannot read: the listing without labels', async () => {
    const cwd = await project('broken', false);
    await put(cwd, '.gitignore', '*.log\n');
    await put(cwd, '.git', '');
    await put(cwd, 'a.log', 'a');
    expect((await listed(cwd)).entries).toEqual([{ name: 'a.log', kind: 'file', size: 1 }]);
  });

  let failures = 0;
  it.each<[string, GitArgsResult]>([
    ['exit code 128', { ok: false, stdout: './a.log\n', exitCode: 128 }],
    ['a time-out', { ok: false, stdout: './a.log\n', timedOut: true }],
    ['a failed start', { ok: false, stdout: '', spawnFailed: 'EAGAIN' }],
    ['a read cut at its cap', { ok: true, stdout: './a.log\n', capped: true, exitCode: 0 }],
    ['an answer without an exit code', { ok: true, stdout: './a.log\n' }],
    ['a line that is not a path of the batch', { ok: true, stdout: 'a.log\n', exitCode: 0 }],
    ['a broken quoted path', { ok: true, stdout: '"./a.log\n', exitCode: 0 }],
  ])('%s → the listing without labels', async (_, answer) => {
    failures += 1;
    const cwd = await project(`fails-${String(failures)}`);
    await put(cwd, 'a.log', 'a');
    await put(cwd, 'b.txt', 'b');
    const listing = await listed(cwd, '', () => Promise.resolve(answer));
    expect(listing.entries).toEqual([
      { name: 'a.log', kind: 'file', size: 1 }, { name: 'b.txt', kind: 'file', size: 1 },
    ]);
  });

  it('one failed batch drops every label; exit code 1 is "nothing ignored" and keeps the rest', async () => {
    const cwd = await project('batches');
    const names = Array.from({ length: CHECK_IGNORE_BATCH + 1 }, (_, i) => `n${String(i).padStart(3, '0')}.txt`);
    await Promise.all(names.map((name) => writeFile(path.join(cwd, name), '')));
    const answers: GitArgsResult[] = [
      { ok: true, stdout: './n000.txt\n', exitCode: 0 }, { ok: false, stdout: '', exitCode: 1 },
    ];
    const first = await listed(cwd, '', () => Promise.resolve(answers.shift() ?? { ok: false, stdout: '' }));
    expect(ignoredOf(first)).toEqual(['n000.txt']);
    const failing: GitArgsResult[] = [
      { ok: true, stdout: './n000.txt\n', exitCode: 0 }, { ok: false, stdout: '', exitCode: 128 },
    ];
    const second = await listed(cwd, '', () => Promise.resolve(failing.shift() ?? { ok: false, stdout: '' }));
    expect(ignoredOf(second)).toEqual([]);
  });

  it('an empty directory runs no git', async () => {
    const cwd = await project('empty');
    const spy = recorded();
    expect((await listed(cwd, '', spy.run)).entries).toEqual<FileEntry[]>([]);
    expect(spy.calls).toEqual([]);
  });
});
