/**
 * Znacznik prośby w hooku.
 *
 * `scripts/hooks/rarog-pending.mjs` przy `PermissionRequest` narzędzia innego niż `AskUserQuestion` pisze
 * `<dataDir>/markers/<sesja>/<nazwa>.json` po walidacji i po skrócie kanonu, PRZED wyborem drogi (strażnik wysokości,
 * cień, kanał zgód, rejestracja, przycięcie, każde wyjście bez czekania), i nigdy go nie kasuje. Bramka: `alive.json`
 * w poprawnym kształcie ze świeżym `ts`, sesja na liście, tryb `main` albo `all` i `markers: true`. Nazwa = klucz per
 * wywołanie, losowany raz i ten sam w zrzucie per wywołanie i w rejestracji kanału zgód.
 *
 * Hook biegnie jako proces potomny (payload na stdin). `alive.json` pisze test, bo serwer pola `markers` jeszcze nie
 * pisze; kanał zgód idzie przez prawdziwy rejestr i gniazdo serwera, jak w `hook-channel.test.ts`. The
 * receipt route confirms every validly signed receipt there (no cycle in these tests).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createConsentHandler, startConsentSocket } from '../src/auth/consent-socket.ts';
import type { ConsentSocket } from '../src/auth/consent-socket.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import {
  HOOK_ALIVE_FILENAME, HOOK_CALL_KEY_PATTERN, HOOK_MARKERS_DIRNAME, HOOK_MARKER_ANON_PATTERN, HOOK_MARKER_ANON_PREFIX,
  HOOK_PENDING_DIRNAME, HOOK_SHADOW_LOG_FILENAME,
} from '../src/herdr/dialogs/hook/contract.ts';
import type {
  HookAliveFile, HookCallDump, HookMarkerFile, HookShadowLogEntry, HookShadowReason,
} from '../src/herdr/dialogs/hook/contract.ts';
import { CONSENT_DIRNAME, CONSENT_REGISTER_ROUTE } from '../src/herdr/dialogs/layer1/contract.ts';
import type { ConsentReasonId } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentClaims } from '../src/herdr/dialogs/layer1/receipt.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256, signConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import type { ConsentSignedFields } from '../src/herdr/dialogs/layer1/sign.ts';
import { HOOK_INSTALL_FILES } from '../src/herdr/hook-config.ts';

const HOOKS = join(import.meta.dirname, '..', '..', 'scripts', 'hooks');
const HOOK = join(HOOKS, 'rarog-pending.mjs');
const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const PROMPT = 'fb908934-26eb-4419-9e30-8adcd4ed356b';
const SUBAGENT = 'a7e5ec6c821818fae';
const BOOT = 'boot-znacznik';
const TIMEOUT = 10_000;
const INPUT = { command: 'rm -rf "$TMPDIR/znacznik"', description: 'Remove temp dir' };
const INPUT_SHA = canonicalSha256(INPUT);
/** Input over the dump ceiling (1 MiB): the marker carries the truncation marker (64 kB preview) and the whole hash. */
const BIG_INPUT = { command: 'x'.repeat(1024 * 1024) };
/** Komenda na 43 wiersze dialogu (`dialog-guard.test.ts`): strażnik wysokości odmawia formy. */
const RM_40 = `rm -r -- ${
  Array.from({ length: 40 }, (_, i) => `wynik-${String(i).padStart(2, '0')}-${'x'.repeat(21)}`).join(' ')
}`;
const TALL_INPUT = { command: RM_40, description: 'Remove results' };
/** `canon.mjs`, który ładuje się, ale rzuca: `consent.mjs` wstaje, skrót kanonu nie. */
const BROKEN_CANON = "export function canonicalSha256() {\n  throw new Error('broken canon');\n}\n";

const dirs: string[] = [];
const children = new Set<ChildProcess>();
const sockets: ConsentSocket[] = [];

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  for (const socket of sockets.splice(0)) await socket.close();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type AliveOver = Partial<Record<keyof HookAliveFile, unknown>>;

interface Scene {
  readonly dir: string;
  readonly project: string;
  readonly registry: ConsentRegistry;
  /** Znaczniki sesji w chwili, gdy gniazdo dostało rejestrację (jedna lista na rejestrację). */
  readonly atRegister: string[][];
}

interface SceneOptions {
  /** Gniazdo rejestracji kanału zgód (domyślnie żywe). */
  readonly socket?: boolean;
  /** Pola `alive.json` ponad domyślne (`main`, `markers: true`); `null` = bez pliku. */
  readonly alive?: AliveOver | null;
  /** Przesunięcie `ts` w `alive.json` względem chwili zapisu. */
  readonly tsOffset?: number;
  /** Treść `alive.json` wprost (np. zepsuty JSON). */
  readonly aliveRaw?: string;
  readonly roots?: Record<string, unknown>;
}

function writeAtomically(file: string, body: string): void {
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

function writeAlive(s: Scene, over: AliveOver = {}, tsOffset = 0): void {
  writeAtomically(join(s.dir, HOOK_ALIVE_FILENAME), JSON.stringify({
    ts: Date.now() + tsOffset, bootId: BOOT, mode: 'main', send: true, sessions: [SESSION], markers: true, ...over,
  }));
}

const markersRoot = (s: Scene): string => join(s.dir, HOOK_MARKERS_DIRNAME);
const markersDir = (s: Scene): string => join(markersRoot(s), SESSION);
const markerNames = (s: Scene): string[] => (existsSync(markersDir(s)) ? readdirSync(markersDir(s)).sort() : []);
const readMarker = (s: Scene, name: string): HookMarkerFile =>
  JSON.parse(readFileSync(join(markersDir(s), name), 'utf8')) as HookMarkerFile;
const modeOf = (path: string): number => statSync(path).mode & 0o777;

/** Zrzuty per wywołanie sesji; w przypadku `zrzut` w miejscu katalogu leży plik, więc zrzutów nie ma. */
const callDumps = (s: Scene): string[] => {
  const dir = join(s.dir, HOOK_PENDING_DIRNAME, SESSION);
  return existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).sort() : [];
};

function readLog(s: Scene): HookShadowLogEntry[] {
  const file = join(s.dir, HOOK_SHADOW_LOG_FILENAME);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as HookShadowLogEntry);
}

/** Katalog danych z korzeniami, `alive.json` (`main`, `markers: true`) i (domyślnie) żywym gniazdem rejestracji. */
async function scene(options: SceneOptions = {}): Promise<Scene> {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-znacznik-'));
  dirs.push(dir);
  const project = join(dir, 'roots', 'Projects', 'demo');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(dir, 'roots.json'), JSON.stringify({ roots: [join(dir, 'roots', 'Projects')], ...options.roots }));
  mkdirSync(join(dir, CONSENT_DIRNAME, SESSION), { recursive: true });
  const registry = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [SESSION], log: () => {} });
  registry.setScope('main');
  const s: Scene = { dir, project, registry, atRegister: [] };
  if (options.socket !== false) {
    const handler = createConsentHandler(registry, createConsentClaims({ registry, confirm: async () => true }));
    const socket = await startConsentSocket(dir, (req, res) => {
      if (req.url === CONSENT_REGISTER_ROUTE) s.atRegister.push(markerNames(s));
      handler(req, res);
    }, () => {});
    if (socket === null) throw new Error('gniazdo rejestracji nie wstało');
    sockets.push(socket);
  }
  if (options.aliveRaw !== undefined) writeAtomically(join(dir, HOOK_ALIVE_FILENAME), options.aliveRaw);
  else if (options.alive !== null) writeAlive(s, options.alive, options.tsOffset);
  return s;
}

const permissionRequest = (s: Scene, over: Record<string, unknown> = {}): string => JSON.stringify({
  session_id: SESSION, cwd: s.project, prompt_id: PROMPT, permission_mode: 'default',
  hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: INPUT, ...over,
});

const QUESTIONS = [{ question: 'Jaki smak?', header: 'Smak', multiSelect: false, options: [{ label: 'A' }] }];
const questionRequest = (s: Scene, event = 'PermissionRequest'): string => permissionRequest(s, {
  hook_event_name: event, tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS },
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
interface HookOptions {
  readonly env?: Record<string, string>;
  readonly args?: readonly string[];
  readonly hook?: string;
}

function startHook(s: Scene, stdin: string, options: HookOptions = {}): Run {
  const child = spawn(process.execPath, [options.hook ?? HOOK, ...(options.args ?? [])], {
    env: { PATH: process.env['PATH'] ?? '', HOME: s.dir, RAROG_DATA_DIR: s.dir, ...options.env },
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

async function until<T>(probe: () => T | null | undefined, what: string, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`nie doczekano: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Kopia hooka w katalogu sceny: pliki instalacji bez `drop`, z treścią z `replace`. */
function hookCopy(s: Scene, change: { drop?: string; replace?: Record<string, string> }): string {
  const copy = join(s.dir, 'kopia');
  mkdirSync(copy);
  for (const name of HOOK_INSTALL_FILES) {
    if (name === change.drop) continue;
    const body = change.replace?.[name];
    if (body === undefined) copyFileSync(join(HOOKS, name), join(copy, name));
    else writeFileSync(join(copy, name), body);
  }
  return join(copy, 'rarog-pending.mjs');
}

interface Registered {
  readonly key: string;
  readonly secret: string;
}

/** Rejestracja hooka w rejestrze serwera i linia `czekam` (hook czeka na plik odpowiedzi). */
async function registered(s: Scene): Promise<Registered> {
  const entry = await until(() => s.registry.entries()[0], 'rejestracja');
  const secret = s.registry.secretOf(SESSION, entry.key);
  if (secret === null) throw new Error('rejestr bez sekretu');
  await until(() => readLog(s).find((line) => line.ev === 'czekam'), 'linia czekam');
  return { key: entry.key, secret };
}

const DECISIONS: Readonly<Record<ConsentReasonId, ConsentSignedFields['decision']>> = {
  'allow': 'allow', 'allow-always': 'allow', 'phone-deny': 'deny', 'phone-deny-siblings': 'deny', 'release': 'release',
};

/** Podpisany plik odpowiedzi dla prośby `INPUT`, jak napisze go serwer. */
function answer(s: Scene, { key, secret }: Registered, reasonId: ConsentReasonId): void {
  const fields: ConsentSignedFields = {
    sessionId: SESSION, key, decision: DECISIONS[reasonId], reasonId, inputSha256: INPUT_SHA,
    cardSha256: consentCardSha256({
      sessionId: SESSION, toolName: 'Bash', toolInput: INPUT, cwd: s.project, agentId: null, permissionMode: 'default',
    }),
    at: Date.now(),
  };
  const file = join(s.dir, CONSENT_DIRNAME, SESSION, `${key}.json`);
  writeAtomically(file, JSON.stringify(signConsentFile(secret, fields)));
}

interface ExitCase {
  readonly nazwa: string;
  readonly powod: HookShadowReason;
  readonly options?: SceneOptions;
  readonly over?: Record<string, unknown>;
  readonly env?: Record<string, string>;
  readonly args?: readonly string[];
  readonly hook?: (s: Scene) => string;
  readonly before?: (s: Scene) => void;
  /** Co robi „serwer” po starcie hooka (plik odpowiedzi, zmiana `alive.json`, sygnał). */
  readonly during?: (s: Scene, run: Run) => Promise<void>;
  /** Decyzja na stdout; brak = pusty stdout. */
  readonly decision?: 'allow' | 'deny';
  /** Pola znacznika inne niż dla prośby wątku głównego z `INPUT`. */
  readonly marker?: Partial<Record<keyof HookMarkerFile, unknown>>;
}

/**
 * Każde wyjście cyklu w trybie `main` z `markers: true`: znacznik powstaje przed wyborem drogi i zostaje po wyjściu,
 * także po odbiorze decyzji, `release`, sufcie i sygnale.
 */
const EXITS: readonly ExitCase[] = [
  {
    nazwa: 'bez `prompt_id`: nazwa `anon-…`, `key: null`', powod: 'klucz', over: { prompt_id: undefined },
    marker: { key: null, promptId: null },
  },
  {
    nazwa: '`prompt_id` ze ścieżką: nazwa `anon-…`, bez kawałka ścieżki', powod: 'klucz',
    over: { prompt_id: '../poza' }, marker: { key: null, promptId: null },
  },
  {
    nazwa: 'zepsuty `canon.mjs`: `inputSha256: null`', powod: 'skrot',
    hook: (s) => hookCopy(s, { replace: { 'canon.mjs': BROKEN_CANON } }), marker: { inputSha256: null },
  },
  {
    nazwa: 'zapis zrzutu per wywołanie się nie udaje', powod: 'zrzut',
    before: (s) => {
      mkdirSync(join(s.dir, HOOK_PENDING_DIRNAME));
      writeFileSync(join(s.dir, HOOK_PENDING_DIRNAME, SESSION), '');
    },
  },
  { nazwa: 'brak gniazda rejestracji', powod: 'rejestracja', options: { socket: false } },
  {
    nazwa: 'wejście ponad sufit: `toolInput` przycięty, skrót całości', powod: 'obciety',
    over: { tool_input: BIG_INPUT },
    marker: {
      toolInput: { rarogTruncated: true, preview: JSON.stringify(BIG_INPUT).slice(0, 64 * 1024) },
      inputSha256: canonicalSha256(BIG_INPUT),
    },
  },
  {
    nazwa: 'prośba subagenta w trybie `main`', powod: 'subagent', over: { agent_id: SUBAGENT },
    marker: { agentId: SUBAGENT },
  },
  {
    nazwa: 'tryb spada do `shadow` w czasie czekania', powod: 'tryb-nizszy',
    during: async (s) => {
      await registered(s);
      writeAlive(s, { mode: 'shadow' });
    },
  },
  {
    nazwa: 'odmowa formy strażnika wysokości (subagent poza kanałem)', powod: 'straznik',
    options: { roots: { tallDialogGuard: true } }, env: { HERDR_ENV: '1' }, decision: 'deny',
    over: { agent_id: SUBAGENT, tool_input: TALL_INPUT },
    marker: { agentId: SUBAGENT, toolInput: TALL_INPUT, inputSha256: canonicalSha256(TALL_INPUT) },
  },
  { nazwa: 'kopia bez `consent.mjs`', powod: 'modul', hook: (s) => hookCopy(s, { drop: 'consent.mjs' }) },
  {
    nazwa: 'weto `alive.json` w drodze cienia (`send: false`, tryb `main`)', powod: 'tryb-nieznany',
    options: { alive: { send: false } },
  },
  {
    nazwa: 'weto `alive.json` w czasie czekania kanału (`send: false`)', powod: 'send',
    during: async (s) => {
      await registered(s);
      writeAlive(s, { send: false });
    },
  },
  {
    nazwa: 'ważny `allow`', powod: 'odbior', decision: 'allow',
    during: async (s) => { answer(s, await registered(s), 'allow'); },
  },
  { nazwa: 'ważny `release`', powod: 'release', during: async (s) => { answer(s, await registered(s), 'release'); } },
  {
    nazwa: 'sufit `--answer-wait`', powod: 'sufit', args: ['--answer-wait=0.5'],
    during: async (s) => { await registered(s); },
  },
  {
    nazwa: 'SIGTERM w czasie czekania', powod: 'sygnal',
    during: async (s, run) => {
      await registered(s);
      run.child.kill('SIGTERM');
    },
  },
];

/**
 * Reasons whose exit happens with the marker gate closed, so this table cannot carry them; the named test covers them.
 * `przerwa`: the restart break ends without a server, and the marker comes only after the break.
 */
const ELSEWHERE: Readonly<Partial<Record<HookShadowReason, string>>> = {
  przerwa: 'server/test/hook-channel-restart.test.ts',
};

describe('znacznik prośby: zapis przed wyborem drogi, bez kasowania', () => {
  it.each(EXITS)('$nazwa → `$powod`', async (c) => {
    const s = await scene(c.options);
    c.before?.(s);
    const hook = c.hook?.(s);
    const run = startHook(s, permissionRequest(s, c.over ?? {}), {
      ...(c.env === undefined ? {} : { env: c.env }), ...(c.args === undefined ? {} : { args: c.args }),
      ...(hook === undefined ? {} : { hook }),
    });
    await c.during?.(s, run);
    const outcome = await run.done;
    expect(outcome).toMatchObject({ code: 0, signal: null, stderr: '' });
    if (c.decision === undefined) expect(outcome.stdout).toBe('');
    else {
      expect(JSON.parse(outcome.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: c.decision } } });
    }
    const log = readLog(s);
    expect(log.at(-1)).toMatchObject({ ev: 'wyjscie', powod: c.powod });

    // Jeden znacznik, po wyjściu nietknięty; pola z kontraktu, nic ponad nie.
    const names = markerNames(s);
    expect(names).toHaveLength(1);
    const name = names[0] ?? '';
    const marker = readMarker(s, name);
    expect(marker).toEqual({
      key: expect.stringMatching(HOOK_CALL_KEY_PATTERN), sessionId: SESSION, promptId: PROMPT, pid: run.pid,
      startedAt: expect.any(Number), toolName: 'Bash', toolInput: INPUT, cwd: s.project, at: expect.any(Number),
      inputSha256: INPUT_SHA, ...c.marker,
    });
    expect(marker.startedAt).toBeLessThanOrEqual(marker.at);
    if (marker.key === null) {
      expect(name).toBe(`${HOOK_MARKER_ANON_PREFIX}${String(run.pid)}-${String(marker.startedAt)}.json`);
      expect(name.slice(0, -'.json'.length)).toMatch(HOOK_MARKER_ANON_PATTERN);
      expect(name.slice(0, -'.json'.length)).not.toMatch(HOOK_CALL_KEY_PATTERN);
    } else {
      expect(name).toBe(`${marker.key}.json`);
      expect(marker.key.startsWith(`${PROMPT}-`)).toBe(true);
    }

    // Po linii `start` i nie później niż pierwsza linia po niej: wybór drogi przyszedł po znaczniku.
    const [start, next] = log;
    expect(start?.ev).toBe('start');
    expect(marker.at).toBeGreaterThanOrEqual(start?.at ?? Number.POSITIVE_INFINITY);
    expect(marker.at).toBeLessThanOrEqual(next?.at ?? Number.NEGATIVE_INFINITY);
    // Ten sam klucz w dzienniku i w rejestracji; rejestracja zastała znacznik na dysku.
    for (const line of log) if (line.key !== undefined) expect(line.key).toBe(marker.key);
    for (const entry of s.registry.entries()) expect(entry.key).toBe(marker.key);
    for (const seen of s.atRegister) expect(seen).toEqual([name]);

    expect(modeOf(join(markersDir(s), name))).toBe(0o600);
    expect(modeOf(markersDir(s))).toBe(0o700);
    expect(modeOf(markersRoot(s))).toBe(0o700);
    // Zrzut per wywołanie znika jak dziś; plik tymczasowy znacznika nie zostaje.
    expect(callDumps(s)).toEqual([]);
  }, TIMEOUT);

  it('tabela obejmuje każdy powód `skipWaiting` z hooka', () => {
    const literal = [...readFileSync(HOOK, 'utf8').matchAll(/\bskipWaiting\('([^']+)'/g)].map((hit) => hit[1] ?? '');
    expect(literal.length, 'wzorzec nie widzi wywołań `skipWaiting`').toBeGreaterThan(0);
    const covered = [...EXITS.map((c) => c.powod), ...Object.keys(ELSEWHERE)];
    for (const reason of literal) expect(covered, reason).toContain(reason);
  });
});

describe('znacznik prośby: jeden klucz na wywołanie', () => {
  it('kanał zgód: znacznik przed rejestracją; znacznik, rejestracja, zrzut i dziennik z tym samym kluczem', async () => {
    const s = await scene();
    const run = startHook(s, permissionRequest(s));
    const reg = await registered(s);
    expect(reg.key).toMatch(HOOK_CALL_KEY_PATTERN);
    expect(s.atRegister).toEqual([[`${reg.key}.json`]]);
    expect(callDumps(s)).toEqual([`${reg.key}.json`]);
    const dump = JSON.parse(
      readFileSync(join(s.dir, HOOK_PENDING_DIRNAME, SESSION, `${reg.key}.json`), 'utf8'),
    ) as HookCallDump;
    const marker = readMarker(s, `${reg.key}.json`);
    const entry = s.registry.entry(SESSION, reg.key);
    // Ten sam nonce: cały klucz, a z nim 32 znaki hex końcówki, jest jeden.
    expect([marker.key, dump.key, entry?.key]).toEqual([reg.key, reg.key, reg.key]);
    expect([marker.pid, marker.startedAt]).toEqual([dump.pid, dump.startedAt]);
    expect([entry?.pid, entry?.startedAt]).toEqual([dump.pid, dump.startedAt]);
    expect([marker.inputSha256, entry?.inputSha256]).toEqual([dump.inputSha256, dump.inputSha256]);
    expect(marker.at).toBeLessThanOrEqual(dump.at);

    answer(s, reg, 'release');
    await run.done;
    expect(readLog(s).filter((line) => line.key !== undefined).map((line) => line.key))
      .toEqual(['czekam', 'odbior', 'wyjscie'].map(() => reg.key));
    expect(markerNames(s)).toEqual([`${reg.key}.json`]);
  }, TIMEOUT);

  it('dwie identyczne prośby naraz: dwa znaczniki o różnych kluczach, każdy = klucz jego rejestracji', async () => {
    const s = await scene();
    const first = startHook(s, permissionRequest(s));
    const second = startHook(s, permissionRequest(s));
    const entries = await until(() => (s.registry.entries().length === 2 ? s.registry.entries() : null), 'rejestracje');
    const [a, b] = entries;
    expect(a?.key).not.toBe(b?.key);
    expect(markerNames(s)).toEqual(entries.map((entry) => `${entry.key}.json`).sort());
    for (const { key, pid, startedAt } of entries) {
      expect(readMarker(s, `${key}.json`)).toMatchObject({ key, pid, startedAt });
    }
    for (const entry of entries) {
      const secret = s.registry.secretOf(SESSION, entry.key);
      if (secret === null) throw new Error('rejestr bez sekretu');
      answer(s, { key: entry.key, secret }, 'release');
    }
    await Promise.all([first.done, second.done]);
    expect(markerNames(s)).toEqual(entries.map((entry) => `${entry.key}.json`).sort());
  }, TIMEOUT);

  // Kontrakt pkt 1: błąd zapisu znacznika połknięty, droga hooka bez zmian.
  it('zapis znacznika się nie udaje (`markers` to plik): rejestracja, czekanie i `allow` jak bez znaczników', async () => {
    const s = await scene();
    writeFileSync(markersRoot(s), '');
    const run = startHook(s, permissionRequest(s));
    const reg = await registered(s);
    expect(s.atRegister).toEqual([[]]);
    answer(s, reg, 'allow');
    const outcome = await run.done;
    expect(outcome).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(JSON.parse(outcome.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
    expect(readLog(s).at(-1)).toMatchObject({ ev: 'wyjscie', powod: 'odbior', key: reg.key });
    expect(statSync(markersRoot(s)).isFile()).toBe(true);
    expect(callDumps(s)).toEqual([]);
  }, TIMEOUT);
});

interface GateCase {
  readonly nazwa: string;
  readonly options?: SceneOptions;
  readonly stdin?: (s: Scene) => string;
  readonly env?: Record<string, string>;
  readonly args?: readonly string[];
  /** Powód wyjścia cyklu; `null` = hook nie zaczyna cyklu (bez linii dziennika). */
  readonly powod: HookShadowReason | null;
}

/** Bramka zamknięta: znacznika nie ma, a hook idzie dzisiejszą drogą (powód wyjścia jak bez znaczników). */
const GATE: readonly GateCase[] = [
  { nazwa: 'bez `alive.json`', options: { alive: null }, powod: 'alive-brak' },
  {
    nazwa: '`alive.json` bez pola `markers` (serwer sprzed znaczników)',
    options: { socket: false, alive: { markers: undefined } }, powod: 'rejestracja',
  },
  { nazwa: '`markers: "true"` (napis)', options: { socket: false, alive: { markers: 'true' } }, powod: 'rejestracja' },
  { nazwa: '`markers: 1`', options: { socket: false, alive: { markers: 1 } }, powod: 'rejestracja' },
  { nazwa: '`ts` sprzed 31 s', options: { tsOffset: -31_000 }, powod: 'alive-ts' },
  { nazwa: '`ts` za 31 s', options: { tsOffset: 31_000 }, powod: 'alive-ts' },
  { nazwa: 'zepsuty JSON', options: { aliveRaw: '{"ts":' }, powod: 'alive-zly' },
  { nazwa: 'sesja spoza listy', options: { alive: { sessions: ['inna-sesja'] } }, powod: 'tryb-nieznany' },
  { nazwa: 'tryb `shadow`', options: { alive: { mode: 'shadow' } }, args: ['--answer-wait=0.3'], powod: 'sufit' },
  { nazwa: 'tryb `off`', options: { alive: { mode: 'off' } }, powod: 'tryb-off' },
  { nazwa: 'tryb nieznany hookowi', options: { alive: { mode: 'nieznany' } }, powod: 'tryb-nieznany' },
  { nazwa: '`cwd` poza korzeniami', stdin: (s) => permissionRequest(s, { cwd: s.dir }), powod: null },
  {
    nazwa: 'pytanie `AskUserQuestion` (`PermissionRequest`)', stdin: (s) => questionRequest(s),
    args: ['--answer-wait=0.3'], powod: null,
  },
  { nazwa: 'pytanie `AskUserQuestion` (`PreToolUse`)', stdin: (s) => questionRequest(s, 'PreToolUse'), powod: null },
  { nazwa: 'sesja programowa', env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, powod: null },
];

describe('znacznik prośby: bramka zamknięta = bez znacznika', () => {
  it.each(GATE)('$nazwa', async (c) => {
    const s = await scene(c.options);
    const run = startHook(s, c.stdin?.(s) ?? permissionRequest(s), {
      ...(c.env === undefined ? {} : { env: c.env }), ...(c.args === undefined ? {} : { args: c.args }),
    });
    const outcome = await run.done;
    expect(outcome).toEqual({ code: 0, signal: null, stdout: '', stderr: '' });
    expect(existsSync(markersRoot(s))).toBe(false);
    const log = readLog(s);
    if (c.powod === null) expect(log).toEqual([]);
    else expect(log.at(-1)).toMatchObject({ ev: 'wyjscie', powod: c.powod });
  }, TIMEOUT);
});
