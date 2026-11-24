/*
 * Strażniki skryptów, które nie mają własnej logiki do testowania, ale muszą działać pod tym, co
 * je uruchamia: `scripts/check.sh` (bramka `pnpm run check`) i każdy `scripts/*.sh`.
 *
 * Te asercje pilnują rzeczy niezależnych od frontu: składni i ShellChecka bramki oraz
 * przenośności wszystkich skryptów na systemowego basha 3.2.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { repoFiles } from '../../scripts/lib/repo-files.mjs';
import { skipSites } from './platform.ts';
import { inExportView } from './private-guard.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checkScript = path.join(repoRoot, 'scripts', 'check.sh');

describe('scripts/check.sh — składnia', () => {
  it('przechodzi `bash -n`', () => {
    expect(() => execFileSync('bash', ['-n', checkScript])).not.toThrow();
  });

  const hasShellcheck = spawnSync('shellcheck', ['--version']).status === 0;
  it.skipIf(!hasShellcheck)('jest ShellCheck-clean (requires shellcheck)', () => {
    const result = spawnSync('shellcheck', [checkScript], { encoding: 'utf8' });
    expect(result.status, result.stdout).toBe(0);
  });
});

describe('scripts/check.sh — język testów Swift', () => {
  // Krok `swift-contract` odpala testy RarogContract, a `CopyLanguage` zatrzymuje proces testów bez przypiętego
  // języka (`docs/localization.md`, „Tests”). Bez Xcode krok jest pomijany, więc pilnujemy samej linii polecenia.
  it('bramka puszcza strażnika katalogów copy (scripts/l10n-check.mjs)', () => {
    expect(readFileSync(checkScript, 'utf8')).toMatch(/^node scripts\/l10n-check\.mjs$/m);
  });

  it('swift test RarogContract dostaje RAROG_COPY_LANGUAGE=pl', () => {
    const body = readFileSync(checkScript, 'utf8');
    expect(body).toMatch(/^\s*RAROG_COPY_LANGUAGE=pl\b[^\n]*swift test --package-path native\/Rarog\/Packages\/RarogContract$/m);
  });
});

describe('scripts/check.sh — przekaźnik push', () => {
  // `relay/` to osobny projekt pnpm: root `vitest` i `tsc -b` go nie widzą, więc bramka woła go sama, a bez
  // instalacji mówi „pominięto" (jak krok `swift-contract`), zamiast przejść po cichu.
  it('typecheck i testy relay/ przy relay/node_modules, inaczej jawne „pominięto"', () => {
    const body = readFileSync(checkScript, 'utf8');
    expect(body).toMatch(/^if \[\[ -d relay\/node_modules \]\]; then\n {2}pnpm -C relay run typecheck\n {2}pnpm -C relay test\nelse\n {2}echo "relay: skipped/m);
  });
});

describe('scripts/check.sh — rejestr relaya iroh', () => {
  // `relay-auth/` to osobny projekt pnpm jak `relay/`, a jego moduły wspólne biorą zależności z
  // `relay/node_modules`: krok wymaga obu instalacji, bez którejkolwiek mówi „pominięto".
  it('typecheck i testy relay-auth/ przy obu node_modules, inaczej jawne „pominięto"', () => {
    const body = readFileSync(checkScript, 'utf8');
    expect(body).toMatch(/^if \[\[ -d relay-auth\/node_modules && -d relay\/node_modules \]\]; then\n {2}pnpm -C relay-auth run typecheck\n {2}pnpm -C relay-auth test\nelse\n {2}echo "relay-auth: skipped/m);
  });
});

describe('scripts/check.sh — kroki warunkowe i `--strict` (atrapa repo)', () => {
  // Prawdziwy `check.sh` i loader literałów w atrapie repo; `pnpm`, `xcrun`, `git`, `shellcheck`, `zizmor` to zaślepki
  // z dziennikiem wywołań. PATH to sam katalog atrap (plus `node`, `dirname` i `bash`), więc „brak narzędzia” jest
  // prawdziwym brakiem także tam, gdzie ShellCheck albo git leżą w `/usr/bin` (Ubuntu).
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const ALL_SKIPPED = 'swift-contract, relay, relay-auth, git diff --check, shellcheck, toml, zizmor';
  /** Narzędzia systemowe, których `check.sh` potrzebuje poza atrapami: `cd "$(dirname "$0")/.."` i `bash -n`. */
  const SYSTEM_TOOLS = ['dirname', 'bash'].map((name) => ({
    name, file: ['/usr/bin', '/bin'].map((dir) => path.join(dir, name)).find((file) => existsSync(file)) ?? `/bin/${name}`,
  }));

  interface Atrapa {
    readonly run: (args: readonly string[], env?: Readonly<Record<string, string>>) => ReturnType<typeof spawnSync>;
    readonly log: () => string;
    readonly literals: (data: unknown) => string;
    /** Podmienia zaślepkę narzędzia na taką, która kończy się kodem 1 przy argumentach pasujących do wzorca `case`. */
    readonly failOn: (name: string, pattern: string) => void;
    /** Usuwa katalog atrapy repo (np. `relay/node_modules`). */
    readonly remove: (relative: string) => void;
  }

  /** `komplet`: Xcode, relay/ i relay-auth/node_modules, `.git` (plik, jak w worktree), ShellCheck, `python3`, zizmor. */
  function atrapa(komplet: boolean): Atrapa {
    const base = mkdtempSync(path.join(tmpdir(), 'rarog-check-strict-'));
    made.push(base);
    const root = path.join(base, 'repo');
    const bin = path.join(base, 'bin');
    const home = path.join(base, 'home');
    const log = path.join(base, 'wywolania.log');
    for (const dir of [path.join(root, 'scripts', 'lib'), bin, home]) mkdirSync(dir, { recursive: true });
    copyFileSync(checkScript, path.join(root, 'scripts', 'check.sh'));
    for (const name of ['private-literals.mjs', 'is-main.mjs']) {
      copyFileSync(path.join(repoRoot, 'scripts', 'lib', name), path.join(root, 'scripts', 'lib', name));
    }
    writeFileSync(path.join(root, 'scripts', 'l10n-check.mjs'), '');
    writeFileSync(path.join(root, 'scripts', 'xcode-toolchain.sh'), komplet
      ? 'rarog_xcode_developer_dir() { echo /atrapa/Xcode; }\n'
      : 'rarog_xcode_developer_dir() { return 1; }\n');
    symlinkSync(process.execPath, path.join(bin, 'node'));
    for (const tool of SYSTEM_TOOLS) symlinkSync(tool.file, path.join(bin, tool.name));
    const stub = (name: string, failPattern?: string): void => {
      const fail = failPattern === undefined ? '' : `case "$*" in ${failPattern}) exit 1 ;; esac\n`;
      writeFileSync(path.join(bin, name),
        `#!/bin/sh\necho "${name} $* REQUIRE=\${RAROG_REQUIRE_PRIVATE_LITERALS:-}" >>"$CHECK_LOG"\n${fail}`, { mode: 0o755 });
    };
    stub('pnpm');
    if (komplet) {
      for (const name of ['xcrun', 'git', 'shellcheck', 'python3', 'zizmor']) stub(name);
      mkdirSync(path.join(root, 'relay', 'node_modules'), { recursive: true });
      mkdirSync(path.join(root, 'relay-auth', 'node_modules'), { recursive: true });
      writeFileSync(path.join(root, '.git'), 'gitdir: /atrapa/.git/worktrees/repo\n');
    }
    return {
      run: (args, env = {}) => spawnSync('/bin/bash', [path.join(root, 'scripts', 'check.sh'), ...args], {
        encoding: 'utf8', env: { PATH: bin, HOME: home, CHECK_LOG: log, ...env },
      }),
      log: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
      literals: (data) => {
        const file = path.join(base, 'private-literals.json');
        writeFileSync(file, JSON.stringify(data));
        return file;
      },
      failOn: (name, pattern) => { stub(name, pattern); },
      remove: (relative) => { rmSync(path.join(root, relative), { recursive: true }); },
    };
  }
  const SYNTHETIC = { version: 2, forbidden: ['atrapa-literal'] };

  it('bez `--strict`: każde pominięcie jawne, kod 0, lista pominiętych w ostatniej linii', () => {
    const repo = atrapa(false);
    const res = repo.run([]);
    expect(res.status, String(res.stderr)).toBe(0);
    expect(res.stdout).toContain('private literals: file missing, name guards skipped');
    expect(String(res.stdout).trimEnd().split('\n').at(-1))
      .toBe(`check: green — production untouched (skipped: private literals, ${ALL_SKIPPED})`);
    expect(repo.log()).toContain('pnpm test REQUIRE=\n');
  });

  it('`--strict` i `RAROG_CHECK_STRICT=1`: pominięty krok = kod 3 z nazwą każdego kroku; testy z wymogiem pliku', () => {
    for (const [args, env] of [[['--strict'], {}], [[], { RAROG_CHECK_STRICT: '1' }]] as const) {
      const repo = atrapa(false);
      const res = repo.run(args, { ...env, RAROG_PRIVATE_LITERALS: repo.literals(SYNTHETIC) });
      expect(res.status, String(res.stdout)).toBe(3);
      expect(res.stderr).toContain(`check --strict: skipped steps: ${ALL_SKIPPED}`);
      expect(res.stdout).not.toContain('check: green');
      expect(repo.log()).toContain('pnpm test REQUIRE=1\n');
    }
  });

  it('`--strict` bez pliku literałów: kod 3 przed testami', () => {
    const repo = atrapa(true);
    const res = repo.run(['--strict']);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain('skipped step: private literals');
    expect(repo.log()).toBe('');
  });

  it('`--strict` z kompletem narzędzi: zielono, każdy krok warunkowy wykonany', () => {
    const repo = atrapa(true);
    const res = repo.run(['--strict'], { RAROG_PRIVATE_LITERALS: repo.literals(SYNTHETIC) });
    expect(res.status, String(res.stderr)).toBe(0);
    expect(String(res.stdout).trimEnd().split('\n').at(-1)).toBe('check: green — production untouched');
    const log = repo.log();
    for (const call of ['xcrun swift test', 'pnpm -C relay test', 'pnpm -C relay-auth run typecheck',
      'pnpm -C relay-auth test', 'git diff --check', 'git diff --cached --check', 'shellcheck scripts/',
      'python3 -I scripts/lib/toml-check.py', 'zizmor --offline --strict-collection .github']) {
      expect(log, call).toContain(call);
    }
  });

  it('`--strict --no-tests`: every step but vitest runs, exit 0, the tests are not counted as a skipped step', () => {
    const repo = atrapa(true);
    const res = repo.run(['--strict', '--no-tests'], { RAROG_PRIVATE_LITERALS: repo.literals(SYNTHETIC) });
    expect(res.status, String(res.stderr)).toBe(0);
    expect(res.stdout).toContain('== test\ntest: not run (--no-tests)\n');
    expect(String(res.stdout).trimEnd().split('\n').at(-1)).toBe('check: green — production untouched');
    const log = repo.log();
    expect(log).not.toMatch(/^pnpm test/m);
    for (const call of ['pnpm run typecheck', 'xcrun swift test', 'pnpm -C relay run typecheck', 'pnpm -C relay test',
      'pnpm -C relay-auth run typecheck', 'pnpm -C relay-auth test', 'git diff --check', 'git diff --cached --check',
      'shellcheck scripts/', 'python3 -I scripts/lib/toml-check.py', 'zizmor --offline --strict-collection .github']) {
      expect(log, call).toContain(call);
    }
  });

  it('znalezisko zizmora przewraca bramkę kodem narzędzia, bez „zielono”', () => {
    const repo = atrapa(true);
    repo.failOn('zizmor', '*');
    const res = repo.run(['--strict'], { RAROG_PRIVATE_LITERALS: repo.literals(SYNTHETIC) });
    expect(res.status).toBe(1);
    expect(res.stdout).not.toContain('check: green');
    expect(repo.log()).toContain('zizmor --offline --strict-collection .github');
  });

  it('plik `.github/`, którego zizmor nie sparsuje, przewraca bramkę zamiast cichego pominięcia', () => {
    // Atrapa odtwarza zizmor 1.31.1 na zepsutym `dependabot.yml`: bez `--strict-collection` tylko ostrzeżenie
    // „failed to parse input” i kod 0, z flagą kod 1.
    const repo = atrapa(true);
    repo.failOn('zizmor', '*--strict-collection*');
    const res = repo.run(['--strict'], { RAROG_PRIVATE_LITERALS: repo.literals(SYNTHETIC) });
    expect(res.status, String(res.stdout)).toBe(1);
    expect(res.stdout).not.toContain('check: green');
  });

  it('relay-auth bez relay/node_modules: krok „pominięto", pnpm dla relay-auth nie startuje', () => {
    const repo = atrapa(true);
    repo.remove('relay/node_modules');
    const res = repo.run([], { RAROG_PRIVATE_LITERALS: repo.literals(SYNTHETIC) });
    expect(res.status, String(res.stderr)).toBe(0);
    expect(res.stdout).toContain('relay-auth: skipped');
    expect(String(res.stdout).trimEnd().split('\n').at(-1))
      .toBe('check: green — production untouched (skipped: relay, relay-auth)');
    expect(repo.log()).not.toContain('-C relay-auth');
  });

  it('błąd typecheck albo testów relay-auth przewraca bramkę przed dalszymi krokami', () => {
    for (const pattern of ['"-C relay-auth run typecheck"', '"-C relay-auth test"']) {
      const repo = atrapa(true);
      repo.failOn('pnpm', pattern);
      const res = repo.run([], { RAROG_PRIVATE_LITERALS: repo.literals(SYNTHETIC) });
      expect(res.status, pattern).not.toBe(0);
      expect(res.stdout, pattern).not.toContain('check: green');
      expect(repo.log(), pattern).toContain('pnpm -C relay-auth');
      expect(repo.log(), pattern).not.toContain('git diff --check');
    }
  });

  it('`RAROG_CHECK_TEST_REPORT`: testy z dodatkowym raportem JSON, bez zmiennej zwykłe `pnpm test`', () => {
    const repo = atrapa(false);
    expect(repo.run([], { RAROG_CHECK_TEST_REPORT: '/atrapa/raport.json' }).status).toBe(0);
    expect(repo.log()).toContain('pnpm test --reporter=default --reporter=json --outputFile.json=/atrapa/raport.json REQUIRE=\n');
    const plain = atrapa(false);
    expect(plain.run([]).status).toBe(0);
    expect(plain.log()).toContain('pnpm test REQUIRE=\n');
  });

  it('zepsuty plik literałów przewraca bramkę zawsze (kod 2), bez treści pliku w komunikacie', () => {
    const repo = atrapa(true);
    const res = repo.run([], { RAROG_PRIVATE_LITERALS: repo.literals({ version: 1, forbidden: ['tajna-nazwa-x'] }) });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('version');
    expect(`${String(res.stdout)}${String(res.stderr)}`).not.toContain('tajna-nazwa-x');
    expect(repo.log()).toBe('');
  });

  it('nieznany argument: kod 2 i użycie', () => {
    const res = atrapa(false).run(['--strct']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('usage');
  });
});

describe('scripts/*.sh — przenośność', () => {
  /*
   * `bash -n` i ShellCheck NIE łapią klasy „działa tylko na homebrew bashu": brak wbudowanego
   * polecenia jest błędem CZASU WYKONANIA. Tak przeszedł kiedyś `mapfile -t history` (bash ≥ 4)
   * — `/bin/bash` na macOS to 3.2.57, a skrypt w odchudzonym PATH (env -i, launchd, sesja
   * ratunkowa) kończył się kodem 127.
   */
  const BASH4_ONLY = /\b(mapfile|readarray|declare\s+-[AaIln]*A)\b/;

  it('żaden skrypt nie sięga po wbudowane polecenia basha 4 (systemowy /bin/bash to 3.2)', () => {
    for (const file of readdirSync(path.join(repoRoot, 'scripts'))) {
      if (!file.endsWith('.sh')) continue;
      const body = readFileSync(path.join(repoRoot, 'scripts', file), 'utf8')
        // Komentarze wolno o nich mówić — chodzi o KOD.
        .split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
      expect(BASH4_ONLY.test(body), `scripts/${file} używa wbudowanego polecenia basha 4`).toBe(false);
    }
  });

  it('`pnpm run ios:shots` woła istniejący `scripts/ios-shots.sh`', () => {
    const scripts = (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }).scripts;
    expect(scripts['ios:shots']).toBe('bash scripts/ios-shots.sh');
    expect(existsSync(path.join(repoRoot, 'scripts', 'ios-shots.sh'))).toBe(true);
  });
});

describe('Inwentarz pominięć testów (lista zamknięta)', () => {
  /*
   * Każde miejsce pominięcia w plikach testów widoku eksportu (`skipIf`, `runIf`, `.skip`, `.todo`, `ctx.skip`) stoi
   * tu z liczbą: nowe pominięcie albo zniknięcie starego przewraca test. Zadanie CI na Ubuntu pomija dzięki temu
   * tylko to, co ta lista nazywa, a pominięcie tylko-macOS ma powód w tytule (`platform.ts`, `macOnly`).
   * Lista tylko-macOS dla czytelnika: `docs/publishing.md`, „macOS-only tests”.
   */
  const SKIPS: Readonly<Record<string, number>> = {
    'relay-vps/test/bramka.test.ts': 4,
    'relay-vps/test/config.test.ts': 1,
    'server/test/fs-browse-work-area.test.ts': 1,
    'server/test/fs-mkdir.test.ts': 1,
    'server/test/git-konfiguracja-repo.test.ts': 1,
    'server/test/file-index-repo.test.ts': 2,
    'server/test/files-sciezka.test.ts': 1,
    'server/test/git-watch.test.ts': 2,
    'server/test/herdr-uploads-protected-dirs.test.ts': 1,
    'server/test/iroh-adapter.test.ts': 1,
    'server/test/iroh-zywa-biblioteka.test.ts': 1,
    'server/test/layer1-top.test.ts': 4,
    'server/test/live-activity-plist-guard.test.ts': 1,
    'server/test/privacy-manifest-guard.test.ts': 2,
    'server/test/rarog-doctor.test.ts': 2,
    'server/test/rarog-restart.test.ts': 11,
    'server/test/rarog-serve.test.ts': 5,
    'server/test/rarog-service.test.ts': 6,
    'server/test/rarog-service-linux.test.ts': 1,
    'server/test/rarog-setup.test.ts': 13,
    'server/test/rarog-update-finish.test.ts': 1,
    'server/test/rarog-update.test.ts': 1,
    'server/test/repo-files.test.ts': 4,
    'server/test/safe-read.test.ts': 2,
    'server/test/scripts-check.test.ts': 1,
    'server/test/scripts-ios-check-demo.test.ts': 6,
    'server/test/scripts-ios-demo.test.ts': 1,
    'server/test/scripts-ios-lib.test.ts': 1,
    'server/test/scripts-launchd.test.ts': 2,
    'server/test/sdk-install-live.test.ts': 1,
    'server/test/secret-input.test.ts': 1,
    'server/test/session-files-repo.test.ts': 1,
    'server/test/setup-check.test.ts': 1,
    'server/test/setup-config.test.ts': 2,
    'server/test/setup-herdr-agent.test.ts': 4,
    'server/test/setup-herdr-unit.test.ts': 1,
    'server/test/setup-pytania.test.ts': 6,
    'server/test/setup-roots.test.ts': 2,
    'server/test/setup-screen.test.ts': 14,
    'server/test/setup-secrets.test.ts': 1,
    'server/test/setup-tailscale-only.test.ts': 1,
    'server/test/setup-transport.test.ts': 9,
    'server/test/setup-voice.test.ts': 2,
    'server/test/term-integration.test.ts': 1,
  };
  /** Pliki z testami tylko-macOS (`skipIf(!IS_MAC)(macOnly(…))`). */
  const MAC_ONLY = [
    'server/test/file-index-repo.test.ts',
    'server/test/files-sciezka.test.ts',
    'server/test/git-konfiguracja-repo.test.ts',
    'server/test/live-activity-plist-guard.test.ts',
    'server/test/privacy-manifest-guard.test.ts',
    'server/test/rarog-doctor.test.ts',
    'server/test/rarog-restart.test.ts',
    'server/test/rarog-service.test.ts',
    'server/test/rarog-setup.test.ts',
    'server/test/rarog-update-finish.test.ts',
    'server/test/rarog-update.test.ts',
    'server/test/safe-read.test.ts',
    'server/test/scripts-ios-check-demo.test.ts',
    'server/test/scripts-ios-lib.test.ts',
    'server/test/scripts-launchd.test.ts',
    'server/test/secret-input.test.ts',
    'server/test/session-files-repo.test.ts',
    'server/test/setup-check.test.ts',
    'server/test/setup-config.test.ts',
    'server/test/setup-herdr-agent.test.ts',
    'server/test/setup-pytania.test.ts',
    'server/test/setup-roots.test.ts',
    'server/test/setup-screen.test.ts',
    'server/test/setup-secrets.test.ts',
    'server/test/setup-tailscale-only.test.ts',
    'server/test/setup-transport.test.ts',
    'server/test/setup-voice.test.ts',
  ];
  const TEST_FILE = /^(?:server|shared|relay|relay-auth|relay-vps)\/test\/.+\.test\.ts$/;
  const scanned = repoFiles(repoRoot).filter((file) => TEST_FILE.test(file) && inExportView(file)).sort()
    .map((file) => ({ file, ...skipSites(readFileSync(path.join(repoRoot, file), 'utf8')) }));

  it('liczba miejsc pominięcia per plik = tabela (nowe pominięcie dopisz tu i w docs, zniknięte usuń)', () => {
    const current = Object.fromEntries(scanned.filter((one) => one.count > 0).map((one) => [one.file, one.count]));
    expect(current, 'aktualna tabela SKIPS').toEqual(SKIPS);
  });

  it('pliki tylko-macOS = lista; każde pominięcie tylko-macOS przez `skipIf(!IS_MAC)(macOnly(…))`', () => {
    expect(scanned.filter((one) => one.macOnly).map((one) => one.file)).toEqual(MAC_ONLY);
    const bare = scanned.flatMap((one) => one.bare.map((line) => `${one.file}:${String(line)}`));
    expect(bare, 'pominięcie tylko-macOS bez powodu w tytule albo z warunkiem na process.platform').toEqual([]);
  });

  it('każde pominięcie ma powód w tytule w tej samej linii (podsumowanie CI liczy je według powodu)', () => {
    const unexplained = scanned.flatMap((one) => one.unexplained.map((line) => `${one.file}:${String(line)}`));
    expect(unexplained, 'tytuł bez nawiasu z powodem: „(requires …)”, „(only with …)”, „(skipped …)” albo macOnly(…)')
      .toEqual([]);
  });

  it('`docs/publishing.md`, „macOS-only tests”, wymienia te same pliki', () => {
    const doc = readFileSync(path.join(repoRoot, 'docs', 'publishing.md'), 'utf8');
    const start = doc.indexOf('\n## macOS-only tests\n');
    expect(start, 'sekcja „macOS-only tests”').toBeGreaterThan(0);
    const section = doc.slice(start + 1).split(/\n(?=## )/)[0] ?? '';
    const listed = [...section.matchAll(/^- `([^`]+\.test\.ts)`/gm)].map((match) => `server/test/${match[1] ?? ''}`).sort();
    expect(listed).toEqual(MAC_ONLY);
  });
});
