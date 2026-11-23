/**
 * Kopia hooka zgód poza checkoutem.
 *
 * Claude Code wykonuje hook z `~/.claude/hooks/rarog/` (ścieżka chroniona przed zapisem z sandboksa), a kopię robi
 * ręczna komenda `pnpm run hooks:install` (`installHookCopy`). `/health`, `restart.sh` i `hooks:doctor` mówią
 * `stale`, gdy kopia różni się od repo. Każdy test bierze `HOME` i repo z katalogu tymczasowego: prawdziwy dom
 * i prawdziwe ustawienia Claude Code zostają nietknięte.
 *
 * Repo testowe to `git init` z kopią `scripts/hooks/*.mjs` i jednym commitem, bo instalacja bierze wyłącznie stan
 * z commita (`git status --porcelain -- scripts/hooks` pusty, bajty równe blobowi z `HEAD`).
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hooksCommand } from '../src/cli/hooks.ts';
import { renderExecStart } from '../src/cli/systemd-unit.ts';
import { gitReadEnv, spawnGitArgs } from '../src/git-status.ts';
import {
  HOOK_INSTALL_FILES, HOOK_MANIFEST_FILENAME, STATUSLINE_INSTALL_FILES, hookBlock, hookCommand,
  hookCopyReport, hookHealth, hookInstallDir, installHookCopy, installStatuslineCopy,
  statuslineCopyReport, userSettingsPath, writeHookRoots,
} from '../src/herdr/hook-config.ts';
import { OLD_ENTRY_FILE } from '../src/herdr/hook-commands.ts';
import { CHILD_TEST_TIMEOUT_MS, childJson, runInChild, serverModule } from './child-limit.ts';

const REPO = join(import.meta.dirname, '..', '..');
/** Pliki kopii (te same nazwy w repo i w kopii), w kolejności zapisu: pliki hooka i skrypt `statusLine`. */
const ALL_FILES = [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES];
const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const SESSION = '550e8400-e29b-41d4-a716-446655440000';

let base = '';
let home = '';
let repo = '';

/** Git testu: bez konfiguracji globalnej i systemowej (podpis commitów właściciela nie ma tu nic do rzeczy). */
function git(args: readonly string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd: repo, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: base, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

/** Runner gita instalatora — ten sam, który składa CLI (`spawnGitArgs` z osłonami odczytu plików). */
const runner = (): ReturnType<typeof spawnGitArgs> => spawnGitArgs(gitReadEnv({
  PATH: process.env['PATH'] ?? '', HOME: base, GIT_CONFIG_NOSYSTEM: '1',
}));

const install = (): ReturnType<typeof installHookCopy> => installHookCopy({
  home, root: repo, mode: 'clone', git: runner(), serviceRefusal: () => null,
});

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Ustawienia `HOME` testu z blokiem wskazującym kopię (to, co wkleja człowiek po `hooks:print`). */
function pasteBlock(): string {
  const path = userSettingsPath(home);
  writeFileSync(path, JSON.stringify(hookBlock(hookCommand(home)), null, 2));
  return path;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rarog-hook-kopia-'));
  home = join(base, 'home');
  repo = join(base, 'repo');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(repo, 'scripts', 'hooks'), { recursive: true });
  for (const name of ALL_FILES) {
    copyFileSync(join(REPO, 'scripts', 'hooks', name), join(repo, 'scripts', 'hooks', name));
  }
  git(['init', '-q']);
  git(['add', 'scripts/hooks']);
  git(['commit', '-qm', 'hook']);
});

afterEach(() => {
  // Katalog tylko do odczytu z testu EACCES nie może zatrzymać sprzątania.
  if (existsSync(join(home, '.claude', 'hooks'))) chmodSync(join(home, '.claude', 'hooks'), 0o755);
  rmSync(base, { recursive: true, force: true });
});

describe('hooks:install — kopia w ~/.claude/hooks/rarog/', () => {
  it('tworzy katalog, pliki hooka (z `consent.mjs`), skrypt `statusLine` i manifest; skróty = repo, 0644, commit z HEAD', async () => {
    const result = await install();
    expect(result).toMatchObject({ ok: true, dir: hookInstallDir(home) });
    if (!result.ok) return;
    const dir = hookInstallDir(home);
    expect(readdirSync(dir).sort()).toEqual([HOOK_MANIFEST_FILENAME, ...ALL_FILES].sort());
    const head = git(['rev-parse', 'HEAD']).trim();
    expect(result.commit).toBe(head);
    for (const name of ALL_FILES) {
      expect(sha(join(dir, name)), name).toBe(sha(join(repo, 'scripts', 'hooks', name)));
      expect(statSync(join(dir, name)).mode & 0o777, name).toBe(0o644);
      expect(lstatSync(join(dir, name)).isFile(), name).toBe(true);
    }
    expect(result.files.map((one) => one.name)).toEqual(ALL_FILES);
    const manifest = JSON.parse(readFileSync(join(dir, HOOK_MANIFEST_FILENAME), 'utf8')) as {
      commit: string; at: number; files: Record<string, string>;
    };
    expect(manifest.commit).toBe(head);
    expect(typeof manifest.at).toBe('number');
    expect(manifest.files).toEqual(Object.fromEntries(ALL_FILES.map((name) => [name, sha(join(dir, name))])));
    expect(hookCopyReport(home, repo).ok).toBe(true);
    expect(statuslineCopyReport(home, repo).ok).toBe(true);
  });

  it('klon nie pyta: bramą jest stan z commita, `review` nie jest wołany nawet przy różnej kopii', async () => {
    expect((await install()).ok).toBe(true);
    writeFileSync(join(repo, 'scripts', 'hooks', 'canon.mjs'), '// zmiana w commicie\n', { flag: 'a' });
    git(['commit', '-qam', 'zmiana']);
    let asked = 0;
    const result = await installHookCopy({
      home, root: repo, mode: 'clone', git: runner(), serviceRefusal: () => null,
      review: () => {
        asked += 1;
        return Promise.resolve(false);
      },
    });
    expect(result).toMatchObject({ ok: true, version: null, commit: git(['rev-parse', 'HEAD']).trim() });
    expect(asked).toBe(0);
    expect(readFileSync(join(hookInstallDir(home), 'canon.mjs'), 'utf8')).toMatch(/\/\/ zmiana w commicie\n$/);
  });

  it('drugi przebieg jest idempotentny: te same bajty, bez plików tymczasowych', async () => {
    expect((await install()).ok).toBe(true);
    const before = ALL_FILES.map((name) => sha(join(hookInstallDir(home), name)));
    expect((await install()).ok).toBe(true);
    expect(ALL_FILES.map((name) => sha(join(hookInstallDir(home), name)))).toEqual(before);
    expect(readdirSync(hookInstallDir(home)).sort()).toEqual([HOOK_MANIFEST_FILENAME, ...ALL_FILES].sort());
  });

  it('odmowa, gdy `rarog` jest dowiązaniem; cel dowiązania nietknięty', async () => {
    const target = join(base, 'cel');
    mkdirSync(target);
    mkdirSync(join(home, '.claude', 'hooks'));
    symlinkSync(target, hookInstallDir(home));
    const result = await install();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('is a symlink');
    expect(readdirSync(target)).toEqual([]);
  });

  it('odmowa przy niezacommitowanych zmianach w `scripts/hooks` (zmiana i plik nieśledzony)', async () => {
    writeFileSync(join(repo, 'scripts', 'hooks', 'tall-dialog.mjs'), '// zmiana bez commita\n', { flag: 'a' });
    const changed = await install();
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.reason).toContain('scripts/hooks/tall-dialog.mjs');
    git(['checkout', '--', 'scripts/hooks']);
    writeFileSync(join(repo, 'scripts', 'hooks', 'nowy.mjs'), 'export {};\n');
    const untracked = await install();
    expect(untracked.ok).toBe(false);
    if (!untracked.ok) expect(untracked.reason).toContain('scripts/hooks/nowy.mjs');
    expect(existsSync(hookInstallDir(home)), 'odmowa nie zakłada katalogu').toBe(false);
  });

  it('ostrzeżenie z prawdziwą ścieżką, gdy `~/.claude/hooks` prowadzi poza `~/.claude`', async () => {
    const outside = join(base, 'dotfiles-hooks');
    mkdirSync(outside);
    symlinkSync(outside, join(home, '.claude', 'hooks'));
    const result = await install();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([expect.stringContaining(outside)]);
  });

  it('HEAD przesunięty w trakcie instalacji → odmowa: bajty muszą być z zapamiętanego commita', async () => {
    const git0 = runner();
    let moved = false;
    // Po odczycie commita ktoś (równoległy checkout, commit agenta) przesuwa HEAD i zmienia plik.
    const racing: ReturnType<typeof spawnGitArgs> = async (command, cwd) => {
      const result = await git0(command, cwd);
      if (!moved && command.sub === 'rev-parse' && command.rest.includes('HEAD^{commit}')) {
        moved = true;
        writeFileSync(join(repo, 'scripts', 'hooks', 'tall-dialog.mjs'), '// inny commit\n', { flag: 'a' });
        git(['commit', '-qam', 'zmiana w trakcie']);
      }
      return result;
    };
    const result = await installHookCopy({ home, root: repo, mode: 'clone', git: racing, serviceRefusal: () => null });
    expect(moved).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('scripts/hooks/tall-dialog.mjs');
    expect(existsSync(hookInstallDir(home))).toBe(false);
  });

  it('brak prawa zapisu (EACCES/EPERM) → odmowa z prośbą o własny terminal poza sandboksem', async () => {
    mkdirSync(join(home, '.claude', 'hooks'));
    chmodSync(join(home, '.claude', 'hooks'), 0o555);
    const result = await install();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('outside the Claude Code sandbox');
  });
});

describe('kopia jest odcięta od checkoutu', () => {
  it('wysoki `Bash` do ZAINSTALOWANEGO hooka → `deny` (strażnik ładuje się z kopii)', async () => {
    expect((await install()).ok).toBe(true);
    const result = await runGuardedHook(join(hookInstallDir(home), 'rarog-pending.mjs'));
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  });

  it('zmiana bajtu w checkoutcie po instalacji nie zmienia decyzji kopii i daje `stale`', async () => {
    expect((await install()).ok).toBe(true);
    pasteBlock();
    expect(hookHealth({ settingsPaths: [userSettingsPath(home)], dataDir: base, home, root: repo }).status).toBe('ok');

    const source = join(repo, 'scripts', 'hooks', 'rarog-pending.mjs');
    writeFileSync(source, readFileSync(source, 'utf8').replace('async function main() {', 'async function main() {\n  return;'));
    // Mutacja działa: hook z checkoutu milczy…
    expect((await runGuardedHook(source)).stdout).toBe('');
    // …a kopia odmawia jak przed zmianą.
    const copy = await runGuardedHook(join(hookInstallDir(home), 'rarog-pending.mjs'));
    expect(JSON.parse(copy.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });

    expect(hookHealth({ settingsPaths: [userSettingsPath(home)], dataDir: base, home, root: repo }).status).toBe('stale');
    const report = hookCopyReport(home, repo);
    expect(report.files.find((one) => one.name === 'rarog-pending.mjs')?.state).toBe('differs');
    expect(report.files.find((one) => one.name === 'tall-dialog.mjs')?.state).toBe('match');
  });
});

describe('hookHealth i hookCopyReport — `stale`', () => {
  it('kopia = repo → `ok`; zmieniony bajt kopii → `stale`; brak kopii przy poprawnym wpisie → `stale`', async () => {
    const settings = pasteBlock();
    const health = (): string => hookHealth({ settingsPaths: [settings], dataDir: base, home, root: repo }).status;
    expect(health(), 'wpis poprawny, kopii brak').toBe('stale');
    expect(hookCopyReport(home, repo).files.map((one) => one.state)).toEqual(HOOK_INSTALL_FILES.map(() => 'missing'));

    expect((await install()).ok).toBe(true);
    expect(health()).toBe('ok');

    writeFileSync(join(hookInstallDir(home), 'tall-dialog.mjs'), '\n', { flag: 'a' });
    expect(health()).toBe('stale');
    const changed = hookCopyReport(home, repo).files.find((one) => one.name === 'tall-dialog.mjs');
    expect(changed?.state).toBe('differs');
    expect(changed?.manifestSha, 'manifest pamięta skrót z instalacji').toBe(changed?.repoSha);
  });

  it('wpis inny niż drukowany zostaje `mismatch`, a brak wpisu `brak` — kopia nie poprawia rejestracji', async () => {
    expect((await install()).ok).toBe(true);
    const path = userSettingsPath(home);
    writeFileSync(path, JSON.stringify(hookBlock(`node ${join(REPO, 'scripts', 'hooks', 'rarog-pending.mjs')} --answer-wait=3598`)));
    expect(hookHealth({ settingsPaths: [path], dataDir: base, home, root: repo }).status).toBe('mismatch');
    writeFileSync(path, '{}');
    expect(hookHealth({ settingsPaths: [path], dataDir: base, home, root: repo }).status).toBe('missing');
  });

  it('dowiązany plik kopii albo dowiązany katalog `rarog` to `stale`, nawet przy tych samych bajtach', async () => {
    pasteBlock();
    mkdirSync(join(home, '.claude', 'hooks'));
    symlinkSync(join(repo, 'scripts', 'hooks'), hookInstallDir(home));
    expect(hookCopyReport(home, repo)).toMatchObject({ ok: false, dirKind: 'symlink' });
    expect(hookHealth({ settingsPaths: [userSettingsPath(home)], dataDir: base, home, root: repo }).status).toBe('stale');

    unlinkSync(hookInstallDir(home)); // dowiązanie: `rmSync` na Node 24 odmawia przy dowiązaniu do katalogu
    mkdirSync(hookInstallDir(home));
    for (const name of HOOK_INSTALL_FILES) {
      symlinkSync(join(repo, 'scripts', 'hooks', name), join(hookInstallDir(home), name));
    }
    expect(hookCopyReport(home, repo).files.map((one) => one.state)).toEqual(HOOK_INSTALL_FILES.map(() => 'unreadable'));
  });

  it('FIFO w `scripts/hooks` repo nie zawiesza sondy: `stale` od razu', async () => {
    expect((await install()).ok).toBe(true);
    pasteBlock();
    const fifo = join(repo, 'scripts', 'hooks', 'tall-dialog.mjs');
    rmSync(fifo);
    execFileSync('mkfifo', [fifo]);
    const result = childJson<{ status: string; state: string | undefined }>(await runInChild(base, `
import { hookCopyReport, hookHealth } from ${serverModule('herdr/hook-config.ts')};
const input = { settingsPaths: [${JSON.stringify(userSettingsPath(home))}], dataDir: ${JSON.stringify(base)},
  home: ${JSON.stringify(home)}, root: ${JSON.stringify(repo)} };
const state = hookCopyReport(input.home, input.root).files.find((one) => one.name === 'tall-dialog.mjs')?.state;
console.log(JSON.stringify({ status: hookHealth(input).status, state }));
`));
    expect(result).toEqual({ status: 'stale', state: 'unreadable' });
  }, CHILD_TEST_TIMEOUT_MS);
});

/**
 * Kopia sprzed skryptu `statusLine`: pliki hooka i manifest bez wpisu skryptu — stan konta, które ostatni raz
 * robiło `hooks install` przed dodaniem skryptu do kopii.
 */
function olderCopy(): string {
  const dir = hookInstallDir(home);
  mkdirSync(dir, { recursive: true });
  for (const name of HOOK_INSTALL_FILES) copyFileSync(join(repo, 'scripts', 'hooks', name), join(dir, name));
  const files = Object.fromEntries(HOOK_INSTALL_FILES.map((name) => [name, sha(join(dir, name))]));
  writeFileSync(join(dir, HOOK_MANIFEST_FILENAME), JSON.stringify({ commit: 'a'.repeat(40), at: 1, files }));
  return dir;
}

/** Skróty wszystkich wpisów katalogu (nazwa → sha256) — „nic się nie zmieniło” bajt w bajt. */
function hashes(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, sha(join(dir, name))]));
}

describe('skrypt `statusLine` w kopii: osobny stan, osobna instalacja', () => {
  it('kopia bez skryptu `statusLine` (dwa pliki hooka, manifest bez wpisu) → `hook: ok` w `/health`', () => {
    olderCopy();
    pasteBlock();
    expect(hookCopyReport(home, repo).ok).toBe(true);
    expect(hookHealth({ settingsPaths: [userSettingsPath(home)], dataDir: base, home, root: repo }).status).toBe('ok');
    const script = statuslineCopyReport(home, repo);
    expect(script.ok).toBe(false);
    expect(script.files.map((one) => [one.name, one.state])).toEqual([['rarog-statusline.mjs', 'missing']]);
  });

  it('`installStatuslineCopy` dokłada sam skrypt: pliki hooka i manifest bajt w bajt bez zmian', async () => {
    const dir = olderCopy();
    const before = hashes(dir);
    const result = await installStatuslineCopy({ home, root: repo, mode: 'clone', git: runner(), serviceRefusal: () => null });
    expect(result).toMatchObject({ ok: true, dir, files: [{ name: 'rarog-statusline.mjs' }] });
    const after = hashes(dir);
    expect(Object.keys(after)).toEqual([...Object.keys(before), 'rarog-statusline.mjs'].sort());
    for (const [name, value] of Object.entries(before)) expect(after[name], name).toBe(value);
    expect(after['rarog-statusline.mjs']).toBe(sha(join(repo, 'scripts', 'hooks', 'rarog-statusline.mjs')));
    expect(statSync(join(dir, 'rarog-statusline.mjs')).mode & 0o777).toBe(0o644);
    expect(statuslineCopyReport(home, repo).ok).toBe(true);
    expect(hookCopyReport(home, repo).ok).toBe(true);

    // Drugi przebieg niczego nie nadpisuje.
    const again = await installStatuslineCopy({ home, root: repo, mode: 'clone', git: runner(), serviceRefusal: () => null });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain('already exists');
    expect(hashes(dir)).toEqual(after);
  });

  it('wyścig: plik powstaje między sprawdzeniem a zapisem → odmowa `EEXIST`, cudzy plik nietknięty', async () => {
    const dir = olderCopy();
    const git0 = runner();
    const racing: ReturnType<typeof spawnGitArgs> = async (command, cwd) => {
      const result = await git0(command, cwd);
      if (command.sub === 'status') writeFileSync(join(dir, 'rarog-statusline.mjs'), 'cudzy\n');
      return result;
    };
    const result = await installStatuslineCopy({ home, root: repo, mode: 'clone', git: racing, serviceRefusal: () => null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('appeared during the install');
    expect(readFileSync(join(dir, 'rarog-statusline.mjs'), 'utf8')).toBe('cudzy\n');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('brama „stan z commita” jak w `hooks install`: zmiana bez commita → odmowa, nic nie zapisane', async () => {
    const dir = olderCopy();
    const before = hashes(dir);
    writeFileSync(join(repo, 'scripts', 'hooks', 'rarog-statusline.mjs'), '// zmiana\n', { flag: 'a' });
    const result = await installStatuslineCopy({ home, root: repo, mode: 'clone', git: runner(), serviceRefusal: () => null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('uncommitted changes');
    expect(hashes(dir)).toEqual(before);
  });

  it('bez katalogu kopii: zakłada katalog i sam skrypt, bez plików hooka i manifestu', async () => {
    const result = await installStatuslineCopy({ home, root: repo, mode: 'clone', git: runner(), serviceRefusal: () => null });
    expect(result.ok).toBe(true);
    expect(readdirSync(hookInstallDir(home))).toEqual(['rarog-statusline.mjs']);
  });

  it('`rarog` jako dowiązanie → odmowa, cel nietknięty', async () => {
    const target = join(base, 'cel');
    mkdirSync(target);
    mkdirSync(join(home, '.claude', 'hooks'));
    symlinkSync(target, hookInstallDir(home));
    const result = await installStatuslineCopy({ home, root: repo, mode: 'clone', git: runner(), serviceRefusal: () => null });
    expect(result.ok).toBe(false);
    expect(readdirSync(target)).toEqual([]);
  });
});

/**
 * Plik z poprzedniej instalacji w tym pliku testów: plik wejściowy pod starą nazwą produktu, jedyna nazwa spoza
 * obecnego zestawu na zamkniętej liście plików, które kopia kiedykolwiek miała (`EVER_COPY_FILES`).
 */
const LEFTOVER = OLD_ENTRY_FILE;

/**
 * Kopia po instalacji z dodatkowym plikiem `LEFTOVER` wymienionym w manifeście (stan po instalacji, której zestaw
 * miał ten plik), plus `extra` dopisane do manifestu bez tworzenia plików.
 */
async function copyWithLeftover(extra: Record<string, string> = {}): Promise<string> {
  expect((await install()).ok).toBe(true);
  const dir = hookInstallDir(home);
  writeFileSync(join(dir, LEFTOVER), '// poprzednia instalacja\n');
  const manifest = JSON.parse(readFileSync(join(dir, HOOK_MANIFEST_FILENAME), 'utf8')) as {
    files: Record<string, string>;
  };
  manifest.files = { ...manifest.files, [LEFTOVER]: sha(join(dir, LEFTOVER)), ...extra };
  writeFileSync(join(dir, HOOK_MANIFEST_FILENAME), JSON.stringify(manifest));
  return dir;
}

describe('pliki z poprzedniej instalacji (`hooks install` sprząta kopię)', () => {
  it('plik z poprzedniego manifestu: `stale` przed instalacją; `hooks install` go usuwa, obcego pliku nie', async () => {
    const dir = await copyWithLeftover();
    writeFileSync(join(dir, 'obcy.mjs'), '// spoza manifestu\n');
    pasteBlock();
    const health = (): string => hookHealth({ settingsPaths: [userSettingsPath(home)], dataDir: base, home, root: repo })
      .status;
    const before = hookCopyReport(home, repo);
    expect(before).toMatchObject({ ok: false, leftovers: [LEFTOVER] });
    expect(before.files.every((one) => one.state === 'match')).toBe(true);
    expect(statuslineCopyReport(home, repo)).toMatchObject({ ok: true, leftovers: [] });
    expect(health()).toBe('stale');

    const result = await install();
    expect(result).toMatchObject({ ok: true, removed: [LEFTOVER], warnings: [] });
    expect(existsSync(join(dir, LEFTOVER))).toBe(false);
    expect(readFileSync(join(dir, 'obcy.mjs'), 'utf8')).toBe('// spoza manifestu\n');
    const manifest = JSON.parse(readFileSync(join(dir, HOOK_MANIFEST_FILENAME), 'utf8')) as {
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files)).toEqual(ALL_FILES);
    expect(hookCopyReport(home, repo)).toMatchObject({ ok: true, leftovers: [] });
    expect(health()).toBe('ok');
    // Drugi przebieg nie ma już czego usuwać.
    expect(await install()).toMatchObject({ ok: true, removed: [] });
  });

  it('dowiązanie albo katalog pod nazwą z manifestu: nietknięte, z ostrzeżeniem; cel dowiązania też', async () => {
    const dir = await copyWithLeftover({ 'katalog.mjs': 'b'.repeat(64) });
    const target = join(base, 'cel.mjs');
    writeFileSync(target, '// cel\n');
    unlinkSync(join(dir, LEFTOVER));
    symlinkSync(target, join(dir, LEFTOVER));
    mkdirSync(join(dir, 'katalog.mjs'));
    expect(hookCopyReport(home, repo)).toMatchObject({ ok: true, leftovers: [] });

    const result = await install();
    expect(result).toMatchObject({ ok: true, removed: [] });
    if (!result.ok) return;
    expect(result.warnings).toEqual([
      expect.stringContaining(`${join(dir, LEFTOVER)} is in the previous manifest, but it is not a regular file`),
      expect.stringContaining(`${join(dir, 'katalog.mjs')} is in the previous manifest`),
    ]);
    expect(lstatSync(join(dir, LEFTOVER)).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('// cel\n');
    expect(statSync(join(dir, 'katalog.mjs')).isDirectory()).toBe(true);
  });

  it('nazwa z manifestu spoza katalogu kopii (`..`, `/`, kropka na początku) nie jest ruszana', async () => {
    const outside = join(hookInstallDir(home), '..', 'poza.mjs');
    const sub = join(hookInstallDir(home), 'pod');
    const dir = await copyWithLeftover({
      '../poza.mjs': 'c'.repeat(64), 'pod/plik.mjs': 'd'.repeat(64), '.ukryty.mjs': 'e'.repeat(64),
    });
    writeFileSync(outside, 'poza\n');
    mkdirSync(sub);
    writeFileSync(join(sub, 'plik.mjs'), 'pod\n');
    writeFileSync(join(dir, '.ukryty.mjs'), 'ukryty\n');
    expect(hookCopyReport(home, repo).leftovers).toEqual([LEFTOVER]);

    expect(await install()).toMatchObject({ ok: true, removed: [LEFTOVER], warnings: [] });
    expect(readFileSync(outside, 'utf8')).toBe('poza\n');
    expect(readFileSync(join(sub, 'plik.mjs'), 'utf8')).toBe('pod\n');
    expect(readFileSync(join(dir, '.ukryty.mjs'), 'utf8')).toBe('ukryty\n');
  });

  it('nazwa z manifestu spoza zamkniętej listy (`notes.txt`): plik zostaje z ostrzeżeniem, `stale` go nie liczy', async () => {
    const notes = 'notatki\n';
    const dir = await copyWithLeftover({ 'notes.txt': createHash('sha256').update(notes).digest('hex') });
    writeFileSync(join(dir, 'notes.txt'), notes);
    expect(hookCopyReport(home, repo).leftovers).toEqual([LEFTOVER]);

    const result = await install();
    expect(result).toMatchObject({ ok: true, removed: [LEFTOVER] });
    if (!result.ok) return;
    expect(result.warnings).toEqual([
      expect.stringContaining(`${join(dir, 'notes.txt')} is in the previous manifest, but no Rarog copy ever had a file`),
    ]);
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe(notes);
    expect(hookCopyReport(home, repo)).toMatchObject({ ok: true, leftovers: [] });
  });

  it('nieczytelny manifest: nic nie usuwa i nie liczy plików z poprzedniej instalacji', async () => {
    const dir = await copyWithLeftover();
    writeFileSync(join(dir, HOOK_MANIFEST_FILENAME), '{ zepsuty');
    expect(hookCopyReport(home, repo)).toMatchObject({ ok: true, manifest: null, leftovers: [] });
    expect(await install()).toMatchObject({ ok: true, removed: [] });
    expect(existsSync(join(dir, LEFTOVER))).toBe(true);
  });

  it('odmowa bramy (zmiana bez commita) nie usuwa niczego', async () => {
    const dir = await copyWithLeftover();
    writeFileSync(join(repo, 'scripts', 'hooks', 'canon.mjs'), '// zmiana bez commita\n', { flag: 'a' });
    expect((await install()).ok).toBe(false);
    expect(existsSync(join(dir, LEFTOVER))).toBe(true);
  });

  /**
   * Runner gita, przy którego pierwszym `rev-parse` równoległa instalacja dopisuje do kopii plik `LEFTOVER` i jego
   * wpis w manifeście (brama trwa, więc lista plików do usunięcia z początku instalacji jest już nieaktualna).
   */
  function racingLeftover(dir: string): { readonly git: ReturnType<typeof spawnGitArgs>; readonly raced: () => boolean } {
    const git0 = runner();
    let raced = false;
    return {
      raced: () => raced,
      git: async (command, cwd) => {
        const result = await git0(command, cwd);
        if (!raced && command.sub === 'rev-parse') {
          raced = true;
          writeFileSync(join(dir, LEFTOVER), '// poprzednia instalacja\n');
          const manifest = JSON.parse(readFileSync(join(dir, HOOK_MANIFEST_FILENAME), 'utf8')) as {
            files: Record<string, string>;
          };
          manifest.files = { ...manifest.files, [LEFTOVER]: sha(join(dir, LEFTOVER)) };
          writeFileSync(join(dir, HOOK_MANIFEST_FILENAME), JSON.stringify(manifest));
        }
        return result;
      },
    };
  }

  it('plik z poprzedniej instalacji dopisany w trakcie bramy → odmowa, plik i manifest nietknięte', async () => {
    expect((await install()).ok).toBe(true);
    const dir = hookInstallDir(home);
    const race = racingLeftover(dir);
    const result = await installHookCopy({ home, root: repo, mode: 'clone', git: race.git, serviceRefusal: () => null });
    expect(race.raced()).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('changed during the install');
    expect(existsSync(join(dir, LEFTOVER))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, HOOK_MANIFEST_FILENAME), 'utf8')) as {
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files)).toContain(LEFTOVER);
    expect(hookCopyReport(home, repo).leftovers).toEqual([LEFTOVER]);
  });

  it('to samo przy usłudze innej instalacji: bez trybu „tylko manifest”, odmowa, manifest nietknięty', async () => {
    expect((await install()).ok).toBe(true);
    const dir = hookInstallDir(home);
    const race = racingLeftover(dir);
    const result = await installHookCopy({
      home, root: repo, mode: 'clone', git: race.git, serviceRefusal: () => 'usługa wskazuje inną instalację',
    });
    expect(race.raced()).toBe(true);
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, LEFTOVER))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, HOOK_MANIFEST_FILENAME), 'utf8')) as {
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files)).toContain(LEFTOVER);
  });

  it('`rarog setup` (sam skrypt `statusLine`, `installStatuslineCopy`) niczego nie usuwa', async () => {
    const dir = await copyWithLeftover();
    rmSync(join(dir, 'rarog-statusline.mjs'));
    const result = await installStatuslineCopy({ home, root: repo, mode: 'clone', git: runner(), serviceRefusal: () => null });
    expect(result).toMatchObject({ ok: true, removed: [] });
    expect(existsSync(join(dir, LEFTOVER))).toBe(true);
    expect(hookCopyReport(home, repo).leftovers).toEqual([LEFTOVER]);
  });
});

describe('kopia z instalacji usługi: `rarog hooks install` klonu obok usługi innej instalacji', () => {
  const unit = (): string => join(home, '.config', 'systemd', 'user', 'rarog.service');
  /** Plik jednostki w `HOME` testu, którego usługa startuje `bin` (kształt z `rarog service install`). */
  function serviceFor(bin: string): void {
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unit(), `[Service]\nExecStart=${renderExecStart(['/opt/n/bin/node', bin, 'serve'])}\n`);
  }

  /** `rarog hooks install` klonu `repo` na Linuksie (atrapy nie są potrzebne: cel czyta się z pliku jednostki). */
  async function hooksInstall(): Promise<{ readonly code: number; readonly stderr: string }> {
    let stderr = '';
    const code = await hooksCommand(['install'], {
      stdout: () => {}, stderr: (text) => { stderr += text; },
      env: { PATH: process.env['PATH'] ?? '', HOME: home }, cwd: base, platform: 'linux',
    }, 'użycie', 64, { mode: 'clone', root: repo });
    return { code, stderr };
  }

  it('usługa startuje paczkę: odmowa bez zapisu i bez propozycji przepięcia usługi na klon', async () => {
    serviceFor('/opt/n/lib/node_modules/rarog/bin/rarog.mjs');
    const result = await hooksInstall();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('refused — the service points to another installation (/opt/n/lib/node_modules/rarog/bin/rarog.mjs');
    expect(result.stderr).toContain("The service's installation installs the copy: `'/opt/n/bin/node'"
      + " '/opt/n/lib/node_modules/rarog/bin/rarog.mjs' hooks install`.");
    expect(result.stderr).not.toContain('first point the service');
    expect(result.stderr).not.toContain('service install');
    expect(existsSync(hookInstallDir(home))).toBe(false);
  });

  it('kopia już równa klonowi: zapis przechodzi, pliki bajt w bajt, nowy manifest z commitem', async () => {
    expect((await install()).ok).toBe(true);
    const dir = hookInstallDir(home);
    const before = ALL_FILES.map((name) => sha(join(dir, name)));
    serviceFor('/opt/n/lib/node_modules/rarog/bin/rarog.mjs');
    // Wpisy hooka już w ustawieniach: krok wpisów niczego nie zmienia, więc bez terminala nie odmawia.
    pasteBlock();
    expect((await hooksInstall()).code).toBe(0);
    expect(ALL_FILES.map((name) => sha(join(dir, name)))).toEqual(before);
    // Nowy commit ze zmianą hooka: ta sama usługa daje już odmowę, kopia bez zmian.
    writeFileSync(join(repo, 'scripts', 'hooks', 'canon.mjs'), '// zmiana w commicie\n', { flag: 'a' });
    git(['commit', '-qam', 'zmiana']);
    const refused = await hooksInstall();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('hooks:install: refused — the service points to another installation');
    expect(ALL_FILES.map((name) => sha(join(dir, name)))).toEqual(before);
  });

  it('usługa startuje ten klon: kopia jak bez usługi', async () => {
    serviceFor(join(repo, 'bin', 'rarog.mjs'));
    pasteBlock();
    expect((await hooksInstall()).code).toBe(0);
    expect(readdirSync(hookInstallDir(home)).sort()).toEqual([HOOK_MANIFEST_FILENAME, ...ALL_FILES].sort());
  });

  it('kopia równa klonowi, ale z plikiem z poprzedniej instalacji: odmowa, plik i manifest nietknięte', async () => {
    const dir = await copyWithLeftover();
    const manifestBefore = readFileSync(join(dir, HOOK_MANIFEST_FILENAME), 'utf8');
    serviceFor('/opt/n/lib/node_modules/rarog/bin/rarog.mjs');
    const refused = await hooksInstall();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('hooks:install: refused — the service points to another installation');
    expect(existsSync(join(dir, LEFTOVER))).toBe(true);
    expect(readFileSync(join(dir, HOOK_MANIFEST_FILENAME), 'utf8')).toBe(manifestBefore);
  });
});

/** Wysoka zgoda `Bash` subagenta w sesji herdr (kształt z pomiaru) do wskazanego skryptu hooka. */
function runGuardedHook(script: string): Promise<{ code: number | null; stdout: string }> {
  const dataDir = join(base, 'data');
  const project = join(base, 'roots', 'Projects', 'demo');
  mkdirSync(project, { recursive: true });
  writeHookRoots(dataDir, [join(base, 'roots', 'Projects')], { tallDialogGuard: true });
  const tall = JSON.parse(readFileSync(join(FIXTURES, 'dialog-bash-subagent-telefon-2.1.302.command.json'), 'utf8')) as {
    command: string; description?: string;
  };
  const payload = JSON.stringify({
    session_id: SESSION, cwd: project, prompt_id: '99926dae-f611-484e-b34d-ca9352af0c01', permission_mode: 'auto',
    agent_id: 'a0caa98eefec36726', agent_type: 'general-purpose', hook_event_name: 'PermissionRequest',
    tool_name: 'Bash', tool_input: { command: tall.command, description: tall.description },
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--answer-wait=1'], {
      env: { PATH: process.env['PATH'] ?? '', HOME: home, RAROG_DATA_DIR: dataDir, HERDR_ENV: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout }); });
    child.stdin.end(payload);
  });
}
