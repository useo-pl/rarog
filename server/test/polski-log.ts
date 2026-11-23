/**
 * Mechanizm zapadki polskiego tekstu w `server.log`:
 * które linie kodu `server/src/**` niosą tekst, który trafia do logu serwera. Test i baza:
 * `polski-log-zapadka.test.ts`.
 * Regułę słowa („czy tekst jest polski”) bierze z `polski-tekst.ts`, więc obie zapadki mierzą tym samym, z jedną
 * różnicą: lista słów ASCII dostaje {@link SLOWA_LOGU}, słowa tekstów logu, których wspólna lista nie zna.
 *
 * Producent logu (definicja skanera): wywołanie, którego wywoływany, z `?.` zapisanym jak `.`, pasuje
 * do {@link LOG_CALLEE} (`log(`, `log?.(`, `log.info(`, `this.log.error(`, `this.#log(`, `safeLog(`, `logOnce(`,
 * `config.logger?.(`, `console.warn(` …), a nie do {@link NOT_LOG} (`audit.log(` pisze `herdr-audit.log`, rekordy
 * JSON z wartościami maszynowymi; `client.log` pisze apka). Tekst linii to pierwszy argument, rozwinięty:
 * - napis, szablon (interpolacja `${…}` to dane, chyba że rozwija się według tych samych reguł), `+`, `?:`, `||`,
 *   `??`, nawiasy i `as`, `[…].join(…)`;
 * - nazwa: zmienna lokalna z inicjalizatorem (najbliższa funkcja otaczająca), stała modułu, stała zaimportowana
 *   z pliku względnego; obiekt-słownik stałej modułu (`ETYKIETA[klucz]`: wszystkie wartości, `ETYKIETA.pole`: jedna);
 * - budowniczy: argument (albo inicjalizator zmiennej z argumentu) to wywołanie funkcji z tego pliku albo
 *   zaimportowanej z pliku względnego, `this.f()` albo `this.#f()`: tekstem są napisy z ciała funkcji i funkcji, które
 *   ona woła w swoim pliku (do trzech poziomów);
 * - parametr: argument używa parametru `p` nazwanej funkcji `F`, w której stoi wywołanie: tekstem jest argument `p`
 *   w każdym wywołaniu `F(…)`, `x.F(…)` albo `this.#F(…)` w tym samym pliku (bez łańcucha dalej);
 * - nośnik z {@link NOSNIKI}: kanał między plikami, którego reguły wyżej nie widzą (notatki zbierane i wypisywane
 *   gdzie indziej, pole obiektu, metoda innego obiektu). Lista zamknięta; nośnik bez żadnego napisu to błąd.
 *
 * Linia kodu liczy się, gdy stoi na niej polski kawałek takiego tekstu (stała użyta w kilku liniach logu liczy się raz,
 * w swoim pliku). Komentarze, tytuły testów i napisy, które do logu nie idą, się nie liczą. Wartości maszynowe, które
 * zostają po polsku (rekordy cienia, `herdr-audit.log`), idą do wyjątków testu z powodem i całą linią.
 * Ciche dziury, znane: nośnik między plikami spoza listy, tekst przez pole obiektu albo tablicę zbieraną w pętli
 * w innym pliku, wartość argumentu przekazana dalej przez drugą funkcję.
 */
import path from 'node:path';
import { parseAst } from 'vitest/node';
import { polski } from './polski-tekst.ts';

/**
 * Polskie słowa ASCII tekstów logu spoza `SLOWA_LISTA` (`polski-tekst.ts`): słowa kawałków tekstu logu
 * `server/src/**`, których nie ma we wspólnej liście ani w angielskim słowniku systemu (`/usr/share/dict/words`),
 * bez nazw i skrótów (`apns`, `herdr`, `iroh`, `pty`, `sdk`, `seq`, `udp`, `cwd`, `sigterm`, `numstat`). Bez `stan`
 * (wspólna lista wyklucza je jako angielskie). Test sprawdza listę na dokumentacji zależności i angielskich plikach
 * wejścia repo (zero trafień). Lista tylko rośnie o słowo, które tego sprawdzenia nie trafia.
 */
export const SLOWA_LOGU_LISTA: readonly string[] = `
  akcja aktualizacji anulowany bufora cisza dialogi dialogiem dniach domowy dopisku gniazd historia inwentarz kolejka
  konflikt konflikty kontroler lazygita liczniki managera martwy mediana meldunek migracja nieodczytany nieplanowo
  nieudana nieudane nieudany nieudanym niezmierzone nieznane odczyty odnowieniu odrzucona odrzucony odwolany
  odzyskano odzyskiwanie oknie otwarcie pady panele paneli patrzy pilne pluginy policzone pomijam ponowienie
  priorytet przeliczenia przeniesiony przerwany przeskok rola sierota silnik skasowano sparsowane sprawdzam
  sprawdzenie stanie startuje strumienia strumienie terminale tokeny toku transkrypt uchwyt uzbrojone warstwa
  wbudowanych wklejka wstrzymany wyrejestrowanie wyslane zarejestrowany zastany zator zerwane zestaw zmianie
  znakowaniu zniknal zwolniona
`.trim().split(/\s+/u);

/** {@link SLOWA_LOGU_LISTA} jako zbiór. */
export const SLOWA_LOGU: ReadonlySet<string> = new Set(SLOWA_LOGU_LISTA);

/** Wywoływany, który pisze do `server.log` (tekst źródła wywoływanego, `?.` jak `.`). */
export const LOG_CALLEE =
  /^(?:console\.(?:log|warn|error|info)|(?:.*\.)?#?(?:log|logger|safeLog|logOnce|logGitStats)(?:\.(?:info|error|warn))?)$/u;
/** Wywołania o pasującej nazwie, które nie piszą `server.log` (dziennik audytu, log apki, git). */
export const NOT_LOG = /(?:^|\.)audit\.log$|rotate|appendClientLog|clientLogPath|parseGitLog|spawnGitLog/u;

/** Kanał tekstu do logu między plikami, którego reguły automatyczne nie widzą. */
export type Nosnik =
  | { readonly plik: string; readonly wywolanie: string; readonly argument: number; readonly dokad: string }
  | { readonly plik: string; readonly budowniczy: string; readonly dokad: string }
  | { readonly plik: string; readonly pole: string; readonly dokad: string };

/** Nośniki dziś (lista zamknięta, każdy musi trafić napis). */
export const NOSNIKI: readonly Nosnik[] = [
  {
    plik: 'server/src/herdr/commands/discover.ts', wywolanie: 'note', argument: 0,
    dokad: 'notatki skanu wypisuje `logOnce(note)` w `herdr/commands/catalog.ts`',
  },
  {
    plik: 'server/src/iroh/listener.ts', wywolanie: 'note', argument: 1,
    dokad: '`budget.note(rodzaj, szczegół)` wypisuje `iroh/log-budget.ts` jako `iroh: <rodzaj> <szczegół>`',
  },
  {
    plik: 'server/src/term/herdr-stream.ts', wywolanie: 'onSkip', argument: 0,
    dokad: 'powód pominiętej linii wypisuje `onSkip` w `term/herdr-backend.ts`',
  },
  {
    plik: 'server/src/auth/limiter.ts', pole: 'logLine',
    dokad: '`outcome.logLine` wypisują `router.ts` i `term/ws.ts`',
  },
  { plik: 'server/src/git-stats.ts', budowniczy: 'noteRead', dokad: 'linię okna wypisuje `#logGitStats` w `SessionGit`' },
  { plik: 'server/src/git-stats.ts', budowniczy: 'noteFrame', dokad: 'linię okna wypisuje `#logGitStats` w `SessionGit`' },
  {
    plik: 'server/src/notify/index.ts', budowniczy: 'noResultCause',
    dokad: 'pola `turn` i `owed` wplata `this.#log` harmonogramu w linie `PUSH_QUIET_LOG` i uzbrojenia',
  },
];

/** Węzeł drzewa składni (ESTree z `parseAst`), czytany luźno: mechanizm sięga tylko po pola, których używa. */
interface Wezel {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [pole: string]: unknown;
}

const wezel = (x: unknown): Wezel | null =>
  typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string' ? x as Wezel : null;
const pole = (n: Wezel, nazwa: string): Wezel | null => wezel(n[nazwa]);
const lista = (n: Wezel, nazwa: string): Wezel[] => {
  const v = n[nazwa];
  return Array.isArray(v) ? v.map(wezel).filter((x): x is Wezel => x !== null) : [];
};
const nazwaId = (n: Wezel | null): string | null =>
  n !== null && (n.type === 'Identifier' || n.type === 'PrivateIdentifier') && typeof n['name'] === 'string'
    ? n['name'] : null;
const FUNKCJA = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/u;

/** Przejście po drzewie z łańcuchem rodziców; `false` z `fn` = bez zejścia w dzieci. */
function przejdz(n: Wezel, fn: (n: Wezel, rodzice: readonly Wezel[]) => boolean | void, rodzice: Wezel[] = []): void {
  if (fn(n, rodzice) === false) return;
  rodzice.push(n);
  for (const [klucz, v] of Object.entries(n)) {
    if (klucz === 'type' || v === null || typeof v !== 'object') continue;
    for (const dziecko of Array.isArray(v) ? v : [v]) {
      const w = wezel(dziecko);
      if (w !== null) przejdz(w, fn, rodzice);
    }
  }
  rodzice.pop();
}

/** Plik po parsowaniu: kod, drzewo, początki linii, stałe i funkcje modułu, importy względne. */
interface Plik {
  readonly sciezka: string;
  readonly kod: string;
  readonly ast: Wezel;
  readonly poczatki: readonly number[];
  readonly stale: ReadonlyMap<string, Wezel>;
  readonly funkcje: ReadonlyMap<string, Wezel>;
  readonly importy: ReadonlyMap<string, { readonly plik: string; readonly nazwa: string }>;
}

function nrLinii(p: Plik, offset: number): number {
  let lo = 0;
  let hi = p.poczatki.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.poczatki[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Nazwa funkcji z jej rodzica: deklaracja, `const f = () =>`, metoda klasy, pole obiektu albo klasy. */
function nazwaFunkcji(fn: Wezel, rodzic: Wezel | undefined): string | null {
  if (fn.type === 'FunctionDeclaration') return nazwaId(pole(fn, 'id'));
  if (rodzic === undefined) return null;
  if (rodzic.type === 'VariableDeclarator') return nazwaId(pole(rodzic, 'id'));
  if (/^(?:MethodDefinition|Property|PropertyDefinition)$/u.test(rodzic.type)) return nazwaId(pole(rodzic, 'key'));
  return null;
}

function przygotuj(sciezka: string, kod: string, wszystkie: ReadonlySet<string>): Plik | null {
  let ast: Wezel | null;
  try {
    ast = wezel(parseAst(kod, { lang: 'ts', sourceType: 'module' }));
  } catch {
    return null;
  }
  if (ast === null) return null;
  const poczatki = [0];
  for (let i = 0; i < kod.length; i += 1) if (kod[i] === '\n') poczatki.push(i + 1);
  const stale = new Map<string, Wezel>();
  const funkcje = new Map<string, Wezel>();
  const importy = new Map<string, { plik: string; nazwa: string }>();
  for (const instr of lista(ast, 'body')) {
    const decl = instr.type === 'ExportNamedDeclaration' ? pole(instr, 'declaration') : instr;
    if (instr.type === 'ImportDeclaration') {
      const zrodlo = pole(instr, 'source')?.['value'];
      if (typeof zrodlo !== 'string' || !zrodlo.startsWith('.')) continue;
      const cel = path.posix.normalize(path.posix.join(path.posix.dirname(sciezka), zrodlo));
      if (!wszystkie.has(cel)) continue;
      for (const s of lista(instr, 'specifiers')) {
        const lokalna = nazwaId(pole(s, 'local'));
        const obca = s.type === 'ImportSpecifier' ? nazwaId(pole(s, 'imported')) : null;
        if (lokalna !== null && obca !== null) importy.set(lokalna, { plik: cel, nazwa: obca });
      }
      continue;
    }
    if (decl?.type === 'VariableDeclaration') {
      for (const d of lista(decl, 'declarations')) {
        const nazwa = nazwaId(pole(d, 'id'));
        const init = pole(d, 'init');
        if (nazwa === null || init === null) continue;
        if (FUNKCJA.test(init.type)) funkcje.set(nazwa, init);
        else stale.set(nazwa, init);
      }
    }
  }
  const p: Plik = { sciezka, kod, ast, poczatki, stale, funkcje, importy };
  // Funkcje i metody w głębi pliku (klasy, fabryki): pierwsza o danej nazwie wygrywa, stałe modułu mają pierwszeństwo.
  przejdz(ast, (n, rodzice) => {
    if (!FUNKCJA.test(n.type)) return;
    const nazwa = nazwaFunkcji(n, rodzice.at(-1));
    if (nazwa !== null && !funkcje.has(nazwa)) funkcje.set(nazwa, n);
  });
  return p;
}

/** Polski kawałek tekstu logu: plik i linia, w której stoi. */
interface Kawalek {
  readonly plik: string;
  readonly linia: number;
  readonly tekst: string;
}

/** Rozwijanie tekstu linii logu (reguły w nagłówku modułu). */
class Rozwijacz {
  readonly #pliki: ReadonlyMap<string, Plik>;
  readonly #wynik: Kawalek[];
  /** Węzeł albo funkcja już rozwinięte → czy dały napis (w trakcie rozwijania: `false`, co ucina cykle). */
  readonly #widziane = new Map<string, boolean>();

  constructor(pliki: ReadonlyMap<string, Plik>, wynik: Kawalek[]) {
    this.#pliki = pliki;
    this.#wynik = wynik;
  }

  /**
   * Napis w pliku. Napis przez kilka linii źródła (szablon z nową linią) daje kawałek na każdą; `\n` zapisane ucieczką
   * w jednej linii źródła zostaje w tej linii.
   */
  #napis(p: Plik, n: Wezel, tekst: string): void {
    const pierwsza = nrLinii(p, n.start);
    if (!p.kod.slice(n.start, n.end).includes('\n')) {
      this.#wynik.push({ plik: p.sciezka, linia: pierwsza, tekst });
      return;
    }
    tekst.split('\n').forEach((czesc, i) => {
      this.#wynik.push({ plik: p.sciezka, linia: pierwsza + i, tekst: czesc });
    });
  }

  /** Wyrażenie tekstu; zwraca, czy znalazło jakikolwiek napis. `rodzice` = łańcuch do węzła (zasięg nazw). */
  tekst(p: Plik, e: Wezel | null, rodzice: readonly Wezel[], glebokosc = 0): boolean {
    if (e === null || glebokosc > 8) return false;
    const klucz = `${p.sciezka}:${String(e.start)}:${String(e.end)}`;
    const byl = this.#widziane.get(klucz);
    if (byl !== undefined) return byl;
    this.#widziane.set(klucz, false);
    const wynik = this.#rozwin(p, e, rodzice, glebokosc);
    this.#widziane.set(klucz, wynik);
    return wynik;
  }

  #rozwin(p: Plik, e: Wezel, rodzice: readonly Wezel[], glebokosc: number): boolean {
    const dalej = (x: Wezel | null): boolean => this.tekst(p, x, rodzice, glebokosc + 1);
    switch (e.type) {
      case 'ParenthesizedExpression': case 'TSAsExpression': case 'TSNonNullExpression': case 'TSSatisfiesExpression':
        return dalej(pole(e, 'expression'));
      case 'Literal':
        if (typeof e['value'] !== 'string') return false;
        this.#napis(p, e, e['value']);
        return true;
      case 'TemplateLiteral': {
        let jest = false;
        for (const q of lista(e, 'quasis')) {
          const wartosc = q['value'] as { cooked?: string | null; raw: string };
          this.#napis(p, q, wartosc.cooked ?? wartosc.raw);
          jest = true;
        }
        for (const x of lista(e, 'expressions')) dalej(x);
        return jest;
      }
      case 'BinaryExpression':
        if (e['operator'] !== '+') return false;
        return [dalej(pole(e, 'left')), dalej(pole(e, 'right'))].some(Boolean);
      case 'LogicalExpression':
        return [dalej(pole(e, 'left')), dalej(pole(e, 'right'))].some(Boolean);
      case 'ConditionalExpression':
        return [dalej(pole(e, 'consequent')), dalej(pole(e, 'alternate'))].some(Boolean);
      case 'Identifier': {
        const nazwa = nazwaId(e)!;
        const zasieg = this.#zasieg(rodzice, nazwa);
        if (zasieg === 'parametr') return false;
        if (zasieg !== null) return dalej(zasieg);
        const stala = this.#stala(p, nazwa);
        return stala !== null && this.tekst(stala.plik, stala.init, [], glebokosc + 1);
      }
      case 'MemberExpression': {
        // `ETYKIETA[klucz]` albo `ETYKIETA.pole` na obiekcie-słowniku stałej modułu.
        const obiekt = pole(e, 'object');
        const nazwa = obiekt?.type === 'Identifier' ? nazwaId(obiekt) : null;
        // Nazwa lokalna albo parametr przesłania stałą modułu: to dane, nie słownik.
        const stala = nazwa === null || this.#zasieg(rodzice, nazwa) !== null ? null : this.#stala(p, nazwa);
        const slownik = stala === null ? null : this.#obiekt(stala.init);
        if (stala === null || slownik === null) return false;
        const klucz2 = e['computed'] === true ? null : nazwaId(pole(e, 'property'));
        let jest = false;
        for (const wpis of lista(slownik, 'properties')) {
          if (klucz2 !== null && nazwaId(pole(wpis, 'key')) !== klucz2) continue;
          if (this.tekst(stala.plik, pole(wpis, 'value'), [], glebokosc + 1)) jest = true;
        }
        return jest;
      }
      case 'CallExpression': {
        const wolany = pole(e, 'callee');
        if (wolany?.type === 'MemberExpression' && nazwaId(pole(wolany, 'property')) === 'join'
          && pole(wolany, 'object')?.type === 'ArrayExpression') {
          return lista(pole(wolany, 'object')!, 'elements').map((x) => dalej(x)).some(Boolean);
        }
        return false;
      }
      default:
        return false;
    }
  }

  /** Obiekt-słownik: `{…}`, także w `as const` i `Object.freeze({…})`. */
  #obiekt(init: Wezel): Wezel | null {
    let x: Wezel | null = init;
    while (x !== null && (x.type === 'TSAsExpression' || x.type === 'TSSatisfiesExpression')) x = pole(x, 'expression');
    if (x?.type === 'CallExpression' && lista(x, 'arguments').length === 1) x = lista(x, 'arguments')[0]!;
    return x?.type === 'ObjectExpression' ? x : null;
  }

  /** Stała modułu albo zaimportowana: plik, w którym stoi, i jej inicjalizator. */
  #stala(p: Plik, nazwa: string): { plik: Plik; init: Wezel } | null {
    const init = p.stale.get(nazwa);
    if (init !== undefined) return { plik: p, init };
    const imp = p.importy.get(nazwa);
    const cel = imp === undefined ? undefined : this.#pliki.get(imp.plik);
    const obca = cel === undefined || imp === undefined ? undefined : cel.stale.get(imp.nazwa);
    return cel !== undefined && obca !== undefined ? { plik: cel, init: obca } : null;
  }

  /**
   * Nazwa w zasięgu łańcucha `rodzice`: parametr najbliższej funkcji (`'parametr'`), inicjalizator zmiennej z jej
   * ciała (bez funkcji zagnieżdżonych) albo `null` (stała modułu, import albo nic).
   */
  #zasieg(rodzice: readonly Wezel[], nazwa: string): Wezel | 'parametr' | null {
    for (let i = rodzice.length - 1; i >= 0; i -= 1) {
      const fn = rodzice[i]!;
      if (!FUNKCJA.test(fn.type)) continue;
      if (lista(fn, 'params').some((par) => nazwaParametru(par) === nazwa)) return 'parametr';
      const cialo = pole(fn, 'body');
      if (cialo === null) continue;
      let init: Wezel | null = null;
      przejdz(cialo, (n) => {
        if (init !== null || (n !== cialo && FUNKCJA.test(n.type))) return false;
        if (n.type === 'VariableDeclarator' && nazwaId(pole(n, 'id')) === nazwa && pole(n, 'init') !== null) {
          init = pole(n, 'init');
        }
        return undefined;
      });
      if (init !== null) return init;
    }
    return null;
  }

  /** Budowniczy: napisy z ciała funkcji `nazwa` w pliku `p` i funkcji, które ona woła w tym pliku. */
  budowniczy(p: Plik, nazwa: string, glebokosc = 0): boolean {
    const klucz = `fn:${p.sciezka}:${nazwa}`;
    const byl = this.#widziane.get(klucz);
    if (byl !== undefined) return byl;
    const fn = p.funkcje.get(nazwa);
    if (glebokosc > 3 || fn === undefined) return false;
    this.#widziane.set(klucz, false);
    let jest = false;
    przejdz(fn, (n, rodzice) => {
      if (n.type === 'CallExpression') {
        const wewnetrzna = wywolanaWPliku(pole(n, 'callee'));
        if (wewnetrzna !== null && wewnetrzna !== nazwa && this.budowniczy(p, wewnetrzna, glebokosc + 1)) jest = true;
        return undefined;
      }
      // Zwracane wyrażenie bez napisu we własnym węźle (`return ETYKIETA;`, `() => x ? A : B`): rozwinięcie jak
      // argument logu, ze stałymi modułu i importami. Napis zwrócony wprost policzy się drugi raz w tej samej linii.
      const zwracane = n.type === 'ReturnStatement' ? pole(n, 'argument')
        : n === fn && n.type === 'ArrowFunctionExpression' && pole(n, 'body')?.type !== 'BlockStatement'
          ? pole(n, 'body') : null;
      if (zwracane !== null && this.tekst(p, zwracane, [...rodzice, n])) jest = true;
      if (n.type === 'Literal' || n.type === 'TemplateLiteral') {
        if (this.tekst(p, n, rodzice)) jest = true;
        // W szablon schodzi dalej: wywołanie w interpolacji (`${opis()}`) to też budowniczy.
        return n.type === 'TemplateLiteral' ? undefined : false;
      }
      return undefined;
    });
    this.#widziane.set(klucz, jest);
    return jest;
  }
}

/** Nazwa parametru: `p`, `p = x`, `private p`, `...p`. */
function nazwaParametru(par: Wezel): string | null {
  if (par.type === 'Identifier') return nazwaId(par);
  if (par.type === 'AssignmentPattern') return nazwaId(pole(par, 'left'));
  if (par.type === 'TSParameterProperty') return nazwaParametru(pole(par, 'parameter') ?? par);
  if (par.type === 'RestElement') return nazwaId(pole(par, 'argument'));
  return null;
}

/** Funkcja wołana w obrębie pliku: `f(…)`, `this.f(…)`, `this.#f(…)`; inne wywołania `null`. */
function wywolanaWPliku(wolany: Wezel | null): string | null {
  if (wolany?.type === 'Identifier') return nazwaId(wolany);
  if (wolany?.type === 'MemberExpression' && pole(wolany, 'object')?.type === 'ThisExpression') {
    return nazwaId(pole(wolany, 'property'));
  }
  return null;
}

/** Nazwa wołanej funkcji albo metody (`f`, `x.f`, `this.#f`) do szukania wywołań parametru i nośnika. */
function nazwaWolanej(wolany: Wezel | null): string | null {
  if (wolany?.type === 'Identifier') return nazwaId(wolany);
  if (wolany?.type === 'MemberExpression') return nazwaId(pole(wolany, 'property'));
  return null;
}

const zrodlo = (p: Plik, n: Wezel): string => p.kod.slice(n.start, n.end).replace(/\s+/gu, '').replace(/\?\./gu, '.');

/** Czy wywołanie pisze do `server.log` (definicja w nagłówku modułu). */
function wywolanieLogu(p: Plik, n: Wezel): boolean {
  if (n.type !== 'CallExpression') return false;
  const wolany = pole(n, 'callee');
  if (wolany === null || lista(n, 'arguments').length === 0) return false;
  const tekst = zrodlo(p, wolany);
  return LOG_CALLEE.test(tekst) && !NOT_LOG.test(tekst);
}

/** Wynik: polskie linie tekstu logu per plik, nośniki bez napisu i pliki, których parser nie przeczytał. */
export interface MiejscaLogu {
  /** Plik → numery polskich linii (rosnąco). */
  readonly linie: ReadonlyMap<string, readonly number[]>;
  readonly martweNosniki: readonly Nosnik[];
  readonly nieczytelne: readonly string[];
}

/** Polskie linie tekstu logu w plikach `pliki` (ścieżka względem korzenia → treść), z nośnikami `nosniki`. */
export function miejscaLogu(pliki: ReadonlyMap<string, string>, nosniki: readonly Nosnik[] = NOSNIKI): MiejscaLogu {
  const sparsowane = new Map<string, Plik>();
  const nieczytelne: string[] = [];
  const sciezki = new Set(pliki.keys());
  for (const [sciezka, kod] of pliki) {
    const p = przygotuj(sciezka, kod, sciezki);
    if (p === null) nieczytelne.push(sciezka);
    else sparsowane.set(sciezka, p);
  }
  const kawalki: Kawalek[] = [];
  const r = new Rozwijacz(sparsowane, kawalki);
  const parametry = new Map<string, Set<number>>(); // `plik#F` → indeksy parametrów wplecionych w tekst logu

  for (const p of sparsowane.values()) {
    przejdz(p.ast, (n, rodzice) => {
      if (!wywolanieLogu(p, n)) return undefined;
      const arg = lista(n, 'arguments')[0]!;
      // Parametry funkcji otaczających, użyte w argumencie (bliższa funkcja przesłania dalszą).
      const uzyte = new Set<string>();
      przejdz(arg, (m, wyzej) => {
        const rodzic = wyzej.at(-1);
        // Pole po kropce i klucz obiektu to nie nazwa w zasięgu (`request.decision` nie używa parametru `decision`).
        const klucz = rodzic !== undefined && rodzic['computed'] !== true
          && ((rodzic.type === 'MemberExpression' && rodzic['property'] === m)
            || (rodzic.type === 'Property' && rodzic['key'] === m));
        if (m.type === 'Identifier' && !klucz) uzyte.add(nazwaId(m)!);
      });
      for (let i = rodzice.length - 1; i >= 0; i -= 1) {
        const fn = rodzice[i]!;
        if (!FUNKCJA.test(fn.type)) continue;
        const nazwa = nazwaFunkcji(fn, rodzice[i - 1]);
        lista(fn, 'params').forEach((par, k) => {
          const pn = nazwaParametru(par);
          if (pn === null || !uzyte.has(pn)) return;
          uzyte.delete(pn);
          if (nazwa === null) return;
          const klucz = `${p.sciezka}#${nazwa}`;
          parametry.set(klucz, (parametry.get(klucz) ?? new Set()).add(k));
        });
      }
      const kontekst = [...rodzice, n];
      r.tekst(p, arg, kontekst);
      // Budowniczy: argument albo inicjalizator zmiennej z argumentu to wywołanie funkcji.
      let wywolanie: Wezel | null = arg.type === 'ChainExpression' ? pole(arg, 'expression') : arg;
      if (wywolanie?.type === 'Identifier') {
        const nazwa = nazwaId(wywolanie)!;
        const lokalna = rodzice.toReversed().find((x) => FUNKCJA.test(x.type));
        wywolanie = null;
        if (lokalna !== undefined) {
          przejdz(pole(lokalna, 'body') ?? lokalna, (m) => {
            if (m.type === 'VariableDeclarator' && nazwaId(pole(m, 'id')) === nazwa) wywolanie = pole(m, 'init');
          });
        }
      }
      const w = wywolanie as Wezel | null;
      if (w?.type === 'CallExpression') {
        const wolany = pole(w, 'callee');
        const wlasna = wywolanaWPliku(wolany);
        if (wlasna !== null && p.funkcje.has(wlasna)) r.budowniczy(p, wlasna);
        else if (wolany?.type === 'Identifier') {
          const imp = p.importy.get(nazwaId(wolany)!);
          const cel = imp === undefined ? undefined : sparsowane.get(imp.plik);
          if (cel !== undefined && imp !== undefined) r.budowniczy(cel, imp.nazwa);
        }
      }
      return undefined;
    });
  }

  // Parametry wplecione w tekst: argumenty wywołań tej funkcji w tym samym pliku.
  for (const [klucz, indeksy] of parametry) {
    const [sciezka, nazwa] = klucz.split('#') as [string, string];
    const p = sparsowane.get(sciezka)!;
    przejdz(p.ast, (n, rodzice) => {
      if (n.type !== 'CallExpression' || wywolanieLogu(p, n) || nazwaWolanej(pole(n, 'callee')) !== nazwa) return;
      const args = lista(n, 'arguments');
      for (const k of indeksy) {
        const a = args[k];
        if (a !== undefined) r.tekst(p, a, [...rodzice, n]);
      }
    });
  }

  const martweNosniki: Nosnik[] = [];
  for (const nosnik of nosniki) {
    const p = sparsowane.get(nosnik.plik);
    let jest = false;
    if (p !== undefined && 'budowniczy' in nosnik) jest = r.budowniczy(p, nosnik.budowniczy);
    if (p !== undefined && 'wywolanie' in nosnik) {
      przejdz(p.ast, (n, rodzice) => {
        if (n.type !== 'CallExpression' || nazwaWolanej(pole(n, 'callee')) !== nosnik.wywolanie) return;
        const a = lista(n, 'arguments')[nosnik.argument];
        if (a !== undefined && r.tekst(p, a, [...rodzice, n])) jest = true;
      });
    }
    if (p !== undefined && 'pole' in nosnik) {
      przejdz(p.ast, (n, rodzice) => {
        if (n.type !== 'Property' || n['shorthand'] === true || nazwaId(pole(n, 'key')) !== nosnik.pole) return;
        if (r.tekst(p, pole(n, 'value'), [...rodzice, n])) jest = true;
      });
    }
    if (!jest) martweNosniki.push(nosnik);
  }

  const linie = new Map<string, Set<number>>();
  for (const k of kawalki) {
    if (!polski(k.tekst, true, SLOWA_LOGU)) continue;
    linie.set(k.plik, (linie.get(k.plik) ?? new Set()).add(k.linia));
  }
  return {
    linie: new Map([...linie].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([plik, zbior]) => [plik, [...zbior].sort((a, b) => a - b)])),
    martweNosniki,
    nieczytelne,
  };
}
