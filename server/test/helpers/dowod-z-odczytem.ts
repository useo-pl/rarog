/**
 * Werdykt `standing` z odczytem dowodu dla testów cyklu kanału zgód, które sprawdzają decyzje, pliki odpowiedzi
 * i wynik, a nie sam dowód „dialog stoi” (W-d).
 *
 * Do karty 2a `observe(…, 'standing', dump)` bez odczytu (`observed`) dawało karcie `pending` dowód bez terminu. Od W-d
 * dowód bez wpisu nie obowiązuje, więc taki krok zostawia kartę bez przycisku zgody. Te testy dostają ten sam werdykt
 * drogą produkcyjną, według rodzaju prośby:
 *
 * - prośba wątku głównego spoza MCP: sygnał `channel` z odczytem rejestru CLI bez terminu (reguła `channel`);
 * - prośba subagenta: sygnał `hidden` z odczytem faktów bez terminu (dowód ukryty; cykl przyjmuje go tylko przy `all`,
 *   a przy `main` karta subagenta i tak jest `terminal-only`);
 * - prośba MCP: bez zmian. Reguła `channel` jej nie obejmuje, więc test daje jej dowód z wierzchu sam
 *   ({@link topReadOf}, {@link observeStandingOf}).
 *
 * Krok zmienia się tylko dla karty, której jeszcze nie ma, i karty `pending`: przejścia stanu dalszych kart biorą
 * `standing` bez odczytu tak jak przed W-d. Asercje testów zostają bez zmian; zmienia się tylko wejście kroku.
 * Rama właściwości ma własny wzorzec z pulą i wierzchem: jej kroki idą przez {@link observeVariantStep}.
 */
import type { HookCallDump } from '../../src/herdr/dialogs/hook/contract.ts';
import { CONSENT_PROOF_TTL_MS } from '../../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../../src/herdr/dialogs/layer1/cycle.ts';
import type {
  ConsentCycle, ConsentCycleOptions, ConsentObserved, ConsentObservedSignal,
} from '../../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentAfterClaim } from '../../src/herdr/dialogs/layer1/proof.ts';
import { consentKeyRule } from '../../src/herdr/dialogs/layer1/proof.ts';
import type { ConsentProofKind } from '../../src/herdr/dialogs/layer1/records.ts';
import { matchTop, topFieldsOf } from '../../src/herdr/dialogs/layer1/top.ts';
import { REGISTRY_SLACK_MS } from '../../src/herdr/dialogs/shadow/evidence.ts';

/** Odczyt obserwacji z dowodem z kanału bez terminu, z chwilą `at` (bez ekranu i bez dowodu ukrytego). */
export function channelReadAt(at: number): ConsentObserved {
  return {
    at, until: null, screen: null, matchTop: () => 'no', hidden: null,
    channel: { at, until: Number.POSITIVE_INFINITY },
  };
}

/** Odczyt obserwacji z faktami dowodu ukrytego bez terminu, z chwilą `at` (bez ekranu). */
export function hiddenReadAt(at: number): ConsentObserved {
  return { at, until: null, screen: null, matchTop: () => 'no', hidden: { at, until: Number.POSITIVE_INFINITY } };
}

/**
 * Cykl, w którym `observe` z sygnałem `standing` bez odczytu dla karty nowej albo `pending` idzie drogą produkcyjną
 * dowodu prośby (opis modułu) z chwilą `now()`; każde inne wywołanie bez zmian. Stan jest wspólny z `cycle` (te same
 * domknięcia).
 */
export function standingWithRead(cycle: ConsentCycle, now: () => number = Date.now): ConsentCycle {
  return {
    ...cycle,
    observe: (sessionId, key, signal, dump, afterClaim, observed, finding) => {
      const record = cycle.record(sessionId, key);
      const request = record ?? (dump === undefined ? null : { toolName: dump.toolName, agentId: dump.agentId ?? null });
      if (signal !== 'standing' || observed !== undefined || request === null
        || (record !== null && record.state !== 'pending')) {
        return cycle.observe(sessionId, key, signal, dump, afterClaim, observed, finding);
      }
      if (request.agentId !== null) {
        return cycle.observe(sessionId, key, 'hidden', dump, afterClaim, hiddenReadAt(now()), finding);
      }
      if (consentKeyRule('channel', request) === 'channel') {
        return cycle.observe(sessionId, key, 'channel', dump, afterClaim, channelReadAt(now()), finding);
      }
      return cycle.observe(sessionId, key, signal, dump, afterClaim, observed, finding);
    },
  };
}

/** `createConsentCycle(options)` w {@link standingWithRead} z zegarem cyklu (`options.now`, domyślnie `Date.now`). */
export function createCycleWithRead(options: ConsentCycleOptions): ConsentCycle {
  return standingWithRead(createConsentCycle(options), options.now ?? Date.now);
}

/**
 * Krok `observe(…, 'standing', dump)` karty nowej w teście cyklu. Prośba MCP (reguła `channel` jej nie obejmuje)
 * dostaje dowód z wierzchu przez pulę sesji ({@link topReadOf}): cykl wstał przed tym krokiem, więc odczyt `active`
 * po zapasie `REGISTRY_SLACK_MS` od teraz zdejmuje blokadę startu. `advance(ms)` przesuwa zegar testu o `ms` i oddaje
 * nową chwilę; po kroku zegar stoi na chwili odczytu ekranu. Inna prośba idzie bez odczytu (`standingWithRead`).
 */
export async function observeStandingOf(
  cycle: ConsentCycle, dump: HookCallDump, advance: (ms: number) => number,
): Promise<void> {
  if (consentKeyRule('channel', dump) !== 'screen') {
    await cycle.observe(dump.sessionId, dump.key, 'standing', dump);
    return;
  }
  const read = topReadOf(cycle, dump, advance(REGISTRY_SLACK_MS));
  advance(1);
  await cycle.observe(dump.sessionId, dump.key, 'standing', dump, undefined, read);
}

/**
 * Krok `observe` wzorca ramy właściwości (W-d). Dowód bez wpisu nie obowiązuje, więc `standing` wzorca dla karty
 * nowej albo `pending` przy odczycie ekranu wzorca z chwili `screenAt` idzie do cyklu jako sygnał `channel` z terminem
 * tego odczytu ({@link CONSENT_PROOF_TTL_MS} od `screenAt`), drogą bez puli serwera: wzorce dają `standing` wyłącznie
 * prośbom wątku głównego spoza MCP (wzorzec ma własną pulę i wierzch), więc cykl sprawdza tylko termin. Inne sygnały
 * i dalsze przejścia (`standing` bez odczytu) bez zmian.
 */
export function observeVariantStep(
  cycle: ConsentCycle, sessionId: string, dump: HookCallDump, signal: ConsentObservedSignal,
  afterClaim: ConsentAfterClaim, screenAt: number | null,
): Promise<unknown> {
  const record = cycle.record(sessionId, dump.key);
  if (signal !== 'standing' || screenAt === null || (record !== null && record.state !== 'pending')) {
    return cycle.observe(sessionId, dump.key, signal, dump, afterClaim, undefined);
  }
  const proof: ConsentObserved = {
    at: screenAt, until: null, screen: null, matchTop, hidden: null,
    channel: { at: screenAt, until: screenAt + CONSENT_PROOF_TTL_MS },
  };
  return cycle.observe(sessionId, dump.key, 'channel', dump, afterClaim, proof);
}

/**
 * Rodzaj dowodu zgody klucza `key` w ramie właściwości (`top`, gdy rekord go nie ma). Rama liczy regułę `screen`
 * (obserwacja bez `proofRule`): zgoda z dowodem z kanału to błąd ramy w kroku `step`.
 */
export function screenRuleProofKind(
  cycle: ConsentCycle, sessionId: string, key: string, step: number | string,
): Exclude<ConsentProofKind, 'channel'> {
  const kind = cycle.record(sessionId, key)?.proofKind ?? 'top';
  if (kind === 'channel') throw new Error(`krok ${String(step)}: zgoda z dowodem z kanału przy regule screen`);
  return kind;
}

/**
 * Dowód z wierzchu dla jednej prośby (np. MCP, której reguła `channel` nie obejmuje) przez pulę sesji jak w serwerze:
 * odczyt rejestru `active` bez kandydatów zdejmuje blokadę startu, odczyt `waiting: permission` dopisuje zrzut do puli,
 * a odczyt ekranu o 1 ms późniejszy pasuje tylko do pól wierzchu tego zrzutu (`topFieldsOf`: nazwa, a przy `Bash`,
 * `Edit` i `ExitPlanMode` także skrót wejścia). Cykl musi wstać co najmniej `REGISTRY_SLACK_MS` przed `at`; inny
 * kandydat puli z tymi samymi polami odbiera dowód (bliźniaki przy wierzchu).
 * Zwraca odczyt do `observe(…, 'standing', dump, undefined, odczyt)` w chwili `at + 1`.
 */
export function topReadOf(cycle: ConsentCycle, dump: HookCallDump, at: number): ConsentObserved {
  cycle.notePool(dump.sessionId, [], { kind: 'active', at }, at);
  cycle.notePool(dump.sessionId, [dump], { kind: 'waiting', dialog: 'permission', at }, at);
  const readAt = at + 1;
  const own = topFieldsOf(dump);
  return {
    at: readAt, until: readAt + CONSENT_PROOF_TTL_MS, screen: { text: 'dialog prośby', readStartedAt: readAt },
    matchTop: (_text, candidate) => (
      candidate.toolName === own.toolName && candidate.inputSha256 === own.inputSha256 ? 'match' : 'no'
    ),
    hidden: null,
  };
}
