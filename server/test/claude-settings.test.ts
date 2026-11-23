/**
 * Writer of `~/.claude/settings.json`: the consent hooks and the context hook with the shared write mechanics — the
 * diff before the question, the write after „y” under a lock, a backup, a symlink stays a symlink, a refusal when the
 * file changes during the question, a conflict on a command similar to Rarog's.
 *
 * Wszystko w `HOME` z katalogu tymczasowego (`tempHome`): pisarz dostaje dom argumentem, a każdy przebieg sprawdza,
 * że to dom testu. Kopia hooka to pliki `scripts/hooks/` repo (bez gita), więc `hookCopyReport` jest zgodny.
 * `rarog hooks install` i `rarog hooks doctor` biegną w procesie na Linuksie (`CliIo.platform`), żeby cel usługi
 * czytał się z pliku jednostki w `HOME` testu, nie z launchd konta.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REFORMAT_NOTE, SETTINGS_BACKUP_DIRNAME, entriesDiff, entriesQuestion, writeClaudeSettings,
} from '../src/cli/claude-settings.ts';
import type {
  BatchQuestion, SettingsOperation, SettingsWriteResult, SettingsWriterFs,
} from '../src/cli/claude-settings.ts';
import { hooksCommand } from '../src/cli/hooks.ts';
import type { CliIo } from '../src/cli/io.ts';
import {
  HOOK_ANSWER_TIMEOUT_S, HOOK_INSTALL_FILES, STATUSLINE_INSTALL_FILES, contextHookBlock, contextHookCommand, contextHookEntries,
  denyReadPaths, expectedHookEntries, hookBlock, hookCommand, hookInstallDir, inspectContextHook, inspectSettingsFile,
  localSettingsPath, pasteHookBlock, statuslineCommand, userSettingsPath,
} from '../src/herdr/hook-config.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

const REPO = path.join(import.meta.dirname, '..', '..');
const HOOKS_SRC = path.join(REPO, 'scripts', 'hooks');
/** Stara nazwa produktu złożona z kawałków (dosłownie stoi tylko w liniach ze znacznikiem). */
const OLD = 'pi' + 'lot';
/** Hook herdr `SessionStart` (kształt z `herdr integration install claude`). */
const HERDR_HOOK = { type: 'command', command: "'/h/.claude/hooks/herdr-agent-state.sh' session-start" };

let t: TempHome;
let home = '';
let data = '';
let lockDir = '';

beforeEach(() => {
  t = tempHome('rarog-cs-');
  home = path.join(t.home, 'h');
  data = path.join(t.home, 'dane');
  lockDir = path.join(home, '.config', 'rarog');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  putCopy();
});

afterEach(() => { t.cleanup(); });

afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

/** Kopia hooka z plików repo (stan po `hooks install`). */
function putCopy(): void {
  const dir = hookInstallDir(home);
  mkdirSync(dir, { recursive: true });
  for (const name of [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]) {
    copyFileSync(path.join(HOOKS_SRC, name), path.join(dir, name));
  }
}

const settings = (): string => userSettingsPath(home);
const text = (file = settings()): string => readFileSync(file, 'utf8');
const json = (file = settings()): Record<string, unknown> => JSON.parse(text(file)) as Record<string, unknown>;
const canonical = (value: unknown, indent: string | number = 2): string => `${JSON.stringify(value, null, indent)}\n`;
const backupDir = (): string => path.join(data, SETTINGS_BACKUP_DIRNAME);
const backups = (): string[] => (existsSync(backupDir()) ? readdirSync(backupDir()).sort() : []);
const tmpFiles = (dir = path.dirname(settings())): string[] => readdirSync(dir).filter((name) => name.endsWith('.tmp'));

/** A value in a foreign field of the settings file that must never reach a log; not token-shaped on purpose. */
const SETTINGS_MARKER = 'settings-file-content-never-in-a-log';

/** The backups of `rarog hooks install` under the test's HOME (its data directory by the default rule). */
const BACKUPS_UNDER_HOME = path.join('.local', 'share', 'rarog', SETTINGS_BACKUP_DIRNAME);

/** Regular files under `root` whose bytes contain `needle`, relative to `root`, sorted (symlinks not followed). */
function filesContaining(root: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && readFileSync(file).includes(needle)) found.push(path.relative(root, file));
    }
  };
  walk(root);
  return found.sort();
}

/** Grupy Raroga z bloku zgód (`hookBlock`) po zdarzeniu. */
const rarogGroups = (): Record<string, unknown[]> =>
  (hookBlock(hookCommand(home)) as { hooks: Record<string, unknown[]> }).hooks;

/** Komenda kopii pod starą nazwą pliku, tak jak ją drukowano: przy suficie godziny, z `--answer-wait=3598`. */
const oldCopyCommand = (): string =>
  `node '${home}/.claude/hooks/rarog/${OLD}-pending.mjs' --answer-wait=3598`;

function putSettings(value: unknown, file = settings()): string {
  const body = typeof value === 'string' ? value : canonical(value);
  writeFileSync(file, body, { mode: 0o644 });
  chmodSync(file, 0o644);
  return body;
}

/**
 * The question of one operation on a file in the writer's layout: how many entries and where, the
 * names only under `d`, no backup sentence (the backup is still made; the line of the write names it).
 */
const ONE_ENTRY = 'Add a Rarog entry to ~/.claude/settings.json?';
const QUESTION = {
  permission: ONE_ENTRY,
  context: ONE_ENTRY,
  statusLine: ONE_ENTRY,
  denyRead: ONE_ENTRY,
  writeBlock: ONE_ENTRY,
  remove: 'Remove Rarog entries from ~/.claude/settings.json?',
} as const satisfies Readonly<Record<SettingsOperation, string>>;

interface Run {
  readonly result: SettingsWriteResult;
  readonly printed: string[];
  readonly questions: string[];
  /** Linie wypisane przed pierwszym pytaniem. */
  readonly beforeQuestion: string[];
}

interface RunOptions {
  readonly operation?: SettingsOperation;
  /** Odpowiedź na pytanie (funkcja dostaje pytanie); `null` = bez terminala. */
  readonly answer?: boolean | null | ((question: string) => boolean | Promise<boolean>);
  readonly fs?: Partial<SettingsWriterFs>;
  readonly now?: () => Date;
  readonly dataDir?: { readonly ok: true; readonly dir: string } | { readonly ok: false; readonly message: string };
  /** `held` = blokadę trzyma wołający (`rarog service uninstall`). */
  readonly lock?: 'held';
}

async function run(options: RunOptions = {}): Promise<Run> {
  // Bezpiecznik: pisarz dostaje wyłącznie dom z katalogu tymczasowego.
  expect(home.startsWith(tmpdir()) || home.startsWith('/private/var/') || home.startsWith('/var/')).toBe(true);
  const printed: string[] = [];
  const questions: string[] = [];
  let beforeQuestion: string[] = [];
  const answer = options.answer === undefined ? true : options.answer;
  const operation = options.operation ?? 'permission';
  const result = await writeClaudeSettings({
    home, root: REPO, operation,
    dataDir: options.dataDir ?? { ok: true, dir: data },
    lock: options.lock ?? { dir: lockDir, what: 'rarog setup' },
    confirm: answer === null ? null : async (question) => {
      const asked = entriesQuestion(question);
      questions.push(asked);
      beforeQuestion = [...printed];
      return typeof answer === 'function' ? answer(asked) : answer;
    },
    print: (line) => { printed.push(line); },
    again: 'rarog setup',
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { result, printed, questions, beforeQuestion };
}

/** Różnica z wydruku (hunki `@@ -a,b +c,d @@`) nałożona na `before` — tak, jak przeczyta ją człowiek. */
function applyDiff(before: string, printed: readonly string[]): string {
  const lines = before.split('\n');
  const out: string[] = [];
  let at = 0;
  for (const line of printed) {
    const header = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(line);
    if (header !== null) {
      const start = Number(header[2]) === 0 ? Number(header[1]) : Number(header[1]) - 1;
      out.push(...lines.slice(at, start));
      at = start;
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('target: ')) continue;
    const kind = line[0];
    const body = line.slice(1);
    if (kind === ' ') {
      expect(lines[at]).toBe(body);
      out.push(body);
      at += 1;
    } else if (kind === '-') {
      expect(lines[at]).toBe(body);
      at += 1;
    } else if (kind === '+') {
      out.push(body);
    }
  }
  out.push(...lines.slice(at));
  return out.join('\n');
}

/** Stan pliku do porównania „bez zmian”: bajty, i-węzeł i czas modyfikacji. */
function fileState(file = settings()): string {
  const info = statSync(file);
  return JSON.stringify([readFileSync(file).toString('base64'), info.ino, info.mtimeMs, info.mode]);
}

// ---------------------------------------------------------------------------
// Zapis: nowy plik, dopisanie, migracja, idempotencja
// ---------------------------------------------------------------------------

describe('pisarz ustawień: zapis po „y”', () => {
  it('brak settings.json → po „y” nowy plik 0600 z blokiem zgód; różnica przed pytaniem pokazuje całą treść', async () => {
    rmSync(path.join(home, '.claude', 'settings.json'), { force: true });
    const r = await run();
    expect(r.result).toMatchObject({ kind: 'written', target: settings(), backup: null });
    expect(r.questions).toEqual(['Add a Rarog entry to ~/.claude/settings.json?']);
    const expected = canonical(hookBlock(hookCommand(home)));
    expect(text()).toBe(expected);
    expect(statSync(settings()).mode & 0o777).toBe(0o600);
    for (const line of expected.trimEnd().split('\n')) expect(r.beforeQuestion).toContain(`+${line}`);
    expect(r.beforeQuestion).toContain(`--- ${settings()} (no file yet)`);
    expect(r.beforeQuestion).toContain(`target: ${settings()} (new file, mode 600)`);
    expect(applyDiff('', r.beforeQuestion)).toBe(expected);
    expect(r.printed.at(-1)).toBe(`written: ${settings()} (new file, mode 600; to undo: rm '${settings()}')`);
    expect(backups()).toEqual([]);
    expect(tmpFiles()).toEqual([]);
    expect(inspectSettingsFile(settings(), expectedHookEntries(hookCommand(home))).status).toBe('ok');
  });

  it('hook herdr SessionStart i cudzy PreToolUse → dopisane grupy Raroga na końcu, reszta bez zmian', async () => {
    const before = {
      model: 'opus',
      hooks: {
        SessionStart: [{ hooks: [HERDR_HOOK] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo cudzy', timeout: 9 }] }],
      },
      env: { X: '1' },
    };
    const original = putSettings(before);
    const r = await run();
    expect(r.result).toMatchObject({ kind: 'written', target: settings() });
    const after = json();
    expect(Object.keys(after)).toEqual(['model', 'hooks', 'env']);
    const hooks = after['hooks'] as Record<string, unknown[]>;
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'PreToolUse', 'PermissionRequest']);
    expect(hooks['SessionStart']).toEqual(before.hooks.SessionStart);
    expect(hooks['PreToolUse']?.[0]).toEqual(before.hooks.PreToolUse[0]);
    expect(hooks['PreToolUse']?.[1]).toEqual(rarogGroups()['PreToolUse']?.[0]);
    expect(hooks['PermissionRequest']).toEqual(rarogGroups()['PermissionRequest']);
    expect(after['model']).toBe('opus');
    expect(after['env']).toEqual({ X: '1' });
    // Bajty: wynik to kanoniczny zapis nowego obiektu, a każda linia oryginału (poza domknięciem tablicy, która
    // dostaje przecinek) stoi w nim w tej samej kolejności.
    expect(text()).toBe(canonical(after));
    const removed = r.beforeQuestion.filter((line) => line.startsWith('-') && !line.startsWith('---'));
    expect(removed.filter((line) => !/^-\s*[}\]]$/.test(line))).toEqual([]);
    expect(applyDiff(original, r.beforeQuestion)).toBe(text());
    expect(inspectSettingsFile(settings(), expectedHookEntries(hookCommand(home))).status).toBe('ok');
    expect(backups()).toHaveLength(1);
  });

  it('wpisy bieżące już stoją → zero pytań, zapisów i kopii zapasowych; drugi przebieg po zapisie tak samo', async () => {
    putSettings({ hooks: { SessionStart: [{ hooks: [HERDR_HOOK] }] } });
    expect((await run()).result.kind).toBe('written');
    expect((await run({ operation: 'context' })).result.kind).toBe('written');
    expect(backups()).toHaveLength(2);
    const state = fileState();
    for (const operation of ['permission', 'context'] as const) {
      const again = await run({ operation, answer: () => { throw new Error('pytanie'); } });
      expect(again.result).toEqual({ kind: 'unchanged' });
      expect(again.questions).toEqual([]);
      expect(again.printed).toEqual([]);
    }
    expect(fileState()).toBe(state);
    expect(backups()).toHaveLength(2);
    // Plik z kompletem z `rarog hooks print` (inny układ niż zapis pisarza): też bez pytania.
    putSettings(JSON.stringify(pasteHookBlock(hookCommand(home), contextHookCommand(home))));
    const pasted = fileState();
    expect((await run({ answer: null })).result).toEqual({ kind: 'unchanged' });
    expect((await run({ operation: 'context', answer: null })).result).toEqual({ kind: 'unchanged' });
    expect(fileState()).toBe(pasted);
    expect(existsSync(path.join(lockDir, 'lock'))).toBe(false);
  });

  it('postać historyczna (stara nazwa pliku w kopii) w grupie z cudzym handlerem → znika tylko handler Raroga', async () => {
    const old = oldCopyCommand();
    const checkout = `node /Users/ktos/Projects/rarog/scripts/hooks/${OLD}-pending.mjs --answer-wait=3598`;
    const foreign = { type: 'command', command: 'echo cudzy' };
    putSettings({
      hooks: {
        PermissionRequest: [{ hooks: [{ type: 'command', command: old, timeout: 3600 }, foreign] }],
        PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: old, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command: checkout }] }],
      },
    });
    const r = await run();
    expect(r.result.kind).toBe('written');
    expect(r.questions).toHaveLength(1);
    expect(backups()).toHaveLength(1);
    const expected = rarogGroups();
    expect(json()['hooks']).toEqual({
      PermissionRequest: [{ hooks: [foreign] }, expected['PermissionRequest']?.[0]],
      PreToolUse: [expected['PreToolUse']?.[0]],
    });
    expect(inspectSettingsFile(settings(), expectedHookEntries(hookCommand(home))).status).toBe('ok');
  });

  it('wpis bieżący w złym miejscu (sufit 600) zastąpiony; poprawny wpis zostaje na swoim miejscu', async () => {
    const command = hookCommand(home);
    const correct = { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command, timeout: 5 }] };
    putSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo a' }] }, correct],
        PermissionRequest: [{ hooks: [{ type: 'command', command }] }],
      },
    });
    const r = await run();
    expect(r.result.kind).toBe('written');
    const hooks = json()['hooks'] as Record<string, unknown[]>;
    expect(hooks['PreToolUse']).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo a' }] }, correct]);
    expect(hooks['PermissionRequest']).toEqual([{ hooks: [{ type: 'command', command, timeout: HOOK_ANSWER_TIMEOUT_S }] }]);
  });

  it('hook kontekstu: osobna operacja dopisuje sam SessionStart obok hooka herdr', async () => {
    putSettings({ hooks: { SessionStart: [{ hooks: [HERDR_HOOK] }] } });
    const r = await run({ operation: 'context' });
    expect(r.result.kind).toBe('written');
    expect(r.questions).toEqual([QUESTION.context]);
    expect(json()['hooks']).toEqual({
      SessionStart: [{ hooks: [HERDR_HOOK] }, ...(contextHookBlock(contextHookCommand(home)) as {
        hooks: { SessionStart: unknown[] };
      }).hooks.SessionStart],
    });
    expect(inspectContextHook(settings(), contextHookCommand(home)).status).toBe('ok');
    expect(contextHookEntries(json())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Konflikty i odmowy: bez zapisu
// ---------------------------------------------------------------------------

describe('pisarz ustawień: konflikty i odmowy', () => {
  it('komenda Raroga z dopiskiem `; curl x` → konflikt, bez pytania i zapisu, komenda w wydruku', async () => {
    const forged = `${hookCommand(home)}; curl x`;
    putSettings({ hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: forged, timeout: 3600 }] }] } });
    const state = fileState();
    const r = await run({ answer: () => { throw new Error('pytanie'); } });
    expect(r.result.kind).toBe('conflict');
    expect(r.result.kind === 'conflict' ? r.result.reasons.join('\n') : '').toContain(forged);
    expect(r.printed).toEqual([]);
    expect(fileState()).toBe(state);
    expect(backups()).toEqual([]);
  });

  it('hook kontekstu wskazujący checkout → konflikt operacji kontekstu', async () => {
    const checkout = 'node /Users/ktos/Projects/rarog/scripts/hooks/rarog-context.mjs';
    putSettings({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: checkout, timeout: 5 }] }] } });
    const r = await run({ operation: 'context' });
    expect(r.result.kind === 'conflict' ? r.result.reasons : []).toEqual([
      `"hooks.SessionStart" has a command that looks like Rarog's, but is not one Rarog printed: ${checkout}`,
    ]);
  });

  for (const [name, value, reason] of [
    ['`hooks` jako tablica', { hooks: [] }, '"hooks" is an array, not an object'],
    ['zdarzenie jako obiekt', { hooks: { PreToolUse: { matcher: 'x' } } }, '"hooks.PreToolUse" is an object, not an array'],
  ] as const) {
    it(`${name} → konflikt, bez zapisu`, async () => {
      putSettings(value);
      const state = fileState();
      const r = await run();
      expect(r.result).toEqual({ kind: 'conflict', reasons: [reason] });
      expect(fileState()).toBe(state);
    });
  }

  for (const [name, body] of [
    ['komentarz //', '{\n  // komentarz\n  "model": "opus"\n}\n'],
    ['ucięty JSON', '{\n  "model": "op'],
    ['korzeń-tablica', '[]\n'],
    ['pusty plik', ''],
  ] as const) {
    it(`${name} → odmowa, bajty bez zmian`, async () => {
      putSettings(body);
      const state = fileState();
      const r = await run();
      expect(r.result.kind).toBe('refused');
      expect(r.questions).toEqual([]);
      expect(fileState()).toBe(state);
      expect(tmpFiles()).toEqual([]);
    });
  }

  it('odmowa przy złym JSON nie cytuje treści pliku', async () => {
    putSettings('{ "env": { "KLUCZ": "sztuczny-sekret-0123" }, // x\n}');
    const r = await run();
    expect(r.result.kind === 'refused' ? r.result.reason : '').toMatch(/not strict JSON/);
    expect(JSON.stringify(r)).not.toContain('sztuczny-sekret');
  });

  it('wiszące dowiązanie → odmowa, dowiązanie bez zmian', async () => {
    symlinkSync(path.join(t.home, 'nie-ma'), settings());
    const r = await run();
    expect(r.result.kind === 'refused' ? r.result.reason : '').toMatch(/symlink .* leads to no file/);
    expect(lstatSync(settings()).isSymbolicLink()).toBe(true);
  });

  it('plik zmieniony między pytaniem a zapisem → odmowa, bez zapisu i kopii zapasowej', async () => {
    putSettings({ model: 'opus' });
    const changed = '{\n  "model": "sonnet"\n}\n';
    const r = await run({ answer: () => { writeFileSync(settings(), changed); return true; } });
    expect(r.result.kind === 'refused' ? r.result.reason : '').toContain('changed meanwhile');
    expect(text()).toBe(changed);
    expect(backups()).toEqual([]);
  });

  it('te same bajty pod nowym i-węzłem między pytaniem a zapisem → odmowa', async () => {
    const body = putSettings({ model: 'opus' });
    const r = await run({
      answer: () => {
        const other = path.join(home, '.claude', 'inny.json');
        writeFileSync(other, body);
        renameSync(other, settings());
        return true;
      },
    });
    expect(r.result.kind === 'refused' ? r.result.reason : '').toContain('changed meanwhile');
    expect(text()).toBe(body);
  });

  it('dowiązanie przepięte między pytaniem a zapisem → odmowa, oba cele bez zmian', async () => {
    const dotfiles = path.join(t.home, 'dotfiles');
    mkdirSync(dotfiles);
    const first = path.join(dotfiles, 'a.json');
    const second = path.join(dotfiles, 'b.json');
    const body = putSettings({ model: 'opus' }, first);
    writeFileSync(second, body);
    symlinkSync(first, settings());
    const r = await run({ answer: () => { unlinkSync(settings()); symlinkSync(second, settings()); return true; } });
    expect(r.result.kind === 'refused' ? r.result.reason : '').toContain('changed meanwhile');
    expect([text(first), text(second)]).toEqual([body, body]);
    expect(readlinkSync(settings())).toBe(second);
  });

  for (const [name, answer] of [['„n”', false], ['EOF', false], ['brak terminala', null]] as const) {
    it(`${name} → bez zapisu, różnica wypisana`, async () => {
      const body = putSettings({ model: 'opus' });
      const r = await run({ answer });
      expect(r.result.kind).toBe(answer === null ? 'no-terminal' : 'declined');
      expect(r.printed.some((line) => line.startsWith('+') && line.includes('PermissionRequest'))).toBe(true);
      expect(r.printed.at(-1)).toBe(`target: ${settings()}`);
      expect(text()).toBe(body);
      expect(backups()).toEqual([]);
    });
  }

  for (const [name, spoil] of [
    ['zmieniona', () => { writeFileSync(path.join(hookInstallDir(home), 'canon.mjs'), '// inna treść\n'); }],
    ['usunięta', () => { rmSync(hookInstallDir(home), { recursive: true }); }],
  ] as const) {
    it(`kopia hooka ${name} w czasie pytania → po „y” odmowa, bez zapisu i kopii zapasowej`, async () => {
      const body = putSettings({ model: 'opus' });
      const r = await run({ answer: () => { spoil(); return true; } });
      expect(r.questions).toHaveLength(1);
      expect(r.result.kind === 'refused' ? r.result.reason : '').toContain('hook copy');
      expect(r.result.kind === 'refused' ? r.result.reason : '').toContain('changed meanwhile');
      expect(text()).toBe(body);
      expect(backups()).toEqual([]);
      expect(tmpFiles()).toEqual([]);
    });
  }

  it('kopia hooka brak albo różna od źródła → wpisów nie pisze i mówi dlaczego', async () => {
    const body = putSettings({ model: 'opus' });
    const dir = hookInstallDir(home);
    writeFileSync(path.join(dir, 'canon.mjs'), '// inna treść\n');
    const differs = await run();
    expect(differs.result.kind === 'copy-not-ready' ? differs.result.reason : '')
      .toContain(`the hook copy in ${dir} is missing or differs from the source`);
    rmSync(dir, { recursive: true });
    const missing = await run();
    expect(missing.result.kind).toBe('copy-not-ready');
    expect([...differs.questions, ...missing.questions, ...differs.printed, ...missing.printed]).toEqual([]);
    expect(text()).toBe(body);
  });

  it('druga instancja trzyma blokadę → odmowa z PID-em, bez zapisu', async () => {
    const body = putSettings({ model: 'opus' });
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, 'lock'), `${String(process.ppid)}\n`);
    const r = await run();
    expect(r.result.kind === 'refused' ? r.result.reason : '').toContain(`PID ${String(process.ppid)}`);
    expect(text()).toBe(body);
    expect(backups()).toEqual([]);
    expect(readFileSync(path.join(lockDir, 'lock'), 'utf8')).toBe(`${String(process.ppid)}\n`);
  });

  it('brak katalogu danych przy istniejącym pliku → odmowa przed pytaniem', async () => {
    putSettings({ model: 'opus' });
    const r = await run({ dataDir: { ok: false, message: 'Data directory conflict: x.' } });
    expect(r.result).toEqual({ kind: 'refused', reason: 'no directory for the backup: Data directory conflict: x.' });
    expect(r.questions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dowiązanie, układ pliku, kopia zapasowa, błędy zapisu
// ---------------------------------------------------------------------------

describe('pisarz ustawień: dowiązanie, układ i kopia zapasowa', () => {
  it('settings.json dowiązaniem → zapis do celu, lstat dalej dowiązanie, bajty celu = pokazana różnica', async () => {
    const dotfiles = path.join(t.home, 'dotfiles');
    mkdirSync(dotfiles);
    const target = path.join(dotfiles, 'settings.json');
    const before = putSettings({ hooks: { SessionStart: [{ hooks: [HERDR_HOOK] }] }, model: 'opus' }, target);
    symlinkSync(target, settings());
    // Cel po `realpath` (na macOS `/var` to dowiązanie do `/private/var`).
    const real = realpathSync(target);
    const r = await run();
    expect(r.result).toMatchObject({ kind: 'written', target: real });
    expect(lstatSync(settings()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(settings())).toBe(target);
    expect(applyDiff(before, r.beforeQuestion)).toBe(text(target));
    expect(r.beforeQuestion.at(-1)).toBe(`target: ${real} (${settings()} is a symlink to it and stays one)`);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(tmpFiles(dotfiles)).toEqual([]);
    const [backup] = backups();
    expect(r.printed.at(-1)).toBe(`written: ${real}; backup: ${path.join(backupDir(), backup ?? '')} (to undo: cp`
      + ` '${path.join(backupDir(), backup ?? '')}' '${real}')`);
  });

  for (const [name, indent] of [['4 spacje', 4], ['tab', '\t']] as const) {
    it(`wcięcie ${name} zachowane, bez „reformatted”`, async () => {
      putSettings(canonical({ model: 'opus' }, indent));
      const r = await run();
      expect(r.result.kind).toBe('written');
      expect(text()).toBe(canonical(json(), indent));
      expect(r.questions[0]).not.toContain('reformatted');
    });
  }

  it('bez końcowego \\n zostaje bez; plik niekanoniczny → pytanie z „reformatted”', async () => {
    putSettings(JSON.stringify({ model: 'opus' }, null, 2));
    expect((await run()).questions[0]).toBe(QUESTION.permission);
    expect(text().endsWith('}')).toBe(true);
    putSettings('{"model":   "opus",\n  "env": {}}\n');
    const r = await run();
    expect(r.questions[0]).toBe(`${REFORMAT_NOTE} ${QUESTION.permission}`);
    expect(r.questions[0]).toContain('reformatted');
  });

  it('kopia zapasowa: oryginalne bajty, unikalna nazwa przy tym samym czasie, plik 0600, katalog 0700', async () => {
    const first = putSettings({ model: 'opus' });
    const now = (): Date => new Date('2026-11-08T10:00:00.000Z');
    expect((await run({ now })).result.kind).toBe('written');
    const second = text();
    expect((await run({ operation: 'context', now })).result.kind).toBe('written');
    const names = backups();
    expect(names).toHaveLength(2);
    for (const name of names) {
      expect(name).toMatch(/^settings\.2026-11-08T10-00-00\.000Z\.[0-9a-f]{8}\.json$/);
      expect(statSync(path.join(backupDir(), name)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(backupDir()).mode & 0o777).toBe(0o700);
    expect(names.map((name) => readFileSync(path.join(backupDir(), name), 'utf8')).sort()).toEqual([first, second].sort());
  });

  it('katalog kopii zapasowych jako dowiązanie → odmowa, ustawienia bez zmian', async () => {
    const body = putSettings({ model: 'opus' });
    mkdirSync(data, { recursive: true });
    const elsewhere = path.join(t.home, 'gdzie-indziej');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, backupDir());
    const r = await run();
    expect(r.result.kind === 'refused' ? r.result.reason : '').toContain('is a symlink or not a directory');
    expect(text()).toBe(body);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('błąd zapisu kopii zapasowej (atrapa) → ustawienia nietknięte, bez plików tymczasowych', async () => {
    putSettings({ model: 'opus' });
    const state = fileState();
    const written: string[] = [];
    const r = await run({
      fs: {
        writeExclusive: (file) => {
          written.push(file);
          throw Object.assign(new Error('pełny dysk'), { code: 'ENOSPC' });
        },
      },
    });
    // Kopia zapasowa idzie pierwsza: po jej błędzie pliku tymczasowego ustawień nikt nie zakłada.
    expect(written).toHaveLength(1);
    expect(written[0]?.startsWith(backupDir())).toBe(true);
    expect(r.result).toMatchObject({ kind: 'refused' });
    expect(r.result.kind === 'refused' ? r.result.reason : '').toMatch(/backup .*ENOSPC.*settings unchanged/);
    expect(fileState()).toBe(state);
    expect(tmpFiles()).toEqual([]);
  });

  it('błąd `rename` (atrapa) → ustawienia nietknięte, plik tymczasowy usunięty', async () => {
    putSettings({ model: 'opus' });
    const state = fileState();
    let tried = '';
    const r = await run({
      fs: {
        rename: (from) => {
          tried = from;
          throw Object.assign(new Error('inny wolumin'), { code: 'EXDEV' });
        },
      },
    });
    expect(r.result.kind === 'refused' ? r.result.reason : '').toBe(`cannot write ${settings()} (EXDEV); settings unchanged`);
    expect(path.dirname(tried)).toBe(path.dirname(settings()));
    expect(existsSync(tried)).toBe(false);
    expect(fileState()).toBe(state);
    expect(tmpFiles()).toEqual([]);
  });

  it('nowy plik powstał między pytaniem a zapisem → odmowa, cudzy plik bez zmian', async () => {
    rmSync(settings(), { force: true });
    const r = await run({ answer: () => { writeFileSync(settings(), '{}\n'); return true; } });
    expect(r.result.kind === 'refused' ? r.result.reason : '').toContain('changed meanwhile');
    expect(text()).toBe('{}\n');
    expect(tmpFiles()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `statusLine`
// ---------------------------------------------------------------------------

/** Zrzut paska statusu w `~/.claude/statusline/` z czasem modyfikacji `ageMs` temu. */
function putDump(ageMs: number, name = 'sesja-1.json'): void {
  const dir = path.join(home, '.claude', 'statusline');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, '{"session_id":"sesja-1"}');
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(file, at, at);
}

const HOUR_MS = 60 * 60 * 1000;
/** Cudza komenda paska statusu z apostrofem (cytowanie łańcucha w obie strony). */
const FOREIGN = "bash -c 'echo pasek'";

describe('pisarz ustawień: statusLine', () => {
  const statusLine = (): unknown => json()['statusLine'];

  it('brak statusLine → po „y” {"type":"command","command":"node \'<kopia>/rarog-statusline.mjs\'"}', async () => {
    putSettings({ model: 'opus', hooks: { SessionStart: [{ hooks: [HERDR_HOOK] }] } });
    const r = await run({ operation: 'statusLine' });
    expect(r.result.kind).toBe('written');
    expect(r.questions).toEqual([QUESTION.statusLine]);
    expect(statusLine()).toEqual({ type: 'command', command: statuslineCommand(home) });
    expect(statuslineCommand(home)).toBe(`node '${path.join(hookInstallDir(home), 'rarog-statusline.mjs')}'`);
    expect(Object.keys(json())).toEqual(['model', 'hooks', 'statusLine']);
    expect(json()['hooks']).toEqual({ SessionStart: [{ hooks: [HERDR_HOOK] }] });
    expect(backups()).toHaveLength(1);
  });

  it('brak pliku → nowy plik 0600 z samym statusLine', async () => {
    rmSync(settings(), { force: true });
    const r = await run({ operation: 'statusLine' });
    expect(r.result).toMatchObject({ kind: 'written', backup: null });
    expect(text()).toBe(canonical({ statusLine: { type: 'command', command: statuslineCommand(home) } }));
    expect(statSync(settings()).mode & 0o777).toBe(0o600);
  });

  for (const [name, ageMs] of [['bez zrzutów', null], ['zrzut starszy niż godzina', 2 * HOUR_MS]] as const) {
    it(`cudzy X z padding, ${name} → RAROG_STATUSLINE_CHAIN='X' node '…', padding bez zmian`, async () => {
      if (ageMs !== null) putDump(ageMs);
      putSettings({ statusLine: { type: 'command', command: FOREIGN, padding: 2 }, model: 'opus' });
      const r = await run({ operation: 'statusLine' });
      expect(r.result.kind).toBe('written');
      const chained = statuslineCommand(home, FOREIGN);
      expect(chained).toBe(`RAROG_STATUSLINE_CHAIN='bash -c '\\''echo pasek'\\''' ${statuslineCommand(home)}`);
      expect(statusLine()).toEqual({ type: 'command', command: chained, padding: 2 });
      expect(Object.keys(statusLine() as object)).toEqual(['type', 'command', 'padding']);
      expect(Object.keys(json())).toEqual(['statusLine', 'model']);
      // Drugi przebieg: bieżąca komenda z łańcuchem = bez pytania i zapisu.
      const state = fileState();
      const again = await run({ operation: 'statusLine', answer: () => { throw new Error('pytanie'); } });
      expect(again.result).toEqual({ kind: 'unchanged' });
      expect(fileState()).toBe(state);
    });
  }

  it('cudzy X ze zrzutem młodszym niż godzina → bez pytania, zapisu i wydruku', async () => {
    putDump(10 * 60 * 1000);
    putSettings({ statusLine: { type: 'command', command: FOREIGN } });
    const state = fileState();
    const r = await run({ operation: 'statusLine', answer: () => { throw new Error('pytanie'); } });
    expect(r.result).toEqual({ kind: 'unchanged' });
    expect(r.printed).toEqual([]);
    expect(fileState()).toBe(state);
    expect(backups()).toEqual([]);
  });

  it('cudzy X, katalog zrzutów nieczytelny → odmowa, bez zapisu', async () => {
    putDump(10 * 60 * 1000);
    putSettings({ statusLine: { type: 'command', command: FOREIGN } });
    const dir = path.join(home, '.claude', 'statusline');
    chmodSync(dir, 0o000);
    try {
      const state = fileState();
      const r = await run({ operation: 'statusLine' });
      expect(r.result.kind === 'refused' ? r.result.reason : '').toContain(`cannot read ${dir} (EACCES)`);
      expect(r.questions).toEqual([]);
      expect(fileState()).toBe(state);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('łańcuch Raroga ze starą nazwą zmiennej (postać historyczna) → ten sam X, bieżący skrypt, jedno owinięcie', async () => {
    const quoted = `'${FOREIGN.replaceAll("'", `'\\''`)}'`;
    const old = `${OLD.toUpperCase()}_STATUSLINE_CHAIN=${quoted} ${statuslineCommand(home)}`;
    putSettings({ statusLine: { type: 'command', command: old, padding: 0 } });
    // Świeży zrzut nie zatrzymuje przebudowy: to komenda Raroga, nie cudza.
    putDump(60 * 1000);
    const r = await run({ operation: 'statusLine' });
    expect(r.result.kind).toBe('written');
    const command = (statusLine() as { command: string }).command;
    expect(command).toBe(statuslineCommand(home, FOREIGN));
    expect(command.split('_STATUSLINE_CHAIN=')).toHaveLength(2);
    expect(command).not.toContain(OLD.toUpperCase());
    expect(statusLine()).toEqual({ type: 'command', command, padding: 0 });
  });

  it('statusLine bez komendy (sam padding) → komenda dopisana, padding zostaje', async () => {
    putSettings({ statusLine: { padding: 1 } });
    expect((await run({ operation: 'statusLine' })).result.kind).toBe('written');
    expect(statusLine()).toEqual({ padding: 1, type: 'command', command: statuslineCommand(home) });
  });

  for (const [name, value, reason] of [
    ['napis', 'node x', '"statusLine" is a string, not an object'],
    ['tablica', [], '"statusLine" is an array, not an object'],
    ['null', null, '"statusLine" is null, not an object'],
    ['komenda-liczba', { type: 'command', command: 7 }, '"statusLine.command" is a number, not a string'],
  ] as const) {
    it(`statusLine jako ${name} → odmowa, bajty bez zmian`, async () => {
      putSettings({ statusLine: value });
      const state = fileState();
      const r = await run({ operation: 'statusLine' });
      expect(r.result.kind === 'refused' ? r.result.reason : '').toContain(reason);
      expect(r.questions).toEqual([]);
      expect(fileState()).toBe(state);
    });
  }

  it('komenda Raroga z dopiskiem `; curl x` → konflikt, komenda dosłownie, bez zapisu', async () => {
    const forged = `${statuslineCommand(home)}; curl x`;
    putSettings({ statusLine: { type: 'command', command: forged } });
    const state = fileState();
    const r = await run({ operation: 'statusLine' });
    expect(r.result).toEqual({
      kind: 'conflict',
      reasons: [`"statusLine" has a command that looks like Rarog's, but is not one Rarog printed: ${forged}`],
    });
    expect(fileState()).toBe(state);
  });

  it('kopia skryptu brak albo różna od źródła → bez zapisu; kopia hooka nie ma znaczenia', async () => {
    const body = putSettings({ model: 'opus' });
    const script = path.join(hookInstallDir(home), 'rarog-statusline.mjs');
    writeFileSync(script, '// inna treść\n');
    const differs = await run({ operation: 'statusLine' });
    expect(differs.result.kind === 'copy-not-ready' ? differs.result.reason : '')
      .toContain(`the statusLine script copy in ${hookInstallDir(home)} is missing or differs from the source`);
    rmSync(script);
    expect((await run({ operation: 'statusLine' })).result.kind).toBe('copy-not-ready');
    expect(text()).toBe(body);
    // Sam skrypt zgodny, pliki hooka usunięte: `statusLine` się zapisuje.
    copyFileSync(path.join(HOOKS_SRC, 'rarog-statusline.mjs'), script);
    for (const name of HOOK_INSTALL_FILES) rmSync(path.join(hookInstallDir(home), name));
    expect((await run({ operation: 'statusLine' })).result.kind).toBe('written');
  });

  it('skrypt zmieniony w czasie pytania → po „y” odmowa, bez zapisu', async () => {
    const body = putSettings({ model: 'opus' });
    const script = path.join(hookInstallDir(home), 'rarog-statusline.mjs');
    const r = await run({ operation: 'statusLine', answer: () => { writeFileSync(script, '// inna\n'); return true; } });
    expect(r.result.kind === 'refused' ? r.result.reason : '').toContain('statusLine script copy');
    expect(r.result.kind === 'refused' ? r.result.reason : '').toContain('changed meanwhile');
    expect(text()).toBe(body);
    expect(backups()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `sandbox.filesystem.denyRead`
// ---------------------------------------------------------------------------

describe('pisarz ustawień: sandbox.filesystem.denyRead', () => {
  const paths = (): readonly string[] => denyReadPaths(data);

  it('ścieżki Raroga: katalog sekretów i katalog gniazda admina w katalogu danych', () => {
    expect(paths()).toEqual(['~/.config/rarog/secret', path.join(data, 'run')]);
  });

  it('brak sandbox → obiekty powstają, dwie ścieżki; kopia hooka niepotrzebna', async () => {
    putSettings({ model: 'opus', statusLine: { type: 'command', command: FOREIGN } });
    rmSync(hookInstallDir(home), { recursive: true });
    const r = await run({ operation: 'denyRead' });
    expect(r.result.kind).toBe('written');
    expect(r.questions).toEqual([QUESTION.denyRead]);
    expect(json()).toEqual({
      model: 'opus', statusLine: { type: 'command', command: FOREIGN },
      sandbox: { filesystem: { denyRead: paths() } },
    });
  });

  it('denyRead z jednym z dwóch → dopisany drugi na końcu; cudze wpisy i klucze zostają', async () => {
    const [secret, admin] = paths();
    putSettings({
      sandbox: { enabled: true, filesystem: { denyRead: ['~/.aws', admin], allowWrite: ['/x'] }, network: {} },
    });
    expect((await run({ operation: 'denyRead' })).result.kind).toBe('written');
    expect(json()).toEqual({
      sandbox: { enabled: true, filesystem: { denyRead: ['~/.aws', admin, secret], allowWrite: ['/x'] }, network: {} },
    });
    // Drugi przebieg: komplet = bez pytania i zapisu.
    const state = fileState();
    const again = await run({ operation: 'denyRead', answer: () => { throw new Error('pytanie'); } });
    expect(again.result).toEqual({ kind: 'unchanged' });
    expect(fileState()).toBe(state);
  });

  it('ścieżki Raroga w równoważnej postaci (bezwzględnej, z `/./`, z ukośnikiem) → bez pytania, zapisu i duplikatu', async () => {
    const body = putSettings({
      sandbox: { filesystem: { denyRead: [`${home}/.config/rarog/secret/`, `${data}/./run`] } },
    });
    const r = await run({ operation: 'denyRead', answer: () => { throw new Error('pytanie'); } });
    expect(r.result).toEqual({ kind: 'unchanged' });
    expect(text()).toBe(body);
    expect(backups()).toEqual([]);
  });

  for (const [name, sandbox, reason] of [
    ['denyRead: "x"', { filesystem: { denyRead: 'x' } }, '"sandbox.filesystem.denyRead" is a string, not an array'],
    ['filesystem: []', { filesystem: [] }, '"sandbox.filesystem" is an array, not an object'],
    ['sandbox: true', true, '"sandbox" is a boolean, not an object'],
  ] as const) {
    it(`${name} → odmowa, bajty bez zmian`, async () => {
      putSettings({ sandbox });
      const state = fileState();
      const r = await run({ operation: 'denyRead' });
      expect(r.result.kind === 'refused' ? r.result.reason : '').toContain(reason);
      expect(r.questions).toEqual([]);
      expect(fileState()).toBe(state);
    });
  }

  it('brak katalogu danych → odmowa przed pytaniem, także przy braku pliku', async () => {
    rmSync(settings(), { force: true });
    const r = await run({ operation: 'denyRead', dataDir: { ok: false, message: 'Data directory conflict: x.' } });
    expect(r.result.kind === 'refused' ? r.result.reason : '').toContain('Data directory conflict: x.');
    expect(r.questions).toEqual([]);
    expect(existsSync(settings())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Zdjęcie wpisów przy odinstalowaniu
// ---------------------------------------------------------------------------

describe('pisarz ustawień: zdjęcie wpisów Raroga (`rarog service uninstall`)', () => {
  /** Kroki 5–8 setup po „y”: wpisy zgód, hook kontekstu, `statusLine`, `denyRead`. */
  async function setupAll(): Promise<void> {
    for (const operation of ['permission', 'context', 'statusLine', 'denyRead'] as const) {
      expect((await run({ operation })).result.kind, operation).toBe('written');
    }
  }

  /** Plik kanoniczny z cudzymi wpisami we wszystkich kluczach, których dotyka setup. */
  const FOREIGN_SETTINGS = {
    model: 'opus',
    env: { FOO: '1' },
    hooks: {
      SessionStart: [{ hooks: [HERDR_HOOK] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo cudzy', timeout: 9 }] }],
    },
    statusLine: { type: 'command', command: FOREIGN, padding: 2 },
    sandbox: { enabled: true, filesystem: { denyRead: ['~/.aws'] } },
  };

  it('setup (wszystkie wpisy) na pliku kanonicznym, potem zdjęcie wpisów → bajty równe plikowi sprzed setup; jedno pytanie, jedna kopia', async () => {
    const before = putSettings(FOREIGN_SETTINGS);
    await setupAll();
    expect(text()).not.toBe(before);
    const backupsBefore = backups().length;
    const r = await run({ operation: 'remove' });
    expect(r.result.kind).toBe('written');
    expect(r.questions).toEqual([QUESTION.remove]);
    expect(text()).toBe(before);
    expect(backups()).toHaveLength(backupsBefore + 1);
    // Kopia zapasowa = stan po setup (z wpisami Raroga), więc `cp` z wydruku cofa samo zdjęcie.
    const backup = r.result.kind === 'written' ? r.result.backup ?? '' : '';
    expect(readFileSync(backup, 'utf8')).toContain(hookCommand(home));
    expect(r.beforeQuestion[0]).toBe(`--- ${settings()}`);
    expect(r.printed.at(-1)).toContain(`backup: ${backup}`);
    // Drugi przebieg: nic Raroga nie zostało = bez pytania i zapisu.
    const state = fileState();
    const again = await run({ operation: 'remove', answer: () => { throw new Error('pytanie'); } });
    expect(again.result).toEqual({ kind: 'unchanged' });
    expect(fileState()).toBe(state);
  });

  it('setup na braku pliku, potem zdjęcie wpisów → plik `{}` z `\\n` (pliku nie kasujemy)', async () => {
    rmSync(settings(), { force: true });
    await setupAll();
    expect(Object.keys(json())).toEqual(['hooks', 'statusLine', 'sandbox']);
    const r = await run({ operation: 'remove' });
    expect(r.result.kind).toBe('written');
    expect(text()).toBe('{}\n');
  });

  it('brak pliku → nic do zdjęcia: bez pytania, pliku nie zakłada', async () => {
    rmSync(settings(), { force: true });
    const r = await run({ operation: 'remove', answer: () => { throw new Error('pytanie'); } });
    expect(r.result).toEqual({ kind: 'unchanged' });
    expect(r.printed).toEqual([]);
    expect(existsSync(settings())).toBe(false);
  });

  it('łańcuch `RAROG_STATUSLINE_CHAIN=\'X\' …` z `padding` → statusLine z komendą X i tym samym padding', async () => {
    putSettings({ statusLine: { type: 'command', command: statuslineCommand(home, FOREIGN), padding: 3 }, model: 'opus' });
    const r = await run({ operation: 'remove' });
    expect(r.result.kind).toBe('written');
    expect(json()).toEqual({ statusLine: { type: 'command', command: FOREIGN, padding: 3 }, model: 'opus' });
    expect(Object.keys(json()['statusLine'] as object)).toEqual(['type', 'command', 'padding']);
  });

  it('postaci historyczne (stara nazwa pliku hooka i zmiennej łańcucha) znikają jak bieżące', async () => {
    const oldHook = oldCopyCommand();
    const checkout = `node /Users/ktos/Projects/rarog/scripts/hooks/${OLD}-pending.mjs --answer-wait=3598`;
    const quoted = `'${FOREIGN.replaceAll("'", `'\\''`)}'`;
    const oldChain = `${OLD.toUpperCase()}_STATUSLINE_CHAIN=${quoted} ${statuslineCommand(home)}`;
    const foreign = { type: 'command', command: 'echo cudzy' };
    putSettings({
      hooks: {
        PermissionRequest: [{ hooks: [{ type: 'command', command: oldHook, timeout: 3600 }, foreign] }],
        Stop: [{ hooks: [{ type: 'command', command: checkout }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: contextHookCommand(home), timeout: 5 }] }],
      },
      statusLine: { type: 'command', command: oldChain },
    });
    const r = await run({ operation: 'remove' });
    expect(r.result.kind).toBe('written');
    expect(json()).toEqual({
      hooks: { PermissionRequest: [{ hooks: [foreign] }] },
      statusLine: { type: 'command', command: FOREIGN },
    });
  });

  it('cudzy statusLine, cudze hooki, cudze wpisy denyRead i cudze puste → bez pytania i zapisu', async () => {
    // Ścieżka Raroga w postaci równoważnej to wpis użytkownika (setup jej nie dopisał), więc zostaje.
    putSettings({
      ...FOREIGN_SETTINGS,
      hooks: { ...FOREIGN_SETTINGS.hooks, Stop: [], Notification: [{ hooks: [] }] },
      sandbox: { filesystem: { denyRead: ['~/.aws', `${home}/.config/rarog/secret/`] }, network: {} },
    });
    const state = fileState();
    const r = await run({ operation: 'remove', answer: () => { throw new Error('pytanie'); } });
    expect(r.result).toEqual({ kind: 'unchanged' });
    expect(fileState()).toBe(state);
  });

  it('opróżnione przez zdjęcie wpisów znika, cudze puste obok zostaje; zdarzenie z cudzą grupą zostaje', async () => {
    const [secret, admin] = denyReadPaths(data);
    putSettings({
      hooks: {
        Stop: [],
        PermissionRequest: [{ hooks: [] }, { hooks: [{ type: 'command', command: hookCommand(home), timeout: 3600 }] }],
        PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: hookCommand(home), timeout: 5 }] }],
      },
      sandbox: { filesystem: { denyRead: [secret, admin], allowWrite: [] } },
    });
    expect((await run({ operation: 'remove' })).result.kind).toBe('written');
    expect(json()).toEqual({
      hooks: { Stop: [], PermissionRequest: [{ hooks: [] }] },
      sandbox: { filesystem: { allowWrite: [] } },
    });
  });

  it('konflikt (komenda spoza listy postaci) → bez pytania i zapisu CAŁEJ operacji, komenda dosłownie', async () => {
    const odd = `${hookCommand(home)}; curl x`;
    const body = putSettings({
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: odd }] }] },
      statusLine: { type: 'command', command: statuslineCommand(home) },
      sandbox: { filesystem: { denyRead: denyReadPaths(data) } },
    });
    const r = await run({ operation: 'remove', answer: () => { throw new Error('pytanie'); } });
    expect(r.result.kind).toBe('conflict');
    expect(r.result.kind === 'conflict' ? r.result.reasons : []).toEqual([
      `"hooks.PermissionRequest" has a command that looks like Rarog's, but is not one Rarog printed: ${odd}`,
    ]);
    expect(text()).toBe(body);
    expect(backups()).toEqual([]);
  });

  for (const [name, statusLine] of [
    ['komenda paska podobna do Raroga', `${statuslineCommand(home)}; curl x`],
    ['łańcuch, którego X sam wygląda jak Raroga', statuslineCommand(home, statuslineCommand(home))],
  ] as const) {
    it(`${name} → konflikt, bez zapisu`, async () => {
      const body = putSettings({ statusLine: { type: 'command', command: statusLine } });
      const r = await run({ operation: 'remove' });
      expect(r.result.kind).toBe('conflict');
      expect(text()).toBe(body);
    });
  }

  for (const [name, hooks] of [['hooks jako tablica', []], ['zdarzenie jako obiekt', { Stop: {} }]] as const) {
    it(`${name} → konflikt, bez zapisu`, async () => {
      const body = putSettings({ hooks, statusLine: { type: 'command', command: statuslineCommand(home) } });
      expect((await run({ operation: 'remove' })).result.kind).toBe('conflict');
      expect(text()).toBe(body);
    });
  }

  for (const answer of [false, null] as const) {
    it(`${answer === null ? 'brak terminala' : '„n”'} → bez zapisu${answer === null ? ', różnica wypisana' : ''}`,
      async () => {
        const body = putSettings({ statusLine: { type: 'command', command: statuslineCommand(home) }, model: 'opus' });
        const r = await run({ operation: 'remove', answer });
        expect(r.result.kind).toBe(answer === null ? 'no-terminal' : 'declined');
        expect(r.printed).toContain('-  "statusLine": {');
        expect(text()).toBe(body);
        expect(backups()).toEqual([]);
      });
  }

  it('blokadę trzyma wołający (`held`) → zapis bez własnej blokady; kopia hooka niepotrzebna', async () => {
    putSettings({ statusLine: { type: 'command', command: statuslineCommand(home) }, model: 'opus' });
    rmSync(hookInstallDir(home), { recursive: true });
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, 'lock'), `${String(process.ppid)}\n`);
    const r = await run({ operation: 'remove', lock: 'held' });
    expect(r.result.kind).toBe('written');
    expect(json()).toEqual({ model: 'opus' });
    expect(readFileSync(path.join(lockDir, 'lock'), 'utf8')).toBe(`${String(process.ppid)}\n`);
  });

  it('brak katalogu danych → odmowa przed pytaniem', async () => {
    const body = putSettings({ statusLine: { type: 'command', command: statuslineCommand(home) } });
    const r = await run({ operation: 'remove', dataDir: { ok: false, message: 'Data directory conflict: x.' } });
    expect(r.result.kind === 'refused' ? r.result.reason : '').toContain('Data directory conflict: x.');
    expect(r.questions).toEqual([]);
    expect(text()).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// `rarog hooks install` i `rarog hooks doctor`
// ---------------------------------------------------------------------------

describe('`rarog hooks install`: kopia, potem wpisy zgód', () => {
  let repo = '';

  beforeEach(() => {
    rmSync(hookInstallDir(home), { recursive: true });
    repo = path.join(t.home, 'repo');
    mkdirSync(path.join(repo, 'scripts', 'hooks'), { recursive: true });
    for (const name of [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]) {
      copyFileSync(path.join(HOOKS_SRC, name), path.join(repo, 'scripts', 'hooks', name));
    }
    const git = (args: readonly string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
        cwd: repo, env: { PATH: process.env['PATH'] ?? '', HOME: t.home, GIT_CONFIG_NOSYSTEM: '1' },
      });
    };
    git(['init', '-q']);
    git(['add', 'scripts/hooks']);
    git(['commit', '-qm', 'hook']);
  });

  async function hooksInstall(ask: ((prompt: string) => Promise<string | null>) | null): Promise<{
    readonly code: number; readonly stdout: string; readonly stderr: string; readonly prompts: string[];
  }> {
    let stdout = '';
    let stderr = '';
    const prompts: string[] = [];
    const io: CliIo = {
      stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; },
      env: { PATH: process.env['PATH'] ?? '', HOME: home }, cwd: t.home, platform: 'linux',
      ...(ask === null ? {} : { ask: async (prompt: string) => { prompts.push(prompt); return ask(prompt); } }),
    };
    const code = await hooksCommand(['install'], io, 'użycie', 64, { mode: 'clone', root: repo });
    return { code, stdout, stderr, prompts };
  }

  /** A prompt as one line: the form wraps it at the layout width. */
  const flat = (prompt: string): string => prompt.replace(/\s+/gu, ' ');

  it('„y” → kopia i wpisy, kod 0; drugi przebieg bez pytania', async () => {
    const first = await hooksInstall(() => Promise.resolve('y'));
    expect(first.code).toBe(0);
    expect(first.prompts.map(flat))
      .toEqual(['? Add a Rarog entry to ~/.claude/settings.json? [y/N/d] ']);
    // The diff is not printed up front: only the answer `d` shows it.
    expect(first.stdout).not.toMatch(/^\+.*"PermissionRequest"/mu);
    expect(inspectSettingsFile(settings(), expectedHookEntries(hookCommand(home))).status).toBe('ok');
    // Hook kontekstu dopisuje `rarog setup` (krok 6, osobne pytanie), nie `hooks install`.
    expect(inspectContextHook(settings(), contextHookCommand(home)).status).toBe('missing');
    expect(first.stdout).toContain(`written: ${settings()} (new file, mode 600`);
    const second = await hooksInstall(() => Promise.reject(new Error('pytanie')));
    expect(second.code).toBe(0);
    expect(second.prompts).toEqual([]);
    expect(second.stdout).toContain(`Hook entries in ${settings()}: match.`);
  });

  for (const [name, ask] of [
    ['„n”', () => Promise.resolve('n')],
    ['EOF', () => Promise.resolve(null)],
    ['brak terminala', null],
  ] as const) {
    it(`${name} na wpisy → kopia jest, wpisów nie ma, bez różnicy na stdout, kod 1`, async () => {
      putSettings({ model: 'opus' });
      const body = text();
      const r = await hooksInstall(ask);
      expect(r.code).toBe(1);
      expect(existsSync(path.join(hookInstallDir(home), 'manifest.json'))).toBe(true);
      expect(text()).toBe(body);
      expect(r.prompts).toHaveLength(ask === null ? 0 : 1);
      expect(r.stdout).not.toMatch(/^\+.*"PermissionRequest"/mu);
      expect(r.stderr).toContain('pnpm run hooks:print');
    });
  }

  it('„d” → różnica na ekranie i to samo pytanie; „n” → plik bajt w bajt, kod 1', async () => {
    putSettings({ model: 'opus' });
    const body = text();
    const answers = ['d', 'n'];
    const r = await hooksInstall(() => Promise.resolve(answers.shift() ?? null));
    expect(r.code).toBe(1);
    expect(r.prompts).toHaveLength(2);
    expect(r.prompts[1]).toBe(r.prompts[0]);
    expect(flat(r.prompts[0] ?? '')).toBe('? Add a Rarog entry to ~/.claude/settings.json? [y/N/d] ');
    // The names of the entries stand under `d`, above the diff.
    expect(r.stdout).toContain('A Rarog entry: permission hook\n');
    expect(r.stdout).toMatch(/^\+.*"PermissionRequest"/mu);
    expect(r.stdout).toContain(`target: ${settings()}`);
    expect(text()).toBe(body);
  });

  for (const reply of ['y', 'n', 'd'] as const) {
    it(`a foreign settings value never reaches a log or the output after "${reply}"`, async () => {
      // One line, so the whole file is one changed line of the diff.
      putSettings(JSON.stringify({ env: { SOME_TOKEN: SETTINGS_MARKER } }));
      const answers: string[] = reply === 'd' ? ['d', 'n'] : [reply];
      const r = await hooksInstall(() => Promise.resolve(answers.shift() ?? null));
      expect(r.code).toBe(reply === 'y' ? 0 : 1);
      // Only the answer `d` puts the file on the screen; the command writes no log of its own.
      expect(r.stdout.includes(SETTINGS_MARKER)).toBe(reply === 'd');
      expect(r.stderr).not.toContain(SETTINGS_MARKER);
      expect(filesContaining(home, SETTINGS_MARKER).filter((one) => !one.startsWith(BACKUPS_UNDER_HOME)))
        .toEqual(['.claude/settings.json']);
    });
  }

  it('konflikt → kod 1, komenda w wydruku, plik bez zmian', async () => {
    const forged = `${hookCommand(home)}; curl x`;
    putSettings({ hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: forged }] }] } });
    const body = text();
    const r = await hooksInstall(() => Promise.resolve('y'));
    expect(r.code).toBe(1);
    expect(r.prompts).toEqual([]);
    expect(r.stderr).toContain(forged);
    expect(text()).toBe(body);
  });
});

describe('`rarog hooks doctor`: wpisy Raroga w dwóch plikach ustawień', () => {
  async function doctor(): Promise<string> {
    let stdout = '';
    await hooksCommand(['doctor'], {
      stdout: (chunk) => { stdout += chunk; }, stderr: () => {},
      env: { PATH: '/usr/bin:/bin', HOME: home, RAROG_DATA_DIR: data }, cwd: project, platform: 'linux',
    }, 'użycie', 64);
    return stdout;
  }
  let project = '';

  beforeEach(() => {
    project = path.join(t.home, 'projekt');
    mkdirSync(path.join(project, '.claude'), { recursive: true });
    putSettings(pasteHookBlock(hookCommand(home), contextHookCommand(home)));
  });

  it('wpisy także w <cwd>/.claude/settings.local.json → linia o podwójnym odpaleniu ze ścieżkami', async () => {
    putSettings(hookBlock(hookCommand(home)), localSettingsPath(project));
    const out = await doctor();
    expect(out).toContain(`WARNING: Rarog hook entries are in both ${settings()} and ${localSettingsPath(project)}`);
    expect(out).toContain('different ones (for example an old command) fire twice');
  });

  it('sam hook kontekstu w pliku projektu też się liczy; bez wpisów Raroga w projekcie linii nie ma', async () => {
    putSettings(contextHookBlock(contextHookCommand(home)), localSettingsPath(project));
    expect(await doctor()).toContain('WARNING: Rarog hook entries are in both');
    putSettings({ hooks: { SessionStart: [{ hooks: [HERDR_HOOK] }] } }, localSettingsPath(project));
    expect(await doctor()).not.toContain('WARNING: Rarog hook entries are in both');
  });
});

/**
 * The one `[y/N/d]` question, the same in `rarog setup`, `rarog hooks install` and `rarog
 * service uninstall`: who writes how many entries where, the clauses only when they apply, the names under `d`.
 */
describe('entriesQuestion and entriesDiff', () => {
  const batch = (changes: readonly SettingsOperation[], extra: Partial<BatchQuestion> = {}): BatchQuestion => ({
    changes, chains: false, reformatted: false, newFile: false, diff: ['--- x', '+++ x (after the change)'], ...extra,
  });
  const FOUR: readonly SettingsOperation[] = ['permission', 'context', 'statusLine', 'denyRead'];

  it('four entries, with herdr: the count, herdr and the file, no names and no backup sentence', () => {
    expect(entriesQuestion(batch(FOUR))).toBe('Add 4 Rarog entries to ~/.claude/settings.json?');
    expect(entriesQuestion(batch(FOUR), 'herdr\'s hook'))
      .toBe('Add 4 Rarog entries and herdr\'s hook to ~/.claude/settings.json?');
    for (const newFile of [false, true]) {
      const asked = entriesQuestion(batch(FOUR, { newFile }));
      expect(asked).not.toContain('backup');
      expect(asked).not.toContain('permission');
    }
  });

  it('the clauses stay when they apply: the user\'s own status line command chained, the file reformatted', () => {
    expect(entriesQuestion(batch(FOUR, { chains: true }), 'herdr\'s hook')).toBe('Add 4 Rarog entries and herdr\'s'
      + ' hook to ~/.claude/settings.json, with your own status line command chained behind Rarog\'s?');
    expect(entriesQuestion(batch(['permission'], { reformatted: true })))
      .toBe(`${REFORMAT_NOTE} Add a Rarog entry to ~/.claude/settings.json?`);
  });

  it('"d" shows the names of the entries, then the diff; the removal shows the diff alone', () => {
    expect(entriesDiff(batch(FOUR))).toEqual([
      '4 Rarog entries: permission and context hooks, status line, sandbox read block', '--- x',
      '+++ x (after the change)',
    ]);
    expect(entriesDiff(batch(['denyRead']))[0]).toBe('A Rarog entry: sandbox read block');
    expect(entriesDiff(batch(['remove']))).toEqual(['--- x', '+++ x (after the change)']);
  });
});
