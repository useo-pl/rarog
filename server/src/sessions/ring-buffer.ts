/**
 * Ring buffer eventów per żywa sesja — źródło tail-replay dla SSE (`Last-Event-ID`).
 *
 * Kontrakt ze speca: pojemność 500, `push(t) → seq` monotoniczny od 1, `since(seq) → T[]`,
 * `tooOld(seq) → boolean`.
 *
 * Semantyka kursora (taka sama jak w SSE): kursor to `seq` OSTATNIEGO odebranego eventu,
 * więc `since(seq)` zwraca elementy o `seq > kursor`. Kursor `0` = „nic jeszcze nie widziałem".
 * `seq` żyje w ramach jednego `serverStartId` — po restarcie backendu kursor jest z definicji
 * nieważny. Pilnuje tego warstwa SSE, nie bufor: `id:` ramki niesie `<serverStartId>:<seq>`,
 * a `openSession` odsyła kursor z obcym prefiksem prosto na `transcript-snapshot`. Bez
 * tego sprawdzenia — `tooOld` widzi tylko własny licznik — kursor z poprzedniego
 * procesu przechodziłby jako ważny i klient dostawałby replay zamiast snapshotu (gubiąc m.in.
 * odtworzone karty zgody).
 *
 * Delty tekstu NIE wchodzą do bufora (są ulotne) — decyduje o tym wołający.
 *
 * Sufit jest DWOJAKI: sztuki ORAZ bajty ({@link RING_MAX_BYTES}). Sam
 * licznik sztuk nie mówi nic o pamięci — 500 eventów bywało 500 kB i bywało 20 MB, zależnie
 * od tego, ile zdjęć poszło z telefonu. Oba sufity wypychają najstarsze wpisy tą samą drogą.
 */

/** Element bufora razem z przypisanym numerem sekwencyjnym. */
export interface RingEntry<T> {
  seq: number;
  value: T;
}

/** Domyślna pojemność wg speca. */
export const DEFAULT_RING_CAPACITY = 500;

/**
 * Sufit BAJTÓW jednej wiadomości transkryptu.
 *
 * Sztuki nie są miarą pamięci: jedna wiadomość potrafiła nieść 5 × 1,5 MB base64, a bloki
 * `tool-call` z długim diffem potrafią urosnąć same z siebie. Wiadomość ponad ten sufit jest
 * PRZYCINANA z jawnym znacznikiem (`sessions/session.ts`) — Rarog jest do zerkania, więc
 * ćwierć megabajta tekstu na jednym dymku i tak nie jest treścią, którą ktokolwiek czyta
 * z telefonu, a cichy zjazd byłby gorszy od widocznego cięcia.
 */
export const MAX_MESSAGE_BYTES = 256 * 1024;

/**
 * Sufit BAJTÓW pamięci transkryptu JEDNEJ sesji — mierzony osobno dla ringu eventów
 * i dla tablicy wiadomości (obie struktury trzymają te same wiadomości, obie oddają je
 * na telefon: ring przez replay `Last-Event-ID`, tablica przez `transcript-snapshot`).
 *
 * 4 MB × 30 paneli (sufit liczby paneli) to pesymistycznie 120 MB — tyle wolno Rarogowi zająć
 * transkryptami. Przekroczenie wypycha NAJSTARSZE wpisy, dokładnie tak jak sufit sztuk;
 * sztuki zostają drugim limitem, bo 500 malutkich eventów też ma się kiedyś skończyć.
 */
export const RING_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Waga wartości w bajtach = długość jej JSON-a w UTF-8.
 *
 * Mierzymy dokładnie to, co pójdzie na telefon (ramka SSE to ten sam JSON), a nie zgadujemy
 * rozmiaru obiektu w RAM — obie liczby są tego samego rzędu, a tylko pierwsza da się
 * sprawdzić testem. Wartość niekodowalna (cykl) waży 0: bufor nie ma prawa rzucić przy pushu.
 */
export function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

export interface RingBufferOptions<T> {
  /** Sufit sumy wag; brak = bufor liczy wyłącznie sztuki (tak działa w testach jednostkowych). */
  maxBytes?: number;
  /** Waga elementu; domyślnie {@link jsonBytes}. Bez `maxBytes` nie jest w ogóle wołana. */
  weigh?: (value: T) => number;
}

export class RingBuffer<T> {
  /** Tablica cykliczna o stałej długości `capacity`. */
  readonly #slots: (T | undefined)[];
  /** Waga każdego zajętego slotu — indeksy zgodne ze `#slots`. */
  readonly #weights: number[];
  readonly #capacity: number;
  readonly #maxBytes: number | null;
  readonly #weigh: (value: T) => number;
  /** Indeks najstarszego elementu w `#slots`. */
  #start = 0;
  #size = 0;
  /** Suma wag elementów aktualnie przechowywanych. */
  #bytes = 0;
  /** Ostatnio przydzielony `seq`; 0 = nic jeszcze nie wrzucono. */
  #lastSeq = 0;

  constructor(capacity: number = DEFAULT_RING_CAPACITY, opts: RingBufferOptions<T> = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer: pojemność musi być dodatnią liczbą całkowitą, jest ${capacity}`);
    }
    this.#capacity = capacity;
    this.#slots = new Array<T | undefined>(capacity);
    this.#weights = new Array<number>(capacity).fill(0);
    this.#maxBytes = opts.maxBytes ?? null;
    this.#weigh = opts.weigh ?? jsonBytes;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** Suma wag przechowywanych elementów; `0`, gdy bufor nie ma sufitu bajtów. */
  get bytes(): number {
    return this.#bytes;
  }

  /** Liczba elementów aktualnie przechowywanych (≤ capacity). */
  get size(): number {
    return this.#size;
  }

  /** `seq` ostatnio wrzuconego elementu (0, gdy bufor nigdy nic nie dostał). */
  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** `seq` najstarszego zachowanego elementu; `null`, gdy bufor jest pusty. */
  get firstSeq(): number | null {
    return this.#size === 0 ? null : this.#lastSeq - this.#size + 1;
  }

  /**
   * Najstarszy kursor, który da się jeszcze obsłużyć bez utraty eventów.
   * Dla pustego bufora = `lastSeq` (można obsłużyć wyłącznie „jestem na bieżąco").
   */
  get oldestServableCursor(): number {
    return this.#lastSeq - this.#size;
  }

  /** Dopisuje element i zwraca jego `seq` (monotoniczny, od 1, bez dziur). */
  push(value: T): number {
    const writeAt = (this.#start + this.#size) % this.#capacity;
    this.#slots[writeAt] = value;
    const weight = this.#maxBytes === null ? 0 : this.#weigh(value);
    if (this.#size === this.#capacity) {
      // Wrap-around: najstarszy element wypada, `start` przesuwa się o jeden.
      this.#bytes -= this.#weights[this.#start] ?? 0;
      this.#start = (this.#start + 1) % this.#capacity;
    } else {
      this.#size += 1;
    }
    this.#weights[writeAt] = weight;
    this.#bytes += weight;
    this.#lastSeq += 1;
    /*
     * Sufit bajtów wypycha NAJSTARSZE — tak samo jak sufit sztuk, więc `firstSeq`,
     * `oldestServableCursor` i `tooOld` liczą się dalej z samego `#size` i kursor za starym
     * ogonem kończy się snapshotem, a nie dziurą w replayu.
     *
     * Element, który sam przekracza sufit, ZOSTAJE (bufor nie może być pusty po pushu):
     * jego wagę ograniczyliśmy wcześniej, przy składaniu wiadomości (MAX_MESSAGE_BYTES).
     */
    while (this.#maxBytes !== null && this.#bytes > this.#maxBytes && this.#size > 1) {
      this.#bytes -= this.#weights[this.#start] ?? 0;
      this.#slots[this.#start] = undefined;
      this.#weights[this.#start] = 0;
      this.#start = (this.#start + 1) % this.#capacity;
      this.#size -= 1;
    }
    return this.#lastSeq;
  }

  /**
   * Czy kursor jest nie do obsłużenia (trzeba wysłać pełny snapshot)?
   *
   * `true`, gdy:
   * - część eventów po kursorze została już wyparta z bufora (kursor za stary), albo
   * - kursor wskazuje na `seq` z przyszłości / z innego `serverStartId` (kursor niespójny).
   */
  tooOld(seq: number): boolean {
    if (!Number.isFinite(seq)) return true;
    if (seq > this.#lastSeq) return true;
    return seq < this.oldestServableCursor;
  }

  /**
   * Ogon po kursorze: elementy o `seq > seq`.
   * Wołający powinien NAJPIERW sprawdzić `tooOld()` — przy zbyt starym kursorze dostanie
   * tylko to, co zostało w buforze (dziura jest wtedy nieunikniona).
   */
  since(seq: number): T[] {
    return this.entriesSince(seq).map((entry) => entry.value);
  }

  /** Jak `since()`, ale z numerami `seq` (SSE potrzebuje ich do pola `id:`). */
  entriesSince(seq: number): RingEntry<T>[] {
    const first = this.firstSeq;
    if (first === null) return [];
    const from = Math.max(first, Number.isFinite(seq) ? Math.floor(seq) + 1 : first);
    if (from > this.#lastSeq) return [];
    const out: RingEntry<T>[] = [];
    for (let s = from; s <= this.#lastSeq; s += 1) {
      const index = (this.#start + (s - first)) % this.#capacity;
      out.push({ seq: s, value: this.#slots[index] as T });
    }
    return out;
  }

  /** Wszystko, co bufor przechowuje, od najstarszego. */
  toArray(): T[] {
    return this.since(this.oldestServableCursor);
  }

  /** Wszystko z numerami `seq`, od najstarszego. */
  entries(): RingEntry<T>[] {
    return this.entriesSince(this.oldestServableCursor);
  }

  /** Czyści zawartość; `seq` NIE cofa się (monotoniczność w ramach `serverStartId`). */
  clear(): void {
    this.#slots.fill(undefined);
    this.#weights.fill(0);
    this.#start = 0;
    this.#size = 0;
    this.#bytes = 0;
  }
}
