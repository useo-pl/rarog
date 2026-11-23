/** Bytes, base64 and digests on WebCrypto, without `node:*` (Worker without `nodejs_compat`). */

const encoder = new TextEncoder();

/** A copy on its own `ArrayBuffer`: what `crypto.subtle` wants in the Workers types. */
export const utf8 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(encoder.encode(text));

/** Text length in UTF-8 bytes (the APNs payload and HTTP body caps count bytes, not characters). */
export const utf8Length = (text: string): number => encoder.encode(text).byteLength;

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Standard base64 (`openssl rand -base64`) or URL-safe, with or without padding. `null` for anything
 * else: the value comes from a secret or from the network, so this never throws.
 */
export function base64Decode(text: string): Uint8Array<ArrayBuffer> | null {
  const compact = text.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/_-]*$/.test(compact) || compact.length % 4 === 1) return null;
  const standard = compact.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text))));
}
