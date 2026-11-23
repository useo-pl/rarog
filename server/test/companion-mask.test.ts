/**
 * Maska kształtów sekretów (`server/src/companion/mask.ts`) na wspólnej tabeli `shared/fixtures/companion/secret-shapes.json`.
 *
 * Tę samą tabelę czyta test projekcji w apce (Swift), więc obie maski mają te same reguły w tej samej kolejności
 * i dają ten sam wynik na każdym wierszu. Przykłady w tabeli są syntetyczne.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECRET_MASK, SECRET_SHAPES, maskSecrets } from '../src/companion/mask.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Table {
  mask: string;
  rules: { name: string; pattern: string; caseInsensitive: boolean; replacement: string }[];
  cases: { rule: string; example: string; expected: string }[];
}

const TABLE = JSON.parse(
  readFileSync(join(REPO, 'shared/fixtures/companion/secret-shapes.json'), 'utf8'),
) as Table;

describe('companion: maska sekretów według tabeli kształtów', () => {
  it.each(TABLE.cases.map((row) => [row.rule, row.example, row.expected] as const))(
    '%s: %s',
    (_rule, example, expected) => {
      expect(maskSecrets(example)).toBe(expected);
    },
  );

  it('reguły kodu to dokładnie reguły tabeli, w tej samej kolejności', () => {
    expect(SECRET_MASK).toBe(TABLE.mask);
    expect(SECRET_SHAPES.map((shape) => ({
      name: shape.name,
      pattern: shape.pattern.source,
      caseInsensitive: shape.pattern.flags.includes('i'),
      replacement: shape.replacement,
    }))).toEqual(TABLE.rules);
  });

  it('każda reguła ma w tabeli przykład, który maskuje', () => {
    for (const rule of TABLE.rules) {
      expect(TABLE.cases.some((row) => row.rule === rule.name && row.expected !== row.example), rule.name).toBe(true);
    }
  });

  it('kilka sekretów w jednym tekście, maska idempotentna', () => {
    const text = TABLE.cases.filter((row) => row.expected !== row.example).map((row) => row.example).join('\n');
    const masked = maskSecrets(text);
    expect(masked).toBe(TABLE.cases.filter((row) => row.expected !== row.example).map((row) => row.expected).join('\n'));
    expect(maskSecrets(masked)).toBe(masked);
  });
});
