/**
 * Rama właściwości kanału zgód przy regule dowodu `channel` (warstwa 1): niezmienniki „zgoda jednorazowa” i „prawda
 * na karcie” na kodzie produkcyjnym, w trybach subagentów `main` i `all`.
 *
 * - Zgoda jednorazowa: CLI wykonuje po podpisanym `allow` co najwyżej wywołanie, którego pełną treść pokazała
 *   karta. Model sprawdza każde wykonanie z odpowiedzi hooka: hook przyjął plik odpowiedzi po `verifyConsentFile`
 *   z własnym sekretem, kluczem i skrótami ze stdin, telefon zgodził się na tę kartę z przyciskiem zgody, a karta
 *   w chwili wyboru pokazywała dokładnie prezentację wykonanego wejścia (`presentConsentInput`). Każdy plik, który
 *   serwer podpisał, hook przyjmuje (podpis i skróty zgodne z rejestracją).
 * - Prawda na karcie: karta traci przycisk zgody najpóźniej w takcie, w którym serwer widzi wynik wywołania
 *   w pliku rozmowy (wywołanie bez bliźniaka) albo odczyt rejestru CLI bez `waiting` (karta wątku głównego). Bliźniak
 *   to inna prośba tego wątku z tą samą nazwą i skrótem wejścia rekordu, której czas nakłada się na tę (wynik jednej
 *   przed startem hooka drugiej je rozdziela). Stan końcowy `settled-at-desk` tylko przy wywołaniu bez bliźniaka,
 *   rozstrzygniętym klawiszem przy biurku, z tą samą decyzją i wiązaniem z własnym `tool_use`. `applied` for an
 *   `allow` needs the hook's receipt, which the model's hook does not send (`consentReceiptOf` gives `false`),
 *   so a hook `allow` without a twin (also in the model's truth) ends in the turn as `unknown` (`no-receipt`) on its
 *   own call; a `deny` needs no receipt, so a hook `reject` without a twin ends as `applied` on its own call, except
 *   under a dump the hook truncated: it has no card digest, so the answer's call is not proven (`unknown`,
 *   `no-receipt`). With a twin the final state is only `unknown`. Model sprawdza to wprost, zamiast pomijać.
 *
 * Kod produkcyjny: rejestr sekretów (`createConsentRegistry`), cykl (`createConsentCycle`, pliki odpowiedzi
 * w pamięci), obserwacja `observeConsentSession` z bramką wersji CLI (`createConsentProofGate`, konfiguracja
 * `channel`, wersja z odczytu rejestru), zrzuty na dysku, przegląd pliku rozmowy `createConsentEvidenceReview` nad
 * prawdziwym plikiem `.jsonl` (i plikiem subagenta przy `all`), `decide` z telefonu. Przy `all` obserwacja dostaje
 * fakty pliku subagenta, pamięć utraty wierzchu i listę hooków sesji (sam hook Raroga), jak w `server/src/index.ts`.
 *
 * Model świata (prawda) idzie za zachowaniem CLI z `docs/dialogs.md` („PermissionRequest hook behavior”):
 *
 * - kolejka dialogów CLI (nowy dialog na końcu, jako niezmierzona możliwość także na wierzchu); rejestr CLI mówi
 *   `waiting: permission`, póki w kolejce stoi dialog; klawisz przy biurku rozstrzyga dialog z wierzchu, CLI zapisuje
 *   wynik z `permissionDecision.source` `user_temporary` albo `user_reject`, a hook tej prośby zostaje sierotą (żyje,
 *   zrzut zostaje);
 * - hook czeka na plik odpowiedzi, przejmuje go (`.json` → `.claimed`) zaraz po decyzji albo dopiero w następnym
 *   takcie i sprawdza podpis; `allow` wykonuje wywołanie tylko wtedy, gdy jego dialog stoi (późne `allow` po decyzji
 *   przy biurku nic nie wykonuje, zmierzone), wynik ma źródło `hook`; `release` oddaje prośbę do biurka; hook może
 *   wyjść bez odpowiedzi (zrzut znika) albo zginąć od SIGKILL (zrzut zostaje, `ps` mówi `false`);
 * - zrzut na dysku jak u hooka, przycięty (marker) albo podmieniony (inne wejście z własnym skrótem pod tym samym
 *   kluczem);
 * - `tool_use` w pliku rozmowy przed dialogiem (wiadomość z jednym blokiem) albo dopiero razem z wynikiem; prośby
 *   jednego wątku czekające naraz to bloki jednej wiadomości, którą CLI zapisuje w całości przed pierwszym wynikiem,
 *   a nowej wiadomości wątek nie zaczyna przed wynikiem poprzedniej; dwa identyczne wywołania (bliźniaki);
 * - subagent w tle (tylko `all`, start w tle w pliku głównym): bez dialogu, póki jego hook czeka; po wyjściu albo
 *   śmierci hooka jego dialog staje w kolejce. Przy `main` hook subagenta nie czeka (bez kanału), a dialog stoi od
 *   razu;
 * - obserwacja: rejestr z tej chwili, z poprzedniego taktu albo nieznany; transkrypt znany albo nie; `ps` bez
 *   odpowiedzi; telefon wybiera kartę z przyciskiem i decyduje od razu albo dopiero po zdarzeniach następnego taktu.
 *
 * Mutanty (rejestracja i hook, które ufają zrzutowi; serwer bez przeglądu pliku rozmowy) sprawdzają, że wyrocznie obu
 * niezmienników wykrywają złamaną ochronę. Regułę `screen` (bramka wersji CLI, MCP, subagenci) sprawdza osobna rama
 * `layer1-property-frame.test.ts`.
 *
 * Deterministycznie: stałe ziarno i liczba przebiegów (`RAMA_KANALU_SEED`, `RAMA_KANALU_RUNS` zmieniają je przy
 * diagnozie); kontrprzykład wypisuje fast-check z ziarnem i ścieżką, liczniki pokrycia `RAMA_KANALU_POKAZ=1`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { createConsentEvidenceReview } from '../src/herdr/consent-evidence.ts';
import type { ConsentEvidenceReview } from '../src/herdr/consent-evidence.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { CONSENT_CHANNEL_MEASURED_CLI, HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import type { TurnToolResult, TurnToolUse } from '../src/herdr/dialogs/layer1/bind.ts';
import { presentConsentInput } from '../src/herdr/dialogs/layer1/card.ts';
import type { ConsentPresentation } from '../src/herdr/dialogs/layer1/card.ts';
import {
  CONSENT_CLAIMED_SUFFIX, CONSENT_DIRNAME, CONSENT_EVIDENCE_SCAN_INTERVAL_MS, CONSENT_FINAL_STATES,
  CONSENT_SECRET_BYTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { createConsentProofGate, createConsentTopLoss, observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentSessionSources } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentSubagentFile, TranscriptToolUses } from '../src/herdr/dialogs/layer1/proof.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import {
  CONSENT_NOT_BEFORE_MARGIN_MS, consentCardSha256, signConsentFile, verifyConsentFile,
} from '../src/herdr/dialogs/layer1/sign.ts';
import { REGISTRY_MAX_AGE_MS } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import { memoryIo } from './helpers/consent-memory-io.ts';

const SID = '00000000-0000-4000-9000-00000000c0d1';
const PROMPT = '00000000-0000-4000-9000-00000000c0d2';
const AGENT = 'a7c0ffee00000001';
const CWD = '/tmp/projekt';
const T0 = Date.parse('2026-11-11T12:00:00.000Z');
const SEED = Number(process.env['RAMA_KANALU_SEED'] ?? 20_261_111);
const RUNS = Number(process.env['RAMA_KANALU_RUNS'] ?? 1_500);
const PROPERTY_TIMEOUT_MS = 120_000;
const CLI = CONSENT_CHANNEL_MEASURED_CLI.cli;

const BASE = mkdtempSync(join(tmpdir(), 'rarog-rama-kanalu-'));
afterAll(() => { rmSync(BASE, { recursive: true, force: true }); });

// ---------------------------------------------------------------- scenariusz (wejście generatora)

type Mode = 'main' | 'all';
type Thread = 'main' | 'bg';
type Tool = 'Bash' | 'Edit';
/** Zrzut na dysku: jak u hooka, przycięty (marker) albo podmieniony (inne wejście z własnym skrótem, ten sam klucz). */
type DumpKind = 'full' | 'cut' | 'forged';

interface AskEv {
  readonly kind: 'ask';
  readonly thread: Thread;
  readonly tool: Tool;
  /** Wejście z małego zbioru: ten sam numer i narzędzie w jednym wątku = bliźniaki. */
  readonly input: number;
  readonly dump: DumpKind;
  /** `tool_use` w pliku rozmowy przed dialogiem albo dopiero razem z wynikiem. */
  readonly entry: 'before' | 'withResult';
  /** Hook przejmuje plik odpowiedzi dopiero w następnym takcie (inaczej zaraz po decyzji). */
  readonly slow: boolean;
  /** Nowy dialog na wierzchu kolejki zamiast na końcu (niezmierzone: dopuszczone). */
  readonly front: boolean;
}

/** Klawisz przy biurku na dialogu z wierzchu kolejki. */
interface DeskEv { readonly kind: 'desk'; readonly act: 'allow' | 'deny' }

/** Hook `pick`-tej czekającej prośby wychodzi bez odpowiedzi (`exit`) albo ginie od SIGKILL (`kill`). */
interface HookEv { readonly kind: 'exit' | 'kill'; readonly pick: number }

type Ev = AskEv | DeskEv | HookEv;

interface Obs {
  /** Rejestr CLI z chwili obserwacji, z poprzedniego taktu albo nieznany. */
  readonly reg: 'now' | 'lag' | 'unknown';
  readonly transcript: 'ok' | 'null';
  readonly psNull: boolean;
}

/** Telefon: `pick`-ta karta z przyciskiem; decyzja od razu albo po zdarzeniach następnego taktu (`late`). */
interface Phone { readonly pick: number; readonly act: 'allow' | 'deny'; readonly late: boolean }

interface Step { readonly events: readonly Ev[]; readonly obs: Obs; readonly phone: Phone | null }

interface Scenario { readonly steps: readonly Step[] }

// ---------------------------------------------------------------- prawda modelu

function inputOf(tool: Tool, n: number): Record<string, unknown> {
  return tool === 'Bash'
    ? { command: `npm test -- part${String(n)}`, description: 'Run the tests' }
    : { file_path: `${CWD}/src/a${String(n)}.ts`, old_string: 'a', new_string: `b${String(n)}`, replace_all: false };
}

interface Req {
  readonly n: number;
  readonly key: string;
  readonly thread: Thread;
  readonly tool: Tool;
  readonly inputNo: number;
  readonly input: Record<string, unknown>;
  readonly agentId: string | null;
  readonly pid: number;
  readonly startedAt: number;
  readonly dumpKind: DumpKind;
  readonly dump: HookCallDump | null;
  readonly toolUseId: string;
  readonly entry: AskEv['entry'];
  readonly slow: boolean;
  /** Sekret i chwila rejestracji (hook kanału); `null` = hook bez kanału (subagent przy `main`). */
  readonly secret: string | null;
  readonly registeredAt: number;
  readonly cardSha256: string;
  hook: 'waiting' | 'exited' | 'dead' | 'none';
  /** `hidden` = subagent w tle, póki jego hook czeka; `done` = wywołanie rozstrzygnięte. */
  dialog: 'hidden' | 'queued' | 'done';
  outcome: { readonly by: 'hook' | 'desk'; readonly decision: 'accept' | 'reject' } | null;
  useWritten: boolean;
  resultWritten: boolean;
  /** Chwila zapisu wyniku do pliku rozmowy. */
  resultAt: number | null;
}

/** Wykonanie po odpowiedzi hooka. */
interface Execution { readonly key: string; readonly decision: 'allow' | 'deny' }

/** Wynik przebiegu: naruszenia obu niezmienników osobno, liczniki pokrycia. */
interface RunResult {
  readonly n1: string[];
  readonly n3: string[];
  readonly counts: Map<string, number>;
}

const bump = (map: Map<string, number>, key: string, by = 1): void => { map.set(key, (map.get(key) ?? 0) + by); };

let runCounter = 0;
let lineCounter = 0;

const iso = (ms: number): string => new Date(ms).toISOString();
const uuid = (): string => {
  lineCounter += 1;
  return `00000000-0000-4000-9000-${lineCounter.toString(16).padStart(12, '0')}`;
};
const line = (entry: unknown): string => `${JSON.stringify(entry)}\n`;

function humanLine(at: number): string {
  return line({
    type: 'user', uuid: uuid(), timestamp: iso(at), sessionId: SID, promptId: PROMPT, isSidechain: false,
    origin: { kind: 'human' }, message: { role: 'user', content: 'do the work' },
  });
}

/** Wiadomość asystenta z blokami `tool_use` próśb jednego wątku (wiadomość z kilkoma blokami: jedna linia). */
function useLine(group: readonly Req[], at: number): string {
  const [first] = group;
  if (first === undefined) return '';
  const entry = {
    type: 'assistant', uuid: uuid(), timestamp: iso(at), sessionId: SID, isSidechain: first.agentId !== null,
    ...(first.agentId === null ? {} : { agentId: first.agentId }),
    message: {
      id: `msg_${first.toolUseId}`, role: 'assistant',
      content: group.map((req) => ({ type: 'tool_use', id: req.toolUseId, name: req.tool, input: req.input })),
    },
  };
  return line(entry);
}

function resultLine(req: Req, at: number, decision: 'accept' | 'reject', source: string): string {
  return line({
    type: 'user', uuid: uuid(), timestamp: iso(at), sessionId: SID, promptId: PROMPT, isSidechain: req.agentId !== null,
    ...(req.agentId === null ? {} : { agentId: req.agentId }),
    permissionDecision: { decision, source, reasonType: source, reasonCode: 'unknown' },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: req.toolUseId, is_error: decision === 'reject', content: 'ok' }],
    },
  });
}

function endLine(at: number): string {
  return line({
    type: 'system', subtype: 'turn_duration', uuid: uuid(), timestamp: iso(at), sessionId: SID, isSidechain: false,
    isMeta: false, durationMs: 4_000,
  });
}

/** Start subagenta w tle w pliku głównym: wywołanie `Agent` i wynik `async_launched` (kształt z CLI 2.1.319). */
function launchLines(at: number): string {
  const id = 'toolu_agent_launch_0000000001';
  return line({
    type: 'assistant', uuid: uuid(), timestamp: iso(at), sessionId: SID, isSidechain: false,
    message: {
      id: 'msg_agent', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { prompt: 'x' } }],
    },
  }) + line({
    type: 'user', uuid: uuid(), timestamp: iso(at + 100), sessionId: SID, promptId: PROMPT, isSidechain: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'launched' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: AGENT },
  });
}

function subOpenLine(at: number): string {
  return line({
    type: 'user', uuid: uuid(), timestamp: iso(at), sessionId: SID, promptId: PROMPT, isSidechain: true, agentId: AGENT,
    message: { role: 'user', content: 'background work' },
  });
}

// ---------------------------------------------------------------- przebieg scenariusza na kodzie produkcyjnym

/** Przebieg jednego scenariusza w trybie `mode`; `trace` = linie przebiegu dla opisu kontrprzykładu. */
/**
 * Mutant ramy (sprawdzian, że wyrocznie obu niezmienników wykrywają błąd): `trust-dump` = rejestracja ze skrótami
 * wejścia i karty ze zrzutu, a hook bez sprawdzenia `inputSha256` i `cardSha256` (obie ochrony zgody jednorazowej
 * naraz); `no-review` = serwer bez przeglądu pliku rozmowy.
 */
type Mutant = 'trust-dump' | 'no-review';

async function runScenario(
  sc: Scenario, mode: Mode, trace: string[] = [], mutant: Mutant | null = null,
): Promise<RunResult> {
  runCounter += 1;
  const run = runCounter;
  const n1: string[] = [];
  const n3: string[] = [];
  const counts = new Map<string, number>();
  let clock = T0 - 10_000;
  const now = (): number => clock;
  const dataDir = mkdtempSync(join(BASE, `r${String(run)}-`));
  const project = join(dataDir, 'projekt');
  const mainFile = join(project, `${SID}.jsonl`);
  const subFile = join(project, SID, 'subagents', `agent-${AGENT}.jsonl`);
  mkdirSync(dirname(subFile), { recursive: true });
  writeFileSync(mainFile, '');
  writeFileSync(subFile, '');
  const pendingDir = join(dataDir, HOOK_PENDING_DIRNAME, SID);
  mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
  const consentDir = join(dataDir, CONSENT_DIRNAME, SID);
  const files = new Map<string, string>();
  const bootId = 'boot-rama-kanalu';
  const reg = createConsentRegistry({ bootId, send: () => true, sessions: () => [SID], log: () => {}, now });
  reg.setScope(mode);
  const cycle: ConsentCycle = createConsentCycle({
    dataDir, bootId, registry: reg, now, io: memoryIo(files), mode: () => mode,
  });
  const gate = createConsentProofGate({ configured: 'channel', log: () => {} });
  const review: ConsentEvidenceReview = createConsentEvidenceReview({ cycle, locate: async () => mainFile, now });
  const topLoss = createConsentTopLoss();
  const reqs: Req[] = [];
  const queue: Req[] = [];
  /** Karta, na którą telefon się zgodził: prezentacja z chwili wyboru. */
  const signedAllows = new Map<string, ConsentPresentation | null>();
  const executions: Execution[] = [];
  let lastTruth: RegistryEvidence = { kind: 'active', at: clock, cliVersion: CLI };
  let launchAt = 0;

  const note = (text: string): void => { trace.push(`${String(clock - T0)} ms: ${text}`); };
  /**
   * Ta sama tożsamość wywołania, jaką widzi serwer: wątek, nazwa i skrót wejścia rekordu (ze zrzutu; zrzut podmieniony
   * niesie skrót innego wejścia).
   */
  const visibleSha = (req: Req): string => req.dump?.inputSha256 ?? canonicalSha256(req.input);
  const sameCall = (a: Req, b: Req): boolean => a.thread === b.thread && a.tool === b.tool
    && visibleSha(a) === visibleSha(b);
  /** Wynik `a` w pliku przed startem hooka `b`: wywołanie `a` skończyło się, zanim `b` zapytało. */
  const before = (a: Req, b: Req): boolean => a.resultAt !== null && a.resultAt < b.startedAt;
  /**
   * Bez bliźniaka: żadna inna prośba tego wątku z tą samą tożsamością nie nakłada się w czasie (wynik jednej przed
   * startem hooka drugiej rozdziela je: następne wywołanie przychodzi po wyniku poprzedniego).
   */
  const overlapping = (req: Req, same: (a: Req, b: Req) => boolean): boolean => reqs.some((other) => other !== req
    && same(other, req) && !before(other, req) && !before(req, other));
  const unique = (req: Req): boolean => !overlapping(req, sameCall);
  /** Bez bliźniaka w prawdzie modelu: także zrzut podmieniony nie ukrywa drugiego identycznego wywołania. */
  const alone = (req: Req): boolean => !overlapping(req, (a, b) => a.thread === b.thread && a.tool === b.tool
    && a.inputNo === b.inputNo);
  const fileOf = (req: Req): string => (req.agentId === null ? mainFile : subFile);
  const card = (key: string): ReturnType<ConsentCycle['cards']>[number] | undefined =>
    cycle.cards(SID).find((view) => view.permId === key);
  const button = (key: string): boolean => card(key)?.canAllow === true;
  const truth = (): RegistryEvidence => (queue.length > 0
    ? { kind: 'waiting', dialog: 'permission', at: clock, cliVersion: CLI }
    : { kind: 'active', at: clock, cliVersion: CLI });

  const writeDump = (req: Req): void => {
    if (req.dump !== null) writeFileSync(join(pendingDir, `${req.key}.json`), JSON.stringify(req.dump), { mode: 0o600 });
  };
  const dropDump = (req: Req): void => {
    if (req.dump === null) return;
    try {
      unlinkSync(join(pendingDir, `${req.key}.json`));
    } catch {
      // Zrzut już zniknął.
    }
  };
  const writeResult = (req: Req, decision: 'accept' | 'reject', source: string): void => {
    let text = '';
    if (!req.useWritten) {
      // Model: wiadomość z kilkoma blokami w całości przed pierwszym wynikiem (zapis razem z wynikami zmierzony na CLI
      // 2.1.319, `transcriptPassed` w `proof.ts`; plik rośnie w kolejności zapisu).
      const group = reqs.filter((r) => r.thread === req.thread && !r.useWritten && (r === req || r.dialog !== 'done'));
      text += useLine(group, clock);
      for (const r of group) r.useWritten = true;
    }
    text += resultLine(req, clock, decision, source);
    appendFileSync(fileOf(req), text);
    req.resultWritten = true;
    req.resultAt = clock;
  };
  const leaveQueue = (req: Req): void => {
    const at = queue.indexOf(req);
    if (at >= 0) queue.splice(at, 1);
  };
  /** Hook przestaje czekać: dialog subagenta w tle staje w kolejce (bez hooka CLI pokazuje go przy biurku). */
  const hookGone = (req: Req, state: 'exited' | 'dead'): void => {
    req.hook = state;
    if (state === 'exited') dropDump(req);
    if (req.dialog === 'hidden') {
      req.dialog = 'queued';
      queue.push(req);
    }
  };

  const ask = (ev: AskEv): void => {
    // Model: wątek nie zaczyna nowej wiadomości przed wynikami poprzedniej, więc prośby czekające naraz to bloki jednej
    // wiadomości, zapisanej dopiero razem z wynikami (zmierzone na CLI 2.1.319). Wiadomość z jednym blokiem już w pliku
    // = bez nowej prośby.
    const pendingSame = reqs.filter((r) => r.thread === ev.thread && r.dialog !== 'done');
    if (pendingSame.some((r) => r.useWritten)) {
      note(`prośba ${ev.tool}(${String(ev.input)}) ${ev.thread} pominięta: wątek czeka na wynik wiadomości`);
      return;
    }
    const entry = pendingSame.length > 0 ? 'withResult' : ev.entry;
    const n = reqs.length;
    const nonce = createHash('sha256').update(`rama-kanalu-${String(run)}-${String(n)}`).digest('hex').slice(0, 32);
    const key = `${PROMPT}-${nonce}`;
    const input = inputOf(ev.tool, ev.input);
    const agentId = ev.thread === 'bg' ? AGENT : null;
    // Przy `main` hook subagenta pomija czekanie: bez zrzutu i rejestracji, dialog stoi od razu.
    const channel = agentId === null || mode === 'all';
    const startedAt = clock + 50;
    const inputSha256 = canonicalSha256(input);
    const dumpInput = ev.dump === 'cut' ? { rarogTruncated: true, preview: 'npm' }
      : ev.dump === 'forged' ? inputOf(ev.tool, ev.input + 3) : input;
    const dump: HookCallDump | null = channel ? {
      key, sessionId: SID, promptId: PROMPT, pid: 70_000 + n, startedAt, toolName: ev.tool, toolInput: dumpInput,
      cwd: CWD, at: startedAt + 10, inputSha256: ev.dump === 'forged' ? canonicalSha256(dumpInput) : inputSha256,
      permissionMode: 'default', ...(agentId === null ? {} : { agentId }),
    } : null;
    const cardSha256 = consentCardSha256({
      sessionId: SID, toolName: ev.tool, toolInput: input, cwd: CWD, agentId, permissionMode: 'default',
    });
    const secret = channel ? randomBytes(CONSENT_SECRET_BYTES).toString('hex') : null;
    const req: Req = {
      n, key, thread: ev.thread, tool: ev.tool, inputNo: ev.input, input, agentId, pid: 70_000 + n, startedAt,
      dumpKind: ev.dump, dump, toolUseId: `toolu_rama_${String(run)}_${String(n).padStart(4, '0')}`, entry,
      slow: ev.slow, secret, registeredAt: startedAt + 20, cardSha256, hook: channel ? 'waiting' : 'none',
      dialog: agentId !== null && channel ? 'hidden' : 'queued', outcome: null, useWritten: false,
      resultWritten: false, resultAt: null,
    };
    reqs.push(req);
    if (req.dialog === 'queued') {
      if (ev.front) queue.unshift(req);
      else queue.push(req);
    }
    if (entry === 'before') {
      appendFileSync(fileOf(req), useLine([req], clock));
      req.useWritten = true;
    }
    if (secret !== null && dump !== null) {
      const registered = mutant === 'trust-dump' ? consentCardSha256({
        sessionId: SID, toolName: ev.tool, toolInput: dump.toolInput, cwd: CWD, agentId, permissionMode: 'default',
      }) : cardSha256;
      const outcome = reg.register({
        key, sessionId: SID, promptId: PROMPT, secret, cardSha256: registered, pid: req.pid, startedAt,
        inputSha256: mutant === 'trust-dump' ? dump.inputSha256 : inputSha256,
        ...(agentId === null ? {} : { agentId }),
      });
      if (outcome.status !== 200) throw new Error(`rejestracja ${key} odrzucona: ${JSON.stringify(outcome.body)}`);
      writeDump(req);
    }
    note(`prośba #${String(n)} ${ev.tool}(${String(ev.input)}) ${ev.thread} zrzut ${ev.dump} wpis ${entry}`
      + `${ev.front ? ' na wierzchu' : ''}`);
  };

  const desk = (ev: DeskEv): void => {
    const top = queue[0];
    if (top === undefined) return;
    leaveQueue(top);
    top.dialog = 'done';
    top.outcome = { by: 'desk', decision: ev.act === 'allow' ? 'accept' : 'reject' };
    writeResult(top, top.outcome.decision, ev.act === 'allow' ? 'user_temporary' : 'user_reject');
    note(`biurko ${ev.act} #${String(top.n)}`);
  };

  const hookEv = (ev: HookEv): void => {
    const waiting = reqs.filter((req) => req.hook === 'waiting');
    const req = waiting[ev.pick % Math.max(1, waiting.length)];
    if (req === undefined) return;
    hookGone(req, ev.kind === 'exit' ? 'exited' : 'dead');
    note(`hook #${String(req.n)} ${ev.kind}`);
  };

  /** Hooki przejmują pliki odpowiedzi; `all` = także hooki wolne (początek taktu). */
  const claims = (all: boolean): void => {
    for (const req of reqs) {
      if (req.hook !== 'waiting' || req.secret === null || (req.slow && !all)) continue;
      const path = join(consentDir, `${req.key}.json`);
      const body = files.get(path);
      if (body === undefined) continue;
      files.delete(path);
      files.set(join(consentDir, `${req.key}${CONSENT_CLAIMED_SUFFIX}`), body);
      const raw = JSON.parse(body) as { inputSha256?: unknown; cardSha256?: unknown };
      const trusting = mutant === 'trust-dump' && typeof raw.inputSha256 === 'string' && typeof raw.cardSha256 === 'string';
      const verdict = verifyConsentFile(raw, {
        secret: req.secret, sessionId: SID, key: req.key,
        inputSha256: trusting ? String(raw.inputSha256) : canonicalSha256(req.input),
        cardSha256: trusting ? String(raw.cardSha256) : req.cardSha256,
        notBefore: req.registeredAt - CONSENT_NOT_BEFORE_MARGIN_MS,
      });
      if (!verdict.ok) {
        // Hook odrzuca plik i wraca do biurka: bez skutku, ale serwer podpisał coś, czego hook nie przyjmuje.
        n1.push(`hook #${String(req.n)} odrzucił podpisany plik (${verdict.reason})`);
        hookGone(req, 'exited');
        continue;
      }
      const decision = verdict.file.decision;
      hookGone(req, 'exited');
      if (decision === 'release') {
        note(`hook #${String(req.n)} zwolniony do biurka`);
        continue;
      }
      if (req.dialog === 'done') {
        // Późna odpowiedź po decyzji przy biurku: CLI na nią już nie czeka, nic się nie wykonuje (zmierzone).
        bump(counts, `orphan-${decision}`);
        note(`hook #${String(req.n)} sierota dostał ${decision}: bez skutku`);
        continue;
      }
      leaveQueue(req);
      req.dialog = 'done';
      const accepted = decision === 'allow';
      req.outcome = { by: 'hook', decision: accepted ? 'accept' : 'reject' };
      executions.push({ key: req.key, decision: accepted ? 'allow' : 'deny' });
      writeResult(req, req.outcome.decision, 'hook');
      bump(counts, accepted ? `exec-${req.thread}` : 'hook-deny');
      note(`hook #${String(req.n)} ${decision}: CLI ${accepted ? 'wykonuje' : 'odmawia'}`);
      if (accepted) checkN1(req);
    }
  };

  /** Zgoda jednorazowa: wykonanie po `allow` tylko na kartę z przyciskiem i pełną treścią wykonanego wywołania. */
  const checkN1 = (req: Req): void => {
    if (executions.filter((e) => e.key === req.key).length > 1) n1.push(`#${String(req.n)} wykonane dwa razy`);
    if (!signedAllows.has(req.key)) {
      n1.push(`#${String(req.n)} wykonane po allow, na które telefon się nie zgodził`);
      return;
    }
    const shown = signedAllows.get(req.key) ?? null;
    const expected = presentConsentInput(req.tool, req.input);
    if (JSON.stringify(shown) !== JSON.stringify(expected)) {
      n1.push(`#${String(req.n)} wykonane wejście inne niż na karcie (zrzut ${req.dumpKind})`);
    }
    if (req.dumpKind !== 'full') n1.push(`#${String(req.n)} wykonane po karcie ze zrzutem ${req.dumpKind}`);
    if (mode === 'main' && req.agentId !== null) n1.push(`#${String(req.n)} subagent wykonany z telefonu przy main`);
  };

  const subagentFacts = (): ConsentSubagentFile => {
    const uses: TurnToolUse[] = [];
    const results: TurnToolResult[] = [];
    for (const req of reqs) {
      if (req.agentId === null) continue;
      if (req.useWritten) {
        uses.push({ id: req.toolUseId, name: req.tool, inputSha256: canonicalSha256(req.input), line: 2 + req.n });
      }
      if (req.resultWritten && req.outcome !== null) {
        results.push({
          toolUseId: req.toolUseId, line: 100 + req.n, at: req.resultAt, decision: req.outcome.decision,
          source: req.outcome.by === 'hook' ? 'hook' : req.outcome.decision === 'accept' ? 'user_temporary' : 'user_reject',
          interrupted: false,
        });
      }
    }
    return {
      partial: false, toolUses: uses, results, settled: true, caughtUp: true,
      agent: { launch: { at: launchAt }, ends: [], settled: true },
    };
  };

  const transcriptOf = (): TranscriptToolUses => ({
    open: reqs.filter((r) => r.agentId === null && r.useWritten && !r.resultWritten)
      .map((r) => ({ toolName: r.tool, input: r.input })),
    closed: reqs.filter((r) => r.agentId === null && r.resultWritten)
      .map((r) => ({ toolName: r.tool, inputSha256: canonicalSha256(r.input), closedAt: r.resultAt })),
    lostAt: null,
  });

  const observe = async (obs: Obs): Promise<void> => {
    const current = truth();
    const registry: RegistryEvidence = obs.reg === 'now' ? current
      : obs.reg === 'lag' ? lastTruth : { kind: 'unknown', why: 'unread' };
    lastTruth = current;
    const sources: ConsentSessionSources = {
      dataDir, sessionId: SID, registry, screen: null, now,
      transcript: obs.transcript === 'ok' ? transcriptOf() : null,
      liveness: async (processes) => new Map(processes.map((p) => {
        const req = reqs.find((r) => r.pid === p.pid);
        return [p.pid, obs.psNull ? null : req?.hook === 'waiting'];
      })),
      proofRule: gate.ruleFor(SID, registry),
      ...(mode === 'all' ? {
        subagentTurns: async (requests) => requests.map(() => subagentFacts()),
        hidden: { topLoss, sessionHooks: async (_sid, dumps) => new Set(dumps.map((d) => d.key)) },
      } : {}),
    };
    await observeConsentSession(cycle, sources);
    // Prawda na karcie: odczyt rejestru bez `waiting` zdejmuje przycisk każdej karcie wątku głównego w tym takcie.
    if (registry.kind === 'active' && clock - registry.at <= REGISTRY_MAX_AGE_MS) {
      for (const req of reqs) {
        if (req.agentId === null && button(req.key)) {
          n3.push(`#${String(req.n)} z przyciskiem po odczycie rejestru bez waiting`);
        }
      }
    }
  };

  /** Prawda na karcie: wynik wywołania bez bliźniaka w pliku rozmowy przed przeglądem zdejmuje przycisk karty. */
  const reviewTick = async (): Promise<void> => {
    const seen = reqs.filter((req) => req.resultWritten);
    if (mutant !== 'no-review') await review.tick();
    for (const req of seen) {
      if (unique(req) && button(req.key)) n3.push(`#${String(req.n)} z przyciskiem po przeglądzie z wynikiem w pliku`);
    }
  };

  const decide = async (key: string, act: Phone['act'], shown: ConsentPresentation | null): Promise<void> => {
    const outcome = await cycle.decide(SID, key, act);
    const req = reqs.find((r) => r.key === key);
    note(`telefon ${act} #${String(req?.n ?? -1)}: ${outcome.ok ? 'ok' : outcome.error}`);
    if (!outcome.ok) {
      bump(counts, `refused-${outcome.error}`);
      return;
    }
    bump(counts, `phone-${act}`);
    if (act === 'allow') signedAllows.set(key, shown);
    claims(false);
  };

  type Pick = { readonly key: string; readonly act: Phone['act']; readonly shown: ConsentPresentation | null };
  let latePhone: Pick | null = null;

  try {
    // Proces serwera wstał 10 s przed scenariuszem; odczyt rejestru bez `waiting` 5 s przed nim.
    clock = T0 - 5_000;
    await observeConsentSession(cycle, {
      dataDir, sessionId: SID, liveness: async () => new Map(), registry: { kind: 'active', at: clock, cliVersion: CLI },
      transcript: null, screen: null, now, proofRule: 'channel',
    });
    clock = T0 - 2_000;
    let opening = humanLine(clock);
    if (mode === 'all') {
      launchAt = clock + 600;
      opening += launchLines(clock + 500);
      appendFileSync(subFile, subOpenLine(clock + 700));
    }
    appendFileSync(mainFile, opening);
    clock = T0;
    const steps: Step[] = [...sc.steps, ...Array.from({ length: 3 }, (): Step => ({
      events: [], obs: { reg: 'now', transcript: 'ok', psNull: false }, phone: null,
    }))];
    for (const step of steps) {
      clock += 300;
      await cycle.tick();
      claims(true);
      for (const ev of step.events) {
        clock += 100;
        if (ev.kind === 'ask') ask(ev);
        else if (ev.kind === 'desk') desk(ev);
        else hookEv(ev);
      }
      if (latePhone !== null) {
        clock += 100;
        const { key, act, shown } = latePhone;
        latePhone = null;
        await decide(key, act, shown);
      }
      clock += 200;
      await observe(step.obs);
      clock += 100;
      await reviewTick();
      if (step.phone !== null) {
        const phone = step.phone;
        const cards = cycle.cards(SID).filter((view) => (phone.act === 'allow' ? view.canAllow : view.canDeny));
        const chosen = cards[phone.pick % Math.max(1, cards.length)];
        if (chosen !== undefined) {
          const shown = chosen.presentation;
          if (phone.late) {
            latePhone = { key: chosen.permId, act: phone.act, shown };
          } else {
            clock += 300;
            await decide(chosen.permId, phone.act, shown);
          }
        }
      }
      clock += 500;
    }
    // Koniec tury, gdy w wątku głównym nic nie stoi; przegląd po tempie przeglądu doczytuje koniec.
    if (!reqs.some((r) => r.agentId === null && r.dialog !== 'done')) {
      appendFileSync(mainFile, endLine(clock));
      note('koniec tury');
    }
    for (let i = 0; i < 2; i += 1) {
      clock += CONSENT_EVIDENCE_SCAN_INTERVAL_MS;
      await cycle.tick();
      claims(true);
      await reviewTick();
    }
    finalChecks(reqs, cycle, { unique, alone }, n3, counts);
    return { n1, n3, counts };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * Stan końcowy: `settled-at-desk` tylko przy jednoznacznym klawiszu przy biurku na własnym wywołaniu klucza;
 * `applied` only for a phone `deny` under a full dump whose hook `reject` is bound to the key's own call (a `deny`
 * needs no receipt, an `allow` without one never reaches it, a truncated dump has no card digest to prove the call). `unique` = bez bliźniaka, którego widzi serwer (skrót rekordu), `alone` = bez
 * bliźniaka w prawdzie modelu.
 */
function finalChecks(
  reqs: readonly Req[], cycle: ConsentCycle,
  twins: { readonly unique: (req: Req) => boolean; readonly alone: (req: Req) => boolean }, n3: string[],
  counts: Map<string, number>,
): void {
  const { unique, alone } = twins;
  for (const req of reqs) {
    const record = cycle.record(SID, req.key);
    if (record === null) continue;
    bump(counts, `final-${record.state}${record.cause === null ? '' : `-${record.cause}`}`);
    const name = `#${String(req.n)}`;
    const hookDeny = req.outcome?.by === 'hook' && req.outcome.decision === 'reject';
    // A dump the hook truncated has no card digest: the call of its answer is not proven (`consentAnswerProven`).
    const provenDeny = hookDeny && req.dumpKind === 'full';
    if (record.state === 'applied' && !(provenDeny && record.decision === 'deny')) {
      n3.push(`${name} applied bez potwierdzenia odbioru`);
    }
    if (record.state === 'settled-at-desk') {
      const desk = req.outcome?.by === 'desk';
      if (!desk || !unique(req)) n3.push(`${name} settled-at-desk bez jednoznacznego klawisza przy biurku`);
      if (record.toolUseId !== req.toolUseId) n3.push(`${name} settled-at-desk związany z cudzym wywołaniem`);
      const decision = req.outcome?.decision === 'accept' ? 'allow' : 'deny';
      const recorded = (record as { deskDecision?: string }).deskDecision;
      if (desk && recorded !== decision) n3.push(`${name} decyzja przy biurku ${String(recorded)} zamiast ${decision}`);
    }
    // Wynik z odpowiedzi hooka bez potwierdzenia odbioru: bez bliźniaka (ani widocznego, ani w prawdzie) i ze skrótem
    // zrzutu zgodnym z wywołaniem (rekord wiąże się z wpisem) rozliczony w turze na własnym wywołaniu: `allow` jako
    // `unknown` (`no-receipt`), `deny` under a full dump as `applied` (it needs no receipt), under a truncated one as
    // `unknown` (`no-receipt`); inaczej stan końcowy tylko `unknown`
    // (bliźniak, który jeszcze stoi, zostawia rekord otwarty).
    if (req.outcome?.by === 'hook') {
      const bindable = unique(req) && alone(req) && req.dumpKind !== 'forged';
      const final = (CONSENT_FINAL_STATES as readonly string[]).includes(record.state);
      const own = record.toolUseId === req.toolUseId;
      const settled = provenDeny
        ? record.state === 'applied' && record.decision === 'deny' && own
        : record.state === 'unknown' && record.cause === 'no-receipt' && own;
      const expected = provenDeny ? 'applied' : 'unknown/no-receipt';
      if (bindable ? !settled : final && record.state !== 'unknown') {
        n3.push(`${name} wynik hooka kończy się ${record.state}/${String(record.cause)}`
          + ` zamiast ${bindable ? expected : 'unknown'}`);
      }
    }
  }
}

// ---------------------------------------------------------------- generator

function weighted<T>(...pairs: readonly (readonly [T, number])[]): fc.Arbitrary<T> {
  return fc.oneof(...pairs.map(([value, weight]) => ({ arbitrary: fc.constant(value), weight })));
}

const askArb: fc.Arbitrary<AskEv> = fc.record({
  kind: fc.constant('ask' as const),
  thread: weighted<Thread>(['main', 3], ['bg', 1]),
  tool: weighted<Tool>(['Bash', 2], ['Edit', 1]),
  input: fc.integer({ min: 0, max: 2 }),
  dump: weighted<DumpKind>(['full', 12], ['cut', 1], ['forged', 1]),
  entry: weighted<AskEv['entry']>(['before', 3], ['withResult', 1]),
  slow: fc.boolean(),
  front: weighted([false, 7], [true, 1]),
});

const evArb: fc.Arbitrary<Ev> = fc.oneof(
  { arbitrary: askArb, weight: 4 },
  {
    arbitrary: fc.record({ kind: fc.constant('desk' as const), act: weighted<DeskEv['act']>(['allow', 2], ['deny', 1]) }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: weighted<HookEv['kind']>(['exit', 1], ['kill', 1]), pick: fc.nat(3) }), weight: 1 },
);

const obsArb: fc.Arbitrary<Obs> = fc.record({
  reg: weighted<Obs['reg']>(['now', 6], ['lag', 2], ['unknown', 1]),
  transcript: weighted<Obs['transcript']>(['ok', 5], ['null', 1]),
  psNull: weighted([false, 8], [true, 1]),
});

const phoneArb: fc.Arbitrary<Phone | null> = fc.option(fc.record({
  pick: fc.nat(3), act: weighted<Phone['act']>(['allow', 4], ['deny', 1]), late: fc.boolean(),
}), { freq: 4 });

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  steps: fc.array(fc.record({ events: fc.array(evArb, { maxLength: 2 }), obs: obsArb, phone: phoneArb }), {
    minLength: 2, maxLength: 8,
  }),
});

// ---------------------------------------------------------------- przypadki stałe i właściwości

const OBS: Obs = { reg: 'now', transcript: 'ok', psNull: false };
const step = (events: readonly Ev[], phone: Phone | null = null, obs: Obs = OBS): Step => ({ events, obs, phone });
const ask = (over: Partial<AskEv> = {}): AskEv => ({
  kind: 'ask', thread: 'main', tool: 'Bash', input: 0, dump: 'full', entry: 'before', slow: false, front: false, ...over,
});
const allowNow: Phone = { pick: 0, act: 'allow', late: false };

const SHOW = process.env['RAMA_KANALU_POKAZ'] === '1';

function checked(label: 'n1' | 'n3', mode: Mode, sum: Map<string, number>, mutant: Mutant | null) {
  return fc.asyncProperty(scenarioArb, async (sc) => {
    const trace: string[] = [];
    const result = await runScenario(sc, mode, trace, mutant);
    for (const [key, value] of result.counts) bump(sum, key, value);
    const bad = label === 'n1' ? result.n1 : result.n3;
    if (bad.length > 0) throw new Error(`${bad.join('; ')}\n${trace.join('\n')}`);
  });
}

async function property(label: 'n1' | 'n3', mode: Mode): Promise<Map<string, number>> {
  const sum = new Map<string, number>();
  await fc.assert(checked(label, mode, sum, null), { seed: SEED, numRuns: RUNS });
  if (SHOW) console.log(`${label} ${mode}:`, Object.fromEntries([...sum].sort()));
  return sum;
}

/** Mutant musi dać kontrprzykład; minimalny wypisuje `RAMA_KANALU_POKAZ=1`. */
async function mutantFound(label: 'n1' | 'n3', mode: Mode, mutant: Mutant): Promise<boolean> {
  const result = await fc.check(checked(label, mode, new Map(), mutant), { seed: SEED, numRuns: RUNS });
  if (SHOW && result.failed) console.log(`${label} ${mode} ${mutant}:`, String(result.errorInstance));
  return result.failed;
}

const MODES: readonly Mode[] = ['main', 'all'];

describe('rama kanału przy regule channel: przypadki stałe (model i kod produkcyjny)', () => {
  it('zgoda z telefonu na kartę z pełną treścią: hook przyjmuje podpis, CLI wykonuje, rekord `unknown` (`no-receipt`)',
    async () => {
      const result = await runScenario({ steps: [step([ask()], allowNow), step([])] }, 'main');
      expect(result).toMatchObject({ n1: [], n3: [] });
      expect(result.counts.get('exec-main')).toBe(1);
      expect(result.counts.get('final-unknown-no-receipt')).toBe(1);
    });

  it('decyzja przy biurku, potem późna zgoda z telefonu: nic się nie wykonuje, rekord `settled-at-desk`', async () => {
    const result = await runScenario({
      steps: [
        step([ask({ entry: 'withResult' }), ask({ input: 1 })], { pick: 0, act: 'allow', late: true }),
        step([{ kind: 'desk', act: 'allow' }]),
      ],
    }, 'main');
    expect(result).toMatchObject({ n1: [], n3: [] });
    expect(result.counts.get('exec-main') ?? 0).toBe(0);
    expect(result.counts.get('final-settled-at-desk')).toBeGreaterThanOrEqual(1);
  });

  it('bliźniaki `Bash`: jeden przy biurku, drugi z telefonu; żaden nie kończy się `settled-at-desk` ani `applied`',
    async () => {
      const result = await runScenario({
        steps: [step([ask({ entry: 'withResult' }), ask()]), step([{ kind: 'desk', act: 'allow' }], allowNow), step([])],
      }, 'main');
      expect(result).toMatchObject({ n1: [], n3: [] });
      expect(result.counts.get('final-settled-at-desk') ?? 0).toBe(0);
      expect(result.counts.get('final-applied') ?? 0).toBe(0);
    });

  it.each([['cut'], ['forged']] as const)('zrzut %s: karta bez przycisku zgody, telefon nie ma czego wybrać',
    async (dump) => {
      const result = await runScenario({ steps: [step([ask({ dump })], allowNow), step([])] }, 'main');
      expect(result).toMatchObject({ n1: [], n3: [] });
      expect(result.counts.get('phone-allow') ?? 0).toBe(0);
    });

  it('plik odpowiedzi jednej prośby u hooka bliźniaka: podpis wiąże klucz, hook odrzuca (`binding`)', () => {
    const secret = randomBytes(CONSENT_SECRET_BYTES).toString('hex');
    const input = inputOf('Bash', 0);
    const cardSha256 = consentCardSha256({
      sessionId: SID, toolName: 'Bash', toolInput: input, cwd: CWD, agentId: null, permissionMode: 'default',
    });
    const inputSha256 = canonicalSha256(input);
    // Ten sam sekret u obu hooków: nawet wtedy klucz w podpisie odróżnia pliki bliźniaków.
    const signed = signConsentFile(secret, {
      key: `${PROMPT}-${'a'.repeat(32)}`, sessionId: SID, decision: 'allow', reasonId: 'allow', inputSha256, cardSha256,
      at: T0,
    });
    const own = { secret, sessionId: SID, inputSha256, cardSha256, notBefore: T0 - 1 };
    expect(verifyConsentFile(signed, { ...own, key: signed.key })).toMatchObject({ ok: true });
    expect(verifyConsentFile(signed, { ...own, key: `${PROMPT}-${'b'.repeat(32)}` }))
      .toEqual({ ok: false, reason: 'binding' });
  });

  it('subagent w tle przy `all`: zgoda z telefonu wykonuje wywołanie hookiem, wynik z pliku subagenta daje `unknown`',
    async () => {
      const result = await runScenario({ steps: [step([ask({ thread: 'bg' })], allowNow), step([])] }, 'all');
      expect(result).toMatchObject({ n1: [], n3: [] });
      expect(result.counts.get('exec-bg')).toBe(1);
      expect(result.counts.get('final-unknown-no-receipt')).toBe(1);
    });

  it('subagent przy `main`: hook bez kanału, karta bez przycisku, dialog rozstrzyga biurko', async () => {
    const result = await runScenario({
      steps: [step([ask({ thread: 'bg' })], allowNow), step([{ kind: 'desk', act: 'deny' }])],
    }, 'main');
    expect(result).toMatchObject({ n1: [], n3: [] });
    expect(result.counts.get('phone-allow') ?? 0).toBe(0);
  });
});

describe.each(MODES)('zgoda jednorazowa przy trybie subagentów %s', (mode) => {
  it(`${String(RUNS)} przebiegów ziarna ${String(SEED)}: każde wykonanie po allow to karta z pełną treścią tego wywołania`,
    async () => {
      const sum = await property('n1', mode);
      expect(sum.get('exec-main') ?? 0).toBeGreaterThan(0);
      expect(sum.get('orphan-allow') ?? 0).toBeGreaterThan(0);
      if (mode === 'all') expect(sum.get('exec-bg') ?? 0).toBeGreaterThan(0);
    }, PROPERTY_TIMEOUT_MS);
});

describe.each(MODES)('prawda na karcie przy trybie subagentów %s', (mode) => {
  it(`${String(RUNS)} przebiegów ziarna ${String(SEED)}: przycisk znika w takcie wyniku albo rejestru bez waiting,`
    + ' stan końcowy tylko przy jednoznacznym wiązaniu, `applied` only for a phone `deny`', async () => {
    const sum = await property('n3', mode);
    expect(sum.get('final-settled-at-desk') ?? 0).toBeGreaterThan(0);
    expect(sum.get('final-unknown-no-receipt') ?? 0).toBeGreaterThan(0);
    // Every `applied` is a phone `deny` on its own call: the oracle (`finalChecks`) fails any other.
    expect(sum.get('final-applied') ?? 0).toBeGreaterThan(0);
  }, PROPERTY_TIMEOUT_MS);
});

describe.each(MODES)('mutanty ramy przy trybie subagentów %s: wyrocznia wykrywa złamaną ochronę', (mode) => {
  it('rejestracja ze skrótami ze zrzutu i hook bez sprawdzenia skrótów = wykonanie innej treści niż'
    + ' na karcie', async () => {
    expect(await mutantFound('n1', mode, 'trust-dump')).toBe(true);
  }, PROPERTY_TIMEOUT_MS);

  it('serwer bez przeglądu pliku rozmowy = przycisk po wyniku w pliku', async () => {
    expect(await mutantFound('n3', mode, 'no-review')).toBe(true);
  }, PROPERTY_TIMEOUT_MS);
});
