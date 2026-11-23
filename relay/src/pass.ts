/**
 * Relay pass: stateless proof that the relay has checked the token.
 *
 *     v1.<kid>.<environment>.alert.<token digest>.<exp>.<HMAC>                         (device, 7 fields)
 *     v2.<kid>.<environment>.liveactivity.<token digest>.<parent digest>.<exp>.<HMAC>  (Live Activity, 8 fields)
 *
 * - the version tells the shape: `v1` only of type `alert`, `v2` only of type `liveactivity`;
 *   `v1` of type `liveactivity` is garbage, so `/v1/push` returns 401 and the server orders a new Live Activity pass;
 * - `kid`: which key from `PASS_KEYS` signed; rotation = a new `kid` next to the old one (two valid at once);
 * - environment `development` | `production`: the pass works only in it;
 * - token digest = the first 16 hex characters of `sha256` of the token written in LOWERCASE hex (device or
 *   activity token; the caller lowercases it before computing anything);
 * - parent digest (`v2` only) = the DEVICE token digest from the `alert` pass the Live Activity pass was issued for:
 *   Live Activity limits count per parent, so many activity tokens of one device do not multiply the budget;
 * - `exp`: epoch seconds, 90 days from issue; a Live Activity pass at most until the parent's `exp` ({@link
 *   activityPassExp});
 * - HMAC-SHA256 with the `kid` key over the text before the last dot, base64url without padding.
 *
 * Verification: `crypto.subtle.verify` (constant-time comparison), then expiry, environment, type and token digest
 * at the caller ({@link checkPass}). The pass does not bind the topic: the allow-list has one app topic
 * (`identity.ts`).
 */
import { base64Decode, base64url, sha256Hex, utf8 } from './bytes.ts';
import { isApnsEnvironment } from './identity.ts';
import type { ApnsEnvironment, PushType } from './identity.ts';

/** Format version of the device pass (`alert`, 7 fields). */
export const PASS_VERSION_ALERT = 'v1';
/** Format version of the Live Activity pass (`liveactivity`, 8 fields with the parent digest). */
export const PASS_VERSION_ACTIVITY = 'v2';
/** Pass validity from issue. */
export const PASS_TTL_SECONDS = 90 * 24 * 60 * 60;
/**
 * Expiry of a Live Activity pass: 90 days from issue, but no longer than the parent device pass, so the Live Activity
 * pass does not outlive its parent. Another expiry variant changes this function and the renewal condition in
 * `/v1/push` (`core.ts`).
 */
export const activityPassExp = (nowSec: number, parentExp: number): number =>
  Math.min(nowSec + PASS_TTL_SECONDS, parentExp);
/** When less than this remains until `exp`, `/v1/push` returns `renewedPass` (device pass only). */
export const PASS_RENEW_WITHIN_SECONDS = 7 * 24 * 60 * 60;
/** Length cap of a pass from the network, checked before parsing. */
export const PASS_MAX_CHARS = 256;
/** How many hex characters of the token's `sha256` the pass carries (64 bits: a binding, not a secret). */
export const TOKEN_HASH_CHARS = 16;
/** Shortest HMAC key in `PASS_KEYS` (after base64 decoding). */
export const PASS_KEY_MIN_BYTES = 32;
/** Key identifier: no dot, because the dot separates pass fields. */
export const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** How many keys `PASS_KEYS` holds at once (the current one and old ones from the overlap period). */
export const PASS_KEYS_MAX = 8;

const TOKEN_HASH_RE = new RegExp(`^[0-9a-f]{${String(TOKEN_HASH_CHARS)}}$`);
const EXP_RE = /^[1-9][0-9]{0,11}$/;
const MAC_RE = /^[A-Za-z0-9_-]{43}$/;

interface ClaimsBase {
  readonly kid: string;
  readonly environment: ApnsEnvironment;
  readonly tokenHash: string;
  /** Epoch seconds. */
  readonly exp: number;
}

/** Device pass (`v1`). */
export interface AlertPassClaims extends ClaimsBase {
  readonly type: 'alert';
}

/** Live Activity pass (`v2`): digest of the parent device token. */
export interface ActivityPassClaims extends ClaimsBase {
  readonly type: 'liveactivity';
  readonly parentHash: string;
}

export type PassClaims = AlertPassClaims | ActivityPassClaims;

/** Fields of a new pass (no `kid`: the current one signs). */
export type NewPass = Omit<AlertPassClaims, 'kid'> | Omit<ActivityPassClaims, 'kid'>;

export interface PassKeyring {
  /** The `kid` the relay signs NEW passes with (`PASS_KID`). */
  readonly currentKid: string;
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

/** Token digest for the pass and the rate-limit key. The token MUST already be lowercase. */
export async function tokenHashOf(token: string): Promise<string> {
  return (await sha256Hex(token)).slice(0, TOKEN_HASH_CHARS);
}

/**
 * `PASS_KEYS` (JSON `{kid: base64 key ≥ 32 B}`) and `PASS_KID` → HMAC keys. `null` on ANY configuration
 * defect: a relay without reliable keys neither issues nor accepts anything (503).
 */
export async function importPassKeyring(passKeysJson: string, currentKid: string): Promise<PassKeyring | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(passKeysJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > PASS_KEYS_MAX) return null;
  const keys = new Map<string, CryptoKey>();
  for (const [kid, value] of entries) {
    if (!KID_RE.test(kid) || typeof value !== 'string') return null;
    const raw = base64Decode(value);
    if (raw === null || raw.byteLength < PASS_KEY_MIN_BYTES) return null;
    keys.set(kid, await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
  if (!keys.has(currentKid)) return null;
  return { currentKid, keys };
}

/** Signed text: all fields before the HMAC, in the shape of the type's version. */
const signedPart = (claims: PassClaims): string => (claims.type === 'alert'
  ? [PASS_VERSION_ALERT, claims.kid, claims.environment, claims.type, claims.tokenHash, String(claims.exp)]
  : [PASS_VERSION_ACTIVITY, claims.kid, claims.environment, claims.type, claims.tokenHash, claims.parentHash,
    String(claims.exp)]
).join('.');

/** New pass signed with the current `kid`. */
export async function issuePass(ring: PassKeyring, claims: NewPass): Promise<string> {
  const key = ring.keys.get(ring.currentKid);
  if (key === undefined) throw new Error('current kid has no key');
  const full: PassClaims = { ...claims, kid: ring.currentKid };
  const head = signedPart(full);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(head)));
  return `${head}.${base64url(mac)}`;
}

/**
 * Pass fields from a string, without the signature; `null` when the shape does not match the version: `v1` = 7 fields
 * of type `alert`, `v2` = 8 fields of type `liveactivity`. Any other layout (including `v1` of type `liveactivity`) is
 * garbage.
 */
function shapeOf(parts: readonly string[]): { readonly claims: PassClaims; readonly mac: string } | null {
  const [version, kid = '', environment = '', type, tokenHash = ''] = parts;
  if (!KID_RE.test(kid) || !isApnsEnvironment(environment) || !TOKEN_HASH_RE.test(tokenHash)) return null;
  if (version === PASS_VERSION_ALERT && parts.length === 7 && type === 'alert') {
    const [, , , , , exp = '', mac = ''] = parts;
    if (!EXP_RE.test(exp) || !MAC_RE.test(mac)) return null;
    return { claims: { kid, environment, type, tokenHash, exp: Number(exp) }, mac };
  }
  if (version === PASS_VERSION_ACTIVITY && parts.length === 8 && type === 'liveactivity') {
    const [, , , , , parentHash = '', exp = '', mac = ''] = parts;
    if (!TOKEN_HASH_RE.test(parentHash) || !EXP_RE.test(exp) || !MAC_RE.test(mac)) return null;
    return { claims: { kid, environment, type, tokenHash, parentHash, exp: Number(exp) }, mac };
  }
  return null;
}

/** Shape and signature; `null` for anything that is not a pass of this relay. Does not check expiry. */
export async function readPass(ring: PassKeyring, pass: string): Promise<PassClaims | null> {
  if (pass.length > PASS_MAX_CHARS) return null;
  const shape = shapeOf(pass.split('.'));
  if (shape === null) return null;
  const { claims, mac } = shape;
  const key = ring.keys.get(claims.kid);
  const signature = base64Decode(mac);
  // One pass = one string: the last base64url character carries 2 padding bits that must not change.
  if (key === undefined || signature === null || base64url(signature) !== mac) return null;
  const valid = await crypto.subtle.verify('HMAC', key, signature, utf8(signedPart(claims)));
  return valid ? claims : null;
}

export interface PassExpectation {
  readonly environment: ApnsEnvironment;
  readonly type?: PushType;
  readonly tokenHash?: string;
}

/** Pass valid NOW (`exp` > now) and matching the caller's expectation; otherwise `null`. */
export async function checkPass(
  ring: PassKeyring, pass: string, expected: PassExpectation, nowSec: number,
): Promise<PassClaims | null> {
  const claims = await readPass(ring, pass);
  if (claims === null || claims.exp <= nowSec || claims.environment !== expected.environment) return null;
  if (expected.type !== undefined && claims.type !== expected.type) return null;
  if (expected.tokenHash !== undefined && claims.tokenHash !== expected.tokenHash) return null;
  return claims;
}

/** Whether a device pass gets a fresh one in `/v1/push`: an old `kid` or less than 7 days until `exp`. */
export function needsRenewal(ring: PassKeyring, claims: PassClaims, nowSec: number): boolean {
  return claims.kid !== ring.currentKid || claims.exp - nowSec < PASS_RENEW_WITHIN_SECONDS;
}

/** `exp` (epoch seconds) → `expiresAt` in the response (ISO 8601 UTC). */
export const expiresAtOf = (exp: number): string => new Date(exp * 1000).toISOString();
