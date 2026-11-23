/**
 * Cloudflare Workers adapter for the registry core (`core.ts`): `env` → configuration (Apple key once per isolate),
 * Durable Objects bindings → {@link Registry}, KV `DENIED` → denial list, Rate Limiting bindings → per-address limits,
 * `CF-Connecting-IP` (and behind a pseudo address `CF-Connecting-IPv6`) → client address, console → writing log lines
 * (already past the `log.ts` allow-list). Cron (`[triggers]` in `wrangler.toml`, every 6 h) calls `scheduled`, which
 * has no work.
 *
 * The client address follows the same recipe as the push relay (`relay/src/worker.ts`): `CF-Connecting-IPv6` counts
 * only behind a Pseudo IPv4 address (240.0.0.0/4), because Cloudflare forwards client headers.
 */
import { DENIED_CACHE_TTL_SECONDS, ENV_SECRETS, ENV_TEST_VARS, ENV_VARS, prepare } from './config.ts';
import type { Prepared, Settings } from './config.ts';
import { createRelayAuth } from './core.ts';
import type { AuthLimits, Registry } from './core.ts';
import { formatLogLine } from './log.ts';
import { ADMIN_NAME, GATE_NAME, stubOf } from './objects.ts';
import type { Admin, Endpoint, Gate } from './objects.ts';

// The main module exports ONLY the handler and the Durable Objects classes: `workerd` rejects at start any other
// value export (constant, list), so binding names and adapter constants live in `config.ts` (guard in
// `worker.test.ts`).
export { Admin, Endpoint, Gate } from './objects.ts';

/** Worker variables (`[vars]`), secrets and bindings; `test/config.test.ts` checks the names (lists in `config.ts`). */
export interface Env {
  readonly DEPLOY_SHA: string;
  readonly GATE_KIND: string;
  readonly ENFORCE: string;
  readonly APPLE_TEAM_ID: string;
  readonly REGISTER_MONTHLY_QUOTA: string;
  readonly REGISTER_DAILY_BRAKE: string;
  readonly SPONSOR_QUOTA: string;
  readonly SPONSORED_LIVE_MAX: string;
  readonly QUOTA_GRACE_UNTIL: string;
  readonly DIAG_UNTIL: string;
  /** Only outside production (measurement, tests on `workerd`): seconds added to the clock. */
  readonly CLOCK_OFFSET?: string;
  /** Only outside production (local `workerd`): `1` = registry objects without the EU jurisdiction. */
  readonly NO_JURISDICTION?: string;
  /**
   * Secrets: bearer of the `/v1/access` hook, bearer of the `/v1/admin/*` routes, the gate's Apple key (kind from
   * `GATE_KIND`).
   */
  readonly RELAY_HOOK_SECRET?: string;
  readonly ADMIN_SECRET?: string;
  readonly DEVICECHECK_KEY?: string;
  readonly DEVICECHECK_KEY_ID?: string;
  readonly APNS_KEY?: string;
  readonly APNS_KEY_ID?: string;
  /** EndpointId entry (`idFromName`). */
  readonly ENDPOINT: DurableObjectNamespace<Endpoint>;
  /** One object: serializes registrations through the gate. */
  readonly GATE: DurableObjectNamespace<Gate>;
  /** One object: the denial list. */
  readonly ADMIN: DurableObjectNamespace<Admin>;
  /** Denial list mirror. */
  readonly DENIED: KVNamespace;
  /** `/v1/app/*` per client address. */
  readonly RL_APP: RateLimit;
  /** `/v1/app/register` per client address. */
  readonly RL_REGISTER: RateLimit;
}

let cached: { readonly fingerprint: string; readonly prepared: Promise<Prepared> } | undefined;

/**
 * Configuration once per isolate (Apple key import) while the variables and secrets are the same; problems logged once.
 */
function preparedFor(env: Env): Promise<Prepared> {
  const names = [...ENV_VARS, ...ENV_TEST_VARS, ...ENV_SECRETS];
  const fingerprint = names.map((name) => env[name] ?? '').join('\u0000');
  if (cached?.fingerprint !== fingerprint) {
    const settings = Object.fromEntries(names.map((name) => [name, env[name]]));
    cached = {
      fingerprint,
      prepared: prepare(settings).then((prepared) => {
        for (const problem of [...prepared.settings.secretProblems, ...prepared.problems]) {
          console.log(formatLogLine({ event: 'config', problem }));
        }
        if (prepared.settings.clockOffset !== 0) console.log(formatLogLine({ event: 'config', problem: 'clock-offset' }));
        if (prepared.settings.jurisdiction === null) {
          console.log(formatLogLine({ event: 'config', problem: 'no-jurisdiction' }));
        }
        return prepared;
      }),
    };
  }
  return cached.prepared;
}

const registryOf = (env: Env, jurisdiction: Settings['jurisdiction']): Registry => ({
  endpoint: (endpointId) => stubOf(env.ENDPOINT, endpointId, jurisdiction),
  gate: () => stubOf(env.GATE, GATE_NAME, jurisdiction),
  admin: () => stubOf(env.ADMIN, ADMIN_NAME, jurisdiction),
});

const limitsOf = (env: Env): AuthLimits => ({
  app: async (key) => (await env.RL_APP.limit({ key })).success,
  register: async (key) => (await env.RL_REGISTER.limit({ key })).success,
});

/** Cloudflare's Pseudo IPv4: a class E address (240.0.0.0/4) that no client on the network has. */
const PSEUDO_IPV4_RE = /^2(?:4[0-9]|5[0-5])\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;

function clientAddressOf(request: Request): string | null {
  const address = request.headers.get('cf-connecting-ip');
  const ipv6 = request.headers.get('cf-connecting-ipv6');
  return address !== null && PSEUDO_IPV4_RE.test(address) && ipv6 !== null && ipv6 !== '' ? ipv6 : address;
}

export default {
  // `ctx` unused: the registry has no work after the response (the log is synchronous).
  async fetch(request, env, _ctx: ExecutionContext): Promise<Response> {
    const prepared = await preparedFor(env);
    const offsetMs = prepared.settings.clockOffset * 1000;
    const auth = createRelayAuth(prepared, {
      registry: registryOf(env, prepared.settings.jurisdiction),
      isDenied: async (endpointId) => (await env.DENIED.get(endpointId, { cacheTtl: DENIED_CACHE_TTL_SECONDS })) !== null,
      now: () => Date.now() + offsetMs,
      log: (line) => { console.log(line); },
    });
    return auth.handle(request, { clientAddress: clientAddressOf(request), limits: limitsOf(env) });
  },
  scheduled(_controller, _env, _ctx: ExecutionContext): void {
    // Canary cron: the registry has no work (Durable Objects alarms handle entry and denial deadlines).
  },
} satisfies ExportedHandler<Env>;
