/**
 * Core of the iroh relay registry Worker without Workers globals: the contract routes `/v1/*`
 * (`shared/src/relay-auth.ts`, imported by relative path) as `Request` → `Response`. The store (Durable Objects behind
 * {@link Registry}), the denial mirror (KV), the rate-limit counters, the clock and the logger are injected;
 * `worker.ts` is a thin adapter.
 *
 * The order of checks is part of the protection (a flood within the zone's WAF rule costs only Worker calls,
 * not Durable Objects):
 * - JSON routes (`/v1/app/*`, `/v1/admin/*`): `Content-Type: application/json` and `X-Rarog-Relay-Client` BEFORE
 *   reading the body; body cap 16 KiB before parsing;
 * - `/v1/app/*`: per-address limit (`RL_APP`, `register` also `RL_REGISTER`) before parsing and signature; then
 *   shape, `issuedAt` ±5 min, Ed25519 signature, denial list, and only then Durable Objects;
 * - `/v1/admin/*`: admin bearer before the body;
 * - `/v1/access` (iroh relay access hook, no body and no client header): hook bearer, then EndpointId from the header.
 *   The response is `200` with body `true` or `403` with body `false`; in shadow mode (`ENFORCE` other than `1`)
 *   always `true`, and the log line carries the decision the Worker would have made, with the full EndpointId. Any
 *   other response (401, 400, 500, 503) is not a decision: the adapter on the VPS then lets the client in (fail-open).
 *   No cache in the Worker: the adapter keeps a negative cache (15 s), and denials come from KV with `cacheTtl` 60 s.
 */
import {
  RELAY_AUTH_ACCESS_ALLOW, RELAY_AUTH_ACCESS_DENY, RELAY_AUTH_CLIENT_HEADER, RELAY_AUTH_CLOCK_SKEW_SECONDS,
  RELAY_AUTH_ENDPOINT_HEADER, RELAY_AUTH_ERROR_STATUS, RELAY_AUTH_METHODS, RELAY_AUTH_PATHS,
  RELAY_AUTH_PROTOCOL_VERSION, isRelayAuthEndpointId, parseRelayAuthRequest,
} from '../../shared/src/relay-auth.ts';
import type {
  RelayAuthAdminRoute, RelayAuthAppRequests, RelayAuthAppRoute, RelayAuthErrorCode, RelayAuthHealthResponse,
  RelayAuthRoute,
} from '../../shared/src/relay-auth.ts';
import type { Prepared } from './config.ts';
import { bearerOf, secretEquals, verifyAppSignature } from './crypto.ts';
import { formatLogLine } from './log.ts';
import type { AdminApi, EndpointApi, ForgetOutcome, GateApi } from './registry.ts';
import { clientBucket } from './wspolne.ts';

/**
 * Cap on the HTTP request body (bytes), checked before parsing. Fits the longest valid contract request:
 * a proof token of up to 8192 characters (`RELAY_AUTH_PROOF_TOKEN_MAX_CHARS`) with the other `register` fields.
 */
export const BODY_MAX_BYTES = 16 * 1024;
/** Length cap of `X-Rarog-Relay-Client`. */
export const CLIENT_HEADER_MAX_CHARS = 128;

/** Registry Durable Objects: an entry per EndpointId, one gate, one denial list. */
export interface Registry {
  endpoint(endpointId: string): EndpointApi;
  gate(): GateApi;
  admin(): AdminApi;
}

/** Rate Limiting counters per client address (key from `clientBucket`); `false` = exceeded. */
export interface AuthLimits {
  /** `RL_APP`: every `/v1/app/*` route. */
  app(key: string): Promise<boolean>;
  /** `RL_REGISTER`: `/v1/app/register`. */
  register(key: string): Promise<boolean>;
}

export interface AuthDeps {
  readonly registry: Registry;
  /** Admin denial from the KV mirror (`cacheTtl` 60 s). */
  readonly isDenied: (endpointId: string) => Promise<boolean>;
  /** Epoch ms by the registry clock (with `CLOCK_OFFSET` outside production). */
  readonly now: () => number;
  /** Writes a finished log line (already past the allow-list). */
  readonly log: (line: string) => void;
}

export interface RequestContext {
  /** Client address from the platform (`worker.ts`) or `null`. */
  readonly clientAddress: string | null;
  readonly limits: AuthLimits;
}

export interface RelayAuth {
  handle(request: Request, context: RequestContext): Promise<Response>;
}

interface Reply {
  readonly status: number;
  /** Object = JSON with `v: 1`; string = the hook's text body. */
  readonly body: Readonly<Record<string, unknown>> | string;
  readonly headers?: Readonly<Record<string, string>>;
}

type LogBag = Record<string, unknown>;

const ok = (body: Readonly<Record<string, unknown>>): Reply => ({ status: 200, body });
const fail = (error: RelayAuthErrorCode, extra: Readonly<Record<string, unknown>> = {},
  headers?: Readonly<Record<string, string>>): Reply =>
  ({ status: RELAY_AUTH_ERROR_STATUS[error], body: { error, ...extra }, ...(headers === undefined ? {} : { headers }) });
const decision = (allow: boolean): Reply =>
  (allow ? { status: 200, body: RELAY_AUTH_ACCESS_ALLOW } : { status: 403, body: RELAY_AUTH_ACCESS_DENY });

const ROUTE_OF_PATH: ReadonlyMap<string, RelayAuthRoute> = new Map(
  (Object.entries(RELAY_AUTH_PATHS) as [RelayAuthRoute, string][]).map(([route, path]) => [path, route]),
);

/**
 * Body up to {@link BODY_MAX_BYTES} as UTF-8; `null` when larger (declared or actual: the stream is read
 * with a cap, without trusting `Content-Length`) or not valid UTF-8. The same recipe as in the push relay.
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

/**
 * Headers of JSON routes: media type `application/json` (parameters and case do not matter) and a non-empty
 * `X-Rarog-Relay-Client` of up to {@link CLIENT_HEADER_MAX_CHARS} characters. A simple POST from a browser has neither.
 */
function jsonHeadersOk(request: Request): boolean {
  const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const client = request.headers.get(RELAY_AUTH_CLIENT_HEADER);
  return mediaType === 'application/json' && client !== null && client !== ''
    && client.length <= CLIENT_HEADER_MAX_CHARS;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Body of the admin routes `{v: 1, endpointId}`; unknown fields ignored. */
function parseAdminBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { v, endpointId } = body as Readonly<Record<string, unknown>>;
  return v === RELAY_AUTH_PROTOCOL_VERSION && isRelayAuthEndpointId(endpointId) ? endpointId : null;
}

function toResponse(reply: Reply): Response {
  const base = { 'cache-control': 'no-store', ...reply.headers };
  if (typeof reply.body === 'string') {
    return new Response(reply.body, { status: reply.status, headers: { 'content-type': 'text/plain; charset=utf-8', ...base } });
  }
  return new Response(JSON.stringify({ v: RELAY_AUTH_PROTOCOL_VERSION, ...reply.body }), {
    status: reply.status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...base },
  });
}

export function health(prepared: Prepared): RelayAuthHealthResponse {
  const { settings } = prepared;
  return {
    v: RELAY_AUTH_PROTOCOL_VERSION, ok: prepared.registrations, version: settings.version, gate: settings.gate,
    enforce: settings.enforce,
  };
}

export function createRelayAuth(prepared: Prepared, deps: AuthDeps): RelayAuth {
  const { settings } = prepared;
  const { registry } = deps;
  const nowSec = (): number => Math.floor(deps.now() / 1000);

  /**
   * The Rate Limiting counter failed (binding exception): a `limit-error` line. `register` refuses (every attempt is
   * an Apple call), the other app routes let through (the signature and the Durable Object stand after it anyway).
   */
  const within = async (route: RelayAuthAppRoute, check: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await check();
    } catch {
      deps.log(formatLogLine({ event: 'limit-error', route }));
      return route !== 'register';
    }
  };

  async function register(request: RelayAuthAppRequests['register'], log: LogBag): Promise<Reply> {
    if (!prepared.registrations || settings.gate === null) return fail('unavailable');
    if (request.proof.kind !== settings.gate) return fail('gate-mismatch', { gate: settings.gate });
    log['gate'] = settings.gate;
    const outcome = await registry.gate().register(request.endpointId, request.proof);
    if (outcome.ok) {
      log['fresh'] = outcome.fresh;
      return ok({ endpointId: request.endpointId, expiresAt: outcome.expiresAt });
    }
    if (outcome.apple !== undefined) {
      log['apple_status'] = outcome.apple.status;
      log['reason'] = outcome.apple.reason;
      log['cause'] = outcome.apple.cause;
    }
    return outcome.error === 'gate-mismatch' ? fail('gate-mismatch', { gate: settings.gate }) : fail(outcome.error);
  }

  /**
   * Renewal at the app, then at the servers (also repairs a server entry that disappeared). A server write that arrived
   * after `forget` or after a new registration of this app is undone at once: `orphans` says which sponsorships the
   * incarnation no longer holds, and the drop applies only to the sponsorship with that identifier.
   */
  async function renew(request: RelayAuthAppRequests['renew']): Promise<Reply> {
    const { endpointId: appId } = request;
    const app = registry.endpoint(appId);
    const outcome = await app.renew(request.servers);
    if (!outcome.ok) return fail(outcome.error);
    const { epoch } = outcome;
    await Promise.all(outcome.renewed.map((item) =>
      registry.endpoint(item.server).addSponsor(appId, epoch, item.ticket, item.expiresAt)));
    if (outcome.renewed.length > 0) {
      const orphans = await app.orphans(epoch, outcome.renewed.map(({ server, ticket }) => ({ server, ticket })));
      await Promise.all(orphans.map((item) => registry.endpoint(item.server).dropSponsor(appId, epoch, item.ticket)));
    }
    return ok({ expiresAt: outcome.expiresAt, unsponsored: outcome.unsponsored });
  }

  /**
   * Sponsorship in three steps: quota reservation at the app (idempotency key `(app, server)`, 10 min term,
   * sponsorship identifier), write at the server, commit at the app in the same incarnation and for the same
   * sponsorship. A retry after a failure at any point hits the same reservation or live sponsorship and does not cost
   * a second quota unit; a reservation nobody committed removes the server write after it expires (the app entry's
   * alarm).
   */
  async function sponsor(request: RelayAuthAppRequests['sponsor'], log: LogBag): Promise<Reply> {
    const { endpointId: appId, server } = request;
    if (await deps.isDenied(server)) return fail('denied');
    const app = registry.endpoint(appId);
    const reserved = await app.reserve(server, {
      windowMax: settings.quotas.sponsor, liveMax: settings.quotas.sponsoredLive,
    });
    if (!reserved.ok) return fail(reserved.error);
    log['fresh'] = reserved.fresh;
    const { epoch, ticket } = reserved;
    const added = await registry.endpoint(server).addSponsor(appId, epoch, ticket, reserved.expiresAt);
    if (!added.ok) {
      await app.cancel(server, epoch, ticket);
      return fail(added.error);
    }
    const committed = await app.commit(server, epoch, ticket, reserved.expiresAt);
    if (!committed.ok) {
      // The incarnation or reservation disappeared meanwhile (`forget` next to it, expiry): the sponsorship does not
      // stay without it.
      await registry.endpoint(server).dropSponsor(appId, epoch, ticket);
      return fail(committed.error);
    }
    return ok({ server, expiresAt: committed.expiresAt });
  }

  /**
   * Deleting at the app leaves a durable record of sponsorship drops; the core performs them at once. A server
   * failure = 500, and a retry gets the same record and finishes the drops (without a retry the app entry's alarm
   * does).
   */
  async function forget(request: RelayAuthAppRequests['forget']): Promise<Reply> {
    const outcome = await forgetApp(request.endpointId);
    return outcome.ok ? ok({ forgotten: true }) : fail(outcome.error);
  }

  /** Removes an app entry and drops its sponsorships at the servers; a server entry gives `kind-conflict`. */
  async function forgetApp(endpointId: string): Promise<ForgetOutcome> {
    const outcome = await registry.endpoint(endpointId).forget();
    if (outcome.ok) {
      await Promise.all(outcome.drops.map((drop) =>
        registry.endpoint(drop.server).dropSponsor(drop.app, drop.epoch, drop.ticket)));
    }
    return outcome;
  }

  async function appRoute(route: RelayAuthAppRoute, request: Request, context: RequestContext, log: LogBag):
    Promise<Reply> {
    if (!jsonHeadersOk(request)) return fail('bad-request');
    const raw = await readBodyCapped(request);
    if (raw === null) return fail('bad-request');
    const bucket = clientBucket(context.clientAddress);
    if (!(await within(route, () => context.limits.app(bucket)))) return fail('limited');
    if (route === 'register' && !(await within(route, () => context.limits.register(bucket)))) return fail('limited');
    const parsed = parseRelayAuthRequest(route, parseJson(raw));
    if (!parsed.ok) {
      log['field'] = parsed.field;
      return fail('bad-request');
    }
    if (settings.problems.length > 0) return fail('unavailable');
    const signed = parsed.request;
    if (Math.abs(signed.issuedAt - nowSec()) > RELAY_AUTH_CLOCK_SKEW_SECONDS) return fail('clock-skew');
    if (!(await verifyAppSignature(route, signed))) return fail('bad-signature');
    if (await deps.isDenied(signed.endpointId)) return fail('denied');
    switch (route) {
      case 'register': return register(signed as RelayAuthAppRequests['register'], log);
      case 'renew': return renew(signed as RelayAuthAppRequests['renew']);
      case 'sponsor': return sponsor(signed as RelayAuthAppRequests['sponsor'], log);
      case 'forget': return forget(signed as RelayAuthAppRequests['forget']);
    }
  }

  async function adminRoute(route: RelayAuthAdminRoute, request: Request): Promise<Reply> {
    if (!jsonHeadersOk(request)) return fail('bad-request');
    if (settings.adminSecret === null) return fail('unavailable');
    const given = bearerOf(request);
    if (given === null || !(await secretEquals(given, settings.adminSecret))) return fail('unauthorized');
    const raw = await readBodyCapped(request);
    const endpointId = raw === null ? null : parseAdminBody(parseJson(raw));
    if (endpointId === null) return fail('bad-request');
    const admin = registry.admin();
    if (route === 'allow') return ok({ endpointId, denied: (await admin.allow(endpointId)).denied });
    const result = await admin.deny(endpointId);
    // A denied app also loses its entry and the servers it sponsored; a denied server keeps its entry (`kind-conflict`)
    // and the denial alone blocks it. A failure here is a 500 after the denial is stored; a repeated deny finishes.
    await forgetApp(endpointId);
    return ok({ endpointId, denied: result.denied });
  }

  async function accessRoute(request: Request, log: LogBag): Promise<Reply> {
    if (settings.hookSecret === null) return fail('unavailable');
    const given = bearerOf(request);
    if (given === null || !(await secretEquals(given, settings.hookSecret))) return fail('unauthorized');
    const endpointId = request.headers.get(RELAY_AUTH_ENDPOINT_HEADER);
    if (!isRelayAuthEndpointId(endpointId)) return fail('bad-request');
    let verdict: 'allow' | 'deny' | 'error';
    try {
      const [denied, status] = await Promise.all([deps.isDenied(endpointId), registry.endpoint(endpointId).status()]);
      // A server needs one sponsor without a denial: a sponsorship that a denied app recreated while its denial was
      // reaching KV (a register or sponsor in flight, a stale read) lives at most 90 days, the denial a year.
      const sponsored = status?.sponsors === undefined
        || (await Promise.all(status.sponsors.map((app) => deps.isDenied(app)))).includes(false);
      verdict = !denied && status !== null && sponsored ? 'allow' : 'deny';
    } catch {
      verdict = 'error';
    }
    log['decision'] = verdict;
    log['enforce'] = settings.enforce;
    if (!settings.enforce || (settings.diagUntil !== null && nowSec() < settings.diagUntil)) log['endpoint'] = endpointId;
    if (!settings.enforce) return decision(true);
    // A store error while enforcing is not a decision: 500, and the adapter lets in (fail-open).
    return verdict === 'error' ? fail('internal') : decision(verdict === 'allow');
  }

  async function dispatch(route: RelayAuthRoute | undefined, request: Request, context: RequestContext, log: LogBag):
    Promise<Reply> {
    if (route === undefined) return fail('not-found');
    const method = RELAY_AUTH_METHODS[route];
    if (request.method !== method) return fail('method-not-allowed', {}, { allow: method });
    switch (route) {
      case 'health': return ok({ ...health(prepared) });
      case 'access': return accessRoute(request, log);
      case 'deny':
      case 'allow': return adminRoute(route, request);
      default: return appRoute(route, request, context, log);
    }
  }

  return {
    async handle(request, context): Promise<Response> {
      const started = deps.now();
      const route = ROUTE_OF_PATH.get(new URL(request.url).pathname);
      const log: LogBag = { event: 'request', route: route ?? 'unknown', client: request.headers.get(RELAY_AUTH_CLIENT_HEADER) };
      let reply: Reply;
      try {
        reply = await dispatch(route, request, context, log);
      } catch {
        // No exception text (it could carry request data).
        reply = fail('internal');
      }
      log['status'] = reply.status;
      if (typeof reply.body !== 'string') log['code'] = reply.body['error'];
      log['ms'] = deps.now() - started;
      deps.log(formatLogLine(log));
      return toResponse(reply);
    },
  };
}
