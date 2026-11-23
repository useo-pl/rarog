/**
 * Push relay core: the routes `/v1/pass`, `/v1/push`, `/v1/health` as `Request` → `Response`.
 *
 * No Workers globals: `fetch` to APNs, the clock, the logger and the rate-limit counters are injected,
 * configuration comes in as strings. `worker.ts` is a thin adapter.
 *
 * The contract (statuses, codes, bodies, units) is described in `relay/README.md`, and examples of every route and
 * every code stand in `shared/fixtures/relay/` (tests compare the code against them). Every response is JSON with `v:
 * 1`.
 *
 * The order of checks is part of the protection:
 * - POST routes: `Content-Type: application/json` and `X-Rarog-Relay-Client` BEFORE reading the body: a simple
 *   POST from a browser (no preflight) has neither, and an `OPTIONS` preflight gets 405 without CORS;
 * - body cap (8 KiB) BEFORE parsing;
 * - `/v1/pass`: per-address limit before anything expensive (every `alert` attempt is a subrequest to Apple); the
 *   address key comes from `client-key.ts` (IPv6 cut to /64); a counter failure = refusal (429), not a pass;
 * - `/v1/pass` for a Live Activity: after checking `devicePass`, a second counter `RL_PASS` per parent device, so
 *   one device pass does not issue Live Activity passes without end;
 * - `/v1/push`: the pass BEFORE the limits, otherwise someone without a pass could exhaust another token's limit with
 *   garbage and drown its pushes. Two counters: `RL_PUSH` per device (banner `a:<digest>`, Live Activity
 *   `la:<parent digest>`) and `RL_PUSH_ADDR` per client address; a counter failure lets through (pass already checked);
 * - tokens lowercased before the digest, the pass, the limit and the APNs address.
 */
import { callApns, isTokenRejection } from './apns.ts';
import type { ApnsFetch } from './apns.ts';
import { clientBucket, parentKey, pushKey } from './client-key.ts';
import { RELAY_VERSION, prepare } from './config.ts';
import type { Prepared, RelayEnv } from './config.ts';
import { isAllowedTopic, isApnsEnvironment, isPushType } from './identity.ts';
import type { ApnsEnvironment } from './identity.ts';
import { formatLogLine } from './log.ts';
import type { Route } from './log.ts';
import {
  PASS_MAX_CHARS, PASS_TTL_SECONDS, activityPassExp, checkPass, expiresAtOf, issuePass, needsRenewal, tokenHashOf,
} from './pass.ts';
import { checkHeaders, checkPayload } from './policy.ts';

/** Cap on the HTTP request body (bytes), checked before parsing. */
export const BODY_MAX_BYTES = 8 * 1024;
/** APNs token (device or activity) as hex: the same pattern as `APNS_TOKEN_RE` in `shared/src/rest.ts`. */
export const TOKEN_RE = /^[0-9a-fA-F]{32,512}$/;
/** How many headers and how long values `/v1/push` accepts before the allow-list deals with them. */
const HEADERS_MAX = 16;
const HEADER_VALUE_MAX_CHARS = 256;
/**
 * Length cap of `X-Rarog-Relay-Client` on POST routes. No version pattern: the log passes only the
 * `name/version` shape anyway (`log.ts`), and the server allows more characters in the version than the log pattern.
 */
export const CLIENT_HEADER_MAX_CHARS = 128;
/** Client version header on POST routes (lowercase, as in `Headers.get`). */
export const CLIENT_HEADER = 'x-rarog-relay-client';

/** Client version from the {@link CLIENT_HEADER} header; another header is not the client version (missing = 400). */
export function clientHeaderOf(request: Request): string | null {
  return request.headers.get(CLIENT_HEADER);
}

/** Error codes per route (contract; fixtures cover each one). */
export const PASS_ERRORS = [
  'bad-request', 'topic-not-allowed', 'pass-invalid', 'token-rejected', 'relay-limited', 'apns-error',
  'apns-unreachable', 'environment-unavailable',
] as const;
export const PUSH_ERRORS = [
  'bad-request', 'payload-rejected', 'pass-invalid', 'relay-limited', 'apns-unreachable', 'environment-unavailable',
] as const;
/** Outside the routes: unknown path and wrong method. `internal` should not happen (exception in the core). */
export const ROUTING_ERRORS = ['not-found', 'method-not-allowed', 'internal'] as const;

export type ErrorCode = typeof PASS_ERRORS[number] | typeof PUSH_ERRORS[number] | typeof ROUTING_ERRORS[number];

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  'bad-request': 400,
  'topic-not-allowed': 400,
  'payload-rejected': 400,
  'pass-invalid': 401,
  'not-found': 404,
  'method-not-allowed': 405,
  'token-rejected': 422,
  'relay-limited': 429,
  internal: 500,
  'apns-error': 502,
  'apns-unreachable': 502,
  'environment-unavailable': 503,
};

/**
 * Test silent push on `/v1/pass` of type `alert`: the app has no background mode, the system swallows it with no
 * effect.
 */
export const PROBE_PAYLOAD = '{"aps":{"content-available":1}}';
const probeHeaders = (topic: string): Record<string, string> => ({
  'apns-push-type': 'background',
  'apns-priority': '5',
  'apns-topic': topic,
  // Deliver now or never: the proof is Apple's 200, not delivery, so nothing waits in the APNs queue.
  'apns-expiration': '0',
});

/** What to issue: a device pass, or a Live Activity pass with a parent (digest and expiry of the device pass). */
type PassKind =
  | { readonly type: 'alert' }
  | { readonly type: 'liveactivity'; readonly parentHash: string; readonly parentExp: number };

export interface RelayLimits {
  /**
   * `RL_PASS`: `/v1/pass` per address (key from `clientBucket`) and, for a Live Activity, per parent device
   * (`parentKey`); `false` = exceeded.
   */
  pass(key: string): Promise<boolean>;
  /** `RL_PUSH`: `/v1/push` per device (key from `pushKey`); `false` = exceeded. */
  push(key: string): Promise<boolean>;
  /** `RL_PUSH_ADDR`: `/v1/push` per client address (key from `clientBucket`); `false` = exceeded. */
  pushAddr(key: string): Promise<boolean>;
}

export interface RelayDeps {
  readonly fetch: ApnsFetch;
  /** Epoch ms. */
  readonly now: () => number;
  /** Writes a finished log line (already past the allow-list). */
  readonly log: (line: string) => void;
  /** Cap on the APNs response; 10 s by default. */
  readonly apnsTimeoutMs?: number;
}

export interface RequestContext {
  /**
   * Client address from the platform, as it came (`worker.ts`: `CF-Connecting-IP`, behind a pseudo address
   * `CF-Connecting-IPv6`); `null` when it gave none. `clientBucket` computes the rate-limit key from it.
   */
  readonly clientAddress: string | null;
  readonly limits: RelayLimits;
}

export interface Relay {
  handle(request: Request, context: RequestContext): Promise<Response>;
}

interface Reply {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
}

type Json = Record<string, unknown>;
type LogBag = Record<string, unknown>;

const ok = (body: Json): Reply => ({ status: 200, body });
const fail = (code: ErrorCode, extra: Json = {}, headers?: Record<string, string>): Reply =>
  ({ status: ERROR_STATUS[code], body: { error: code, ...extra }, ...(headers === undefined ? {} : { headers }) });

const ROUTES: Readonly<Record<string, { readonly route: Route; readonly method: string }>> = {
  '/v1/pass': { route: 'pass', method: 'POST' },
  '/v1/push': { route: 'push', method: 'POST' },
  '/v1/health': { route: 'health', method: 'GET' },
};

/**
 * Body up to {@link BODY_MAX_BYTES} as UTF-8; `null` when larger (declared or actual: the stream is read
 * with a cap, without trusting `Content-Length`) or not valid UTF-8.
 */
async function readBodyCapped(request: Request): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]{1,10}$/.test(declared) || Number(declared) > BODY_MAX_BYTES)) {
    await request.body?.cancel();
    return null;
  }
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all);
  } catch {
    return null;
  }
}

/** A JSON object with `v: 1`; `null` for anything else. Unknown fields stay (compatibility with a newer server). */
function parseV1(raw: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return (parsed as Json)['v'] === 1 ? parsed as Json : null;
  } catch {
    return null;
  }
}

const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN_RE.test(value);

/**
 * Headers required on POST routes: media type `application/json` (parameters and case do not
 * matter) and a non-empty `X-Rarog-Relay-Client` ({@link clientHeaderOf}) of up to {@link CLIENT_HEADER_MAX_CHARS}
 * characters. A simple POST from a browser can carry only `text/plain`, a form or `multipart`, and no custom
 * header.
 */
function postHeadersOk(request: Request): boolean {
  const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const client = clientHeaderOf(request);
  return mediaType === 'application/json' && client !== null && client !== ''
    && client.length <= CLIENT_HEADER_MAX_CHARS;
}

function headersOf(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Json);
  if (entries.length > HEADERS_MAX) return null;
  const out: Record<string, string> = {};
  for (const [name, item] of entries) {
    if (typeof item !== 'string' || item.length > HEADER_VALUE_MAX_CHARS) return null;
    out[name] = item;
  }
  return out;
}

export function createRelay(env: RelayEnv, deps: RelayDeps): Relay {
  let prepared: Promise<Prepared> | undefined;

  /** Configuration computed once per isolate; problems go to the log once, by name. */
  const ready = (): Promise<Prepared> => {
    prepared ??= prepare(env)
      // `prepare` does not throw by design; if it does anyway, the relay is disabled, not a promise rejected forever.
      .catch((): Prepared => ({ usable: false, version: RELAY_VERSION, alertPolicy: null, problems: ['config-error'] }))
      .then((result) => {
        if (!result.usable) for (const problem of result.problems) deps.log(formatLogLine({ event: 'config', problem }));
        return result;
      });
    return prepared;
  };

  const nowSec = (): number => Math.floor(deps.now() / 1000);

  /**
   * The Rate Limiting counter failed (binding exception): a `limit-error` line, and the result depends on the route.
   * `/v1/pass` refuses (429 `relay-limited`): every `alert` attempt is a subrequest to Apple with the USEO key, and
   * after 429 the server waits 60 s in the queue (after 503 it would mute the whole route for 15 min together with
   * the sends). `/v1/push` lets through: the pass is already checked, and a refusal would lose owners' pushes at
   * every counter failure.
   */
  const within = async (route: Route, check: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await check();
    } catch {
      deps.log(formatLogLine({ event: 'limit-error', route }));
      return route === 'push';
    }
  };

  /**
   * New pass: device (`alert`, `v1`, 90 days) or Live Activity (`liveactivity`, `v2` with the parent digest;
   * expiry at most the parent's expiry). `token` in lowercase.
   */
  async function issue(
    config: Prepared & { usable: true }, environment: ApnsEnvironment, token: string, kind: PassKind,
  ): Promise<{ pass: string; expiresAt: string }> {
    const exp = kind.type === 'alert' ? nowSec() + PASS_TTL_SECONDS : activityPassExp(nowSec(), kind.parentExp);
    const tokenHash = await tokenHashOf(token);
    const pass = await issuePass(config.ring, kind.type === 'alert'
      ? { environment, type: 'alert', tokenHash, exp }
      : { environment, type: 'liveactivity', tokenHash, parentHash: kind.parentHash, exp });
    return { pass, expiresAt: expiresAtOf(exp) };
  }

  async function passRoute(request: Request, context: RequestContext, log: LogBag): Promise<Reply> {
    const raw = await readBodyCapped(request);
    if (raw === null) return fail('bad-request');
    if (!(await within('pass', () => context.limits.pass(clientBucket(context.clientAddress))))) {
      return fail('relay-limited');
    }
    const body = parseV1(raw);
    if (body === null) return fail('bad-request');
    const { token, environment, type, topic, devicePass } = body;
    if (!isToken(token) || !isApnsEnvironment(environment) || !isPushType(type) || typeof topic !== 'string') {
      return fail('bad-request');
    }
    // `devicePass` belongs ONLY to an activity pass.
    if (type === 'alert' ? devicePass !== undefined
      : typeof devicePass !== 'string' || devicePass.length > PASS_MAX_CHARS) return fail('bad-request');
    log['env'] = environment;
    log['type'] = type;
    if (!isAllowedTopic(topic)) return fail('topic-not-allowed');
    const config = await ready();
    if (!config.usable || !config.environments.includes(environment)) return fail('environment-unavailable');
    const lower = token.toLowerCase();

    if (type === 'liveactivity') {
      const device = await checkPass(config.ring, String(devicePass), { environment, type: 'alert' }, nowSec());
      if (device === null) return fail('pass-invalid');
      log['kid'] = device.kid;
      // Live Activity passes per parent device: a legitimate server orders one once per activity, after `401` and at
      // start.
      if (!(await within('pass', () => context.limits.pass(parentKey(device.tokenHash))))) return fail('relay-limited');
      return ok(await issue(config, environment, lower,
        { type: 'liveactivity', parentHash: device.tokenHash, parentExp: device.exp }));
    }

    const outcome = await callApns(deps.fetch, {
      environment, token: lower, jwt: config.tokens.token(deps.now()), headers: probeHeaders(topic), body: PROBE_PAYLOAD,
    }, deps.apnsTimeoutMs);
    if (outcome.kind === 'unreachable') {
      log['cause'] = outcome.cause;
      return fail('apns-unreachable');
    }
    log['apns_status'] = outcome.status;
    log['reason'] = outcome.reason;
    if (outcome.status === 200) return ok(await issue(config, environment, lower, { type: 'alert' }));
    const reason = outcome.reason ?? 'unknown';
    if (isTokenRejection(outcome)) {
      return fail('token-rejected', {
        apnsStatus: outcome.status, reason, ...(outcome.timestamp === undefined ? {} : { timestamp: outcome.timestamp }),
      });
    }
    // No Apple fields: an anonymous caller does not learn the key state; status and reason are in the log line.
    return fail('apns-error');
  }

  async function pushRoute(request: Request, context: RequestContext, log: LogBag): Promise<Reply> {
    const raw = await readBodyCapped(request);
    if (raw === null) return fail('bad-request');
    const body = parseV1(raw);
    if (body === null) return fail('bad-request');
    const { pass, token, environment, payload } = body;
    const headers = headersOf(body['headers']);
    if (typeof pass !== 'string' || pass.length > PASS_MAX_CHARS || !isToken(token) || !isApnsEnvironment(environment)
      || headers === null || typeof payload !== 'string') return fail('bad-request');
    log['env'] = environment;
    const config = await ready();
    if (!config.usable) return fail('environment-unavailable');
    const lower = token.toLowerCase();
    const tokenHash = await tokenHashOf(lower);
    const claims = await checkPass(config.ring, pass, { environment, tokenHash }, nowSec());
    if (claims === null) return fail('pass-invalid');
    log['type'] = claims.type;
    log['kid'] = claims.kid;
    if (!(await within('push', () => context.limits.push(pushKey(claims))))) return fail('relay-limited');
    if (!(await within('push', () => context.limits.pushAddr(clientBucket(context.clientAddress))))) {
      return fail('relay-limited');
    }
    if (!config.environments.includes(environment)) return fail('environment-unavailable');
    const rule = checkHeaders(headers, claims.type) ?? checkPayload(payload, claims.type);
    if (rule !== null) {
      log['rule'] = rule;
      return fail('payload-rejected', { rule });
    }

    const outcome = await callApns(deps.fetch, {
      environment, token: lower, jwt: config.tokens.token(deps.now()), headers, body: payload,
    }, deps.apnsTimeoutMs);
    if (outcome.kind === 'unreachable') {
      log['cause'] = outcome.cause;
      return fail('apns-unreachable');
    }
    log['apns_status'] = outcome.status;
    log['reason'] = outcome.reason;
    // Renewal only after 200: like the test push at issue, it proves the token is alive. Only the device pass:
    // a Live Activity push does not know the parent's expiry, so the server's sweep renews it after the device pass.
    const renew = outcome.status === 200 && claims.type === 'alert' && needsRenewal(config.ring, claims, nowSec());
    log['renewed'] = renew;
    return ok({
      apnsStatus: outcome.status,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.timestamp === undefined ? {} : { timestamp: outcome.timestamp }),
      ...(renew ? { renewedPass: await issue(config, environment, lower, { type: 'alert' }) } : {}),
    });
  }

  async function healthRoute(): Promise<Reply> {
    const config = await ready();
    const environments = config.usable ? config.environments : [];
    return ok({
      ok: environments.length > 0,
      version: config.version,
      environments,
      alertPolicy: config.alertPolicy,
    });
  }

  async function dispatch(request: Request, context: RequestContext, log: LogBag): Promise<Reply> {
    const target = ROUTES[new URL(request.url).pathname];
    if (target === undefined) return fail('not-found');
    if (request.method !== target.method) return fail('method-not-allowed', {}, { allow: target.method });
    if (target.method === 'POST' && !postHeadersOk(request)) return fail('bad-request');
    switch (target.route) {
      case 'pass': return passRoute(request, context, log);
      case 'push': return pushRoute(request, context, log);
      default: return healthRoute();
    }
  }

  return {
    async handle(request, context): Promise<Response> {
      const started = deps.now();
      const route = ROUTES[new URL(request.url).pathname]?.route ?? 'unknown';
      const log: LogBag = { event: 'request', route, client: clientHeaderOf(request) };
      let reply: Reply;
      try {
        reply = await dispatch(request, context, log);
      } catch {
        // The core does not throw by design; if it does anyway, no exception text (it could carry request data).
        reply = fail('internal');
      }
      log['status'] = reply.status;
      log['code'] = reply.body['error'];
      log['ms'] = deps.now() - started;
      deps.log(formatLogLine(log));
      return new Response(JSON.stringify({ v: 1, ...reply.body }), {
        status: reply.status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...reply.headers },
      });
    },
  };
}
