/**
 * Dowód ukryty w cyklu i obserwacji kanału zgód: hydraulika bez reguły.
 *
 * Zdania, których pilnuje plik:
 *
 * - reguła produkcyjna (`CONSENT_HIDDEN_RULE`) bez faktów pliku subagenta nie daje dowodu: bez
 *   wstrzykniętej reguły prośba subagenta przy `all` bez ekranu zostaje bez przycisku, a cykl nie dostaje sygnału
 *   `hidden` (reguła z faktami: `layer1-hidden.test.ts`);
 * - wejście reguły ma własną chwilę odczytu: najstarszy odczyt faktów (rejestr u wołającego albo początek kroku);
 *   bez źródła faktów subagentów (kanał zamknięty dla subagentów) reguły nikt nie pyta;
 * - wstrzyknięty sygnał „ukryty” daje prośbie subagenta przy `all` kartę z przyciskiem zgody, a `decide('allow')`
 *   podpisuje plik i zapisuje w rekordzie `proofKind: 'hidden'`;
 * - ten sam sygnał starszy niż `CONSENT_PROOF_TTL_MS` przy decyzji, także gdy termin mija między zapisem `deciding`
 *   a podpisem: odmowa (`card-changed`), pliku odpowiedzi nie ma, rekord wraca do `pending` bez `proofKind`;
 *   termin liczy się od najstarszego odczytu faktów, nie od chwili kroku;
 * - przy trybie innym niż `all` (także po zmianie trybu po obserwacji) i dla rekordu wątku głównego sygnał ukryty
 *   przycisku nie daje: wątek główny ma te same karty, rekordy i wyniki co bez reguły, a zgoda z dowodu z wierzchu
 *   niesie `proofKind: 'top'`;
 * - dwa rodzaje dowodu osobno: odczyt starszy od przyjętego nie zmienia werdyktu, nowszy odczyt bez dowodu zabiera
 *   dowód ukryty, a dowód z wierzchu po ukrytym daje zgodę z `proofKind: 'top'`; odmowa i zwolnienie `proofKind` nie
 *   niosą;
 * - rekord z pliku bez pola `proofKind` czyta się bez zmian, a pole w złym kształcie odpada, rekord
 *   zostaje;
 * - `subagentPending`: czy w sesji czeka (`pending`) prośba subagenta.
 *
 * Zrzuty leżą na dysku w katalogu danych testu, `ps` to atrapa (każdy hook żyje), cykl i rejestr są prawdziwe,
 * z zegarem testu.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_DIRNAME, CONSENT_PROOF_TTL_MS, CONSENT_RECORDS_DIRNAME, CONSENT_SECRET_BYTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type {
  ConsentCycle, ConsentCycleIo, ConsentObserved, ConsentObservedSignal,
} from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';
import { NO_HIDDEN_PROOF, observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentHiddenInput, ConsentHiddenRule } from '../src/herdr/dialogs/layer1/observe.ts';
import { readConsentRecords, writeConsentRecord } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256, verifyConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import { matchTop } from '../src/herdr/dialogs/layer1/top.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';
import { topReadOf } from './helpers/dowod-z-odczytem.ts';

const SESSION = '00000000-0000-4000-9000-0000000000d1';
const BOOT = 'boot-ukryty-1';
const AGENT = 'a5d88ad0b14a23c38';
const BASH = { command: 'npm test' };
type Tryb = Extract<ConsentEffectiveMode, 'main' | 'all'>;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let clock = Date.parse('2026-11-09T12:00:00.000Z');
const now = (): number => clock;

/** Zrzut per wywołanie (klucz z `seed`); `agentId` = prośba subagenta. */
function dumpOf(seed: string, over: Partial<HookCallDump> = {}): HookCallDump {
  const promptId = over.promptId ?? '00000000-0000-4000-9000-0000000000aa';
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return {
    key: `${promptId}-${nonce}`, sessionId: SESSION, promptId, pid: process.pid, startedAt: clock - 1_000,
    toolName: 'Bash', toolInput: BASH, cwd: '/tmp/projekt', at: clock - 900, inputSha256: canonicalSha256(BASH),
    permissionMode: 'default', ...over,
  };
}

const busy = (at: number): RegistryEvidence => ({ kind: 'active', at });
const waitingPermission = (at: number): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at });
const alive: ProcessLiveness = async (processes) => new Map(processes.map((proc) => [proc.pid, true]));
/** Reguła wstrzyknięta: dialog stoi ukryty dla wszystkich zrzutów obserwacji. */
const everyKey: ConsentHiddenRule = (input) => new Set(input.evidence.dumps.map((dump) => dump.key));

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  /** Tryb efektywny cyklu (zmienny w teście). */
  readonly mode: { tryb: Tryb };
  /** Wejścia reguły dowodu ukrytego, po kolei. */
  readonly inputs: ConsentHiddenInput[];
  /** Sygnały, z którymi obserwacja woła cykl: `klucz` → ostatni sygnał. */
  readonly signals: Map<string, ConsentObservedSignal>;
}

function harness(tryb: Tryb, io?: Partial<ConsentCycleIo>): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-cykl-ukryty-'));
  dirs.push(dir);
  const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope(tryb);
  const mode = { tryb };
  // Cykl wstał 10 s wcześniej: pula sesji odblokowuje wierzch odczytem rejestru po zapasie od startu serwera.
  const started = clock;
  clock = started - 10_000;
  const cycle = createConsentCycle({
    dataDir: dir, bootId: BOOT, registry: reg, now, mode: () => mode.tryb, log: () => {},
    ...(io === undefined ? {} : { io }),
  });
  clock = started;
  return { dir, reg, cycle, mode, inputs: [], signals: new Map() };
}

/** Hook startuje: zrzut na dysku; `register` = rejestracja sekretu (przy `all` przyjęta, przy `main` dla subagenta nie). */
function hookStarts(h: Harness, dump: HookCallDump, register = true): string {
  const path = join(h.dir, HOOK_PENDING_DIRNAME, SESSION, `${dump.key}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(dump), { mode: 0o600 });
  const secret = randomBytes(CONSENT_SECRET_BYTES).toString('hex');
  const result = h.reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, secret, inputSha256: dump.inputSha256,
    cardSha256: cardShaOf(dump), pid: dump.pid, startedAt: dump.startedAt,
    ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
  });
  if (register) expect(result.status).toBe(200);
  return secret;
}

function cardShaOf(dump: HookCallDump): string {
  return consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
  });
}

/**
 * Krok obserwacji bez ekranu, z kanałem otwartym dla subagentów (fakty plików nieznane) albo bez niego
 * (`subagents: false`); `rule` = reguła dowodu ukrytego (brak = produkcyjna). Sygnały do cyklu zbiera `h.signals`.
 */
async function step(h: Harness, opts: {
  registry?: RegistryEvidence; rule?: ConsentHiddenRule; subagents?: boolean;
} = {}): Promise<void> {
  const cycle: Parameters<typeof observeConsentSession>[0] = {
    ...h.cycle,
    observe: (sessionId, key, signal, ...rest) => {
      h.signals.set(key, signal);
      return h.cycle.observe(sessionId, key, signal, ...rest);
    },
  };
  const rule = opts.rule;
  await observeConsentSession(cycle, {
    dataDir: h.dir, sessionId: SESSION, liveness: alive, registry: opts.registry ?? busy(clock), transcript: null,
    screen: null, now,
    ...(opts.subagents === false ? {} : { subagentTurns: async (requests) => requests.map(() => null) }),
    ...(rule === undefined ? {} : {
      hiddenRule: (input: ConsentHiddenInput) => { h.inputs.push(input); return rule(input); },
    }),
  });
}

/** Odczyt faktów dowodu ukrytego z chwili `at` (wejście `cycle.observe` z sygnałem `hidden`). */
function hiddenAt(at: number): ConsentObserved {
  return { at, until: null, screen: null, matchTop, hidden: { at, until: at + CONSENT_PROOF_TTL_MS } };
}

/** Obserwacja bez ekranu i bez faktów dowodu ukrytego z chwili `at`. */
function plainAt(at: number): ConsentObserved {
  return { at, until: null, screen: null, matchTop, hidden: null };
}

const answerPath = (h: Harness, key: string): string => join(h.dir, CONSENT_DIRNAME, SESSION, `${key}.json`);
const recordPath = (h: Harness, key: string): string => join(h.dir, CONSENT_RECORDS_DIRNAME, SESSION, `${key}.json`);
const onDisk = (h: Harness, key: string): ReturnType<typeof readConsentRecords>[number] | undefined =>
  readConsentRecords(h.dir).find((record) => record.key === key);

describe('reguła produkcyjna bez faktów pliku subagenta: bez dowodu ukrytego', () => {
  it('bez wstrzykniętej reguły prośba subagenta przy `all` bez ekranu: `no-proof`, sygnał do cyklu bez `hidden`',
    async () => {
      const h = harness('all');
      const dump = dumpOf('produkcja', { agentId: AGENT });
      hookStarts(h, dump);
      await step(h);
      expect(h.signals.get(dump.key)).toBe('unknown');
      expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
      expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    });

  it('wejście reguły: chwila najstarszego odczytu faktów (rejestr sprzed kroku albo początek kroku); bez źródła'
    + ' faktów subagentów reguły nikt nie pyta', async () => {
    const h = harness('all');
    const dump = dumpOf('wejscie', { agentId: AGENT });
    hookStarts(h, dump);
    await step(h, { rule: NO_HIDDEN_PROOF, registry: busy(clock - 1_500) });
    expect(h.inputs.map((input) => input.readAt)).toEqual([clock - 1_500]);
    expect(h.signals.get(dump.key)).toBe('unknown');
    expect(h.inputs[0]?.evidence.dumps.map((one) => one.key)).toEqual([dump.key]);
    expect(h.inputs[0]?.top).toBeNull();
    // Rejestr nieznany: chwila początku kroku.
    await step(h, { rule: NO_HIDDEN_PROOF, registry: { kind: 'unknown', why: 'unread' } });
    expect(h.inputs.at(-1)?.readAt).toBe(clock);
    // Kanał zamknięty dla subagentów (`main`, proces pomiaru bez `all`): bez pytania o regułę i bez sygnału `hidden`.
    const count = h.inputs.length;
    await step(h, { rule: everyKey, subagents: false });
    expect(h.inputs).toHaveLength(count);
    expect(h.signals.get(dump.key)).not.toBe('hidden');
  });
});

describe('wstrzyknięty sygnał „ukryty”', () => {
  it('prośba subagenta przy `all`: karta z przyciskiem zgody, `decide(allow)` podpisuje plik, rekord `proofKind:'
    + ' hidden` w pamięci i na dysku', async () => {
    const h = harness('all');
    const dump = dumpOf('ukryty-zgoda', { agentId: AGENT });
    const secret = hookStarts(h, dump);
    await step(h, { rule: everyKey });
    expect(h.signals.get(dump.key)).toBe('hidden');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({
      state: 'pending', agentId: AGENT, canAllow: true, canDeny: true, unavailable: null,
    });
    expect(h.cycle.subagentPending(SESSION)).toBe(true);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'sent', decision: 'allow', proofKind: 'hidden' });
    expect(onDisk(h, dump.key)).toMatchObject({ state: 'sent', decision: 'allow', proofKind: 'hidden' });
    expect(verifyConsentFile(JSON.parse(readFileSync(answerPath(h, dump.key), 'utf8')), {
      secret, sessionId: SESSION, key: dump.key, inputSha256: dump.inputSha256, cardSha256: cardShaOf(dump),
      notBefore: dump.startedAt - 60_000,
    })).toMatchObject({ ok: true, file: { decision: 'allow', reasonId: 'allow' } });
    expect(h.cycle.subagentPending(SESSION)).toBe(false);
  });

  it('ten sam sygnał starszy niż 2 s przy decyzji: karta bez przycisku, `decide(allow)` odmówione, pliku nie ma',
    async () => {
      const h = harness('all');
      const dump = dumpOf('ukryty-stary', { agentId: AGENT });
      hookStarts(h, dump);
      const t0 = clock;
      await step(h, { rule: everyKey });
      clock = t0 + CONSENT_PROOF_TTL_MS - 1;
      expect(h.cycle.card(SESSION, dump.key)?.canAllow).toBe(true);
      clock = t0 + CONSENT_PROOF_TTL_MS;
      expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false, canDeny: true });
      expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
      expect(existsSync(answerPath(h, dump.key))).toBe(false);
      expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'pending', decision: null });
      expect(h.cycle.record(SESSION, dump.key)?.proofKind).toBeUndefined();
      clock = t0;
    });

  it('termin dowodu ukrytego mija między zapisem `deciding` a podpisem: drugie sprawdzenie odmawia, rekord wraca do'
    + ' `pending` bez `proofKind`, pliku nie ma', async () => {
    const t0 = clock;
    const states: string[] = [];
    const h = harness('all', {
      writeRecord: (dataDir, record, options) => {
        states.push(record.state);
        // Zapis `deciding` z `fsync` trwa tyle, że termin dowodu mija przed podpisem.
        if (record.state === 'deciding') clock = t0 + CONSENT_PROOF_TTL_MS;
        writeConsentRecord(dataDir, record, options);
      },
    });
    const dump = dumpOf('ukryty-podpis', { agentId: AGENT });
    hookStarts(h, dump);
    await step(h, { rule: everyKey });
    expect(h.cycle.card(SESSION, dump.key)?.canAllow).toBe(true);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    // Zapis `deciding` był, po nim rekord wrócił do `pending`.
    expect(states.indexOf('deciding')).toBeGreaterThan(-1);
    expect(states.slice(states.indexOf('deciding') + 1)).toContain('pending');
    expect(states.at(-1)).toBe('pending');
    expect(existsSync(answerPath(h, dump.key))).toBe(false);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'pending', decision: null });
    expect(h.cycle.record(SESSION, dump.key)?.proofKind).toBeUndefined();
    expect(onDisk(h, dump.key)?.proofKind).toBeUndefined();
    clock = t0;
  });

  it('termin liczy się od najstarszego odczytu faktów: rejestr przeczytany 1,5 s przed krokiem daje 0,5 s dowodu',
    async () => {
      const h = harness('all');
      const dump = dumpOf('ukryty-rejestr', { agentId: AGENT });
      hookStarts(h, dump);
      const t0 = clock;
      await step(h, { rule: everyKey, registry: busy(t0 - 1_500) });
      expect(h.cycle.card(SESSION, dump.key)?.canAllow).toBe(true);
      clock = t0 + 500;
      expect(h.cycle.card(SESSION, dump.key)?.canAllow).toBe(false);
      expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
      clock = t0;
    });

  it('przy `main` prośba subagenta zostaje `terminal-only`; zmiana trybu na `main` po obserwacji zabiera przycisk'
    + ' przed decyzją', async () => {
    const main = harness('main');
    const sub = dumpOf('ukryty-main', { agentId: AGENT });
    hookStarts(main, sub, false);
    await step(main, { rule: everyKey });
    expect(main.cycle.card(SESSION, sub.key)).toMatchObject({
      state: 'pending', canAllow: false, canDeny: false, unavailable: 'terminal-only',
    });

    const h = harness('all');
    const dump = dumpOf('ukryty-zmiana-trybu', { agentId: AGENT });
    hookStarts(h, dump);
    await step(h, { rule: everyKey });
    expect(h.cycle.card(SESSION, dump.key)?.canAllow).toBe(true);
    h.mode.tryb = 'main';
    expect(h.cycle.card(SESSION, dump.key)?.canAllow).toBe(false);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: false, state: 'pending' });
    expect(existsSync(answerPath(h, dump.key))).toBe(false);
  });
});

describe('rekord wątku głównego: ścieżka i wyniki jak bez dowodu ukrytego', () => {
  it('sygnał ukryty z reguły dla wątku głównego: te same karty, rekordy i wynik `decide` co przy regule „nigdy”',
    async () => {
      const results: { signal: unknown; card: unknown; decided: unknown; record: unknown }[] = [];
      for (const rule of [everyKey, NO_HIDDEN_PROOF]) {
        const h = harness('all');
        const dump = dumpOf('glowny');
        hookStarts(h, dump);
        await step(h, { rule, registry: waitingPermission(clock) });
        const card = h.cycle.card(SESSION, dump.key);
        const decided = await h.cycle.decide(SESSION, dump.key, 'allow');
        results.push({ signal: h.signals.get(dump.key), card, decided, record: h.cycle.record(SESSION, dump.key) });
      }
      // Reguła wstrzyknięta podała cyklowi `hidden`, a cykl liczy go dla wątku głównego jak niewiadomą.
      expect(results.map((one) => one.signal)).toEqual(['hidden', 'unknown']);
      expect(results[0]?.card).toMatchObject({ state: 'pending', canAllow: false });
      expect(results[0]?.decided).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
      expect({ ...results[0], signal: null }).toEqual({ ...results[1], signal: null });
    });

  it('zgoda z dowodu z wierzchu niesie `proofKind: top`, odmowa `proofKind` nie niesie', async () => {
    const h = harness('all');
    const t0 = clock;
    const allow = dumpOf('glowny-zgoda');
    // Inne wejście niż zgoda: przy wierzchu bliźniaki (ta sama nazwa i skrót) nie mają przycisku.
    const lint = { command: 'npm run lint' };
    const deny = dumpOf('glowny-odmowa', { toolInput: lint, inputSha256: canonicalSha256(lint) });
    hookStarts(h, allow);
    hookStarts(h, deny);
    // Dowód z wierzchu z odczytem ekranu (krok `standing` bez odczytu przycisku nie daje).
    for (const dump of [allow, deny]) {
      const read = topReadOf(h.cycle, dump, clock);
      clock = read.at;
      expect(await h.cycle.observe(SESSION, dump.key, 'standing', dump, undefined, read)).toMatchObject({ canAllow: true });
    }
    expect(await h.cycle.decide(SESSION, allow.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    expect(await h.cycle.decide(SESSION, deny.key, 'deny')).toEqual({ ok: true, state: 'sent' });
    expect(h.cycle.record(SESSION, allow.key)).toMatchObject({ decision: 'allow', proofKind: 'top' });
    expect(onDisk(h, allow.key)?.proofKind).toBe('top');
    expect(h.cycle.record(SESSION, deny.key)?.proofKind).toBeUndefined();
    expect(onDisk(h, deny.key)?.proofKind).toBeUndefined();
    clock = t0;
  });
});

describe('dwa rodzaje dowodu osobno: świeżość z rodzajem', () => {
  it('odczyt starszy od przyjętego nie zmienia werdyktu; nowszy bez dowodu zabiera dowód ukryty', async () => {
    const h = harness('all');
    const dump = dumpOf('swiezosc', { agentId: AGENT });
    hookStarts(h, dump);
    const t0 = clock;
    expect(await h.cycle.observe(SESSION, dump.key, 'hidden', dump, undefined, hiddenAt(t0)))
      .toMatchObject({ canAllow: true });
    expect(await h.cycle.observe(SESSION, dump.key, 'unknown', dump, undefined, plainAt(t0 - 100)))
      .toMatchObject({ canAllow: true });
    // Sygnał ukryty z odczytu starszego niż przyjęty też niczego nie zmienia (ani nie przedłuża terminu).
    expect(await h.cycle.observe(SESSION, dump.key, 'hidden', dump, undefined, hiddenAt(t0 - 50)))
      .toMatchObject({ canAllow: true });
    clock = t0 + 100;
    expect(await h.cycle.observe(SESSION, dump.key, 'unknown', dump, undefined, plainAt(t0 + 100)))
      .toMatchObject({ canAllow: false, unavailable: 'no-proof' });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    clock = t0;
  });

  it('sygnał `hidden` bez odczytu faktów (albo z odczytu, który już minął) jest niewiadomą', async () => {
    const h = harness('all');
    const dump = dumpOf('bez-faktow', { agentId: AGENT });
    hookStarts(h, dump);
    expect(await h.cycle.observe(SESSION, dump.key, 'hidden', dump, undefined, plainAt(clock)))
      .toMatchObject({ canAllow: false, unavailable: 'no-proof' });
    expect(await h.cycle.observe(SESSION, dump.key, 'hidden', dump, undefined, hiddenAt(clock - CONSENT_PROOF_TTL_MS)))
      .toMatchObject({ canAllow: false, unavailable: 'no-proof' });
    expect(await h.cycle.observe(SESSION, dump.key, 'hidden', dump)).toMatchObject({ canAllow: false });
  });

  it('dowód z wierzchu po ukrytym zastępuje go: zgoda z `proofKind: top`', async () => {
    const h = harness('all');
    const dump = dumpOf('wierzch-po-ukrytym', { agentId: AGENT });
    hookStarts(h, dump);
    const t0 = clock;
    // Obserwacja z dowodem ukrytym; ten sam krok wpisuje zrzut do puli, a rejestr `busy` zdejmuje blokadę startu.
    await step(h, { rule: everyKey, registry: busy(t0) });
    expect(h.signals.get(dump.key)).toBe('hidden');
    expect(h.cycle.card(SESSION, dump.key)?.canAllow).toBe(true);
    // Następny odczyt ekranu: jedyny zrzut puli pasuje do wierzchu, dowód z wierzchu przed terminem.
    clock = t0 + 1;
    const top: ConsentObserved = {
      at: clock, until: clock + CONSENT_PROOF_TTL_MS, screen: { text: 'ramka Bash', readStartedAt: clock },
      matchTop: () => 'match', hidden: null,
    };
    expect(await h.cycle.observe(SESSION, dump.key, 'standing', dump, undefined, top)).toMatchObject({ canAllow: true });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    expect(h.cycle.record(SESSION, dump.key)?.proofKind).toBe('top');
    clock = t0;
  });

  it('zwolnienie z urządzenia po dowodzie ukrytym nie niesie `proofKind`', async () => {
    const h = harness('all');
    const dump = dumpOf('zwolnienie', { agentId: AGENT });
    hookStarts(h, dump);
    await h.cycle.observe(SESSION, dump.key, 'hidden', dump, undefined, hiddenAt(clock));
    expect(await h.cycle.release(SESSION, dump.key)).toMatchObject({ ok: true });
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ decision: 'release' });
    expect(h.cycle.record(SESSION, dump.key)?.proofKind).toBeUndefined();
  });
});

describe('pole `proofKind` w pliku rekordu', () => {
  /** Rekord zgody na dysku po prawdziwej decyzji, ze zmienionym polem `proofKind` (`undefined` = bez pola). */
  async function recordWith(proofKind: unknown): Promise<{ h: Harness; key: string; before: Record<string, unknown> }> {
    const h = harness('all');
    const dump = dumpOf(`plik-${String(proofKind)}`, { agentId: AGENT });
    hookStarts(h, dump);
    await step(h, { rule: everyKey });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    const before = JSON.parse(readFileSync(recordPath(h, dump.key), 'utf8')) as Record<string, unknown>;
    expect(before['proofKind']).toBe('hidden');
    const { proofKind: _written, ...rest } = before;
    const edited = proofKind === undefined ? rest : { ...rest, proofKind };
    writeFileSync(recordPath(h, dump.key), `${JSON.stringify(edited)}\n`);
    return { h, key: dump.key, before: rest };
  }

  it('rekord bez pola (sprzed karty) czyta się bez zmian', async () => {
    const { h, key, before } = await recordWith(undefined);
    const read = onDisk(h, key);
    expect(read).toEqual(before);
    expect(read?.proofKind).toBeUndefined();
  });

  it('pole w złym kształcie odpada, rekord zostaje', async () => {
    for (const bad of ['bogus', 7, null]) {
      const { h, key, before } = await recordWith(bad);
      expect(onDisk(h, key), String(bad)).toEqual(before);
    }
  });

  it('przegląd po restarcie serwera czyta rekord z polem i bez pola', async () => {
    for (const proofKind of ['hidden', undefined]) {
      const { h, key } = await recordWith(proofKind);
      const next = createConsentCycle({
        dataDir: h.dir, bootId: 'boot-ukryty-2', registry: h.reg, now, mode: () => 'all', log: () => {},
      });
      expect(await next.recover()).toMatchObject({ records: 1 });
      expect(next.record(SESSION, key)?.decision).toBe('allow');
      expect(next.record(SESSION, key)?.proofKind).toBe(proofKind);
    }
  });
});

describe('`subagentPending`', () => {
  it('prawda tylko przy prośbie subagenta w `pending` tej sesji', async () => {
    const h = harness('all');
    expect(h.cycle.subagentPending(SESSION)).toBe(false);
    const main = dumpOf('pending-glowny');
    hookStarts(h, main);
    await h.cycle.observe(SESSION, main.key, 'unknown', main);
    expect(h.cycle.subagentPending(SESSION)).toBe(false);
    const sub = dumpOf('pending-sub', { agentId: AGENT });
    hookStarts(h, sub);
    await h.cycle.observe(SESSION, sub.key, 'unknown', sub);
    expect(h.cycle.subagentPending(SESSION)).toBe(true);
    expect(h.cycle.subagentPending('00000000-0000-4000-9000-0000000000d2')).toBe(false);
    expect(await h.cycle.decide(SESSION, sub.key, 'deny')).toEqual({ ok: true, state: 'sent' });
    expect(h.cycle.subagentPending(SESSION)).toBe(false);
  });
});
