/**
 * Kanał zgód w hooku (warstwa 1): `scripts/hooks/rarog-pending.mjs` z modułem `scripts/hooks/consent.mjs`.
 *
 * Hook w trybie `main` (albo `all`) z `alive.json` rejestruje sekret na gnieździe `<dataDir>/run/consent.sock`,
 * czeka na podpisany plik `<dataDir>/consent/<sesja>/<klucz>.json`, przejmuje go (`rename` na `.claimed`), dopiero
 * potem czyta i weryfikuje, a CLI oddaje `allow`, gołe `deny` albo ciszę (`release`). Każda inna ścieżka kończy się
 * BEZ decyzji: dialog zostaje przy biurku.
 *
 * Hook biegnie w procesie potomnym przeciw prawdziwemu rejestrowi i gniazdu serwera (`layer1/registry.ts`,
 * `auth/consent-socket.ts`), a pliki odpowiedzi podpisuje `layer1/sign.ts` — tak jak zrobi to serwer. The receipt
 * route (`POST /claim`, `layer1/receipt.ts`) checks the hook's real receipt signature; without a cycle here, the
 * record's side confirms every signed receipt (the record rule: `layer1-receipt.test.ts`). Wyścig
 * przejęcia i wspólne wektory podpisu idą przez `consent.mjs` w tym procesie, z podmienionymi operacjami na dysku.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createConsentHandler, startConsentSocket } from '../src/auth/consent-socket.ts';
import type { ConsentSocket } from '../src/auth/consent-socket.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import {
  HOOK_ALIVE_FILENAME, HOOK_ALIVE_MODES, HOOK_CALL_KEY_PATTERN, HOOK_PENDING_DIRNAME, HOOK_POLL_MS,
  HOOK_SHADOW_LOG_EVENTS, HOOK_SHADOW_LOG_FILENAME, HOOK_SHADOW_REASONS,
} from '../src/herdr/dialogs/hook/contract.ts';
import type { HookAliveFile, HookShadowLogEntry, HookShadowReason } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_CLAIMED_SUFFIX, CONSENT_DENY_MESSAGE, CONSENT_DIRNAME, CONSENT_REGISTER_ROUTE, CONSENT_REJECTED_SUFFIX,
  CONSENT_REVOKED_SUFFIX,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentClaims } from '../src/herdr/dialogs/layer1/receipt.ts';
import type { ConsentFile, ConsentReasonId } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256, signConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import type { ConsentExpectation, ConsentSignedFields, ConsentVerdict } from '../src/herdr/dialogs/layer1/sign.ts';
import { HOOK_INSTALL_FILES, hookCopyReport, hookInstallDir } from '../src/herdr/hook-config.ts';

const REPO = join(import.meta.dirname, '..', '..');
const HOOKS = join(REPO, 'scripts', 'hooks');
const HOOK = join(HOOKS, 'rarog-pending.mjs');
const CONSENT = join(HOOKS, 'consent.mjs');
const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const PROMPT = 'fb908934-26eb-4419-9e30-8adcd4ed356b';
const BOOT = 'boot-kanal';
const TIMEOUT = 10_000;
/** Wyjście po zmianie `alive.json`: jedno odpytanie i zapas na odczyt i zapis dziennika. */
const VETO_EXIT_MAX_MS = HOOK_POLL_MS + 150;
const INPUT = { command: 'rm -rf "$TMPDIR/kanal"', description: 'Remove temp dir' };
const INPUT_SHA = canonicalSha256(INPUT);

/** Interfejs `consent.mjs` używany w teście (moduł JS bez typów). */
interface IoCalls {
  rename(from: string, to: string): void;
  readClaimed(path: string): string | null;
}
interface WaitOutcome {
  readonly outcome: 'claimed' | 'veto';
  readonly file?: ConsentFile;
}
interface ConsentModule {
  readonly NODE_IO: IoCalls;
  readonly DENY_MESSAGE: string;
  macMessage(fields: ConsentSignedFields): string;
  signFields(secret: string, fields: ConsentSignedFields): string;
  cardSha256(card: Readonly<Record<string, unknown>>): string;
  verifyConsentFile(raw: unknown, expected: ConsentExpectation): ConsentVerdict;
  waitForConsent(options: {
    base: string; expected: ConsentExpectation; pollMs: number;
    veto: () => Record<string, unknown> | null; onRejected: (reason: string, n: number) => void;
    io?: IoCalls; sleep?: (ms: number) => Promise<void>;
  }): Promise<WaitOutcome>;
}
const consentModule = async (): Promise<ConsentModule> =>
  (await import(pathToFileURL(CONSENT).href)) as ConsentModule;

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

interface Scene {
  readonly dir: string;
  readonly project: string;
  readonly registry: ConsentRegistry;
  /** Stan katalogu w chwili, gdy gniazdo dostało rejestrację: zrzuty per wywołanie i linie dziennika z kluczem. */
  readonly atRegister: { dumps: string[]; keyedLines: number }[];
}

function writeAtomically(file: string, body: string): void {
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

function writeAlive(s: Scene, over: Partial<Record<keyof HookAliveFile, unknown>> = {}): number {
  const ts = Date.now();
  writeAtomically(join(s.dir, HOOK_ALIVE_FILENAME), JSON.stringify({
    ts, bootId: BOOT, mode: 'main', send: true, sessions: [SESSION], ...over,
  }));
  return ts;
}

const callDumps = (s: Scene): string[] => {
  const dir = join(s.dir, HOOK_PENDING_DIRNAME, SESSION);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

function readLog(s: Scene): HookShadowLogEntry[] {
  const file = join(s.dir, HOOK_SHADOW_LOG_FILENAME);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as HookShadowLogEntry);
}

/** Katalog danych z korzeniami, `alive.json` w trybie `main` i (domyślnie) żywym gniazdem rejestracji. */
async function scene(options: { socket?: boolean; alive?: Partial<Record<keyof HookAliveFile, unknown>> } = {}):
Promise<Scene> {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-kanal-'));
  dirs.push(dir);
  const project = join(dir, 'roots', 'Projects', 'demo');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(dir, 'roots.json'), JSON.stringify({ roots: [join(dir, 'roots', 'Projects')] }));
  mkdirSync(join(dir, CONSENT_DIRNAME, SESSION), { recursive: true });
  const registry = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [SESSION], log: () => {} });
  registry.setScope('main');
  const s: Scene = { dir, project, registry, atRegister: [] };
  if (options.socket !== false) {
    const handler = createConsentHandler(registry, createConsentClaims({ registry, confirm: async () => true }));
    const socket = await startConsentSocket(dir, (req, res) => {
      if (req.url === CONSENT_REGISTER_ROUTE) {
        s.atRegister.push({
          dumps: callDumps(s), keyedLines: readLog(s).filter((line) => line.key !== undefined).length,
        });
      }
      handler(req, res);
    }, () => {});
    if (socket === null) throw new Error('gniazdo rejestracji nie wstało');
    sockets.push(socket);
  }
  writeAlive(s, options.alive);
  return s;
}

const permissionRequest = (s: Scene, over: Record<string, unknown> = {}): string => JSON.stringify({
  session_id: SESSION, cwd: s.project, prompt_id: PROMPT, permission_mode: 'default',
  hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: INPUT, ...over,
});

interface Outcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}
interface Run {
  readonly child: ChildProcess;
  readonly env: Record<string, string>;
  readonly done: Promise<Outcome>;
  readonly exited: () => boolean;
}

function startHook(s: Scene, stdin: string, hook = HOOK): Run {
  const env = { PATH: process.env['PATH'] ?? '', HOME: s.dir, RAROG_DATA_DIR: s.dir };
  const child = spawn(process.execPath, [hook], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let closed = false;
  const done = new Promise<Outcome>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      closed = true;
      children.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
  child.stdin?.end(stdin);
  return { child, env, done, exited: () => closed };
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

interface Registered {
  readonly key: string;
  readonly secret: string;
}

/** Rejestracja hooka w rejestrze serwera i linia `czekam` (hook czeka na plik). */
async function registered(s: Scene): Promise<Registered> {
  const entry = await until(() => s.registry.entries()[0], 'rejestracja');
  const secret = s.registry.secretOf(SESSION, entry.key);
  if (secret === null) throw new Error('rejestr bez sekretu');
  await until(() => readLog(s).find((line) => line.ev === 'czekam'), 'linia czekam');
  return { key: entry.key, secret };
}

const base = (s: Scene, key: string): string => join(s.dir, CONSENT_DIRNAME, SESSION, key);
const answerPath = (s: Scene, key: string, suffix = '.json'): string => `${base(s, key)}${suffix}`;

const DECISIONS: Readonly<Record<ConsentReasonId, ConsentSignedFields['decision']>> = {
  'allow': 'allow', 'allow-always': 'allow', 'phone-deny': 'deny', 'phone-deny-siblings': 'deny', 'release': 'release',
};

/** Pola podpisu dla prośby ze stdin: skróty liczone tak, jak liczy je serwer. */
function fieldsFor(s: Scene, key: string, reasonId: ConsentReasonId, over: Partial<ConsentSignedFields> = {}):
ConsentSignedFields {
  return {
    sessionId: SESSION, key, decision: DECISIONS[reasonId], reasonId, inputSha256: INPUT_SHA,
    cardSha256: consentCardSha256({
      sessionId: SESSION, toolName: 'Bash', toolInput: INPUT, cwd: s.project, agentId: null,
      permissionMode: 'default',
    }),
    at: Date.now(), ...over,
  };
}

function writeAnswer(s: Scene, key: string, body: unknown): void {
  writeAtomically(answerPath(s, key), JSON.stringify(body));
}

const exitOf = (s: Scene): HookShadowLogEntry | undefined => readLog(s).find((line) => line.ev === 'wyjscie');

async function expectNoDecision(s: Scene, run: Run, powod: HookShadowReason): Promise<Outcome> {
  const outcome = await run.done;
  expect(outcome).toMatchObject({ code: 0, signal: null, stdout: '', stderr: '' });
  expect(exitOf(s)?.powod).toBe(powod);
  expect(callDumps(s)).toEqual([]);
  return outcome;
}

describe('kanał zgód w hooku: decyzja z podpisanego pliku', () => {
  it('ważny `allow` → `rename` na `.claimed`, stdout `allow` bez `updatedInput`, kod 0', async () => {
    const s = await scene();
    const run = startHook(s, permissionRequest(s));
    const { key, secret } = await registered(s);
    expect(key).toMatch(HOOK_CALL_KEY_PATTERN);
    expect(key.startsWith(`${PROMPT}-`)).toBe(true);
    const entry = s.registry.entry(SESSION, key);
    expect(entry).toMatchObject({ inputSha256: INPUT_SHA, cardSha256: fieldsFor(s, key, 'allow').cardSha256 });
    expect(entry?.agentId).toBeUndefined();
    // Rejestracja PRZED zrzutem per wywołanie i przed linią dziennika z kluczem.
    expect(s.atRegister).toEqual([{ dumps: [], keyedLines: 0 }]);
    expect(callDumps(s)).toEqual([`${key}.json`]);

    writeAnswer(s, key, signConsentFile(secret, fieldsFor(s, key, 'allow')));
    const outcome = await run.done;
    expect(outcome).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(JSON.parse(outcome.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(existsSync(answerPath(s, key, CONSENT_CLAIMED_SUFFIX))).toBe(true);
    expect(existsSync(answerPath(s, key))).toBe(false);
    expect(callDumps(s)).toEqual([]);
    const log = readLog(s);
    expect(log.map((line) => line.ev)).toEqual(['start', 'czekam', 'odbior', 'wyjscie']);
    expect(log.find((line) => line.ev === 'czekam')).toMatchObject({ key, tryb: 'main', bootId: BOOT });
    expect(log.find((line) => line.ev === 'odbior')).toMatchObject({ key, decyzja: 'allow', szczegol: 'allow' });
    expect(exitOf(s)).toMatchObject({ key, powod: 'odbior', czekal: true });
  }, TIMEOUT);

  it('sekret rejestracji nie wychodzi poza gniazdo: argv, env, dziennik, zrzuty, pliki, stdout i stderr', async () => {
    const s = await scene();
    const run = startHook(s, permissionRequest(s));
    const { key, secret } = await registered(s);
    writeAnswer(s, key, signConsentFile(secret, fieldsFor(s, key, 'phone-deny')));
    const outcome = await run.done;
    expect(outcome.stdout).not.toContain(secret);
    expect(outcome.stderr).not.toContain(secret);
    expect(run.child.spawnargs.join(' ')).not.toContain(secret);
    expect(JSON.stringify(run.env)).not.toContain(secret);
    // Każdy zwykły plik w katalogu testu (dziennik, zrzuty, plik odpowiedzi, `alive.json`): bez sekretu.
    const seen: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const info = lstatSync(path);
        if (info.isDirectory()) walk(path);
        else if (info.isFile()) {
          seen.push(path);
          expect(readFileSync(path, 'utf8'), path).not.toContain(secret);
        }
      }
    };
    walk(s.dir);
    expect(seen).toContain(join(s.dir, HOOK_SHADOW_LOG_FILENAME));
    expect(seen).toContain(answerPath(s, key, CONSENT_CLAIMED_SUFFIX));
  }, TIMEOUT);

  it('`phone-deny` → gołe `deny` z angielskim tekstem z listy, sam ASCII', async () => {
    const s = await scene();
    const run = startHook(s, permissionRequest(s));
    const { key, secret } = await registered(s);
    writeAnswer(s, key, signConsentFile(secret, fieldsFor(s, key, 'phone-deny')));
    const outcome = await run.done;
    expect(outcome.code).toBe(0);
    expect(JSON.parse(outcome.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: CONSENT_DENY_MESSAGE },
      },
    });
    expect(CONSENT_DENY_MESSAGE).toMatch(/^[\x20-\x7e]+$/);
    expect((await consentModule()).DENY_MESSAGE).toBe(CONSENT_DENY_MESSAGE);
  }, TIMEOUT);

  it('`release` → wyjście bez decyzji (dialog zostaje przy biurku)', async () => {
    const s = await scene();
    const run = startHook(s, permissionRequest(s));
    const { key, secret } = await registered(s);
    writeAnswer(s, key, signConsentFile(secret, fieldsFor(s, key, 'release')));
    await expectNoDecision(s, run, 'release');
    expect(existsSync(answerPath(s, key, CONSENT_CLAIMED_SUFFIX))).toBe(true);
  }, TIMEOUT);

  it('`ExitPlanMode`: `allow` oddaje w `updatedInput` wejście ze stdin', async () => {
    const s = await scene();
    const plan = { plan: '# Plan\n\n1. krok' };
    const run = startHook(s, permissionRequest(s, { tool_name: 'ExitPlanMode', tool_input: plan }));
    const { key, secret } = await registered(s);
    writeAnswer(s, key, signConsentFile(secret, fieldsFor(s, key, 'allow', {
      inputSha256: canonicalSha256(plan),
      cardSha256: consentCardSha256({
        sessionId: SESSION, toolName: 'ExitPlanMode', toolInput: plan, cwd: s.project, agentId: null,
        permissionMode: 'default',
      }),
    })));
    const outcome = await run.done;
    expect(JSON.parse(outcome.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: plan } },
    });
  }, TIMEOUT);
});

describe('kanał zgód w hooku: plik nieważny idzie na bok, czekanie trwa', () => {
  it('plik z polem `message` → `.rejected`, hook czeka dalej, następny ważny plik → `allow`', async () => {
    const s = await scene();
    const run = startHook(s, permissionRequest(s));
    const { key, secret } = await registered(s);
    writeAnswer(s, key, { ...signConsentFile(secret, fieldsFor(s, key, 'allow')), message: 'Zrób to inaczej.' });
    await until(() => existsSync(answerPath(s, key, `.1${CONSENT_REJECTED_SUFFIX}`)) || null, 'plik odłożony');
    expect(run.exited()).toBe(false);
    writeAnswer(s, key, signConsentFile(secret, fieldsFor(s, key, 'allow')));
    const outcome = await run.done;
    expect(JSON.parse(outcome.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(readLog(s).filter((line) => line.ev === 'odrzucony')).toEqual([
      expect.objectContaining({ key, powod: 'podpis', szczegol: 'message', n: 1 }),
    ]);
  }, TIMEOUT);

  it('zły podpis i inny `cardSha256` → `.rejected` każdy, bez decyzji', async () => {
    const s = await scene();
    const run = startHook(s, permissionRequest(s));
    const { key, secret } = await registered(s);
    const other = secret.replace(/^./, secret.startsWith('0') ? '1' : '0');
    writeAnswer(s, key, signConsentFile(other, fieldsFor(s, key, 'allow')));
    await until(() => existsSync(answerPath(s, key, `.1${CONSENT_REJECTED_SUFFIX}`)) || null, 'pierwszy odłożony');
    const otherCard = consentCardSha256({
      sessionId: SESSION, toolName: 'Bash', toolInput: INPUT, cwd: join(s.dir, 'inny'), agentId: null,
      permissionMode: 'default',
    });
    writeAnswer(s, key, signConsentFile(secret, fieldsFor(s, key, 'allow', { cardSha256: otherCard })));
    await until(() => existsSync(answerPath(s, key, `.2${CONSENT_REJECTED_SUFFIX}`)) || null, 'drugi odłożony');
    expect(run.exited()).toBe(false);
    writeAlive(s, { mode: 'shadow' });
    await expectNoDecision(s, run, 'tryb-nizszy');
    expect(readLog(s).filter((line) => line.ev === 'odrzucony').map((line) => [line.powod, line.szczegol, line.n]))
      .toEqual([['podpis', 'mac', 1], ['karta-inna', 'card', 2]]);
  }, TIMEOUT);
});

describe('kanał zgód w hooku: wyjście bez decyzji', () => {
  it.each([
    ['tryb `off`', { mode: 'off' }, 'tryb-nizszy'],
    ['tryb `shadow`', { mode: 'shadow' }, 'tryb-nizszy'],
    ['nowy `bootId`', { bootId: 'boot-nowy' }, 'restart'],
    ['tryb spoza listy', { mode: 'nieznany' }, 'tryb-nieznany'],
  ] as const)('`alive.json` w czasie czekania: %s → wyjście w jednym odpytaniu', async (_nazwa, alive, powod) => {
    const s = await scene();
    const run = startHook(s, permissionRequest(s));
    await registered(s);
    const ts = writeAlive(s, alive);
    await expectNoDecision(s, run, powod);
    const exit = exitOf(s);
    expect(exit?.aliveTs).toBe(ts);
    expect((exit?.at ?? Infinity) - ts).toBeLessThanOrEqual(VETO_EXIT_MAX_MS);
  }, TIMEOUT);

  it('brak gniazda rejestracji → bez czekania (`rejestracja`), zrzut per wywołanie posprzątany', async () => {
    const s = await scene({ socket: false });
    const run = startHook(s, permissionRequest(s));
    await expectNoDecision(s, run, 'rejestracja');
    expect(readLog(s).find((line) => line.ev === 'bez-czekania')).toMatchObject({
      powod: 'rejestracja', szczegol: 'socket',
    });
    expect(readLog(s).some((line) => line.ev === 'czekam')).toBe(false);
  }, TIMEOUT);

  it('tryb `main` i prośba subagenta (`agent_id`): poza kanałem, bez rejestracji i bez decyzji', async () => {
    const s = await scene();
    const run = startHook(s, permissionRequest(s, { agent_id: 'a1b2c3' }));
    await expectNoDecision(s, run, 'subagent');
    expect(s.registry.entries()).toEqual([]);
    expect(s.atRegister).toEqual([]);
  }, TIMEOUT);

  it('kopia bez `consent.mjs` → hook nie oddaje decyzji, status kopii inny niż `ok`', async () => {
    const s = await scene();
    const home = join(s.dir, 'home');
    const copy = hookInstallDir(home);
    mkdirSync(copy, { recursive: true });
    for (const name of HOOK_INSTALL_FILES) copyFileSync(join(HOOKS, name), join(copy, name));
    expect(hookCopyReport(home, REPO).ok).toBe(true);
    unlinkSync(join(copy, 'consent.mjs'));
    const report = hookCopyReport(home, REPO);
    expect(report.ok).toBe(false);
    expect(report.files.find((one) => one.name === 'consent.mjs')?.state).toBe('missing');

    const run = startHook(s, permissionRequest(s), join(copy, 'rarog-pending.mjs'));
    await expectNoDecision(s, run, 'modul');
    expect(s.registry.entries()).toEqual([]);
  }, TIMEOUT);

  it('powody i rodzaje linii z tego pliku należą do kontraktu; tryby `main` i `all` zna hook', () => {
    expect(HOOK_SHADOW_REASONS).toEqual(expect.arrayContaining([
      'modul', 'rejestracja', 'podpis', 'karta-inna', 'release', 'restart', 'tryb-nizszy',
    ]));
    expect(HOOK_SHADOW_LOG_EVENTS).toContain('odrzucony');
    expect(HOOK_ALIVE_MODES).toEqual(expect.arrayContaining(['main', 'all']));
  });
});

describe('kanał zgód w hooku: tryb `all`', () => {
  it('prośba wątku głównego w `all` idzie kanałem tak samo jak w `main`', async () => {
    const s = await scene({ alive: { mode: 'all' } });
    const run = startHook(s, permissionRequest(s));
    const { key, secret } = await registered(s);
    expect(readLog(s).find((line) => line.ev === 'czekam')?.tryb).toBe('all');
    writeAnswer(s, key, signConsentFile(secret, fieldsFor(s, key, 'allow')));
    const outcome = await run.done;
    expect(JSON.parse(outcome.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
  }, TIMEOUT);
});

describe('`consent.mjs`: przejęcie przed odczytem i wyścig z serwerem', () => {
  const SECRET = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  const KEY = `${PROMPT}-00112233445566778899aabbccddeeff`;
  const CARD = 'ff79188ab85878638314e56548b89166e042ef58a393025fa5b5257715a43ff0';

  function fields(reasonId: ConsentReasonId, at: number): ConsentSignedFields {
    return {
      sessionId: SESSION, key: KEY, decision: DECISIONS[reasonId], reasonId, inputSha256: INPUT_SHA, cardSha256: CARD,
      at,
    };
  }

  it('`allow` → `release` przed `rename` hooka: wykonuje się WYŁĄCZNIE przejęta treść, bez odczytu `.json`', async () => {
    const consent = await consentModule();
    const dir = mkdtempSync(join(tmpdir(), 'rarog-kanal-wyscig-'));
    dirs.push(dir);
    const where = join(dir, KEY);
    let clock = 1_767_225_600_000;
    writeAtomically(`${where}.json`, JSON.stringify(signConsentFile(SECRET, fields('allow', clock))));
    const calls: string[] = [];
    let raced = false;
    const io: IoCalls = {
      rename(from, to) {
        // Serwer między odczytem katalogu a `rename` hooka: odwołuje `allow` i kładzie `release` pod tym kluczem.
        if (!raced && from === `${where}.json`) {
          raced = true;
          renameSync(`${where}.json`, `${where}${CONSENT_REVOKED_SUFFIX}`);
          writeAtomically(`${where}.json`, JSON.stringify(signConsentFile(SECRET, fields('release', clock + 1))));
        }
        calls.push(`rename ${from} → ${to}`);
        consent.NODE_IO.rename(from, to);
      },
      readClaimed(path) {
        calls.push(`read ${path}`);
        return consent.NODE_IO.readClaimed(path);
      },
    };
    const result = await consent.waitForConsent({
      base: where,
      expected: {
        secret: SECRET, sessionId: SESSION, key: KEY, inputSha256: INPUT_SHA, cardSha256: CARD, notBefore: clock - 60_000,
      },
      pollMs: HOOK_POLL_MS, veto: () => null, onRejected: () => {}, io,
      sleep: (ms) => { clock += ms; return Promise.resolve(); },
    });
    expect(result).toMatchObject({ outcome: 'claimed', file: { decision: 'release', reasonId: 'release' } });
    expect(calls).toEqual([
      `rename ${where}.json → ${where}${CONSENT_CLAIMED_SUFFIX}`,
      `read ${where}${CONSENT_CLAIMED_SUFFIX}`,
    ]);
    expect(existsSync(`${where}${CONSENT_REVOKED_SUFFIX}`)).toBe(true);
  });

  it('strażnik: hook nie czyta pliku odpowiedzi poza przejętym `.claimed` (każdy plik, każde okrążenie)', async () => {
    const consent = await consentModule();
    const dir = mkdtempSync(join(tmpdir(), 'rarog-kanal-straz-'));
    dirs.push(dir);
    const where = join(dir, KEY);
    let clock = 1_767_225_600_000;
    const reads: string[] = [];
    const renames: string[] = [];
    const queue = [
      JSON.stringify({ ...signConsentFile(SECRET, fields('allow', clock)), message: 'x' }),
      'nie JSON',
      JSON.stringify(signConsentFile(SECRET, fields('phone-deny', clock))),
    ];
    const io: IoCalls = {
      rename(from, to) {
        renames.push(to);
        consent.NODE_IO.rename(from, to);
      },
      readClaimed(path) {
        reads.push(path);
        return consent.NODE_IO.readClaimed(path);
      },
    };
    const rejected: [string, number][] = [];
    const result = await consent.waitForConsent({
      base: where,
      expected: {
        secret: SECRET, sessionId: SESSION, key: KEY, inputSha256: INPUT_SHA, cardSha256: CARD, notBefore: clock - 60_000,
      },
      pollMs: HOOK_POLL_MS,
      veto: () => {
        const next = queue.shift();
        if (next !== undefined && !existsSync(`${where}.json`)) writeAtomically(`${where}.json`, next);
        return null;
      },
      onRejected: (reason, n) => { rejected.push([reason, n]); }, io,
      sleep: (ms) => { clock += ms; return Promise.resolve(); },
    });
    expect(result).toMatchObject({ outcome: 'claimed', file: { reasonId: 'phone-deny' } });
    expect(rejected).toEqual([['message', 1], ['shape', 2]]);
    expect(new Set(reads)).toEqual(new Set([`${where}${CONSENT_CLAIMED_SUFFIX}`]));
    expect(renames).toEqual([
      `${where}${CONSENT_CLAIMED_SUFFIX}`, `${where}.1${CONSENT_REJECTED_SUFFIX}`,
      `${where}${CONSENT_CLAIMED_SUFFIX}`, `${where}.2${CONSENT_REJECTED_SUFFIX}`,
      `${where}${CONSENT_CLAIMED_SUFFIX}`,
    ]);
  });

  it('termin trzyma weto (atrapa zegara): bez pliku czeka co `pollMs`; weto przed przejęciem zostawia plik', async () => {
    const consent = await consentModule();
    const dir = mkdtempSync(join(tmpdir(), 'rarog-kanal-termin-'));
    dirs.push(dir);
    let clock = 0;
    const expected = {
      secret: SECRET, sessionId: SESSION, key: KEY, inputSha256: INPUT_SHA, cardSha256: CARD, notBefore: 0,
    };
    const sleep = (ms: number): Promise<void> => { clock += ms; return Promise.resolve(); };
    expect(await consent.waitForConsent({
      base: join(dir, KEY), expected, pollMs: 250, veto: () => (clock >= 1_000 ? { powod: 'sufit' } : null),
      onRejected: () => {}, sleep,
    })).toEqual({ outcome: 'veto', powod: 'sufit' });
    expect(clock).toBe(1_000);
    writeAtomically(join(dir, `${KEY}.json`), JSON.stringify(signConsentFile(SECRET, fields('allow', 1))));
    expect(await consent.waitForConsent({
      base: join(dir, KEY), expected, pollMs: 250, veto: () => ({ powod: 'restart' }), onRejected: () => {}, sleep,
    })).toEqual({ outcome: 'veto', powod: 'restart' });
    expect(existsSync(join(dir, `${KEY}.json`))).toBe(true);
  });
});

/** Wspólne wektory podpisu (`server/test/hook-canon.test.ts` liczy je przez `layer1/sign.ts`). */
interface Podpis {
  readonly karty: readonly { readonly nazwa: string; readonly pola: Record<string, unknown>; readonly sha256: string }[];
  readonly wiadomosci: readonly {
    readonly nazwa: string; readonly sekret: string; readonly pola: ConsentSignedFields; readonly wiadomosc: string;
    readonly mac: string;
  }[];
  readonly rozjazdy: {
    readonly baza: string;
    readonly zmiany: readonly {
      readonly nazwa: string; readonly pola?: Partial<ConsentSignedFields>; readonly sekret?: string; readonly mac: string;
    }[];
  };
  readonly weryfikacja: {
    readonly oczekiwane: {
      readonly sekret: string; readonly sessionId: string; readonly key: string; readonly inputSha256: string;
      readonly cardSha256: string; readonly notBefore: number; readonly permissionsSha256: string;
    };
    readonly przypadki: readonly { readonly nazwa: string; readonly plik: unknown; readonly wynik: string }[];
  };
}
const PODPIS = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'hook-kanon', 'podpis.json'), 'utf8'),
) as Podpis;

describe('`consent.mjs`: wspólne wektory podpisu `podpis.json`', () => {
  it.each(PODPIS.karty.map((k) => [k.nazwa, k] as const))('`cardSha256`: %s', async (_nazwa, k) => {
    expect((await consentModule()).cardSha256(k.pola)).toBe(k.sha256);
  });

  it.each(PODPIS.wiadomosci.map((w) => [w.nazwa, w] as const))('wiadomość i `mac`: %s', async (_nazwa, w) => {
    const consent = await consentModule();
    expect(consent.macMessage(w.pola)).toBe(w.wiadomosc);
    expect(consent.signFields(w.sekret, w.pola)).toBe(w.mac);
  });

  it.each(PODPIS.rozjazdy.zmiany.map((z) => [z.nazwa, z] as const))('rozjazd daje inny `mac`: %s', async (_nazwa, z) => {
    const consent = await consentModule();
    const baza = PODPIS.wiadomosci.find((w) => w.nazwa === PODPIS.rozjazdy.baza);
    if (baza === undefined) throw new Error('podpis.json: brak bazy rozjazdów');
    expect(consent.signFields(z.sekret ?? baza.sekret, { ...baza.pola, ...z.pola })).toBe(z.mac);
  });

  it.each(PODPIS.weryfikacja.przypadki.map((p) => [p.nazwa, p] as const))('weryfikacja: %s', async (_nazwa, p) => {
    const o = PODPIS.weryfikacja.oczekiwane;
    const verdict = (await consentModule()).verifyConsentFile(p.plik, {
      secret: o.sekret, sessionId: o.sessionId, key: o.key, inputSha256: o.inputSha256, cardSha256: o.cardSha256,
      notBefore: o.notBefore, permissionsSha256: o.permissionsSha256,
    });
    expect(verdict).toEqual(p.wynik === 'ok' ? { ok: true, file: p.plik } : { ok: false, reason: p.wynik });
  });

  it('wektory obejmują obcą sesję, inny klucz, inne wejście, `reasonId`, stare `at` i nadmiarowe pola', () => {
    const wyniki = new Set(PODPIS.weryfikacja.przypadki.map((p) => p.wynik));
    for (const wynik of ['binding', 'input', 'card', 'stale', 'shape', 'mac', 'message']) expect(wyniki).toContain(wynik);
  });
});
