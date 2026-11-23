/**
 * Limity planu (okno 5 h i tydzień) dla Live Activity — z ZRZUTÓW paska
 * statusu Claude Code, nie z API limitów.
 *
 * Powód: API limitów dzielimy z sesjami CLI na tym koncie, a ono potrafi odrzucać każde
 * zapytanie z adresu Maca. Zrzuty paska statusu
 * (`~/.claude/statusline/*.json`) to lokalne pliki, które CLI odświeża przy każdej turze — zero sieci.
 * Panel limitów apki czyta te same zrzuty, tylko na żądanie. Cena: gdy nic nie pracuje, liczby
 * stoją, a przy dwóch kontach na Macu kafel mówi o koncie, które ostatnio rozmawiało z API.
 *
 * Reguły:
 * - każdy udany odczyt ZASTĘPUJE poprzedni w całości: oba okna pochodzą z jednego zrzutu, czyli z jednego
 *   konta — sklejanie okna 5 h z jednego odczytu z tygodniem z innego mieszałoby konta;
 * - okno po `resetsAt` znika z kafla, a nie spada do 0 %: reset bez nowego zrzutu nie dowodzi zera, bo
 *   limit mógł rosnąć na innym urządzeniu. Kafel pokazuje wtedy „nie wiem" (brak paska);
 * - błąd odczytu zostawia poprzedni odczyt (dalej z tą samą regułą resetu).
 *
 * Odczyt przez `scanFreshestRateLimits`, który przy nieczytelnym katalogu rzuca — wspólne `null` z „brak
 * żywego okna" kasowałoby limity przy chwilowym błędzie.
 *
 * Co {@link LIMITS_POLL_MS} odczyt; zmiana WIDOCZNYCH procentów (także zniknięcie okna po resecie) woła
 * `onChange` — producent przelicza stan i wysyła aktualizację priorytetem 5, w throttlingu. **Nigdy nie rzuca.**
 *
 * Next to the tile the poller hands over the weekly window of every live reset (`weeklyWindows()`, all accounts on
 * this Mac, not only the winner) and calls `onPoll` after every read, also an unchanged or a failed one: the
 * weekly-limit signal (`weekly-limit.ts`) evaluates there, without a second timer or scan.
 */
import { defaultStatuslineRoot, scanFreshestRateLimits } from '../herdr/statusline.ts';
import type { StatuslineLimitWindow, StatuslineRateLimits } from '../herdr/statusline.ts';

/** Co ile odczyt zrzutów — limity rosną w tempie minut. */
export const LIMITS_POLL_MS = 60_000;

/** One weekly window for the weekly-limit signal. */
export interface WeeklyLimitReading {
  /** {@link contractPercent} of the window: the same rounding as the tile and the list footer. */
  readonly percent: number;
  /** ISO reset instant; the dedup key of the signal. */
  readonly resetsAt: string;
  /** ms epoch: `changeAt` of that window's newest dump. */
  readonly at: number;
}

/** Procenty w kształcie kontraktu kafla (`limits` stanu treści). */
export interface LiveActivityLimits {
  fiveHour?: number;
  weekly?: number;
}

export interface LimitsPollerOptions {
  /** Najświeższy zrzut z limitami; `null` = żaden zrzut nie ma żywego okna; wyjątek = odczyt się nie udał. */
  readonly read?: (now: number) => Promise<StatuslineRateLimits | null>;
  readonly now?: () => number;
  /** Zmiana widocznych procentów (pierwsze pojawienie się, wzrost, zniknięcie po resecie). */
  readonly onChange?: () => void;
  /** After every read (also a failed one), after `onChange`; never after `close()`; its exceptions are swallowed. */
  readonly onPoll?: () => void;
  readonly setInterval?: (cb: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface LimitsPoller {
  /** Procenty na tę chwilę (okno po resecie pominięte); `undefined` = żadnego żywego okna. */
  current(): LiveActivityLimits | undefined;
  /** Weekly windows of the last reading, one per live reset; windows past their reset dropped on every call. */
  weeklyWindows(): readonly WeeklyLimitReading[];
  close(): void;
}

/** Procent w kształcie kontraktu: całość w klamrze 0–100 (`used_percentage` bywa ułamkiem). */
export function contractPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Procent okna, które jeszcze trwa; po resecie (albo z nieczytelną datą) — brak. */
function live(window: StatuslineLimitWindow | undefined, now: number): number | undefined {
  if (window === undefined) return undefined;
  const resetsAt = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAt) || now >= resetsAt) return undefined;
  return contractPercent(window.percent);
}

export function createLimitsPoller(options: LimitsPollerOptions = {}): LimitsPoller {
  const now = options.now ?? ((): number => Date.now());
  // `scan…`, nie `read…`: nieczytelny katalog musi RZUCIĆ, żeby błąd I/O nie skasował limitów.
  const read = options.read ?? ((at: number) => scanFreshestRateLimits(defaultStatuslineRoot(), at));
  const startTimer = options.setInterval
    ?? ((cb, ms): unknown => {
      const handle = setInterval(cb, ms);
      if (typeof handle.unref === 'function') handle.unref();
      return handle;
    });
  const stopTimer = options.clearInterval ?? ((handle): void => { clearInterval(handle as NodeJS.Timeout); });

  let latest: StatuslineRateLimits | null = null;
  let closed = false;
  let polling = false;
  /**
   * Procenty ostatnio zgłoszone przez `onChange`. Porównanie z nimi, a nie ze stanem z początku
   * odczytu: reset okna zdejmuje je w `current()` sam, między odczytami — bez tej pamięci zniknięcie
   * paska po resecie nie budziłoby przeliczenia kafla.
   */
  let reported = 'null';

  const current = (): LiveActivityLimits | undefined => {
    const at = now();
    const five = live(latest?.fiveHour, at);
    const week = live(latest?.weekly, at);
    if (five === undefined && week === undefined) return undefined;
    return { ...(five === undefined ? {} : { fiveHour: five }), ...(week === undefined ? {} : { weekly: week }) };
  };

  const poll = async (): Promise<void> => {
    if (closed || polling) return;
    polling = true;
    try {
      try {
        latest = await read(now());
      } catch {
        // Błąd odczytu: zostaje poprzedni zrzut (reset i tak zdejmie jego okna w swoim czasie).
      }
      if (closed) return;
      const next = JSON.stringify(current() ?? null);
      if (next !== reported) {
        reported = next;
        try {
          options.onChange?.();
        } catch {
          // Producent sam pilnuje swoich wyjątków; tu tylko nie wypuszczamy niczego z timera.
        }
      }
      try {
        options.onPoll?.();
      } catch {
        // The signal guards its own exceptions; nothing leaves the timer.
      }
    } finally {
      polling = false;
    }
  };

  void poll();
  const timer = startTimer(() => { void poll(); }, LIMITS_POLL_MS);

  const weeklyWindows = (): readonly WeeklyLimitReading[] => {
    const at = now();
    return (latest?.weeklyWindows ?? []).flatMap((window) => {
      const percent = live(window, at);
      return percent === undefined ? [] : [{ percent, resetsAt: window.resetsAt, at: window.at }];
    });
  };

  return {
    current,
    weeklyWindows,
    close(): void {
      if (closed) return;
      closed = true;
      stopTimer(timer);
    },
  };
}
