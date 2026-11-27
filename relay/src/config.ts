/**
 * Relay configuration from Worker variables and secrets. Any configuration defect
 * disables ALL environments (503 `environment-unavailable`, `/v1/health` with `ok: false`) and gives one log line
 * with the problem code: a name, never a value. A relay without a reliable key does not guess.
 */
import { ALERT_POLICIES } from './alert-policy.ts';
import type { AlertPolicyName } from './alert-policy.ts';
import { isApnsEnvironment } from './identity.ts';
import type { ApnsEnvironment } from './identity.ts';
import { ProviderTokens, apnsKeyScalar } from './jwt.ts';
import { KID_RE, importPassKeyring } from './pass.ts';
import type { PassKeyring } from './pass.ts';

/** Relay code version (`version` in `/v1/health`); equal to `version` in `relay/package.json` (test). */
export const RELAY_VERSION = '1.1.2-beta.1';

/** Non-secret variables (`[vars]` in `wrangler.toml`, in EACH environment separately: `vars` are not inherited). */
export const ENV_VARS = ['APNS_TEAM_ID', 'APNS_ENVIRONMENTS', 'ALERT_POLICY', 'PASS_KID', 'DEPLOY_SHA'] as const;
/** Secrets (`wrangler secret put`, values never in the repo). */
export const ENV_SECRETS = ['APNS_KEY', 'APNS_KEY_ID', 'PASS_KEYS'] as const;

export type RelayEnv = Readonly<Partial<Record<typeof ENV_VARS[number] | typeof ENV_SECRETS[number], string>>>;

/** Apple Team ID and Key ID: 10 characters, uppercase letters and digits. */
const APPLE_ID_RE = /^[A-Z0-9]{10}$/;
const DEPLOY_SHA_RE = /^[0-9A-Za-z.-]{1,40}$/;

export type Prepared =
  | {
    readonly usable: true;
    readonly version: string;
    readonly environments: readonly ApnsEnvironment[];
    readonly alertPolicy: AlertPolicyName;
    readonly ring: PassKeyring;
    readonly tokens: ProviderTokens;
  }
  | {
    readonly usable: false;
    readonly version: string;
    readonly alertPolicy: AlertPolicyName | null;
    /** Problem codes for the log (`apns-key-missing`…), without values. */
    readonly problems: readonly string[];
  };

const isAlertPolicy = (value: unknown): value is AlertPolicyName =>
  typeof value === 'string' && (ALERT_POLICIES as readonly string[]).includes(value);

/** `development,production` → list without repeats; `null` on an unknown environment. Empty list = nothing works. */
export function parseEnvironments(value: string): ApnsEnvironment[] | null {
  const items = value.split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (!items.every(isApnsEnvironment) || new Set(items).size !== items.length) return null;
  return items;
}

export async function prepare(env: RelayEnv): Promise<Prepared> {
  const sha = env.DEPLOY_SHA;
  const version = sha !== undefined && DEPLOY_SHA_RE.test(sha) ? `${RELAY_VERSION}+${sha}` : RELAY_VERSION;
  const problems: string[] = [];
  const alertPolicy = isAlertPolicy(env.ALERT_POLICY) ? env.ALERT_POLICY : null;
  if (alertPolicy === null) problems.push('alert-policy-invalid');
  const environments = parseEnvironments(env.APNS_ENVIRONMENTS ?? '');
  if (environments === null) problems.push('apns-environments-invalid');
  else if (environments.length === 0) problems.push('apns-environments-empty');
  if (!APPLE_ID_RE.test(env.APNS_TEAM_ID ?? '')) problems.push('apns-team-id-invalid');
  if (env.APNS_KEY_ID === undefined || env.APNS_KEY_ID === '') problems.push('apns-key-id-missing');
  else if (!APPLE_ID_RE.test(env.APNS_KEY_ID)) problems.push('apns-key-id-invalid');

  let scalar: Uint8Array | null = null;
  if (env.APNS_KEY === undefined || env.APNS_KEY === '') problems.push('apns-key-missing');
  else {
    scalar = await apnsKeyScalar(env.APNS_KEY);
    if (scalar === null) problems.push('apns-key-invalid');
  }

  let ring: PassKeyring | null = null;
  const kid = env.PASS_KID ?? '';
  if (!KID_RE.test(kid)) problems.push('pass-kid-invalid');
  if (env.PASS_KEYS === undefined || env.PASS_KEYS === '') problems.push('pass-keys-missing');
  else if (KID_RE.test(kid)) {
    ring = await importPassKeyring(env.PASS_KEYS, kid);
    if (ring === null) problems.push('pass-keys-invalid');
  }

  if (problems.length > 0 || alertPolicy === null || environments === null || scalar === null || ring === null) {
    return { usable: false, version, alertPolicy, problems };
  }
  return {
    usable: true,
    version,
    environments,
    alertPolicy,
    ring,
    tokens: new ProviderTokens(scalar, env.APNS_KEY_ID ?? '', env.APNS_TEAM_ID ?? ''),
  };
}
