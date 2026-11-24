/**
 * The order of a listing (`compareFileEntries` in `shared/src/protocol/files.ts`) on the vector the app checks with its
 * own comparator (`shared/fixtures/files/listing-order.json`, `FileEntryOrderTests` in RarogContract), so a listing the
 * app extends keeps the server's order.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FILE_ENTRY_KINDS, compareFileEntries } from '../src/protocol.ts';

const VECTOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/files/listing-order.json');

const vectorSchema = z.strictObject({
  $comment: z.string(),
  ordered: z.array(z.strictObject({ name: z.string().min(1), kind: z.enum(FILE_ENTRY_KINDS) })).min(2),
});

const { ordered } = vectorSchema.parse(JSON.parse(readFileSync(VECTOR, 'utf8')));

describe('listing order: the vector shared with the app', () => {
  it('every entry sorts before every later one and after none', () => {
    for (const [index, a] of ordered.entries()) {
      for (const b of ordered.slice(index + 1)) {
        expect(compareFileEntries(a, b), `${JSON.stringify(a.name)} before ${JSON.stringify(b.name)}`).toBeLessThan(0);
        expect(compareFileEntries(b, a), `${JSON.stringify(b.name)} after ${JSON.stringify(a.name)}`).toBeGreaterThan(0);
      }
      expect(compareFileEntries(a, a)).toBe(0);
    }
  });

  it('a reversed copy sorts back into the vector', () => {
    expect([...ordered].reverse().sort(compareFileEntries)).toEqual(ordered);
  });
});
