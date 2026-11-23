/**
 * Szkielet CLI `rarog`: `bin/rarog.mjs` sprawdza Node i rejestruje tsx,
 * `server/src/cli/main.ts` rozdziela komendy. Komendy mają własne pliki testów (`rarog-pair-devices.test.ts` dla
 * `pair`/`devices`, `hook-config.test.ts` dla `hooks`).
 *
 * Sprawdza: kody wyjścia i użycie `main`; Node starszy niż 22.15 = jedno zdanie bez stosu; start z obcego katalogu
 * roboczego; granicę zależności (moduły serwera poza `server/src/cli/` nie importują CLI, więc kod CLI nie trafia do
 * procesu serwera); jedno źródło linku parowania (`rarog pair` woła `pairingLink` serwera). Każdy proces potomny ma
 * `HOME` i `XDG_DATA_HOME` w katalogu tymczasowym, a `afterAll` sprawdza, że prawdziwe katalogi `rarog` właściciela
 * nie powstały.
 */
import { spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer } from 'node:net';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hookCopyOriginLine } from '../src/cli/doctor.ts';
import { USAGE, main } from '../src/cli/main.ts';
import type { HookCopyFile, HookCopyReport } from '../src/herdr/hook-config.ts';
import type { CliIo } from '../src/cli/io.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';

const REPO = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'rarog.mjs');
// Short prefixes: a socket under them has to fit in 103 B together with the vitest run directory.
const HOME = tempHome('rcs-');
/** Katalogi tymczasowe założone przez ten plik (dom testu i katalogi pod nim): po `afterAll` żaden nie istnieje. */
const tempDirs: string[] = [HOME.home];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(HOME.home, prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  HOME.cleanup();
  expect(tempDirs.filter((dir) => existsSync(dir))).toEqual([]);
  expect(realRarogDirsCreated()).toEqual([]);
});

/** `main` z wyjściem w pamięci; `env` domyślnie z katalogiem domowym testu. */
async function call(
  argv: readonly string[], env: NodeJS.ProcessEnv = HOME.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, env, cwd: HOME.home,
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

describe('rarog: wejście i kody wyjścia', () => {
  it('`help`, `--help`, `-h` → użycie na stdout, 0; bez komendy → użycie na stderr, 64', async () => {
    for (const argv of [['help'], ['--help'], ['-h']]) {
      expect(await call(argv), argv.join(' ')).toEqual({ code: 0, stdout: `${USAGE}\n`, stderr: '' });
    }
    expect(await call([])).toEqual({ code: 64, stdout: '', stderr: `${USAGE}\n` });
  });

  it('nieznana komenda (także nazwa z prototypu obiektu) → 64 z nazwą, przed liczeniem katalogu danych', async () => {
    for (const name of ['nieznana', 'constructor', 'toString']) {
      const result = await call([name]);
      expect(result.code, name).toBe(64);
      expect(result.stderr, name).toContain(`Unknown command: ${name}`);
    }
  });

  it('złe wywołanie komendy (`Usage`) → jedno zdanie i odsyłacz do --help, bez użycia wszystkich komend, 64', async () => {
    const result = await call(['devices', 'revoke', '--data-dir', HOME.home]);
    expect(result.code).toBe(64);
    expect(result.stderr).toBe('Give a device id or --all.\nRun rarog devices --help.\n');
    expect((await call(['pair', '--bez-sensu'])).code).toBe(64);
  });

  it('`rarog setup --bogus` → at most 2 lines, each within 60 columns, the setup help named, code 64', async () => {
    const result = await call(['setup', '--bogus']);
    expect(result.code).toBe(64);
    expect(result.stdout).toBe('');
    const lines = result.stderr.trimEnd().split('\n');
    expect(lines.length, result.stderr).toBeLessThanOrEqual(2);
    for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(60);
    expect(lines).toEqual(['rarog setup: unknown argument "--bogus".', 'Run rarog setup --help.']);
    expect(result.stderr).not.toContain('Usage:');
  });

  it('a long bad-argument sentence wraps at 60 columns; the help line stays whole', async () => {
    const result = await call(['serve', '--print-env', '--env', `RAROG_NOT_A_VARIABLE_${'X'.repeat(10)}=1`]);
    expect(result.code).toBe(64);
    const lines = result.stderr.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(60);
    expect(lines.at(-1)).toBe('Run rarog serve --help.');
  });

  it('`hooks --help` → użycie komendy, 0, nic nie drukuje bloku', async () => {
    const result = await call(['hooks', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('rarog hooks [print|install|doctor] [--local]');
    expect(result.stdout).not.toContain('Wklej ten blok');
  });

  it('--help of every command on a 60-column terminal fits the width; the words stay as in the usage', async () => {
    const commands = [[], ['setup'], ['update'], ['service'], ['hooks'], ['serve'], ['restart'], ['doctor'],
      ['devices'], ['dialogs'], ['dictation'], ['voice-agent']];
    for (const command of commands) {
      let stdout = '';
      const io: CliIo = {
        stdout: (text) => { stdout += text; }, stderr: () => {}, env: HOME.env, cwd: HOME.home,
        terminal: { tty: true, columns: 60, color: false },
      };
      expect(await main([...command, '--help'], io), command.join(' ')).toBe(0);
      for (const line of stdout.trimEnd().split('\n')) {
        expect([...line].length, `${command.join(' ')}: ${line}`).toBeLessThanOrEqual(60);
      }
      const words = (text: string): string => text.replace(/\s+/gu, ' ').trim();
      const plain = await call([...command, '--help']);
      // Only the line breaks change (a path may break after its `/`).
      expect(words(stdout).replace(/\/ /gu, '/'), command.join(' ')).toBe(words(plain.stdout).replace(/\/ /gu, '/'));
    }
  });
});

describe('rarog: wszystko liczone od `HOME` z `CliIo`, nie od procesu', () => {
  /** Osobny dom bez `XDG_DATA_HOME`: katalog danych też ma wyjść spod niego. */
  const home = (): string => tempDir('dom-');

  it('`hooks print` i `hooks doctor` wskazują kopię i ustawienia pod tym domem', async () => {
    const dom = home();
    const print = await call(['hooks', 'print'], { PATH: HOME.env['PATH'], HOME: dom });
    expect(print.code).toBe(0);
    expect(print.stdout).toContain(`${dom}/.claude/hooks/rarog/rarog-pending.mjs`);
    const doctor = await call(['hooks', 'doctor'], { PATH: HOME.env['PATH'], HOME: dom });
    expect(doctor.stdout).toContain(`copy:    ${dom}/.claude/hooks/rarog`);
    expect(doctor.stdout).toContain(`${dom}/.claude/settings.json`);
    expect(doctor.stdout).toContain(`dataDir: ${dom}/.local/share/rarog`);
  });

  it('`hooks install` celuje w kopię pod tym domem (odmowa przy dowiązaniu, nic nie zapisane)', async () => {
    const dom = home();
    const target = path.join(dom, 'cel');
    mkdirSync(target);
    mkdirSync(path.join(dom, '.claude', 'hooks'), { recursive: true });
    symlinkSync(target, path.join(dom, '.claude', 'hooks', 'rarog'));
    const result = await call(['hooks', 'install'], { PATH: HOME.env['PATH'], HOME: dom });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is a symlink');
    expect(readdirSync(target)).toEqual([]);
  });

  it('`devices` szuka gniazda w katalogu danych pod tym domem', async () => {
    const dom = home();
    const result = await call(['devices'], { PATH: HOME.env['PATH'], HOME: dom });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`${dom}/.local/share/rarog/run/admin.sock`);
  });

  it('`dialogs off` i `dialogs release` też: gniazdo administracyjne pod tym domem, bez serwera kod 2', async () => {
    const dom = home();
    for (const argv of [['dialogs', 'off'], ['dialogs', 'release', 'sesja-1']]) {
      const result = await call(argv, { PATH: HOME.env['PATH'], HOME: dom });
      expect(result.code, argv.join(' ')).toBe(2);
      expect(result.stderr, argv.join(' ')).toContain(`${dom}/.local/share/rarog/run/admin.sock`);
    }
  });
});

describe('rarog dialogs: wywołanie', () => {
  it('`dialogs --help` → użycie obu podkomend, 0; użycie stoi w pełnym `USAGE`', async () => {
    const result = await call(['dialogs', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('rarog dialogs off [--data-dir <dir>]');
    expect(result.stdout).toContain('rarog dialogs release <sessionId> [--key <key>] [--data-dir <dir>]');
    expect(USAGE).toContain('rarog dialogs off');
  });

  it('bez podkomendy, nieznana podkomenda, `release` bez sesji, `off` z kluczem albo obca opcja → 64', async () => {
    for (const argv of [['dialogs'], ['dialogs', 'on'], ['dialogs', 'release'], ['dialogs', 'off', '--key', 'k'],
      ['dialogs', 'off', 'teraz'], ['dialogs', 'off', '--force'], ['dialogs', 'release', 'a', 'b']]) {
      expect((await call(argv)).code, argv.join(' ')).toBe(64);
    }
  });

  it('odpowiedź gniazda urwana po nagłówkach, przed końcem ciała → komunikat i kod 2, bez wiszącej obietnicy',
    async () => {
      const dataDir = tempDir('u-');
      mkdirSync(path.join(dataDir, 'run'), { recursive: true, mode: 0o700 });
      // Nagłówki obiecują 100 B, przychodzą 2 B i koniec połączenia (Node: `aborted` i `close`, bez `end`).
      const raw: NetServer = createNetServer((conn) => {
        conn.on('error', () => {});
        conn.once('data', () => {
          conn.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{}');
          setTimeout(() => { conn.destroy(); }, 50);
        });
      });
      await new Promise<void>((resolve, reject) => {
        raw.once('error', reject);
        raw.listen(path.join(dataDir, 'run', 'admin.sock'), resolve);
      });
      try {
        for (const argv of [['dialogs', 'off'], ['dialogs', 'release', 'sesja-1']]) {
          const result = await call([...argv, '--data-dir', dataDir]);
          expect(result.code, argv.join(' ')).toBe(2);
          expect(result.stderr, argv.join(' ')).toContain('ECONNRESET');
        }
      } finally {
        await new Promise<void>((resolve) => { raw.close(() => { resolve(); }); });
      }
    }, 15_000);
});

describe('bin/rarog.mjs', () => {
  /**
   * `rarog help` w procesie, który widzi wersję Node `version` (podmiana `process.versions.node` przed wejściem).
   * tsx wybiera API rejestracji po tej wersji, więc starsza wersja na nowszym węźle daje ostrzeżenie Node
   * o przestarzałym `module.register()`, nie zdanie `rarog`: `--no-deprecation` je wycisza.
   */
  function helpOn(version: string): SpawnSyncReturns<string> {
    const preload = path.join(HOME.home, `node-${version}.mjs`);
    writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: '${version}' });\n`);
    return spawnSync(process.execPath, ['--no-deprecation', '--import', preload, CLI, 'help'], {
      env: HOME.env, encoding: 'utf8',
    });
  }

  it('Node starszy niż 22.15 albo linia 23 przed 23.11 → jedno zdanie bez stosu, kod 1, przed tsx', () => {
    for (const version of ['20.18.0', '22.14.0', '21.7.3', '23.10.0']) {
      const run = helpOn(version);
      expect(run.status, version).toBe(1);
      expect(run.stdout, version).toBe('');
      expect(run.stderr.trim().split('\n'), version).toHaveLength(1);
      expect(run.stderr).toContain('rarog: requires Node 22.15 or newer (on the 23 line: 23.11 or newer), and this'
        + ` process is v${version}`);
      expect(run.stderr).not.toMatch(/\n\s+at /);
    }
  });

  it('Node 22.15 i nowsze linie LTS (24, 26) → komenda bez słowa o wersji; linia nieparzysta → jedno ostrzeżenie', () => {
    for (const version of ['22.15.0', '24.11.1', '26.10.0']) {
      const run = helpOn(version);
      expect(run.stderr, version).toBe('');
      expect(run.status, version).toBe(0);
      expect(run.stdout, version).toBe(`${USAGE}\n`);
    }
    for (const version of ['23.11.0', '25.9.0']) {
      const run = helpOn(version);
      expect(run.status, version).toBe(0);
      expect(run.stdout, version).toBe(`${USAGE}\n`);
      expect(run.stderr.trim().split('\n'), version).toEqual([
        `rarog: warning: Node v${version} is an odd-numbered line without long-term support; rarog is tested`
          + ' on even-numbered LTS lines.',
      ]);
    }
  });

  it('działa z obcego katalogu roboczego (tsconfig i moduły liczone od pliku, nie od `cwd`)', () => {
    const run = spawnSync(process.execPath, [CLI, 'help'], { cwd: HOME.home, env: HOME.env, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${USAGE}\n`);
  });

  it('`package.json`: nazwa `rarog`, `bin` i skrypt wskazują `bin/rarog.mjs`', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
      name: string; bin: Record<string, string>; scripts: Record<string, string>;
    };
    expect(pkg.name).toBe('rarog');
    expect(pkg.bin).toEqual({ rarog: 'bin/rarog.mjs' });
    expect(pkg.scripts['rarog']).toBe('node bin/rarog.mjs');
  });
});

/** Pliki `.ts` pod katalogiem (ścieżki względem repo). */
function tsFiles(rel: string): string[] {
  return readdirSync(path.join(REPO, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) return tsFiles(child);
    return entry.name.endsWith('.ts') ? [child] : [];
  });
}

/** Specyfikatory importów (statycznych, `export … from`, `import()` z literałem) w źródle. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

describe('granica: serwer nie zależy od CLI', () => {
  const CLI_DIR = path.join(REPO, 'server', 'src', 'cli');

  it('żaden moduł `server/src` spoza `server/src/cli/` nie importuje niczego z `server/src/cli/`', () => {
    const offenders: string[] = [];
    for (const file of tsFiles('server/src')) {
      if (file.startsWith('server/src/cli/')) continue;
      for (const spec of importSpecifiers(readFileSync(path.join(REPO, file), 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const target = path.resolve(path.dirname(path.join(REPO, file)), spec);
        if (target === CLI_DIR || target.startsWith(`${CLI_DIR}${path.sep}`)) offenders.push(`${file} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('skaner widzi import CLI (negatyw na sztucznym źródle)', () => {
    expect(importSpecifiers("import { main } from '../cli/main.ts';\nconst x = await import('./cli/io.ts');"))
      .toEqual(['../cli/main.ts', './cli/io.ts']);
  });

  it('`rarog pair` składa link funkcją serwera `pairingLink`, bez własnej kopii schematu', () => {
    const source = readFileSync(path.join(CLI_DIR, 'devices.ts'), 'utf8');
    expect(source).toMatch(/import \{[^}]*\bpairingLink\b[^}]*\} from '\.\.\/auth\/admin\.ts';/);
    expect(source).not.toContain('://pair');
  });
});

describe('rarog doctor: pochodzenie kopii hooka (krok 6 rollbacku kanału zgód)', () => {
  const sha = (c: string): string => c.repeat(64);
  const file = (name: string, copySha: string | null, manifestSha: string | null): HookCopyFile => ({
    name, state: copySha === null ? 'missing' : 'match', copySha, repoSha: copySha, manifestSha,
  } as HookCopyFile);
  const report = (over: Partial<HookCopyReport>): HookCopyReport => ({
    dir: '/h/.claude/hooks/rarog', dirKind: 'dir', leftovers: [], ok: true,
    files: [file('rarog-pending.mjs', sha('a'), sha('a')), file('consent.mjs', sha('b'), sha('b'))],
    manifest: { commit: 'c'.repeat(40), version: null, at: Date.UTC(2026, 10, 8), files: {} },
    ...over,
  });

  it('kopia równa manifestowi: commit klonu albo wersja paczki z chwilą instalacji', () => {
    expect(hookCopyOriginLine(report({})))
      .toBe(`installed copy from commit ${'c'.repeat(40)}, installed 2026-11-08T00:00:00.000Z`);
    expect(hookCopyOriginLine(report({ manifest: { commit: null, version: '1.2.0', at: 0, files: {} } })))
      .toBe('installed copy from version 1.2.0, installed 1970-01-01T00:00:00.000Z');
  });

  it('bez zgadywania: plik zmieniony po instalacji, brak pliku, brak manifestu, brak katalogu = powód', () => {
    expect(hookCopyOriginLine(report({
      files: [file('rarog-pending.mjs', sha('a'), sha('a')), file('consent.mjs', sha('d'), sha('b'))],
    }))).toBe('installed copy: origin unknown (changed after installation or missing: consent.mjs)');
    expect(hookCopyOriginLine(report({ files: [file('consent.mjs', null, sha('b'))] })))
      .toBe('installed copy: origin unknown (changed after installation or missing: consent.mjs)');
    expect(hookCopyOriginLine(report({ manifest: null })))
      .toBe('installed copy: origin unknown (manifest.json missing or unreadable)');
    for (const dirKind of ['missing', 'symlink', 'other'] as const) {
      expect(hookCopyOriginLine(report({ dirKind }))).toBe('installed copy: origin unknown (no copy directory)');
    }
  });
});
