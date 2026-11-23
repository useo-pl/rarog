/**
 * Token dostawcy APNs: ES256 deterministyczny, `iat` w oknie 40 min, podpis weryfikowalny kluczem
 * publicznym, PEM PKCS#8 → skalar bez `nodejs_compat`.
 */
import { describe, expect, it } from 'vitest';
import { JWT_WINDOW_SECONDS, ProviderTokens, apnsKeyScalar, jwtIat, signProviderToken } from '../src/jwt.ts';
import { NOW_MS, generateApnsKey, testKey } from './helpers.ts';

const decode = (segment: string): unknown =>
  JSON.parse(atob(segment.replace(/-/g, '+').replace(/_/g, '/')));

/** PEM z dowolnym wnętrzem; nagłówek i stopka w osobnych napisach, bo skaner sekretów bierze sklejony blok za klucz. */
const pemOf = (body: string): string => ['-----BEGIN PRIVATE KEY-----', body, '-----END PRIVATE KEY-----'].join('\n');

async function scalar(pem: string): Promise<Uint8Array> {
  const value = await apnsKeyScalar(pem);
  if (value === null) throw new Error('klucz testowy nie wszedł');
  return value;
}

describe('JWT dostawcy', () => {
  it('nagłówek {alg: ES256, kid}, claims {iss, iat}', async () => {
    const token = signProviderToken(await scalar((await testKey()).pem), 'KEYID00001', 'TEAMID0001', 1793613600);
    const [header, claims] = token.split('.');
    expect(decode(header ?? '')).toEqual({ alg: 'ES256', kid: 'KEYID00001' });
    expect(decode(claims ?? '')).toEqual({ iss: 'TEAMID0001', iat: 1793613600 });
  });

  it('podpis (r‖s, 64 B) weryfikuje klucz publiczny WebCrypto', async () => {
    const { pem, publicKey } = await testKey();
    const token = signProviderToken(await scalar(pem), 'KEYID00001', 'TEAMID0001', 1793613600);
    const [header, claims, signature] = token.split('.') as [string, string, string];
    const raw = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    expect(raw.byteLength).toBe(64);
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, raw,
      new TextEncoder().encode(`${header}.${claims}`));
    expect(valid).toBe(true);
  });

  it('deterministyczny: dwa „izolaty” w tym samym oknie liczą ten sam token', async () => {
    const value = await scalar((await testKey()).pem);
    const a = new ProviderTokens(value, 'KEYID00001', 'TEAMID0001');
    const b = new ProviderTokens(Uint8Array.from(value), 'KEYID00001', 'TEAMID0001');
    const start = jwtIat(NOW_MS) * 1000;
    expect(a.token(start)).toBe(b.token(start + JWT_WINDOW_SECONDS * 1000 - 1));
    expect(a.token(start + 5 * 60_000)).toBe(a.token(start));
  });

  it('nowe okno → nowy token; okno trwa 40 min (Apple: 20–60)', async () => {
    const tokens = new ProviderTokens(await scalar((await testKey()).pem), 'KEYID00001', 'TEAMID0001');
    const start = jwtIat(NOW_MS) * 1000;
    expect(tokens.token(start + JWT_WINDOW_SECONDS * 1000)).not.toBe(tokens.token(start));
    expect(JWT_WINDOW_SECONDS).toBeGreaterThanOrEqual(20 * 60);
    expect(JWT_WINDOW_SECONDS).toBeLessThan(60 * 60);
  });

  it('iat nigdy nie jest starszy niż 60 min (ani z przyszłości)', () => {
    for (let offset = 0; offset < 3 * JWT_WINDOW_SECONDS; offset += 97) {
      const now = NOW_MS + offset * 1000;
      const age = now / 1000 - jwtIat(now);
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(60 * 60);
    }
  });

  it('inny klucz → inny token (ten sam iat)', async () => {
    const one = signProviderToken(await scalar((await testKey()).pem), 'KEYID00001', 'TEAMID0001', 1);
    const two = signProviderToken(await scalar((await generateApnsKey()).pem), 'KEYID00001', 'TEAMID0001', 1);
    expect(one).not.toBe(two);
  });
});

describe('klucz APNs z PEM', () => {
  it('PKCS#8 P-256 → skalar 32 B; PEM z CRLF i spacjami na brzegach też', async () => {
    const { pem } = await testKey();
    expect((await apnsKeyScalar(pem))?.byteLength).toBe(32);
    expect((await apnsKeyScalar(`  ${pem.replace(/\n/g, '\r\n')}  `))?.byteLength).toBe(32);
  });

  it.each([
    ['pusty', ''],
    ['bez nagłówka', 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg'],
    ['śmieci w środku', pemOf('nie-base64!')],
    ['base64, ale nie klucz', pemOf(btoa('to nie jest klucz'))],
  ])('%s → null (bez wyjątku)', async (_what, pem) => {
    expect(await apnsKeyScalar(pem)).toBeNull();
  });

  it('klucz innej krzywej (P-384) → null', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']);
    if (!('privateKey' in pair)) throw new Error('para');
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
    const pem = pemOf(btoa(String.fromCharCode(...der)));
    expect(await apnsKeyScalar(pem)).toBeNull();
  });
});
