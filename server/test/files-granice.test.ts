/**
 * Boundaries of the session files directory (`server/src/files/`), checked on the code without comments
 * (`source-scan.ts`), like `herdr-background-boundary.test.ts`:
 * - the directory does not import a facade (the session manager, the router, the start, the configuration, the
 *   herdr driver) nor a route group, so the rule takes the session and the configuration through its ports;
 * - it opens files only through the work-area port (`server/src/folder-gate/disk.ts`), which opens a file in a guarded
 *   home folder in that folder's helper; the rule does not reach `server/src/safe-read.ts` itself. From `fs` it takes
 *   only the calls that list, describe and resolve (`readdir`, `lstat`, `stat`, `realpath`, and the synchronous
 *   `lstat`, `readlink`, `realpath` the work-area walk needs), never one that opens or reads a file, and it starts no
 *   process.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { relativeImports, scan, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(REPO, 'server/src/files');

const repoPath = (file: string): string => relative(REPO, file);
const read = (file: string): string => readFileSync(file, 'utf8');

const MODULES = tsFiles(DIR).map(repoPath);

const FACADES = [
  'server/src/sessions/manager.ts',
  'server/src/router.ts',
  'server/src/index.ts',
  'server/src/config.ts',
  'server/src/drivers/herdr-driver.ts',
];

/** The names a module of the directory may take from `fs` and `fs/promises` (type imports aside). */
const FS_ALLOWED = new Set(['readdir', 'lstat', 'stat', 'realpath', 'lstatSync', 'readlinkSync', 'realpathSync']);

const importsOf = (file: string): string[] => relativeImports(read(join(REPO, file)))
  .map((spec) => repoPath(resolve(dirname(join(REPO, file)), spec)));

/** Every value name a source takes from `fs` or `fs/promises`, a namespace or default import as `*`. */
function fsNames(source: string): string[] {
  const code = scan(source).code;
  const names: string[] = [];
  for (const hit of code.matchAll(/\bimport\s+(?!type\b)([\w$\s{},*]+?)\s+from\s+(['"])(?:node:)?fs(?:\/promises)?\2/gu)) {
    const clause = hit[1] ?? '';
    if (/\*\s*as\s/u.test(clause) || /^\s*[\w$]+\s*(?:,|$)/u.test(clause)) names.push('*');
    const named = /\{([^}]*)\}/u.exec(clause)?.[1] ?? '';
    for (const part of named.split(',')) {
      const spec = part.trim();
      if (spec === '' || spec.startsWith('type ')) continue;
      names.push(spec.split(/\s+as\s+/u)[0] ?? spec);
    }
  }
  if (/\b(?:import|require)\s*\(\s*['"`](?:node:)?fs/u.test(code)) names.push('dynamic');
  return names;
}

describe('session files: the directory exists', () => {
  it('has modules (without them no guard below defends anything)', () => {
    expect(MODULES).toContain('server/src/files/path-rule.ts');
  });
});

describe('session files: direction of dependencies', () => {
  it.each(MODULES)('%s imports no facade and no route group', (file) => {
    const imported = importsOf(file);
    expect(imported.filter((target) => FACADES.includes(target))).toEqual([]);
    expect(imported.filter((target) => target.startsWith('server/src/routes/'))).toEqual([]);
  });
});

describe('session files: one way to open a file', () => {
  it.each(MODULES)('%s takes from `fs` only what lists, describes and resolves', (file) => {
    expect(fsNames(read(join(REPO, file))).filter((name) => !FS_ALLOWED.has(name))).toEqual([]);
  });

  it.each(MODULES)('%s starts no process', (file) => {
    expect(scan(read(join(REPO, file))).code).not.toMatch(/['"](?:node:)?child_process['"]/u);
  });

  it('the rule opens through the work-area port, not through `safe-read.ts` past it', () => {
    const imported = importsOf('server/src/files/path-rule.ts');
    expect(imported).toContain('server/src/folder-gate/disk.ts');
    expect(imported).not.toContain('server/src/safe-read.ts');
  });

  it('the name check sees an open, an alias, a namespace, a default import and a dynamic import', () => {
    expect(fsNames("import { open } from 'node:fs/promises';")).toEqual(['open']);
    expect(fsNames("import { readFileSync as r, lstat } from 'fs';")).toEqual(['readFileSync', 'lstat']);
    expect(fsNames("import * as fs from 'node:fs';")).toEqual(['*']);
    expect(fsNames("import fs from 'node:fs';")).toEqual(['*']);
    expect(fsNames("const fs = await import('node:fs');")).toEqual(['dynamic']);
    expect(fsNames("import type { Dirent } from 'node:fs';\nimport { readdir } from 'node:fs/promises';"))
      .toEqual(['readdir']);
  });
});
