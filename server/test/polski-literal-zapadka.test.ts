/**
 * Ban on Polish literals in server code: a Polish string or template in `server/src/**` or `shared/src/**`, outside
 * log text and outside the closed list of exceptions, fails the test. A server sentence for the app has a code in
 * the sentence registry (`say()`), so no Polish literal is allowed there. The mechanism (what a literal is, the word
 * rule, the log cut-off) lives in `polski-literal.ts`.
 *
 * Exceptions (`polski-literal-wyjatki.json`): file → class → literal text that stays Polish because it never reaches
 * the app as a server sentence (registry descriptions, internal file values, zod, swallowed errors, demo content,
 * relay placeholder text…). The reason for each class is in {@link KLASY}; a class without a reason, an unused class
 * and an entry that removes nothing fail the test. An exception names the text, not a line number, so it survives
 * moved code and a literal wrapped in a call.
 *
 * Rules ({@link REGULY}) remove, without entries, text that grows in everyday work: the whole demo content file
 * (`demo/content/pl.ts`) and the `what` field of the screen signature registry (`screen/signatures.ts`). A rule has
 * a class from KLASY; a rule that removes nothing fails the test. Other fields of the signature registry count like
 * any literal.
 *
 * Log text in `server/src/**` is counted by `polski-log-zapadka.test.ts`, and `rarog` command lines also by
 * `polski-tekst-zapadka.test.ts`; here every code file of both directories counts. Only the export view counts
 * (`inExportView`), so the result is the same in the source repo and in the export; the test reads no private file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAst } from 'vitest/node';
import {
  plikKodu, policz, polskieLiteraly, type Literaly, type Policzone, type PolskiLiteral, type Wyjatki,
} from './polski-literal.ts';
import { REPO, inExportView } from './private-guard.ts';
import { repoTextFiles } from './source-scan.ts';

const WYJATKI_PLIK = 'server/test/polski-literal-wyjatki.json';

/** Klasy wyjątków z powodem: dlaczego tekst nie trafia do apki i zostaje polski. */
const KLASY: Readonly<Record<string, string>> = {
  'registry-description': 'opis wpisu rejestru (sygnatury dialogów, kształty CLI, komendy, reguły ryzyka): '
    + 'czyta go człowiek w kodzie i testach, apka dostaje identyfikator',
  'internal-file': 'wartość maszynowa dziennika audytu, pliku cienia, `alive.jsonl` albo zrzutu odmowy',
  'internal-reason': 'powód wewnętrzny drivera herdr, który manager pomija',
  'zod-message': 'komunikat schematu zod: router odsyła zamiast niego stałe zdanie, `.issues` nie wychodzi',
  'server-error-500': 'niezmiennik, którego wyjątek kończy jako 500 ze zdaniem ogólnym',
  'to-agent': 'tekst promptu, nazwa pliku albo powód odmowy dla agenta, nie dla apki',
  'cli-input': 'odpowiedź użytkownika komendy `rarog` (`isYes`); linię pilnuje też `polski-tekst-zapadka.test.ts`',
  'server-log': 'tekst `server.log` albo stderr sondy drogą, której zapadka logu nie widzi (wyjątek, wartość zwracana)',
  'startup-invariant': 'niezmiennik sprawdzany przy starcie serwera, poza drogą do apki',
  'relay-schema': 'komunikat zod przekaźnika (żądanie przepustki), nie trafia do apki',
  'relay-placeholder': 'tekst zastępczy przekaźnika dla buildu apki bez kluczy katalogu: baner (`ALERT_PLACEHOLDER`) '
    + 'i dzwonek kafla (`LIVE_ACTIVITY_CHIME`); stoi dosłownie w polityce przekaźnika (`relay/src/alert-policy.ts`)',
  'demo-content': 'treść demo udająca agenta i użytkownika (prompty, odpowiedzi, notatki, słowa wyzwalaczy atrapy), '
    + 'nie zdanie serwera',
};

const czytajJson = <T>(plik: string): T => JSON.parse(readFileSync(path.join(REPO, plik), 'utf8')) as T;
const WYJATKI: Wyjatki = czytajJson<{ pliki: Wyjatki }>(WYJATKI_PLIK).pliki;

const ADVICE = [
  'Polish literals in server code outside the exceptions.',
  'What to do: move a sentence for the app to the sentence registry (`say()` with a code); add text that never',
  `reaches the app to ${WYJATKI_PLIK} under a class with a reason (KLASY in this test).`,
] as const;

/** Files with Polish literals outside the exceptions, one line per file (`file: count`), sorted. */
function naruszenia(liczby: ReadonlyMap<string, number>): string[] {
  return [...liczby].filter(([, n]) => n > 0).map(([plik, n]) => `${plik}: ${String(n)}`).sort();
}

/** Failure message: advice, then each offending file with its literal lines (`line: text`). */
function komunikat(wynik: Policzone): string {
  const pliki = [...wynik.liczby].filter(([, n]) => n > 0).map(([plik]) => plik).sort();
  return [...ADVICE, ...pliki.flatMap((plik) => [`${plik}:`, ...(wynik.linie.get(plik) ?? []).map((l) => `  ${l}`)])]
    .join('\n');
}

/** Pliki kodu `server/src/**` i `shared/src/**` widoku eksportu (ścieżka → treść). */
const plikiZakresu = (): Map<string, string> => new Map(['server/src', 'shared/src'].flatMap((katalog) =>
  [...repoTextFiles(REPO, katalog, (plik) => !inExportView(plik) || !plikKodu(plik))]));

/** Reguła: plik (albo jedno pole obiektów pliku), którego polskie literały zostają polskie bez wpisu na literał. */
interface Regula {
  readonly plik: string;
  /** Klasa z {@link KLASY}: powód, dla którego tekst nie trafia do apki. */
  readonly klasa: string;
  /** Nazwa pola obiektu (`what: '…'`), którego wartość zdejmuje reguła; bez pola reguła zdejmuje cały plik. */
  readonly pole?: string;
}

const SYGNATURY = 'server/src/herdr/dialogs/screen/signatures.ts';
const DEMO_PL = 'server/src/demo/content/pl.ts';

const REGULY: readonly Regula[] = [
  // Treść demo: cały plik udaje rozmowę człowieka z agentem; nowy seed albo odpowiedź atrapy nie wymaga wpisu.
  { plik: DEMO_PL, klasa: 'demo-content' },
  // Rejestr sygnatur ekranu: `what` opisuje sygnaturę dla człowieka; `noFixture` i reszta pól liczą się dalej.
  { plik: SYGNATURY, klasa: 'registry-description', pole: 'what' },
];

interface Wezel {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [pole: string]: unknown;
}

const wezel = (x: unknown): Wezel | null =>
  typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string' ? x as Wezel : null;

/**
 * Kod z wartościami pola `pole` (`pole: '…'` w literale obiektu, klucz nazwą albo napisem, bez `[…]`) zastąpionymi
 * pustym napisem. Znaki końca linii wartości zostają, więc numery linii reszty literałów się nie zmieniają.
 * Kod, którego parser nie czyta, wraca bez zmian (`polskieLiteraly` zgłosi go jako nieczytelny).
 */
function bezPola(kod: string, pole: string): string {
  let ast: Wezel | null;
  try {
    ast = wezel(parseAst(kod, { lang: 'ts', sourceType: 'module' }));
  } catch {
    return kod;
  }
  const zakresy: { start: number; end: number }[] = [];
  const przejdz = (n: Wezel): void => {
    const klucz = wezel(n['key']);
    const wartosc = wezel(n['value']);
    if (n.type === 'Property' && n['computed'] !== true && klucz !== null && wartosc !== null
      && (klucz['name'] === pole || (klucz.type === 'Literal' && klucz['value'] === pole))) {
      zakresy.push({ start: wartosc.start, end: wartosc.end });
      return;
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'type' || v === null || typeof v !== 'object') continue;
      for (const dziecko of Array.isArray(v) ? v : [v]) {
        const w = wezel(dziecko);
        if (w !== null) przejdz(w);
      }
    }
  };
  if (ast !== null) przejdz(ast);
  let wynik = kod;
  for (const { start, end } of zakresy.sort((a, b) => b.start - a.start)) {
    wynik = `${wynik.slice(0, start)}''${wynik.slice(start, end).replace(/[^\n]/gu, '')}${wynik.slice(end)}`;
  }
  return wynik;
}

/**
 * Polskie literały plików po regułach i liczba literałów, które zdjęła każda reguła (indeks w `reguly`). Reguła
 * pola liczy literały pliku z wartościami pola zastąpionymi pustym napisem; reguła bez pola pomija cały plik.
 * Liczbę zdjętych literałów daje porównanie samego pliku reguły przed i po.
 */
function poRegulach(pliki: ReadonlyMap<string, string>, reguly: readonly Regula[] = REGULY):
  Literaly & { readonly zdjete: readonly number[] } {
  const bez = (plik: string, kod: string): string =>
    reguly.reduce((k, r) => (r.plik === plik && r.pole !== undefined ? bezPola(k, r.pole) : k), kod);
  const wynik = polskieLiteraly(new Map([...pliki].map(([plik, kod]) => [plik, bez(plik, kod)])));
  const calePliki = new Set(reguly.filter((r) => r.pole === undefined).map((r) => r.plik));
  const ile = (plik: string, kod: string): number => polskieLiteraly(new Map([[plik, kod]])).literaly.length;
  return {
    literaly: wynik.literaly.filter((l) => !calePliki.has(l.plik)),
    nieczytelne: wynik.nieczytelne,
    zdjete: reguly.map(({ plik, pole }) => {
      const kod = pliki.get(plik);
      if (kod === undefined) return 0;
      return ile(plik, kod) - (pole === undefined ? 0 : ile(plik, bezPola(kod, pole)));
    }),
  };
}

const jeden = (kod: string, plik = 'server/src/proba.ts'): PolskiLiteral[] =>
  [...polskieLiteraly(new Map([[plik, kod]])).literaly];

describe('zapadka literałów: co jest polskim literałem (dane syntetyczne)', () => {
  it('napis i szablon z polskim kawałkiem liczą się; angielski, komentarz, wzorzec i specyfikator modułu nie', () => {
    const kod = [
      "export const a = 'Nie ma takiej sesji.';",
      'export const b = "brak pliku";',
      'export const c = `Sesja ${id} nie odpowiada`;',
      "export const d = 'No such session.';",
      '// Nie ma takiej sesji.',
      '/* brak pliku */',
      'export const e = /łódź/u;',
      "import x from './łódź.ts';",
      "export { y } from './łódź.ts';",
      "export const f = await import('./łódź.ts');",
      "export const g = 'jest';",
    ].join('\n');
    expect(jeden(kod)).toEqual([
      { plik: 'server/src/proba.ts', linia: 1, tekst: 'Nie ma takiej sesji.' },
      { plik: 'server/src/proba.ts', linia: 2, tekst: 'brak pliku' },
      { plik: 'server/src/proba.ts', linia: 3, tekst: 'Sesja ${…} nie odpowiada' },
      { plik: 'server/src/proba.ts', linia: 11, tekst: 'jest' },
    ]);
  });

  it('literał w interpolacji angielskiego szablonu liczy się sam; białe znaki ściśnięte', () => {
    expect(jeden("export const a = `id: ${ok ? 'gotowe' : 'ready'}`;").map((l) => l.tekst)).toEqual(['gotowe']);
    expect(jeden('export const a = `Sesja\n   nie odpowiada`;')).toEqual([
      { plik: 'server/src/proba.ts', linia: 1, tekst: 'Sesja nie odpowiada' },
    ]);
  });

  it('tekst logu `server/src` odpada (liczy go zapadka logu); poza `server/src` i poza logiem zostaje', () => {
    const kod = ["console.warn('Serwer nie odpowiada');", "throw new Error('Serwer nie odpowiada');"].join('\n');
    expect(jeden(kod).map((l) => l.linia)).toEqual([2]);
    expect(jeden(kod, 'shared/src/proba.ts').map((l) => l.linia)).toEqual([1, 2]);
  });

  it('plik, którego parser nie czyta, jest nieczytelny', () => {
    expect(polskieLiteraly(new Map([['server/src/zly.ts', 'const = ;']])).nieczytelne).toEqual(['server/src/zly.ts']);
  });

  it('wyjątek zdejmuje jeden literał o swoim tekście; drugie wystąpienie się liczy; wpis bez literału jest martwy', () => {
    const literaly = jeden(["export const a = 'brak pliku';", "export const b = 'brak pliku';"].join('\n'));
    const wynik = policz(literaly, { 'server/src/proba.ts': { 'internal-file': ['brak pliku', 'nie ma'] } });
    expect(wynik.liczby).toEqual(new Map([['server/src/proba.ts', 1]]));
    expect(wynik.linie.get('server/src/proba.ts')).toEqual(['2: brak pliku']);
    expect(wynik.martwe).toEqual([{ plik: 'server/src/proba.ts', klasa: 'internal-file', tekst: 'nie ma' }]);
  });

  it('reguła pola `what` rejestru sygnatur: wartość pola nie liczy się; inne pole, stała i inny plik tak', () => {
    const kod = [
      'export const R = {',
      "  a: { what: 'górna krawędź ramki', pattern: 'brak pliku' },",
      '  b: {',
      "    what: 'długi opis '",
      "      + 'w dwóch kawałkach',",
      "    noFixture: 'żadnego pomiaru',",
      '  },',
      '  c: { what: `szablon ${x} ręczny` },',
      "  d: { 'what': 'klucz w cudzysłowie' },",
      '};',
      "export const what = 'stała, nie pole';",
    ].join('\n');
    const wynik = poRegulach(new Map([[SYGNATURY, kod]]));
    expect(wynik.literaly).toEqual([
      { plik: SYGNATURY, linia: 2, tekst: 'brak pliku' },
      { plik: SYGNATURY, linia: 6, tekst: 'żadnego pomiaru' },
      { plik: SYGNATURY, linia: 11, tekst: 'stała, nie pole' },
    ]);
    expect(wynik.zdjete[REGULY.findIndex((r) => r.plik === SYGNATURY)]).toBe(5);
    expect(poRegulach(new Map([['server/src/inny.ts', kod]])).literaly).toHaveLength(8);
  });

  it('failure message names the file and the literal line, without baseline advice', () => {
    const tekst = komunikat(policz(jeden("export const a = 'Nie ma takiej sesji.';"), {}));
    expect(tekst).toContain('server/src/proba.ts');
    expect(tekst).toContain('1: Nie ma takiej sesji.');
    expect(tekst).not.toMatch(/baz[aęy]|baseline/iu);
  });

  it('reguła całego pliku treści demo: żaden literał pliku się nie liczy; ten sam kod w innym pliku tak', () => {
    const kod = ["export const a = 'brak pliku';", "export const b = { what: 'żadnego pomiaru' };"].join('\n');
    const wynik = poRegulach(new Map([[DEMO_PL, kod], ['server/src/inny.ts', kod]]));
    expect(wynik.literaly.map((l) => `${l.plik}:${String(l.linia)}`))
      .toEqual(['server/src/inny.ts:1', 'server/src/inny.ts:2']);
    expect(wynik.zdjete[REGULY.findIndex((r) => r.plik === DEMO_PL)]).toBe(2);
  });
});

describe('zapadka literałów: repo', () => {
  const pliki = plikiZakresu();
  const { literaly, nieczytelne, zdjete } = poRegulach(pliki);

  it('zakres: kod `server/src` i `shared/src` widoku eksportu; parser czyta każdy plik', () => {
    for (const plik of ['server/src/router.ts', 'server/src/sessions/manager.ts', 'shared/src/protocol.ts',
      'shared/src/relay.ts', 'server/src/demo/seeds.ts']) {
      expect(pliki.has(plik), plik).toBe(true);
    }
    expect(pliki.size).toBeGreaterThan(200);
    expect(nieczytelne, 'pliki, których parser nie przeczytał').toEqual([]);
  });

  it('wyjątki: każda klasa ma powód, każda klasa z KLASY jest użyta, plik wyjątku jest w zakresie', () => {
    const uzyte = new Set(Object.values(WYJATKI).flatMap((klasy) => Object.keys(klasy)));
    expect([...uzyte].filter((k) => !(k in KLASY)), 'klasa bez powodu w KLASY').toEqual([]);
    expect(Object.keys(KLASY).filter((k) => !uzyte.has(k)), 'klasa w KLASY bez wyjątku').toEqual([]);
    for (const klasa of Object.keys(KLASY)) expect(klasa).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    expect(Object.keys(WYJATKI).filter((plik) => !pliki.has(plik)), 'plik wyjątku poza zakresem').toEqual([]);
  });

  it('reguły: klasa z KLASY, plik w zakresie, każda zdejmuje co najmniej jeden literał', () => {
    expect(REGULY.map((r) => r.plik).sort()).toEqual([DEMO_PL, SYGNATURY].sort());
    for (const [i, regula] of REGULY.entries()) {
      expect(regula.klasa in KLASY, `${regula.plik}: klasa ${regula.klasa} bez powodu`).toBe(true);
      expect(pliki.has(regula.plik), `${regula.plik}: plik reguły poza zakresem`).toBe(true);
      expect(zdjete[i] ?? 0, `${regula.plik}: reguła niczego nie zdejmuje`).toBeGreaterThan(0);
    }
  });

  it('mutation fails the ban: a planted Polish literal does; English, a comment and log text do not', () => {
    const zmien = (plik: string, dopisek: string): Map<string, string> =>
      new Map([...pliki].map(([p, t]) => [p, p === plik ? `${t}\n${dopisek}\n` : t]));
    const raport = (mapa: Map<string, string>): string[] =>
      naruszenia(policz(poRegulach(mapa).literaly, WYJATKI).liczby);
    const stan = raport(pliki);
    const nowe = (mapa: Map<string, string>): string[] => raport(mapa).filter((g) => !stan.includes(g));
    expect(nowe(zmien('server/src/router.ts', "export const probaZapadki = 'Nie ma takiej sesji.';")))
      .toEqual([expect.stringMatching(/^server\/src\/router\.ts: /u)]);
    expect(nowe(zmien('server/src/health.ts', 'export const probaZapadki = `Serwer ${x} nie odpowiada`;')))
      .toEqual([expect.stringMatching(/^server\/src\/health\.ts: /u)]);
    expect(nowe(zmien('shared/src/protocol.ts', "export const probaZapadki = 'brak pliku';")))
      .toEqual([expect.stringMatching(/^shared\/src\/protocol\.ts: /u)]);
    for (const dopisek of ["export const probaZapadki = 'No such session.';", '// Nie ma takiej sesji.',
      "console.warn('Serwer nie odpowiada');"]) {
      expect(nowe(zmien('server/src/router.ts', dopisek)), dopisek).toEqual([]);
    }
    // Tekst wyjątku dopisany drugi raz nie ma swojego wpisu, więc się liczy.
    expect(nowe(zmien('server/src/cli/io.ts', "export const probaZapadki = 'tak';")))
      .toEqual([expect.stringMatching(/^server\/src\/cli\/io\.ts: /u)]);
    // Reguły: w rejestrze sygnatur zdejmują tylko pole `what`, w treści demo cały plik.
    expect(nowe(zmien(SYGNATURY, "export const probaZapadki = { what: 'opis próby', pattern: 'Nie ma sesji.' };")))
      .toEqual([expect.stringMatching(/^server\/src\/herdr\/dialogs\/screen\/signatures\.ts: /u)]);
    expect(nowe(zmien(SYGNATURY, "export const probaZapadki = 'Nie ma takiej sesji.';")))
      .toEqual([expect.stringMatching(/^server\/src\/herdr\/dialogs\/screen\/signatures\.ts: /u)]);
    expect(nowe(zmien(SYGNATURY, "export const probaZapadki = { what: 'opis próby zapadki' };"))).toEqual([]);
    expect(nowe(zmien(DEMO_PL, "export const probaZapadki = 'Nie ma takiej sesji.';"))).toEqual([]);
  }, 120_000); // Każda mutacja liczy całe drzewo od nowa (odcięcie logu sięga stałych między plikami).

  it('dzwonek kafla bez kluczy (`LIVE_ACTIVITY_CHIME`) stoi w wyjątkach; brak jednego wpisu przewraca skan', () => {
    const plik = 'server/src/notify/apns-payload.ts';
    const klasy = WYJATKI[plik] ?? {};
    const dzwonek = klasy['relay-placeholder'] ?? [];
    expect([...dzwonek].sort()).toEqual(['Agent skończył', 'Wynik czeka w Rarogu']);
    const przed = naruszenia(policz(literaly, WYJATKI).liczby);
    for (const tekst of dzwonek) {
      const bez: Wyjatki = {
        ...WYJATKI, [plik]: { ...klasy, 'relay-placeholder': dzwonek.filter((t) => t !== tekst) },
      };
      const wzrosty = naruszenia(policz(literaly, bez).liczby).filter((g) => !przed.includes(g));
      expect(wzrosty, tekst).toEqual([expect.stringMatching(/^server\/src\/notify\/apns-payload\.ts: /u)]);
    }
  });

  it('no Polish literal outside the exceptions; every exception removes a literal', () => {
    const wynik = policz(literaly, WYJATKI);
    expect(naruszenia(wynik.liczby), komunikat(wynik)).toEqual([]);
    expect(wynik.martwe.map((w) => `${w.plik} [${w.klasa}]: „${w.tekst}”`),
      `martwe wyjątki: usuń wpis z ${WYJATKI_PLIK}`).toEqual([]);
  });
});
