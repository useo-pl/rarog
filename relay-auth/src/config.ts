/**
 * Registry configuration from Worker variables and secrets. Non-secret variables stand in `[vars]` of `wrangler.toml`,
 * the owner sets the secrets. A configuration defect disables the app routes (503 `unavailable`, `ok: false` in
 * `/v1/health`) and gives a log line with the problem code (a name, never a value). The `/v1/access` hook and the
 * admin routes keep working: they need only their own secret.
 */
import { RELAY_AUTH_GATES } from '../../shared/src/relay-auth.ts';
import type { RelayAuthGate } from '../../shared/src/relay-auth.ts';
import { ProviderTokens, apnsKeyScalar } from './wspolne.ts';

/** Worker code version (`version` in `/v1/health`); equal to `version` in `relay-auth/package.json` (test). */
export const RELAY_AUTH_VERSION = '1.1.0-beta.1';

/**
 * Non-secret variables (`[vars]` in `wrangler.toml`):
 * - `DEPLOY_SHA`: version suffix in `/v1/health`;
 * - `GATE_KIND`: the registry entry gate, `devicecheck` or `apns`; any other value = no gate;
 * - `ENFORCE`: `1` enforces denials in `/v1/access`, any other value = shadow mode;
 * - `APPLE_TEAM_ID`: Apple team of the app publisher (`iss` of the DeviceCheck and APNs provider token);
 * - `REGISTER_MONTHLY_QUOTA`: registrations of new app EndpointIds per device per month (1–3: two DeviceCheck bits);
 * - `REGISTER_DAILY_BRAKE`: registrations through the gate per UTC day, separately per gate;
 * - `SPONSOR_QUOTA`: new sponsorships of one app in 30 days;
 * - `SPONSORED_LIVE_MAX`: live sponsorships of one app at once;
 * - `QUOTA_GRACE_UNTIL`: epoch seconds; until then exhausted DeviceCheck bits do not block registration (after losing
 *   the registry the bits stay at Apple); empty = no grace period;
 * - `DIAG_UNTIL`: epoch seconds; until then the `/v1/access` decision line carries the full EndpointId also when
 *   enforcing; empty = only in shadow mode.
 */
export const ENV_VARS = [
  'DEPLOY_SHA', 'GATE_KIND', 'ENFORCE', 'APPLE_TEAM_ID', 'REGISTER_MONTHLY_QUOTA', 'REGISTER_DAILY_BRAKE',
  'SPONSOR_QUOTA', 'SPONSORED_LIVE_MAX', 'QUOTA_GRACE_UNTIL', 'DIAG_UNTIL',
] as const;

/**
 * Variables only outside production (measurements on `workerd`, tests): `CLOCK_OFFSET` = seconds added to the Worker
 * and Durable Objects clock; `NO_JURISDICTION=1` = registry objects without a jurisdiction, because local `workerd`
 * does not know it ("Jurisdiction restrictions are not implemented in workerd", wrangler 4.151.1). The guard
 * `test/config.test.ts` checks that they are not in `wrangler.toml`.
 */
export const ENV_TEST_VARS = ['CLOCK_OFFSET', 'NO_JURISDICTION'] as const;

/**
 * Jurisdiction of the registry objects: they run and keep data only in the EU (Durable Objects docs, "Data location").
 */
export const JURISDICTION = 'eu' as const;

/** Secrets (`wrangler secret put`, values never in the repo). */
export const ENV_SECRETS = [
  'RELAY_HOOK_SECRET', 'ADMIN_SECRET', 'DEVICECHECK_KEY', 'DEVICECHECK_KEY_ID', 'APNS_KEY', 'APNS_KEY_ID',
] as const;

/** Worker bindings (`Env` in `worker.ts`, binding sections in `wrangler.toml`). */
export const ENV_BINDINGS = ['ENDPOINT', 'GATE', 'ADMIN', 'DENIED', 'RL_APP', 'RL_REGISTER'] as const;

/** Denials from KV: a value from the Cloudflare location cache for up to 60 s (read `cacheTtl` in `worker.ts`). */
export const DENIED_CACHE_TTL_SECONDS = 60;

export type RelayAuthEnv = Readonly<Partial<Record<
  typeof ENV_VARS[number] | typeof ENV_TEST_VARS[number] | typeof ENV_SECRETS[number], string
>>>;

/** Quota and brake values when the variable is absent (the `wrangler.toml` file sets them explicitly). */
export const DEFAULT_QUOTAS = {
  registerMonthly: 3,
  registerDailyBrake: 200,
  sponsor: 3,
  sponsoredLive: 5,
} as const;

export interface Quotas {
  readonly registerMonthly: number;
  readonly registerDailyBrake: number;
  readonly sponsor: number;
  readonly sponsoredLive: number;
}

export interface Settings {
  readonly version: string;
  readonly gate: RelayAuthGate | null;
  readonly enforce: boolean;
  readonly quotas: Quotas;
  /** Epoch seconds or `null`. */
  readonly graceUntil: number | null;
  readonly diagUntil: number | null;
  /** Seconds added to the clock (only outside production). */
  readonly clockOffset: number;
  /** {@link JURISDICTION}; `null` only outside production (`NO_JURISDICTION=1`). */
  readonly jurisdiction: typeof JURISDICTION | null;
  readonly hookSecret: string | null;
  readonly adminSecret: string | null;
  /** Codes of hook and admin secret defects (names only); they go to the log and do not touch the app routes. */
  readonly secretProblems: readonly string[];
  /** Configuration problem codes of the app routes (without values). */
  readonly problems: readonly string[];
}

/** The gate's Apple key, ready to sign provider tokens. */
export interface AppleCredentials {
  readonly gate: RelayAuthGate;
  readonly tokens: ProviderTokens;
}

export interface Prepared {
  readonly settings: Settings;
  /** `null`: gate not chosen or its key does not work. */
  readonly apple: AppleCredentials | null;
  /** Problems of the gate settings and key. */
  readonly problems: readonly string[];
  /** The Worker accepts registrations: gate chosen, key works, configuration without problems. */
  readonly registrations: boolean;
}

const DEPLOY_SHA_RE = /^[0-9A-Za-z.-]{1,40}$/;
/** Apple Team ID and Key ID: 10 characters, uppercase letters and digits. */
const APPLE_ID_RE = /^[A-Z0-9]{10}$/;
const UINT_RE = /^[0-9]{1,10}$/;
const INT_RE = /^-?[0-9]{1,10}$/;

const isGate = (value: unknown): value is RelayAuthGate =>
  typeof value === 'string' && (RELAY_AUTH_GATES as readonly string[]).includes(value);

/** A number within range or a problem; missing variable = default value. */
function bounded(value: string | undefined, fallback: number, min: number, max: number, problem: string,
  problems: string[]): number {
  if (value === undefined) return fallback;
  const parsed = UINT_RE.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= min && parsed <= max)) {
    problems.push(problem);
    return fallback;
  }
  return parsed;
}

/** Epoch seconds or `null` (missing or empty); a bad value = problem. */
function epoch(value: string | undefined, problem: string, problems: string[]): number | null {
  if (value === undefined || value === '') return null;
  if (!UINT_RE.test(value)) {
    problems.push(problem);
    return null;
  }
  return Number(value);
}

/** Shortest accepted bearer secret: 128 bits as hex (`openssl rand -hex 16`); the runbook generates 64 characters. */
export const SECRET_MIN_CHARS = 32;

/**
 * A secret shorter than {@link SECRET_MIN_CHARS} counts as missing: its routes answer 503 and the problem goes to
 * `secretProblems`, not `problems`, because the app routes do not use these secrets and must keep working.
 */
function secret(value: string | undefined, problem: string, secretProblems: string[]): string | null {
  if (value === undefined || value === '') return null;
  if (value.length < SECRET_MIN_CHARS) {
    secretProblems.push(problem);
    return null;
  }
  return value;
}

/** Worker variables → settings. A bad or empty gate and `ENFORCE` other than `1` give a safe state. */
export function settingsOf(env: RelayAuthEnv): Settings {
  const problems: string[] = [];
  const secretProblems: string[] = [];
  const sha = env.DEPLOY_SHA;
  const quotas: Quotas = {
    registerMonthly: bounded(env.REGISTER_MONTHLY_QUOTA, DEFAULT_QUOTAS.registerMonthly, 1, 3,
      'register-monthly-quota-invalid', problems),
    registerDailyBrake: bounded(env.REGISTER_DAILY_BRAKE, DEFAULT_QUOTAS.registerDailyBrake, 1, 1_000_000,
      'register-daily-brake-invalid', problems),
    sponsor: bounded(env.SPONSOR_QUOTA, DEFAULT_QUOTAS.sponsor, 1, 1000, 'sponsor-quota-invalid', problems),
    sponsoredLive: bounded(env.SPONSORED_LIVE_MAX, DEFAULT_QUOTAS.sponsoredLive, 1, 32, 'sponsored-live-max-invalid',
      problems),
  };
  const graceUntil = epoch(env.QUOTA_GRACE_UNTIL, 'quota-grace-until-invalid', problems);
  const diagUntil = epoch(env.DIAG_UNTIL, 'diag-until-invalid', problems);
  const offset = env.CLOCK_OFFSET;
  let clockOffset = 0;
  if (offset !== undefined && offset !== '') {
    if (INT_RE.test(offset)) clockOffset = Number(offset);
    else problems.push('clock-offset-invalid');
  }
  return {
    version: sha !== undefined && DEPLOY_SHA_RE.test(sha) ? `${RELAY_AUTH_VERSION}+${sha}` : RELAY_AUTH_VERSION,
    gate: isGate(env.GATE_KIND) ? env.GATE_KIND : null,
    enforce: env.ENFORCE === '1',
    quotas,
    graceUntil,
    diagUntil,
    clockOffset,
    jurisdiction: env.NO_JURISDICTION === '1' ? null : JURISDICTION,
    hookSecret: secret(env.RELAY_HOOK_SECRET, 'relay-hook-secret-short', secretProblems),
    adminSecret: secret(env.ADMIN_SECRET, 'admin-secret-short', secretProblems),
    secretProblems,
    problems,
  };
}

/** Secrets of the gate key: PEM and Key ID. */
const GATE_KEYS: Readonly<Record<RelayAuthGate, { readonly key: 'DEVICECHECK_KEY' | 'APNS_KEY';
  readonly keyId: 'DEVICECHECK_KEY_ID' | 'APNS_KEY_ID' }>> = {
  devicecheck: { key: 'DEVICECHECK_KEY', keyId: 'DEVICECHECK_KEY_ID' },
  apns: { key: 'APNS_KEY', keyId: 'APNS_KEY_ID' },
};

/**
 * Settings and the Apple key of the chosen gate (P-256 PKCS#8 PEM from the Apple portal, the same format for
 * DeviceCheck and APNs). Never throws; no gate is not a problem, only `registrations: false`.
 */
export async function prepare(env: RelayAuthEnv): Promise<Prepared> {
  const settings = settingsOf(env);
  const problems = [...settings.problems];
  let apple: AppleCredentials | null = null;
  if (settings.gate !== null) {
    const names = GATE_KEYS[settings.gate];
    const teamId = env.APPLE_TEAM_ID ?? '';
    const keyId = env[names.keyId] ?? '';
    const pem = env[names.key] ?? '';
    if (!APPLE_ID_RE.test(teamId)) problems.push('apple-team-id-invalid');
    if (keyId === '') problems.push('gate-key-id-missing');
    else if (!APPLE_ID_RE.test(keyId)) problems.push('gate-key-id-invalid');
    let scalar: Uint8Array | null = null;
    if (pem === '') problems.push('gate-key-missing');
    else {
      scalar = await apnsKeyScalar(pem);
      if (scalar === null) problems.push('gate-key-invalid');
    }
    if (scalar !== null && APPLE_ID_RE.test(teamId) && APPLE_ID_RE.test(keyId)) {
      apple = { gate: settings.gate, tokens: new ProviderTokens(scalar, keyId, teamId) };
    }
  }
  return { settings, apple, problems, registrations: settings.gate !== null && apple !== null && problems.length === 0 };
}
