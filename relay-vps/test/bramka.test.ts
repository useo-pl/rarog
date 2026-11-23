/**
 * Bramka repo zna katalog relaya iroh na VPS (`relay-vps/README.md`, „How it is checked”): `scripts/check.sh`
 * puszcza `bash -n` i ShellCheck na `relay-vps/*.sh` i składnię TOML na `relay-vps/*.toml`
 * (`scripts/lib/toml-check.py`), a CI robi to samo osobnymi krokami.
 *
 * Prawdziwy `check.sh` biegnie w atrapie repo: `pnpm` to zaślepka, plik prywatnych literałów, Xcode, `relay/` i `.git`
 * są nieobecne (te kroki mówią „skipped”), a `python3` i `shellcheck` to prawdziwe narzędzia z PATH procesu
 * testów, podane atrapie jako dowiązania. Bez nich test kroku pomija się z powodem w tytule. Celowo zepsuta
 * fikstura z `test/fixtures/` skopiowana do `relay-vps/` atrapy przewraca swój krok; te same fikstury
 * w podkatalogu, jak w prawdziwym repo, bramki nie przewracają.
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const TOML_CHECK = path.join(REPO, 'scripts', 'lib', 'toml-check.py');

/** Python z `tomllib` (3.11+): ścieżka interpretera albo `null`. */
const PYTHON = ((): string | null => {
  const res = spawnSync('python3', ['-I', '-c', 'import sys, tomllib; print(sys.executable)'], { encoding: 'utf8' });
  return res.status === 0 && res.stdout.trim() !== '' ? res.stdout.trim() : null;
})();

/** Plik wykonywalny z PATH procesu testów albo `null`. */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const file = path.join(dir, name);
    if (spawnSync(file, ['--version']).status === 0) return file;
  }
  return null;
}
const SHELLCHECK = onPath('shellcheck');

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Atrapa {
  /** Korzeń atrapy repo. */
  readonly root: string;
  /** `bash scripts/check.sh` w atrapie, PATH = sam katalog atrap. */
  readonly run: () => SpawnSyncReturns<string>;
}

/** Atrapa repo z prawdziwym `check.sh` i loaderem literałów; `relay-vps/` dokłada test. */
function atrapa(): Atrapa {
  const base = mkdtempSync(path.join(tmpdir(), 'rarog-relay-vps-'));
  made.push(base);
  const root = path.join(base, 'repo');
  const bin = path.join(base, 'bin');
  const home = path.join(base, 'home');
  for (const dir of [path.join(root, 'scripts', 'lib'), bin, home]) mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(REPO, 'scripts', 'check.sh'), path.join(root, 'scripts', 'check.sh'));
  for (const name of ['private-literals.mjs', 'is-main.mjs', 'toml-check.py']) {
    copyFileSync(path.join(REPO, 'scripts', 'lib', name), path.join(root, 'scripts', 'lib', name));
  }
  writeFileSync(path.join(root, 'scripts', 'l10n-check.mjs'), '');
  // Ze shebangiem: prawdziwy ShellCheck lintuje cały `scripts/*.sh` atrapy.
  writeFileSync(path.join(root, 'scripts', 'xcode-toolchain.sh'),
    '#!/usr/bin/env bash\nrarog_xcode_developer_dir() { return 1; }\n');
  symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const name of ['dirname', 'bash']) {
    const file = ['/usr/bin', '/bin'].map((dir) => path.join(dir, name)).find((one) => existsSync(one)) ?? `/bin/${name}`;
    symlinkSync(file, path.join(bin, name));
  }
  writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (PYTHON !== null) symlinkSync(PYTHON, path.join(bin, 'python3'));
  if (SHELLCHECK !== null) symlinkSync(SHELLCHECK, path.join(bin, 'shellcheck'));
  return {
    root,
    run: () => spawnSync('/bin/bash', [path.join(root, 'scripts', 'check.sh')], {
      encoding: 'utf8', env: { PATH: bin, HOME: home },
    }),
  };
}

/** Atrapa z fiksturami skopiowanymi do samego `relay-vps/` (tam, gdzie patrzy glob bramki). */
function atrapaZ(...fixtures: string[]): Atrapa {
  const repo = atrapa();
  mkdirSync(path.join(repo.root, 'relay-vps'), { recursive: true });
  for (const name of fixtures) copyFileSync(path.join(FIXTURES, name), path.join(repo.root, 'relay-vps', name));
  return repo;
}

/** Ostatni nagłówek kroku (`== …`) na stdout: krok, na którym bramka stanęła. */
function lastStep(res: SpawnSyncReturns<string>): string | undefined {
  return res.stdout.split('\n').filter((line) => line.startsWith('== ')).at(-1);
}

const lastLine = (res: SpawnSyncReturns<string>): string | undefined => res.stdout.trimEnd().split('\n').at(-1);

describe('scripts/check.sh: pliki relay-vps/ (atrapa repo)', () => {
  it('bez katalogu `relay-vps/` i z pustym: kroki skryptów i TOML przechodzą (glob bez trafień nic nie psuje)', () => {
    const bez = atrapa();
    const pusty = atrapa();
    mkdirSync(path.join(pusty.root, 'relay-vps', 'test'), { recursive: true });
    for (const repo of [bez, pusty]) {
      const res = repo.run();
      expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('== bash -n scripts/*.sh scripts/lib/*.sh relay-vps/*.sh\n');
      expect(lastLine(res)).toMatch(/^check: green/);
    }
  });

  it('zła składnia `relay-vps/*.sh` przewraca krok `bash -n`', () => {
    const res = atrapaZ('zepsuta-skladnia.sh').run();
    expect(res.status).not.toBe(0);
    expect(lastStep(res)).toBe('== bash -n scripts/*.sh scripts/lib/*.sh relay-vps/*.sh');
    expect(res.stderr).toContain('relay-vps/zepsuta-skladnia.sh');
    expect(res.stdout).not.toContain('check: green');
  });

  it.skipIf(SHELLCHECK === null)('ostrzeżenie ShellCheck w `relay-vps/*.sh` przewraca krok ShellCheck (requires shellcheck)', () => {
    const res = atrapaZ('ostrzezenie-shellcheck.sh').run();
    expect(res.status).not.toBe(0);
    expect(lastStep(res)).toBe('== shellcheck scripts/*.sh scripts/lib/*.sh relay-vps/*.sh');
    expect(res.stdout).toContain('relay-vps/ostrzezenie-shellcheck.sh');
    expect(res.stdout).toContain('SC2086');
  });

  it.skipIf(PYTHON === null)('zły TOML w `relay-vps/*.toml` przewraca krok TOML (requires python3 with tomllib)', () => {
    const res = atrapaZ('zepsuty.toml').run();
    expect(res.status).toBe(1);
    expect(lastStep(res)).toBe('== toml relay-vps/*.toml');
    expect(res.stderr).toMatch(/^toml: relay-vps\/zepsuty\.toml: .*line 2/m);
  });

  it.skipIf(PYTHON === null)('poprawne `.sh` i `.toml` w `relay-vps/` przechodzą, a krok TOML je liczy (requires python3 with tomllib)', () => {
    const repo = atrapa();
    mkdirSync(path.join(repo.root, 'relay-vps'));
    writeFileSync(path.join(repo.root, 'relay-vps', 'dobry.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "${1:-}"\n');
    writeFileSync(path.join(repo.root, 'relay-vps', 'dobry.toml'), 'nazwa = "relay.example.net"\n\n[sekcja]\nliczba = 1\n');
    const res = repo.run();
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    expect(res.stdout).toContain('toml: files checked: 1, with errors: 0');
  });

  it('fikstury w `relay-vps/test/fixtures/`, jak w repo, są poza globem bramki', () => {
    const repo = atrapa();
    cpSync(FIXTURES, path.join(repo.root, 'relay-vps', 'test', 'fixtures'), { recursive: true });
    const res = repo.run();
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    expect(lastLine(res)).toMatch(/^check: green/);
  });
});

describe.skipIf(PYTHON === null)('scripts/lib/toml-check.py (requires python3 with tomllib)', () => {
  const tomlCheck = (args: readonly string[], code = ''): SpawnSyncReturns<string> => spawnSync(
    PYTHON ?? 'python3', code === '' ? ['-I', TOML_CHECK, ...args] : ['-I', '-c', code], { encoding: 'utf8' },
  );

  it('bez plików kod 0; zły plik albo brak pliku kod 1, po linii na stderr; reszta listy dalej sprawdzona', () => {
    expect(tomlCheck([]).status).toBe(0);
    const missing = path.join(FIXTURES, 'nie-ma.toml');
    const res = tomlCheck([path.join(FIXTURES, 'zepsuty.toml'), missing]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`toml: ${path.join(FIXTURES, 'zepsuty.toml')}: `);
    expect(res.stderr).toContain(`toml: ${missing}: `);
    expect(res.stdout).toContain('toml: files checked: 2, with errors: 2');
  });

  it('Python bez `tomllib`: kod 2 z komunikatem, bez śladu stosu', () => {
    const code = `import runpy, sys; sys.modules['tomllib'] = None; sys.argv = ['toml-check.py']; `
      + `runpy.run_path(${JSON.stringify(TOML_CHECK)}, run_name='__main__')`;
    const res = tomlCheck([], code);
    expect(res.status).toBe(2);
    expect(res.stderr.trim()).toBe('toml: no tomllib module (needs Python 3.11+)');
  });
});

describe('CI (`.github/workflows/check.yml`) sprawdza `relay-vps/` tak samo jak `check.sh`', () => {
  const workflow = readFileSync(path.join(REPO, '.github', 'workflows', 'check.yml'), 'utf8');

  it('ShellCheck na `scripts/*.sh` i `relay-vps/*.sh`, TOML na `relay-vps/*.toml`, oba z `nullglob`', () => {
    expect(workflow).toMatch(/run: \|\n {10}shopt -s nullglob\n {10}shellcheck scripts\/\*\.sh relay-vps\/\*\.sh\n/);
    expect(workflow).toMatch(/run: \|\n {10}shopt -s nullglob\n {10}python3 -I scripts\/lib\/toml-check\.py relay-vps\/\*\.toml\n/);
  });
});
