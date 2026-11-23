/*
 * `scripts/l10n-check.mjs` — strażnik katalogów copy apki natywnej (`docs/localization.md`, „Guards”): komplet
 * wartości w wymaganych językach, kategorie liczby mnogiej, zgodność parametrów między językami i klucze `L("…")`
 * użyte w kodzie, katalog `Info.plist` apki z tekstami zgód i `CFBundleLocalizations` trzech `Info.plist`,
 * katalog zdań serwera w RarogContract (reguły wartości i parametrów, prefiks `server.`/`push.`, bez `L("…")`).
 * Katalogi w testach są syntetyczne (kształt `.xcstrings` z Xcode 27); na końcu skrypt idzie po
 * prawdziwym repo tak, jak woła go `scripts/check.sh`.
 *
 * Moduł spod `scripts/` ładujemy importem dynamicznym po ścieżce (nie należy do projektu `server`).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO, 'scripts', 'l10n-check.mjs');

type Catalog = Record<string, unknown>;
interface Options { file?: string; required?: string[]; source?: string }
interface Module {
  REQUIRED_LANGUAGES: string[];
  SOURCE_LANGUAGE: string;
  catalogProblems: (catalog: Catalog, options?: Options) => string[];
  formatSignature: (value: string) => {
    params: { position: number | null; type: string; explicit: boolean }[]; percent: number; ownArg: boolean;
    unsupported: boolean;
  };
  copyKeysInSwift: (source: string) => { keys: { key: string; line: number }[]; dynamic: { line: number }[] };
  repoProblems: (root: string) => {
    problems: string[]; catalogs: number; serverCatalogs: number; infoCatalogs: number; plists: number;
    locKeyCatalogs: number;
  };
  SERVER_CATALOG_PACKAGE: string;
  serverCatalogProblems: (catalog: Catalog, options?: Options) => string[];
  APP_INFO_PLIST: string;
  APP_INFO_CATALOG: string;
  INFO_PLISTS: string[];
  plistValues: (xml: string) => { strings: Map<string, string>; arrays: Map<string, string[]> };
  infoPlistCatalogProblems: (catalog: Catalog, plistXml: string, options: Options & { plistFile: string }) => string[];
  plistLanguageProblems: (plistXml: string, options: { file: string; required?: string[] }) => string[];
  SERVER_CATALOG: string;
  LOC_KEYS: string[];
  LOC_KEY_CATALOGS: string[];
  locKeyCatalogProblems: (catalog: Catalog, serverCatalog: Catalog,
    options: Options & { serverFile: string }) => string[];
}
const l10n = await import(pathToFileURL(SCRIPT).href) as Module;

const unit = (value: string, state = 'translated') => ({ stringUnit: { state, value } });
const plural = (forms: Record<string, string>) => ({
  variations: { plural: Object.fromEntries(Object.entries(forms).map(([name, value]) => [name, unit(value)])) },
});
const catalog = (strings: Record<string, unknown>, sourceLanguage = 'pl'): Catalog =>
  ({ sourceLanguage, strings, version: '1.0' });
const PL_SESSIONS = { one: '%lld sesja', few: '%lld sesje', many: '%lld sesji', other: '%lld sesji' };
const check = (strings: Record<string, unknown>, required = ['pl', 'en']) =>
  l10n.catalogProblems(catalog(strings), { file: 'K', required, source: 'pl' });

const temporary: string[] = [];
afterAll(() => {
  for (const made of temporary.splice(0)) rmSync(made, { recursive: true, force: true });
});

describe('l10n-check: wartości i stan', () => {
  it('komplet w obu językach, z liczbą mnogą i podstawieniem: bez problemów', () => {
    expect(check({
      'a.plain': { localizations: { pl: unit('Zapisz'), en: unit('Save') } },
      'a.count': { localizations: { pl: plural(PL_SESSIONS), en: plural({ one: '%lld session', other: '%lld sessions' }) } },
      'a.two': { localizations: {
        pl: { ...unit('%#@s@ w %#@p@'), substitutions: {
          s: { argNum: 1, formatSpecifier: 'lld', ...plural({ one: '%arg sesja', few: '%arg sesje', many: '%arg sesji', other: '%arg sesji' }) },
          p: { argNum: 2, formatSpecifier: 'lld', ...plural({ one: '%arg projekcie', few: '%arg projektach', many: '%arg projektach', other: '%arg projektach' }) },
        } },
        en: { ...unit('%#@s@ in %#@p@'), substitutions: {
          s: { argNum: 1, formatSpecifier: 'lld', ...plural({ one: '%arg session', other: '%arg sessions' }) },
          p: { argNum: 2, formatSpecifier: 'lld', ...plural({ one: '%arg project', other: '%arg projects' }) },
        } },
      } },
    })).toEqual([]);
  });

  it('brak języka, stan inny niż translated, pusta wartość', () => {
    expect(check({
      'b.missing': { localizations: { pl: unit('Zapisz') } },
      'b.state': { localizations: { pl: unit('Zapisz'), en: unit('Save', 'needs_review') } },
      'b.empty': { localizations: { pl: unit(''), en: unit('Save') } },
    })).toEqual([
      'K: "b.missing" [en]: no value',
      'K: "b.state" [en]: state "needs_review", "translated" required',
      'K: "b.empty" [pl]: empty value',
    ]);
  });

  it('język źródłowy katalogu musi się zgadzać', () => {
    expect(l10n.catalogProblems(catalog({}, 'en'), { file: 'K', required: ['pl'], source: 'pl' }))
      .toEqual(['K: sourceLanguage "en", expected "pl"']);
  });

  it('wymagane są en i pl, źródło en', () => {
    expect(l10n.REQUIRED_LANGUAGES).toEqual(['en', 'pl']);
    expect(l10n.SOURCE_LANGUAGE).toBe('en');
  });

  it('domyślnie: katalog z samym pl to brak en; parametry porównane z en jako źródłem', () => {
    const strings = {
      'j.polish': { localizations: { pl: unit('Zapisz') } },
      'j.param': { localizations: { en: unit('Session %@'), pl: unit('Sesja %lld') } },
    };
    expect(l10n.catalogProblems(catalog(strings, 'en'), { file: 'K' })).toEqual([
      'K: "j.polish" [en]: no value',
      'K: "j.param" [pl]: parameters 1:lld ≠ en: 1:@',
    ]);
    expect(l10n.catalogProblems(catalog({}), { file: 'K' })).toEqual(['K: sourceLanguage "pl", expected "en"']);
  });

  it('forma one bez liczby („One more workflow”) i liczba mnoga tam, gdzie polski jej nie ma: bez problemów', () => {
    // Kształt `liveActivity.spoken.moreWorkflows`: podpis parametrów łączy wszystkie formy, więc `one` bez `%lld`
    // nie zmienia go względem polskiego zdania bez wariantów.
    expect(l10n.catalogProblems(catalog({
      'k.more': { localizations: {
        en: plural({ one: 'One more workflow', other: '%lld more workflows' }),
        pl: unit('Jeszcze %lld workflow'),
      } },
    }, 'en'), { file: 'K' })).toEqual([]);
  });
});

describe('l10n-check: liczba mnoga', () => {
  it('polski potrzebuje one, few, many, other; angielski one, other; inny język co najmniej other', () => {
    expect(check({
      'c.pl': { localizations: { pl: plural({ one: '%lld sesja', other: '%lld sesji' }), en: plural({ one: '%lld s', other: '%lld s' }) } },
      'c.en': { localizations: { pl: plural(PL_SESSIONS), en: plural({ other: '%lld sessions' }) } },
    })).toEqual([
      'K: "c.pl" [pl]: plural is missing categories few, many',
      'K: "c.en" [en]: plural is missing categories one',
    ]);
    expect(l10n.catalogProblems(catalog({ 'c.de': { localizations: { pl: plural(PL_SESSIONS), de: plural({ one: '%lld Sitzung' }) } } }),
      { file: 'K', required: ['pl', 'de'], source: 'pl' })).toEqual(['K: "c.de" [de]: plural is missing categories other']);
  });

  it('podstawienie też ma komplet kategorii', () => {
    expect(check({
      'c.sub': { localizations: {
        pl: { ...unit('%#@s@'), substitutions: { s: { argNum: 1, formatSpecifier: 'lld', ...plural({ one: '%arg sesja', other: '%arg sesji' }) } } },
        en: { ...unit('%#@s@'), substitutions: { s: { argNum: 1, formatSpecifier: 'lld', ...plural({ one: '%arg session', other: '%arg sessions' }) } } },
      } },
    })).toEqual(['K: "c.sub" [pl] substitution s: plural is missing categories few, many']);
  });
});

describe('l10n-check: parametry między językami', () => {
  it('liczba, typ i pozycja; kolejność w zdaniu może się różnić przy pozycjach jawnych', () => {
    expect(check({
      'd.order': { localizations: { pl: unit('%1$@ w %2$lld'), en: unit('%2$lld in %1$@') } },
      'd.type': { localizations: { pl: unit('Sesja %@'), en: unit('Session %lld') } },
      'd.count': { localizations: { pl: unit('%@ i %@'), en: unit('%@') } },
    })).toEqual([
      'K: "d.type" [en]: parameters 1:lld ≠ pl: 1:@',
      'K: "d.count" [en]: parameters 1:@ ≠ pl: 1:@ 2:@',
    ]);
  });

  it('%% liczone między językami; w zdaniu bez parametrów %% byłoby widać dosłownie', () => {
    expect(check({
      'e.percent': { localizations: { pl: unit('%lld%% gotowe'), en: unit('%lld done') } },
      'e.literal': { localizations: { pl: unit('Gotowe w 100%%'), en: unit('100% done') } },
    })).toEqual([
      'K: "e.percent" [en]: "%%" none ≠ pl: sentence=1',
      'K: "e.literal" [pl]: "%%" in a sentence without parameters — without parameters the text goes out verbatim, write "%"',
      'K: "e.literal" [en]: "%%" none ≠ pl: sentence=1',
    ]);
  });

  it('podpis formatu: pozycje kolejne i jawne, flagi bez spacji („100% done” to tekst), podstawienie, %arg, *', () => {
    expect(l10n.formatSignature('%@ ma %lld (%.1f) %%')).toEqual({
      params: [
        { position: 1, type: '@', explicit: false }, { position: 2, type: 'lld', explicit: false },
        { position: 3, type: 'f', explicit: false },
      ],
      percent: 1, ownArg: false, unsupported: false,
    });
    expect(l10n.formatSignature('100% done')).toEqual({ params: [], percent: 0, ownArg: false, unsupported: false });
    expect(l10n.formatSignature('%#@sessions@ i %arg')).toEqual({
      params: [{ position: null, type: '@sessions@', explicit: true }], percent: 0, ownArg: true, unsupported: false,
    });
    expect(l10n.formatSignature('%*lld').unsupported).toBe(true);
    expect(l10n.formatSignature('%1$*2$lld').unsupported).toBe(true);
    expect(l10n.formatSignature('%1$.*2$f').unsupported).toBe(true);
  });

  const substitution = (argNum: number, formatSpecifier: string, forms: Record<string, string>) =>
    ({ argNum, formatSpecifier, ...plural(forms) });
  const PL_SUB = { one: '%arg sesja', few: '%arg sesje', many: '%arg sesji', other: '%arg sesji' };

  it('podstawienia: argNum i formatSpecifier porównane między językami, parametry w wariantach też', () => {
    const pl = { ...unit('%#@s@'), substitutions: { s: substitution(1, 'lld', PL_SUB) } };
    const en = (sub: unknown) => ({ ...unit('%#@s@'), substitutions: { s: sub } });
    expect(check({
      'f.arg': { localizations: { pl, en: en(substitution(2, 'lld', { one: '%arg session', other: '%arg sessions' })) } },
      'f.type': { localizations: { pl, en: en(substitution(1, '@', { one: '%arg session', other: '%arg sessions' })) } },
      'f.extra': { localizations: { pl, en: en(substitution(1, 'lld', { one: '%arg session', other: '%arg session %2$@' })) } },
      'f.unpositioned': { localizations: { pl, en: en(substitution(1, 'lld', { one: '%arg session', other: '%arg %@' })) } },
      'f.undefined': { localizations: { pl, en: unit('%#@x@') } },
      'f.mixed': { localizations: {
        pl: { ...unit('%#@s@'), substitutions: { s: substitution(1, 'lld', { one: '%arg %2$@ %lld', few: '%arg %2$@ %lld', many: '%arg %2$@ %lld', other: '%arg %2$@ %lld' }) } },
        en: { ...unit('%#@s@'), substitutions: { s: substitution(1, 'lld', { one: '%arg %2$@ %lld', other: '%arg %2$@ %lld' }) } },
      } },
    })).toEqual([
      'K: "f.arg" [en]: parameters 2:lld ≠ pl: 1:lld',
      'K: "f.type" [en]: parameters 1:@ ≠ pl: 1:lld',
      'K: "f.extra" [en]: parameters 1:lld 2:@ ≠ pl: 1:lld',
      'K: "f.unpositioned" [en] substitution s plural.other: parameter without a position in a substitution variant (write %N$…)',
      'K: "f.unpositioned" [en] substitution s plural.other: position 1 is both lld and @',
      'K: "f.undefined" [en]: substitution "x" has no definition',
      'K: "f.undefined" [en]: parameters none ≠ pl: 1:lld',
      'K: "f.mixed" [pl] substitution s plural.one: parameter without a position in a substitution variant (write %N$…)',
      'K: "f.mixed" [pl] substitution s plural.few: parameter without a position in a substitution variant (write %N$…)',
      'K: "f.mixed" [pl] substitution s plural.many: parameter without a position in a substitution variant (write %N$…)',
      'K: "f.mixed" [pl] substitution s plural.other: parameter without a position in a substitution variant (write %N$…)',
      'K: "f.mixed" [en] substitution s plural.one: parameter without a position in a substitution variant (write %N$…)',
      'K: "f.mixed" [en] substitution s plural.other: parameter without a position in a substitution variant (write %N$…)',
    ]);
  });

  it('sprzeczne typy między wariantami liczby mnogiej i różne %% w wariantach', () => {
    expect(check({
      'g.types': { localizations: { pl: plural(PL_SESSIONS), en: plural({ one: '%@ session', other: '%lld sessions' }) } },
      'g.percent': { localizations: {
        pl: plural({ one: '%lld%%', few: '%lld%%', many: '%lld%%', other: '%lld%%' }),
        en: plural({ one: '%lld%%', other: '%lld' }),
      } },
    })).toEqual([
      'K: "g.types" [en] plural.other: position 1 is both @ and lld',
      'K: "g.types" [en]: parameters 1:@ ≠ pl: 1:lld',
      'K: "g.percent" [en]: variants have different counts of "%%"',
    ]);
  });

  it('warianty zagnieżdżone (urządzenie → liczba mnoga) i puste variations sprawdzane rekurencyjnie', () => {
    expect(check({
      'i.device': { localizations: {
        pl: { variations: { device: { iphone: plural({ one: '%lld sesja', other: '%lld sesji' }), other: plural(PL_SESSIONS) } } },
        en: plural({ one: '%lld session', other: '%lld sessions' }),
      } },
      'i.empty': { localizations: { pl: { variations: {} }, en: unit('x') } },
    }, ['pl'])).toEqual([
      'K: "i.device" [pl] device.iphone: plural is missing categories few, many',
      'K: "i.empty" [pl]: no value',
    ]);
  });

  it('pusta lokalizacja i pusta kategoria liczby mnogiej to brak wartości; * w formacie nieobsługiwane', () => {
    expect(check({
      'h.empty': { localizations: { pl: {}, en: unit('x') } },
      'h.category': { localizations: {
        pl: { variations: { plural: { one: {}, few: unit('%lld sesje'), many: unit('%lld sesji'), other: unit('%lld sesji') } } },
        en: plural({ one: '%lld session', other: '%lld sessions' }),
      } },
      'h.star': { localizations: { pl: unit('%*lld sesji'), en: unit('%*lld sessions') } },
    })).toEqual([
      'K: "h.empty" [pl]: no value',
      'K: "h.category" [pl] plural.one: no value',
      'K: "h.star" [pl]: width or precision "*" is not supported',
      'K: "h.star" [en]: width or precision "*" is not supported',
    ]);
  });
});

describe('l10n-check: klucze w kodzie Swift', () => {
  it('literał klucza w L(…), także z językiem i w interpolacji; komentarz, deklaracja i metoda innego typu nie', () => {
    const swift = [
      'func L(_ key: String, _ arguments: any CVarArg...) -> String { "" }',
      'let a = L("list.title")',
      'let b = L("list.count", language: .en, 3)',
      'let c = "\\(L("list.inner"))"',
      '// L("list.comment")',
      'let d = other.L("nie.ten")',
      'let e = L(key)',
      'let f = L("list.\\(kind)")',
      'let g = L ("list.space")',
      'let h = L/* uwaga */("list.comment.gap")',
      'let i = L("list." + suffix)',
      'let j = #"surowy \\#"# dalej"# + L("list.after.raw")',
    ].join('\n');
    const found = l10n.copyKeysInSwift(swift);
    expect(found.keys.map((key) => key.key)).toEqual([
      'list.title', 'list.count', 'list.inner', 'list.space', 'list.comment.gap', 'list.after.raw']);
    expect(found.dynamic.map((call) => call.line)).toEqual([7, 8, 11]);
  });

  it('repo: klucz spoza katalogu pakietu, pakiet bez katalogu, klucz nie-literał i klucz katalogu bez użycia to problemy', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rarog-l10n-check-'));
    temporary.push(root);
    const write = (relative: string, text: string): void => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), text);
    };
    write('native/Rarog/Packages/RarogUI/Sources/RarogUI/Copy/Localizable.xcstrings', JSON.stringify(catalog({
      'ui.ok': { localizations: { en: unit('OK'), pl: unit('OK') } },
      'ui.dead': { localizations: { en: unit('Old'), pl: unit('Stare') } },
    }, 'en')));
    write('native/Rarog/Packages/RarogUI/Sources/RarogUI/View.swift', 'let a = L("ui.ok")\nlet b = L("ui.brak")\nlet c = L(x)\n');
    write('native/Rarog/Packages/RarogTransport/Sources/RarogTransport/Client.swift', 'let a = L("t.key")\n');
    const { problems, catalogs } = l10n.repoProblems(root);
    expect(catalogs).toBe(1);
    expect(problems).toEqual([
      'native/Rarog/Packages/RarogTransport/Sources/RarogTransport/Client.swift:1: "t.key" — package RarogTransport has no catalog',
      'native/Rarog/Packages/RarogUI/Sources/RarogUI/View.swift:3: L(…) with a key that is not a literal',
      'native/Rarog/Packages/RarogUI/Sources/RarogUI/View.swift:2: "ui.brak" is missing from native/Rarog/Packages/RarogUI/Sources/RarogUI/Copy/Localizable.xcstrings',
      'native/Rarog/Packages/RarogUI/Sources/RarogUI/Copy/Localizable.xcstrings: "ui.dead" — no L("…") in package RarogUI uses this key',
    ]);
  });
});

describe('l10n-check: katalog zdań serwera w RarogContract', () => {
  const SERVER = 'native/Rarog/Packages/RarogContract/Sources/RarogContract/Copy/Localizable.xcstrings';

  it('reguły wartości i parametrów jak w katalogu pakietu, każdy klucz z prefiksem server. albo push.', () => {
    expect(l10n.SERVER_CATALOG_PACKAGE).toBe('RarogContract');
    const problems = l10n.serverCatalogProblems(catalog({
      'server.rest.ok': { localizations: { en: unit('Ready.'), pl: unit('Gotowe.') } },
      'push.chime.title': { localizations: { en: unit('Agent finished'), pl: unit('Agent skończył') } },
      'server.session.label': { localizations: { en: unit('session %1$lld'), pl: unit('sesja %1$@') } },
      'server.rest.half': { localizations: { en: unit('Ready.') } },
      'cards.ok': { localizations: { en: unit('OK'), pl: unit('OK') } },
    }, 'en'), { file: 'S' });
    expect(problems).toEqual([
      'S: "server.session.label" [pl]: parameters 1:@ ≠ en: 1:lld',
      'S: "server.rest.half" [pl]: no value',
      'S: "cards.ok" — a server sentence key starts with server. or push.',
    ]);
  });

  it('repo: katalog RarogContract bez L("…") w źródłach nie jest martwym tekstem (bez reguł 4 i 5), liczony osobno', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rarog-l10n-check-server-'));
    temporary.push(root);
    mkdirSync(path.dirname(path.join(root, SERVER)), { recursive: true });
    writeFileSync(path.join(root, SERVER), JSON.stringify(catalog({
      'server.rest.ok': { localizations: { en: unit('Ready.'), pl: unit('Gotowe.') } },
      'ui.wrong': { localizations: { en: unit('Wrong'), pl: unit('Źle') } },
    }, 'en')));
    writeFileSync(path.join(root, path.dirname(SERVER), 'CopyLanguage.swift'), 'let a = 1\n');
    const { problems, catalogs, serverCatalogs } = l10n.repoProblems(root);
    expect([catalogs, serverCatalogs]).toEqual([0, 1]);
    expect(problems).toEqual([`${SERVER}: "ui.wrong" — a server sentence key starts with server. or push.`]);
  });
});

/** Płaski plist XML z parami klucz → napis i tablicą `CFBundleLocalizations` (`null` = bez klucza). */
const plist = (strings: Record<string, string>, languages: string[] | null = ['en', 'pl']): string => [
  '<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0">', '<dict>',
  ...Object.entries(strings).flatMap(([key, value]) => [`\t<key>${key}</key>`, `\t<string>${value}</string>`]),
  ...(languages ? ['\t<key>CFBundleLocalizations</key>', '\t<array>',
    ...languages.map((language) => `\t\t<string>${language}</string>`), '\t</array>'] : []),
  '</dict>', '</plist>', '',
].join('\n');

describe('l10n-check: Info.plist apki — teksty zgód i języki procesów', () => {
  const CAMERA = 'The camera turns on only when you tap “Scan QR Code”.';
  const camera = { localizations: { en: unit(CAMERA), pl: unit('Aparat włącza się po „Skanuj kod QR”.') } };
  const infoCheck = (strings: Record<string, unknown>, xml: string) => l10n.infoPlistCatalogProblems(
    catalog(strings, 'en'), xml, { file: 'C', plistFile: 'P' });

  it('odczyt plist: napisy z encjami XML, tablica, zakomentowany klucz nie istnieje', () => {
    const xml = '<dict>\n<!-- <key>NSOld</key><string>x</string> -->\n<key>A</key>\n<string>B &amp; C</string>\n'
      + '<key>CFBundleLocalizations</key>\n<array>\n<string>en</string>\n<string>pl</string>\n</array>\n</dict>';
    const { strings, arrays } = l10n.plistValues(xml);
    expect([...strings]).toEqual([['A', 'B & C']]);
    expect(arrays.get('CFBundleLocalizations')).toEqual(['en', 'pl']);
  });

  it('komplet: klucz zgody w obu miejscach, en = Info.plist, pl przetłumaczone; inne klucze plist bez znaczenia', () => {
    expect(infoCheck({ NSCameraUsageDescription: camera },
      plist({ NSCameraUsageDescription: CAMERA, CFBundleDisplayName: 'Rarog' }))).toEqual([]);
  });

  it('klucz zgody bez katalogu, klucz katalogu bez Info.plist, en różne od Info.plist, brak pl', () => {
    expect(infoCheck({
      NSCameraUsageDescription: { localizations: { en: unit('Other text.'), pl: unit('Aparat.') } },
      NSPhotoLibraryUsageDescription: { localizations: { en: unit('Photos.') } },
    }, plist({ NSCameraUsageDescription: CAMERA, NSMicrophoneUsageDescription: 'Mic.' }))).toEqual([
      'C: "NSPhotoLibraryUsageDescription" [pl]: no value',
      'P: "NSMicrophoneUsageDescription" is missing from C',
      'C: "NSCameraUsageDescription" [en] differs from P (the en text stands in both)',
      'C: "NSPhotoLibraryUsageDescription" — P has no such key',
    ]);
  });

  it('źródło katalogu en; parametry porównane z en jak w katalogach pakietów', () => {
    expect(l10n.infoPlistCatalogProblems(catalog({ NSCameraUsageDescription: camera }, 'pl'),
      plist({ NSCameraUsageDescription: CAMERA }), { file: 'C', plistFile: 'P' }))
      .toEqual(['C: sourceLanguage "pl", expected "en"']);
    expect(infoCheck({ NSCameraUsageDescription: { localizations: { en: unit(CAMERA), pl: unit('Aparat %@') } } },
      plist({ NSCameraUsageDescription: CAMERA }))).toEqual(['C: "NSCameraUsageDescription" [pl]: parameters 1:@ ≠ en: none']);
  });

  it('CFBundleLocalizations = wymagane języki: brak klucza, brak języka, język bez katalogów', () => {
    expect(l10n.plistLanguageProblems(plist({}), { file: 'P' })).toEqual([]);
    expect(l10n.plistLanguageProblems(plist({}, ['pl', 'en']), { file: 'P' }), 'kolejność bez znaczenia').toEqual([]);
    expect(l10n.plistLanguageProblems(plist({}, null), { file: 'P' }))
      .toEqual(['P: no CFBundleLocalizations (required: en, pl)']);
    expect(l10n.plistLanguageProblems(plist({}, ['en', 'de']), { file: 'P' })).toEqual([
      'P: CFBundleLocalizations is missing pl',
      'P: CFBundleLocalizations has de, which the catalogs do not require',
    ]);
  });

  it('repo z Info.plist apki: katalog Info.plist wymagany, CFBundleLocalizations każdego istniejącego Info.plist', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rarog-l10n-check-plist-'));
    temporary.push(root);
    mkdirSync(path.join(root, 'native/Rarog/Packages'), { recursive: true });
    mkdirSync(path.join(root, 'native/Rarog/RarogWidgets'), { recursive: true });
    writeFileSync(path.join(root, l10n.APP_INFO_PLIST), plist({ NSCameraUsageDescription: CAMERA }));
    writeFileSync(path.join(root, l10n.INFO_PLISTS[1] ?? ''), plist({}, ['en']));
    const missing = l10n.repoProblems(root);
    expect(missing.problems).toEqual([
      `${l10n.APP_INFO_CATALOG}: missing — the usage descriptions of ${l10n.APP_INFO_PLIST} have no translations`,
      `${l10n.INFO_PLISTS[1] ?? ''}: CFBundleLocalizations is missing pl`,
    ]);
    expect([missing.infoCatalogs, missing.plists]).toEqual([0, 2]);
    mkdirSync(path.join(root, 'native/Rarog/Rarog'), { recursive: true });
    writeFileSync(path.join(root, l10n.APP_INFO_CATALOG), JSON.stringify(catalog({ NSCameraUsageDescription: camera }, 'en')));
    writeFileSync(path.join(root, l10n.INFO_PLISTS[1] ?? ''), plist({}));
    expect(l10n.repoProblems(root)).toMatchObject({ problems: [], infoCatalogs: 1, plists: 2 });
  });
});

describe('l10n-check: klucze loc-key pusha w katalogach apki i widżetu', () => {
  const LOC_KEYS = ['push.chime.body', 'push.chime.title', 'push.placeholder.body', 'push.placeholder.title'];
  const VALUES: Record<string, [string, string]> = {
    'push.chime.body': ['The result is waiting in Rarog', 'Wynik czeka w Rarogu'],
    'push.chime.title': ['Agent finished', 'Agent skończył'],
    'push.placeholder.body': ['New notification', 'Nowe powiadomienie'],
    'push.placeholder.title': ['Rarog', 'Rarog'],
  };
  const entries = (values = VALUES) => Object.fromEntries(Object.entries(values)
    .map(([key, [en, pl]]) => [key, { extractionState: 'manual', localizations: { en: unit(en), pl: unit(pl) } }]));
  /** Katalog zdań serwera z kluczami pusha i jednym kluczem `server.`, który do katalogów apki nie należy. */
  const server = () => catalog({
    ...entries(), 'server.rest.ok': { localizations: { en: unit('Ready.'), pl: unit('Gotowe.') } },
  }, 'en');
  const locCheck = (strings: Record<string, unknown>) =>
    l10n.locKeyCatalogProblems(catalog(strings, 'en'), server(), { file: 'A', serverFile: 'S' });

  it('stałe: cztery klucze loc-key, katalogi głównego celu apki i widżetu, katalog zdań serwera', () => {
    expect(l10n.LOC_KEYS).toEqual(LOC_KEYS);
    expect(l10n.LOC_KEY_CATALOGS).toEqual(['native/Rarog/Rarog/Localizable.xcstrings',
      'native/Rarog/RarogWidgets/Localizable.xcstrings']);
    expect(l10n.SERVER_CATALOG)
      .toBe('native/Rarog/Packages/RarogContract/Sources/RarogContract/Copy/Localizable.xcstrings');
  });

  it('komplet czterech kluczy z wartościami równymi RarogContract: bez problemów', () => {
    expect(locCheck(entries())).toEqual([]);
  });

  it('brak push.chime.body to problem z nazwą klucza', () => {
    const { 'push.chime.body': _dropped, ...rest } = entries();
    expect(locCheck(rest)).toEqual(['A: no "push.chime.body" (push loc-keys: push.chime.body, push.chime.title, '
      + 'push.placeholder.body, push.placeholder.title)']);
  });

  it('wartość pl inna niż w RarogContract to problem; en też', () => {
    expect(locCheck(entries({ ...VALUES, 'push.chime.title': ['Agent done', 'Agent zakończył'] }))).toEqual([
      'A: "push.chime.title" [en] differs from S',
      'A: "push.chime.title" [pl] differs from S',
    ]);
  });

  it('piąty klucz to problem, także klucz server., którego katalog serwera ma', () => {
    const extra = { localizations: { en: unit('Ready.'), pl: unit('Gotowe.') } };
    expect(locCheck({ ...entries(), 'server.rest.ok': extra })).toEqual([
      'A: "server.rest.ok" — only the push loc-keys belong here (push.chime.body, push.chime.title, '
      + 'push.placeholder.body, push.placeholder.title)',
    ]);
  });

  it('reguły 1–3 jak w każdym katalogu; klucz, którego brak w katalogu serwera, nie ma z czym się równać', () => {
    const half: Record<string, unknown> = {
      ...entries(), 'push.chime.body': { localizations: { en: unit('The result is waiting in Rarog') } },
    };
    expect(locCheck(half)).toEqual(['A: "push.chime.body" [pl]: no value', 'A: "push.chime.body" [pl] differs from S']);
    const { 'push.placeholder.title': _gone, ...partial } = entries();
    expect(l10n.locKeyCatalogProblems(catalog(entries(), 'en'), catalog(partial, 'en'), { file: 'A', serverFile: 'S' }))
      .toEqual(['S: no "push.placeholder.title" to compare A with']);
  });

  it('repo: katalog każdego celu, którego folder jest, wymagany przy katalogu zdań serwera; to samo dla widżetu', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rarog-l10n-check-lockeys-'));
    temporary.push(root);
    const write = (relative: string, value: unknown): void => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), JSON.stringify(value));
    };
    write(l10n.SERVER_CATALOG, server());
    const [appCatalog = '', widgetCatalog = ''] = l10n.LOC_KEY_CATALOGS;
    mkdirSync(path.join(root, path.dirname(appCatalog)), { recursive: true });
    mkdirSync(path.join(root, path.dirname(widgetCatalog)), { recursive: true });
    expect(l10n.repoProblems(root)).toMatchObject({
      problems: [
        `${appCatalog}: missing — iOS has no text for the push loc-keys in this target`,
        `${widgetCatalog}: missing — iOS has no text for the push loc-keys in this target`,
      ],
      locKeyCatalogs: 0,
    });
    write(appCatalog, catalog(entries(), 'en'));
    const { 'push.chime.body': _dropped, ...rest } = entries();
    write(widgetCatalog, catalog({ ...rest, 'push.extra': { localizations: { en: unit('x'), pl: unit('x') } } }, 'en'));
    expect(l10n.repoProblems(root)).toMatchObject({
      problems: [
        `${widgetCatalog}: no "push.chime.body" (push loc-keys: push.chime.body, push.chime.title, `
          + 'push.placeholder.body, push.placeholder.title)',
        `${widgetCatalog}: "push.extra" — only the push loc-keys belong here (push.chime.body, push.chime.title, `
          + 'push.placeholder.body, push.placeholder.title)',
      ],
      locKeyCatalogs: 2,
    });
  });
});

describe('l10n-check: prawdziwe repo (krok `pnpm run check`)', () => {
  it('katalogi pakietów, katalog zdań serwera, katalog-próbka, katalog Info.plist i trzy Info.plist są w porządku; CLI kończy się zerem', () => {
    const { problems, catalogs, serverCatalogs, infoCatalogs, plists, locKeyCatalogs } = l10n.repoProblems(REPO);
    expect(problems).toEqual([]);
    expect([catalogs, serverCatalogs, infoCatalogs, plists, locKeyCatalogs]).toEqual([3, 1, 1, 3, 2]);
    expect(l10n.INFO_PLISTS).toHaveLength(3);
    const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      'l10n-check: green (3 package catalogs, 1 server sentence catalog, 1 Info.plist catalog, 3 Info.plist, '
      + '2 push loc-key catalogs, required languages: en, pl)');
  });
});
