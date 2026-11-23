/**
 * Kanoniczna postać `tool_input` i jej skrót sha256 po stronie serwera — bliźniak `scripts/hooks/canon.mjs`.
 *
 * Hook wpisuje `inputSha256` do zrzutu per wywołanie (`pending/<sesja>/<klucz>.json`), serwer liczy ten sam skrót
 * z treści, którą pokazuje karta, i oba muszą być równe co do bajtu. Hook jest czystym Node bez importów z repo
 * (wykonywana kopia w `~/.claude/hooks/rarog/`), więc algorytm stoi dwa razy; zgodność pilnują wspólne wektory
 * `server/test/fixtures/hook-kanon/wektory.json` w `server/test/hook-canon.test.ts`.
 *
 * Postać: klucze obiektów posortowane rekurencyjnie (porządek jednostek UTF-16, jak `sort()` bez komparatora
 * i jak w JCS), tablice w swojej kolejności, wartości proste przez `JSON.stringify`, bez białych znaków; skrót
 * z bajtów UTF-8, zapis hex. Wejście z `JSON.parse` (same typy JSON); `undefined` daje `null`.
 */
import { createHash } from 'node:crypto';

/** Kanoniczny JSON wartości z `JSON.parse` (ten sam algorytm co `canonicalJson` w `canon.mjs`). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Pełny sha256 (hex, 64 znaki) kanonicznej postaci wartości — `inputSha256` zrzutu per wywołanie. */
export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
