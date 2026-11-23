/**
 * Sufit hooka zgód: doba.
 *
 * Hook `PermissionRequest` czeka na decyzję z telefonu do 24 h: `timeout` rejestracji 86 400 s, a komenda niesie
 * `--answer-wait=86398`, więc hook kończy czekanie sam, 2 s przed sygnałem CLI (hook zabity przy `timeout` milczy,
 * pomiar na CLI 2.1.257). Ten plik pilnuje, że:
 * 1. blok z `rarog hooks print` ma te dwie wartości (oba wpisy, bo `PreToolUse` pytania ma tę samą komendę);
 * 2. wpis z sufitem godziny (`timeout` 3600, `--answer-wait=3598`) to `mismatch` w `rarog hooks doctor` z widocznym
 *    starym sufitem, a pisarz ustawień (`rarog hooks install`, `rarog setup`) zamienia go na bieżący po różnicy,
 *    bez konfliktu;
 * 3. hook bez `--answer-wait` czeka do 86 398 s: wartość domyślna w źródle hooka równa się stałej serwera, a proces
 *    hooka to potwierdza. Zegar procesu przesuwa moduł `--import` o liczbę ms z pliku testu, więc doba mija w kilka
 *    sekund, a czekanie nie zależy od obciążenia maszyny.
 *
 * Wszystko w katalogu tymczasowym (`tempHome`); ustawień i kopii hooka właściciela test nie dotyka.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entriesQuestion, writeClaudeSettings } from '../src/cli/claude-settings.ts';
import { hooksCommand } from '../src/cli/hooks.ts';
import type { CliIo } from '../src/cli/io.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import {
  HOOK_ANSWER_TIMEOUT_S, HOOK_ANSWER_WAIT_S, HOOK_INSTALL_FILES, STATUSLINE_INSTALL_FILES, expectedHookEntries,
  hookCommand, hookInstallDir, inspectSettingsFile, userSettingsPath,
} from '../src/herdr/hook-config.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

const REPO = path.join(import.meta.dirname, '..', '..');
const HOOKS_SRC = path.join(REPO, 'scripts', 'hooks');
const HOOK = path.join(HOOKS_SRC, 'rarog-pending.mjs');
const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const PROMPT = 'fb908934-26eb-4419-9e30-8adcd4ed356b';
/** Sufit doby: `timeout` rejestracji i czekanie hooka 2 s krócej. */
const DAY_TIMEOUT_S = 86_400;
const DAY_WAIT_S = 86_398;
/** Sufit godziny: wpis z nim to `mismatch` do zamiany. */
const HOUR_TIMEOUT_S = 3600;
const HOUR_WAIT_S = 3598;

let t: TempHome;
let home = '';
let data = '';
const children = new Set<ChildProcess>();

beforeEach(() => {
  t = tempHome('rarog-sufit-doby-');
  home = path.join(t.home, 'h');
  data = path.join(t.home, 'dane');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
});

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  t.cleanup();
});

afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

const settings = (): string => userSettingsPath(home);

/** Kopia hooka z plików repo (stan po `hooks install`), żeby doctor i pisarz widzieli zgodną kopię. */
function putCopy(): void {
  const dir = hookInstallDir(home);
  mkdirSync(dir, { recursive: true });
  for (const name of [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]) {
    copyFileSync(path.join(HOOKS_SRC, name), path.join(dir, name));
  }
}

/** Komenda kopii z sufitem godziny: ta sama ścieżka, co dziś, tylko stare `--answer-wait`. */
const hourCommand = (): string => `node '${home}/.claude/hooks/rarog/rarog-pending.mjs' --answer-wait=${String(HOUR_WAIT_S)}`;

/** Wpisy zgód w kształcie drukowanym przy suficie godziny (`PermissionRequest` 3600 s, `PreToolUse` 5 s). */
function hourBlock(): Record<string, unknown> {
  return {
    hooks: {
      PermissionRequest: [{ hooks: [{ type: 'command', command: hourCommand(), timeout: HOUR_TIMEOUT_S }] }],
      PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: hourCommand(), timeout: 5 }] }],
    },
  };
}

function cliIo(out: { stdout: string }): CliIo {
  return {
    stdout: (chunk) => { out.stdout += chunk; }, stderr: () => {},
    env: { PATH: process.env['PATH'] ?? '', HOME: home, RAROG_DATA_DIR: data }, cwd: t.home, platform: 'linux',
  };
}

describe('sufit hooka zgód: blok ustawień', () => {
  it('`rarog hooks print`: `PermissionRequest` z `timeout` 86400, obie komendy z `--answer-wait=86398`', async () => {
    const out = { stdout: '' };
    expect(await hooksCommand(['print'], cliIo(out), 'użycie', 64)).toBe(0);
    const start = out.stdout.indexOf('\n{\n');
    const end = out.stdout.indexOf('\n}\n', start);
    expect(start, out.stdout).toBeGreaterThan(-1);
    const block = JSON.parse(out.stdout.slice(start + 1, end + 2)) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>>;
    };
    const permission = block.hooks['PermissionRequest']?.[0]?.hooks[0];
    const question = block.hooks['PreToolUse']?.[0]?.hooks[0];
    expect(permission?.timeout).toBe(DAY_TIMEOUT_S);
    expect(permission?.command).toBe(`node '${home}/.claude/hooks/rarog/rarog-pending.mjs' --answer-wait=${String(DAY_WAIT_S)}`);
    expect(question?.command).toBe(permission?.command);
    expect(question?.timeout, '`PreToolUse` tylko zrzuca: sufit 5 s bez zmian').toBe(5);
    expect(out.stdout).toContain(`\`timeout: ${String(DAY_TIMEOUT_S)}\` (24 h) on \`PermissionRequest\``);
  });

  it('`rarog hooks doctor` na wpisie z `timeout` 3600: `mismatch` ze starym sufitem i bieżącą komendą', async () => {
    putCopy();
    writeFileSync(settings(), JSON.stringify(hourBlock()));
    const out = { stdout: '' };
    expect(await hooksCommand(['doctor'], cliIo(out), 'użycie', 64)).toBe(1);
    expect(out.stdout).toContain('hook: mismatch');
    expect(out.stdout).toContain(
      `${settings()}: mismatch — PermissionRequest timeout=${String(HOUR_TIMEOUT_S)}, PreToolUse/AskUserQuestion timeout=5`);
    expect(out.stdout).toContain(`command: ${hookCommand(home)}`);
    expect(hookCommand(home)).toContain(`--answer-wait=${String(DAY_WAIT_S)}`);
  });

  it('pisarz ustawień: wpis z sufitem godziny to postać Raroga — różnica, „y”, wpisy bieżące, bez konfliktu', async () => {
    putCopy();
    writeFileSync(settings(), `${JSON.stringify(hourBlock(), null, 2)}\n`);
    const printed: string[] = [];
    const questions: string[] = [];
    const result = await writeClaudeSettings({
      home, root: REPO, operation: 'permission',
      dataDir: { ok: true, dir: data }, lock: { dir: path.join(home, '.config', 'rarog'), what: 'rarog setup' },
      confirm: (question) => { questions.push(entriesQuestion(question)); return Promise.resolve(true); },
      print: (line) => { printed.push(line); }, again: 'rarog hooks install',
    });
    expect(result.kind).toBe('written');
    expect(questions).toEqual(['Add a Rarog entry to ~/.claude/settings.json?']);
    const diff = printed.join('\n');
    expect(diff).toContain(`--answer-wait=${String(HOUR_WAIT_S)}`);
    expect(diff).toContain(`--answer-wait=${String(DAY_WAIT_S)}`);
    expect(diff).toMatch(new RegExp(`^-\\s*"timeout": ${String(HOUR_TIMEOUT_S)}$`, 'm'));
    expect(diff).toMatch(new RegExp(`^\\+\\s*"timeout": ${String(DAY_TIMEOUT_S)}$`, 'm'));
    expect(inspectSettingsFile(settings(), expectedHookEntries(hookCommand(home))).status).toBe('ok');
    const after = readFileSync(settings(), 'utf8');
    expect(after).not.toContain(`--answer-wait=${String(HOUR_WAIT_S)}`);
  });
});

// ---------------------------------------------------------------------------
// Hook bez `--answer-wait`: czekanie domyślne
// ---------------------------------------------------------------------------

/** Moduł `--import` procesu hooka: `Date.now` = zegar systemu + przesunięcie (ms) z pliku, czytane przy każdym odczycie. */
function clockModule(dir: string, offsetFile: string): string {
  const file = path.join(dir, 'zegar.mjs');
  writeFileSync(file, [
    "import { readFileSync } from 'node:fs';",
    'const real = Date.now.bind(Date);',
    `const file = ${JSON.stringify(offsetFile)};`,
    'Date.now = () => {',
    '  let offset = 0;',
    "  try { offset = Number(readFileSync(file, 'utf8')) || 0; } catch { offset = 0; }",
    '  return real() + offset;',
    '};',
    '',
  ].join('\n'));
  return pathToFileURL(file).href;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

describe('sufit hooka zgód: hook bez `--answer-wait`', () => {
  it('wartość domyślna czekania w hooku równa się `HOOK_ANSWER_WAIT_S` serwera (86 398 s)', () => {
    const source = readFileSync(HOOK, 'utf8');
    const match = /^const ANSWER_WAIT_DEFAULT_S = ([\d_]+);$/mu.exec(source);
    expect(match, 'brak stałej `ANSWER_WAIT_DEFAULT_S` w hooku').not.toBeNull();
    expect(Number((match?.[1] ?? '').replaceAll('_', ''))).toBe(HOOK_ANSWER_WAIT_S);
    expect(HOOK_ANSWER_WAIT_S).toBe(DAY_WAIT_S);
    expect(HOOK_ANSWER_TIMEOUT_S).toBe(DAY_TIMEOUT_S);
  });

  it('formularz pytania: hook żyje minutę przed 86 398 s czekania i kończy sam po tym czasie, bez decyzji', async () => {
    const project = path.join(data, 'roots', 'Projects', 'demo');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(data, 'roots.json'), JSON.stringify({ roots: [path.join(data, 'roots', 'Projects')] }));
    const offsetFile = path.join(t.home, 'przesuniecie-ms');
    const child = spawn(process.execPath, ['--import', clockModule(t.home, offsetFile), HOOK], {
      env: { PATH: process.env['PATH'] ?? '', HOME: home, RAROG_DATA_DIR: data },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    const exited = new Promise<number | null>((resolve) => { child.on('exit', (code) => { resolve(code); }); });
    child.stdin.end(JSON.stringify({
      session_id: SESSION, cwd: project, prompt_id: PROMPT, permission_mode: 'default',
      hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{
          question: 'Jaki smak?', header: 'Smak', multiSelect: false,
          options: [{ label: 'Wanilia' }, { label: 'Czekolada' }],
        }],
      },
    }));
    // Zrzut pytania leży, więc hook czeka; termin czekania liczy synchronicznie zaraz po zapisie zrzutu.
    const dump = path.join(data, HOOK_PENDING_DIRNAME, `${SESSION}.json`);
    expect(await until(() => existsSync(dump), 10_000), 'hook nie zrzucił pytania').toBe(true);
    await sleep(500);
    expect(child.exitCode, 'hook skończył przed przesunięciem zegara').toBeNull();

    writeFileSync(offsetFile, String((DAY_WAIT_S - 60) * 1000));
    await sleep(1500);
    expect(child.exitCode, `hook skończył przed ${String(DAY_WAIT_S - 60)} s czekania`).toBeNull();

    writeFileSync(offsetFile, String((DAY_WAIT_S + 5) * 1000));
    const code = await Promise.race([exited, sleep(5000).then(() => 'czeka' as const)]);
    expect(code, `hook czeka dłużej niż ${String(DAY_WAIT_S + 5)} s`).toBe(0);
    expect(stdout, 'po suficie bez decyzji: formularz zostaje przy biurku').toBe('');
  }, 30_000);
});
