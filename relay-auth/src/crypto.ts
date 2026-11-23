/**
 * Registry cryptography on WebCrypto (Worker without `nodejs_compat`, tests in Node): Ed25519 signature of app
 * requests and constant-time bearer comparison.
 */
import { relayAuthSigningBytes } from '../../shared/src/relay-auth.ts';
import type { RelayAuthAppRequests, RelayAuthAppRoute } from '../../shared/src/relay-auth.ts';
import { utf8 } from './wspolne.ts';

const HEX_RE = /^(?:[0-9a-f]{2})*$/;

/** Lowercase hex → bytes; `null` for any other string. */
export function fromHex(text: string): Uint8Array<ArrayBuffer> | null {
  if (!HEX_RE.test(text)) return null;
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * App request signature: Ed25519 with the `endpointId` public key over the bytes of a fixed-layout text
 * (`relayAuthSigningBytes`). A bad key or signature is `false`, never an exception.
 */
export async function verifyAppSignature<R extends RelayAuthAppRoute>(route: R, request: RelayAuthAppRequests[R]):
  Promise<boolean> {
  const key = fromHex(request.endpointId);
  const sig = fromHex(request.sig);
  if (key === null || key.byteLength !== 32 || sig === null || sig.byteLength !== 64) return false;
  try {
    const publicKey = await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']);
    const message = Uint8Array.from(relayAuthSigningBytes(route, request));
    return await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, sig, message);
  } catch {
    return false;
  }
}

/** Bearer from the `Authorization: Bearer <value>` header; `null` for any other shape. */
export function bearerOf(request: Request): string | null {
  const match = /^Bearer ([!-~]{1,512})$/i.exec(request.headers.get('authorization') ?? '');
  return match?.[1] ?? null;
}

/** Secret equality without a timing leak: SHA-256 digests (fixed length) compared byte by byte with no early exit. */
export async function secretEquals(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', utf8(given)), crypto.subtle.digest('SHA-256', utf8(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
