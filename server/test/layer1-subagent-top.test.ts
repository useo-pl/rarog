/**
 * Dowód z wierzchu dla prośby subagenta przy trybie `all`.
 *
 * Zdania, których pilnuje plik:
 *
 * - przy `all` prośba subagenta, której dialog stoi na wierzchu, dostaje `standing` i kartę z przyciskiem zgody, gdy
 *   jej plik subagenta (`<sesja>/subagents/agent-<id>.jsonl`) jest znany do końca i nie zamknął jej wywołania; przy
 *   `main` karta zostaje `terminal-only`;
 * - dowód własny prośby subagenta liczy jej plik: wynik jej `tool_use` w pliku subagenta zabiera dowód (a po 5 s daje
 *   `gone`), a transkrypt wątku głównego, także z wywołaniem o tej samej tożsamości, sieroty z niej nie robi;
 * - rejestr bez `waiting` zabiera prośbie subagenta dowód z wierzchu (`unknown`), nigdy nie daje `gone`;
 * - bliźniak wątku głównego i subagenta na wierzchu: brak zwycięzcy, żadna karta bez przycisku; `Read` subagenta na
 *   wierzchu bez przycisku;
 * - fakty pliku nieznane (`RAROG_AGENT_FILES=0`, plik agenta workflow poza `subagents/agent-<id>.jsonl`) = bez dowodu;
 * - tryb cienia (wejście bez opcji warstwy 1) i kanał `main` (opcja bez faktów pliku): prośba subagenta `subagent`;
 * - ramki dialogu subagenta z pomiaru (CLI 2.1.319) różnią się od ramki wątku głównego tylko dopiskiem tytułu,
 *   a `matchTop` daje na nich ten sam wynik;
 * - fakty po odbiorze przy `all` liczą żywy zrzut subagenta jako inny żywy zrzut sesji;
 * - wiek procesu hooka z `ps` liczy się od chwili samego `ps`: odczyt plików subagentów dłuższy niż zapas
 *   `START_TOLERANCE_MS` nie robi z żywego hooka martwego.
 *
 * Plik subagenta to linie fixture'u `subagent-fg` (CLI 2.1.314) z wejściem `Bash` zamienionym na komendę zmierzonej
 * ramki (CLI 2.1.319).
 * Zrzuty leżą na dysku w katalogu danych testu, `ps` to atrapa, cykl i rejestr są prawdziwe, z zegarem testu.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeConsentEvidenceIo } from '../src/herdr/consent-evidence.ts';
import { createSubagentObservation } from '../src/herdr/consent-subagent.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_DIRNAME, CONSENT_EVIDENCE_SCAN_MAX_BYTES, CONSENT_SECRET_BYTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentSessionObservation, ConsentSessionSources } from '../src/herdr/dialogs/layer1/observe.ts';
import { subagentClosures, transcriptPassed } from '../src/herdr/dialogs/layer1/proof.ts';
import type { ConsentAfterClaim, ConsentSubagentFile, TranscriptToolUses } from '../src/herdr/dialogs/layer1/proof.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import { matchTop } from '../src/herdr/dialogs/layer1/top.ts';
import { orphanHooks, registryNegates, standingProofs } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { EvidenceInput, RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import { PS_TIMEOUT_MS, psLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';
import type { ProcessLiveness, PsRun } from '../src/herdr/dialogs/shadow/liveness.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = join(REPO, 'server', 'test', 'fixtures');
const DOWOD = join(FIXTURES, 'consent-dowod');
const fixture = (path: string): string => readFileSync(join(FIXTURES, path), 'utf8');

/** Hook prośby subagenta z pomiaru (CLI 2.1.314): sesja, tura i agent. */
const FG_HOOK = JSON.parse(fixture('consent-dowod/subagent-fg.hook.json')) as {
  session_id: string; prompt_id: string; agent_id: string;
};
const SESSION = FG_HOOK.session_id;
const PROMPT = FG_HOOK.prompt_id;
const AGENT = FG_HOOK.agent_id;

/** Linie pliku subagenta z pomiaru: otwarcie tury, `tool_use`, wynik (`hook`/`accept`), tekst końcowy. */
const FG_LINES = fixture('consent-dowod/subagent-fg.jsonl').split('\n').filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const USE_AT = Date.parse(String(FG_LINES[1]?.['timestamp']));
const RESULT_AT = Date.parse(String(FG_LINES[2]?.['timestamp']));

/** Ramki dialogu `Bash` z pomiaru (CLI 2.1.319): subagent na pierwszym planie i wątek główny, ta sama komenda. */
const FG_SUBAGENT_SCREEN = fixture('consent-dowod/foreground-subagent.ekran.txt');
const FG_MAIN_SCREEN = fixture('consent-dowod/foreground-main.ekran.txt');
const FG_INPUT = { command: 'echo fg-1 >> fg-1.txt', description: 'fg-1' };
/** Dialog `Read` (CLI 2.1.278) i ten sam z dopiskiem tytułu subagenta. */
const READ_MAIN = fixture('herdr/dialog-permission-read-2.1.278.txt');
const READ_SUBAGENT = READ_MAIN.replace(' Read file\n', ' Read file · from the general-purpose agent\n');
const READ_INPUT = { file_path: '/etc/hosts' };

let clock = USE_AT + 1_500;
const now = (): number => clock;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const waiting = (at = clock): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at });
const busy = (at = clock): RegistryEvidence => ({ kind: 'active', at });

let nextPid = 81_000;

/** Zrzut per wywołanie: hook wystartował 200 ms po linii `tool_use` z pomiaru, zrzut zapisał 100 ms później. */
function dumpOf(seed: string, toolName: string, toolInput: unknown, over: Partial<HookCallDump> = {}): HookCallDump {
  nextPid += 1;
  const nonce = createHash('sha256').update(`${seed}-${String(nextPid)}`).digest('hex').slice(0, 32);
  return {
    key: `${PROMPT}-${nonce}`, sessionId: SESSION, promptId: PROMPT, pid: nextPid, startedAt: USE_AT + 200, toolName,
    toolInput, cwd: '/tmp/projekt', at: USE_AT + 300, inputSha256: canonicalSha256(toolInput),
    permissionMode: 'default', ...over,
  };
}

const subagentBash = (seed: string, over: Partial<HookCallDump> = {}): HookCallDump =>
  dumpOf(seed, 'Bash', FG_INPUT, { agentId: AGENT, ...over });

/**
 * Linie pliku subagenta z pomiaru z wejściem `tool_use` zamienionym na `input` (nazwa narzędzia `toolName`): `upTo` =
 * ile pierwszych linii (2 = otwarcie i `tool_use`, 3 = z wynikiem).
 */
function subagentJsonl(upTo: number, toolName = 'Bash', input: unknown = FG_INPUT): string {
  return FG_LINES.slice(0, upTo).map((entry) => {
    const copy = structuredClone(entry);
    delete copy['wireToolInputs'];
    const message = copy['message'] as { content?: unknown };
    if (Array.isArray(message.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block['type'] === 'tool_use') {
          block['name'] = toolName;
          block['input'] = input;
        }
      }
    }
    return `${JSON.stringify(copy)}\n`;
  }).join('');
}

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly life: Map<number, boolean | null>;
  /** Plik wątku głównego sesji w magazynie testu (sam plik nie musi istnieć). */
  readonly mainFile: string;
  /** Krok obserwacji: rejestr, ekran z chwilą odczytu = teraz (`null` = bez odczytu), transkrypt wątku głównego. */
  step(registry: RegistryEvidence, screen: string | null, transcript?: TranscriptToolUses | null):
    Promise<ConsentSessionObservation>;
}

/**
 * Cykl i rejestr w trybie `tryb`, jak w serwerze: przy `all` obserwacja dostaje fakty plików subagentów z czytnika
 * serwera (`createSubagentObservation`), przy `main` nie. Proces wstał 10 s przed zegarem testu, a blokadę startu
 * zdjął rejestr bez `waiting` 5 s przed nim.
 */
async function harness(
  tryb: Extract<ConsentEffectiveMode, 'main' | 'all'>, opts: { readonly agentFiles?: boolean } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-subagent-wierzch-'));
  dirs.push(dir);
  const reg = createConsentRegistry({ bootId: 'boot-1c', send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope(tryb);
  const started = clock;
  clock = started - 10_000;
  const cycle = createConsentCycle({ dataDir: dir, bootId: 'boot-1c', registry: reg, now, mode: () => tryb });
  clock = started;
  const life = new Map<number, boolean | null>();
  const liveness: ProcessLiveness = async (processes) => new Map(processes.map((p) => [p.pid, life.get(p.pid) ?? null]));
  const mainFile = join(dir, 'projekt', `${SESSION}.jsonl`);
  const files = createSubagentObservation({
    io: nodeConsentEvidenceIo, locate: async () => mainFile, agentFiles: opts.agentFiles ?? true,
    maxBytes: CONSENT_EVIDENCE_SCAN_MAX_BYTES,
  });
  const subagents: Pick<ConsentSessionSources, 'subagentTurns'> = tryb === 'all'
    ? { subagentTurns: (requests) => files.read(SESSION, requests) }
    : {};
  await observeConsentSession(cycle, {
    dataDir: dir, sessionId: SESSION, liveness, registry: busy(started - 5_000), transcript: null, screen: null,
    now: () => started - 5_000, ...subagents,
  });
  return {
    dir, reg, cycle, life, mainFile,
    step: async (registry, screen, transcript = null) => observeConsentSession(cycle, {
      dataDir: dir, sessionId: SESSION, liveness, registry, transcript,
      screen: screen === null ? null : { text: screen, readStartedAt: clock }, now, ...subagents,
    }),
  };
}

/** Plik subagenta `AGENT` obok pliku wątku głównego (`relative` = inna ścieżka w katalogu sesji). */
function writeSubagentFile(h: Harness, content: string, relative = join('subagents', `agent-${AGENT}.jsonl`)): void {
  const file = join(h.mainFile.slice(0, -'.jsonl'.length), relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Hook startuje: zrzut na dysku, proces żywy; przy `all` rejestracja sekretu przyjęta. */
function hookStarts(h: Harness, dump: HookCallDump, register: boolean): void {
  const path = join(h.dir, HOOK_PENDING_DIRNAME, SESSION, `${dump.key}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(dump), { mode: 0o600 });
  h.life.set(dump.pid, true);
  const cardSha256 = consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
  });
  const result = h.reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
    inputSha256: dump.inputSha256, cardSha256, pid: dump.pid, startedAt: dump.startedAt,
    ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
  });
  if (register) expect(result.status).toBe(200);
}

const NO_BUTTON = { state: 'pending', canAllow: false, unavailable: 'no-proof' };

describe('dowód z wierzchu prośby subagenta: przypadki', () => {
  it('przy `all`: zrzut subagenta, zmierzona ramka subagenta na wierzchu, rejestr `waiting`, plik subagenta z otwartym'
    + ' `tool_use` → `standing`, karta z przyciskiem zgody i odmowy, zgoda z telefonu pisze odpowiedź', async () => {
    clock = USE_AT + 1_500;
    const h = await harness('all');
    const dump = subagentBash('fg-stoi');
    writeSubagentFile(h, subagentJsonl(2));
    hookStarts(h, dump, true);
    const observation = await h.step(waiting(), FG_SUBAGENT_SCREEN);
    expect(observation.signals.get(dump.key)).toBe('standing');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({
      state: 'pending', agentId: AGENT, canAllow: true, canDeny: true, unavailable: null,
    });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    expect(readFileSync(join(h.dir, CONSENT_DIRNAME, SESSION, `${dump.key}.json`), 'utf8')).toContain('"allow"');
  });

  it('to samo przy `main` → karta `terminal-only`, bez przycisku zgody i odmowy (rejestracja odmówiona)', async () => {
    clock = USE_AT + 1_500;
    const h = await harness('main');
    const dump = subagentBash('fg-main');
    writeSubagentFile(h, subagentJsonl(2));
    hookStarts(h, dump, false);
    const observation = await h.step(waiting(), FG_SUBAGENT_SCREEN);
    expect(observation.signals.get(dump.key)).toBe('unknown');
    expect(standingProofs({ ...observation.evidence, queue: { kind: 'unknown' } }))
      .toContainEqual({ key: dump.key, kind: 'brak', why: 'subagent' });
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({
      state: 'pending', canAllow: false, canDeny: false, unavailable: 'terminal-only',
    });
  });

  it('plik subagenta z wynikiem tego `tool_use` → brak dowodu, a 5 s po zapisie zrzutu `gone`; rekord zostaje'
    + ' `pending` (żywa rejestracja)', async () => {
    clock = RESULT_AT + 500;
    const h = await harness('all');
    const dump = subagentBash('fg-wynik', { startedAt: USE_AT + 200, at: RESULT_AT - 100 });
    writeSubagentFile(h, subagentJsonl(3));
    hookStarts(h, dump, true);
    const first = await h.step(waiting(), FG_SUBAGENT_SCREEN);
    expect(first.signals.get(dump.key)).toBe('unknown');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
    clock = dump.at + 5_000;
    const later = await h.step(waiting(), FG_SUBAGENT_SCREEN);
    expect(later.signals.get(dump.key)).toBe('gone');
    expect(h.cycle.record(SESSION, dump.key)?.state).toBe('pending');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
  });

  it('wynik wcześniejszego identycznego wywołania (przed startem hooka) dowodu nie zabiera', async () => {
    clock = RESULT_AT + 1_000;
    const h = await harness('all');
    const dump = subagentBash('fg-drugie', { startedAt: RESULT_AT + 100, at: RESULT_AT + 200 });
    writeSubagentFile(h, subagentJsonl(3));
    hookStarts(h, dump, true);
    const observation = await h.step(waiting(), FG_SUBAGENT_SCREEN);
    expect(observation.signals.get(dump.key)).toBe('standing');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ canAllow: true });
  });

  it('zrzut subagenta starszy niż 5 s bez wpisu w pliku GŁÓWNYM → nie sierota, dowód z wierzchu zostaje', async () => {
    clock = USE_AT + 7_000;
    const h = await harness('all');
    const dump = subagentBash('fg-stary');
    writeSubagentFile(h, subagentJsonl(2));
    hookStarts(h, dump, true);
    expect(clock - dump.at).toBeGreaterThan(5_000);
    const observation = await h.step(waiting(), FG_SUBAGENT_SCREEN, { open: [], closed: [], lostAt: null });
    expect(observation.signals.get(dump.key)).toBe('standing');
    expect(orphanHooks(observation.evidence)).toEqual([]);
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ canAllow: true });
  });

  it('wywołanie o tej samej tożsamości zamknięte w pliku GŁÓWNYM nie zabiera dowodu prośbie subagenta; ten sam'
    + ' transkrypt robi sierotę z prośby wątku głównego', async () => {
    clock = USE_AT + 7_000;
    const transcript: TranscriptToolUses = {
      open: [], closed: [{ toolName: 'Bash', inputSha256: canonicalSha256(FG_INPUT), closedAt: USE_AT + 1_000 }],
      lostAt: null,
    };
    const h = await harness('all');
    const sub = subagentBash('fg-glowny-zamknal');
    writeSubagentFile(h, subagentJsonl(2));
    hookStarts(h, sub, true);
    const observation = await h.step(waiting(), FG_SUBAGENT_SCREEN, transcript);
    expect(observation.signals.get(sub.key)).toBe('standing');

    const other = await harness('all');
    const main = dumpOf('glowny-zamkniety', 'Bash', FG_INPUT);
    hookStarts(other, main, true);
    const control = await other.step(waiting(), FG_MAIN_SCREEN, transcript);
    expect(control.signals.get(main.key)).toBe('gone');
  });

  it('zrzut subagenta, rejestr `busy` (odczyt wyraźnie po zrzucie) przez 3 s → sygnał `unknown`, nigdy `gone`;'
    + ' rekord `pending` bez przycisku; ten sam rejestr daje `gone` prośbie wątku głównego', async () => {
    clock = USE_AT + 2_500;
    const h = await harness('all');
    const dump = subagentBash('fg-busy');
    writeSubagentFile(h, subagentJsonl(2));
    hookStarts(h, dump, true);
    expect(registryNegates(busy(), clock, dump)).toBe(true);
    const seen: unknown[] = [];
    for (const at of [clock, clock + 1_500, clock + 3_000]) {
      clock = at;
      const observation = await h.step(busy(), null);
      seen.push(observation.signals.get(dump.key));
    }
    expect(seen).toEqual(['unknown', 'unknown', 'unknown']);
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);

    clock = USE_AT + 2_500;
    const other = await harness('all');
    const main = dumpOf('glowny-busy', 'Bash', FG_INPUT);
    hookStarts(other, main, true);
    expect((await other.step(busy(), null)).signals.get(main.key)).toBe('gone');
  });

  it.each([
    ['zmierzona ramka subagenta', FG_SUBAGENT_SCREEN],
    ['zmierzona ramka wątku głównego', FG_MAIN_SCREEN],
  ] as const)('bliźniak wątku głównego i subagenta na wierzchu (%s) → brak zwycięzcy, obie karty bez przycisku',
    async (_name, screen) => {
      clock = USE_AT + 1_500;
      const h = await harness('all');
      const sub = subagentBash('blizniak-sub');
      const main = dumpOf('blizniak-main', 'Bash', FG_INPUT);
      writeSubagentFile(h, subagentJsonl(2));
      hookStarts(h, sub, true);
      hookStarts(h, main, true);
      const observation = await h.step(waiting(), screen);
      expect([observation.signals.get(sub.key), observation.signals.get(main.key)]).toEqual(['unknown', 'unknown']);
      expect([h.cycle.card(SESSION, sub.key), h.cycle.card(SESSION, main.key)])
        .toMatchObject([NO_BUTTON, NO_BUTTON]);
      expect(await h.cycle.decide(SESSION, sub.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    });

  it.each([
    ['z dopiskiem tytułu subagenta', READ_SUBAGENT],
    ['bez dopisku', READ_MAIN],
  ] as const)('`Read` subagenta na wierzchu (%s) → bez przycisku', async (_name, screen) => {
    clock = USE_AT + 1_500;
    const h = await harness('all');
    const dump = dumpOf('read-sub', 'Read', READ_INPUT, { agentId: AGENT });
    writeSubagentFile(h, subagentJsonl(2, 'Read', READ_INPUT));
    hookStarts(h, dump, true);
    const observation = await h.step(waiting(), screen);
    expect(observation.signals.get(dump.key)).toBe('unknown');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
  });

  it('tryb cienia (bez opcji warstwy 1) i kanał `main` (opcja bez faktów pliku): zrzut subagenta `subagent`, bez'
    + ' sieroty', () => {
    clock = USE_AT + 7_000;
    const dump = subagentBash('cien');
    const shadow: EvidenceInput = {
      now: clock, dumps: [dump], alive: new Map([[dump.key, true]]), registry: busy(),
      queue: { kind: 'unknown' }, transcript: [],
    };
    expect(standingProofs(shadow)).toEqual([{ key: dump.key, kind: 'brak', why: 'subagent' }]);
    expect(orphanHooks(shadow)).toEqual([]);
    const main: EvidenceInput = { ...shadow, layer1: { passed: () => true, lost: () => true } };
    expect(standingProofs(main)).toEqual([{ key: dump.key, kind: 'brak', why: 'subagent' }]);
    expect(orphanHooks(main)).toEqual([]);
    const unknownFile: EvidenceInput = { ...main, layer1: { passed: () => true, lost: () => true, subagentFile: () => false } };
    expect(standingProofs(unknownFile)).toEqual([{ key: dump.key, kind: 'brak', why: 'subagent' }]);
  });
});

describe('`ps` po odczycie plików subagentów: wiek procesu wobec chwili samego `ps`', () => {
  it('przy `all` odczyt plików subagentów trwa 3 s, `ps` widzi żywy hook → hook żywy, bez sygnału `dead`, rekord'
    + ' `pending`, rejestracja zostaje', async () => {
    clock = USE_AT + 1_500;
    const h = await harness('all');
    const dump = subagentBash('ps-po-odczycie');
    writeSubagentFile(h, subagentJsonl(2));
    hookStarts(h, dump, true);
    const files = createSubagentObservation({
      io: nodeConsentEvidenceIo, locate: async () => h.mainFile, agentFiles: true,
      maxBytes: CONSENT_EVIDENCE_SCAN_MAX_BYTES,
    });
    // Atrapa `ps`: hook żyje od `startedAt` zrzutu, `etime` w pełnych sekundach według zegara testu w chwili `ps`.
    const psAt: number[] = [];
    const run: PsRun = async (pid) => {
      psAt.push(clock);
      if (pid !== dump.pid) return '';
      const seconds = Math.floor((clock - dump.startedAt) / 1_000);
      return `${String(pid)} ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}\n`;
    };
    const observation = await observeConsentSession(h.cycle, {
      dataDir: h.dir, sessionId: SESSION, liveness: psLiveness(PS_TIMEOUT_MS, run), registry: waiting(),
      transcript: null, screen: { text: FG_SUBAGENT_SCREEN, readStartedAt: clock }, now,
      subagentTurns: async (requests) => {
        clock += 3_000;
        return files.read(SESSION, requests);
      },
    });
    expect(psAt).toEqual([USE_AT + 4_500]);
    expect(observation.evidence.alive.get(dump.key)).toBe(true);
    // Ekran przeczytany 3 s przed `ps`: dowód z wierzchu wygasł (`unknown`), ale hook nie jest martwy.
    expect(observation.signals.get(dump.key)).toBe('unknown');
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'pending' });
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
    expect(h.reg.entry(SESSION, dump.key)).not.toBeNull();
  });
});

describe('fakty pliku subagenta nieznane: bez dowodu', () => {
  it('`RAROG_AGENT_FILES=0` → karta `no-proof` mimo ramki na wierzchu i otwartego `tool_use`', async () => {
    clock = USE_AT + 1_500;
    const h = await harness('all', { agentFiles: false });
    const dump = subagentBash('bez-plikow');
    writeSubagentFile(h, subagentJsonl(2));
    hookStarts(h, dump, true);
    const observation = await h.step(waiting(), FG_SUBAGENT_SCREEN);
    expect(observation.signals.get(dump.key)).toBe('unknown');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
  });

  it('plik agenta workflow w dwóch przebiegach (`subagents/workflows/wf_<id>/agent-<id>.jsonl`) → czytnik nie wie,'
    + ' który, karta `no-proof`', async () => {
    clock = USE_AT + 1_500;
    const h = await harness('all');
    const dump = subagentBash('workflow');
    for (const run of ['wf_m8pomiar', 'wf_m8pomiar2']) {
      writeSubagentFile(h, subagentJsonl(2), join('subagents', 'workflows', run, `agent-${AGENT}.jsonl`));
    }
    hookStarts(h, dump, true);
    const observation = await h.step(waiting(), FG_SUBAGENT_SCREEN);
    expect(observation.signals.get(dump.key)).toBe('unknown');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
  });

  it('niedokończona ostatnia linia pliku subagenta → bez dowodu; po dopisaniu reszty linii dowód wraca', async () => {
    clock = USE_AT + 1_500;
    const h = await harness('all');
    const dump = subagentBash('niedokonczona');
    const full = subagentJsonl(2);
    writeSubagentFile(h, full.slice(0, -10));
    hookStarts(h, dump, true);
    expect((await h.step(waiting(), FG_SUBAGENT_SCREEN)).signals.get(dump.key)).toBe('unknown');
    writeSubagentFile(h, full);
    clock += 1_500;
    expect((await h.step(waiting(), FG_SUBAGENT_SCREEN)).signals.get(dump.key)).toBe('standing');
  });
});

describe('ramki dialogu subagenta z pomiaru: `matchTop` jak dla wątku głównego', () => {
  const bash = (command: string): Parameters<typeof matchTop>[1] => {
    const toolInput = { command };
    return { toolName: 'Bash', toolInput, cwd: '/tmp', inputSha256: canonicalSha256(toolInput) };
  };
  const frame = (name: string): string => readFileSync(join(DOWOD, `${name}.ekran.txt`), 'utf8');

  it('ramka subagenta różni się od ramki wątku głównego tylko dopiskiem tytułu', () => {
    expect(FG_SUBAGENT_SCREEN.replace(' Bash command · from the general-purpose agent\n', ' Bash command\n')).toBe(FG_MAIN_SCREEN);
  });

  it.each([
    ['foreground-subagent', 'echo fg-1 >> fg-1.txt'],
    ['foreground-main', 'echo fg-1 >> fg-1.txt'],
    ['main-beside-hidden', 'echo hidden-1-main > hidden-1-main.txt'],
    ['background-after-release', 'echo release-1 > release-1.txt'],
    ['queue-1of2-main', 'echo m8rg-1-glowny > m8rg-1-glowny.txt'],
    ['queue-2of2-background', 'echo m8rg-1-tlo > m8rg-1-tlo.txt'],
  ] as const)('%s: własna komenda `match`, inna `no`', (name, command) => {
    expect(matchTop(frame(name), bash(command))).toBe('match');
    expect(matchTop(frame(name), bash('echo inne > inne.txt'))).toBe('no');
  });

  it.each(['exit-background-work', 'workflow'])('%s: wierzch bez pełnej tożsamości, `unknown` dla każdego zrzutu',
    (name) => {
      expect(matchTop(frame(name), bash('echo m8zw-1 > m8zw-1.txt'))).toBe('unknown');
      expect(matchTop(frame(name), bash('echo inne > inne.txt'))).toBe('unknown');
    });
});

describe('`subagentClosures`: pamięć zamknięć z faktów pliku subagenta', () => {
  const use = { id: 'toolu_1', name: 'Bash', inputSha256: canonicalSha256(FG_INPUT), line: 2 };
  const result = (at: number | null, toolUseId = 'toolu_1') => ({
    toolUseId, line: 3, at, decision: 'accept', source: 'hook', interrupted: false,
  });
  const file = (over: Partial<ConsentSubagentFile> = {}): ConsentSubagentFile => ({
    partial: false, toolUses: [use], results: [], settled: true, caughtUp: true, ...over,
  });
  const dump = subagentBash('zamkniecia');

  it('fakty nieznane do końca → `null`', () => {
    expect(subagentClosures(null, clock)).toBeNull();
    expect(subagentClosures(file({ partial: true }), clock)).toBeNull();
    expect(subagentClosures(file({ settled: false }), clock)).toBeNull();
    expect(subagentClosures(file({ caughtUp: false }), clock)).toBeNull();
  });

  it('wynik znanego `tool_use` → zamknięcie z chwilą wpisu wyniku; bez wyniku nic', () => {
    expect(subagentClosures(file(), clock)).toEqual({ closed: [], lostAt: null });
    const closures = subagentClosures(file({ results: [result(RESULT_AT)] }), clock);
    expect(closures).toEqual({
      closed: [{ toolName: 'Bash', inputSha256: canonicalSha256(FG_INPUT), closedAt: RESULT_AT }], lostAt: null,
    });
    expect(closures !== null && transcriptPassed(closures, dump)).toBe(true);
  });

  it('wynik bez znanego `tool_use` → utrata pokrycia (`lostAt`), bez chwili wpisu liczona jak teraz', () => {
    expect(subagentClosures(file({ results: [result(RESULT_AT, 'toolu_obcy')] }), clock))
      .toEqual({ closed: [], lostAt: RESULT_AT });
    const closures = subagentClosures(file({ results: [result(null, 'toolu_obcy')] }), clock);
    expect(closures).toEqual({ closed: [], lostAt: clock });
    expect(closures !== null && transcriptPassed(closures, dump)).toBe(true);
  });
});

describe('czytnik serwera `createSubagentObservation`', () => {
  function storeWith(relative: string | null): { mainFile: string } {
    const dir = mkdtempSync(join(tmpdir(), 'rarog-subagent-czytnik-'));
    dirs.push(dir);
    const mainFile = join(dir, `${SESSION}.jsonl`);
    if (relative !== null) {
      const file = join(dir, SESSION, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, subagentJsonl(2));
    }
    return { mainFile };
  }
  const request = { agentId: AGENT, promptId: PROMPT };
  const reader = (mainFile: string | null, agentFiles = true) => createSubagentObservation({
    io: nodeConsentEvidenceIo, locate: async () => mainFile, agentFiles, maxBytes: CONSENT_EVIDENCE_SCAN_MAX_BYTES,
  });

  it('plik `subagents/agent-<id>.jsonl`: fakty tury prośby, znane do końca', async () => {
    const { mainFile } = storeWith(join('subagents', `agent-${AGENT}.jsonl`));
    const [facts] = await reader(mainFile).read(SESSION, [request]);
    expect(facts).toMatchObject({ partial: false, settled: true, caughtUp: true, results: [] });
    expect(facts?.toolUses.map((one) => one.name)).toEqual(['Bash']);
  });

  it('plik agenta workflow z katalogu spoza kształtu `wf_<id>`, brak pliku, pliki wyłączone, nieznany plik'
    + ' wątku głównego → bez faktów; inny `promptId` hooka nie zabiera faktów biegu', async () => {
      const workflow = storeWith(join('subagents', 'workflows', 'm8pomiar', `agent-${AGENT}.jsonl`));
      expect(await reader(workflow.mainFile).read(SESSION, [request])).toEqual([null]);
      const missing = storeWith(null);
      expect(await reader(missing.mainFile).read(SESSION, [request])).toEqual([null]);
      const present = storeWith(join('subagents', `agent-${AGENT}.jsonl`));
      const [other] = await reader(present.mainFile).read(SESSION, [{ agentId: AGENT, promptId: SESSION }]);
      // The hook `promptId` is the newest main-thread one, not the agent's: the run decides, not the `promptId`.
      expect(subagentClosures(other ?? null, clock)).not.toBeNull();
      expect(await reader(present.mainFile, false).read(SESSION, [request])).toEqual([null]);
      expect(await reader(null).read(SESSION, [request])).toEqual([null]);
      expect(await reader(present.mainFile).read(SESSION, [{ agentId: '../x', promptId: PROMPT }])).toEqual([null]);
    });

  it('odczyty jednej sesji po kolei: dwa naraz dają te same fakty co jeden', async () => {
    const { mainFile } = storeWith(join('subagents', `agent-${AGENT}.jsonl`));
    const files = reader(mainFile);
    const [a, b] = await Promise.all([files.read(SESSION, [request]), files.read(SESSION, [request])]);
    expect(a?.[0]).toMatchObject({ settled: true, caughtUp: true });
    expect(b?.[0]).toMatchObject({ settled: true, caughtUp: true });
    expect(b?.[0]?.toolUses).toEqual(a?.[0]?.toolUses);
  });
});

describe('fakty po odbiorze: inny żywy zrzut sesji', () => {
  /** Cykl-atrapa: zapisuje fakty po odbiorze z każdego kroku. */
  function recordingCycle(): {
    cycle: Parameters<typeof observeConsentSession>[0]; afterClaims: Map<string, ConsentAfterClaim | undefined>;
  } {
    const afterClaims = new Map<string, ConsentAfterClaim | undefined>();
    const cycle: Parameters<typeof observeConsentSession>[0] = {
      observe: async (_sid, key, _signal, _dump, afterClaim) => { afterClaims.set(key, afterClaim); return null; },
      cards: () => [], notePassed: () => {}, noteTranscript: () => {}, proofLost: () => false, notePool: () => {},
      topWinner: () => null, poolKnows: () => false, hookWatch: () => [], noteHookChecks: () => {},
      noteHookDead: () => {},
    };
    return { cycle, afterClaims };
  }

  it('przy `all` żywy zrzut subagenta liczy się dla karty wątku głównego; bez kanału dla subagentów nie', async () => {
    clock = USE_AT + 1_500;
    const dir = mkdtempSync(join(tmpdir(), 'rarog-subagent-odbior-'));
    dirs.push(dir);
    const main = dumpOf('odbior-main', 'Bash', { command: 'npm test' });
    const sub = subagentBash('odbior-sub');
    for (const dump of [main, sub]) {
      const path = join(dir, HOOK_PENDING_DIRNAME, SESSION, `${dump.key}.json`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(dump), { mode: 0o600 });
    }
    const liveness: ProcessLiveness = async (processes) => new Map(processes.map((p) => [p.pid, true]));
    const sources: ConsentSessionSources = {
      dataDir: dir, sessionId: SESSION, liveness, registry: waiting(), transcript: null, screen: null, now,
    };
    const open = recordingCycle();
    await observeConsentSession(open.cycle, { ...sources, subagentTurns: async (requests) => requests.map(() => null) });
    expect(open.afterClaims.get(main.key)?.otherLive).toBe(true);
    const closed = recordingCycle();
    await observeConsentSession(closed.cycle, sources);
    expect(closed.afterClaims.get(main.key)?.otherLive).toBe(false);
  });
});
