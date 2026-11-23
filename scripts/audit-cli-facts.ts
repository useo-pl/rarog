/**
 * Lista zdań o zachowaniu Claude Code bez dowodu (opis: `docs/distribution.md`, „What the repo knows about Claude Code”).
 *
 * Wypisuje bloki tekstu ze słowem „CLI”, czasownikiem zachowania i bez znacznika dowodu (wersja CLI, fixture, strona
 * docs), po jednym na linię jako `plik:od-do`, potem liczby per plik i sumę. Liczy tym samym kodem
 * (`zdaniaBezDowodu` w `server/test/cli-bez-binarki.ts`) i na tych samych plikach (widok eksportu), co test
 * zakazu `server/test/cli-fakty-zapadka.test.ts`, więc niepusta lista znaczy czerwony test. Treści linii nie wypisuje:
 * linia repo może nieść literał, którego nie wolno pokazać.
 *
 * Uruchomienie: `pnpm exec tsx scripts/audit-cli-facts.ts` (kod wyjścia 0 także przy niepustej liście).
 */
import { isMainModule } from './lib/is-main.mjs';
import { liczbyZdan, miejsceZdania, plikiRepo, zdaniaBezDowodu } from '../server/test/cli-bez-binarki.ts';
import { REPO, inExportView } from '../server/test/private-guard.ts';

/** Linie raportu: miejsca, liczby per plik, suma. */
export function raport(root: string = REPO): string[] {
  const zdania = zdaniaBezDowodu(plikiRepo(root, inExportView));
  const liczby = liczbyZdan(zdania);
  return [
    ...zdania.map(miejsceZdania),
    '',
    'per file:',
    ...[...liczby].map(([plik, ile]) => `  ${plik}: ${String(ile)}`),
    '',
    `total: ${String(zdania.length)} in ${String(liczby.size)} files`,
  ];
}

if (isMainModule(import.meta.url)) {
  process.stdout.write(`${raport().join('\n')}\n`);
}
