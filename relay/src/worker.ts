/**
 * Cloudflare Workers adapter for the relay core: `env` → configuration, Rate Limiting bindings → limits,
 * `CF-Connecting-IP` (and behind a pseudo address `CF-Connecting-IPv6`) → client address, Worker console → writing
 * log lines (already past the `log.ts` allow-list). Address: with Pseudo IPv4 "Overwrite", `CF-Connecting-IP` carries
 * a class E pseudo address (240.0.0.0/4) computed from IPv6, and Cloudflare leaves the real address in
 * `CF-Connecting-IPv6`; with Pseudo IPv4 off (the default) IPv6 stands in `CF-Connecting-IP`. `CF-Connecting-IPv6`
 * counts ONLY behind a pseudo address: Cloudflare forwards client headers and does not promise to remove this one,
 * so otherwise the caller would pick its own rate-limit key. The core computes the rate-limit key from the address
 * (`client-key.ts`).
 *
 * The core (HMAC keys, APNs key scalar, window JWT) is built once per isolate and stays while the configuration is the
 * same. This is configuration state, not request state: nothing from a request stays between calls.
 */
import { createRelay } from './core.ts';
import type { Relay, RelayLimits } from './core.ts';
import { ENV_SECRETS, ENV_VARS } from './config.ts';

/**
 * Worker variables (`[vars]`), secrets and bindings; a test against `wrangler.toml` checks the names
 * (`config.test.ts`).
 */
export interface Env {
  readonly APNS_TEAM_ID: string;
  readonly APNS_ENVIRONMENTS: string;
  readonly ALERT_POLICY: string;
  readonly PASS_KID: string;
  readonly DEPLOY_SHA: string;
  /** Secrets: missing = 503 `environment-unavailable` and `ok: false` in `/v1/health`. */
  readonly APNS_KEY?: string;
  readonly APNS_KEY_ID?: string;
  readonly PASS_KEYS?: string;
  /** `/v1/pass` per address and issuing Live Activity passes per parent device (`la:<digest>`). */
  readonly RL_PASS: RateLimit;
  /** `/v1/push` per device (`a:<digest>` for a banner, `la:<parent digest>` for a Live Activity). */
  readonly RL_PUSH: RateLimit;
  /** `/v1/push` per client address. */
  readonly RL_PUSH_ADDR: RateLimit;
}

export const ENV_BINDINGS = ['RL_PASS', 'RL_PUSH', 'RL_PUSH_ADDR'] as const;

let cached: { readonly fingerprint: string; readonly relay: Relay } | undefined;

function relayFor(env: Env): Relay {
  const names = [...ENV_VARS, ...ENV_SECRETS];
  const fingerprint = names.map((name) => env[name] ?? '').join('\u0000');
  if (cached?.fingerprint !== fingerprint) {
    const settings = Object.fromEntries(names.map((name) => [name, env[name]]));
    cached = {
      fingerprint,
      relay: createRelay(settings, {
        fetch: (url, init) => fetch(url, init),
        now: () => Date.now(),
        log: (line) => { console.log(line); },
      }),
    };
  }
  return cached.relay;
}

const limitsOf = (env: Env): RelayLimits => ({
  pass: async (key) => (await env.RL_PASS.limit({ key })).success,
  push: async (key) => (await env.RL_PUSH.limit({ key })).success,
  pushAddr: async (key) => (await env.RL_PUSH_ADDR.limit({ key })).success,
});

/** Cloudflare's Pseudo IPv4: a class E address (240.0.0.0/4) that no client on the network has. */
const PSEUDO_IPV4_RE = /^2(?:4[0-9]|5[0-5])\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;

/**
 * Client address from Cloudflare: `CF-Connecting-IP`, and when that is a pseudo address, a non-empty
 * `CF-Connecting-IPv6`.
 */
function clientAddressOf(request: Request): string | null {
  const address = request.headers.get('cf-connecting-ip');
  const ipv6 = request.headers.get('cf-connecting-ipv6');
  return address !== null && PSEUDO_IPV4_RE.test(address) && ipv6 !== null && ipv6 !== '' ? ipv6 : address;
}

export default {
  // `ctx` unused: the relay has no work after the response (the log is synchronous).
  async fetch(request, env, _ctx: ExecutionContext): Promise<Response> {
    return relayFor(env).handle(request, {
      clientAddress: clientAddressOf(request),
      limits: limitsOf(env),
    });
  },
} satisfies ExportedHandler<Env>;
