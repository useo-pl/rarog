/**
 * Tryb i korzeń instalacji serwera: JEDYNE miejsce, w którym kod `server/src` liczy ścieżki z `import.meta`
 * (strażnik `server/test/install-guard.test.ts`). Komendy `rarog`, wersja serwera i źródło kopii hooka biorą korzeń
 * stąd, więc reguła „gdzie leży instalacja” ma jedną definicję.
 *
 * Tryb liczy rozszerzenie TEGO pliku: `.ts` (tsx w klonie repo) to `clone`, `.js` (kod zbudowany do JavaScriptu) to
 * `package`. Korzeń to katalog z `package.json` serwera, trzy poziomy nad tym plikiem (`server/src/install/`);
 * układ katalogów jest ten sam w obu trybach. Moduł importuje wyłącznie `node:*` (reguła katalogu `install/`).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `clone` — klon repo uruchomiony przez tsx; `package` — kod zbudowany do JavaScriptu. */
export type InstallMode = 'clone' | 'package';

/** Tryb instalacji modułu o tym adresie: `.js` = `package`, każde inne rozszerzenie = `clone`. */
export function installModeOf(moduleUrl: string | URL): InstallMode {
  return new URL(moduleUrl).pathname.endsWith('.js') ? 'package' : 'clone';
}

/**
 * Tryb INNEJ instalacji z korzeniem `root` (np. tej, którą startuje usługa): `package`, gdy leży w niej zbudowany
 * `server/src/cli/main.js` — po nim `bin/rarog.mjs` wybiera import bez tsx — inaczej `clone`.
 */
export function installModeAt(root: string): InstallMode {
  return existsSync(path.join(root, 'server', 'src', 'cli', 'main.js')) ? 'package' : 'clone';
}

/** Adres korzenia instalacji (z końcowym `/`) dla modułu leżącego w `server/src/install/`. */
function rootUrlOf(moduleUrl: string | URL): URL {
  return new URL('../../../', moduleUrl);
}

/** Korzeń instalacji (bez końcowego `/`) dla modułu leżącego w `server/src/install/`. */
export function installRootOf(moduleUrl: string | URL): string {
  return fileURLToPath(rootUrlOf(moduleUrl)).replace(/\/$/, '');
}

/** Tryb tej instalacji. */
export const INSTALL_MODE: InstallMode = installModeOf(import.meta.url);

/** Korzeń tej instalacji: w klonie katalog repo. */
export const INSTALL_ROOT: string = installRootOf(import.meta.url);

/** `package.json` korzenia tej instalacji (pole `version` czyta `server/src/version.ts`). */
export const ROOT_PACKAGE_JSON: URL = new URL('package.json', rootUrlOf(import.meta.url));
