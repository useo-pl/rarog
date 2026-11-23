/**
 * Typy `is-main.mjs` (czy moduł uruchomiono wprost, także przez dowiązanie w ścieżce). Osobny plik, bo
 * `tsconfig.base.json` nie ma `allowJs`, a moduł musi zostać czystym ESM dla gołego `node`.
 */

/**
 * `true`, gdy `realpath` pliku modułu (`importMetaUrl`) równa się `realpath` ścieżki skryptu (`argv1`, domyślnie
 * `process.argv[1]`). Brak `argv1` albo błąd `realpath` to `false`, nigdy wyjątek.
 */
export declare function isMainModule(importMetaUrl: string, argv1?: string | undefined): boolean;
