/**
 * Most do hooków Claude Code: blok do wklejenia, doctor, korzenie dla filtra `cwd`
 * i pole `hook` w `/health`.
 *
 * Trzy niezmienniki, których pilnuje ten plik i których złamanie jest ciche:
 * 1. `hooks:print` i `hooks:doctor` mówią o TYM SAMYM bloku — inaczej „mismatch" przy
 *    poprawnej instalacji nauczyłby użytkownika ignorować sygnał;
 * 2. doctor NICZEGO nie zapisuje i nie uznaje cudzych hooków (herdr `SessionStart`,
 *    `notes-guard`) za błąd — w tym samym pliku siedzi hook, od którego zależy wykrywanie
 *    sesji, a `~/.claude/settings.json` jest symlinkiem do repo dotfiles;
 * 3. `roots.json` pisany przez serwer jest CZYTELNY DLA HOOKA — obie strony filtra `cwd`
 *    testujemy razem, bo rozjazd nazw pól znaczy „hook nie pisze nigdy" (fail-closed).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOOK_ANSWER_TIMEOUT_S, HOOK_ANSWER_WAIT_S, HOOK_INSTALL_FILES, HOOK_MANIFEST_FILENAME,
  HOOK_QUESTION_MATCHER, HOOK_ROOTS_FILENAME, HOOK_SEEN_FILENAME, HOOK_TIMEOUT_S, STATUSLINE_INSTALL_FILES,
  combineStatus, contextHookCommand, expectedHookEntries, hookBlock, hookCommand, hookCopyReport, hookHealth,
  hookInstallDir, hookScriptPath, inspectSettingsFile, installHookCopy, installMissingHookCopy, installStatuslineCopy,
  localSettingsPath, pasteHookBlock, rarogHookEntries, readHookRoots, readHookSeenAt, renderHookBlock,
  renderHookCopyReview,
  statuslineBlock, statuslineCommand, userSettingsPath, visibleLine, writeBlockRules, writeHookRoots,
  type HookCopyReport, type HookCopyReview, type HookInstallOptions, type HookInstallResult,
} from '../src/herdr/hook-config.ts';
import { OLD_ENTRY_FILE } from '../src/herdr/hook-commands.ts';
import { lineDiff } from '../src/herdr/line-diff.ts';
import { readPendingHook } from '../src/herdr/dialogs/hook/dump.ts';
import { gitReadEnv, spawnGitArgs } from '../src/git-status.ts';
import { RESTART_HOOK_REPAIR } from '../src/install/repair.ts';
import { HOOK_LEFTOVER_TEXT, HOOK_REPAIR_COPY, hooksCommand, type HookInstallTarget } from '../src/cli/hooks.ts';
import type { CliIo } from '../src/cli/io.ts';
import { renderExecStart } from '../src/cli/systemd-unit.ts';
import { realRarogDirsCreated, tempHome, type TempHome } from './rarog-home.ts';

const REPO = join(import.meta.dirname, '..', '..');
const HOOK_SCRIPT = join(REPO, 'scripts', 'hooks', 'rarog-pending.mjs');
/** `rarog hooks …` (kod w `server/src/cli/hooks.ts`). */
const CLI = join(REPO, 'bin', 'rarog.mjs');
/** Podkładka `pnpm run hooks:*` — ten sam kod przez `tsx`. */
const SHIM = join(REPO, 'scripts', 'hooks-config.ts');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const SESSION = '550e8400-e29b-41d4-a716-446655440000';
/** Dom do testów samego pliku ustawień — komenda hooka zależy od niego (kopia w `<home>/.claude/hooks/rarog/`). */
const HOME = '/Users/x';
/** Wpisy, których doctor szuka dla {@link HOME}. */
const EXPECTED = expectedHookEntries(hookCommand(HOME));
const inspect = (path: string): ReturnType<typeof inspectSettingsFile> => inspectSettingsFile(path, EXPECTED);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rarog-hookcfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Cudze hooki, które MUSZĄ przeżyć każdą operację doctora — kształt z żywych ustawień. */
const OBCE_HOOKI = {
  PreToolUse: [{
    matcher: 'Bash|Read|Grep|Glob|Edit|Write',
    hooks: [{ type: 'command', command: "bash '/Users/x/.local/bin/notes-guard.sh'", timeout: 10 }],
  }],
  SessionStart: [{
    matcher: '*',
    hooks: [{
      type: 'command', command: "bash '/Users/x/.claude/hooks/herdr-agent-state.sh' session",
      timeout: 10,
    }],
  }],
};

/** Ustawienia z cudzymi hookami + (opcjonalnie) naszym blokiem; zwraca ścieżkę pliku. */
function putSettings(name: string, rarog: Record<string, unknown> | null): string {
  const path = join(dir, name);
  const hooks: Record<string, unknown> = { ...OBCE_HOOKI };
  if (rarog !== null) {
    for (const [event, groups] of Object.entries(rarog)) {
      const existing = hooks[event];
      hooks[event] = Array.isArray(existing)
        ? [...existing, ...(groups as unknown[])]
        : groups;
    }
  }
  writeFileSync(path, `${JSON.stringify({ permissions: { allow: [] }, hooks }, null, 2)}\n`);
  return path;
}

/** Nasz blok w postaci, w jakiej trafia do pliku ustawień (to samo, co drukuje `print`). */
function rarogHooks(command = hookCommand(HOME)): Record<string, unknown> {
  return (hookBlock(command) as { hooks: Record<string, unknown> }).hooks;
}

describe('blok do wklejenia (hooks:print)', () => {
  it('rejestruje DWA zdarzenia: `PermissionRequest` bez matchera i `PreToolUse` z matcherem', () => {
    const block = hookBlock(hookCommand(HOME)) as {
      hooks: Record<string, { matcher?: string; hooks: { type: string; timeout: number }[] }[]>;
    };
    const permission = block.hooks['PermissionRequest'];
    const preTool = block.hooks['PreToolUse'];

    expect(permission).toHaveLength(1);
    expect(permission?.[0]?.matcher, '`PermissionRequest` ma obejmować KAŻDY dialog zgody')
      .toBeUndefined();
    expect(preTool?.[0]?.matcher, 'hook przy każdym narzędziu został wycięty')
      .toBe(HOOK_QUESTION_MATCHER);
    // Jawny sufit czasu: bez niego zawieszony hook zwisałby domyślne 600 s przed dialogiem.
    for (const groups of [permission, preTool]) {
      expect(groups?.[0]?.hooks[0]?.type).toBe('command');
    }
    /*
     * DWA różne sufity, bo hook ma dwie role. `PreToolUse` wyłącznie
     * ZRZUCA i kończy w milisekundach — 5 s to margines na zimny start node. `PermissionRequest`
     * przy formularzu `AskUserQuestion` i przy zgodzie z kanałem zgód CZEKA na decyzję z telefonu,
     * więc jego sufit to doba; CLI 2.1.257 honoruje wartości ponad domyślne 600 s, a CLI 2.1.311
     * przyjmuje 86 400 s. Zrównanie ich oznaczałoby zabicie hooka w ciszy po 5 sekundach.
     */
    expect(preTool?.[0]?.hooks[0]?.timeout).toBe(HOOK_TIMEOUT_S);
    expect(HOOK_TIMEOUT_S).toBe(5);
    expect(permission?.[0]?.hooks[0]?.timeout).toBe(HOOK_ANSWER_TIMEOUT_S);
    expect(HOOK_ANSWER_TIMEOUT_S).toBe(86_400);
  });

  it('komenda wskazuje KOPIĘ w domu, źródłem kopii jest ISTNIEJĄCY skrypt repo', () => {
    expect(hookScriptPath()).toBe(HOOK_SCRIPT);
    expect(existsSync(HOOK_SCRIPT), 'kopia powstaje ze skryptu, którego nie ma').toBe(true);
    // `--answer-wait` jedzie ARGUMENTEM, żeby rozjazd z `timeout` był widoczny jako `mismatch`,
    // a nie jako hook czekający dłużej, niż pozwala mu rejestracja (i zabity w ciszy).
    expect(hookCommand(HOME))
      .toBe(`node '${HOME}/.claude/hooks/rarog/rarog-pending.mjs' --answer-wait=${String(HOOK_ANSWER_WAIT_S)}`);
    expect(HOOK_ANSWER_WAIT_S, 'sufit rejestracji minus 2 s na zwinięcie procesu')
      .toBe(HOOK_ANSWER_TIMEOUT_S - 2);
    expect(renderHookBlock(hookCommand(HOME))).toContain(`${hookInstallDir(HOME)}/rarog-pending.mjs`);
  });

  it('stary blok (jeden sufit 5 s, komenda bez `--answer-wait`) jest `mismatch`', () => {
    // Bez tego doctor mówiłby `ok` nad instalacją, w której hook nie ma prawa doczekać
    // odpowiedzi — czyli nad kanałem, który po cichu nie działa.
    const stary = {
      PermissionRequest: [{ hooks: [{ type: 'command', command: `node ${HOOK_SCRIPT}`, timeout: 5 }] }],
      PreToolUse: [{
        matcher: HOOK_QUESTION_MATCHER,
        hooks: [{ type: 'command', command: `node ${HOOK_SCRIPT}`, timeout: 5 }],
      }],
    };
    expect(inspect(putSettings('stare-suffity.json', stary)).status).toBe('mismatch');
  });

  it('wydrukowany blok jest DOKŁADNIE tym, którego szuka doctor', () => {
    const path = putSettings('settings.json', rarogHooks());
    expect(inspect(path).status).toBe('ok');
    // Druga strona równości: wpisy wyłuskane z pliku = wpisy oczekiwane.
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect([...rarogHookEntries(parsed)].sort((a, b) => a.event.localeCompare(b.event)))
      .toEqual([...EXPECTED].sort((a, b) => a.event.localeCompare(b.event)));
  });
});

describe('doctor: ocena pliku ustawień', () => {
  it('`brak`, gdy w pliku stoją WYŁĄCZNIE cudze hooki — i nie rusza ani jednego', () => {
    const path = putSettings('settings.json', null);
    const before = readFileSync(path, 'utf8');

    const result = inspect(path);
    expect(result.status).toBe('missing');
    expect(result.readable).toBe(true);
    expect(result.entries).toEqual([]);
    expect(readFileSync(path, 'utf8'), 'doctor ma prawo TYLKO czytać').toBe(before);
  });

  it('`brak`, gdy pliku nie ma w ogóle', () => {
    const result = inspect(join(dir, 'nie-ma.json'));
    expect(result.status).toBe('missing');
    expect(result.readable).toBe(false);
  });

  it('`mismatch` dla bloku bez `timeout` (domyślne 600 s to dziesięciominutowy zwis)', () => {
    const hooks = rarogHooks() as Record<string, { hooks: Record<string, unknown>[] }[]>;
    for (const groups of Object.values(hooks)) {
      for (const group of groups) delete group.hooks[0]?.['timeout'];
    }
    expect(inspect(putSettings('settings.json', hooks)).status).toBe('mismatch');
  });

  it('`mismatch` dla STAREJ rejestracji `PreToolUse` bez matchera', () => {
    const hooks = rarogHooks() as Record<string, { matcher?: string }[]>;
    delete hooks['PreToolUse']?.[0]?.matcher;
    expect(inspect(putSettings('settings.json', hooks)).status).toBe('mismatch');
  });

  it('`mismatch` dla komendy wskazującej inne repo (przeprowadzka katalogu)', () => {
    const hooks = rarogHooks('node /gdzie/indziej/scripts/hooks/rarog-pending.mjs');
    const result = inspect(putSettings('settings.json', hooks));
    expect(result.status).toBe('mismatch');
    expect(result.entries, 'wpis Raroga ma być ROZPOZNANY, a nie pominięty').toHaveLength(2);
    expect(result.checkout, 'wpis wskazuje checkout repo').toBe(true);
  });

  it('stary wpis z checkoutu → `mismatch` z powodem; wpis kopii → `ok` bez powodu', () => {
    const stary = inspect(putSettings('stary.json', rarogHooks(`node ${HOOK_SCRIPT} --answer-wait=${String(HOOK_ANSWER_WAIT_S)}`)));
    expect(stary).toMatchObject({ status: 'mismatch', checkout: true });
    expect(stary.entries).toHaveLength(2);
    expect(inspect(putSettings('nowy.json', rarogHooks()))).toMatchObject({ status: 'ok', checkout: false });
    // Kopia z cudzego domu jest rozpoznana (nie `brak`), ale to inny wpis niż drukowany.
    expect(inspect(putSettings('obcy.json', rarogHooks(hookCommand('/Users/y'))))).toMatchObject({
      status: 'mismatch', checkout: false,
    });
  });

  it('`mismatch` dla pliku, którego nie da się sparsować — fail-closed', () => {
    const path = join(dir, 'zepsute.json');
    writeFileSync(path, '{ "hooks": ');
    const result = inspect(path);
    expect(result.status).toBe('mismatch');
    expect(result.readable).toBe(false);
  });

  it('wpis Raroga pod obcym zdarzeniem też jest widoczny (nie milczy)', () => {
    const entries = rarogHookEntries({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: hookCommand(HOME) }] }] },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toBe('Stop');
    expect(entries[0]?.timeout, 'brak `timeout` w pliku = brak sufitu, nie „domyślny"').toBeNull();
  });

  it('status łączony: `ok` wygrywa z `brak`, `mismatch` wygrywa z `brak`', () => {
    const ok = inspect(putSettings('user.json', rarogHooks()));
    const none = inspect(putSettings('local.json', null));
    const bad = inspect(putSettings('stare.json', rarogHooks('node /inne/scripts/hooks/rarog-pending.mjs')));

    expect(combineStatus([ok, none])).toBe('ok');
    expect(combineStatus([bad, none])).toBe('mismatch');
    expect(combineStatus([none])).toBe('missing');
    expect(combineStatus([]), 'pusta lista = nic nie wiemy = brak').toBe('missing');
  });

  it('ścieżki obu wariantów instalacji są zbudowane z jednego miejsca', () => {
    expect(userSettingsPath('/Users/x')).toBe('/Users/x/.claude/settings.json');
    expect(localSettingsPath('/repo')).toBe('/repo/.claude/settings.local.json');
  });
});

describe('roots.json — filtr `cwd` po stronie serwera i po stronie hooka', () => {
  it('zapis jest atomowy, prywatny i nie zostawia śmieci', () => {
    writeHookRoots(dir, ['/Users/x/Projects', '/Users/x/Documents/Projects']);

    const file = join(dir, HOOK_ROOTS_FILENAME);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readHookRoots(dir)).toEqual(['/Users/x/Projects', '/Users/x/Documents/Projects']);
  });

  it('nadpisanie przy kolejnym starcie nie zostawia starych korzeni', () => {
    writeHookRoots(dir, ['/a']);
    writeHookRoots(dir, ['/b']);
    expect(readHookRoots(dir)).toEqual(['/b']);
  });

  it('brak pliku i śmieciowa treść dają `null`, nie wyjątek', () => {
    expect(readHookRoots(join(dir, 'nie-ma'))).toBeNull();
    writeFileSync(join(dir, HOOK_ROOTS_FILENAME), '{ zepsute');
    expect(readHookRoots(dir)).toBeNull();
  });

  it('HOOK czyta dokładnie to, co zapisał SERWER (obie strony filtra razem)', async () => {
    const project = join(dir, 'Projects', 'demo');
    mkdirSync(project, { recursive: true });
    writeHookRoots(dir, [join(dir, 'Projects')]);

    await runHook(JSON.stringify({
      session_id: SESSION, cwd: project, hook_event_name: 'PermissionRequest',
      tool_name: 'Bash', tool_input: { command: 'ls' },
    }));

    expect(readPendingHook(dir, SESSION, () => Date.now())?.toolName).toBe('Bash');
    /*
     * Ta sama równość dla ZNACZNIKA: serwer czyta go przez `HOOK_SEEN_FILENAME`, hook pisze
     * własnym literałem. Gdyby obie strony testowały się osobno (tu literał, tam
     * stała), rename stałej po stronie serwera zostawiałby testy zielone, a `/health`
     * mówiłoby na zawsze „hook nie odpalił ani razu" — czyli sygnał, dla którego ten plik
     * powstał, umierałby po cichu.
     */
    expect(readHookSeenAt(dir), 'znacznik `hook-seen.json` nie powstał pod nazwą ze stałej')
      .not.toBeNull();
  });

  it('HOOK zapisuje pytanie dla narzędzia z `HOOK_QUESTION_MATCHER`', async () => {
    /*
     * Matcher `PreToolUse` jest w bloku stałą serwera, a w skrypcie hooka literałem
     * `QUESTION_TOOL`. Test bloku porównywał stałą ze stałą (tautologia): rozjazd rejestrował
     * `PreToolUse` na narzędzie, którego hook nie zapisuje, więc karty pytań cicho wracały
     * do wersji ekranowej. Napędzamy więc hook TĄ SAMĄ stałą, którą blok wpisuje w ustawienia.
     */
    const project = join(dir, 'Projects', 'demo');
    mkdirSync(project, { recursive: true });
    writeHookRoots(dir, [join(dir, 'Projects')]);

    await runHook(JSON.stringify({
      session_id: SESSION, cwd: project, hook_event_name: 'PreToolUse',
      tool_name: HOOK_QUESTION_MATCHER, tool_input: { questions: [] },
    }));

    expect(readPendingHook(dir, SESSION, () => Date.now())?.toolName).toBe(HOOK_QUESTION_MATCHER);
  });

  it('pusta lista korzeni jest zapisywana — i znaczy dla hooka „nigdzie nie pisz"', async () => {
    const project = join(dir, 'Projects', 'demo');
    mkdirSync(project, { recursive: true });
    writeHookRoots(dir, []);
    expect(readHookRoots(dir)).toEqual([]);

    await runHook(JSON.stringify({
      session_id: SESSION, cwd: project, hook_event_name: 'PermissionRequest',
      tool_name: 'Bash', tool_input: { command: 'ls' },
    }));

    expect(readPendingHook(dir, SESSION, () => Date.now())).toBeNull();
  });
});

describe('hookHealth — pole `hook` i `hookSeenAgo` w /health', () => {
  const seen = (at: number): void => {
    writeFileSync(join(dir, HOOK_SEEN_FILENAME), JSON.stringify({ at, event: 'PermissionRequest' }));
  };

  it('składa status z ustawień i kopii oraz wiek ze znacznika hooka', () => {
    const settings = putSettings('settings.json', rarogHooks(hookCommand(dir)));
    putCopy(dir);
    seen(1_000_000);

    expect(hookHealth({ settingsPaths: [settings], dataDir: dir, home: dir, nowMs: 1_012_000 }))
      .toEqual({ status: 'ok', seenAgo: 12 });
  });

  it('bez znacznika mówi `null` — hook nie odpalił ani razu', () => {
    const settings = putSettings('settings.json', rarogHooks(hookCommand(dir)));
    putCopy(dir);
    expect(hookHealth({ settingsPaths: [settings], dataDir: dir, home: dir, nowMs: 5 }))
      .toEqual({ status: 'ok', seenAgo: null });
  });

  it('poprawny wpis bez kopii to `stale`, nie `ok`', () => {
    const settings = putSettings('settings.json', rarogHooks(hookCommand(dir)));
    expect(hookHealth({ settingsPaths: [settings], dataDir: dir, home: dir }).status).toBe('stale');
  });

  it('znacznik z przyszłości daje 0, nigdy liczby ujemnej', () => {
    seen(9_000);
    expect(hookHealth({ settingsPaths: [], dataDir: dir, home: dir, nowMs: 1_000 }).seenAgo).toBe(0);
  });

  it('zepsuty znacznik jest jak jego brak', () => {
    writeFileSync(join(dir, HOOK_SEEN_FILENAME), 'nie json');
    expect(readHookSeenAt(dir)).toBeNull();
    writeFileSync(join(dir, HOOK_SEEN_FILENAME), JSON.stringify({ at: 'wczoraj' }));
    expect(readHookSeenAt(dir)).toBeNull();
  });

  it('brak ustawień = `brak`, a nie awaria', () => {
    expect(hookHealth({ settingsPaths: [join(dir, 'nie-ma.json')], dataDir: dir, home: dir }).status)
      .toBe('missing');
  });
});

describe('podpięcie: package.json i restart.sh', () => {
  it('`hooks:install`, `hooks:print` i `hooks:doctor` wołają podkładkę `scripts/hooks-config.ts`', () => {
    const scripts = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }).scripts;
    expect(scripts['hooks:install']).toBe('tsx scripts/hooks-config.ts install');
    expect(scripts['hooks:print']).toContain('scripts/hooks-config.ts');
    expect(scripts['hooks:doctor']).toContain('scripts/hooks-config.ts');
  });

  it('`restart.sh` wypisuje `hook:` obok `herdr:`/`term:`, a przy `stale` podpowiada `hooks:install`', () => {
    // Degradacja kanału treści (reinstalacja integracji herdr nadpisuje ten sam plik ustawień)
    // jest inaczej całkowicie cicha — restart ma ją pokazywać przy każdym starcie.
    const restart = readFileSync(join(REPO, 'scripts', 'restart.sh'), 'utf8');
    expect(restart).toContain('"hook":');
    expect(restart).toMatch(/herdr: \$herdr · term: \$term · hook:/);
    // Kopia różna od repo: jedna linia podpowiedzi, restartu nie przewraca. Zdanie naprawy przychodzi od
    // `rarog restart` parametrem (`install/repair.ts`), więc skrypt wypisuje parametr, a nie własną komendę.
    expect(restart).toMatch(/"\$hook" = stale[^\n]*\n[^\n]*"\$HOOK_REPAIR"/);
    expect(RESTART_HOOK_REPAIR).toContain('pnpm run hooks:install');
  });
});

/**
 * Kopia hooka w `<home>/.claude/hooks/rarog/` z plików repo — stan po `hooks:install`, bez gita: każdy plik
 * {@link HOOK_INSTALL_FILES}.
 */
function putCopy(home: string, manifest?: Record<string, unknown>): string {
  const target = hookInstallDir(home);
  mkdirSync(target, { recursive: true });
  for (const name of HOOK_INSTALL_FILES) copyFileSync(join(REPO, 'scripts', 'hooks', name), join(target, name));
  if (manifest !== undefined) writeFileSync(join(target, HOOK_MANIFEST_FILENAME), JSON.stringify(manifest));
  return target;
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** Skróty manifestu dla kopii z plików repo: nazwa → sha256 pliku w repo. */
function repoCopyShas(): Record<string, string> {
  return Object.fromEntries(HOOK_INSTALL_FILES.map((name) => [
    name, sha256(readFileSync(join(REPO, 'scripts', 'hooks', name))),
  ]));
}

describe('CLI rarog hooks print / doctor / install (proces)', () => {
  /** Ustawienia `HOME` testu: cudze hooki + blok Raroga z podaną komendą. */
  function putUserSettings(command = hookCommand(dir)): void {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { ...OBCE_HOOKI, ...rarogHooks(command) } }),
    );
    writeHookRoots(join(dir, '.local', 'share', 'rarog'), ['/Users/x/Projects']);
  }

  it('`print` drukuje blok, którego szuka doctor dla tego samego domu', async () => {
    const result = await runCli(['print'], { HOME: dir });

    expect(result.code).toBe(0);
    const start = result.stdout.indexOf('{');
    const end = result.stdout.lastIndexOf('}');
    const block = JSON.parse(result.stdout.slice(start, end + 1)) as Record<string, unknown>;
    // Blok zgód i hook kontekstu `SessionStart` w jednym obiekcie `hooks`; doctor szuka zgód tylko w części
    // `hookBlock`, wpis kontekstu ma własny stan (`server/test/hook-context.test.ts`). The block carries all five
    // entries: also `statusLine`, the Rarog `denyRead` paths and the write block rules.
    const paste = pasteHookBlock(hookCommand(dir), contextHookCommand(dir)) as Record<string, unknown>;
    const status = statuslineBlock(statuslineCommand(dir)) as Record<string, unknown>;
    expect(Object.keys(block)).toEqual(['hooks', 'statusLine', 'sandbox', 'permissions']);
    expect(block['hooks']).toEqual(paste['hooks']);
    expect(block['statusLine']).toEqual(status['statusLine']);
    expect(JSON.stringify(block['sandbox'])).toContain('"denyRead":["~/.config/rarog/secret",');
    const rules = writeBlockRules(join(dir, '.local', 'share', 'rarog'), dir);
    expect(block['permissions']).toEqual({ deny: rules.ok ? rules.rules : [] });
    expect(rarogHookEntries(block)).toEqual(rarogHookEntries(hookBlock(hookCommand(dir))));
    // Instrukcja ma mówić, że to WKLEJENIE, a nie automatyczny zapis.
    expect(result.stdout).toContain('Paste this block');
    expect(result.stdout).toContain('.claude/settings.json');
    // Kopia powstaje osobną, ręczną komendą.
    expect(result.stdout).toContain('pnpm run hooks:install');
  });

  it('`print --local` kieruje do `settings.local.json`, blok wskazuje tę samą kopię', async () => {
    const result = await runCli(['print', '--local'], { HOME: dir });
    expect(result.stdout).toContain('settings.local.json');
    for (const command of [hookCommand(dir), contextHookCommand(dir), statuslineCommand(dir)]) {
      expect(result.stdout).toContain(JSON.stringify(command));
    }
  });

  it('`statusline` drukuje blok `statusLine` wskazujący kopię skryptu; `--chain` dokłada łańcuch', async () => {
    const plain = await runCli(['statusline'], { HOME: dir });
    expect(plain.code).toBe(0);
    const block = (text: string): unknown => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    expect(block(plain.stdout)).toEqual(statuslineBlock(statuslineCommand(dir)));
    expect(statuslineCommand(dir)).toBe(`node '${dir}/.claude/hooks/rarog/rarog-statusline.mjs'`);
    expect(plain.stdout).toContain('Paste this block');
    expect(plain.stdout).toContain('rarog hooks install');

    const chained = await runCli(['statusline', '--chain', "bash ~/.claude/moj pasek.sh 'x'"], { HOME: dir });
    expect(chained.code).toBe(0);
    expect(block(chained.stdout)).toEqual(statuslineBlock(
      `RAROG_STATUSLINE_CHAIN='bash ~/.claude/moj pasek.sh '\\''x'\\''' node '${dir}/.claude/hooks/rarog/rarog-statusline.mjs'`,
    ));
  });

  it('`--chain` bez wartości albo przy innej komendzie niż `statusline` = użycie (64)', async () => {
    for (const args of [['statusline', '--chain'], ['print', '--chain', 'x'], ['statusline', '--chain', ' ']]) {
      const result = await runCli(args, { HOME: dir });
      expect(result, args.join(' ')).toMatchObject({ code: 64, stdout: '' });
    }
  });

  it('`doctor` na koncie z blokiem i kopią zgodną z repo kończy się zerem', async () => {
    putUserSettings();
    putCopy(dir);

    const result = await runCli(['doctor'], { HOME: dir });
    expect(result.stdout).toContain('hook: ok');
    expect(result.stdout).toContain(`copy:    ${hookInstallDir(dir)}`);
    for (const name of HOOK_INSTALL_FILES) expect(result.stdout).toContain(`${name}: matches the repo`);
    // Kopia sprzed skryptu `statusLine` (dwa pliki hooka): hook dalej `ok`, skrypt pokazany osobno jako brak.
    expect(result.stdout).toContain('rarog-statusline.mjs: missing (statusLine script, outside the hook state)');
    expect(result.stdout).toContain(HOOK_ROOTS_FILENAME);
    expect(result.code).toBe(0);
  });

  it('`doctor` bez bloku mówi `brak`, kodem wyjścia też', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: OBCE_HOOKI }));

    const result = await runCli(['doctor'], { HOME: dir });
    expect(result.stdout).toContain('hook: missing');
    expect(result.stdout).toContain('hooks:install');
    expect(result.stdout).toContain('hooks:print');
    expect(result.code).toBe(1);
  });

  it('`doctor`: zmieniony bajt kopii → `stale` z nazwą pliku i ostrzeżeniem, kod ≠ 0', async () => {
    putUserSettings();
    const files = repoCopyShas();
    const target = putCopy(dir, { commit: 'a'.repeat(40), at: 1, files });
    writeFileSync(join(target, 'tall-dialog.mjs'), '\n', { flag: 'a' });

    const result = await runCli(['doctor'], { HOME: dir });
    expect(result.stdout).toContain('hook: stale');
    expect(result.stdout).toContain('tall-dialog.mjs: differs from the repo');
    expect(result.stdout).toContain('copy changed AFTER the install');
    expect(result.code).toBe(1);
  });

  it('`doctor`: plik z poprzedniego manifestu w kopii → `stale` z nazwą pliku i naprawą `hooks:install`', async () => {
    putUserSettings();
    const target = putCopy(dir);
    writeFileSync(join(target, OLD_ENTRY_FILE), '// poprzednia instalacja\n');
    const files = { ...repoCopyShas(), [OLD_ENTRY_FILE]: sha256(readFileSync(join(target, OLD_ENTRY_FILE))) };
    writeFileSync(join(target, HOOK_MANIFEST_FILENAME), JSON.stringify({ commit: 'a'.repeat(40), at: 1, files }));

    const result = await runCli(['doctor'], { HOME: dir });
    expect(result.stdout).toContain('hook: stale');
    for (const name of HOOK_INSTALL_FILES) expect(result.stdout).toContain(`${name}: matches the repo`);
    expect(result.stdout).toContain(`  ${OLD_ENTRY_FILE}: ${HOOK_LEFTOVER_TEXT}`);
    expect(result.stdout).toContain(HOOK_REPAIR_COPY);
    expect(result.code).toBe(1);
  });

  it('`doctor`: repo zmienione od instalacji → `stale` z `git log <commit>..HEAD` przed `hooks:install`', async () => {
    putUserSettings();
    const target = putCopy(dir);
    writeFileSync(join(target, 'rarog-pending.mjs'), '// stara wersja\n');
    const files = Object.fromEntries(HOOK_INSTALL_FILES.map((name) => [name, sha256(readFileSync(join(target, name)))]));
    writeFileSync(join(target, HOOK_MANIFEST_FILENAME), JSON.stringify({ commit: 'b'.repeat(40), at: 1, files }));

    const result = await runCli(['doctor'], { HOME: dir });
    expect(result.stdout).toContain('hook: stale');
    expect(result.stdout).toContain('rarog-pending.mjs: differs from the repo');
    expect(result.stdout).toContain(`git log ${'b'.repeat(40)}..HEAD -- scripts/hooks`);
    expect(result.stdout).toContain('pnpm run hooks:install');
    expect(result.code).toBe(1);
  });

  it('`doctor`: manifest z datą poza zakresem `Date` → „nieczytelny”, diagnostyka bez wyjątku', async () => {
    putUserSettings();
    const files = repoCopyShas();
    putCopy(dir, { commit: 'a'.repeat(40), at: 1e20, files });

    const result = await runCli(['doctor'], { HOME: dir });
    expect(result.stderr).not.toContain('RangeError');
    expect(result.stdout).toContain(`${HOOK_MANIFEST_FILENAME}: missing or unreadable`);
    expect(result.stdout).toContain('hook: ok');
    expect(result.stdout).toContain(HOOK_ROOTS_FILENAME);
    expect(result.code).toBe(0);
  });

  it('`doctor`: poprawny wpis bez kopii → `stale`, kod ≠ 0', async () => {
    putUserSettings();
    const result = await runCli(['doctor'], { HOME: dir });
    expect(result.stdout).toContain('hook: stale');
    expect(result.stdout).toContain('missing');
    expect(result.stdout).toContain('pnpm run hooks:install');
    expect(result.code).toBe(1);
  });

  it('`doctor`: stary wpis z checkoutu → `mismatch` z powodem', async () => {
    putUserSettings(`node ${HOOK_SCRIPT} --answer-wait=${String(HOOK_ANSWER_WAIT_S)}`);
    putCopy(dir);
    const result = await runCli(['doctor'], { HOME: dir });
    expect(result.stdout).toContain('hook: mismatch');
    expect(result.stdout).toContain('points at the repo checkout');
    expect(result.code).toBe(1);
  });

  /** Atrapa `herdr` w `<dir>/bin`: na `integration status` wypisuje `lines`, każde wywołanie loguje. */
  function fakeHerdr(lines: readonly string[]): string {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const file = join(bin, 'herdr');
    writeFileSync(file, ['#!/bin/sh', `printf '%s\\n' "$*" >> '${join(dir, 'herdr.log')}'`,
      'if [ "$1 $2" = "integration status" ]; then', ...lines.map((one) => `  echo '${one}'`), 'fi', 'exit 0', ''].join('\n'));
    chmodSync(file, 0o755);
    return bin;
  }

  it('`doctor`: herdr bez integracji Claude → linia z `herdr integration install claude`, kod jak dziś, bez instalacji', async () => {
    putUserSettings();
    putCopy(dir);
    const bin = fakeHerdr(['pi: not installed (/x/.pi/agent/extensions/herdr-agent-state.ts)',
      `claude: not installed (${dir}/.claude/hooks/herdr-agent-state.sh)`]);
    const result = await runCli(['doctor'], { HOME: dir, PATH: `${bin}:/usr/bin:/bin` });
    expect(result.stdout).toContain('hook: ok');
    expect(result.stdout).toContain('MISSING herdr integration for Claude Code (not installed');
    expect(result.stdout).toContain('`herdr integration install claude`');
    expect(result.code, 'integracja nie zmienia kodu wyjścia hooks:doctor').toBe(0);
    expect(readFileSync(join(dir, 'herdr.log'), 'utf8')).toBe('integration status\n');
  });

  it('`doctor`: integracja `current` → linia ze stanem; bez herdr → „not checked”', async () => {
    putUserSettings();
    putCopy(dir);
    const bin = fakeHerdr(['claude: current (v11) (/x/.claude/hooks/herdr-agent-state.sh)']);
    const current = await runCli(['doctor'], { HOME: dir, PATH: `${bin}:/usr/bin:/bin` });
    expect(current.stdout).toContain('herdr integration for Claude Code: current (v11)');
    expect(current.stdout).not.toContain('herdr integration install claude');
    const none = await runCli(['doctor'], { HOME: dir, PATH: '/usr/bin:/bin' });
    expect(none.stdout).toContain('herdr integration for Claude Code: not checked (no herdr');
    expect(none.code).toBe(current.code);
  });

  it('`install`: `rarog` jako dowiązanie → odmowa z kodem 1, cel nietknięty', async () => {
    const target = join(dir, 'cel');
    mkdirSync(target);
    mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true });
    symlinkSync(target, hookInstallDir(dir));

    const result = await runCli(['install'], { HOME: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is a symlink');
    expect(readdirSync(target)).toEqual([]);
  });

  it('podkładka `pnpm run hooks:*` (tsx `scripts/hooks-config.ts`) mówi to samo co `rarog hooks`', async () => {
    putUserSettings();
    putCopy(dir);
    for (const args of [['print'], ['print', '--local'], ['doctor'], []]) {
      const viaRarog = await runCli(args, { HOME: dir });
      const viaShim = await runShim(args, { HOME: dir });
      expect(viaShim, args.join(' ')).toEqual(viaRarog);
    }
    // Złe wywołanie: podkładka zostaje przy dawnym komunikacie i kodzie 2, `rarog hooks` ma 64 jak reszta CLI.
    const shimBad = await runShim(['nic'], { HOME: dir });
    expect(shimBad).toMatchObject({ code: 2, stdout: '' });
    expect(shimBad.stderr).toBe('Usage: hooks-config.ts [install|print|doctor] [--local]\n');
    const rarogBad = await runCli(['nic'], { HOME: dir });
    expect(rarogBad).toMatchObject({ code: 64, stdout: '' });
    expect(rarogBad.stderr).toBe('rarog hooks: unknown subcommand or option.\nRun rarog hooks --help.\n');
  });
});

describe('lineDiff: hunki różnicy linii', () => {
  it('teksty równe → pusto; jedna zmieniona linia → hunk z kontekstem i numerami linii', () => {
    expect(lineDiff('a\nb\n', 'a\nb\n')).toEqual([]);
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
    const after = ['1', '2', '3', '4', 'X', '6', '7', '8', '9'].join('\n');
    expect(lineDiff(before, after)).toEqual(['@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+X', ' 6', ' 7', ' 8']);
  });

  it('dopisek na początku i na końcu, dwa odległe zmiany = dwa hunki', () => {
    expect(lineDiff('a\nb', 'nowa\na\nb', 1)).toEqual(['@@ -1,1 +1,2 @@', '+nowa', ' a']);
    expect(lineDiff('a\nb', 'a\nb\nkoniec', 0)).toEqual(['@@ -2,0 +3,1 @@', '+koniec']);
    const lines = Array.from({ length: 20 }, (_, i) => String(i));
    const changed = lines.map((one, i) => (i === 1 || i === 18 ? `${one}!` : one));
    expect(lineDiff(lines.join('\n'), changed.join('\n'), 1).filter((one) => one.startsWith('@@'))).toEqual([
      '@@ -1,3 +1,3 @@', '@@ -18,3 +18,3 @@',
    ]);
  });

  it('hunk ze 150 000 linii (pod limitem 1 MB, także ponad progiem tablicy LCS) → bez wyjątku', () => {
    const added = '//x\n'.repeat(150_000);
    expect(lineDiff('a\nb\n', `a\nb\n${added}`)).toHaveLength(1 + 2 + 150_000 + 1);
    const before = Array.from({ length: 2500 }, (_, i) => `a${String(i)}`).join('\n');
    expect(lineDiff(before, added)).toHaveLength(1 + 2500 + 150_001);
  });
});

describe('tryb paczki: kopia hooka z katalogu instalacji', () => {
  /** Pliki źródłowe kopii: pliki hooka i skrypt `statusLine`. */
  const SOURCES = [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES];
  let t: TempHome;
  let home = '';
  let pkg = '';

  /** Katalog paczki: `package.json` z wersją i `scripts/hooks/` z plików repo. */
  function putPackage(version: string): void {
    mkdirSync(join(pkg, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'rarog', version }));
    for (const name of SOURCES) copyFileSync(join(REPO, 'scripts', 'hooks', name), join(pkg, 'scripts', 'hooks', name));
  }

  /** Bajty każdego pliku w kopii (nazwa → treść); pusty obiekt bez katalogu. */
  function copyState(): Record<string, string> {
    const target = hookInstallDir(home);
    if (!existsSync(target)) return {};
    return Object.fromEntries(readdirSync(target).sort().map((name) => [name, readFileSync(join(target, name), 'utf8')]));
  }

  const git = spawnGitArgs(gitReadEnv({ PATH: process.env['PATH'] ?? '', HOME: '/nonexistent' }));
  const options = (review?: (diff: HookCopyReview) => Promise<boolean>): HookInstallOptions => ({
    home, root: pkg, mode: 'package', git, serviceRefusal: () => null, ...(review === undefined ? {} : { review }),
  });

  beforeEach(() => {
    t = tempHome('rarog-hook-paczka-');
    home = join(t.home, 'h');
    pkg = join(t.home, 'lib', 'node_modules', 'rarog');
    mkdirSync(join(home, '.claude'), { recursive: true });
    putPackage('9.9.9');
  });

  afterEach(() => { t.cleanup(); });

  afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

  it('pierwsza instalacja: różnica z samymi nowymi plikami (rozmiar, skrót, ścieżka), zapis po „t”', async () => {
    const seen: HookCopyReview[] = [];
    const result = await installHookCopy(options((diff) => {
      seen.push(diff);
      return Promise.resolve(true);
    }));
    expect(result).toMatchObject({ ok: true, commit: null, version: '9.9.9' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.changes.map((one) => one.state)).toEqual(seen[0]?.changes.map(() => 'new'));
    const text = renderHookCopyReview(seen[0] as HookCopyReview);
    expect(text).toContain('against package version 9.9.9');
    expect(text).toContain(`+ tall-dialog.mjs: new file, ${String(statSync(join(pkg, 'scripts', 'hooks', 'tall-dialog.mjs')).size)} B`);
    expect(text).toContain(`content: ${join(pkg, 'scripts', 'hooks', 'tall-dialog.mjs')}`);
    const manifest = JSON.parse(copyState()[HOOK_MANIFEST_FILENAME] ?? '{}') as Record<string, unknown>;
    expect(manifest['version']).toBe('9.9.9');
    expect(manifest).not.toHaveProperty('commit');
    expect(hookCopyReport(home, pkg)).toMatchObject({ ok: true, manifest: { version: '9.9.9', commit: null } });
  });

  it('kopia równa paczce → zapis bez pytania; manifest z klonu (`commit`) przechodzi na `version`', async () => {
    const target = hookInstallDir(home);
    mkdirSync(target, { recursive: true });
    const files: Record<string, string> = {};
    for (const name of SOURCES) {
      copyFileSync(join(pkg, 'scripts', 'hooks', name), join(target, name));
      files[name] = sha256(readFileSync(join(target, name)));
    }
    writeFileSync(join(target, HOOK_MANIFEST_FILENAME), JSON.stringify({ commit: 'c'.repeat(40), at: 1, files }));
    expect(hookCopyReport(home, pkg).manifest).toMatchObject({ commit: 'c'.repeat(40), version: null });
    let asked = 0;
    const result = await installHookCopy(options(() => {
      asked += 1;
      return Promise.resolve(false);
    }));
    expect(result).toMatchObject({ ok: true, version: '9.9.9' });
    expect(asked).toBe(0);
    expect(hookCopyReport(home, pkg).manifest).toMatchObject({ commit: null, version: '9.9.9', files });
  });

  it('zmieniony bajt w paczce → różnica przed zapisem; „t” zapisuje bufory z różnicy, nie drugi odczyt', async () => {
    expect((await installHookCopy(options(() => Promise.resolve(true)))).ok).toBe(true);
    const before = copyState();
    const source = join(pkg, 'scripts', 'hooks', 'tall-dialog.mjs');
    writeFileSync(source, '// zmiana w paczce\n', { flag: 'a' });
    const shown = readFileSync(source);
    putPackage('9.9.10');
    writeFileSync(source, shown);
    let review: HookCopyReview | null = null;
    const result = await installHookCopy(options((diff) => {
      review = diff;
      expect(copyState(), 'przed odpowiedzią kopia nietknięta').toEqual(before);
      // Podmiana źródła w trakcie pytania: zapis ma wziąć bajty, które człowiek widział.
      writeFileSync(source, '// podmiana w trakcie pytania\n', { flag: 'a' });
      return Promise.resolve(true);
    }));
    expect(result).toMatchObject({ ok: true, version: '9.9.10' });
    const got = review as HookCopyReview | null;
    const changed = got?.changes.find((one) => one.name === 'tall-dialog.mjs');
    expect(changed?.state).toBe('changed');
    expect(changed?.diff).toContain('+// zmiana w paczce');
    expect(got?.changes.filter((one) => one.state !== 'match').map((one) => one.name)).toEqual(['tall-dialog.mjs']);
    expect(got === null ? '' : renderHookCopyReview(got)).toContain('current copy: version 9.9.9');
    expect(readFileSync(join(hookInstallDir(home), 'tall-dialog.mjs'))).toEqual(shown);
  });

  it('„nie” na pytanie → kopia bez zmian, odmowa z `declined`', async () => {
    expect((await installHookCopy(options(() => Promise.resolve(true)))).ok).toBe(true);
    writeFileSync(join(pkg, 'scripts', 'hooks', 'canon.mjs'), '// zmiana\n', { flag: 'a' });
    const before = copyState();
    const result = await installHookCopy(options(() => Promise.resolve(false)));
    expect(result).toMatchObject({ ok: false, declined: true });
    expect(copyState()).toEqual(before);
  });

  it('plik z poprzedniego manifestu: różnica go pokazuje, „nie” go zostawia; sam plik do usunięcia bez pytania', async () => {
    expect((await installHookCopy(options(() => Promise.resolve(true)))).ok).toBe(true);
    const target = hookInstallDir(home);
    const leftover = join(target, OLD_ENTRY_FILE);
    writeFileSync(leftover, '// poprzednia instalacja\n');
    const manifestPath = join(target, HOOK_MANIFEST_FILENAME);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Record<string, string> };
    manifest.files[OLD_ENTRY_FILE] = sha256(readFileSync(leftover));
    writeFileSync(manifestPath, JSON.stringify(manifest));

    writeFileSync(join(pkg, 'scripts', 'hooks', 'canon.mjs'), '// zmiana\n', { flag: 'a' });
    let shown = '';
    const declined = await installHookCopy(options((diff) => {
      shown = renderHookCopyReview(diff);
      return Promise.resolve(false);
    }));
    expect(declined).toMatchObject({ ok: false, declined: true });
    expect(shown).toContain(`  - ${OLD_ENTRY_FILE}: to be removed from the copy (file from a previous install`);
    expect(existsSync(leftover)).toBe(true);

    // Kopia równa paczce, został tylko plik do usunięcia: zapis bez pytania, bo usunięcie nie wnosi kodu.
    const equal = readFileSync(join(target, 'canon.mjs'));
    writeFileSync(join(pkg, 'scripts', 'hooks', 'canon.mjs'), equal);
    let asked = 0;
    const result = await installHookCopy(options(() => {
      asked += 1;
      return Promise.resolve(false);
    }));
    expect(result).toMatchObject({ ok: true, removed: [OLD_ENTRY_FILE] });
    expect(asked).toBe(0);
    expect(existsSync(leftover)).toBe(false);
  });

  it('bez terminala (bez `review`) → odmowa z różnicą do wydruku, nic nie zapisane', async () => {
    for (const install of [
      (): Promise<HookInstallResult> => installHookCopy(options()),
      (): Promise<HookInstallResult> => installMissingHookCopy(options()),
      (): Promise<HookInstallResult> => installStatuslineCopy(options()),
    ]) {
      const result = await install();
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toContain('rarog hooks install');
      expect(result.review?.changes.length).toBeGreaterThan(0);
      expect(existsSync(hookInstallDir(home))).toBe(false);
    }
  });

  it('`package.json` paczki bez wersji albo FIFO w miejscu pliku hooka → odmowa przed pytaniem', async () => {
    let asked = 0;
    const counting = options(() => {
      asked += 1;
      return Promise.resolve(true);
    });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'rarog' }));
    expect(await installHookCopy(counting)).toMatchObject({ ok: false, reason: expect.stringContaining('"version"') });
    putPackage('9.9.9');
    rmSync(join(pkg, 'scripts', 'hooks', 'canon.mjs'));
    execFileSync('mkfifo', [join(pkg, 'scripts', 'hooks', 'canon.mjs')]);
    expect(await installHookCopy(counting)).toMatchObject({
      ok: false, reason: expect.stringContaining('scripts/hooks/canon.mjs: not a regular file'),
    });
    expect(asked).toBe(0);
    expect(existsSync(hookInstallDir(home))).toBe(false);
  });

  it('różnica pokazuje znaki sterujące, kierunku pisma i zerowej szerokości jako `\\u{…}`, a dosłowny `\\` jako `\\\\`', async () => {
    expect((await installHookCopy(options(() => Promise.resolve(true)))).ok).toBe(true);
    const hidden = `// ok${String.fromCodePoint(0x1b)}[2K${String.fromCodePoint(0x0d)}`
      + `${String.fromCodePoint(0x202e)}x${String.fromCodePoint(0x200b)}\tkoniec\n`;
    writeFileSync(join(pkg, 'scripts', 'hooks', 'canon.mjs'), hidden, { flag: 'a' });
    let text = '';
    await installHookCopy(options((diff) => {
      text = renderHookCopyReview(diff);
      return Promise.resolve(false);
    }));
    expect(text).toContain('+// ok\\u{1b}[2K\\u{d}\\u{202e}x\\u{200b}\tkoniec');
    for (const code of [0x1b, 0x0d, 0x202e, 0x200b]) expect(text).not.toContain(String.fromCodePoint(code));
    expect(visibleLine(`a${String.fromCodePoint(0x9b)}b${String.fromCodePoint(0x2066)}`)).toBe('a\\u{9b}b\\u{2066}');
    expect(visibleLine('\\u{d}')).not.toBe(visibleLine('\r'));
    expect(visibleLine('/\\d+/\r')).toBe('/\\\\d+/\\u{d}');
  });

  it('bajty spoza UTF-8 → ostrzeżenie w różnicy; o zmianie rozstrzyga sha256', async () => {
    expect((await installHookCopy(options(() => Promise.resolve(true)))).ok).toBe(true);
    const source = join(pkg, 'scripts', 'hooks', 'canon.mjs');
    writeFileSync(source, Buffer.concat([readFileSync(source), Buffer.from([0xff, 0x0a])]));
    let text = '';
    await installHookCopy(options((diff) => {
      text = renderHookCopyReview(diff);
      return Promise.resolve(false);
    }));
    expect(text).toContain('~ canon.mjs: sha256');
    expect(text).toContain('is not valid UTF-8');
  });

  it('manifest w obu kształtach: `commit`, `version`, oba; zły zapis albo brak obu → nieczytelny', () => {
    const target = hookInstallDir(home);
    mkdirSync(target, { recursive: true });
    const put = (body: unknown): HookCopyReport['manifest'] => {
      writeFileSync(join(target, HOOK_MANIFEST_FILENAME), JSON.stringify(body));
      return hookCopyReport(home, pkg).manifest;
    };
    const commit = 'd'.repeat(40);
    expect(put({ commit, at: 1, files: {} })).toEqual({ commit, version: null, at: 1, files: {} });
    expect(put({ version: '1.0.0-rc.1', at: 2, files: {} })).toEqual({ commit: null, version: '1.0.0-rc.1', at: 2, files: {} });
    expect(put({ commit, version: '1.0.0', at: 3, files: {} })).toMatchObject({ commit, version: '1.0.0' });
    expect(put({ at: 4, files: {} })).toBeNull();
    expect(put({ version: '1.0 0', at: 5, files: {} })).toBeNull();
    expect(put({ version: 'x'.repeat(65), at: 5, files: {} })).toBeNull();
    expect(put({ commit: 'zły', version: '1.0.0', at: 6, files: {} })).toBeNull();
  });

  describe('CLI `rarog hooks install` i `doctor` w paczce', () => {
    const TARGET = (): HookInstallTarget => ({ mode: 'package', root: pkg });

    /** `rarog hooks <args>` w procesie testu: odpowiedzi z `answers` (brak = bez terminala). */
    async function hooks(args: readonly string[], answers?: (string | null)[], platform?: NodeJS.Platform): Promise<{
      code: number; stdout: string; stderr: string; prompts: string[];
    }> {
      let stdout = '';
      let stderr = '';
      const prompts: string[] = [];
      const io: CliIo = {
        stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
        env: { PATH: process.env['PATH'] ?? '', HOME: home }, cwd: t.home,
        ...(platform === undefined ? {} : { platform }),
        ...(answers === undefined ? {} : {
          ask: (prompt: string) => {
            prompts.push(prompt);
            stdout += prompt;
            return Promise.resolve(answers.shift() ?? null);
          },
        }),
      };
      const code = await hooksCommand(args, io, 'użycie', 64, TARGET());
      return { code, stdout, stderr, prompts };
    }

    it('różnica na ekranie PRZED pytaniem; „n” → kod 1, kopia bez zmian; „t” → zapis i wersja w wyniku', async () => {
      // Pierwsze „t” = kopia, drugie = wpisy hooka w `~/.claude/settings.json`; potem wpisy są bieżące.
      expect((await hooks(['install'], ['t', 't'])).code).toBe(0);
      writeFileSync(join(pkg, 'scripts', 'hooks', 'tall-dialog.mjs'), '// bajt\n', { flag: 'a' });
      const before = copyState();

      const no = await hooks(['install'], ['n']);
      expect(no.prompts).toEqual([`Write these files to ${hookInstallDir(home)}? [y/N] `]);
      expect(no.stdout.indexOf('+// bajt')).toBeGreaterThan(-1);
      expect(no.stdout.indexOf('+// bajt')).toBeLessThan(no.stdout.indexOf('Write these files'));
      expect(no.code).toBe(1);
      expect(no.stderr).toContain('was not approved');
      expect(copyState()).toEqual(before);

      const yes = await hooks(['install'], ['t']);
      expect(yes.code).toBe(0);
      expect(yes.stdout).toContain(`Hook copy in ${hookInstallDir(home)} (version 9.9.9):`);
      expect(readFileSync(join(hookInstallDir(home), 'tall-dialog.mjs'), 'utf8')).toMatch(/\/\/ bajt\n$/);
    });

    it('bez terminala: różnica wydrukowana, odmowa z kodem 1; kopia równa paczce idzie bez pytania', async () => {
      const refused = await hooks(['install']);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toContain('+ rarog-pending.mjs: new file');
      expect(refused.stderr).toContain('hooks:install: refused — the copy differs from the package');
      expect(existsSync(hookInstallDir(home))).toBe(false);

      expect((await hooks(['install'], ['t', 't'])).code).toBe(0);
      const again = await hooks(['install']);
      expect(again.code).toBe(0);
      expect(again.prompts).toEqual([]);
    });

    it('usługa startuje inną instalację (plik jednostki): odmowa z komendą przed różnicą i pytaniem, kopii brak', async () => {
      const unit = join(home, '.config', 'systemd', 'user', 'rarog.service');
      mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
      const unitFor = (bin: string): string => `[Service]\nExecStart=${renderExecStart(['/opt/n/bin/node', bin, 'serve'])}\n`;
      writeFileSync(unit, unitFor('/opt/klon/bin/rarog.mjs'));

      const refused = await hooks(['install'], ['t'], 'linux');
      expect(refused.code).toBe(1);
      expect(refused.prompts).toEqual([]);
      expect(refused.stdout).not.toContain('Diff of the copy');
      expect(refused.stderr).toContain('hooks:install: refused — the service points to another installation'
        + ' (/opt/klon/bin/rarog.mjs, the file is gone)');
      expect(refused.stderr).toContain("The service's installation installs the copy: `'/opt/n/bin/node' '/opt/klon/bin/rarog.mjs'"
        + ' hooks install`; or first point the service at this installation (`rarog service install`), then'
        + ' `rarog hooks install`.');
      expect(existsSync(hookInstallDir(home))).toBe(false);

      // Plik jednostki nie z `rarog service install`: celu nie widać, więc też odmowa bez zapisu.
      writeFileSync(unit, '[Service]\nExecStart=/opt/n/bin/node /opt/klon/bin/rarog.mjs serve\n');
      const unknown = await hooks(['install'], ['t'], 'linux');
      expect(unknown.code).toBe(1);
      expect(unknown.prompts).toEqual([]);
      expect(unknown.stderr).toContain('cannot tell which installation the service starts');
      expect(existsSync(hookInstallDir(home))).toBe(false);

      // Usługa tej paczki: różnica, pytanie i zapis jak bez usługi (wpisy hooka już bieżące, więc jedno pytanie).
      writeFileSync(unit, unitFor(join(pkg, 'bin', 'rarog.mjs')));
      writeFileSync(userSettingsPath(home), JSON.stringify(hookBlock(hookCommand(home))));
      const own = await hooks(['install'], ['t'], 'linux');
      expect(own.code).toBe(0);
      expect(own.prompts).toHaveLength(1);
      expect(existsSync(join(hookInstallDir(home), 'rarog-pending.mjs'))).toBe(true);
    });

    it('`.claude` dowiązane do `.claude` innego domu: odmowa bez zapisu; dowiązany `settings.json` nie przeszkadza', async () => {
      const other = join(t.home, 'inny-dom');
      mkdirSync(join(other, '.claude'), { recursive: true });
      rmSync(join(home, '.claude'), { recursive: true });
      symlinkSync(join(other, '.claude'), join(home, '.claude'));
      const refused = await hooks(['install'], ['t']);
      expect(refused.code).toBe(1);
      expect(refused.prompts).toEqual([]);
      expect(refused.stderr).toContain(`the copy directory leads outside HOME through a symlink: ${join(home, '.claude')} → `);
      expect(readdirSync(join(other, '.claude'))).toEqual([]);

      // Dowiązanie wewnątrz HOME (np. do katalogu dotfiles w domu) nie wychodzi poza HOME: instalacja jak zawsze.
      rmSync(join(home, '.claude'));
      mkdirSync(join(home, 'dotfiles', 'claude'), { recursive: true });
      symlinkSync(join(home, 'dotfiles', 'claude'), join(home, '.claude'));
      expect((await hooks(['install'], ['t', 't'])).code).toBe(0);
      expect(existsSync(join(home, 'dotfiles', 'claude', 'hooks', 'rarog', 'rarog-pending.mjs'))).toBe(true);

      // Zwykły `.claude` z `settings.json` dowiązanym do pliku poza HOME: instalacja jak zawsze.
      rmSync(join(home, '.claude'));
      mkdirSync(join(home, '.claude'));
      writeFileSync(join(other, 'settings.json'), '{}\n');
      symlinkSync(join(other, 'settings.json'), join(home, '.claude', 'settings.json'));
      const own = await hooks(['install'], ['t', 't']);
      expect(own.code).toBe(0);
      expect(existsSync(join(hookInstallDir(home), 'rarog-pending.mjs'))).toBe(true);
      // Wpisy idą do celu dowiązania, a dowiązanie zostaje dowiązaniem.
      expect(JSON.parse(readFileSync(join(other, 'settings.json'), 'utf8'))).toEqual(hookBlock(hookCommand(home)));
      expect(readlinkSync(join(home, '.claude', 'settings.json'))).toBe(join(other, 'settings.json'));
    });

    it('plik usługi jest, ale go nie widać (wiszące dowiązanie, katalog bez prawa przejścia): odmowa, kopii brak', async () => {
      const units = join(home, '.config', 'systemd', 'user');
      const agents = join(home, 'Library', 'LaunchAgents');
      mkdirSync(units, { recursive: true });
      mkdirSync(agents, { recursive: true });
      symlinkSync(join(home, 'nie-ma'), join(units, 'rarog.service'));
      symlinkSync(join(home, 'nie-ma'), join(agents, 'ai.rarog.server.plist'));
      for (const platform of ['linux', 'darwin'] as const) {
        const dangling = await hooks(['install'], ['t'], platform);
        expect(dangling.code).toBe(1);
        expect(dangling.prompts).toEqual([]);
        expect(dangling.stderr).toContain('cannot tell which installation the service starts');
        expect(existsSync(hookInstallDir(home))).toBe(false);
      }

      rmSync(join(units, 'rarog.service'));
      writeFileSync(join(units, 'rarog.service'), '[Service]\n');
      chmodSync(units, 0o000);
      try {
        const hidden = await hooks(['install'], ['t'], 'linux');
        expect(hidden.code).toBe(1);
        expect(hidden.prompts).toEqual([]);
        expect(hidden.stderr).toContain(`cannot tell which installation the service starts (cannot check ${units}/rarog.service`
          + ' (EACCES))');
      } finally {
        chmodSync(units, 0o700);
      }
      expect(existsSync(hookInstallDir(home))).toBe(false);
    });

    it('`doctor` przy `stale`: „kopia: wersja A; źródło: paczka w wersji B” zamiast `git log`', async () => {
      expect((await hooks(['install'], ['t', 't'])).code).toBe(0);
      writeFileSync(userSettingsPath(home), JSON.stringify(hookBlock(hookCommand(home))));
      putPackage('9.9.10');
      writeFileSync(join(pkg, 'scripts', 'hooks', 'rarog-pending.mjs'), '// nowa wersja\n', { flag: 'a' });

      const result = await hooks(['doctor']);
      expect(result.stdout).toContain('hook: stale');
      expect(result.stdout).toContain(`${HOOK_MANIFEST_FILENAME}: version 9.9.9,`);
      expect(result.stdout).toContain('copy: version 9.9.9; source: package version 9.9.10');
      expect(result.stdout).toContain('`rarog hooks install` shows the diff before writing and asks.');
      expect(result.stdout).toContain('Fix: `rarog hooks install`');
      expect(result.stdout).not.toContain('git log');
      expect(result.code).toBe(1);
    });
  });
});

/** Odpala hook jako proces (kontrakt jest procesowy: stdin → plik, exit 0, pusty stdout). */
function runHook(stdin: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT], {
      env: { PATH: process.env['PATH'] ?? '', HOME: dir, RAROG_DATA_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout }); });
    child.stdin.end(stdin);
  });
}

/** Odpala `node bin/rarog.mjs hooks …` — tak samo, jak robi to `rarog hooks …` z powłoki. */
function runCli(
  args: readonly string[], env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return spawnCli(process.execPath, [CLI, 'hooks', ...args], env);
}

/** Odpala podkładkę przez `tsx` — tak samo, jak robi to `pnpm run hooks:*`. */
function runShim(
  args: readonly string[], env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return spawnCli(TSX, [SHIM, ...args], env);
}

function spawnCli(
  file: string, args: readonly string[], env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: dir,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout, stderr }); });
  });
}
