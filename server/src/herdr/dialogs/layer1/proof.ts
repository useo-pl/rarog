/**
 * Dowody kanału zgód (warstwa 1): czy dialog prośby stoi i co transkrypt mówi o skutku decyzji.
 *
 * - {@link consentKeyRule}: the proof rule of a main-thread request. Under `channel` (the default,
 *   `RAROG_CONSENT_PROOF`) a main-thread card outside MCP gets `standing` without the screen top: the own proof and
 *   a fresh registry read `waiting` of the `permission` class suffice, because the hook gives a signed `allow` only
 *   for the call it waits for, and a late `allow` after a desk decision runs nothing (measured on the release
 *   `CONSENT_CHANNEL_MEASURED_CLI`, and by the canary on each release it passed). The session rules per request kind
 *   come from the version gate (`version-gate.ts`). The `screen` rule, an MCP tool (a bare `allow` does not close an
 *   MCP dialog with interaction; with the dump's MCP marker the card has no button, `card.ts`) and a subagent request
 *   count the top below; a subagent request under the subagents' `channel` rule has the hidden proof without the top
 *   ({@link consentHiddenKeyRule}).
 * - {@link consentDialogSignals}: dowód „dialog stoi”. `standing` daje wyłącznie komplet:
 *   dowód własny zrzutu z reguł trybu cienia (`shadow/evidence.ts`: żywy proces hooka, wątek główny, skrót zgodny,
 *   bez faktu utraty i bez własnego zamknięcia w transkrypcie), świeży rejestr CLI `waiting` z klasą `permission`
 *   i, przy regule `screen`, zrzut na wierzchu ekranu ({@link consentTopWinner}: jedyny kandydat pełnej puli sesji
 *   z `match`). Reguła licząca
 *   cienia (licznik kolejki, bliźniaki o tym samym skrócie) z dowodu znika: tożsamość niesie wierzch. `gone` to sygnał
 *   negatywny przy żywym hooku (rejestr bez `waiting`, transkrypt bez otwartego wywołania), `dead` martwy proces,
 *   a niewiadoma `unknown` niczego nie zabiera i niczego nie daje. Sygnał negatywny zabiera wyłącznie dowód własny;
 *   żaden nie daje dowodu innemu zrzutowi. Opcja warstwy 1 wobec cienia: skrót wejścia bez otwartego odpowiednika
 *   (`transkrypt-skrot` cienia) niczego nie zabiera i sieroty nie robi, bo prośby tej nazwy rozdziela wierzch; brak
 *   prośby w transkrypcie zabiera dowód dopiero wtedy, gdy transkrypt poszedł dalej niż ona ({@link transcriptPassed});
 *   zrzut, który dowód stracił na stałe (fakty cyklu, `cycle.ts`), nie ma go przy żadnym transkrypcie i po 5 s od
 *   zapisu zrzutu daje `gone`. Przy kanale otwartym dla subagentów (`all`, 5.4) prośba subagenta ma dowód
 *   własny z tych samych reguł, gdy fakty jej pliku są znane do końca ({@link subagentClosures}): zamknięcia z jej
 *   pliku zamiast transkryptu wątku głównego, a rejestr bez `waiting` zabiera jej dowód (`unknown`), nie daje `gone`.
 * - {@link subagentClosures}: pamięć zamknięć tury subagenta z faktów jego pliku dla {@link transcriptPassed}.
 * - {@link consentHiddenProofs}: dowód ukryty prośby subagenta (5.3) z faktów obserwacji bez ekranu: przy
 *   regule `channel` ({@link consentHiddenKeyRule}) każdej prośby subagenta z warunków żywego hooka i pliku subagenta,
 *   przy `screen` prośby w tle ze wszystkich warunków {@link consentHiddenProofs}; termin i tryb sprawdza cykl.
 * - {@link consentTopWinner}: zrzut na wierzchu ekranu z puli sesji (`cycle.ts`) i dopasowania (`top.ts`).
 * - Diagnostyka bez wpływu na decyzję (linia logu `consent: proof of key … missing` w `cycle.ts`): te same funkcje
 *   z powodem, który człon odpadł: {@link consentDialogFindings} (dowód własny i rejestr), {@link consentTopVerdict}
 *   (wierzch z puli) i {@link consentTopMissText} (człon wierzchu w linii logu); {@link unknownTopOf} czyta z członów
 *   nieznany element wierzchu (wyzwalacz zrzutu ekranu w `refusals/`).
 * - {@link claimedDialogSignal}: dialog karty `claimed`, której hook nie żyje albo wyszedł, z rejestru CLI
 *   odczytanego po odbiorze, z innych żywych zrzutów sesji i, przy regule `screen`, z wierzchu ekranu.
 * - {@link consentEffectOf}: skutek z wyniku ZWIĄZANEGO wywołania (`bind.ts`). `permissionDecision.source == "hook"`
 *   to rozstrzygnięcie hookiem (`accept` = `allow`, `reject` = `deny`), `user_*` albo wynik przerwania bez źródła to
 *   klawisz przy biurku. Plik `.claimed` nie jest dowodem skutku (SIGKILL hooka po przejęciu).
 * - {@link consentSettlement}: the state after the result for the record's state and decision; `applied` only when
 *   the effect is the record's own answer ({@link consentAnswerProven}: the answer signed under a registration of the
 *   record's own tool name and call identity, and an `allow` with the hook's receipt);
 *   {@link consentDeskDecisionOf}: decyzja klawisza przy biurku dla urządzeń.
 *
 * Czyste funkcje nad jawnymi wejściami: bez dysku, zegara i transkryptu.
 */
import type { CliDialogClass } from '../../../cli-version.ts';
import { canonicalSha256 } from '../hook/canon.ts';
import type { HookCallDump } from '../hook/contract.ts';
import { REGISTRY_MAX_AGE_MS, REGISTRY_SLACK_MS, orphanHooks, standingProofs } from '../shadow/evidence.ts';
import type {
  EvidenceInput, Layer1Evidence, NoProofReason, OpenToolUse, RegistryEvidence,
} from '../shadow/evidence.ts';
import type { ConsentAgentEnd, ConsentAgentTurn, TurnToolResult, TurnToolUse } from './bind.ts';
import { CONSENT_CALL_FIELDS, CONSENT_COMPARABLE_TOOL_PREFIX, CONSENT_NAME_ONLY_TOOLS } from './contract.ts';
import type {
  ConsentCycleState, ConsentDecision, ConsentDeskDecision, ConsentProofRule, ConsentUnknownCause,
} from './contract.ts';
import type { ConsentCall, ConsentSigned } from './records.ts';
import type { ConsentScreenRead, MatchTop, TopDump, TopScreen, TopScreenMiss } from './top.ts';

export type { ConsentProofRule };

/**
 * Reguła dowodu jednej prośby przy regule sesji `rule`: `channel` tylko dla wątku głównego (subagenci: dowód ukryty,
 * {@link consentHiddenKeyRule}) i narzędzia spoza MCP (gołe `allow` nie zamyka dialogu MCP
 * z `requiresUserInteraction`, pomiar 3 z 3; the dump's marker of an empty suggestion list takes the card's button
 * away, but its absence does not prove a plain MCP tool, so MCP stays `screen`); reszta `screen`.
 */
export function consentKeyRule(
  rule: ConsentProofRule, request: { readonly toolName: string; readonly agentId?: string | null },
): ConsentProofRule {
  if (rule !== 'channel' || (request.agentId ?? null) !== null) return 'screen';
  return request.toolName.startsWith(CONSENT_COMPARABLE_TOOL_PREFIX) ? 'screen' : 'channel';
}

/** Sygnał o dialogu prośby jednego klucza. */
export type ConsentDialogSignal = 'standing' | 'gone' | 'dead' | 'unknown';

/**
 * Zamknięty `tool_use` wątku głównego (wynikiem albo końcem tury) z pamięci zamknięć: nazwa, skrót wejścia policzony
 * przy zamknięciu i chwila wpisu, który go zamknął.
 */
export interface ClosedToolUse {
  readonly toolName: string;
  /** `canonicalSha256` wejścia z wpisu (postać `inputSha256` zrzutu); `null` = nie dał się policzyć. */
  readonly inputSha256: string | null;
  /** ms epoki; `null` = wpis bez czytelnej chwili. */
  readonly closedAt: number | null;
}

/** Wywołania z transkryptu wątku głównego, które dostaje kanał zgód. */
export interface TranscriptToolUses {
  readonly open: readonly OpenToolUse[];
  readonly closed: readonly ClosedToolUse[];
  /**
   * Najpóźniejsza chwila (ms epoki) zamknięcia, którego pamięć `closed` nie ma, choć mogło się zdarzyć (wyparte ponad
   * limit, wynik bez znanego `tool_use`, luka odczytu); `null` = pamięć ma wszystko, co czytnik przeczytał.
   */
  readonly lostAt: number | null;
}

/**
 * Czy transkrypt poszedł dalej niż prośba zrzutu: zamknięte wywołanie tej prośby wpisem nie starszym niż start
 * procesu hooka. Wynik wcześniejszego identycznego wywołania jest starszy niż ten start (następne wywołanie
 * przychodzi po wyniku poprzedniego), więc się nie liczy; wpis bez czytelnej chwili też nie.
 *
 * - Wywołanie tej prośby to ta sama nazwa i skrót wejścia, a dla {@link CONSENT_NAME_ONLY_TOOLS} sama nazwa: CLI
 *   przekształca wejście między hookiem a wpisem (`ExitPlanMode`: hook `{}`, wpis `{plan: …}`, CLI 2.1.314, fixture'y
 *   `consent-dowod/exitplanmode.*`). Kilka żywych zrzutów
 *   takiej nazwy i jedno zamknięcie po ich starcie = każdy z nich zamknięty (strona bezpieczna). Zamknięcie tej nazwy
 *   bez skrótu też się liczy.
 * - Utrata pokrycia zabiera dowód: zamknięcie, którego pamięć nie ma, z chwilą nie starszą niż start hooka
 *   (`lostAt`), mogło być zamknięciem tej prośby, więc zrzut liczy się jak zamknięty.
 *
 * CLI zapisuje wpisy wiadomości z kilkoma blokami `tool_use` dopiero razem z wynikami, a hook pierwszego bloku
 * startuje wcześniej (CLI 2.1.319): przez całe czekanie transkrypt nie ma prośby, choć dialog stoi. Plik rośnie
 * w kolejności zapisu, więc wynik tej prośby przychodzi po jej `tool_use`; zanim przyjdzie, brak prośby
 * w transkrypcie to niewiadoma.
 */
export function transcriptPassed(transcript: Omit<TranscriptToolUses, 'open'>, dump: HookCallDump): boolean {
  if (transcript.lostAt !== null && transcript.lostAt >= dump.startedAt) return true;
  const byName = (CONSENT_NAME_ONLY_TOOLS as readonly string[]).includes(dump.toolName);
  const sameCall = (tool: ClosedToolUse): boolean =>
    byName || tool.inputSha256 === null || tool.inputSha256 === dump.inputSha256;
  return transcript.closed.some((tool) => tool.toolName === dump.toolName && tool.closedAt !== null
    && tool.closedAt >= dump.startedAt && sameCall(tool));
}

/**
 * Facts of the agent's run from its file (`subagents/agent-<agentId>.jsonl`: the calls of the current run and the
 * results of the whole file), given by a reader outside layer 1 (`consent-subagent.ts`, `SubagentTurnPass`).
 */
export interface ConsentSubagentFile {
  /** The read has seen no opening entry of a run. */
  readonly partial: boolean;
  readonly toolUses: readonly TurnToolUse[];
  readonly results: readonly TurnToolResult[];
  /** Run known to its end: no unfinished line and no full line that did not parse. */
  readonly settled: boolean;
  /** The read reached the end of the file. */
  readonly caughtUp: boolean;
  /**
   * Fakty pliku wątku głównego sesji o agencie prośby (dowód ukryty); brak pola = czytnik ich nie podaje,
   * `null` = nieznane (brak pliku głównego, błąd odczytu). Bez nich prośba dowodu ukrytego nie ma.
   */
  readonly agent?: ConsentSubagentLaunch | null;
}

/**
 * The main-thread file about the agent of a subagent request, from the request's checkpoint (the agent's start call,
 * else the main turn of the hook's `promptId`) to the end of the file (`consent-evidence.ts`, target with `agentId`):
 * background start, ends of runs and whether the read is known to its end.
 */
export interface ConsentSubagentLaunch {
  /** Start w tle: wynik `Agent` z `async_launched` (albo `forked` z `background: true`) z `agentId` agenta. */
  readonly launch: ConsentAgentTurn['launch'];
  /** Końce biegów agenta (wynik albo meldunek `<task-notification>` z `<task-id>` i statusem końcowym). */
  readonly ends: readonly ConsentAgentEnd[];
  /**
   * Plik główny doczytany do rozmiaru, bez niedokończonej linii na końcu, z tym samym rozmiarem przed przebiegiem
   * i po nim. Bez tego brak końca w faktach znaczy tylko „nie widzieliśmy”.
   */
  readonly settled: boolean;
}

/**
 * Pamięć zamknięć tury subagenta dla {@link transcriptPassed}: wynik ze znanym `tool_use` tej tury to zamknięcie
 * (nazwa i skrót wejścia z `tool_use`, chwila wpisu wyniku), a wynik bez znanego `tool_use` to zamknięcie, którego
 * pamięć nie ma (`lostAt`; wpis bez czytelnej chwili liczy się jak `now`). `null` = fakty nieznane do końca (brak
 * pliku, odczyt bez otwarcia tury, niedokończona albo nieczytelna linia, plik niedoczytany): prośba subagenta jest
 * wtedy bez dowodu (`subagent`).
 */
export function subagentClosures(
  file: ConsentSubagentFile | null, now: number,
): Omit<TranscriptToolUses, 'open'> | null {
  if (file === null || file.partial || !file.settled || !file.caughtUp) return null;
  const uses = new Map(file.toolUses.map((use) => [use.id, use]));
  const closed: ClosedToolUse[] = [];
  let lostAt: number | null = null;
  for (const result of file.results) {
    const use = uses.get(result.toolUseId);
    if (use === undefined) {
      lostAt = Math.max(lostAt ?? Number.NEGATIVE_INFINITY, result.at ?? now);
      continue;
    }
    closed.push({ toolName: use.name, inputSha256: use.inputSha256, closedAt: result.at });
  }
  return { closed, lostAt };
}

/**
 * Fakty dowodu ukrytego jednej obserwacji spoza wejścia dowodu własnego (5.3), per zrzut prośby.
 */
export interface ConsentHiddenFacts {
  /** Fakty pliku subagenta prośby razem z faktami pliku głównego o agencie; `null` = nieznane. */
  readonly file: (dump: HookCallDump) => ConsentSubagentFile | null;
  /** Któryś odczyt ekranu od rejestracji dał dopasowanie zrzutu na wierzchu (także jako bliźniak). */
  readonly topLost: (dump: HookCallDump) => boolean;
  /** Lista hooków `PermissionRequest` sesji przy tej prośbie to sam hook Raroga. */
  readonly onlyRarogHooks: (dump: HookCallDump) => boolean;
}

/** Fakty dowodu ukrytego bez źródła: żadna prośba ich nie ma. */
export const NO_HIDDEN_FACTS: ConsentHiddenFacts = {
  file: () => null, topLost: () => true, onlyRarogHooks: () => false,
};

function digestOf(input: unknown): string | null {
  try {
    return canonicalSha256(input);
  } catch {
    return null;
  }
}

/**
 * Hidden proof rule of one subagent request under the session's subagent rule `rule` (`ConsentProofRules.subagents`
 * in `version-gate.ts`): `channel` under the `channel` rule and a tool outside MCP (a bare `allow` does not close an
 * MCP dialog with `requiresUserInteraction`, as in {@link consentKeyRule}); otherwise `screen`, every check of
 * {@link consentHiddenProofs}.
 */
export function consentHiddenKeyRule(rule: ConsentProofRule, request: { readonly toolName: string }): ConsentProofRule {
  return rule === 'channel' && !request.toolName.startsWith(CONSENT_COMPARABLE_TOOL_PREFIX) ? 'channel' : 'screen';
}

/**
 * Klucze zrzutów, których dialog stoi ukryty (5.3). Przy regule klucza `channel`
 * ({@link consentHiddenKeyRule}) zrzut prośby subagenta dostaje klucz z samych warunków żywego hooka i pliku subagenta,
 * bez startu w tle, wierzchu ekranu, rejestru i listy hooków: podpisane `allow` odbiera tylko hook własnego klucza,
 * który czeka na swoje wywołanie, a `allow` hooka wykonuje prośbę subagenta zagnieżdżonego, agenta workflow i subagenta
 * w tle przy stojącym dialogu wątku głównego (pomiar 7 z 7, CLI 2.1.322 i 2.1.325); wynik obcego hooka rozlicza wynik
 * zgody (`unknown`), nie dowód. Wierzch ekranu do tej reguły nie wchodzi. Przy regule klucza `screen` zrzut prośby
 * subagenta dostaje klucz, gdy naraz:
 *
 * - rejestr: rejestr CLI sesji z tej obserwacji znany, nie starszy niż {@link REGISTRY_MAX_AGE_MS} i nie `waiting`
 *   z klasą `permission` (w sesji stoi dialog zgody, więc ukryta prośba może być tą, którą widać);
 * - żywy hook: hook żyje według `ps`, skrót wejścia zrzutu zgodny, zrzut nie minięty i bez faktu utraty z cyklu
 *   (rejestrację i skrót karty sprawdza cykl: bez nich karta przycisku nie ma);
 * - background start: the main file has the agent's background start after the request's checkpoint (class `bg`; the
 *   start call of a nested agent is in its parent's file and a workflow agent has none, so they are `fg-or-unknown`);
 * - plik subagenta: fakty pliku subagenta znane do końca ({@link subagentClosures}), bez zamknięcia prośby
 *   ({@link transcriptPassed}) i bez wyniku przerwania nie starszego niż start hooka (Esc w widoku subagenta,
 *   skrót zatrzymania agentów, pomiar na CLI 2.1.319), a plik główny znany do końca i bez końca
 *   biegu agenta nie starszego niż start hooka (koniec sprzed rejestracji, np. przed wznowieniem, się nie liczy);
 * - wierzch ekranu: żaden odczyt ekranu od rejestracji nie dał dopasowania zrzutu na wierzchu;
 * - lista hooków: lista hooków `PermissionRequest` sesji to sam hook Raroga.
 */
export function consentHiddenProofs(
  input: ConsentEvidenceInput, facts: ConsentHiddenFacts, rule: ConsentProofRule = 'screen',
): Set<string> {
  const out = new Set<string>();
  for (const dump of input.dumps) if (consentHiddenMiss(input, facts, rule, dump) === null) out.add(dump.key);
  return out;
}

/**
 * The check of {@link consentHiddenProofs} that failed for one dump, in check order (diagnostics: the reason of
 * a desk release, `desk-reason.ts`): `thread` (main-thread request), `hook` (`ps` does not say alive), `registry`,
 * `digest`, `passed`, `lost`, `file` (subagent file facts not known to the end), `interrupted`, `main-file`
 * (main-file facts about the agent unknown or not known to the end), `not-background`, `run-ended`, `top-lost`,
 * `other-hooks`; `null` = the dump has the hidden proof.
 */
export type ConsentHiddenMiss =
  | 'thread' | 'hook' | 'registry' | 'digest' | 'passed' | 'lost' | 'file' | 'interrupted' | 'main-file'
  | 'not-background' | 'run-ended' | 'top-lost' | 'other-hooks';

/** {@link consentHiddenProofs} for one dump with the check that failed; the same checks in the same order. */
export function consentHiddenMiss(
  input: ConsentEvidenceInput, facts: ConsentHiddenFacts, rule: ConsentProofRule, dump: HookCallDump,
): ConsentHiddenMiss | null {
  const registry = input.registry;
  if (dump.agentId === undefined) return 'thread';
  if (input.alive.get(dump.key) !== true) return 'hook';
  const channel = consentHiddenKeyRule(rule, dump) === 'channel';
  // Rejestr (tylko przy regule klucza `screen`).
  const registryHolds = registry.kind !== 'unknown' && input.now - registry.at <= REGISTRY_MAX_AGE_MS
    && !(registry.kind === 'waiting' && registry.dialog === 'permission');
  if (!channel && !registryHolds) return 'registry';
  if (digestOf(dump.toolInput) !== dump.inputSha256) return 'digest';
  if (input.layer1.passed(dump)) return 'passed';
  if (input.layer1.lost(dump)) return 'lost';
  const turn = hiddenTurnMiss(facts.file(dump), dump, input.now, !channel);
  if (turn !== null) return turn;
  if (!channel && facts.topLost(dump)) return 'top-lost';
  if (!channel && !facts.onlyRarogHooks(dump)) return 'other-hooks';
  return null;
}

/**
 * Warunek pliku subagenta z faktów pliku subagenta i pliku głównego, a przy `launched` także start w tle (opis
 * {@link consentHiddenProofs}); `null` = both hold.
 */
function hiddenTurnMiss(
  file: ConsentSubagentFile | null, dump: HookCallDump, now: number, launched: boolean,
): ConsentHiddenMiss | null {
  if (file === null) return 'file';
  const closures = subagentClosures(file, now);
  if (closures === null) return 'file';
  if (transcriptPassed(closures, dump)) return 'passed';
  if (file.results.some((result) => result.interrupted && (result.at === null || result.at >= dump.startedAt))) {
    return 'interrupted';
  }
  const agent = file.agent;
  if (agent === undefined || agent === null || !agent.settled) return 'main-file';
  if (launched && agent.launch === null) return 'not-background';
  return agent.ends.some((end) => end.at >= dump.startedAt) ? 'run-ended' : null;
}

/**
 * Wejście dowodu kanału zgód: wejście trybu cienia z opcją warstwy 1, zawsze podaną: reguła „transkrypt poszedł dalej”
 * ({@link transcriptPassed} nad pamięcią zamknięć sesji) i fakty utraty dowodu z cyklu (`proofLost` w `cycle.ts`).
 */
export type ConsentEvidenceInput = EvidenceInput & { readonly layer1: Layer1Evidence };

/**
 * Zrzut kandydata w pamięci puli: klucz, chwila zapisu i wątek (wyjście z puli) oraz pola, które czyta dopasowanie
 * do wierzchu (`topFieldsOf` w `top.ts`). Reszty zrzutu pula nie trzyma. Kandydat ze znacznika prośby ma tu nazwę
 * znacznika jako klucz (klucz per wywołanie albo `anon-<pid>-<startedAt>`) i pola znacznika.
 */
export type ConsentPoolDump = TopDump & Pick<HookCallDump, 'key' | 'at' | 'agentId'>;

/** Kandydat puli sesji ze zrzutem: bez wyjścia albo po wyjściu, póki trwa termin odczytu, który mógł go użyć. */
export interface ConsentPoolCandidate {
  /** Zrzut z pierwszego odczytu klucza ({@link ConsentPoolDump}). */
  readonly dump: ConsentPoolDump;
  /** Chwila odczytu rejestru bez `waiting`, który wyjął zrzut z puli (ms epoki); `null` = w puli. */
  readonly exitAt: number | null;
}

/** Kandydat po wyjściu bez zrzutu: klucz i chwila wyjścia. */
export interface ConsentPoolExit {
  readonly key: string;
  readonly exitAt: number;
}

/** Wejście {@link consentTopWinner}: kandydaci ze zrzutem, blokada startu, sufit i ostatnie wyjście bez zrzutu. */
export interface ConsentTopPool {
  readonly candidates: Iterable<ConsentPoolCandidate>;
  /** Chwila odczytu rejestru, który zdjął blokadę startu procesu (ms epoki); `null` = blokada trwa. */
  readonly unlockedAt: number | null;
  /** Sufit kandydatów bez wyjścia przekroczony: treść puli zwolniona, sesja bez dowodu do restartu procesu. */
  readonly overflow: boolean;
  /** Najpóźniejsze wyjście kandydata, którego zrzut pula zwolniła (ms epoki); `null` = żadnego. */
  readonly exitedAt: number | null;
}

/**
 * Pula sesji (`pool` w `cycle.ts`): każdy zrzut per wywołanie i znacznik prośby widziany w tym procesie, jeden
 * kandydat na klucz. Kandydat po wyjściu, gdy minął termin każdego odczytu, który mógł go użyć, zostaje jako klucz
 * z chwilą wyjścia ({@link ConsentPool.exited}).
 */
export interface ConsentPool extends ConsentTopPool {
  /** Kandydaci ze zrzutem w kolejności pierwszego odczytu. */
  readonly candidates: readonly ConsentPoolCandidate[];
  /** Kandydaci po wyjściu bez zrzutu w kolejności zwolnienia. */
  readonly exited: readonly ConsentPoolExit[];
}

/**
 * Zrzut na wierzchu ekranu: klucz jedynego kandydata puli, który daje `match`, gdy każdy inny daje `no`. Pula do
 * porównania to kandydaci widziani dotąd minus wyjścia zapisane PRZED rozpoczęciem odczytu ekranu (przy równych
 * chwilach kandydat zostaje). `null` (bez dowodu dla nikogo): brak odczytu ekranu, sufit puli, blokada startu zdjęta
 * nie przed odczytem, kandydat bez zrzutu z wyjściem nie przed odczytem (porównanie wymagałoby zwolnionego zrzutu),
 * wierzch `unknown` dla któregoś kandydata, dwa dopasowania albo żadne.
 */
export function consentTopWinner(
  pool: ConsentTopPool, screen: ConsentScreenRead | null, matchTop: MatchTop,
): string | null {
  return consentTopVerdict(pool, screen, matchTop).winner;
}

/**
 * Dlaczego pula nie ma zwycięzcy wierzchu ({@link consentTopVerdict}), w kolejności sprawdzania: `no-screen` (bez
 * odczytu ekranu), `pool-overflow` (sufit puli), `start-lock` (blokada startu zdjęta nie przed odczytem),
 * `exit-unread` (kandydat bez zrzutu z wyjściem nie przed odczytem), `unknown` (któryś kandydat dał `unknown`),
 * `ambiguous` (dwa dopasowania), `no-match` (żadne).
 */
export type ConsentTopPoolMiss =
  'no-screen' | 'pool-overflow' | 'start-lock' | 'exit-unread' | 'unknown' | 'ambiguous' | 'no-match';

/** Wierzch z puli z powodem braku zwycięzcy (diagnostyka); zwycięzca ten sam co {@link consentTopWinner}. */
export interface ConsentTopVerdict {
  readonly winner: string | null;
  /** `null` = jest zwycięzca. */
  readonly miss: ConsentTopPoolMiss | null;
  /** Kandydat, którego `unknown` zakończył porównanie (przy `miss: 'unknown'`), inaczej `null`. */
  readonly unknownKey: string | null;
}

/**
 * {@link consentTopWinner} z powodem: te same warunki i to samo porównanie w tej samej kolejności, z przerwaniem na
 * pierwszym `unknown` i drugim dopasowaniu.
 */
export function consentTopVerdict(
  pool: ConsentTopPool, screen: ConsentScreenRead | null, matchTop: MatchTop,
): ConsentTopVerdict {
  const none = (miss: ConsentTopPoolMiss, unknownKey: string | null = null): ConsentTopVerdict =>
    ({ winner: null, miss, unknownKey });
  if (screen === null) return none('no-screen');
  if (pool.overflow) return none('pool-overflow');
  if (pool.unlockedAt === null || pool.unlockedAt >= screen.readStartedAt) return none('start-lock');
  if (pool.exitedAt !== null && pool.exitedAt >= screen.readStartedAt) return none('exit-unread');
  let winner: string | null = null;
  for (const candidate of pool.candidates) {
    if (candidate.exitAt !== null && candidate.exitAt < screen.readStartedAt) continue;
    const match = matchTop(screen.text, candidate.dump);
    if (match === 'no') continue;
    if (match === 'unknown') return none('unknown', candidate.dump.key);
    if (winner !== null) return none('ambiguous');
    winner = candidate.dump.key;
  }
  return winner === null ? none('no-match') : { winner, miss: null, unknownKey: null };
}

/**
 * Dlaczego rejestr CLI nie daje dowodu (`waitingNow` w {@link consentDialogFindings}): `not-waiting` (świeży odczyt bez
 * `waiting`), `class-<klasa>` (`waiting` z klasą inną niż `permission`), `stale` (odczyt starszy niż
 * {@link REGISTRY_MAX_AGE_MS}), `unknown-<powód>` (rejestr nieznany, powód z `RegistryEvidence`).
 */
export type ConsentRegistryMiss =
  | 'not-waiting' | 'stale' | `class-${Exclude<CliDialogClass, 'permission'>}`
  | `unknown-${Extract<RegistryEvidence, { kind: 'unknown' }>['why']}`;

/**
 * Warunek dowodu własnego, który odpadł (reguły trybu cienia bez reguły liczącej, `shadow/evidence.ts`, nazwy po
 * angielsku): `subagent`, `digest` (zrzut przycięty), `hook-dead`, `hook-unknown` (`ps` bez odpowiedzi),
 * `transcript-missing`, `transcript-digest`, `queue`, a z opcji warstwy 1 `transcript-passed`
 * ({@link transcriptPassed}).
 * Warunki rejestru niesie {@link ConsentRegistryMiss}, a fakt utraty cykl (`lost=` w linii logu).
 */
export type ConsentOwnMiss =
  | 'subagent' | 'digest' | 'hook-dead' | 'hook-unknown' | 'transcript-missing' | 'transcript-digest' | 'queue'
  | 'transcript-passed';

/**
 * Sprawdzenie wierzchu w cyklu (`topWinner` w `cycle.ts`): {@link ConsentTopVerdict} albo brak porównania przed nim,
 * z powodem: `scan-incomplete` (obserwacja z niekompletnym odczytem zrzutów albo znaczników), `expired` (termin dowodu
 * minął), `no-pool` (sesja bez puli).
 */
export interface ConsentTopCheck {
  readonly winner: string | null;
  readonly miss: ConsentTopPoolMiss | 'scan-incomplete' | 'expired' | 'no-pool' | null;
  readonly unknownKey: string | null;
}

/** Powód braku tożsamości wierzchu w linii logu; strefa `Bash` z liczbami, bez treści linii. */
function topScreenMissText(miss: TopScreenMiss): string {
  if (miss.kind !== 'bash-zone') return miss.kind;
  const chars = miss.lines.map((line) => String(line.chars)).join('/');
  const bars = miss.lines.map((line) => (line.bar ? 'yes' : 'no')).join('/');
  return `bash-zone(unlisted=${String(miss.lines.length)},chars=${chars},bar=${bars})`;
}

/** Rodzaj braku tożsamości wierzchu, który znaczy „wygląd CLI spoza zamkniętej listy Raroga”. */
export type UnknownTopKind = 'bash-zone' | 'edit-zone' | 'bottom';

/** Człon wierzchu `top=…` z nieznanym elementem w członach linii logu dowodu (format {@link topScreenMissText}). */
const UNKNOWN_TOP_MEMBER = /(?:^| )top=(bash-zone(?=\()|edit-zone(?= |$)|bottom(?= |$))/u;

/**
 * Nieznany element wierzchu z członów linii logu dowodu (`consent: proof of key … missing: <człony>`): `bash-zone`
 * (linie strefy `Bash` spoza listy), `edit-zone` (strefa `Edit` inna niż pytanie o plik), `bottom` (tekst pod stopką
 * dialogu); `null` = człon wierzchu innego rodzaju albo brak. Wyzwalacz zrzutu ekranu karty w cyklu.
 */
export function unknownTopOf(members: string): UnknownTopKind | null {
  return (UNKNOWN_TOP_MEMBER.exec(members)?.[1] as UnknownTopKind | undefined) ?? null;
}

/**
 * Człon wierzchu w linii logu cyklu dla klucza (`top=…` w `consent: proof of key <key> missing: …`); `null` = klucz
 * jest zwycięzcą. `screen` = wierzch ekranu dowodu z `topScreen` (`top.ts`); `null` = nieznany (szew dopasowania albo
 * obserwacja bez ekranu). Wierzch bez tożsamości mówi powód z odczytu ekranu (każdy kandydat dał wtedy `unknown`);
 * wierzch z tożsamością dokłada jej rodzaj: `unknown` (ten klucz dał `unknown`), `other-unknown`, `ambiguous`,
 * `no-match` i `other-key` (zwycięzcą inny klucz) z `(screen=bash|plan|edit)`.
 */
export function consentTopMissText(check: ConsentTopCheck, key: string, screen: TopScreen | null): string | null {
  if (check.winner === key) return null;
  const on = screen !== null && screen.identity !== null ? `(screen=${screen.identity})` : '';
  if (check.winner !== null) return `other-key${on}`;
  const miss = check.miss ?? 'no-match';
  if (miss !== 'unknown' && miss !== 'ambiguous' && miss !== 'no-match') return miss;
  if (screen !== null && screen.identity === null) return topScreenMissText(screen.miss);
  if (miss === 'unknown') return `${check.unknownKey === key ? 'unknown' : 'other-unknown'}${on}`;
  return `${miss}${on}`;
}

/**
 * Sygnał klucza, reguła dowodu klucza ({@link consentKeyRule}) i człony dowodu poza wierzchem, które odpadły
 * (`null` = człon jest albo go nie sprawdzono).
 */
export interface ConsentDialogFinding {
  readonly signal: ConsentDialogSignal;
  readonly rule: ConsentProofRule;
  readonly own: ConsentOwnMiss | null;
  readonly registry: ConsentRegistryMiss | null;
}

/** Wynik obserwacji klucza dla linii logu cyklu: człony poza wierzchem i wierzch tej obserwacji. */
export interface ConsentProofFinding {
  readonly own: ConsentOwnMiss | null;
  readonly registry: ConsentRegistryMiss | null;
  /** Klucz był zwycięzcą wierzchu obserwacji tuż przed krokiem cyklu. */
  readonly top: boolean;
  /** Reguła dowodu klucza; brak pola = `screen`. Przy `channel` linia logu nie ma członu wierzchu. */
  readonly rule?: ConsentProofRule;
  /** Subagent request: facts for the reason of a desk release (`desk-reason.ts`); absent = main thread. */
  readonly subagent?: ConsentSubagentProofFacts;
}

/** What one observation knew about a subagent request's proof, for the reason of a desk release (diagnostics). */
export interface ConsentSubagentProofFacts {
  /** The dump and marker read was complete (`scanCallDumps`, `scanMarkers`). */
  readonly complete: boolean;
  /** Facts of the request's subagent file; `null` = none (no source, no file, read error). */
  readonly file: ConsentSubagentFile | null;
  /** The check of the hidden proof that failed ({@link consentHiddenMiss}); `null` = the key had the hidden proof. */
  readonly hidden: ConsentHiddenMiss | null;
  /** The key has a proof-loss fact of the cycle (`proofLost`). */
  readonly lost: boolean;
  /**
   * When the hook list check did not hold for the request under the `screen` hidden rule, whatever check failed first:
   * the `why` of the session's hook list verdict (`ConsentSessionHooks.why` in `observe.ts`); absent = the check held,
   * did not count or is unknown. Kept by the desk release for the card's reason, never sent to devices; a durable one
   * releases at once (`consentDeskAtOnce` in `desk-reason.ts`).
   */
  readonly hooks?: string;
}

function registryMissOf(registry: RegistryEvidence, now: number): ConsentRegistryMiss | null {
  if (registry.kind === 'unknown') return `unknown-${registry.why}`;
  if (now - registry.at > REGISTRY_MAX_AGE_MS) return 'stale';
  if (registry.kind === 'active') return 'not-waiting';
  return registry.dialog === 'permission' ? null : `class-${registry.dialog}`;
}

/** Powód cienia po angielsku; powody rejestru niesie człon rejestru (`null`). */
function ownMissOf(why: NoProofReason): ConsentOwnMiss | null {
  switch (why) {
    case 'subagent': return 'subagent';
    case 'skrot': return 'digest';
    case 'hook-martwy': return 'hook-dead';
    case 'hook-nieznany': return 'hook-unknown';
    case 'transkrypt-brak': return 'transcript-missing';
    case 'transkrypt-skrot': return 'transcript-digest';
    case 'kolejka': return 'queue';
    case 'rejestr-nie-czeka':
    case 'rejestr-nieznany':
    case 'rejestr-klasa':
      return null;
  }
}

/**
 * Sygnały per klucz zrzutu z wejść dowodu trybu cienia, reguły „transkrypt poszedł dalej” i zrzutu na wierzchu
 * ekranu (`top`, {@link consentTopWinner}; `null` = żaden). `standing` dostaje wyłącznie zrzut z dowodem własnym
 * i świeżym `waiting: permission`, a przy regule klucza `screen` ({@link consentKeyRule} z reguły sesji `rule`,
 * domyślnie `screen`) do tego zrzut `top`. Klucz, którego nie ma w zrzutach, nie ma wpisu: wołający traktuje go jak
 * `unknown`.
 */
export function consentDialogSignals(
  input: ConsentEvidenceInput, top: string | null, rule: ConsentProofRule = 'screen',
): Map<string, ConsentDialogSignal> {
  return new Map([...consentDialogFindings(input, top, rule)].map(([key, finding]) => [key, finding.signal]));
}

/**
 * {@link consentDialogSignals} z członami dowodu poza wierzchem, które odpadły: dowód własny ({@link ConsentOwnMiss};
 * zrzut z faktem utraty bez powodu własnego) i rejestr ({@link ConsentRegistryMiss}). Ta sama decyzja, powody obok.
 */
export function consentDialogFindings(
  input: ConsentEvidenceInput, top: string | null, rule: ConsentProofRule = 'screen',
): Map<string, ConsentDialogFinding> {
  const out = new Map<string, ConsentDialogFinding>();
  const byKey = new Map(input.dumps.map((dump) => [dump.key, dump]));
  const registry = registryMissOf(input.registry, input.now);
  const waitingNow = registry === null;
  // Bez licznika kolejki: dowód własny to reguły cienia bez reguły liczącej. Bliźniaki (ta sama nazwa i skrót)
  // rozstrzyga przy regule `screen` wierzch, a przy `channel` nie trzeba: podpisane `allow` odbiera tylko hook
  // własnego klucza, który czeka na swoje wywołanie.
  for (const verdict of standingProofs({ ...input, queue: { kind: 'unknown' } })) {
    const dump = byKey.get(verdict.key);
    const keyRule = dump === undefined ? 'screen' : consentKeyRule(rule, dump);
    const passed = dump !== undefined && input.layer1.passed(dump);
    const own = (verdict.kind === 'stoi' || verdict.kind === 'niejednoznaczny') && dump !== undefined && !passed;
    const alive = input.alive.get(verdict.key);
    const proven = own && waitingNow && (keyRule === 'channel' || verdict.key === top);
    const signal = alive === false ? 'dead' : proven ? 'standing' : 'unknown';
    const lost = dump !== undefined && input.layer1.lost(dump);
    const ownMiss = own || lost ? null
      : passed ? 'transcript-passed' : verdict.kind === 'brak' ? ownMissOf(verdict.why) : null;
    out.set(verdict.key, { signal, rule: keyRule, own: ownMiss, registry });
  }
  for (const orphan of orphanHooks(input)) {
    const found = out.get(orphan.key);
    out.set(orphan.key, {
      signal: 'gone', rule: found?.rule ?? 'screen', own: found?.own ?? null, registry: found?.registry ?? registry,
    });
  }
  return out;
}

/** Fakty sesji dla karty `claimed`, której hook nie żyje albo wyszedł (zrzut zniknął). */
export interface ConsentAfterClaim {
  /** Sygnał rejestru sesji CLI z chwilą odczytu. */
  readonly registry: RegistryEvidence;
  /**
   * W sesji żyje inny zrzut wątku głównego (także formularza pytania), a przy kanale otwartym dla subagentów (`all`)
   * także inny zrzut subagenta.
   */
  readonly otherLive: boolean;
  /**
   * Zrzut karty jest na wierzchu ekranu tej obserwacji ({@link consentTopWinner}); brak pola = nie wiadomo. Dialog
   * innej tożsamości, bez zrzutu, nie jest `standing` karty `claimed`. Przy {@link ConsentAfterClaim.channel} pole
   * nie wchodzi do reguły.
   */
  readonly top?: boolean;
  /**
   * Karta liczy dowód regułą `channel` ({@link consentKeyRule}): `standing` bez wierzchu ekranu. Brak pola = `screen`.
   */
  readonly channel?: boolean;
}

/**
 * Dialog karty `claimed` bez żywego hooka (odebrana odpowiedź, a CLI mogło jej nie wykonać: MCP z interakcją,
 * SIGKILL hooka po przejęciu). Hook nie czeka, więc dowodem jest rejestr CLI z odczytu po odbiorze:
 *
 * - inny żywy zrzut wątku głównego w sesji (przy `all` także subagenta) = CLI pyta już o coś innego, `gone`;
 * - rejestr nieznany, starszy niż {@link REGISTRY_MAX_AGE_MS} albo odczytany przed odbiorem = `unknown`;
 * - rejestr bez `waiting` albo `waiting` z klasą inną niż `permission` = `gone`;
 * - `waiting` z klasą `permission` odczytany co najmniej {@link REGISTRY_SLACK_MS} po odbiorze, przy regule `channel`
 *   ({@link ConsentAfterClaim.channel}) albo przy zrzucie karty na wierzchu ekranu ({@link ConsentAfterClaim.top})
 *   = `standing` (wcześniej CLI mogło jeszcze nie przepisać rejestru po wykonaniu odpowiedzi; przy regule `screen`
 *   dialog innej tożsamości na wierzchu nie jest dialogiem karty, więc `unknown`). Przy `channel` innego dialogu
 *   wątku głównego nie ma, bo jego żywy zrzut dałby wyżej `gone`.
 *
 * Brak faktów (sygnał `dead` z zamiatania rejestru, bez odczytu rejestru CLI) = `unknown`. Przyjęte ograniczenie:
 * przy dwóch prośbach naraz żywy zrzut drugiej daje pierwszej `gone`, także gdy CLI pierwszej nie wykonało.
 */
export function claimedDialogSignal(
  facts: ConsentAfterClaim | undefined, claimedAt: number, now: number,
): Exclude<ConsentDialogSignal, 'dead'> {
  if (facts === undefined) return 'unknown';
  if (facts.otherLive) return 'gone';
  const registry = facts.registry;
  if (registry.kind === 'unknown' || now - registry.at > REGISTRY_MAX_AGE_MS || registry.at < claimedAt) {
    return 'unknown';
  }
  if (registry.kind === 'active' || registry.dialog !== 'permission') return 'gone';
  const shown = facts.channel === true || facts.top === true;
  return registry.at >= claimedAt + REGISTRY_SLACK_MS && shown ? 'standing' : 'unknown';
}

/** Skutek z wyniku związanego wywołania. */
export type ConsentEffect =
  /** Bez wyniku (wywołanie otwarte albo przerwane bez wpisu). */
  | { readonly kind: 'none' }
  /** Rozstrzygnięcie hookiem `PermissionRequest`. */
  | { readonly kind: 'hook'; readonly decision: ConsentDecision }
  /** Klawisz przy biurku: `user_*` albo przerwanie (Esc) bez źródła. */
  | { readonly kind: 'desk' }
  /** Wynik bez rozpoznanego źródła rozstrzygnięcia. */
  | { readonly kind: 'other' };

/** Źródła `permissionDecision` z klawisza przy biurku. */
const DESK_SOURCES = ['user_temporary', 'user_permanent', 'user_reject'] as const;

export function consentEffectOf(result: TurnToolResult | null): ConsentEffect {
  if (result === null) return { kind: 'none' };
  if (result.source === 'hook') {
    if (result.decision === 'accept') return { kind: 'hook', decision: 'allow' };
    if (result.decision === 'reject') return { kind: 'hook', decision: 'deny' };
    return { kind: 'other' };
  }
  if (result.source !== null && (DESK_SOURCES as readonly string[]).includes(result.source)) return { kind: 'desk' };
  if (result.source === null && result.interrupted) return { kind: 'desk' };
  return { kind: 'other' };
}

/**
 * Decision of the desk key from the bound result: `user_permanent` with `accept` = `allow-always`, another `accept`
 * = `allow`, a `reject` and an interruption without a source = `deny`; `null` = not a desk key.
 */
export function consentDeskDecisionOf(result: TurnToolResult | null): ConsentDeskDecision | null {
  if (consentEffectOf(result).kind !== 'desk' || result === null) return null;
  if (result.decision === 'accept') return result.source === 'user_permanent' ? 'allow-always' : 'allow';
  return 'deny';
}

/**
 * Whether the record carries the hook's confirmed receipt of its answer (`POST /claim`, the record's
 * `receipt` field): the decision is `allow`, the receipt confirms this `decisionAt`, and the registration the answer
 * was signed for has the record's own input digest. The record binds its call by its own digest (the first dump),
 * the hook verified the file against the registration's; a mismatch means the bound call may not be the one the
 * phone approved, so the result settles `unknown` (`no-receipt`), never `applied` (fail-closed). A `.claimed` file
 * is not a receipt.
 */
export function consentReceiptOf(record: {
  readonly decision: ConsentDecision | null; readonly decisionAt: number | null; readonly inputSha256: string;
  readonly receipt?: { readonly decisionAt: number; readonly inputSha256: string };
}): boolean {
  const { receipt } = record;
  return record.decision === 'allow' && receipt !== undefined && record.decisionAt === receipt.decisionAt
    && receipt.inputSha256 === record.inputSha256;
}

/**
 * Whether a hook result of the record's decision on the call the record binds is the record's own answer, one
 * rule for `allow` and `deny`. The call's identity: the record binds by what it took from its first dump (the tool
 * name and its call identity, {@link CONSENT_CALL_FIELDS}: the turn, the agent, the hook process and its start, the
 * input digest), and a dump is not authenticated, while the hook checks the answer file against its registration's
 * `inputSha256` and `cardSha256` (tool name, whole input, session, `cwd`, agent, permission mode). So the record's
 * `signed` (the registration the answer of this `decisionAt` is signed under) must equal the record's call identity,
 * field by field, and its `cardSha256` the card digest of the first dump (`dumpCardSha256`, which covers the tool
 * name); a mismatch means the bound call may not be the one the phone answered. Delivery: an `allow` also needs the
 * hook's receipt ({@link consentReceiptOf}); the hook gives a `deny` without one. A record without the card digest
 * (a truncated first dump) or without `signed` (a record from before the fields) proves nothing: no `applied`
 * (fail-closed). `release` is never proven.
 */
export function consentAnswerProven(record: Parameters<typeof consentReceiptOf>[0] & ConsentCall & {
  readonly dumpCardSha256?: string;
  readonly signed?: ConsentSigned;
}): boolean {
  const { signed } = record;
  const sameCall = signed !== undefined && record.decisionAt === signed.decisionAt
    && signed.cardSha256 === record.dumpCardSha256
    && CONSENT_CALL_FIELDS.every((field) => signed[field] !== undefined && signed[field] === record[field]);
  if (!sameCall) return false;
  return record.decision === 'deny' || consentReceiptOf(record);
}

/** Stan po wyniku: nowy stan, przyczyna (`unknown`) i znacznik spóźnionego dowodu. */
export interface ConsentSettlement {
  readonly state: ConsentCycleState;
  readonly cause: ConsentUnknownCause | null;
  readonly late: boolean;
}

/**
 * Stan po wyniku związanego wywołania dla stanu `state` rekordu z odebraną (albo żadną) decyzją `decision`;
 * `proven` = the hook's effect is the record's own answer ({@link consentAnswerProven}: the bound call is the one the
 * answer was signed for, and an `allow` has the receipt). `null` = wynik niczego nie zmienia (brak wyniku, stan,
 * który transkrypt nie rozlicza).
 *
 * A `deny` takes no receipt (the hook gives it without `POST /claim`): the hook's `reject` of the bound call is the
 * effect the phone asked for whichever copy of the answer gave it, once the call is the one the answer was signed
 * for. "Proven" below means `proven`; without it the cause is `no-receipt`.
 *
 * - `claimed`/`running` (odpowiedź odebrana): hook z tą samą decyzją = `applied`, gdy skutek dowiedziony, inaczej
 *   `unknown` (`no-receipt`); klawisz przy biurku = `settled-at-desk`; hook z inną decyzją = `unknown`
 *   (`foreign-decision`); inne źródło = `unknown` (`desk-unknown`).
 * - `unknown`: hook z odebraną decyzją i dowiedzionym skutkiem = `applied` z `late`; reszta bez zmian.
 * - `pending` (wywołanie skończyło się bez naszej odpowiedzi): klawisz przy biurku = `settled-at-desk`; hook =
 *   `unknown` (`foreign-decision`); inne źródło = `unknown` (`desk-unknown`).
 * - `revoked` (karta zdjęta bez odbioru, W-b): klawisz przy biurku = `settled-at-desk`; hook z decyzją rekordu =
 *   `applied`, gdy skutek dowiedziony, inaczej `unknown` (`no-receipt`); hook z inną decyzją albo bez naszej
 *   odpowiedzi = `unknown` (`foreign-decision`); inne źródło bez zmian.
 */
export function consentSettlement(
  state: ConsentCycleState, decision: ConsentDecision | null, effect: ConsentEffect, proven: boolean,
): ConsentSettlement | null {
  if (effect.kind === 'none') return null;
  const hook = (): ConsentSettlement => {
    if (effect.kind !== 'hook' || effect.decision !== decision) {
      return { state: 'unknown', cause: 'foreign-decision', late: false };
    }
    return proven
      ? { state: 'applied', cause: null, late: false }
      : { state: 'unknown', cause: 'no-receipt', late: false };
  };
  if (state === 'claimed' || state === 'running' || state === 'pending') {
    if (effect.kind === 'hook') return hook();
    if (effect.kind === 'desk') return { state: 'settled-at-desk', cause: null, late: false };
    return { state: 'unknown', cause: 'desk-unknown', late: false };
  }
  if (state === 'unknown') {
    return effect.kind === 'hook' && effect.decision === decision && proven
      ? { state: 'applied', cause: null, late: true }
      : null;
  }
  if (state === 'revoked') {
    if (effect.kind === 'desk') return { state: 'settled-at-desk', cause: null, late: false };
    return effect.kind === 'hook' ? hook() : null;
  }
  return null;
}
