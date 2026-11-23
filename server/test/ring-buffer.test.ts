/**
 * Testy ring buffera: monotoniczność `seq`, `since()`, `tooOld()` i wrap-around
 * (zachowanie po przepełnieniu pojemności).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_RING_CAPACITY, MAX_MESSAGE_BYTES, RING_MAX_BYTES, RingBuffer, jsonBytes,
} from '../src/sessions/ring-buffer.ts';

const fill = (buf: RingBuffer<string>, from: number, to: number): void => {
  for (let i = from; i <= to; i += 1) buf.push(`e${i}`);
};

describe('RingBuffer — podstawy', () => {
  it('domyślna pojemność to 500 (spec)', () => {
    expect(DEFAULT_RING_CAPACITY).toBe(500);
    expect(new RingBuffer<string>().capacity).toBe(500);
  });

  it('odrzuca niepoprawną pojemność', () => {
    expect(() => new RingBuffer<string>(0)).toThrow(RangeError);
    expect(() => new RingBuffer<string>(-1)).toThrow(RangeError);
    expect(() => new RingBuffer<string>(1.5)).toThrow(RangeError);
  });

  it('pusty bufor: brak elementów, kursor 0 jest aktualny', () => {
    const buf = new RingBuffer<string>(4);
    expect(buf.size).toBe(0);
    expect(buf.lastSeq).toBe(0);
    expect(buf.firstSeq).toBeNull();
    expect(buf.since(0)).toEqual([]);
    expect(buf.tooOld(0)).toBe(false);
  });
});

describe('RingBuffer — monotoniczność seq', () => {
  it('push zwraca kolejne liczby od 1, bez dziur', () => {
    const buf = new RingBuffer<string>(3);
    const seqs = ['a', 'b', 'c', 'd', 'e'].map((v) => buf.push(v));
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(buf.lastSeq).toBe(5);
  });

  it('seq nie cofa się po wyparciu ani po clear()', () => {
    const buf = new RingBuffer<string>(2);
    fill(buf, 1, 5);
    expect(buf.lastSeq).toBe(5);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.push('kolejny')).toBe(6);
  });

  it('property: seq rośnie o 1 przy każdym push', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 20 }),
      fc.array(fc.string(), { maxLength: 200 }),
      (capacity, values) => {
        const buf = new RingBuffer<string>(capacity);
        let prev = 0;
        for (const v of values) {
          const seq = buf.push(v);
          expect(seq).toBe(prev + 1);
          prev = seq;
        }
        expect(buf.size).toBe(Math.min(values.length, capacity));
      },
    ));
  });
});

describe('RingBuffer — since()', () => {
  it('zwraca ogon po kursorze (kursor = ostatni odebrany seq)', () => {
    const buf = new RingBuffer<string>(10);
    fill(buf, 1, 5);
    expect(buf.since(0)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(buf.since(3)).toEqual(['e4', 'e5']);
    expect(buf.since(5)).toEqual([]);
  });

  it('kursor z przyszłości nie zwraca nic', () => {
    const buf = new RingBuffer<string>(10);
    fill(buf, 1, 3);
    expect(buf.since(99)).toEqual([]);
  });

  it('entriesSince zwraca pary seq+wartość zgodne z push', () => {
    const buf = new RingBuffer<string>(10);
    fill(buf, 1, 3);
    expect(buf.entriesSince(1)).toEqual([
      { seq: 2, value: 'e2' },
      { seq: 3, value: 'e3' },
    ]);
  });

  it('property: since(k) to dokładnie elementy o seq > k', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 0, max: 40 }),
      (capacity, count) => {
        const buf = new RingBuffer<number>(capacity);
        for (let i = 1; i <= count; i += 1) buf.push(i);
        const cursor = Math.max(0, count - Math.min(capacity, count));
        expect(buf.since(cursor)).toEqual(
          Array.from({ length: count - cursor }, (_, i) => cursor + i + 1),
        );
      },
    ));
  });
});

describe('RingBuffer — tooOld()', () => {
  it('kursor mieszczący się w buforze nie jest za stary', () => {
    const buf = new RingBuffer<string>(3);
    fill(buf, 1, 3);
    expect(buf.tooOld(0)).toBe(false);
    expect(buf.tooOld(2)).toBe(false);
    expect(buf.tooOld(3)).toBe(false);
  });

  it('kursor sprzed wypartych eventów jest za stary', () => {
    const buf = new RingBuffer<string>(3);
    fill(buf, 1, 5);          // w buforze zostają e3..e5
    expect(buf.tooOld(1)).toBe(true);
    expect(buf.tooOld(2)).toBe(false);  // e3..e5 da się jeszcze odtworzyć w całości
    expect(buf.since(2)).toEqual(['e3', 'e4', 'e5']);
  });

  it('kursor z przyszłości / z innego serverStartId jest za stary', () => {
    const buf = new RingBuffer<string>(3);
    fill(buf, 1, 3);
    expect(buf.tooOld(4)).toBe(true);
    expect(buf.tooOld(Number.NaN)).toBe(true);
    expect(buf.tooOld(Number.POSITIVE_INFINITY)).toBe(true);
  });

  it('property: gdy !tooOld(k), since(k) odtwarza WSZYSTKO po k bez dziury', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 10 }),
      fc.integer({ min: 0, max: 40 }),
      fc.integer({ min: 0, max: 45 }),
      (capacity, count, cursor) => {
        const buf = new RingBuffer<number>(capacity);
        for (let i = 1; i <= count; i += 1) buf.push(i);
        if (buf.tooOld(cursor)) return;
        expect(buf.since(cursor)).toEqual(
          Array.from({ length: count - cursor }, (_, i) => cursor + i + 1),
        );
      },
    ));
  });
});

describe('RingBuffer — wrap-around', () => {
  it('po przepełnieniu trzyma dokładnie ostatnie `capacity` elementów', () => {
    const buf = new RingBuffer<string>(3);
    fill(buf, 1, 7);
    expect(buf.size).toBe(3);
    expect(buf.firstSeq).toBe(5);
    expect(buf.lastSeq).toBe(7);
    expect(buf.toArray()).toEqual(['e5', 'e6', 'e7']);
  });

  it('kolejność zachowana po wielu okrążeniach', () => {
    const buf = new RingBuffer<number>(4);
    for (let i = 1; i <= 1000; i += 1) buf.push(i);
    expect(buf.toArray()).toEqual([997, 998, 999, 1000]);
    expect(buf.entries()).toEqual([
      { seq: 997, value: 997 },
      { seq: 998, value: 998 },
      { seq: 999, value: 999 },
      { seq: 1000, value: 1000 },
    ]);
  });

  it('bufor 500 (domyślny) wypycha najstarszy dopiero na 501. evencie', () => {
    const buf = new RingBuffer<number>();
    for (let i = 1; i <= 500; i += 1) buf.push(i);
    expect(buf.tooOld(0)).toBe(false);
    buf.push(501);
    expect(buf.tooOld(0)).toBe(true);
    expect(buf.tooOld(1)).toBe(false);
    expect(buf.size).toBe(500);
  });
});

describe('RingBuffer — sufit BAJTÓW', () => {
  it('stałe są tam, gdzie mówi plan: jedna wiadomość i jedna sesja', () => {
    expect(MAX_MESSAGE_BYTES).toBeLessThan(RING_MAX_BYTES);
    // Waga liczona jak ramka SSE — JSON w UTF-8, nie rozmiar obiektu w RAM.
    expect(jsonBytes({ a: 'ą' })).toBe(Buffer.byteLength('{"a":"ą"}', 'utf8'));
    // Wartość niekodowalna nie ma prawa wywrócić pushu.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonBytes(cyclic)).toBe(0);
  });

  it('bez `maxBytes` bufor liczy wyłącznie sztuki', () => {
    const buf = new RingBuffer<string>(3);
    fill(buf, 1, 3);
    expect(buf.size).toBe(3);
    expect(buf.bytes).toBe(0);
  });

  it('przekroczony budżet wypycha NAJSTARSZE, a kursor po nich jest za stary', () => {
    // Waga = długość napisu, żeby arytmetyka testu była policzalna wprost.
    const buf = new RingBuffer<string>(100, { maxBytes: 10, weigh: (v) => v.length });
    buf.push('aaaa');
    buf.push('bbbb');
    expect(buf.size).toBe(2);
    buf.push('cccc');
    // 12 > 10 → wypada najstarszy, zostaje 8 bajtów.
    expect(buf.toArray()).toEqual(['bbbb', 'cccc']);
    expect(buf.bytes).toBe(8);
    expect(buf.tooOld(1)).toBe(false);
    expect(buf.tooOld(0)).toBe(true);
  });

  it('element cięższy niż cały budżet ZOSTAJE sam — bufor po pushu nie bywa pusty', () => {
    const buf = new RingBuffer<string>(10, { maxBytes: 4, weigh: (v) => v.length });
    buf.push('a');
    buf.push('x'.repeat(50));
    expect(buf.size).toBe(1);
    expect(buf.toArray()).toEqual(['x'.repeat(50)]);
  });

  it('własność: suma bajtów NIGDY nie przekracza sufitu (poza samotnym olbrzymem)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 0, maxLength: 40 }), { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 1, max: 60 }),
        (values, maxBytes) => {
          const buf = new RingBuffer<string>(500, { maxBytes, weigh: (v) => v.length });
          for (const value of values) {
            buf.push(value);
            // Jedyny dopuszczalny nadmiar to POJEDYNCZY element cięższy od całego budżetu:
            // pusty bufor po pushu byłby gorszy niż bufor za ciężki o jeden wpis.
            if (buf.bytes > maxBytes) expect(buf.size).toBe(1);
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
