/**
 * Pending interactions: prośby o zgodę (permission) i pytania (AskUserQuestion) czekające
 * na decyzję człowieka.
 *
 * Reguły ze speca („Permissions + risk"):
 * - **first-wins per permId**: pierwsza decyzja wygrywa (200 + broadcast `permission-resolved`),
 *   a kolejna — o karcie JUŻ ROZSTRZYGNIĘTEJ — dostaje `'conflict'` (→409). Dzięki temu iPhone
 *   i iPad mogą patrzeć na tę samą kartę i drugi klik nie cofa ani nie dubluje decyzji.
 *   First-wins jest BLOKADĄ RÓWNOLEGŁYCH PRÓB, a nie usunięciem wpisu: pending
 *   schodzi z mapy dopiero, gdy driver zamelduje `applied` (kontrakt `DecisionOutcome`).
 *   Odmowa drivera („nie wiem, którą cyfrę wysłać") pendingu NIE zużywa — karta stoi
 *   w terminalu dalej, więc ma stać i na telefonie,
 * - próba RÓWNOLEGŁA (pierwsza jeszcze w locie) to `'refused'` z powodem `in-flight` (→422),
 *   NIE 409: dopóki pierwsza nie wróci, nikt nie wie, czy jakakolwiek decyzja zapadła,
 * - nieznany albo wygasły identyfikator → `'gone'` (→410),
 * - przy interrupt/close/restart pending wygasa: driver dostaje twarde `deny` (żeby nie wisiał
 *   w nieskończoność na `canUseTool`), a manager rozgłasza `decision: 'expired'`. Wyjątkiem
 *   jest karta, o której decyzja JEST W LOCIE: driver ma ją już w kolejce, więc `deny` byłoby
 *   drugim klawiszem za cyfrą — wygaszenie ją usuwa, ale drivera nie zawiadamia,
 * - wygaszenie w oknie decyzji WYGRYWA: wynik drivera wraca wtedy jako `'gone'` (→410),
 *   bez drugiego `permission-resolved` i bez przestawiania znacznika na „zdecydowane".
 *
 * Ten moduł nie zna SSE ani maszyny stanów — zwraca wynik operacji, broadcast robi manager.
 * Stan jest wyłącznie w RAM: po restarcie backendu pending fizycznie przepada (to świadoma
 * decyzja z architektury — sesja idzie wtedy w `resumable`, a nie „cicho znika").
 */
import type { PermissionRequest, QuestionRequest, RefuseReason } from '@rarog/shared';
import type { SentenceCode } from '@rarog/shared/sentences';
import type { DecisionOutcome } from './drivers/types.ts';

/**
 * Wynik próby rozstrzygnięcia — mapowany przez router na 200 / 409 / 410 / 422. `consent` = odmowa decyzji karty
 * kanału zgód (warstwa 1) z własnym statusem, kodem i zdaniem ({@link ConsentRefusalBody}).
 */
export type ResolveOutcome = 'ok' | 'conflict' | 'gone' | 'refused' | 'consent';

/**
 * Odmowa decyzji karty kanału zgód: status, kod błędu w ciele i kod zdania dla człowieka. Apka czyta 409 z kodem
 * `too-late` (hook już nie czeka), 410 (karta wygasła), a każdy inny 409 i 422 jako odmowę ze zdaniem serwera.
 */
export interface ConsentRefusalBody {
  readonly status: 409 | 410 | 422;
  readonly code: string;
  readonly sentence: SentenceCode;
}

/**
 * Wynik z powodem: `reason` jest OBECNY dokładnie dla `'refused'`.
 *
 * Osobny typ zamiast wariantu w unii, bo wołających interesuje przede wszystkim sam wynik
 * (trzy z czterech gałęzi nie mają czego nieść), a router i tak musi dostać powód, żeby
 * złożyć ciało 422 z jednym zdaniem dla człowieka.
 */
export interface ResolveResult {
  outcome: ResolveOutcome;
  reason?: RefuseReason;
  /** Obecne dokładnie dla `consent`. */
  consent?: ConsentRefusalBody;
}

export type PermissionDecision = 'allow' | 'allow-always' | 'deny';

/**
 * Decyzja z urządzenia: zgoda, odmowa albo zwolnienie karty kanału zgód do terminala (`release`; wyłącznie
 * karta `channel: 'hook'`, inaczej 422).
 */
export type DeviceDecision = PermissionDecision | 'release';

/**
 * Callback do drivera: przekazuje decyzję i ODDAJE jej wynik.
 *
 * Obietnica jest tu istotą kontraktu, nie ozdobą: dopóki nie wiadomo, czy klawisz wyszedł,
 * nie wolno zdjąć pendingu (patrz nagłówek pliku).
 */
export type PermissionResponder = (
  decision: PermissionDecision, message?: string,
) => Promise<DecisionOutcome>;

/**
 * Callback do drivera: przekazuje odpowiedzi na pytania (per pytanie tablica labeli) i — przy
 * kartach z `notes: true` — notatki równoległe do nich.
 */
export type QuestionResponder = (
  answers: string[][], notes?: readonly (string | null)[],
) => Promise<DecisionOutcome>;

/** Powód podawany driverowi przy wygaszaniu pending — widoczny tylko w transkrypcie agenta. */
export const EXPIRED_REASON = 'Zgoda wygasła (sesja przerwana lub zamknięta).';

/** Ile rozstrzygniętych identyfikatorów pamiętamy, żeby odróżnić 409 od 410. */
export const SETTLED_MEMORY = 500;

interface PendingEntry<TRequest, TResponder> {
  request: TRequest;
  respond: TResponder;
}

/** Jak zakończył się cykl życia identyfikatora — decyduje o 409 vs 410. */
type SettledKind = 'decided' | 'expired';

export interface ExpiredInteractions {
  permIds: string[];
  qIds: string[];
}

export class PendingInteractions {
  readonly #permissions = new Map<string, PendingEntry<PermissionRequest, PermissionResponder>>();
  readonly #questions = new Map<string, PendingEntry<QuestionRequest, QuestionResponder>>();
  /** Klucze `p:<permId>` / `q:<qId>` → jak się skończyło. Mapa jest przycinana (FIFO). */
  readonly #settled = new Map<string, SettledKind>();
  /**
   * Decyzje W LOCIE (`p:<permId>` / `q:<qId>`) — blokada równoległych prób.
   *
   * Odkąd wpis schodzi z mapy dopiero po `applied`, to ten zbiór pilnuje okna, w którym driver
   * czyta ekran i wysyła klawisz: druga próba dostaje 422 `in-flight` (karta zostaje), a nie
   * 409 — bo wynik pierwszej jest w tej chwili jeszcze nieznany.
   */
  readonly #inFlight = new Set<string>();
  readonly #settledMemory: number;

  constructor(opts: { settledMemory?: number } = {}) {
    this.#settledMemory = opts.settledMemory ?? SETTLED_MEMORY;
  }

  // -------------------------------------------------------------------------
  // Rejestracja
  // -------------------------------------------------------------------------

  /** Rejestruje prośbę o zgodę. Powtórny `permId` nadpisuje wpis (driver nie powinien tak robić). */
  addPermission(request: PermissionRequest, respond: PermissionResponder): void {
    this.#permissions.set(request.permId, { request, respond });
    this.#settled.delete(`p:${request.permId}`);
  }

  addQuestion(request: QuestionRequest, respond: QuestionResponder): void {
    this.#questions.set(request.qId, { request, respond });
    this.#settled.delete(`q:${request.qId}`);
  }

  // -------------------------------------------------------------------------
  // Odczyt (transcript-snapshot)
  // -------------------------------------------------------------------------

  permissionsFor(sessionId: string): PermissionRequest[] {
    return [...this.#permissions.values()]
      .filter((entry) => entry.request.sessionId === sessionId)
      .map((entry) => entry.request);
  }

  questionsFor(sessionId: string): QuestionRequest[] {
    return [...this.#questions.values()]
      .filter((entry) => entry.request.sessionId === sessionId)
      .map((entry) => entry.request);
  }

  hasPending(sessionId: string): boolean {
    return this.permissionsFor(sessionId).length > 0 || this.questionsFor(sessionId).length > 0;
  }

  // -------------------------------------------------------------------------
  // Rozstrzyganie
  // -------------------------------------------------------------------------

  /**
   * Rozstrzyga zgodę (first-wins jako BLOKADA, nie jako usunięcie).
   *
   * @returns `'ok'` dla decyzji, która wyszła (`applied`), `'conflict'` gdy druga próba trafia
   *          w kartę JUŻ ROZSTRZYGNIĘTĄ, `'gone'` gdy identyfikator jest nieznany, wygasł,
   *          należy do innej sesji, wygasł w oknie decyzji albo driver oddał `stale`,
   *          `'refused'` (z `reason`) gdy klawisz NIE wyszedł — wpis wtedy zostaje;
   *          `in-flight` to szczególny przypadek: trwa próba równoległa.
   */
  async resolvePermission(
    sessionId: string,
    permId: string,
    decision: PermissionDecision,
    message?: string,
  ): Promise<ResolveResult> {
    const entry = this.#permissions.get(permId);
    if (entry === undefined) return { outcome: this.#outcomeForSettled(`p:${permId}`) };
    // Cudzy permId traktujemy jak nieistniejący — klient nie może zgadywać identyfikatorów
    // innej sesji ani rozstrzygać ich „przy okazji".
    if (entry.request.sessionId !== sessionId) return { outcome: 'gone' };

    const key = `p:${permId}`;
    return this.#settle(
      key,
      () => entry.respond(decision, message),
      // Tożsamość OBIEKTU, nie samo `has`: po wygaszeniu mógł dojść NOWY wpis o tym samym
      // identyfikatorze (`addPermission` nadpisuje), a decyzja sprzed `await` nie jest jego.
      () => this.#permissions.get(permId) === entry,
      () => { this.#permissions.delete(permId); },
    );
  }

  /** Rozstrzyga pytanie (ta sama semantyka first-wins co przy zgodach). */
  async resolveQuestion(
    sessionId: string, qId: string, answers: string[][], notes?: readonly (string | null)[],
  ): Promise<ResolveResult> {
    const entry = this.#questions.get(qId);
    if (entry === undefined) return { outcome: this.#outcomeForSettled(`q:${qId}`) };
    if (entry.request.sessionId !== sessionId) return { outcome: 'gone' };

    return this.#settle(
      `q:${qId}`,
      () => (notes === undefined ? entry.respond(answers) : entry.respond(answers, notes)),
      () => this.#questions.get(qId) === entry,
      () => { this.#questions.delete(qId); },
    );
  }

  /**
   * Wspólny cykl decyzji: blokada równoległych prób → driver → sprzątanie wg wyniku.
   *
   * Blokada zastępuje dawne „usuń wpis, potem zawołaj drivera": tamta kolejność dawała 409
   * drugiemu urządzeniu za darmo, ale kosztem karty zjadanej przy KAŻDEJ odmowie drivera.
   * Teraz drugie tapnięcie w trakcie pierwszego dostaje `conflict` z tej blokady, a wpis
   * schodzi z mapy dopiero po `applied` — czyli dokładnie wtedy, gdy klawisz naprawdę poszedł.
   *
   * `stale` traktujemy jak wygaśnięcie (410 + `expired` u managera): panel już tego dialogu
   * nie pokazuje, więc karta na telefonie nie ma czego reprezentować.
   *
   * `stillMine` domyka okno `await`: przez ten czas wpis SIEDZI w mapie, więc może go zabrać
   * `expireSession` (interrupt / close / `permission-cleared`). Wtedy wygaszenie wygrywa —
   * patrz komentarz w ciele.
   */
  async #settle(
    key: string,
    ask: () => Promise<DecisionOutcome>,
    stillMine: () => boolean,
    drop: () => void,
  ): Promise<ResolveResult> {
    /*
     * Kolizja to 422 `in-flight`, a NIE 409: w tej chwili nie wiadomo jeszcze, czym skończy
     * się pierwsza próba. Gdy skończy się `refused` (np. `send-failed` — nic nie wyszło,
     * karty nikt nie zgasił), 409 kazałby drugiemu urządzeniu ZDJĄĆ kartę i pokazać
     * „decyzja zapadła gdzie indziej", choć nie zapadła żadna, a dialog dalej czeka.
     * 422 zostawia kartę i odblokowuje przyciski; jeśli pierwsza próba wyjdzie, kartę
     * zdejmie SSE `permission-resolved`.
     */
    if (this.#inFlight.has(key)) return { outcome: 'refused', reason: 'in-flight' };
    this.#inFlight.add(key);
    let outcome: DecisionOutcome;
    try {
      outcome = await ask();
    } finally {
      this.#inFlight.delete(key);
    }
    /*
     * Wpis zniknął w oknie `await`: WYGASZENIE WYGRYWA, wynik drivera jest już bez znaczenia.
     *
     * Bez `drop()` (mapa albo jest pusta, albo trzyma NOWY wpis o tym samym id) i bez
     * `#markSettled` — znacznik ma zostać `'expired'`, żeby powtórka dostała 410, a nie 409
     * „ktoś już zdecydował" o karcie, o której manager chwilę wcześniej rozgłosił
     * `decision: 'expired'`. `gone` także dla `applied`: gdyby wracało `ok`, manager
     * rozgłosiłby DRUGIE `permission-resolved` (tym razem `allow`) dla tego samego permId
     * i oddał 200 na kartę, której na telefonie już nie ma. `refused` też oddaje `gone`,
     * a nie 422: 422 znaczy „karta stoi dalej", a ona właśnie zniknęła.
     */
    if (!stillMine()) return { outcome: 'gone' };
    if (outcome.kind === 'refused') return { outcome: 'refused', reason: outcome.reason };
    drop();
    this.#markSettled(key, outcome.kind === 'applied' ? 'decided' : 'expired');
    return { outcome: outcome.kind === 'applied' ? 'ok' : 'gone' };
  }

  // -------------------------------------------------------------------------
  // Wygaszanie
  // -------------------------------------------------------------------------

  /**
   * Wygasza wszystkie pending danej sesji (interrupt / close / restart).
   *
   * Driver dostaje `deny` z powodem — inaczej `canUseTool` wisiałby w nieskończoność
   * (SDK nie ma deadline'u na prompt uprawnień). Manager po tej operacji rozgłasza
   * `permission-resolved` z `decision: 'expired'`.
   *
   * Sprzątanie samo w sobie jest BEZWARUNKOWE (wpis znika, znacznik `expired` staje,
   * identyfikator wraca do `expired`) — także dla decyzji będącej właśnie W LOCIE. Pominięcie
   * takiego wpisu zostawiłoby po `refused` (`screen-changed`, `no-digit`, `send-failed`)
   * ducha w mapie na sesji już przerwanej: `hasPending()` kłamałby, a karty nie dałoby się
   * zdjąć bez restartu. Odpada wtedy WYŁĄCZNIE powiadomienie drivera — patrz niżej.
   *
   * @param notifyDriver ustaw `false`, gdy driver już nie żyje (np. po `dispose()`).
   */
  expireSession(sessionId: string, notifyDriver = true): ExpiredInteractions {
    const expired: ExpiredInteractions = { permIds: [], qIds: [] };

    for (const [permId, entry] of [...this.#permissions]) {
      if (entry.request.sessionId !== sessionId) continue;
      this.#permissions.delete(permId);
      this.#markSettled(`p:${permId}`, 'expired');
      expired.permIds.push(permId);
      // Wyniku NIE czytamy: wygaszenie jest sprzątaniem po stronie Raroga, a nie decyzją
      // człowieka — karta i tak znika, więc `refused` nie miałoby czego uratować.
      if (notifyDriver) this.#denyUnlessInFlight(`p:${permId}`, () => {
        void entry.respond('deny', EXPIRED_REASON);
      });
    }

    for (const [qId, entry] of [...this.#questions]) {
      if (entry.request.sessionId !== sessionId) continue;
      this.#questions.delete(qId);
      this.#markSettled(`q:${qId}`, 'expired');
      expired.qIds.push(qId);
      // Pytanie bez odpowiedzi: pusta tablica = „użytkownik nic nie wybrał".
      if (notifyDriver) this.#denyUnlessInFlight(`q:${qId}`, () => {
        void entry.respond(entry.request.questions.map(() => []));
      });
    }

    return expired;
  }

  /**
   * Powiadamia driver o wygaszeniu — CHYBA że decyzja o tej samej karcie jest właśnie w locie.
   *
   * Driver ma ją wtedy w swojej kolejce, więc `canUseTool` nie zawiśnie, a `deny` byłoby
   * DRUGIM klawiszem: `escape` doklejonym ZA cyfrą, której nie da się już cofnąć. Przy
   * `interrupt()` (który sam wysyła `escape` zaraz po wygaszeniu) dawało to `cyfra → Esc → Esc`,
   * a dwa Esc pod rząd na pustym composerze to w Claude Code rewind, nie anulowanie. Przy
   * pytaniach szkoda jest ta sama: pusta tablica odpowiedzi wchodzi do `answerQuestion` jako
   * „wielokrotny wybór", zostawia wpis w transkrypcie i gasi driverowi aktywną prośbę.
   */
  #denyUnlessInFlight(key: string, notify: () => void): void {
    if (this.#inFlight.has(key)) return;
    notify();
  }

  /**
   * Wygasza same karty zgód sesji, bez powiadomienia drivera i bez ruszania pytań. Dla karty z ekranu, którą
   * zastępuje karta kanału zgód tego samego dialogu: `deny` do drivera byłoby klawiszem w żywym dialogu, który
   * rozstrzyga teraz plik odpowiedzi. Powtórka decyzji o zdjętej karcie dostaje 410.
   */
  expirePermissions(sessionId: string): string[] {
    const expired: string[] = [];
    for (const [permId, entry] of [...this.#permissions]) {
      if (entry.request.sessionId !== sessionId) continue;
      this.#permissions.delete(permId);
      this.#markSettled(`p:${permId}`, 'expired');
      expired.push(permId);
    }
    return expired;
  }

  /** Zapomina o sesji (po zamknięciu) — także o jej rozstrzygniętych identyfikatorach. */
  forgetSession(sessionId: string): void {
    this.expireSession(sessionId, false);
  }

  // -------------------------------------------------------------------------
  // Wewnętrzne
  // -------------------------------------------------------------------------

  #outcomeForSettled(key: string): ResolveOutcome {
    const settled = this.#settled.get(key);
    if (settled === 'decided') return 'conflict';
    // 'expired' oraz brak wpisu (nieznany identyfikator) → 410.
    return 'gone';
  }

  #markSettled(key: string, kind: SettledKind): void {
    this.#settled.set(key, kind);
    if (this.#settled.size <= this.#settledMemory) return;
    // Mapa zachowuje kolejność wstawiania — najstarszy klucz wypada pierwszy.
    const oldest = this.#settled.keys().next();
    if (!oldest.done) this.#settled.delete(oldest.value);
  }
}
