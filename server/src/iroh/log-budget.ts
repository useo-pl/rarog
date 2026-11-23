/**
 * Log line budget for refusals at the iroh boundary (`docs/security-model.md`, "Layer 1b"). Before authentication
 * anyone who knows the server's EndpointId can trigger a refusal as often as they like, and one line per refusal
 * would flood `server.log`. So per refusal kind the FIRST line in a 60 s window goes out, and the rest only to the
 * counters; the end of a window with skipped lines gives one summary line with the count of each kind. `totals()`
 * gives the sums since process start (snapshot).
 *
 * Applies only to the iroh socket: TCP lines stay unchanged, and the `auth/limiter.ts` throttle counts a bad device
 * key and a bad pairing code.
 *
 * A detail comes from outside (a peer's error text, a refused request path), so it goes to the line through
 * `sanitizeLogText` (`text.ts`): no control or hidden character, at most 120 UTF-16 units.
 */
import { sanitizeLogText } from '../text.ts';
import type { IrohClock, IrohTimer } from './endpoint.ts';

/** Refusal and boundary event kinds, each with its own first line in the window. */
export const IROH_REFUSALS = [
  'handshake-refused', // over the limit of handshakes in progress: `refuse()` without a handshake
  'handshake-error', // handshake aborted on the client or network side
  'alpn', // ALPN other than `IROH_ALPN`
  'evicted', // unauthenticated connection closed to make room for a new one
  'busy', // connection limit reached and all authenticated: the new one closed
  'auth-timeout', // 60 s without authentication
  'stream-limit', // bidirectional stream over the connection limit
  'uni-stream', // unidirectional stream (the protocol does not use them)
  'close-escalation', // stream close operations past the deadline: connection closed
  'origin', // mutation with an `Origin` other than `IROH_ORIGIN`
  'upgrade-refused', // WebSocket upgrade refused
  'login', // `/api/login` over iroh
] as const;

export type IrohRefusal = typeof IROH_REFUSALS[number];

/** Budget window. */
export const LOG_BUDGET_WINDOW_MS = 60_000;

export interface LogBudget {
  /**
   * Event of kind `kind`; `detail` goes to the log only in the kind's first line in the window. The line carries it
   * through `sanitizeLogText`.
   */
  note(kind: IrohRefusal, detail: string): void;
  /** Sums since start. */
  totals(): Readonly<Record<IrohRefusal, number>>;
  /** End of work: summary of the current window at once. */
  flush(): void;
}

function zeros(): Record<IrohRefusal, number> {
  return Object.fromEntries(IROH_REFUSALS.map((kind) => [kind, 0])) as Record<IrohRefusal, number>;
}

export function createLogBudget(
  log: (line: string) => void, clock: IrohClock, windowMs: number = LOG_BUDGET_WINDOW_MS,
): LogBudget {
  const totals = zeros();
  let window: Record<IrohRefusal, number> | null = null;
  let suppressed = 0;
  let timer: IrohTimer | null = null;

  const close = (): void => {
    timer?.cancel();
    timer = null;
    const counts = window;
    window = null;
    if (counts === null || suppressed === 0) {
      suppressed = 0;
      return;
    }
    const parts = IROH_REFUSALS.filter((kind) => counts[kind] > 0).map((kind) => `${kind} ${String(counts[kind])}`);
    log(`iroh: refusals in a ${String(Math.round(windowMs / 1000))} s window: ${parts.join(', ')}`
      + ` (suppressed lines: ${String(suppressed)})`);
    suppressed = 0;
  };

  return {
    note(kind, detail) {
      totals[kind] += 1;
      if (window === null) {
        window = zeros();
        timer = clock.after(windowMs, close);
      }
      window[kind] += 1;
      if (window[kind] === 1) log(`iroh: ${kind} ${sanitizeLogText(detail)}`);
      else suppressed += 1;
    },
    totals: () => ({ ...totals }),
    flush: close,
  };
}
