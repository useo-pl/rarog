/**
 * Licznik kosztu gita do `server.log` — JEDNA linia na okno, nie linia na odczyt.
 *
 * Po co: szczegóły plików (`fileDetails`) dokładają do odczytu gita trzeci proces
 * (`git diff --numstat`), a podpis ramki obejmuje liczniki linii, więc ramek `git-status` może być
 * więcej. Ile kosztuje to naprawdę na kilkunastu panelach, mówi dopiero żywy serwer: ta linia
 * pozwala porównać okres z `RAROG_GIT_FILE_DETAILS=0` z okresem z `1`.
 *
 * Dlaczego okno, a nie linia na odczyt: przy kilkunastu panelach odczytów są dziesiątki na minutę,
 * a `server.log` pod launchd tylko rośnie. Okno zamyka się LENIWIE — przy pierwszym zdarzeniu po
 * jego końcu — więc bez ruchu w gicie nie ma ani linii, ani timera.
 */
import type { NumstatOutcome } from './git-status.ts';

/** Długość okna pomiaru. */
export const GIT_STATS_WINDOW_MS = 5 * 60_000;

/** Fraza linii kosztu gita za jedno okno: `git: window <s> s — reads …`. */
export const GIT_STATS_WINDOW_LOG = 'git: window';

/** Sufit próbek czasu w jednym oknie — pamięć ograniczona także przy burzy odczytów. */
const MAX_SAMPLES = 10_000;

export class GitReadStats {
  readonly #now: () => number;
  readonly #windowMs: number;
  #startedAt: number | null = null;
  #samples: number[] = [];
  #reads = 0;
  #frames = 0;
  #numstat: Record<NumstatOutcome, number> = { ok: 0, skipped: 0, timeout: 0, failed: 0 };

  constructor(now: () => number, windowMs = GIT_STATS_WINDOW_MS) {
    this.#now = now;
    this.#windowMs = windowMs;
  }

  /** Jeden odczyt gita (`#collect`): czas całości i los liczników. Linia za zamknięte okno albo `null`. */
  noteRead(ms: number, numstat: NumstatOutcome): string | null {
    const line = this.#rollOver();
    this.#reads += 1;
    if (this.#samples.length < MAX_SAMPLES) this.#samples.push(ms);
    this.#numstat[numstat] += 1;
    return line;
  }

  /** Jedna rozgłoszona ramka `git-status`. Linia za zamknięte okno albo `null`. */
  noteFrame(): string | null {
    const line = this.#rollOver();
    this.#frames += 1;
    return line;
  }

  /** Zamyka okno, jeśli minęło, i oddaje jego linię; otwiera okno przy pierwszym zdarzeniu. */
  #rollOver(): string | null {
    const now = this.#now();
    if (this.#startedAt === null) {
      this.#startedAt = now;
      return null;
    }
    const elapsed = now - this.#startedAt;
    if (elapsed < this.#windowMs) return null;
    const line = this.#format(elapsed);
    this.#startedAt = now;
    this.#samples = [];
    this.#reads = 0;
    this.#frames = 0;
    this.#numstat = { ok: 0, skipped: 0, timeout: 0, failed: 0 };
    return line;
  }

  #format(elapsedMs: number): string {
    const sorted = [...this.#samples].sort((a, b) => a - b);
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    const n = this.#numstat;
    return `${GIT_STATS_WINDOW_LOG} ${String(Math.round(elapsedMs / 1000))} s — reads ${String(this.#reads)}`
      + ` (median ${String(at(0.5))} ms, p95 ${String(at(0.95))} ms, max ${String(sorted.at(-1) ?? 0)} ms),`
      + ` numstat ok ${String(n.ok)} / skipped ${String(n.skipped)} / timeout ${String(n.timeout)}`
      + ` / error ${String(n.failed)}, git-status frames ${String(this.#frames)}`;
  }
}
