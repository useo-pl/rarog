/**
 * Osobny plik, bo mock `node:crypto` obowiązuje w całym module testowym.
 * Sprawdzamy JEDYNIE, że porównanie sekretu klucza urządzenia idzie przez `timingSafeEqual`
 * (wymaganie z speca: brak porównania `===` na sekretach).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const { timingSafeEqual } = await import('node:crypto');
const { checkDevice, createDeviceStore, createPairing, deviceAuthorization } = await import('../src/auth/index.ts');

describe('porównania w stałym czasie', () => {
  it('checkDevice porównuje skrót sekretu przez timingSafeEqual — dla rekordu i dla nieznanego id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rarog-auth-timing-'));
    try {
      const store = createDeviceStore({ dataDir: dir, epoch: '1', write: () => Promise.resolve() });
      const pairing = createPairing({ store, epoch: '1' });
      const paired = pairing.redeem({ code: pairing.issue('admin').code, label: 'iPhone·test' });
      if (!paired.ok) throw new Error('parowanie w teście nie przeszło');
      vi.mocked(timingSafeEqual).mockClear();
      expect(checkDevice(store, deviceAuthorization(paired.record.id, paired.secret)).ok).toBe(true);
      expect(vi.mocked(timingSafeEqual)).toHaveBeenCalled();
      vi.mocked(timingSafeEqual).mockClear();
      expect(checkDevice(store, deviceAuthorization('f'.repeat(32), paired.secret)).ok).toBe(false);
      expect(vi.mocked(timingSafeEqual)).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
