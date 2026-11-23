/*
 * Zasięg `tsc -b`: KAŻDY plik `.ts` w repo należy do jakiegoś projektu.
 *
 * Dwa pakiety (`shared`, `server`) mają swoje `include`, ale narzędzia CLI z `scripts/`
 * i konfiguracje leżą poza nimi: bez osobnego projektu `pnpm run typecheck` by ich nie widział,
 * vitest ich nie ładuje, więc błąd typów w `scripts/hooks-config.ts` (importuje
 * `server/src/herdr/hook-config.ts`) wychodziłby dopiero przy URUCHOMIENIU hooka z ręki. Zamyka
 * to `tsconfig.scripts.json`, dopięty do solution file'a.
 *
 * Test jest TEKSTOWY, bo pliki `tsconfig*.json` niosą komentarze `//` i `JSON.parse` na nich
 * pada. Pilnuje trzech rzeczy: projekt jest w `tsc -b`, ma referencje bez których leci TS6307,
 * i żaden nowy plik konfiguracyjny w korzeniu nie wypadł poza `include`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('`tsc -b` obejmuje scripts/ i konfiguracje builda', () => {
  const solution = read('tsconfig.json');
  const scripts = read('tsconfig.scripts.json');

  it('solution file odsyła do `tsconfig.scripts.json`', () => {
    expect(solution, '`pnpm run typecheck` nie zbuduje projektu, którego nie ma w referencjach')
      .toContain('"./tsconfig.scripts.json"');
  });

  it('projekt ma referencje do `shared` i `server` — bez nich 13× TS6307', () => {
    // `scripts/hooks-config.ts` i inne narzędzia CLI z `scripts/` importują `server/src/**`,
    // a przez nie `@rarog/shared`. Bez referencji tsc mówi „plik nie jest na liście plików
    // projektu" i typecheck pada, zamiast sprawdzać cokolwiek.
    expect(scripts).toMatch(/"references":[\s\S]*"\.\/shared"/);
    expect(scripts).toMatch(/"references":[\s\S]*"\.\/server"/);
  });

  it('`include` łapie wszystkie skrypty i konfiguracje spoza pakietów', () => {
    expect(scripts).toContain('"scripts/**/*.ts"');
    for (const plik of readdirSync(repoRoot).filter((f) => f.endsWith('.config.ts'))) {
      expect(scripts, `konfiguracja \`${plik}\` w korzeniu repo poza \`tsc -b\``)
        .toContain(`"${plik}"`);
    }
  });
});
