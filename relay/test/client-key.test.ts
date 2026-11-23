/**
 * Klucz limitu z adresu klienta: IPv4 bez zmian, IPv6 po /64 w jednej postaci, IPv4 zapisany
 * jako IPv6 → IPv4, napis nie do rozbioru i brak adresu → wspólny kubełek `unknown`.
 */
import { describe, expect, it } from 'vitest';
import { UNKNOWN_BUCKET, clientBucket } from '../src/client-key.ts';

describe('clientBucket', () => {
  it('IPv4 bez zmian', () => {
    for (const address of ['203.0.113.7', '0.0.0.0', '255.255.255.255', '10.0.0.1']) {
      expect(clientBucket(address)).toBe(address);
    }
  });

  it('dwa adresy jednej /64 → ten sam klucz; inna /64 → inny', () => {
    const a = clientBucket('2001:db8:85a3:12::1');
    expect(a).toBe('2001:0db8:85a3:0012::/64');
    expect(clientBucket('2001:db8:85a3:12:ffff:ffff:ffff:fffe')).toBe(a);
    expect(clientBucket('2001:db8:85a3:13::1')).toBe('2001:0db8:85a3:0013::/64');
  });

  it('zapis skrócony, pełny i wielkie litery → ten sam klucz', () => {
    const forms = [
      '2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001', '2001:DB8:0:0::abcd', '2001:db8:0:0:1::',
    ];
    expect(new Set(forms.map(clientBucket))).toEqual(new Set(['2001:0db8:0000:0000::/64']));
    expect(clientBucket('::')).toBe('0000:0000:0000:0000::/64');
    expect(clientBucket('::1')).toBe('0000:0000:0000:0000::/64');
    expect(clientBucket('fe80::')).toBe('fe80:0000:0000:0000::/64');
  });

  it('IPv4 zapisany jako IPv6 (IPv4-mapped) → IPv4', () => {
    expect(clientBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientBucket('::FFFF:cb00:7107')).toBe('203.0.113.7');
    expect(clientBucket('0:0:0:0:0:ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('IPv6 z czwórką kropkową na końcu (nie IPv4-mapped) → zwykła /64', () => {
    expect(clientBucket('64:ff9b::203.0.113.7')).toBe('0064:ff9b:0000:0000::/64');
  });

  it.each([
    ['null', null],
    ['pusty', ''],
    ['słowo', 'localhost'],
    ['oktet ponad 255', '256.1.1.1'],
    ['oktet z zerem wiodącym', '01.2.3.4'],
    ['trzy oktety', '1.2.3'],
    ['dwa „::”', '2001::db8::1'],
    ['dziewięć grup', '1:2:3:4:5:6:7:8:9'],
    ['siedem grup bez „::”', '1:2:3:4:5:6:7'],
    ['grupa pięciocyfrowa', '2001:db8:12345::1'],
    ['znak spoza hex', '2001:db8:g::1'],
    ['strefa', 'fe80::1%en0'],
    ['nawias', '[2001:db8::1]'],
    ['dwukropek na początku', ':2001:db8::1'],
    ['zły IPv4 na końcu', '::ffff:1.2.3.999'],
    ['IPv4 w środku', '1.2.3.4::1'],
    ['za długi', `2001:db8::${'0'.repeat(80)}`],
    ['spacja', ' 203.0.113.7'],
  ])('%s → wspólny kubełek „unknown”', (_what, address) => {
    expect(clientBucket(address)).toBe(UNKNOWN_BUCKET);
    expect(UNKNOWN_BUCKET).toBe('unknown');
  });
});
