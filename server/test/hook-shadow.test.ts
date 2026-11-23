/**
 * Tryb cienia hooka `scripts/hooks/rarog-pending.mjs` jako PROCES: zrzut per wywołanie, czekanie według
 * `<dataDir>/alive.json`, przejęcie pliku cienia, odwołanie, sygnał i dziennik `shadow.jsonl`.
 *
 * Kontrakt jest procesowy (payload na stdin, kod 0, PUSTY stdout, pliki w katalogu danych), więc hook biegnie
 * przez `spawn`, jak w `pending-hook.test.ts`. Serwer gra tu test: pisze `alive.json` i plik cienia tak, jak
 * opisuje kontrakt (`server/src/herdr/dialogs/hook/contract.ts`), atomowo przez `rename`. Każdy test ma własny
 * katalog danych, więc testy biegną równolegle; dziecko, które przeżyło test, dostaje SIGKILL w `afterAll`
 * (sufit czekania hooka to prawie doba). Opis zachowania: `docs/dialogs.md`, „Permission hook”.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import {
  HOOK_ALIVE_FILENAME, HOOK_CALL_KEY_PATTERN, HOOK_CHANNEL_MODE_OFF, HOOK_CHANNEL_MODE_SHADOW, HOOK_PENDING_DIRNAME,
  HOOK_SHADOW_CLAIMED_SUFFIX, HOOK_SHADOW_DIRNAME, HOOK_SHADOW_LOG_EVENTS, HOOK_SHADOW_LOG_FILENAME,
  HOOK_SHADOW_REASONS, HOOK_SHADOW_REVOKED_SUFFIX,
} from '../src/herdr/dialogs/hook/contract.ts';
import type {
  HookAliveFile, HookCallDump, HookShadowFile, HookShadowLogEntry, HookShadowReason,
} from '../src/herdr/dialogs/hook/contract.ts';
import { readPendingHook } from '../src/herdr/dialogs/hook/dump.ts';
import { writeHookAnswer } from '../src/herdr/dialogs/hook/answers.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const PROMPT = 'fb908934-26eb-4419-9e30-8adcd4ed356b';
const HOOKS = join(import.meta.dirname, '..', '..', 'scripts', 'hooks');
const HOOK = join(HOOKS, 'rarog-pending.mjs');
/** Znacznik per plik wejściowy obok wspólnego `hook-seen.json`. */
const SEEN_PER_FILE = `hook-seen.${basename(HOOK, '.mjs')}.json`;
/** Jawny sufit testu: każdy kończy się w ułamku tego czasu, cały plik w kilka sekund. */
const TIMEOUT = 8_000;
/** Zmiana warunku w trakcie czekania kończy hook najpóźniej po tylu ms (odpytanie co 250 ms). */
const RELEASE_MAX_MS = 1_000;
/** Treść, której nie wolno zobaczyć w `shadow.jsonl`. */
const MARK = 'cien-tresc-polecenia';
const INPUT = { command: `rm -rf "$TMPDIR/${MARK}"`, description: 'Remove temp dir' };
/** Komenda na 43 wiersze dialogu (`dialog-guard.test.ts`): strażnik wysokości odmawia formy. */
const RM_40 = `rm -r -- ${
  Array.from({ length: 40 }, (_, i) => `wynik-${String(i).padStart(2, '0')}-${'x'.repeat(21)}`).join(' ')
}`;

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

/** Własny katalog danych z `roots.json` i katalogiem projektu (`cwd` sesji) w korzeniu. */
function scene(rootsExtra: Record<string, unknown> = {}): Scene {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-cien-'));
  dirs.push(dir);
  const project = join(dir, 'roots', 'Projects', 'demo');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(dir, 'roots.json'), JSON.stringify({ roots: [join(dir, 'roots', 'Projects')], ...rootsExtra }));
  return { dir, project };
}

/** Zapis jak serwer: plik tymczasowy obok i `rename` (hook nigdy nie widzi pliku w połowie). */
function writeAtomically(file: string, body: string): void {
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

function writeAlive(s: Scene, over: Partial<Record<keyof HookAliveFile, unknown>> = {}): void {
  writeAtomically(join(s.dir, HOOK_ALIVE_FILENAME), JSON.stringify({
    ts: Date.now(), bootId: 'boot-test', mode: HOOK_CHANNEL_MODE_SHADOW, send: true, sessions: [SESSION], ...over,
  }));
}

function writeAliveRaw(s: Scene, body: string): void {
  writeAtomically(join(s.dir, HOOK_ALIVE_FILENAME), body);
}

const shadowBase = (s: Scene, key: string): string => join(s.dir, HOOK_SHADOW_DIRNAME, SESSION, key);

function writeShadow(s: Scene, key: string, body: string | Partial<HookShadowFile> = {}): void {
  mkdirSync(join(s.dir, HOOK_SHADOW_DIRNAME, SESSION), { recursive: true });
  writeAtomically(`${shadowBase(s, key)}.json`, typeof body === 'string' ? body : JSON.stringify({
    key, sessionId: SESSION, decision: 'allow', inputSha256: canonicalSha256(INPUT), at: Date.now(), ...body,
  }));
}

const callDumpPath = (s: Scene, key: string): string => join(s.dir, HOOK_PENDING_DIRNAME, SESSION, `${key}.json`);
const pendingListing = (s: Scene): string[] => readdirSync(join(s.dir, HOOK_PENDING_DIRNAME)).sort();

const permissionRequest = (s: Scene, over: Record<string, unknown> = {}): string => JSON.stringify({
  session_id: SESSION,
  cwd: s.project,
  prompt_id: PROMPT,
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: INPUT,
  ...over,
});

const QUESTIONS = [{
  question: 'Jaki smak?', header: 'Smak', multiSelect: false, options: [{ label: 'Wanilia' }, { label: 'Czekolada' }],
}];
const questionRequest = (s: Scene): string => permissionRequest(s, {
  tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS },
});

interface Outcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Run {
  readonly pid: number;
  readonly child: ChildProcess;
  readonly done: Promise<Outcome>;
}

function startHook(
  s: Scene, stdin: string, env: Record<string, string> = {}, args: readonly string[] = [], hook = HOOK,
): Run {
  const child = spawn(process.execPath, [hook, ...args], {
    env: { PATH: process.env['PATH'] ?? '', HOME: s.dir, RAROG_DATA_DIR: s.dir, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  const done = new Promise<Outcome>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      children.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
  child.stdin?.end(stdin);
  if (child.pid === undefined) throw new Error('hook nie wystartował');
  return { pid: child.pid, child, done };
}

/** Wyjście bez wyniku: kod 0 i pusty stdout (silnik czyta stdout jak decyzję). */
async function expectNoResult(run: Run): Promise<Outcome> {
  const outcome = await run.done;
  expect(outcome).toMatchObject({ code: 0, signal: null, stdout: '' });
  return outcome;
}

function readLog(s: Scene): HookShadowLogEntry[] {
  let raw: string;
  try {
    raw = readFileSync(join(s.dir, HOOK_SHADOW_LOG_FILENAME), 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as HookShadowLogEntry);
}

const logOf = (s: Scene, pid: number): HookShadowLogEntry[] => readLog(s).filter((entry) => entry.pid === pid);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Czeka na linię `ev` procesu `pid` (np. `czekam`: hook czeka, klucz jest w linii). */
async function waitForEntry(s: Scene, pid: number, ev: HookShadowLogEntry['ev']): Promise<HookShadowLogEntry> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const entry = logOf(s, pid).find((line) => line.ev === ev);
    if (entry !== undefined) return entry;
    await sleep(20);
  }
  throw new Error(`hook ${String(pid)} nie dopisał linii „${ev}”`);
}

/** Hook czeka: linia `czekam` z kluczem per wywołanie. */
async function waiting(s: Scene, run: Run): Promise<string> {
  const entry = await waitForEntry(s, run.pid, 'czekam');
  expect(entry.key).toMatch(HOOK_CALL_KEY_PATTERN);
  return entry.key ?? '';
}

/**
 * Dziennik jednego procesu zgodny z kontraktem: znane zdarzenia i powody, `start` pierwszy, `wyjscie` ostatnie
 * i jedyne, klucz w kształcie klucza, żadnej treści `tool_input`. Zwraca linię `wyjscie`.
 */
function expectCycle(s: Scene, pid: number, events: readonly HookShadowLogEntry['ev'][]): HookShadowLogEntry {
  const lines = logOf(s, pid);
  expect(lines.map((line) => line.ev)).toEqual(events);
  for (const line of lines) {
    expect(HOOK_SHADOW_LOG_EVENTS).toContain(line.ev);
    expect(line.sessionId).toBe(SESSION);
    if (line.powod !== undefined) expect(HOOK_SHADOW_REASONS).toContain(line.powod);
    if (line.key !== undefined) expect(line.key).toMatch(HOOK_CALL_KEY_PATTERN);
  }
  expect(JSON.stringify(lines), 'dziennik bez treści `tool_input`').not.toContain(MARK);
  const exit = lines.at(-1);
  if (exit === undefined) throw new Error('pusty dziennik');
  return exit;
}

/** Po wyjściu w `pending/` zostaje sam zrzut per sesja, jak dziś (zrzut per wywołanie i jego katalog znikają). */
function expectCallDumpGone(s: Scene): void {
  expect(pendingListing(s)).toEqual([`${SESSION}.json`]);
}

describe.concurrent('hook w trybie cienia (proces)', () => {
  it('bez `alive.json` (tryb `off`): zrzut per sesja, stdout i pliki jak dziś, plus dziennik cyklu', async () => {
    const s = scene();
    const run = startHook(s, permissionRequest(s));
    await expectNoResult(run);

    // Zrzut per sesja: ten sam komplet pól co bez trybu cienia, plus klucz per wywołanie tej prośby (`callKey`).
    const dump = JSON.parse(readFileSync(join(s.dir, HOOK_PENDING_DIRNAME, `${SESSION}.json`), 'utf8')) as object;
    expect(Object.keys(dump).sort()).toEqual([
      'at', 'callKey', 'cwd', 'hookEventName', 'permissionMode', 'promptId', 'sessionId', 'toolInput', 'toolName',
    ]);
    expect((dump as { callKey?: unknown }).callKey).toMatch(HOOK_CALL_KEY_PATTERN);
    expect(dump).toMatchObject({ sessionId: SESSION, toolName: 'Bash', toolInput: INPUT, cwd: s.project });
    expectCallDumpGone(s);
    // Nowy jest wyłącznie dziennik `shadow.jsonl`: bez `shadow/`, bez `answers/`.
    expect(readdirSync(s.dir).sort()).toEqual([
      HOOK_PENDING_DIRNAME, HOOK_SHADOW_LOG_FILENAME, 'hook-seen.json', SEEN_PER_FILE, 'roots', 'roots.json',
    ].sort());

    const exit = expectCycle(s, run.pid, ['start', 'bez-czekania', 'wyjscie']);
    expect(exit).toMatchObject({ powod: 'alive-brak', czekal: false });
    // Pliku nie ma, więc wyjście nie niesie pól `alive.json`.
    expect(exit).not.toHaveProperty('aliveTs');
    expect(exit).not.toHaveProperty('bootId');
    expect(logOf(s, run.pid)[0]).toMatchObject({
      toolName: 'Bash', promptId: PROMPT, subagent: false, permissionMode: 'default',
    });
  }, TIMEOUT);

  interface NoWait {
    readonly nazwa: string;
    readonly powod: HookShadowReason;
    readonly setup: (s: Scene) => void;
    readonly over?: Record<string, unknown>;
  }
  const noWait: readonly NoWait[] = [
    { nazwa: 'tryb `off`', powod: 'tryb-off', setup: (s) => { writeAlive(s, { mode: HOOK_CHANNEL_MODE_OFF }); } },
    { nazwa: 'tryb nieznany hookowi', powod: 'tryb-nieznany', setup: (s) => { writeAlive(s, { mode: 'nieznany' }); } },
    { nazwa: '`send: false`', powod: 'send', setup: (s) => { writeAlive(s, { send: false }); } },
    { nazwa: 'sesja spoza listy', powod: 'sesja', setup: (s) => { writeAlive(s, { sessions: ['inna-sesja'] }); } },
    { nazwa: '`ts` sprzed 31 s', powod: 'alive-ts', setup: (s) => { writeAlive(s, { ts: Date.now() - 31_000 }); } },
    { nazwa: '`ts` za 31 s', powod: 'alive-ts', setup: (s) => { writeAlive(s, { ts: Date.now() + 31_000 }); } },
    { nazwa: 'zepsuty JSON', powod: 'alive-zly', setup: (s) => { writeAliveRaw(s, '{"ts":'); } },
    { nazwa: 'brak pola `bootId`', powod: 'alive-zly', setup: (s) => { writeAlive(s, { bootId: undefined }); } },
    { nazwa: 'tablica zamiast obiektu', powod: 'alive-zly', setup: (s) => { writeAliveRaw(s, '[]'); } },
    {
      nazwa: 'prośba subagenta (`agent_id`)', powod: 'subagent', setup: writeAlive,
      over: { agent_id: 'a7e5ec6c821818fae' },
    },
    { nazwa: 'bez `prompt_id`', powod: 'klucz', setup: writeAlive, over: { prompt_id: undefined } },
    {
      nazwa: '`tool_input` ponad sufit zrzutu', powod: 'obciety', setup: writeAlive,
      over: { tool_input: { command: 'x'.repeat(1024 * 1024) } },
    },
  ];

  /** Weta z pliku w poprawnym kształcie: wyjście niesie `bootId` i `ts` tego pliku (audyt cienia). */
  const vetoWithFile = new Set<HookShadowReason>(['alive-ts', 'tryb-off', 'tryb-nieznany', 'send', 'sesja']);

  it.each(noWait)('nie czeka: $nazwa → `$powod`', async ({ powod, setup, over }) => {
    const s = scene();
    setup(s);
    const run = startHook(s, permissionRequest(s, over ?? {}));
    await expectNoResult(run);

    const exit = expectCycle(s, run.pid, ['start', 'bez-czekania', 'wyjscie']);
    expect(logOf(s, run.pid)[1]).toMatchObject({ powod });
    expect(exit).toMatchObject({ powod, czekal: false });
    if (vetoWithFile.has(powod)) {
      expect(exit).toMatchObject({ bootId: 'boot-test' });
      expect(typeof exit.aliveTs).toBe('number');
    } else {
      expect(exit).not.toHaveProperty('aliveTs');
    }
    // Zrzut per sesja powstaje jak dziś; per wywołanie znika razem z procesem.
    expect(readPendingHook(s.dir, SESSION, () => Date.now())?.toolName).toBe('Bash');
    expectCallDumpGone(s);
    if (powod === 'klucz') expect(exit.key).toBeUndefined();
    if (powod === 'subagent') expect(logOf(s, run.pid)[0]?.subagent).toBe(true);
  }, TIMEOUT);

  it('kopia hooka bez `canon.mjs`: nie czeka (`skrot`), reszta jak dziś', async () => {
    const s = scene();
    writeAlive(s);
    const copy = join(s.dir, 'kopia');
    mkdirSync(copy);
    copyFileSync(HOOK, join(copy, 'rarog-pending.mjs'));
    copyFileSync(join(HOOKS, 'tall-dialog.mjs'), join(copy, 'tall-dialog.mjs'));
    copyFileSync(join(HOOKS, 'work-area.mjs'), join(copy, 'work-area.mjs'));
    const run = startHook(s, permissionRequest(s), {}, [], join(copy, 'rarog-pending.mjs'));
    await expectNoResult(run);

    expect(expectCycle(s, run.pid, ['start', 'bez-czekania', 'wyjscie'])).toMatchObject({ powod: 'skrot' });
    expect(pendingListing(s)).toEqual([`${SESSION}.json`]);
  }, TIMEOUT);

  it('czeka, przejmuje plik cienia `rename` na `.claimed` i wychodzi bez wyniku', async () => {
    const s = scene();
    writeAlive(s);
    const before = Date.now();
    const run = startHook(s, permissionRequest(s));
    const key = await waiting(s, run);
    expect(key.startsWith(`${PROMPT}-`)).toBe(true);

    // Zrzut per wywołanie: kontrakt `HookCallDump`, skrót liczony tak samo jak po stronie serwera.
    const dump = JSON.parse(readFileSync(callDumpPath(s, key), 'utf8')) as HookCallDump;
    expect(dump).toEqual({
      key, sessionId: SESSION, promptId: PROMPT, pid: run.pid, startedAt: dump.startedAt, permissionMode: 'default',
      toolName: 'Bash', toolInput: INPUT, cwd: s.project, at: dump.at, inputSha256: canonicalSha256(INPUT),
    });
    expect(dump.startedAt).toBeGreaterThan(before - 5_000);
    expect(dump.startedAt).toBeLessThanOrEqual(dump.at);
    // Zrzut per sesja: klucz per wywołanie ten sam co w zrzucie per wywołanie (`callKey`), bez `answerKey`.
    expect(readPendingHook(s.dir, SESSION, () => Date.now())).not.toHaveProperty('answerKey');
    expect(readPendingHook(s.dir, SESSION, () => Date.now())?.callKey).toBe(key);

    writeShadow(s, key);
    await expectNoResult(run);

    expect(existsSync(`${shadowBase(s, key)}${HOOK_SHADOW_CLAIMED_SUFFIX}`)).toBe(true);
    expect(existsSync(`${shadowBase(s, key)}.json`)).toBe(false);
    const exit = expectCycle(s, run.pid, ['start', 'czekam', 'odbior', 'wyjscie']);
    expect(logOf(s, run.pid)[1]).toMatchObject({ bootId: 'boot-test', key, inputSha256: canonicalSha256(INPUT) });
    expect(typeof logOf(s, run.pid)[1]?.aliveTs).toBe('number');
    expect(exit).not.toHaveProperty('aliveTs');
    expect(logOf(s, run.pid)[2]).toMatchObject({ decyzja: 'allow', zgodny: true });
    expect(exit).toMatchObject({ powod: 'odbior', czekal: true, key });
    expectCallDumpGone(s);
  }, TIMEOUT);

  it('plik cienia z inną treścią też przejmuje; treść trafia tylko do dziennika (`zgodny: false`)', async () => {
    const s = scene();
    writeAlive(s);
    const deny = startHook(s, permissionRequest(s));
    writeShadow(s, await waiting(s, deny), { decision: 'deny', inputSha256: '0'.repeat(64) });
    await expectNoResult(deny);
    expect(logOf(s, deny.pid).find((line) => line.ev === 'odbior')).toMatchObject({ decyzja: 'deny', zgodny: false });

    const broken = startHook(s, permissionRequest(s));
    const key = await waiting(s, broken);
    writeShadow(s, key, 'to nie JSON');
    await expectNoResult(broken);
    expect(logOf(s, broken.pid).find((line) => line.ev === 'odbior')).toMatchObject({ decyzja: '?', zgodny: false });
    expect(existsSync(`${shadowBase(s, key)}${HOOK_SHADOW_CLAIMED_SUFFIX}`)).toBe(true);
  }, TIMEOUT);

  const release: readonly (readonly [string, HookShadowReason, (s: Scene) => void])[] = [
    ['`send: false`', 'send', (s) => { writeAlive(s, { send: false }); }],
    ['sesja zeszła z listy', 'sesja', (s) => { writeAlive(s, { sessions: [] }); }],
    ['`alive.json` zniknął', 'alive-brak', (s) => { rmSync(join(s.dir, HOOK_ALIVE_FILENAME)); }],
    ['`alive.json` zepsuty', 'alive-zly', (s) => { writeAliveRaw(s, 'x'); }],
    ['`ts` stęchły', 'alive-ts', (s) => { writeAlive(s, { ts: Date.now() - 31_000 }); }],
    ['tryb `shadow` → `off`', 'tryb-off', (s) => { writeAlive(s, { mode: HOOK_CHANNEL_MODE_OFF }); }],
  ];

  it.each(release)('zwalnia w ≤1 s bez wyniku: %s → `%s`', async (_nazwa, powod, change) => {
    const s = scene();
    writeAlive(s);
    const run = startHook(s, permissionRequest(s));
    const key = await waiting(s, run);
    expect(existsSync(callDumpPath(s, key))).toBe(true);

    const changedAt = Date.now();
    change(s);
    await expectNoResult(run);

    const exit = expectCycle(s, run.pid, ['start', 'czekam', 'wyjscie']);
    expect(exit).toMatchObject({ powod, czekal: true });
    expect(exit.at - changedAt).toBeLessThanOrEqual(RELEASE_MAX_MS);
    // Weto z czytelnego pliku: `ts` pliku, który zwolnił hook (przy `tryb-off` = chwila zmiany flagi).
    if (powod === 'alive-brak' || powod === 'alive-zly') {
      expect(exit).not.toHaveProperty('aliveTs');
    } else {
      expect(exit).toMatchObject({ bootId: 'boot-test' });
      expect(exit.aliveTs).toBeGreaterThanOrEqual(powod === 'alive-ts' ? changedAt - 32_000 : changedAt);
      expect(exit.aliveTs).toBeLessThanOrEqual(exit.at);
    }
    expectCallDumpGone(s);
  }, TIMEOUT);

  it('`<klucz>.revoked` kończy czekanie bez wyniku i bez przejęcia', async () => {
    const s = scene();
    writeAlive(s);
    const run = startHook(s, permissionRequest(s));
    const key = await waiting(s, run);
    mkdirSync(join(s.dir, HOOK_SHADOW_DIRNAME, SESSION), { recursive: true });
    const revokedAt = Date.now();
    writeFileSync(`${shadowBase(s, key)}${HOOK_SHADOW_REVOKED_SUFFIX}`, '');
    await expectNoResult(run);

    const exit = expectCycle(s, run.pid, ['start', 'czekam', 'wyjscie']);
    expect(exit).toMatchObject({ powod: 'odwolane', czekal: true });
    expect(exit.at - revokedAt).toBeLessThanOrEqual(RELEASE_MAX_MS);
    expect(existsSync(`${shadowBase(s, key)}${HOOK_SHADOW_CLAIMED_SUFFIX}`)).toBe(false);
    expectCallDumpGone(s);
  }, TIMEOUT);

  it('plik cienia po wyjściu hooka (`sufit` z `--answer-wait`) leży nieprzejęty', async () => {
    const s = scene();
    writeAlive(s);
    const run = startHook(s, permissionRequest(s), {}, ['--answer-wait=1']);
    const key = await waiting(s, run);
    await expectNoResult(run);
    const exit = expectCycle(s, run.pid, ['start', 'czekam', 'wyjscie']);
    expect(exit).toMatchObject({ powod: 'sufit', czekal: true });
    expect(exit.ms).toBeGreaterThanOrEqual(1_000);
    expectCallDumpGone(s);

    writeShadow(s, key);
    await sleep(600);
    expect(readdirSync(join(s.dir, HOOK_SHADOW_DIRNAME, SESSION))).toEqual([`${key}.json`]);
  }, TIMEOUT);

  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
    '%s w trakcie czekania: `sygnal`, sprzątnięty zrzut, kod 0, pusty stdout',
    async (signal) => {
      const s = scene();
      writeAlive(s);
      const run = startHook(s, permissionRequest(s));
      await waiting(s, run);
      run.child.kill(signal);
      await expectNoResult(run);

      const exit = expectCycle(s, run.pid, ['start', 'czekam', 'sygnal', 'wyjscie']);
      expect(logOf(s, run.pid)[2]).toMatchObject({ sygnal: signal });
      expect(exit).toMatchObject({ powod: 'sygnal', czekal: true });
      expectCallDumpGone(s);
    },
    TIMEOUT,
  );

  it.each(['../poza', 'a/b', 'x'.repeat(129)])(
    '`prompt_id` %j nie nadaje się na nazwę pliku: bez klucza, bez zrzutu per wywołanie, bez czekania',
    async (promptId) => {
      const s = scene();
      writeAlive(s);
      const run = startHook(s, permissionRequest(s, { prompt_id: promptId }));
      await expectNoResult(run);

      const exit = expectCycle(s, run.pid, ['start', 'bez-czekania', 'wyjscie']);
      expect(exit).toMatchObject({ powod: 'klucz', czekal: false });
      expect(exit.key).toBeUndefined();
      // `pending/` ma tylko zrzut per sesja (żadnego podkatalogu z kawałka ścieżki), `shadow/` nie powstał.
      expectCallDumpGone(s);
      expect(existsSync(join(s.dir, HOOK_SHADOW_DIRNAME))).toBe(false);
    },
    TIMEOUT,
  );

  it('SIGTERM w chwili `rename`: plik przejęty albo nietknięty, dziennik mówi to samo', async () => {
    /*
     * Proces zatrzymany SIGSTOP-em, plik cienia już leży, SIGTERM czeka w kolejce: po SIGCONT hook zdąży
     * przejąć plik albo nie, zależnie od kolejności zdarzeń pętli. Oba wyniki są poprawne, pod warunkiem, że
     * stan plików i dziennik zgadzają się ze sobą, a wyjście jest jedno.
     */
    const s = scene();
    writeAlive(s);
    const run = startHook(s, permissionRequest(s));
    const key = await waiting(s, run);
    process.kill(run.pid, 'SIGSTOP');
    await sleep(30);
    writeShadow(s, key);
    process.kill(run.pid, 'SIGTERM');
    process.kill(run.pid, 'SIGCONT');
    await expectNoResult(run);

    const claimed = existsSync(`${shadowBase(s, key)}${HOOK_SHADOW_CLAIMED_SUFFIX}`);
    expect(existsSync(`${shadowBase(s, key)}.json`)).toBe(!claimed);
    const events = logOf(s, run.pid).map((line) => line.ev);
    if (claimed) {
      expect(events.slice(0, 4)).toEqual(['start', 'czekam', 'odbior', 'wyjscie']);
      expect(events.slice(4).every((ev) => ev === 'sygnal')).toBe(true);
    } else {
      expect(expectCycle(s, run.pid, ['start', 'czekam', 'sygnal', 'wyjscie'])).toMatchObject({ powod: 'sygnal' });
    }
    expect(events.filter((ev) => ev === 'wyjscie')).toHaveLength(1);
    expectCallDumpGone(s);
  }, TIMEOUT);

  it('dwie identyczne prośby: różne klucze, osobne zrzuty, każdą zwalnia jej własny plik', async () => {
    const s = scene();
    writeAlive(s);
    const first = startHook(s, permissionRequest(s));
    const second = startHook(s, permissionRequest(s));
    const [k1, k2] = await Promise.all([waiting(s, first), waiting(s, second)]);
    expect(k1).not.toBe(k2);
    const sessionDumps = join(s.dir, HOOK_PENDING_DIRNAME, SESSION);
    expect(readdirSync(sessionDumps).sort()).toEqual([`${k1}.json`, `${k2}.json`].sort());

    writeShadow(s, k1);
    await expectNoResult(first);
    // Katalog sesji zostaje, bo leży w nim zrzut drugiej prośby.
    expect(readdirSync(sessionDumps)).toEqual([`${k2}.json`]);
    expect(logOf(s, second.pid).some((line) => line.ev === 'wyjscie')).toBe(false);

    writeShadow(s, k2);
    await expectNoResult(second);
    expectCallDumpGone(s);
  }, TIMEOUT);

  it('pytanie czeka dzisiejszym kanałem obok czekającej zgody tej samej sesji', async () => {
    const s = scene();
    writeAlive(s);
    const consent = startHook(s, permissionRequest(s));
    const key = await waiting(s, consent);

    const question = startHook(s, questionRequest(s), {}, ['--answer-wait=10']);
    let answerKey: string | undefined;
    for (let attempt = 0; attempt < 200 && answerKey === undefined; attempt += 1) {
      answerKey = readPendingHook(s.dir, SESSION, () => Date.now())?.answerKey;
      if (answerKey === undefined) await sleep(20);
    }
    expect(answerKey).toBeDefined();
    writeHookAnswer(s.dir, SESSION, answerKey ?? '', { 'Jaki smak?': 'Czekolada' });
    const answered = await question.done;
    expect(answered.code).toBe(0);
    expect(JSON.parse(answered.stdout)).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow', updatedInput: { answers: { 'Jaki smak?': 'Czekolada' } } } },
    });
    // Pytanie nie ma cyklu cienia; zgoda czeka dalej, choć zrzut per sesja należy już do pytania.
    expect(logOf(s, question.pid)).toEqual([]);
    expect(logOf(s, consent.pid).some((line) => line.ev === 'wyjscie')).toBe(false);
    expect(existsSync(callDumpPath(s, key))).toBe(true);

    writeShadow(s, key);
    await expectNoResult(consent);
    expect(expectCycle(s, consent.pid, ['start', 'czekam', 'odbior', 'wyjscie'])).toMatchObject({ powod: 'odbior' });
  }, TIMEOUT);

  it('zgoda po czekającym pytaniu: pytanie kończy w ciszy jak dziś (`dumpStillMine`), zgoda czeka', async () => {
    const s = scene();
    writeAlive(s);
    const question = startHook(s, questionRequest(s), {}, ['--answer-wait=10']);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (readPendingHook(s.dir, SESSION, () => Date.now())?.answerKey !== undefined) break;
      await sleep(20);
    }
    const consent = startHook(s, permissionRequest(s));
    const key = await waiting(s, consent);
    // Zrzut per sesja należy teraz do zgody: pytanie traci kanał odpowiedzi i kończy bez wyniku.
    await expectNoResult(question);
    expect(logOf(s, consent.pid).some((line) => line.ev === 'wyjscie')).toBe(false);

    writeShadow(s, key);
    await expectNoResult(consent);
    expectCallDumpGone(s);
  }, TIMEOUT);

  it('strażnik wysokości w trybie cienia: odmowa formy jak dziś, bez zrzutu per wywołania i czekania', async () => {
    const s = scene({ tallDialogGuard: true });
    writeAlive(s);
    const run = startHook(s, permissionRequest(s, {
      tool_input: { command: RM_40, description: 'Remove results' },
    }), { HERDR_ENV: '1' });
    const outcome = await run.done;
    expect(outcome.code).toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });

    expect(expectCycle(s, run.pid, ['start', 'bez-czekania', 'wyjscie'])).toMatchObject({
      powod: 'straznik', czekal: false,
    });
    expect(existsSync(join(s.dir, HOOK_PENDING_DIRNAME))).toBe(false);
    expect(existsSync(join(s.dir, 'guard.jsonl'))).toBe(true);
  }, TIMEOUT);
});
