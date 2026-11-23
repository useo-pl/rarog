/**
 * Throttle of failed authentication attempts and the attempt source for the log.
 *
 * Throttles failures globally, in process memory, with ONE budget for two paths: `POST /api/pair` with a
 * bad code and the `Rarog-Device` header with a key the server does not know (REST, SSE and the terminal
 * upgrade). Only the log line carries the attempt kind. It authenticates nothing itself: that is
 * `principal.ts` (`authenticate`).
 */
import type { IncomingMessage } from 'node:http';
import { irohPeerLabel } from '../iroh/socket.ts';

/** How many failed attempts in a window get 401/404 before the rest start getting 429. */
export const LOGIN_FAILURE_BUDGET = 10;

/** Length of the budget window: after it the counter starts from zero. */
export const LOGIN_WINDOW_MS = 60_000;

/** How many distinct sources we name in the summary line (the rest go as "+N"). */
const LOGIN_PEERS_IN_LOG = 3;

/**
 * The source label is the LONGEST PREFIX of IP address characters (v4/v6).
 *
 * A prefix, and not "cut out bad characters": from `1.2.3.4\nfailed pairing (victim)` cutting would
 * still leave a tail of hex letters. The first character outside an address ends the label.
 */
const PEER_PREFIX = /^[0-9a-fA-F:.[\]]*/;

/**
 * Source of a failed attempt for the log: the first part of `X-Forwarded-For` (Caddy adds it),
 * and without it the socket address.
 *
 * The client sets the header, so its value is NOT proof: it is a clue, and so it
 * goes through a character filter and a hard length limit: without that one request would inject
 * its own line (`\n`) or a kilobyte of garbage into `server.log`.
 *
 * iroh socket: `iroh:<12 characters of EndpointId>` from `socket.ts`, skipping the header and the filter. The
 * EndpointId comes from the QUIC handshake (the client key), so it is authenticated and has only hex characters.
 */
export function loginPeer(req: IncomingMessage): string {
  const iroh = irohPeerLabel(req.socket);
  if (iroh !== null) return iroh;
  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const forwarded = (header ?? '').split(',')[0]?.trim() ?? '';
  const source = forwarded !== '' ? forwarded : (req.socket?.remoteAddress ?? '');
  const clean = (PEER_PREFIX.exec(source)?.[0] ?? '').slice(0, 45);
  return clean === '' ? 'unknown source' : clean;
}

/** What to do with a failed attempt: the response status and (optionally) a log line. */
export interface LoginFailureOutcome {
  /** Window budget exhausted: we answer 429 instead of 401. */
  readonly limited: boolean;
  /** Seconds to the end of the window, for the `Retry-After` header. Always ≥ 1. */
  readonly retryAfterSeconds: number;
  /** A log line, or `undefined` when this failure fits in an already written summary. */
  readonly logLine?: string;
}

/** Kind of failed attempt: only for the log line (the budget is one). */
export type FailureKind = 'pairing' | 'device key';

export interface LoginLimiter {
  /** Records a FAILED attempt and says how to answer it. */
  fail(peer: string, nowMs: number, kind: FailureKind): LoginFailureOutcome;
  /** Successful pairing: the owner proved who they are, the window starts from zero. */
  succeed(): void;
}

export interface LoginLimiterOptions {
  budget?: number;
  windowMs?: number;
}

/**
 * Throttle of failed attempts: global, in process memory.
 *
 * Why it throttles FAILURES, and not all attempts: `/api/pair` is public (`PUBLIC_PATHS`),
 * and the tailnet's range holds OTHER PEOPLE'S devices (`docs/security-model.md`). If every attempt
 * ate the budget, an unauthenticated peer could close the owner's way to their own
 * Rarog by noise alone. The throttle takes two things from an attacker that we really deny them:
 * - unlimited writing to the UNROTATED `server.log` (a line per attempt → GB per day),
 * - invisibility: at least the window's first failure and the moment the budget is exceeded
 *   leave a trace with the source and the counter, and the upper bound is 2 lines per window.
 *
 * This throttle does NOT replace credential strength and does not pretend to: a pairing code lives 5 minutes and is
 * single-use, and a device key is 32 random bytes.
 */
export function createLoginLimiter(opts: LoginLimiterOptions = {}): LoginLimiter {
  const budget = opts.budget ?? LOGIN_FAILURE_BUDGET;
  const windowMs = opts.windowMs ?? LOGIN_WINDOW_MS;
  let windowStartMs = 0;
  let failures = 0;
  const peers = new Set<string>();

  const peerList = (): string => {
    const shown = [...peers].slice(0, LOGIN_PEERS_IN_LOG);
    const rest = peers.size - shown.length;
    return rest > 0 ? `${shown.join(', ')} +${String(rest)}` : shown.join(', ');
  };

  return {
    fail(peer, nowMs, kind) {
      if (failures === 0 || nowMs - windowStartMs >= windowMs) {
        windowStartMs = nowMs;
        failures = 0;
        peers.clear();
      }
      failures += 1;
      // The set of sources has a cap: without it an attack with a forged `X-Forwarded-For` would grow a map
      // in process memory for the whole window.
      if (peers.size < LOGIN_PEERS_IN_LOG * 4) peers.add(peer);
      const retryAfterSeconds = Math.max(
        1, Math.ceil((windowStartMs + windowMs - nowMs) / 1000),
      );
      const limited = failures > budget;
      if (failures === 1) {
        // The kind stands in the line directly: `failed pairing attempt (…)`,
        // `failed device key attempt (…)`.
        return { limited, retryAfterSeconds, logLine: `failed ${kind} attempt (${peer})` };
      }
      if (failures === budget + 1) {
        return {
          limited,
          retryAfterSeconds,
          logLine: `failed attempts: budget ${String(budget)} in a ${
            String(Math.round(windowMs / 1000))} s window exhausted, further attempts get 429 (sources: ${
            peerList()}; counted together: pairing, unknown device key)`,
        };
      }
      return { limited, retryAfterSeconds };
    },
    succeed() {
      failures = 0;
      peers.clear();
    },
  };
}
