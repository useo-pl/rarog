/**
 * Zrzut hooka: czytnik (`server/src/herdr/dialogs/hook/dump.ts`) i sam hook
 * (`scripts/hooks/rarog-pending.mjs`) jako PROCES.
 *
 * Hook słucha DWÓCH zdarzeń — `PermissionRequest` (dialog zgody realnie stanął, także
 * dla `ExitPlanMode`) i `PreToolUse` wyłącznie dla `AskUserQuestion` — a przed jakimkolwiek
 * zapisem sprawdza `cwd` względem korzeni z `<dataDir>/roots.json`. Payloady w testach są
 * DOSŁOWNYMI wycinkami z pomiarów, bo to jedyne
 * miejsce, w którym wiemy, jak ten payload naprawdę wygląda (ekran `/hooks` kłamie o
 * `tool_use_id`).
 *
 * Hook testujemy przez `spawn`, a nie przez import funkcji, bo jego kontrakt jest procesowy:
 * payload na stdin, exit 0, PUSTY stdout, uprawnienia pliku. Import sprawdzałby logikę, ale nie
 * to, co naprawdę może zepsuć sesję użytkownika (niezerowy kod wyjścia albo wypis na stdout
 * wzięty przez silnik za decyzję o uprawnieniach).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PENDING_HOOK_QUESTION_TTL_MS, PENDING_HOOK_TTL_MS, clearPendingHook, readPendingHook,
  sweepPendingHooks,
} from '../src/herdr/dialogs/hook/dump.ts';
import { hookAnswerPath, writeHookAnswer } from '../src/herdr/dialogs/hook/answers.ts';
import { HOOK_ANSWER_TIMEOUT_S } from '../src/herdr/hook-config.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const HOOK = join(import.meta.dirname, '..', '..', 'scripts', 'hooks', 'rarog-pending.mjs');

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rarog-pending-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** Kładzie surową treść pod adresem, pod którym czytnik jej szuka. */
function putRaw(sessionId: string, body: string): string {
  const dir = join(dataDir, 'pending');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.json`);
  writeFileSync(path, body);
  return path;
}

const at = (): number => 1_700_000_000_000;
const now = (offset = 0) => (): number => at() + offset;

describe('readPendingHook', () => {
  it('zwraca narzędzie z poprawnego, świeżego zrzutu', () => {
    putRaw(SESSION, JSON.stringify({
      sessionId: SESSION,
      toolName: 'Bash',
      toolInput: { command: 'pnpm test' },
      at: at(),
    }));

    expect(readPendingHook(dataDir, SESSION, now(5_000))).toEqual({
      toolName: 'Bash',
      toolInput: { command: 'pnpm test' },
      at: at(),
    });
  });

  it('przepuszcza pola zdarzenia, tury i trybu uprawnień', () => {
    putRaw(SESSION, JSON.stringify({
      sessionId: SESSION,
      toolName: 'ExitPlanMode',
      toolInput: { plan: 'Krok 1' },
      at: at(),
      hookEventName: 'PermissionRequest',
      promptId: '75462c5c-8e34-484a-821c-68e996b86a68',
      permissionMode: 'plan',
    }));

    expect(readPendingHook(dataDir, SESSION, now())).toEqual({
      toolName: 'ExitPlanMode',
      toolInput: { plan: 'Krok 1' },
      at: at(),
      hookEventName: 'PermissionRequest',
      promptId: '75462c5c-8e34-484a-821c-68e996b86a68',
      permissionMode: 'plan',
    });
  });

  it('przepuszcza `agentId` prośby subagenta (dziennik odmów)', () => {
    putRaw(SESSION, JSON.stringify({
      sessionId: SESSION, toolName: 'Bash', toolInput: { command: 'ls' }, at: at(),
      hookEventName: 'PermissionRequest', agentId: 'a7e5ec6c821818fae',
    }));

    expect(readPendingHook(dataDir, SESSION, now())?.agentId).toBe('a7e5ec6c821818fae');
  });

  it('passes `callKey` in the per-call key shape; any other value drops only the field', () => {
    const key = `75462c5c-8e34-484a-821c-68e996b86a68-${'0123456789abcdef'.repeat(2)}`;
    const dump = { sessionId: SESSION, toolName: 'Bash', toolInput: { command: 'ls' }, at: at() };
    putRaw(SESSION, JSON.stringify({ ...dump, callKey: key }));
    expect(readPendingHook(dataDir, SESSION, now())?.callKey).toBe(key);
    for (const bad of ['../../etc/passwd', `${key}x`, 'abc', 42, null]) {
      putRaw(SESSION, JSON.stringify({ ...dump, callKey: bad }));
      const read = readPendingHook(dataDir, SESSION, now());
      expect(read?.toolName, JSON.stringify(bad)).toBe('Bash');
      expect(read, JSON.stringify(bad)).not.toHaveProperty('callKey');
    }
  });

  it('ignoruje pola, których nie zna (hook wolno rozbudować addytywnie)', () => {
    putRaw(SESSION, JSON.stringify({
      sessionId: SESSION, toolName: 'Edit', toolInput: null, at: at(), nowePole: 'x',
    }));

    expect(readPendingHook(dataDir, SESSION, now())?.toolName).toBe('Edit');
  });

  it('przepuszcza `cwd` sesji tylko jako ścieżkę bezwzględną; zły kształt gubi pole, nie zrzut', () => {
    const z = (cwd: unknown) => {
      putRaw(SESSION, JSON.stringify({ sessionId: SESSION, toolName: 'Edit', toolInput: {}, at: at(), cwd }));
      return readPendingHook(dataDir, SESSION, now());
    };
    expect(z('/home/u/projekt')?.cwd).toBe('/home/u/projekt');
    for (const zly of ['projekt', '', 7, null, `/${'a'.repeat(4096)}`, '/a\0b']) {
      const wynik = z(zly);
      expect(wynik?.toolName).toBe('Edit');
      expect(wynik).not.toHaveProperty('cwd');
    }
  });

  it('odrzuca zrzut starszy niż TTL', () => {
    putRaw(SESSION, JSON.stringify({
      sessionId: SESSION, toolName: 'Bash', toolInput: {}, at: at(),
    }));

    expect(readPendingHook(dataDir, SESSION, now(PENDING_HOOK_TTL_MS))).not.toBeNull();
    expect(readPendingHook(dataDir, SESSION, now(PENDING_HOOK_TTL_MS + 1))).toBeNull();
  });

  it('stojący formularz pytania (PermissionRequest + AskUserQuestion) żyje do sufitu hooka zgód', () => {
    /*
     * Formularz `AskUserQuestion` stoi tak długo, jak długo
     * człowiek go czyta, a bywa wielopytaniowy — 10 minut gasiłoby zrzut w środku namysłu
     * i zakładki 2..n spadałyby do karty „odpowiedz w terminalu". Tożsamości nie dowodzi czas,
     * tylko dopasowanie treści i kompletu etykiet (`hookQuestionFrom`). Hook formularza czeka
     * na odpowiedź do sufitu rejestracji (`HOOK_ANSWER_TIMEOUT_S`), więc zrzut
     * żyje tyle samo: karta ma kanał odpowiedzi tak długo, jak żyje hook.
     */
    putRaw(SESSION, JSON.stringify({
      sessionId: SESSION, toolName: 'AskUserQuestion', toolInput: { questions: [] }, at: at(),
      hookEventName: 'PermissionRequest',
    }));
    const ceilingMs = HOOK_ANSWER_TIMEOUT_S * 1000;

    expect(readPendingHook(dataDir, SESSION, now(PENDING_HOOK_TTL_MS + 1))).not.toBeNull();
    expect(readPendingHook(dataDir, SESSION, now(61 * 60_000)), 'zrzut sprzed 61 min').not.toBeNull();
    expect(readPendingHook(dataDir, SESSION, now(ceilingMs))).not.toBeNull();
    expect(readPendingHook(dataDir, SESSION, now(ceilingMs + 1000)), 'zrzut sprzed sufitu + 1 s').toBeNull();
    expect(PENDING_HOOK_QUESTION_TTL_MS).toBe(ceilingMs);
  });

  it('dłuższy TTL formularza należy się WYŁĄCZNIE parze PermissionRequest + AskUserQuestion', () => {
    // `PreToolUse` odpala się PRZED dialogiem (narzędzie mogło pójść bez pytania) — zostaje przy
    // dziesięciu minutach. Zgoda `Bash` przy `PermissionRequest` żyje 60 minut, ale
    // po dziesiątej ze znacznikiem `stale` (dowód z ekranu: `dialogs-dump-bash-60.test.ts`).
    putRaw(SESSION, JSON.stringify({
      sessionId: SESSION, toolName: 'AskUserQuestion', toolInput: {}, at: at(),
      hookEventName: 'PreToolUse',
    }));
    expect(readPendingHook(dataDir, SESSION, now(PENDING_HOOK_TTL_MS + 1))).toBeNull();

    putRaw(SESSION, JSON.stringify({
      sessionId: SESSION, toolName: 'Bash', toolInput: {}, at: at(),
      hookEventName: 'PermissionRequest',
    }));
    expect(readPendingHook(dataDir, SESSION, now(PENDING_HOOK_TTL_MS))).not.toHaveProperty('stale');
    expect(readPendingHook(dataDir, SESSION, now(PENDING_HOOK_TTL_MS + 1))).toMatchObject({ stale: true });
  });

  it('odrzuca zrzut z przyszłości — znacznika, którego nie umiemy umiejscowić, nie ufamy', () => {
    putRaw(SESSION, JSON.stringify({
      sessionId: SESSION, toolName: 'Bash', toolInput: {}, at: at(),
    }));

    expect(readPendingHook(dataDir, SESSION, now(-1))).toBeNull();
  });

  it('zepsuty JSON i zły kształt dają null, nie wyjątek', () => {
    putRaw(SESSION, '{ to nie jest json');
    expect(readPendingHook(dataDir, SESSION, now())).toBeNull();

    putRaw(SESSION, JSON.stringify({ sessionId: SESSION, toolName: '', toolInput: {}, at: at() }));
    expect(readPendingHook(dataDir, SESSION, now())).toBeNull();

    putRaw(SESSION, JSON.stringify({ sessionId: SESSION, toolName: 'Bash', toolInput: {} }));
    expect(readPendingHook(dataDir, SESSION, now())).toBeNull();
  });

  it('nazwa narzędzia niebędąca IDENTYFIKATOREM = zrzut nieobecny', () => {
    /*
     * Nazwa jedzie dalej niż cokolwiek innego ze zrzutu: na kartę i do `herdr-audit.log`,
     * a plik pisze proces spoza Raroga. Zdanie, sekret albo 200 kB tekstu pod tym
     * kluczem nie są nazwą narzędzia — taki plik traktujemy jak nieobecny, zamiast wpuszczać
     * jego treść do dziennika, który runbook „kradzież telefonu" każe potem czytać.
     */
    for (const toolName of [
      'Bash; rm -rf /', 'TOKEN=sekret pnpm run restart', 'X'.repeat(200), '1Bash', 'ma spację',
    ]) {
      putRaw(SESSION, JSON.stringify({ sessionId: SESSION, toolName, toolInput: {}, at: at() }));
      expect(readPendingHook(dataDir, SESSION, now()), toolName).toBeNull();
    }
    // Realne nazwy — w tym MCP z podwójnym podkreśleniem — przechodzą bez zmian.
    for (const toolName of ['Bash', 'ExitPlanMode', 'mcp__serwer__narzedzie']) {
      putRaw(SESSION, JSON.stringify({ sessionId: SESSION, toolName, toolInput: {}, at: at() }));
      expect(readPendingHook(dataDir, SESSION, now())?.toolName, toolName).toBe(toolName);
    }
  });

  it('odrzuca zrzut o CUDZEJ sesji leżący pod naszą nazwą', () => {
    putRaw(SESSION, JSON.stringify({
      sessionId: 'inna-sesja', toolName: 'Bash', toolInput: {}, at: at(),
    }));

    expect(readPendingHook(dataDir, SESSION, now())).toBeNull();
  });

  it('brak pliku i brak katalogu dają null (hook nie musi być zainstalowany)', () => {
    expect(readPendingHook(dataDir, SESSION, now())).toBeNull();
    expect(readPendingHook(join(dataDir, 'nie-ma'), SESSION, now())).toBeNull();
  });

  it('identyfikator ze ścieżką nie dotyka dysku', () => {
    // Wersja z traversalem nie może trafić na plik obok — walidacja jest PRZED `join`.
    putRaw(SESSION, JSON.stringify({
      sessionId: SESSION, toolName: 'Bash', toolInput: {}, at: at(),
    }));

    expect(readPendingHook(dataDir, `../pending/${SESSION}`, now())).toBeNull();
    expect(readPendingHook(dataDir, '', now())).toBeNull();
  });
});

describe('clearPendingHook', () => {
  it('kasuje zrzut, a brak pliku znosi bez błędu', () => {
    putRaw(SESSION, JSON.stringify({
      sessionId: SESSION, toolName: 'Bash', toolInput: {}, at: at(),
    }));

    clearPendingHook(dataDir, SESSION);
    expect(readPendingHook(dataDir, SESSION, now())).toBeNull();
    expect(() => clearPendingHook(dataDir, SESSION)).not.toThrow();
    expect(() => clearPendingHook(dataDir, '../zly')).not.toThrow();
  });

  it('z kluczem kasuje TYLKO swoją generację zrzutu', () => {
    /*
     * Nazwa pliku jest jedna na sesję, a hook nadpisuje ją przy KAŻDYM pytaniu: zrzut pytania
     * drugiego potrafi więc powstać, zanim Rarog posprząta po pierwszym. Bezwarunkowe
     * kasowanie zabierało mu wtedy treść, a karta spadała do „odpowiedz w terminalu".
     */
    const zrzut = (key: string): string => JSON.stringify({
      sessionId: SESSION,
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Które dodatki?', options: [{ label: 'Polewa' }] }] },
      at: at(),
      hookEventName: 'PermissionRequest',
      answerKey: key,
    });

    putRaw(SESSION, zrzut('klucz-2'));
    clearPendingHook(dataDir, SESSION, 'klucz-1');
    expect(readPendingHook(dataDir, SESSION, now())?.answerKey, 'cudza generacja zostaje')
      .toBe('klucz-2');

    clearPendingHook(dataDir, SESSION, 'klucz-2');
    expect(readPendingHook(dataDir, SESSION, now())).toBeNull();

    // Zrzut BEZ klucza (stara instalacja hooka) też nie jest nasz — zostaje TTL-owi.
    putRaw(SESSION, JSON.stringify({
      sessionId: SESSION, toolName: 'Bash', toolInput: {}, at: at(),
    }));
    clearPendingHook(dataDir, SESSION, 'klucz-1');
    expect(readPendingHook(dataDir, SESSION, now())).not.toBeNull();
    // …a kasowanie BEZ klucza (Esc, cyfra) zdejmuje go jak dotąd.
    clearPendingHook(dataDir, SESSION);
    expect(readPendingHook(dataDir, SESSION, now())).toBeNull();
  });
});

describe('sweepPendingHooks — żniwiarz katalogu zrzutów', () => {
  /*
   * TTL działający WYŁĄCZNIE przy odczycie nie wystarcza: po 10 minutach `readPendingHook`
   * oddaje `null`, ale plik z pełnym `tool_input` (komenda `Bash` razem z wartościami env
   * w linii, treść `Write`, cały plan) leżałby w `dataDir` bezterminowo. Kasowałby go tylko
   * `clearPendingHook`, czyli decyzja podjęta Z RAROGA — a hook odpala się we wszystkich
   * sesjach Claude pod korzeniami Raroga, także w tych, których Rarog nigdy nie zobaczy.
   */
  const postarz = (path: string): string => {
    const stale = new Date(Date.now() - PENDING_HOOK_TTL_MS - 60_000);
    utimesSync(path, stale, stale);
    return path;
  };

  it('kasuje zrzuty starsze niż TTL, świeże zostawia', () => {
    const stary = postarz(putRaw(SESSION, JSON.stringify({
      sessionId: SESSION, toolName: 'Bash', toolInput: { command: 'echo SEKRET' }, at: at(),
    })));
    const drugi = '11111111-2222-4333-8444-555555555555';
    const swiezy = putRaw(drugi, JSON.stringify({
      sessionId: drugi, toolName: 'Bash', toolInput: {}, at: Date.now(),
    }));

    expect(sweepPendingHooks(dataDir)).toBe(1);
    expect(existsSync(stary)).toBe(false);
    expect(existsSync(swiezy)).toBe(true);
  });

  it('zrzut stojącego formularza pytania przeżywa żniwiarza aż do SWOJEGO TTL', () => {
    // Żniwiarz nie może skasować pliku, który czytnikowi wciąż wolno podpiąć pod kartę —
    // inaczej restart serwera w środku formularza zabierałby mu treść.
    const path = putRaw(SESSION, JSON.stringify({
      sessionId: SESSION, toolName: 'AskUserQuestion', toolInput: { questions: [] }, at: at(),
      hookEventName: 'PermissionRequest',
    }));
    postarz(path);

    expect(sweepPendingHooks(dataDir)).toBe(0);
    expect(existsSync(path)).toBe(true);

    const dawno = new Date(Date.now() - PENDING_HOOK_QUESTION_TTL_MS - 60_000);
    utimesSync(path, dawno, dawno);
    expect(sweepPendingHooks(dataDir)).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it('plik zepsuty też znika po TTL — wiek liczymy z mtime, nie z treści', () => {
    const path = postarz(putRaw(SESSION, '{ to nie jest json'));

    expect(sweepPendingHooks(dataDir)).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it('brak katalogu i pliki spoza `.json` nie są błędem', () => {
    expect(sweepPendingHooks(join(dataDir, 'nie-ma'))).toBe(0);
    const dir = join(dataDir, 'pending');
    mkdirSync(dir, { recursive: true });
    const inny = join(dir, 'notatka.txt');
    writeFileSync(inny, 'x');
    postarz(inny);

    expect(sweepPendingHooks(dataDir)).toBe(0);
    expect(existsSync(inny)).toBe(true);
  });
});

/** Odpala hook z podanym stdin; zwraca kod wyjścia i strumienie. */
function runHook(
  stdin: string, env: Record<string, string> = {}, args: readonly string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, ...args], {
      // Czyste środowisko: hook nie może zależeć od zmiennych powłoki testu, a HOME musi
      // wskazywać katalog tymczasowy, żeby test nie pisał po prawdziwym koncie.
      env: { PATH: process.env['PATH'] ?? '', HOME: dataDir, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}

describe('hook rarog-pending.mjs (proces)', () => {
  /** Katalog „projektu", czyli `cwd` sesji Claude — leży w korzeniu zapisanym dla hooka. */
  let project: string;
  let outside: string;

  beforeEach(() => {
    project = join(dataDir, 'roots', 'Projects', 'demo');
    outside = join(dataDir, 'obce', 'klient');
    mkdirSync(project, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(dataDir, 'roots.json'),
      JSON.stringify({ roots: [join(dataDir, 'roots', 'Projects')] }),
    );
  });

  const env = (): Record<string, string> => ({ RAROG_DATA_DIR: dataDir });

  /** Payload `PermissionRequest` — pomiar A, komplet pól z żywego Claude Code v2.1.251. */
  const permissionRequest = (over: Record<string, unknown> = {}): string => JSON.stringify({
    session_id: SESSION,
    transcript_path: `/Users/x/.claude/projects/-demo/${SESSION}.jsonl`,
    cwd: project,
    prompt_id: 'fb908934-26eb-4419-9e30-8adcd4ed356b',
    permission_mode: 'auto',
    effort: { level: 'xhigh' },
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf "$TMPDIR/x"', description: 'Remove temp dir' },
    ...over,
  });

  /** Payload `PreToolUse` dla `AskUserQuestion` — z pomiaru (jedyne źródło treści pytania). */
  const askUserQuestion = (over: Record<string, unknown> = {}): string => JSON.stringify({
    session_id: SESSION,
    cwd: project,
    prompt_id: '75462c5c-8e34-484a-821c-68e996b86a68',
    permission_mode: 'auto',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{
        question: 'Który wariant?',
        header: 'Wybór',
        multiSelect: true,
        options: [
          { label: 'A', description: 'pierwszy' },
          { label: 'B', description: 'drugi' },
        ],
      }],
    },
    tool_use_id: 'toolu_000000000000000000000001',
    ...over,
  });

  it('`PermissionRequest` zapisuje zrzut pod ścieżką, którą czyta serwer', async () => {
    const before = Date.now();
    const result = await runHook(permissionRequest(), env());

    expect(result.code).toBe(0);
    expect(result.stdout, 'stdout hooka MUSI być pusty — silnik czyta go jak decyzję').toBe('');

    const entry = readPendingHook(dataDir, SESSION, () => Date.now());
    expect(entry?.toolName).toBe('Bash');
    expect(entry?.toolInput).toEqual({ command: 'rm -rf "$TMPDIR/x"', description: 'Remove temp dir' });
    expect(entry?.at).toBeGreaterThanOrEqual(before);
    // Pola zdarzenia i tury: klucz zrzutu został per sesja, ale zrzut mówi, SKĄD pochodzi i z jakiej tury.
    expect(entry?.hookEventName).toBe('PermissionRequest');
    expect(entry?.promptId).toBe('fb908934-26eb-4419-9e30-8adcd4ed356b');
    expect(entry?.permissionMode).toBe('auto');
    // `PermissionRequest` nie niesie `tool_use_id` (pomiar A) — i nie wolno go zmyślać.
    expect(entry?.toolUseId).toBeUndefined();
    // Wątek główny nie ma `agent_id` — zrzut też go nie ma.
    expect(entry?.agentId).toBeUndefined();

    // 0700 na katalogu i 0600 na pliku: zrzut niesie treść komend i diffów użytkownika.
    expect(statSync(join(dataDir, 'pending')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, 'pending', `${SESSION}.json`)).mode & 0o777).toBe(0o600);
  });

  it('`PermissionRequest` SUBAGENTA zapisuje `agentId`, który czyta serwer (zgodność formatu)', async () => {
    // Payload subagenta niesie `agent_id` i `agent_type` (CLI 2.1.302).
    const result = await runHook(permissionRequest({
      agent_id: 'a7e5ec6c821818fae', agent_type: 'general-purpose',
    }), env());

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    const entry = readPendingHook(dataDir, SESSION, () => Date.now());
    expect(entry?.agentId).toBe('a7e5ec6c821818fae');
    // Do zrzutu idzie sam identyfikator — typ agenta zostaje w payloadzie.
    const raw = JSON.parse(readFileSync(join(dataDir, 'pending', `${SESSION}.json`), 'utf8')) as Record<string, unknown>;
    expect(raw['agentId']).toBe('a7e5ec6c821818fae');
    expect(raw['agentType']).toBeUndefined();
  });

  it('`PermissionRequest` dla `ExitPlanMode` niesie PEŁNĄ treść planu (pomiar)', async () => {
    const plan = 'Krok 1\nKrok 2\n';
    await runHook(permissionRequest({
      permission_mode: 'plan',
      tool_name: 'ExitPlanMode',
      tool_input: { plan, planFilePath: '/Users/x/.claude/plans/floofy.md' },
    }), env());

    const entry = readPendingHook(dataDir, SESSION, () => Date.now());
    expect(entry?.toolName).toBe('ExitPlanMode');
    expect((entry?.toolInput as { plan?: string }).plan).toBe(plan);
    expect(entry?.permissionMode).toBe('plan');
  });

  it('`PreToolUse` dla `AskUserQuestion` zapisuje pełne `questions` i `tool_use_id`', async () => {
    const result = await runHook(askUserQuestion(), env());

    expect(result.code).toBe(0);
    const entry = readPendingHook(dataDir, SESSION, () => Date.now());
    expect(entry?.toolName).toBe('AskUserQuestion');
    expect(entry?.hookEventName).toBe('PreToolUse');
    expect(entry?.toolUseId).toBe('toolu_000000000000000000000001');
    const questions = (entry?.toolInput as { questions: { multiSelect: boolean; options: unknown[] }[] }).questions;
    expect(questions[0]?.multiSelect, '`multiSelect` z hooka jest autorytatywny').toBe(true);
    expect(questions[0]?.options).toHaveLength(2);
  });

  it('`PreToolUse` dla INNEGO narzędzia nie pisze nic — stęchłe zrzuty przy każdym Readzie', async () => {
    const result = await runHook(askUserQuestion({
      tool_name: 'Bash', tool_input: { command: 'ls' },
    }), env());

    expect(result.code).toBe(0);
    expect(readPendingHook(dataDir, SESSION, () => Date.now())).toBeNull();
  });

  it('zdarzenie spoza kontraktu (`PostToolUse`, brak pola) nie pisze nic', async () => {
    for (const payload of [
      permissionRequest({ hook_event_name: 'PostToolUse' }),
      permissionRequest({ hook_event_name: undefined }),
    ]) {
      const result = await runHook(payload, env());
      expect(result.code).toBe(0);
      expect(readPendingHook(dataDir, SESSION, () => Date.now())).toBeNull();
    }
  });

  it('`cwd` POZA korzeniami Raroga nie zostawia ani zrzutu, ani znacznika', async () => {
    const result = await runHook(permissionRequest({ cwd: outside }), env());

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr, 'cudze repo nie ma prawa nawet zobaczyć śladu w logu').toBe('');
    expect(readPendingHook(dataDir, SESSION, () => Date.now())).toBeNull();
    expect(existsSync(join(dataDir, 'hook-seen.json'))).toBe(false);
  });

  it('brak `roots.json` = brak zapisu (fail-closed: nie wiemy, gdzie wolno pisać)', async () => {
    rmSync(join(dataDir, 'roots.json'));
    const result = await runHook(permissionRequest(), env());

    expect(result.code).toBe(0);
    expect(readPendingHook(dataDir, SESSION, () => Date.now())).toBeNull();
  });

  it('pusta lista korzeni i zepsuty `roots.json` znaczą to samo, co brak pliku', async () => {
    for (const body of ['{"roots":[]}', '{ to nie jest json', '{"roots":"/Users"}']) {
      writeFileSync(join(dataDir, 'roots.json'), body);
      const result = await runHook(permissionRequest(), env());
      expect(result.code, body).toBe(0);
      expect(readPendingHook(dataDir, SESSION, () => Date.now()), body).toBeNull();
    }
  });

  it('korzeń podany przez dowiązanie łapie `cwd` po jego rozwiązaniu', async () => {
    // macOS: `/tmp` jest dowiązaniem do `/private/tmp`, a projekty bywają za skrótem.
    const link = join(dataDir, 'skrot');
    symlinkSync(join(dataDir, 'roots', 'Projects'), link);
    writeFileSync(join(dataDir, 'roots.json'), JSON.stringify({ roots: [link] }));

    await runHook(permissionRequest(), env());
    expect(readPendingHook(dataDir, SESSION, () => Date.now())?.toolName).toBe('Bash');
  });

  it('znacznik `hook-seen.json` mówi, że hook ODPALIŁ — przeżywa skasowanie zrzutu', async () => {
    const before = Date.now();
    await runHook(permissionRequest(), env());
    clearPendingHook(dataDir, SESSION);

    const seen = JSON.parse(readFileSync(join(dataDir, 'hook-seen.json'), 'utf8')) as {
      at: number; event: string; toolName: string;
    };
    expect(seen.at).toBeGreaterThanOrEqual(before);
    expect(seen.event).toBe('PermissionRequest');
    expect(seen.toolName).toBe('Bash');
    expect(statSync(join(dataDir, 'hook-seen.json')).mode & 0o777).toBe(0o600);
  });

  it('honoruje RAROG_DATA_DIR i nie zostawia plików tymczasowych', async () => {
    const result = await runHook(permissionRequest(), env());

    expect(result.code).toBe(0);
    const raw = await readFile(join(dataDir, 'pending', `${SESSION}.json`), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(readdirSync(join(dataDir, 'pending'))).toEqual([`${SESSION}.json`]);
  });

  it('liczy dataDir z HOME tak samo jak `defaultDataDir` serwera', async () => {
    const home = join(dataDir, 'home');
    const rarogDir = join(home, '.local', 'share', 'rarog');
    mkdirSync(rarogDir, { recursive: true });
    writeFileSync(
      join(rarogDir, 'roots.json'),
      JSON.stringify({ roots: [join(dataDir, 'roots', 'Projects')] }),
    );

    const result = await runHook(permissionRequest(), { HOME: home });
    expect(result.code).toBe(0);
    expect(readPendingHook(rarogDir, SESSION, () => Date.now())?.toolName).toBe('Bash');
  });

  it('przycina wielki tool_input z markerem zamiast się wywalić', async () => {
    const huge = 'x'.repeat(1100 * 1024);
    const result = await runHook(permissionRequest({
      tool_name: 'Write', tool_input: { content: huge },
    }), env());

    expect(result.code).toBe(0);
    const entry = readPendingHook(dataDir, SESSION, () => Date.now());
    expect(entry?.toolName).toBe('Write');
    const input = entry?.toolInput as { rarogTruncated?: boolean; preview?: string };
    expect(input.rarogTruncated).toBe(true);
    expect(input.preview?.length).toBe(64 * 1024);
  });

  it('sufit 1 MiB i podgląd 64 kB są BAJTOWE także dla treści spoza ASCII', async () => {
    /*
     * `serialized.slice(0, TRUNCATED_PREVIEW_MAX_BYTES)` w `preview` brałby 65536
     * ZNAKÓW z limitu wyrażonego w BAJTACH — zdanie „limit bajtowy ≥ limit
     * znaków dla utf8" odwraca nierówność. Plan po polsku albo diff z emoji rósłby do
     * ~256 kB przy zadeklarowanym suficie 64 kB, a hook pisze synchronicznie przy KAŻDYM
     * dialogu. Kontrakt mówi „powyżej 64 kB" — i ma to znaczyć.
     */
    // 17 B per repetition: 80 000 of them are ~1.3 MiB, over the 1 MiB ceiling.
    const huge = '„źdźbło"🍦'.repeat(80_000);
    const result = await runHook(permissionRequest({
      tool_name: 'Write', tool_input: { content: huge },
    }), env());

    expect(result.code).toBe(0);
    const path = join(dataDir, 'pending', `${SESSION}.json`);
    // Narzut to koperta zrzutu (sessionId, toolName, at, cwd…) plus ucieczki JSON w podglądzie
    // — ale rząd wielkości ma być 64 kB, a nie 256 kB.
    expect(statSync(path).size).toBeLessThan(2 * 64 * 1024);
    const entry = readPendingHook(dataDir, SESSION, () => Date.now());
    const input = entry?.toolInput as { rarogTruncated?: boolean; preview?: string };
    expect(input.rarogTruncated).toBe(true);
    expect(Buffer.byteLength(input.preview ?? '', 'utf8')).toBeLessThanOrEqual(64 * 1024);
    // `toString` odcina urwaną sekwencję bajtów — żaden znak nie pęka w połowie.
    expect(input.preview?.includes('\uFFFD')).toBe(false);
  });

  /*
   * KANAŁ ODPOWIEDZI. Testujemy go przez PROCES i przez PRAWDZIWY
   * zapisywacz z serwera (`writeHookAnswer`), bo to jest cały kontrakt: dwa procesy, jeden
   * katalog, jeden klucz liczony po jednej stronie. Test importujący same funkcje sprawdziłby
   * logikę i przegapił jedyną rzecz, która może się rozjechać — nazwę pliku.
   */
  const questionRequest = (over: Record<string, unknown> = {}): string => permissionRequest({
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{
        question: 'Jaki smak?',
        header: 'Smak',
        multiSelect: false,
        options: [{ label: 'Wanilia' }, { label: 'Czekolada' }],
      }],
    },
    ...over,
  });

  /** Czeka, aż śpiący hook zapisze zrzut, i oddaje jego `answerKey`. */
  async function waitForAnswerKey(): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const entry = readPendingHook(dataDir, SESSION, () => Date.now());
      if (entry?.answerKey !== undefined) return entry.answerKey;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('hook nie zapisał zrzutu z `answerKey`');
  }

  /** Czeka, aż zrzut pokaże `answerKey` INNY niż podany (czyli nadpisał go kolejny hook). */
  async function waitForOtherAnswerKey(previous: string): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const entry = readPendingHook(dataDir, SESSION, () => Date.now());
      if (entry?.answerKey !== undefined && entry.answerKey !== previous) return entry.answerKey;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('drugi hook nie nadpisał zrzutu własnym `answerKey`');
  }

  it('dwa wywołania o TYM SAMYM `prompt_id` i payloadzie dostają RÓŻNE klucze (nonce)', async () => {
    /*
     * A key that is a PURE function (`prompt_id` + content hash) would give a repeated question
     * (same turn, same content) the same key as the previous one. The nonce makes it one-time; `prompt_id`
     * i skrót zostają na swoim miejscu, bo po nich poznaje się, CZEGO klucz dotyczy.
     */
    await runHook(questionRequest(), env(), ['--answer-wait=0']);
    const first = readPendingHook(dataDir, SESSION, () => Date.now())?.answerKey ?? '';
    await runHook(questionRequest(), env(), ['--answer-wait=0']);
    const second = readPendingHook(dataDir, SESSION, () => Date.now())?.answerKey ?? '';

    expect(first).not.toBe('');
    expect(second).not.toBe(first);
    // Różni je WYŁĄCZNIE ostatni człon: przedrostek `<prompt_id>-<skrót>` jest z definicji ten sam.
    const prefix = (key: string): string => key.slice(0, key.lastIndexOf('-'));
    expect(prefix(second)).toBe(prefix(first));
    expect(prefix(first)).toBe('fb908934-26eb-4419-9e30-8adcd4ed356b-'
      + createHash('sha256').update(JSON.stringify([{
        question: 'Jaki smak?',
        header: 'Smak',
        multiSelect: false,
        options: [{ label: 'Wanilia' }, { label: 'Czekolada' }],
      }]), 'utf8').digest('hex').slice(0, 16));
    // Klucz jest NAZWĄ PLIKU — musi przejść przez `ANSWER_KEY_PATTERN` Raroga, inaczej
    // `writeHookAnswer` odda `null` i kanał milczy bez śladu.
    expect(hookAnswerPath(dataDir, SESSION, second)).not.toBeNull();
  });

  it('po nadpisaniu zrzutu STARY proces kończy w ciszy i nie zjada pliku nowego', async () => {
    /*
     * CLI nie zabija hooka rozstrzygniętego cyfrą z biurka — ignoruje tylko jego spóźnione
     * `allow` — więc dwa procesy potrafią czekać naraz. Przy kluczu bez nonce'a
     * oba pilnowały TEJ SAMEJ nazwy pliku i pierwszy z brzegu zjadał odpowiedź przeznaczoną
     * dla drugiego. Z nonce'em stary czeka na plik, którego nikt nie napisze, a kończy go
     * `dumpStillMine`: w zrzucie stoi już cudzy `answerKey`.
     */
    const stary = runHook(questionRequest(), env(), ['--answer-wait=30']);
    const keyStary = await waitForAnswerKey();
    const nowy = runHook(questionRequest(), env(), ['--answer-wait=30']);
    const keyNowy = await waitForOtherAnswerKey(keyStary);

    writeHookAnswer(dataDir, SESSION, keyNowy, { 'Jaki smak?': 'Czekolada' });

    const wynikStarego = await stary;
    expect(wynikStarego.code).toBe(0);
    expect(wynikStarego.stdout, 'stary proces nie ma prawa oddać cudzej odpowiedzi').toBe('');
    const out = JSON.parse((await nowy).stdout) as {
      hookSpecificOutput: { decision: { updatedInput: { answers: Record<string, string> } } };
    };
    expect(out.hookSpecificOutput.decision.updatedInput.answers)
      .toEqual({ 'Jaki smak?': 'Czekolada' });
  });

  it('`PermissionRequest` + `AskUserQuestion`: plik odpowiedzi wraca jako `allow` z `answers`', async () => {
    const running = runHook(questionRequest(), env(), ['--answer-wait=10']);
    const key = await waitForAnswerKey();
    // Klucz odróżnia DWA równoległe pytania tej samej tury, więc niesie
    // `prompt_id` ORAZ skrót treści — samo `prompt_id` by nie wystarczyło.
    expect(key.startsWith('fb908934-26eb-4419-9e30-8adcd4ed356b-')).toBe(true);
    const path = writeHookAnswer(dataDir, SESSION, key, { 'Jaki smak?': 'Czekolada' });
    expect(path).not.toBeNull();

    const result = await running;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        // Kształt z docs hooków („PermissionRequest decision control”): `decision` jest OBIEKTEM,
        // a `updatedInput` niesie CAŁY `tool_input` z dołożonym `answers`.
        decision: {
          behavior: 'allow',
          updatedInput: {
            questions: [{
              question: 'Jaki smak?',
              header: 'Smak',
              multiSelect: false,
              options: [{ label: 'Wanilia' }, { label: 'Czekolada' }],
            }],
            answers: { 'Jaki smak?': 'Czekolada' },
          },
        },
      },
    });
    // Plik ZUŻYTY: gdyby został, odpowiedziałby na NASTĘPNE pytanie tej samej sesji.
    expect(existsSync(path as string)).toBe(false);
  });

  it('formularz WIELOPYTANIOWY: jeden plik domyka wszystkie pytania naraz', async () => {
    /*
     * Kształt pliku, który Rarog pisze (karta z kompletem pytań): mapa
     * `treść pytania → wartość` dla WSZYSTKICH pytań wywołania, z wielokrotnym wyborem
     * sklejonym przecinkiem. `allow` domyka całe wywołanie, więc niepełna mapa oddałaby
     * modelowi pustkę na pytanie, którego nikt już nie zada — tu sprawdzamy, że pełna
     * przechodzi przez PROCES hooka bez ani jednej zmiany.
     */
    const trzy = questionRequest({
      tool_input: {
        questions: [
          { question: 'Jaki smak?', header: 'Smak', multiSelect: false,
            options: [{ label: 'Wanilia' }, { label: 'Czekolada' }] },
          { question: 'Jaki kubek?', header: 'Kubek', multiSelect: false,
            options: [{ label: 'Mały' }, { label: 'Duży' }] },
          { question: 'Co na wierzch?', header: 'Wierzch', multiSelect: true,
            options: [{ label: 'Orzechy' }, { label: 'Wiórki' }] },
        ],
      },
    });
    const running = runHook(trzy, env(), ['--answer-wait=10']);
    const key = await waitForAnswerKey();
    const path = writeHookAnswer(dataDir, SESSION, key, {
      'Jaki smak?': 'Czekolada',
      'Jaki kubek?': 'Duży',
      'Co na wierzch?': 'Orzechy, Wiórki',
    });

    const out = JSON.parse((await running).stdout) as {
      hookSpecificOutput: { decision: { updatedInput: { answers: Record<string, string> } } };
    };
    expect(out.hookSpecificOutput.decision.updatedInput.answers).toEqual({
      'Jaki smak?': 'Czekolada',
      'Jaki kubek?': 'Duży',
      'Co na wierzch?': 'Orzechy, Wiórki',
    });
    expect(existsSync(path as string), 'plik zużyty przez hook').toBe(false);
  });

  it('wolny tekst i wiele wartości przechodzą DOSŁOWNIE (CLI nie waliduje etykiet)', async () => {
    const running = runHook(questionRequest(), env(), ['--answer-wait=10']);
    const key = await waitForAnswerKey();
    writeHookAnswer(dataDir, SESSION, key, { 'Jaki smak?': 'Posypka, zupełnie wolny tekst 42' });

    const out = JSON.parse((await running).stdout) as {
      hookSpecificOutput: { decision: { updatedInput: { answers: Record<string, string> } } };
    };
    expect(out.hookSpecificOutput.decision.updatedInput.answers)
      .toEqual({ 'Jaki smak?': 'Posypka, zupełnie wolny tekst 42' });
  });

  it('wartość ponad sufit długości NIE wychodzi z hooka do modelu', async () => {
    /*
     * Trzecia bramka długości wolnego tekstu: Rarog tnie po
     * `MAX_ANSWER_TEXT_CHARS` w schemacie ciała i w managerze, ale hook czyta PLIK — czyli
     * wejście spoza tamtych bramek. Przekroczenie odrzuca cały plik (fail-closed), więc hook
     * kończy w ciszy i formularz zostaje przy cyfrze; przycinanie oddałoby modelowi INNĄ
     * odpowiedź, niż napisał człowiek.
     */
    const running = runHook(questionRequest(), env(), ['--answer-wait=1']);
    const key = await waitForAnswerKey();
    writeHookAnswer(dataDir, SESSION, key, { 'Jaki smak?': 'x'.repeat(8 * 1024 + 1) });

    expect((await running).stdout).toBe('');
  });

  it('brak odpowiedzi do sufitu = stdout PUSTY (formularz stoi dalej, cyfra działa)', async () => {
    const result = await runHook(questionRequest(), env(), ['--answer-wait=0']);

    expect(result.code).toBe(0);
    expect(result.stdout, 'po timeoucie hook nie ma prawa niczego zdecydować').toBe('');
    // Zrzut powstaje jak dotąd — karta z pełną treścią pytania nie zależy od kanału odpowiedzi.
    expect(readPendingHook(dataDir, SESSION, () => Date.now())?.answerKey).toBeDefined();
  });

  it('plik z CUDZYM kluczem albo cudzą sesją jest ignorowany', async () => {
    const running = runHook(questionRequest(), env(), ['--answer-wait=1']);
    const key = await waitForAnswerKey();
    // Klucz z innej tury (ten sam kształt, inna treść) — plik leży, ale nie o tym pytaniu.
    writeHookAnswer(dataDir, SESSION, `${key}x`, { 'Jaki smak?': 'Czekolada' });
    // I odpowiedź podpisana cudzą sesją, podłożona pod właściwą nazwę.
    writeFileSync(
      join(dataDir, 'answers', SESSION, `${key}.json`),
      JSON.stringify({ sessionId: 'inna', key, at: Date.now(), answers: { 'Jaki smak?': 'A' } }),
    );

    expect((await running).stdout).toBe('');
  });

  /*
   * NOTATKI: plik Raroga niesie `annotations` — notatkę człowieka i ORYGINAŁ podglądu
   * wybranej opcji — a hook dokłada je do `updatedInput`. Walidator CLI na ścieżce hooka nie
   * działa, więc kształt i sufity pilnuje hook; każdy błąd odrzuca CAŁY plik.
   */
  const PODGLAD = '+------+\n| W  |\n+------+';
  const questionWithPreview = (): string => questionRequest({
    tool_input: {
      questions: [{
        question: 'Jaki smak?',
        header: 'Smak',
        multiSelect: false,
        options: [{ label: 'Wanilia', preview: PODGLAD }, { label: 'Czekolada' }],
      }],
    },
  });

  it('notatka z podglądem wybranej opcji wraca jako `updatedInput.annotations`', async () => {
    const running = runHook(questionWithPreview(), env(), ['--answer-wait=10']);
    const key = await waitForAnswerKey();
    const path = writeHookAnswer(dataDir, SESSION, key, { 'Jaki smak?': 'Wanilia' }, Date.now, {
      'Jaki smak?': { notes: 'ale bez cukru', preview: PODGLAD },
    });

    const out = JSON.parse((await running).stdout) as {
      hookSpecificOutput: { decision: { updatedInput: Record<string, unknown> } };
    };
    expect(out.hookSpecificOutput.decision.updatedInput).toMatchObject({
      answers: { 'Jaki smak?': 'Wanilia' },
      annotations: { 'Jaki smak?': { notes: 'ale bez cukru', preview: PODGLAD } },
    });
    expect(existsSync(path as string)).toBe(false);
  });

  it('plik BEZ notatek daje dawny kształt `updatedInput` — bez pola `annotations`', async () => {
    const running = runHook(questionWithPreview(), env(), ['--answer-wait=10']);
    const key = await waitForAnswerKey();
    writeHookAnswer(dataDir, SESSION, key, { 'Jaki smak?': 'Czekolada' });

    const out = JSON.parse((await running).stdout) as {
      hookSpecificOutput: { decision: { updatedInput: Record<string, unknown> } };
    };
    expect(Object.keys(out.hookSpecificOutput.decision.updatedInput).sort())
      .toEqual(['answers', 'questions']);
  });

  it.each([
    ['podgląd, którego nie ma w opcjach (ucięty)', { notes: 'x', preview: PODGLAD.slice(0, 5) }],
    ['notatka ponad sufit 8192', { notes: 'n'.repeat(8193) }],
    ['pusta notatka bez podglądu', { notes: '' }],
    ['pole spoza kontraktu', { notes: 'x', followUp: 'y' }],
    ['notatka nie-tekst', { notes: 7 }],
  ])('zła notatka (%s) odrzuca CAŁY plik — stdout pusty', async (_name, annotation) => {
    const running = runHook(questionWithPreview(), env(), ['--answer-wait=1']);
    const key = await waitForAnswerKey();
    mkdirSync(join(dataDir, 'answers', SESSION), { recursive: true });
    writeFileSync(join(dataDir, 'answers', SESSION, `${key}.json`), JSON.stringify({
      sessionId: SESSION, key, at: Date.now(),
      answers: { 'Jaki smak?': 'Wanilia' },
      annotations: { 'Jaki smak?': annotation },
    }));

    expect((await running).stdout).toBe('');
  });

  it('notatka do pytania, na które plik nie odpowiada, albo spoza wywołania — odrzucona', async () => {
    const running = runHook(questionWithPreview(), env(), ['--answer-wait=1']);
    const key = await waitForAnswerKey();
    writeHookAnswer(dataDir, SESSION, key, { 'Jaki smak?': 'Wanilia' }, Date.now, {
      'Inne pytanie?': { notes: 'x' },
    });

    expect((await running).stdout).toBe('');
  });

  it('pytanie o treści „__proto__" dostaje odpowiedź i notatkę jako własne klucze', async () => {
    const running = runHook(questionRequest({
      tool_input: {
        questions: [{
          question: '__proto__', header: 'Proto', multiSelect: false,
          options: [{ label: 'A', preview: PODGLAD }, { label: 'B' }],
        }],
      },
    }), env(), ['--answer-wait=10']);
    const key = await waitForAnswerKey();
    mkdirSync(join(dataDir, 'answers', SESSION), { recursive: true });
    // Plik w kształcie, jaki pisze Rarog (`JSON.stringify` słownika bez prototypu).
    writeFileSync(join(dataDir, 'answers', SESSION, `${key}.json`),
      `{"sessionId":"${SESSION}","key":"${key}","at":${String(Date.now())},`
      + `"answers":{"__proto__":"A"},"annotations":{"__proto__":{"notes":"uwaga","preview":${JSON.stringify(PODGLAD)}}}}`);

    const out = JSON.parse((await running).stdout) as {
      hookSpecificOutput: { decision: { updatedInput: { answers: object; annotations: object } } };
    };
    const input = out.hookSpecificOutput.decision.updatedInput;
    expect(Object.hasOwn(input.answers, '__proto__')).toBe(true);
    expect(Object.hasOwn(input.annotations, '__proto__')).toBe(true);
  });

  it('suma odpowiedzi i notatek ponad 32768 jednostek odrzuca plik', async () => {
    const running = runHook(questionRequest({
      tool_input: {
        questions: [1, 2, 3, 4, 5].map((i) => ({
          question: `P${String(i)}?`, header: '', multiSelect: false,
          options: [{ label: 'A', preview: PODGLAD }],
        })),
      },
    }), env(), ['--answer-wait=1']);
    const key = await waitForAnswerKey();
    const answers = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`P${String(i)}?`, 'A']));
    const notes = Object.fromEntries(
      [1, 2, 3, 4, 5].map((i) => [`P${String(i)}?`, { notes: 'n'.repeat(7000) }]),
    );
    writeHookAnswer(dataDir, SESSION, key, answers, Date.now, notes);

    expect((await running).stdout).toBe('');
  });

  it('`PreToolUse` dla `AskUserQuestion` NIE czeka — czekanie wstrzymuje render formularza', async () => {
    const started = Date.now();
    const result = await runHook(askUserQuestion(), env(), ['--answer-wait=30']);

    expect(result.stdout).toBe('');
    expect(Date.now() - started, 'hook `PreToolUse` musi kończyć natychmiast').toBeLessThan(5000);
    expect(readPendingHook(dataDir, SESSION, () => Date.now())?.answerKey).toBeUndefined();
  });

  it('`PermissionRequest` dla narzędzia (nie pytania) NIE czeka i nie dostaje klucza', async () => {
    const started = Date.now();
    const result = await runHook(permissionRequest(), env(), ['--answer-wait=30']);

    expect(result.stdout).toBe('');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(readPendingHook(dataDir, SESSION, () => Date.now())?.answerKey).toBeUndefined();
  });

  it('zniknięcie zrzutu kończy czekanie — Rarog rozstrzygnął dialog cyfrą', async () => {
    const running = runHook(questionRequest(), env(), ['--answer-wait=30']);
    await waitForAnswerKey();
    clearPendingHook(dataDir, SESSION);

    const result = await running;
    expect(result.stdout, 'bez tego proces spałby dobę po decyzji z innego kanału').toBe('');
  });

  it('śmieciowy stdin, pusty stdin i zły session_id kończą się cicho na exit 0', async () => {
    for (const payload of [
      'to nie jest json',
      '',
      'null',
      permissionRequest({ session_id: '../../etc/passwd' }),
      permissionRequest({ tool_name: undefined }),
      permissionRequest({ cwd: undefined }),
    ]) {
      const result = await runHook(payload, env());
      expect(result.code, payload).toBe(0);
      expect(result.stdout, payload).toBe('');
      expect(readPendingHook(dataDir, SESSION, () => Date.now()), payload).toBeNull();
    }
  });
});
