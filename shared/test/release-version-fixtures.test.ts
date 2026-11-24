/**
 * Release version cases in `shared/fixtures/release-version/cases.json`: every string in `stable` is a stable
 * version, every string in `beta` is a beta of the next stable version, and every string in `rejected` is neither.
 * Each list is checked against both patterns, so a case filed under the wrong list fails here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/release-version/cases.json');
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const BETA = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/u;

interface Cases {
  readonly stable: readonly string[];
  readonly beta: readonly string[];
  readonly rejected: readonly string[];
}

const cases = JSON.parse(readFileSync(FILE, 'utf8')) as Cases;

describe('release version cases', () => {
  it('has exactly the three lists, none empty, and no case in two lists', () => {
    expect(Object.keys(cases).sort()).toEqual(['beta', 'rejected', 'stable']);
    for (const list of [cases.stable, cases.beta, cases.rejected]) expect(list.length).toBeGreaterThan(0);
    const all = [...cases.stable, ...cases.beta, ...cases.rejected];
    expect(new Set(all).size).toBe(all.length);
  });

  it.each([
    ['stable', STABLE, BETA],
    ['beta', BETA, STABLE],
  ] as const)('every %s case matches its pattern and not the other one', (list, own, other) => {
    for (const version of cases[list]) {
      expect(own.test(version), version).toBe(true);
      expect(other.test(version), version).toBe(false);
    }
  });

  it('every rejected case matches neither pattern', () => {
    for (const version of cases.rejected) {
      expect(STABLE.test(version) || BETA.test(version), JSON.stringify(version)).toBe(false);
    }
  });
});
