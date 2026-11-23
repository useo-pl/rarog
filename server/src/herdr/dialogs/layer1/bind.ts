/**
 * Wiązanie klucza hooka z wywołaniem w transkrypcie (`tool_use.id`) — warstwa 1. `PermissionRequest` nie niesie
 * `tool_use_id`, a wpis `tool_use` nie niesie `promptId`, więc wiązanie liczy się z faktów CAŁEJ tury
 * wątku głównego ({@link ConsentTurnFacts}: wywołania i wyniki w kolejności linii pliku), po jej końcu; w trakcie
 * tury tylko klucz, którego wywołanie na pewno się skończyło ({@link bindDuringTurn}). Chwilowa liczba otwartych
 * kandydatów niczego nie dowodzi.
 *
 * Reguły (pomiar na CLI 2.1.314; opis: `docs/dialogs.md`, „Channel cycle”):
 *
 * 1. Porównywalność: narzędzia z {@link CONSENT_COMPARABLE_TOOLS} i MCP — kandydat ma tę samą nazwę i ten sam
 *    `canonicalSha256` wejścia co zrzut; {@link CONSENT_NAME_ONLY_TOOLS} — sama nazwa; inne `incomparable-input`.
 * 2. Kandydat, którego wynik zapisano PRZED startem procesu hooka klucza, nie jest wywołaniem tego klucza (hook
 *    startuje przy prośbie, a wynik przychodzi po decyzji). Spośród reszty klucz bierze pierwszego w kolejności linii.
 * 3. Nakładanie z kolejności linii: A i B nakładają się, gdy `tool_use` każdego stoi przed wynikiem drugiego
 *    (wywołanie bez wyniku jest otwarte do końca tury). Wybrany kandydat, który nakładał się z innym wywołaniem tej
 *    samej nazwy i porównywalnego wejścia, to `ambiguous-tool-use` — także po wyniku jednego z nich.
 * 4. Dwa klucze z tym samym wybranym kandydatem: oba `ambiguous-tool-use`. Wynik bez czytelnego `timestamp` u
 *    któregokolwiek pasującego wywołania: reguły 2 nie da się zastosować, więc też `ambiguous-tool-use`.
 * 5. Przed końcem tury, i przy faktach bez pewnego początku tury, każdy klucz zostaje `open`; wyjątek przed końcem
 *    tury: wywołanie klucza skończone ({@link bindDuringTurn}).
 *
 * Tura subagenta (5.6; {@link bindAgentTurn}): kandydaci to wywołania z JEGO pliku
 * (`subagents/agent-<agentId>.jsonl`) z biegu klucza (reguła 6), a koniec daje plik główny:
 * wynik `Agent` ze statusem końcowym (pierwszy plan) albo meldunek o końcu zadania (tło, także postój). Wynik startu
 * w tle (`async_launched`) końcem nie jest. Koniec liczy się dla klucza tylko wtedy, gdy wpis końca nie jest starszy
 * niż start procesu hooka: koniec wcześniejszego biegu agenta (przed wznowieniem `SendMessage`) nie zamyka próśb
 * nowego biegu. Reguły 1–4 bez zmian, każdy subagent osobno.
 *
 * 6. Run of a subagent key: the agent file holds every run, so a key's candidates are the calls of the key's run
 *    only, the run whose opening entry is the last one not later than the hook's start
 *    ({@link ConsentAgentTurn.runStarts}). A call of a later run (after a resume) cannot settle a hook whose run ended
 *    without its call, and a call of an earlier run left without a result does not overlap a request of a later one.
 *    No such run (an opening entry without a readable time, a hook older than the first opening entry):
 *    `ambiguous-tool-use`.
 *
 * Czysta funkcja nad jawnymi wejściami: bez dysku, zegara i transkryptu (fakty czyta `herdr/consent-evidence.ts`,
 * plik subagenta `herdr/consent-subagent.ts`).
 */
import {
  CONSENT_COMPARABLE_TOOLS, CONSENT_COMPARABLE_TOOL_PREFIX, CONSENT_NAME_ONLY_TOOLS,
} from './contract.ts';
import type { ConsentCorrelation, ConsentUnknownCause } from './contract.ts';

/** Wywołanie narzędzia w turze: `id`, nazwa, skrót zapisanego wejścia i numer linii w przeglądzie. */
export interface TurnToolUse {
  readonly id: string;
  readonly name: string;
  /** `canonicalSha256(tool_use.input)` albo `null`, gdy wejścia nie da się policzyć. */
  readonly inputSha256: string | null;
  readonly line: number;
  /** Subagent file: index of the call's run in {@link ConsentAgentTurn.runStarts}; absent in the main thread. */
  readonly run?: number;
}

/** Wynik wywołania w turze z tym, co mówi o rozstrzygnięciu dialogu. */
export interface TurnToolResult {
  readonly toolUseId: string;
  readonly line: number;
  /** `timestamp` wpisu wyniku (ms epoki) albo `null`. */
  readonly at: number | null;
  /** `permissionDecision.decision` (`accept`, `reject`) albo `null`. */
  readonly decision: string | null;
  /** `permissionDecision.source` (`hook`, `user_temporary`, `user_permanent`, `user_reject`, `config`…) albo `null`. */
  readonly source: string | null;
  /** Wynik przerwania przy biurku (Esc): „interrupted by user”, „doesn't want to proceed”. */
  readonly interrupted: boolean;
}

/**
 * Koniec biegu subagenta w pliku głównym: wynik `Agent` z pierwszego planu ze statusem końcowym albo meldunek
 * `<task-notification>` z `<task-id>` agenta i statusem końcowym (subagent w tle, także postój).
 */
export interface ConsentAgentEnd {
  /** `timestamp` wpisu (ms epoki). Wpis bez czytelnego `timestamp` końcem nie jest. */
  readonly at: number;
  /** Status końcowy z wyniku albo meldunku (`completed`, `failed`, `killed`, `stopped`). */
  readonly status: string;
  /** `result` = wynik `Agent` z pierwszego planu, `notification` = meldunek o końcu zadania. */
  readonly via: 'result' | 'notification';
  /** Meldunek o postoju: agent stanął, a jego własna praca w tle jeszcze leci. */
  readonly standby: boolean;
}

/**
 * Fakty tury SUBAGENTA (5.2, 5.3 i 5.6): plik subagenta (wywołania i wyniki w {@link ConsentTurnFacts})
 * i to, co plik główny mówi o tym agencie.
 */
export interface ConsentAgentTurn {
  readonly agentId: string;
  /**
   * Start w tle w pliku głównym: wynik `Agent` z `agentId` tego agenta i statusem `async_launched` (albo `forked`
   * z `background: true`), z chwilą wpisu (`at: null` = wpis bez czytelnego `timestamp`); `null` = nie widziano.
   */
  readonly launch: { readonly at: number | null } | null;
  /** Końce biegów agenta w kolejności linii pliku głównego, od początku tury głównej `promptId`. */
  readonly ends: readonly ConsentAgentEnd[];
  /**
   * `timestamp` (ms since epoch, `null` = unreadable) of every opening entry of the agent file, in line order
   * (rule 6); absent = no run boundaries, every call is a candidate.
   */
  readonly runStarts?: readonly (number | null)[];
  /**
   * Tura subagenta znana do końca (jak `settled` w `background/agent-file.ts`): plik przeczytany od początku do
   * rozmiaru pliku albo do początku następnej tury, bez niedokończonej linii i bez pełnej linii, której nie dało się
   * sparsować. Bez tego brak wyniku w faktach znaczy tylko „nie widzieliśmy”, więc żaden klucz tury się nie zamyka.
   */
  readonly settled: boolean;
}

/** Fakty jednej tury (wątku głównego albo subagenta), w kolejności linii pliku. */
export interface ConsentTurnFacts {
  readonly promptId: string;
  /**
   * Wątek główny: wpis końca tury (`system/turn_duration`) albo początek następnej tury przeczytany. Tura
   * subagenta: plik główny ma co najmniej jeden koniec agenta ({@link ConsentAgentTurn.ends}); dla klucza liczy się
   * {@link agentTurnEnd}.
   */
  readonly ended: boolean;
  /** Przegląd nie widział początku tury: wcześniejsze wywołania mogły umknąć. */
  readonly partial: boolean;
  readonly toolUses: readonly TurnToolUse[];
  readonly results: readonly TurnToolResult[];
  /** Tura subagenta: jego `agentId` i fakty pliku głównego o nim; brak = tura wątku głównego. */
  readonly agent?: ConsentAgentTurn;
}

/** Klucz hooka do związania: nazwa i skrót wejścia ze zrzutu, start procesu hooka. */
export interface BindKey {
  readonly key: string;
  readonly toolName: string;
  readonly inputSha256: string;
  readonly hookStartedAt: number;
}

export interface BindVerdict {
  readonly key: string;
  readonly correlation: ConsentCorrelation;
  /** Wywołanie przy `bound`, inaczej `null`. */
  readonly toolUseId: string | null;
  /** Przyczyna braku wiązania po końcu tury (`ambiguous-tool-use`, `incomparable-input`, `no-tool-use`). */
  readonly cause: ConsentUnknownCause | null;
}

/** Jak klucz porównuje się z wywołaniami: skrót wejścia, sama nazwa albo wcale. */
export function comparabilityOf(toolName: string): 'input' | 'name' | 'none' {
  if ((CONSENT_COMPARABLE_TOOLS as readonly string[]).includes(toolName)) return 'input';
  if (toolName.startsWith(CONSENT_COMPARABLE_TOOL_PREFIX)) return 'input';
  if ((CONSENT_NAME_ONLY_TOOLS as readonly string[]).includes(toolName)) return 'name';
  return 'none';
}

function verdict(key: string, correlation: ConsentCorrelation, toolUseId: string | null,
  cause: ConsentUnknownCause | null): BindVerdict {
  return { key, correlation, toolUseId, cause };
}

/**
 * Run of the key in the agent file (rule 6): the index of the last opening entry not later than the hook's start;
 * `undefined` = facts without run boundaries, `null` = no such run.
 */
function keyRunOf(k: BindKey, facts: ConsentTurnFacts): number | null | undefined {
  const starts = facts.agent?.runStarts;
  if (starts === undefined) return undefined;
  if (starts.some((at) => at === null)) return null;
  let run = -1;
  starts.forEach((at, index) => {
    if (at !== null && at <= k.hookStartedAt) run = index;
  });
  return run < 0 ? null : run;
}

/**
 * Calls of the turn the key can be (rules 1 and 6): the same name, for input tools the same input digest, and in
 * a subagent file the key's run (every run when it is not known: the key is then ambiguous).
 */
function matchesOf(k: BindKey, facts: ConsentTurnFacts): TurnToolUse[] {
  const mode = comparabilityOf(k.toolName);
  if (mode === 'none') return [];
  const run = keyRunOf(k, facts);
  return facts.toolUses.filter((use) => use.name === k.toolName
    && (mode === 'name' || use.inputSha256 === k.inputSha256)
    && (typeof run !== 'number' || use.run === run));
}

/** Matches without a result written before the key's hook started (rule 2), in line order. */
function remainingOf(
  k: BindKey, matches: readonly TurnToolUse[], resultOf: ReadonlyMap<string, TurnToolResult>,
): TurnToolUse[] {
  return matches.filter((use) => {
    const at = resultOf.get(use.id)?.at;
    return at === undefined || at === null || at >= k.hookStartedAt;
  });
}

function firstResults(facts: ConsentTurnFacts): Map<string, TurnToolResult> {
  const resultOf = new Map<string, TurnToolResult>();
  for (const result of facts.results) if (!resultOf.has(result.toolUseId)) resultOf.set(result.toolUseId, result);
  return resultOf;
}

/**
 * Binding during the turn (incremental read): a key whose call is surely over gets the verdict the end of
 * the turn gives, every other key stays `open`. Over = the chosen call already has its result (`bound`: a later
 * line can neither overlap it nor take it, because a later hook starts after that result), or every remaining
 * candidate has one (`ambiguous-tool-use`: whichever of them is the key's call, it has finished). Facts without
 * a certain turn start, and a subagent file not known to its end, keep every key `open`.
 */
export function bindDuringTurn(keys: readonly BindKey[], facts: ConsentTurnFacts): BindVerdict[] {
  if (facts.partial || (facts.agent !== undefined && !facts.agent.settled)) {
    return keys.map((k) => verdict(k.key, 'open', null, null));
  }
  const resultOf = firstResults(facts);
  const byKey = new Map(keys.map((k) => [k.key, k]));
  return bindTurn(keys, facts, true).map((v) => {
    const k = byKey.get(v.key);
    if (k === undefined) return verdict(v.key, 'open', null, null);
    if (v.correlation === 'bound' && v.toolUseId !== null && resultOf.has(v.toolUseId)) return v;
    if (v.correlation === 'ambiguous-tool-use') {
      const remaining = remainingOf(k, matchesOf(k, facts), resultOf);
      if (remaining.length > 0 && remaining.every((use) => resultOf.has(use.id))) return v;
    }
    return verdict(v.key, 'open', null, null);
  });
}

/**
 * Wiązanie wszystkich kluczy jednej tury. `ended` pozwala wołającemu zamknąć turę bez wpisu w transkrypcie
 * (bezczynność sesji, `/exit`); fakty z `ended: true` zamykają ją same.
 */
export function bindTurn(keys: readonly BindKey[], facts: ConsentTurnFacts, ended = facts.ended): BindVerdict[] {
  if (!ended || facts.partial) return keys.map((k) => verdict(k.key, 'open', null, null));
  const resultOf = firstResults(facts);
  const end = (use: TurnToolUse): number => resultOf.get(use.id)?.line ?? Number.POSITIVE_INFINITY;
  const overlaps = (a: TurnToolUse, b: TurnToolUse): boolean => a.line < end(b) && b.line < end(a);

  const chosen = new Map<string, TurnToolUse>();
  const out = new Map<string, BindVerdict>();
  for (const k of keys) {
    const mode = comparabilityOf(k.toolName);
    if (mode === 'none') {
      out.set(k.key, verdict(k.key, 'incomparable-input', null, 'incomparable-input'));
      continue;
    }
    const matches = matchesOf(k, facts);
    if (keyRunOf(k, facts) === null
      || matches.some((use) => resultOf.has(use.id) && resultOf.get(use.id)?.at === null)) {
      out.set(k.key, verdict(k.key, 'ambiguous-tool-use', null, 'ambiguous-tool-use'));
      continue;
    }
    const remaining = remainingOf(k, matches, resultOf);
    const pick = remaining[0];
    if (pick === undefined) {
      out.set(k.key, verdict(k.key, 'open', null, 'no-tool-use'));
      continue;
    }
    if (matches.some((use) => use !== pick && overlaps(pick, use))) {
      out.set(k.key, verdict(k.key, 'ambiguous-tool-use', null, 'ambiguous-tool-use'));
      continue;
    }
    chosen.set(k.key, pick);
  }

  const takers = new Map<string, number>();
  for (const use of chosen.values()) takers.set(use.id, (takers.get(use.id) ?? 0) + 1);
  for (const [key, use] of chosen) {
    out.set(key, (takers.get(use.id) ?? 0) > 1
      ? verdict(key, 'ambiguous-tool-use', null, 'ambiguous-tool-use')
      : verdict(key, 'bound', use.id, null));
  }
  return keys.map((k) => out.get(k.key) ?? verdict(k.key, 'open', null, null));
}

/**
 * Koniec biegu subagenta, który zamyka turę klucza z hookiem startującym w `hookStartedAt`: pierwszy koniec z wpisem
 * nie starszym niż start hooka; `null` = bieg klucza jeszcze się nie skończył (albo fakty nie są turą subagenta).
 */
export function agentTurnEnd(facts: ConsentTurnFacts, hookStartedAt: number): ConsentAgentEnd | null {
  return facts.agent?.ends.find((end) => end.at >= hookStartedAt) ?? null;
}

/**
 * Wiązanie kluczy tury subagenta: klucz, którego bieg się skończył ({@link agentTurnEnd}), idzie przez reguły
 * {@link bindTurn} po końcu tury; reszta, i każdy klucz przy faktach bez pewnego początku tury albo przy turze
 * nieznanej do końca ({@link ConsentAgentTurn.settled}), zostaje `open`.
 */
export function bindAgentTurn(keys: readonly BindKey[], facts: ConsentTurnFacts): BindVerdict[] {
  if (facts.agent === undefined || facts.partial || !facts.agent.settled) {
    return keys.map((k) => verdict(k.key, 'open', null, null));
  }
  const ended = keys.filter((k) => agentTurnEnd(facts, k.hookStartedAt) !== null);
  const verdicts = new Map(bindTurn(ended, facts, true).map((v) => [v.key, v]));
  return keys.map((k) => verdicts.get(k.key) ?? verdict(k.key, 'open', null, null));
}

/** Wynik związanego wywołania z faktów tury albo `null` (jeszcze bez wyniku). */
export function boundResult(facts: ConsentTurnFacts, toolUseId: string): TurnToolResult | null {
  return facts.results.find((result) => result.toolUseId === toolUseId) ?? null;
}
