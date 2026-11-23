/**
 * Hook `scripts/hooks/rarog-pending.mjs` w sesji programowej Claude Code: przy
 * `CLAUDE_CODE_ENTRYPOINT` ze zbioru {@link HOOK_PROGRAMMATIC_ENTRYPOINT} hook kończy się kodem 0, z pustym stdout
 * i bez jednego zapisu w katalogu danych — także tam, gdzie bez tej reguły czekałby, odmówił albo zrobił zrzut.
 * Każda inna wartość i brak zmiennej dają zachowanie bez zmian.
 *
 * Kontrakt jest procesowy, więc hook biegnie przez `spawn` z CZYSTYM środowiskiem (`PATH`, `HOME`,
 * `RAROG_DATA_DIR` i to, co test ustawia celowo): `CLAUDE_CODE_ENTRYPOINT` sesji, w której ktoś puścił testy,
 * nie dociera do hooka. Opis zachowania: `docs/dialogs.md`, „Permission hook”.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  HOOK_ALIVE_FILENAME, HOOK_CHANNEL_MODE_SHADOW, HOOK_PENDING_DIRNAME, HOOK_PROGRAMMATIC_ENTRYPOINT,
  HOOK_SHADOW_LOG_FILENAME,
} from '../src/herdr/dialogs/hook/contract.ts';
import type { HookShadowLogEntry } from '../src/herdr/dialogs/hook/contract.ts';
import { HOOK_GUARD_LOG_FILENAME, HOOK_SEEN_FILENAME } from '../src/herdr/hook-config.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const PROMPT = 'fb908934-26eb-4419-9e30-8adcd4ed356b';
const HOOK = join(import.meta.dirname, '..', '..', 'scripts', 'hooks', 'rarog-pending.mjs');
const TIMEOUT = 10_000;
/** Sufit czekania sesji programowej: hook, który by czekał, wyszedłby dopiero po nim. */
const SDK_WAIT_S = 3;
/** Sesja programowa kończy się szybciej niż sufit czekania (sam start Node, z zapasem na obciążenie). */
const SDK_EXIT_MAX_MS = 2_500;
/** Sufit czekania przypadków kontrolnych: czekanie da się zobaczyć, a plik biegnie szybko. */
const CONTROL_WAIT_S = 0.5;
/** Komenda na 43 wiersze dialogu (`dialog-guard.test.ts`): strażnik wysokości odmawia formy. */
const RM_40 = `rm -r -- ${
  Array.from({ length: 40 }, (_, i) => `wynik-${String(i).padStart(2, '0')}-${'x'.repeat(21)}`).join(' ')
}`;
const QUESTIONS = [{
  question: 'Jaki smak?', header: 'Smak', multiSelect: false, options: [{ label: 'Wanilia' }, { label: 'Czekolada' }],
}];

const dirs: string[] = [];
const children = new Set<ChildProcess>();

afterAll(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Scene {
  readonly dir: string;
  readonly project: string;
}

/**
 * Katalog danych, w którym hook bez reguły robi wszystko naraz: `roots.json` ze strażnikiem wysokości, świeży
 * `alive.json` w trybie cienia z sesją na liście, `cwd` sesji w korzeniu.
 */
function scene(): Scene {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-sdk-'));
  dirs.push(dir);
  const project = join(dir, 'roots', 'Projects', 'demo');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(dir, 'roots.json'), JSON.stringify({
    roots: [join(dir, 'roots', 'Projects')], tallDialogGuard: true,
  }));
  writeFileSync(join(dir, HOOK_ALIVE_FILENAME), JSON.stringify({
    ts: Date.now(), bootId: 'boot-test', mode: HOOK_CHANNEL_MODE_SHADOW, send: true, sessions: [SESSION],
  }));
  return { dir, project };
}

/** Wszystkie pliki pod `dir` ze skrótem treści: każdy zapis hooka (nowy plik, nadpisanie) zmienia wynik. */
function tree(dir: string, root = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out[`${relative(root, path)}/`] = 'dir';
      Object.assign(out, tree(path, root));
    } else {
      out[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  return out;
}

interface Case {
  /** Co hook robi dziś w tym przypadku (nazwa testu). */
  readonly name: string;
  readonly payload: (s: Scene) => Record<string, unknown>;
}

const base = (s: Scene): Record<string, unknown> => ({
  session_id: SESSION, cwd: s.project, prompt_id: PROMPT, permission_mode: 'default',
  hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls', description: 'Lista' },
});

const CASES = {
  shadow: { name: 'zgoda w trybie cienia (hook czekałby na plik cienia)', payload: base },
  guard: {
    name: 'wysoki `Bash` przy strażniku i `HERDR_ENV=1` (hook odmówiłby formy)',
    payload: (s) => ({ ...base(s), tool_input: { command: RM_40, description: 'Remove results' } }),
  },
  questionPre: {
    name: '`PreToolUse` `AskUserQuestion` (hook zrobiłby zrzut)',
    payload: (s) => ({
      ...base(s), hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_01',
      tool_input: { questions: QUESTIONS },
    }),
  },
  questionPermission: {
    name: '`PermissionRequest` `AskUserQuestion` (hook czekałby na `answers/`)',
    payload: (s) => ({ ...base(s), tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS } }),
  },
} satisfies Record<string, Case>;

interface Outcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly ms: number;
}

/** Hook z `HERDR_ENV=1` (strażnik) i `CLAUDE_CODE_ENTRYPOINT` tylko wtedy, gdy test go podaje. */
function runHook(s: Scene, stdin: string, entrypoint: string | undefined, waitS: number): Promise<Outcome> {
  const started = Date.now();
  const child = spawn(process.execPath, [HOOK, `--answer-wait=${String(waitS)}`], {
    env: {
      PATH: process.env['PATH'] ?? '', HOME: s.dir, RAROG_DATA_DIR: s.dir, HERDR_ENV: '1',
      ...(entrypoint === undefined ? {} : { [HOOK_PROGRAMMATIC_ENTRYPOINT.env]: entrypoint }),
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  children.add(child);
  return new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      children.delete(child);
      resolve({ code, stdout, ms: Date.now() - started });
    });
    child.stdin.end(stdin);
  });
}

function readLog(s: Scene): HookShadowLogEntry[] {
  return readFileSync(join(s.dir, HOOK_SHADOW_LOG_FILENAME), 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as HookShadowLogEntry);
}

function readDump(s: Scene): Record<string, unknown> {
  return JSON.parse(readFileSync(join(s.dir, HOOK_PENDING_DIRNAME, `${SESSION}.json`), 'utf8')) as Record<
    string, unknown
  >;
}

describe.concurrent('sesja programowa: hook nic nie robi', () => {
  for (const value of HOOK_PROGRAMMATIC_ENTRYPOINT.values) {
    for (const one of Object.values(CASES)) {
      it(`${value}: ${one.name}`, async () => {
        const s = scene();
        const before = tree(s.dir);
        const outcome = await runHook(s, JSON.stringify(one.payload(s)), value, SDK_WAIT_S);
        expect(outcome).toMatchObject({ code: 0, stdout: '' });
        expect(outcome.ms, 'hook nie czeka').toBeLessThan(SDK_EXIT_MAX_MS);
        expect(tree(s.dir), 'zero zapisów w katalogu danych').toEqual(before);
      }, TIMEOUT);
    }
  }

  it('duży payload: hook czyta stdin do końca, zanim wyjdzie (CLI nie dostaje EPIPE)', async () => {
    const s = scene();
    const before = tree(s.dir);
    const big = JSON.stringify({ ...base(s), tool_input: { command: 'x'.repeat(2 * 1024 * 1024) } });
    const child = spawn(process.execPath, [HOOK], {
      env: { PATH: process.env['PATH'] ?? '', HOME: s.dir, RAROG_DATA_DIR: s.dir, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    children.add(child);
    const errors: string[] = [];
    child.stdin.on('error', (err: NodeJS.ErrnoException) => { errors.push(err.code ?? String(err)); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (exit) => {
        children.delete(child);
        resolve(exit);
      });
      child.stdin.end(big);
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(tree(s.dir)).toEqual(before);
  }, TIMEOUT);
});

describe.concurrent('inna wartość albo brak zmiennej: zachowanie bez zmian', () => {
  for (const value of ['cli', undefined, 'claude-vscode', 'mcp', '', 'SDK-CLI']) {
    const label = value === undefined ? 'brak zmiennej' : `„${value}”`;

    it(`${label}: ${CASES.shadow.name}`, async () => {
      const s = scene();
      const outcome = await runHook(s, JSON.stringify(CASES.shadow.payload(s)), value, CONTROL_WAIT_S);
      expect(outcome).toMatchObject({ code: 0, stdout: '' });
      expect(readLog(s).map((line) => line.ev)).toEqual(['start', 'czekam', 'wyjscie']);
      expect(readLog(s).at(-1)).toMatchObject({ powod: 'sufit', czekal: true });
      expect(readDump(s)).toMatchObject({ sessionId: SESSION, hookEventName: 'PermissionRequest', toolName: 'Bash' });
      expect(Object.keys(tree(s.dir))).toContain(HOOK_SEEN_FILENAME);
    }, TIMEOUT);

    it(`${label}: ${CASES.guard.name}`, async () => {
      const s = scene();
      const outcome = await runHook(s, JSON.stringify(CASES.guard.payload(s)), value, CONTROL_WAIT_S);
      expect(outcome.code).toBe(0);
      expect(JSON.parse(outcome.stdout)).toMatchObject({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
      });
      expect(Object.keys(tree(s.dir))).toEqual(expect.arrayContaining([HOOK_GUARD_LOG_FILENAME, HOOK_SEEN_FILENAME]));
      expect(readLog(s).at(-1)).toMatchObject({ powod: 'straznik' });
    }, TIMEOUT);

    it(`${label}: ${CASES.questionPre.name}`, async () => {
      const s = scene();
      const outcome = await runHook(s, JSON.stringify(CASES.questionPre.payload(s)), value, CONTROL_WAIT_S);
      expect(outcome).toMatchObject({ code: 0, stdout: '' });
      expect(readDump(s)).toMatchObject({ hookEventName: 'PreToolUse', toolName: 'AskUserQuestion' });
    }, TIMEOUT);

    it(`${label}: ${CASES.questionPermission.name}`, async () => {
      const s = scene();
      const outcome = await runHook(s, JSON.stringify(CASES.questionPermission.payload(s)), value, CONTROL_WAIT_S);
      expect(outcome).toMatchObject({ code: 0, stdout: '' });
      expect(outcome.ms, 'hook czekał na plik odpowiedzi do sufitu').toBeGreaterThanOrEqual(CONTROL_WAIT_S * 1000);
      expect(readDump(s)).toMatchObject({ hookEventName: 'PermissionRequest', toolName: 'AskUserQuestion' });
      expect(readDump(s)['answerKey']).toEqual(expect.any(String));
    }, TIMEOUT);
  }
});
