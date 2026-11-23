/**
 * Reguła katalogu danych:
 * jedna definicja w `shared/src/data-dir.mjs`, ta sama reguła przepisana inline w hooku
 * `scripts/hooks/rarog-pending.mjs`.
 *
 * - macierz stanów modułu: flaga, `RAROG_DATA_DIR`, `XDG_DATA_HOME` i `rarog` we wszystkich kształtach (brak,
 *   katalog, pusty katalog, plik, dowiązanie do katalogu, do pliku, bez celu, pętla, nieczytelna baza), każdy stan
 *   raz z bazą z `HOME`, raz z `XDG_DATA_HOME`;
 * - parytet hook ↔ moduł na tej samej macierzy: hook w podprocesie pisze `pending/` dokładnie w katalogu z modułu
 *   i nigdzie indziej, a przy konflikcie nie pisze nic;
 * - serwer: `loadConfig` przy konflikcie rzuca `ConfigError` ze ścieżką i komendą naprawy, a start
 *   `server/src/index.ts` kończy się kodem 1 bez zapisu czegokolwiek; demo i jawne `RAROG_DATA_DIR` reguły nie pytają;
 * - wołający (CLI `rarog devices` i `rarog hooks doctor`, podkładka `hooks:doctor`) przy
 *   konflikcie odmawiają;
 * - strażnik: poza modułem i hookiem nikt w `server/src`, `shared/src`, `scripts/`, `bin/`, `relay/scripts/` nie
 *   składa `.local/share` ani nie czyta `XDG_DATA_HOME`.
 *
 * Każdy test ma `HOME` (i `XDG_DATA_HOME`, gdy go używa) w katalogu tymczasowym; `afterAll` sprawdza, że realny
 * `~/.local/share/rarog` nie powstał.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { dataDirConflictMessage, resolveDataDir } from '@rarog/shared/data-dir';
import type { DataDirConflictReason, DataDirResult } from '@rarog/shared/data-dir';
import { ConfigError, loadConfig } from '../src/config.ts';
import { inExportView } from './private-guard.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(REPO, 'scripts', 'hooks', 'rarog-pending.mjs');
/** Znacznik per plik wejściowy obok wspólnego `hook-seen.json`. */
const SEEN_PER_FILE = `hook-seen.${path.basename(HOOK, '.mjs')}.json`;
const CLI = path.join(REPO, 'bin', 'rarog.mjs');
const SESSION = '550e8400-e29b-41d4-a716-446655440000';

/** Realny katalog nowej instalacji — po `userInfo`, nie po `HOME`, bo testy podmieniają `HOME` podprocesom. */
const REAL_RAROG = path.join(os.userInfo().homedir, '.local', 'share', 'rarog');
const realRarogBefore = exists(REAL_RAROG);

function exists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** `tsx` z najbliższego `node_modules` w górę drzewa — worktree bywa bez własnego. */
function findTsx(): string {
  let dir = REPO;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('brak node_modules/.bin/tsx');
}

const temporary: string[] = [];
function tempRoot(): string {
  const made = mkdtempSync(path.join(os.tmpdir(), 'rarog-katalog-danych-'));
  temporary.push(made);
  return made;
}

afterAll(() => {
  for (const dir of temporary) {
    // Stan „nieczytelny" zostawia katalog z prawami 000 — bez tego `rm` nie wejdzie do środka.
    const walk = (current: string): void => {
      try {
        if (lstatSync(current).isDirectory()) {
          chmodSync(current, 0o700);
          for (const entry of readdirSync(current)) walk(path.join(current, entry));
        }
      } catch {
        // Sprzątanie best-effort.
      }
    };
    walk(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  if (!realRarogBefore) {
    expect(exists(REAL_RAROG), `test założył realny ${REAL_RAROG}`).toBe(false);
  }
});

/** Wszystkie wpisy pod `root` (bez wchodzenia w dowiązania): `/` katalog, `@` dowiązanie. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      out.push(`${path.relative(root, dir)}/<nieczytelny>`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const suffix = entry.isSymbolicLink() ? '@' : entry.isDirectory() ? '/' : '';
      out.push(`${path.relative(root, full)}${suffix}`);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}

type Expected = { readonly dir: 'rarog' } | { readonly conflict: DataDirConflictReason };

interface State {
  readonly name: string;
  /** Buduje stan w `base` (`<baza>` reguły); `elsewhere` to katalog spoza bazy na cel dowiązania. */
  readonly build: (base: string, elsewhere: string) => void;
  readonly expected: Expected;
}

const withFile = (dir: string, file = 'devices.json'): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), '{}\n');
};

const STATES: readonly State[] = [
  { name: 'żaden (bez bazy)', build: () => undefined, expected: { dir: 'rarog' } },
  { name: 'pusty rarog', build: (b) => { mkdirSync(path.join(b, 'rarog'), { recursive: true }); }, expected: { dir: 'rarog' } },
  { name: 'tylko rarog', build: (b) => { withFile(path.join(b, 'rarog')); }, expected: { dir: 'rarog' } },
  {
    name: 'rarog plikiem',
    build: (b) => { mkdirSync(b, { recursive: true }); writeFileSync(path.join(b, 'rarog'), 'x'); },
    expected: { conflict: 'default-not-dir' },
  },
  {
    name: 'rarog dowiązaniem do katalogu',
    build: (b, e) => { withFile(e); mkdirSync(b, { recursive: true }); symlinkSync(e, path.join(b, 'rarog')); },
    expected: { dir: 'rarog' },
  },
  {
    name: 'rarog dowiązaniem do pliku',
    build: (b, e) => {
      mkdirSync(e, { recursive: true });
      writeFileSync(path.join(e, 'plik'), 'x');
      mkdirSync(b, { recursive: true });
      symlinkSync(path.join(e, 'plik'), path.join(b, 'rarog'));
    },
    expected: { conflict: 'default-not-dir' },
  },
  {
    name: 'rarog dowiązaniem bez celu',
    build: (b, e) => { mkdirSync(b, { recursive: true }); symlinkSync(path.join(e, 'brak'), path.join(b, 'rarog')); },
    expected: { conflict: 'default-not-dir' },
  },
  {
    name: 'pętla dowiązań rarog ↔ inne',
    build: (b) => {
      mkdirSync(b, { recursive: true });
      symlinkSync('inne', path.join(b, 'rarog'));
      symlinkSync('rarog', path.join(b, 'inne'));
    },
    expected: { conflict: 'unreadable' },
  },
  ...(process.getuid?.() === 0 ? [] : [{
    // Root czyta katalog 000 mimo praw — wtedy stanu „nieczytelny" nie da się zbudować.
    name: 'baza nieczytelna',
    build: (b: string) => { withFile(path.join(b, 'rarog')); chmodSync(b, 0o000); },
    expected: { conflict: 'unreadable' } as const,
  }]),
];

/** Dwa sposoby na bazę: `HOME/.local/share` albo `XDG_DATA_HOME` (wtedy `HOME` jest pusty). */
const BASES = ['HOME', 'XDG_DATA_HOME'] as const;

interface Scene {
  readonly root: string;
  readonly home: string;
  readonly base: string;
  readonly env: Record<string, string>;
}

function scene(state: State, mode: (typeof BASES)[number]): Scene {
  const root = tempRoot();
  const home = path.join(root, 'home');
  mkdirSync(home);
  const base = mode === 'HOME' ? path.join(home, '.local', 'share') : path.join(root, 'xdg');
  state.build(base, path.join(root, 'inne-dane'));
  return { root, home, base, env: mode === 'HOME' ? {} : { XDG_DATA_HOME: base } };
}

function expectResult(result: DataDirResult, base: string, expected: Expected): void {
  if ('dir' in expected) {
    expect(result).toMatchObject({ ok: true, dir: path.join(base, expected.dir), source: 'default' });
  } else {
    expect(result).toMatchObject({ ok: false, reason: expected.conflict, defaultDir: path.join(base, 'rarog') });
  }
}

describe('resolveDataDir: macierz stanów', () => {
  for (const mode of BASES) {
    for (const state of STATES) {
      it(`${state.name} (baza z ${mode})`, () => {
        const s = scene(state, mode);
        const before = snapshot(s.root);
        expectResult(resolveDataDir({ env: s.env, home: s.home }), s.base, state.expected);
        expect(snapshot(s.root), 'reguła tylko czyta').toEqual(before);
      });
    }
  }

  it('flaga wygrywa z `RAROG_DATA_DIR`, a obie z konfliktem; puste wartości = brak', () => {
    const s = scene(CONFLICT, 'HOME');
    expect(resolveDataDir({ flag: '/f', env: { RAROG_DATA_DIR: '/e' }, home: s.home }))
      .toEqual({ ok: true, dir: '/f', source: 'flag' });
    expect(resolveDataDir({ env: { RAROG_DATA_DIR: '/e' }, home: s.home }))
      .toEqual({ ok: true, dir: '/e', source: 'env' });
    expect(resolveDataDir({ flag: '', env: { RAROG_DATA_DIR: '' }, home: s.home })).toMatchObject({ ok: false });
    // Puste `XDG_DATA_HOME` (tak przychodzi z jawnego środowiska `env -i`) = baza z `HOME`.
    const t = scene(STATES.find((x) => x.name === 'tylko rarog')!, 'HOME');
    expect(resolveDataDir({ env: { XDG_DATA_HOME: '' }, home: t.home }))
      .toMatchObject({ ok: true, dir: path.join(t.base, 'rarog') });
  });

  it('konflikt: szczegół to rodzaj wpisu, komunikat ma ścieżkę i komendę naprawy', () => {
    const s = scene(CONFLICT, 'HOME');
    const result = resolveDataDir({ env: {}, home: s.home });
    expect(result).toMatchObject({ ok: false, detail: 'file' });
    if (result.ok) throw new Error('oczekiwany konflikt');
    const message = dataDirConflictMessage(result);
    expect(message).toContain(path.join(s.base, 'rarog'));
    expect(message).toContain(`mv '${path.join(s.base, 'rarog')}'`);
    expect(message).toContain('RAROG_DATA_DIR');
  });
});

const permissionRequest = (cwd: string): string => JSON.stringify({
  session_id: SESSION,
  transcript_path: `/Users/x/.claude/projects/-demo/${SESSION}.jsonl`,
  cwd,
  prompt_id: 'fb908934-26eb-4419-9e30-8adcd4ed356b',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'ls', description: 'lista' },
});

function runHook(stdin: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout }); });
    child.stdin.end(stdin);
  });
}

describe('parytet: hook w podprocesie liczy ten sam katalog co moduł', () => {
  for (const mode of BASES) {
    for (const state of STATES) {
      it(`${state.name} (baza z ${mode})`, async () => {
        const s = scene(state, mode);
        const project = path.join(s.root, 'projekty', 'demo');
        mkdirSync(project, { recursive: true });
        const roots = `${JSON.stringify({ roots: [path.join(s.root, 'projekty')] })}\n`;
        const first = resolveDataDir({ env: s.env, home: s.home });
        if (first.ok) {
          mkdirSync(first.dir, { recursive: true });
          writeFileSync(path.join(first.dir, 'roots.json'), roots);
        }
        // Podłożenie `roots.json` nie zmienia wyniku reguły (inaczej parytet sprawdzałby inny stan).
        const result = resolveDataDir({ env: s.env, home: s.home });
        expect(result).toEqual(first);
        expectResult(result, s.base, state.expected);

        const before = snapshot(s.root);
        const hook = await runHook(permissionRequest(project), { HOME: s.home, ...s.env });
        expect(hook).toEqual({ code: 0, stdout: '' });
        const added = snapshot(s.root).filter((entry) => !before.includes(entry));
        if (result.ok) {
          const pending = path.join(result.dir, 'pending', `${SESSION}.json`);
          expect(JSON.parse(readFileSync(pending, 'utf8'))).toMatchObject({ sessionId: SESSION, toolName: 'Bash' });
          // Nowe wpisy wyłącznie w katalogu z modułu: `pending/`, zrzut, znaczniki `hook-seen.json` i per plik
          // wejściowy oraz dziennik cyklu `shadow.jsonl` (przez dowiązanie `rarog` lądują w jego celu — porównanie
          // po ścieżkach rzeczywistych). Zrzut per wywołanie `pending/<sesja>/` hook sprząta przy wyjściu.
          const dirRel = path.relative(realpathSync(s.root), realpathSync(result.dir));
          expect(added.sort()).toEqual([
            `${dirRel}/hook-seen.json`, `${dirRel}/${SEEN_PER_FILE}`, `${dirRel}/pending/`,
            `${dirRel}/pending/${SESSION}.json`, `${dirRel}/shadow.jsonl`,
          ].sort());
        } else {
          expect(added, 'konflikt: hook milknie i nie pisze nigdzie').toEqual([]);
        }
      });
    }
  }

  it('jawne `RAROG_DATA_DIR` wygrywa z konfliktem w bazie: moduł, serwer, CLI i hook', async () => {
    const s = scene(CONFLICT, 'HOME');
    const explicit = path.join(s.root, 'jawny');
    const project = path.join(s.root, 'projekty', 'demo');
    mkdirSync(project, { recursive: true });
    mkdirSync(explicit);
    writeFileSync(path.join(explicit, 'roots.json'), JSON.stringify({ roots: [path.join(s.root, 'projekty')] }));
    const env = { RAROG_DATA_DIR: explicit };
    expect(resolveDataDir({ env, home: s.home })).toEqual({ ok: true, dir: explicit, source: 'env' });
    expect(loadConfig({ ...PRODUCTION_ENV, HOME: s.home, ...env }).dataDir).toBe(explicit);
    const cli = spawnSync(process.execPath, [CLI, 'hooks', 'doctor'], {
      env: { PATH: process.env['PATH'] ?? '', HOME: s.home, ...env }, encoding: 'utf8',
    });
    expect(cli.stdout).toContain(explicit);
    expect(cli.stdout).not.toContain('KONFLIKT');
    const hook = await runHook(permissionRequest(project), { HOME: s.home, ...env });
    expect(hook.code).toBe(0);
    expect(existsSync(path.join(explicit, 'pending', `${SESSION}.json`))).toBe(true);
  });
});

const CONFLICT = STATES.find((x) => x.name === 'rarog plikiem')!;
const PRODUCTION_ENV = { RAROG_ORIGINS: 'https://rarog.example' };

describe('serwer: konflikt = odmowa startu przed pierwszym zapisem', () => {
  it('`loadConfig` rzuca ConfigError ze ścieżką i komendą naprawy', () => {
    const s = scene(CONFLICT, 'HOME');
    const attempt = (): unknown => loadConfig({ ...PRODUCTION_ENV, HOME: s.home });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(path.join(s.base, 'rarog'));
    expect(attempt).toThrow(/mv '/);
  });

  it('`loadConfig` bez konfliktu bierze katalog z reguły', () => {
    const s = scene(STATES.find((x) => x.name === 'tylko rarog')!, 'HOME');
    expect(loadConfig({ ...PRODUCTION_ENV, HOME: s.home }).dataDir).toBe(path.join(s.base, 'rarog'));
    const t = scene(STATES[0]!, 'XDG_DATA_HOME');
    expect(loadConfig({ ...PRODUCTION_ENV, HOME: t.home, ...t.env }).dataDir).toBe(path.join(t.base, 'rarog'));
  });

  it('demo i jawne `RAROG_DATA_DIR` nie pytają reguły — konflikt ich nie zatrzymuje', () => {
    const s = scene(CONFLICT, 'HOME');
    expect(loadConfig({ RAROG_DEMO: '1', HOME: s.home }).dataDir).toBe(path.join(os.tmpdir(), 'rarog-demo'));
    const explicit = path.join(s.root, 'jawny');
    expect(loadConfig({ ...PRODUCTION_ENV, HOME: s.home, RAROG_DATA_DIR: explicit }).dataDir).toBe(explicit);
  });

  it('start `server/src/index.ts` przy konflikcie: kod 1, komunikat, zero zapisów', async () => {
    const s = scene(CONFLICT, 'HOME');
    const before = snapshot(s.root);
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(findTsx(), ['server/src/index.ts'], {
        cwd: REPO,
        // Port 0 i wyłączone kanały: gdyby reguła zawiodła, serwer wstałby na losowym porcie, bez paneli i pushy,
        // zamiast zderzyć się z produkcją na 8930.
        env: {
          PATH: process.env['PATH'] ?? '', HOME: s.home, TMPDIR: os.tmpdir(), ...PRODUCTION_ENV,
          RAROG_PORT: '0', RAROG_HERDR_SEND: '0', RAROG_HERDR_LAUNCH: '0', RAROG_PUSH: '0', RAROG_TERM: '0',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 30_000);
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
    });
    expect(result.stderr).toContain('Configuration error: Data directory conflict');
    expect(result.code).toBe(1);
    expect(snapshot(s.root), 'serwer zapisał coś mimo konfliktu').toEqual(before);
  }, 40_000);
});

describe('wołający reguły: konflikt = odmowa', () => {
  it('`rarog devices`: kod 1 i komunikat reguły, bez zapisu', () => {
    const s = scene(CONFLICT, 'HOME');
    const before = snapshot(s.root);
    const run = spawnSync(process.execPath, [CLI, 'devices'], {
      env: { PATH: process.env['PATH'] ?? '', HOME: s.home }, encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Data directory conflict');
    expect(snapshot(s.root)).toEqual(before);
  });

  it('`rarog hooks doctor`: kod 1 i komunikat reguły', () => {
    const s = scene(CONFLICT, 'HOME');
    const run = spawnSync(process.execPath, [CLI, 'hooks', 'doctor'], {
      env: { PATH: process.env['PATH'] ?? '', HOME: s.home }, encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('dataDir: CONFLICT');
  });

  it('`hooks:doctor`: kod 1 i komunikat reguły', () => {
    const s = scene(CONFLICT, 'HOME');
    const env = { PATH: process.env['PATH'] ?? '', HOME: s.home, TMPDIR: os.tmpdir() };
    const doctor = spawnSync(findTsx(), ['scripts/hooks-config.ts', 'doctor'], { cwd: REPO, env, encoding: 'utf8' });
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain('dataDir: CONFLICT');
  }, 30_000);
});

/**
 * Strażnik jednej definicji: poza modułem i hookiem nikt nie składa `.local/share` ani nie czyta `XDG_DATA_HOME`.
 * Wyjątek = (plik, fragment linii, powód); wyjątek, który niczego nie trafia, przewraca test.
 */
describe('strażnik: reguła katalogu danych ma jedną definicję', () => {
  const ROOTS = ['server/src', 'shared/src', 'scripts', 'bin', 'relay/scripts'];
  const PATTERN = /\.local\/share|['"]\.local['"],\s*['"]share['"]|XDG_DATA_HOME/;
  /** Pliki wyjęte w całości. */
  const WHOLE_FILES: Readonly<Record<string, string>> = {
    'shared/src/data-dir.mjs': 'moduł reguły — jedyna definicja',
    'shared/src/data-dir.d.mts': 'typy modułu reguły',
    'scripts/hooks/rarog-pending.mjs': 'hook: ta sama reguła inline, bez importu (pilnuje parytet wyżej)',
    'scripts/hooks/rarog-context.mjs': 'hook kontekstu z tej samej kopii hooka: reguła inline przepisana '
      + 'z `rarog-pending.mjs`, bez importu, bo kopia w `~/.claude/hooks/rarog/` nie widzi modułów repo',
  };
  /** Pojedyncze linie wyjęte z powodem: nie są katalogiem danych albo opisują Maca właściciela. */
  const LINES: readonly { file: string; fragment: string; why: string }[] = [
    {
      file: 'server/src/auth/admin.ts', fragment: 'CAN READ `~/.local/share/rarog`',
      why: 'komentarz: pomiar sandboksa na Macu właściciela (2026-10-19)',
    },
    {
      file: 'server/src/config-env.ts', fragment: 'XDG_DATA_HOME_ENV',
      why: 'rejestr zmiennych serwera: nazwa ze stałej modułu reguły (rodzaj `process`), bez odczytu',
    },
    {
      file: 'server/src/install/data-dir.ts', fragment: 'XDG_DATA_HOME_ENV',
      why: 'nazwy zmiennych do komunikatu rozjazdu katalogu instalacji: stała modułu reguły, katalog liczy `resolveDataDir`',
    },
  ];

  function filesUnder(rel: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') out.push(...filesUnder(child));
      } else {
        out.push(child);
      }
    }
    return out;
  }

  it('poza modułem, hookiem i wyjątkami nikt nie składa `.local/share` ani nie czyta `XDG_DATA_HOME`', () => {
    const offenders: string[] = [];
    const usedLines = new Set<string>();
    const usedFiles = new Set<string>();
    const files = ROOTS.flatMap(filesUnder).filter(inExportView);
    expect(files.length, 'strażnik nie widzi plików').toBeGreaterThan(100);
    for (const file of files) {
      const lines = readFileSync(path.join(REPO, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!PATTERN.test(line)) return;
        if (file in WHOLE_FILES) {
          usedFiles.add(file);
          return;
        }
        const exception = LINES.find((entry) => entry.file === file && line.includes(entry.fragment));
        if (exception !== undefined) {
          usedLines.add(`${exception.file}:${exception.fragment}`);
          return;
        }
        offenders.push(`${file}:${String(index + 1)}: ${line.trim()}`);
      });
    }
    expect(offenders, 'katalog danych liczy się wyłącznie regułą `shared/src/data-dir.mjs`').toEqual([]);
    expect(Object.keys(WHOLE_FILES).filter((file) => !usedFiles.has(file)), 'wyjątek bez trafienia: usuń wpis')
      .toEqual([]);
    expect(LINES.filter((entry) => !usedLines.has(`${entry.file}:${entry.fragment}`)).map((entry) => entry.file),
      'wyjątek bez trafienia: usuń wpis').toEqual([]);
  });
});
