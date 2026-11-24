/**
 * The file index of a session directory on real git (`server/src/files/file-index.ts`): the production runner
 * (`spawnGitArgs`) reads `git ls-files` in the session directory, and the walk keeps the files git does not ignore,
 * on repositories made in the run's temporary directory: a plain repository, an untracked nested repository with its
 * own ignore rules, a submodule, a session directory below the top of a repository, a session directory without git,
 * and a `.git` git cannot read. Git only narrows the walk: every path comes from a listing of the path rule.
 *
 * Git config is cut off from the machine (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM`), as in
 * `session-files-repo.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileIndex } from '@rarog/shared';
import { fileIndexSchema } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import { SessionFileIndex } from '../src/files/file-index.ts';
import { FILES_DISK, type FilesDisk } from '../src/files/path-rule.ts';
import type { SessionFilesPort } from '../src/files/session-files.ts';
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

const plainEnv = (): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
});

const env = (): NodeJS.ProcessEnv => gitReadEnv(plainEnv());

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Rarog', '-c', 'user.email=rarog@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always', ...args,
  ], { cwd, env: plainEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'rarog-index-git-'));
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

function portOf(cwd: string, run: GitArgsRunner): SessionFilesPort {
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

/** The index of `cwd` with the production runner (or `run`), every git command and listed directory recorded. */
async function indexed(cwd: string, run: GitArgsRunner = spawnGitArgs(env())): Promise<{
  index: FileIndex; commands: GitCommand[]; listed: string[];
}> {
  const commands: GitCommand[] = [];
  const listed: string[] = [];
  const disk: FilesDisk = {
    ...FILES_DISK,
    readdirByIdentity: (dir) => {
      listed.push(path.relative(realpathSync(cwd), dir.real));
      return FILES_DISK.readdirByIdentity(dir);
    },
  };
  const answer = await new SessionFileIndex({ disk }).index('s1', MAX_BYTES, portOf(cwd, (command, dir) => {
    commands.push(command);
    return run(command, dir);
  }));
  if (!answer.ok) throw new Error(`refused: ${answer.refusal.code}`);
  expect(fileIndexSchema.parse(answer.value)).toEqual(answer.value);
  return { index: answer.value, commands, listed };
}

describe('file index on git: the files git does not ignore', () => {
  it('tracked and untracked files stay, ignored ones go; a directory with ignored files only is not walked',
    async () => {
      const cwd = await project('app');
      await put(cwd, '.gitignore', 'dist/\n*.log\n');
      await put(cwd, 'README.md');
      await put(cwd, 'src/a.ts');
      await put(cwd, 'src/deep/b.ts');
      await put(cwd, 'dist/out.js');
      await put(cwd, 'dist/maps/out.js.map');
      await put(cwd, 'app.log');
      await put(cwd, 'notes/todo.md');
      git(cwd, 'add', '.gitignore', 'README.md', 'src/a.ts');
      git(cwd, 'commit', '-qm', 'start');
      const { index, commands, listed } = await indexed(cwd);
      expect(index).toEqual({
        paths: ['README.md', 'notes/todo.md', 'src/a.ts', 'src/deep/b.ts'], truncated: false, maxBytes: MAX_BYTES,
      });
      expect(commands.map((command) => [command.sub, ...command.rest])).toEqual([
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      ]);
      expect(listed.sort()).toEqual(['', 'notes', 'src', 'src/deep']);
    });

  it('a tracked file that matches an ignore rule stays: git lists it', async () => {
    const cwd = await project('kept');
    await put(cwd, '.gitignore', '*.log\n');
    await put(cwd, 'kept.log');
    await put(cwd, 'drop.log');
    git(cwd, 'add', '.gitignore');
    git(cwd, 'add', '-f', 'kept.log');
    git(cwd, 'commit', '-qm', 'start');
    expect((await indexed(cwd)).index.paths).toEqual(['kept.log']);
  });

  it('an untracked nested repository is walked whole, its own ignore rules aside', async () => {
    const cwd = await project('outer');
    await put(cwd, '.gitignore', '*.tmp\n');
    await put(cwd, 'top.tmp');
    await put(cwd, 'top.ts');
    const nested = path.join(cwd, 'nested');
    await mkdir(nested);
    git(nested, 'init', '-q');
    await put(nested, '.gitignore', 'gen/\n');
    await put(nested, 'gen/g.js');
    await put(nested, 'inner.tmp');
    await put(nested, 'src/main.ts');
    expect((await indexed(cwd)).index.paths.sort()).toEqual([
      'nested/gen/g.js', 'nested/inner.tmp', 'nested/src/main.ts', 'top.ts',
    ]);
  });

  it('a submodule is walked whole', async () => {
    const source = await project('sub-source');
    await put(source, '.gitignore', 'build/\n');
    await put(source, 'lib.ts');
    commitAll(source);
    const cwd = await project('with-sub');
    await put(cwd, '.gitignore', '*.out\n');
    await put(cwd, 'run.out');
    await put(cwd, 'main.ts');
    git(cwd, 'submodule', 'add', '-q', source, 'mods/sub');
    commitAll(cwd);
    await put(path.join(cwd, 'mods/sub'), 'build/b.js');
    expect((await indexed(cwd)).index.paths.sort()).toEqual(['main.ts', 'mods/sub/build/b.js', 'mods/sub/lib.ts']);
  });

  it('a session directory below the top of the repository: paths relative to the session directory', async () => {
    const top = await project('mono');
    await put(top, '.gitignore', '*.log\n');
    await put(top, 'web/src/app.ts');
    await put(top, 'web/debug.log');
    await put(top, 'api/server.ts');
    commitAll(top);
    expect((await indexed(path.join(top, 'web'))).index.paths).toEqual(['src/app.ts']);
  });

  it.skipIf(!IS_MAC)(macOnly(
    'macOS: a decomposed name git reports composed (`core.precomposeunicode`) stays, under its name on disk',
    'a disk that keeps decomposed names'),
    async () => {
      const cwd = await project('nfd');
      git(cwd, 'config', 'core.precomposeunicode', 'true');
      const decomposed = 'café/noteś.md';
      await put(cwd, decomposed);
      const { paths } = (await indexed(cwd)).index;
      expect(paths.map((one) => one.normalize('NFC'))).toEqual([decomposed.normalize('NFC')]);
    });
});

describe('file index on git: names git spells another way than the disk', () => {
  it.skipIf(!IS_MAC)(macOnly(
    'macOS, `core.ignorecase`: a tracked file and a directory renamed only in letter case stay, under the disk names',
    'a case-insensitive disk'),
    async () => {
      const cwd = await project('case');
      git(cwd, 'config', 'core.ignorecase', 'true');
      await put(cwd, 'README.md');
      await put(cwd, 'docs/a.md');
      await put(cwd, 'docs/deep/b.md');
      commitAll(cwd);
      await rename(path.join(cwd, 'README.md'), path.join(cwd, 'readme.md'));
      await rename(path.join(cwd, 'docs'), path.join(cwd, 'Docs'));
      expect((await indexed(cwd)).index.paths).toEqual(['readme.md', 'Docs/a.md', 'Docs/deep/b.md']);
    });
});

describe('file index on git: no repository, or git fails', () => {
  it('a session directory without git: every file the rule allows, ignored ones too', async () => {
    const cwd = await project('plain', false);
    await put(cwd, '.gitignore', '*.log\n');
    await put(cwd, 'x.log');
    await put(cwd, 'dist/out.js');
    expect((await indexed(cwd)).index.paths).toEqual(['x.log', 'dist/out.js']);
  });

  it('a `.git` git cannot read: every file the rule allows', async () => {
    const cwd = await project('broken', false);
    await put(cwd, '.gitignore', '*.log\n');
    await put(cwd, '.git', '');
    await put(cwd, 'a.log');
    expect((await indexed(cwd)).index.paths).toEqual(['a.log']);
  });

  let failures = 0;
  it.each<[string, GitArgsResult]>([
    ['exit code 128', { ok: false, stdout: 'a.txt\0', exitCode: 128 }],
    ['a time-out', { ok: false, stdout: 'a.txt\0', timedOut: true }],
    ['a failed start', { ok: false, stdout: '', spawnFailed: 'EAGAIN' }],
    ['a read cut at its cap', { ok: true, stdout: 'a.txt\0', capped: true, exitCode: 0 }],
    ['an answer without an exit code', { ok: true, stdout: 'a.txt\0' }],
  ])('%s → every file the rule allows', async (_, answer) => {
    failures += 1;
    const cwd = await project(`fails-${String(failures)}`);
    await put(cwd, 'a.txt');
    await put(cwd, 'b.log');
    expect((await indexed(cwd, () => Promise.resolve(answer))).index.paths).toEqual(['a.txt', 'b.log']);
  });

  it('git names a path the disk does not have: it never reaches the index', async () => {
    const cwd = await project('ghost');
    await put(cwd, 'real.ts');
    const answer: GitArgsResult = { ok: true, stdout: 'real.ts\0ghost.ts\0../outside.ts\0', exitCode: 0 };
    expect((await indexed(cwd, () => Promise.resolve(answer))).index.paths).toEqual(['real.ts']);
  });
});
