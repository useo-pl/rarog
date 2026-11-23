/**
 * Boundary of `server/src/sessions/`: modules split out of the session manager do not import `manager.ts`.
 *
 * The manager calls its modules (`state-sentences.ts`, `seen-marks.ts`, …) and passes them what they need.
 * An import in the other direction closes a cycle and lets the manager's state back into code that tests call
 * without a manager. The test is a grep over imports, like `herdr-background-boundary.test.ts`: a breaking change
 * shows up as a red test, not in review. Fix: pass the value as a parameter or move the shared type into the
 * module and let `manager.ts` import it from there.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { relativeImports, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(REPO, 'server/src/sessions');
const MANAGER = 'server/src/sessions/manager.ts';

const repoPath = (file: string): string => relative(REPO, file);

/** Modules of the directory as repo paths. */
const MODULES = tsFiles(DIR).map(repoPath);
/** Every module except the manager itself. */
const SPLIT = MODULES.filter((file) => file !== MANAGER);

/** Relative imports of a module, resolved to repo paths. */
function importsOf(file: string): string[] {
  const source = readFileSync(join(REPO, file), 'utf8');
  return relativeImports(source).map((spec) => repoPath(resolve(dirname(join(REPO, file)), spec)));
}

describe('sessions/: modules do not import manager.ts', () => {
  it('sees the directory, the manager and the split modules (otherwise the rule below is empty)', () => {
    expect(MODULES).toContain(MANAGER);
    expect(SPLIT).toContain('server/src/sessions/seen-marks.ts');
    expect(SPLIT).toContain('server/src/sessions/state-sentences.ts');
  });

  it('the import pattern sees imports (the manager imports its modules)', () => {
    expect(importsOf(MANAGER)).toContain('server/src/sessions/seen-marks.ts');
    expect(SPLIT.flatMap(importsOf).length).toBeGreaterThan(0);
  });

  it.each(SPLIT)('%s does not import manager.ts', (file) => {
    expect(importsOf(file), `${file} imports ${MANAGER}: pass the value in or move the type out`)
      .not.toContain(MANAGER);
  });
});
