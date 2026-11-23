/*
 * `scripts/l10n-add.mjs`: one command adds a text key to a copy package's String Catalog with an `en` and a `pl`
 * value and a translator comment (`docs/localization.md`, "Adding a text"), so an agent does not open the catalog.
 *
 * Every case runs on copies in a temporary directory: the real catalog of RarogUI (the large one) for the sorted
 * place and the "only the new entry" diff, and the real catalog and sources of RarogCore for the round trip through
 * `scripts/l10n-check.mjs`. The real catalogs are never written. One case runs the script through `node`, as an
 * agent calls it.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO, 'scripts', 'l10n-add.mjs');
const CHECK = path.join(REPO, 'scripts', 'l10n-check.mjs');
const PACKAGES = 'native/Rarog/Packages';
const catalogOf = (name: string): string => `${PACKAGES}/${name}/Sources/${name}/Copy/Localizable.xcstrings`;

interface Io { root?: string; stdout?: (text: string) => void; stderr?: (text: string) => void }
interface AddModule { main: (argv: string[], io?: Io) => number }
interface CheckModule { repoProblems: (root: string) => { problems: string[]; catalogs: number } }
const l10nAdd = await import(pathToFileURL(SCRIPT).href) as AddModule;
const l10nCheck = await import(pathToFileURL(CHECK).href) as CheckModule;

const temporary: string[] = [];
afterAll(() => {
  for (const made of temporary.splice(0)) rmSync(made, { recursive: true, force: true });
});
const tempRoot = (): string => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'rarog-l10n-add-')));
  temporary.push(dir);
  return dir;
};

/** A temporary repo with copies of the named packages' `Sources/<name>` (catalog, `L.swift`, registry). */
const repoWith = (...names: string[]): string => {
  const root = tempRoot();
  for (const name of names) {
    const sources = `${PACKAGES}/${name}/Sources/${name}`;
    cpSync(path.join(REPO, sources), path.join(root, sources), { recursive: true });
  }
  return root;
};

/** `main` with `root`; returns the exit code and both streams. */
const run = (root: string, argv: string[]) => {
  let out = '';
  let err = '';
  const code = l10nAdd.main(argv, { root, stdout: (text) => { out += text; }, stderr: (text) => { err += text; } });
  return { code, out, err };
};

const keysOf = (text: string): string[] => Object.keys((JSON.parse(text) as { strings: object }).strings);
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe('l10n-add: a new key', () => {
  it('lands in its sorted place with en, pl and the comment, and the diff is only the new entry', () => {
    const root = repoWith('RarogUI');
    const file = path.join(root, catalogOf('RarogUI'));
    const before = readFileSync(file, 'utf8');
    const key = 'composer.l10nAddProbe';
    expect(keysOf(before)).not.toContain(key);

    const result = run(root, ['RarogUI', key, '--en', 'Sent %@.', '--pl', 'Wysłano %@.',
      '--comment', 'Composer status line. Parameter: %@ the file name.']);
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(result.out).toContain(`"${key}"`);
    expect(result.out).toContain(`L("${key}"`);

    const after = readFileSync(file, 'utf8');
    const keys = keysOf(after);
    expect(keys).toEqual([...keysOf(before), key].sort(byCodeUnit));
    const at = keys.indexOf(key);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(keys.length - 1);

    // Line diff: the common head and tail are the whole old file, the middle is exactly the new entry.
    const old = before.split('\n');
    const now = after.split('\n');
    let head = 0;
    while (old[head] === now[head]) head++;
    let tail = 0;
    while (tail < old.length - head && old.at(-1 - tail) === now.at(-1 - tail)) tail++;
    expect(head + tail).toBe(old.length);
    expect(now.slice(head, now.length - tail).join('\n')).toBe([
      `    "${key}" : {`,
      '      "comment" : "Composer status line. Parameter: %@ the file name.",',
      '      "extractionState" : "manual",',
      '      "localizations" : {',
      '        "en" : {',
      '          "stringUnit" : {',
      '            "state" : "translated",',
      '            "value" : "Sent %@."',
      '          }',
      '        },',
      '        "pl" : {',
      '          "stringUnit" : {',
      '            "state" : "translated",',
      '            "value" : "Wysłano %@."',
      '          }',
      '        }',
      '      }',
      '    },',
    ].join('\n'));
  });

  it('refuses a key that already exists and leaves the catalog untouched', () => {
    const root = repoWith('RarogCore');
    const file = path.join(root, catalogOf('RarogCore'));
    const before = readFileSync(file, 'utf8');
    const result = run(root, ['RarogCore', 'core.noConnection', '--en', 'Offline.', '--pl', 'Offline.',
      '--comment', 'Gate refusal.']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('"core.noConnection" already exists');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('l10n-add: the result against l10n-check', () => {
  it('passes with a Swift source that calls the key; without the call the dead-key rule rejects only that key', () => {
    const root = repoWith('RarogCore');
    expect(l10nCheck.repoProblems(root)).toMatchObject({ problems: [], catalogs: 1 });

    const key = 'core.l10nAddProbe';
    const result = run(root, ['RarogCore', key, '--en', 'The server has %lld sessions.',
      '--pl', 'Serwer ma %lld sesji.', '--comment', 'Gate refusal. Parameter: %lld the session count.']);
    expect(result.code).toBe(0);

    const relative = catalogOf('RarogCore');
    expect(l10nCheck.repoProblems(root).problems).toEqual([
      `${relative}: "${key}" — no L("…") in package RarogCore uses this key`,
    ]);

    const registry = path.join(root, `${PACKAGES}/RarogCore/Sources/RarogCore/Copy/L10nAddProbe.swift`);
    writeFileSync(registry, `enum L10nAddProbe {\n    static func sessions(_ count: Int) -> String { L("${key}", count) }\n}\n`);
    expect(l10nCheck.repoProblems(root)).toMatchObject({ problems: [], catalogs: 1 });
  });

  it('refuses values whose parameters differ between languages and writes nothing', () => {
    const root = repoWith('RarogCore');
    const file = path.join(root, catalogOf('RarogCore'));
    const before = readFileSync(file, 'utf8');
    const mismatch = run(root, ['RarogCore', 'core.l10nAddProbe', '--en', 'Sent %@.', '--pl', 'Wysłano.',
      '--comment', 'Probe.']);
    expect(mismatch.code).toBe(1);
    expect(mismatch.err).toContain('parameters none ≠ en: 1:@');
    const percent = run(root, ['RarogCore', 'core.l10nAddProbe', '--en', '100%% done', '--pl', '100%% gotowe',
      '--comment', 'Probe.']);
    expect(percent.code).toBe(1);
    expect(percent.err).toContain('"%%" in a sentence without parameters');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('l10n-add: arguments and packages', () => {
  it('exits 2 on a missing value, comment or key, and on a key that breaks the key shape', () => {
    const root = repoWith('RarogCore');
    expect(run(root, ['RarogCore', 'core.x', '--en', 'A.', '--pl', 'A.']).code).toBe(2);
    expect(run(root, ['RarogCore', 'core.x', '--en', '', '--pl', 'A.', '--comment', 'C.']).code).toBe(2);
    expect(run(root, ['RarogCore', '--en', 'A.', '--pl', 'A.', '--comment', 'C.']).code).toBe(2);
    const shape = run(root, ['RarogCore', 'core x', '--en', 'A.', '--pl', 'A.', '--comment', 'C.']);
    expect(shape.code).toBe(2);
    expect(shape.err).toContain('area.name');
  });

  it('refuses the server sentence catalog and a package without a copy catalog, naming the copy packages', () => {
    const root = repoWith('RarogCore', 'RarogContract');
    const server = run(root, ['RarogContract', 'server.x', '--en', 'A.', '--pl', 'A.', '--comment', 'C.']);
    expect(server.code).toBe(2);
    expect(server.err).toContain('scripts/sentences-catalog.mjs');
    const unknown = run(root, ['RarogNope', 'nope.x', '--en', 'A.', '--pl', 'A.', '--comment', 'C.']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('RarogCore');
  });

  it('refuses a catalog that is not in the layout Xcode writes, so the diff stays one entry', () => {
    const root = repoWith('RarogCore');
    const file = path.join(root, catalogOf('RarogCore'));
    const compact = JSON.stringify(JSON.parse(readFileSync(file, 'utf8')));
    writeFileSync(file, compact);
    const result = run(root, ['RarogCore', 'core.l10nAddProbe', '--en', 'A.', '--pl', 'A.', '--comment', 'C.']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('layout');
    expect(readFileSync(file, 'utf8')).toBe(compact);
  });

  it('runs through node and prints the next step', () => {
    const root = repoWith('RarogCore');
    mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
    for (const name of ['l10n-add.mjs', 'l10n-check.mjs', 'lib/is-main.mjs']) {
      cpSync(path.join(REPO, 'scripts', name), path.join(root, 'scripts', name));
    }
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'l10n-add.mjs'), 'RarogCore',
      'core.l10nAddProbe', '--en', 'Done.', '--pl', 'Gotowe.', '--comment', 'Probe.'], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('node scripts/l10n-check.mjs');
    expect(keysOf(readFileSync(path.join(root, catalogOf('RarogCore')), 'utf8'))).toContain('core.l10nAddProbe');
  });
});
