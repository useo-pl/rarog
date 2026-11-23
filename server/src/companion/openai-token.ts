/**
 * Short-lived OpenAI Realtime key of the voice agent: the server's own key (`OPENAI_API_KEY`) is traded for a
 * key that lives 60 s (`POST /v1/realtime/client_secrets`), with the model from `RAROG_COMPANION_MODEL`. The phone
 * talks to OpenAI itself with the short-lived key; the server's key never leaves the server.
 *
 * What it does not do: retry (a loop on the phone would only burn the account's limit), follow a redirect (the key
 * would go to another host), log anything but the status and the expiry (never the key, the short-lived key or the
 * upstream body), or pass OpenAI's error text to the client (the sentences are Rarog's).
 */
import type { CompanionToken } from '@rarog/shared/rest';
import {
  COMPANION_DISABLED_ERROR, COMPANION_OPENAI_ERROR, COMPANION_OPENAI_KEY_ERROR, COMPANION_OPENAI_LIMIT_ERROR,
  COMPANION_THROTTLED_ERROR,
} from '@rarog/shared/rest';
import { type ServerSentence, say } from '@rarog/shared/sentences';
import type { RarogConfig } from '../config.ts';
import { VOICE_TOKEN_HOURLY_CAP, VOICE_TOKEN_MIN_INTERVAL_MS } from '../config.ts';

/** Endpoint pinned in code, never taken from the environment: the key goes to this host and no other. */
export const OPENAI_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

/**
 * Lifetime of a short-lived key, counted from the moment OpenAI makes it. OpenAI takes 10–7200 s (default 600); a
 * minute is enough to open the WebSocket and limits what a revoked device can still open.
 */
export const COMPANION_TOKEN_EXPIRES_IN_SECONDS = 60;

/** Timeout of one request. No retry: a longer wait is a frozen "start" button. */
export const COMPANION_TOKEN_TIMEOUT_MS = 5_000;

/** The part of `fetch` this module uses; tests inject it. `redirect: 'error'` makes a redirect a failure. */
export type CompanionTokenFetch = (
  input: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    redirect: 'error';
  },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/** Refusal codes of the route; the client sees the same strings. */
export type CompanionTokenRefusal =
  | typeof COMPANION_DISABLED_ERROR
  | typeof COMPANION_THROTTLED_ERROR
  | typeof COMPANION_OPENAI_KEY_ERROR
  | typeof COMPANION_OPENAI_LIMIT_ERROR
  | typeof COMPANION_OPENAI_ERROR;

/** Result in the shape the route needs: a key, a refusal with its status and sentence, or a cancelled request. */
export type CompanionTokenResult =
  | { readonly kind: 'token'; readonly token: CompanionToken }
  | {
    readonly kind: 'refused';
    readonly status: 429 | 502 | 503;
    readonly error: CompanionTokenRefusal;
    readonly sentence: ServerSentence;
  }
  | { readonly kind: 'cancelled' };

export interface CompanionTokenMinterOptions {
  readonly config: Pick<RarogConfig, 'companionEnabled' | 'companionModel' | 'openaiApiKey'>;
  readonly fetchImpl?: CompanionTokenFetch;
  readonly now?: () => number;
  readonly minIntervalMs?: number;
  readonly hourlyCap?: number;
  readonly timeoutMs?: number;
  /** Diagnostic log: the upstream status and the expiry only. */
  readonly log?: (line: string) => void;
}

export interface CompanionTokenMinter {
  /** One short-lived key; `signal` = the client went away (the request to OpenAI is cancelled). */
  mint(signal?: AbortSignal): Promise<CompanionTokenResult>;
  /** The flag is on and the server has a key. */
  readonly available: boolean;
}

const HOUR_MS = 3_600_000;

/** The client's signal fired; a function, so the check reads the signal after an `await` (not a narrowed value). */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** `value` and `expires_at` (seconds of the epoch) of the reply, or `null` for anything else. */
function readClientSecret(payload: unknown, nowMs: number): { value: string; expiresAt: string } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const value = record['value'];
  const expiresAt = record['expires_at'];
  if (typeof value !== 'string' || value === '') return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt * 1000 <= nowMs) return null;
  return { value, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

/**
 * Builds the minter. The throttle lives here and is shared by every device: it protects the OpenAI account, not the
 * route, and it counts attempts, not successes (a failing loop is the one that retries most).
 */
export function createCompanionTokenMinter(opts: CompanionTokenMinterOptions): CompanionTokenMinter {
  const apiKey = opts.config.openaiApiKey?.trim() ?? '';
  const enabled = opts.config.companionEnabled;
  const model = opts.config.companionModel;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as CompanionTokenFetch);
  const now = opts.now ?? ((): number => Date.now());
  const minIntervalMs = opts.minIntervalMs ?? VOICE_TOKEN_MIN_INTERVAL_MS;
  const hourlyCap = opts.hourlyCap ?? VOICE_TOKEN_HOURLY_CAP;
  const timeoutMs = opts.timeoutMs ?? COMPANION_TOKEN_TIMEOUT_MS;
  const log = opts.log;
  let attempts: number[] = [];

  function takeSlot(): boolean {
    const at = now();
    const last = attempts[attempts.length - 1];
    if (last !== undefined && at - last < minIntervalMs) return false;
    attempts = attempts.filter((ts) => at - ts < HOUR_MS);
    if (attempts.length >= hourlyCap) return false;
    attempts.push(at);
    return true;
  }

  const refused = (
    status: 429 | 502 | 503, error: CompanionTokenRefusal, sentence: ServerSentence,
  ): CompanionTokenResult => ({ kind: 'refused', status, error, sentence });
  const upstream = (): CompanionTokenResult => refused(502, COMPANION_OPENAI_ERROR, say('rest.companion-openai'));

  async function mint(signal?: AbortSignal): Promise<CompanionTokenResult> {
    if (!enabled) return refused(503, COMPANION_DISABLED_ERROR, say('rest.companion-disabled'));
    if (apiKey === '') return refused(503, COMPANION_DISABLED_ERROR, say('rest.companion-openai-key-missing'));
    if (signal?.aborted === true) return { kind: 'cancelled' };
    // The slot is taken BEFORE the network: the throttle guards the account also when every attempt fails.
    if (!takeSlot()) return refused(429, COMPANION_THROTTLED_ERROR, say('rest.companion-throttled'));

    const timeout = new AbortController();
    const timer = setTimeout(() => { timeout.abort(); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const combined = signal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, signal]);
    try {
      const response = await doFetch(OPENAI_CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: COMPANION_TOKEN_EXPIRES_IN_SECONDS },
          session: { type: 'realtime', model },
        }),
        signal: combined,
        redirect: 'error',
      });
      // 401/403 is the server's configuration, not an OpenAI outage: 503 with a sentence that says what to fix.
      if (response.status === 401 || response.status === 403) {
        log?.(`companion: OpenAI refused the key (${String(response.status)})`);
        return refused(503, COMPANION_OPENAI_KEY_ERROR, say('rest.companion-openai-key'));
      }
      if (response.status === 429) {
        log?.('companion: OpenAI rate limit (429)');
        return refused(429, COMPANION_OPENAI_LIMIT_ERROR, say('rest.companion-openai-limit'));
      }
      if (response.status < 200 || response.status >= 300) {
        log?.(`companion: OpenAI request failed (${String(response.status)})`);
        return upstream();
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (isAborted(signal)) return { kind: 'cancelled' };
        log?.('companion: OpenAI reply is not JSON');
        return upstream();
      }
      const secret = readClientSecret(payload, now());
      if (secret === null) {
        // No reply content in the log: this is the body that carries the short-lived key.
        log?.('companion: OpenAI reply without a valid short-lived key');
        return upstream();
      }
      log?.(`companion: short-lived key valid until ${secret.expiresAt}`);
      return { kind: 'token', token: { value: secret.value, expiresAt: secret.expiresAt, model } };
    } catch {
      // The error text stays out of the log: some `fetch` implementations quote the request headers.
      if (isAborted(signal)) return { kind: 'cancelled' };
      log?.(timeout.signal.aborted
        ? 'companion: OpenAI timeout'
        : 'companion: OpenAI unreachable (network, redirect or TLS)');
      return upstream();
    } finally {
      clearTimeout(timer);
    }
  }

  return { mint, available: enabled && apiKey !== '' };
}
