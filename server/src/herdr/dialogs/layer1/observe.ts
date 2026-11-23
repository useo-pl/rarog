/**
 * Obserwacja kanału zgód jednej sesji (warstwa 1). Jedna definicja dla serwera (`observeConsent`
 * w `server/src/index.ts`) i procesu pomiaru kanału.
 *
 * Krok obserwacji: zrzuty per wywołanie `pending/<sesja>/`, znaczniki prośby `markers/<sesja>/`, pula
 * sesji w cyklu, życie procesów hooków z `ps`, sygnały
 * „dialog stoi” (`consentDialogFindings`: dowód własny z reguł trybu cienia z pamięcią zamkniętych `tool_use`, świeży
 * `waiting: permission` i, przy regule `screen`, zrzut na wierzchu ekranu z {@link ConsentSessionSources.matchTop})
 * i jeden krok cyklu na klucz z członami dowodu, które odpadły (linia logu dowodu w cyklu).
 * Reguły dowodu sesji per rodzaj prośby ({@link ConsentSessionSources.proofRule}: wątek główny i subagenci; w serwerze
 * z bramki wersji {@link createConsentProofGate} z wersją procesu z odczytu rejestru tej obserwacji i plikiem
 * kanarka, `version-gate.ts`): przy regule wątku głównego `channel` prośba wątku głównego spoza MCP (`consentKeyRule`
 * w `proof.ts`) ze `standing` idzie do cyklu sygnałem `channel`, bez wierzchu, z chwilą i terminem od odczytu
 * rejestru procesów (`ConsentObserved.channel`: odczyt + `REGISTRY_MAX_AGE_MS`); reszta, także wątek główny przy
 * `screen`, idzie regułą wierzchu niżej. Odczyt zrzutów niekompletny nie zabiera dowodu z kanału: ten nie pyta puli.
 * Zrzut formularza pytania ({@link HOOK_QUESTION_TOOL}) karty nie dostaje (ma własny kanał), ale jako żywy zrzut
 * wątku głównego się liczy i jest kandydatem puli.
 * Utrata dowodu idzie przez cykl w jedną stronę. Na początku kroku, przed odczytem `ps`, krok oddaje cyklowi klucze
 * zrzutów kart, które transkrypt minął (`notePassed`; `transcriptPassed` dla każdego zrzutu niezależnie od otwartych
 * wywołań tej nazwy i od tego, co `ps` wie o procesie), znany transkrypt kończy okres powrotu gniazda herdr
 * (`noteTranscript`), a każdy przeczytany zrzut, znacznik i rejestr idą do puli sesji (`notePool`: kandydaci, wyjścia,
 * blokada startu). Znaczniki: `scanMarkers` parsuje tylko nazwy, których pula ani zrzuty tej obserwacji nie znają,
 * najwyżej {@link CONSENT_POOL_MAX} nowych nazw. Fakty cyklu (`proofLost`: klucz minięty kiedykolwiek, okres otwarty
 * albo hook nie późniejszy niż granica) krok czyta po odczycie `ps` i podaje do dowodu opcją warstwy 1.
 * Ten sam odczyt `ps` sprawdza hooki kandydatów subagenta ze znacznikiem (`hookWatch`, najwyżej
 * {@link CONSENT_HOOK_CHECKS_MAX} na obserwację, najdawniej sprawdzane najpierw; sprawdzenie w obserwacji z kompletnym
 * odczytem zrzutów i znaczników przesuwa hook na koniec kolejki, `noteHookChecks`): `false` dla pidu i startu w takiej
 * obserwacji, przy pidzie bez innego startu wśród pytanych procesów, zapisuje śmierć hooka (`noteHookDead`), od której
 * liczy się wyjście kandydata z puli.
 * Dowód z wierzchu ma termin: rozpoczęcie odczytu ekranu + {@link CONSENT_PROOF_TTL_MS}. Zrzut na wierzchu liczy cykl
 * z bieżącej puli sesji (`topWinner`): krok pyta po każdym `await`, a cykl jeszcze raz w kroku kolejki klucza
 * (`observed`), więc kandydat dopisany przez inną obserwację zabiera dowód od razu. Odczyt zrzutów albo znaczników
 * niekompletny (`scanCallDumps`: sufit odczytu, plik o nazwie zrzutu nieczytelny albo zniknięty po `readdir`;
 * `scanMarkers`: budżet nowych nazw, znacznik nieczytelny albo zniknięty) = obserwacja bez dowodu dla nikogo: pula
 * mogłaby nie mieć prośby dialogu z wierzchu.
 * Karta niekońcowa bez zrzutu dostaje sygnał `dead` (W-c: after an incomplete dump read only a card whose dump file
 * is gone; a dump on disk outside the read window keeps the hook's registration). Każdy krok niesie fakty po odbiorze
 * ({@link ConsentAfterClaim}):
 * sygnał rejestru sesji z wejścia, to, czy w sesji żyje inny zrzut wątku głównego (przy kanale otwartym dla
 * subagentów także subagenta), czy zrzut karty jest na wierzchu ekranu i czy karta liczy dowód regułą `channel`.
 * Regułę karty `claimed` bez żywego hooka stosuje cykl (`claimedDialogSignal` w `proof.ts`).
 * Kanał otwarty dla subagentów (tryb `all`, 5.4) wołający zaznacza źródłem
 * {@link ConsentSessionSources.subagentTurns}: fakty plików subagentów dla zrzutów z `agentId`. Po synchronicznym
 * początku kroku, przed odczytem `ps`, krok czyta je dla każdego zrzutu subagenta, a klucze zrzutów, które ich plik
 * minął (`transcriptPassed` nad {@link subagentClosures}), oddaje cyklowi tak samo jak klucze wątku głównego. Zrzut
 * subagenta z faktami znanymi do końca ma dowód własny z reguł trybu cienia jak wątek główny, a bez nich (brak pliku,
 * plik agenta workflow w dwóch przebiegach, `RAROG_AGENT_FILES=0`, błąd odczytu) jest bez dowodu.
 * Bez źródła prośba subagenta dowodu nie ma (`subagent`), jak w trybie cienia.
 *
 * Dowód ukryty (5.3 i 5.6) ma osobne wejście i osobną chwilę odczytu: przy kanale otwartym dla subagentów i
 * kompletnym odczycie zrzutów i znaczników reguła dowodu ukrytego ({@link ConsentSessionSources.hiddenRule}) dostaje
 * fakty obserwacji bez ekranu ({@link ConsentHiddenInput}: zrzuty, `ps`, rejestr z chwilą odczytu, zamknięcia z
 * transkryptu i plików subagentów, fakty utraty z cyklu, zrzut na wierzchu) i oddaje klucze, których dialog stoi ukryty
 * (przy regule subagentów `channel` prośba subagenta spoza MCP bez startu w tle, wierzchu, rejestru i listy hooków,
 * `consentHiddenKeyRule` w `proof.ts`). Chwila odczytu tych faktów to najstarszy z odczytów: rejestru u wołającego albo
 * początku kroku (zrzuty, znaczniki, pliki subagentów, lista hooków sesji i `ps` krok czyta po nim); od niej liczy się
 * termin {@link CONSENT_PROOF_TTL_MS} (`ConsentObserved.hidden`), niezależny od odczytu ekranu dowodu z wierzchu. Zrzut
 * z niewiadomą (`unknown`), którego klucz reguła oddała, idzie do cyklu z sygnałem `hidden`; cykl sprawdza termin,
 * wątek i tryb. Reguła produkcyjna ({@link CONSENT_HIDDEN_RULE}) to `consentHiddenProofs` z `proof.ts`
 * nad faktami ze źródła {@link ConsentSessionSources.hidden}: pliki subagentów z faktami pliku głównego o agencie
 * ({@link subagentTurns}), pamięć utraty wierzchu ekranu ({@link createConsentTopLoss}) i lista hooków
 * `PermissionRequest` sesji (`hook-list/hook-list.ts`). Bez źródła żadna prośba dowodu ukrytego nie dostaje.
 *
 * Pamięć utraty wierzchu ekranu notuje każdą obserwację z ekranem na samym początku kroku, przed pierwszym `await`:
 * zrzut prośby subagenta, który w tym odczycie ekranu dał `match` (także jako bliźniak, bez rozstrzygania puli), traci
 * dowód ukryty na stałe, z chwilą rozpoczęcia odczytu ekranu. Obserwacja, której fakty dowodu ukrytego przeczytano
 * przed tą chwilą, nie przywraca go w cyklu (odczyt starszy od przyjętego nic nie daje). Obserwacja z odczytem faktów
 * między początkiem odczytu ekranu z dopasowaniem a jego notatką może dać dowód ukryty do następnej obserwacji (przy
 * jednym panelu sesji obserwacje idą po kolei, więc tego okna nie ma).
 *
 * A subagent request's finding carries the facts for the reason of a desk release (`subagent` in
 * `ConsentProofFinding`: read completeness, subagent file facts, the failed hidden-proof check, the loss fact, and the
 * hook list's `why` when the hook list check failed for it under the `screen` hidden rule); `desk-reason.ts` derives
 * the reason, and a durable `why` also makes the desk fallback release at once.
 *
 * Rejestr CLI, otwarte i ostatnie zamknięte `tool_use`, fakty plików subagentów oraz odczyt ekranu panelu podaje
 * wołający (driver albo proces pomiaru): moduł czyta z dysku same zrzuty i pyta `ps`. Błąd odczytu zrzutów leci do
 * wołającego; błąd odczytu plików subagentów to fakty nieznane.
 */
import { CONSENT_CHANNEL_MEASURED_CLI, HOOK_QUESTION_TOOL } from '../hook/contract.ts';
import type { HookCallDump } from '../hook/contract.ts';
import { queueOnScreen } from '../screen/queue.ts';
import { REGISTRY_MAX_AGE_MS } from '../shadow/evidence.ts';
import type { RegistryEvidence } from '../shadow/evidence.ts';
import { callDumpPresent, scanCallDumps, scanMarkers } from '../shadow/files.ts';
import type { HookProcess, LivenessVerdicts, ProcessLiveness } from '../shadow/liveness.ts';
import {
  CONSENT_FINAL_STATES, CONSENT_HOOK_CHECKS_MAX, CONSENT_POOL_MAX, CONSENT_PROOF_TTL_MS,
} from './contract.ts';
import type {
  ConsentChannelRead, ConsentCycle, ConsentHiddenRead, ConsentObserved, ConsentObservedSignal,
} from './cycle.ts';
import {
  NO_HIDDEN_FACTS, consentDialogFindings, consentHiddenKeyRule, consentHiddenMiss, consentHiddenProofs, consentKeyRule,
  subagentClosures, transcriptPassed,
} from './proof.ts';
import type {
  ConsentAfterClaim, ConsentDialogSignal, ConsentEvidenceInput, ConsentHiddenFacts, ConsentHiddenMiss,
  ConsentProofFinding, ConsentProofRule, ConsentSubagentFile, ConsentSubagentProofFacts, TranscriptToolUses,
} from './proof.ts';
import { matchTop as productionMatchTop, topScreen } from './top.ts';
import type { ConsentScreenRead, MatchTop } from './top.ts';
import {
  CONSENT_CANARY_ABSENT, CONSENT_SCREEN_RULES, consentCanaryNote, consentProofRules,
} from './version-gate.ts';
import type { ConsentCanaryFile, ConsentProofRules } from './version-gate.ts';

/** Wejścia obserwacji jednej sesji od wołającego. */
export interface ConsentSessionSources {
  readonly dataDir: string;
  readonly sessionId: string;
  /** Życie procesów hooka (`psLiveness` w serwerze). */
  readonly liveness: ProcessLiveness;
  /** Sygnał rejestru sesji CLI z chwilą odczytu. */
  readonly registry: RegistryEvidence;
  /**
   * Otwarte i ostatnie zamknięte `tool_use` wątku głównego z chwilą zamknięcia, którego pamięć już nie ma; `null` =
   * transkrypt nieznany.
   */
  readonly transcript: TranscriptToolUses | null;
  /**
   * Ekran panelu przeczytany dla tej obserwacji, z chwilą rozpoczęcia odczytu (przed zapytaniem); `null` = bez
   * odczytu, więc bez dowodu „dialog stoi”.
   */
  readonly screen: ConsentScreenRead | null;
  /** Dopasowanie zrzutu do wierzchu ekranu; domyślnie `matchTop` z `top.ts` (szew testu właściwości). */
  readonly matchTop?: MatchTop;
  /**
   * Kanał otwarty dla subagentów (tryb `all`): fakty pliku subagenta per prośba, w kolejności `requests`; `null` =
   * fakty nieznane. Brak źródła = kanał zamknięty dla subagentów (`main`, proces pomiaru bez `all`).
   */
  readonly subagentTurns?: ConsentSubagentTurns;
  /**
   * Źródła faktów dowodu ukrytego (tryb `all`, 5.3): pamięć utraty wierzchu ekranu i lista hooków sesji. Brak
   * źródła = żadna prośba dowodu ukrytego nie ma.
   */
  readonly hidden?: ConsentHiddenSources;
  /**
   * Reguła dowodu ukrytego (szew testu, 5.3); domyślnie {@link CONSENT_HIDDEN_RULE}. Liczy się tylko przy
   * kanale otwartym dla subagentów ({@link subagentTurns}) i kompletnym odczycie zrzutów i znaczników.
   */
  readonly hiddenRule?: ConsentHiddenRule;
  /**
   * Proof rules of the session per request kind: main thread (`consentKeyRule` in `proof.ts`) and subagents
   * (`consentHiddenKeyRule`); in the server from the version gate ({@link createConsentProofGate}) at every
   * observation. One rule = the same for both kinds. Absent = `screen` (the channel measurement process, top tests).
   */
  readonly proofRule?: ConsentProofRule | ConsentProofRules;
  readonly now?: () => number;
}

/** The CLI version gate of the proof rule: session rules from the configuration, release and canary file. */
export interface ConsentProofGate {
  /**
   * Proof rules of session `sessionId` for an observation with registry read `registry`: `consentProofRules`
   * (`version-gate.ts`) with the release of the session's single process from THIS read
   * (`RegistryEvidence.cliVersion`), so the state and the release come from one registry snapshot. An unknown
   * registry (several processes of the session, no entry, no read) or a read without a release = unknown release,
   * `screen` for both kinds.
   */
  ruleFor(sessionId: string, registry: RegistryEvidence): ConsentProofRules;
  /**
   * The rules of session `sessionId` now, for the cycle's check of a proof taken under `channel` (each view of a card
   * with the approve button, the decision and the signature): the release of the session's latest observation and
   * the canary file read again. No observation with a known release = `screen` for both kinds.
   */
  current(sessionId: string): ConsentProofRules;
}

/**
 * The CLI version gate: `RAROG_CONSENT_PROOF`, {@link CONSENT_CHANNEL_MEASURED_CLI} and the canary file
 * (`canary`; absent = the package constant alone), read at every observation with a known release, so a new entry
 * changes the rule of a live session without a restart. A log line goes at every change of a session's rules (process
 * memory), only under the `channel` configuration and with a known release; the first observation of a session logs
 * nothing when both kinds have `channel` from the package constant alone. An unknown release gives `screen` without
 * a line and without reading the file (right after a server start the process registry may not be read yet). The
 * cycle asks `current` at every check of a proof taken under `channel`, so after a change to `screen` that proof
 * holds neither for an observation still running nor for a decision without a new observation.
 */
export function createConsentProofGate(options: {
  readonly configured: ConsentProofRule;
  readonly log: (line: string) => void;
  readonly canary?: ConsentCanaryFile;
}): ConsentProofGate {
  const last = new Map<string, ConsentProofRules>();
  /** The release of each session's latest observation (`undefined` = unknown), for `current`. */
  const releases = new Map<string, string | undefined>();
  const rulesNow = (sessionId: string, cliVersion: string | undefined): ConsentProofRules => {
    if (options.configured !== 'channel' || cliVersion === undefined) return CONSENT_SCREEN_RULES;
    const canary = options.canary?.read() ?? CONSENT_CANARY_ABSENT;
    const rules = consentProofRules(options.configured, cliVersion, canary);
    const before = last.get(sessionId);
    const base = consentProofRules(options.configured, cliVersion, CONSENT_CANARY_ABSENT);
    const quiet = before === undefined
      ? sameRules(rules, base) && rules.main === 'channel' && rules.subagents === 'channel'
      : sameRules(rules, before);
    last.set(sessionId, rules);
    if (!quiet) {
      options.log(`consent: session ${sessionId} runs Claude Code ${cliVersion}: proof rule main=${rules.main},`
        + ` subagents=${rules.subagents} (measured ${CONSENT_CHANNEL_MEASURED_CLI.cli};`
        + ` ${consentCanaryNote(canary, cliVersion)})`);
    }
    return rules;
  };
  return {
    ruleFor(sessionId, registry) {
      const cliVersion = registry.kind === 'unknown' ? undefined : registry.cliVersion;
      releases.set(sessionId, cliVersion);
      return rulesNow(sessionId, cliVersion);
    },
    current: (sessionId) => rulesNow(sessionId, releases.get(sessionId)),
  };
}

const sameRules = (a: ConsentProofRules, b: ConsentProofRules): boolean =>
  a.main === b.main && a.subagents === b.subagents;

/** Rules per request kind from the source field; one rule counts for both kinds. */
const rulesOf = (rule: ConsentProofRule | ConsentProofRules | undefined): ConsentProofRules =>
  rule === undefined ? CONSENT_SCREEN_RULES : typeof rule === 'string' ? { main: rule, subagents: rule } : rule;

/**
 * Wejście reguły dowodu ukrytego z jednej obserwacji, bez ekranu (5.3): fakty dowodu własnego, zrzut na
 * wierzchu ekranu tej obserwacji i chwila najstarszego odczytu faktów.
 */
export interface ConsentHiddenInput {
  /**
   * Zrzuty kart, życie hooków z `ps`, rejestr CLI z chwilą odczytu, zamknięcia z transkryptu i plików subagentów
   * (`layer1.passed`, `layer1.subagentFile`) i fakty utraty dowodu z cyklu (`layer1.lost`).
   */
  readonly evidence: ConsentEvidenceInput;
  /** Zrzut na wierzchu ekranu tej obserwacji (`topWinner` cyklu); `null` = żaden albo obserwacja bez ekranu. */
  readonly top: string | null;
  /** Chwila rozpoczęcia najstarszego odczytu faktów (ms epoki): rejestru u wołającego albo początku kroku. */
  readonly readAt: number;
  /**
   * Reguła dowodu próśb subagentów tej obserwacji (`ConsentProofRules.subagents`; `consentHiddenKeyRule` w `proof.ts`
   * wybiera z niej regułę prośby).
   */
  readonly rule: ConsentProofRule;
  /**
   * Fakty spoza wejścia dowodu własnego: pliki subagentów z faktami pliku głównego (start w tle, plik subagenta),
   * utrata wierzchu ekranu i lista hooków sesji; bez źródła {@link ConsentSessionSources.hidden} = `NO_HIDDEN_FACTS`
   * (żadna prośba ich nie ma).
   */
  readonly facts: ConsentHiddenFacts;
}

/** Reguła dowodu ukrytego: klucze zrzutów, których dialog stoi ukryty według faktów obserwacji. */
export type ConsentHiddenRule = (input: ConsentHiddenInput) => ReadonlySet<string>;

const NO_KEYS: ReadonlySet<string> = new Set();

/** Reguła „nigdy” (szew testu): żaden klucz. */
export const NO_HIDDEN_PROOF: ConsentHiddenRule = () => NO_KEYS;

/**
 * Reguła dowodu ukrytego w produkcji (`consentHiddenProofs` w `proof.ts`): przy regule `channel` warunki żywego
 * hooka i pliku subagenta, przy `screen` wszystkie warunki.
 */
export const CONSENT_HIDDEN_RULE: ConsentHiddenRule = ({ evidence, facts, rule }) =>
  consentHiddenProofs(evidence, facts, rule);

/**
 * Lista hooków `PermissionRequest` sesji (`hook-list/hook-list.ts`): klucze zrzutów spośród `dumps`, przy których
 * jedynym hookiem tego zdarzenia w każdej warstwie ustawień sesji jest hook Raroga. Błąd = żaden klucz.
 */
export interface ConsentSessionHooks {
  (sessionId: string, dumps: readonly HookCallDump[]): Promise<ReadonlySet<string>>;
  /**
   * The same read with the `why` of the negative verdict the keys came from (`changed:<file>`, `foreign:<layer>`,
   * `io:<code>`…): a verdict for the session's current process that covers every `cwd` of `dumps`, else `null`. The
   * desk release keeps its kind and file (`desk-reason.ts`). Without the member the observation calls the function
   * above and has no `why`; an exception = no keys and no `why`.
   */
  readonly answer?: (sessionId: string, dumps: readonly HookCallDump[]) => Promise<ConsentSessionHookAnswer>;
}

/** Keys and `why` of one session hook list read ({@link ConsentSessionHooks.answer}). */
export interface ConsentSessionHookAnswer {
  readonly keys: ReadonlySet<string>;
  readonly why: string | null;
}

const NO_HOOK_ANSWER: ConsentSessionHookAnswer = { keys: NO_KEYS, why: null };

/** Źródła faktów dowodu ukrytego spoza obserwacji (stan między obserwacjami i odczyt ustawień sesji). */
export interface ConsentHiddenSources {
  readonly topLoss: ConsentTopLoss;
  readonly sessionHooks: ConsentSessionHooks;
}

/**
 * Pamięć utraty dowodu ukrytego: zrzuty próśb subagentów per sesja i chwila rozpoczęcia pierwszego odczytu
 * ekranu, w którym zrzut dał `match`.
 */
export interface ConsentTopLoss {
  /**
   * Odczyt jednej obserwacji: zapamiętuje zrzuty próśb subagentów, a przy kompletnym odczycie zapomina te, których
   * zrzutu już nie ma; z ekranem notuje utratę każdego zapamiętanego zrzutu z `match`.
   */
  note(sessionId: string, dumps: readonly HookCallDump[], complete: boolean, screen: ConsentScreenRead | null,
    matchTop: MatchTop): void;
  /** Chwila rozpoczęcia odczytu ekranu, który zabrał zrzutowi dowód ukryty; `null` = nie zabrał. */
  lostAt(sessionId: string, key: string): number | null;
}

export function createConsentTopLoss(): ConsentTopLoss {
  const sessions = new Map<string, Map<string, { readonly dump: HookCallDump; lostAt: number | null }>>();
  return {
    note(sessionId, dumps, complete, screen, matchTop) {
      const subagent = dumps.filter((dump) => dump.agentId !== undefined);
      let known = sessions.get(sessionId);
      if (known === undefined) {
        if (subagent.length === 0) return;
        known = new Map();
        sessions.set(sessionId, known);
      }
      for (const dump of subagent) if (!known.has(dump.key)) known.set(dump.key, { dump, lostAt: null });
      if (complete) {
        const present = new Set(subagent.map((dump) => dump.key));
        for (const key of [...known.keys()]) if (!present.has(key)) known.delete(key);
      }
      if (screen !== null) {
        for (const entry of known.values()) {
          if (entry.lostAt === null && matchTop(screen.text, entry.dump) === 'match') entry.lostAt = screen.readStartedAt;
        }
      }
      if (known.size === 0) sessions.delete(sessionId);
    },
    lostAt(sessionId, key) {
      return sessions.get(sessionId)?.get(key)?.lostAt ?? null;
    },
  };
}

/** Prośba subagenta, której fakty pliku obserwacja czyta: agent i tura (`promptId` zrzutu). */
export interface ConsentSubagentRequest {
  readonly agentId: string;
  readonly promptId: string;
}

/** Fakty plików subagentów sesji per prośba, w kolejności próśb; `null` = fakty nieznane. */
export type ConsentSubagentTurns =
  (requests: readonly ConsentSubagentRequest[]) => Promise<readonly (ConsentSubagentFile | null)[]>;

/** Co obserwacja przeczytała, zanim ruszyła cykl (dziennik procesu pomiaru). */
export interface ConsentSessionObservation {
  readonly sessionId: string;
  /** Wszystkie zrzuty sesji, także formularza pytania i subagentów. */
  readonly dumps: readonly HookCallDump[];
  /** Klucze, którym reguła dowodu ukrytego oddała dialog stojący ukryty (przed terminem i trybem w cyklu). */
  readonly hidden: ReadonlySet<string>;
  /**
   * Odczyt zrzutów i znaczników kompletny (`scanCallDumps`, `scanMarkers`); `false` = obserwacja bez dowodu „dialog
   * stoi”.
   */
  readonly complete: boolean;
  /**
   * Wejście dowodu „dialog stoi”: zrzuty kart (bez formularza pytania). Licznik kolejki (`queue`) z ekranu obserwacji
   * zostaje do dziennika; dowód warstwy 1 liczy się bez niego.
   */
  readonly evidence: ConsentEvidenceInput;
  readonly signals: ReadonlyMap<string, ConsentDialogSignal>;
}

/**
 * Krok obserwacji sesji: odczyt zrzutów, nowe fakty utraty dowodu i pula do cyklu, `ps`, odczyt faktów, sygnały,
 * `inspect` (bez skutków), potem cykl: każdy zrzut karty z sygnałem i faktami po odbiorze, a karty niekońcowe bez
 * zrzutu z sygnałem `dead`.
 */
export async function observeConsentSession(
  cycle: Pick<
    ConsentCycle, 'observe' | 'cards' | 'notePassed' | 'noteTranscript' | 'proofLost' | 'notePool' | 'topWinner'
      | 'poolKnows' | 'hookWatch' | 'noteHookChecks' | 'noteHookDead'
  >,
  sources: ConsentSessionSources, inspect?: (observation: ConsentSessionObservation) => void,
): Promise<ConsentSessionObservation> {
  const sid = sources.sessionId;
  const clock = sources.now ?? Date.now;
  // Początek kroku: przed nim tylko odczyt rejestru u wołającego (chwila odczytu faktów dowodu ukrytego).
  const stepAt = clock();
  const scan = scanCallDumps(sources.dataDir, sid);
  const all = scan.dumps;
  const dumpKeys = new Set(all.map((dump) => dump.key));
  // Znacznik pod kluczem znanym puli albo zrzutowi tej obserwacji nie wnosi nic nowego: bez odczytu pliku.
  const marks = scanMarkers(
    sources.dataDir, sid, (name) => dumpKeys.has(name) || cycle.poolKnows(sid, name), CONSENT_POOL_MAX,
  );
  const complete = scan.complete && marks.complete;
  const dumps = all.filter((dump) => dump.toolName !== HOOK_QUESTION_TOOL);
  const matchTop = sources.matchTop ?? productionMatchTop;
  // Utrata wierzchu ekranu przed pierwszym `await`: dopasowanie na wierzchu zabiera dowód ukryty, zanim inna
  // obserwacja go policzy.
  sources.hidden?.topLoss.note(sid, dumps, complete, sources.screen, matchTop);
  const now = clock();
  const transcript = sources.transcript;
  const mainPassed = (dump: HookCallDump): boolean => transcript !== null && transcriptPassed(transcript, dump);
  /*
   * Przed odczytem `ps`, w synchronicznym początku kroku. Decyzja z urządzenia w trakcie odczytu widzi już klucze
   * minięte w tym transkrypcie. Koniec okresu powrotu gniazda liczy chwila startu kroku: krok, który zaczął się przed
   * `re-attached` (stary driver, stary follower), okresu nie kończy, a po `re-attached` kroki zaczyna już tylko nowy
   * driver (manager odpina stary w tym samym kroku synchronicznym). Pula dostaje każdy przeczytany zrzut, zanim
   * jakakolwiek obserwacja tej sesji policzy wierzch.
   */
  cycle.notePassed(sid, dumps.filter((dump) => dump.agentId === undefined && mainPassed(dump)).map((dump) => dump.key));
  if (transcript !== null) cycle.noteTranscript(sid, now);
  cycle.notePool(sid, all, sources.registry, now, marks);
  // Kanał otwarty dla subagentów: zamknięcia z pliku subagenta per zrzut z `agentId`; `null` = fakty nieznane. Bez
  // źródła krok nie czeka (kolejność kroków przy kanale zamkniętym dla subagentów bez zmian).
  const subagentTurns = sources.subagentTurns;
  const { closures: closuresOf, files } = subagentTurns === undefined ? NO_SUBAGENT_FACTS
    : await subagentFacts(subagentTurns, dumps, now);
  // Lista hooków tylko dla próśb ze startem w tle w faktach pliku głównego (lista hooków to odczyt ustawień sesji).
  const hiddenSources = subagentTurns === undefined || !complete ? undefined : sources.hidden;
  const launched = dumps.filter((dump) => {
    const agent = files.get(dump.key)?.agent;
    return agent !== undefined && agent !== null && agent.launch !== null;
  });
  // The keys and the list's `why` for the desk release (`desk-reason.ts`) come from one verdict for these requests.
  const { keys: onlyRarog, why: hooksWhy } = hiddenSources === undefined || launched.length === 0 ? NO_HOOK_ANSWER
    : await sessionHooksOf(hiddenSources.sessionHooks, sid, launched);
  const launchedKeys = new Set(launched.map((dump) => dump.key));
  const passed = (dump: HookCallDump): boolean => {
    if (dump.agentId === undefined) return mainPassed(dump);
    const closures = closuresOf.get(dump.key);
    return closures !== undefined && closures !== null && transcriptPassed(closures, dump);
  };
  cycle.notePassed(sid, dumps.filter((dump) => dump.agentId !== undefined && passed(dump)).map((dump) => dump.key));
  // Hooki kandydatów subagenta ze znacznikiem, których zrzutu ta obserwacja nie ma (zrzut pyta `ps` i tak), najdawniej
  // sprawdzane najpierw.
  const checks = cycle.hookWatch(sid).filter((watch) => !dumpKeys.has(watch.key)).slice(0, CONSENT_HOOK_CHECKS_MAX);
  const asked: HookProcess[] = [...all, ...checks];
  // Wiek procesu z `ps` liczy się od chwili samego `ps`, nie od startu kroku: odczyt plików subagentów przed nim może
  // trwać dłużej niż zapas `START_TOLERANCE_MS`, a stara chwila zrobiłaby z żywego hooka martwy.
  const psAt = clock();
  const processes: LivenessVerdicts = asked.length > 0 ? await sources.liveness(asked, psAt) : new Map();
  const aliveOf = (dump: HookCallDump): boolean | null => processes.get(dump.pid) ?? null;
  if (complete) {
    // Sprawdzenie, z którego reguła śmierci może skorzystać, przy każdej odpowiedzi `ps` (także `true` i jej braku):
    // sprawdzone hooki idą na koniec kolejki, więc następna obserwacja pyta kolejnych.
    cycle.noteHookChecks(sid, checks.map((watch) => watch.key));
    const deadAt = clock();
    /** Odpowiedź `ps` per pid: pid z dwoma różnymi startami wśród pytanych procesów nie mówi, o który chodzi. */
    const certain = (proc: HookProcess): boolean =>
      asked.every((other) => other.pid !== proc.pid || other.startedAt === proc.startedAt);
    const watched = cycle.hookWatch(sid);
    const dead = watched.filter((watch) => processes.get(watch.pid) === false && certain(watch)
      && asked.some((one) => one.pid === watch.pid && one.startedAt === watch.startedAt));
    if (dead.length > 0) cycle.noteHookDead(sid, dead.map((watch) => watch.key), deadAt);
  }
  // Po odczycie `ps`: okres powrotu gniazda herdr otwarty w trakcie odczytu wchodzi już do tej oceny.
  const lost = new Set(dumps.filter((dump) => cycle.proofLost(sid, dump)).map((dump) => dump.key));
  const screen = sources.screen;
  // Niekompletny odczyt zrzutów albo znaczników: bez ekranu dowodu, ale z chwilą odczytu ekranu (werdykt nadpisuje
  // starsze).
  const proofScreen = complete ? screen : null;
  // Dowód ukryty: kanał otwarty dla subagentów i kompletny odczyt zrzutów i znaczników, termin od najstarszego odczytu.
  const rules = rulesOf(sources.proofRule);
  const hiddenRead = subagentTurns === undefined || !complete ? null
    : hiddenReadOf(sources.registry, stepAt, rules.subagents, dumps);
  const observed: ConsentObserved = {
    at: screen?.readStartedAt ?? now,
    until: proofScreen === null ? null : proofScreen.readStartedAt + CONSENT_PROOF_TTL_MS,
    screen: proofScreen,
    matchTop,
    hidden: hiddenRead,
    // Reguła `channel` wątku głównego: termin dowodu z odczytu rejestru CLI, nie z ekranu.
    ...(rules.main === 'channel' ? { channel: channelReadOf(sources.registry) } : {}),
    // Linia logu dowodu: powód braku ekranu i wierzch z tego samego odczytu co dopasowanie produkcyjne.
    unread: screen === null ? 'no-screen' : 'scan-incomplete',
    ...(sources.matchTop === undefined ? { screenTop: topScreen } : {}),
  };
  /** Zrzut na wierzchu z bieżącej puli, przed terminem dowodu; inaczej `null`. */
  const topNow = (): string | null => cycle.topWinner(sid, observed);
  const evidence: ConsentEvidenceInput = {
    now, dumps, alive: new Map(dumps.map((dump) => [dump.key, aliveOf(dump)])), registry: sources.registry,
    queue: queueOnScreen(screen?.text ?? null), transcript: transcript?.open ?? null,
    layer1: {
      passed,
      lost: (dump) => lost.has(dump.key),
      ...(subagentTurns === undefined ? {} : { subagentFile: (dump: HookCallDump) => known(closuresOf, dump) }),
    },
  };
  const top = topNow();
  const findings = consentDialogFindings(evidence, top, rules.main);
  const signals = new Map([...findings].map(([key, finding]) => [key, finding.signal]));
  const facts: ConsentHiddenFacts = hiddenSources === undefined ? NO_HIDDEN_FACTS : {
    file: (dump) => files.get(dump.key) ?? null,
    topLost: (dump) => hiddenSources.topLoss.lostAt(sid, dump.key) !== null,
    onlyRarogHooks: (dump) => onlyRarog.has(dump.key),
  };
  const hidden = hiddenRead === null ? NO_KEYS
    : (sources.hiddenRule ?? CONSENT_HIDDEN_RULE)({
      evidence, top, readAt: hiddenRead.at, facts, rule: rules.subagents,
    });
  const observation: ConsentSessionObservation = {
    sessionId: sid, dumps: all, hidden, complete, evidence, signals,
  };
  inspect?.(observation);
  const afterClaim = (
    key: string, request: { readonly toolName: string; readonly agentId?: string | null },
  ): ConsentAfterClaim => ({
    registry: sources.registry,
    otherLive: all.some((dump) => dump.key !== key && (dump.agentId === undefined || subagentTurns !== undefined)
      && aliveOf(dump) === true),
    top: topNow() === key,
    // Karta `claimed` z regułą `channel`: dialog stoi bez wierzchu (`claimedDialogSignal` w `proof.ts`).
    ...(consentKeyRule(rules.main, request) === 'channel' ? { channel: true } : {}),
  });
  for (const dump of dumps) {
    const signal = signals.get(dump.key) ?? 'unknown';
    const finding = findings.get(dump.key);
    const channelKey = finding?.rule === 'channel';
    // Po każdym `await`: termin i kandydaci dopisani do puli w trakcie (obserwacja drugiego panelu tej sesji).
    const onTop = topNow() === dump.key;
    // Reguła `channel`: `standing` bez wierzchu, termin sprawdza cykl. Dowód ukryty w miejsce niewiadomej: sygnał
    // negatywny i dowód z wierzchu zostają. Prośba subagenta z regułą `channel` dowodu ukrytego bierze go przed
    // dowodem z wierzchu, bo wierzch do tej reguły nie wchodzi.
    const hiddenFirst = dump.agentId !== undefined && consentHiddenKeyRule(rules.subagents, dump) === 'channel'
      && hidden.has(dump.key) && (signal === 'standing' || signal === 'unknown');
    const current: ConsentObservedSignal = channelKey ? (signal === 'standing' ? 'channel' : signal)
      : hiddenFirst ? 'hidden'
        : signal === 'standing' && !onTop ? 'unknown'
          : signal === 'unknown' && hidden.has(dump.key) ? 'hidden' : signal;
    const proof: ConsentProofFinding = {
      own: finding?.own ?? null, registry: finding?.registry ?? null, top: onTop,
      ...(channelKey ? { rule: 'channel' as const } : {}),
      ...(dump.agentId === undefined ? {} : {
        subagent: subagentProofFacts(
          complete, files.get(dump.key) ?? null, lost.has(dump.key),
          hidden.has(dump.key) ? null : consentHiddenMiss(evidence, facts, rules.subagents, dump),
          launchedKeys.has(dump.key) && !onlyRarog.has(dump.key)
            && consentHiddenKeyRule(rules.subagents, dump) === 'screen'
            ? hooksWhy : null,
        ),
      }),
    };
    // The `ps` facts of a `dead` verdict go to the log line of the forgotten registration only.
    const psFinding = current === 'dead' ? processes.finding?.(dump.pid) : undefined;
    const deadWhy = psFinding === undefined ? undefined : { ps: psFinding };
    await cycle.observe(sid, dump.key, current, dump, afterClaim(dump.key, dump), observed, proof, deadWhy);
  }
  const keys = new Set(dumps.map((dump) => dump.key));
  for (const card of cycle.cards(sid)) {
    if (keys.has(card.permId) || (CONSENT_FINAL_STATES as readonly string[]).includes(card.state)) continue;
    // W-c: after an incomplete read (the cap of read dumps, a file that could not be read) a card whose dump
    // is still on disk was only not read now. `dead` would forget the secret of a live hook, so `deny` and `release`
    // could not reach it. `unknown` keeps the record and the secret but withdraws an earlier proof, so the card shows
    // no `allow` until an observation reads its dump again.
    const present = !complete && callDumpPresent(sources.dataDir, sid, card.permId);
    await cycle.observe(sid, card.permId, present ? 'unknown' : 'dead', undefined, afterClaim(card.permId, card), observed,
      undefined, { cause: 'call dump gone' });
  }
  return observation;
}

/** Odczyt rejestru CLI dowodu z kanału: chwila odczytu i termin `REGISTRY_MAX_AGE_MS`; rejestr nieznany = `null`. */
function channelReadOf(registry: RegistryEvidence): ConsentChannelRead | null {
  return registry.kind === 'unknown' ? null : { at: registry.at, until: registry.at + REGISTRY_MAX_AGE_MS };
}

/**
 * Odczyt faktów dowodu ukrytego: chwila najstarszego odczytu (rejestr wołającego, jeśli znany, albo początek kroku)
 * i termin {@link CONSENT_PROOF_TTL_MS} od niej. Each dump's rule goes with it, as the hidden rule took it
 * (`consentHiddenKeyRule` of the subagents' rule `rule`: an MCP tool `screen`), so the cycle drops only proofs taken
 * under `channel` once the subagents' rule is `screen`.
 */
function hiddenReadOf(
  registry: RegistryEvidence, stepAt: number, rule: ConsentProofRule, dumps: readonly HookCallDump[],
): ConsentHiddenRead {
  const at = registry.kind === 'unknown' ? stepAt : Math.min(stepAt, registry.at);
  const keyRules = new Map(dumps.map((dump) => [dump.key, consentHiddenKeyRule(rule, dump)]));
  return { at, until: at + CONSENT_PROOF_TTL_MS, keyRules };
}

type SubagentClosures = ReadonlyMap<string, Omit<TranscriptToolUses, 'open'> | null>;

/** Fakty plików subagentów jednej obserwacji per klucz zrzutu: zamknięcia i surowe fakty pliku. */
interface SubagentFacts {
  readonly closures: SubagentClosures;
  readonly files: ReadonlyMap<string, ConsentSubagentFile>;
}

const NO_SUBAGENT_FACTS: SubagentFacts = { closures: new Map(), files: new Map() };

/**
 * Facts of a subagent request for the desk release. `hooksWhy` = the list's `why` when the hook list check did not hold
 * for the request under the `screen` hidden rule (asked for it, its key not given), whatever check failed first: a
 * durable one sends the request back at once (`consentDeskAtOnce` in `desk-reason.ts`).
 */
function subagentProofFacts(
  complete: boolean, file: ConsentSubagentFile | null, lost: boolean, hidden: ConsentHiddenMiss | null,
  hooksWhy: string | null,
): ConsentSubagentProofFacts {
  return { complete, file, lost, hidden, ...(hooksWhy === null ? {} : { hooks: hooksWhy }) };
}

/**
 * The hook list check for the requests `dumps` with the `why` of the same verdict; a source error = no key and no
 * `why`.
 */
async function sessionHooksOf(
  read: ConsentSessionHooks, sessionId: string, dumps: readonly HookCallDump[],
): Promise<ConsentSessionHookAnswer> {
  try {
    return read.answer === undefined ? { keys: await read(sessionId, dumps), why: null }
      : await read.answer(sessionId, dumps);
  } catch {
    return NO_HOOK_ANSWER;
  }
}

/** Czy fakty pliku subagenta zrzutu są znane do końca. */
function known(closures: SubagentClosures, dump: HookCallDump): boolean {
  const found = closures.get(dump.key);
  return found !== undefined && found !== null;
}

/**
 * Zamknięcia z plików subagentów per klucz zrzutu z `agentId` (`subagentClosures`) i surowe fakty pliku; przy błędzie
 * odczytu puste mapy, a brak klucza = fakty nieznane. Pytanie bez próśb też idzie: czytnik zapomina wtedy stan
 * przeglądów sesji.
 */
async function subagentFacts(
  read: ConsentSubagentTurns, dumps: readonly HookCallDump[], now: number,
): Promise<SubagentFacts> {
  const closures = new Map<string, Omit<TranscriptToolUses, 'open'> | null>();
  const files = new Map<string, ConsentSubagentFile>();
  const asked = dumps.filter((dump): dump is HookCallDump & { agentId: string } => dump.agentId !== undefined);
  let found: readonly (ConsentSubagentFile | null)[];
  try {
    found = await read(asked.map((dump) => ({ agentId: dump.agentId, promptId: dump.promptId })));
  } catch {
    return { closures, files };
  }
  for (const [index, dump] of asked.entries()) {
    const file = found[index] ?? null;
    closures.set(dump.key, subagentClosures(file, now));
    if (file !== null) files.set(dump.key, file);
  }
  return { closures, files };
}
