/**
 * Strażnik pochodzenia zdań serwera. Typ (`say`, `foreign`) pilnuje ujść, a ten test pilnuje
 * tego, czego typ sam nie widzi:
 *
 * 1. Klasy błędów. Każda klasa w `server/src` i `shared/src`, która dziedziczy po `Error`, niesie pole `sentence`
 *    z typem zdania (własne albo odziedziczone), bo z niego, a nie z `Error.message`, `errorBodyOf` w routerze
 *    składa ciało REST 4xx. Listę klas test bierze z drzewa składni kodu, więc nowa klasa bez pola go przewraca.
 *    Klasa bez zdania stoi w {@link BEZ_ZDANIA} z powodem; wpis bez takiej klasy jest martwy.
 * 2. Ciała błędów w `server/src/router.ts`. Literał obiektu z kluczem `message` stoi tylko w `errorBody`, a tę
 *    woła wyłącznie `errorBodyOf`, `genericErrorBody` i `sendError`; JSON pisze tylko `writeJson`, wołany przez
 *    `sendJson` (status 200 albo 202), `sendError` i `sendFailure`.
 * 3. Moduł zdań. `@rarog/shared/sentences` nie eksportuje drogi „zdanie własne bez kodu” (nazwy
 *    z {@link ZAKAZANE_EKSPORTY}). Wywołanie takiej funkcji w kodzie łapie `tsc`; powrót eksportu łapie ten test.
 * 4. Ujście karty w `server/src/herdr/dialogs/cards/build.ts`. Treść karty zgody (`displayText`, `displayTextRef`)
 *    powstaje tylko w `cardText`, treść pytania (`question` z `questionRef`) tylko w `questionText`; obie funkcje
 *    biorą tekst typu `AnyText`, więc kod zdania wynika z pochodzenia tekstu, a nie z ręcznie dopisanego pola.
 *
 * Drzewo składni daje `parseAst` z `vitest/node` (jak `polski-log.ts`), więc komentarze i napisy się nie liczą.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vitest/node';
import { describe, expect, it } from 'vitest';
import { managerErrorStatus } from '../src/router.ts';
import { tsFiles } from './source-scan.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KATALOGI = ['server/src', 'shared/src'] as const;

/** Węzeł drzewa składni (ESTree z `parseAst`), czytany luźno. */
interface Wezel {
  readonly type: string;
  readonly start: number;
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

/** Przejście po drzewie z łańcuchem rodziców (najbliższy na końcu). */
function przejdz(n: Wezel, fn: (n: Wezel, rodzice: readonly Wezel[]) => void, rodzice: Wezel[] = []): void {
  fn(n, rodzice);
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

interface Zrodlo {
  readonly plik: string;
  readonly kod: string;
  readonly ast: Wezel;
}

function parsuj(plik: string, kod: string): Zrodlo {
  const ast = wezel(parseAst(kod, { lang: 'ts', sourceType: 'module' }));
  if (ast === null) throw new Error(`parseAst nie oddał drzewa: ${plik}`);
  return { plik, kod, ast };
}

const ZRODLA: readonly Zrodlo[] = KATALOGI.flatMap((katalog) => tsFiles(path.join(REPO, katalog)).map((full) =>
  parsuj(path.relative(REPO, full), readFileSync(full, 'utf8'))));

const linia = (z: Zrodlo, n: Wezel): number => z.kod.slice(0, n.start).split('\n').length;

/** Nazwa funkcji, w której stoi węzeł: deklaracja, metoda, albo strzałka/wyrażenie przypisane do zmiennej. */
function funkcjaOtaczajaca(rodzice: readonly Wezel[]): string | null {
  for (let i = rodzice.length - 1; i >= 0; i -= 1) {
    const r = rodzice[i];
    if (r === undefined) continue;
    if (r.type === 'FunctionDeclaration') return nazwaId(pole(r, 'id'));
    if (r.type === 'FunctionExpression' || r.type === 'ArrowFunctionExpression') {
      const wyzej = rodzice[i - 1];
      if (wyzej?.type === 'VariableDeclarator') return nazwaId(pole(wyzej, 'id'));
      if (wyzej?.type === 'MethodDefinition' || wyzej?.type === 'Property') return nazwaId(pole(wyzej, 'key'));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Klasy błędów
// ---------------------------------------------------------------------------

/** Typy, które wolno dać polu `sentence` (z `@rarog/shared/sentences`). */
const TYPY_ZDANIA: ReadonlySet<string> = new Set(['OwnText', 'AnyText', 'ServerSentence', 'ForeignText']);

/** Klasy bazowe spoza repo, od których zaczyna się rodzina błędów. */
const BLEDY_WBUDOWANE: ReadonlySet<string> = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError']);

/**
 * Klasy błędów bez pola `sentence`, każda z powodem. `rest: false` znaczy, że klasa nie trafia do ciała REST
 * (test sprawdza, że `managerErrorStatus` mapuje jej nazwę na 500, czyli ciało ogólne, bez treści wyjątku).
 */
const BEZ_ZDANIA: Readonly<Record<string, { readonly powod: string; readonly rest: boolean }>> = {
  ConfigError: { powod: 'błąd konfiguracji przy starcie `rarog serve`, idzie do terminala, nie do apki', rest: false },
  Usage: { powod: 'komenda `rarog`: zły sposób użycia, tekst do terminala', rest: false },
  Refusal: { powod: 'komenda `rarog`: odmowa, tekst do terminala', rest: false },
  Unreachable: { powod: 'komenda `rarog devices`: gniazdo administracyjne nie odpowiada, tekst do terminala', rest: false },
  SecretInputTooLong: {
    powod: 'komenda `rarog dictation set-key`: wejście klucza ponad sufit, komenda pisze własne zdanie do terminala',
    rest: false,
  },
  SecretInputInterrupted: {
    powod: 'komenda `rarog dictation set-key`: Ctrl-C w pytaniu bez echa, komenda kończy się kodem 130',
    rest: false,
  },
  SetupInterrupted: {
    powod: 'komenda `rarog setup`: Ctrl-C przerwał krok, `runSteps` łapie go i kończy się kodem 130 bez podsumowania',
    rest: false,
  },
  IrohLoadError: { powod: 'ładowanie biblioteki iroh przy starcie, tekst do logu serwera', rest: false },
  DevicesFormatError: {
    powod: 'odmowa startu przy pliku urządzeń nowszego formatu (K4): `createDeviceStore` rzuca ją przed zapisem, '
      + 'tekst idzie do terminala `rarog serve` i do logu, nie do apki',
    rest: false,
  },
  TermHandleStaleError: {
    powod: 'uchwyt terminala przestał wskazywać naszą powłokę; rejestr terminali łapie go i liczy uchwyt od nowa',
    rest: false,
  },
  DiffError: {
    powod: 'kod odmowy diffa per plik; zdanie ciała 4xx bierze `errorBodyOf` z tabeli `DIFF_FAILURES` po kodzie',
    rest: true,
  },
  HookListNoProof: {
    powod: 'lista hooków sesji łapie go w `sessionHookVerdict` i zwraca werdykt „brak dowodu” z powodem do logu',
    rest: false,
  },
};

interface Klasa {
  readonly nazwa: string;
  readonly miejsce: string;
  readonly rodzic: string | null;
  /** Typ pola `sentence` zadeklarowanego w tej klasie (`null`: brak pola; `'?'`: pole bez typu albo z innym). */
  readonly zdanie: string | null;
}

/** Nazwa typu z adnotacji (`TSTypeAnnotation` → `TSTypeReference`), inaczej `'?'`. */
function typPola(adnotacja: Wezel | null): string {
  const typ = adnotacja === null ? null : pole(adnotacja, 'typeAnnotation');
  if (typ?.type !== 'TSTypeReference') return '?';
  return nazwaId(pole(typ, 'typeName')) ?? '?';
}

/** Pole `sentence` klasy: właściwość instancji albo parametr konstruktora z modyfikatorem (`readonly sentence`). */
function poleZdania(klasa: Wezel): string | null {
  for (const czlon of lista(pole(klasa, 'body') ?? klasa, 'body')) {
    if (czlon.type === 'PropertyDefinition' && czlon['static'] !== true && czlon['computed'] !== true
      && nazwaId(pole(czlon, 'key')) === 'sentence') {
      return typPola(pole(czlon, 'typeAnnotation'));
    }
    if (czlon.type === 'MethodDefinition' && czlon['kind'] === 'constructor') {
      for (const param of lista(pole(czlon, 'value') ?? czlon, 'params')) {
        const p = param.type === 'TSParameterProperty' ? pole(param, 'parameter') : null;
        if (p !== null && nazwaId(p) === 'sentence') return typPola(pole(p, 'typeAnnotation'));
      }
    }
  }
  return null;
}

function klasyZKodu(): Klasa[] {
  const out: Klasa[] = [];
  for (const z of ZRODLA) {
    przejdz(z.ast, (n) => {
      if (n.type !== 'ClassDeclaration' && n.type !== 'ClassExpression') return;
      const nazwa = nazwaId(pole(n, 'id'));
      const nad = pole(n, 'superClass');
      const rodzic = nad === null ? null
        : nad.type === 'MemberExpression' ? nazwaId(pole(nad, 'property')) : nazwaId(nad);
      out.push({ nazwa: nazwa ?? '(bez nazwy)', miejsce: `${z.plik}:${String(linia(z, n))}`, rodzic, zdanie: poleZdania(n) });
    });
  }
  return out;
}

const KLASY = klasyZKodu();
const PO_NAZWIE = new Map<string, Klasa[]>();
for (const k of KLASY) PO_NAZWIE.set(k.nazwa, [...PO_NAZWIE.get(k.nazwa) ?? [], k]);

/** Łańcuch przodków w repo (bez samej klasy); kończy się na klasie spoza repo albo na `null`. */
function przodkowie(k: Klasa): string[] {
  const out: string[] = [];
  let r = k.rodzic;
  while (r !== null && !out.includes(r)) {
    out.push(r);
    r = PO_NAZWIE.get(r)?.[0]?.rodzic ?? null;
  }
  return out;
}

const jestBledem = (k: Klasa): boolean => przodkowie(k).some((p) => BLEDY_WBUDOWANE.has(p));

/** Typ pola `sentence` własny albo najbliższego przodka w repo. */
function zdanieKlasy(k: Klasa): string | null {
  if (k.zdanie !== null) return k.zdanie;
  for (const p of przodkowie(k)) {
    const zdanie = PO_NAZWIE.get(p)?.[0]?.zdanie ?? null;
    if (zdanie !== null) return zdanie;
  }
  return null;
}

const BLEDY = KLASY.filter(jestBledem);

describe('strażnik pochodzenia zdań: klasy błędów niosą `sentence`', () => {
  it('lista klas pochodzi z kodu: HerdrError ma co najmniej 13 podklas, a rodzina managera i UploadError są na niej', () => {
    const herdr = BLEDY.filter((k) => przodkowie(k).includes('HerdrError'));
    expect(herdr.length).toBeGreaterThanOrEqual(13);
    const nazwy = new Set(BLEDY.map((k) => k.nazwa));
    for (const znana of ['HerdrError', 'UploadError', 'ClientIdConflictError', 'NotFoundError', 'TermBackendRetryError']) {
      expect(nazwy.has(znana), znana).toBe(true);
    }
  });

  it('nazwa klasy błędu jest jednoznaczna (łańcuch przodków czyta się po nazwie)', () => {
    const powtorzone = [...PO_NAZWIE].filter(([, k]) => k.length > 1 && k.some(jestBledem))
      .map(([nazwa, k]) => `${nazwa}: ${k.map((x) => x.miejsce).join(', ')}`);
    expect(powtorzone).toEqual([]);
  });

  it('każda klasa błędu ma pole `sentence` z typem zdania albo wpis w BEZ_ZDANIA', () => {
    const braki = BLEDY.filter((k) => !Object.hasOwn(BEZ_ZDANIA, k.nazwa) && zdanieKlasy(k) === null)
      .map((k) => `${k.nazwa} (${k.miejsce})`);
    expect(braki, [
      'Klasa błędu bez pola `sentence`: `errorBodyOf` w routerze składa ciało 4xx wyłącznie z tego pola.',
      'Dodaj `readonly sentence: OwnText` (albo AnyText, gdy treść bywa obca) i ustaw je w konstruktorze;',
      'klasa, która nigdy nie trafia do ciała REST, idzie do BEZ_ZDANIA z powodem.',
    ].join('\n')).toEqual([]);
    const zlyTyp = BLEDY.filter((k) => {
      const typ = zdanieKlasy(k);
      return typ !== null && !TYPY_ZDANIA.has(typ);
    }).map((k) => `${k.nazwa} (${k.miejsce}): ${String(zdanieKlasy(k))}`);
    expect(zlyTyp, `pole \`sentence\` ma typ spoza ${[...TYPY_ZDANIA].join(', ')}`).toEqual([]);
  });

  it('wpis BEZ_ZDANIA ma klasę bez pola; klasa spoza REST nie mapuje się na status 4xx', () => {
    for (const [nazwa, wpis] of Object.entries(BEZ_ZDANIA)) {
      const klasy = (PO_NAZWIE.get(nazwa) ?? []).filter(jestBledem);
      expect(klasy.length, `martwy wpis BEZ_ZDANIA: ${nazwa}`).toBe(1);
      const klasa = klasy[0];
      if (klasa !== undefined) expect(zdanieKlasy(klasa), `${nazwa} ma już \`sentence\`: usuń wpis`).toBeNull();
      expect(wpis.powod.trim().length).toBeGreaterThan(0);
      if (!wpis.rest) expect(managerErrorStatus({ name: nazwa }), nazwa).toBe(500);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Ciała błędów w routerze
// ---------------------------------------------------------------------------

const ROUTER = ZRODLA.find((z) => z.plik === 'server/src/router.ts');

/** Gdzie wolno wołać budowniczych ciała i zapisu JSON. */
const WOLNO_WOLAC: Readonly<Record<string, ReadonlySet<string>>> = {
  errorBody: new Set(['errorBodyOf', 'genericErrorBody', 'sendError']),
  writeJson: new Set(['sendJson', 'sendError', 'sendFailure']),
};

interface Naruszenie {
  readonly linia: number;
  readonly opis: string;
}

/** Nazwa wywoływanego: `f(…)` → `f`, `a.b(…)` → `a.b`. */
function wywolywany(n: Wezel): string | null {
  const callee = pole(n, 'callee');
  if (callee === null) return null;
  if (callee.type === 'MemberExpression' && callee['computed'] !== true) {
    const obj = nazwaId(pole(callee, 'object'));
    const prop = nazwaId(pole(callee, 'property'));
    return obj !== null && prop !== null ? `${obj}.${prop}` : null;
  }
  return nazwaId(callee);
}

const kluczWlasciwosci = (n: Wezel): string | null => {
  const key = pole(n, 'key');
  if (key === null || n['computed'] === true) return null;
  return key.type === 'Literal' && typeof key['value'] === 'string' ? key['value'] : nazwaId(key);
};

function naruszeniaRoutera(z: Zrodlo): { naruszenia: Naruszenie[]; literalyMessage: number } {
  const naruszenia: Naruszenie[] = [];
  let literalyMessage = 0;
  przejdz(z.ast, (n, rodzice) => {
    const gdzie = (): string => funkcjaOtaczajaca(rodzice) ?? '(poziom modułu)';
    if (n.type === 'Property' && rodzice.at(-1)?.type === 'ObjectExpression' && kluczWlasciwosci(n) === 'message') {
      literalyMessage += 1;
      if (gdzie() !== 'errorBody') {
        naruszenia.push({ linia: linia(z, n), opis: `literał obiektu z kluczem \`message\` w ${gdzie()} (tylko errorBody)` });
      }
    }
    if (n.type !== 'CallExpression') return;
    const nazwa = wywolywany(n);
    if (nazwa === null) return;
    const wolno = Object.hasOwn(WOLNO_WOLAC, nazwa) ? WOLNO_WOLAC[nazwa] : undefined;
    if (wolno !== undefined && !wolno.has(gdzie())) {
      naruszenia.push({ linia: linia(z, n), opis: `${nazwa}(…) w ${gdzie()} (wolno: ${[...wolno].join(', ')})` });
    }
    if (nazwa === 'JSON.stringify' && gdzie() !== 'writeJson') {
      naruszenia.push({ linia: linia(z, n), opis: `JSON.stringify(…) w ${gdzie()} (tylko writeJson)` });
    }
    if (nazwa === 'sendJson') {
      const status = lista(n, 'arguments')[1];
      if (status?.type !== 'Literal' || (status['value'] !== 200 && status['value'] !== 202)) {
        naruszenia.push({ linia: linia(z, n), opis: 'sendJson z innym statusem niż literał 200 albo 202' });
      }
    }
  });
  return { naruszenia, literalyMessage };
}

describe('strażnik pochodzenia zdań: ciało błędu w routerze składa tylko errorBodyOf i sendError', () => {
  it('router.ts jest w źródłach i ma dokładnie jeden literał `message` (w errorBody)', () => {
    expect(ROUTER).toBeDefined();
    if (ROUTER !== undefined) expect(naruszeniaRoutera(ROUTER).literalyMessage).toBe(1);
  });

  it('bez literałów `message:` i zapisu JSON poza helperami', () => {
    const { naruszenia } = ROUTER === undefined ? { naruszenia: [] } : naruszeniaRoutera(ROUTER);
    expect(naruszenia.map((x) => `server/src/router.ts:${String(x.linia)}: ${x.opis}`), [
      'Ciało błędu powstaje tylko w errorBodyOf (z wyjątku) albo przez sendError (zdanie trasy); 2xx idzie przez',
      'sendJson ze statusem 200 albo 202. Inna droga ominęłaby typ zdania i późniejszy `messageRef`.',
    ].join('\n')).toEqual([]);
  });

  it('skaner widzi naruszenia (przykład syntetyczny)', () => {
    const z = parsuj('przyklad.ts', [
      'function handler(res) {',
      '  sendJson(res, 400, { error: "bad-request", message: "x" });',
      '  writeJson(res, 400, errorBody("bad-request", t));',
      '  res.end(JSON.stringify({ message }));',
      '  const { message: m } = err;',
      '}',
    ].join('\n'));
    expect(naruszeniaRoutera(z).naruszenia.map((x) => x.linia)).toEqual([2, 2, 3, 3, 4, 4]);
  });
});

// ---------------------------------------------------------------------------
// 3. Moduł zdań bez drogi „zdanie własne bez kodu”
// ---------------------------------------------------------------------------

const MODUL_ZDAN_PLIK = 'shared/src/sentences/index.ts';
const MODUL_ZDAN = ZRODLA.find((z) => z.plik === MODUL_ZDAN_PLIK);

/** Nazwy, które moduł zdań kiedyś eksportował dla zdań bez kodu; powrót każdej z nich jest czerwony. */
const ZAKAZANE_EKSPORTY: readonly string[] = ['legacy', 'isLegacyText', 'LegacyText'];

/** Nazwy eksportowane przez moduł (deklaracje z `export`, specyfikatory `export { … }`; `export *` jako `*`). */
function eksportyModulu(z: Zrodlo): string[] {
  const out: string[] = [];
  for (const n of lista(z.ast, 'body')) {
    if (n.type === 'ExportAllDeclaration') {
      out.push('*');
      continue;
    }
    if (n.type !== 'ExportNamedDeclaration') continue;
    for (const s of lista(n, 'specifiers')) {
      const nazwa = nazwaId(pole(s, 'exported')) ?? (typeof pole(s, 'exported')?.['value'] === 'string'
        ? String(pole(s, 'exported')?.['value']) : null);
      if (nazwa !== null) out.push(nazwa);
    }
    const d = pole(n, 'declaration');
    if (d === null) continue;
    const id = nazwaId(pole(d, 'id'));
    if (id !== null) out.push(id);
    for (const v of lista(d, 'declarations')) {
      const vid = nazwaId(pole(v, 'id'));
      if (vid !== null) out.push(vid);
    }
  }
  return out;
}

describe('strażnik pochodzenia zdań: moduł zdań nie ma drogi „zdanie własne bez kodu”', () => {
  it('@rarog/shared/sentences nie eksportuje nazw z ZAKAZANE_EKSPORTY (wartości i typy)', async () => {
    const modul: Record<string, unknown> = await import('@rarog/shared/sentences');
    expect(ZAKAZANE_EKSPORTY.filter((nazwa) => Object.hasOwn(modul, nazwa)), [
      'Zdanie dla apki powstaje przez say() z kodem z rejestru (shared/src/sentences/), tekst obcy przez foreign().',
      'Droga bez kodu wróciłaby do apki z gotowym angielskim tekstem, którego apka nie przetłumaczy.',
    ].join('\n')).toEqual([]);
    expect(MODUL_ZDAN, `brak ${MODUL_ZDAN_PLIK} w źródłach`).toBeDefined();
    const eksporty = MODUL_ZDAN === undefined ? [] : eksportyModulu(MODUL_ZDAN);
    expect(eksporty).toContain('say');
    expect(eksporty.filter((nazwa) => nazwa === '*' || ZAKAZANE_EKSPORTY.includes(nazwa))).toEqual([]);
  });

  it('skaner eksportów widzi deklaracje, specyfikatory i `export *` (przykład syntetyczny)', () => {
    const z = parsuj('przyklad.ts', [
      'export interface Stary { readonly text: string }',
      'export function stary(text: string) { return text; }',
      'export const jestStary = (v: unknown) => false, inne = 1;',
      'const ukryte = 1;',
      'export { ukryte as wolne };',
      "export * from './obszar.ts';",
    ].join('\n'));
    expect(eksportyModulu(z)).toEqual(['Stary', 'stary', 'jestStary', 'inne', 'wolne', '*']);
  });
});

// ---------------------------------------------------------------------------
// 4. Ujście karty w `cards/build.ts`
// ---------------------------------------------------------------------------

const KARTY_PLIK = 'server/src/herdr/dialogs/cards/build.ts';
const KARTY = ZRODLA.find((z) => z.plik === KARTY_PLIK);

/** Klucz literału obiektu karty → jedyna funkcja, w której wolno go postawić. */
const UJSCIA_KARTY: Readonly<Record<string, string>> = {
  displayText: 'cardText', displayTextRef: 'cardText', questionRef: 'questionText',
};
const HELPERY_KARTY: readonly string[] = ['cardText', 'questionText'];

/** Typ pierwszego parametru funkcji (nazwa z adnotacji), inaczej `'?'`. */
function typPierwszegoParametru(fn: Wezel): string {
  const param = lista(fn, 'params')[0];
  return param === undefined ? '?' : typPola(pole(param, 'typeAnnotation'));
}

/** Wywołanie funkcji `nazwa` w rozproszeniu (`...nazwa(…)`). */
const rozproszenieZ = (n: Wezel, nazwa: string): boolean => {
  const arg = pole(n, 'argument');
  return n.type === 'SpreadElement' && arg?.type === 'CallExpression' && nazwaId(pole(arg, 'callee')) === nazwa;
};

function naruszeniaKarty(z: Zrodlo): { naruszenia: Naruszenie[]; helpery: ReadonlyMap<string, string> } {
  const naruszenia: Naruszenie[] = [];
  const helpery = new Map<string, string>();
  przejdz(z.ast, (n, rodzice) => {
    if (n.type === 'FunctionDeclaration') {
      const nazwa = nazwaId(pole(n, 'id'));
      if (nazwa !== null && HELPERY_KARTY.includes(nazwa)) helpery.set(nazwa, typPierwszegoParametru(n));
      return;
    }
    if (n.type === 'Property' && rodzice.at(-1)?.type === 'ObjectExpression') {
      const klucz = kluczWlasciwosci(n);
      const wolno = klucz !== null && Object.hasOwn(UJSCIA_KARTY, klucz) ? UJSCIA_KARTY[klucz] : undefined;
      const gdzie = funkcjaOtaczajaca(rodzice) ?? '(poziom modułu)';
      if (wolno !== undefined && gdzie !== wolno) {
        naruszenia.push({ linia: linia(z, n), opis: `literał \`${String(klucz)}\` w ${gdzie} (tylko ${wolno})` });
      }
      return;
    }
    if (n.type !== 'ObjectExpression') return;
    // Literał pytania (`Question`: `header` i `options`) bierze treść pytania wyłącznie z `...questionText(…)`.
    const czlony = lista(n, 'properties');
    const klucze = new Set(czlony.map((c) => (c.type === 'Property' ? kluczWlasciwosci(c) : null)));
    if (!klucze.has('header') || !klucze.has('options')) return;
    if (klucze.has('question') || !czlony.some((c) => rozproszenieZ(c, 'questionText'))) {
      naruszenia.push({ linia: linia(z, n), opis: 'literał pytania bez `...questionText(…)` (treść pytania z typem zdania)' });
    }
  });
  return { naruszenia, helpery };
}

describe('strażnik pochodzenia zdań: ujście karty w cards/build.ts przyjmuje tekst z typem zdania', () => {
  it('cards/build.ts jest w źródłach, a `cardText` i `questionText` biorą `AnyText`', () => {
    expect(KARTY).toBeDefined();
    const { helpery } = KARTY === undefined ? { helpery: new Map<string, string>() } : naruszeniaKarty(KARTY);
    expect(Object.fromEntries(helpery)).toEqual({ cardText: 'AnyText', questionText: 'AnyText' });
  });

  it('treść karty i pytania powstaje tylko w swoich funkcjach', () => {
    const { naruszenia } = KARTY === undefined ? { naruszenia: [] } : naruszeniaKarty(KARTY);
    expect(naruszenia.map((x) => `${KARTY_PLIK}:${String(x.linia)}: ${x.opis}`), [
      'Treść karty zgody idzie przez cardText(tekst), treść pytania przez ...questionText(tekst): tekst to say(),',
      'albo foreign(), a kod zdania (`displayTextRef`, `questionRef`) bierze się z jego typu.',
    ].join('\n')).toEqual([]);
  });

  it('skaner widzi naruszenia (przykład syntetyczny)', () => {
    const z = parsuj('przyklad.ts', [
      'function cardText(text: string) { return { displayText: text }; }',
      'function card(t) {',
      '  return { displayText: t, displayTextRef: { code: "x" } };',
      '}',
      'const q = { question: "Q?", header: "", options: [] };',
      'const r = { ...questionText(t), header: "", options: [], questionRef: { code: "y" } };',
    ].join('\n'));
    const { naruszenia, helpery } = naruszeniaKarty(z);
    expect(naruszenia.map((x) => x.linia)).toEqual([3, 3, 5, 6]);
    expect(Object.fromEntries(helpery)).toEqual({ cardText: '?' });
  });
});

