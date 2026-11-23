/**
 * APNs provider token: JWT ES256, `kid` = Key ID, `iss` = Team ID, `iat`.
 *
 * DETERMINISTIC signature (RFC 6979, `@noble/curves`) with `iat` rounded down to a 40 min window: every Worker
 * isolate computes byte for byte the same token for a given window. Apple requires refreshing the token no more often
 * than every 20 min and no less often than every 60 (otherwise `429 TooManyProviderTokenUpdates` or
 * `403 ExpiredProviderToken`), and a Worker has many isolates at once: a random WebCrypto signature would give each
 * a different token and a change on every cold start. With a 40 min window the token changes every 40 min and is
 * never older than 40 min.
 *
 * Key: PKCS#8 PEM from the Apple portal → scalar via WebCrypto (`importKey('pkcs8')`, `exportKey('jwk')`, field `d`).
 * No `nodejs_compat`: WebCrypto exists in the Worker and in Node, and it also checks that this really is a P-256 key.
 * A WebCrypto signature alone is ruled out because it is random (above).
 */
import { p256 } from '@noble/curves/nist.js';
import { base64Decode, base64url, utf8 } from './bytes.ts';

/** The `iat` window: the token changes every 40 min (Apple: 20–60 min). */
export const JWT_WINDOW_SECONDS = 40 * 60;

const PEM_RE = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/;

/** P-256 private key scalar (32 B) from PKCS#8 PEM; `null` when it is not such a key. Never throws. */
export async function apnsKeyScalar(pem: string): Promise<Uint8Array | null> {
  const match = PEM_RE.exec(pem.trim());
  const der = match?.[1] === undefined ? null : base64Decode(match[1].replace(/\s+/g, ''));
  if (der === null) return null;
  try {
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', key) as JsonWebKey;
    const scalar = typeof jwk.d === 'string' ? base64Decode(jwk.d) : null;
    return scalar !== null && scalar.byteLength === 32 ? scalar : null;
  } catch {
    return null;
  }
}

/** `iat` of the window that contains the moment `nowMs`. */
export const jwtIat = (nowMs: number): number =>
  Math.floor(nowMs / 1000 / JWT_WINDOW_SECONDS) * JWT_WINDOW_SECONDS;

const segment = (value: unknown): string => base64url(utf8(JSON.stringify(value)));

/** JWT for a given `iat`: the same key, Key ID, Team ID and `iat` always give the same string. */
export function signProviderToken(scalar: Uint8Array, keyId: string, teamId: string, iat: number): string {
  const unsigned = `${segment({ alg: 'ES256', kid: keyId })}.${segment({ iss: teamId, iat })}`;
  // `prehash` (SHA-256 of the message) and the `r‖s` format are the `p256.sign` defaults: exactly what JWS wants.
  const signature = p256.sign(utf8(unsigned), scalar);
  return `${unsigned}.${base64url(signature)}`;
}

/** Token for the current window, computed once per window in the isolate. */
export class ProviderTokens {
  readonly #scalar: Uint8Array;
  readonly #keyId: string;
  readonly #teamId: string;
  #cached: { readonly iat: number; readonly token: string } | undefined;

  constructor(scalar: Uint8Array, keyId: string, teamId: string) {
    this.#scalar = scalar;
    this.#keyId = keyId;
    this.#teamId = teamId;
  }

  token(nowMs: number): string {
    const iat = jwtIat(nowMs);
    if (this.#cached?.iat !== iat) {
      this.#cached = { iat, token: signProviderToken(this.#scalar, this.#keyId, this.#teamId, iat) };
    }
    return this.#cached.token;
  }
}
