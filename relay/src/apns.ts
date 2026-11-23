/**
 * One request to APNs (`POST /3/device/<token>`) through an injected `fetch`, and reading the response.
 *
 * The result is either Apple's response (status, the `reason` word, `timestamp` in epoch ms on 410, unchanged), or
 * "Apple did not respond" (network, 10 s cap). The latter is NEVER confused with a dead token: a dead token
 * is only 410 or 400 `BadDeviceToken`/`DeviceTokenNotForTopic` (like the server's `GONE_REASONS`,
 * `server/src/notify/apns.ts`).
 *
 * Does not log and does not throw. The `fetch` error message never leaves this module (it could carry request
 * headers, and `authorization` holds the JWT); only the cause `timeout` or `network`.
 */
import type { ApnsEnvironment } from './identity.ts';

/** APNs hosts per environment (the app's `aps-environment`). */
export const APNS_ORIGINS: Readonly<Record<ApnsEnvironment, string>> = {
  development: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};

/** Cap on the APNs response (as in the server's sender); after it the request is aborted. */
export const APNS_TIMEOUT_MS = 10_000;
/** How many bytes of the response body we read: APNs returns `{"reason": …}`, never more. */
export const APNS_RESPONSE_MAX_BYTES = 4096;

/** `400` reasons after which the token is dead (410 is always dead). */
export const TOKEN_REJECTED_REASONS: ReadonlySet<string> = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic']);

const REASON_RE = /^[A-Za-z]{1,64}$/;

export type ApnsFetch = (url: string, init: RequestInit) => Promise<Response>;

export type ApnsOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly reason?: string; readonly timestamp?: number }
  | { readonly kind: 'unreachable'; readonly cause: 'timeout' | 'network' };

export interface ApnsCall {
  readonly environment: ApnsEnvironment;
  /** Lowercase hex. */
  readonly token: string;
  readonly jwt: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Apple's response means a dead token (for `/v1/pass`: 422 `token-rejected`). */
export function isTokenRejection(outcome: ApnsOutcome): boolean {
  return outcome.kind === 'response' && (outcome.status === 410
    || (outcome.status === 400 && outcome.reason !== undefined && TOKEN_REJECTED_REASONS.has(outcome.reason)));
}

async function readCapped(response: Response, max: number): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= max) {
      await reader.cancel();
      break;
    }
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all.subarray(0, max));
}

/** `reason` (letters-only word) and `timestamp` (safe integer) from the response body. */
function parseBody(text: string): { reason?: string; timestamp?: number } {
  try {
    const parsed = JSON.parse(text) as { reason?: unknown; timestamp?: unknown };
    return {
      ...(typeof parsed.reason === 'string' && REASON_RE.test(parsed.reason) ? { reason: parsed.reason } : {}),
      ...(typeof parsed.timestamp === 'number' && Number.isSafeInteger(parsed.timestamp)
        ? { timestamp: parsed.timestamp } : {}),
    };
  } catch {
    // Empty (200) or non-JSON body: no reason.
    return {};
  }
}

export async function callApns(fetchFn: ApnsFetch, call: ApnsCall, timeoutMs = APNS_TIMEOUT_MS): Promise<ApnsOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchFn(`${APNS_ORIGINS[call.environment]}/3/device/${call.token}`, {
      method: 'POST',
      headers: { ...call.headers, authorization: `bearer ${call.jwt}`, 'content-type': 'application/json' },
      body: call.body,
      signal: controller.signal,
    });
    const text = await readCapped(response, APNS_RESPONSE_MAX_BYTES);
    return { kind: 'response', status: response.status, ...(response.status === 200 ? {} : parseBody(text)) };
  } catch {
    return { kind: 'unreachable', cause: timedOut ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
