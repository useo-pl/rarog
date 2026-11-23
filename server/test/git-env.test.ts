/**
 * Granica sekretów procesów `git` — env JEST podawane, nie dziedziczone.
 *
 * An environment built on `...process.env` would give `git` — and through it code from the repository config —
 * `RAROG_AUTH_TOKEN`, `SONIOX_API_KEY` and the notification key, even through an `env -i` block. This file guards
 * both sides: the process gets an EXPLICIT env (never `undefined`, so never inherited from the server), and the env
 * holds not a single Rarog secret. Rarog only READS git (`status`, `log`, `diff`).
 *
 * `node:child_process` jest tu zamockowany, więc żaden prawdziwy git się nie uruchamia —
 * sprawdzamy dokładnie to, co poszłoby do `spawn`.
 */
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

interface SpawnCall {
  args: readonly string[];
  options: { env?: NodeJS.ProcessEnv };
}

const spawnCalls: SpawnCall[] = [];

/**
 * The fake git answers the runner's version probe (`diff` runs only with git 2.44 or newer); every other
 * command prints nothing by default (the env tests need only the spawn).
 */
const withVersion = (other: (args: readonly string[]) => string) => (args: readonly string[]): string =>
  (args.at(-1) === 'version' ? 'git version 2.54.0\n' : other(args));

/** Wyjście atrapy gita dla danych argumentów — domyślnie puste (testom env wystarcza sam spawn). */
let stdoutFor: (args: readonly string[]) => string = withVersion(() => '');

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ args, options });
    const stream = { setEncoding: (): void => {}, on: (): void => {}, destroy: (): void => {} };
    const stdout = {
      ...stream,
      on: (event: string, callback: (chunk: string) => void): void => {
        const out = event === 'data' ? stdoutFor(args) : '';
        if (out !== '') callback(out);
      },
    };
    return {
      stdout,
      stderr: stream,
      on: (event: string, callback: (code: number, signal: null) => void) => {
        // Domykamy proces natychmiast: test nie sprawdza wyjścia gita, tylko jego środowisko,
        // a wiszące dziecko zostawiłoby po sobie timer limitu.
        if (event === 'exit' || event === 'close') queueMicrotask(() => { callback(0, null); });
      },
      kill: (): void => {},
    };
  },
}));

const { collectDiff, gitReadEnv, spawnGitArgs, spawnGitStatus } = await import('../src/git-status.ts');
const { collectDiffFile, collectDiffList } = await import('../src/git-diff.ts');
const { loadConfig } = await import('../src/config.ts');

/** Env serwera z KOMPLETEM sekretów Raroga — dokładnie to, co niesie proces spod `env -i`. */
const ENV_SERWERA: NodeJS.ProcessEnv = {
  RAROG_ORIGINS: 'https://rarog.example',
  RAROG_AUTH_EPOCH: '4',
  SONIOX_API_KEY: 'sekret-soniox',
  // Kanał APNs: ścieżka pliku klucza i Key ID przechodzą przez `env -i` serwera.
  RAROG_APNS_KEY_PATH: '/Users/x/.secrets.d/klucz-apns',
  RAROG_APNS_KEY_ID: 'ABC123DEFG',
  HOME: '/Users/x',
  PATH: '/opt/homebrew/bin:/usr/bin',
  // Gniazdo ssh-agenta w env serwera nie przechodzi: Rarog gita tylko czyta.
  SSH_AUTH_SOCK: '/tmp/agent.sock',
};

const WARTOSCI_RAROGA = [
  'sekret-soniox', '4',
  '/Users/x/.secrets.d/klucz-apns', 'ABC123DEFG',
];

function baza(): Readonly<Record<string, string>> {
  return loadConfig(ENV_SERWERA).gitEnvBase;
}

/**
 * Directory of the reads: an empty `.git` is enough for the runner, which starts no git without a work tree.
 * Resolved, because the runner passes the resolved path as `--git-dir` and `--work-tree`.
 */
let repo = '';

beforeAll(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'rarog-git-env-')));
  await mkdir(join(repo, '.git'));
});

describe('status/diff: env procesów czytających repo', () => {
  it('spawn dostaje env JAWNE i bez sekretów Raroga', async () => {
    spawnCalls.length = 0;
    await spawnGitStatus(gitReadEnv(baza()))(repo);

    // The config key names read (filter drivers), then status itself; all with the same explicit env. On macOS
    // the first read of an environment also probes the sandbox once (`--exec-path`), with that env too.
    expect(spawnCalls.map((call) => call.args.at(-1)).filter((arg) => arg !== '--exec-path'))
      .toEqual(['--list', '--untracked-files=all']);
    for (const call of spawnCalls) {
      const env = call.options.env;
      expect(env, 'brak `env` znaczy dziedziczenie po serwerze').toBeDefined();
      expect(Object.keys(env ?? {}).sort()).toEqual([
        'GIT_ALLOW_PROTOCOL', 'GIT_NO_LAZY_FETCH', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'HOME', 'PATH',
      ]);
      for (const sekret of WARTOSCI_RAROGA) expect(Object.values(env ?? {})).not.toContain(sekret);
    }
  });

  it('collectDiff woła gita tym samym env (cztery spawny, żaden bez env)', async () => {
    spawnCalls.length = 0;
    await collectDiff(repo, { run: spawnGitArgs(gitReadEnv(baza())) });

    expect(spawnCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of spawnCalls) {
      expect(call.options.env, `\`${call.args.join(' ')}\` bez jawnego env`).toBeDefined();
      for (const sekret of WARTOSCI_RAROGA) {
        expect(Object.values(call.options.env ?? {})).not.toContain(sekret);
      }
    }
  });

  /*
   * Diff per plik: oba kolektory idą przez ten sam `spawnGitArgs`, więc każdy ich proces —
   * dwie listy, liczniki, patch pliku śledzonego i `--no-index` nieśledzonego — dostaje to samo
   * jawne środowisko co stara trasa.
   */
  it('collectDiffList i collectDiffFile wołają gita tym samym env co collectDiff', async () => {
    const env = gitReadEnv(baza());
    spawnCalls.length = 0;
    await collectDiff(repo, { run: spawnGitArgs(env) });
    const wzorzec = spawnCalls[0]?.options.env;
    expect(wzorzec).toBeDefined();

    spawnCalls.length = 0;
    stdoutFor = withVersion((args) => (args.includes('--name-status') ? 'M\0a.ts\0'
      : args.includes('ls-files') ? 'nowy.txt\0'
        : args.includes('--numstat') ? '1\t0\ta.ts\0' : 'diff --git a/x b/x\n'));
    try {
      const run = spawnGitArgs(env);
      await collectDiffList(repo, { run, runNumstat: spawnGitArgs(env, 1_500) });
      await collectDiffFile(repo, 'a.ts', { run });
      await collectDiffFile(repo, 'nowy.txt', { run, probe: () => Promise.resolve({ kind: 'file' }) });
    } finally {
      stdoutFor = withVersion(() => '');
    }

    const wywolania = spawnCalls.map((call) => call.args.join(' '));
    // 3 procesy listy + 2×(dwie listy walidacji + patch): komplet ścieżek kodu obu kolektorów. Each one comes after
    // its config key names read (filter drivers).
    expect(spawnCalls).toHaveLength(18);
    expect(wywolania.filter((args) => args.endsWith(' config --null --name-only --list'))).toHaveLength(9);
    expect(wywolania.filter((args) => args.includes('--name-status'))).toHaveLength(3);
    expect(wywolania.filter((args) => args.includes(' ls-files '))).toHaveLength(3);
    const oslony = '-c core.fsmonitor=false -c log.showSignature=false -c safe.bareRepository=explicit'
      + ' -c core.hooksPath=/dev/null -c diff.submodule=short';
    const diff = 'diff --no-textconv --no-ext-diff --ignore-submodules=dirty';
    // The repository pin of the read stands right after the guards, before the caller's global options.
    const workTree = `--git-dir=${repo}/.git --work-tree=${repo}`;
    expect(wywolania).toContain(
      `${oslony} ${workTree} --literal-pathspecs ${diff} --no-ext-diff --relative HEAD -- a.ts`,
    );
    expect(wywolania).toContain(
      `${oslony} ${workTree} --literal-pathspecs ${diff} --no-ext-diff --no-index -- /dev/null nowy.txt`,
    );
    for (const call of spawnCalls) {
      // Osłony konfiguracji stoją przed KAŻDĄ podkomendą, która dochodzi do `spawn`.
      expect(call.args.join(' ').startsWith(`${oslony} `), call.args.join(' ')).toBe(true);
      expect(call.options.env, `\`${call.args.join(' ')}\` bez jawnego env`).toEqual(wzorzec);
      for (const sekret of WARTOSCI_RAROGA) {
        expect(Object.values(call.options.env ?? {})).not.toContain(sekret);
      }
    }
  });
});
