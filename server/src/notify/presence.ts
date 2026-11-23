/**
 * Obecność — czy KTOŚ PATRZY w Raroga, i na którą sesję.
 *
 * Presence measured on the Mac (`HIDIdleTime` of the keyboard and `atime` of every `/dev/ttys*`) answers
 * "are you touching a TERMINAL". Work in the phone client touches neither the Mac keyboard nor any tty, so such
 * a measure would push at someone watching the same session on screen, and merely checking "did it arrive"
 * would refresh `atime` and SUPPRESS the notification.
 *
 * Rarog nie musi zgadywać. Klient mówi wprost, czy jest widoczny.
 *
 * **Dlaczego sam otwarty strumień SSE NIE wystarcza.** iOS usypia apkę w tle, a gniazdo potrafi
 * jeszcze chwilę wisieć — serwer zobaczyłby wtedy „klient jest" przy zgaszonym ekranie. Stąd
 * jawny sygnał (`POST /api/presence`) i TTL: obecność trzeba POTWIERDZAĆ, a nie deklarować raz.
 *
 * **Brak danych = NIEOBECNY.** Po restarcie serwera, po zerwaniu tailnetu, przy starszym
 * kliencie, który tego endpointu nie zna. Asymetria jest świadoma i jest tą samą, którą wybrały
 * hooki: zgubione powiadomienie kosztuje realny czas, nadmiarowe kosztuje jedno spojrzenie.
 */
import { PRESENCE_TTL_MS } from '@rarog/shared';

/**
 * Re-eksport progu obecności z protokołu — kontrakt jest wspólny dla serwera i klienta.
 *
 * Tutaj go STOSUJEMY, więc wołający ma go brać z tego modułu; wartość i uzasadnienie stoją
 * przy definicji w `@rarog/shared` (klient musi odświeżać się wyraźnie częściej).
 */
export { PRESENCE_TTL_MS };

/** Ilu klientów pamiętamy. Sufit jest siatką na wyciek, nie limitem funkcjonalnym. */
export const PRESENCE_MAX_CLIENTS = 32;

/**
 * Karencja po zejściu z Raroga: tyle od ostatniej widoczności „gotowe” czeka, zanim zagra.
 * Krótkie wyjście z apki (⌘Tab do terminala na kilkanaście sekund, kilka razy
 * na minutę) to nie odejście: bez karencji każda tura skończona w takiej przerwie grała dzwonek kafla na iPadzie,
 * na którym właśnie pracujesz. Powrót w karencji kasuje czekające „gotowe” jak każdy powrót.
 */
export const PRESENCE_GRACE_MS = 60_000;

export interface PresenceReport {
  /** `document.visibilityState !== 'hidden'` w chwili wysyłki. */
  readonly visible: boolean;
  /**
   * Sesja, której TRANSKRYPT jest otwarty na ekranie. Brak = lista, ustawienia, terminal.
   *
   * Osobna informacja od `visible` i używana do czegoś innego: `visible` gasi push, a to pole
   * gasi snackbar dla sesji, na którą i tak patrzysz.
   */
  readonly sessionId?: string;
}

interface Entry {
  visible: boolean;
  sessionId: string | undefined;
  at: number;
}

export interface PresenceOptions {
  readonly ttlMs?: number;
  /** {@link PRESENCE_GRACE_MS}; testy podają własną. */
  readonly graceMs?: number;
  readonly now?: () => number;
  readonly maxClients?: number;
  /**
   * Log ZMIAN obecności (nie każdego odświeżenia — te lecą co 20 s i zalałyby plik).
   *
   * Powód istnienia jest ten sam co przy logu korekt stanu z herdr: obecność rozstrzyga
   * o powiadomieniach, czyli działa dokładnie wtedy, gdy nikt nie patrzy. Bez śladu
   * odpowiedź na „czemu push nie przyszedł" byłaby rekonstrukcją z pamięci.
   */
  readonly log?: (line: string) => void;
  /**
   * Wołane w chwili, gdy obecność WRACA (nikt nie patrzył → ktoś patrzy).
   *
   * Osobny callback, a nie zaglądanie do harmonogramu, bo zależność ma iść w jedną stronę:
   * rejestr obecności nie wie, że gdzieś istnieją powiadomienia. Wywołanie jest jednorazowe
   * na przejście — odświeżenia co 20 s go NIE odpalają.
   */
  readonly onActive?: () => void;
}

/**
 * Rejestr obecnych klientów.
 *
 * Klasa, a nie funkcje na mapie, wyłącznie dla wstrzykiwanego zegara: testy muszą umieć postarzyć
 * wpis o minutę bez czekania minuty.
 */
export class Presence {
  readonly #clients = new Map<string, Entry>();
  readonly #ttlMs: number;
  readonly #graceMs: number;
  readonly #maxClients: number;
  readonly #now: () => number;
  readonly #log: ((line: string) => void) | undefined;
  readonly #onActive: (() => void) | undefined;
  /**
   * Ostatnia chwila, w której ktoś NA PEWNO patrzył: zgłoszenie `visible: true` albo zejście z ekranu
   * (`visible: false`, {@link forget}) klienta, który do tej chwili był widoczny. Osobno od wpisów, bo te
   * znikają po TTL, a karencja trwa dłużej. Zamknięcie strumienia SSE `forget` nie woła (`sse.ts`), więc klient,
   * który zamilkł bez `visible: false`, liczy się od ostatniego `visible: true`.
   */
  #lastVisibleAt: number | undefined;

  constructor(options: PresenceOptions = {}) {
    this.#ttlMs = options.ttlMs ?? PRESENCE_TTL_MS;
    this.#graceMs = options.graceMs ?? PRESENCE_GRACE_MS;
    this.#maxClients = options.maxClients ?? PRESENCE_MAX_CLIENTS;
    this.#now = options.now ?? ((): number => Date.now());
    this.#log = options.log;
    this.#onActive = options.onActive;
  }

  /**
   * Zgłoszenie od klienta. Wywoływane przy zmianie widoczności ORAZ jako odpowiedź na heartbeat.
   *
   * `visible: false` zapisujemy, zamiast kasować wpis, bo to dwie różne rzeczy: „powiedział, że
   * schodzi w tło" (wiemy na pewno) kontra „zamilkł" (mógł stracić sieć w trakcie patrzenia).
   * Pierwsze ma gasić obecność NATYCHMIAST, drugie dopiero po TTL.
   */
  note(clientId: string, report: PresenceReport): void {
    const at = this.#now();
    const before = this.#clients.get(clientId);
    // Logujemy ZMIANĘ, nie odświeżenie: te lecą co 20 s z każdego otwartego urządzenia.
    const moved = before === undefined
      || before.visible !== report.visible
      || before.sessionId !== report.sessionId;
    if (moved) {
      const where = report.sessionId === undefined ? 'list' : `session ${report.sessionId}`;
      this.#log?.(`presence: ${clientId} ${report.visible ? 'WATCHING' : 'in the background'} (${where})`);
    }
    // Stan PRZED zapisem — po nim nie da się już odróżnić powrotu od zwykłego odświeżenia.
    const wasActive = this.active();
    if (report.visible || this.#visibleNow(before, at)) this.#lastVisibleAt = at;
    this.#clients.set(clientId, {
      visible: report.visible,
      sessionId: report.sessionId,
      at,
    });
    this.#evict(at);
    if (!wasActive && this.active()) this.#onActive?.();
  }

  /** Klient odszedł (zamknięty strumień SSE). Nieznany identyfikator jest no-opem. */
  forget(clientId: string): void {
    const at = this.#now();
    if (this.#visibleNow(this.#clients.get(clientId), at)) this.#lastVisibleAt = at;
    this.#clients.delete(clientId);
  }

  /**
   * Ile milisekund zostało z karencji po ostatniej widoczności ({@link PRESENCE_GRACE_MS}); 0 = minęła albo nikt
   * od startu serwera nie patrzył. Harmonogram odkłada o tyle pierwsze sprawdzenie „gotowe”.
   */
  graceLeftMs(): number {
    if (this.#lastVisibleAt === undefined) return 0;
    return Math.max(0, this.#lastVisibleAt + this.#graceMs - this.#now());
  }

  /**
   * Czy ktokolwiek patrzy w Raroga.
   *
   * To jest bramka pushy — jedyne pytanie, na które musi odpowiedzieć poprawnie, żeby
   * „powiadomienia tylko wtedy, gdy nie mam aktywnego okna" było prawdą.
   */
  active(): boolean {
    const at = this.#now();
    for (const entry of this.#clients.values()) {
      if (entry.visible && at - entry.at < this.#ttlMs) return true;
    }
    return false;
  }

  /**
   * Czy ktoś ma otwarty transkrypt TEJ sesji.
   *
   * Bramka snackbara: sygnał o sesji, na którą właśnie patrzysz, jest czystym szumem — transkrypt
   * już to pokazuje. Nie jest to bramka pushy: push gasi {@link active}, bo wtedy patrzysz
   * w Raroga GDZIEKOLWIEK.
   */
  watching(sessionId: string): boolean {
    const at = this.#now();
    for (const entry of this.#clients.values()) {
      if (!entry.visible || at - entry.at >= this.#ttlMs) continue;
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  #visibleNow(entry: Entry | undefined, at: number): boolean {
    return entry !== undefined && entry.visible && at - entry.at < this.#ttlMs;
  }

  /** Ilu klientów jest w rejestrze (diagnostyka i testy) — także tych przeterminowanych. */
  get size(): number {
    return this.#clients.size;
  }

  /**
   * Sprząta przeterminowane wpisy, a gdy to nie wystarczy — najstarszy.
   *
   * Sufit jest potrzebny, bo identyfikator klienta nadaje strumień SSE, a iOS zrywa go przy
   * każdym uśpieniu ekranu: telefon otwiera go kilkadziesiąt razy dziennie i bez sprzątania
   * mapa rosłaby przez cały czas życia procesu.
   */
  #evict(at: number): void {
    for (const [id, entry] of this.#clients) {
      if (at - entry.at >= this.#ttlMs) this.#clients.delete(id);
    }
    while (this.#clients.size > this.#maxClients) {
      let oldestId: string | undefined;
      let oldestAt = Infinity;
      for (const [id, entry] of this.#clients) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      this.#clients.delete(oldestId);
    }
  }
}
