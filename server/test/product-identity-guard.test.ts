/**
 * Strażnik tożsamości produktu: identyfikatory, które widzi system i użytkownik apki, mają jedno źródło prawdy
 * albo test zgodności między źródłami. Zmiana nazwy w jednym miejscu bez pozostałych przewraca ten test z listą
 * wartości i miejsc.
 *
 * Część POZYTYWNA, na źródłach tożsamości, nie na literałach w teście:
 * - bundle id: `IOS_BUNDLE_ID` (`scripts/ios-identity.sh`) = cel `Rarog` w `project.pbxproj`; każda linia
 *   `PRODUCT_BUNDLE_IDENTIFIER` ma prefiks `IOS_BUNDLE_ID`,
 *   widżet to `<IOS_BUNDLE_ID>.widgets`, rozszerzenie powiadomień (NSE) `<IOS_BUNDLE_ID>.notification-service`;
 *   `CFBundleURLName` = `IOS_BUNDLE_ID`;
 * - nazwa pod ikoną: `CFBundleDisplayName` apki, widżetu i NSE = `app.appName` w katalogu copy RarogUI (każdy język);
 * - schemat linku: `CFBundleURLSchemes` = `PushRouting.scheme` = `LiveActivityPresentation.scheme` =
 *   `PairingLinkWire.scheme` (Swift, odczyt regexem) = `PAIRING_LINK_SCHEME` (`shared/src/pairing-link.ts`);
 * - pairing link host (universal link `https://<host>/pair#…`): the only `applinks:<host>` entry of
 *   `com.apple.developer.associated-domains` in `Rarog.entitlements` = `PairingLinkWire.host` (Swift, read by regex) =
 *   `PAIRING_LINK_HOST` (`shared/src/pairing-link.ts`) = the host of the link from `pairingLink`
 *   (`server/src/auth/admin.ts`, which `rarog pair` calls too) = the site domain of `ProductLinks.setup`, which also
 *   serves the association file for that link;
 * - grupy Keychaina: `RarogKeychainGroup` i `RarogKeychainSharedGroup` w `Info.plist` = `keychain-access-groups`
 *   w `Rarog.entitlements`, pod `$(AppIdentifierPrefix)<IOS_BUNDLE_ID>`; NSE ma w entitlements DOKŁADNIE grupę
 *   współdzieloną (bez prywatnej: sekretu urządzenia nie widzi), a jego `RarogKeychainSharedGroup` = apki;
 * - temat przekaźnika push: `APP_TOPIC` w `relay/src/identity.ts` (allow-lista tematów, odczyt regexem —
 *   przekaźnik to osobny projekt, bez importu) = `RELAY_APP_TOPIC` w `shared/src/relay.ts` (temat, który serwer
 *   bez klucza przyjmuje w rejestracji i dla którego zamawia przepustki) = `IOS_BUNDLE_ID`;
 * - adresy produktu w apce: każda stała `ProductLinks.swift` (RarogCore) to strona `https://` albo skrzynka
 *   w domenie przekaźnika push i relaya iroh z `server/src/cli/setup-config.ts` i `setup.ts`, z nazwami i ścieżkami
 *   z kontraktu.
 *
 * Teksty, które widzi użytkownik apki (wartości katalogów copy we wszystkich językach i wariantach, zdania zgód
 * `NS…UsageDescription` trzech `Info.plist` i katalogu `InfoPlist.xcstrings` apki, teksty pushy i angielskie
 * szablony zdań serwera z plików obszarów rejestru, `SERVER_TEXT_SOURCES`; wszędzie bez komentarzy i importów):
 * komenda CLI w nich to `rarog pair` i `rarog devices`.
 * Źródła tych tekstów muszą być niepuste, a skaner plików serwera musi domknąć szkielet, bo wzorzec wzięty za
 * komentarz ukryłby po cichu resztę pliku.
 */
import { describe, expect, it } from 'vitest';
import { PAIRING_LINK_HOST, PAIRING_LINK_SCHEME } from '@rarog/shared/pairing-link';
import { RELAY_APP_TOPIC } from '@rarog/shared/relay';
import { pairingLink } from '../src/auth/admin.ts';
import { DEFAULT_PUSH_RELAY_URL } from '../src/cli/setup-config.ts';
import { DEFAULT_IROH_RELAY } from '../src/cli/setup.ts';
import {
  APP_INFO_CATALOG, APP_PLIST, ASC_APPLE_ID_RE, BUNDLE_ID_RE, NSE_PLIST, PAIRING_LINK, PBXPROJ, PRODUCT_LINKS, PUSH_TEXT_SOURCES,
  SENTENCE_SOURCES, SERVER_TEXT_SOURCES, UI_CATALOG, WIDGET_PLIST, catalogTexts, catalogValues, consentTexts,
  copyCatalogs, iosAscAppleId, iosBundleId, lineAt, pbxBundleIdMentions, pbxBundleIds, plistArrays, plistStringEntries, plistStrings, readRepo,
  swiftStringConstants, tsTextLiterals, tsTexts,
} from './product-identity.ts';
import { scan, unbalanced } from './source-scan.ts';

const ENTITLEMENTS = 'native/Rarog/Rarog.entitlements';
const NSE_ENTITLEMENTS = 'native/Rarog/RarogNotificationService.entitlements';
const PUSH_ROUTING = 'native/Rarog/Packages/RarogCore/Sources/RarogCore/PushRouting.swift';
const LIVE_ACTIVITY = 'native/Rarog/Packages/RarogActivity/Sources/RarogActivity/LiveActivityPresentation.swift';
/** Link parowania w apce: składanie i parsowanie, lustro `shared/src/pairing-link.ts`. */
const PAIRING_LINK_WIRE = 'native/Rarog/Packages/RarogContract/Sources/RarogContract/PairingLinkWire.swift';
const RELAY_IDENTITY = 'relay/src/identity.ts';

/** Wartość z miejscem (`plik:linia opis`), żeby porażka mówiła, co się nie zgadza i gdzie. */
interface Sourced {
  readonly where: string;
  readonly value: string;
}

const table = (entries: readonly Sourced[]): string =>
  entries.map((entry) => `  ${entry.where}: „${entry.value}”`).join('\n');

/** Wszystkie źródła mają tę samą wartość; inaczej komunikat z całą tabelą. */
function expectSame(what: string, entries: readonly Sourced[]): void {
  expect(entries.length, `${what}: brak źródeł`).toBeGreaterThan(1);
  const values = new Set(entries.map((entry) => entry.value));
  expect(values.size, `${what} — źródła się rozjeżdżają:\n${table(entries)}`).toBe(1);
}

/** Dokładnie jedno wystąpienie; inaczej komunikat z liczbą i miejscami. */
function single(what: string, entries: readonly Sourced[]): Sourced {
  expect(entries, `${what}: oczekiwano dokładnie jednego wpisu, jest ${String(entries.length)}:\n${table(entries)}`)
    .toHaveLength(1);
  return entries[0] as Sourced;
}

/** Stała `public static let scheme = "…"` w pliku Swift. */
function swiftScheme(rel: string): Sourced[] {
  const text = readRepo(rel);
  return [...text.matchAll(/^[ \t]*public static let scheme = "([^"]*)"$/gm)]
    .map((match) => ({ where: `${rel}:${String(lineAt(text, match.index))} scheme`, value: match[1] ?? '' }));
}

function plistValue(rel: string, key: string): Sourced[] {
  return plistStrings(readRepo(rel), key).map((hit) => ({ where: `${rel}:${String(hit.line)} ${key}`, value: hit.value }));
}

describe('strażnik tożsamości: odczyt źródeł', () => {
  const pbx = [
    '/* Begin PBXNativeTarget section */',
    '\t\tAA0000000000000000000001 /* App */ = {',
    '\t\t\tisa = PBXNativeTarget;',
    '\t\t\tbuildConfigurationList = AA0000000000000000000002 /* Build configuration list for PBXNativeTarget "App" */;',
    '\t\t\tname = App;',
    '\t\t};',
    '\t\tAA0000000000000000000002 /* Build configuration list for PBXNativeTarget "App" */ = {',
    '\t\t\tisa = XCConfigurationList;',
    '\t\t\tbuildConfigurations = (',
    '\t\t\t\tAA0000000000000000000003 /* Debug */,',
    '\t\t\t);',
    '\t\t};',
    '\t\tAA0000000000000000000003 /* Debug */ = {',
    '\t\t\tisa = XCBuildConfiguration;',
    '\t\t\tbuildSettings = {',
    '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "com.example.app";',
    '\t\t\t\t"PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]" = com.example.device;',
    '\t\t\t};',
    '\t\t\tname = Debug;',
    '\t\t};',
    '\t\tAA0000000000000000000004 /* Project Debug */ = {',
    '\t\t\tisa = XCBuildConfiguration;',
    '\t\t\tbuildSettings = {',
    '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.stray;',
    '\t\t\t};',
    '\t\t\tname = Debug;',
    '\t\t};',
  ].join('\n');

  it('pbxproj: bundle id celu przez listę konfiguracji (także warunkowy), z linią; linia spoza celów widoczna', () => {
    expect(pbxBundleIds(pbx)).toEqual([
      { target: 'App', config: 'Debug', condition: '', value: 'com.example.app', line: 16 },
      { target: 'App', config: 'Debug', condition: '[sdk=iphoneos*]', value: 'com.example.device', line: 17 },
    ]);
    expect(pbxBundleIdMentions(pbx).map((hit) => hit.line)).toEqual([16, 17, 24]);
  });

  it('plist: napis i tablica pod kluczem, z linią i encjami XML; zakomentowany klucz nie istnieje', () => {
    const xml = '<dict>\n\t<key>A</key>\n\t<string>x &amp; y</string>\n\t<key>B</key>\n\t<array>\n'
      + '\t\t<string>p</string>\n\t\t<string>q</string>\n\t</array>\n'
      + '\t<!-- <key>C</key>\n\t<string>stare</string>\n\t<key>B</key><array><string>z</string></array> -->\n'
      + '\t<key>C</key>\n\t<string>nowe</string>\n</dict>';
    expect(plistStrings(xml, 'A')).toEqual([{ value: 'x & y', line: 2 }]);
    expect(plistArrays(xml, 'B')).toEqual([{ values: ['p', 'q'], line: 4 }]);
    expect(plistStrings(xml, 'C')).toEqual([{ value: 'nowe', line: 12 }]);
    expect(plistStrings(xml, 'D')).toEqual([]);
  });

  it('plist: każda para klucz → napis, z linią klucza; komentarz XML pominięty', () => {
    const xml = '<dict>\n\t<key>NSCameraUsageDescription</key>\n\t<string>A &amp; B</string>\n'
      + '\t<!-- <key>NSOld</key><string>x</string> -->\n\t<key>Flag</key>\n\t<true/>\n'
      + '\t<key>CFBundleName</key>\n\t<string>$(PRODUCT_NAME)</string>\n</dict>';
    expect(plistStringEntries(xml)).toEqual([
      { key: 'NSCameraUsageDescription', value: 'A & B', line: 2 },
      { key: 'CFBundleName', value: '$(PRODUCT_NAME)', line: 7 },
    ]);
  });

  it('Swift: stałe tekstowe `static let` (napis i `URL(string:)`), z linią; inna postać nie jest stałą tekstową', () => {
    const source = [
      'public enum Links {',
      '  public static let page = URL(string: "https://a.example/x")!',
      '  static let mail = "help@a.example"',
      '  public static let count = 3',
      '  // public static let old = "https://b.example"',
      '}',
    ].join('\n');
    expect(swiftStringConstants(source)).toEqual([
      { name: 'page', value: 'https://a.example/x', line: 2 },
      { name: 'mail', value: 'help@a.example', line: 3 },
    ]);
  });

  it('TypeScript: napisy i kawałki szablonów z linią; bez komentarzy, importów i wzorców', () => {
    const source = [
      "import { a } from '@app/shared/x';",
      "// komentarz: 'Rarog' w apostrofach",
      "/* blok \"Rarogu\" */ const re = /'rarog'/g;",
      "export const T = { body: 'Tap otwiera Raroga.', key: \"rarog:test\" };",
      'const s = `${label} — odepnij: rarog devices`;',
      "const lazy = await import('./rarog.ts');",
    ].join('\n');
    expect(tsTextLiterals(source)).toEqual([
      { value: 'Tap otwiera Raroga.', line: 4 },
      { value: 'rarog:test', line: 4 },
      { value: '', line: 5 },
      { value: ' — odepnij: rarog devices', line: 5 },
    ]);
  });
});

describe('strażnik tożsamości: część pozytywna (źródła zgodne ze sobą)', () => {
  const bundleId = iosBundleId();
  const pbxText = readRepo(PBXPROJ);
  const targets = pbxBundleIds(pbxText);
  const at = (entry: { target: string; config: string; condition: string; line: number }): string =>
    `${PBXPROJ}:${String(entry.line)} ${entry.target}/${entry.config}${entry.condition}`;

  it('`IOS_BUNDLE_ID` z `scripts/ios-identity.sh` to bundle id', () => {
    expect(bundleId).toMatch(BUNDLE_ID_RE);
  });

  it('`IOS_ASC_APP_APPLE_ID` z `scripts/ios-identity.sh` to same cyfry (numeryczne Apple ID apki)', () => {
    expect(iosAscAppleId()).toMatch(ASC_APPLE_ID_RE);
  });

  it('pbxproj: każda linia z `PRODUCT_BUNDLE_IDENTIFIER` to ustawienie celu z prefiksem `IOS_BUNDLE_ID`', () => {
    // Pokrycie: linia, w której pada nazwa ustawienia, a której parser celów nie odczytał (postać nieznana
    // parserowi, ustawienie projektu albo spoza celu), przewraca test — inaczej jej wartość przeszłaby bez kontroli.
    const unread = pbxBundleIdMentions(pbxText).filter((hit) => !targets.some((entry) => entry.line === hit.line));
    expect(unread.map((hit) => `${PBXPROJ}:${String(hit.line)}: ${hit.text}`),
      'linie PRODUCT_BUNDLE_IDENTIFIER, których strażnik nie odczytał jako ustawienia celu').toEqual([]);
    const wrong = targets.filter((entry) => entry.value !== bundleId && !entry.value.startsWith(`${bundleId}.`));
    expect(wrong.map((entry) => `${at(entry)}: „${entry.value}”`),
      `bundle id bez prefiksu „${bundleId}” (IOS_BUNDLE_ID z scripts/ios-identity.sh)`).toEqual([]);
  });

  it('pbxproj: pięć celów w Debug i Release — apka = `IOS_BUNDLE_ID`, widżet i NSE z sufiksem', () => {
    for (const target of ['Rarog', 'RarogWidgets', 'RarogNotificationService', 'RarogUITests', 'RarogUIKitTests']) {
      const plain = targets.filter((entry) => entry.target === target && entry.condition === '');
      expect(plain.map((entry) => entry.config).sort(),
        `${PBXPROJ}: konfiguracje celu ${target} z PRODUCT_BUNDLE_IDENTIFIER`).toEqual(['Debug', 'Release']);
    }
    const expected: Record<string, string> = {
      Rarog: bundleId, RarogWidgets: `${bundleId}.widgets`, RarogNotificationService: `${bundleId}.notification-service`,
    };
    const wrong = targets.filter((entry) => entry.target in expected && entry.value !== expected[entry.target]);
    expect(wrong.map((entry) => `${at(entry)}: „${entry.value}”, oczekiwano „${String(expected[entry.target])}”`))
      .toEqual([]);
  });

  it('bundle id apki: `IOS_BUNDLE_ID` = cel `Rarog` = `CFBundleURLName`', () => {
    expectSame('bundle id apki', [
      { where: 'scripts/ios-identity.sh IOS_BUNDLE_ID', value: bundleId },
      ...targets.filter((entry) => entry.target === 'Rarog').map((entry) => ({ where: at(entry), value: entry.value })),
      single(`${APP_PLIST} CFBundleURLName`, plistValue(APP_PLIST, 'CFBundleURLName')),
    ]);
  });

  it('temat przekaźnika push: `APP_TOPIC` przekaźnika = `RELAY_APP_TOPIC` serwera = `IOS_BUNDLE_ID`', () => {
    const text = readRepo(RELAY_IDENTITY);
    const topics = [...text.matchAll(/^export const APP_TOPIC = '([^']*)';$/gm)]
      .map((match) => ({ where: `${RELAY_IDENTITY}:${String(lineAt(text, match.index))} APP_TOPIC`, value: match[1] ?? '' }));
    expectSame('temat przekaźnika push', [
      { where: 'scripts/ios-identity.sh IOS_BUNDLE_ID', value: bundleId },
      single(`${RELAY_IDENTITY} APP_TOPIC`, topics),
      { where: 'shared/src/relay.ts RELAY_APP_TOPIC', value: RELAY_APP_TOPIC },
    ]);
  });

  it('nazwa pod ikoną: `CFBundleDisplayName` apki, widżetu i NSE = `app.appName` w katalogu RarogUI', () => {
    const names = catalogValues(UI_CATALOG, 'app.appName');
    expect(names.length, `${UI_CATALOG}: brak wartości klucza app.appName`).toBeGreaterThan(0);
    expectSame('nazwa produktu', [
      single(`${APP_PLIST} CFBundleDisplayName`, plistValue(APP_PLIST, 'CFBundleDisplayName')),
      single(`${WIDGET_PLIST} CFBundleDisplayName`, plistValue(WIDGET_PLIST, 'CFBundleDisplayName')),
      single(`${NSE_PLIST} CFBundleDisplayName`, plistValue(NSE_PLIST, 'CFBundleDisplayName')),
      ...names,
    ]);
  });

  it('schemat linku: plist = `scheme` Swift (PushRouting, LiveActivityPresentation, PairingLinkWire) = `PAIRING_LINK_SCHEME`', () => {
    const schemes = plistArrays(readRepo(APP_PLIST), 'CFBundleURLSchemes');
    const plist = single(`${APP_PLIST} CFBundleURLSchemes`, schemes.flatMap((hit) =>
      hit.values.map((value) => ({ where: `${APP_PLIST}:${String(hit.line)} CFBundleURLSchemes`, value }))));
    expectSame('schemat linku apki', [
      plist,
      single(`${PUSH_ROUTING} scheme`, swiftScheme(PUSH_ROUTING)),
      single(`${LIVE_ACTIVITY} scheme`, swiftScheme(LIVE_ACTIVITY)),
      single(`${PAIRING_LINK_WIRE} scheme`, swiftScheme(PAIRING_LINK_WIRE)),
      { where: 'shared/src/pairing-link.ts PAIRING_LINK_SCHEME', value: PAIRING_LINK_SCHEME },
    ]);
  });

  it('pairing link host: `applinks:` entitlement = `PairingLinkWire.host` (Swift) = `PAIRING_LINK_HOST` = `pairingLink` = the site domain of `ProductLinks`', () => {
    const constant = (rel: string, name: string, value: (raw: string) => string): Sourced[] =>
      swiftStringConstants(readRepo(rel)).filter((entry) => entry.name === name)
        .map((entry) => ({ where: `${rel}:${String(entry.line)} ${name}`, value: value(entry.value) }));
    const link = pairingLink('https://a.example', null, 'k');
    // The server builds the universal link: `https` and the host, nothing else before the path.
    const built = /^https:\/\/([^/?#@:]+)\/pair#/.exec(link)?.[1] ?? '(not an https://<host>/pair# link)';
    // The app claims exactly one associated domain; without it the link opens the browser instead of the app.
    const domains = plistArrays(readRepo(ENTITLEMENTS), 'com.apple.developer.associated-domains');
    const applinks = single(`${ENTITLEMENTS} com.apple.developer.associated-domains`, domains.flatMap((hit) =>
      hit.values.map((value) => ({ where: `${ENTITLEMENTS}:${String(hit.line)} associated-domains`, value }))));
    expectSame('pairing link host', [
      { where: applinks.where, value: applinks.value.replace(/^applinks:/, '') },
      single(`${PAIRING_LINK_WIRE} host`, constant(PAIRING_LINK_WIRE, 'host', (raw) => raw)),
      { where: 'shared/src/pairing-link.ts PAIRING_LINK_HOST', value: PAIRING_LINK_HOST },
      { where: `${PAIRING_LINK} pairingLink → ${link}`, value: built },
      single(`${PRODUCT_LINKS} setup`, constant(PRODUCT_LINKS, 'setup', (raw) => new URL(raw).hostname)),
    ]);
  });

  it('grupy Keychaina: `Info.plist` = `keychain-access-groups` w entitlements, pod `IOS_BUNDLE_ID`', () => {
    const group = single(`${APP_PLIST} RarogKeychainGroup`, plistValue(APP_PLIST, 'RarogKeychainGroup'));
    const shared = single(`${APP_PLIST} RarogKeychainSharedGroup`, plistValue(APP_PLIST, 'RarogKeychainSharedGroup'));
    const declared = plistArrays(readRepo(ENTITLEMENTS), 'keychain-access-groups');
    expect(declared, `${ENTITLEMENTS}: jeden klucz keychain-access-groups`).toHaveLength(1);
    // Kolejność w entitlements nie ma znaczenia dla systemu — porównanie zbiorów.
    expect([...(declared[0]?.values ?? [])].sort(), `${ENTITLEMENTS}:${String(declared[0]?.line)} `
      + `keychain-access-groups — inne niż grupy z Info.plist:\n${table([group, shared])}`)
      .toEqual([group.value, shared.value].sort());
    expect([group.value, shared.value], `grupy Keychaina poza bundle id „${bundleId}”:\n${table([group, shared])}`)
      .toEqual([`$(AppIdentifierPrefix)${bundleId}`, `$(AppIdentifierPrefix)${bundleId}.shared`]);
  });

  it('grupy Keychaina NSE: entitlements = DOKŁADNIE grupa współdzielona, `Info.plist` NSE = apki', () => {
    const declared = plistArrays(readRepo(NSE_ENTITLEMENTS), 'keychain-access-groups');
    expect(declared, `${NSE_ENTITLEMENTS}: jeden klucz keychain-access-groups`).toHaveLength(1);
    // Bez grupy prywatnej apki: rozszerzenie nie widzi sekretu urządzenia, tylko klucz push.
    expect(declared[0]?.values, `${NSE_ENTITLEMENTS}:${String(declared[0]?.line)} keychain-access-groups`)
      .toEqual([`$(AppIdentifierPrefix)${bundleId}.shared`]);
    expectSame('grupa współdzielona Keychaina', [
      single(`${APP_PLIST} RarogKeychainSharedGroup`, plistValue(APP_PLIST, 'RarogKeychainSharedGroup')),
      single(`${NSE_PLIST} RarogKeychainSharedGroup`, plistValue(NSE_PLIST, 'RarogKeychainSharedGroup')),
      { where: `${NSE_ENTITLEMENTS} keychain-access-groups`, value: declared[0]?.values[0] ?? '' },
    ]);
  });
  it('adresy produktu: `ProductLinks.swift` w domenie przekaźnika push i relaya iroh, nazwy i ścieżki kontraktu', () => {
    const source = readRepo(PRODUCT_LINKS);
    const links = swiftStringConstants(source);
    // Stała w innej postaci (interpolacja, wyrażenie) wypadłaby z odczytu po cichu: każda `static let` ma być adresem.
    const declared = source.split('\n').filter((line) => /^\s*(?:public )?static let /.test(line)).length;
    expect(links.length, `${PRODUCT_LINKS}: każda \`static let\` to adres w cudzysłowie`).toBe(declared);
    const relayDomain = (url: string): string => new URL(url).hostname.split('.').slice(1).join('.');
    const linkDomain = (value: string): string => (value.includes('://') ? new URL(value).hostname : value.slice(value.indexOf('@') + 1));
    expectSame('domena produktu', [
      { where: 'server/src/cli/setup-config.ts DEFAULT_PUSH_RELAY_URL', value: relayDomain(DEFAULT_PUSH_RELAY_URL) },
      { where: 'server/src/cli/setup.ts DEFAULT_IROH_RELAY', value: relayDomain(DEFAULT_IROH_RELAY) },
      ...links.map((link) => ({ where: `${PRODUCT_LINKS}:${String(link.line)} ${link.name}`, value: linkDomain(link.value) })),
    ]);
    const shape = Object.fromEntries(links.map((link) => [link.name, link.value.includes('://')
      ? `${new URL(link.value).protocol}${new URL(link.value).pathname}${new URL(link.value).hash}`
      : link.value.slice(0, link.value.indexOf('@') + 1)]));
    expect(shape, `${PRODUCT_LINKS}: nazwy i ścieżki z kontraktu A2`).toEqual({
      privacy: 'https:/privacy', setup: 'https:/setup', support: 'https:/support',
      privacyDictation: 'https:/privacy#dictation', supportMail: 'support@',
    });
  });
});

describe('strażnik tożsamości: teksty dla użytkownika apki', () => {
  const catalogs = copyCatalogs();
  const catalog = catalogTexts(catalogs);
  const consents = consentTexts();
  const pushTexts = tsTexts(PUSH_TEXT_SOURCES);
  const serverTexts = tsTexts(SERVER_TEXT_SOURCES);

  it('pliki serwera ze zdaniami dla apki to pliki obszarów rejestru zdań (`shared/src/sentences/<obszar>.ts`)', () => {
    // Zdanie serwera dla apki powstaje tylko przez `say()` z kodem rejestru, więc jego angielski tekst stoi tylko tu.
    expect(SERVER_TEXT_SOURCES).toEqual(SENTENCE_SOURCES);
    expect(SENTENCE_SOURCES.length, 'pliki obszarów z wpisami').toBeGreaterThanOrEqual(13);
    for (const file of SENTENCE_SOURCES) expect(file).toMatch(/^shared\/src\/sentences\/[a-z-]+\.ts$/u);
    expect(SENTENCE_SOURCES).not.toContain('shared/src/sentences/index.ts');
  });

  it('pliki serwera ze zdaniami dla apki: skaner czyta całość (szkielet domknięty), każdy ma napisy', () => {
    // Wzorzec wzięty za komentarz zjadłby resztę pliku i strażnik przestałby po cichu widzieć napisy.
    for (const file of SERVER_TEXT_SOURCES) {
      expect(unbalanced(scan(readRepo(file)).skeleton), `${file}: skaner nie domknął nawiasów`).toBeNull();
      expect(serverTexts.filter((entry) => entry.file === file).length, `${file}: napisy`).toBeGreaterThan(0);
    }
  });

  it('źródła tekstów są niepuste: trzy katalogi pakietów, zdania zgód apki (Info.plist i każdy język), teksty pushy', () => {
    expect(catalogs).toEqual(expect.arrayContaining([UI_CATALOG,
      'native/Rarog/Packages/RarogActivity/Sources/RarogActivity/Copy/Localizable.xcstrings',
      'native/Rarog/Packages/RarogCore/Sources/RarogCore/Copy/Localizable.xcstrings']));
    expect(catalog.length, 'wartości katalogów').toBeGreaterThan(1000);
    expect(consents.map((entry) => entry.where.replace(/:\d+ /, ' ')).sort()).toEqual([
      `${APP_PLIST} NSCameraUsageDescription`, `${APP_PLIST} NSLocalNetworkUsageDescription`,
      `${APP_PLIST} NSMicrophoneUsageDescription`, `${APP_PLIST} NSPhotoLibraryAddUsageDescription`,
      `${APP_PLIST} NSSpeechRecognitionUsageDescription`,
      `${APP_INFO_CATALOG} „NSCameraUsageDescription” [en]`, `${APP_INFO_CATALOG} „NSCameraUsageDescription” [pl]`,
      `${APP_INFO_CATALOG} „NSLocalNetworkUsageDescription” [en]`,
      `${APP_INFO_CATALOG} „NSLocalNetworkUsageDescription” [pl]`,
      `${APP_INFO_CATALOG} „NSMicrophoneUsageDescription” [en]`,
      `${APP_INFO_CATALOG} „NSMicrophoneUsageDescription” [pl]`,
      `${APP_INFO_CATALOG} „NSPhotoLibraryAddUsageDescription” [en]`,
      `${APP_INFO_CATALOG} „NSPhotoLibraryAddUsageDescription” [pl]`,
      `${APP_INFO_CATALOG} „NSSpeechRecognitionUsageDescription” [en]`,
      `${APP_INFO_CATALOG} „NSSpeechRecognitionUsageDescription” [pl]`,
    ]);
    for (const file of PUSH_TEXT_SOURCES) {
      expect(pushTexts.filter((entry) => entry.file === file).length, `${file}: napisy`).toBeGreaterThan(0);
    }
  });

  it('komendy CLI w tekstach to `rarog pair` i `rarog devices` (warstwa 2)', () => {
    // Także zdanie gniazda administracyjnego dla terminala (`auth/admin.ts`), które leży poza `SERVER_TEXT_SOURCES`.
    const all = [...catalog, ...consents, ...pushTexts, ...serverTexts, ...tsTexts([PAIRING_LINK])];
    const count = (text: string): number => all.filter((entry) => entry.value.includes(text)).length;
    // Sześć zdań katalogu RarogUI i zgoda na aparat mówią `rarog pair|devices`; push i zdanie gniazda — też.
    expect(count('rarog pair'), 'rarog pair').toBeGreaterThanOrEqual(5);
    expect(count('rarog devices'), 'rarog devices').toBeGreaterThanOrEqual(4);
  });
});
