/*
 * `scripts/ios-lib.sh`: numer builda (`ios_build_number`) i klucz API App Store Connect (`ios_asc_auth`),
 * oraz przejście numeru przez `scripts/ios-build.sh` do `xcodebuild`.
 *
 * Bez nadpisania numer to liczba commitów HEAD. Płytki klon zaniża tę liczbę, więc helper wtedy odmawia.
 * `RAROG_BUILD_NUMBER` służy rollbackowi apki do starszego commita: build ze znacznika ma dostać numer WYŻSZY
 * niż zainstalowany, więc nadpisanie musi być liczbą większą od liczby commitów. Skrypty iOS idą w atrapie repo
 * (kopie publicznych skryptów, własna historia), z atrapą Xcode (katalog z `Platforms/` i `xcrun`, który
 * zawsze odpowiada 0), bez prawdziwego toolchainu. Wynik nie zależy więc od tego, czy repo testu jest płytkim
 * klonem.
 *
 * A directory without git (an unpacked archive) has no commit count: there `RAROG_BUILD_NUMBER` is the number as
 * given, with a warning below the minimum app build of a package install (read from `server/src/config/clients.ts`
 * copied into the dummy), and without it the build stops.
 *
 * Klucz przychodzi wyłącznie ze środowiska (trzy zmienne `RAROG_ASC_*`); pliku sekretów skrypt nie czyta.
 * Wartości są fikcyjne, a klucz `.p8` to atrapa w katalogu tymczasowym (treść „atrapa”).
 *
 * Lint tego pliku jedzie w `pnpm run check` (glob `scripts/*.sh`), nie tutaj.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MIN_CLIENT_BUILD } from '../src/config/clients.ts';
import { IS_MAC, macOnly } from './platform.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = path.join(repoRoot, 'scripts/ios-lib.sh');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// Atrapa DEVELOPER_DIR psuje `/usr/bin/git` na macOS (nakładka Apple szuka gita w Xcode), więc skrypty
// dostają gita przez opakowanie bez tej zmiennej.
const REAL_GIT = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

// Atrapa `xcrun` odpowiada 0; z `log` dopisuje tam każde wywołanie. Ścieżka logu jest wpisana w skrypt,
// nie w zmienną środowiska: `ios_xcodebuild` woła `xcrun` przez `env -i`, które zmienną by skasowało.
// `devicectl` dostaje pustą listę urządzeń w pliku `--json-output` (ostatni argument): iPad niepołączony.
function fakeXcode(log?: string): { developerDir: string; bin: string } {
  const dir = tempDir('rarog-ios-lib-');
  const developerDir = path.join(dir, 'Developer');
  mkdirSync(path.join(developerDir, 'Platforms'), { recursive: true });
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const xcrun = [
    '#!/usr/bin/env bash',
    ...(log ? [`echo "$*" >>'${log}'`] : []),
    `if [[ "$1" == devicectl ]]; then printf '{"result":{"devices":[]}}' >"\${@: -1}"; fi`,
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(path.join(bin, 'xcrun'), xcrun);
  chmodSync(path.join(bin, 'xcrun'), 0o755);
  writeFileSync(path.join(bin, 'git'), `#!/bin/bash\nexec env -u DEVELOPER_DIR "${REAL_GIT}" "$@"\n`);
  chmodSync(path.join(bin, 'git'), 0o755);
  return { developerDir, bin };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Publiczne skrypty, które `ios-build.sh` źródłuje, razem z nim: kopie w atrapie repo. */
const BUILD_SCRIPTS = ['ios-build.sh', 'ios-lib.sh', 'ios-identity.sh', 'xcode-toolchain.sh'];

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

const COMMIT = [
  '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null', 'commit', '-q',
];

/** Server source the build reads the package's minimum app build from (a build without git warns below it). */
const CLIENTS = 'server/src/config/clients.ts';

/** Katalog z kopiami skryptów builda w `scripts/`, bez gita. */
function scriptsDir(prefix: string): string {
  const dir = tempDir(prefix);
  mkdirSync(path.join(dir, 'scripts'));
  for (const script of BUILD_SCRIPTS) {
    copyFileSync(path.join(repoRoot, 'scripts', script), path.join(dir, 'scripts', script));
  }
  mkdirSync(path.join(dir, path.dirname(CLIENTS)), { recursive: true });
  copyFileSync(path.join(repoRoot, CLIENTS), path.join(dir, CLIENTS));
  return dir;
}

/** Atrapa repo z pełną historią: skrypty builda w pierwszym commicie, potem puste commity, razem `commits`. */
function fakeRepo(commits: number): string {
  const repo = scriptsDir('rarog-ios-repo-');
  git(repo, 'init', '-q');
  git(repo, 'add', 'scripts');
  git(repo, ...COMMIT, '-m', 'skrypty');
  for (let i = 2; i <= commits; i += 1) git(repo, ...COMMIT, '--allow-empty', '-m', `commit ${i}`);
  return repo;
}

/** Płytki klon atrapy (`git clone --depth`; lokalny klon bierze `--depth` tylko przez `file://`). */
function shallowClone(repo: string, depth: number): string {
  const clone = path.join(tempDir('rarog-ios-shallow-'), 'repo');
  const args = ['clone', '-q', '--depth', String(depth), `file://${repo}`, clone];
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git clone --depth: ${res.stderr}`);
  return clone;
}

/**
 * `ios_build_number <count>` ze skryptów w `root` (domyślnie świeża atrapa repo z jednym commitem). Liczba
 * commitów przychodzi argumentem, a z repo helper czyta tylko to, czy klon jest płytki.
 */
function buildNumber(count: string, override?: string, root = fakeRepo(1)): Run {
  const { developerDir, bin } = fakeXcode();
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: tempDir('rarog-ios-home-'),
    DEVELOPER_DIR: developerDir,
    // Katalog bez gita nie znajdzie repo wyżej (np. gdy katalog tymczasowy leży w repo).
    GIT_CEILING_DIRECTORIES: path.dirname(root),
  };
  if (override !== undefined) env.RAROG_BUILD_NUMBER = override;
  const lib = path.join(root, 'scripts/ios-lib.sh');
  const res = spawnSync('bash', ['-c', `source "${lib}"\nios_build_number "${count}"`], { encoding: 'utf8', env });
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

interface BuildRun extends Run {
  /** Wywołania `xcodebuild` atrapy `xcrun`, po jednym w linii. */
  xcodebuild: string[];
}

/** `scripts/ios-build.sh` z kopii w `root`: bez iPada, bez klucza API, z atrapą `xcrun` zapisującą wywołania. */
function iosBuild(root: string, extra: Record<string, string> = {}): BuildRun {
  const home = tempDir('rarog-ios-home-');
  const log = path.join(home, 'xcrun.log');
  writeFileSync(log, '');
  const { developerDir, bin } = fakeXcode(log);
  const res = spawnSync('bash', [path.join(root, 'scripts/ios-build.sh')], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      TMPDIR: home,
      DEVELOPER_DIR: developerDir,
      GIT_CEILING_DIRECTORIES: path.dirname(root),
      ...extra,
    },
  });
  const xcodebuild = readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('xcodebuild '));
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr.trim(), xcodebuild };
}

/** `CURRENT_PROJECT_VERSION` z jedynego wywołania `xcodebuild`. */
function projectVersion(run: BuildRun): string | undefined {
  expect(run.xcodebuild).toHaveLength(1);
  return /(?:^| )CURRENT_PROJECT_VERSION=(\S+)/u.exec(run.xcodebuild[0] ?? '')?.[1];
}

describe('ios-build.sh: numer builda z ios_build_number', () => {
  it('kontrola atrapy: pełna historia ma 7 commitów, płytki klon 2 i flagę płytkości', () => {
    const repo = fakeRepo(7);
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('7');
    expect(git(repo, 'rev-parse', '--is-shallow-repository')).toBe('false');
    const clone = shallowClone(repo, 2);
    expect(git(clone, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(git(clone, 'rev-parse', '--is-shallow-repository')).toBe('true');
  });

  it('pełna historia: numer = liczba commitów HEAD, w xcodebuild i w raporcie', () => {
    const run = iosBuild(fakeRepo(7));
    expect(run.status).toBe(0);
    expect(projectVersion(run)).toBe('7');
    expect(run.stdout).toContain('ios: built (build 7)');
  });

  it('nadpisanie w górę: numer = RAROG_BUILD_NUMBER', () => {
    const run = iosBuild(fakeRepo(7), { RAROG_BUILD_NUMBER: '50' });
    expect(run.status).toBe(0);
    expect(projectVersion(run)).toBe('50');
    expect(run.stdout).toContain('ios: built (build 50)');
  });

  it.each(['7', '3'])('nadpisanie %s nie w górę: odmowa przed xcodebuild', (override) => {
    const run = iosBuild(fakeRepo(7), { RAROG_BUILD_NUMBER: override });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`RAROG_BUILD_NUMBER=${override} must be greater than the HEAD commit count (7)`);
    expect(run.xcodebuild).toEqual([]);
  });

  it.each([
    ['bez nadpisania', {}],
    ['z nadpisaniem w górę', { RAROG_BUILD_NUMBER: '50' }],
  ])('płytki klon (%s): odmowa przed xcodebuild', (_name, extra: Record<string, string>) => {
    const run = iosBuild(shallowClone(fakeRepo(7), 2), extra);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('shallow clone: the HEAD commit count (2) is too low');
    expect(run.stderr).toContain('fetch --unshallow');
    expect(run.xcodebuild).toEqual([]);
  });

  it('katalog bez gita (rozpakowane archiwum): odmowa przed xcodebuild', () => {
    const run = iosBuild(scriptsDir('rarog-ios-bez-gita-'));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('HEAD commit count unknown (empty)');
    expect(run.xcodebuild).toEqual([]);
  });

  it('a directory without git builds with RAROG_BUILD_NUMBER', () => {
    const run = iosBuild(scriptsDir('rarog-ios-bez-gita-'), { RAROG_BUILD_NUMBER: '6000' });
    expect(run.status, run.stderr).toBe(0);
    expect(projectVersion(run)).toBe('6000');
    expect(run.stdout).toContain('ios: built (build 6000)');
  });
});

describe('ios_build_number', () => {
  it('bez RAROG_BUILD_NUMBER oddaje liczbę commitów', () => {
    expect(buildNumber('1450')).toEqual({ status: 0, stdout: '1450', stderr: '' });
  });

  it('puste RAROG_BUILD_NUMBER = brak nadpisania', () => {
    expect(buildNumber('1450', '')).toEqual({ status: 0, stdout: '1450', stderr: '' });
  });

  it('nadpisanie większe od liczby commitów wygrywa', () => {
    expect(buildNumber('1450', '1501')).toEqual({ status: 0, stdout: '1501', stderr: '' });
  });

  it.each(['1450', '1449', '0'])('odrzuca nadpisanie %s nie większe od liczby commitów', (override) => {
    const res = buildNumber('1450', override);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('must be greater than the HEAD commit count (1450)');
  });

  // `ios-build.sh` liczy commity podstawieniem w argumencie helpera, więc błąd gita nie zatrzymuje skryptu
  // przez `set -e`: pusty albo zły wynik musi zatrzymać helper, także z poprawnym nadpisaniem.
  it.each([
    ['', undefined],
    ['', '1501'],
    ['fatal', '1501'],
  ])('odrzuca nieznaną liczbę commitów „%s” (nadpisanie: %s)', (count, override) => {
    const res = buildNumber(count, override);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('HEAD commit count unknown');
  });

  it.each(['abc', '15o1', '-1600', '1600 ', '01600'])('odrzuca nadpisanie „%s”, które nie jest liczbą', (override) => {
    const res = buildNumber('1450', override);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('is not a number');
  });

  it.each([undefined, '1501'])('płytki klon odmawia (nadpisanie: %s)', (override) => {
    const res = buildNumber('1450', override, shallowClone(fakeRepo(3), 1));
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('shallow clone: the HEAD commit count (1450) is too low');
  });

  it('katalog bez gita: nie wiadomo, czy historia jest pełna, więc odmowa', () => {
    const res = buildNumber('1450', undefined, scriptsDir('rarog-ios-bez-gita-'));
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('cannot check whether the clone has the full history');
  });

  describe('a directory without git (an unpacked archive) with RAROG_BUILD_NUMBER', () => {
    const above = String(DEFAULT_MIN_CLIENT_BUILD + 386);
    const below = String(DEFAULT_MIN_CLIENT_BUILD - 1);

    it.each(['', '1450'])('takes the number as given (commit count %j)', (count) => {
      expect(buildNumber(count, above, scriptsDir('rarog-ios-bez-gita-'))).toEqual({
        status: 0, stdout: above, stderr: '',
      });
    });

    it('below the minimum app build of a package install: the number, and a warning on stderr', () => {
      const res = buildNumber('', below, scriptsDir('rarog-ios-bez-gita-'));
      expect(res.status).toBe(0);
      expect(res.stdout).toBe(below);
      expect(res.stderr).toContain(`warning: build ${below} is below the minimum app build of a package install`
        + ` (${String(DEFAULT_MIN_CLIENT_BUILD)})`);
    });

    it('without the server source: the number, and a warning that the minimum could not be read', () => {
      const dir = scriptsDir('rarog-ios-bez-gita-');
      rmSync(path.join(dir, 'server'), { recursive: true });
      const res = buildNumber('', above, dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe(above);
      expect(res.stderr).toContain(`warning: cannot read DEFAULT_MIN_CLIENT_BUILD from ${CLIENTS}`);
    });

    it.each(['abc', '01600', '-1'])('refuses %j, which is not a number', (override) => {
      const res = buildNumber('', override, scriptsDir('rarog-ios-bez-gita-'));
      expect(res.status).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('is not a number');
    });
  });

  // Git bez `--is-shallow-repository` (starszy niż 2.15) wypisuje nieznaną opcję i kończy się kodem 0: tylko
  // dosłowne `false` przepuszcza.
  it('git z kodem 0 i odpowiedzią inną niż true/false: odmowa', () => {
    const repo = fakeRepo(1);
    const { developerDir, bin } = fakeXcode();
    writeFileSync(path.join(bin, 'git'), [
      '#!/bin/bash',
      'for arg; do [[ "$arg" == --is-shallow-repository ]] && { echo "$arg"; exit 0; }; done',
      `exec env -u DEVELOPER_DIR "${REAL_GIT}" "$@"`,
      '',
    ].join('\n'));
    const res = spawnSync('bash', ['-c', `source "${path.join(repo, 'scripts/ios-lib.sh')}"\nios_build_number 1450`], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: tempDir('rarog-ios-home-'), DEVELOPER_DIR: developerDir },
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('cannot check whether the clone has the full history');
  });
});

// Atrapa klucza `.p8`: skrypt sprawdza tylko istnienie i prawa pliku, treści nie czyta.
function fakeKey(file: string, mode = 0o600): string {
  writeFileSync(file, 'atrapa\n');
  chmodSync(file, mode);
  return file;
}

function ascArgs(keyPath: string, keyId: string, issuer: string): string {
  return ['-authenticationKeyPath', keyPath, '-authenticationKeyID', keyId, '-authenticationKeyIssuerID', issuer].join(
    '\n',
  );
}

interface AscOptions {
  env?: Record<string, string>;
  home?: string;
  /** Kod wyjścia podmienionego strażnika czystości (`ios_scripts_clean`). */
  guard?: 0 | 1;
}

// `ios_asc_auth` w świeżym HOME z atrapą Xcode; stdout = flagi xcodebuild po jednej w linii. Środowisko testu ma
// tylko to, co poda przypadek.
function ascAuth(opts: AscOptions = {}): Run {
  const { developerDir, bin } = fakeXcode();
  const home = opts.home ?? tempDir('rarog-ios-home-');
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: home,
    DEVELOPER_DIR: developerDir,
    ...opts.env,
  };
  const script = [
    `source "${LIB}"`,
    `ios_scripts_clean() { return ${opts.guard ?? 0}; }`,
    'ios_asc_auth || exit $?',
    'printf "%s\\n" "${IOS_ASC_ARGS[@]}"',
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

// Pełna trójka zmiennych środowiska z kluczem `keyPath`.
function envTrio(keyPath: string): Record<string, string> {
  return { RAROG_ASC_KEY_ID: 'KEYENV', RAROG_ASC_ISSUER_ID: 'issuer-env', RAROG_ASC_KEY_PATH: keyPath };
}

// Plik sekretów z pełną trójką w HOME i pod `RAROG_SECRETS_FILE`: `ios_asc_auth` go nie czyta.
function secretsFile(home: string, keyPath: string): string {
  const file = path.join(home, '.secrets');
  writeFileSync(
    file,
    ['export RAROG_ASC_KEY_ID="KEYPLIK"', "RAROG_ASC_ISSUER_ID='issuer-plik'", `RAROG_ASC_KEY_PATH=${keyPath}`, ''].join('\n'),
  );
  return file;
}

describe.skipIf(!IS_MAC)(macOnly('ios_asc_auth', 'stat -f'), () => {
  it('pełna trójka ze środowiska', () => {
    const dir = tempDir('rarog-ios-asc-');
    const key = fakeKey(path.join(dir, 'klucz-env.p8'));
    expect(ascAuth({ env: envTrio(key) })).toEqual({
      status: 0,
      stdout: ascArgs(key, 'KEYENV', 'issuer-env'),
      stderr: '',
    });
  });

  it.each([
    ['bez KEY_PATH', { RAROG_ASC_KEY_ID: 'KEYENV', RAROG_ASC_ISSUER_ID: 'issuer-env' }],
    ['bez KEY_ID', { RAROG_ASC_ISSUER_ID: 'issuer-env', RAROG_ASC_KEY_PATH: 'ENV_KEY' }],
    ['z pustym ISSUER_ID', { RAROG_ASC_KEY_ID: 'KEYENV', RAROG_ASC_ISSUER_ID: '', RAROG_ASC_KEY_PATH: 'ENV_KEY' }],
  ])('niepełne środowisko (%s): kod 1, także przy pliku sekretów z pełną trójką', (_name, partial) => {
    const home = tempDir('rarog-ios-home-');
    const envKey = fakeKey(path.join(home, 'klucz-env.p8'));
    const secrets = secretsFile(home, fakeKey(path.join(home, 'klucz-plik.p8')));
    const env = Object.fromEntries(
      Object.entries(partial).map(([name, value]) => [name, value === 'ENV_KEY' ? envKey : value]),
    );
    expect(ascAuth({ home, env: { ...env, RAROG_SECRETS_FILE: secrets } }))
      .toEqual({ status: 1, stdout: '', stderr: '' });
  });

  it.each([
    ['bez zmiennych', {}],
    ['z pustymi zmiennymi', { RAROG_ASC_KEY_ID: '', RAROG_ASC_ISSUER_ID: '', RAROG_ASC_KEY_PATH: '' }],
  ])('puste środowisko (%s): kod 1, komunikat zostaje wołającemu', (_name, env) => {
    expect(ascAuth({ env })).toEqual({ status: 1, stdout: '', stderr: '' });
  });

  // Menedżer sekretów podaje ścieżkę dosłownie, bez rozwinięcia przez powłokę.
  it.each(['~/klucz.p8', '$HOME/klucz.p8'])('ścieżka „%s” ze środowiska rozwija się do HOME', (keyPath) => {
    const home = tempDir('rarog-ios-home-');
    const key = fakeKey(path.join(home, 'klucz.p8'));
    expect(ascAuth({ home, env: envTrio(keyPath) })).toEqual({
      status: 0,
      stdout: ascArgs(key, 'KEYENV', 'issuer-env'),
      stderr: '',
    });
  });

  it('klucz z prawami 644: kod 1, bez treści klucza', () => {
    const dir = tempDir('rarog-ios-asc-');
    const key = fakeKey(path.join(dir, 'klucz.p8'), 0o644);
    const res = ascAuth({ env: envTrio(key) });
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('chmod 600');
    expect(res.stderr).not.toContain('atrapa');
  });

  it('ścieżka ze środowiska bez pliku klucza: kod 1', () => {
    const dir = tempDir('rarog-ios-asc-');
    const res = ascAuth({ env: envTrio(path.join(dir, 'nie-ma-klucza.p8')) });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('RAROG_ASC_KEY_PATH does not point to a key file');
  });

  // Klucz TestFlighta to osobna trójka `RAROG_ASC_TESTFLIGHT_*`: `ios_asc_auth` jej nie bierze.
  it('trójka TestFlighta w środowisku to nie klucz buildu na urządzenie: kod 1', () => {
    const dir = tempDir('rarog-ios-asc-');
    const key = fakeKey(path.join(dir, 'klucz-tf.p8'));
    expect(ascAuth({
      env: {
        RAROG_ASC_TESTFLIGHT_KEY_ID: 'KEYTF', RAROG_ASC_TESTFLIGHT_ISSUER_ID: 'issuer-tf',
        RAROG_ASC_TESTFLIGHT_KEY: 'atrapa', RAROG_ASC_TESTFLIGHT_KEY_PATH: key,
      },
    })).toEqual({ status: 1, stdout: '', stderr: '' });
  });

  it('strażnik czystości odmawia także przy pełnej trójce ze środowiska', () => {
    const dir = tempDir('rarog-ios-asc-');
    const res = ascAuth({ env: envTrio(fakeKey(path.join(dir, 'klucz.p8'))), guard: 1 });
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('uncommitted changes');
  });

  it.each<[string, () => string, boolean, string]>([
    ['a checkout with uncommitted script changes, without the key: refusal', () => {
      const repo = fakeRepo(1);
      writeFileSync(path.join(repo, 'scripts/ios-lib.sh'), `${readFileSync(LIB, 'utf8')}\n# change\n`);
      return repo;
    }, false, 'uncommitted changes'],
    ['a directory without git, without the key: no key, no refusal', () => scriptsDir('rarog-ios-bez-gita-'), false, ''],
    ['a directory without git, with the key trio: the guard cannot run, so a refusal',
      () => scriptsDir('rarog-ios-bez-gita-'), true, 'uncommitted changes'],
  ])('%s', (_, makeRoot, trio, stderr) => {
    const root = makeRoot();
    const { developerDir, bin } = fakeXcode();
    const home = tempDir('rarog-ios-home-');
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, DEVELOPER_DIR: developerDir,
      GIT_CEILING_DIRECTORIES: path.dirname(root),
      ...(trio ? envTrio(fakeKey(path.join(home, 'atrapa-klucza'))) : {}),
    };
    const script = `source "${path.join(root, 'scripts/ios-lib.sh')}"\nios_asc_auth || exit $?`;
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
    expect(res.status).toBe(1);
    if (stderr === '') expect(res.stderr.trim()).toBe('');
    else expect(res.stderr).toContain(stderr);
  });
});

// Kontrola atrapy: wywołanie przez `ios_xcodebuild` (z `env -i`) zostawia wpis w logu, więc asercja
// „xcodebuild nie ruszył” na tej atrapie coś mierzy. Przy okazji: do potomka nie trafia żadna zmienna `RAROG_ASC_*`.
describe('atrapa xcrun', () => {
  it('loguje wywołanie przez ios_xcodebuild mimo env -i, bez zmiennych klucza w środowisku potomka', () => {
    const home = tempDir('rarog-ios-home-');
    const xcrunLog = path.join(home, 'xcrun.log');
    writeFileSync(xcrunLog, '');
    const { developerDir, bin } = fakeXcode(xcrunLog);
    writeFileSync(
      path.join(bin, 'xcrun'),
      `#!/usr/bin/env bash\necho "$*" >>'${xcrunLog}'\nenv | grep -c '^RAROG_ASC_' >>'${xcrunLog}' || true\nexit 0\n`,
    );
    const res = spawnSync('bash', ['-c', `source "${LIB}"\nios_xcodebuild -version`], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        DEVELOPER_DIR: developerDir,
        RAROG_ASC_KEY_ID: 'KEYENV',
        RAROG_ASC_ISSUER_ID: 'issuer-env',
        RAROG_ASC_KEY_PATH: '/nie/ma.p8',
      },
    });
    expect(res.status).toBe(0);
    // Źródłowanie biblioteki woła wcześniej `xcrun --find swift` (wybór toolchainu, bez `env -i`); liczy się
    // wpis `xcodebuild` i liczba zmiennych klucza widziana przez TEN proces.
    const log = readFileSync(xcrunLog, 'utf8').trim().split('\n');
    expect(log.slice(log.indexOf('xcodebuild -version'))).toEqual(['xcodebuild -version', '0']);
  });
});

/**
 * `ios_scripts_clean` w atrapie repo `root` po `before` (np. dopisaniu skryptu do listy): stdout = lista
 * `IOS_KEY_SCRIPTS` po jednej ścieżce w linii, kod wyjścia = wynik strażnika.
 */
function scriptsClean(root: string, before = ''): Run {
  const { developerDir, bin } = fakeXcode();
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: tempDir('rarog-ios-home-'),
    DEVELOPER_DIR: developerDir,
    GIT_CEILING_DIRECTORIES: path.dirname(root),
  };
  const lib = path.join(root, 'scripts/ios-lib.sh');
  const script = [`source "${lib}"`, before, 'printf "%s\\n" "${IOS_KEY_SCRIPTS[@]}"', 'ios_scripts_clean'].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

describe('lista skryptów klucza (`IOS_KEY_SCRIPTS`) i strażnik czystości', () => {
  it('lista to biblioteka i build na urządzenie, same pliki tego repo', () => {
    const listed = scriptsClean(fakeRepo(1)).stdout.split('\n');
    expect([...listed].sort()).toEqual(BUILD_SCRIPTS.map((script) => `scripts/${script}`).sort());
  });

  it('czyste skrypty z listy: kod 0; zmiana w skrypcie spoza listy go nie zmienia', () => {
    const repo = fakeRepo(1);
    expect(scriptsClean(repo).status).toBe(0);
    writeFileSync(path.join(repo, 'scripts/inny.sh'), '# poza listą\n');
    git(repo, 'add', 'scripts/inny.sh');
    git(repo, ...COMMIT, '-m', 'inny');
    writeFileSync(path.join(repo, 'scripts/inny.sh'), '# zmiana\n');
    expect(scriptsClean(repo).status).toBe(0);
  });

  it('niezacommitowana zmiana w skrypcie z listy: kod różny od 0', () => {
    const repo = fakeRepo(1);
    writeFileSync(path.join(repo, 'scripts/ios-identity.sh'), '# zmiana\n', { flag: 'a' });
    expect(scriptsClean(repo).status).not.toBe(0);
  });

  it('skrypt dopisany do listy przez wołającego: jego zmiana też blokuje', () => {
    const repo = fakeRepo(1);
    writeFileSync(path.join(repo, 'scripts/wysylka.sh'), '# klucz\n');
    git(repo, 'add', 'scripts/wysylka.sh');
    git(repo, ...COMMIT, '-m', 'wysyłka');
    const append = 'IOS_KEY_SCRIPTS+=(scripts/wysylka.sh)';
    expect(scriptsClean(repo, append).status).toBe(0);
    writeFileSync(path.join(repo, 'scripts/wysylka.sh'), '# zmiana\n', { flag: 'a' });
    expect(scriptsClean(repo, append).status).not.toBe(0);
    expect(scriptsClean(repo).status).toBe(0);
  });
});
