/**
 * Przepustka: format, HMAC, `kid` i zakładka rotacji, `exp`, środowisko, typ, skrót
 * tokenu i wielkość liter tokenu.
 */
import { describe, expect, it } from 'vitest';
import {
  PASS_RENEW_WITHIN_SECONDS, PASS_TTL_SECONDS, checkPass, expiresAtOf, importPassKeyring, issuePass, needsRenewal,
  readPass, tokenHashOf,
} from '../src/pass.ts';
import type { PassKeyring } from '../src/pass.ts';
import { DAY_S, NOW_MS, OTHER_PASS_KEYS, T1, T2, TEST_PASS_KEYS } from './helpers.ts';

const NOW = NOW_MS / 1000;

async function ring(json = TEST_PASS_KEYS, kid = 'k1'): Promise<PassKeyring> {
  const result = await importPassKeyring(json, kid);
  if (result === null) throw new Error('klucze testowe nie weszły');
  return result;
}

async function devicePass(r: PassKeyring, exp = NOW + PASS_TTL_SECONDS, token = T1): Promise<string> {
  return issuePass(r, { environment: 'development', type: 'alert', tokenHash: await tokenHashOf(token), exp });
}

/** Podmiana PIERWSZEGO znaku pola `index` przepustki (cyfra → następna cyfra, litera → inna litera). */
function tamper(pass: string, index: number): string {
  const parts = pass.split('.');
  const field = parts[index] ?? '';
  const first = field.charAt(0);
  const swap = /[0-9]/.test(first) ? String((Number(first) + 1) % 10) : first === 'a' ? 'b' : 'a';
  parts[index] = `${swap}${field.slice(1)}`;
  return parts.join('.');
}

describe('przepustka: format i podpis', () => {
  it('kształt v1.<kid>.<env>.alert.<skrót 16 hex>.<exp>.<HMAC base64url>', async () => {
    const pass = await devicePass(await ring());
    expect(pass).toMatch(/^v1\.k1\.development\.alert\.[0-9a-f]{16}\.[0-9]+\.[A-Za-z0-9_-]{43}$/);
    expect(pass.split('.')[5]).toBe(String(NOW + PASS_TTL_SECONDS));
  });

  it('skrót = pierwsze 16 hex sha256 tokenu małymi literami', async () => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(T1)));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(await tokenHashOf(T1)).toBe(hex.slice(0, 16));
  });

  it('zgodny z niezależnie liczonym HMAC-SHA256 (ten sam tekst przed ostatnią kropką)', async () => {
    const r = await ring();
    const pass = await devicePass(r);
    const head = pass.slice(0, pass.lastIndexOf('.'));
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(JSON.parse(TEST_PASS_KEYS).k1 as string),
      (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(head)));
    const b64 = btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(pass.slice(pass.lastIndexOf('.') + 1)).toBe(b64);
  });

  it.each([1, 2, 3, 4, 5, 6])('zmiana pola %i unieważnia przepustkę', async (index) => {
    const r = await ring();
    const pass = await devicePass(r);
    expect(await readPass(r, pass)).not.toBeNull();
    expect(await readPass(r, tamper(pass, index))).toBeNull();
  });

  it.each([
    ['pusty', ''],
    ['bez podpisu', 'v1.k1.development.alert.0123456789abcdef.1800000000'],
    ['zła wersja', 'v2.k1.development.alert.0123456789abcdef.1800000000.' + 'A'.repeat(43)],
    ['nieznane środowisko', 'v1.k1.staging.alert.0123456789abcdef.1800000000.' + 'A'.repeat(43)],
    ['nieznany typ', 'v1.k1.development.background.0123456789abcdef.1800000000.' + 'A'.repeat(43)],
    ['za długa', `v1.${'k'.repeat(300)}`],
  ])('śmieci (%s) → null', async (_what, pass) => {
    expect(await readPass(await ring(), pass)).toBeNull();
  });

  it('podpis w niekanonicznym base64url (bity dopełnienia ostatniego znaku) → null', async () => {
    const r = await ring();
    const pass = await devicePass(r);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(pass.at(-1) ?? '');
    const sibling = alphabet.charAt(last ^ 1);
    expect(await readPass(r, `${pass.slice(0, -1)}${sibling}`)).toBeNull();
  });

  it('przepustka z innego przekaźnika (inne PASS_KEYS, ten sam kid) → null', async () => {
    const foreign = await devicePass(await ring(OTHER_PASS_KEYS));
    expect(await readPass(await ring(), foreign)).toBeNull();
  });
});

describe('przepustka: kid i rotacja z zakładką', () => {
  it('stary kid w PASS_KEYS dalej działa; po usunięciu z PASS_KEYS — nie', async () => {
    const before = await ring(TEST_PASS_KEYS, 'k0');
    const old = await devicePass(before);
    expect(old.split('.')[1]).toBe('k0');
    const rotated = await ring(TEST_PASS_KEYS, 'k1');
    expect(await readPass(rotated, old)).not.toBeNull();
    expect(needsRenewal(rotated, (await readPass(rotated, old))!, NOW)).toBe(true);
    const k1Only = await ring(JSON.stringify({ k1: (JSON.parse(TEST_PASS_KEYS) as Record<string, string>)['k1'] }));
    expect(await readPass(k1Only, old)).toBeNull();
  });

  it('nowe przepustki podpisuje bieżący kid', async () => {
    expect((await devicePass(await ring(TEST_PASS_KEYS, 'k1'))).split('.')[1]).toBe('k1');
  });

  it.each([
    ['nie JSON', 'k1=abc', 'k1'],
    ['tablica', '[]', 'k1'],
    ['pusty obiekt', '{}', 'k1'],
    ['klucz za krótki', JSON.stringify({ k1: btoa('za krótki klucz') }), 'k1'],
    ['nie base64', JSON.stringify({ k1: '!!!' + 'a'.repeat(60) }), 'k1'],
    ['kid z kropką', JSON.stringify({ 'k.1': btoa('x'.repeat(40)) }), 'k.1'],
    ['PASS_KID spoza PASS_KEYS', TEST_PASS_KEYS, 'k9'],
  ])('PASS_KEYS: %s → null', async (_what, json, kid) => {
    expect(await importPassKeyring(json, kid)).toBeNull();
  });
});

describe('przepustka: termin, środowisko, typ, token', () => {
  it('exp w przyszłości — ważna; exp = teraz albo wcześniej — nieważna', async () => {
    const r = await ring();
    const pass = await devicePass(r, NOW + 1);
    expect(await checkPass(r, pass, { environment: 'development' }, NOW)).not.toBeNull();
    expect(await checkPass(r, pass, { environment: 'development' }, NOW + 1)).toBeNull();
  });

  it('środowisko, typ i skrót tokenu muszą się zgadzać', async () => {
    const r = await ring();
    const pass = await devicePass(r);
    const hash = await tokenHashOf(T1);
    expect(await checkPass(r, pass, { environment: 'development', type: 'alert', tokenHash: hash }, NOW)).not.toBeNull();
    expect(await checkPass(r, pass, { environment: 'production' }, NOW)).toBeNull();
    expect(await checkPass(r, pass, { environment: 'development', type: 'liveactivity' }, NOW)).toBeNull();
    expect(await checkPass(r, pass, { environment: 'development', tokenHash: await tokenHashOf(T2) }, NOW)).toBeNull();
  });

  it('odnowienie: mniej niż 7 dni do exp albo stary kid', async () => {
    const r = await ring();
    const claims = (exp: number) => ({
      kid: 'k1', environment: 'development' as const, type: 'alert' as const, tokenHash: '0'.repeat(16), exp,
    });
    expect(needsRenewal(r, claims(NOW + PASS_RENEW_WITHIN_SECONDS), NOW)).toBe(false);
    expect(needsRenewal(r, claims(NOW + PASS_RENEW_WITHIN_SECONDS - 1), NOW)).toBe(true);
    expect(needsRenewal(r, { ...claims(NOW + 80 * DAY_S), kid: 'k0' }, NOW)).toBe(true);
  });

  it('expiresAt to ISO 8601 UTC z exp w sekundach', () => {
    expect(expiresAtOf(1801389600)).toBe('2027-01-31T10:00:00.000Z');
  });
});

describe('przepustka kafla v2: skrót rodzica, liczba pól, wersja × typ', () => {
  /** HMAC-SHA256 liczony niezależnie od `pass.ts` (klucz testowy z `TEST_PASS_KEYS`). */
  async function sign(head: string, kid = 'k1'): Promise<string> {
    const raw = Uint8Array.from(atob((JSON.parse(TEST_PASS_KEYS) as Record<string, string>)[kid] ?? ''), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(head)));
    return `${head}.${btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  }

  async function tilePass(r: PassKeyring, exp = NOW + PASS_TTL_SECONDS): Promise<string> {
    return issuePass(r, {
      environment: 'development', type: 'liveactivity', tokenHash: await tokenHashOf(T2), parentHash: await tokenHashOf(T1), exp,
    });
  }

  it('kształt v2.<kid>.<env>.liveactivity.<skrót kafla>.<skrót rodzica>.<exp>.<HMAC>; podpis = niezależny HMAC', async () => {
    const r = await ring();
    const pass = await tilePass(r);
    const parts = pass.split('.');
    expect(parts.slice(0, 7)).toEqual([
      'v2', 'k1', 'development', 'liveactivity', await tokenHashOf(T2), await tokenHashOf(T1), String(NOW + PASS_TTL_SECONDS),
    ]);
    expect(pass).toBe(await sign(parts.slice(0, 7).join('.')));
    expect(pass.length).toBeLessThan(140);
    expect(await readPass(r, pass)).toEqual({
      kid: 'k1', environment: 'development', type: 'liveactivity', tokenHash: await tokenHashOf(T2),
      parentHash: await tokenHashOf(T1), exp: NOW + PASS_TTL_SECONDS,
    });
  });

  it.each([1, 2, 3, 4, 5, 6, 7])('zmiana pola %i (w tym skrótu rodzica, 5) unieważnia przepustkę kafla', async (index) => {
    const r = await ring();
    const pass = await tilePass(r);
    expect(await readPass(r, tamper(pass, index))).toBeNull();
  });

  it('7 albo 9 pól pod v2 → null, także z poprawnym HMAC', async () => {
    const r = await ring();
    const [tile, parent] = [await tokenHashOf(T2), await tokenHashOf(T1)];
    const exp = String(NOW + PASS_TTL_SECONDS);
    expect(await readPass(r, await sign(['v2', 'k1', 'development', 'liveactivity', tile, exp].join('.')))).toBeNull();
    expect(await readPass(r, await sign(['v2', 'k1', 'development', 'liveactivity', tile, parent, parent, exp].join('.'))))
      .toBeNull();
  });

  it('v2 typu alert i v1 typu liveactivity (stary format kafla) → null, także z poprawnym HMAC', async () => {
    const r = await ring();
    const [tile, parent] = [await tokenHashOf(T2), await tokenHashOf(T1)];
    const exp = String(NOW + PASS_TTL_SECONDS);
    expect(await readPass(r, await sign(['v2', 'k1', 'development', 'alert', tile, parent, exp].join('.')))).toBeNull();
    expect(await readPass(r, await sign(['v1', 'k1', 'development', 'liveactivity', tile, exp].join('.')))).toBeNull();
    // Kontrola: ten sam podpisujący wydaje ważne v1 `alert`.
    expect(await readPass(r, await sign(['v1', 'k1', 'development', 'alert', parent, exp].join('.')))).not.toBeNull();
  });

  it('stary kid po rotacji: v2 podpisana k0 działa, póki k0 jest w PASS_KEYS (do odnowienia); bez k0 → null', async () => {
    const old = await tilePass(await ring(TEST_PASS_KEYS, 'k0'));
    expect(old.split('.')[1]).toBe('k0');
    const rotated = await ring(TEST_PASS_KEYS, 'k1');
    const claims = await readPass(rotated, old);
    expect(claims).not.toBeNull();
    expect(needsRenewal(rotated, claims!, NOW)).toBe(true);
    const k1Only = await ring(JSON.stringify({ k1: (JSON.parse(TEST_PASS_KEYS) as Record<string, string>)['k1'] }));
    expect(await readPass(k1Only, old)).toBeNull();
  });
});
