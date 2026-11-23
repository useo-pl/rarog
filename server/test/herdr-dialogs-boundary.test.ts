/**
 * Granice katalogu dialogów (`server/src/herdr/dialogs/`) — kierunek importów i mapa modułów.
 *
 * Katalog trzyma reguły „co stoi na ekranie, jaka karta i co wolno z niej zatwierdzić" jako funkcje nad
 * jawnymi argumentami. Ma to sens tylko wtedy, gdy strzałka idzie w JEDNĄ stronę: fasada drivera, manager
 * i nadzorca wołają katalog, katalog nie zna żadnego z nich. Import w drugą stronę wpuściłby do czystych
 * modułów stan panelu, którego nie da się podać w teście. Testy są GREPOWE, jak
 * `herdr-background-boundary.test.ts`: łamiąca zmiana ma się pokazać jako czerwony test, a nie w review.
 *
 * Podkatalogi mają tu te same reguły co reszta katalogu (kierunek importów, wpis w obu mapach). Warstwa 1
 * (`layer1/`) ma ponad nie własne zakazy: bez transkryptu i modułów drivera herdr, a `shadow/` bez `layer1/`
 * (`layer1-granica.test.ts`).
 *
 * Opis katalogu: `docs/dialogs.md`, sekcja „Module map".
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { relativeImports, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(REPO, 'server/src/herdr/dialogs');
const INDEX = 'server/src/herdr/dialogs/index.ts';
const DOC = 'docs/dialogs.md';

const repoPath = (file: string): string => relative(REPO, file);
const read = (file: string): string => readFileSync(join(REPO, file), 'utf8');

/** Failure message of a boundary check: what broke, why the boundary exists, what to do. */
const explain = (broken: string, why: string, fix: string): string => `${broken}\nWhy: ${why}\nFix: ${fix}`;
const WHY_DIRECTION = 'the dialogs directory holds rules as functions over explicit arguments. The driver facade, the '
  + 'manager and the supervisor call it, it knows none of them: an import the other way lets pane state into pure '
  + 'modules that a test cannot supply.';
const WHY_MAP = `\`${INDEX}\` holds the per-file module map and \`${DOC}\` ("Module map") names the subdirectories; `
  + 'an agent finds a module through these maps, so a missing or stale entry sends it to the wrong place.';
const WHY_SCAN = 'with no modules or imports found, every guard below passes on nothing.';

/** Moduły katalogu (także w podkatalogach) jako ścieżki względem korzenia repo. */
const MODULES = tsFiles(DIR).map(repoPath);

/** Importowane ścieżki względne (`relativeImports`), rozwiązane do ścieżek repo. */
function importsOf(file: string): string[] {
  return relativeImports(read(file)).map((spec) => repoPath(resolve(dirname(join(REPO, file)), spec)));
}

describe('katalog dialogów: istnieje i ma wejście', () => {
  it('ma moduły i `index.ts` (bez nich żaden strażnik niżej niczego nie broni)', () => {
    const message = explain(
      `server/src/herdr/dialogs/ is missing, has a single module or has no \`${INDEX}\`.`,
      WHY_SCAN,
      'after a move, update `DIR` and `INDEX`.',
    );
    expect(MODULES.length, message).toBeGreaterThan(1);
    expect(MODULES, message).toContain(INDEX);
  });
});

describe('katalog dialogów: kierunek zależności', () => {
  const FORBIDDEN = [
    'server/src/drivers/herdr-driver.ts',
    'server/src/sessions/manager.ts',
    'server/src/herdr/supervisor.ts',
  ];

  it('wzorzec importów widzi importy (inaczej zakazy niżej byłyby puste)', () => {
    const message = explain(
      'The import scan finds no relative import in the dialogs directory or in its `index.ts`.',
      WHY_SCAN,
      'check `relativeImports` in `server/test/source-scan.ts`.',
    );
    expect(MODULES.flatMap(importsOf).length, message).toBeGreaterThan(0);
    expect(importsOf(INDEX).length, message).toBeGreaterThan(0);
  });

  it('wzorzec importów widzi każdy kształt: `from`, reeksport, import dla efektu i dynamiczny', () => {
    const source = [
      "import { a } from './a.ts';",
      "import type { B } from '../b.ts';",
      "export * from './c.ts';",
      "import '../../drivers/herdr-driver.ts';",
      "const e = await import('./index.ts');",
      'const f = await import(`../../jsonl-pending.ts`);',
      "import { readFileSync } from 'node:fs';",
    ].join('\n');
    expect(relativeImports(source), explain(
      '`relativeImports` no longer sees every import shape: `from`, re-export, side-effect import, dynamic import.',
      'a shape the scan misses lets a forbidden import through unnoticed.',
      'fix `relativeImports` in `server/test/source-scan.ts`, not the expected list.',
    )).toEqual([
      './a.ts', '../b.ts', './c.ts', '../../drivers/herdr-driver.ts', './index.ts', '../../jsonl-pending.ts',
    ]);
  });

  it.each(MODULES)('%s nie importuje fasady drivera, managera ani nadzorcy', (file) => {
    for (const imported of importsOf(file)) {
      expect(FORBIDDEN, explain(
        `${file} imports ${imported}.`,
        WHY_DIRECTION,
        'take the value as an argument from the caller, or move the shared type or rule into the dialogs directory '
          + 'and let the facade, the manager or the supervisor import it from there.',
      )).not.toContain(imported);
    }
  });

  it.each(MODULES.filter((file) => file !== INDEX))('%s nie importuje `index.ts` katalogu', (file) => {
    // Moduły katalogu biorą się nawzajem wprost z pliku: przez `index.ts` zamknęłyby cykl importów.
    expect(importsOf(file), explain(
      `${file} imports the directory's \`${INDEX}\`.`,
      '`index.ts` re-exports the modules of the directory, so a module importing it closes an import cycle.',
      'import the module that holds the value directly from its file.',
    )).not.toContain(INDEX);
  });
});

describe('katalog dialogów: mapa modułów', () => {
  const doc = read(DOC);

  /** Sekcja „Module map" dokumentu — od nagłówka do następnego `## `. */
  function moduleMap(): string {
    const start = doc.indexOf('\n## Module map');
    expect(start, explain(
      `${DOC} has no "## Module map" section.`,
      WHY_MAP,
      'restore the section (heading `## Module map`) or, after a rename, update this test together with the '
        + 'references to it.',
    )).toBeGreaterThan(-1);
    const rest = doc.slice(start + 1);
    const end = rest.indexOf('\n## ');
    return rest.slice(0, end === -1 ? undefined : end);
  }

  /** Podkatalogi katalogu dialogów (`screen/`, `decide/`…): dokument wymienia je, listę plików trzyma `index.ts`. */
  const SUBDIRS = [...new Set(MODULES
    .map((file) => relative(DIR, join(REPO, file)))
    .filter((name) => name.includes('/'))
    .map((name) => `${name.slice(0, name.indexOf('/'))}/`))].sort();

  it('katalog ma podkatalogi (inaczej test niżej niczego nie sprawdza)', () => {
    expect(SUBDIRS.length, explain(
      'The dialogs directory has fewer than two subdirectories.',
      'the map check below runs once per subdirectory; with none found it passes on nothing.',
      'after a move, update `DIR`.',
    )).toBeGreaterThan(1);
  });

  it.each(SUBDIRS)('podkatalog %s stoi w mapie modułów dokumentu', (sub) => {
    expect(moduleMap(), explain(
      `${DOC}: the "Module map" section does not name \`${sub}\`.`,
      WHY_MAP,
      `add a bullet \`${sub}\`: <what it holds> to the subdirectory list of "Module map" in ${DOC}.`,
    )).toContain(`\`${sub}\``);
  });

  it('mapa dokumentu odsyła do mapy plików w `index.ts`, zamiast ją powtarzać', () => {
    expect(moduleMap(), explain(
      `${DOC}: the "Module map" section does not point to \`${INDEX}\`.`,
      `${WHY_MAP} The file list lives once, in \`${INDEX}\`.`,
      `name \`${INDEX}\` in "Module map" instead of listing the files there.`,
    )).toContain(`\`${INDEX}\``);
  });

  it('mapa dokumentu nie wymienia pliku katalogu, którego już nie ma', () => {
    const listed = [...moduleMap().matchAll(/`(server\/src\/herdr\/dialogs\/[^`]+\.ts)`/g)].map((hit) => hit[1] ?? '');
    expect(listed.length, explain(
      `${DOC}: the "Module map" section names no file of server/src/herdr/dialogs/.`,
      'with no file found, the stale-entry check below passes on nothing.',
      `keep at least the \`${INDEX}\` reference in "Module map".`,
    )).toBeGreaterThan(0);
    for (const file of listed) {
      expect(MODULES, explain(
        `${DOC}: "Module map" names ${file}, which does not exist.`,
        WHY_MAP,
        `put the new path in "Module map" of ${DOC}, or remove the mention when the module is gone.`,
      )).toContain(file);
    }
  });

  it('mapa w `index.ts` wymienia każdy plik katalogu', () => {
    const header = read(INDEX);
    for (const file of MODULES) {
      const name = relative(DIR, join(REPO, file));
      expect(header, explain(
        `${INDEX}: the module map in the header does not name \`${name}\`.`,
        WHY_MAP,
        `add \`${name}\` with one line on what it holds to the module map at the top of ${INDEX}.`,
      )).toContain(`\`${name}\``);
    }
  });
});
