/**
 * Dowód „dialog stoi” kanału zgód z dopasowania do wierzchu ekranu (warstwa 1, wariant B ramy).
 *
 * Przycisk zgody ma wyłącznie prośba, która jako jedyna z pełnej puli sesji pasuje do świeżo przeczytanego wierzchu
 * ekranu (`matchTop`: cała ramka `Bash`, dialog planu, `Edit` przy `single`). Pula jest lepka w procesie, wyjście
 * z niej daje tylko świeży rejestr bez `waiting` odczytany co najmniej `REGISTRY_SLACK_MS` po zrzucie, po starcie
 * procesu sesja czeka na pierwszy taki rejestr (blokada startu), a dowód ma termin od chwili rozpoczęcia odczytu
 * ekranu. Licznik kolejki i bliźniaki po skrócie wejścia nie wchodzą do dowodu.
 *
 * Każdy przypadek idzie przez prawdziwy parser na ekranie w kształcie fixture'ów `fixtures/herdr/` (CLI 2.1.293),
 * prawdziwą obserwację sesji (zrzuty na dysku, atrapa `ps`), prawdziwy cykl z rejestrem sekretów, `decide`
 * i sprawdzenie podpisu pliku odpowiedzi. Zegar podaje test.
 *
 * Dalej: `Edit` bez potwierdzenia dopasowania i bez sprzeczności ścieżki to niewiadoma, dowód
 * obowiązuje tylko przy zwycięzcy bieżącej puli (także po zapisie `deciding`), niekompletny odczyt zrzutów zabiera
 * dowód obserwacji, widok karty liczy przycisk zgody przy odczycie, a przegląd plików publikuje jego utratę, pula
 * zwalnia pola zrzutu kandydata po wyjściu i terminie dowodu.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import type { ConsentCardView } from '../src/herdr/dialogs/layer1/cards.ts';
import {
  CONSENT_CLAIMED_STANDING_MS, CONSENT_DIRNAME, CONSENT_POOL_MAX, CONSENT_PROOF_TTL_MS, CONSENT_SECRET_BYTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle, ConsentCycleIo } from '../src/herdr/dialogs/layer1/cycle.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentSessionObservation } from '../src/herdr/dialogs/layer1/observe.ts';
import type { TranscriptToolUses } from '../src/herdr/dialogs/layer1/proof.ts';
import { readConsentRecords, writeConsentRecord } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { CONSENT_NOT_BEFORE_MARGIN_MS, consentCardSha256, verifyConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import type { ConsentScreenRead } from '../src/herdr/dialogs/layer1/top.ts';
import {
  ORPHAN_TRANSCRIPT_MIN_AGE_MS, REGISTRY_SLACK_MS, orphanHooks, standingProofs,
} from '../src/herdr/dialogs/shadow/evidence.ts';
import type { EvidenceInput, RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import { readCallDumps, scanCallDumps } from '../src/herdr/dialogs/shadow/files.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';
import { CLI_WAITING_POLL_MS } from '../src/sessions/state-sentences.ts';

/**
 * Zrzut znikający między `readdir` a odczytem (hook wyszedł): po wylistowaniu katalogu `dir` test kasuje plik.
 * Bez uzbrojenia `readdirSync` działa jak zwykle.
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

const SESSION = '00000000-0000-4000-9000-000000000b1a';
const OTHER_SESSION = '00000000-0000-4000-9000-000000000b1b';
const PROMPT = '00000000-0000-4000-9000-0000000000c1';
/** Takt obserwacji w serwerze: odczyt rejestru drivera co 1,5 s. */
const TICK_MS = CLI_WAITING_POLL_MS;

let clock = Date.parse('2026-11-09T09:00:00.000Z');
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

// ---------------------------------------------------------------- ekrany w kształcie fixture'ów

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const BASH_FIXTURE = fixture('measured/zgoda-bash-2.1.293.txt');

/** Dialog `Bash` z pomiaru (szerokość ramki 61 kolumn) z podanymi liniami ramki komendy. */
function bashScreen(...frame: readonly string[]): string {
  const lines = BASH_FIXTURE.split('\n');
  const top = lines.findIndex((line) => line.startsWith('╌'));
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith('╌'));
  return [...lines.slice(0, top + 1), ...frame.map((line) => ` ${line}`), ...lines.slice(bottom)].join('\n');
}

/** Dialog `Edit` z pomiaru: `pomiar-dialogow.txt` względem katalogu wywołania, `stara wartosc` → `nowa wartosc`. */
const EDIT_SCREEN = fixture('measured/zgoda-edit-2.1.293.txt');
/** Ten sam dialog `Edit` z licznikiem kolejki „1 of 2” w linii tytułu bloku. */
const EDIT_QUEUE_SCREEN = EDIT_SCREEN.replace('\n Edit file\n', `\n Edit file${' '.repeat(40)}1 of 2\n`);
/** Dialog planu z pomiaru z nazwą pliku planu w stopce. */
const planScreen = (name: string): string => fixture('measured/exitplanmode-2.1.293.txt').replace('<plan>.md', `${name}.md`);
const MCP_SCREEN = fixture('measured/zgoda-mcp-2.1.293.txt');
const READ_SCREEN = fixture('dialog-permission-read-2.1.278.txt');
const WRITE_SCREEN = fixture('measured/zgoda-write-2.1.293.txt');

/** Odczyt ekranu obserwacji: tekst i chwila rozpoczęcia odczytu. */
const screenRead = (text: string, readStartedAt: number): ConsentScreenRead => ({ text, readStartedAt });

// ---------------------------------------------------------------- zrzuty

const CWD = '/tmp/projekt';
const EDIT_INPUT = {
  file_path: `${CWD}/pomiar-dialogow.txt`, old_string: 'stara wartosc', new_string: 'nowa wartosc', replace_all: false,
};

let nextPid = 70_000;

/** Zrzut syntetyczny wątku głównego: hook wystartował 1 s temu, zrzut zapisał 0,9 s temu. */
function dumpOf(seed: string, toolName: string, toolInput: unknown, over: Partial<HookCallDump> = {}): HookCallDump {
  const promptId = over.promptId ?? PROMPT;
  const nonce = createHash('sha256').update(`${seed}-${String(nextPid)}`).digest('hex').slice(0, 32);
  nextPid += 1;
  return {
    key: `${promptId}-${nonce}`, sessionId: SESSION, promptId, pid: nextPid, startedAt: clock - 1_000, toolName,
    toolInput, cwd: CWD, at: clock - 900, inputSha256: canonicalSha256(toolInput), permissionMode: 'default', ...over,
  };
}

const bash = (seed: string, command: string, over: Partial<HookCallDump> = {}): HookCallDump =>
  dumpOf(seed, 'Bash', { command, description: 'Pomiar wierzchu' }, over);
const plan = (seed: string, name: string, over: Partial<HookCallDump> = {}): HookCallDump =>
  dumpOf(seed, 'ExitPlanMode', { plan: `# Plan ${seed}\n\nKrok pierwszy.`, planFilePath: `/Users/u/.claude/plans/${name}.md` }, over);
const commandOf = (dump: HookCallDump): string => (dump.toolInput as { command: string }).command;

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
  /** Widoki kart wysłane do urządzeń (`onCard` cyklu), w kolejności publikacji. */
  readonly published: ConsentCardView[];
  /** Odczyt `ps` (podmienny: opóźnienie, wstrzymanie). */
  liveness: ProcessLiveness;
  /** Ostatnia obserwacja kroku (`inspect`): zrzuty, wejście dowodu i sygnały. */
  observation: ConsentSessionObservation | null;
  /**
   * Krok obserwacji sesji: rejestr, ekran przeczytany w tej obserwacji (`null` = bez odczytu) z chwilą rozpoczęcia
   * odczytu (domyślnie teraz), transkrypt (domyślnie nieznany), `ps` tego kroku (domyślnie {@link liveness})
   * i `inspect` po sygnałach, przed krokami cyklu.
   */
  step(registry: RegistryEvidence, screen: string | null, opts?: {
    readonly readStartedAt?: number; readonly transcript?: TranscriptToolUses | null; readonly sessionId?: string;
    readonly liveness?: ProcessLiveness; readonly inspect?: (observation: ConsentSessionObservation) => void;
  }): Promise<void>;
}

/**
 * Cykl jak w serwerze. Proces wstał 10 s przed testem, a blokadę startu zdjął rejestr bez `waiting` 5 s po starcie
 * (`locked` = cykl wstaje teraz i blokada trwa). `io` podmienia operacje dysku cyklu (zapis rekordu).
 */
async function harness(
  opts: { readonly locked?: boolean; readonly io?: Partial<ConsentCycleIo> } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-wierzch-'));
  dirs.push(dir);
  const reg = createConsentRegistry({
    bootId: 'boot-b1a', send: () => true, sessions: () => [SESSION, OTHER_SESSION], log: () => {}, now,
  });
  reg.setScope('main');
  const started = clock;
  if (opts.locked !== true) clock = started - 10_000;
  const published: ConsentCardView[] = [];
  const cycle = createConsentCycle({
    dataDir: dir, bootId: 'boot-b1a', registry: reg, now, onCard: (view) => { published.push(view); },
    ...(opts.io === undefined ? {} : { io: opts.io }),
  });
  clock = started;
  const life = new Map<number, boolean | null>();
  const h: Harness = {
    dir, reg, cycle, life, registered: new Map(), published, observation: null,
    liveness: async (processes) => new Map(processes.map((p) => [p.pid, life.get(p.pid) ?? null])),
    step: async (registry, screen, stepOpts = {}) => {
      const readStartedAt = stepOpts.readStartedAt ?? clock;
      const liveness = stepOpts.liveness ?? ((processes, at) => h.liveness(processes, at));
      await observeConsentSession(cycle, {
        dataDir: dir, sessionId: stepOpts.sessionId ?? SESSION, liveness,
        registry, transcript: stepOpts.transcript ?? null, screen: screen === null ? null : screenRead(screen, readStartedAt),
        now,
      }, (observation) => {
        h.observation = observation;
        stepOpts.inspect?.(observation);
      });
    },
  };
  if (opts.locked !== true) {
    for (const sessionId of [SESSION, OTHER_SESSION]) {
      await observeConsentSession(cycle, {
        dataDir: dir, sessionId, liveness: h.liveness, registry: active(started - 5_000), transcript: null, screen: null,
        now: () => started - 5_000,
      });
    }
  }
  return h;
}

const dumpPath = (h: Harness, dump: HookCallDump): string =>
  join(h.dir, HOOK_PENDING_DIRNAME, dump.sessionId, `${dump.key}.json`);
const answerPath = (h: Harness, dump: HookCallDump, suffix: string): string =>
  join(h.dir, CONSENT_DIRNAME, dump.sessionId, `${dump.key}${suffix}`);

/** Hook startuje: zrzut na dysku, proces żywy, rejestracja sekretu przyjęta. */
function hookStarts(h: Harness, dump: HookCallDump, alive: boolean | null = true): void {
  mkdirSync(dirname(dumpPath(h, dump)), { recursive: true, mode: 0o700 });
  writeFileSync(dumpPath(h, dump), JSON.stringify(dump), { mode: 0o600 });
  h.life.set(dump.pid, alive);
  const cardSha256 = consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
  });
  const secret = randomBytes(CONSENT_SECRET_BYTES).toString('hex');
  expect(h.reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, secret, inputSha256: dump.inputSha256, cardSha256,
    pid: dump.pid, startedAt: dump.startedAt, ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
  }).status).toBe(200);
  h.registered.set(dump.key, { secret, cardSha256, at: clock });
}

/** Hook wyszedł: zrzut znika, proces martwy. */
function hookExits(h: Harness, dump: HookCallDump): void {
  rmSync(dumpPath(h, dump), { force: true });
  h.life.set(dump.pid, false);
}

/** Sam zrzut na dysku, bez rejestracji sekretu (subagent, zrzut przycięty, zrzuty sufitu). */
function writeDump(h: Harness, dump: HookCallDump, alive: boolean | null): void {
  mkdirSync(dirname(dumpPath(h, dump)), { recursive: true, mode: 0o700 });
  writeFileSync(dumpPath(h, dump), JSON.stringify(dump), { mode: 0o600 });
  h.life.set(dump.pid, alive);
}

const cardOf = (h: Harness, dump: HookCallDump): unknown => {
  const card = h.cycle.card(dump.sessionId, dump.key);
  return card === null ? null : { state: card.state, canAllow: card.canAllow };
};
const stateOf = (h: Harness, dump: HookCallDump): unknown => {
  const record = h.cycle.record(dump.sessionId, dump.key);
  return record === null ? null : { state: record.state, cause: record.cause };
};
const BUTTON = { state: 'pending', canAllow: true } as const;
const NO_BUTTON = { state: 'pending', canAllow: false } as const;

/** Zgoda z telefonu: `sent` i plik odpowiedzi z podpisem, który hook tej prośby przyjmuje. */
async function allowSigned(h: Harness, dump: HookCallDump): Promise<void> {
  expect(await h.cycle.decide(dump.sessionId, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
  const registered = h.registered.get(dump.key);
  if (registered === undefined) throw new Error(`brak rejestracji ${dump.key}`);
  const raw = JSON.parse(readFileSync(answerPath(h, dump, '.json'), 'utf8')) as unknown;
  expect(verifyConsentFile(raw, {
    secret: registered.secret, sessionId: dump.sessionId, key: dump.key, inputSha256: dump.inputSha256,
    cardSha256: registered.cardSha256, notBefore: registered.at - CONSENT_NOT_BEFORE_MARGIN_MS,
  })).toMatchObject({ ok: true, file: { decision: 'allow', reasonId: 'allow', key: dump.key } });
}

/** Hook przejmuje plik odpowiedzi, przegląd plików go widzi: rekord `claimed` w chwili `clock`. */
async function claimed(h: Harness, dump: HookCallDump): Promise<number> {
  renameSync(answerPath(h, dump, '.json'), answerPath(h, dump, '.claimed'));
  await h.cycle.tick();
  expect(stateOf(h, dump)).toEqual({ state: 'claimed', cause: null });
  return clock;
}

/** Takty co {@link TICK_MS} do `until` (włącznie) z rejestrem i ekranem przeczytanym w takcie; karta po każdym. */
async function ticksUntil(
  h: Harness, dump: HookCallDump, until: number, registry: () => RegistryEvidence, screen: string | null,
): Promise<unknown[]> {
  const seen: unknown[] = [];
  while (clock + TICK_MS <= until) {
    clock += TICK_MS;
    await h.step(registry(), screen);
    seen.push(cardOf(h, dump));
  }
  return seen;
}

// ---------------------------------------------------------------- przypadki

describe('termin dowodu', () => {
  it('`CONSENT_PROOF_TTL_MS` = takt rejestru + 500 ms (zapas na sufit `ps` i odczyt ekranu)', () => {
    expect(CONSENT_PROOF_TTL_MS).toBe(CLI_WAITING_POLL_MS + 500);
    expect(CONSENT_PROOF_TTL_MS).toBe(2_000);
  });
});

describe('dowód z wierzchu: pojedyncza prośba z pełną tożsamością na wierzchu', () => {
  it('`Bash` z całą ramką i świeżym `waiting: permission` → przycisk zgody, zgoda = `sent` z poprawnym podpisem', async () => {
    const h = await harness();
    const x = bash('bash', 'echo b1a > /dev/null');
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(cardOf(h, x)).toEqual(BUTTON);
    await allowSigned(h, x);
  });

  it('`ExitPlanMode` z nazwą planu w stopce → przycisk zgody i podpisana zgoda', async () => {
    const h = await harness();
    const p = plan('plan', 'cichy-strumyk-lasu');
    hookStarts(h, p);
    await h.step(waiting(), planScreen('cichy-strumyk-lasu'));
    expect(cardOf(h, p)).toEqual(BUTTON);
    await allowSigned(h, p);
  });

  it('`Edit` przy `single` (ścieżka względem `cwd` wywołania, diff z ramki) → przycisk zgody i podpisana zgoda', async () => {
    const h = await harness();
    const e = dumpOf('edit', 'Edit', EDIT_INPUT);
    hookStarts(h, e);
    await h.step(waiting(), EDIT_SCREEN);
    expect(cardOf(h, e)).toEqual(BUTTON);
    await allowSigned(h, e);
  });

  it('`Edit` of a project instructions file with lines the frame wraps in a 57-column pane (Claude Code 2.1.330,'
    + ' `kontrolny/zgoda-edit-wrap-claude-md-57-2.1.330.txt`) → button and a signed allow', async () => {
    const name = 'kontrolny/zgoda-edit-wrap-claude-md-57-2.1.330';
    const { input, cwd } = JSON.parse(fixture(`${name}.input.json`)) as { input: Record<string, unknown>; cwd: string };
    const h = await harness();
    const e = dumpOf('claude-md', 'Edit', input, { cwd });
    hookStarts(h, e);
    await h.step(waiting(), fixture(`${name}.txt`));
    expect(cardOf(h, e)).toEqual(BUTTON);
    await allowSigned(h, e);
  });

  it('dialog stoi 30 s bez zmian, takt rejestru 1,5 s z odczytem ekranu w każdym → przycisk w każdym takcie po'
    + ' pierwszym odczycie, a zgoda tuż przed następnym taktem przechodzi', async () => {
    const h = await harness();
    const x = bash('trzydziesci', 'echo stoi-30-s > /dev/null');
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(cardOf(h, x)).toEqual(BUTTON);
    const seen = await ticksUntil(h, x, clock + 30_000, () => waiting(), bashScreen(commandOf(x)));
    expect(seen.length).toBe(20);
    expect(seen).toEqual(seen.map(() => BUTTON));
    // Termin dłuższy od taktu: dowód z ostatniego odczytu trwa do następnego taktu.
    clock += TICK_MS - 1;
    await allowSigned(h, x);
  });
});

describe('termin dowodu: chwila rozpoczęcia odczytu ekranu + `CONSENT_PROOF_TTL_MS`', () => {
  it('`ps` opóźnione poza termin → bez przycisku', async () => {
    const h = await harness();
    const x = bash('ps-wolne', 'echo ps-wolne > /dev/null');
    hookStarts(h, x);
    const fast = h.liveness;
    h.liveness = async (processes, at) => {
      clock += CONSENT_PROOF_TTL_MS + 100;
      return fast(processes, at);
    };
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
  });

  it('`decide(allow)` po terminie bez nowej obserwacji → `card-changed`, bez pliku odpowiedzi', async () => {
    const h = await harness();
    const x = bash('po-terminie', 'echo po-terminie > /dev/null');
    hookStarts(h, x);
    const readStartedAt = clock;
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(cardOf(h, x)).toEqual(BUTTON);
    clock = readStartedAt + CONSENT_PROOF_TTL_MS;
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(() => readFileSync(answerPath(h, x, '.json'))).toThrow();
    // Nowa obserwacja z nowym odczytem daje dowód od nowa.
    await h.step(waiting(), bashScreen(commandOf(x)));
    await allowSigned(h, x);
  });

  it('decyzja tuż przed terminem przechodzi', async () => {
    const h = await harness();
    const x = bash('przed-terminem', 'echo przed-terminem > /dev/null');
    hookStarts(h, x);
    const readStartedAt = clock;
    await h.step(waiting(), bashScreen(commandOf(x)));
    clock = readStartedAt + CONSENT_PROOF_TTL_MS - 1;
    await allowSigned(h, x);
  });

  it('opóźniona odpowiedź odczytu ekranu terminu nie odświeża: odczyt rozpoczęty ponad termin temu → bez przycisku', async () => {
    const h = await harness();
    const x = bash('ekran-wolny', 'echo ekran-wolny > /dev/null');
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(commandOf(x)), { readStartedAt: clock - CONSENT_PROOF_TTL_MS - 100 });
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
  });

  it('nieudana obserwacja (`ps` rzuca) terminu nie przedłuża: po terminie bez przycisku', async () => {
    const h = await harness();
    const x = bash('ps-rzuca', 'echo ps-rzuca > /dev/null');
    hookStarts(h, x);
    const readStartedAt = clock;
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(cardOf(h, x)).toEqual(BUTTON);
    h.liveness = () => Promise.reject(new Error('ps padło'));
    clock += TICK_MS;
    await expect(h.step(waiting(), bashScreen(commandOf(x)))).rejects.toThrow('ps padło');
    clock = readStartedAt + CONSENT_PROOF_TTL_MS;
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
  });
});

describe('dwa panele jednej sesji: werdykt ze starszego ekranu nie nadpisuje werdyktu z nowszego', () => {
  /** Dwie obserwacje naraz; `ps` starszej czeka, aż nowsza skończy. */
  async function reversed(h: Harness, older: string, newer: string): Promise<void> {
    const fast = h.liveness;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    h.liveness = async (processes, at) => {
      calls += 1;
      if (calls === 1) await held;
      return fast(processes, at);
    };
    const olderRead = clock;
    const first = h.step(waiting(), older, { readStartedAt: olderRead });
    await new Promise((resolve) => setImmediate(resolve));
    await h.step(waiting(), newer, { readStartedAt: olderRead + 100 });
    release();
    await first;
    h.liveness = fast;
  }

  it('nowszy ekran pokazuje inną komendę, starszy tę prośbę → bez przycisku zostaje', async () => {
    const h = await harness();
    const x = bash('panele-a', 'echo panele-a > /dev/null');
    hookStarts(h, x);
    await reversed(h, bashScreen(commandOf(x)), bashScreen('echo inna-komenda > /dev/null'));
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
  });

  it('nowszy ekran pokazuje tę prośbę, starszy inny dialog → przycisk zostaje', async () => {
    const h = await harness();
    const x = bash('panele-b', 'echo panele-b > /dev/null');
    hookStarts(h, x);
    await reversed(h, READ_SCREEN, bashScreen(commandOf(x)));
    expect(cardOf(h, x)).toEqual(BUTTON);
    await allowSigned(h, x);
  });
});

describe('pula pełna: każdy inny kandydat musi dać `no`', () => {
  it('dwa zrzuty `Bash` tej samej komendy, jeden rozstrzygnięty przy biurku (narzędzie biegnie, rejestr dalej'
    + ' `waiting`) → oba bez przycisku', async () => {
    const h = await harness();
    const command = 'echo blizniak > /dev/null';
    const first = bash('blizniak-1', command);
    hookStarts(h, first);
    clock += 300;
    const second = bash('blizniak-2', command);
    hookStarts(h, second);
    const running: TranscriptToolUses = { open: [{ toolName: 'Bash', input: first.toolInput }], closed: [], lostAt: null };
    for (let tick = 0; tick < 8; tick += 1) {
      clock += TICK_MS;
      await h.step(waiting(), bashScreen(command), { transcript: running });
      expect([first, second].map((dump) => h.cycle.card(SESSION, dump.key)?.canAllow)).toEqual([false, false]);
    }
    // Starszy bliźniak po 5 s jest sierotą (`transkrypt-nadmiar`) i traci kartę, ale zostaje w puli.
    expect(stateOf(h, first)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
    expect(cardOf(h, second)).toEqual(NO_BUTTON);
  });

  it('zawinięta ramka pasuje do komendy ze spacją i z nową linią na granicy → obie bez przycisku', async () => {
    const h = await harness();
    const head = `echo ${'x'.repeat(40)}`;
    const tail = 'y'.repeat(20);
    const spaced = bash('zawiniecie-spacja', `${head} ${tail}`);
    const broken = bash('zawiniecie-linia', `${head}\n${tail}`);
    hookStarts(h, spaced);
    hookStarts(h, broken);
    await h.step(waiting(), bashScreen(head, tail));
    expect([cardOf(h, spaced), cardOf(h, broken)]).toEqual([NO_BUTTON, NO_BUTTON]);
  });

  it('przycięty zrzut `Bash` (skrót wejścia niezgodny z wejściem) w puli → bez przycisku dla pasującej prośby', async () => {
    const h = await harness();
    const x = bash('pelny', 'echo pelny > /dev/null');
    const cut = bash('przyciety', 'echo przyciety', { inputSha256: canonicalSha256({ command: 'echo pełne wejście' }) });
    hookStarts(h, x);
    writeDump(h, cut, true);
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
  });

  it('dwa zrzuty planu tej samej nazwy → oba bez przycisku, także gdy hook pierwszego już wyszedł', async () => {
    const h = await harness();
    const first = plan('plan-1', 'ta-sama-nazwa');
    hookStarts(h, first);
    clock += 300;
    const second = plan('plan-2', 'ta-sama-nazwa');
    hookStarts(h, second);
    await h.step(waiting(), planScreen('ta-sama-nazwa'));
    expect([cardOf(h, first), cardOf(h, second)]).toEqual([NO_BUTTON, NO_BUTTON]);
    hookExits(h, first);
    clock += TICK_MS;
    await h.step(waiting(), planScreen('ta-sama-nazwa'));
    expect(cardOf(h, second)).toEqual(NO_BUTTON);
  });

  it('plan innej nazwy w puli nie zabiera dowodu (`no`)', async () => {
    const h = await harness();
    const other = plan('plan-inny', 'inna-nazwa');
    hookStarts(h, other);
    clock += 300;
    const p = plan('plan-ten', 'ta-nazwa');
    hookStarts(h, p);
    await h.step(waiting(), planScreen('ta-nazwa'));
    expect([cardOf(h, other), cardOf(h, p)]).toEqual([NO_BUTTON, BUTTON]);
  });

  it('zrzut subagenta tej samej komendy w puli → prośba wątku głównego bez przycisku (zostaje w puli na stałe)', async () => {
    const h = await harness();
    const command = 'echo subagent > /dev/null';
    const sub = bash('subagent', command, { agentId: 'agent-1' });
    writeDump(h, sub, true);
    await h.step(waiting(), null);
    hookExits(h, sub);
    // Rejestr bez `waiting` po zapasie: zrzut subagenta z puli nie wychodzi (rejestr przy subagencie mówi `busy`).
    clock = sub.at + REGISTRY_SLACK_MS + 500;
    await h.step(active(), null);
    clock += 500;
    const x = bash('glowny', command);
    hookStarts(h, x);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
  });

  it.each([
    ['`Edit` w kolejce (licznik „1 of 2”)', 'Edit', EDIT_INPUT, EDIT_QUEUE_SCREEN],
    ['MCP', 'mcp__catalog__get_project_tree_layout', { space: 'pomiar' }, MCP_SCREEN],
    ['`Read`', 'Read', { file_path: '/projekt/zewn/a.txt' }, READ_SCREEN],
    ['`Write`', 'Write', { file_path: `${CWD}/pomiar.txt`, content: 'pomiar\n' }, WRITE_SCREEN],
  ] as const)('%s na wierzchu → bez przycisku (wierzch bez pełnej tożsamości)', async (_name, tool, input, screen) => {
    const h = await harness();
    const d = dumpOf(`bez-tozsamosci-${tool}`, tool, input);
    hookStarts(h, d);
    await h.step(waiting(), screen);
    expect(cardOf(h, d)).toEqual(NO_BUTTON);
  });
});

/**
 * Kolejka `Bash` z licznikiem bez linii `Ask rule` (tryb domyślny) na zmierzonym ekranie CLI 2.1.319: dwa
 * równoległe `cat` spoza katalogu sesji, na wierzchu „Bash command … 1 of 2” z całą ramką `cat …/a.txt`.
 */
describe('kolejka `Bash` z licznikiem bez `Ask rule`: przycisk tylko dla prośby z ramki na wierzchu', () => {
  const QUEUE = 'dialog-bash-kolejka-licznik-2.1.319';
  const QUEUE_SCREEN = fixture(`${QUEUE}.txt`);
  const A = (JSON.parse(fixture(`${QUEUE}.command.json`)) as { command: string }).command;
  const B = A.replace(/a\.txt$/u, 'b.txt');
  /** Zmierzony ekran kolejki z podanymi liniami ramki komendy (pasek `│`, ramka na 127 kolumn). */
  const queueScreen = (...frame: readonly string[]): string =>
    QUEUE_SCREEN.replace(/^ │ cat .*$/mu, frame.map((line) => ` │ ${line}`).join('\n'));

  it('obie prośby kolejki w puli → przycisk wyłącznie dla `a`, zgoda z telefonu podpisana dla hooka `a`; `b` bez'
    + ' przycisku, `decide(allow)` odrzucone bez pliku odpowiedzi', async () => {
    const h = await harness();
    const a = bash('kolejka-a', A);
    hookStarts(h, a);
    clock += 100;
    const b = bash('kolejka-b', B);
    hookStarts(h, b);
    await h.step(waiting(), QUEUE_SCREEN);
    expect([cardOf(h, a), cardOf(h, b)]).toEqual([BUTTON, NO_BUTTON]);
    expect(await h.cycle.decide(SESSION, b.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(answerPath(h, b, '.json'))).toBe(false);
    await allowSigned(h, a);
  });

  it('dwie identyczne komendy w kolejce → żadna karta bez przycisku zgody', async () => {
    const h = await harness();
    const first = bash('kolejka-blizniak-1', A);
    hookStarts(h, first);
    clock += 100;
    const second = bash('kolejka-blizniak-2', A);
    hookStarts(h, second);
    await h.step(waiting(), QUEUE_SCREEN);
    expect([cardOf(h, first), cardOf(h, second)]).toEqual([NO_BUTTON, NO_BUTTON]);
  });

  it('dwie komendy, które zawinięta ramka pokazuje tak samo (spacja i nowa linia na granicy) → żadna z przyciskiem',
    async () => {
      const h = await harness();
      const head = `cat ${'x'.repeat(100)}`;
      const tail = 'y'.repeat(30);
      const spaced = bash('kolejka-zawiniecie-spacja', `${head} ${tail}`);
      const broken = bash('kolejka-zawiniecie-linia', `${head}\n${tail}`);
      hookStarts(h, spaced);
      hookStarts(h, broken);
      await h.step(waiting(), queueScreen(head, tail));
      expect([cardOf(h, spaced), cardOf(h, broken)]).toEqual([NO_BUTTON, NO_BUTTON]);
      // Sprawdzian: ta sama ramka przy jednej z tych komend w puli daje przycisk.
      const alone = await harness();
      const one = bash('kolejka-zawiniecie-sama', `${head} ${tail}`);
      hookStarts(alone, one);
      await alone.step(waiting(), queueScreen(head, tail));
      expect(cardOf(alone, one)).toEqual(BUTTON);
    });

  it('kontrprzykład `Write` przycięty od wstrzykniętej kreski (tytuł „Create file” nad krawędzią odczytu, para'
    + ' licznikowa podrobiona, pod ramką pytanie `Write`): zrzut `Bash` „1 pomiar” i zrzut `Write` w puli → żadna karta'
    + ' z przyciskiem zgody, `decide(allow)` odrzucone bez pliku odpowiedzi', async () => {
    const forged = `${'─'.repeat(63)}\n Bash command${' '.repeat(20)}1 of 2\n`;
    const full = WRITE_SCREEN.replace(' pomiar-dialogow-nowy.txt\n', () => ` pomiar-dialogow-nowy.txt\n${forged}`);
    const screen = full.slice(full.indexOf(forged));
    expect(screen.startsWith(forged)).toBe(true);
    const h = await harness();
    const forgedBash = bash('podrobiona-para-bash', '1 pomiar');
    hookStarts(h, forgedBash);
    clock += 100;
    const write = dumpOf('podrobiona-para-write', 'Write',
      { file_path: `${CWD}/pomiar-dialogow-nowy.txt`, content: 'pomiar\n' });
    hookStarts(h, write);
    await h.step(waiting(), screen);
    expect([cardOf(h, forgedBash), cardOf(h, write)]).toEqual([NO_BUTTON, NO_BUTTON]);
    expect(await h.cycle.decide(SESSION, forgedBash.key, 'allow'))
      .toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(answerPath(h, forgedBash, '.json'))).toBe(false);
  });
});

/**
 * Ogon i dół dialogu: para tytułu i ramka wpisane w treść innego dialogu nie dają przycisku żadnej prośbie,
 * a dialog, którego ogon przestaje pasować do listy, traci przycisk przy następnej obserwacji.
 */
describe('ogon i dół dialogu: podróbka w treści bez przycisku, odrzucony ogon zabiera przycisk', () => {
  const READ_SCREEN_CUT = (forged: string): string => {
    const full = READ_SCREEN.replace(' Read file\n', () => ` Read file\n${forged}`);
    return full.slice(full.indexOf(forged));
  };
  const RULE = '╌'.repeat(128);
  const BASH_FORGED = `${'─'.repeat(128)}\n Bash command\n${RULE}\n cat /etc/hosts\n${RULE}\n`;
  const EDIT_FORGED = `${'─'.repeat(128)}\n Edit file\n pomiar-dialogow.txt\n${RULE}\n 1 -stara wartosc\n`
    + ` 1 +nowa wartosc\n${RULE}\n`;

  it.each([
    ['`Bash` spod tytułu z listy', BASH_FORGED, (): HookCallDump => bash('podrobiony-tytul-bash', 'cat /etc/hosts')],
    ['nagłówek i ramka `Edit`', EDIT_FORGED, (): HookCallDump => dumpOf('podrobiony-tytul-edit', 'Edit', EDIT_INPUT)],
  ] as const)('odtworzenie z review (%s pod tytułem `Read`, odczyt od kreski): zrzut z podróbki i zrzut `Read`'
    + ' w puli → żadna karta z przyciskiem, `decide(allow)` odrzucone bez pliku odpowiedzi', async (_name, forged, own) => {
    const h = await harness();
    const forgedDump = own();
    hookStarts(h, forgedDump);
    clock += 100;
    const read = dumpOf('podrobiony-tytul-read', 'Read', { file_path: '/etc/hosts' });
    hookStarts(h, read);
    await h.step(waiting(), READ_SCREEN_CUT(forged));
    expect([cardOf(h, forgedDump), cardOf(h, read)]).toEqual([NO_BUTTON, NO_BUTTON]);
    expect(await h.cycle.decide(SESSION, forgedDump.key, 'allow'))
      .toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(answerPath(h, forgedDump, '.json'))).toBe(false);
  });

  it.each([
    ['linia spoza listy w strefie pytania `Bash`', (screen: string): string =>
      screen.replace(' Do you want to proceed?\n', () => ' Note: linia spoza listy\n Do you want to proceed?\n')],
    ['tekst transkryptu pod stopką', (screen: string): string => `${screen}\n⏺ dalszy tekst transkryptu\n`],
  ] as const)('przejście z rozpoznanego dialogu `Bash` na odrzucony ogon (%s): karta traci przycisk, spóźnione'
    + ' `decide(allow)` odmawia i nie zapisuje podpisanej odpowiedzi', async (_name, reject) => {
    const h = await harness();
    const x = bash('odrzucony-ogon', 'echo s3a6l > /dev/null');
    hookStarts(h, x);
    const screen = bashScreen(commandOf(x));
    await h.step(waiting(), screen);
    expect(cardOf(h, x)).toEqual(BUTTON);
    clock += TICK_MS;
    const rejected = reject(screen);
    expect(rejected).not.toBe(screen);
    await h.step(waiting(), rejected);
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(answerPath(h, x, '.json'))).toBe(false);
  });
});

describe('pula lepka: jedyne wyjście to rejestr bez `waiting` po zapasie', () => {
  it('zrzut znika przy stojącym dialogu (zwolnienie do terminala), potem nowa prośba tej samej komendy → bez'
    + ' przycisku, aż rejestr bez `waiting` co najmniej `REGISTRY_SLACK_MS` po zrzucie; rejestr nieznany nie wyjmuje',
  async () => {
    const h = await harness();
    const command = 'echo zwolniona > /dev/null';
    const released = bash('zwolniona', command);
    hookStarts(h, released);
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, released)).toEqual(BUTTON);
    expect(await h.cycle.release(SESSION, released.key)).toEqual({ ok: true, state: 'sent' });
    // Hook przyjmuje zwolnienie i wychodzi bez decyzji: zrzut znika, dialog stoi w terminalu.
    hookExits(h, released);
    clock = released.at + 1_500;
    const next = bash('nastepna', command);
    hookStarts(h, next);
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, next)).toEqual(NO_BUTTON);
    clock = released.at + REGISTRY_SLACK_MS + 50;
    await h.step(writers, null);
    clock += 50;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, next)).toEqual(NO_BUTTON);
    // Rejestr bez `waiting` po zapasie zwolnionej (a w zapasie następnej): zwolniona wychodzi z puli na stałe.
    clock = released.at + REGISTRY_SLACK_MS + 200;
    expect(clock).toBeLessThan(next.at + REGISTRY_SLACK_MS);
    await h.step(active(), null);
    expect(stateOf(h, next)).toEqual({ state: 'pending', cause: null });
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, next)).toEqual(BUTTON);
    await allowSigned(h, next);
  });

  it('wyjście zapisane w chwili rozpoczęcia odczytu ekranu albo później: kandydat zostaje w porównaniu', async () => {
    const h = await harness();
    const command = 'echo rowne-chwile > /dev/null';
    const gone = bash('rowne-1', command);
    hookStarts(h, gone);
    await h.step(waiting(), bashScreen(command));
    hookExits(h, gone);
    clock = gone.at + 1_500;
    const next = bash('rowne-2', command);
    hookStarts(h, next);
    const exitAt = gone.at + REGISTRY_SLACK_MS + 100;
    expect(exitAt).toBeLessThan(next.at + REGISTRY_SLACK_MS);
    clock = exitAt;
    await h.step(active(), null);
    // Ekran przeczytany w tej samej chwili co rejestr wyjścia: wyjście nie było zapisane przed odczytem.
    await h.step(waiting(), bashScreen(command), { readStartedAt: exitAt });
    expect(cardOf(h, next)).toEqual(NO_BUTTON);
    clock = exitAt + 1;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, next)).toEqual(BUTTON);
  });

  it('restart: dialog stoi, stary zrzut znika, nowa prośba → bez przycisku do pierwszego rejestru bez `waiting`'
    + ' po starcie (dwóch pisarzy rejestru blokady nie zdejmuje), potem nowa prośba z przyciskiem', async () => {
    const h = await harness({ locked: true });
    const command = 'echo po-restarcie > /dev/null';
    // Hook sprzed restartu (stary `bootId`) skończył czekanie wetem `restart` i usunął zrzut, zanim nowy proces go
    // zobaczył; jego dialog stoi dalej, a nowa prośba tej samej komendy czeka za nim.
    clock += 500;
    const fresh = bash('po-restarcie', command);
    hookStarts(h, fresh);
    const seen: unknown[] = [];
    for (let tick = 0; tick < 4; tick += 1) {
      clock += TICK_MS;
      await h.step(tick === 2 ? writers : waiting(), tick === 2 ? null : bashScreen(command));
      seen.push(cardOf(h, fresh));
    }
    expect(seen).toEqual(seen.map(() => NO_BUTTON));
    // Pierwszy świeży rejestr bez `waiting` po starcie (dialogi rozstrzygnięte, CLI pracuje): blokada zdjęta.
    clock += 100;
    await h.step(active(), null);
    expect(stateOf(h, fresh)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
    clock += TICK_MS;
    const after = bash('nastepna-po-restarcie', command);
    hookStarts(h, after);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, after)).toEqual(BUTTON);
    await allowSigned(h, after);
  });

  it('zamknięcie w transkrypcie pasujące do X → X bez przycisku na stałe, a X zostaje w puli (także po wyjściu'
    + ' hooka): identyczna prośba bez przycisku do rejestru bez `waiting`', async () => {
    const h = await harness();
    const command = 'echo zamknieta > /dev/null';
    const x = bash('zamknieta', command);
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(command), { transcript: { open: [], closed: [], lostAt: null } });
    expect(cardOf(h, x)).toEqual(BUTTON);
    clock += 400;
    const closed: TranscriptToolUses = {
      open: [], closed: [{ toolName: 'Bash', inputSha256: x.inputSha256, closedAt: clock - 100 }], lostAt: null,
    };
    await h.step(waiting(), bashScreen(command), { transcript: closed });
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    clock += 100;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    // Hook X wychodzi (zrzut znika); X zostaje kandydatem puli.
    hookExits(h, x);
    clock += 200;
    const twin = bash('po-zamknieciu', command);
    hookStarts(h, twin);
    clock += 300;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, twin)).toEqual(NO_BUTTON);
    // Rejestr bez `waiting` po zapasie X, a w zapasie bliźniaka: X wychodzi z puli, bliźniak ma przycisk.
    clock = x.at + REGISTRY_SLACK_MS + 100;
    expect(clock).toBeLessThan(twin.at + REGISTRY_SLACK_MS);
    await h.step(active(), null);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, twin)).toEqual(BUTTON);
    await allowSigned(h, twin);
  });
});

describe('stany po decyzji: `standing` tylko z dopasowania przy `no` dla reszty puli', () => {
  it('rekord `claimed`, hook wyszedł, na wierzchu dialog innej komendy bez zrzutu → nie `standing`: po 30 s dalej'
    + ' `claimed`', async () => {
    const h = await harness();
    const x = bash('odebrana-inna', 'echo odebrana > /dev/null');
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(commandOf(x)));
    await allowSigned(h, x);
    const claimedAt = await claimed(h, x);
    hookExits(h, x);
    await ticksUntil(h, x, claimedAt + CONSENT_CLAIMED_STANDING_MS + 3_000, () => waiting(),
      bashScreen('echo inny-dialog-bez-zrzutu > /dev/null'));
    expect(stateOf(h, x)).toEqual({ state: 'claimed', cause: null });
  });

  it('rekord `claimed`, hook wyszedł, na wierzchu ten sam dialog 30 s → `unknown: no-effect` jak dziś', async () => {
    const h = await harness();
    const x = bash('odebrana-stoi', 'echo odebrana-stoi > /dev/null');
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(commandOf(x)));
    await allowSigned(h, x);
    const claimedAt = await claimed(h, x);
    hookExits(h, x);
    await ticksUntil(h, x, claimedAt + CONSENT_CLAIMED_STANDING_MS - 1_000, () => waiting(), bashScreen(commandOf(x)));
    expect(stateOf(h, x)).toEqual({ state: 'claimed', cause: null });
    clock = claimedAt + CONSENT_CLAIMED_STANDING_MS;
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(stateOf(h, x)).toEqual({ state: 'unknown', cause: 'no-effect' });
  });

  it('rekord `claimed`, hook żywy, na wierzchu dialog innej komendy → nie `standing`; ten sam → 30 s `no-effect`',
    async () => {
      const h = await harness();
      const x = bash('odebrana-zywy', 'echo odebrana-zywy > /dev/null');
      hookStarts(h, x);
      await h.step(waiting(), bashScreen(commandOf(x)));
      await allowSigned(h, x);
      const claimedAt = await claimed(h, x);
      await ticksUntil(h, x, claimedAt + CONSENT_CLAIMED_STANDING_MS + 1_500, () => waiting(),
        bashScreen('echo inny > /dev/null'));
      expect(stateOf(h, x)).toEqual({ state: 'claimed', cause: null });
      clock += TICK_MS;
      await h.step(waiting(), bashScreen(commandOf(x)));
      expect(stateOf(h, x)).toEqual({ state: 'unknown', cause: 'no-effect' });
    });
});

describe('sufit puli', () => {
  it(`${String(CONSENT_POOL_MAX)} kandydatów sesji, potem następny → sesja bez dowodu do restartu, inne sesje bez`
    + ' zmian', async () => {
    const h = await harness();
    // Zrzuty martwych hooków też są kandydatami: 16 obserwacji po 64 zrzuty (sufit odczytu katalogu).
    let written: HookCallDump[] = [];
    for (let batch = 0; batch < CONSENT_POOL_MAX / 64; batch += 1) {
      for (const dump of written) rmSync(dumpPath(h, dump), { force: true });
      written = [];
      for (let n = 0; n < 64; n += 1) {
        const dump = bash(`sufit-${String(batch)}-${String(n)}`, `echo sufit-${String(batch)}-${String(n)}`);
        mkdirSync(dirname(dumpPath(h, dump)), { recursive: true, mode: 0o700 });
        writeFileSync(dumpPath(h, dump), JSON.stringify(dump), { mode: 0o600 });
        h.life.set(dump.pid, false);
        written.push(dump);
      }
      await h.step(waiting(), null);
    }
    for (const dump of written) rmSync(dumpPath(h, dump), { force: true });
    expect(h.cycle.cards(SESSION)).toEqual([]);
    clock += TICK_MS;
    const x = bash('po-sufitie', 'echo po-sufitie > /dev/null');
    hookStarts(h, x);
    // Rejestr bez `waiting` wyjmuje zrzuty partii (po zapasie), ale nie X; sufit zostaje: kandydatów się nie wymienia.
    clock += 500;
    expect(clock).toBeLessThan(x.at + REGISTRY_SLACK_MS);
    await h.step(active(), null);
    expect(stateOf(h, x)).toEqual({ state: 'pending', cause: null });
    const seen: unknown[] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      clock += TICK_MS;
      await h.step(waiting(), bashScreen(commandOf(x)));
      seen.push(cardOf(h, x));
    }
    expect(seen).toEqual(seen.map(() => NO_BUTTON));
    const other = bash('inna-sesja', 'echo inna-sesja > /dev/null', { sessionId: OTHER_SESSION });
    hookStarts(h, other);
    await h.step(waiting(), bashScreen(commandOf(other)), { sessionId: OTHER_SESSION });
    expect(cardOf(h, other)).toEqual(BUTTON);
    await allowSigned(h, other);
  });
});

/**
 * {@link CONSENT_POOL_MAX} zrzutów martwych hooków w 16 obserwacjach po 64 (sufit odczytu katalogu). `exit` = każda
 * obserwacja z rejestrem bez `waiting` po zapasie, więc kandydaci partii wychodzą z puli w tej samej obserwacji.
 */
async function fillPool(h: Harness, prefix: string, exit: boolean): Promise<void> {
  let written: HookCallDump[] = [];
  for (let batch = 0; batch < CONSENT_POOL_MAX / 64; batch += 1) {
    for (const dump of written) rmSync(dumpPath(h, dump), { force: true });
    written = [];
    for (let n = 0; n < 64; n += 1) {
      const dump = bash(`${prefix}-${String(batch)}-${String(n)}`, `echo ${prefix}-${String(batch)}-${String(n)}`);
      writeDump(h, dump, false);
      written.push(dump);
    }
    if (exit) clock += TICK_MS;
    await h.step(exit ? active() : waiting(), null);
  }
  for (const dump of written) rmSync(dumpPath(h, dump), { force: true });
}

describe('pamięć puli: kandydat po wyjściu i terminie bez zrzutu, sufit liczy kandydatów bez wyjścia', () => {
  it('kandydat po wyjściu i terminie zostaje jako klucz z chwilą wyjścia; ten sam plik na dysku nie wraca jako nowy'
    + ' kandydat i nie dostaje dowodu, a nowa prośba tej samej komendy ma przycisk', async () => {
    const h = await harness();
    const command = 'echo po-wyjsciu > /dev/null';
    const x = bash('po-wyjsciu', command);
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, x)).toEqual(BUTTON);
    // Dialog rozstrzygnięty przy biurku: rejestr bez `waiting` po zapasie wyjmuje X; hook X czeka dalej, zrzut leży.
    clock = x.at + REGISTRY_SLACK_MS + 100;
    const exitAt = clock;
    await h.step(active(), null);
    expect(stateOf(h, x)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
    expect(h.cycle.pool(SESSION).candidates).toEqual([expect.objectContaining({ exitAt })]);
    // Termin każdego odczytu, który mógł użyć X, minął: w pamięci zostaje klucz i chwila wyjścia, bez zrzutu.
    clock = exitAt + CONSENT_PROOF_TTL_MS + 1;
    await h.step(waiting(), null);
    expect(h.cycle.pool(SESSION)).toMatchObject({ candidates: [], exited: [{ key: x.key, exitAt }], exitedAt: exitAt });
    const y = bash('po-wyjsciu-nastepna', command);
    hookStarts(h, y);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(command));
    expect(h.observation?.dumps.map((dump) => dump.key)).toContain(x.key);
    expect(h.cycle.pool(SESSION).candidates.map((candidate) => candidate.dump.key)).toEqual([y.key]);
    expect(h.observation?.signals.get(x.key)).not.toBe('standing');
    expect(cardOf(h, y)).toEqual(BUTTON);
    await allowSigned(h, y);
  });

  it(`${String(CONSENT_POOL_MAX)} kandydatów po wyjściu nie blokuje sesji: pula trzyma ich klucze bez zrzutów, nowa`
    + ' prośba ma przycisk i podpisaną zgodę', async () => {
    const h = await harness();
    await fillPool(h, 'wyszli', true);
    clock += CONSENT_PROOF_TTL_MS + 1;
    const x = bash('po-wyjsciach', 'echo po-wyjsciach > /dev/null');
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(commandOf(x)));
    const pool = h.cycle.pool(SESSION);
    expect(pool.overflow).toBe(false);
    expect(pool.candidates.map((candidate) => candidate.dump.key)).toEqual([x.key]);
    expect(pool.exited.length).toBe(CONSENT_POOL_MAX);
    expect(cardOf(h, x)).toEqual(BUTTON);
    await allowSigned(h, x);
  });

  it('przekroczenie sufitu zwalnia treść puli (kandydaci i klucze po wyjściu), a blokada dowodu sesji zostaje do'
    + ' restartu; inne sesje bez zmian', async () => {
    const h = await harness();
    const gone = bash('przed-sufitem', 'echo przed-sufitem > /dev/null');
    writeDump(h, gone, false);
    await h.step(waiting(), null);
    rmSync(dumpPath(h, gone));
    clock = gone.at + REGISTRY_SLACK_MS + 100;
    await h.step(active(), null);
    clock += CONSENT_PROOF_TTL_MS + 1;
    await h.step(waiting(), null);
    expect(h.cycle.pool(SESSION).exited.map((one) => one.key)).toEqual([gone.key]);
    await fillPool(h, 'zwolnienie', false);
    const over = bash('ponad-sufit', 'echo ponad-sufit > /dev/null');
    writeDump(h, over, false);
    await h.step(waiting(), null);
    rmSync(dumpPath(h, over));
    expect(h.cycle.pool(SESSION)).toMatchObject({ overflow: true, candidates: [], exited: [] });
    const x = bash('po-zwolnieniu', 'echo po-zwolnieniu > /dev/null');
    hookStarts(h, x);
    for (let tick = 0; tick < 3; tick += 1) {
      clock += TICK_MS;
      await h.step(waiting(), bashScreen(commandOf(x)));
      expect(cardOf(h, x)).toEqual(NO_BUTTON);
    }
    expect(h.cycle.pool(SESSION)).toMatchObject({ overflow: true, candidates: [], exited: [] });
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    const other = bash('inna-sesja-po-zwolnieniu', 'echo inna-sesja-po-zwolnieniu > /dev/null', { sessionId: OTHER_SESSION });
    hookStarts(h, other);
    await h.step(waiting(), bashScreen(commandOf(other)), { sessionId: OTHER_SESSION });
    expect(cardOf(h, other)).toEqual(BUTTON);
    await allowSigned(h, other);
  });
});

describe('`Edit`: `no` tylko przy dowiedzionej sprzeczności ścieżki, poza nią bez potwierdzenia `unknown`', () => {
  /** Ten sam dialog `Edit` z diffem `a b ab` → `x ab` (prawdziwy kształt zamiany `replace_all` „a b” → „x”). */
  const REPLACE_ALL_SCREEN = EDIT_SCREEN.replace(' 1 -stara wartosc', ' 1 -a b ab').replace(' 1 +nowa wartosc', ' 1 +x ab');
  const FILE = `${CWD}/pomiar-dialogow.txt`;

  it('prawdziwy dialog `Edit` z `replace_all` na `a b ab` i drugi kandydat pasujący do widocznego diffu → żaden bez'
    + ' przycisku, `decide(allow)` → `card-changed`, bez pliku', async () => {
    const h = await harness();
    const real = dumpOf('replace-all', 'Edit', { file_path: FILE, old_string: 'a b', new_string: 'x', replace_all: true });
    hookStarts(h, real);
    clock += 300;
    const visible = dumpOf('widoczny-diff', 'Edit', {
      file_path: FILE, old_string: 'a b ab', new_string: 'x ab', replace_all: false,
    });
    hookStarts(h, visible);
    await h.step(waiting(), REPLACE_ALL_SCREEN);
    expect([cardOf(h, real), cardOf(h, visible)]).toEqual([NO_BUTTON, NO_BUTTON]);
    for (const dump of [visible, real]) {
      expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
      expect(existsSync(answerPath(h, dump, '.json'))).toBe(false);
    }
  });

  it('`Edit` innego pliku w puli (ścieżka z nagłówka nie może go wskazać) dowodu nie zabiera', async () => {
    const h = await harness();
    const other = dumpOf('inny-plik', 'Edit', { ...EDIT_INPUT, file_path: `${CWD}/inny-plik.txt` });
    hookStarts(h, other);
    clock += 300;
    const e = dumpOf('ten-plik', 'Edit', EDIT_INPUT);
    hookStarts(h, e);
    await h.step(waiting(), EDIT_SCREEN);
    expect([cardOf(h, other), cardOf(h, e)]).toEqual([NO_BUTTON, BUTTON]);
    await allowSigned(h, e);
  });
});

describe('dowód tylko przy zwycięzcy bieżącej puli (krok kolejki, widok, `decide`, publikacja)', () => {
  /** `ps` wstrzymane do `release`: obserwacja drugiego panelu stoi po odczycie zrzutów i dopisaniu ich do puli. */
  function heldLiveness(h: Harness): { readonly liveness: ProcessLiveness; readonly release: () => void } {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    return {
      liveness: async (processes, at) => {
        await held;
        return h.liveness(processes, at);
      },
      release: () => { release(); },
    };
  }

  it('druga obserwacja dopisuje bliźniaka między `topNow()` a krokiem kolejki pierwszej → bez przycisku,'
    + ' `decide(allow)` → `card-changed`, bez pliku', async () => {
    const h = await harness();
    const command = 'echo wyscig > /dev/null';
    const x = bash('wyscig', command);
    hookStarts(h, x);
    const twin = bash('wyscig-blizniak', command);
    const second = heldLiveness(h);
    let running: Promise<void> = Promise.resolve();
    await h.step(waiting(), bashScreen(command), {
      // Po sygnałach pierwszej obserwacji (X na wierzchu), przed jej krokiem kolejki: drugi panel czyta zrzuty.
      inspect: (observation) => {
        expect(observation.signals.get(x.key)).toBe('standing');
        hookStarts(h, twin);
        queueMicrotask(() => {
          running = h.step(waiting(), bashScreen(command), { liveness: second.liveness });
        });
      },
    });
    expect(h.cycle.pool(SESSION).candidates.map((candidate) => candidate.dump.key)).toEqual([x.key, twin.key]);
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    expect(h.published.filter((view) => view.permId === x.key).map((view) => view.canAllow)).not.toContain(true);
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(answerPath(h, x, '.json'))).toBe(false);
    second.release();
    await running;
    expect([cardOf(h, x), cardOf(h, twin)]).toEqual([NO_BUTTON, NO_BUTTON]);
  });

  it('druga obserwacja dopisuje bliźniaka po kroku kolejki pierwszej → przycisk znika od razu w `card()` i `cards()`,'
    + ' `decide(allow)` → `card-changed`, bez pliku', async () => {
    const h = await harness();
    const command = 'echo po-kroku > /dev/null';
    const x = bash('po-kroku', command);
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(command));
    expect(cardOf(h, x)).toEqual(BUTTON);
    const twin = bash('po-kroku-blizniak', command);
    hookStarts(h, twin);
    const second = heldLiveness(h);
    clock += 100;
    const running = h.step(waiting(), bashScreen(command), { liveness: second.liveness });
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    expect(h.cycle.cards(SESSION).map((card) => card.canAllow)).toEqual([false]);
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(answerPath(h, x, '.json'))).toBe(false);
    second.release();
    await running;
    expect([cardOf(h, x), cardOf(h, twin)]).toEqual([NO_BUTTON, NO_BUTTON]);
  });

  it('kandydat z `no` dopisany przez drugą obserwację dowodu nie zabiera', async () => {
    const h = await harness();
    const x = bash('z-no', 'echo z-no > /dev/null');
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(commandOf(x)));
    const other = bash('z-no-inna', 'echo inna-komenda > /dev/null');
    hookStarts(h, other);
    const second = heldLiveness(h);
    clock += 100;
    const running = h.step(waiting(), bashScreen(commandOf(x)), { liveness: second.liveness });
    expect(h.cycle.pool(SESSION).candidates.map((candidate) => candidate.dump.key)).toEqual([x.key, other.key]);
    expect(cardOf(h, x)).toEqual(BUTTON);
    await allowSigned(h, x);
    second.release();
    await running;
  });
});

describe('odczyt zrzutów niekompletny: obserwacja bez dowodu, cień czyta jak dziś', () => {
  const pendingDir = (h: Harness): string => join(h.dir, HOOK_PENDING_DIRNAME, SESSION);
  const keyOf = (name: string): string => name.slice(0, -'.json'.length);

  it('65 zrzutów w sesji, bliźniak tej samej komendy pominięty przez sufit odczytu → bez przycisku; cień dostaje te'
    + ' same 64 zrzuty', async () => {
    const h = await harness();
    const command = 'echo sufit-odczytu > /dev/null';
    for (let n = 0; n < 65; n += 1) writeDump(h, bash(`odczyt-${String(n)}`, `echo odczyt-${String(n)}`), false);
    const names = readdirSync(pendingDir(h)).filter((name) => name.endsWith('.json'));
    expect(names.length).toBe(65);
    // Prośba na pierwszym miejscu `readdir`, bliźniak na 65.: odczyt kończy się na 64 zrzutach.
    const x = bash('odczyt-x', command, { key: keyOf(names[0] ?? '') });
    const twin = bash('odczyt-blizniak', command, { key: keyOf(names[64] ?? '') });
    hookStarts(h, x);
    hookStarts(h, twin);
    await h.step(waiting(), bashScreen(command));
    expect(h.observation?.dumps.map((dump) => dump.key)).not.toContain(twin.key);
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(answerPath(h, x, '.json'))).toBe(false);
    const read = names.slice(0, 64).map((name) => JSON.parse(readFileSync(join(pendingDir(h), name), 'utf8')) as HookCallDump);
    const shadow = readCallDumps(h.dir, SESSION);
    expect(shadow).toEqual([...read].sort((a, b) => a.at - b.at));
    expect(scanCallDumps(h.dir, SESSION)).toEqual({ dumps: shadow, complete: false });
  });

  it('plik o nazwie zrzutu z zepsutym JSON → bez przycisku w tej obserwacji, po jego zniknięciu przycisk; cień pomija'
    + ' plik jak dziś', async () => {
    const h = await harness();
    const x = bash('zepsuty-json', 'echo zepsuty-json > /dev/null');
    hookStarts(h, x);
    const broken = join(pendingDir(h), `${PROMPT}-${'e'.repeat(32)}.json`);
    writeFileSync(broken, '{"key":', { mode: 0o600 });
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(answerPath(h, x, '.json'))).toBe(false);
    expect(readCallDumps(h.dir, SESSION)).toEqual([x]);
    expect(scanCallDumps(h.dir, SESSION)).toEqual({ dumps: [x], complete: false });
    rmSync(broken);
    clock += TICK_MS;
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(cardOf(h, x)).toEqual(BUTTON);
    await allowSigned(h, x);
  });

  it('zrzut bliźniaka znika między `readdir` a odczytem (hook wyszedł) → bez przycisku w tej obserwacji; cień'
    + ' pomija go jak dziś', async () => {
    const h = await harness();
    const command = 'echo znika > /dev/null';
    const x = bash('znika', command);
    const twin = bash('znika-blizniak', command);
    hookStarts(h, x);
    hookStarts(h, twin);
    listing.after = { dir: pendingDir(h), remove: dumpPath(h, twin) };
    await h.step(waiting(), bashScreen(command));
    expect(listing.after).toBeNull();
    expect(h.observation?.dumps.map((dump) => dump.key)).toEqual([x.key]);
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(answerPath(h, x, '.json'))).toBe(false);
    writeDump(h, twin, true);
    listing.after = { dir: pendingDir(h), remove: dumpPath(h, twin) };
    expect(readCallDumps(h.dir, SESSION)).toEqual([x]);
    writeDump(h, twin, true);
    listing.after = { dir: pendingDir(h), remove: dumpPath(h, twin) };
    expect(scanCallDumps(h.dir, SESSION)).toEqual({ dumps: [x], complete: false });
  });
});

describe('termin dowodu po zapisie `deciding` i widok karty liczony przy odczycie', () => {
  it('termin mija w trakcie zapisu `deciding` (atrapa zapisu przesuwa zegar) → `card-changed`, rekord `pending`, bez'
    + ' pliku odpowiedzi', async () => {
    let slow = false;
    const h = await harness({
      io: {
        writeRecord: (dataDir, record, options) => {
          // Zapis `deciding` z `fsync` trwa dłużej niż reszta terminu dowodu.
          if (slow && record.state === 'deciding') {
            slow = false;
            clock += CONSENT_PROOF_TTL_MS;
          }
          writeConsentRecord(dataDir, record, options);
        },
      },
    });
    const x = bash('wolny-zapis', 'echo wolny-zapis > /dev/null');
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(cardOf(h, x)).toEqual(BUTTON);
    slow = true;
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(slow).toBe(false);
    expect(stateOf(h, x)).toEqual({ state: 'pending', cause: null });
    expect(readConsentRecords(h.dir).find((record) => record.key === x.key)?.state).toBe('pending');
    expect(existsSync(answerPath(h, x, '.json'))).toBe(false);
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    expect(h.published.at(-1)).toMatchObject({ permId: x.key, canAllow: false });
  });

  it('`card()` i `cards()` po terminie → bez przycisku; przy `ps`, które rzuca, przegląd plików (`tick`) publikuje'
    + ' urządzeniom `canAllow: false`', async () => {
    const h = await harness();
    const x = bash('widok-po-terminie', 'echo widok-po-terminie > /dev/null');
    hookStarts(h, x);
    const readStartedAt = clock;
    await h.step(waiting(), bashScreen(commandOf(x)));
    expect(h.published.at(-1)).toMatchObject({ permId: x.key, canAllow: true });
    h.liveness = () => Promise.reject(new Error('ps padło'));
    clock = readStartedAt + TICK_MS;
    await expect(h.step(waiting(), bashScreen(commandOf(x)))).rejects.toThrow('ps padło');
    expect(cardOf(h, x)).toEqual(BUTTON);
    clock = readStartedAt + CONSENT_PROOF_TTL_MS;
    expect(h.cycle.card(SESSION, x.key)).toMatchObject({ canAllow: false, unavailable: 'no-proof' });
    expect(h.cycle.cards(SESSION).map((card) => card.canAllow)).toEqual([false]);
    const before = h.published.length;
    await h.cycle.tick();
    expect(h.published.slice(before)).toEqual([expect.objectContaining({ permId: x.key, canAllow: false })]);
    // Następny takt bez zmiany widoku niczego nie publikuje.
    await h.cycle.tick();
    expect(h.published.length).toBe(before + 1);
    expect(await h.cycle.decide(SESSION, x.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(answerPath(h, x, '.json'))).toBe(false);
  });
});

describe('dowód własny bez reguły skrótu wejścia (`transkrypt-skrot`) pod opcją warstwy 1', () => {
  /** Transkrypt z otwartym `tool_use` podanych zrzutów i zamknięciami (skrót wejścia, chwila wpisu). */
  const transcriptOf = (open: readonly HookCallDump[], closed: readonly HookCallDump[] = []): TranscriptToolUses => ({
    open: open.map((dump) => ({ toolName: dump.toolName, input: dump.toolInput })),
    closed: closed.map((dump) => ({ toolName: dump.toolName, inputSha256: dump.inputSha256, closedAt: clock })),
    lostAt: null,
  });
  /** Wejście trybu cienia z tej samej obserwacji: bez opcji warstwy 1, licznik kolejki z ekranu jak w cieniu. */
  const shadowOf = (h: Harness): EvidenceInput => {
    const evidence = h.observation?.evidence;
    if (evidence === undefined) throw new Error('brak obserwacji');
    return { ...evidence, layer1: undefined };
  };
  const shadowVerdict = (h: Harness, dump: HookCallDump): string | undefined => {
    const verdict = standingProofs(shadowOf(h)).find((one) => one.key === dump.key);
    return verdict === undefined ? undefined : verdict.kind === 'brak' ? `brak:${verdict.why}` : verdict.kind;
  };

  it('dwa zrzuty `Bash` o różnych komendach, Y otwarty w transkrypcie, X bez otwartego wpisu, X jedyny pasujący do'
    + ' wierzchu → X ma przycisk i podpisaną zgodę; werdykt cienia bez zmian (`transkrypt-skrot`)', async () => {
    const h = await harness();
    const x = bash('skrot-x', 'echo skrot-x > /dev/null');
    const y = bash('skrot-y', 'echo skrot-y > /dev/null');
    hookStarts(h, x);
    hookStarts(h, y);
    await h.step(waiting(), bashScreen(commandOf(x)), { transcript: transcriptOf([y]) });
    expect(h.observation?.signals.get(x.key)).toBe('standing');
    expect(h.observation?.signals.get(y.key)).toBe('unknown');
    expect(cardOf(h, x)).toEqual(BUTTON);
    expect(cardOf(h, y)).toEqual(NO_BUTTON);
    expect(shadowVerdict(h, x)).toBe('brak:transkrypt-skrot');
    expect(shadowVerdict(h, y)).toBe('stoi');
    await allowSigned(h, x);
  });

  /** Zgoda z telefonu na kartę bez przycisku: odrzucona, bez pliku odpowiedzi. */
  const allowRefused = async (h: Harness, dump: HookCallDump): Promise<void> => {
    expect(await h.cycle.decide(SESSION, dump.key, 'allow'))
      .toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(answerPath(h, dump, '.json'))).toBe(false);
  };

  it('X z własnym zamknięciem w transkrypcie (obok otwartego Y) → bez przycisku, `decide(allow)` odrzucone',
    async () => {
      const h = await harness();
      const x = bash('zamkniety-x', 'echo zamkniety-x > /dev/null');
      const y = bash('zamkniety-y', 'echo zamkniety-y > /dev/null');
      hookStarts(h, x);
      hookStarts(h, y);
      await h.step(waiting(), bashScreen(commandOf(x)), { transcript: transcriptOf([y], [x]) });
      expect(h.observation?.signals.get(x.key)).not.toBe('standing');
      expect(cardOf(h, x)).toEqual(NO_BUTTON);
      await allowRefused(h, x);
    });

  it('`transkrypt-brak` przy `passed` (zero otwartych `tool_use` tej nazwy, zamknięcie X po starcie hooka) → bez'
    + ' przycisku', async () => {
    const h = await harness();
    const x = bash('brak-x', 'echo brak-x > /dev/null');
    hookStarts(h, x);
    await h.step(waiting(), bashScreen(commandOf(x)), { transcript: transcriptOf([], [x]) });
    const evidence = h.observation?.evidence;
    expect(evidence?.layer1.passed(x)).toBe(true);
    expect(evidence === undefined ? null : standingProofs(evidence).find((one) => one.key === x.key))
      .toEqual({ key: x.key, kind: 'brak', why: 'transkrypt-brak' });
    expect(cardOf(h, x)).toEqual(NO_BUTTON);
    await allowRefused(h, x);
  });

  it('karta X bez otwartego wpisu obok otwartego Y nie jest odwołana jako sierota po 5 s od zrzutu: na wierzchu'
    + ' z przyciskiem, pod Y bez przycisku; sieroty cienia bez zmian (`transkrypt-skrot`)', async () => {
    for (const onTop of ['x', 'y'] as const) {
      const h = await harness();
      const x = bash(`sierota-x-${onTop}`, `echo sierota-x-${onTop} > /dev/null`);
      const y = bash(`sierota-y-${onTop}`, `echo sierota-y-${onTop} > /dev/null`);
      hookStarts(h, x);
      hookStarts(h, y);
      const screen = bashScreen(commandOf(onTop === 'x' ? x : y));
      const transcript = transcriptOf([y]);
      await h.step(waiting(), screen, { transcript });
      const until = x.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS + TICK_MS;
      while (clock + TICK_MS <= until) {
        clock += TICK_MS;
        await h.step(waiting(), screen, { transcript });
      }
      expect(clock - x.at).toBeGreaterThanOrEqual(ORPHAN_TRANSCRIPT_MIN_AGE_MS);
      expect(stateOf(h, x)).toEqual({ state: 'pending', cause: null });
      expect(h.observation?.signals.get(x.key)).toBe(onTop === 'x' ? 'standing' : 'unknown');
      expect([cardOf(h, x), cardOf(h, y)]).toEqual(onTop === 'x' ? [BUTTON, NO_BUTTON] : [NO_BUTTON, BUTTON]);
      expect(orphanHooks(shadowOf(h))).toEqual([{ key: x.key, why: 'transkrypt-skrot' }]);
      if (onTop === 'x') await allowSigned(h, x);
    }
  });
});

describe('znane drogi otwarte i koszty dowodu z wierzchu', () => {
  it.todo('droga otwarta (skipped; an exit within a tick closes the request marker, a lasting trace in the hook): pula'
    + ' widzi tylko zrzuty obecne przy odczycie katalogu obserwacji, więc nie ma'
    + ' w niej zrzutu hooka, który wyszedł bez wyniku przed jakąkolwiek obserwacją (odmowa rejestracji, weto, ścieżka'
    + ' błędu w ciągu taktu: dialog zostaje przy biurku), zrzutu zapisanego po odczycie katalogu, choć jego dialog jest'
    + ' już na przeczytanym wierzchu, i zrzutu z przerwy bez obserwacji (`stale` → `re-attached`). Prośba tej samej'
    + ' tożsamości z dowodem własnym dostaje wtedy przycisk do terminu, a decyzja hooka wykonuje ją (ukrytą w kolejce)'
    + ' albo nic (sierota), nie dialog z wierzchu');
  it.todo('koszt znany (skipped): `Edit` bez dowiedzionej sprzeczności ścieżki'
    + ' daje `unknown`, więc dwa wywołania `Edit` tego samego pliku w puli bez wyjścia nie dają dowodu nikomu. W zwykłej'
    + ' pracy: kilka `Edit` jednego pliku po kolei w jednej odpowiedzi modelu; pierwszy kandydat wychodzi z puli dopiero'
    + ' przy rejestrze bez `waiting` co najmniej `REGISTRY_SLACK_MS` po jego zrzucie, a przy stojącym następnym dialogu'
    + ' rejestr mówi `waiting`, więc następne dialogi tego pliku zostają bez przycisku zgody, także po zgodzie z telefonu'
    + ' na pierwszy');
  it.todo('koszt znany (skipped): cykl trzyma do restartu procesu'
    + ' rekord, werdykt i ostatni pełny zrzut każdej karty (`dumps` w `cycle.ts`), także karty w stanie końcowym i po'
    + ' końcu sesji; nic poza restartem ich nie zwalnia');
  it.todo('koszt znany (skipped): przegląd plików (`tick`, co sekundę)'
    + ' publikuje kartę bez przycisku zaraz po terminie dowodu także wtedy, gdy następna obserwacja tylko się spóźnia'
    + ' (`ps` albo odczyt ekranu dłużej niż 500 ms zapasu terminu ponad takt rejestru, np. pod obciążeniem): przycisk'
    + ' znika do następnej obserwacji, a rekord dostaje pole audytu `buttonless` (`no-proof`) jak karta bez przycisku,'
    + ' choć miała go przed terminem i dostaje z powrotem');
});
