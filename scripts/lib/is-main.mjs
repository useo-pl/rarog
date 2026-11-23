/**
 * Czy moduł uruchomiono wprost (`node <plik>`, `tsx <plik>`), czy go zaimportowano. JEDNA definicja dla skryptów
 * repo, które są zarazem modułem z eksportami i komendą:
 *
 *     if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
 *
 * Node podaje w `import.meta.url` modułu głównego ścieżkę po rozwinięciu dowiązań, a `process.argv[1]` zostawia
 * tak, jak ją podano. Porównanie wprost (`import.meta.url === pathToFileURL(process.argv[1]).href`) daje więc
 * `false`, gdy ścieżka do checkoutu prowadzi przez dowiązanie (`/var` → `/private/var` na macOS, katalog projektu
 * przez symlink): `main` się nie wykonuje, a proces kończy się kodem 0, czyli sprawdzian przepuszcza bez
 * sprawdzenia. Tu obie strony przechodzą przez `realpath`.
 *
 * Brak `argv[1]` (REPL, `node -e`, import w teście) i błąd `realpath` albo adresu (`data:`) to „nie jest główny”,
 * bez wyjątku. Czysty ESM, wyłącznie `node:*`: działa przed `pnpm install`. Typy: `is-main.d.mts`.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} importMetaUrl `import.meta.url` sprawdzanego modułu
 * @param {string | undefined} [argv1] ścieżka skryptu z wiersza poleceń, domyślnie `process.argv[1]`
 * @returns {boolean}
 */
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== 'string' || argv1 === '') return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(path.resolve(argv1));
  } catch {
    return false;
  }
}
