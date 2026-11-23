/**
 * Apple calls of the registration gate ({@link AppleGate}) through an injected `fetch`:
 * - DeviceCheck: `query_two_bits` and `update_two_bits` (`https://api.devicecheck.apple.com/v1/…`, the
 *   `development` environment on `api.development.devicecheck.apple.com`), JWT ES256 provider token as for APNs;
 * - APNs: a test silent push to the device token (`callApns` of the push relay); the proof is Apple's 200 response.
 *
 * The result is a value or a failure of one of three kinds: `rejected` (Apple rejects the app's proof: bad
 * DeviceCheck token, dead APNs token), `unreachable` (network, timeout, 429, Apple 5xx) and `refused` (Apple rejects
 * our key or configuration: 401, 403, other 4xx). Does not log and does not throw; the `fetch` error message never
 * leaves this module (it could carry the `authorization` header with the provider token).
 */
import type { RelayAuthEnvironment } from '../../shared/src/relay-auth.ts';
import type { AppleFailure, AppleGate, AppleResult, DeviceBits } from './registry.ts';
import { APNS_TIMEOUT_MS, APP_TOPIC, callApns, isTokenRejection } from './wspolne.ts';
import type { ApnsFetch, ProviderTokens } from './wspolne.ts';

export const DEVICECHECK_ORIGINS: Readonly<Record<RelayAuthEnvironment, string>> = {
  development: 'https://api.development.devicecheck.apple.com',
  production: 'https://api.devicecheck.apple.com',
};

/** How many bytes of the DeviceCheck response we read (bits in JSON or a short error description). */
const DEVICECHECK_RESPONSE_MAX_BYTES = 1024;

/**
 * The 200 `query_two_bits` response for a device with no bits set: Apple production returns "Failed to find bit
 * state", the documentation gives "Bit State Not Found"; both mean "no bits set". Only the whole response (no
 * whitespace at the edges, case-insensitive): the phrase inside another response does not reset the device counter.
 */
const BITS_NOT_FOUND = new Set(['bit state not found', 'failed to find bit state']);
/** DeviceCheck 400 description that speaks about the device token (the app's proof), not about our request. */
const BAD_DEVICE_TOKEN_RE = /device token/i;
const MONTH_RE = /^[0-9]{4}-[0-9]{2}$/;

/**
 * Test silent push (like the push relay's `/v1/pass`): the app has no background mode, the system swallows it with no
 * effect.
 */
export const PROBE_PAYLOAD = '{"aps":{"content-available":1}}';
const PROBE_HEADERS: Readonly<Record<string, string>> = {
  'apns-push-type': 'background',
  'apns-priority': '5',
  'apns-topic': APP_TOPIC,
  // Deliver now or never: the proof is Apple's 200, not delivery.
  'apns-expiration': '0',
};

export interface AppleDeps {
  readonly fetch: ApnsFetch;
  /** Epoch ms (registry clock). */
  readonly now: () => number;
  readonly tokens: ProviderTokens;
  /** DeviceCheck transaction identifier (`crypto.randomUUID`). */
  readonly transactionId: () => string;
  readonly timeoutMs?: number;
}

type Reply = { readonly status: number; readonly text: string } | { readonly cause: 'timeout' | 'network' };

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

const failureOf = (status: number): AppleFailure =>
  (status === 429 || status >= 500 ? { kind: 'unreachable', status } : { kind: 'refused', status });

export function createAppleGate(deps: AppleDeps): AppleGate {
  const timeoutMs = deps.timeoutMs ?? APNS_TIMEOUT_MS;

  async function deviceCheck(environment: RelayAuthEnvironment, endpoint: string, fields: Record<string, unknown>):
    Promise<Reply> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await deps.fetch(`${DEVICECHECK_ORIGINS[environment]}/v1/${endpoint}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${deps.tokens.token(deps.now())}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...fields, transaction_id: deps.transactionId(), timestamp: deps.now() }),
        signal: controller.signal,
      });
      return { status: response.status, text: await readCapped(response, DEVICECHECK_RESPONSE_MAX_BYTES) };
    } catch {
      return { cause: timedOut ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** DeviceCheck response other than 200 → failure; `null` on 200. */
  function deviceCheckFailure(reply: Reply): AppleFailure | null {
    if ('cause' in reply) return { kind: 'unreachable', cause: reply.cause };
    if (reply.status === 200) return null;
    if (reply.status === 400 && BAD_DEVICE_TOKEN_RE.test(reply.text)) return { kind: 'rejected', status: 400 };
    return failureOf(reply.status);
  }

  return {
    async queryBits(environment, token): Promise<AppleResult<DeviceBits | null>> {
      const reply = await deviceCheck(environment, 'query_two_bits', { device_token: token });
      const failure = deviceCheckFailure(reply);
      if (failure !== null) return { ok: false, failure };
      const text = 'text' in reply ? reply.text : '';
      if (BITS_NOT_FOUND.has(text.trim().toLowerCase())) return { ok: true, value: null };
      try {
        const parsed = JSON.parse(text) as { bit0?: unknown; bit1?: unknown; last_update_time?: unknown };
        const { bit0, bit1, last_update_time: lastUpdate } = parsed;
        if (typeof bit0 === 'boolean' && typeof bit1 === 'boolean' && typeof lastUpdate === 'string'
          && MONTH_RE.test(lastUpdate)) {
          return { ok: true, value: { bit0, bit1, lastUpdate } };
        }
      } catch {
        // Below: a 200 response without bits is not a state we can count.
      }
      return { ok: false, failure: { kind: 'unreachable', status: 200 } };
    },

    async updateBits(environment, token, bit0, bit1): Promise<AppleResult<null>> {
      const failure = deviceCheckFailure(await deviceCheck(environment, 'update_two_bits',
        { device_token: token, bit0, bit1 }));
      return failure === null ? { ok: true, value: null } : { ok: false, failure };
    },

    async probe(environment, token): Promise<AppleResult<null>> {
      const outcome = await callApns(deps.fetch, {
        environment, token, jwt: deps.tokens.token(deps.now()), headers: PROBE_HEADERS, body: PROBE_PAYLOAD,
      }, timeoutMs);
      if (outcome.kind === 'unreachable') return { ok: false, failure: { kind: 'unreachable', cause: outcome.cause } };
      if (outcome.status === 200) return { ok: true, value: null };
      const reason = outcome.reason === undefined ? {} : { reason: outcome.reason };
      if (isTokenRejection(outcome)) return { ok: false, failure: { kind: 'rejected', status: outcome.status, ...reason } };
      return { ok: false, failure: { ...failureOf(outcome.status), ...reason } };
    },
  };
}
