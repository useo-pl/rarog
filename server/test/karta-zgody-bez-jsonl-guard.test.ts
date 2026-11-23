/**
 * Strażnik-zapadka „karta zgody nie czyta jsonl”: moduły katalogu dialogów (`server/src/herdr/dialogs/**`)
 * nie importują transkryptu — ani czytnika wpisów (`herdr/jsonl-pending.ts`), ani śledzenia pliku rozmowy
 * (`herdr/jsonl-follow.ts`, `herdr/transcript-path.ts`, `drivers/herdr/transcript.ts`). Liczy się też sam typ
 * (`import type { PendingTool }`): wpis transkryptu w sygnaturze znaczy, że moduł składa kartę albo decyzję z treści
 * jsonl, a nie ze zrzutu hooka i ekranu.
 *
 * Dziś importuje go pięć modułów ścieżki karty z wpisu jsonl. Lista {@link WYJATKI} jest ZAMKNIĘTA: nowy
 * moduł z importem transkryptu jest czerwony, wpis bez importu (martwy) też — usunięty import ma zdjąć wpis
 * w tym samym commicie. Fasada drivera (`drivers/herdr-driver.ts`) jest poza zakresem: śledzi transkrypt dla
 * wiadomości i podaje wpis decyzji jako argument.
 *
 * Zakres: karta zgody z kanału hooka mieszka w warstwie 1 (`server/src/herdr/dialogs/layer1/`) i ten
 * podkatalog nie ma wyjątków: moduł `layer1/**` z importem transkryptu przewraca `layer1-granica.test.ts`
 * niezależnie od listy niżej (tam razem z zakazem modułów drivera herdr). Pięć wyjątków niesie ścieżkę cyfry
 * (karta z wpisu jsonl, karta pytania, cyfra po treści z jsonl); bez tej ścieżki lista ma
 * być pusta.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { relativeImports, scan, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(REPO, 'server/src/herdr/dialogs');

/** Moduły transkryptu: czytnik wpisów i śledzenie pliku rozmowy. */
const TRANSCRIPT = [
  'server/src/herdr/jsonl-pending.ts',
  'server/src/herdr/jsonl-follow.ts',
  'server/src/herdr/transcript-path.ts',
  'server/src/drivers/herdr/transcript.ts',
  // Przegląd dowodów kanału zgód: czyta transkrypt, a warstwa 1 dostaje od niego same fakty tury.
  'server/src/herdr/consent-evidence.ts',
  // Plik subagenta w przeglądzie dowodów kanału zgód.
  'server/src/herdr/consent-subagent.ts',
] as const;

interface Wyjatek {
  readonly plik: string;
  readonly powod: string;
}

/** Dzisiejsze moduły katalogu z importem transkryptu. Lista ZAMKNIĘTA: martwy wpis też jest błędem. */
const WYJATKI: readonly Wyjatek[] = [
  { plik: 'server/src/herdr/dialogs/cards/build.ts', powod: 'karta z wpisu jsonl (`PendingTool` → `ActiveReq`)' },
  { plik: 'server/src/herdr/dialogs/cross-check.ts', powod: 'uzgadnianie wpisu jsonl ze zrzutem hooka i ekranem' },
  { plik: 'server/src/herdr/dialogs/decide/decide.ts', powod: 'decyzja „jaka karta” z wpisem jsonl jako źródłem' },
  { plik: 'server/src/herdr/dialogs/decide/input.ts', powod: 'wejście decyzji niesie wpis jsonl' },
  { plik: 'server/src/herdr/dialogs/decide/sources.ts', powod: 'konkurencja wpisu jsonl i zrzutu hooka' },
];

const repoPath = (file: string): string => relative(REPO, file);

/** Importy transkryptu w KODZIE modułu (komentarze się nie liczą), jako ścieżki repo. */
function transcriptImports(file: string, source: string): string[] {
  return relativeImports(scan(source).code)
    .map((spec) => repoPath(resolve(dirname(join(REPO, file)), spec)))
    .filter((target) => (TRANSCRIPT as readonly string[]).includes(target));
}

describe('karta zgody nie czyta jsonl (zapadka)', () => {
  it('moduły transkryptu istnieją (przemianowany plik zrobiłby z zakazu pusty zbiór)', () => {
    for (const file of TRANSCRIPT) expect(existsSync(join(REPO, file)), file).toBe(true);
  });

  it('widzi import typu, wartości i dynamiczny; komentarz się nie liczy', () => {
    const file = 'server/src/herdr/dialogs/decide/probka.ts';
    const source = [
      "import type { PendingTool } from '../../jsonl-pending.ts';",
      "import { echoKey } from '../../jsonl-follow.ts';",
      "const t = await import('../../../drivers/herdr/transcript.ts');",
      "// import { locateTranscript } from '../../transcript-path.ts';",
      "import { parseOptions } from '../screen/parse.ts';",
    ].join('\n');
    expect(transcriptImports(file, source)).toEqual([
      'server/src/herdr/jsonl-pending.ts', 'server/src/herdr/jsonl-follow.ts', 'server/src/drivers/herdr/transcript.ts',
    ]);
  });

  it('żaden moduł katalogu dialogów poza listą wyjątków nie importuje transkryptu; lista bez martwych wpisów', () => {
    const uzyte = new Set<Wyjatek>();
    const obce: string[] = [];
    for (const file of tsFiles(DIR).map(repoPath)) {
      const hits = transcriptImports(file, readFileSync(join(REPO, file), 'utf8'));
      if (hits.length === 0) continue;
      const wyjatek = WYJATKI.find((w) => w.plik === file);
      if (wyjatek === undefined) {
        obce.push(`${file} importuje ${hits.join(', ')} — karta ma brać treść ze zrzutu hooka i ekranu`);
        continue;
      }
      uzyte.add(wyjatek);
    }
    expect(obce).toEqual([]);
    expect(WYJATKI.filter((w) => !uzyte.has(w)).map((w) => w.plik), 'martwe wyjątki').toEqual([]);
  });
});
