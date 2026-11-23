/**
 * Boundaries of the Inbox directory (`server/src/inbox/`), checked on the code without comments (`source-scan.ts`),
 * like `herdr-background-boundary.test.ts`:
 *
 * - no inbox module imports a facade (manager, herdr driver, router, server entry, config); it asks the session
 *   manager through its port;
 * - code outside the directory imports only `inbox/index.ts`;
 * - `card.ts` stays pure: no file system and no other inbox module, so the card of a session is a function of its
 *   summary and segments;
 * - only `removals.ts` writes to disk;
 * - the module map in the header of `index.ts` names every file of the directory and no other.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { relativeImports, scan, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(REPO, 'server/src');
const DIR = join(SRC, 'inbox');

const repoPath = (file: string): string => relative(REPO, file);
const read = (file: string): string => readFileSync(file, 'utf8');
const importsOf = (file: string): string[] => relativeImports(read(file))
  .map((spec) => repoPath(resolve(dirname(file), spec)));

const MODULES = tsFiles(DIR);
const FACADES = [
  'server/src/sessions/manager.ts', 'server/src/drivers/herdr-driver.ts', 'server/src/router.ts',
  'server/src/index.ts', 'server/src/config.ts',
];

describe('inbox: module boundaries', () => {
  it('no inbox module imports a facade', () => {
    const hits = MODULES.flatMap((file) => importsOf(file)
      .filter((target) => FACADES.includes(target))
      .map((target) => `${repoPath(file)} -> ${target}`));
    expect(hits).toEqual([]);
  });

  it('code outside the directory imports only inbox/index.ts', () => {
    const hits = tsFiles(SRC)
      .filter((file) => !file.startsWith(`${DIR}/`))
      .flatMap((file) => importsOf(file)
        .filter((target) => target.startsWith('server/src/inbox/') && target !== 'server/src/inbox/index.ts')
        .map((target) => `${repoPath(file)} -> ${target}`));
    expect(hits).toEqual([]);
  });

  it('card.ts reads no file and imports no other inbox module', () => {
    const file = join(DIR, 'card.ts');
    const code = scan(read(file)).code;
    expect(code).not.toMatch(/['"]node:fs/);
    expect(importsOf(file).filter((target) => target.startsWith('server/src/inbox/'))).toEqual([]);
  });

  it('only removals.ts writes to disk', () => {
    const writers = MODULES
      .filter((file) => /\b(?:writeFile|appendFile|rename|mkdir|unlink|rm)(?:Sync)?\s*\(/.test(scan(read(file)).code))
      .map(repoPath);
    expect(writers).toEqual(['server/src/inbox/removals.ts']);
  });

  it('the module map in index.ts names every file of the directory and no other', () => {
    const header = read(join(DIR, 'index.ts')).split('*/')[0] ?? '';
    const named = [...header.matchAll(/`([a-z-]+\.ts)`/g)].map((hit) => hit[1]).sort();
    const files = MODULES.map((file) => basename(file)).filter((name) => name !== 'index.ts').sort();
    expect(named).toEqual(files);
  });
});
