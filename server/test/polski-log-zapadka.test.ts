/**
 * Zapadka polskiego tekstu w logu serwera: liczba linii
 * kodu `server/src/**` z polskim tekstem, który trafia do `server.log`, per plik nie rośnie wobec `BAZA_LOGU`, a baza
 * wyższa niż stan też jest czerwona, więc każde tłumaczenie ją obniża, aż do zera. Mechanizm (producent logu, co
 * jest tekstem linii, nośniki, znane dziury): `polski-log.ts`; reguła słowa: `polski-tekst.ts` i `SLOWA_LOGU`.
 *
 * Osobny strażnik obok `polski-tekst-zapadka.test.ts`, bo mierzy innym mechanizmem (drzewo składni, nie linie
 * napisów) inną rzecz (tekst logu, nie każdy napis pliku). Plik w zakresie obu (`index.ts`, `auth/admin.ts`,
 * `install/sdk.ts`) liczy się w obu, każda zapadka swoje. Liczy się tylko widok eksportu (`inExportView`), więc baza
 * jest ta sama w repo źródłowym i w eksporcie; test nie czyta plików prywatnych.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOSNIKI, SLOWA_LOGU, SLOWA_LOGU_LISTA, miejscaLogu, type Nosnik } from './polski-log.ts';
import { SLOWA, polskieSlowa, type Wyjatek } from './polski-tekst.ts';
import { REPO, inExportView, ratchet, ratchetMessage } from './private-guard.ts';
import { repoTextFiles } from './source-scan.ts';

/** Powód wyjątków cienia: stan i powód rekordu cyklu to wartości maszynowe, linia logu je tylko cytuje. */
const CIEN = 'stan albo powód rekordu cyklu cienia (`decisions/<sesja>/<klucz>.json`, `SHADOW_DECISION_STATES`'
  + ' w `shadow/files.ts`): wartość maszynowa, linia logu ją tylko cytuje';

/**
 * Linie, które zostają polskie, z powodem. Lista zamknięta: wpis to cała linia po `trim()`, a wpis, który nie trafia
 * polskiej linii tekstu logu, przewraca test.
 */
const WYJATKI: readonly Wyjatek[] = [
  "if (outcome === 'revoked') return finish(record, 'anulowany', reason);",
  "return finish(record, 'unknown', 'zniknal');",
  "if (state === 'revoked') return finish(record, 'anulowany', 'odwolany');",
  "if (state === 'none') return finish(record, 'unknown', 'zniknal');",
  ".catch(() => { finish(current, 'unknown', 'blad'); });",
  "track(check(record, true).then(() => undefined).catch(() => { finish(record, 'unknown', 'blad'); }));",
  "finish(base, 'unknown', 'zapis');",
].map((linia) => ({ plik: 'server/src/herdr/dialogs/shadow/channel.ts', linia, powod: CIEN }));

/** Polskie linie tekstu logu per plik widoku eksportu. Tylko obniżasz: wzrost znaczy nowy polski tekst w logu. */
const BAZA_LOGU: Readonly<Record<string, number>> = {
};

const RADA = [
  'Wzrost: napisz tekst logu po angielsku; wartość maszynowa, która musi zostać po polsku, idzie do WYJATKI',
  'z powodem i całą linią. Bazy nie podnoś. Spadek: obniż bazę (tabela niżej). Linie ze wzrostem są na końcu.',
] as const;

/** Pliki `server/src/**` widoku eksportu, które czyta mechanizm (ścieżka → treść). */
const plikiZakresu = (): Map<string, string> => repoTextFiles(REPO, 'server/src', (plik) =>
  !inExportView(plik) || !plik.endsWith('.ts') || plik.endsWith('.d.ts'));

interface Policzone {
  readonly liczby: Map<string, number>;
  /** Plik → linie po `trim()` z polskim tekstem logu (bez wyjątków), do komunikatu porażki. */
  readonly linie: Map<string, string[]>;
  readonly martwe: readonly Wyjatek[];
}

/** Linie z polskim tekstem logu per plik, bez linii z wyjątków. */
function policz(
  pliki: ReadonlyMap<string, string>, wyjatki: readonly Wyjatek[], nosniki?: readonly Nosnik[],
): Policzone {
  const liczby = new Map<string, number>();
  const linie = new Map<string, string[]>();
  const uzyte = new Set<Wyjatek>();
  for (const [plik, numery] of miejscaLogu(pliki, nosniki).linie) {
    const zrodlo = pliki.get(plik)!.split('\n');
    const wlasne: string[] = [];
    for (const nr of numery) {
      const tekst = zrodlo[nr - 1]!.trim();
      const wyjatek = wyjatki.find((w) => w.plik === plik && w.linia === tekst);
      if (wyjatek === undefined) wlasne.push(`${String(nr)}: ${tekst}`);
      else uzyte.add(wyjatek);
    }
    if (wlasne.length > 0) {
      liczby.set(plik, wlasne.length);
      linie.set(plik, wlasne);
    }
  }
  return { liczby, linie, martwe: wyjatki.filter((w) => !uzyte.has(w)) };
}

/** Polskie linie tekstu logu jednego pliku syntetycznego (numery linii). */
const linieLogu = (kod: string, nosniki: readonly Nosnik[] = []): readonly number[] =>
  miejscaLogu(new Map([['server/src/proba.ts', kod]]), nosniki).linie.get('server/src/proba.ts') ?? [];

describe('zapadka logu: reguła słowa', () => {
  it('SLOWA_LOGU: małe litery ASCII, od dwóch liter, posortowana, bez powtórzeń, rozłączna z SLOWA_LISTA', () => {
    for (const slowo of SLOWA_LOGU_LISTA) {
      expect(slowo, slowo).toMatch(/^[a-z]{2,}$/u);
      expect(SLOWA.has(slowo), `${slowo} jest już w SLOWA_LISTA`).toBe(false);
    }
    expect([...SLOWA_LOGU_LISTA].sort()).toEqual(SLOWA_LOGU_LISTA);
    expect(SLOWA_LOGU.size).toBe(SLOWA_LOGU_LISTA.length);
  });

  it('SLOWA_LOGU nie trafia angielskiego tekstu: angielskie pliki wejścia i dokumentacja zależności', () => {
    const korzen = path.join(REPO, 'node_modules', '.pnpm');
    expect(existsSync(korzen), 'brak node_modules: pnpm install').toBe(true);
    const pliki = ['SECURITY.md', 'CONTRIBUTING.md', 'docs/README.md'].map((plik) => path.join(REPO, plik));
    for (const paczka of readdirSync(korzen)) {
      const nm = path.join(korzen, paczka, 'node_modules');
      if (!existsSync(nm)) continue;
      // Własny katalog paczki; zależności to dowiązania do innych wpisów `.pnpm`, więc odpadają.
      for (const wpis of readdirSync(nm, { withFileTypes: true })) {
        if (wpis.isSymbolicLink() || !wpis.isDirectory()) continue;
        const katalogi = wpis.name.startsWith('@')
          ? readdirSync(path.join(nm, wpis.name), { withFileTypes: true }).filter((w) => w.isDirectory())
            .map((w) => path.join(nm, wpis.name, w.name))
          : [path.join(nm, wpis.name)];
        for (const katalog of katalogi) {
          pliki.push(...readdirSync(katalog).filter((w) => /\.md$/iu.test(w)).map((w) => path.join(katalog, w)));
        }
      }
    }
    expect(pliki.length).toBeGreaterThan(50);
    const slowaLogu = (l: string): string[] =>
      polskieSlowa(l, false, SLOWA_LOGU).filter((s) => SLOWA_LOGU.has(s.toLowerCase()));
    const trafienia = pliki.flatMap((plik) => readFileSync(plik, 'utf8').split('\n')
      .filter((l) => slowaLogu(l).length > 0)
      .map((l) => `${path.relative(REPO, plik)}: [${slowaLogu(l).join(', ')}] ${l.trim().slice(0, 120)}`));
    expect(trafienia, 'słowo z SLOWA_LOGU trafia angielski tekst: usuń je z listy').toEqual([]);
  });
});

describe('zapadka logu: co jest tekstem logu (dane syntetyczne)', () => {
  it('kształty: log, log?.(, log.info, this.log.error, this.#log, safeLog, logOnce, logger?.(, console', () => {
    const kod = [
      "log('Serwer nie odpowiada');",
      "log?.('Serwer nie odpowiada');",
      "log.info('Serwer nie odpowiada');",
      "this.log.error('Serwer nie odpowiada');",
      "class A { #log(t: string) { void t; } m() { this.#log('Serwer nie odpowiada'); } }",
      "safeLog('Serwer nie odpowiada');",
      "logOnce('Serwer nie odpowiada');",
      "config.logger?.('Serwer nie odpowiada');",
      "console.warn('Serwer nie odpowiada');",
      "audit.log('Serwer nie odpowiada');",
      "appendClientLog('Serwer nie odpowiada');",
      "show('Serwer nie odpowiada');",
      "log('The server does not respond');",
      '// log(\'Serwer nie odpowiada\');',
    ].join('\n');
    expect(linieLogu(kod)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('szablon: kawałki tekstu; interpolacja według tych samych reguł; napis przez kilka linii po liniach', () => {
    expect(linieLogu('log(`push: ${projekt} — wysłane`);')).toEqual([1]);
    expect(linieLogu('log(`push: ${"nieudane"}`);')).toEqual([1]);
    expect(linieLogu('log(`push: ${projekt} sent`);')).toEqual([]);
    expect(linieLogu('log(`push:\nnie odpowiada`);')).toEqual([2]);
    expect(linieLogu("log('push: a\\nnie odpowiada');")).toEqual([1]);
  });

  it('stała modułu, zmienna lokalna, słownik, `?:`, `+`, `[…].join`', () => {
    expect(linieLogu(["const X = 'serwer nie odpowiada';", 'log(`${X} 1`);'].join('\n'))).toEqual([1]);
    expect(linieLogu(['function f() {', "  const why = 'brak pliku';", '  log(`a: ${why}`);', '}'].join('\n')))
      .toEqual([2]);
    expect(linieLogu(["const L = { a: 'nieudane', b: 'ok' };", 'log(`x ${L[k]}`);'].join('\n'))).toEqual([1]);
    expect(linieLogu(["const L = { a: 'nieudane', b: 'ok' };", 'log(`x ${L.b}`);'].join('\n'))).toEqual([]);
    expect(linieLogu(["log(ok ? 'gotowe' : 'brak pliku');", "log('a' + 'tylko');", "log(['bez', 'x'].join(' '));"]
      .join('\n'))).toEqual([1, 2, 3]);
  });

  it('nazwa lokalna przesłania stałą modułu; parametr to dane', () => {
    const kod = [
      "const why = 'brak pliku';",
      'function f(why: string) { log(`a: ${why}`); }',
      "function g() { const L = { a: 'x' }; log(`a: ${L.a}`); }",
      "const L = { a: 'nieudane' };",
    ].join('\n');
    expect(linieLogu(kod)).toEqual([]);
  });

  it('parametr wpleciony w tekst: argument każdego wywołania funkcji w tym samym pliku', () => {
    const kod = [
      'function g(reason: string) { log(`x: ${reason}`); }',
      "g('brak pliku');",
      "g('missing file');",
      "obj.g('wpis nieudany');",
    ].join('\n');
    expect(linieLogu(kod)).toEqual([2, 4]);
  });

  it('budowniczy: napisy z ciała funkcji z tego pliku i funkcji, które ona woła', () => {
    const kod = [
      "function szczegol(): string { return 'brak pliku'; }",
      'function linia(): string { return `x ${szczegol()}`; }',
      'log(linia());',
      "function inna(): string { return 'nie idzie do logu'; }",
    ].join('\n');
    expect(linieLogu(kod)).toEqual([1]);
  });

  it('budowniczy zwraca stałą bez napisu w swoim ciele: stała modułu, importowana, `?:`, strzałka', () => {
    expect(linieLogu(["const REVIEW_LOG = 'serwer nie odpowiada';", 'function linia(): string { return REVIEW_LOG; }',
      'log(linia());'].join('\n'))).toEqual([1]);
    expect(linieLogu(["const A = 'brak pliku';", "const B = 'missing';", 'const linia = (x: boolean) => x ? A : B;',
      'log(linia(true));'].join('\n'))).toEqual([1]);
    expect(linieLogu(['function linia(why: string): string { return why; }', 'log(linia(x));'].join('\n')))
      .toEqual([]);
    const pliki = new Map([
      ['server/src/a.ts', "export const A_LOG = 'serwer nie odpowiada';"],
      ['server/src/b.ts', "import { A_LOG } from './a.ts';\nfunction linia(): string { return A_LOG; }\nlog(linia());"],
    ]);
    expect([...miejscaLogu(pliki, []).linie]).toEqual([['server/src/a.ts', [1]]]);
  });

  it('stała z pliku względnego liczy się w swoim pliku', () => {
    const pliki = new Map([
      ['server/src/a.ts', "export const A_LOG = 'serwer nie odpowiada';"],
      ['server/src/b.ts', "import { A_LOG } from './a.ts';\nlog(`${A_LOG} 1`);"],
    ]);
    expect([...miejscaLogu(pliki, []).linie]).toEqual([['server/src/a.ts', [1]]]);
  });

  it('nośnik z listy: wywołanie, pole, budowniczy; nośnik bez napisu jest martwy; zły plik jest nieczytelny', () => {
    const plik = 'server/src/proba.ts';
    const nosniki: Nosnik[] = [
      { plik, wywolanie: 'note', argument: 0, dokad: 'test' },
      { plik, pole: 'logLine', dokad: 'test' },
      { plik, budowniczy: 'opis', dokad: 'test' },
      { plik, wywolanie: 'nieMa', argument: 0, dokad: 'test' },
    ];
    const kod = [
      "this.note('katalog komend: nie czytam pliku');",
      "const wynik = { logLine: 'nieudane próby' };",
      "function opis(): string { return 'brak pliku'; }",
    ].join('\n');
    const wynik = miejscaLogu(new Map([[plik, kod], ['server/src/zly.ts', 'const = ;']]), nosniki);
    expect(wynik.linie.get(plik)).toEqual([1, 2, 3]);
    expect(wynik.martweNosniki).toEqual([nosniki[3]]);
    expect(wynik.nieczytelne).toEqual(['server/src/zly.ts']);
  });

  it('słowo z SLOWA_LOGU liczy się w logu, angielskie nie', () => {
    expect(linieLogu("log('push: APNs nieudane');")).toEqual([1]);
    expect(linieLogu("log('push: APNs failed');")).toEqual([]);
  });

  it('wyjątek zdejmuje swoją linię; wyjątek bez polskiej linii logu jest martwy', () => {
    const plik = 'server/src/proba.ts';
    const pliki = new Map([[plik, "log('brak pliku');\nlog('tylko raz');"]]);
    const zywy: Wyjatek = { plik, linia: "log('brak pliku');", powod: 'test' };
    const martwy: Wyjatek = { plik, linia: "log('missing');", powod: 'test' };
    const wynik = policz(pliki, [zywy, martwy], []);
    expect(wynik.liczby).toEqual(new Map([[plik, 1]]));
    expect(wynik.martwe).toEqual([martwy]);
  });
});

describe('zapadka logu: repo', () => {
  const pliki = plikiZakresu();

  it('zakres: pliki `server/src/**/*.ts` widoku eksportu; parser czyta każdy, nośniki żyją', () => {
    for (const plik of ['server/src/index.ts', 'server/src/router.ts', 'server/src/sessions/manager.ts',
      'server/src/term/registry.ts', 'server/src/notify/index.ts', ...NOSNIKI.map((n) => n.plik)]) {
      expect(pliki.has(plik), plik).toBe(true);
    }
    expect(pliki.size).toBeGreaterThan(150);
    const wynik = miejscaLogu(pliki);
    expect(wynik.nieczytelne, 'pliki, których parser nie przeczytał').toEqual([]);
    expect(wynik.martweNosniki, 'nośnik bez napisu: zmienił się kanał, popraw NOSNIKI').toEqual([]);
  });

  it('mutacje na każdym pliku: polskie zdanie w logu +1; angielskie, komentarz i napis poza logiem +0', () => {
    const dopiski = [
      ["console.warn('Serwer nie odpowiada, sprawdz konfiguracje');", 1],
      ["console.warn('The server does not respond');", 0],
      ['// Serwer nie odpowiada, sprawdz konfiguracje', 0],
      ["export const probaZapadki = 'Serwer nie odpowiada';", 0],
    ] as const;
    const slepe: string[] = [];
    for (const [plik, tresc] of pliki) {
      const ile = (kod: string): number => miejscaLogu(new Map([[plik, kod]]), []).linie.get(plik)?.length ?? 0;
      const przed = ile(tresc);
      for (const [dopisek, oczekiwane] of dopiski) {
        const po = ile(`${tresc.replace(/\n?$/u, '\n')}${dopisek}\n`) - przed;
        if (po !== oczekiwane) slepe.push(`${plik}: „${dopisek}” daje ${String(po)}`);
      }
    }
    expect(slepe).toEqual([]);
  });

  it('mutacja przewraca zapadkę: polskie zdanie w logu pliku z bazą i bez niej; angielskie nie', () => {
    const dopisz = (mapa: ReadonlyMap<string, string>, plik: string, dopisek: string): Map<string, string> =>
      new Map([...mapa].map(([p, t]) => [p, p === plik ? `${t}\n${dopisek}\n` : t]));
    const zmien = (plik: string, dopisek: string): Map<string, string> => dopisz(pliki, plik, dopisek);
    const wzrost = (mapa: Map<string, string>, baza = BAZA_LOGU): string[] =>
      ratchet(policz(mapa, WYJATKI).liczby, baza, false).grown;
    // Plik z bazą: po tłumaczeniu wszystkie bazy są zerowe, więc bazę 1 daje jedna dopisana polska linia.
    const zBaza = zmien('server/src/term/registry.ts', "console.warn('term: panel nie wstał');");
    const baza = { ...BAZA_LOGU, 'server/src/term/registry.ts': 1 };
    expect(wzrost(zBaza, baza)).toEqual([]);
    expect(wzrost(dopisz(zBaza, 'server/src/term/registry.ts', "console.warn('term: panel padł');"), baza))
      .toEqual([expect.stringMatching(/^server\/src\/term\/registry\.ts: /u)]);
    expect(wzrost(zBaza)).toEqual([expect.stringMatching(/^server\/src\/term\/registry\.ts: /u)]);
    expect(wzrost(zmien('server/src/health.ts', "console.warn('http: serwer nie odpowiada');")))
      .toEqual([expect.stringMatching(/^server\/src\/health\.ts: /u)]);
    expect(wzrost(zmien('server/src/term/registry.ts', "console.warn('term: pane did not start');"))).toEqual([]);
  });

  it('nośnik `noResultCause` (`notify/index.ts`): polski powód ciszy +1, angielski +0, bez nośnika +0', () => {
    const plik = 'server/src/notify/index.ts';
    const tresc = pliki.get(plik)!;
    const ile = (kod: string, nosniki?: readonly Nosnik[]): number =>
      miejscaLogu(new Map([[plik, kod]]), nosniki).linie.get(plik)?.length ?? 0;
    const angielski = "turn: 'turn after a subagent standby alone'";
    expect(tresc.split(angielski), 'napis w `noResultCause` się zmienił: popraw test').toHaveLength(2);
    const polski = tresc.replace(angielski, "turn: 'tura po samym postoju subagenta'");
    const przed = ile(tresc);
    expect(ile(polski) - przed).toBe(1);
    expect(ile(tresc.replace(angielski, "turn: 'turn after a lone subagent standby'")) - przed).toBe(0);
    // Napis wraca z funkcji przez pole obiektu, więc bez nośnika mechanizm go nie widzi: łapie go wpis NOSNIKI.
    const bezNosnika = NOSNIKI.filter((n) => !('budowniczy' in n && n.budowniczy === 'noResultCause'));
    expect(bezNosnika).toHaveLength(NOSNIKI.length - 1);
    expect(ile(polski, bezNosnika) - ile(tresc, bezNosnika)).toBe(0);
  });

  it('liczba polskich linii tekstu logu per plik nie rośnie i nie spada poniżej bazy; wyjątki żyją', () => {
    const wynik = policz(pliki, WYJATKI);
    const raport = ratchet(wynik.liczby, BAZA_LOGU, false);
    const wzrosty = raport.grown.map((linia) => linia.slice(0, linia.indexOf(':')))
      .flatMap((plik) => [`${plik}:`, ...(wynik.linie.get(plik) ?? []).map((l) => `  ${l}`)]);
    expect(raport.grown.length + raport.stale.length,
      [ratchetMessage('Polskie linie logu', raport, wynik.liczby, RADA), ...wzrosty].join('\n')).toBe(0);
    expect(wynik.martwe.map((w) => `${w.plik}: „${w.linia}”`), 'martwe wyjątki').toEqual([]);
  });
});
