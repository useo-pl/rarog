/**
 * Canonical form of `tool_input` and its sha256 digest: `inputSha256` in the per-call dump of the
 * `rarog-pending.mjs` hook.
 *
 * The digest binds the decision from the phone to the content the card showed: the server computes it from the dump,
 * the hook from its own stdin, and both results must be equal to the byte. So the form is canonical, not "as it came":
 * object keys sorted recursively (UTF-16 code unit order, like `Array.prototype.sort` without a comparator and as in
 * JCS), arrays in their own order, primitive values through `JSON.stringify` (numbers and strings in the JS engine's
 * JSON notation), no whitespace. The digest is computed from the UTF-8 bytes of this form, written as hex.
 *
 * The input comes from `JSON.parse`, so it knows only JSON types. `undefined` (no `tool_input`) gives `null`, like
 * a missing field in the dump. The server-side twin: `server/src/herdr/dialogs/hook/canon.ts`; the shared vectors
 * `server/test/fixtures/hook-kanon/wektory.json` check that both agree
 * (`server/test/hook-canon.test.ts`).
 *
 * A PURE module: zero dependencies beyond `node:crypto`, zero I/O, zero state. The hook loads it dynamically in `try`,
 * so a load error or an exception (e.g. stack overflow on a very deeply nested input) means
 * "no digest": the hook writes no per-call dump and does not wait. It lies in the hook copy (`HOOK_INSTALL_FILES`).
 */
import { createHash } from 'node:crypto';

/**
 * Canonical JSON of a value from `JSON.parse`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Full sha256 (hex, 64 characters) of the value's canonical form.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalSha256(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
