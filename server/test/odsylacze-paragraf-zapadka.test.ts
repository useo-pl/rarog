/**
 * Ratchet on section-sign references (`§`) in code comments of `server/src` and `shared/src`.
 *
 * A `§` in a comment points at a numbered chapter of a plan, and plans are deleted once done, so the reference dies.
 * A comment cites a section name of a living document in quotes (`docs/<file>.md`, „Section”) instead. The baseline
 * is empty: no file in the working tree may have a `§` sign in a comment. Strings, templates and regex literals are
 * code, not comments (`scan` from `source-scan.ts`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoFiles } from '../../scripts/lib/repo-files.mjs';
import { scan } from './source-scan.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ROOTS = ['server/src/', 'shared/src/'] as const;
const CODE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const SIGN = '§';

interface Baseline {
  readonly files: Readonly<Record<string, number>>;
}

/** The working tree baseline: no entries, so a file may not have any `§` sign in comments. */
const BASELINE: Baseline = { files: {} };

/** A file in scope: code under `server/src` or `shared/src`. */
function inScope(file: string): boolean {
  return ROOTS.some((root) => file.startsWith(root)) && CODE.test(file);
}

/** How many times `needle` stands in `text`. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * `§` signs in comments: all signs in the source minus the signs the scanner leaves in the code (strings, templates
 * and regex literals stay in `code`, comments do not). Line and block comments count alike, also after code.
 */
function countSigns(text: string): number {
  const all = occurrences(text, SIGN);
  return all === 0 ? 0 : all - occurrences(scan(text).code, SIGN);
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Violations for a tree state (`state`: file in scope → `§` signs in comments). */
function violations(state: ReadonlyMap<string, number>, baseline: Baseline): string[] {
  const out: string[] = [];
  for (const [file, n] of [...state].sort(([a], [b]) => byKey(a, b))) {
    if (n === 0) continue;
    const entry = Object.hasOwn(baseline.files, file) ? baseline.files[file] : undefined;
    if (entry === undefined) out.push(`NEW ${file}: ${String(n)} ${SIGN} sign(s) in comments, allowed 0`);
    else if (n > entry) out.push(`UP ${file}: ${String(n)} ${SIGN} sign(s) in comments, baseline ${String(entry)}`);
  }
  return out;
}

const ADVICE = [
  `Why: ${SIGN} points at a chapter of a plan, and a finished plan is deleted, so the reference dies.`,
  'What to do: replace the reference with a section name of a living document',
  'in quotes (`docs/<file>.md`, „Section”),',
  'or drop it when the sentence says enough without it.',
].join('\n');

function treeState(root: string): Map<string, number> {
  const state = new Map<string, number>();
  for (const file of repoFiles(root)) {
    if (!inScope(file)) continue;
    state.set(file, countSigns(readFileSync(path.join(root, file), 'utf8')));
  }
  return state;
}

const state = treeState(REPO);

describe('section-sign ratchet: rule on synthetic data', () => {
  const a = 'server/src/a.ts';
  const b = 'shared/src/b.ts';
  const synthetic: Baseline = { files: { [a]: 3, [b]: 1 } };
  const full = (changes: Record<string, number>): Map<string, number> =>
    new Map(Object.entries({ [a]: 3, [b]: 1, ...changes }));

  it('state equal to the baseline or below it: green', () => {
    expect(violations(full({}), synthetic)).toEqual([]);
    expect(violations(full({ [a]: 0, [b]: 0 }), synthetic)).toEqual([]);
  });

  it('one line more than the entry: red', () => {
    expect(violations(full({ [a]: 4 }), synthetic)).toEqual([
      `UP ${a}: 4 ${SIGN} sign(s) in comments, baseline 3`,
    ]);
  });

  it('a new file with a sign: red; a new file without one: green', () => {
    expect(violations(full({ 'server/src/new.ts': 0 }), synthetic)).toEqual([]);
    expect(violations(full({ 'server/src/new.ts': 1 }), synthetic)).toEqual([
      `NEW server/src/new.ts: 1 ${SIGN} sign(s) in comments, allowed 0`,
    ]);
  });

  it('counts signs in comments only: line, block and trailing comments, not strings, templates or regexes', () => {
    const text = [
      '/**',
      ` * See ${SIGN}4.2 of the plan.`,
      ' */',
      `const x = 1; // ${SIGN}5`,
      `// ${SIGN}6 and ${SIGN}7 on one line`,
      `const s = '${SIGN}';`,
      `/* ${SIGN}8 */`,
    ].join('\n');
    expect(countSigns(text)).toBe(5);
    expect(countSigns(`const x = 1; /* ${SIGN}4 */`)).toBe(1);
    expect(countSigns(`/*\nSee ${SIGN}4\n*/\nconst x = 1;`)).toBe(1);
    expect(countSigns(`const url = "https://example.test/${SIGN}4";`)).toBe(0);
    expect(countSigns(['const t = `', `// ${SIGN}4 inside a template`, '`;'].join('\n'))).toBe(0);
    expect(countSigns(`const s = '${SIGN}'; // ${SIGN}9`)).toBe(1);
    expect(countSigns(`const r = /${SIGN}\\d+/u;`)).toBe(0);
  });

  it('scope: code in server/src and shared/src only', () => {
    expect([a, b, 'server/src/herdr/x.mjs', 'server/src/a.tsx', 'shared/src/a.jsx'].every(inScope)).toBe(true);
    expect(['server/src/README.md', 'server/test/x.test.ts', 'docs/architecture.md', 'scripts/x.mjs'].some(inScope))
      .toBe(false);
  });
});

describe('section-sign ratchet: working tree', () => {
  it('no file has more § signs in comments than its entry', () => {
    const out = violations(state, BASELINE);
    expect(out.length, [`Section-sign ratchet: ${SIGN} references in comments.`, ...out, '', ADVICE].join('\n'))
      .toBe(0);
  });
});
