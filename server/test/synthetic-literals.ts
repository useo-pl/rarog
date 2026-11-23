/**
 * Syntetyczny plik prywatnych literałów dla testów producentów fixture'ów. Producent zapisuje fixture
 * wyłącznie przez `scripts/anonymize-fixture.ts`, który bez pliku literałów odmawia (fail closed). Test, który
 * dziedziczyłby środowisko, brałby więc plik właściciela (`~/.config/rarog/`), a w publicznym CI — żaden i padał.
 * Ten plik daje każdemu takiemu testowi jawną, zmyśloną mapę (`fixtures/literaly-syntetyczne.json`): nazwy nie
 * pochodzą z prawdziwego pliku literałów.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SYNTHETIC_LITERALS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/literaly-syntetyczne.json');

/** Środowisko procesu producenta: syntetyczny plik literałów albo podana ścieżka (np. nieistniejąca). */
export function literalsEnv(literals: string = SYNTHETIC_LITERALS_FILE): NodeJS.ProcessEnv {
  return { ...process.env, RAROG_PRIVATE_LITERALS: literals, RAROG_REQUIRE_PRIVATE_LITERALS: undefined };
}
