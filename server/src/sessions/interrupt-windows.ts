/**
 * Interrupt idempotency windows of the session manager: the "in flight" window before the `escape` is delivered
 * and the debounce window after it, one entry per session. The manager owns one {@link InterruptWindows}, gives it
 * a narrow {@link InterruptWindowsPort} (sessions, clock, logger), asks it before sending a new `escape` and hands it
 * the driver's delivery promise. Session state, transitions and the driver call stay in the manager. This module does
 * not import `manager.ts`.
 */
import type { Session } from './session.ts';
import { INTERRUPT_DEBOUNCE_MS } from './state-sentences.ts';

/** What the interrupt windows read from the manager: sessions, clock, logger. */
export interface InterruptWindowsPort {
  readonly sessions: ReadonlyMap<string, Session>;
  readonly now: () => number;
  readonly logger?: (line: string) => void;
}

/** Both interrupt windows of every session; one instance per manager. */
export class InterruptWindows {
  readonly #port: InterruptWindowsPort;

  /**
   * Przerwania W LOCIE: `sessionId` → obietnica JEDNEGO `escape`.
   *
   * Wpis powstaje w chwili PRZYJĘCIA żądania i znika przy rozstrzygnięciu, więc każde kolejne
   * żądanie w tym oknie dopina się do tej samej obietnicy zamiast kolejkować drugi klawisz.
   * To jedyny mechanizm, który łapie mashowanie z żywego dziennika (cztery POST-y w 0,79 s,
   * gdy pierwszy `escape` stał jeszcze w kolejce drivera) — debounce zaczyna działać dopiero
   * PO dostarczeniu, więc to okno jest dla niego niewidoczne.
   */
  readonly #interruptsInFlight = new Map<string, Promise<boolean>>();

  /**
   * Kiedy `escape` tej sesji został DOSTARCZONY (ms) — okno debounce'u.
   *
   * Zapisujemy wyłącznie klawisz, który naprawdę poszedł. Dzięki temu żądanie zjedzone
   * przez okno odpowiada „dostarczone" i nie jest to uprzejmość: w tym oknie faktycznie było.
   */
  readonly #lastInterruptAtMs = new Map<string, number>();

  constructor(port: InterruptWindowsPort) {
    this.#port = port;
  }

  /**
   * Answer of an open window for a repeated request, or `undefined` when a new `escape` has to go.
   *
   * The manager asks before expiring decisions and before the state transition.
   */
  answerFromWindows(id: string): Promise<boolean> | undefined {
    /*
     * Mechanizm A: `escape` stoi jeszcze w kolejce drivera → oddajemy TĘ SAMĄ obietnicę.
     *
     * Bramka jest PRZED `#expirePending` i przed przejściem stanu świadomie: pierwsze żądanie
     * zrobiło jedno i drugie, a powtórka nie ma tu czego zmienić. Restart karencji z drugiego
     * tapnięcia też byłby szkodą, nie zyskiem — przedłużałby okno, w którym `working`
     * z herdr jest ignorowany.
     */
    const inFlight = this.#interruptsInFlight.get(id);
    if (inFlight !== undefined) return inFlight;
    /*
     * Mechanizm B: krótkie okno PO dostarczonym klawiszu (`INTERRUPT_DEBOUNCE_MS`). Odpowiedź
     * `true` bez wysyłki jest prawdą, bo okno otwiera wyłącznie `escape`, który poszedł.
     */
    const deliveredAt = this.#lastInterruptAtMs.get(id);
    if (deliveredAt !== undefined && this.#port.now() - deliveredAt < INTERRUPT_DEBOUNCE_MS) {
      return Promise.resolve(true);
    }
    return undefined;
  }

  /**
   * Zapina obietnicę drivera na oknach idempotencji: wpis „w locie" na czas czekania,
   * a po dostarczeniu — początek okna debounce'u.
   *
   * Porównanie tożsamości przy rozstrzygnięciu nie jest asekuracją: nowa tura użytkownika
   * unieważnia oba okna (`resetInterruptWindows`), a spóźniony `escape` sprzed tej tury nie
   * ma prawa ani skasować cudzego wpisu, ani otworzyć debounce'u NAD nową turą.
   */
  trackInterrupt(id: string, delivered: Promise<boolean>): Promise<boolean> {
    const tracked: Promise<boolean> = delivered.then(
      (sent) => this.#settleInterrupt(id, tracked, sent),
      (err: unknown) => {
        /*
         * Kontrakt mówi, że odmowy lecą SYNCHRONICZNIE, więc odrzucona obietnica to
         * awaria kanału, nie decyzja. „Nie dostarczono" jest tu jedyną uczciwą odpowiedzią:
         * przejście stanu już się wydarzyło i wróciło do klienta, więc 500 nad nim byłby
         * gorszym kłamstwem niż `delivered: 'no'`.
         */
        this.#port.logger?.(`interrupt ${id}: ${describeError(err)}`);
        return this.#settleInterrupt(id, tracked, false);
      },
    );
    this.#interruptsInFlight.set(id, tracked);
    return tracked;
  }

  /** Rozstrzygnięcie: zamyka okno „w locie", a dostarczony klawisz otwiera debounce. */
  #settleInterrupt(id: string, tracked: Promise<boolean>, sent: boolean): boolean {
    if (this.#interruptsInFlight.get(id) !== tracked) return sent;
    this.#interruptsInFlight.delete(id);
    if (sent) this.#lastInterruptAtMs.set(id, this.#port.now());
    return sent;
  }

  /** Zeruje OBA okna przerwania tej sesji — nowa tura i zniknięcie karty. */
  resetInterruptWindows(id: string): void {
    this.#interruptsInFlight.delete(id);
    this.#lastInterruptAtMs.delete(id);
  }

  /**
   * Gasi znaczniki przerwania na czas wysyłki i oddaje funkcję, która je PRZYWRACA.
   *
   * Powód przywracania: bramki w `#sendToHerdr` potrafią wysyłkę ODRZUCIĆ (tryb `unknown`,
   * guard tekstu, throttle 429, błąd zapisu załączników), a wtedy do panelu nie poszło NIC
   * i żadna tura nie ruszyła. Bez tego codzienna sekwencja — Esc, prompt wraca do pola,
   * tapnięcie „Wyślij" w oknie throttle'a → 429 — zostawiała przerwaną turę bez karencji
   * i bez idempotencji, czyli dokładnie z awarią, dla której `INTERRUPT_WORKING_GRACE_MS`
   * powstało: spóźniony push `working` z UBITEJ tury wskrzeszał spinner na zawsze.
   *
   * Wariant „przywróć przy odmowie" jest tu wybrany zamiast „gaś dopiero po przyjęciu",
   * bo tamten wymagałby przesunięcia gaszenia za `writeUploads` — a to jest sekunda, przez
   * którą karta stoi w `waiting-input` i push `working` z ŻYWEJ tury wpadałby w karencję
   * (bramka `wysyłka ze zdjęciem gasi karencję NA WEJŚCIU`). Ta wersja nie rusza ścieżki
   * udanej i jest odporna na dołożenie kolejnej bramki: nowa odmowa dziedziczy przywrócenie.
   */
  suspendInterruptWindows(session: Session): () => void {
    const id = session.id;
    const grace = session.interruptedAtMs;
    const inFlight = this.#interruptsInFlight.get(id);
    const deliveredAt = this.#lastInterruptAtMs.get(id);
    session.interruptedAtMs = undefined;
    this.resetInterruptWindows(id);
    return () => {
      /*
       * Nie wskrzeszamy NAD świeższą prawdą: karta mogła w czasie odrzuconej wysyłki zniknąć,
       * a Esc naciśnięty w tym czasie ustawił własne, aktualne okna. Nadpisanie ich stanem
       * sprzed wysyłki byłoby cofnięciem — stary wpis „w locie" zasłoniłby nowy i połknął
       * następne żądanie.
       */
      if (this.#port.sessions.get(id) !== session) return;
      if (session.interruptedAtMs !== undefined) return;
      if (this.#interruptsInFlight.has(id) || this.#lastInterruptAtMs.has(id)) return;
      session.interruptedAtMs = grace;
      if (deliveredAt !== undefined) this.#lastInterruptAtMs.set(id, deliveredAt);
      /*
       * Okno „w locie" wraca przez `trackInterrupt`, a nie przez samo wstawienie do mapy:
       * obietnica mogła się w międzyczasie rozstrzygnąć (jej `#settleInterrupt` trafił już
       * w pustą mapę i wyszedł), a wpis, którego nikt nie posprząta, zjadałby KAŻDE kolejne
       * przerwanie tej sesji. Ponowne zapięcie samo domyka okno i — gdy klawisz poszedł —
       * otwiera debounce.
       */
      if (inFlight !== undefined) void this.trackInterrupt(id, inFlight);
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
