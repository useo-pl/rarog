/**
 * Boundaries of the PR status directory (`server/src/pr-status/`), grep-style on code without comments
 * (`source-scan.ts`), like `companion-granice.test.ts`.
 *
 * - `gh` starts only from `pr-status/gh.ts`: it alone imports `node:child_process` in the directory, and no other
 *   server file sends a GraphQL query.
 * - The directory imports no facade: relative imports stay inside it, plus the variable registry (`config-env.ts`, the
 *   closed `gh` environment list), the scheduler type (`drivers/runtime.ts`, type only) and the address grammar of
 *   the conversation file reader (`herdr/background/pull-requests.ts`, a pure module, one definition of `PR_URL`).
 * - Callers outside the directory import only its entry, `pr-status/index.ts`, and the module map in its header
 *   names exactly the modules of the directory: no file without an entry, no entry without a file.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { relativeImports, scan, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(REPO, 'server/src');
const DIR = join(SRC, 'pr-status');
const GH = 'server/src/pr-status/gh.ts';
const ENTRY = 'server/src/pr-status/index.ts';
/** Files outside the directory that its modules may import. */
const ALLOWED_OUTSIDE = [
  'server/src/config-env.ts', 'server/src/drivers/runtime.ts', 'server/src/herdr/background/pull-requests.ts',
];
/** Of those, the ones imported as types only. */
const TYPE_ONLY = ['server/src/drivers/runtime.ts'];

const repoPath = (file: string): string => relative(REPO, file);
const read = (file: string): string => readFileSync(file, 'utf8');

const MODULES = tsFiles(DIR).map(repoPath);
/** Code (without comments) of every `server/src/**` file, under its path from the repo root. */
const CODE = new Map(tsFiles(SRC).map((file) => [repoPath(file), scan(read(file)).code]));

const importsOf = (file: string): string[] => relativeImports(read(join(REPO, file)))
  .map((spec) => repoPath(resolve(dirname(join(REPO, file)), spec)));

/**
 * Module map of the entry: the bullets of the leading doc comment of `index.ts`. `entries` are the names of the
 * bullets ``* - `name.ts`: …``; `unread` are the bullets in any other shape. Only that comment counts, so a module
 * named only in an `export … from` line has no entry. `null` when the source does not start with a doc comment.
 */
function headerBullets(entrySource: string): { entries: string[]; unread: string[] } | null {
  const header = /^\s*\/\*\*([\s\S]*?)\*\//.exec(entrySource);
  if (!header) return null;
  const entries: string[] = [];
  const unread: string[] = [];
  for (const hit of (header[1] ?? '').matchAll(/^[ \t]*\*[ \t]+-[ \t]+(.*)$/gm)) {
    const bullet = hit[1] ?? '';
    const name = /^`([^`]+)`:/.exec(bullet)?.[1];
    if (name === undefined) unread.push(bullet);
    else entries.push(name);
  }
  return { entries, unread };
}

/**
 * Problems between the module map in the header of `index.ts` and the files of the directory (paths relative to
 * it, `index.ts` included or not: the entry is not its own entry). Empty list = both sides agree.
 */
function moduleMapProblems(entrySource: string, files: readonly string[]): string[] {
  const map = headerBullets(entrySource);
  if (map === null || map.entries.length === 0) {
    return ['index.ts: no module map in the leading doc comment; list each module as a bullet "* - `name.ts`: …"'];
  }
  const { entries, unread } = map;
  const modules = files.filter((file) => file !== 'index.ts');
  return [
    // A bullet the parser cannot read could name a module that is gone, so it fails even when the rest agrees.
    ...unread.map((bullet) => `index.ts: bullet "${bullet}" is not in the shape "* - \`name.ts\`: …"`),
    ...modules.filter((file) => !entries.includes(file))
      .map((file) => `${file}: module without an entry in the header of index.ts; add "* - \`${file}\`: …"`),
    ...entries.filter((entry) => !modules.includes(entry))
      .map((entry) => `index.ts names \`${entry}\`, which is not a module of the directory; fix or remove the bullet`),
  ];
}

describe('pr-status: module map comparison', () => {
  const header = (bullets: string): string => `/**\n * PR status.\n *\n${bullets} */\nexport {} from './gh.ts';\n`;
  const MAP = header(
    ' * - `gh.ts`: the gh source;\n * - `source.ts`: the contract;\n *   continued line with `x.ts`: inside.\n',
  );

  it('agrees when every module has an entry and every entry a module', () => {
    expect(moduleMapProblems(MAP, ['gh.ts', 'index.ts', 'source.ts'])).toEqual([]);
  });

  it('flags a file of the directory without an entry', () => {
    expect(moduleMapProblems(MAP, ['gh.ts', 'index.ts', 'source.ts', 'extra.ts']))
      .toEqual([expect.stringMatching(/^extra\.ts: module without an entry/)]);
  });

  it('flags an entry without a file', () => {
    expect(moduleMapProblems(MAP, ['gh.ts', 'index.ts']))
      .toEqual([expect.stringMatching(/^index\.ts names `source\.ts`, which is not a module/)]);
  });

  it.each([
    ['an empty doc comment', '/**\n */\nexport {};\n'],
    ['no doc comment', "export { a } from './gh.ts';\n"],
    ['bullets without the `name.ts`: shape', header(' * - gh.ts: the gh source;\n * - source.ts — the contract;\n')],
  ])('flags a header with %s', (_, source) => {
    expect(moduleMapProblems(source, ['gh.ts', 'index.ts', 'source.ts']))
      .toEqual([expect.stringMatching(/^index\.ts: no module map/)]);
  });

  it('flags a bullet in another shape even when the other entries cover the directory', () => {
    const mixed = header(' * - `gh.ts`: a;\n * - `source.ts`: b;\n * - `removed.ts` — a module that is gone.\n');
    expect(moduleMapProblems(mixed, ['gh.ts', 'index.ts', 'source.ts']))
      .toEqual([expect.stringMatching(/^index\.ts: bullet "`removed\.ts` — a module that is gone\." is not in the/)]);
  });

  it('accepts a new module that has an entry', () => {
    const grown = header(' * - `gh.ts`: a;\n * - `source.ts`: b;\n * - `fresh.ts`: c.\n');
    expect(moduleMapProblems(grown, ['fresh.ts', 'gh.ts', 'index.ts', 'source.ts'])).toEqual([]);
  });

  it('reads only the header and does not ask an entry for `index.ts`', () => {
    const exportsOnly = `${header(' * - `gh.ts`: a;\n')}export { b } from './source.ts';\n`;
    expect(moduleMapProblems(exportsOnly, ['gh.ts', 'index.ts', 'source.ts']))
      .toEqual([expect.stringMatching(/^source\.ts: module without an entry/)]);
    expect(moduleMapProblems(exportsOnly, ['gh.ts', 'index.ts'])).toEqual([]);
  });
});

describe('pr-status: modules and entry', () => {
  it('the header of `index.ts` lists exactly the modules of the directory', () => {
    const files = tsFiles(DIR).map((file) => relative(DIR, file));
    expect(moduleMapProblems(read(join(REPO, ENTRY)), files)).toEqual([]);
  });

  it('code outside the directory imports only the entry', () => {
    const offenders = [...CODE.keys()]
      .filter((file) => !MODULES.includes(file))
      .flatMap((file) => importsOf(file)
        .filter((target) => target.startsWith('server/src/pr-status/') && target !== ENTRY)
        .map((target) => `${file} → ${target}`));
    expect(offenders).toEqual([]);
  });
});

describe('pr-status: gh starts from one place', () => {
  it('scanner sees the code (otherwise the checks below would be empty)', () => {
    expect(CODE.get(GH)).toContain('execFile(');
    expect(CODE.get(GH)).toContain("'graphql'");
  });

  it.each(MODULES.filter((file) => file !== GH))('%s does not import `node:child_process`', (file) => {
    expect(CODE.get(file)).not.toContain('node:child_process');
  });

  it('no other server file names a GraphQL call', () => {
    const others = [...CODE].filter(([file, code]) => file !== GH && /['"`]graphql['"`]/.test(code)).map(([file]) => file);
    expect(others).toEqual([]);
  });
});

describe('pr-status: direction of imports', () => {
  it.each(MODULES)('%s imports only its directory and the allowed files outside', (file) => {
    for (const target of importsOf(file)) {
      if (target.startsWith('server/src/pr-status/')) continue;
      expect(ALLOWED_OUTSIDE, `${file} imports ${target}`).toContain(target);
    }
  });

  it.each(MODULES)('%s imports the scheduler as a type only', (file) => {
    for (const line of (CODE.get(file) ?? '').split('\n')) {
      if (!TYPE_ONLY.some((target) => line.includes(`'../${relative(SRC, join(REPO, target))}'`))) continue;
      expect(line, file).toMatch(/^import type /);
    }
  });
});
