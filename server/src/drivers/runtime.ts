/**
 * Wspólne narzędzia runtime driverów: jednokonsumencka kolejka async oraz wstrzykiwalny zegar.
 *
 * Jedno miejsce tej mechaniki dla driverów; testy podają własny `Scheduler` zamiast czekać na realny
 * czas.
 */

/** Uchwyt timera — celowo `unknown`, żeby test mógł podać własną implementację zegara. */
export type TimerHandle = unknown;

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** Monotoniczny „teraz" w ms (w testach sterowany przez fake timery). */
  now(): number;
}

/** Domyślny zegar: globalny `setTimeout` (podmieniany przez fake timery vitest). */
export const systemScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now: () => Date.now(),
};

/**
 * Kolejka zdarzeń z interfejsem `AsyncIterable`.
 *
 * Założenia:
 * - dokładnie JEDEN konsument (pump managera) — kolejka trzyma najwyżej jednego oczekującego,
 * - `push()` po `close()` jest ignorowany (driver może dosłać event w trakcie sprzątania),
 * - `close()` domyka iterację (`for await` kończy się normalnie, nie wyjątkiem).
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #buffer: T[] = [];
  #waiting: ((result: IteratorResult<T, undefined>) => void) | null = null;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  /** Liczba elementów czekających na odbiór (diagnostyka/testy). */
  get pendingCount(): number {
    return this.#buffer.length;
  }

  push(value: T): void {
    if (this.#closed) return;
    const waiting = this.#waiting;
    if (waiting !== null) {
      this.#waiting = null;
      waiting({ value, done: false });
      return;
    }
    this.#buffer.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiting = this.#waiting;
    if (waiting !== null) {
      this.#waiting = null;
      waiting({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    const next = (): Promise<IteratorResult<T, undefined>> => {
      if (this.#buffer.length > 0) {
        // `shift()` jest bezpieczny — długość sprawdzona wyżej.
        const value = this.#buffer.shift() as T;
        return Promise.resolve({ value, done: false });
      }
      if (this.#closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<T, undefined>>((resolve) => {
        this.#waiting = resolve;
      });
    };
    return {
      next,
      return: (): Promise<IteratorResult<T, undefined>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
