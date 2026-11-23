/**
 * Zapis tymczasowy kanału hooka (część hookowa).
 *
 * Plik tymczasowy `writeHookRoots`, `writeHookAnswer` i `writeAtomic` pod przewidywalną nazwą `<plik>.<pid>.tmp`
 * bez `O_EXCL` dałby się przekierować: dowiązanie podłożone pod tą nazwą przejmuje zapis (`writeFileSync` idzie
 * za dowiązaniem), a `rename` stawia samo dowiązanie w miejscu pliku. Dlatego tmp ma losowy sufiks i `flag: 'wx'`
 * (wzór `server/src/herdr/uploads.ts`): istniejąca nazwa, także dowiązanie, to błąd, nie zapis za nią.
 *
 * Dwa rodzaje przypadków: dowiązanie pod STARĄ nazwą (przewidywalny sufiks z PID) i kolizja z AKTUALNĄ nazwą przy
 * ustalonym `randomBytes` — ta druga przewraca test, gdy z zapisu zniknie `flag: 'wx'`.
 */
import { spawn } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hookAnswerPath, writeHookAnswer } from '../src/herdr/dialogs/hook/answers.ts';
import { HOOK_QUESTION_MATCHER, HOOK_ROOTS_FILENAME, readHookRoots, writeHookRoots } from '../src/herdr/hook-config.ts';
import { readPendingHook } from '../src/herdr/dialogs/hook/dump.ts';

/** Sufiks tmp przy ustalonym `randomBytes(8)`: osiem bajtów 0xab. */
const FIXED_SUFFIX = 'ab'.repeat(8);

/** `on: false` = prawdziwe `randomBytes`; `on: true` = ustalone bajty (kolizja z aktualną nazwą tmp). */
const fixed = vi.hoisted(() => ({ on: false }));

vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return {
    ...real,
    randomBytes: (size: number): Buffer => (fixed.on ? Buffer.alloc(size, 0xab) : real.randomBytes(size)),
  };
});

const HOOK = join(import.meta.dirname, '..', '..', 'scripts', 'hooks', 'rarog-pending.mjs');
const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const ORIGINAL = 'cudzy plik\n';

let dir = '';
let target = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rarog-zapis-tmp-'));
  target = join(dir, 'cel.txt');
  writeFileSync(target, ORIGINAL);
});

afterEach(() => {
  fixed.on = false;
  rmSync(dir, { recursive: true, force: true });
});

/** Dowiązanie do pliku spoza kanału pod podaną nazwą tmp. */
function plant(tmp: string): string {
  symlinkSync(target, tmp);
  return tmp;
}

/** Stara, przewidywalna nazwa tmp (`<plik>.<pid>.tmp`). */
const oldTmp = (file: string, pid: number = process.pid): string => `${file}.${String(pid)}.tmp`;

/** Aktualna nazwa tmp przy ustalonym `randomBytes`. */
const fixedTmp = (file: string): string => `${file}.${FIXED_SUFFIX}.tmp`;

/** Pliki tymczasowe zostawione w katalogu (poza podłożonym dowiązaniem). */
function leftovers(path: string, planted: string): string[] {
  return readdirSync(path).filter((name) => name.endsWith('.tmp') && join(path, name) !== planted);
}

describe('zapis tymczasowy nie idzie za dowiązaniem', () => {
  it('`writeHookRoots`: cel nietknięty, `roots.json` to plik zwykły, bez resztek tmp', () => {
    const data = join(dir, 'data');
    mkdirSync(data, { recursive: true });
    const planted = plant(oldTmp(join(data, HOOK_ROOTS_FILENAME)));

    writeHookRoots(data, ['/x/Projects']);

    expect(readFileSync(target, 'utf8')).toBe(ORIGINAL);
    expect(lstatSync(join(data, HOOK_ROOTS_FILENAME)).isFile()).toBe(true);
    expect(readHookRoots(data)).toEqual(['/x/Projects']);
    expect(leftovers(data, planted)).toEqual([]);
  });

  it('`writeHookAnswer`: cel nietknięty, plik odpowiedzi to plik zwykły, bez resztek tmp', () => {
    const data = join(dir, 'data');
    const file = hookAnswerPath(data, SESSION, 'k1');
    expect(file).not.toBeNull();
    if (file === null) return;
    mkdirSync(dirname(file), { recursive: true });
    const planted = plant(oldTmp(file));

    expect(writeHookAnswer(data, SESSION, 'k1', { 'Pytanie?': 'Tak' })).toBe(file);

    expect(readFileSync(target, 'utf8')).toBe(ORIGINAL);
    expect(lstatSync(file).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ key: 'k1', answers: { 'Pytanie?': 'Tak' } });
    expect(leftovers(dirname(file), planted)).toEqual([]);
  });

  it('`writeHookRoots`: kolizja z AKTUALNĄ nazwą tmp → błąd `EEXIST`, cel nietknięty (`wx`)', () => {
    const data = join(dir, 'data');
    mkdirSync(data, { recursive: true });
    fixed.on = true;
    plant(fixedTmp(join(data, HOOK_ROOTS_FILENAME)));

    expect(() => { writeHookRoots(data, ['/x/Projects']); }).toThrow(expect.objectContaining({ code: 'EEXIST' }));

    expect(readFileSync(target, 'utf8')).toBe(ORIGINAL);
    expect(existsSync(join(data, HOOK_ROOTS_FILENAME))).toBe(false);
  });

  it('`writeHookAnswer`: kolizja z AKTUALNĄ nazwą tmp → `null`, cel nietknięty (`wx`)', () => {
    const data = join(dir, 'data');
    const file = hookAnswerPath(data, SESSION, 'k1');
    if (file === null) throw new Error('klucz testu poza wzorcem');
    mkdirSync(dirname(file), { recursive: true });
    fixed.on = true;
    plant(fixedTmp(file));

    expect(writeHookAnswer(data, SESSION, 'k1', { 'Pytanie?': 'Tak' })).toBeNull();

    expect(readFileSync(target, 'utf8')).toBe(ORIGINAL);
    expect(existsSync(file)).toBe(false);
  });

  it('hook (`writeAtomic`): dowiązanie pod nazwą tmp z PID procesu hooka nie przekierowuje zrzutu', async () => {
    const { data, pendingFile } = hookFixture();
    let planted = '';
    const result = await runHook(data, [], (pid) => { planted = plant(oldTmp(pendingFile, pid)); });

    expect(result).toEqual({ code: 0, stdout: '' });
    expect(readFileSync(target, 'utf8')).toBe(ORIGINAL);
    expect(lstatSync(pendingFile).isFile()).toBe(true);
    expect(readPendingHook(data, SESSION, () => Date.now())?.toolName).toBe(HOOK_QUESTION_MATCHER);
    expect(leftovers(join(data, 'pending'), planted)).toEqual([]);
  });

  it('hook (`writeAtomic`): kolizja z AKTUALNĄ nazwą tmp → bez zrzutu, cel nietknięty, exit 0 (`wx`)', async () => {
    const { data, pendingFile } = hookFixture();
    // Moduł ładowany przed hookiem: `randomBytes` z ustalonymi bajtami także dla importu nazwanego ESM.
    const preload = join(dir, 'staly-random.mjs');
    writeFileSync(preload, [
      "import crypto from 'node:crypto';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'crypto.randomBytes = (size) => Buffer.alloc(size, 0xab);',
      'syncBuiltinESMExports();',
      '',
    ].join('\n'));
    plant(fixedTmp(pendingFile));

    const result = await runHook(data, ['--import', pathToFileURL(preload).href], () => undefined);

    expect(result).toEqual({ code: 0, stdout: '' });
    expect(readFileSync(target, 'utf8')).toBe(ORIGINAL);
    expect(existsSync(pendingFile)).toBe(false);
  });
});

/** Katalog danych z korzeniami i projektem pod nimi; ścieżka zrzutu sesji testu. */
function hookFixture(): { data: string; pendingFile: string } {
  const data = join(dir, 'data');
  const project = join(dir, 'Projects', 'demo');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(data, 'pending'), { recursive: true, mode: 0o700 });
  writeHookRoots(data, [join(dir, 'Projects')]);
  return { data, pendingFile: join(data, 'pending', `${SESSION}.json`) };
}

/**
 * Hook jako proces z pytaniem `AskUserQuestion` (`PreToolUse`, zrzut do `pending/`). `beforeInput` dostaje PID
 * procesu, zanim hook przeczyta stdin: hook pisze dopiero po końcu wejścia, więc żaden tmp jeszcze nie powstał.
 */
function runHook(
  data: string, nodeArgs: readonly string[], beforeInput: (pid: number) => void,
): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(process.execPath, [...nodeArgs, HOOK], {
    env: { PATH: process.env['PATH'] ?? '', HOME: dir, RAROG_DATA_DIR: data },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const done = new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout }); });
  });
  if (child.pid === undefined) throw new Error('hook nie wystartował');
  beforeInput(child.pid);
  child.stdin.end(JSON.stringify({
    session_id: SESSION, cwd: join(dir, 'Projects', 'demo'), hook_event_name: 'PreToolUse',
    tool_name: HOOK_QUESTION_MATCHER, tool_input: { questions: [] },
  }));
  return done;
}
