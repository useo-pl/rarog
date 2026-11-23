/**
 * `.gitleaksignore` pins gitleaks fingerprints `file:rule:line`, so a default `gitleaks dir` on the repo stays quiet
 * about the format 3 push-crypto vectors. gitleaks matches the fingerprint by line number only: once the vectors
 * file is rewritten and a `bannerKey` moves, the entry silences nothing and the hit comes back. Rule: the entries
 * are exactly the `bannerKey` lines of that file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from './private-guard.ts';

const IGNORE = '.gitleaksignore';
const VECTORS = 'shared/fixtures/push-crypto/vectors.v3.json';

/** Non-comment, non-empty lines of a `.gitleaksignore` text. */
function entriesOf(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
}

/** Fingerprints `file:generic-api-key:line` of every `bannerKey` line in a vectors text. */
function bannerKeyFingerprints(file: string, text: string): string[] {
  return text.split('\n').flatMap((line, index) => (
    /^\s*"bannerKey": "[0-9a-f]{64}",?$/u.test(line) ? [`${file}:generic-api-key:${String(index + 1)}`] : []
  ));
}

describe('.gitleaksignore', () => {
  it('lists exactly the bannerKey lines of the format 3 push-crypto vectors', () => {
    const entries = entriesOf(readFileSync(path.join(REPO, IGNORE), 'utf8'));
    const wanted = bannerKeyFingerprints(VECTORS, readFileSync(path.join(REPO, VECTORS), 'utf8'));
    expect(wanted.length).toBeGreaterThan(0);
    expect(entries).toEqual(wanted);
  });
});
