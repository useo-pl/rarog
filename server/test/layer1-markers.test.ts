/**
 * Znaczniki prośby w puli sesji kanału zgód (warstwa 1): serwer czyta `markers/<sesja>/<nazwa>.json`
 * (pisze je hook, `HookMarkerFile`) do puli i je sprząta.
 *
 * Pula = zrzuty ∪ znaczniki, jeden kandydat na klucz. Kandydat z samego znacznika (prośba bez czekania hooka, znacznik
 * `anon-…`, zrzut zniknięty przed odczytem) nie ma dowodu własnego, ale jako kandydat zabiera dowód bliźniakowi tej
 * samej tożsamości. Kandydat subagenta ze znacznikiem wychodzi z puli dopiero po potwierdzonej śmierci hooka i świeżym
 * rejestrze bez `waiting` co najmniej `REGISTRY_SLACK_MS` później. Znacznik znika po wyjściu kandydata i terminie
 * odczytów, na końcu sesji i przy starcie po 7 dniach.
 *
 * Każdy przypadek idzie przez prawdziwą obserwację sesji (zrzuty i znaczniki na dysku, atrapa `ps`), prawdziwy cykl
 * z rejestrem sekretów i parser ekranu na dialogu `Bash` z pomiaru (CLI 2.1.293). Zegar podaje test.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_MARKERS_DIRNAME, HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump, HookMarkerFile } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_DIRNAME, CONSENT_HOOK_CHECKS_MAX, CONSENT_POOL_MAX, CONSENT_PROOF_TTL_MS, CONSENT_SECRET_BYTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle, ConsentCycleIo } from '../src/herdr/dialogs/layer1/cycle.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentSessionObservation } from '../src/herdr/dialogs/layer1/observe.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { CONSENT_NOT_BEFORE_MARGIN_MS, consentCardSha256, verifyConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import { matchTop } from '../src/herdr/dialogs/layer1/top.ts';
import type { ConsentScreenRead } from '../src/herdr/dialogs/layer1/top.ts';
import { REGISTRY_SLACK_MS } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import { scanMarkers } from '../src/herdr/dialogs/shadow/files.ts';
import type { HookProcess, ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';
import { MARKER_RETENTION_MS, sweepMarkerFiles } from '../src/herdr/dialogs/shadow/sweep.ts';
import { CLI_WAITING_POLL_MS } from '../src/sessions/state-sentences.ts';

/**
 * Znacznik znikający między `readdir` a odczytem: po wylistowaniu katalogu `dir` test kasuje plik. Bez uzbrojenia
 * `readdirSync` działa jak zwykle.
 */
const listing = vi.hoisted(() => ({
  after: null as { readonly dir: string; readonly remove: string } | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readdirSync = ((...args: Parameters<typeof real.readdirSync>) => {
    const names = real.readdirSync(...args);
    const armed = listing.after;
    if (armed !== null && String(args[0]) === armed.dir) {
      listing.after = null;
      real.rmSync(armed.remove, { force: true });
    }
    return names;
  }) as typeof real.readdirSync;
  return { ...real, readdirSync, default: { ...real, readdirSync } };
});

const SESSION = '00000000-0000-4000-9000-000000000b2a';
const OTHER_SESSION = '00000000-0000-4000-9000-000000000b2b';
const PROMPT = '00000000-0000-4000-9000-0000000000c2';
/** Takt obserwacji w serwerze: odczyt rejestru drivera co 1,5 s. */
const TICK_MS = CLI_WAITING_POLL_MS;

let clock = Date.parse('2026-11-09T12:00:00.000Z');
const now = (): number => clock;

const dirs: string[] = [];
afterEach(() => {
  listing.after = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const waiting = (at = clock): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at });
const active = (at = clock): RegistryEvidence => ({ kind: 'active', at });
/** Dwóch pisarzy rejestru tej sesji: „nie wiem”. */
const writers: RegistryEvidence = { kind: 'unknown', why: 'writers' };

// ---------------------------------------------------------------- ekran w kształcie fixture'u

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const BASH_FIXTURE = readFileSync(join(FIXTURES, 'measured/zgoda-bash-2.1.293.txt'), 'utf8');

/** Dialog `Bash` z pomiaru (szerokość ramki 61 kolumn) z podanymi liniami ramki komendy. */
function bashScreen(...frame: readonly string[]): string {
  const lines = BASH_FIXTURE.split('\n');
  const top = lines.findIndex((line) => line.startsWith('╌'));
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith('╌'));
  return [...lines.slice(0, top + 1), ...frame.map((line) => ` ${line}`), ...lines.slice(bottom)].join('\n');
}

const screenRead = (text: string, readStartedAt: number): ConsentScreenRead => ({ text, readStartedAt });

// ---------------------------------------------------------------- zrzuty i znaczniki

const CWD = '/tmp/projekt';
let nextPid = 71_000;

/** Zrzut syntetyczny wątku głównego: hook wystartował 1 s temu, zrzut zapisał 0,9 s temu. */
function bash(seed: string, command: string, over: Partial<HookCallDump> = {}): HookCallDump {
  const promptId = over.promptId ?? PROMPT;
  const nonce = createHash('sha256').update(`${seed}-${String(nextPid)}`).digest('hex').slice(0, 32);
  nextPid += 1;
  const toolInput = { command, description: 'Pomiar znaczników' };
  return {
    key: `${promptId}-${nonce}`, sessionId: SESSION, promptId, pid: nextPid, startedAt: clock - 1_000, toolName: 'Bash',
    toolInput, cwd: CWD, at: clock - 900, inputSha256: canonicalSha256(toolInput), permissionMode: 'default', ...over,
  };
}
const commandOf = (dump: HookCallDump): string => (dump.toolInput as { command: string }).command;

/** Znacznik prośby z nazwą pliku (bez `.json`). */
interface TestMarker extends HookMarkerFile {
  readonly name: string;
}

/** Znacznik prośby zrzutu: te same pola bez `permissionMode`, zapis 50 ms przed zrzutem (hook pisze go pierwszy). */
function markerOf(dump: HookCallDump, over: Partial<HookMarkerFile> = {}): TestMarker {
  return {
    name: dump.key, key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, pid: dump.pid,
    startedAt: dump.startedAt, ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }), toolName: dump.toolName,
    toolInput: dump.toolInput, cwd: dump.cwd, at: dump.at - 50, inputSha256: dump.inputSha256, ...over,
  };
}

/** Znacznik bez klucza per wywołanie (`prompt_id` bez kształtu identyfikatora): nazwa `anon-<pid>-<startedAt>`. */
function anonMarker(command: string, over: Partial<HookMarkerFile> = {}): TestMarker {
  nextPid += 1;
  const pid = over.pid ?? nextPid;
  const startedAt = over.startedAt ?? clock - 1_000;
  const toolInput = { command, description: 'Pomiar znaczników' };
  return {
    name: `anon-${String(pid)}-${String(startedAt)}`, key: null, sessionId: SESSION, promptId: null, pid, startedAt,
    toolName: 'Bash', toolInput, cwd: CWD, at: clock - 950, inputSha256: canonicalSha256(toolInput), ...over,
  };
}

// ---------------------------------------------------------------- harness

interface Registered {
  readonly secret: string;
  readonly cardSha256: string;
  readonly at: number;
}

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  /** Życie procesów hooka dla atrapy `ps`; brak pidu = „nie wiem”. */
  readonly life: Map<number, boolean | null>;
  readonly registered: Map<string, Registered>;
  /** Procesy z każdego wywołania atrapy `ps`, w kolejności wywołań. */
  readonly asked: HookProcess[][];
  /** Linie logu cyklu. */
  readonly logs: string[];
  /** Ostatnia obserwacja kroku (`inspect`): zrzuty, kompletność odczytu, sygnały. */
  observation: ConsentSessionObservation | null;
  /** Krok obserwacji sesji: rejestr i ekran przeczytany w tej obserwacji (`null` = bez odczytu). */
  step(registry: RegistryEvidence, screen: string | null, opts?: {
    readonly readStartedAt?: number; readonly sessionId?: string; readonly liveness?: ProcessLiveness;
  }): Promise<void>;
}

/**
 * Cykl jak w serwerze. Bez `locked` proces wstał 10 s przed testem, a blokadę startu obu sesji zdjął rejestr bez
 * `waiting` 5 s po starcie; `locked` = cykl wstaje teraz (restart serwera) i blokada trwa. `dir` = katalog danych
 * poprzedniego procesu (restart), `io` podmienia operacje dysku cyklu.
 */
async function harness(
  opts: { readonly locked?: boolean; readonly io?: Partial<ConsentCycleIo>; readonly dir?: string } = {},
): Promise<Harness> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'rarog-znaczniki-'));
  if (opts.dir === undefined) dirs.push(dir);
  const reg = createConsentRegistry({
    bootId: 'boot-b2a2', send: () => true, sessions: () => [SESSION, OTHER_SESSION], log: () => {}, now,
  });
  reg.setScope('main');
  const started = clock;
  if (opts.locked !== true) clock = started - 10_000;
  const logs: string[] = [];
  const cycle = createConsentCycle({
    dataDir: dir, bootId: 'boot-b2a2', registry: reg, now, log: (line) => { logs.push(line); },
    ...(opts.io === undefined ? {} : { io: opts.io }),
  });
  clock = started;
  const life = new Map<number, boolean | null>();
  const asked: HookProcess[][] = [];
  const liveness: ProcessLiveness = async (processes) => {
    asked.push(processes.map((one) => ({ pid: one.pid, startedAt: one.startedAt })));
    return new Map(processes.map((one) => [one.pid, life.get(one.pid) ?? null]));
  };
  const h: Harness = {
    dir, reg, cycle, life, registered: new Map(), asked, logs, observation: null,
    step: async (registry, screen, stepOpts = {}) => {
      const readStartedAt = stepOpts.readStartedAt ?? clock;
      await observeConsentSession(cycle, {
        dataDir: dir, sessionId: stepOpts.sessionId ?? SESSION, liveness: stepOpts.liveness ?? liveness, registry,
        transcript: null, screen: screen === null ? null : screenRead(screen, readStartedAt), now,
      }, (observation) => { h.observation = observation; });
    },
  };
  if (opts.locked !== true) {
    for (const sessionId of [SESSION, OTHER_SESSION]) {
      await observeConsentSession(cycle, {
        dataDir: dir, sessionId, liveness: async () => new Map(), registry: active(started - 5_000), transcript: null,
        screen: null, now: () => started - 5_000,
      });
    }
  }
  return h;
}

const dumpPath = (h: Harness, dump: HookCallDump): string =>
  join(h.dir, HOOK_PENDING_DIRNAME, dump.sessionId, `${dump.key}.json`);
const answerPath = (h: Harness, dump: HookCallDump): string =>
  join(h.dir, CONSENT_DIRNAME, dump.sessionId, `${dump.key}.json`);
const markerDir = (h: Pick<Harness, 'dir'>, sessionId = SESSION): string =>
  join(h.dir, HOOK_MARKERS_DIRNAME, sessionId);
const markerPath = (h: Pick<Harness, 'dir'>, name: string, sessionId = SESSION): string =>
  join(markerDir(h, sessionId), `${name}.json`);

/** Treść pliku znacznika (bez nazwy) z nadpisanymi polami, pod nazwą `name` w katalogu sesji {@link SESSION}. */
function writeMarkerFile(h: Pick<Harness, 'dir'>, name: string, file: Record<string, unknown>): void {
  mkdirSync(markerDir(h), { recursive: true, mode: 0o700 });
  writeFileSync(markerPath(h, name), JSON.stringify(file), { mode: 0o600 });
}

const fileOf = (marker: TestMarker): Record<string, unknown> => {
  const { name: _name, ...file } = marker;
  return file;
};

/** Znacznik na dysku jak u hooka (0600 w katalogu 0700); `alive` = życie procesu hooka dla atrapy `ps`. */
function writeMarker(h: Harness, marker: TestMarker, alive?: boolean | null): void {
  mkdirSync(markerDir(h, marker.sessionId), { recursive: true, mode: 0o700 });
  writeFileSync(markerPath(h, marker.name, marker.sessionId), `${JSON.stringify(fileOf(marker))}\n`, { mode: 0o600 });
  if (alive !== undefined) h.life.set(marker.pid, alive);
}

/** Hook startuje: znacznik, zrzut na dysku, proces żywy, rejestracja sekretu przyjęta. */
function hookStarts(h: Harness, dump: HookCallDump, marker = true): void {
  if (marker) writeMarker(h, markerOf(dump));
  mkdirSync(dirname(dumpPath(h, dump)), { recursive: true, mode: 0o700 });
  writeFileSync(dumpPath(h, dump), JSON.stringify(dump), { mode: 0o600 });
  h.life.set(dump.pid, true);
  const cardSha256 = consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
  });
  const secret = randomBytes(CONSENT_SECRET_BYTES).toString('hex');
  expect(h.reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, secret, inputSha256: dump.inputSha256, cardSha256,
    pid: dump.pid, startedAt: dump.startedAt,
  }).status).toBe(200);
  h.registered.set(dump.key, { secret, cardSha256, at: clock });
}

/** Hook wyszedł: zrzut znika, proces martwy; znacznik zostaje (hook go nie kasuje). */
function hookExits(h: Harness, dump: HookCallDump): void {
  rmSync(dumpPath(h, dump), { force: true });
  h.life.set(dump.pid, false);
}

/** Sam zrzut na dysku, bez rejestracji sekretu (subagent). */
function writeDump(h: Harness, dump: HookCallDump, alive: boolean | null): void {
  mkdirSync(dirname(dumpPath(h, dump)), { recursive: true, mode: 0o700 });
  writeFileSync(dumpPath(h, dump), JSON.stringify(dump), { mode: 0o600 });
  h.life.set(dump.pid, alive);
}

const cardOf = (h: Harness, dump: HookCallDump): unknown => {
  const card = h.cycle.card(dump.sessionId, dump.key);
  return card === null ? null : { state: card.state, canAllow: card.canAllow };
};
const BUTTON = { state: 'pending', canAllow: true } as const;
const NO_BUTTON = { state: 'pending', canAllow: false } as const;

/** Klucze kandydatów puli sesji ze zrzutem z chwilą wyjścia (`null` = w puli). */
const poolOf = (h: Harness, sessionId = SESSION): [string, number | null][] =>
  h.cycle.pool(sessionId).candidates.map((candidate) => [candidate.dump.key, candidate.exitAt]);

/** Zgoda z telefonu: `sent` i plik odpowiedzi z podpisem, który hook tej prośby przyjmuje. */
async function allowSigned(h: Harness, dump: HookCallDump): Promise<void> {
  expect(await h.cycle.decide(dump.sessionId, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
  const registered = h.registered.get(dump.key);
  if (registered === undefined) throw new Error(`brak rejestracji ${dump.key}`);
  const raw = JSON.parse(readFileSync(answerPath(h, dump), 'utf8')) as unknown;
  expect(verifyConsentFile(raw, {
    secret: registered.secret, sessionId: dump.sessionId, key: dump.key, inputSha256: dump.inputSha256,
    cardSha256: registered.cardSha256, notBefore: registered.at - CONSENT_NOT_BEFORE_MARGIN_MS,
  })).toMatchObject({ ok: true, file: { decision: 'allow', reasonId: 'allow', key: dump.key } });
}

// ---------------------------------------------------------------- przypadki

describe('pula = zrzuty ∪ znaczniki, jeden kandydat na klucz', () => {
  it('zrzut i znacznik tego samego wywołania = jeden kandydat; przycisk zgody i podpisana zgoda', async () => {
    const h = await harness();
    const x = bash('jeden', 'echo jeden-kandydat > /dev/null');
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(poolOf(h)).toEqual([[x.key, null]]);
    expect(cardOf(h, x)).toEqual(BUTTON);
    await allowSigned(h, x);
  });

  it('znacznik przeczytany przed zrzutem tej prośby: kandydat ze znacznika, zrzut go nie dubluje; przycisk po zrzucie',
    async () => {
      const h = await harness();
      const x = bash('najpierw-znacznik', 'echo najpierw-znacznik > /dev/null');
      writeMarker(h, markerOf(x), true);
      await h.step(waiting(), bashScreen(commandOf(x)));
      expect(poolOf(h)).toEqual([[x.key, null]]);
      expect(h.cycle.card(SESSION, x.key)).toBeNull();
      clock += TICK_MS;
      hookStarts(h, x, false);
      await h.step(waiting(), bashScreen(commandOf(x)));
      expect(poolOf(h)).toEqual([[x.key, null]]);
      expect(cardOf(h, x)).toEqual(BUTTON);
      await allowSigned(h, x);
    });

  it('kandydat z samego znacznika (hook bez czekania) nie ma dowodu własnego ani karty, a bliźniak tej samej komendy'
    + ' traci przycisk', async () => {
    const h = await harness();
    const command = 'echo tylko-znacznik > /dev/null';
    const skip = bash('bez-czekania', command);
    writeMarker(h, markerOf(skip), false);
    await h.step(waiting(), bashScreen(command));
    expect(poolOf(h)).toEqual([[skip.key, null]]);
    expect(h.cycle.cards(SESSION)).toEqual([]);
    expect([...(h.observation?.signals.values() ?? [])]).toEqual([]);
    clock += TICK_MS;
    const twin = bash('blizniak', command);
    hookStarts(h, twin);
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, twin)).toEqual(NO_BUTTON);
  });

  it('kilka znaczników `anon-…` = osobni kandydaci bez dowodu: prośba tej samej komendy bez przycisku, innej z przyciskiem',
    async () => {
      const h = await harness();
      const command = 'echo anonimowy > /dev/null';
      const first = anonMarker(command);
      const second = anonMarker(command);
      writeMarker(h, first, false);
      writeMarker(h, second, false);
      await h.step(writers, null);
      expect(poolOf(h).map(([key]) => key).sort()).toEqual([first.name, second.name].sort());
      expect(h.cycle.cards(SESSION)).toEqual([]);
      clock += TICK_MS;
      const other = bash('inna-komenda', 'echo inna-komenda > /dev/null');
      hookStarts(h, other);
      await h.step(waiting(), bashScreen(commandOf(other)));
      expect(cardOf(h, other)).toEqual(BUTTON);
      clock += TICK_MS;
      const same = bash('ta-sama', command);
      hookStarts(h, same);
      await h.step(waiting(), bashScreen(command));
      expect(cardOf(h, same)).toEqual(NO_BUTTON);
    });
});

describe('przypadek łagodny B: zrzut bliźniaka zniknął przed odczytem zrzutów', () => {
  it.each([
    ['znacznik bliźniaka zostaje → sierota bez przycisku', true, NO_BUTTON],
    ['hook bez znaczników → sierota z przyciskiem jak w B1 (przypadek łagodny)', false, BUTTON],
  ] as const)('%s', async (_name, withMarker, expected) => {
    const h = await harness();
    const command = 'echo przypadek-lagodny > /dev/null';
    const orphan = bash('sierota', command);
    hookStarts(h, orphan, withMarker);
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, orphan)).toEqual(BUTTON);
    // A rozstrzygnięta przy biurku: jej hook żyje dalej jako sierota ze zrzutem. B, identyczna, dostała Esc przy biurku
    // w trakcie odczytu ekranu: hook B wyszedł i skasował zrzut, zanim obserwacja przeczytała zrzuty.
    clock += TICK_MS;
    const twin = bash('blizniak', command);
    if (withMarker) writeMarker(h, markerOf(twin), false);
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, orphan)).toEqual(expected);
  });

  it('bliźniak bez czekania (`skipWaiting`) na wierzchu, sierota tej samej komendy ze zrzutem → bez przycisku', async () => {
    const h = await harness();
    const command = 'echo bez-czekania-na-wierzchu > /dev/null';
    const orphan = bash('sierota-skip', command);
    hookStarts(h, orphan);
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, orphan)).toEqual(BUTTON);
    clock += TICK_MS;
    writeMarker(h, markerOf(bash('skip', command)), false);
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, orphan)).toEqual(NO_BUTTON);
  });

  it.each([
    ['przycięty (`{rarogTruncated, preview}`, skrót całości)', { toolInput: { rarogTruncated: true, preview: 'echo' } }],
    ['bez skrótu wejścia (`inputSha256: null`)', { inputSha256: null }],
  ] as const)('znacznik %s w puli: `unknown` przy wierzchu `Bash`, więc bez przycisku dla nikogo', async (_name, over) => {
    const h = await harness();
    writeMarker(h, markerOf(bash('niepewny', 'echo niepewny > /dev/null'), over), false);
    await h.step(writers, null);
    clock += TICK_MS;
    const x = bash('inna', 'echo calkiem-inna > /dev/null');
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
  });

  it('`matchTop`: znacznik bez skrótu wejścia (`inputSha256: null`) daje `unknown`, z tym samym wejściem i skrótem `match`',
    () => {
      const toolInput = { command: 'echo skrot > /dev/null', description: 'x' };
      const screen = bashScreen('echo skrot > /dev/null');
      expect(matchTop(screen, { toolName: 'Bash', toolInput, cwd: CWD, inputSha256: canonicalSha256(toolInput) }))
        .toBe('match');
      expect(matchTop(screen, { toolName: 'Bash', toolInput, cwd: CWD, inputSha256: null })).toBe('unknown');
    });
});

describe('kandydat subagenta ze znacznikiem: wyjście po śmierci hooka i rejestrze bez `waiting` po zapasie', () => {
  it('ta sama komenda co dialog wątku głównego na wierzchu: bez przycisku, póki hook subagenta żyje albo rejestr mówi'
    + ' `waiting`; po wyjściu kandydata nowa prośba ma przycisk', async () => {
    const h = await harness();
    const command = 'echo subagent-znacznik > /dev/null';
    const sub = bash('subagent', command, { agentId: 'agent-1' });
    writeMarker(h, markerOf(sub), true);
    await h.step(active(), null);
    // Rejestr bez `waiting` długo po znaczniku: hook subagenta żyje, kandydat zostaje.
    for (let tick = 0; tick < 4; tick += 1) {
      clock += TICK_MS;
      await h.step(active(), null);
    }
    expect(poolOf(h)).toEqual([[sub.key, null]]);
    const x = bash('glowny', command);
    hookStarts(h, x);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    // Hook subagenta wychodzi (jego dialog staje za dialogiem X): rejestr mówi `waiting`, kandydat zostaje.
    h.life.set(sub.pid, false);
    for (let tick = 0; tick < 3; tick += 1) {
      clock += TICK_MS;
      await h.step(waiting(), bashScreen(command));
      expect(cardOf(h, x)).toEqual(NO_BUTTON);
    }
    expect(poolOf(h)).toEqual([[sub.key, null], [x.key, null]]);
    // Oba dialogi rozstrzygnięte przy biurku: hook X wychodzi, rejestr bez `waiting` wyjmuje oba.
    hookExits(h, x);
    clock += TICK_MS;
    await h.step(active(), null);
    expect(poolOf(h)).toEqual([[sub.key, clock], [x.key, clock]]);
    const next = bash('nastepna', command);
    hookStarts(h, next);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, next)).toEqual(BUTTON);
    await allowSigned(h, next);
  });

  it('rejestr bez `waiting` w zapasie po śmierci hooka nie wyjmuje, po zapasie wyjmuje; `ps` bez odpowiedzi nie jest'
    + ' śmiercią', async () => {
    const h = await harness();
    const sub = bash('subagent-zapas', 'echo zapas > /dev/null', { agentId: 'agent-2' });
    writeMarker(h, markerOf(sub), null);
    for (let tick = 0; tick < 3; tick += 1) {
      clock += TICK_MS;
      await h.step(active(), null);
    }
    expect(poolOf(h)).toEqual([[sub.key, null]]);
    h.life.set(sub.pid, false);
    clock += TICK_MS;
    await h.step(active(), null);
    const deadAt = clock;
    clock = deadAt + REGISTRY_SLACK_MS - 1;
    await h.step(active(), null);
    expect(poolOf(h)).toEqual([[sub.key, null]]);
    clock = deadAt + REGISTRY_SLACK_MS;
    await h.step(active(), null);
    expect(poolOf(h)).toEqual([[sub.key, clock]]);
  });

  it('zrzut subagenta ze znacznikiem: po wyjściu hooka i rejestrze bez `waiting` po zapasie kandydat wychodzi, a prośba'
    + ' wątku głównego tej samej komendy ma przycisk', async () => {
    const h = await harness();
    const command = 'echo subagent-zrzut > /dev/null';
    const sub = bash('subagent-zrzut', command, { agentId: 'agent-3' });
    writeMarker(h, markerOf(sub));
    writeDump(h, sub, true);
    await h.step(waiting(), null);
    hookExits(h, sub);
    clock = sub.at + REGISTRY_SLACK_MS + 500;
    await h.step(active(), null);
    expect(poolOf(h)).toEqual([[sub.key, null]]);
    clock += REGISTRY_SLACK_MS;
    await h.step(active(), null);
    expect(poolOf(h)).toEqual([[sub.key, clock]]);
    clock += 500;
    const x = bash('glowny', command);
    hookStarts(h, x);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, x)).toEqual(BUTTON);
  });

  it(`70 znaczników subagenta po skończonych hookach: odczyt kompletny, \`ps\` najwyżej ${String(CONSENT_HOOK_CHECKS_MAX)}`
    + ' na obserwację, wszyscy wychodzą, znaczniki znikają, a nowa prośba tej samej komendy ma przycisk', async () => {
    const h = await harness();
    const command = 'echo siedemdziesiat > /dev/null';
    const subs = Array.from({ length: 70 }, (_, n) => bash(`sub-${String(n)}`, command, { agentId: `agent-${String(n)}` }));
    for (const sub of subs) writeMarker(h, markerOf(sub), false);
    const t0 = clock;
    await h.step(active(), null);
    expect(h.observation?.complete).toBe(true);
    expect(poolOf(h)).toHaveLength(70);
    expect(h.asked.map((call) => call.length)).toEqual([CONSENT_HOOK_CHECKS_MAX]);
    clock = t0 + TICK_MS;
    await h.step(active(), null);
    expect(h.asked.map((call) => call.length)).toEqual([CONSENT_HOOK_CHECKS_MAX, 70 - CONSENT_HOOK_CHECKS_MAX]);
    expect(poolOf(h).filter(([, exitAt]) => exitAt !== null)).toEqual([]);
    for (let tick = 2; tick <= 5; tick += 1) {
      clock = t0 + tick * TICK_MS;
      await h.step(active(), null);
    }
    // Śmierć 64 hooków w t0, sześciu w t0 + 1,5 s; wyjścia w t0 + 3 s i t0 + 4,5 s; po terminie odczytów pula trzyma
    // same klucze, a znaczniki znikają z dysku.
    expect(h.asked).toHaveLength(2);
    const pool = h.cycle.pool(SESSION);
    expect(pool.candidates).toEqual([]);
    expect(pool.exited).toHaveLength(70);
    expect(pool.overflow).toBe(false);
    expect(readdirSync(markerDir(h))).toEqual([]);
    const x = bash('glowny-po', command);
    hookStarts(h, x);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, x)).toEqual(BUTTON);
    await allowSigned(h, x);
  });

  it(`${String(CONSENT_HOOK_CHECKS_MAX + 1)} znaczników subagenta, pierwsze ${String(CONSENT_HOOK_CHECKS_MAX)} hooki żyją`
    + ' (`ps` raz `true`, raz bez odpowiedzi), ostatni nie żyje: sprawdzenia `ps` rotują w limicie, więc ostatni'
    + ' wychodzi z puli po rejestrze bez `waiting` po zapasie, a bliźniak wątku głównego ma przycisk', async () => {
    const h = await harness();
    const command = 'echo rotacja-sprawdzen > /dev/null';
    const living = Array.from({ length: CONSENT_HOOK_CHECKS_MAX }, (_, n) =>
      bash(`zywy-${String(n)}`, `echo zywy-${String(n)} > /dev/null`, { agentId: `agent-z${String(n)}` }));
    /** Odpowiedź `ps` o żywych hookach zmienia się co obserwację: na przemian `true` i bez odpowiedzi. */
    const answer = (tick: number): void => {
      living.forEach((sub, n) => { h.life.set(sub.pid, (n + tick) % 2 === 0 ? true : null); });
    };
    for (const sub of living) writeMarker(h, markerOf(sub));
    answer(0);
    await h.step(active(), null);
    // Ostatni kandydat dochodzi do puli po pozostałych, więc w kolejności pierwszego odczytu stoi za nimi.
    const dead = bash('martwy', command, { agentId: 'agent-martwy' });
    writeMarker(h, markerOf(dead), false);
    let tick = 0;
    let askedDeadAt: number | null = null;
    while (tick < 12 && poolOf(h).find(([key]) => key === dead.key)?.[1] == null) {
      tick += 1;
      clock += TICK_MS;
      answer(tick);
      await h.step(active(), null);
      if (askedDeadAt === null && h.asked.at(-1)?.some((one) => one.pid === dead.pid) === true) askedDeadAt = clock;
    }
    expect(h.asked.every((call) => call.length <= CONSENT_HOOK_CHECKS_MAX)).toBe(true);
    expect(askedDeadAt).not.toBeNull();
    const exitAt = poolOf(h).find(([key]) => key === dead.key)?.[1] ?? null;
    expect(exitAt).not.toBeNull();
    expect(exitAt).toBeGreaterThanOrEqual((askedDeadAt ?? 0) + REGISTRY_SLACK_MS);
    // Żywe hooki zostają w puli bez wyjścia.
    expect(poolOf(h).filter(([key, at]) => key !== dead.key && at !== null)).toEqual([]);
    expect(poolOf(h)).toHaveLength(CONSENT_HOOK_CHECKS_MAX + 1);
    const twin = bash('blizniak-glowny', command);
    hookStarts(h, twin);
    clock += TICK_MS;
    answer(tick + 1);
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, twin)).toEqual(BUTTON);
    await allowSigned(h, twin);
  });

  it(`ciągły napływ (co obserwację ${String(CONSENT_HOOK_CHECKS_MAX)} nowych żywych hooków subagenta): hook czekający`
    + ' w kolejce sprawdzeń dostaje `ps` przed każdym kandydatem dopisanym później, więc martwy wychodzi z puli',
  async () => {
    const h = await harness();
    /** Fala żywych hooków subagenta ze znacznikiem: tyle, ile `ps` sprawdza w jednej obserwacji. */
    const wave = (n: number): HookCallDump[] => Array.from({ length: CONSENT_HOOK_CHECKS_MAX }, (_, i) => {
      const seed = `fala-${String(n)}-${String(i)}`;
      const sub = bash(seed, `echo ${seed} > /dev/null`, { agentId: `agent-${seed}` });
      writeMarker(h, markerOf(sub), true);
      return sub;
    });
    const sorted = (pids: readonly number[]): number[] => [...pids].sort((a, b) => a - b);
    const askedIn = (step: number): number[] => (h.asked[step] ?? []).map((one) => one.pid);
    const first = wave(0);
    await h.step(active(), null);
    expect(sorted(askedIn(0))).toEqual(sorted(first.map((sub) => sub.pid)));
    // Martwy hook dochodzi do puli po fali sprawdzonej przed chwilą i w tej obserwacji czeka w kolejce za nią.
    const dead = bash('martwy-w-kolejce', 'echo martwy-w-kolejce > /dev/null', { agentId: 'agent-martwy-w-kolejce' });
    writeMarker(h, markerOf(dead), false);
    clock += TICK_MS;
    await h.step(active(), null);
    expect(sorted(askedIn(1))).toEqual(sorted(first.map((sub) => sub.pid)));
    // Od następnej obserwacji co obserwację dochodzi pełna fala nowych żywych hooków.
    const later: HookCallDump[] = [];
    let checkedAt: number | null = null;
    for (let n = 1; n <= 4; n += 1) {
      later.push(...wave(n));
      clock += TICK_MS;
      await h.step(active(), null);
      if (checkedAt === null && askedIn(h.asked.length - 1).includes(dead.pid)) checkedAt = clock;
    }
    expect(h.asked.every((call) => call.length <= CONSENT_HOOK_CHECKS_MAX)).toBe(true);
    // Czekający hook idzie pierwszy w pierwszej obserwacji po tej, w której czekał; fala z tej obserwacji za nim.
    expect(askedIn(2)[0]).toBe(dead.pid);
    const order = h.asked.flatMap((call) => call.map((one) => one.pid));
    const laterChecked = later.filter((sub) => order.includes(sub.pid));
    expect(laterChecked.length).toBeGreaterThanOrEqual(2 * CONSENT_HOOK_CHECKS_MAX);
    expect(laterChecked.filter((sub) => order.indexOf(sub.pid) < order.indexOf(dead.pid))).toEqual([]);
    // Martwy wychodzi po rejestrze bez `waiting` po zapasie od sprawdzenia; żywe hooki zostają w puli bez wyjścia.
    const exitAt = poolOf(h).find(([key]) => key === dead.key)?.[1] ?? null;
    expect(checkedAt).not.toBeNull();
    expect(exitAt).not.toBeNull();
    expect(exitAt).toBeGreaterThanOrEqual((checkedAt ?? 0) + REGISTRY_SLACK_MS);
    expect(poolOf(h).filter(([key, at]) => key !== dead.key && at !== null)).toEqual([]);
    expect(poolOf(h)).toHaveLength(first.length + 1 + later.length);
  });
});

describe('restart serwera: znaczniki wracają do puli i wychodzą zwykłą regułą', () => {
  it('wątek główny: hook wyszedł (weto `restart`), dialog stoi, znacznik zostaje → bez przycisku do zdjęcia blokady,'
    + ' kandydat wychodzi razem z nią, bliźniak potem ma przycisk', async () => {
    const before = await harness();
    const command = 'echo restart-glowny > /dev/null';
    const a = bash('przed-restartem', command);
    hookStarts(before, a);
    await before.step(waiting(), bashScreen(command));
    expect(cardOf(before, a)).toEqual(BUTTON);
    hookExits(before, a);
    clock += 1_000;
    const h = await harness({ dir: before.dir, locked: true });
    for (let tick = 0; tick < 3; tick += 1) {
      clock += TICK_MS;
      await h.step(waiting(), bashScreen(command));
    }
    expect(poolOf(h)).toEqual([[a.key, null]]);
    expect(h.cycle.pool(SESSION).unlockedAt).toBeNull();
    // Dialog A rozstrzygnięty przy biurku: rejestr bez `waiting` zdejmuje blokadę i wyjmuje A w tej samej chwili.
    clock += TICK_MS;
    await h.step(active(), null);
    expect(h.cycle.pool(SESSION).unlockedAt).toBe(clock);
    expect(poolOf(h)).toEqual([[a.key, clock]]);
    const twin = bash('blizniak-po-restarcie', command);
    hookStarts(h, twin);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, twin)).toEqual(BUTTON);
    await allowSigned(h, twin);
  });

  it('subagent: po zdjęciu blokady bliźniak wątku głównego dalej bez przycisku, aż kandydat subagenta wyjdzie',
    async () => {
      const before = await harness();
      const command = 'echo restart-subagent > /dev/null';
      const sub = bash('subagent-restart', command, { agentId: 'agent-r' });
      writeMarker(before, markerOf(sub), false);
      await before.step(waiting(), null);
      clock += 1_000;
      const h = await harness({ dir: before.dir, locked: true });
      const startedAt = clock;
      h.life.set(sub.pid, false);
      clock += 500;
      await h.step(waiting(), null);
      expect(poolOf(h)).toEqual([[sub.key, null]]);
      // Rejestr bez `waiting` 2 s po starcie zdejmuje blokadę, ale nie jest jeszcze 2 s po śmierci hooka subagenta.
      clock = startedAt + REGISTRY_SLACK_MS;
      await h.step(active(), null);
      expect(h.cycle.pool(SESSION).unlockedAt).toBe(clock);
      expect(poolOf(h)).toEqual([[sub.key, null]]);
      const twin = bash('blizniak-subagenta', command);
      hookStarts(h, twin);
      for (let tick = 0; tick < 3; tick += 1) {
        clock += TICK_MS;
        await h.step(waiting(), bashScreen(command));
        expect(cardOf(h, twin)).toEqual(NO_BUTTON);
      }
      hookExits(h, twin);
      clock += TICK_MS;
      await h.step(active(), null);
      expect(poolOf(h)).toEqual([[sub.key, clock], [twin.key, clock]]);
      const next = bash('nastepna-po-restarcie', command);
      hookStarts(h, next);
      clock += TICK_MS;
      await h.step(waiting(), bashScreen(command));
      expect(cardOf(h, next)).toEqual(BUTTON);
    });

  it('nieudane usunięcie znacznika zostawia plik i linię logu; po restarcie kandydat wraca, wychodzi i znacznik znika',
    async () => {
      const failing: Partial<ConsentCycleIo> = {
        remove: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
      };
      const before = await harness({ io: failing });
      const command = 'echo nieudane-usuniecie > /dev/null';
      const a = bash('nieudane', command);
      hookStarts(before, a);
      await before.step(waiting(), bashScreen(command));
      hookExits(before, a);
      clock = a.at + REGISTRY_SLACK_MS + 100;
      await before.step(active(), null);
      clock += CONSENT_PROOF_TTL_MS + 1;
      await before.step(active(), null);
      expect(before.cycle.pool(SESSION).exited.map((exit) => exit.key)).toEqual([a.key]);
      expect(existsSync(markerPath(before, a.key))).toBe(true);
      expect(before.logs).toContain(`consent: session ${SESSION} marker ${a.key} not removed: EACCES: permission denied`);
      clock += 1_000;
      const h = await harness({ dir: before.dir, locked: true });
      clock += REGISTRY_SLACK_MS;
      await h.step(active(), null);
      expect(poolOf(h)).toEqual([[a.key, clock]]);
      clock += CONSENT_PROOF_TTL_MS + 1;
      await h.step(active(), null);
      expect(existsSync(markerPath(h, a.key))).toBe(false);
      expect(h.cycle.pool(SESSION).exited.map((exit) => exit.key)).toEqual([a.key]);
    });
});

describe('sprzątanie znaczników', () => {
  it('znacznik wątku głównego znika po wyjściu kandydata i terminie odczytów, nie wcześniej', async () => {
    const h = await harness();
    const command = 'echo sprzatanie > /dev/null';
    const a = bash('sprzatanie', command);
    hookStarts(h, a);
    const anon = anonMarker('echo anon-sprzatanie > /dev/null');
    writeMarker(h, anon, false);
    await h.step(waiting(), bashScreen(command));
    hookExits(h, a);
    clock = a.at + REGISTRY_SLACK_MS + 100;
    await h.step(active(), null);
    const exitAt = clock;
    expect(poolOf(h)).toEqual([[a.key, exitAt], [anon.name, exitAt]]);
    clock = exitAt + CONSENT_PROOF_TTL_MS;
    await h.step(active(), null);
    expect(readdirSync(markerDir(h)).sort()).toEqual([`${a.key}.json`, `${anon.name}.json`].sort());
    clock += 1;
    await h.step(active(), null);
    expect(readdirSync(markerDir(h))).toEqual([]);
    expect(h.cycle.pool(SESSION).exited).toEqual([{ key: a.key, exitAt }, { key: anon.name, exitAt }]);
  });

  it('koniec sesji (`endPool`): pula sesji pusta, jej znaczniki i katalog znikają; plik tymczasowy hooka i inna sesja'
    + ' zostają', async () => {
    const h = await harness();
    const x = bash('koniec', 'echo koniec-sesji > /dev/null');
    hookStarts(h, x);
    writeMarker(h, anonMarker('echo anon-koniec > /dev/null'), false);
    const other = bash('inna', 'echo inna-sesja > /dev/null', { sessionId: OTHER_SESSION });
    writeMarker(h, markerOf(other), true);
    await h.step(waiting(), null);
    await h.step(waiting(), null, { sessionId: OTHER_SESSION });
    expect(poolOf(h)).toHaveLength(2);
    h.cycle.endPool(SESSION);
    expect(h.cycle.pool(SESSION)).toEqual({ candidates: [], exited: [], exitedAt: null, unlockedAt: null, overflow: false });
    expect(existsSync(markerDir(h))).toBe(false);
    expect(readdirSync(markerDir(h, OTHER_SESSION))).toEqual([`${other.key}.json`]);
    expect(poolOf(h, OTHER_SESSION)).toEqual([[other.key, null]]);
    // Plik tymczasowy zapisu w toku: nie znacznik, zostaje razem z katalogiem.
    const y = bash('tymczasowy', 'echo tymczasowy > /dev/null');
    writeMarker(h, markerOf(y), true);
    const tmp = `${y.key}.json.0123456789abcdef.tmp`;
    writeFileSync(join(markerDir(h), tmp), '{', { mode: 0o600 });
    h.cycle.endPool(SESSION);
    expect(readdirSync(markerDir(h))).toEqual([tmp]);
  });

  it('koniec sesji przy nieudanym usunięciu: plik zostaje (dla sprzątania startu) z linią logu, pula i tak pusta',
    async () => {
      const h = await harness({
        io: { remove: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } },
      });
      const x = bash('koniec-pada', 'echo koniec-pada > /dev/null');
      hookStarts(h, x);
      await h.step(waiting(), null);
      h.cycle.endPool(SESSION);
      expect(h.cycle.pool(SESSION)).toEqual({ candidates: [], exited: [], exitedAt: null, unlockedAt: null, overflow: false });
      expect(readdirSync(markerDir(h))).toEqual([`${x.key}.json`]);
      expect(h.logs).toContain(`consent: session ${SESSION} marker ${x.key} not removed: EACCES: permission denied`);
    });

  it('koniec sesji: nowa pula dostaje nową wersję, więc zwycięzca wierzchu z puli sprzed końca nie wraca', async () => {
    const h = await harness();
    const command = 'echo wersja-puli > /dev/null';
    const x = bash('wersja', command);
    hookStarts(h, x, false);
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, x)).toEqual(BUTTON);
    h.cycle.endPool(SESSION);
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    // Nowa pula w terminie dowodu: X i bliźniak, rejestr nieznany (blokada nie zdjęta), tyle samo zmian co stara pula.
    const twin = bash('wersja-blizniak', command);
    h.cycle.notePool(SESSION, [x, twin], writers, clock);
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
  });

  it(`sprzątanie startu: znaczniki starsze niż 7 dni (\`MARKER_RETENTION_MS\`) znikają, młodsze zostają, pusty katalog`
    + ' sesji też znika', () => {
    expect(MARKER_RETENTION_MS).toBe(7 * 24 * 60 * 60_000);
    const dir = mkdtempSync(join(tmpdir(), 'rarog-znaczniki-start-'));
    dirs.push(dir);
    const at = clock;
    const write = (sessionId: string, name: string, ageMs: number): void => {
      const path = join(dir, HOOK_MARKERS_DIRNAME, sessionId, name);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, '{}\n', { mode: 0o600 });
      const seconds = (at - ageMs) / 1_000;
      utimesSync(path, seconds, seconds);
    };
    write(SESSION, `${PROMPT}-${'1'.repeat(32)}.json`, MARKER_RETENTION_MS + 60_000);
    write(SESSION, `${PROMPT}-${'2'.repeat(32)}.json`, MARKER_RETENTION_MS - 60_000);
    write(SESSION, `${PROMPT}-${'3'.repeat(32)}.json.0123456789abcdef.tmp`, MARKER_RETENTION_MS + 60_000);
    write(OTHER_SESSION, 'anon-123-456.json', MARKER_RETENTION_MS + 60_000);
    expect(sweepMarkerFiles(dir, at)).toBe(3);
    expect(readdirSync(join(dir, HOOK_MARKERS_DIRNAME, SESSION))).toEqual([`${PROMPT}-${'2'.repeat(32)}.json`]);
    expect(existsSync(join(dir, HOOK_MARKERS_DIRNAME, OTHER_SESSION))).toBe(false);
  });

  it('okablowanie produkcyjne: sprzątanie startu w `server/src/index.ts` woła `sweepMarkerFiles` po sprzątaniu'
    + ' trybu cienia', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(new RegExp([
      String.raw`const swept = await sweepShadowFiles\(config\.dataDir\);`,
      String.raw`[\s\S]{0,600}?`,
      String.raw`const markers = sweepMarkerFiles\(config\.dataDir\);`,
    ].join('')));
  });
});

describe('odczyt znaczników: zepsuty albo znikający znacznik = obserwacja bez dowodu', () => {
  const broken = (h: Harness): Record<string, () => void> => ({
    'zły JSON': () => { writeFileSync(markerPath(h, `${PROMPT}-${'b'.repeat(32)}`), '{"key":'); },
    'cudza sesja w treści': () => {
      const marker = markerOf(bash('cudza', 'echo cudza'));
      writeMarkerFile(h, marker.name, { ...fileOf(marker), sessionId: OTHER_SESSION });
    },
    'klucz inny niż nazwa': () => {
      writeMarkerFile(h, `${PROMPT}-${'d'.repeat(32)}`, fileOf(markerOf(bash('inny-klucz', 'echo inny-klucz'))));
    },
    '`anon-…` z innym pidem w treści': () => {
      const marker = anonMarker('echo anon-pid');
      writeMarkerFile(h, marker.name, { ...fileOf(marker), pid: marker.pid + 1 });
    },
    '`anon-…` z `promptId`': () => {
      const marker = anonMarker('echo anon-prompt');
      writeMarkerFile(h, marker.name, { ...fileOf(marker), promptId: PROMPT });
    },
    'katalog pod nazwą znacznika': () => { mkdirSync(markerPath(h, `${PROMPT}-${'e'.repeat(32)}`)); },
    'plik ponad sufit odczytu': () => {
      const marker = markerOf(bash('duzy', 'echo duzy'), { toolInput: { command: 'x'.repeat(1200 * 1024) } });
      writeMarkerFile(h, marker.name, fileOf(marker));
    },
  });

  it.each([
    'zły JSON', 'cudza sesja w treści', 'klucz inny niż nazwa', '`anon-…` z innym pidem w treści', '`anon-…` z `promptId`',
    'katalog pod nazwą znacznika', 'plik ponad sufit odczytu',
  ])('%s → odczyt niekompletny, bez przycisku; po usunięciu pliku przycisk wraca', async (name) => {
    const h = await harness();
    const command = 'echo zepsuty-znacznik > /dev/null';
    const x = bash('zepsuty', command);
    hookStarts(h, x);
    const known = new Set(readdirSync(markerDir(h)));
    broken(h)[name]?.();
    const added = readdirSync(markerDir(h)).filter((file) => !known.has(file));
    expect(added).toHaveLength(1);
    await h.step(waiting(), bashScreen(command));
    expect(h.observation?.complete).toBe(false);
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    for (const file of added) rmSync(join(markerDir(h), file), { recursive: true, force: true });
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(h.observation?.complete).toBe(true);
    expect(cardOf(h, x)).toEqual(BUTTON);
  });

  it('znacznik znika między `readdir` a odczytem → odczyt niekompletny, bez przycisku', async () => {
    const h = await harness();
    const command = 'echo znikajacy-znacznik > /dev/null';
    const x = bash('znikajacy', command);
    hookStarts(h, x);
    const gone = anonMarker('echo znikajacy-anon > /dev/null');
    writeMarker(h, gone, false);
    listing.after = { dir: markerDir(h), remove: markerPath(h, gone.name) };
    await h.step(waiting(), bashScreen(command));
    expect(listing.after).toBeNull();
    expect(h.observation?.complete).toBe(false);
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
  });

  it('nazwa znana puli albo zrzutowi nie jest parsowana: zepsuta treść pod nią nie zabiera dowodu', async () => {
    const h = await harness();
    const command = 'echo znana-nazwa > /dev/null';
    const x = bash('znana', command);
    hookStarts(h, x);
    writeFileSync(markerPath(h, x.key), 'zepsute');
    await h.step(waiting(), bashScreen(command));
    expect(h.observation?.complete).toBe(true);
    expect(cardOf(h, x)).toEqual(BUTTON);
    const anon = anonMarker('echo znana-anon > /dev/null');
    writeMarker(h, anon, false);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    writeFileSync(markerPath(h, anon.name), 'zepsute');
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(h.observation?.complete).toBe(true);
    expect(cardOf(h, x)).toEqual(BUTTON);
  });

  it(`budżet nowych nazw (\`CONSENT_POOL_MAX\` = ${String(CONSENT_POOL_MAX)} w obserwacji): ponad budżetem odczyt`
    + ' niekompletny, nazwy znane poza budżetem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rarog-znaczniki-budzet-'));
    dirs.push(dir);
    const markers = Array.from({ length: 5 }, (_, n) => anonMarker(`echo budzet-${String(n)}`));
    for (const marker of markers) writeMarkerFile({ dir }, marker.name, fileOf(marker));
    writeFileSync(join(markerDir({ dir }), 'inny-plik.json'), 'nie znacznik');
    const names = markers.map((marker) => marker.name);
    const over = scanMarkers(dir, SESSION, () => false, 3);
    expect(over).toMatchObject({ complete: false });
    expect(over.markers).toHaveLength(3);
    expect([...over.names].sort()).toEqual([...names].sort());
    const knownTwo = new Set(names.slice(0, 2));
    const within = scanMarkers(dir, SESSION, (name) => knownTwo.has(name), 3);
    expect(within.complete).toBe(true);
    expect(within.markers.map((marker) => marker.name).sort()).toEqual(names.slice(2).sort());
    expect(scanMarkers(dir, OTHER_SESSION, () => false, 3)).toEqual({ markers: [], names: new Set(), complete: true });
  });
});

describe('granice gwarancji i hook bez znaczników', () => {
  it('ekran przeczytany przed publikacją znacznika bliźniaka: dowód co najwyżej sieroty tej samej tożsamości'
    + ' (przypadek łagodny), w następnej obserwacji bez przycisku', async () => {
    const h = await harness();
    const command = 'echo przed-znacznikiem > /dev/null';
    const orphan = bash('sierota-okno', command);
    hookStarts(h, orphan);
    await h.step(waiting(), bashScreen(command));
    // A rozstrzygnięta przy biurku (sierota żyje). Dialog bliźniaka B już stoi, a hook B zapisze znacznik dopiero po
    // odczycie znaczników tej obserwacji.
    clock += TICK_MS;
    const twin = bash('blizniak-okno', command, { startedAt: clock - 10, at: clock + 5 });
    await h.step(waiting(), bashScreen(command));
    // Zgoda trafiłaby do hooka sieroty A, którego prośby CLI już nie wykona.
    expect(cardOf(h, orphan)).toEqual(BUTTON);
    writeMarker(h, markerOf(twin), true);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, orphan)).toEqual(NO_BUTTON);
  });

  it('hook bez znaczników: obserwacja bez zrzutów nie pyta `ps`, ze zrzutami pyta tylko o nie, a zrzut subagenta'
    + ' zostaje w puli po wyjściu hooka (B1 bez zmian)', async () => {
    const h = await harness();
    await h.step(active(), null);
    expect(h.asked).toEqual([]);
    const x = bash('bez-znacznikow', 'echo bez-znacznikow > /dev/null');
    hookStarts(h, x, false);
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(h.asked).toEqual([[{ pid: x.pid, startedAt: x.startedAt }]]);
    expect(cardOf(h, x)).toEqual(BUTTON);
    const command = 'echo subagent-bez-znacznika > /dev/null';
    const sub = bash('subagent-bez', command, { agentId: 'agent-b1' });
    writeDump(h, sub, true);
    hookExits(h, x);
    clock += TICK_MS;
    await h.step(waiting(), null);
    hookExits(h, sub);
    const asked = h.asked.length;
    for (let tick = 0; tick < 4; tick += 1) {
      clock += TICK_MS;
      await h.step(active(), null);
    }
    expect(h.asked).toHaveLength(asked);
    expect(poolOf(h).find(([key]) => key === sub.key)).toEqual([sub.key, null]);
    const y = bash('glowny-bez', command);
    hookStarts(h, y, false);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, y)).toEqual(NO_BUTTON);
  });
});
