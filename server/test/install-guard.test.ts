/**
 * Granice katalogu instalacji (`server/src/install/`): wiedza „gdzie leży instalacja i jaką komendą ją naprawić”
 * zostaje w jednym miejscu. Opis katalogu i reguł: `docs/distribution.md`, „Install modes and the CLI module map”.
 *
 * Reguły:
 * 1. korzeń z `import.meta` liczy tylko `install/` (`mode.ts`); poza nim `import.meta` w kodzie `server/src` stoi
 *    wyłącznie w {@link IMPORT_META_WYJATKI};
 * 2. literały komend naprawczych ({@link KOMENDY}) w napisach `server/src` stoją tylko w `install/repair.ts`
 *    (komentarze i teksty demo `server/src/demo/` poza zliczaniem), a w kodzie `scripts/restart.sh` tylko w liniach
 *    {@link RESTART_WYJATKI}: zdanie naprawy hooka skrypt dostaje parametrem `RAROG_RESTART_HOOK_REPAIR`;
 * 3. literał `.ts` w `new URL(…, import.meta.url)` i w ścieżce `new Worker(…)` poza `install/` jest zakazany: kod
 *    zbudowany do JavaScriptu nie ma plików `.ts`, a takiego napisu przepisanie rozszerzeń importów nie dotyka;
 * 4. `install/` importuje tylko `node:*`, `@rarog/shared` i własne moduły, więc serwer i komendy `rarog` mogą go
 *    importować bez wciągania `cli/`.
 *
 * Listy wyjątków są zamknięte: wpis ma powód, a wpis bez trafienia (martwy) jest błędem.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tsTextLiterals } from './product-identity.ts';
import { repoFiles, scan } from './source-scan.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INSTALL = 'server/src/install/';
const REPAIR = 'server/src/install/repair.ts';
const DEMO = 'server/src/demo/';
const RESTART = 'scripts/restart.sh';

/**
 * Komendy naprawcze, które zależą od trybu instalacji: komendy klonu repo i komendy menedżera paczki npm
 * (instalacja, aktualizacja i odinstalowanie globalne npm albo pnpm).
 */
const KOMENDY = new RegExp([
  String.raw`pnpm run\b`, String.raw`pnpm install\b`, String.raw`node bin/rarog\.mjs`,
  String.raw`npm (?:i|install|uninstall|rm) -g\b`, String.raw`pnpm (?:add|remove|rm) -g\b`,
].join('|'), 'u');

const read = (plik: string): string => readFileSync(path.join(REPO, plik), 'utf8');
const ZRODLA = repoFiles(REPO, 'server/src').filter((plik) => /\.(?:ts|mts)$/u.test(plik)).sort();

interface ImportMetaWyjatek {
  readonly plik: string;
  /** Fragment kodu z `import.meta`, który zostaje. */
  readonly fragment: string;
  readonly powod: string;
}

/** `import.meta` poza `install/`, który nie liczy korzenia instalacji. Lista zamknięta. */
const IMPORT_META_WYJATKI: readonly ImportMetaWyjatek[] = [
  {
    plik: 'server/src/iroh/adapter.ts',
    fragment: 'createRequire(import.meta.url)',
    powod: 'rozwiązanie paczki modułu natywnego iroh względem modułu, nie korzeń instalacji',
  },
];

interface RestartWyjatek {
  /** Cała linia po `trim()`. */
  readonly linia: string;
  readonly powod: string;
}

const WPROST = 'odmowa wywołania bez parametrów od `rarog restart`: zdania nie ma skąd wziąć parametrem';

/** Linie kodu `restart.sh` z komendą naprawczą. Lista zamknięta, każdy wpis trafia dokładnie jedną linię. */
const RESTART_WYJATKI: readonly RestartWyjatek[] = [
  { linia: 'echo "restart.sh: bad parameter $1 — only \\`rarog restart\\` (pnpm run restart) sets it." >&2', powod: WPROST },
  { linia: 'echo "restart.sh: missing parameter $1 — only \\`rarog restart\\` (pnpm run restart) sets it." >&2', powod: WPROST },
  { linia: 'echo "are set only by \\`rarog restart\\` (pnpm run restart)."', powod: WPROST },
  { linia: 'echo "\\`rarog restart\\` (pnpm run restart) sets the parameters."', powod: WPROST },
  {
    linia: 'echo "\\`rarog restart\\` (pnpm run restart), which checks it and passes it to this script; without the unit:"',
    powod: WPROST,
  },
  {
    linia: 'echo "restart.sh: this script runs under \\`rarog restart\\` — run \\`pnpm run restart\\` (rarog restart), which"',
    powod: WPROST,
  },
  {
    linia: 'echo "launchctl print $LAUNCHD_TARGET, then pnpm run restart. Nothing was stopped."',
    powod: 'odmowa, gdy usługa launchd z etykiety od `rarog restart` nie jest załadowana: rada restartu, nie hooka',
  },
  {
    linia: 'echo "start: nohup node bin/rarog.mjs serve (service $SERVICE_LABEL is not loaded)"',
    powod: 'opis wykonywanego startu, nie rada; skrypt stoi w korzeniu instalacji (`cd` na początku)',
  },
  {
    linia: 'nohup node bin/rarog.mjs serve >"$LOG" 2>&1 &',
    powod: 'start serwera bez usługi: polecenie wykonywane, nie rada',
  },
];

/** `import.meta` w kodzie bez komentarzy i bez treści napisów; `fragmenty` = dozwolone miejsca. */
function importMetaPoza(source: string, fragmenty: readonly string[]): { zostaje: number; dozwolone: number } {
  let kod = scan(source).skeleton;
  let dozwolone = 0;
  for (const fragment of fragmenty) {
    dozwolone += kod.split(fragment).length - 1;
    kod = kod.split(fragment).join('');
  }
  return { zostaje: kod.split('import.meta').length - 1, dozwolone };
}

/** Napisy z komendą naprawczą: `linia: treść`. */
function komendyWNapisach(source: string): string[] {
  return tsTextLiterals(source).filter(({ value }) => KOMENDY.test(value))
    .map(({ value, line }) => `${String(line)}: ${value.trim().slice(0, 120)}`);
}

/** Linie kodu skryptu powłoki (bez linii komentarza) z komendą naprawczą, po `trim()`. */
function komendyWSkrypcie(source: string): string[] {
  return source.split('\n').map((line) => line.trim())
    .filter((line) => !line.startsWith('#') && KOMENDY.test(line));
}

/** Literał `.ts` w `new URL(…, import.meta.url)` albo w ścieżce `new Worker(…)`, w kodzie bez komentarzy. */
const URL_TS = /new\s+URL\(\s*(['"`])[^'"`]*\.[cm]?ts\1\s*,\s*import\.meta\.url/u;
const WORKER_TS = /new\s+Worker\(\s*(['"`])[^'"`]*\.[cm]?ts\1/u;
function literalTs(source: string): boolean {
  const { code } = scan(source);
  return URL_TS.test(code) || WORKER_TS.test(code);
}

/** Specyfikatory importów: `from '…'` (także `import type` i reeksporty), `import '…'` i `import('…')`. */
function specyfikatory(source: string): string[] {
  const { code } = scan(source);
  const out: string[] = [];
  for (const hit of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"`]([^'"`]+)['"`]|^\s*import\s+['"]([^'"]+)['"]/gmu)) {
    const spec = hit[1] ?? hit[2] ?? hit[3];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

/**
 * Importy paczek obcych w `install/`: zamknięta lista. `sdk.ts` ładuje SDK Claude (w klonie po nazwie, typ funkcji
 * `listSessions`); granicę samego pakietu pilnuje `sdk-boundary.test.ts`.
 */
const OBCE_W_INSTALL: readonly { readonly plik: string; readonly spec: string }[] = [
  { plik: `${INSTALL}sdk.ts`, spec: '@anthropic-ai/claude-agent-sdk' },
];

/** Import dozwolony w `install/`: `node:*`, `@rarog/shared` (z podścieżką), moduł tego katalogu albo wpis z listy. */
function importDozwolony(plik: string, spec: string): boolean {
  if (spec.startsWith('node:') || spec === '@rarog/shared' || spec.startsWith('@rarog/shared/')) return true;
  if (OBCE_W_INSTALL.some((w) => w.plik === plik && w.spec === spec)) return true;
  if (!spec.startsWith('.')) return false;
  const cel = path.posix.normalize(path.posix.join(path.posix.dirname(plik), spec));
  return cel.startsWith(INSTALL);
}

describe('strażnik katalogu instalacji: mechanizm', () => {
  it('`import.meta` w kodzie liczy się, w komentarzu i napisie nie; fragment z wyjątku przechodzi', () => {
    const probka = [
      "// new URL('../../', import.meta.url)",
      "const opis = 'import.meta.url';",
      "export const ROOT = new URL('../../', import.meta.url);",
      'const r = createRequire(import.meta.url);',
    ].join('\n');
    expect(importMetaPoza(probka, [])).toEqual({ zostaje: 2, dozwolone: 0 });
    expect(importMetaPoza(probka, ['createRequire(import.meta.url)'])).toEqual({ zostaje: 1, dozwolone: 1 });
  });

  it('komenda naprawcza w napisie i szablonie się liczy, w komentarzu nie; w skrypcie bez linii `#`', () => {
    const probka = [
      "// Napraw: `pnpm run hooks:install`",
      "const a = 'Napraw: `pnpm run hooks:install`';",
      'const b = `${x} node bin/rarog.mjs doctor`;',
      "const c = 'pnpm install w repo';",
      "const d = 'rarog hooks install';",
      "const e = `Zainstaluj: npm i -g rarog`;",
      "const f = 'pnpm remove -g rarog';",
      "const g = 'npm uninstall -g rarog';",
      "const h = 'npm ci --ignore-scripts';",
    ].join('\n');
    expect(komendyWNapisach(probka).map((hit) => hit.split(':')[0])).toEqual(['2', '3', '4', '6', '7', '8']);
    expect(komendyWSkrypcie('# pnpm run restart\necho "pnpm run restart"\n  echo ok')).toEqual(['echo "pnpm run restart"']);
  });

  it('literał `.ts` w `new URL(…, import.meta.url)` i w `new Worker(…)`; `.js` i komentarz przechodzą', () => {
    expect(literalTs("const w = new URL('./loop.ts', import.meta.url);")).toBe(true);
    expect(literalTs("new Worker('./server/src/iroh/loop.mts')")).toBe(true);
    expect(literalTs("new Worker(new URL(`./loop.ts`, import.meta.url))")).toBe(true);
    expect(literalTs("const w = new URL('./loop.js', import.meta.url);")).toBe(false);
    expect(literalTs("// new Worker('./loop.ts')")).toBe(false);
  });

  it('import w `install/`: `node:*`, `@rarog/shared` i własny katalog; `cli/`, `herdr/` i paczki obce nie', () => {
    const plik = 'server/src/install/x.ts';
    expect(importDozwolony(plik, 'node:path')).toBe(true);
    expect(importDozwolony(plik, '@rarog/shared/data-dir')).toBe(true);
    expect(importDozwolony(plik, './mode.ts')).toBe(true);
    expect(importDozwolony(plik, '../cli/io.ts')).toBe(false);
    expect(importDozwolony(plik, '../herdr/hook-config.ts')).toBe(false);
    expect(importDozwolony(plik, 'tsx')).toBe(false);
    expect(specyfikatory("import a from 'node:fs';\nimport type { B } from './b.ts';\nconst c = await import('../c.ts');"))
      .toEqual(['node:fs', './b.ts', '../c.ts']);
  });
});

describe('strażnik katalogu instalacji: repo', () => {
  it('zakres: źródła `server/src` z katalogiem `install/` i plikami, które korzystają z niego dziś', () => {
    for (const plik of [`${INSTALL}mode.ts`, REPAIR, `${INSTALL}service-target.ts`, 'server/src/cli/hooks.ts']) {
      expect(ZRODLA, plik).toContain(plik);
    }
  });

  it('1. korzeń z `import.meta` tylko w `install/`; wyjątki bez martwych wpisów', () => {
    const obce: string[] = [];
    const martwe: string[] = [];
    for (const plik of ZRODLA) {
      if (plik.startsWith(INSTALL)) continue;
      const wyjatki = IMPORT_META_WYJATKI.filter((w) => w.plik === plik);
      const { zostaje, dozwolone } = importMetaPoza(read(plik), wyjatki.map((w) => w.fragment));
      if (zostaje > 0) obce.push(`${plik}: import.meta ×${String(zostaje)}`);
      if (wyjatki.length > 0 && dozwolone === 0) martwe.push(plik);
    }
    expect(obce, 'Korzeń instalacji bierz z `server/src/install/mode.ts` (INSTALL_ROOT, ROOT_PACKAGE_JSON).')
      .toEqual([]);
    expect(martwe, 'martwe wyjątki').toEqual([]);
    expect(importMetaPoza(read(`${INSTALL}mode.ts`), []).zostaje).toBeGreaterThan(0);
  });

  it('2. komendy naprawcze w napisach `server/src` tylko w `install/repair.ts` (bez tekstów demo)', () => {
    const obce: string[] = [];
    for (const plik of ZRODLA) {
      if (plik === REPAIR || plik.startsWith(DEMO)) continue;
      for (const hit of komendyWNapisach(read(plik))) obce.push(`${plik}:${hit}`);
    }
    expect(obce, 'Komendę naprawczą weź z `REPAIR` albo `rarogCli` (`server/src/install/repair.ts`).').toEqual([]);
    expect(komendyWNapisach(read(REPAIR)).length).toBeGreaterThan(0);
    // Wyjątek demo nie jest martwy: atrapy niosą zmyślone notatki i komendy sesji, nie rady tej instalacji.
    expect(ZRODLA.filter((plik) => plik.startsWith(DEMO)).some((plik) => komendyWNapisach(read(plik)).length > 0))
      .toBe(true);
  });

  it('2. komendy naprawcze w kodzie `restart.sh` tylko w liniach z listy; zdanie naprawy hooka z parametru', () => {
    const linie = komendyWSkrypcie(read(RESTART));
    const obce = linie.filter((linia) => !RESTART_WYJATKI.some((w) => w.linia === linia));
    expect(obce, 'Zdanie dla człowieka z komendą tej instalacji przychodzi od `rarog restart` parametrem.').toEqual([]);
    const zle = RESTART_WYJATKI.filter((w) => linie.filter((linia) => linia === w.linia).length !== 1)
      .map((w) => w.linia);
    expect(zle, 'wpis bez trafienia albo z kilkoma').toEqual([]);
    expect(read(RESTART)).toMatch(/"\$hook" = stale[^\n]*\n[^\n]*"\$HOOK_REPAIR"/u);
  });

  it('3. literał `.ts` w `new URL(…, import.meta.url)` i w ścieżce `Worker` tylko w `install/`', () => {
    const obce = ZRODLA.filter((plik) => !plik.startsWith(INSTALL) && literalTs(read(plik)));
    expect(obce).toEqual([]);
  });

  it('4. `install/` importuje tylko `node:*`, `@rarog/shared` i siebie (poza zamkniętą listą); wpisy bez martwych', () => {
    const obce = ZRODLA.filter((plik) => plik.startsWith(INSTALL)).flatMap((plik) => specyfikatory(read(plik))
      .filter((spec) => !importDozwolony(plik, spec)).map((spec) => `${plik} → ${spec}`));
    expect(obce).toEqual([]);
    const martwe = OBCE_W_INSTALL.filter((w) => !specyfikatory(read(w.plik)).includes(w.spec));
    expect(martwe, 'martwe wpisy listy paczek obcych').toEqual([]);
  });
});
