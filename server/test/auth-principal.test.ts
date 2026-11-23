/**
 * Jedna granica uwierzytelnienia (`server/src/auth/principal.ts`): `authenticate` zna wyłącznie klucz urządzenia
 * z nagłówka `Authorization: Rarog-Device`. Bez nagłówka odmowa `missing` — także przy nagłówku `Cookie`,
 * bo logowania tokenem serwer nie ma. Poza katalogiem `auth/` nikt nie czyta `Authorization` ani `Cookie` sam —
 * router, SSE i upgrade WebSocket terminala pytają `authenticate`. Strażnik jest GREPOWY na kodzie bez
 * komentarzy (`source-scan.ts`).
 */
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { authenticate, createDeviceStore, createPairing, deviceAuthorization } from '../src/auth/index.ts';
import type { AuthResult } from '../src/auth/index.ts';
import { DEVICE_AUTH_SCHEME } from '../src/auth/device.ts';
import { DEFAULT_AUTH_EPOCH } from '../src/config.ts';
import { scan, tsFiles } from './source-scan.ts';

const EPOCH = DEFAULT_AUTH_EPOCH;
const principalOf = (result: AuthResult): unknown => (result.ok ? result.principal : null);

describe('authenticate — bez nagłówka `Authorization`', () => {
  it('brak nagłówków, cookie dawnego logowania i inne cookie → odmowa `missing`, z magazynem i bez', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rarog-principal-cookie-'));
    try {
      const store = createDeviceStore({ dataDir: dir, epoch: EPOCH, write: () => Promise.resolve() });
      for (const headers of [{}, { cookie: 'rarog_auth=1.1700000000000.abc' }, { cookie: 'a=1; b=2' }]) {
        const req = { headers } as unknown as IncomingMessage;
        for (const devices of [store, undefined]) {
          expect(authenticate(req, devices), JSON.stringify(headers)).toEqual({ ok: false, refusal: { kind: 'missing' } });
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('authenticate — klucz urządzenia', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-principal-'));
  const store = createDeviceStore({ dataDir: dir, epoch: EPOCH });
  // Zapisy magazynu w tle kończą się przed sprzątnięciem katalogu (inaczej `mkdir` zapisu go odtworzy).
  afterAll(async () => { await store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const pairing = createPairing({ store, epoch: EPOCH });
  const issued = pairing.issue('admin');
  const paired = pairing.redeem({ code: issued.code, label: 'iPhone·Rarog' });
  if (!paired.ok) throw new Error('parowanie w teście nie przeszło');
  const header = deviceAuthorization(paired.record.id, paired.secret);
  const cookie = 'rarog_auth=1.1700000000000.abc';
  const req = (headers: Record<string, string>): IncomingMessage => ({ headers } as unknown as IncomingMessage);

  it('ważny klucz → klient `device` z identyfikatorem i etykietą z parowania', () => {
    expect(principalOf(authenticate(req({ authorization: header }), store))).toEqual({
      kind: 'device', deviceId: paired.record.id, label: 'iPhone·Rarog',
    });
  });

  it('zły klucz albo obcy schemat to odmowa `device-unknown`, cookie obok niczego nie zmienia', () => {
    const badSecret = deviceAuthorization(paired.record.id, 'A'.repeat(43));
    for (const authorization of [badSecret, 'Bearer abc', 'Rarog-Device', `Basic ${'x'.repeat(10)}`, '']) {
      expect(authenticate(req({ authorization, cookie }), store), authorization)
        .toEqual({ ok: false, refusal: { kind: 'device-unknown' } });
    }
    // Bez magazynu (serwer bez parowania) każdy nagłówek `Authorization` to `device-unknown`.
    expect(authenticate(req({ authorization: header, cookie }), undefined))
      .toEqual({ ok: false, refusal: { kind: 'device-unknown' } });
  });

  it('wielkość liter schematu bez znaczenia (RFC 9110), ale kształt id i sekretu twardy', () => {
    expect(authenticate(req({ authorization: header.replace(DEVICE_AUTH_SCHEME, DEVICE_AUTH_SCHEME.toLowerCase()) }),
      store).ok).toBe(true);
    expect(authenticate(req({ authorization: header.toUpperCase() }), store).ok).toBe(false);
  });

  it('odpięte urządzenie → `device-revoked` z datą i przyczyną, ale tylko dla znającego sekret', () => {
    const tomb = store.revoke(paired.record.id, 'admin');
    expect(tomb).toBeDefined();
    expect(authenticate(req({ authorization: header }), store)).toEqual({
      ok: false, refusal: { kind: 'device-revoked', revokedAt: tomb?.revokedAt, revokedBy: 'admin' },
    });
    expect(authenticate(req({ authorization: deviceAuthorization(paired.record.id, 'B'.repeat(43)) }), store))
      .toEqual({ ok: false, refusal: { kind: 'device-unknown' } });
  });

  it('jeden schemat w każdej wielkości liter daje klienta, obcy schemat nie', () => {
    const value = header.slice(DEVICE_AUTH_SCHEME.length + 1);
    const again = pairing.redeem({ code: pairing.issue('admin').code, label: 'iPad' });
    if (!again.ok) throw new Error('parowanie w teście nie przeszło');
    const fresh = deviceAuthorization(again.record.id, again.secret).slice(DEVICE_AUTH_SCHEME.length + 1);
    for (const variant of [DEVICE_AUTH_SCHEME, DEVICE_AUTH_SCHEME.toLowerCase(), DEVICE_AUTH_SCHEME.toUpperCase()]) {
      expect(principalOf(authenticate(req({ authorization: `${variant} ${fresh}` }), store)), variant)
        .toEqual({ kind: 'device', deviceId: again.record.id, label: 'iPad' });
    }
    for (const foreign of [`${DEVICE_AUTH_SCHEME}x`, `X-${DEVICE_AUTH_SCHEME}`, 'Device', 'Bearer']) {
      expect(authenticate(req({ authorization: `${foreign} ${value}` }), store), foreign)
        .toEqual({ ok: false, refusal: { kind: 'device-unknown' } });
    }
  });
});

describe('granica: poza `server/src/auth/` nikt nie czyta `Authorization` ani `Cookie` sam', () => {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const SRC = join(REPO, 'server/src');
  /** Nazwy, których użycie poza `auth/` znaczyłoby drugą, równoległą bramkę. */
  const FORBIDDEN = new RegExp(
    String.raw`\b(?:checkDevice|parseDeviceAuthorization)\b`
    + String.raw`|headers\.(?:cookie|authorization)\b|headers\[['"](?:cookie|authorization)['"]\]`,
  );

  it('router i `term/ws.ts` wołają `authenticate`; nikt inny nie sięga do poświadczeń', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = relative(REPO, file);
      if (rel.startsWith('server/src/auth/')) continue;
      // Bez numeru linii: skaner zwija komentarz blokowy do spacji, więc numeracja kodu się rozjeżdża.
      for (const line of scan(readFileSync(file, 'utf8')).code.split('\n')) {
        if (FORBIDDEN.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
    for (const rel of ['server/src/router.ts', 'server/src/term/ws.ts']) {
      expect(scan(readFileSync(join(REPO, rel), 'utf8')).code, rel).toMatch(/\bauthenticate\(req, /);
    }
  });

  it('strażnik łapie odczyt nagłówka obok bramki (próbka)', () => {
    for (const sample of ['const a = req.headers.authorization;', "req.headers['cookie']", 'checkDevice(store, h)']) {
      expect(FORBIDDEN.test(sample), sample).toBe(true);
    }
  });
});
