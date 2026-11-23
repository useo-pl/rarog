/**
 * Dowód ukryty prośby subagenta w tle: reguła dowodu ukrytego w kodzie produkcyjnym.
 *
 * Zdania, których pilnuje plik:
 *
 * - przy `all` prośba subagenta w tle (start `async_launched` w pliku głównym), z żywym hookiem, rejestracją, plikami
 *   znanymi do końca bez zamknięcia, ekranem bez jej dopasowania, świeżym rejestrem `busy` i listą hooków sesji
 *   z samym hookiem Raroga dostaje kartę z przyciskiem, a zgoda niesie `proofKind: 'hidden'`;
 * - brak któregoś warunku zabiera dowód ukryty: rejestr `waiting: permission`, nieznany albo starszy niż 5 s; brak
 *   startu w tle (potem powrót do biurka po karencji subagenta); lista hooków nie tylko z hookiem Raroga; plik
 *   subagenta z niedokończoną linią albo niedoczytany; plik główny z niedokończoną linią albo z pełną linią
 *   nieczytelnego JSON-u; fakty starsze niż termin przy decyzji;
 * - zamknięcia: wynik w pliku subagenta, odmowa przy biurku (Esc w widoku subagenta) i skrót zatrzymania agentów
 *   (zmierzone na CLI 2.1.319) zabierają dowód, a spóźnione `decide('allow')` nie ma skutku; meldunek
 *   `<task-notification>` z `killed` zabiera dowód, a meldunek sprzed startu hooka (wznowienie) nie;
 * - jeden odczyt ekranu z dopasowaniem zabiera dowód ukryty na stałe, a obserwacja z faktami sprzed tego odczytu,
 *   skończona po nim, go nie przywraca;
 * - zmiana trybu na `main` po obserwacji: zgoda odmówiona jak dziś poza `all`;
 * - `CONSENT_SUBAGENT_GRACE_MS` wynosi 10 s (pomiar na CLI 2.1.319, 10 z 10).
 *
 * Pliki sesji to linie fixture'ów subagentów (CLI 2.1.319): `background-hidden-1` (subagent w tle, zgoda hookiem) z wejściem `Bash`
 * zamienionym na komendę ramki `foreground-subagent` (ekran z dopasowaniem) i `background-stop-1` (wynik przerwania w pliku
 * subagenta: ten sam ślad po Esc w widoku subagenta i po skrócie zatrzymania). Zrzuty leżą na dysku w katalogu danych
 * testu, `ps` to atrapa, cykl, rejestr, czytnik plików subagentów i przegląd dowodów są prawdziwe, z zegarem testu.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsentEvidenceReview, nodeConsentEvidenceIo } from '../src/herdr/consent-evidence.ts';
import { createSubagentObservation } from '../src/herdr/consent-subagent.ts';
import type { SubagentObservation } from '../src/herdr/consent-subagent.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_DIRNAME, CONSENT_EVIDENCE_SCAN_MAX_BYTES, CONSENT_PROOF_TTL_MS, CONSENT_SECRET_BYTES,
  CONSENT_SUBAGENT_GRACE_MS,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle, ConsentObservedSignal } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';
import { createConsentTopLoss, observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentSessionObservation, ConsentTopLoss } from '../src/herdr/dialogs/layer1/observe.ts';
import { readConsentRecords } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import { matchTop } from '../src/herdr/dialogs/layer1/top.ts';
import type { ConsentScreenRead } from '../src/herdr/dialogs/layer1/top.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DOWOD = join(REPO, 'server', 'test', 'fixtures', 'consent-dowod');
const fixture = (name: string): string => readFileSync(join(DOWOD, name), 'utf8');
const linesOf = (name: string): string[] => fixture(name).split('\n').filter((line) => line !== '');

const HOOK = JSON.parse(fixture('background-hidden-1.hook.json')) as {
  session_id: string; prompt_id: string; agent_id: string; cwd: string;
};
const SESSION = HOOK.session_id;
const PROMPT = HOOK.prompt_id;
const AGENT = HOOK.agent_id;
/** Wejście ramki `foreground-subagent` (ekran z dopasowaniem). */
const INPUT = { command: 'echo fg-1 >> fg-1.txt', description: 'fg-1' };
const SCREEN_MATCH = fixture('foreground-subagent.ekran.txt');
/** Ekran przy biurku z dialogiem wątku głównego przy czekającej ukrytej prośbie (zmierzone na CLI 2.1.319). */
const SCREEN_OTHER = fixture('main-beside-hidden.ekran.txt');
const BOOT = 'boot-ukryty-2';
const SUB_TOOL_USE_ID = 'toolu_000000000000000000000004';

/** Wpis z wejściem `tool_use` zamienionym na {@link INPUT}. */
function withInput(line: string): string {
  const entry = JSON.parse(line) as { message?: { content?: { type?: string; input?: unknown }[] } };
  for (const block of entry.message?.content ?? []) if (block.type === 'tool_use') block.input = INPUT;
  return JSON.stringify(entry);
}

/** Wpis z chwilą `at` (ms epoki). */
function at(line: string, when: number): string {
  return JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), timestamp: new Date(when).toISOString() });
}

const MAIN = linesOf('background-hidden-1.glowny.jsonl');
const SUB = linesOf('background-hidden-1.subagent.jsonl');
const LAUNCH_INDEX = MAIN.findIndex((line) => line.includes('"async_launched"'));
/** Plik główny przy czekającej prośbie: do końca tury głównej, bez meldunku o końcu subagenta. */
const MAIN_WAIT = MAIN.slice(0, MAIN.findIndex((line) => line.includes('<task-notification>')));
/** Meldunek o końcu subagenta (`queue-operation`, przypomnienie, wpis `user` z `<task-notification>`). */
const MAIN_NOTIFY = MAIN.slice(MAIN_WAIT.length).filter((line) => !line.includes('"type":"assistant"')
  && !line.includes('"type":"system"'));
const SUB_WAIT = [SUB[0] ?? '', withInput(SUB[1] ?? '')];
const SUB_USE_AT = Date.parse(String((JSON.parse(SUB[1] ?? '{}') as { timestamp?: string }).timestamp));
/** Start hooka: 70 ms po linii `tool_use` w pliku subagenta (zmierzone 69–139 ms). */
const HOOK_START = SUB_USE_AT + 70;
/** Wynik zgody hookiem w pliku subagenta (`hook_permission_decision`, `tool_result`, odpowiedź). */
const SUB_RESULT = SUB.slice(2);

/** Ślad przerwania w pliku subagenta (`background-stop-1`): `tool_result` z `is_error` i wpis przerwania. */
function subInterrupted(when: number): string[] {
  const s = linesOf('background-stop-1.subagent.jsonl');
  const sHook = JSON.parse(fixture('background-stop-1.hook.json')) as { session_id: string; agent_id: string };
  const useId = /"id":"(toolu_\d+)"/.exec(s[2] ?? '')?.[1] ?? '';
  return s.slice(3).map((line) => at(line.replaceAll(sHook.agent_id, AGENT).replaceAll(sHook.session_id, SESSION)
    .replaceAll(useId, SUB_TOOL_USE_ID), when));
}

/** Wpisy pliku głównego po skrócie zatrzymania agentów (`background-stop-1`): tekst bez `<task-id>`. */
function mainStopped(when: number): string[] {
  const sHook = JSON.parse(fixture('background-stop-1.hook.json')) as { session_id: string };
  return linesOf('background-stop-1.glowny.jsonl').filter((line) => line.includes('was stopped by the user'))
    .map((line) => at(line.replaceAll(sHook.session_id, SESSION), when));
}

/** Sufit przebiegu większy niż plik główny i niż plik subagenta bez dopisku (przypadek `caughtUp: false`). */
const PADDED_MAX_BYTES = 32 * 1024;

let clock = HOOK_START + 1_000;
const now = (): number => clock;

const dirs: string[] = [];
beforeEach(() => {
  clock = HOOK_START + 1_000;
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const busy = (when = clock): RegistryEvidence => ({ kind: 'active', at: when });
const waitingPermission = (when = clock): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at: when });

function dumpOf(seed: string, over: Partial<HookCallDump> = {}): HookCallDump {
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return {
    key: `${PROMPT}-${nonce}`, sessionId: SESSION, promptId: PROMPT, agentId: AGENT, pid: process.pid,
    startedAt: HOOK_START, toolName: 'Bash', toolInput: INPUT, cwd: HOOK.cwd, at: HOOK_START + 100,
    inputSha256: canonicalSha256(INPUT), permissionMode: 'default', ...over,
  };
}

type Tryb = Extract<ConsentEffectiveMode, 'main' | 'all'>;

interface Harness {
  readonly dir: string;
  readonly main: string;
  readonly sub: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly mode: { tryb: Tryb };
  readonly subagents: SubagentObservation;
  readonly topLoss: ConsentTopLoss;
  /** Hook z listy hooków sesji (atrapa źródła; samą listę sprawdza `consent-hook-list.test.ts`). */
  readonly h8: { ok: boolean };
  /** Hook żyje według `ps`. */
  readonly alive: { value: boolean };
  /** Ostatni sygnał per klucz, z którym obserwacja woła cykl. */
  readonly signals: Map<string, ConsentObservedSignal>;
  readonly observations: ConsentSessionObservation[];
}

function harness(opts: { main?: readonly string[]; sub?: readonly string[]; maxBytes?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-ukryty-'));
  dirs.push(dir);
  const main = join(dir, 'projekt', `${SESSION}.jsonl`);
  const sub = join(dir, 'projekt', SESSION, 'subagents', `agent-${AGENT}.jsonl`);
  mkdirSync(dirname(sub), { recursive: true });
  writeFileSync(main, `${(opts.main ?? MAIN_WAIT).join('\n')}\n`);
  writeFileSync(sub, `${(opts.sub ?? SUB_WAIT).join('\n')}\n`);
  const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope('all');
  const mode: { tryb: Tryb } = { tryb: 'all' };
  const started = clock;
  clock = started - 10_000;
  const cycle = createConsentCycle({ dataDir: dir, bootId: BOOT, registry: reg, now, mode: () => mode.tryb, log: () => {} });
  clock = started;
  const subagents = createSubagentObservation({
    io: nodeConsentEvidenceIo, locate: async () => main, agentFiles: true,
    maxBytes: opts.maxBytes ?? CONSENT_EVIDENCE_SCAN_MAX_BYTES,
  });
  return {
    dir, main, sub, reg, cycle, mode, subagents, topLoss: createConsentTopLoss(), h8: { ok: true },
    alive: { value: true }, signals: new Map(), observations: [],
  };
}

function hookStarts(h: Harness, dump: HookCallDump): void {
  const path = join(h.dir, HOOK_PENDING_DIRNAME, SESSION, `${dump.key}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(dump), { mode: 0o600 });
  const result = h.reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId,
    secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: dump.inputSha256,
    cardSha256: consentCardSha256({
      sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
      agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
    }),
    pid: dump.pid, startedAt: dump.startedAt, ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
  });
  expect(result.status).toBe(200);
}

/** Hook wyszedł: zrzut znika, proces nie żyje. */
function hookExits(h: Harness, dump: HookCallDump): void {
  rmSync(join(h.dir, HOOK_PENDING_DIRNAME, SESSION, `${dump.key}.json`), { force: true });
  h.alive.value = false;
}

/**
 * Krok obserwacji przy `all`: źródła jak w serwerze (pliki subagentów, pamięć utraty wierzchu, lista hooków), `screen`
 * = odczyt ekranu (domyślnie brak), `gate` = cykl dostaje sygnały dopiero po jej otwarciu.
 */
async function step(h: Harness, opts: {
  registry?: RegistryEvidence; screen?: ConsentScreenRead | null; gate?: Promise<void>;
} = {}): Promise<ConsentSessionObservation> {
  const liveness: ProcessLiveness = async (processes) => new Map(processes.map((proc) => [proc.pid, h.alive.value]));
  const cycle: Parameters<typeof observeConsentSession>[0] = {
    ...h.cycle,
    observe: async (sessionId, key, signal, ...rest) => {
      await opts.gate;
      h.signals.set(key, signal);
      return h.cycle.observe(sessionId, key, signal, ...rest);
    },
  };
  const observation = await observeConsentSession(cycle, {
    dataDir: h.dir, sessionId: SESSION, liveness, registry: opts.registry ?? busy(), transcript: null,
    screen: opts.screen ?? null, now,
    subagentTurns: (requests) => h.subagents.read(SESSION, requests),
    hidden: {
      topLoss: h.topLoss,
      sessionHooks: async (_sid, dumps) => new Set(h.h8.ok ? dumps.map((dump) => dump.key) : []),
    },
  });
  h.observations.push(observation);
  return observation;
}

const answerPath = (h: Harness, key: string): string => join(h.dir, CONSENT_DIRNAME, SESSION, `${key}.json`);

/** Przegląd dowodów serwera (1b) nad plikami sceny. */
const reviewOf = (h: Harness): { tick: () => Promise<void> } => createConsentEvidenceReview({
  cycle: h.cycle, locate: async () => h.main, now, intervalMs: 0, log: () => {},
});
const NO_BUTTON = { state: 'pending', canAllow: false, unavailable: 'no-proof' };

/** Prośba z dowodem ukrytym: karta z przyciskiem po jednej obserwacji. */
async function hiddenCard(h: Harness, seed: string): Promise<HookCallDump> {
  const dump = dumpOf(seed);
  hookStarts(h, dump);
  await step(h);
  expect(h.signals.get(dump.key)).toBe('hidden');
  expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
  return dump;
}

describe('dowód ukryty z reguły dowodu ukrytego', () => {
  it('prośba `bg` z kompletem warunków: `hidden`, karta z przyciskiem, zgoda z `proofKind: hidden`', async () => {
    const h = harness();
    const dump = dumpOf('komplet');
    hookStarts(h, dump);
    expect(matchTop(SCREEN_OTHER, dump)).not.toBe('match');
    await step(h, { screen: { text: SCREEN_OTHER, readStartedAt: clock - 300 } });
    expect(h.observations.at(-1)?.hidden).toEqual(new Set([dump.key]));
    expect(h.signals.get(dump.key)).toBe('hidden');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: true, state: 'sent' });
    expect(existsSync(answerPath(h, dump.key))).toBe(true);
    expect(readConsentRecords(h.dir).find((record) => record.key === dump.key))
      .toMatchObject({ state: 'sent', decision: 'allow', proofKind: 'hidden' });
  });

  it('rejestr `waiting: permission` (w sesji stoi dialog zgody): bez dowodu ukrytego', async () => {
    const h = harness();
    const dump = dumpOf('rejestr-waiting');
    hookStarts(h, dump);
    await step(h, { registry: waitingPermission() });
    expect(h.signals.get(dump.key)).toBe('unknown');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
  });

  it.each([
    ['nieznany', (): RegistryEvidence => ({ kind: 'unknown', why: 'unread' })],
    ['starszy niż 5 s', (): RegistryEvidence => busy(clock - 5_001)],
  ])('rejestr %s: bez dowodu ukrytego', async (opis, registry) => {
    const h = harness();
    const dump = dumpOf(`rejestr-${opis}`);
    hookStarts(h, dump);
    await step(h, { registry: registry() });
    expect(h.observations.at(-1)?.hidden.size).toBe(0);
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
  });

  it('bez wyniku `async_launched` w pliku głównym (`fg-or-unknown`): bez dowodu, potem `desk-fallback`', async () => {
    const h = harness({ main: MAIN_WAIT.filter((_line, index) => index !== LAUNCH_INDEX) });
    const dump = dumpOf('bez-startu-w-tle');
    hookStarts(h, dump);
    await step(h);
    expect(h.signals.get(dump.key)).toBe('unknown');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
    clock += CONSENT_SUBAGENT_GRACE_MS;
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({
      state: 'sent', decision: 'release', releaseCause: 'desk-fallback',
    });
  });

  it('lista hooków sesji nie tylko z hookiem Raroga: bez dowodu ukrytego', async () => {
    const h = harness();
    h.h8.ok = false;
    const dump = dumpOf('bez-h8');
    hookStarts(h, dump);
    await step(h);
    expect(h.signals.get(dump.key)).toBe('unknown');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
  });

  it.each([
    ['plik subagenta z niedokończoną linią', (h: Harness): void => {
      appendFileSync(h.sub, '{"type":"user","isSidechain":true');
    }],
    // Linia dłuższa niż sufit jednego przebiegu (plik główny mieści się w nim cały): przebieg kończy się przed końcem.
    ['plik subagenta niedoczytany (`caughtUp: false`)', (h: Harness): void => {
      appendFileSync(h.sub, `${JSON.stringify({
        type: 'progress', isSidechain: true, agentId: AGENT, sessionId: SESSION, timestamp: new Date(HOOK_START).toISOString(),
        data: 'x'.repeat(PADDED_MAX_BYTES),
      })}\n`);
    }],
    ['plik główny z niedokończoną linią', (h: Harness): void => {
      appendFileSync(h.main, '{"type":"queue-operation"');
    }],
    // Pełna linia (zakończona `\n`), której nie da się sparsować, to nieczytelny JSON, nie „ostatni bajt `\n`”.
    ['plik główny z pełną linią nieczytelnego JSON-u', (h: Harness): void => {
      appendFileSync(h.main, '{"type":"queue-operation"\n');
    }],
  ])('%s: bez dowodu ukrytego', async (opis, damage) => {
    const h = harness({ maxBytes: PADDED_MAX_BYTES });
    damage(h);
    const dump = dumpOf(`niedoczytany-${opis}`);
    hookStarts(h, dump);
    await step(h);
    expect(h.observations.at(-1)?.hidden.size).toBe(0);
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
  });

  it('ten sam plik bez uszkodzenia przy tym samym suficie przebiegu: dowód ukryty (kontrola przypadków wyżej)',
    async () => {
      const h = harness({ maxBytes: PADDED_MAX_BYTES });
      await hiddenCard(h, 'kontrola-sufitu');
    });

  it('fakty sprzed 2,5 s (odczyt rejestru otwierający obserwację): przy decyzji odmowa podpisu', async () => {
    const h = harness();
    const dump = dumpOf('stary-odczyt');
    hookStarts(h, dump);
    await step(h, { registry: busy(clock - 2_500) });
    expect(h.signals.get(dump.key)).toBe('hidden');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: false, error: 'card-changed' });
    // Świeża obserwacja daje przycisk, a decyzja po terminie faktów jest odmówiona.
    await step(h);
    expect(h.cycle.card(SESSION, dump.key)?.canAllow).toBe(true);
    clock += CONSENT_PROOF_TTL_MS + 500;
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: false, error: 'card-changed' });
    expect(existsSync(answerPath(h, dump.key))).toBe(false);
  });

  it('`tool_result` w pliku subagenta po zgodzie przy biurku: bez dowodu ukrytego, potem `settled-at-desk`',
    async () => {
      const h = harness();
      const dump = await hiddenCard(h, 'wynik-przy-biurku');
      clock += 300;
      // Zgoda przy biurku: wynik ze źródłem `user_temporary`, bez załącznika decyzji hooka (kształt jak w 1b).
      const desk = SUB.slice(3).map((line) => at(line.replace('"source":"hook","reasonType":"hook","reasonCode":"unknown"',
        '"source":"user_temporary"'), clock - 100));
      expect(desk.some((line) => line.includes('"source":"user_temporary"'))).toBe(true);
      appendFileSync(h.sub, `${desk.join('\n')}\n`);
      expect((await step(h)).hidden.size).toBe(0);
      expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
      hookExits(h, dump);
      await step(h);
      appendFileSync(h.main, `${MAIN_NOTIFY.map((line) => at(line, clock)).join('\n')}\n`);
      await reviewOf(h).tick();
      expect(h.cycle.record(SESSION, dump.key)).toMatchObject({
        state: 'settled-at-desk', toolUseId: SUB_TOOL_USE_ID,
      });
    });

  it('`tool_result` w pliku subagenta po zgodzie z telefonu: bez dowodu ukrytego, potem `unknown` (`no-receipt`)', async () => {
    const h = harness();
    const dump = await hiddenCard(h, 'wynik-po-zgodzie');
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: true, state: 'sent' });
    renameSync(answerPath(h, dump.key), answerPath(h, dump.key).replace(/\.json$/, '.claimed'));
    clock += 300;
    appendFileSync(h.sub, `${SUB_RESULT.map((line) => at(line, clock - 100)).join('\n')}\n`);
    expect((await step(h)).hidden.size).toBe(0);
    hookExits(h, dump);
    await step(h);
    appendFileSync(h.main, `${MAIN_NOTIFY.map((line) => at(line, clock)).join('\n')}\n`);
    await reviewOf(h).tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({
      state: 'unknown', cause: 'no-receipt', decision: 'allow', toolUseId: SUB_TOOL_USE_ID, proofKind: 'hidden',
    });
  });

  it.each([
    ['Esc w polu promptu widoku subagenta', false],
    ['skrót zatrzymania agentów', true],
  ])('odmowa przy biurku, %s: wynik przerwania w pliku subagenta → bez dowodu; hook zakończony → karta znika,'
    + ' spóźnione `decide(allow)` bez skutku', async (droga, stopped) => {
    const h = harness();
    const dump = await hiddenCard(h, `biurko-${droga}`);
    clock += 300;
    appendFileSync(h.sub, `${subInterrupted(clock - 100).join('\n')}\n`);
    if (stopped) appendFileSync(h.main, `${mainStopped(clock - 120).join('\n')}\n`);
    // Ślad przerwania zabiera dowód, zanim hook wyjdzie (zamknięcie w pliku subagenta).
    expect((await step(h)).hidden.size).toBe(0);
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
    hookExits(h, dump);
    await step(h);
    await reviewOf(h).tick();
    expect(['revoked', 'settled-at-desk']).toContain(h.cycle.record(SESSION, dump.key)?.state);
    expect(h.cycle.card(SESSION, dump.key)?.canAllow).toBe(false);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: false });
    expect(existsSync(answerPath(h, dump.key))).toBe(false);
    expect(h.cycle.record(SESSION, dump.key)?.decision).not.toBe('allow');
  });

  it('`<task-notification>` z `killed` po starcie hooka: bez dowodu ukrytego', async () => {
    const killed = MAIN_NOTIFY.map((line) => at(line.replaceAll('<status>completed</status>', '<status>killed</status>'),
      HOOK_START + 500));
    expect(killed.some((line) => line.includes('<status>killed</status>'))).toBe(true);
    const h = harness({ main: [...MAIN_WAIT, ...killed] });
    const dump = dumpOf('killed');
    hookStarts(h, dump);
    expect((await step(h)).hidden.size).toBe(0);
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
  });

  it('`<task-notification>` sprzed startu hooka (koniec biegu przed wznowieniem): bez wpływu na dowód', async () => {
    const before = MAIN_NOTIFY.map((line) => at(line, HOOK_START - 500));
    const h = harness({ main: [...MAIN_WAIT, ...before] });
    await hiddenCard(h, 'meldunek-przed');
  });

  it('jeden odczyt ekranu z dopasowaniem zabiera dowód ukryty na stałe; obserwacja z faktami sprzed odczytu,'
    + ' skończona po nim, go nie przywraca', async () => {
    const h = harness();
    const dump = dumpOf('h4');
    hookStarts(h, dump);
    expect(matchTop(SCREEN_MATCH, dump)).toBe('match');
    // Obserwacja A: fakty z chwili `clock`, sygnały do cyklu dopiero po obserwacji B.
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const a = step(h, { gate });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.observations).toHaveLength(0);
    // Obserwacja B: ekran z dopasowaniem, odczyt rozpoczęty po faktach A. Rejestr `busy`, więc dowodu z wierzchu
    // (wymaga `waiting: permission`) też nie ma.
    clock += 200;
    const lostAt = clock - 100;
    const b = await step(h, { screen: { text: SCREEN_MATCH, readStartedAt: lostAt } });
    expect(b.hidden.size).toBe(0);
    expect(h.topLoss.lostAt(SESSION, dump.key)).toBe(lostAt);
    expect(h.signals.get(dump.key)).toBe('unknown');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
    open();
    const fromA = await a;
    // A policzyła dowód przed odczytem B, ale jej sygnał jest starszy niż przyjęty odczyt B: werdykt zostaje z B.
    expect(fromA.hidden).toEqual(new Set([dump.key]));
    expect(h.signals.get(dump.key)).toBe('hidden');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
    // Następne obserwacje bez ekranu: dowodu ukrytego nie ma.
    clock += 500;
    expect((await step(h)).hidden.size).toBe(0);
    expect(h.signals.get(dump.key)).toBe('unknown');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: false });
    expect(existsSync(answerPath(h, dump.key))).toBe(false);
  });

  it('`decide(allow)` po spadku trybu do `main` po obserwacji: odmowa jak dziś poza `all`', async () => {
    const h = harness();
    const dump = await hiddenCard(h, 'tryb-main');
    h.mode.tryb = 'main';
    expect(h.cycle.card(SESSION, dump.key)?.canAllow).toBe(false);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: false, state: 'pending' });
    expect(existsSync(answerPath(h, dump.key))).toBe(false);
  });

  it('karencja subagenta z pomiaru: `CONSENT_SUBAGENT_GRACE_MS` 10 s mieści regułę opóźnienia startu w tle', () => {
    // Reguła: 2 × najdłuższe opóźnienie startu w tle przed hookiem (2005 ms) + 2 s = 6010 ms ≤ 10 s.
    expect(CONSENT_SUBAGENT_GRACE_MS).toBe(10_000);
    expect(2 * 2_005 + 2_000).toBeLessThanOrEqual(CONSENT_SUBAGENT_GRACE_MS);
  });
});
