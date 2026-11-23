/**
 * Strażnik tekstów CLI: napisy, które człowiek widzi w terminalu (`rarog` z `server/src/cli/**` i `bin/**`,
 * komunikaty terminala serwera z `server/src/term/**`), opisują system tak, jak działa dziś. Nie niosą etykiet
 * decyzji (litera z numerem), dat, słów o historii pomiaru i zmian, odsyłaczy do skryptów pomiaru (`scripts/audit…`,
 * `scripts/measure…`) ani ścieżek plików warstwy prywatnej (`PRIVATE_LAYER`; w eksporcie zbiór jest pusty, bo tych
 * plików tam nie ma).
 *
 * Liczą się napisy i kawałki szablonów (`tsTextLiterals`), bez komentarzy i specyfikatorów importów: komentarze
 * należą do kodu, nie do człowieka przy terminalu. Słowa o historii łapie wzorzec po polsku i po angielsku. Lista
 * {@link WYJATKI} jest zamknięta: wpis ma powód, a wpis bez trafienia (martwy) jest błędem. Dziś pusta.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRIVATE_LAYER } from './private-guard.ts';
import { tsTextLiterals } from './product-identity.ts';
import { repoFiles, scan, unbalanced } from './source-scan.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Katalogi z tekstami CLI i terminala serwera. */
const ZAKRES = ['server/src/cli', 'server/src/term', 'bin'] as const;
const ZRODLO = /\.(?:ts|mts|mjs|js)$/u;

/** Rodzaj trafienia i wzorzec, który go wykrywa w treści napisu. */
const WZORCE: readonly { readonly rodzaj: string; readonly wzorzec: RegExp }[] = [
  { rodzaj: 'etykieta decyzji', wzorzec: /\bD-?[A-Z]{0,2}[0-9]+[a-z]?\b/u },
  { rodzaj: 'data', wzorzec: /20[0-9]{2}-[0-9]{2}-[0-9]{2}/u },
  // Rewizja (revised, revision) i pomiar (measured); „unmeasured” i „niezmierzone” to dopisek o braku pomiaru.
  { rodzaj: 'historia', wzorzec: /\b(?:rewizj|zmierzon|revis|measured)/iu },
  { rodzaj: 'skrypt pomiaru', wzorzec: /scripts\/(?:audit|measure)/u },
];

interface Wyjatek {
  readonly plik: string;
  /** Fragment napisu, który zostaje mimo trafienia. */
  readonly fragment: string;
  readonly powod: string;
}

/** Napis, który mimo trafienia opisuje stan dzisiejszy. Lista zamknięta, martwy wpis też jest błędem. */
const WYJATKI: readonly Wyjatek[] = [];

interface Trafienie {
  readonly plik: string;
  readonly linia: number;
  readonly rodzaj: string;
  readonly tekst: string;
}

/** Trafienia w napisach jednego pliku; `prywatne` to ścieżki warstwy prywatnej względem korzenia repo. */
function trafienia(plik: string, source: string, prywatne: ReadonlySet<string>): Trafienie[] {
  const out: Trafienie[] = [];
  for (const { value, line } of tsTextLiterals(source)) {
    for (const { rodzaj, wzorzec } of WZORCE) {
      if (wzorzec.test(value)) out.push({ plik, linia: line, rodzaj, tekst: value });
    }
    for (const sciezka of prywatne) {
      if (value.includes(sciezka)) out.push({ plik, linia: line, rodzaj: `plik prywatny ${sciezka}`, tekst: value });
    }
  }
  return out;
}

const opis = (t: Trafienie): string => `${t.plik}:${String(t.linia)} [${t.rodzaj}] ${t.tekst.trim().slice(0, 120)}`;

const RADA = 'Tekst dla człowieka przy terminalu opisuje stan dzisiejszy: etykietę zastąp treścią albo usuń,'
  + ' datę zastąp wersją CLI albo usuń, odsyłacz do skryptu pomiaru i pliku prywatnego usuń. Napis, który musi'
  + ' zostać, dostaje wyjątek z powodem.';

const PLIKI = ZAKRES.flatMap((katalog) => repoFiles(REPO, katalog)).filter((plik) => ZRODLO.test(plik)).sort();
const read = (plik: string): string => readFileSync(path.join(REPO, plik), 'utf8');

describe('teksty CLI bez etykiet decyzji, dat i nazw plików prywatnych', () => {
  it('mechanizm: napis i szablon z etykietą, datą, historią, skryptem i plikiem prywatnym; komentarz i import nie', () => {
    const probka = [
      "import { a } from './modul-2026-01-01.ts';",
      "// const b = 'komentarz (D5)';",
      '/* `szablon w komentarzu (D-T7)` */',
      "const c = 'Rarog nie pisze do ustawień (D5).';",
      'const d = `powłoka w panelu ${e} herdr (D-T7)`;',
      "const f = 'hooki ładują się tak samo (zmierzone 2026-08-28)';",
      "const g = 'Liczba odmów: `pnpm exec tsx scripts/audit-x.ts`';",
      "const h = 'Zobacz docs/prywatny-plik.md';",
      "const i = 'Rewizja reguły';",
      "const j = 'EndpointId, ED25519, tryb D, wersja 2.1.302';",
      // Kawałek szablonu po interpolacji nazwanej jak słowo kluczowe importu to nadal tekst, nie specyfikator.
      'const k = `Wynik ${from} — (D5)`;',
      'const l = `kopia ${o.import} z 2026-01-02`;',
      "const m = 'hooks load the same way (measured 2026-08-28)';",
      "const n = 'Revised rule: see the decision (D-T7)';",
      "const o = 'note limit 8192 characters, unmeasured in the CLI';",
      "// const p = 'measured in a comment';",
    ].join('\n');
    const wynik = trafienia('a.ts', probka, new Set(['docs/prywatny-plik.md']))
      .map((t) => `${String(t.linia)} ${t.rodzaj}`);
    expect(wynik).toEqual([
      '4 etykieta decyzji', '5 etykieta decyzji', '6 data', '6 historia', '7 skrypt pomiaru',
      '8 plik prywatny docs/prywatny-plik.md', '9 historia', '11 etykieta decyzji', '12 data', '13 data',
      '13 historia', '14 etykieta decyzji', '14 historia',
    ]);
  });

  it('zakres: pliki CLI, terminala i `bin/`; skaner domyka nawiasy każdego pliku', () => {
    const znane = ['bin/rarog.mjs', 'server/src/cli/main.ts', 'server/src/cli/hooks.ts', 'server/src/term/index.ts'];
    for (const plik of znane) expect(PLIKI, plik).toContain(plik);
    for (const plik of PLIKI) {
      expect(unbalanced(scan(read(plik)).skeleton), `${plik}: skaner nie domknął nawiasów`).toBeNull();
    }
  });

  it('kontrola dodatnia: etykieta dopisana na końcu każdego pliku z zakresu jest widoczna', () => {
    const slepe = PLIKI.filter((plik) => {
      const source = `${read(plik)}\nconst proba = 'próba (D-T7)';\n`;
      const ostatnia = source.split('\n').length - 1;
      return !trafienia(plik, source, new Set()).some((t) => t.linia === ostatnia && t.rodzaj === 'etykieta decyzji');
    });
    expect(slepe, 'skaner nie dochodzi do końca pliku').toEqual([]);
  });

  it('mutacja: słowo o historii po polsku i po angielsku w napisie CLI przewraca strażnika, w komentarzu nie', () => {
    const plik = 'server/src/cli/doctor.ts';
    const nowe = (dopisek: string): string[] => trafienia(plik, `${read(plik)}\n${dopisek}\n`, new Set())
      .filter((t) => t.rodzaj === 'historia').map((t) => t.tekst);
    expect(nowe("const proba = 'limit zmierzony na CLI';")).toEqual(['limit zmierzony na CLI']);
    expect(nowe("const proba = 'limit measured on the CLI';")).toEqual(['limit measured on the CLI']);
    expect(nowe("const proba = 'revised limit';")).toEqual(['revised limit']);
    expect(nowe("// const proba = 'limit measured on the CLI';")).toEqual([]);
    expect(nowe("const proba = 'the limit is unmeasured';")).toEqual([]);
  });

  it('napisy bez trafień poza listą wyjątków; lista bez martwych wpisów', () => {
    const uzyte = new Set<Wyjatek>();
    const obce: string[] = [];
    for (const plik of PLIKI) {
      for (const t of trafienia(plik, read(plik), PRIVATE_LAYER)) {
        const wyjatek = WYJATKI.find((w) => w.plik === plik && t.tekst.includes(w.fragment));
        if (wyjatek === undefined) obce.push(opis(t));
        else uzyte.add(wyjatek);
      }
    }
    expect(obce, RADA).toEqual([]);
    const martwe = WYJATKI.filter((w) => !uzyte.has(w)).map((w) => `${w.plik} „${w.fragment}”`);
    expect(martwe, 'martwe wyjątki').toEqual([]);
  });
});
