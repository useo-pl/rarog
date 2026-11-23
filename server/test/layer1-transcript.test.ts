/**
 * Prośba wątku głównego, której `tool_use` CLI jeszcze nie zapisało w transkrypcie (kanał zgód, warstwa 1).
 *
 * Przy wiadomości z dwoma blokami `tool_use` hook pierwszego startuje, zanim drugi blok dojdzie ze strumienia, a CLI
 * zapisuje wpisy tej wiadomości dopiero razem z wynikami (CLI 2.1.319): przez całe czekanie transkrypt nie ma ani
 * jednego `tool_use` tej wiadomości, rejestr mówi `waiting`, hook żyje, dialog stoi. W warstwie 1 brak prośby
 * w transkrypcie zabiera dowód i daje `gone` dopiero wtedy, gdy transkrypt poszedł dalej niż ta prośba: `tool_use`
 * o tej nazwie i skrócie wejścia zamknięty (wynikiem albo końcem tury) wpisem nie starszym niż start hooka.
 * Until then it is an unknown that gives nothing and takes nothing.
 *
 * The shadow-mode input (without the list of closed `tool_use`) keeps the plain rule and its verdicts.
 *
 * Część pierwsza to czyste funkcje dowodu, druga obserwacja sesji z prawdziwym cyklem (zrzuty na dysku, atrapa `ps`,
 * zegar testu), trzecia czytnik transkryptu. Dalej cykl karmiony prawdziwym followerem: nowym, którego okno ogona
 * zaczyna się w środku pliku (pierwsze podpięcie do długiej rozmowy: zamknięcia sprzed okna liczą się jako utracone),
 * i nowym po powrocie gniazda herdr (`re-attached`: od granicy do pierwszej obserwacji ze znanym transkryptem każdy
 * hook traci dowód, cokolwiek wie nowy follower). Potem utrata dowodu zapisana w cyklu w jedną stronę:
 * klucz, który transkrypt raz minął, i hook sprzed końca okresu nie odzyskują przycisku zgody w żadnym późniejszym
 * odczycie. Dalej: okres powrotu gniazda do pierwszej obserwacji nowego followera, fakt zamknięcia
 * zapisany przed odczytem `ps` i reguła skrótu wejścia bez zrzutów utraconych. Ostatnia część: zrzut
 * z faktem utraty zostaje poza regułami skrótu wejścia, bliźniaków i kolejki także po odwołaniu swojej karty (hook
 * odwołanej karty czeka dalej), a rekordy `sent`, `claimed` i `running` idą za surowym sygnałem.
 *
 * The consent button also needs a single match of a session-pool dump to the screen top and a pool without the start
 * lock. The harness starts the cycle long before the test clock (fixtures carry older timestamps) and lifts the lock
 * with a fresh registry without `waiting`; the step screen is the measured `Bash` dialog with the request's full command
 * frame on top, and the `standingProofs` verdicts (shadow-mode input with this screen's queue counter) are the same.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectSlug } from '../src/cli-store.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_CLAIMED_STANDING_MS, CONSENT_DIRNAME, CONSENT_SECRET_BYTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import { transcriptPassed } from '../src/herdr/dialogs/layer1/proof.ts';
import type { ClosedToolUse, TranscriptToolUses } from '../src/herdr/dialogs/layer1/proof.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import type { ConsentScreenRead } from '../src/herdr/dialogs/layer1/top.ts';
import { queueOnScreen } from '../src/herdr/dialogs/screen/queue.ts';
import {
  ORPHAN_TRANSCRIPT_MIN_AGE_MS, REGISTRY_SLACK_MS, orphanHooks, standingProofs,
} from '../src/herdr/dialogs/shadow/evidence.ts';
import type { EvidenceInput, OpenToolUse, RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { JsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { CLOSED_TOOLS_MAX, createPendingTracker, parseJsonlEntry, transcriptToolUses } from '../src/herdr/jsonl-pending.ts';

const SESSION = '00000000-0000-4000-9000-000000000002';
const PROMPT = '00000000-0000-4000-9000-0000000000bb';
/** Takt obserwacji w serwerze: odczyt rejestru drivera co 1,5 s. */
const TICK_MS = 1_500;
const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const BASH_FIXTURE = readFileSync(join(FIXTURES, 'measured', 'zgoda-bash-2.1.293.txt'), 'utf8');

/**
 * Dialog `Bash` z pomiaru (CLI 2.1.293, bez licznika kolejki) z całą ramką komendy wejścia: wierzch ekranu
 * z tożsamością prośby (`matchTop`).
 */
function bashTop(input: { readonly command: string }): string {
  const lines = BASH_FIXTURE.split('\n');
  const top = lines.findIndex((line) => line.startsWith('╌'));
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith('╌'));
  return [...lines.slice(0, top + 1), ` ${input.command}`, ...lines.slice(bottom)].join('\n');
}

const BASH_A = { command: 'echo s3c-a > /dev/null', description: 'Pierwsze wywołanie' };
const BASH_B = { command: 'echo s3c-b > /dev/null', description: 'Drugie wywołanie' };
const BASH_C = { command: 'echo s3c-c > /dev/null', description: 'Trzecie wywołanie' };
/** Na wierzchu stoi prośba `Bash` A, B albo C. */
const TOP_A = bashTop(BASH_A);
const TOP_B = bashTop(BASH_B);
const TOP_C = bashTop(BASH_C);
/** Dialog planu z pomiaru (nazwa pliku planu w stopce; hook planu dostaje `{}`, więc `matchTop` = `unknown`). */
const PLAN_TOP = readFileSync(join(FIXTURES, 'measured', 'exitplanmode-2.1.293.txt'), 'utf8');

let clock = Date.parse('2026-11-08T12:00:00.000Z');
const now = (): number => clock;
/** Start procesu serwera w harnessie: przed każdą chwilą testów tego pliku. */
const BOOT_AT = Date.parse('2026-10-01T00:00:00.000Z');

const waiting = (at = clock): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at });
const active = (at = clock): RegistryEvidence => ({ kind: 'active', at });

let nextPid = 50_000;

/** Zrzut syntetyczny wątku głównego: hook wystartował 1 s temu, zrzut zapisał 0,9 s temu. */
function syntheticDump(seed: string, toolName: string, toolInput: unknown, over: Partial<HookCallDump> = {}): HookCallDump {
  const nonce = createHash('sha256').update(`${seed}-${nextPid}`).digest('hex').slice(0, 32);
  nextPid += 1;
  return {
    key: `${PROMPT}-${nonce}`, sessionId: SESSION, promptId: PROMPT, pid: nextPid, startedAt: clock - 1_000, toolName,
    toolInput, cwd: '/tmp/projekt', at: clock - 900, inputSha256: canonicalSha256(toolInput), permissionMode: 'default',
    ...over,
  };
}

/** Zamknięty `tool_use` ze skrótem wejścia i chwilą wpisu, który go zamknął. */
const closedTool = (toolName: string, input: unknown, closedAt: number | null): ClosedToolUse => ({
  toolName, inputSha256: canonicalSha256(input), closedAt,
});
const openTool = (toolName: string, input: unknown): OpenToolUse => ({ toolName, input });

// ---------------------------------------------------------------- czyste funkcje dowodu

/** Pamięć zamknięć warstwy 1 w wejściu dowodu: lista zamkniętych i chwila utraty pokrycia. */
interface Closures {
  readonly closed?: readonly ClosedToolUse[];
  readonly lostAt?: number | null;
}

/**
 * Wejście dowodu: żywe hooki, świeży rejestr `waiting`/`permission`, ekran z jednym dialogiem. Podana pamięć zamknięć
 * daje opcję warstwy 1 (`layer1.passed`, bez faktów utraty z cyklu); bez niej wejście trybu cienia.
 */
function evidence(dumps: readonly HookCallDump[], over: Partial<EvidenceInput> & Closures = {}): EvidenceInput {
  const { closed, lostAt, ...rest } = over;
  const layer1 = closed === undefined && lostAt === undefined ? {} : {
    layer1: {
      passed: (dump: HookCallDump) => transcriptPassed({ closed: closed ?? [], lostAt: lostAt ?? null }, dump),
      lost: () => false,
    },
  };
  return {
    now: clock, dumps, alive: new Map(dumps.map((d) => [d.key, true])), registry: waiting(clock - 500),
    queue: { kind: 'single' }, transcript: [], ...layer1, ...rest,
  };
}

const kinds = (input: EvidenceInput): string[] => standingProofs(input)
  .map((v) => (v.kind === 'brak' ? `brak:${v.why}` : v.kind));
const orphans = (input: EvidenceInput): string[] => orphanHooks(input).map((o) => o.why);

describe('dowód warstwy 1: prośba bez `tool_use` w transkrypcie', () => {
  it('transkrypt bez prośby i bez zamkniętego `tool_use` po starcie hooka: dowód z kompletu, bez sieroty po 60 s', () => {
    const dump = syntheticDump('dwa-bloki', 'Bash', BASH_A);
    expect(kinds(evidence([dump], { closed: [] }))).toEqual(['stoi']);
    clock += 60_000;
    expect(kinds(evidence([dump], { closed: [] }))).toEqual(['stoi']);
    expect(orphans(evidence([dump], { closed: [] }))).toEqual([]);
  });

  it('wejście cienia (bez listy zamkniętych): `transkrypt-brak` od razu i sierota po 5 s', () => {
    const dump = syntheticDump('cien', 'Bash', BASH_A);
    expect(kinds(evidence([dump]))).toEqual(['brak:transkrypt-brak']);
    expect(orphans(evidence([dump]))).toEqual([]);
    clock = dump.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    expect(orphans(evidence([dump]))).toEqual(['transkrypt-brak']);
  });

  it('`tool_use` tej prośby zamknięty wynikiem po zrzucie: bez dowodu od razu, sierota po 5 s od zrzutu', () => {
    const dump = syntheticDump('biurko', 'Bash', BASH_A);
    const closed = [closedTool('Bash', BASH_A, dump.at + 200)];
    clock = dump.at + 300;
    expect(kinds(evidence([dump], { closed }))).toEqual(['brak:transkrypt-brak']);
    expect(orphans(evidence([dump], { closed }))).toEqual([]);
    clock = dump.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    expect(orphans(evidence([dump], { closed }))).toEqual(['transkrypt-brak']);
  });

  it('zamknięcie między startem hooka a zapisem zrzutu też liczy się jako „transkrypt poszedł dalej”', () => {
    const dump = syntheticDump('szybkie-biurko', 'Bash', BASH_A);
    expect(kinds(evidence([dump], { closed: [closedTool('Bash', BASH_A, dump.startedAt)] }))).toEqual(['brak:transkrypt-brak']);
  });

  it.each<[string, (dump: HookCallDump) => ClosedToolUse]>([
    ['to samo wywołanie zamknięte przed startem hooka (poprzednie identyczne)', (d) => closedTool('Bash', BASH_A, d.startedAt - 1)],
    ['inne wejście tej nazwy zamknięte po starcie hooka', (d) => closedTool('Bash', BASH_B, d.at + 100)],
    ['inna nazwa z tym samym wejściem zamknięta po starcie hooka', (d) => closedTool('Read', BASH_A, d.at + 100)],
    ['zamknięcie bez chwili wpisu', () => closedTool('Bash', BASH_A, null)],
  ])('%s: niewiadoma, dowód z kompletu', (_name, close) => {
    const dump = syntheticDump('niewiadoma', 'Bash', BASH_A);
    clock = dump.at + 10_000;
    const input = evidence([dump], { closed: [close(dump)] });
    expect(kinds(input)).toEqual(['stoi']);
    expect(orphans(input)).toEqual([]);
  });

  it('otwarty `tool_use` tej prośby: lista zamkniętych niczego nie zmienia', () => {
    const dump = syntheticDump('otwarty', 'Bash', BASH_A);
    const input = evidence([dump], { transcript: [openTool('Bash', BASH_A)] });
    expect(kinds(input)).toEqual(['stoi']);
    expect(kinds(evidence([dump], { transcript: [openTool('Bash', BASH_A)], closed: [closedTool('Bash', BASH_A, dump.startedAt - 5)] })))
      .toEqual(['stoi']);
  });

  it('sygnały negatywne zostają: rejestr bez `waiting` po zapasie, licznik kolejki, bliźniaki, hook martwy', () => {
    const a = syntheticDump('neg-a', 'Bash', BASH_A);
    const b = syntheticDump('neg-b', 'Bash', BASH_B);
    const twin = syntheticDump('neg-twin', 'Bash', BASH_A);
    clock = a.at + REGISTRY_SLACK_MS + 100;
    expect(kinds(evidence([a], { closed: [], registry: active(clock) }))).toEqual(['brak:rejestr-nie-czeka']);
    expect(orphans(evidence([a], { closed: [], registry: active(clock) }))).toEqual(['rejestr-nie-czeka']);
    expect(kinds(evidence([a, b], { closed: [] }))).toEqual(['brak:kolejka', 'brak:kolejka']);
    expect(kinds(evidence([a, twin], { closed: [], queue: { kind: 'unknown' } }))).toEqual(['niejednoznaczny', 'niejednoznaczny']);
    expect(orphans(evidence([a, twin], { closed: [], queue: { kind: 'unknown' } }))).toEqual([]);
    expect(kinds(evidence([a], { closed: [], alive: new Map([[a.key, false]]) }))).toEqual(['brak:hook-martwy']);
    expect(kinds(evidence([a], { closed: [], registry: { kind: 'unknown', why: 'unread' } }))).toEqual(['brak:rejestr-nieznany']);
  });

  it('transkrypt nieznany: lista zamkniętych bez znaczenia, dowód z kompletu', () => {
    const dump = syntheticDump('nieznany', 'Bash', BASH_A);
    const closed = [closedTool('Bash', BASH_A, dump.at + 100)];
    expect(kinds(evidence([dump], { transcript: null, closed }))).toEqual(['stoi']);
    expect(kinds(evidence([dump], { transcript: null }))).toEqual(['stoi']);
  });

  it('wejście cienia: werdykty i sieroty bez zmian w przypadkach z otwartym odpowiednikiem, skrótem i bliźniakami', () => {
    const a = syntheticDump('cien-a', 'Bash', BASH_A);
    const b = syntheticDump('cien-b', 'Bash', BASH_B);
    const twin = syntheticDump('cien-twin', 'Bash', BASH_A, { at: a.at + 50 });
    clock = a.at + 10_000;
    const cases: readonly [EvidenceInput, readonly string[], readonly string[]][] = [
      [evidence([a], { transcript: [openTool('Bash', BASH_A)] }), ['stoi'], []],
      [evidence([a, b], { transcript: [openTool('Bash', BASH_A)], queue: { kind: 'unknown' } }),
        ['stoi', 'brak:transkrypt-skrot'], ['transkrypt-skrot']],
      [evidence([a, twin], { transcript: [openTool('Bash', BASH_A)], queue: { kind: 'unknown' } }),
        ['niejednoznaczny', 'niejednoznaczny'], ['transkrypt-nadmiar']],
      [evidence([a], { transcript: [openTool('Read', { file_path: '/x' })] }), ['brak:transkrypt-brak'], ['transkrypt-brak']],
      [evidence([a], { transcript: [] }), ['brak:transkrypt-brak'], ['transkrypt-brak']],
      [evidence([a], { transcript: null }), ['stoi'], []],
    ];
    for (const [input, verdicts, orphanWhy] of cases) {
      expect(kinds(input)).toEqual(verdicts);
      expect(orphans(input)).toEqual(orphanWhy);
    }
  });
});

// ---------------------------------------------------------------- obserwacja sesji z prawdziwym cyklem

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly life: Map<number, boolean | null>;
  /** Atrapa `ps` harnessu (życie z {@link life}). */
  readonly liveness: ProcessLiveness;
  /** Werdykt `standingProofs` per klucz z wejścia ostatniego kroku obserwacji. */
  readonly verdicts: Map<string, string>;
  /** Krok obserwacji; ekran przeczytany w tej obserwacji z chwilą rozpoczęcia odczytu = teraz (`null` = bez odczytu). */
  step(registry: RegistryEvidence, transcript: TranscriptToolUses | null, screen?: string | null): Promise<void>;
}

/** Odczyt ekranu obserwacji, który zaczął się teraz. */
const screenRead = (text: string): ConsentScreenRead => ({ text, readStartedAt: clock });

/**
 * Cykl jak w serwerze. Proces wstał w {@link BOOT_AT}, a blokadę startu zdjął rejestr bez `waiting`
 * `REGISTRY_SLACK_MS` po starcie.
 */
async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-transkrypt-'));
  dirs.push(dir);
  const reg = createConsentRegistry({ bootId: 'boot-tx', send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope('main');
  const started = clock;
  clock = BOOT_AT;
  const cycle = createConsentCycle({ dataDir: dir, bootId: 'boot-tx', registry: reg, now });
  clock = started;
  const life = new Map<number, boolean | null>();
  const liveness: ProcessLiveness = async (processes) => new Map(processes.map((p) => [p.pid, life.get(p.pid) ?? null]));
  const verdicts = new Map<string, string>();
  const unlockAt = BOOT_AT + REGISTRY_SLACK_MS;
  await observeConsentSession(cycle, {
    dataDir: dir, sessionId: SESSION, liveness, registry: active(unlockAt), transcript: null, screen: null, now: () => unlockAt,
  });
  return {
    dir, reg, cycle, life, liveness, verdicts,
    step: async (registry, transcript, screen = null) => {
      await observeConsentSession(cycle, {
        dataDir: dir, sessionId: SESSION, liveness, registry, transcript, screen: screen === null ? null : screenRead(screen),
        now,
      }, (observation) => {
        verdicts.clear();
        for (const v of standingProofs(observation.evidence)) verdicts.set(v.key, v.kind === 'brak' ? `brak:${v.why}` : v.kind);
      });
    },
  };
}

const dumpPath = (dir: string, key: string): string => join(dir, HOOK_PENDING_DIRNAME, SESSION, `${key}.json`);
const answerPath = (dir: string, key: string, suffix: string): string => join(dir, CONSENT_DIRNAME, SESSION, `${key}${suffix}`);

/** Hook startuje: zrzut na dysku, proces żywy, rejestracja sekretu przyjęta. */
function hookStarts(h: Harness, dump: HookCallDump): void {
  mkdirSync(dirname(dumpPath(h.dir, dump.key)), { recursive: true, mode: 0o700 });
  writeFileSync(dumpPath(h.dir, dump.key), JSON.stringify(dump), { mode: 0o600 });
  h.life.set(dump.pid, true);
  const cardSha256 = consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
  });
  expect(h.reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
    inputSha256: dump.inputSha256, cardSha256, pid: dump.pid, startedAt: dump.startedAt,
  }).status).toBe(200);
}

const cardOf = (h: Harness, key: string): unknown => {
  const card = h.cycle.card(SESSION, key);
  return card === null ? null : { state: card.state, canAllow: card.canAllow };
};
const stateOf = (h: Harness, key: string): unknown => {
  const record = h.cycle.record(SESSION, key);
  return record === null ? null : { state: record.state, cause: record.cause };
};

/** Takty co {@link TICK_MS} do `until` (włącznie); karta po każdym takcie. */
async function ticksUntil(
  h: Harness, key: string, until: number, transcript: TranscriptToolUses | null, screen: string | null = null,
): Promise<unknown[]> {
  const seen: unknown[] = [];
  while (clock + TICK_MS <= until) {
    clock += TICK_MS;
    await h.step(waiting(), transcript, screen);
    seen.push(cardOf(h, key));
  }
  return seen;
}

/** Transkrypt po wpisie prośby człowieka: żadnego `tool_use` tej wiadomości, w historii wcześniejsze wywołanie. */
const beforeWrite = (): TranscriptToolUses => ({
  open: [], closed: [closedTool('Bash', { command: 'echo wcześniej' }, clock - 8_000)], lostAt: null,
});

describe('karta warstwy 1: hook pierwszego bloku przed zapisem `tool_use`', () => {
  it('dwa `tool_use` w jednej wiadomości, żywy hook, świeży rejestr `waiting`/`permission`, jeden zrzut: karta'
    + ' `pending` z przyciskiem od pierwszego taktu, po 5 s i po 60 s dalej; zgoda → `sent` → `claimed`', async () => {
    const h = await harness();
    const dump = syntheticDump('dwa-bloki', 'Bash', BASH_A);
    hookStarts(h, dump);
    const transcript = beforeWrite();
    await h.step(waiting(), transcript, TOP_A);
    expect(cardOf(h, dump.key)).toEqual({ state: 'pending', canAllow: true });
    const seen = await ticksUntil(h, dump.key, dump.at + 60_000, transcript, TOP_A);
    expect(seen.length).toBeGreaterThan(30);
    expect(seen).toEqual(seen.map(() => ({ state: 'pending', canAllow: true })));
    expect(clock - dump.at).toBeGreaterThanOrEqual(60_000 - TICK_MS);
    expect(stateOf(h, dump.key)).toEqual({ state: 'pending', cause: null });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    renameSync(answerPath(h.dir, dump.key, '.json'), answerPath(h.dir, dump.key, '.claimed'));
    await h.cycle.tick();
    expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
  });

  it('transkrypt dopisuje potem otwarty `tool_use` tej prośby (i drugiego bloku): bez zmian', async () => {
    const h = await harness();
    const dump = syntheticDump('dopisany', 'Bash', BASH_A);
    hookStarts(h, dump);
    await h.step(waiting(), beforeWrite(), TOP_A);
    expect(cardOf(h, dump.key)).toEqual({ state: 'pending', canAllow: true });
    clock += 7_000;
    const written: TranscriptToolUses = {
      open: [openTool('Bash', BASH_A), openTool('Bash', BASH_B)], closed: beforeWrite().closed, lostAt: null,
    };
    const seen = await ticksUntil(h, dump.key, clock + 6_000, written, TOP_A);
    expect(seen).toEqual(seen.map(() => ({ state: 'pending', canAllow: true })));
  });

  it('hook żywy po decyzji przy biurku: `tool_use` tej prośby z wynikiem po zrzucie, rejestr `waiting` dla następnego'
    + ' dialogu → bez przycisku, `revoked: dialog-gone`', async () => {
    const h = await harness();
    const dump = syntheticDump('biurko', 'Bash', BASH_A);
    hookStarts(h, dump);
    await h.step(waiting(), { open: [openTool('Bash', BASH_A)], closed: [], lostAt: null }, TOP_A);
    expect(cardOf(h, dump.key)).toEqual({ state: 'pending', canAllow: true });
    clock = dump.at + 2_000;
    const decided: TranscriptToolUses = { open: [], closed: [closedTool('Bash', BASH_A, clock - 300)], lostAt: null };
    await h.step(waiting(), decided, TOP_A);
    expect(cardOf(h, dump.key)).toEqual({ state: 'pending', canAllow: false });
    clock = dump.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), decided, TOP_A);
    expect(stateOf(h, dump.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
  });

  it('rejestr bez `waiting` po zapasie przy prośbie bez `tool_use` → `revoked: dialog-gone`', async () => {
    const h = await harness();
    const dump = syntheticDump('rejestr', 'Bash', BASH_A);
    hookStarts(h, dump);
    await h.step(waiting(), beforeWrite(), TOP_A);
    clock = dump.at + REGISTRY_SLACK_MS + 100;
    await h.step(active(), beforeWrite(), TOP_A);
    expect(stateOf(h, dump.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
  });

  it('licznik kolejki niższy od liczby zrzutów nie zabiera dowodu w warstwie 1: na wierzchu A → przycisk'
    + ' tylko A przez 60 s, B bez przycisku; werdykt cienia `kolejka` bez zmian', async () => {
    const h = await harness();
    const a = syntheticDump('kolejka-a', 'Bash', BASH_A);
    const b = syntheticDump('kolejka-b', 'Bash', BASH_B);
    hookStarts(h, a);
    hookStarts(h, b);
    expect(queueOnScreen(TOP_A)).toEqual({ kind: 'single' });
    await h.step(waiting(), beforeWrite(), TOP_A);
    expect([h.verdicts.get(a.key), h.verdicts.get(b.key)]).toEqual(['brak:kolejka', 'brak:kolejka']);
    expect([cardOf(h, a.key), cardOf(h, b.key)]).toEqual([
      { state: 'pending', canAllow: true }, { state: 'pending', canAllow: false },
    ]);
    const seen = await ticksUntil(h, a.key, a.at + 60_000, beforeWrite(), TOP_A);
    expect(seen).toEqual(seen.map(() => ({ state: 'pending', canAllow: true })));
    expect(cardOf(h, b.key)).toEqual({ state: 'pending', canAllow: false });
  });

  it('bliźniaki (ta sama nazwa i wejście, żaden w transkrypcie): bez przycisku i bez zdjęcia przez 60 s', async () => {
    const h = await harness();
    const a = syntheticDump('blizniak-a', 'Bash', BASH_A);
    const b = syntheticDump('blizniak-b', 'Bash', BASH_A);
    hookStarts(h, a);
    hookStarts(h, b);
    // Na wierzchu ramka tej komendy: pasują oba zrzuty, więc żaden nie jest jedynym dopasowaniem.
    await h.step(waiting(), beforeWrite(), TOP_A);
    const seen = await ticksUntil(h, a.key, a.at + 60_000, beforeWrite(), TOP_A);
    expect(seen).toEqual(seen.map(() => ({ state: 'pending', canAllow: false })));
    expect(cardOf(h, b.key)).toEqual({ state: 'pending', canAllow: false });
  });

  it('transkrypt nieznany: przycisk z kompletu i bez zdjęcia', async () => {
    const h = await harness();
    const dump = syntheticDump('nieznany', 'Bash', BASH_A);
    hookStarts(h, dump);
    await h.step(waiting(), null, TOP_A);
    expect(cardOf(h, dump.key)).toEqual({ state: 'pending', canAllow: true });
    const seen = await ticksUntil(h, dump.key, dump.at + 10_000, null, TOP_A);
    expect(seen).toEqual(seen.map(() => ({ state: 'pending', canAllow: true })));
  });
});

// ---------------------------------------------------------------- czytnik transkryptu

const TS = (ms: number): string => new Date(ms).toISOString();
const userLine = (text: string, at: number): string => JSON.stringify({
  type: 'user', message: { role: 'user', content: text }, isSidechain: false, timestamp: TS(at),
});
const toolUseLine = (id: string, name: string, input: unknown, at: number): string => JSON.stringify({
  type: 'assistant', isSidechain: false, timestamp: TS(at),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResultLine = (id: string, at: number): string => JSON.stringify({
  type: 'user', isSidechain: false, timestamp: TS(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});

describe('czytnik transkryptu: zamknięte `tool_use` z chwilą wpisu zamykającego', () => {
  const T0 = Date.parse('2026-11-08T06:50:21.384Z');

  it('wynik zamyka wywołanie z chwilą wpisu wyniku; wypowiedź człowieka zamyka resztę ze swoją chwilą', () => {
    const lines = [
      userLine('dwa razy Bash', T0),
      toolUseLine('toolu_a', 'Bash', BASH_A, T0 + 1_452),
      toolUseLine('toolu_b', 'Bash', BASH_B, T0 + 1_653),
      toolResultLine('toolu_a', T0 + 94_817),
      userLine('[Request interrupted by user for tool use]', T0 + 94_818),
    ];
    expect(transcriptToolUses(lines.slice(0, 1))).toEqual({ open: [], closed: [], lostAt: null });
    const written = transcriptToolUses(lines.slice(0, 3));
    expect(written.open.map((t) => t.id)).toEqual(['toolu_a', 'toolu_b']);
    expect(written.closed).toEqual([]);
    expect(transcriptToolUses(lines)).toEqual({
      open: [],
      closed: [
        { id: 'toolu_a', toolName: 'Bash', inputSha256: canonicalSha256(BASH_A), closedAt: T0 + 94_817 },
        { id: 'toolu_b', toolName: 'Bash', inputSha256: canonicalSha256(BASH_B), closedAt: T0 + 94_818 },
      ],
      lostAt: null,
    });
  });

  it('wynik bez znanego `tool_use` i wpis bez chwili: bez zamkniętego albo z `closedAt: null`', () => {
    const tracker = createPendingTracker();
    tracker.note(parseJsonlEntry(toolResultLine('toolu_obcy', T0)));
    expect(tracker.closed).toEqual([]);
    tracker.note(parseJsonlEntry(toolUseLine('toolu_c', 'Read', { file_path: '/x' }, T0)));
    tracker.note({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c' }] } });
    expect(tracker.closed).toEqual([
      { id: 'toolu_c', toolName: 'Read', inputSha256: canonicalSha256({ file_path: '/x' }), closedAt: null },
    ]);
  });

  it(`lista zamkniętych trzyma ostatnie ${String(CLOSED_TOOLS_MAX)} wywołań`, () => {
    const tracker = createPendingTracker();
    for (let i = 0; i < CLOSED_TOOLS_MAX + 5; i += 1) {
      tracker.note(parseJsonlEntry(toolUseLine(`toolu_${String(i)}`, 'Bash', { command: `echo ${String(i)}` }, T0 + i)));
      tracker.note(parseJsonlEntry(toolResultLine(`toolu_${String(i)}`, T0 + i + 1)));
    }
    expect(tracker.closed).toHaveLength(CLOSED_TOOLS_MAX);
    expect(tracker.closed[0]?.id).toBe('toolu_5');
    expect(tracker.closed.at(-1)?.id).toBe(`toolu_${String(CLOSED_TOOLS_MAX + 4)}`);
  });

  it('pamięć zamknięć trzyma skrót wejścia, nazwę i chwilę, bez pełnego wejścia', () => {
    const tracker = trackerOf([toolUseLine('toolu_w', 'Write', WRITE_INPUT, T0), toolResultLine('toolu_w', T0 + 10)]);
    expect(tracker.closed).toEqual([
      { id: 'toolu_w', toolName: 'Write', inputSha256: canonicalSha256(WRITE_INPUT), closedAt: T0 + 10 },
    ]);
    expect(JSON.stringify(tracker.closed)).not.toContain(WRITE_INPUT.content);
  });

  it('wyparcie ponad limit przesuwa chwilę utraty pokrycia na najpóźniejsze wyparte zamknięcie', () => {
    const lines: string[] = [];
    for (let i = 0; i < CLOSED_TOOLS_MAX + 3; i += 1) {
      lines.push(toolUseLine(`toolu_${String(i)}`, 'Read', { file_path: `/x/${String(i)}` }, T0 + 10 * i));
      lines.push(toolResultLine(`toolu_${String(i)}`, T0 + 10 * i + 5));
    }
    expect(trackerOf(lines.slice(0, 2 * CLOSED_TOOLS_MAX)).lostAt).toBeNull();
    expect(trackerOf(lines).lostAt).toBe(T0 + 25);
  });

  it('wynik bez znanego `tool_use` przesuwa chwilę utraty pokrycia; powtórny wynik i wynik bez chwili nie', () => {
    const tracker = createPendingTracker();
    tracker.note(parseJsonlEntry(toolUseLine('toolu_a', 'Bash', BASH_A, T0)));
    tracker.note(parseJsonlEntry(toolResultLine('toolu_a', T0 + 10)));
    tracker.note(parseJsonlEntry(toolResultLine('toolu_a', T0 + 900)));
    expect(tracker.lostAt).toBeNull();
    tracker.note({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bez_chwili' }] } });
    expect(tracker.lostAt).toBeNull();
    tracker.note(parseJsonlEntry(toolResultLine('toolu_sprzed_okna', T0 + 50)));
    expect(tracker.lostAt).toBe(T0 + 50);
    tracker.note(parseJsonlEntry(toolResultLine('toolu_starszy', T0 + 20)));
    expect(tracker.lostAt).toBe(T0 + 50);
    tracker.lose(T0 + 70);
    tracker.lose(T0 + 60);
    expect(tracker.lostAt).toBe(T0 + 70);
    expect(tracker.closed.map((tool) => tool.id)).toEqual(['toolu_a']);
  });
});

describe('dowód warstwy 1: kiedy transkrypt poszedł dalej niż prośba', () => {
  const PLAN = { plan: 'Plan: nic nie robić.' };

  it('`ExitPlanMode` zamyka sama nazwa (CLI zmienia wejście), inne narzędzie tylko nazwa i skrót', () => {
    const plan = syntheticDump('p', 'ExitPlanMode', {});
    const bash = syntheticDump('b', 'Bash', BASH_A);
    const after = (tool: string, input: unknown, d: HookCallDump): ClosedToolUse => closedTool(tool, input, d.startedAt + 10);
    expect(transcriptPassed({ closed: [after('ExitPlanMode', PLAN, plan)], lostAt: null }, plan)).toBe(true);
    expect(transcriptPassed({ closed: [closedTool('ExitPlanMode', PLAN, plan.startedAt - 1)], lostAt: null }, plan))
      .toBe(false);
    expect(transcriptPassed({ closed: [closedTool('ExitPlanMode', PLAN, null)], lostAt: null }, plan)).toBe(false);
    expect(transcriptPassed({ closed: [after('Bash', BASH_B, bash)], lostAt: null }, bash)).toBe(false);
    expect(transcriptPassed({ closed: [after('Bash', BASH_A, bash)], lostAt: null }, bash)).toBe(true);
  });

  it('zamknięcie tej nazwy bez skrótu po starcie hooka liczy się jako zamknięcie prośby', () => {
    const bash = syntheticDump('bez-skrotu', 'Bash', BASH_A);
    const closed: ClosedToolUse[] = [{ toolName: 'Bash', inputSha256: null, closedAt: bash.startedAt + 5 }];
    expect(transcriptPassed({ closed, lostAt: null }, bash)).toBe(true);
  });

  it('utrata pokrycia z chwilą nie starszą niż start hooka zabiera dowód, starsza nie', () => {
    const bash = syntheticDump('pokrycie', 'Bash', BASH_A);
    expect(transcriptPassed({ closed: [], lostAt: bash.startedAt }, bash)).toBe(true);
    expect(transcriptPassed({ closed: [], lostAt: bash.startedAt - 1 }, bash)).toBe(false);
    expect(kinds(evidence([bash], { closed: [], lostAt: bash.startedAt + 100 }))).toEqual(['brak:transkrypt-brak']);
    expect(kinds(evidence([bash], { closed: [], lostAt: bash.startedAt - 100 }))).toEqual(['stoi']);
  });
});

// ---------------------------------------------------------------- zamknięcie rozpoznane i zapamiętane

/** Plan zatwierdzony hookiem (CLI 2.1.314): hook dostaje `{}`, wpis `tool_use` niesie `{plan: …}`. */
const PLAN_LINES = readFileSync(join(import.meta.dirname, 'fixtures', 'consent-dowod', 'exitplanmode.jsonl'), 'utf8')
  .split('\n').filter(Boolean);
/** Chwila wpisu `tool_use` planu i wpisu jego wyniku w fixturze. */
const PLAN_TOOL_USE_AT = Date.parse('2026-10-30T14:28:52.954Z');
const PLAN_RESULT_AT = Date.parse('2026-10-30T14:28:54.874Z');
const WRITE_INPUT = { file_path: '/tmp/projekt/nowy.txt', content: 'treść' };

/** Tracker followera skarmiony liniami; wejście obserwacji z jego otwartych i zapamiętanych zamknięć. */
function trackerOf(lines: readonly string[]): ReturnType<typeof createPendingTracker> {
  const tracker = createPendingTracker();
  for (const line of lines) tracker.note(parseJsonlEntry(line));
  return tracker;
}
const sourcesOf = (tracker: ReturnType<typeof createPendingTracker>): TranscriptToolUses => ({
  open: [...tracker.open], closed: [...tracker.closed], lostAt: tracker.lostAt,
});

describe('karta warstwy 1: zamknięcie prośby rozpoznane po nazwie i zapamiętane bez utraty pokrycia', () => {
  it('`ExitPlanMode` rozstrzygnięty przy biurku (hook `{}`, wpis `{plan: …}` zamknięty po starcie hooka), stary hook'
    + ' żywy, nowy zrzut `Bash` z otwartym `tool_use`, kolejka `single` → plan bez dowodu, `Bash` stoi z przyciskiem',
  async () => {
    const h = await harness();
    clock = PLAN_RESULT_AT + 600;
    const plan = syntheticDump('plan-biurko', 'ExitPlanMode', {}, {
      startedAt: PLAN_TOOL_USE_AT + 40, at: PLAN_TOOL_USE_AT + 120, permissionMode: 'plan',
    });
    const bash = syntheticDump('po-planie', 'Bash', BASH_A, { startedAt: clock - 200, at: clock - 150 });
    hookStarts(h, plan);
    hookStarts(h, bash);
    const tracker = trackerOf([...PLAN_LINES.slice(0, 5), toolUseLine('toolu_po_planie', 'Bash', BASH_A, clock - 300)]);
    await h.step(waiting(), sourcesOf(tracker), TOP_A);
    expect([h.verdicts.get(plan.key), h.verdicts.get(bash.key)]).toEqual(['brak:transkrypt-brak', 'stoi']);
    expect([cardOf(h, plan.key), cardOf(h, bash.key)]).toEqual([
      { state: 'pending', canAllow: false }, { state: 'pending', canAllow: true },
    ]);
    clock = plan.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS + TICK_MS;
    await h.step(waiting(), sourcesOf(tracker), TOP_A);
    expect(stateOf(h, plan.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
    expect(cardOf(h, bash.key)).toEqual({ state: 'pending', canAllow: true });
  });

  it('plan przed zapisem w transkrypcie (brak wpisu, żywy hook, rejestr `waiting`) → dowód z kompletu przez 60 s', async () => {
    const h = await harness();
    clock = PLAN_TOOL_USE_AT + 500;
    const plan = syntheticDump('plan-przed', 'ExitPlanMode', {}, {
      startedAt: PLAN_TOOL_USE_AT - 60, at: PLAN_TOOL_USE_AT - 20, permissionMode: 'plan',
    });
    hookStarts(h, plan);
    const transcript = sourcesOf(trackerOf(PLAN_LINES.slice(0, 3)));
    expect(transcript.closed).toHaveLength(1);
    await h.step(waiting(), transcript, PLAN_TOP);
    expect(h.verdicts.get(plan.key)).toBe('stoi');
    // Hook planu dostaje `{}`: karta bez treści nie ma przycisku z innego powodu niż dowód, ale nie schodzi.
    expect(h.cycle.card(SESSION, plan.key)?.unavailable).toBe('no-content');
    const seen = await ticksUntil(h, plan.key, plan.at + 60_000, transcript, PLAN_TOP);
    expect(seen).toEqual(seen.map(() => ({ state: 'pending', canAllow: false })));
    expect(h.verdicts.get(plan.key)).toBe('stoi');
    expect(h.cycle.card(SESSION, plan.key)?.unavailable).toBe('no-content');
  });

  it('wynik prośby przy biurku wyparty z pamięci przez kolejne zamknięcia przed upływem 5 s → karta nie odzyskuje'
    + ' przycisku, `decide(allow)` nie daje `sent`, następna karta nie dostaje `brak:kolejka` przez starego hooka',
  async () => {
    const h = await harness();
    const lines = [userLine('zbuduj', clock - 3_000), toolUseLine('toolu_biurko', 'Bash', BASH_A, clock - 2_000)];
    const old = syntheticDump('wyparty', 'Bash', BASH_A, { startedAt: clock - 1_900, at: clock - 1_800 });
    hookStarts(h, old);
    await h.step(waiting(), sourcesOf(trackerOf(lines)), TOP_A);
    expect(cardOf(h, old.key)).toEqual({ state: 'pending', canAllow: true });
    // Decyzja przy biurku: wynik tej prośby w transkrypcie, hook dalej żyje.
    clock += 500;
    lines.push(toolResultLine('toolu_biurko', clock - 100));
    await h.step(waiting(), sourcesOf(trackerOf(lines)), TOP_A);
    expect(cardOf(h, old.key)).toEqual({ state: 'pending', canAllow: false });
    // Agent pracuje dalej: seria wyników, która wypiera zamknięcie prośby z pamięci trackera.
    clock += 1_000;
    for (let i = 0; i < CLOSED_TOOLS_MAX; i += 1) {
      lines.push(toolUseLine(`toolu_read_${String(i)}`, 'Read', { file_path: `/tmp/projekt/${String(i)}.txt` }, clock - 60));
      lines.push(toolResultLine(`toolu_read_${String(i)}`, clock - 50));
    }
    const tracker = trackerOf(lines);
    expect(tracker.closed.some((tool) => tool.id === 'toolu_biurko')).toBe(false);
    await h.step(waiting(), sourcesOf(tracker), TOP_A);
    expect(h.verdicts.get(old.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, old.key)).toEqual({ state: 'pending', canAllow: false });
    expect(await h.cycle.decide(SESSION, old.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    // Następna prośba (`Bash` B na wierzchu) z otwartym `tool_use`: stary hook nie zabiera jej przycisku ani licznikiem
    // kolejki, ani w puli (inna komenda = `no`).
    clock += 200;
    lines.push(toolUseLine('toolu_nastepna', 'Bash', BASH_B, clock - 150));
    const next = syntheticDump('nastepna', 'Bash', BASH_B, { startedAt: clock - 100, at: clock - 50 });
    hookStarts(h, next);
    await h.step(waiting(), sourcesOf(trackerOf(lines)), TOP_B);
    expect([h.verdicts.get(old.key), h.verdicts.get(next.key)]).toEqual(['brak:transkrypt-brak', 'stoi']);
    expect([cardOf(h, old.key), cardOf(h, next.key)]).toEqual([
      { state: 'pending', canAllow: false }, { state: 'pending', canAllow: true },
    ]);
    expect(clock - old.at).toBeLessThan(ORPHAN_TRANSCRIPT_MIN_AGE_MS);
    clock = old.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), sourcesOf(trackerOf(lines)), TOP_B);
    expect(stateOf(h, old.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
    expect(cardOf(h, next.key)).toEqual({ state: 'pending', canAllow: true });
  });

  it('dwa żywe zrzuty `ExitPlanMode` i jedno zamknięcie planu po starcie obu → oba bez dowodu i oba zdjęte po 5 s',
    async () => {
      const h = await harness();
      clock = PLAN_RESULT_AT + 400;
      const first = syntheticDump('plan-1', 'ExitPlanMode', {}, {
        startedAt: PLAN_TOOL_USE_AT - 1_100, at: PLAN_TOOL_USE_AT - 1_000, permissionMode: 'plan',
      });
      const second = syntheticDump('plan-2', 'ExitPlanMode', {}, {
        startedAt: PLAN_TOOL_USE_AT + 40, at: PLAN_TOOL_USE_AT + 120, permissionMode: 'plan',
      });
      hookStarts(h, first);
      hookStarts(h, second);
      const transcript = sourcesOf(trackerOf(PLAN_LINES.slice(0, 5)));
      await h.step(waiting(), transcript);
      expect([h.verdicts.get(first.key), h.verdicts.get(second.key)]).toEqual([
        'brak:transkrypt-brak', 'brak:transkrypt-brak',
      ]);
      expect([cardOf(h, first.key), cardOf(h, second.key)]).toEqual([
        { state: 'pending', canAllow: false }, { state: 'pending', canAllow: false },
      ]);
      clock = second.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
      await h.step(waiting(), transcript);
      expect([stateOf(h, first.key), stateOf(h, second.key)]).toEqual([
        { state: 'revoked', cause: 'dialog-gone' }, { state: 'revoked', cause: 'dialog-gone' },
      ]);
    });
});

// ---------------------------------------------------------------- nowy follower z oknem ogona w środku pliku

const FOLLOW_CWD = '/Users/u/Projects/pokrycie';
const FOLLOW_TIMING = { batchMs: 15, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };
const followers: JsonlFollower[] = [];
afterEach(() => {
  for (const follower of followers.splice(0)) follower.close();
});

const assistantTextLine = (text: string, at: number): string => JSON.stringify({
  type: 'assistant', isSidechain: false, timestamp: TS(at), message: { role: 'assistant', content: [{ type: 'text', text }] },
});
/** Długi wpis spoza rozmowy: okno ogona nowego followera zaczyna się w jego środku. */
const fillerLine = (at: number): string => JSON.stringify({
  type: 'system', subtype: 'informational', isSidechain: false, timestamp: TS(at), content: 'x'.repeat(2_000),
});

/** Plik transkryptu sesji w magazynie CLI testu (katalog sprząta `afterEach` harnessu). */
function transcriptFile(h: Harness, lines: readonly string[]): string {
  const dir = join(h.dir, 'store', projectSlug(FOLLOW_CWD));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(`${path}.partial`, lines.map((l) => `${l}\n`).join(''));
  renameSync(`${path}.partial`, path);
  return path;
}

/**
 * Follower na pliku harnessu. Z `window` (liczba końcowych linii) okno ogona kończy się w środku wypełniacza przed nimi,
 * jak przy pierwszym podpięciu do długiej rozmowy: pierwszy pełny wpis okna to pierwsza z tych linii.
 */
async function follow(h: Harness, lines: readonly string[], window?: number): Promise<JsonlFollower> {
  transcriptFile(h, lines);
  const bytes = window === undefined ? undefined : lines.slice(-window).reduce((sum, l) => sum + Buffer.byteLength(l) + 1, 1_000);
  const follower = createJsonlFollower({
    cwd: FOLLOW_CWD, agentSessionId: SESSION, root: join(h.dir, 'store'), watch: false, timing: FOLLOW_TIMING, now,
    ...(bytes === undefined ? {} : { historyBytes: bytes, historyMaxBytes: bytes, historyMessages: 1_000 }),
  });
  followers.push(follower);
  const deadline = Date.now() + 10_000;
  while (follower.closedToolUses?.() === null) {
    if (Date.now() > deadline) throw new Error('timeout: pierwszy odczyt');
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  return follower;
}

/** Wejście obserwacji z followera, złożone tak jak w driverze (`#consentObserveStep`). */
function sourcesOfFollower(follower: JsonlFollower): TranscriptToolUses | null {
  const open = follower.openToolUses?.() ?? null;
  const closures = follower.closedToolUses?.() ?? null;
  return open === null ? null : { open, closed: closures?.closed ?? [], lostAt: closures === null ? clock : closures.lostAt };
}

describe('karta warstwy 1: nowy follower bez zamknięć sprzed okna ogona', () => {
  it('`tool_use` i wynik prośby rozstrzygniętej przy biurku przed oknem nowego followera, hook żywy, przed upływem 5 s'
    + ' → przycisk nie wraca, `decide(allow)` nie daje `sent`, następna karta nie dostaje `brak:kolejka`', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T13:00:00.000Z');
    const lines = [
      userLine('zbuduj', clock - 6_000), toolUseLine('toolu_biurko', 'Bash', BASH_A, clock - 2_000),
      toolResultLine('toolu_biurko', clock - 1_000), fillerLine(clock - 900), assistantTextLine('dalej', clock - 700),
    ];
    const old = syntheticDump('przed-oknem', 'Bash', BASH_A, { startedAt: clock - 1_900, at: clock - 1_800 });
    hookStarts(h, old);
    // Stary follower czytał plik od początku: zamknięcie prośby w pamięci, karta bez przycisku.
    const before = await follow(h, lines);
    await h.step(waiting(), sourcesOfFollower(before), TOP_A);
    expect(cardOf(h, old.key)).toEqual({ state: 'pending', canAllow: false });
    before.close();
    // Nowy follower (reguła kotwicy okna), okno ogona zaczyna się za wynikiem prośby.
    clock += 100;
    const after = await follow(h, lines, 1);
    expect(after.closedToolUses?.()?.closed).toEqual([]);
    await h.step(waiting(), sourcesOfFollower(after), TOP_A);
    expect(h.verdicts.get(old.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, old.key)).toEqual({ state: 'pending', canAllow: false });
    expect(await h.cycle.decide(SESSION, old.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    // Następna prośba (`Bash` B na wierzchu) z otwartym `tool_use`: stary hook nie zabiera jej przycisku ani licznikiem
    // kolejki, ani w puli (inna komenda = `no`).
    clock += 200;
    appendFileSync(join(h.dir, 'store', projectSlug(FOLLOW_CWD), `${SESSION}.jsonl`),
      `${toolUseLine('toolu_nastepna', 'Bash', BASH_B, clock - 150)}\n`);
    const deadline = Date.now() + 10_000;
    while ((after.openToolUses?.() ?? []).length === 0) {
      if (Date.now() > deadline) throw new Error('timeout: dopisany `tool_use`');
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    const next = syntheticDump('nastepna-po-oknie', 'Bash', BASH_B, { startedAt: clock - 100, at: clock - 50 });
    hookStarts(h, next);
    await h.step(waiting(), sourcesOfFollower(after), TOP_B);
    expect([h.verdicts.get(old.key), h.verdicts.get(next.key)]).toEqual(['brak:transkrypt-brak', 'stoi']);
    expect([cardOf(h, old.key), cardOf(h, next.key)]).toEqual([
      { state: 'pending', canAllow: false }, { state: 'pending', canAllow: true },
    ]);
    expect(clock - old.at).toBeLessThan(ORPHAN_TRANSCRIPT_MIN_AGE_MS);
  });

  it('żywy hook rozpoczęty po pierwszym wpisie okna (i po pierwszym wpisie `assistant`), przed podpięciem followera,'
    + ' bez zapisanego `tool_use` → dowód zostaje, karta stoi z przyciskiem', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T14:00:00.000Z');
    const lines = [
      userLine('przejrzyj', clock - 9_000), toolUseLine('toolu_read', 'Read', { file_path: '/x' }, clock - 8_500),
      toolResultLine('toolu_read', clock - 8_400), fillerLine(clock - 8_000),
      userLine('dalej', clock - 7_000), assistantTextLine('robię', clock - 6_000), userLine('dwa razy Bash', clock - 3_000),
    ];
    const dump = syntheticDump('po-oknie', 'Bash', BASH_A, { startedAt: clock - 1_000, at: clock - 900 });
    hookStarts(h, dump);
    const follower = await follow(h, lines, 3);
    expect(follower.closedToolUses?.()).toEqual({ closed: [], lostAt: clock - 6_000 });
    const transcript = sourcesOfFollower(follower);
    await h.step(waiting(), transcript, TOP_A);
    expect(h.verdicts.get(dump.key)).toBe('stoi');
    expect(cardOf(h, dump.key)).toEqual({ state: 'pending', canAllow: true });
    const seen = await ticksUntil(h, dump.key, dump.at + 10_000, transcript, TOP_A);
    expect(seen).toEqual(seen.map(() => ({ state: 'pending', canAllow: true })));
  });

  it('żywy hook rozpoczęty przed pierwszym wpisem okna, bez zamknięcia w oknie → bez dowodu (`transkrypt-brak`)',
    async () => {
      const h = await harness();
      clock = Date.parse('2026-11-08T15:00:00.000Z');
      const lines = [
        userLine('przejrzyj', clock - 9_000), fillerLine(clock - 8_000),
        userLine('dalej', clock - 3_000), assistantTextLine('robię', clock - 2_500),
      ];
      const dump = syntheticDump('hook-przed-oknem-bez-wyniku', 'Bash', BASH_A, { startedAt: clock - 3_500, at: clock - 3_400 });
      hookStarts(h, dump);
      const follower = await follow(h, lines, 2);
      const transcript = sourcesOfFollower(follower);
      expect(transcript?.lostAt).toBe(clock - 2_500);
      await h.step(waiting(), transcript, TOP_A);
      expect(h.verdicts.get(dump.key)).toBe('brak:transkrypt-brak');
      expect(cardOf(h, dump.key)).toEqual({ state: 'pending', canAllow: false });
      clock = dump.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
      await h.step(waiting(), transcript, TOP_A);
      expect(stateOf(h, dump.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
    });
});

// ---------------------------------------------------------------- powrót gniazda herdr (`re-attached`)

/** Powrót gniazda herdr: manager woła port kanału zgód (`reattached`), a ten stawia granicę w cyklu. */
const reattach = (h: Harness): Promise<void> => h.cycle.markReattached(SESSION);

/** Czeka (czas rzeczywisty, do 10 s) na warunek followera. */
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
}

/**
 * Nowy follower na pliku harnessu, czytanym od początku, bez czekania na znany transkrypt (pusty plik przy pierwszym
 * podpięciu zostaje nieznany). Zwraca go po pierwszym odczycie: pierwsza wypłata listy zadań w tle idzie po nim
 * bezwarunkowo, także przy pustym pliku.
 */
async function followFirstRead(h: Harness, lines: readonly string[]): Promise<JsonlFollower> {
  transcriptFile(h, lines);
  const follower = createJsonlFollower({
    cwd: FOLLOW_CWD, agentSessionId: SESSION, root: join(h.dir, 'store'), watch: false, timing: FOLLOW_TIMING, now,
  });
  followers.push(follower);
  let read = false;
  void (async () => {
    for await (const event of follower.events) if (event.type === 'tasks') read = true;
  })();
  await until(() => read, 'pierwszy odczyt nowego followera');
  return follower;
}

/** Prośba rozstrzygnięta przy biurku: prompt, `tool_use` i jego wynik po starcie hooka z {@link deskDump}. */
const deskLines = (): string[] => [
  userLine('zbuduj', clock - 6_000), toolUseLine('toolu_biurko', 'Bash', BASH_A, clock - 2_000),
  toolResultLine('toolu_biurko', clock - 1_000),
];
const deskDump = (seed: string): HookCallDump => syntheticDump(seed, 'Bash', BASH_A, { startedAt: clock - 1_900, at: clock - 1_800 });

const PENDING_BUTTON = { state: 'pending', canAllow: true } as const;
const PENDING_NO_BUTTON = { state: 'pending', canAllow: false } as const;
const REFUSED = { ok: false, error: 'card-changed', state: 'pending' } as const;

describe('karta warstwy 1: powrót gniazda herdr (`re-attached`) zabiera dowód hookom sprzed granicy', () => {
  it.each<[string, () => readonly string[], TranscriptToolUses | null]>([
    ['skrócenie do zera, potem `re-attached` (nowy follower nad pustym plikiem: transkrypt nieznany)', () => [], null],
    ['skrócenie do mniejszego, niepustego pliku, potem `re-attached` (plik czytany od początku, bez zamknięcia)',
      () => [userLine('zbuduj', clock - 6_100)], { open: [], closed: [], lostAt: null }],
  ])('%s, hook prośby rozstrzygniętej przy biurku żywy, przed upływem 5 s → przycisk nie wraca, `decide(allow)` nie'
    + ' daje `sent`', async (_name, truncated, read) => {
    const h = await harness();
    clock = Date.parse('2026-11-08T16:00:00.000Z');
    const dump = deskDump('skrocenie-potem-powrot');
    hookStarts(h, dump);
    // Stary follower czytał plik od początku: zamknięcie prośby w pamięci, karta bez przycisku.
    const before = await follow(h, deskLines());
    await h.step(waiting(), sourcesOfFollower(before), TOP_A);
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    before.close();
    // CLI skraca plik w przerwie gniazda herdr: granica w cyklu, potem nowy driver i follower bez przeszłości pliku.
    clock += 100;
    await reattach(h);
    const after = await followFirstRead(h, truncated());
    expect(sourcesOfFollower(after)).toEqual(read);
    await h.step(waiting(), sourcesOfFollower(after), TOP_A);
    expect(h.verdicts.get(dump.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual(REFUSED);
    expect(clock - dump.at).toBeLessThan(ORPHAN_TRANSCRIPT_MIN_AGE_MS);
  });

  it('koszt: `re-attached` przy stojącym hooku sprzed powrotu bez zapisanego `tool_use` → karta traci przycisk już przy'
    + ' granicy, nowy follower go nie oddaje, po 5 s `revoked: dialog-gone`; decyzja zostaje przy biurku', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T17:00:00.000Z');
    const lines = [userLine('dwa razy Bash', clock - 3_000)];
    const dump = syntheticDump('stoi-przed-powrotem', 'Bash', BASH_A, { startedAt: clock - 1_000, at: clock - 900 });
    hookStarts(h, dump);
    const before = await follow(h, lines);
    await h.step(waiting(), sourcesOfFollower(before), TOP_A);
    expect(cardOf(h, dump.key)).toEqual(PENDING_BUTTON);
    before.close();
    clock += 100;
    await reattach(h);
    // Karta traci przycisk już przy granicy, przed pierwszą obserwacją nowego drivera.
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    const after = await followFirstRead(h, lines);
    const transcript = sourcesOfFollower(after);
    expect(transcript).toEqual({ open: [], closed: [], lostAt: null });
    await h.step(waiting(), transcript, TOP_A);
    expect(h.verdicts.get(dump.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    clock = dump.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), transcript, TOP_A);
    expect(stateOf(h, dump.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
  });

  it('hook rozpoczęty po pierwszej obserwacji nowego followera po `re-attached` → dowód z kompletu, karta z przyciskiem'
    + ' przez 10 s', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T18:00:00.000Z');
    await reattach(h);
    const after = await followFirstRead(h, [userLine('przejrzyj', clock - 3_000), assistantTextLine('robię', clock - 2_000)]);
    const transcript = sourcesOfFollower(after);
    expect(transcript).toEqual({ open: [], closed: [], lostAt: null });
    // Pierwsza obserwacja nowego drivera ze znanym transkryptem kończy okres powrotu gniazda.
    await h.step(waiting(), transcript, TOP_A);
    clock += 300;
    const dump = syntheticDump('po-podpieciu', 'Bash', BASH_A, { startedAt: clock - 200, at: clock - 100 });
    hookStarts(h, dump);
    await h.step(waiting(), transcript, TOP_A);
    expect(h.verdicts.get(dump.key)).toBe('stoi');
    expect(cardOf(h, dump.key)).toEqual(PENDING_BUTTON);
    const seen = await ticksUntil(h, dump.key, dump.at + 10_000, transcript, TOP_A);
    expect(seen).toEqual(seen.map(() => PENDING_BUTTON));
  });

  it('granica: od `re-attached` do pierwszej obserwacji ze znanym transkryptem traci dowód każdy hook (transkrypt'
    + ' nieznany okresu nie kończy); potem hook rozpoczęty w chwili tej obserwacji traci dowód, o 1 ms później nie;'
    + ' granica nie maleje i dotyczy tylko swojej sesji', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T18:30:00.000Z');
    await reattach(h);
    expect(h.cycle.proofLost(SESSION, { key: 'k-pozniej', startedAt: clock + 60_000 })).toBe(true);
    clock += 500;
    await h.step(waiting(), null, TOP_A);
    expect(h.cycle.proofLost(SESSION, { key: 'k-pozniej', startedAt: clock + 60_000 })).toBe(true);
    clock += 500;
    const end = clock;
    const read: TranscriptToolUses = { open: [], closed: [], lostAt: null };
    await h.step(waiting(), read, TOP_A);
    expect(h.cycle.proofLost(SESSION, { key: 'k-rowny', startedAt: end })).toBe(true);
    expect(h.cycle.proofLost(SESSION, { key: 'k-pozniej', startedAt: end + 1 })).toBe(false);
    // Zegar cofnięty (korekta czasu systemu): drugie `re-attached` i koniec jego okresu granicy nie cofają.
    clock -= 5_000;
    await reattach(h);
    await h.step(waiting(), read, TOP_A);
    expect(h.cycle.proofLost(SESSION, { key: 'k-rowny', startedAt: end })).toBe(true);
    expect(h.cycle.proofLost(SESSION, { key: 'k-pozniej', startedAt: end + 1 })).toBe(false);
    expect(h.cycle.proofLost('00000000-0000-4000-9000-0000000000ff', { key: 'k-rowny', startedAt: end })).toBe(false);
  });
});

// ---------------------------------------------------------------- utrata dowodu zapisana w cyklu

/** Plik transkryptu harnessu (ten, który czyta follower z {@link follow}). */
const transcriptPath = (h: Harness): string => join(h.dir, 'store', projectSlug(FOLLOW_CWD), `${SESSION}.jsonl`);

describe('karta warstwy 1: utrata dowodu zapisana w cyklu, w jedną stronę', () => {
  it('skrócenie zostawia `tool_use` prośby rozstrzygniętej przy biurku i zabiera jej wynik (bez `re-attached`), przed'
    + ' upływem 5 s → przycisk nie wraca, `decide(allow)` odrzucone, po 5 s `revoked: dialog-gone`', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T19:00:00.000Z');
    const lines = deskLines();
    const dump = deskDump('skrocenie-zostawia-tool-use');
    hookStarts(h, dump);
    const follower = await follow(h, lines);
    await h.step(waiting(), sourcesOfFollower(follower), TOP_A);
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    // Plik skrócony do zera i zapisany od nowa bez wyniku prośby: tracker followera ma ją otwartą.
    clock += 100;
    writeFileSync(transcriptPath(h), '');
    await until(() => follower.closedToolUses?.()?.lostAt === clock, 'skrócenie do zera');
    appendFileSync(transcriptPath(h), `${lines.slice(0, 2).join('\n')}\n`);
    await until(() => (follower.openToolUses?.() ?? []).length === 1, 'otwarty `tool_use` po skróceniu');
    const transcript = sourcesOfFollower(follower);
    expect(transcript).toEqual({ open: [expect.objectContaining({ toolName: 'Bash' })], closed: [], lostAt: clock });
    await h.step(waiting(), transcript, TOP_A);
    expect(h.verdicts.get(dump.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual(REFUSED);
    expect(clock - dump.at).toBeLessThan(ORPHAN_TRANSCRIPT_MIN_AGE_MS);
    clock = dump.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), transcript, TOP_A);
    expect(stateOf(h, dump.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
  });

  it('`re-attached`, a w przerwie gniazda prośba rozstrzygnięta przy biurku i plik skrócony tak, że jej `tool_use`'
    + ' zostaje, a wynik nie: nowy follower ma ją otwartą → przycisk nie wraca, `decide(allow)` odrzucone', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T19:10:00.000Z');
    const lines = deskLines();
    const dump = deskDump('powrot-tool-use-zostaje');
    hookStarts(h, dump);
    // Przed przerwą gniazda: prośba otwarta w transkrypcie, karta z przyciskiem.
    await h.step(waiting(), { open: [openTool('Bash', BASH_A)], closed: [], lostAt: null }, TOP_A);
    expect(cardOf(h, dump.key)).toEqual(PENDING_BUTTON);
    clock += 100;
    await reattach(h);
    const after = await follow(h, lines.slice(0, 2));
    const transcript = sourcesOfFollower(after);
    expect(transcript).toEqual({ open: [expect.objectContaining({ toolName: 'Bash' })], closed: [], lostAt: null });
    await h.step(waiting(), transcript, TOP_A);
    expect(h.verdicts.get(dump.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual(REFUSED);
  });

  it.each<[string, (h: Harness) => Promise<TranscriptToolUses | null>]>([
    ['nowy follower bez pliku rozmowy', async (h) => {
      const follower = createJsonlFollower({
        cwd: FOLLOW_CWD, agentSessionId: SESSION, root: join(h.dir, 'store-bez-pliku'), watch: false, timing: FOLLOW_TIMING,
        now,
      });
      followers.push(follower);
      await until(() => follower.hasTranscript() === 'no', 'brak pliku rozmowy');
      return sourcesOfFollower(follower);
    }],
    ['nieudany pierwszy odczyt (driver podaje transkrypt nieznany)', async () => null],
  ])('`re-attached`, potem %s → przycisk nie wraca, po 5 s `revoked: dialog-gone`', async (_name, transcriptOf) => {
    const h = await harness();
    clock = Date.parse('2026-11-08T19:20:00.000Z');
    const dump = deskDump('powrot-bez-odczytu');
    hookStarts(h, dump);
    await h.step(waiting(), { open: [openTool('Bash', BASH_A)], closed: [], lostAt: null }, TOP_A);
    expect(cardOf(h, dump.key)).toEqual(PENDING_BUTTON);
    // Prośba rozstrzygnięta przy biurku w przerwie gniazda; rejestr dalej `waiting` (następny dialog).
    clock += 100;
    await reattach(h);
    const transcript = await transcriptOf(h);
    expect(transcript).toBeNull();
    await h.step(waiting(), transcript, TOP_A);
    expect(h.verdicts.get(dump.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual(REFUSED);
    clock = dump.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), transcript, TOP_A);
    expect(stateOf(h, dump.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
  });

  it.each<[string, 'liveness' | 'inspect']>([
    ['w trakcie odczytu `ps` (przed oceną dowodu)', 'liveness'],
    ['po ocenie dowodu, przed krokiem cyklu (sygnał `standing` już policzony)', 'inspect'],
  ])('`re-attached` %s: zrzut starego hooka bez rekordu, rekord powstaje po granicy → bez przycisku, `decide(allow)`'
    + ' odrzucone', async (_name, at) => {
    const h = await harness();
    clock = Date.parse('2026-11-08T19:30:00.000Z');
    const dump = syntheticDump('powrot-w-trakcie', 'Bash', BASH_A);
    hookStarts(h, dump);
    clock += 100;
    const marks: Promise<void>[] = [];
    const signals = new Map<string, string>();
    await observeConsentSession(h.cycle, {
      dataDir: h.dir, sessionId: SESSION, registry: waiting(), transcript: beforeWrite(), screen: screenRead(TOP_A), now,
      liveness: async (processes, t) => {
        if (at === 'liveness') marks.push(reattach(h));
        return h.liveness(processes, t);
      },
    }, (observation) => {
      for (const [key, signal] of observation.signals) signals.set(key, signal);
      if (at === 'inspect') marks.push(reattach(h));
    });
    await Promise.all(marks);
    expect(h.cycle.record(SESSION, dump.key)?.state).toBe('pending');
    expect(signals.get(dump.key)).toBe(at === 'liveness' ? 'unknown' : 'standing');
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    expect(h.cycle.card(SESSION, dump.key)?.unavailable).toBe('no-proof');
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual(REFUSED);
  });

  it('`decide(allow)` w kolejce klucza, a granica `re-attached` przed jej krokiem → `card-changed`, bez pliku odpowiedzi',
    async () => {
      const h = await harness();
      clock = Date.parse('2026-11-08T19:35:00.000Z');
      const dump = syntheticDump('decyzja-w-kolejce', 'Bash', BASH_A);
      hookStarts(h, dump);
      await h.step(waiting(), beforeWrite(), TOP_A);
      expect(cardOf(h, dump.key)).toEqual(PENDING_BUTTON);
      clock += 100;
      const decided = h.cycle.decide(SESSION, dump.key, 'allow');
      const marked = reattach(h);
      expect(await decided).toEqual(REFUSED);
      await marked;
      expect(existsSync(answerPath(h.dir, dump.key, '.json'))).toBe(false);
    });

  it('zamknięty `Bash` B przy otwartym `Bash` A, potem zrzut A znika bez zamknięcia → B nie odzyskuje przycisku', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T19:40:00.000Z');
    const a = syntheticDump('zamkniety-obok-a', 'Bash', BASH_A);
    const b = syntheticDump('zamkniety-obok-b', 'Bash', BASH_B);
    hookStarts(h, a);
    hookStarts(h, b);
    clock += 300;
    const mixed: TranscriptToolUses = {
      open: [openTool('Bash', BASH_A)], closed: [closedTool('Bash', BASH_B, clock - 100)], lostAt: null,
    };
    await h.step(waiting(), mixed, TOP_A);
    expect([cardOf(h, a.key), cardOf(h, b.key)]).toEqual([PENDING_BUTTON, PENDING_NO_BUTTON]);
    // Hook A wychodzi (zrzut znika), a jego wywołanie zostaje otwarte w transkrypcie; na wierzchu ramka B, więc brak
    // przycisku B bierze się z zamknięcia B, nie z ekranu.
    rmSync(dumpPath(h.dir, a.key));
    h.life.set(a.pid, false);
    clock += TICK_MS;
    await h.step(waiting(), mixed, TOP_B);
    expect(h.verdicts.get(b.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, b.key)).toEqual(PENDING_NO_BUTTON);
    expect(await h.cycle.decide(SESSION, b.key, 'allow')).toEqual(REFUSED);
  });

  it.each<[string, { readonly command: string }, boolean, boolean]>([
    ['inne wejście, zamknięcie X odczytane osobno', BASH_B, false, true],
    ['to samo wejście, zamknięcie X odczytane osobno', BASH_A, false, false],
    ['inne wejście, zamknięcie X i `tool_use` następnego w jednym odczycie', BASH_B, true, true],
  ])('prośba X zamknięta, potem `tool_use` następnego wywołania `Bash` przed zrzutem jego hooka (%s) → X bez przycisku'
    + ' w każdym takcie, następna karta na wierzchu z przyciskiem, gdy jej komenda różni się od X (z komendą X bez'
    + ' przycisku: zrzut X zostaje w puli, S3a-6i-B1a), X po 5 s `revoked: dialog-gone`',
  async (_name, nextInput, oneRead, yButton) => {
    const h = await harness();
    clock = Date.parse('2026-11-08T19:50:00.000Z');
    const x = syntheticDump('nastepny-przed-zrzutem-x', 'Bash', BASH_A);
    hookStarts(h, x);
    await h.step(waiting(), { open: [openTool('Bash', BASH_A)], closed: [], lostAt: null }, TOP_A);
    expect(cardOf(h, x.key)).toEqual(PENDING_BUTTON);
    // Decyzja przy biurku: wynik X po starcie hooka, hook X dalej żyje.
    clock += 200;
    const closedX = closedTool('Bash', BASH_A, clock - 50);
    if (!oneRead) {
      await h.step(waiting(), { open: [], closed: [closedX], lostAt: null }, TOP_A);
      expect(cardOf(h, x.key)).toEqual(PENDING_NO_BUTTON);
    }
    // Następne wywołanie tej nazwy: `tool_use` w transkrypcie, zrzutu jego hooka jeszcze nie ma.
    clock += 200;
    const next: TranscriptToolUses = { open: [openTool('Bash', nextInput)], closed: [closedX], lostAt: null };
    const seen = await ticksUntil(h, x.key, clock + 2 * TICK_MS, next, TOP_A);
    expect(seen).toHaveLength(2);
    expect(seen).toEqual(seen.map(() => PENDING_NO_BUTTON));
    // Zrzut następnego hooka na wierzchu: jego karta z przyciskiem, X dalej bez (i nie jest bliźniakiem ani kandydatem
    // kolejki w werdykcie cienia). Przy komendzie X do wierzchu pasuje też zrzut X z puli: żadna karta z przyciskiem.
    const y = syntheticDump('nastepny-przed-zrzutem-y', 'Bash', nextInput, { startedAt: clock - 100, at: clock - 50 });
    hookStarts(h, y);
    const yCard = yButton ? PENDING_BUTTON : PENDING_NO_BUTTON;
    await h.step(waiting(), next, bashTop(nextInput));
    expect([h.verdicts.get(x.key), h.verdicts.get(y.key)]).toEqual(['brak:transkrypt-brak', 'stoi']);
    expect([cardOf(h, x.key), cardOf(h, y.key)]).toEqual([PENDING_NO_BUTTON, yCard]);
    clock = x.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), next, bashTop(nextInput));
    expect(stateOf(h, x.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
    expect(cardOf(h, y.key)).toEqual(yCard);
  });

  it('utrata dowodu, potem transkrypt nieznany i nowa poprawna karta przy kolejce `single` → nowa karta z przyciskiem,'
    + ' stary klucz po 5 s `revoked: dialog-gone`', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T20:00:00.000Z');
    const old = syntheticDump('utrata-null-stary', 'Bash', BASH_A);
    hookStarts(h, old);
    clock += 200;
    await h.step(waiting(), { open: [], closed: [closedTool('Bash', BASH_A, clock - 100)], lostAt: null }, TOP_A);
    expect(cardOf(h, old.key)).toEqual(PENDING_NO_BUTTON);
    clock += 300;
    const fresh = syntheticDump('utrata-null-nowy', 'Bash', BASH_B, { startedAt: clock - 200, at: clock - 100 });
    hookStarts(h, fresh);
    await h.step(waiting(), null, TOP_B);
    expect([h.verdicts.get(old.key), h.verdicts.get(fresh.key)]).toEqual(['brak:transkrypt-brak', 'stoi']);
    expect([cardOf(h, old.key), cardOf(h, fresh.key)]).toEqual([PENDING_NO_BUTTON, PENDING_BUTTON]);
    clock = old.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), null, TOP_B);
    expect(stateOf(h, old.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
    expect(cardOf(h, fresh.key)).toEqual(PENDING_BUTTON);
  });

  it('na wierzchu B (werdykt cienia `kolejka`), potem B rozstrzygnięta i na wierzchu A → przycisk A wraca (werdykt'
    + ' przejściowy zostaje przejściowy; w warstwie 1 dowód z wierzchu, S3a-6i-B1a)', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T20:10:00.000Z');
    const a = syntheticDump('kolejka-wraca-a', 'Bash', BASH_A);
    const b = syntheticDump('kolejka-wraca-b', 'Bash', BASH_B);
    hookStarts(h, a);
    hookStarts(h, b);
    await h.step(waiting(), beforeWrite(), TOP_B);
    expect([h.verdicts.get(a.key), h.verdicts.get(b.key)]).toEqual(['brak:kolejka', 'brak:kolejka']);
    expect([cardOf(h, a.key), cardOf(h, b.key)]).toEqual([PENDING_NO_BUTTON, PENDING_BUTTON]);
    // B rozstrzygnięta: wynik B po starcie jego hooka, hook B wychodzi, zrzut znika; na ekranie zostaje dialog A.
    clock += 500;
    rmSync(dumpPath(h.dir, b.key));
    h.life.set(b.pid, false);
    const afterB: TranscriptToolUses = {
      open: [], closed: [...beforeWrite().closed, closedTool('Bash', BASH_B, clock - 100)], lostAt: null,
    };
    await h.step(waiting(), afterB, TOP_A);
    expect(h.verdicts.get(a.key)).toBe('stoi');
    expect(cardOf(h, a.key)).toEqual(PENDING_BUTTON);
    expect(await h.cycle.decide(SESSION, a.key, 'allow')).toEqual({ ok: true, state: 'sent' });
  });

  it('rekord `claimed` z kluczem sprzed `re-attached` i dialogiem stojącym 30 s po odbiorze → `unknown: no-effect`'
    + ' (surowy sygnał, bez faktu utraty)', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T20:20:00.000Z');
    const dump = syntheticDump('claimed-utracony', 'Bash', BASH_A);
    hookStarts(h, dump);
    const open: TranscriptToolUses = { open: [openTool('Bash', BASH_A)], closed: [], lostAt: null };
    await h.step(waiting(), open, TOP_A);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    renameSync(answerPath(h.dir, dump.key, '.json'), answerPath(h.dir, dump.key, '.claimed'));
    await h.cycle.tick();
    expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
    await reattach(h);
    expect(h.cycle.proofLost(SESSION, dump)).toBe(false);
    // CLI nie wykonało odpowiedzi (MCP z interakcją): dialog dalej stoi, hook żyje, rejestr `waiting`/`permission`.
    const claimedAt = h.cycle.record(SESSION, dump.key)?.times.claimed ?? clock;
    while (clock < claimedAt + CONSENT_CLAIMED_STANDING_MS) {
      clock += TICK_MS;
      await h.step(waiting(), open, TOP_A);
      expect(h.verdicts.get(dump.key)).toBe('stoi');
    }
    expect(stateOf(h, dump.key)).toEqual({ state: 'unknown', cause: 'no-effect' });
  });

  it('koszt: dwa identyczne wywołania, jedno rozstrzygnięte przy biurku → drugie bez przycisku na stałe, także gdy'
    + ' zostaje samo z otwartym `tool_use`; po 5 s `revoked: dialog-gone`', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T20:30:00.000Z');
    const first = syntheticDump('identyczne-1', 'Bash', BASH_A);
    const second = syntheticDump('identyczne-2', 'Bash', BASH_A, { startedAt: clock - 950, at: clock - 850 });
    hookStarts(h, first);
    hookStarts(h, second);
    await h.step(waiting(), beforeWrite(), TOP_A);
    expect([h.verdicts.get(first.key), h.verdicts.get(second.key)]).toEqual(['niejednoznaczny', 'niejednoznaczny']);
    // Pierwsze rozstrzygnięte przy biurku: wynik po starcie obu hooków; hook pierwszego wychodzi.
    clock += 300;
    const closedFirst = closedTool('Bash', BASH_A, clock - 100);
    rmSync(dumpPath(h.dir, first.key));
    h.life.set(first.pid, false);
    await h.step(waiting(), { open: [], closed: [closedFirst], lostAt: null }, TOP_A);
    expect(cardOf(h, second.key)).toEqual(PENDING_NO_BUTTON);
    // Transkrypt pokazuje potem otwarte drugie wywołanie: jego dialog stoi, a przycisk nie wraca (zapisany koszt).
    clock += 300;
    const reopened: TranscriptToolUses = { open: [openTool('Bash', BASH_A)], closed: [closedFirst], lostAt: null };
    await h.step(waiting(), reopened, TOP_A);
    expect(h.verdicts.get(second.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, second.key)).toEqual(PENDING_NO_BUTTON);
    clock = second.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), reopened, TOP_A);
    expect(stateOf(h, second.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
  });

  it('koszt: pierwsze podpięcie, wynik wywołania sprzed okna dopisany po starcie bieżącego hooka → bieżąca karta bez'
    + ' przycisku na stałe, także po zapisie jej otwartego `tool_use`; po 5 s `revoked: dialog-gone`', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T20:40:00.000Z');
    const lines = [
      userLine('przejrzyj', clock - 9_000), toolUseLine('toolu_dlugi', 'Bash', { command: 'sleep 60' }, clock - 8_500),
      fillerLine(clock - 8_000), userLine('dalej', clock - 3_000), assistantTextLine('robię', clock - 2_500),
    ];
    const dump = syntheticDump('okno-wynik-sprzed', 'Bash', BASH_A, { startedAt: clock - 1_000, at: clock - 900 });
    hookStarts(h, dump);
    const follower = await follow(h, lines, 2);
    expect(follower.closedToolUses?.()).toEqual({ closed: [], lostAt: clock - 2_500 });
    await h.step(waiting(), sourcesOfFollower(follower), TOP_A);
    expect(h.verdicts.get(dump.key)).toBe('stoi');
    expect(cardOf(h, dump.key)).toEqual(PENDING_BUTTON);
    // Wynik wywołania sprzed okna, zapisany po starcie hooka: tracker nie zna jego `tool_use` (utrata pokrycia).
    clock += 200;
    const resultAt = clock - 100;
    appendFileSync(transcriptPath(h), `${toolResultLine('toolu_dlugi', resultAt)}\n`);
    await until(() => follower.closedToolUses?.()?.lostAt === resultAt, 'wynik sprzed okna');
    await h.step(waiting(), sourcesOfFollower(follower), TOP_A);
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    // Transkrypt dopisuje otwarty `tool_use` bieżącej prośby: dialog stoi, a przycisk nie wraca (zapisany koszt).
    clock += 200;
    appendFileSync(transcriptPath(h), `${toolUseLine('toolu_biezacy', 'Bash', BASH_A, clock - 100)}\n`);
    await until(() => (follower.openToolUses?.() ?? []).length === 1, 'otwarty `tool_use` bieżącej prośby');
    await h.step(waiting(), sourcesOfFollower(follower), TOP_A);
    expect(h.verdicts.get(dump.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    clock = dump.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), sourcesOfFollower(follower), TOP_A);
    expect(stateOf(h, dump.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
  });

  it('koszt: dwa żywe `ExitPlanMode` i zamknięcie pierwszego po starcie obu → oba bez przycisku na stałe, także po'
    + ' zapisie otwartego wpisu drugiego; po 5 s oba `revoked: dialog-gone`', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T20:50:00.000Z');
    const planA = { plan: 'Plan A: przejrzeć testy.' };
    const planB = { plan: 'Plan B: poprawić dokument.' };
    const first = syntheticDump('plan-koszt-1', 'ExitPlanMode', planA, { permissionMode: 'plan' });
    const second = syntheticDump('plan-koszt-2', 'ExitPlanMode', planB, {
      startedAt: clock - 900, at: clock - 800, permissionMode: 'plan',
    });
    hookStarts(h, first);
    hookStarts(h, second);
    clock += 300;
    const closedFirst = closedTool('ExitPlanMode', planA, clock - 100);
    const both = (): unknown[] => [h.verdicts.get(first.key), h.verdicts.get(second.key)];
    await h.step(waiting(), { open: [], closed: [closedFirst], lostAt: null }, PLAN_TOP);
    expect(both()).toEqual(['brak:transkrypt-brak', 'brak:transkrypt-brak']);
    expect([cardOf(h, first.key), cardOf(h, second.key)]).toEqual([PENDING_NO_BUTTON, PENDING_NO_BUTTON]);
    clock += 300;
    const reopened: TranscriptToolUses = { open: [openTool('ExitPlanMode', planB)], closed: [closedFirst], lostAt: null };
    await h.step(waiting(), reopened, PLAN_TOP);
    expect(both()).toEqual(['brak:transkrypt-brak', 'brak:transkrypt-brak']);
    expect([cardOf(h, first.key), cardOf(h, second.key)]).toEqual([PENDING_NO_BUTTON, PENDING_NO_BUTTON]);
    clock = second.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), reopened, PLAN_TOP);
    expect([stateOf(h, first.key), stateOf(h, second.key)]).toEqual([
      { state: 'revoked', cause: 'dialog-gone' }, { state: 'revoked', cause: 'dialog-gone' },
    ]);
  });
});

// ---------------------------------------------------------------- okres powrotu gniazda, fakt przed `ps`

describe('karta warstwy 1: okres powrotu gniazda do pierwszej obserwacji nowego followera, fakt zamknięcia przed `ps`,'
  + ' skrót wejścia bez zrzutów utraconych', () => {
  it('zrzut utracony (opcja warstwy 1) nie liczy się w regule skrótu wejścia: prośba bez wpisu obok otwartego wpisu'
    + ' utraconego zrzutu stoi i po 5 s nie jest sierotą; wejście cienia bez zmian (`transkrypt-skrot`)', () => {
    const gone = syntheticDump('skrot-utracony', 'Bash', BASH_A);
    const fresh = syntheticDump('skrot-nowy', 'Bash', BASH_B);
    const transcript = [openTool('Bash', BASH_A)];
    const layer1 = { passed: () => false, lost: (dump: HookCallDump) => dump.key === gone.key };
    expect(kinds(evidence([gone, fresh], { transcript, layer1 }))).toEqual(['brak:transkrypt-brak', 'stoi']);
    expect(kinds(evidence([gone, fresh], { transcript }))).toEqual(['stoi', 'brak:transkrypt-skrot']);
    clock = fresh.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    expect(orphans(evidence([gone, fresh], { transcript, layer1 }))).toEqual(['transkrypt-brak']);
    expect(orphans(evidence([gone, fresh], { transcript }))).toEqual(['transkrypt-skrot']);
  });

  it('`re-attached` w T, hook w T+50 ms, prośba rozstrzygnięta przy biurku i plik skrócony przed pierwszym odczytem'
    + ' nowego followera (T+600 ms) → bez przycisku, `decide(allow)` odrzucone, po 5 s'
    + ' `revoked: dialog-gone`', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T21:10:00.000Z');
    const t = clock;
    await reattach(h);
    // Hook startuje po `re-attached`; nowy driver czeka w kolejce podpięć, więc sesji nikt jeszcze nie obserwuje.
    const dump = syntheticDump('powrot-przed-odczytem', 'Bash', BASH_A, { startedAt: t + 50, at: t + 60 });
    hookStarts(h, dump);
    // Przy biurku prośba rozstrzygnięta, potem plik skrócony (bez jej `tool_use` i wyniku) przed odczytem nowego followera.
    clock = t + 600;
    const after = await followFirstRead(h, [userLine('zbuduj', t - 6_000)]);
    const transcript = sourcesOfFollower(after);
    expect(transcript).toEqual({ open: [], closed: [], lostAt: null });
    await h.step(waiting(), transcript, TOP_A);
    expect(h.verdicts.get(dump.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual(REFUSED);
    expect(existsSync(answerPath(h.dir, dump.key, '.json'))).toBe(false);
    clock = dump.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), transcript, TOP_A);
    expect(stateOf(h, dump.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
  });

  it('obserwacja starego drivera w toku przy `re-attached` (granica w trakcie odczytu `ps`), z transkryptem starego'
    + ' followera → okres trwa: hook rozpoczęty po granicy bez przycisku, a przycisk ma dopiero hook rozpoczęty po'
    + ' pierwszej obserwacji ze znanym transkryptem, która zaczęła się po `re-attached`', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T21:20:00.000Z');
    const old = syntheticDump('stary-driver-w-toku', 'Bash', BASH_A);
    hookStarts(h, old);
    clock += 100;
    // Manager odpina stary driver w tym samym kroku co granica (`manager-herdr.test.ts`), a odpięty driver już nie
    // obserwuje (`layer1-driver.test.ts`): żadna jego obserwacja nie zaczyna się po granicy. Ta zaczęła się
    // przed nią i kończy po niej, z transkryptem starego followera.
    const marks: Promise<void>[] = [];
    await observeConsentSession(h.cycle, {
      dataDir: h.dir, sessionId: SESSION, registry: waiting(), screen: screenRead(TOP_A), now,
      transcript: { open: [openTool('Bash', BASH_A)], closed: [], lostAt: null },
      liveness: async (processes, t) => {
        marks.push(reattach(h));
        return h.liveness(processes, t);
      },
    });
    await Promise.all(marks);
    expect(cardOf(h, old.key)).toEqual(PENDING_NO_BUTTON);
    // Hook po granicy; nowy driver obserwuje przed pierwszym odczytem swojego followera (transkrypt nieznany).
    clock += 200;
    const late = syntheticDump('po-granicy-w-okresie', 'Bash', BASH_B, { startedAt: clock - 100, at: clock - 50 });
    hookStarts(h, late);
    await h.step(waiting(), null, TOP_B);
    expect(h.verdicts.get(late.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, late.key)).toEqual(PENDING_NO_BUTTON);
    expect(await h.cycle.decide(SESSION, late.key, 'allow')).toEqual(REFUSED);
    // Pierwsza obserwacja ze znanym transkryptem kończy okres; hook rozpoczęty po niej ma przycisk.
    clock += 300;
    const read: TranscriptToolUses = { open: [], closed: [], lostAt: null };
    await h.step(waiting(), read, TOP_B);
    expect(cardOf(h, late.key)).toEqual(PENDING_NO_BUTTON);
    clock += 300;
    const fresh = syntheticDump('po-okresie-stary-driver', 'Bash', BASH_C, { startedAt: clock - 200, at: clock - 100 });
    hookStarts(h, fresh);
    await h.step(waiting(), read, TOP_C);
    expect([h.verdicts.get(late.key), h.verdicts.get(fresh.key)]).toEqual(['brak:transkrypt-brak', 'stoi']);
    expect([cardOf(h, late.key), cardOf(h, fresh.key)]).toEqual([PENDING_NO_BUTTON, PENDING_BUTTON]);
  });

  it.each<[string, boolean]>([
    ['bez pliku rozmowy (ten sam nowy follower czyta plik, gdy się pojawi)', true],
    ['z nieudanym odczytem (driver podaje transkrypt nieznany), potem udany odczyt nowego followera', false],
  ])('po `re-attached` trzy takty %s → do udanego odczytu bez przycisku, hook rozpoczęty w tym czasie traci go na stałe'
    + ' (po 5 s `revoked: dialog-gone`), hook rozpoczęty po zamknięciu okresu ma przycisk', async (_name, noFile) => {
    const h = await harness();
    clock = Date.parse('2026-11-08T21:30:00.000Z');
    await reattach(h);
    const missing = noFile ? createJsonlFollower({
      cwd: FOLLOW_CWD, agentSessionId: SESSION, root: join(h.dir, 'store'), watch: false, timing: FOLLOW_TIMING, now,
    }) : null;
    if (missing !== null) {
      followers.push(missing);
      await until(() => missing.hasTranscript() === 'no', 'brak pliku rozmowy');
    }
    clock += 100;
    const during = syntheticDump('okres-bez-odczytu', 'Bash', BASH_A, { startedAt: clock - 50, at: clock - 40 });
    hookStarts(h, during);
    for (let tick = 0; tick < 3; tick += 1) {
      const unknown = missing === null ? null : sourcesOfFollower(missing);
      expect(unknown).toBeNull();
      await h.step(waiting(), unknown, TOP_A);
      expect(h.verdicts.get(during.key)).toBe('brak:transkrypt-brak');
      expect(cardOf(h, during.key)).toEqual(PENDING_NO_BUTTON);
      expect(await h.cycle.decide(SESSION, during.key, 'allow')).toEqual(REFUSED);
      clock += TICK_MS;
    }
    // Udany odczyt: plik się pojawia i czyta go ten sam follower albo odczyt nowego followera się udaje.
    const lines = [userLine('przejrzyj', clock - 6_000)];
    let reader: JsonlFollower;
    if (missing === null) reader = await follow(h, lines);
    else {
      transcriptFile(h, lines);
      await until(() => (missing.closedToolUses?.() ?? null) !== null, 'odczyt pliku, który się pojawił');
      reader = missing;
    }
    const read = sourcesOfFollower(reader);
    expect(read).toEqual({ open: [], closed: [], lostAt: null });
    await h.step(waiting(), read, TOP_A);
    expect(cardOf(h, during.key)).toEqual(PENDING_NO_BUTTON);
    clock += 300;
    const fresh = syntheticDump('po-udanym-odczycie', 'Bash', BASH_B, { startedAt: clock - 200, at: clock - 100 });
    hookStarts(h, fresh);
    await h.step(waiting(), read, TOP_B);
    expect([h.verdicts.get(during.key), h.verdicts.get(fresh.key)]).toEqual(['brak:transkrypt-brak', 'stoi']);
    expect([cardOf(h, during.key), cardOf(h, fresh.key)]).toEqual([PENDING_NO_BUTTON, PENDING_BUTTON]);
    clock = during.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), read, TOP_B);
    expect(stateOf(h, during.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
    expect(cardOf(h, fresh.key)).toEqual(PENDING_BUTTON);
    expect(await h.cycle.decide(SESSION, fresh.key, 'allow')).toEqual({ ok: true, state: 'sent' });
  });

  it('obserwacja z zamknięciem prośby, odczyt `ps` wstrzymany, w tym czasie `decide(allow)` → `card-changed`, bez pliku'
    + ' odpowiedzi', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T21:40:00.000Z');
    const dump = syntheticDump('decyzja-w-trakcie-ps', 'Bash', BASH_A);
    hookStarts(h, dump);
    await h.step(waiting(), { open: [openTool('Bash', BASH_A)], closed: [], lostAt: null }, TOP_A);
    expect(cardOf(h, dump.key)).toEqual(PENDING_BUTTON);
    // Prośba rozstrzygnięta przy biurku: wynik po starcie hooka; hook dalej żyje, a odczyt `ps` trwa.
    clock += 200;
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const inPs = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const observed = observeConsentSession(h.cycle, {
      dataDir: h.dir, sessionId: SESSION, registry: waiting(), screen: screenRead(TOP_A), now,
      transcript: { open: [], closed: [closedTool('Bash', BASH_A, clock - 50)], lostAt: null },
      liveness: async (processes, t) => {
        entered();
        await gate;
        return h.liveness(processes, t);
      },
    });
    await inPs;
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual(REFUSED);
    expect(existsSync(answerPath(h.dir, dump.key, '.json'))).toBe(false);
    release();
    await observed;
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    expect(existsSync(answerPath(h.dir, dump.key, '.json'))).toBe(false);
  });

  it('utracony `Bash` A z otwartym wpisem po skróceniu obok nowego `Bash` B bez wpisu, świeży `waiting/permission` →'
    + ' B `stoi` z przyciskiem w każdym takcie, póki rekord A jest `pending`, także w takcie, w którym B ma ponad 5 s'
    + ' (A schodzi w nim jako sierota)', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T21:50:00.000Z');
    const t = clock;
    const a = syntheticDump('skrot-utracony-a', 'Bash', BASH_A, { startedAt: t, at: t + 50 });
    hookStarts(h, a);
    // A rozstrzygnięta przy biurku: wynik po starcie hooka (fakt utraty w cyklu), hook A dalej żyje.
    clock = t + 150;
    await h.step(waiting(), { open: [], closed: [closedTool('Bash', BASH_A, t + 100)], lostAt: null }, TOP_A);
    expect(cardOf(h, a.key)).toEqual(PENDING_NO_BUTTON);
    // Plik skrócony: `tool_use` A zostaje, wynik nie. Potem prośba B, której `tool_use` jeszcze nie ma w pliku.
    const truncated: TranscriptToolUses = { open: [openTool('Bash', BASH_A)], closed: [], lostAt: t + 200 };
    const b = syntheticDump('skrot-nowy-b', 'Bash', BASH_B, { startedAt: t + 250, at: t + 300 });
    hookStarts(h, b);
    clock = t + 350;
    await h.step(waiting(), truncated, TOP_B);
    expect([h.verdicts.get(a.key), h.verdicts.get(b.key)]).toEqual(['brak:transkrypt-brak', 'stoi']);
    expect(cardOf(h, b.key)).toEqual(PENDING_BUTTON);
    // Takty co 1,5 s; w ostatnim B ma ponad 5 s, a A (zrzut 250 ms starszy) schodzi jako sierota.
    const seen: unknown[] = [];
    for (let tick = 1; tick <= 4; tick += 1) {
      clock = t + 350 + tick * TICK_MS;
      await h.step(waiting(), truncated, TOP_B);
      seen.push([h.verdicts.get(b.key), cardOf(h, b.key)]);
    }
    expect(seen).toEqual(seen.map(() => ['stoi', PENDING_BUTTON]));
    expect(clock - b.at).toBeGreaterThanOrEqual(ORPHAN_TRANSCRIPT_MIN_AGE_MS);
    expect([stateOf(h, a.key), stateOf(h, b.key)]).toEqual([
      { state: 'revoked', cause: 'dialog-gone' }, { state: 'pending', cause: null },
    ]);
    expect(await h.cycle.decide(SESSION, b.key, 'allow')).toEqual({ ok: true, state: 'sent' });
  });

  it('koszt: hook rozpoczęty po `re-attached`, a przed pierwszą obserwacją nowego followera ze znanym transkryptem →'
    + ' karta bez przycisku na stałe, także po zapisie otwartego `tool_use` prośby; po 5 s `revoked: dialog-gone`,'
    + ' decyzja zostaje przy biurku', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T22:00:00.000Z');
    await reattach(h);
    const after = await followFirstRead(h, [userLine('przejrzyj', clock - 3_000), assistantTextLine('robię', clock - 2_000)]);
    clock += 300;
    const dump = syntheticDump('przed-pierwsza-obserwacja', 'Bash', BASH_A, { startedAt: clock - 200, at: clock - 100 });
    hookStarts(h, dump);
    await h.step(waiting(), sourcesOfFollower(after), TOP_A);
    expect(h.verdicts.get(dump.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual(REFUSED);
    // Transkrypt dopisuje otwarty `tool_use` tej prośby: dialog stoi, a przycisk nie wraca (zapisany koszt).
    clock += 200;
    appendFileSync(transcriptPath(h), `${toolUseLine('toolu_stoi', 'Bash', BASH_A, clock - 100)}\n`);
    await until(() => (after.openToolUses?.() ?? []).length === 1, 'otwarty `tool_use` prośby');
    await h.step(waiting(), sourcesOfFollower(after), TOP_A);
    expect(h.verdicts.get(dump.key)).toBe('brak:transkrypt-brak');
    expect(cardOf(h, dump.key)).toEqual(PENDING_NO_BUTTON);
    clock = dump.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    await h.step(waiting(), sourcesOfFollower(after), TOP_A);
    expect(stateOf(h, dump.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
  });
});

// ---------------------------------------------------------------- utracony zrzut po odwołaniu karty

describe('karta warstwy 1: utracony zrzut poza porównaniami także po odwołaniu karty', () => {
  /**
   * Przypadek utraconego `Bash` A z otwartym wpisem, do odwołania A: A rozstrzygnięta przy biurku (wynik po starcie
   * hooka, fakt utraty w cyklu), plik skrócony tak, że otwarty wpis A zostaje, a wynik nie, potem prośba B (`open`:
   * otwarte wpisy po skróceniu). Takty co 1,5 s; w piątym zrzut A ma ponad 5 s i A schodzi jako sierota, a B do tej
   * chwili stoi z przyciskiem. Hook A żyje dalej: odwołanie rekordu `pending` nie pisze pliku odpowiedzi, a hook czeka
   * do sufitu `--answer-wait`. Na wierzchu od startu B stoi ramka B; przy wejściu B równym A pasuje do niej też zrzut
   * A, który zostaje w puli sesji, więc B nie ma przycisku (`button`).
   */
  async function lostRevoked(
    h: Harness, bInput: { readonly command: string }, open: readonly OpenToolUse[], button: boolean,
  ): Promise<{
    readonly a: HookCallDump; readonly b: HookCallDump; readonly truncated: TranscriptToolUses;
  }> {
    const t = clock;
    const a = syntheticDump('odwolany-a', 'Bash', BASH_A, { startedAt: t, at: t + 50 });
    hookStarts(h, a);
    clock = t + 150;
    await h.step(waiting(), { open: [], closed: [closedTool('Bash', BASH_A, t + 100)], lostAt: null }, TOP_A);
    expect(cardOf(h, a.key)).toEqual(PENDING_NO_BUTTON);
    const truncated: TranscriptToolUses = { open, closed: [], lostAt: t + 200 };
    const b = syntheticDump('odwolany-b', 'Bash', bInput, { startedAt: t + 250, at: t + 300 });
    hookStarts(h, b);
    const seen: unknown[] = [];
    for (let tick = 0; tick <= 4; tick += 1) {
      clock = t + 350 + tick * TICK_MS;
      await h.step(waiting(), truncated, bashTop(bInput));
      seen.push([h.verdicts.get(a.key), h.verdicts.get(b.key), cardOf(h, b.key)]);
    }
    expect(seen).toEqual(seen.map(() => ['brak:transkrypt-brak', 'stoi', button ? PENDING_BUTTON : PENDING_NO_BUTTON]));
    expect([stateOf(h, a.key), stateOf(h, b.key)]).toEqual([
      { state: 'revoked', cause: 'dialog-gone' }, { state: 'pending', cause: null },
    ]);
    expect(existsSync(dumpPath(h.dir, a.key))).toBe(true);
    return { a, b, truncated };
  }

  it.each<[string, { readonly command: string }, readonly OpenToolUse[], boolean]>([
    ['B bez wpisu: reguła skrótu wejścia', BASH_B, [openTool('Bash', BASH_A)], true],
    ['B z wpisem przy ekranie z jednym dialogiem: reguła kolejki', BASH_B,
      [openTool('Bash', BASH_A), openTool('Bash', BASH_B)], true],
    ['B z wejściem A, bez własnego wpisu: reguła bliźniaków', BASH_A, [openTool('Bash', BASH_A)], false],
  ])('utracony `Bash` A po `revoked: dialog-gone`, hook A żywy, %s → B `stoi` w trzech taktach po odwołaniu A, po 5 s'
    + ' bez `dialog-gone`; przycisk i `decide(B, allow)` = `sent` przy komendzie B innej niż A (z komendą A zrzut A'
    + ' zostaje w puli: bez przycisku, S3a-6i-B1a); śmierć hooka A zapomina jego rejestrację, rekord A bez zmian',
  async (_name, bInput, open, button) => {
    const h = await harness();
    clock = Date.parse('2026-11-08T23:00:00.000Z');
    const { a, b, truncated } = await lostRevoked(h, bInput, open, button);
    const after: unknown[] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      clock += TICK_MS;
      await h.step(waiting(), truncated, bashTop(bInput));
      after.push([h.verdicts.get(a.key), h.verdicts.get(b.key), cardOf(h, b.key)]);
    }
    expect(after).toEqual(after.map(() => ['brak:transkrypt-brak', 'stoi', button ? PENDING_BUTTON : PENDING_NO_BUTTON]));
    expect(clock - b.at).toBeGreaterThanOrEqual(ORPHAN_TRANSCRIPT_MIN_AGE_MS + 3 * TICK_MS);
    expect(stateOf(h, b.key)).toEqual({ state: 'pending', cause: null });
    expect(await h.cycle.decide(SESSION, b.key, 'allow')).toEqual(button ? { ok: true, state: 'sent' } : REFUSED);
    expect(existsSync(answerPath(h.dir, b.key, '.json'))).toBe(button);
    // Śmierć hooka A (zrzut z faktem utraty) dochodzi do cyklu jak zwykle: rejestracja zapomniana, rekord bez zmian.
    expect(h.reg.entry(SESSION, a.key)).not.toBeNull();
    h.life.set(a.pid, false);
    clock += TICK_MS;
    await h.step(waiting(), truncated, bashTop(bInput));
    expect(h.verdicts.get(a.key)).toBe('brak:hook-martwy');
    expect(h.reg.entry(SESSION, a.key)).toBeNull();
    expect(stateOf(h, a.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
  });

  it('A `sent` z faktem utraty z granicy powrotu gniazda (`re-attached` po wysłaniu): surowy sygnał (`stoi`), śmierć'
    + ' hooka przed przejęciem → plik odpowiedzi odwołany, `revoked: hook-dead`, rejestracja zapomniana',
  async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T23:10:00.000Z');
    const a = syntheticDump('sent-utracony', 'Bash', BASH_A);
    hookStarts(h, a);
    const open: TranscriptToolUses = { open: [openTool('Bash', BASH_A)], closed: [], lostAt: null };
    await h.step(waiting(), open, TOP_A);
    expect(await h.cycle.decide(SESSION, a.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    clock += 100;
    await reattach(h);
    clock += TICK_MS;
    await h.step(waiting(), open, TOP_A);
    // Fakt utraty jest (hook przed granicą), a rekord `sent` idzie za surowym sygnałem.
    expect(h.cycle.proofLost(SESSION, { key: 'bez-rekordu', startedAt: a.startedAt })).toBe(true);
    expect(h.cycle.proofLost(SESSION, a)).toBe(false);
    expect(h.verdicts.get(a.key)).toBe('stoi');
    expect(stateOf(h, a.key)).toEqual({ state: 'sent', cause: null });
    // Proces hooka ginie, zanim przejmie plik: zrzut zostaje, a `ps` mówi „nie żyje”.
    h.life.set(a.pid, false);
    clock += TICK_MS;
    await h.step(waiting(), open, TOP_A);
    expect(h.verdicts.get(a.key)).toBe('brak:hook-martwy');
    expect(stateOf(h, a.key)).toEqual({ state: 'revoked', cause: 'hook-dead' });
    expect([existsSync(answerPath(h.dir, a.key, '.json')), existsSync(answerPath(h.dir, a.key, '.revoked'))])
      .toEqual([false, true]);
    expect(h.reg.entry(SESSION, a.key)).toBeNull();
  });

  it('A `claimed` z faktem utraty (`re-attached` po odbiorze), hook żywy: surowy sygnał (`stoi`), dialog znika'
    + ' (rejestr bez `waiting` po zapasie) → `gone` przesuwa do `running`, a `running` dalej za surowym'
    + ' sygnałem', async () => {
    const h = await harness();
    clock = Date.parse('2026-11-08T23:20:00.000Z');
    const a = syntheticDump('claimed-gone', 'Bash', BASH_A);
    hookStarts(h, a);
    const open: TranscriptToolUses = { open: [openTool('Bash', BASH_A)], closed: [], lostAt: null };
    await h.step(waiting(), open, TOP_A);
    expect(await h.cycle.decide(SESSION, a.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    renameSync(answerPath(h.dir, a.key, '.json'), answerPath(h.dir, a.key, '.claimed'));
    await h.cycle.tick();
    expect(stateOf(h, a.key)).toEqual({ state: 'claimed', cause: null });
    clock += 100;
    await reattach(h);
    clock += TICK_MS;
    await h.step(waiting(), open, TOP_A);
    expect(h.cycle.proofLost(SESSION, { key: 'bez-rekordu', startedAt: a.startedAt })).toBe(true);
    expect(h.cycle.proofLost(SESSION, a)).toBe(false);
    expect(h.verdicts.get(a.key)).toBe('stoi');
    expect(stateOf(h, a.key)).toEqual({ state: 'claimed', cause: null });
    // Odpowiedź wykonana: rejestr bez `waiting` odczytany po zapasie od zrzutu, hook jeszcze żyje.
    clock += TICK_MS;
    await h.step(active(), open, TOP_A);
    expect(h.verdicts.get(a.key)).toBe('brak:rejestr-nie-czeka');
    expect(stateOf(h, a.key)).toEqual({ state: 'running', cause: null });
    clock += TICK_MS;
    await h.step(waiting(), open, TOP_A);
    expect(h.cycle.proofLost(SESSION, a)).toBe(false);
    expect(h.verdicts.get(a.key)).toBe('stoi');
    expect(stateOf(h, a.key)).toEqual({ state: 'running', cause: null });
  });

  it('wejście cienia (bez opcji warstwy 1): przypadki A/B z otwartym wpisem A bez zmian (`transkrypt-skrot`,'
    + ' `kolejka`, bliźniaki), werdykty i sieroty po 5 s', () => {
    const a = syntheticDump('cien-a', 'Bash', BASH_A);
    const b = syntheticDump('cien-b', 'Bash', BASH_B);
    const twin = syntheticDump('cien-blizniak', 'Bash', BASH_A);
    clock += ORPHAN_TRANSCRIPT_MIN_AGE_MS;
    const openA = [openTool('Bash', BASH_A)];
    const cases: [EvidenceInput, string[], string[]][] = [
      [evidence([a, b], { transcript: openA }), ['stoi', 'brak:transkrypt-skrot'], ['transkrypt-skrot']],
      [evidence([a, b], { transcript: [...openA, openTool('Bash', BASH_B)] }), ['brak:kolejka', 'brak:kolejka'], []],
      [evidence([a, twin], { transcript: openA }), ['niejednoznaczny', 'niejednoznaczny'], ['transkrypt-nadmiar']],
    ];
    for (const [input, verdicts, orphanWhy] of cases) {
      expect(input.layer1).toBeUndefined();
      expect(kinds(input)).toEqual(verdicts);
      expect(orphans(input)).toEqual(orphanWhy);
    }
  });

  /*
   * Card A revoked before the transcript passed its key has no loss fact (`notePassed` records it only without
   * a record or at `pending`), so after the file is cut with an open entry A, the raw dump A is compared again. Layer 1
   * has no input-digest rule, and the twin rule makes the oldest dump (A) the orphan, so B loses neither the button
   * nor the card.
   */
  it.each([
    ['B o innej komendzie niż A', BASH_B, TOP_B],
    ['B identyczna z A (bliźniak: sierotą jest najstarszy zrzut, A)', BASH_A, TOP_A],
  ] as const)('karta A odwołana rejestrem bez `waiting`, zanim transkrypt minął jej klucz, hook A żyje, plik skrócony'
    + ' z otwartym wpisem A, potem prośba B bez wpisu: %s → B po 5 s od zrzutu dalej `pending` z przyciskiem',
  async (_name, bInput, bTop) => {
    const h = await harness();
    const a = syntheticDump('droga-a', 'Bash', BASH_A);
    hookStarts(h, a);
    const openA: TranscriptToolUses = { open: [openTool('Bash', BASH_A)], closed: [], lostAt: null };
    await h.step(waiting(), openA, TOP_A);
    expect(cardOf(h, a.key)).toEqual({ state: 'pending', canAllow: true });
    // Decyzja przy biurku: narzędzie A biegnie dłużej niż takt, rejestr bez `waiting` po zapasie od zrzutu A.
    clock = a.at + REGISTRY_SLACK_MS + 100;
    await h.step(active(), openA);
    expect(stateOf(h, a.key)).toEqual({ state: 'revoked', cause: 'dialog-gone' });
    // Wynik A w transkrypcie przy rekordzie odwołanym: faktu utraty nie ma.
    clock += TICK_MS;
    await h.step(active(), { open: [], closed: [closedTool('Bash', BASH_A, clock - 100)], lostAt: null });
    expect(h.cycle.proofLost(SESSION, a)).toBe(false);
    // Skrócenie pliku: otwarty wpis A wraca, nowy czytnik zna utratę pokrycia do chwili skrócenia.
    clock += TICK_MS;
    const truncatedAt = clock;
    clock += TICK_MS;
    const b = syntheticDump('droga-b', 'Bash', bInput);
    expect(b.startedAt).toBeGreaterThan(truncatedAt);
    hookStarts(h, b);
    const reopened: TranscriptToolUses = { open: [openTool('Bash', BASH_A)], closed: [], lostAt: truncatedAt };
    await h.step(waiting(), reopened, bTop);
    expect(cardOf(h, b.key)).toEqual({ state: 'pending', canAllow: true });
    const seen = await ticksUntil(h, b.key, b.at + ORPHAN_TRANSCRIPT_MIN_AGE_MS + TICK_MS, reopened, bTop);
    expect(clock - b.at).toBeGreaterThanOrEqual(ORPHAN_TRANSCRIPT_MIN_AGE_MS);
    expect(seen).toEqual(seen.map(() => ({ state: 'pending', canAllow: true })));
    expect(stateOf(h, b.key)).toEqual({ state: 'pending', cause: null });
  });
});
