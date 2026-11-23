/**
 * Strażnik rejestru sygnatur: wygląd Claude Code stoi w KODZIE serwera tylko w `SCREEN_SIGNATURES`.
 *
 * Rejestr (`server/src/herdr/dialogs/screen/signatures.ts`) jest jedynym miejscem wzorców ekranu CLI, a stałe modułów
 * biorą wartość z niego. Literał z rejestru wpisany drugi raz w kod `server/src/**` to kopia, której nikt nie
 * pilnuje: po zmianie wyglądu CLI pomiar odświeży rejestr, a kopia zostanie stara. Strażnik wykrywa trzy kształty
 * takiej kopii:
 *
 * - napis równy markerowi z rejestru (bez rozróżniania wielkości liter, bo markery porównuje się po `toLowerCase`);
 * - literał wzorca o tym samym źródle co wzorzec z rejestru (flagi bez znaczenia);
 * - napis równy źródłu wzorca z rejestru (`new RegExp('…')`, podwójny ukośnik liczony jak pojedynczy).
 *
 * Komentarze się nie liczą: kod czyta `scan()` ze `source-scan.ts`. Opis rejestru:
 * `docs/dialogs.md`, „CLI look: signature registry”.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCREEN_SIGNATURES } from '../src/herdr/dialogs/screen/signatures.ts';
import type { ScreenSignature } from '../src/herdr/dialogs/screen/signatures.ts';
import { scan, tsFiles, unbalanced } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(REPO, 'server/src');
const REJESTR = 'server/src/herdr/dialogs/screen/signatures.ts';

/** Kopia literału z rejestru, którą świadomie zostawiamy w kodzie. Lista ZAMKNIĘTA: martwy wpis też jest błędem. */
interface Wyjatek {
  readonly plik: string;
  readonly sygnatura: keyof typeof SCREEN_SIGNATURES;
  readonly powod: string;
}

const WYJATKI: readonly Wyjatek[] = [];

type Wzor =
  | { readonly rodzaj: 'marker'; readonly tekst: string }
  | { readonly rodzaj: 'wzorzec'; readonly zrodlo: string };

/** Wzory każdej sygnatury: marker, każdy element listy markerów albo źródło wzorca. */
function wzory(sygnatura: ScreenSignature): Wzor[] {
  const wzorzec = sygnatura.pattern;
  if (typeof wzorzec === 'string') return [{ rodzaj: 'marker', tekst: wzorzec }];
  if (wzorzec instanceof RegExp) return [{ rodzaj: 'wzorzec', zrodlo: wzorzec.source }];
  return wzorzec.map((tekst) => ({ rodzaj: 'marker', tekst }));
}

const REJESTR_WZORY: readonly (readonly [string, Wzor])[] = Object.entries(SCREEN_SIGNATURES)
  .flatMap(([nazwa, sygnatura]) => wzory(sygnatura as ScreenSignature).map((wzor) => [nazwa, wzor] as const));

const linia = (zrodlo: string, offset: number): number => zrodlo.slice(0, offset).split('\n').length;

/** Trafienia literałów z rejestru w KODZIE jednego pliku: `[nazwa sygnatury, numer linii]`. */
function trafienia(zrodlo: string): (readonly [string, number])[] {
  const { literals, regexes } = scan(zrodlo);
  const out: (readonly [string, number])[] = [];
  for (const [nazwa, wzor] of REJESTR_WZORY) {
    if (wzor.rodzaj === 'marker') {
      const szukany = wzor.tekst.toLowerCase();
      for (const napis of literals) {
        if (napis.text.toLowerCase() === szukany) out.push([nazwa, linia(zrodlo, napis.offset)]);
      }
      continue;
    }
    for (const regex of regexes) {
      if (regex.source === wzor.zrodlo) out.push([nazwa, linia(zrodlo, regex.offset)]);
    }
    for (const napis of literals) {
      if (napis.text.replace(/\\\\/g, '\\') === wzor.zrodlo) out.push([nazwa, linia(zrodlo, napis.offset)]);
    }
  }
  return out;
}

const PLIKI = tsFiles(SRC).map((file) => relative(REPO, file)).filter((file) => file !== REJESTR);
const read = (file: string): string => readFileSync(join(REPO, file), 'utf8');

describe('rejestr sygnatur: literały wyglądu CLI tylko w rejestrze', () => {
  it('skanuje kod serwera i rejestr ma oba rodzaje wzorów (inaczej strażnik nie broni niczego)', () => {
    expect(PLIKI.length).toBeGreaterThan(100);
    expect(REJESTR_WZORY.filter(([, wzor]) => wzor.rodzaj === 'marker').length).toBeGreaterThan(10);
    expect(REJESTR_WZORY.filter(([, wzor]) => wzor.rodzaj === 'wzorzec').length).toBeGreaterThan(30);
  });

  it('skaner nie połyka kodu w żadnym pliku (niedomknięty nawias = zjedzony kod, ślepy strażnik)', () => {
    const zjedzone = PLIKI.filter((file) => unbalanced(scan(read(file)).skeleton) !== null);
    expect(zjedzone).toEqual([]);
  });

  it('widzi napis, wzorzec i źródło wzorca w napisie, a komentarza nie', () => {
    const probka = [
      "// 'enter to select' i /^─{8,}$/ w komentarzu się nie liczą",
      "const a = region.includes('Enter to select');",
      'const b = /^─{8,}$/u;',
      "const c = new RegExp('^\\\\s*⎿\\\\s+Set model to\\\\b');",
    ].join('\n');
    const posortowane = (lista: readonly (readonly [string, number])[]): string[] =>
      lista.map(([nazwa, nr]) => `${nazwa}:${nr}`).sort();
    expect(posortowane(trafienia(probka))).toEqual(
      posortowane([['questionSelectFooter', 2], ['dialogTopRule', 3], ['commandInlineResult', 4]]),
    );
  });

  it('widzi wzorzec po dzieleniu z postfiksowym `++`/`--` i po `export default`', () => {
    // Skaner brał `/` po `n++` za początek wzorca, a po `default` za dzielenie: kopia przechodziła bez śladu.
    const probka = [
      'let n = 10; const r = n++ / 2; const yes = /^Yes/i;',
      'let m = 10; const s = m-- / 2; const no = /^No/i;',
      'export default /^yes\\b/i;',
    ].join('\n');
    expect(trafienia(probka).map(([nazwa]) => nazwa).sort()).toEqual(
      ['affirmativeOption', 'knownDialogNoOption', 'knownDialogYesOption'],
    );
  });

  it('żaden plik `server/src/**` poza rejestrem nie powtarza jego literału w kodzie', () => {
    const uzyte = new Set<Wyjatek>();
    const obce: string[] = [];
    for (const file of PLIKI) {
      for (const [nazwa, nr] of trafienia(read(file))) {
        const wyjatek = WYJATKI.find((w) => w.plik === file && w.sygnatura === nazwa);
        if (wyjatek !== undefined) {
          uzyte.add(wyjatek);
          continue;
        }
        obce.push(`${file}:${nr} — literał sygnatury \`${nazwa}\` (weź wartość z SCREEN_SIGNATURES)`);
      }
    }
    expect(obce).toEqual([]);
    expect(WYJATKI.filter((w) => !uzyte.has(w)).map((w) => `${w.plik}: ${w.sygnatura}`), 'martwe wyjątki')
      .toEqual([]);
  });
});
