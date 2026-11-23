/** Typy `relay-watch.mjs` dla testów `relay-vps/test/`. */

export interface WatchState {
  /** Próbki `[ms od epoki, tx_bytes]` z ostatnich ok. 70 min. */
  samples: [number, number][];
  /** Miesiąc UTC `RRRR-MM`, do którego liczy się `monthBytes`. */
  month: string;
  monthBytes: number;
  lastTx: number | null;
  /** Miesiąc, w którym poszedł alert progu miesięcznego (pusty: jeszcze nie). */
  monthAlerted: string;
  lastRunMs: number | null;
  /** Klucz alertu → chwila ostatniego wysłania. */
  alertedAt: Record<string, number>;
  /** UTC day `YYYY-MM-DD` → highest connection count seen that day; only today and yesterday. */
  connPeaks: Record<string, number>;
}

export interface WatchInput {
  txBytes: number;
  conns: number;
  unauthorized: number;
  /** Powód porażki odczytu dziennika adaptera (wtedy `unauthorized` = 0). */
  journalError?: string;
}

export const LINK_BYTES_PER_S: number;
export const RATE_ALERT_FRACTION: number;
export const MONTH_ALERT_BYTES: number;
export const CONN_ALERT: number;
export const SS_ARGS: string[];
export function emptyState(): WatchState;
export function evaluate(prev: Partial<WatchState> | null, input: WatchInput, nowMs: number): {
  state: WatchState;
  alerts: string[];
};
export function countUnauthorized(journal: string): number;
export function dayOf(ms: number): string;
export function forEachLine(cmd: string, args: string[], onLine: (line: string) => void): Promise<void>;
export function countMatching(cmd: string, args: string[], re: RegExp): Promise<number>;
