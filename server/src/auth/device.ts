/**
 * Device key in a request: `Authorization: Rarog-Device <deviceId>.<secret>`. Any other scheme means no
 * device credential (`device-unknown`, 401).
 *
 * The same header carries REST, SSE and the terminal WebSocket upgrade: the app adds headers itself, so
 * no tickets or tokens in the URL. The module decides ONLY about the header; whether the request
 * takes the key path at all (`Authorization` header present = yes, absent = `missing`)
 * is decided by `authenticate` in `principal.ts`.
 *
 * Order of checks: header shape, store expiry sweep, record by `deviceId`, secret digest in constant
 * time. An unknown record and a bad secret give THE SAME result (`device-unknown`);
 * only someone who knows the secret of a revoked device gets `device-revoked` with a date (the tombstone keeps
 * its digest). A successful request moves `lastSeenAt` (at most once a minute, `devices-store.ts`).
 */
import { timingSafeEqual } from 'node:crypto';
import { DEVICE_ID_RE, PAIRING_CODE_RE } from '@rarog/shared/rest';
import type { DeviceRecord, DeviceStore, DeviceTombstone } from './devices-store.ts';
import { hashSecret } from './devices-store.ts';

/**
 * Scheme of the `Authorization` header (case-insensitive, RFC 9110, "Authentication Scheme"): the only one the parser
 * accepts and the one `redact.ts` masks in text.
 */
export const DEVICE_AUTH_SCHEME = 'Rarog-Device';
const ACCEPTED_SCHEME = DEVICE_AUTH_SCHEME.toLowerCase();

/** Credential from the header: identifier and secret (32 B base64url). */
export interface DeviceCredential {
  readonly id: string;
  readonly secret: string;
}

/**
 * `Authorization` → device credential or `null` (another scheme, bad shape, garbage).
 * Strict shapes from the contract, so nothing but `[0-9a-f]{32}` and base64url reaches the store.
 */
export function parseDeviceAuthorization(header: string | undefined): DeviceCredential | null {
  if (header === undefined) return null;
  const match = /^(\S+) +(\S+)$/.exec(header.trim());
  if (match === null) return null;
  const [, scheme = '', value = ''] = match;
  if (scheme.toLowerCase() !== ACCEPTED_SCHEME) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  if (!DEVICE_ID_RE.test(id) || !PAIRING_CODE_RE.test(secret)) return null;
  return { id, secret };
}

/** Header for a client (tests, CLI): `Rarog-Device <id>.<secret>`. */
export function deviceAuthorization(id: string, secret: string): string {
  return `${DEVICE_AUTH_SCHEME} ${id}.${secret}`;
}

export type DeviceCheck =
  | { readonly ok: true; readonly record: DeviceRecord }
  | { readonly ok: false; readonly reason: 'device-unknown' }
  | { readonly ok: false; readonly reason: 'device-revoked'; readonly tombstone: DeviceTombstone };

/** Constant-time comparison of hex digests of the same length. */
function sameHash(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Digest compared when there is no record: the same work as with a record, the result is always `false`. */
const NO_RECORD_HASH = '0'.repeat(64);

/**
 * Checks the header against the store. Does not throw. `nowMs` is injected in expiry tests.
 *
 * @param header raw `Authorization`; `undefined` gives `device-unknown` (the caller asks only when
 *   the header is present).
 */
export function checkDevice(store: DeviceStore, header: string | undefined, nowMs?: number): DeviceCheck {
  const credential = parseDeviceAuthorization(header);
  if (credential === null) return { ok: false, reason: 'device-unknown' };
  const hash = hashSecret(credential.secret);
  const record = store.get(credential.id, nowMs);
  if (record !== undefined) {
    if (!sameHash(hash, record.secretHash)) return { ok: false, reason: 'device-unknown' };
    store.touch(record.id, nowMs);
    return { ok: true, record: store.get(record.id, nowMs) ?? record };
  }
  const tombstone = store.tombstone(credential.id);
  if (!sameHash(hash, tombstone?.secretHash ?? NO_RECORD_HASH) || tombstone === undefined) {
    return { ok: false, reason: 'device-unknown' };
  }
  return { ok: false, reason: 'device-revoked', tombstone };
}
