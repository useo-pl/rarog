/**
 * Moduły wspólne z przekaźnikiem push: `src/wspolne.ts` to jedyny plik `relay-auth/`, który importuje kod
 * z `relay/src/` (strażnik konfiguracji czyta jeszcze `relay/package.json` i `relay/wrangler.toml`), a to, co z niego
 * wychodzi, działa w tym projekcie (rozwiązanie importów i zależności z `relay/node_modules`). Glob Vite pomija plik,
 * który go woła, więc ten test nie widzi siebie.
 */
import { describe, expect, it } from 'vitest';
import {
  APNS_ORIGINS,
  APP_TOPIC,
  UNKNOWN_BUCKET,
  base64url,
  clientBucket,
  createLogFormatter,
  hex,
  jwtIat,
  logCode,
  sha256Hex,
  signProviderToken,
  utf8,
} from '../src/wspolne.ts';

const SOURCES = import.meta.glob<string>(['../src/**/*.ts', './**/*.ts'], { eager: true, query: '?raw', import: 'default' });
/** `from '…/relay/src/…'`, `import '…'` i `import('…')`. */
const RELAY_IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(?\s*)['"](?:\.\.\/)+relay\/src\//;

describe('jedno wejście do relay/src', () => {
  it('z relay/src importuje wyłącznie src/wspolne.ts', () => {
    const importers = Object.entries(SOURCES)
      .filter(([, text]) => RELAY_IMPORT_RE.test(text))
      .map(([file]) => file);
    expect(importers).toEqual(['../src/wspolne.ts']);
  });

  it('glob widzi źródła i testy (pusty wybór nie jest zielonym strażnikiem)', () => {
    expect(Object.keys(SOURCES)).toEqual(expect.arrayContaining([
      '../src/apple.ts', '../src/config.ts', '../src/core.ts', '../src/crypto.ts', '../src/log.ts',
      '../src/objects.ts', '../src/registry.ts', '../src/worker.ts', '../src/wspolne.ts', './worker.test.ts',
    ]));
  });
});

describe('moduły wspólne działają w tym projekcie', () => {
  it('bytes: UTF-8, hex, base64url, SHA-256', async () => {
    expect(hex(utf8('abc'))).toBe('616263');
    expect(base64url(utf8('??>'))).toBe('Pz8-');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('client-key: IPv6 po /64, śmieć do wspólnego kubełka', () => {
    expect(clientBucket('2001:db8:1:2:3:4:5:6')).toBe(clientBucket('2001:db8:1:2::9'));
    expect(clientBucket('nie-adres')).toBe(UNKNOWN_BUCKET);
  });

  it('jwt: token ES256 dostawcy z `kid` i `iss` (atrapa skalara, bez klucza z portalu)', () => {
    const scalar = new Uint8Array(32).fill(7);
    const token = signProviderToken(scalar, 'ABCDEFGHIJ', 'KLMNOPQRST', jwtIat(1_800_000_000_000));
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(atob(header ?? ''))).toEqual({ alg: 'ES256', kid: 'ABCDEFGHIJ' });
    expect(JSON.parse(atob(payload ?? ''))).toMatchObject({ iss: 'KLMNOPQRST' });
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it('apns: adresy Apple obu środowisk; temat apki próbnego pusha', () => {
    expect(Object.keys(APNS_ORIGINS).sort()).toEqual(['development', 'production']);
    expect(APP_TOPIC).toBe('ai.rarog.app');
  });

  it('log: formatter z białą listą', () => {
    expect(createLogFormatter({ event: logCode }).format({ event: 'x', token: 'y' })).toBe('{"event":"x"}');
  });
});
