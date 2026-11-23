/**
 * Git reads run nothing from repository configuration: a bare repository in a subdirectory, a submodule, a hook,
 * a lazy fetch from a promisor remote and a filter driver start no program. Layer 1 (flags and environment) closes
 * the known paths everywhere; layer 2 (`sandbox-exec` on macOS) lets git start only the git binaries and open no
 * connection, so it closes unknown paths and the race as well (case 16).
 *
 * Every case runs the production runner (`spawnGitArgs` and friends) on real git in a temporary directory. A program
 * from the configuration proves it ran by creating a marker file. Where a case claims a closed path, a control run
 * with plain git (no guards) shows first that the layout really starts the program.
 *
 * Git config is cut off from the machine (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM`), as in
 * `git-file-details.test.ts`.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, utimes, writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trackedPatchArgs, untrackedPatchArgs } from '../src/git-diff.ts';
import {
  collectDiff, gitReadEnv, gitSandbox, numstatArgs, parseGitStatusV2, probeGitSandboxAtStart, spawnGitArgs,
  spawnGitLog, spawnGitStatus,
} from '../src/git-status.ts';
import type { GitArgsResult, GitCommand } from '../src/git-status.ts';
import { IS_MAC, macOnly } from './platform.ts';

let root = '';

/** Environment of the setup and of the control runs: no guards of the runner. */
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

/** Plain git as an agent's shell would run it; the exit code does not matter, only the marker. */
function plainGit(cwd: string, ...args: string[]): void {
  spawnSync('git', args, { cwd, env: { ...plainEnv(), GIT_OPTIONAL_LOCKS: '0' }, stdio: 'ignore' });
}

async function repo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q');
  return path;
}

async function write(dir: string, file: string, content: string): Promise<void> {
  await mkdir(join(dir, file, '..'), { recursive: true });
  await writeFile(join(dir, file), content);
}

function commitAll(dir: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'start');
}

/** Same size, new content, later mtime: git has to hash the file again, through the filter. */
async function touchSameSize(dir: string, file: string, content: string): Promise<void> {
  await writeFile(join(dir, file), content);
  const later = new Date(Date.now() + 60_000);
  await utimes(join(dir, file), later, later);
}

/** Shell command that creates the marker; `cat` keeps a filter working. */
const touchCommand = (marker: string): string => `touch '${marker}'; cat`;

/** Executable script that creates the marker and fails. */
async function markerScript(name: string, marker: string): Promise<string> {
  const path = join(root, `${name}.sh`);
  await writeFile(path, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  return path;
}

/** Runs `read` and reports whether the marker appeared; the marker is removed for the next read. */
async function fires(marker: string, read: () => Promise<unknown> | void): Promise<boolean> {
  await rm(marker, { force: true });
  await read();
  const hit = existsSync(marker);
  await rm(marker, { force: true });
  return hit;
}

const NUMSTAT_HEAD: GitCommand = { sub: 'diff', rest: ['--numstat', 'HEAD'] };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-git-config-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/*
 * A directory with `HEAD`, `objects` and `refs` is a repository to git. An agent can leave such a directory inside the
 * project (it writes no top-level `.git/config`, but any subdirectory) and point its `core.worktree` anywhere.
 */
describe('bare repository in a subdirectory of a clone (case 1)', () => {
  let clone = '';
  let evil = '';
  let marker = '';

  beforeAll(async () => {
    clone = await repo(join(root, 'z1', 'clone'));
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'start');
    const work = await repo(join(root, 'z1', 'work'));
    await write(work, '.gitattributes', 'a.txt filter=x\n');
    await write(work, 'a.txt', 'aaaa\n');
    commitAll(work);
    evil = join(clone, 'evil');
    await rename(join(work, '.git'), evil);
    marker = join(root, 'z1', 'MARKER');
    git(evil, '--git-dir=.', 'config', 'core.bare', 'false');
    git(evil, '--git-dir=.', 'config', 'core.worktree', work);
    git(evil, '--git-dir=.', 'config', 'filter.x.clean', touchCommand(marker));
    await touchSameSize(work, 'a.txt', 'bbbb\n');
  });

  it('control: plain git status with cwd in that directory runs the filter', async () => {
    expect(await fires(marker, () => { plainGit(evil, 'status', '--porcelain=v2'); })).toBe(true);
  });

  it('no read of Rarog takes that directory for a repository, and nothing runs', async () => {
    const reads: Record<string, () => Promise<unknown>> = {
      status: () => spawnGitStatus(env())(evil),
      log: () => spawnGitLog(env())(evil),
      numstat: () => spawnGitArgs(env())(NUMSTAT_HEAD, evil),
      'ls-files': () => spawnGitArgs(env())({ sub: 'ls-files', rest: ['--others'] }, evil),
    };
    for (const [name, read] of Object.entries(reads)) {
      expect(await fires(marker, read), name).toBe(false);
    }
    // The runner names the repository of the clone around it (the nearest `.git`), so the inner config never applies.
    const top = await spawnGitArgs(env())({ sub: 'rev-parse', rest: ['--show-toplevel'] }, evil);
    expect(top.stdout.trim()).toBe(await realpath(clone));
  });

});

/*
 * A submodule has its own config (`.git/modules/<name>/config`). Git checks whether the submodule is dirty by running
 * `git status` inside it, and that status hashes changed files through the submodule's filters.
 */
describe('submodule with its own filter (case 12)', () => {
  let superDir = '';
  let marker = '';

  beforeAll(async () => {
    const sub = await repo(join(root, 'z12', 'sub'));
    await write(sub, '.gitattributes', 'a.txt filter=x\n');
    await write(sub, 'a.txt', 'aaaa\n');
    commitAll(sub);
    superDir = await repo(join(root, 'z12', 'super'));
    await write(superDir, 'top.txt', 'top\n');
    commitAll(superDir);
    git(superDir, 'submodule', '-q', 'add', sub, 'sm');
    git(superDir, 'commit', '-qm', 'submodule');
    marker = join(root, 'z12', 'MARKER');
    git(join(superDir, 'sm'), 'config', 'filter.x.clean', touchCommand(marker));
    await touchSameSize(join(superDir, 'sm'), 'a.txt', 'bbbb\n');
  });

  it('control: plain git status and diff in the superproject run the filter', async () => {
    expect(await fires(marker, () => { plainGit(superDir, 'status', '--porcelain=v2'); })).toBe(true);
    expect(await fires(marker, () => { plainGit(superDir, 'diff', '--numstat', 'HEAD'); })).toBe(true);
  });

  it('status and `diff --numstat HEAD` of Rarog run nothing and still answer', async () => {
    let status: { ok: boolean } = { ok: false };
    let numstat: GitArgsResult = { ok: false, stdout: '' };
    expect(await fires(marker, async () => { status = await spawnGitStatus(env())(superDir); })).toBe(false);
    expect(await fires(marker, async () => { numstat = await spawnGitArgs(env())(NUMSTAT_HEAD, superDir); }))
      .toBe(false);
    expect(status.ok).toBe(true);
    expect(numstat.ok).toBe(true);
  });
});

/*
 * Lazy fetch: a repository with a missing object and a promisor remote fetches the object when `git diff` needs it,
 * and the fetch starts a program from the config. Two variants: an `ext::` URL, and `uploadpack` of a partial clone.
 * Status and `log -1` do not fetch; `diff` does.
 */
type Variant = 'ext' | 'uploadpack';

async function promisorRepo(dir: string, variant: Variant, marker: string): Promise<void> {
  await repo(dir);
  await write(dir, 'a.txt', 'a\n');
  commitAll(dir);
  const blob = git(dir, 'rev-parse', 'HEAD:a.txt').trim();
  await unlink(join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const program = await markerScript(`fetch-${variant}-${String(Math.random()).slice(2)}`, marker);
  if (variant === 'ext') {
    git(dir, 'config', 'remote.x.promisor', 'true');
    git(dir, 'config', 'remote.x.url', `ext::${program}`);
    git(dir, 'config', 'protocol.ext.allow', 'always');
  } else {
    git(dir, 'config', 'core.repositoryformatversion', '1');
    git(dir, 'config', 'extensions.partialClone', 'origin');
    git(dir, 'config', 'remote.origin.url', dir);
    git(dir, 'config', 'remote.origin.uploadpack', `${program}; git-upload-pack`);
  }
  await write(dir, 'a.txt', 'a\nb\n');
}

describe('lazy fetch from a promisor remote (cases 13 and 14)', () => {
  /*
   * Case 14 is the same repository as an ordinary `.git/` the agent made in a session directory that is
   * a subdirectory of a clone: git finds the inner `.git/` first, and `safe.bareRepository` does not apply.
   */
  const layouts = [
    { variant: 'ext', nested: false }, { variant: 'uploadpack', nested: false },
    { variant: 'ext', nested: true }, { variant: 'uploadpack', nested: true },
  ] as const;

  for (const { variant, nested } of layouts) {
    const label = `${variant}${nested ? ', nested in a clone' : ''}`;

    it(`${label}: control fetches with plain git; Rarog's diff runs nothing and fails`, async () => {
      const base = join(root, `z16-${variant}-${nested ? 'nested' : 'top'}`);
      let dir = base;
      if (nested) {
        await repo(base);
        git(base, 'commit', '-q', '--allow-empty', '-m', 'start');
        dir = join(base, 'session');
      }
      const marker = join(base, '..', `MARKER-${variant}-${nested ? 'nested' : 'top'}`);
      await promisorRepo(dir, variant, marker);

      expect(await fires(marker, () => { plainGit(dir, 'diff', '--numstat', 'HEAD'); }), 'control').toBe(true);

      // The server's `GIT_*` passthrough cannot reopen the fetch: the runner sets its own values last.
      const hostile = gitReadEnv({
        PATH: process.env['PATH'] ?? '', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_LAZY_FETCH: '0', GIT_ALLOW_PROTOCOL: 'ext:file',
      });
      for (const [name, runEnv] of [['read env', env()], ['hostile passthrough', hostile]] as const) {
        let numstat: GitArgsResult = { ok: true, stdout: '' };
        expect(await fires(marker, async () => { numstat = await spawnGitArgs(runEnv)(NUMSTAT_HEAD, dir); }), name)
          .toBe(false);
        expect(numstat.ok, name).toBe(false);
        expect(await fires(marker, () => collectDiff(dir, { run: spawnGitArgs(runEnv) })), name).toBe(false);
        expect(await fires(marker, () => spawnGitStatus(runEnv)(dir)), name).toBe(false);
        expect(await fires(marker, () => spawnGitLog(runEnv)(dir)), name).toBe(false);
      }
    });
  }
});

/*
 * Shield, green before layer 1 as well: with `GIT_OPTIONAL_LOCKS=0` Rarog's reads do not write the index, so
 * `post-index-change` does not fire. `core.hooksPath=/dev/null` keeps it that way for any hook.
 */
describe('hooks from the repository (case 15)', () => {
  for (const where of ['.git/hooks', 'core.hooksPath'] as const) {
    it(`${where}: no read of Rarog runs post-index-change`, async () => {
      const dir = await repo(join(root, `z15-${where === '.git/hooks' ? 'hooks' : 'path'}`));
      await write(dir, 'a.txt', 'a\n');
      commitAll(dir);
      const marker = join(root, `MARKER-z15-${where === '.git/hooks' ? 'hooks' : 'path'}`);
      const hooks = where === '.git/hooks' ? join(dir, '.git', 'hooks') : join(root, `hooks-${String(Date.now())}`);
      await mkdir(hooks, { recursive: true });
      await writeFile(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      if (where === 'core.hooksPath') git(dir, 'config', 'core.hooksPath', hooks);
      await touchSameSize(dir, 'a.txt', 'b\n');

      const reads: Record<string, () => Promise<unknown>> = {
        status: () => spawnGitStatus(env())(dir),
        log: () => spawnGitLog(env())(dir),
        numstat: () => spawnGitArgs(env())(numstatArgs(['a.txt']), dir),
        diff: () => collectDiff(dir, { run: spawnGitArgs(env()) }),
      };
      for (const [name, read] of Object.entries(reads)) expect(await fires(marker, read), name).toBe(false);

      // Control: plain git writing the index fires the hook, so the layout is live.
      expect(await fires(marker, () => { git(dir, 'add', 'a.txt'); })).toBe(true);
    });
  }
});

/*
 * `GIT_NO_LAZY_FETCH` works from git 2.44. With an older git the runner does not start `diff` (the only measured
 * lazy-fetch path); status and log keep working. The version is read once per `PATH`.
 */
describe('minimum git version for diff', () => {
  /**
   * A `git` in front of `PATH` that answers `version` itself and passes the rest to the real git. It names its own
   * directory as the exec path, as an installed git does, so layer 2 does not start the real git in its place.
   */
  async function fakeGit(name: string, versionLine: string): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
    const bin = join(root, `fake-${name}`);
    await mkdir(bin, { recursive: true });
    const log = join(bin, 'calls.log');
    const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { env: plainEnv(), encoding: 'utf8' }).trim();
    await writeFile(join(bin, 'git'), [
      '#!/bin/sh',
      'for arg do',
      `  if [ "$arg" = version ]; then echo version >> '${log}'; echo '${versionLine}'; exit 0; fi`,
      `  if [ "$arg" = --exec-path ]; then echo '${bin}'; exit 0; fi`,
      'done',
      `echo "$*" >> '${log}'`,
      `exec '${real}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    return {
      env: gitReadEnv({
        PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      }),
      log,
    };
  }

  let dir = '';
  beforeAll(async () => {
    dir = await repo(join(root, 'version'));
    await write(dir, 'a.txt', 'a\n');
    commitAll(dir);
    await write(dir, 'a.txt', 'a\nb\n');
  });

  const calls = async (log: string): Promise<string[]> =>
    (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '');

  for (const [versionLine, allowed] of [
    ['git version 2.43.7', false],
    ['git version 2.44.0', true],
    ['git version 2.54.0 (Apple Git-157)', true],
    ['git version 3.0.0', true],
    ['not git', false],
  ] as const) {
    it(`${versionLine}: diff ${allowed ? 'runs' : 'is refused without starting git'}; status and log run`, async () => {
      const fake = await fakeGit(versionLine.replace(/\W+/g, '-'), versionLine);
      const run = spawnGitArgs(fake.env);
      const first = await run(numstatArgs(['a.txt']), dir);
      const second = await run(NUMSTAT_HEAD, dir);
      expect(first.ok).toBe(allowed);
      expect(second.ok).toBe(allowed);
      if (!allowed) {
        // A refusal is not git's own answer: no exit code, so callers report a failure, not "nothing to compare".
        expect(first.exitCode).toBeUndefined();
        expect(first.stdout).toBe('');
      }
      expect((await spawnGitStatus(fake.env)(dir)).ok).toBe(true);
      expect((await spawnGitLog(fake.env)(dir)).ok).toBe(true);

      const log = await calls(fake.log);
      expect(log.filter((line) => line === 'version')).toEqual(['version']);
      expect(log.filter((line) => / diff /.test(` ${line} `))).toHaveLength(allowed ? 2 : 0);
    });
  }
});

/*
 * Filter drivers (cases 2–11, and 14 with a filter). Git runs `filter.<name>.clean` (or `process`) when it hashes
 * a working-tree file whose stat changed: on `status` when the size stayed the same, on `diff` of a changed file and
 * on `diff --no-index` of an untracked one. Before every git process the runner reads the config key names and empties
 * every driver it finds, from any scope; when it cannot read the names, git does not start.
 */
describe('filter drivers from any config scope (cases 2–11 and 14)', () => {
  /** A config section of driver `name` in raw bytes, so any name (also one that is not UTF-8) gets in. */
  function driver(name: string | Buffer, entries: Readonly<Record<string, string>>): Buffer {
    const lines = Object.entries(entries).map(([key, value]) => `\t${key} = "${value.replace(/[\\"]/g, '\\$&')}"\n`);
    return Buffer.concat([
      Buffer.from('[filter "'), Buffer.from(name), Buffer.from('"]\n'), Buffer.from(lines.join('')),
    ]);
  }

  /**
   * A repository whose `*.txt` files go through filter `name`: `a.txt` committed before any driver exists, then
   * rewritten with the same size and a later mtime; `new.txt` untracked.
   */
  async function filtered(dir: string, name: string | Buffer): Promise<string> {
    await repo(dir);
    await writeFile(join(dir, '.gitattributes'), Buffer.concat([
      Buffer.from('*.txt filter='), Buffer.from(name), Buffer.from('\n'),
    ]));
    await write(dir, 'a.txt', 'aaaa\n');
    commitAll(dir);
    await touchSameSize(dir, 'a.txt', 'bbbb\n');
    await write(dir, 'new.txt', 'new\n');
    return dir;
  }

  const configOf = (dir: string): string => join(dir, '.git', 'config');

  /** Plain git with an environment of the test's choice; only the marker matters. */
  function plainGitEnv(runEnv: NodeJS.ProcessEnv, cwd: string, ...args: string[]): void {
    spawnSync('git', args, { cwd, env: { ...runEnv, GIT_OPTIONAL_LOCKS: '0' }, stdio: 'ignore' });
  }

  /** Every read of Rarog that hashes a working-tree file, with the exit code git gives when it answers. */
  const reads = (dir: string, runEnv: NodeJS.ProcessEnv): Record<string, [() => Promise<GitArgsResult>, number]> => ({
    status: [() => spawnGitStatus(runEnv)(dir) as Promise<GitArgsResult>, 0],
    numstat: [() => spawnGitArgs(runEnv)(numstatArgs(['a.txt']), dir), 0],
    'tracked patch': [() => spawnGitArgs(runEnv)(trackedPatchArgs('a.txt'), dir), 0],
    'untracked patch (--no-index)': [() => spawnGitArgs(runEnv)(untrackedPatchArgs('new.txt'), dir), 1],
  });

  /** No read runs the driver, and git answers each one. */
  async function nothingRuns(dir: string, marker: string, runEnv = env()): Promise<void> {
    for (const [name, [read, exitCode]] of Object.entries(reads(dir, runEnv))) {
      let result: GitArgsResult = { ok: false, stdout: '' };
      expect(await fires(marker, async () => { result = await read(); }), name).toBe(false);
      expect(result.exitCode, name).toBe(exitCode);
    }
  }

  /** No read runs the driver, and none reaches git: the runner refuses without an exit code. */
  async function refused(dir: string, marker: string): Promise<void> {
    for (const [name, [read]] of Object.entries(reads(dir, env()))) {
      let result: GitArgsResult = { ok: true, stdout: '' };
      expect(await fires(marker, async () => { result = await read(); }), name).toBe(false);
      expect(result.ok, name).toBe(false);
      expect(result.exitCode, name).toBeUndefined();
    }
  }

  it('case 2: `clean` in `.git/config` stays off on two statuses in a row, and the file shows as changed', async () => {
    const dir = await filtered(join(root, 'f2'), 'x');
    const marker = join(root, 'MARKER-f2');
    await appendFile(configOf(dir), driver('x', { clean: touchCommand(marker) }));
    expect(await fires(marker, () => { plainGit(dir, 'status', '--porcelain=v2'); }), 'control').toBe(true);

    for (const round of ['first', 'second']) {
      let result: GitArgsResult = { ok: false, stdout: '' };
      expect(await fires(marker, async () => { result = await spawnGitStatus(env())(dir) as GitArgsResult; }), round)
        .toBe(false);
      expect(result.ok, round).toBe(true);
      expect(parseGitStatusV2(result.stdout).fileDetails, round).toContainEqual({ path: 'a.txt', kind: 'modified' });
    }
    await nothingRuns(dir, marker);
  });

  it('case 3: a `process` driver does not start', async () => {
    const dir = await filtered(join(root, 'f3'), 'x');
    const marker = join(root, 'MARKER-f3');
    await appendFile(configOf(dir), driver('x', { process: touchCommand(marker) }));
    expect(await fires(marker, () => { plainGit(dir, 'status', '--porcelain=v2'); }), 'control').toBe(true);
    await nothingRuns(dir, marker);
  });

  it('case 4: `required=true` does not turn the emptied driver into a failed status', async () => {
    const dir = await filtered(join(root, 'f4'), 'x');
    const marker = join(root, 'MARKER-f4');
    await appendFile(configOf(dir), driver('x', { clean: touchCommand(marker), required: 'true' }));
    expect(await fires(marker, () => { plainGit(dir, 'status', '--porcelain=v2'); }), 'control').toBe(true);
    await nothingRuns(dir, marker);
  });

  const oddNames = [['`a=b`', 'a=b', 'eq'], ['`a.b`', 'a.b', 'dot'], ['empty', '', 'empty']] as const;
  for (const [label, name, slug] of oddNames) {
    it(`case 5: a driver named ${label} is emptied too`, async () => {
      const dir = await filtered(join(root, `f5-${slug}`), name);
      const marker = join(root, `MARKER-f5-${slug}`);
      await appendFile(configOf(dir), driver(name, { clean: touchCommand(marker) }));
      expect(await fires(marker, () => { plainGit(dir, 'status', '--porcelain=v2'); }), 'control').toBe(true);
      await nothingRuns(dir, marker);
    });
  }

  it('case 6: a driver from a file pulled in by `include.path`', async () => {
    const dir = await filtered(join(root, 'f6'), 'x');
    const marker = join(root, 'MARKER-f6');
    const included = join(root, 'f6-included.config');
    await writeFile(included, driver('x', { clean: touchCommand(marker) }));
    git(dir, 'config', 'include.path', included);
    expect(await fires(marker, () => { plainGit(dir, 'status', '--porcelain=v2'); }), 'control').toBe(true);
    await nothingRuns(dir, marker);
  });

  it('case 7: a driver from the global `~/.gitconfig`', async () => {
    const dir = await filtered(join(root, 'f7'), 'x');
    const marker = join(root, 'MARKER-f7');
    const home = join(root, 'f7-home');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.gitconfig'), driver('x', { clean: touchCommand(marker) }));
    const base = { PATH: process.env['PATH'] ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
    expect(await fires(marker, () => { plainGitEnv(base, dir, 'status', '--porcelain=v2'); }), 'control').toBe(true);
    await nothingRuns(dir, marker, gitReadEnv(base));
  });

  it('server passthrough: its config pairs stay, a driver among them is emptied, an odd count is refused', async () => {
    const dir = await filtered(join(root, 'fpass'), 'x');
    const marker = join(root, 'MARKER-fpass');
    const base = (count: string): Record<string, string> => ({
      PATH: process.env['PATH'] ?? '', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: count, GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12',
      GIT_CONFIG_KEY_1: 'filter.x.clean', GIT_CONFIG_VALUE_1: touchCommand(marker),
    });
    for (const count of ['2', '+2']) {
      expect(await fires(marker, () => { plainGitEnv(base(count), dir, 'status', '--porcelain=v2'); }), count)
        .toBe(true);
    }

    await nothingRuns(dir, marker, gitReadEnv(base('2')));
    expect((await spawnGitLog(gitReadEnv(base('2')))(dir)).stdout).toMatch(/^[0-9a-f]{12}\u001f/);

    // `+2` is a count git accepts, but not one the runner extends: no git process.
    let result: GitArgsResult = { ok: true, stdout: '' };
    expect(await fires(marker, async () => {
      result = await spawnGitStatus(gitReadEnv(base('+2')))(dir) as GitArgsResult;
    })).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeUndefined();
  });

  /*
   * Two variables of the server's passthrough would leave a driver on. Both drivers are `required`: where layer 2
   * blocks the program, a driver left on shows as a failed read instead of a marker.
   */
  it('server passthrough: `GIT_CONFIG` does not hide a driver of the repository from the names read', async () => {
    const dir = await filtered(join(root, 'fgc'), 'x');
    const marker = join(root, 'MARKER-fgc');
    await appendFile(configOf(dir), driver('x', { clean: touchCommand(marker), required: 'true' }));
    // `GIT_CONFIG` moves `git config` to another file; `status` and `diff` still read the repository's config.
    const base = {
      PATH: process.env['PATH'] ?? '', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG: '/dev/null',
    };
    expect(await fires(marker, () => { plainGitEnv(base, dir, 'status', '--porcelain=v2'); }), 'control').toBe(true);
    await nothingRuns(dir, marker, gitReadEnv(base));
  });

  it('server passthrough: a driver in `GIT_CONFIG_PARAMETERS` does not win over the emptied one', async () => {
    const dir = await filtered(join(root, 'fgp'), 'x');
    const marker = join(root, 'MARKER-fgp');
    const script = await markerScript('fgp', marker);
    const base = {
      PATH: process.env['PATH'] ?? '', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_PARAMETERS: `'filter.x.clean=${script}' 'filter.x.required=true'`,
    };
    expect(await fires(marker, () => { plainGitEnv(base, dir, 'status', '--porcelain=v2'); }), 'control').toBe(true);
    await nothingRuns(dir, marker, gitReadEnv(base));
  });

  it('case 8: `diff` of the changed file and `diff --no-index` of an untracked one run no `clean`', async () => {
    const dir = await filtered(join(root, 'f8'), 'x');
    const marker = join(root, 'MARKER-f8');
    await appendFile(configOf(dir), driver('x', { clean: touchCommand(marker) }));
    expect(await fires(marker, () => { plainGit(dir, 'diff', 'HEAD', '--', 'a.txt'); }), 'control diff').toBe(true);
    expect(await fires(marker, () => { plainGit(dir, 'diff', '--no-index', '--', '/dev/null', 'new.txt'); }),
      'control --no-index').toBe(true);

    await nothingRuns(dir, marker);
    let whole: Awaited<ReturnType<typeof collectDiff>> | undefined;
    expect(await fires(marker, async () => { whole = await collectDiff(dir, { run: spawnGitArgs(env()) }); }))
      .toBe(false);
    expect(whole?.files.map((file) => file.path).sort()).toEqual(['a.txt', 'new.txt']);
  });

  it('case 9: names past the read cap: the runner refuses and git does not start', async () => {
    const dir = await filtered(join(root, 'f9'), 'x');
    const marker = join(root, 'MARKER-f9');
    // About 2 MiB of key names, twice the cap of the names read, with the driver after them.
    const padding = Array.from({ length: 2_100 }, (_, i) => `[pad "${String(i).padStart(1_000, '0')}"]\n\tk = 1\n`);
    await appendFile(configOf(dir), padding.join(''));
    await appendFile(configOf(dir), driver('x', { clean: touchCommand(marker) }));
    expect(await fires(marker, () => { plainGit(dir, 'status', '--porcelain=v2'); }), 'control').toBe(true);
    await refused(dir, marker);
  });

  it('case 10: a driver name that is not UTF-8 cannot be emptied through the environment: refusal', async () => {
    const name = Buffer.from([0xff]);
    const dir = await filtered(join(root, 'f10'), name);
    const marker = join(root, 'MARKER-f10');
    await appendFile(configOf(dir), driver(name, { clean: touchCommand(marker) }));
    expect(await fires(marker, () => { plainGit(dir, 'status', '--porcelain=v2'); }), 'control').toBe(true);
    await refused(dir, marker);
  });

  // Shield: git itself fails on a config it cannot read, so status never answered here; now it does not even start.
  it('case 11: `.git/config` that `git config --list` cannot read: refusal without starting status', async () => {
    const dir = await filtered(join(root, 'f11'), 'x');
    await chmod(configOf(dir), 0o000);
    try {
      const result = await spawnGitStatus(env())(dir) as GitArgsResult;
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBeUndefined();
    } finally {
      await chmod(configOf(dir), 0o600);
    }
  });

  it('case 14: an ordinary `.git/` of the agent in a session subdirectory of a clone, with a filter', async () => {
    const clone = await repo(join(root, 'f14'));
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'start');
    const dir = await filtered(join(clone, 'session'), 'x');
    const marker = join(root, 'MARKER-f14');
    await appendFile(configOf(dir), driver('x', { clean: touchCommand(marker) }));
    expect(await fires(marker, () => { plainGit(dir, 'status', '--porcelain=v2'); }), 'control').toBe(true);
    await nothingRuns(dir, marker);
  });
});

/*
 * Layer 2 (case 16 and the probe). On macOS every git process of the runner starts under `sandbox-exec` with a profile
 * that allows starting only the git binaries and denies the network. The runner probes once per environment (`PATH`);
 * when the profile cannot be applied, git runs with layer 1 only and the server start writes one log line.
 */
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** An environment of the reads with a `PATH` of its own, so the runner probes it afresh. */
async function ownEnv(name: string): Promise<NodeJS.ProcessEnv> {
  const bin = join(root, `path-${name}`);
  await mkdir(bin, { recursive: true });
  return gitReadEnv({
    PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  });
}

/** A stand-in for `sandbox-exec`: records the arguments of every call, then runs `then`. */
async function standIn(name: string, then: string): Promise<{ path: string; calls: () => Promise<string[]> }> {
  const path = join(root, `sandbox-exec-${name}`);
  const log = join(root, `sandbox-exec-${name}.log`);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${then}\n`, { mode: 0o755 });
  return {
    path,
    calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line !== ''),
  };
}

/** A repository whose `a.txt` goes through `clean`, rewritten with the same size; `new.txt` untracked. */
async function cleanFiltered(dir: string, marker: string): Promise<string> {
  await repo(dir);
  await write(dir, '.gitattributes', '*.txt filter=x\n');
  await write(dir, 'a.txt', 'aaaa\n');
  commitAll(dir);
  git(dir, 'config', 'filter.x.clean', touchCommand(marker));
  await touchSameSize(dir, 'a.txt', 'bbbb\n');
  await write(dir, 'new.txt', 'new\n');
  return dir;
}

describe('layer 2 probe: sandbox-exec that cannot apply its profile', () => {
  // Measured: `sandbox-exec` under another sandbox ends with `sandbox_apply: Operation not permitted`, exit code 71.
  it('one log line at start, git runs with layer 1, and the probe runs once', async () => {
    const runEnv = await ownEnv('nested');
    const nested = await standIn('nested', "echo 'sandbox-exec: sandbox_apply: Operation not permitted' >&2\nexit 71");
    const lines: string[] = [];
    const state = await probeGitSandboxAtStart(runEnv, (line) => { lines.push(line); }, nested.path);

    expect(state).toHaveProperty('unavailable');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^git: sandbox-exec .*layer 1/);

    const marker = join(root, 'MARKER-l2-nested');
    const dir = await cleanFiltered(join(root, 'l2-nested'), marker);
    for (let round = 0; round < 2; round++) {
      let status: GitArgsResult = { ok: false, stdout: '' };
      let numstat: GitArgsResult = { ok: false, stdout: '' };
      expect(await fires(marker, async () => { status = await spawnGitStatus(runEnv)(dir) as GitArgsResult; }))
        .toBe(false);
      expect(await fires(marker, async () => { numstat = await spawnGitArgs(runEnv)(NUMSTAT_HEAD, dir); }))
        .toBe(false);
      expect(status.ok).toBe(true);
      expect(parseGitStatusV2(status.stdout).fileDetails).toContainEqual({ path: 'a.txt', kind: 'modified' });
      expect(numstat.ok).toBe(true);
    }
    // The stand-in ran once, for the probe; the reads never start it. Off macOS the probe stops before it.
    expect(await nested.calls()).toHaveLength(process.platform === 'darwin' ? 1 : 0);
  });
});

describe.skipIf(!IS_MAC)(macOnly('layer 2: a read starts git through the sandbox', 'sandbox-exec'), () => {
  it('every git process of a read starts through sandbox-exec, with the profile and no log line', async () => {
    const runEnv = await ownEnv('wrapped');
    const wrapper = await standIn('wrapped', `exec ${SANDBOX_EXEC} "$@"`);
    const lines: string[] = [];
    const state = await probeGitSandboxAtStart(runEnv, (line) => { lines.push(line); }, wrapper.path);
    expect(state, JSON.stringify(state)).toHaveProperty('sandbox');
    expect(lines).toEqual([]);

    const marker = join(root, 'MARKER-l2-wrapped');
    const dir = await cleanFiltered(join(root, 'l2-wrapped'), marker);
    let status: GitArgsResult = { ok: false, stdout: '' };
    let numstat: GitArgsResult = { ok: false, stdout: '' };
    expect(await fires(marker, async () => { status = await spawnGitStatus(runEnv)(dir) as GitArgsResult; }))
      .toBe(false);
    expect(await fires(marker, async () => { numstat = await spawnGitArgs(runEnv)(NUMSTAT_HEAD, dir); })).toBe(false);
    expect(parseGitStatusV2(status.stdout).fileDetails).toContainEqual({ path: 'a.txt', kind: 'modified' });
    expect(numstat.stdout).toMatch(/^1\t1\ta\.txt$/m);

    // The probe's `git version`; per read the config names read and the read; `diff` also reads the version.
    const calls = await wrapper.calls();
    const count = (pattern: RegExp): number => calls.filter((call) => pattern.test(call)).length;
    expect(calls).toHaveLength(6);
    expect(count(/ version$/)).toBe(2);
    expect(count(/ config --null --name-only --list$/)).toBe(2);
    expect(count(/ status --ignore-submodules=dirty --porcelain=v2 /)).toBe(1);
    expect(count(/ diff --no-textconv /)).toBe(1);
    for (const call of calls) {
      expect(call).toMatch(/^-p \(version 1\) .*\(deny process-exec\*\) .*\(deny network\*\)/);
    }
  });

  /*
   * Measured: with a `HOME` it has not seen, the `/usr/bin/git` shim starts `xcodebuild` to find the developer
   * directory. The profile denies that program, so a read through the shim ends with exit code 71.
   */
  it('a read with a `HOME` git has not seen yet answers: the sandbox starts the git of the exec path', async () => {
    const dir = await repo(join(root, 'l2-home'));
    const home = await mkdtemp(join(root, 'l2-home-'));
    // The probe of this `PATH` runs with the first `HOME`; the read with the second one finds it settled.
    expect((await spawnGitStatus(env())(dir) as GitArgsResult).exitCode).toBe(0);
    const result = await spawnGitStatus({ ...env(), HOME: home })(dir) as GitArgsResult;
    expect(result.exitCode).toBe(0);
  });

  it('`GIT_EXEC_PATH` of the server passthrough does not choose the git the sandbox starts', async () => {
    // A native git in a directory an agent could write: a copy of the real one, so it would start and answer.
    const planted = join(root, 'l2-exec-path');
    await mkdir(planted, { recursive: true });
    const real = execFileSync('git', ['--exec-path'], { env: plainEnv(), encoding: 'utf8' }).trim();
    await copyFile(await realpath(join(real, 'git')), join(planted, 'git'));
    await chmod(join(planted, 'git'), 0o755);

    const state = await gitSandbox({ ...await ownEnv('exec-path'), GIT_EXEC_PATH: planted });
    if (!('sandbox' in state)) throw new Error(`sandbox-exec not applied: ${state.unavailable}`);
    expect(state.sandbox.args.join(' ')).not.toContain(planted);
  });

  /*
   * Case 16: the test turns layer 1 off (plain argv and environment: no flags, no emptied drivers, lazy fetch allowed)
   * and runs git under the runner's own sandbox, so only layer 2 stands between the config and a program.
   */
  describe('case 16: layer 1 off, git under the runner\'s sandbox', () => {
    /** Program and arguments of plain git under the runner's sandbox, as the runner itself would start it. */
    async function sandboxPrefix(): Promise<{ file: string; prefix: readonly string[] }> {
      const state = await gitSandbox(env());
      if (!('sandbox' in state)) throw new Error(`sandbox-exec not applied: ${state.unavailable}`);
      return { file: state.sandbox.file, prefix: state.sandbox.args };
    }

    const plainRunEnv = (): NodeJS.ProcessEnv => ({ ...plainEnv(), GIT_OPTIONAL_LOCKS: '0' });

    async function underSandbox(): Promise<(cwd: string, ...args: string[]) => SpawnSyncReturns<string>> {
      const { file, prefix } = await sandboxPrefix();
      return (cwd, ...args) => spawnSync(file, [...prefix, ...args], { cwd, env: plainRunEnv(), encoding: 'utf8' });
    }

    /** Asynchronous run: a listener in this process has to accept the connection while git waits for it. */
    function runAsync(file: string, args: readonly string[], cwd: string): Promise<string> {
      return new Promise((resolve) => {
        const child = spawn(file, args, { cwd, env: plainRunEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
        child.on('close', () => { resolve(stderr); });
      });
    }

    it('a `clean` and a `process` driver do not start on status, diff and diff --no-index', async () => {
      const under = await underSandbox();
      for (const kind of ['clean', 'process'] as const) {
        const marker = join(root, `MARKER-l2-${kind}`);
        const dir = await cleanFiltered(join(root, `l2-${kind}`), marker);
        if (kind === 'process') {
          git(dir, 'config', '--unset', 'filter.x.clean');
          git(dir, 'config', 'filter.x.process', touchCommand(marker));
        }
        expect(await fires(marker, () => { plainGit(dir, 'status', '--porcelain=v2'); }), `${kind}: control`)
          .toBe(true);

        let status: SpawnSyncReturns<string> | undefined;
        expect(await fires(marker, () => { status = under(dir, 'status', '--porcelain=v2'); }), kind).toBe(false);
        expect(status?.status, kind).toBe(0);
        expect(status?.stdout, kind).toMatch(/ a\.txt$/m);
        expect(await fires(marker, () => { under(dir, 'diff', 'HEAD', '--', 'a.txt'); }), kind).toBe(false);
        expect(await fires(marker, () => { under(dir, 'diff', '--no-index', '--', '/dev/null', 'new.txt'); }), kind)
          .toBe(false);
      }
    });

    it('a lazy fetch through an `ext::` URL or `uploadpack` starts nothing', async () => {
      const under = await underSandbox();
      for (const variant of ['ext', 'uploadpack'] as const) {
        const dir = join(root, `l2-fetch-${variant}`);
        const marker = join(root, `MARKER-l2-fetch-${variant}`);
        await promisorRepo(dir, variant, marker);
        expect(await fires(marker, () => { plainGit(dir, 'diff', '--numstat', 'HEAD'); }), `${variant}: control`)
          .toBe(true);
        expect(await fires(marker, () => { under(dir, 'diff', '--numstat', 'HEAD'); }), variant).toBe(false);
      }
    });

    it('a lazy fetch over `git://` opens no connection', async () => {
      const { file, prefix } = await sandboxPrefix();
      let connections = 0;
      const server = createServer((socket) => { connections += 1; socket.destroy(); });
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
      try {
        const { port } = server.address() as AddressInfo;
        const dir = await repo(join(root, 'l2-network'));
        await write(dir, 'a.txt', 'a\n');
        commitAll(dir);
        const blob = git(dir, 'rev-parse', 'HEAD:a.txt').trim();
        await unlink(join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
        git(dir, 'config', 'remote.x.promisor', 'true');
        git(dir, 'config', 'remote.x.url', `git://127.0.0.1:${String(port)}/r`);
        await write(dir, 'a.txt', 'a\nb\n');

        await runAsync('git', ['diff', '--numstat', 'HEAD'], dir);
        expect(connections, 'control').toBeGreaterThan(0);
        connections = 0;
        const stderr = await runAsync(file, [...prefix, 'diff', '--numstat', 'HEAD'], dir);
        expect(connections).toBe(0);
        expect(stderr).toMatch(/unable to connect to 127\.0\.0\.1.*Operation not permitted/s);
      } finally {
        await new Promise((resolve) => { server.close(resolve); });
      }
    });
  });
});
