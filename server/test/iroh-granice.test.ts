/**
 * Granice modułu iroh (`server/src/iroh/`). Biblioteka natywna wchodzi do procesu tylko przez `adapter.ts`
 * (`require()` w chwili wywołania `loadIroh`, więc bez flagi nic się nie ładuje), a warstwa HTTP widzi z katalogu
 * tylko znacznik gniazda `socket.ts`, który sam niczego nie importuje. Testy są GREPOWE na kodzie bez komentarzy
 * (`source-scan.ts`), jak `herdr-commands-boundary.test.ts`; kod produkcyjny to `server/src/`, `shared/src/`, `bin/`
 * i `scripts/`. `import()` z nazwą w zmiennej i `createRequire` liczą tu tylko widok eksportu (`inExportView`); pliki
 * warstwy prywatnej liczy osobny test tej warstwy.
 *
 * Reguła `Origin` ma jedną definicję, `auth/origin.ts`: tylko tam stoi `originAllowList.includes`, a router,
 * upgrade terminala i sterowanie demo wołają `originAllowed(req, config)`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inExportView } from './private-guard.ts';
import { nonLiteralImports, relativeImports, repoFiles, scan } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Nazwa paczki z kawałków: strażnik nie niesie napisu, którego szuka. */
const PACKAGE = ['@number0', 'iroh'].join('/');
const ADAPTER = 'server/src/iroh/adapter.ts';
const SOCKET = 'server/src/iroh/socket.ts';
const PRODUCTION = /^(?:server\/src|shared\/src|bin|scripts)\//;
const CODE_EXT = /\.[cm]?[jt]s$/;

/** Kod produkcyjny bez komentarzy, pod ścieżką względem korzenia repo. */
const CODE = new Map(
  repoFiles(REPO)
    .filter((file) => PRODUCTION.test(file) && CODE_EXT.test(file))
    .map((file) => [file, scan(readFileSync(join(REPO, file), 'utf8')).code]),
);

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Failure message of a boundary check: what broke, why the boundary exists, what to do. */
const explain = (broken: string, why: string, fix: string): string => `${broken}\nWhy: ${why}\nFix: ${fix}`;
const WHY_ADAPTER = 'the native iroh library enters the server process only through the call-time `require()` in '
  + '`adapter.ts`, so with iroh off nothing native loads and a missing platform package cannot break the server.';

/**
 * Narzędzia w osobnym procesie, które ładują bibliotekę same (`createRequire`), każde z powodem. Kod produkcyjny ich
 * nie importuje (test niżej), więc przez nie biblioteka nie wchodzi do procesu serwera.
 */
const STANDALONE: Readonly<Record<string, string>> = {
  'scripts/relay-canary.mjs': 'kanarek relaya iroh: osobny proces z CI albo z terminala, klient relaya jak apka',
};
const inServer = ([file]: readonly [string, string]): boolean => !(file in STANDALONE);

/**
 * Pliki, które wymieniają paczkę jako zależność, ale jej nie ładują (bez `createRequire` i bez `import()` z jej
 * nazwą, test niżej), każdy z powodem.
 */
const NAME_ONLY: Readonly<Record<string, string>> = {
  'scripts/package.mjs': 'pakowacz paczki npm: iroh w grupie zależności z rejestru, poza listą dołączanych',
};

/**
 * `import(…)` z argumentem innym niż literał: znane wywołania, każde z powodem. Nowe takie wywołanie mogłoby
 * załadować bibliotekę z nazwy w zmiennej, z pominięciem `adapter.ts`. Liczy widok eksportu (`inExportView`), jak
 * strażniki z `private-guard.ts`; pliki warstwy prywatnej liczy osobny test tej warstwy.
 */
const DYNAMIC_IMPORTS: Readonly<Record<string, number>> = {
  // `work-area.mjs` beside the hook file (`new URL(…, import.meta.url)`), the hook boundary guard checks the name.
  'scripts/hooks/rarog-context.mjs': 1,
  'scripts/hooks/rarog-pending.mjs': 4, // moduły hooka obok pliku (`new URL(…, import.meta.url)`), strażnik hooka
  'server/src/install/sdk.ts': 1, // SDK Claude po jawnej ścieżce w katalogu danych (`importSdkFrom`), sdk-boundary
  // A named demo content set from the set directory of the install (`loadDemoSet`); the name has `DEMO_SET_NAME` shape.
  'server/src/demo/content/named-set.ts': 1,
  // The folder helper loads its own module from the path the start command passes (`process.argv[1]`).
  'server/src/folder-gate/helper.ts': 1,
};

describe('granice iroh: biblioteka natywna', () => {
  it('kod produkcyjny jest i obejmuje moduły iroh', () => {
    expect([...CODE.keys()], explain(
      'The production code scan misses the iroh modules or the server entry point.',
      'every boundary below reads this scan; an empty or partial scan would pass them all.',
      'fix `PRODUCTION`, `CODE_EXT` or the paths here after a move or rename.',
    )).toEqual(expect.arrayContaining([ADAPTER, SOCKET, 'shared/src/iroh.ts', 'server/src/index.ts']));
  });

  it('nazwa paczki w kodzie produkcyjnym tylko w `adapter.ts` (poza narzędziami w osobnym procesie)', () => {
    const holders = [...CODE].filter(inServer).filter(([file]) => !(file in NAME_ONLY))
      .filter(([, code]) => code.includes(PACKAGE)).map(([file]) => file);
    expect(holders, explain(
      'The iroh package name appears in production code outside `adapter.ts` (list below).',
      WHY_ADAPTER,
      'call the adapter (`loadIroh`) instead of naming the package. A tool that runs in its own process and loads '
        + 'the package itself goes into `STANDALONE`; a file that only lists it as a dependency goes into `NAME_ONLY`; '
        + 'each entry needs a reason.',
    )).toEqual([ADAPTER]);
  });

  it('pliki z samą nazwą paczki: nazwa jest, ładowania nie ma', () => {
    const quoted = `['"\`]${escape(PACKAGE)}['"\`]`;
    for (const file of Object.keys(NAME_ONLY)) {
      const code = CODE.get(file) ?? '';
      expect(code.includes(PACKAGE), explain(
        `${file}: \`NAME_ONLY\` entry, but the file no longer names the package.`,
        'a stale entry would silently allow a future file at this path.',
        'remove the entry.',
      )).toBe(true);
      expect(code, explain(
        `${file}: listed in \`NAME_ONLY\` (names the package only), but loads it with \`import()\` or \`require()\`.`,
        WHY_ADAPTER,
        'load through `adapter.ts`; a tool in its own process moves to `STANDALONE` with a reason.',
      )).not.toMatch(new RegExp(`\\b(?:import|require)\\(\\s*${quoted}`));
      expect(code, explain(
        `${file}: listed in \`NAME_ONLY\`, but uses \`createRequire\`, which can load the package by name.`,
        WHY_ADAPTER,
        'load through `adapter.ts`; a tool in its own process moves to `STANDALONE` with a reason.',
      )).not.toMatch(/\bcreateRequire\b/);
    }
  });

  it('narzędzia w osobnym procesie: każde ładuje bibliotekę i żaden plik produkcyjny ich nie importuje', () => {
    for (const file of Object.keys(STANDALONE)) {
      const code = CODE.get(file) ?? '';
      expect(code.includes(PACKAGE) && /\bcreateRequire\b/.test(code), explain(
        `${file}: \`STANDALONE\` entry, but the file does not load the package with \`createRequire\`.`,
        'the exception covers only tools that load the library in their own process.',
        'remove the entry, or move it to `NAME_ONLY` when the file only names the package.',
      )).toBe(true);
    }
    const importers: string[] = [];
    for (const file of CODE.keys()) {
      for (const spec of relativeImports(readFileSync(join(REPO, file), 'utf8'))) {
        const target = posix.normalize(posix.join(posix.dirname(file), spec));
        if (target in STANDALONE) importers.push(`${file} → ${target}`);
      }
    }
    expect(importers, explain(
      'Production code imports a standalone tool (list below: importer → tool).',
      'a standalone tool loads the native library itself; importing it pulls the library into the server process '
        + 'past `adapter.ts`.',
      'move the shared code into a module that both import, and keep the tool a leaf.',
    )).toEqual([]);
  });

  it('`adapter.ts`: paczka tylko w `require()`, `typeof import()` i stałej, bez importu statycznego', () => {
    const code = CODE.get(ADAPTER) ?? '';
    const quoted = `'${escape(PACKAGE)}'`;
    const load = new RegExp(`\\bcreateRequire\\(import\\.meta\\.url\\)\\(${quoted}\\)`, 'g');
    expect(code.match(load) ?? [], explain(
      '`adapter.ts` must load the package with exactly one call-time `createRequire(import.meta.url)(…)` (used by '
        + '`loadIroh`).',
      WHY_ADAPTER,
      'keep a single `require()` of the package for `loadIroh` and reuse its result.',
    )).toHaveLength(1);
    const rest = code
      .replace(new RegExp(`\\btypeof import\\(${quoted}\\)`, 'g'), '')
      .replace(load, '')
      .replace(new RegExp(`\\bIROH_PACKAGE = ${quoted}`), '');
    expect(rest.includes(PACKAGE), explain(
      '`adapter.ts` names the package outside the allowed shapes: call-time `require()`, `typeof import()` and the '
        + '`IROH_PACKAGE` constant.',
      'a static import would load the native library at server start, even with iroh off.',
      'use the type through `typeof import()` and load only in `loadIroh`.',
    )).toBe(false);
  });

  it('`import()` z argumentem innym niż literał tylko w znanych miejscach', () => {
    const found = Object.fromEntries(
      [...CODE].filter(([file]) => inExportView(file)).map(([file, code]) => [file, nonLiteralImports(code)] as const)
        .filter(([, count]) => count > 0),
    );
    expect(found, explain(
      '`import()` calls with a non-literal argument differ from `DYNAMIC_IMPORTS` (count per file).',
      'such a call can load the native library from a name held in a variable, past `adapter.ts`.',
      'use a literal specifier. A new call that cannot be literal: add the file and its count with a reason; '
        + 'a removed call: lower the count or remove the entry.',
    )).toEqual(DYNAMIC_IMPORTS);
  });

  it('`createRequire` w kodzie produkcyjnym tylko w `adapter.ts` (poza narzędziami w osobnym procesie)', () => {
    const holders = [...CODE].filter(inServer).filter(([file]) => inExportView(file))
      .filter(([, code]) => /\bcreateRequire\b/.test(code)).map(([file]) => file);
    expect(holders, explain(
      '`createRequire` appears in production code outside `adapter.ts` (list below).',
      `\`createRequire\` can load the package by name; ${WHY_ADAPTER}`,
      'load through `adapter.ts`; a tool in its own process goes into `STANDALONE` with a reason.',
    )).toEqual([ADAPTER]);
  });

  it('licznik `import()` widzi wywołanie z nazwą w zmiennej, a pomija literał', () => {
    expect(nonLiteralImports("const name = 'x';\nawait import(name);")).toBe(1);
    expect(nonLiteralImports('await import(`./${name}.js`);')).toBe(1);
    expect(nonLiteralImports("await import('./a.ts'); type T = typeof import('b');")).toBe(0);
  });
});

describe('granice iroh: warstwa HTTP widzi tylko znacznik gniazda', () => {
  const CONSUMERS = /^server\/src\/(?:auth\/|term\/|routes\/|router\.ts$|device-effects\.ts$)/;

  it('`auth/`, `term/`, `router.ts` i `device-effects.ts` importują z `iroh/` wyłącznie `socket.ts`', () => {
    const consumers = [...CODE.keys()].filter((file) => CONSUMERS.test(file));
    expect(consumers, explain(
      '`CONSUMERS` no longer matches `router.ts` and `device-effects.ts`.',
      'with no consumers matched, the import check below passes on nothing.',
      'update `CONSUMERS` after a move or rename.',
    )).toEqual(expect.arrayContaining(['server/src/router.ts', 'server/src/device-effects.ts']));
    const violations: string[] = [];
    for (const file of consumers) {
      for (const spec of relativeImports(readFileSync(join(REPO, file), 'utf8'))) {
        const target = posix.normalize(posix.join(posix.dirname(file), spec));
        if (target.startsWith('server/src/iroh/') && target !== SOCKET) violations.push(`${file} → ${target}`);
      }
    }
    expect(violations, explain(
      'The HTTP layer imports from `server/src/iroh/` beyond `socket.ts` (list below: importer → target).',
      'the HTTP layer sees only the socket marker, so it cannot pull the native library in transitively.',
      'import the marker from `socket.ts`; a type the HTTP layer needs moves to `socket.ts`, which imports nothing.',
    )).toEqual([]);
  });

  it('`socket.ts` niczego nie importuje (warstwa HTTP nie dociąga biblioteki przechodnio)', () => {
    const code = CODE.get(SOCKET) ?? '';
    const message = explain(
      '`socket.ts` imports or requires a module.',
      'the HTTP layer imports `socket.ts`; any import here could reach the native library transitively.',
      'keep `socket.ts` import-free; move the code that needs the import to another module of `server/src/iroh/`.',
    );
    expect(code, message).not.toMatch(/\bimport\b/);
    expect(code, message).not.toMatch(/\brequire\s*\(/);
  });
});

describe('granice iroh: reguła `Origin` w jednym miejscu', () => {
  const ORIGIN_RULE = 'server/src/auth/origin.ts';
  const CALLERS = ['server/src/router.ts', 'server/src/term/ws.ts', 'server/src/demo/control.ts'];

  it('`originAllowList.includes` tylko w `auth/origin.ts`', () => {
    const holders = [...CODE].filter(([, code]) => /\boriginAllowList\s*\.\s*includes\b/.test(code)).map(([file]) => file);
    expect(holders, explain(
      '`originAllowList.includes` appears outside `auth/origin.ts` (list below).',
      'the `Origin` rule has one definition, so the router, the terminal upgrade and demo control cannot drift apart.',
      'call `originAllowed(req, config)` from `auth/origin.ts` instead of checking the list.',
    )).toEqual([ORIGIN_RULE]);
  });

  it('router, upgrade terminala i sterowanie demo wołają `originAllowed(req, config)`', () => {
    for (const file of CALLERS) {
      expect(CODE.get(file) ?? '', explain(
        `${file}: does not call \`originAllowed(req, config)\`.`,
        'every entry point that accepts a browser request checks `Origin` with the one rule in `auth/origin.ts`.',
        'call `originAllowed(req, config)`; after a move, update `CALLERS`.',
      )).toMatch(/\boriginAllowed\(req, config\)/);
    }
  });
});
