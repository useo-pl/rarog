/**
 * Odczyt źródeł tożsamości apki natywnej dla testów: bundle id i Apple ID apki ze `scripts/ios-identity.sh`,
 * bundle id celów z `project.pbxproj`, wartości z plistów XML i katalogów copy oraz napisy z plików TypeScript:
 * teksty, które widzi użytkownik apki (katalogi copy, zdania zgód, teksty pushy, zdania serwera), dla strażnika
 * tożsamości.
 *
 * Po co osobny moduł: strażnik tożsamości (`product-identity-guard.test.ts`) i testy
 * skryptów (`scripts-ios-push`, `scripts-ios-check-demo`) biorą wartość ze źródła zamiast
 * literału, więc zmiana bundle id to zmiana źródeł, a nie polowanie na kopie w testach.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from './source-scan.ts';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const IOS_IDENTITY = 'scripts/ios-identity.sh';
export const PBXPROJ = 'native/Rarog/Rarog.xcodeproj/project.pbxproj';

/** Odwrotny DNS: co najmniej dwa człony z liter, cyfr i myślnika. */
export const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export const readRepo = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8');

/** Numer linii (od 1) znaku `offset` w `text`. */
export const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

/** Numeryczne Apple ID apki w App Store Connect (`IOS_ASC_APP_APPLE_ID`): same cyfry, bez zera na początku. */
export const ASC_APPLE_ID_RE = /^[1-9][0-9]*$/;

/**
 * Zmienna `name` z pliku ŹRÓDŁOWANEGO tak jak w skryptach: pod `set -euo pipefail`, z pustym środowiskiem poza
 * `PATH`. Plik ma być samymi przypisaniami — wyjście przy źródłowaniu albo kod różny od zera to błąd z treścią.
 *
 * `--norc` i stdin `ignore`: `bash -c` ze stdin-gniazdem (domyślne `pipe` Node to para gniazd) i bez `SHLVL` uznaje,
 * że uruchomił go rshd, i czyta `~/.bashrc` użytkownika z bazy haseł (bez `HOME` w środowisku). Na runnerze macOS
 * GitHuba ten plik woła `brew shellenv`, a brew bez `HOME` pisze błąd na stderr — wynik zależałby od cudzego pliku
 * startowego, nie od źródłowanego.
 */
function identityValue(name: string, file: string): string {
  const script = [
    'set -euo pipefail',
    'out="$(source "$1" 2>&1)"',
    'if [[ -n "$out" ]]; then printf "źródłowanie wypisało: %s" "$out" >&2; exit 3; fi',
    'source "$1"',
    `printf "%s" "$${name}"`,
  ].join('\n');
  const res = spawnSync('bash', ['--norc', '-c', script, 'ios-identity', file], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0 || res.stderr !== '') {
    throw new Error(`${file}: źródłowanie pod set -euo pipefail nie przeszło (kod ${String(res.status)}): ${res.stderr}`);
  }
  return res.stdout;
}

/** `IOS_BUNDLE_ID` ze `scripts/ios-identity.sh`; wartość spoza {@link BUNDLE_ID_RE} to błąd. */
export function iosBundleId(file = path.join(REPO, IOS_IDENTITY)): string {
  const value = identityValue('IOS_BUNDLE_ID', file);
  if (!BUNDLE_ID_RE.test(value)) throw new Error(`${file}: IOS_BUNDLE_ID „${value}” to nie bundle id`);
  return value;
}

/** `IOS_ASC_APP_APPLE_ID` ze `scripts/ios-identity.sh` — surowa wartość; regułę sprawdza strażnik. */
export function iosAscAppleId(file = path.join(REPO, IOS_IDENTITY)): string {
  return identityValue('IOS_ASC_APP_APPLE_ID', file);
}

/** Jedno `PRODUCT_BUNDLE_IDENTIFIER` celu w jednej konfiguracji, z linią w `project.pbxproj`. */
export interface PbxBundleId {
  readonly target: string;
  readonly config: string;
  /** Warunek ustawienia (`[sdk=iphoneos*]`) albo `''` dla zwykłego. */
  readonly condition: string;
  readonly value: string;
  readonly line: number;
}

/**
 * Ustawienie bundle id: zwykłe (`PRODUCT_BUNDLE_IDENTIFIER = x;`) albo warunkowe
 * (`"PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]" = x;`), klucz i wartość z cudzysłowem albo bez.
 */
const BUNDLE_SETTING = /^[ \t]*"?PRODUCT_BUNDLE_IDENTIFIER((?:\[[^\]\n]*\])*)"? = ("?)([^";\n]*)\2;$/gm;

interface PbxObject {
  readonly body: string;
  /** Przesunięcie początku `body` w pliku (do numerów linii). */
  readonly offset: number;
}

/**
 * `PRODUCT_BUNDLE_IDENTIFIER` każdego celu (`PBXNativeTarget`) w każdej konfiguracji z jego listy. Obiekty projektu
 * stoją na dwóch tabulatorach (`\t\t<id> /* … *\/ = {` … `\t\t};`); słowniki zagnieżdżone (`buildSettings`) są głębiej,
 * więc koniec obiektu jest jednoznaczny. Wartość w cudzysłowie traci cudzysłów. Ustawienia warunkowe
 * (`[sdk=iphoneos*]`, `[arch=…]`) to osobne wpisy z `condition`: build pasujący do warunku bierze je zamiast
 * zwykłego (np. build na urządzenie przy `[sdk=iphoneos*]`).
 */
export function pbxBundleIds(text: string): PbxBundleId[] {
  const objects = new Map<string, PbxObject>();
  for (const match of text.matchAll(/^\t\t([0-9A-F]{24}) \/\*[^\n]*?\*\/ = \{\n([\s\S]*?)^\t\t\};$/gm)) {
    const id = match[1] ?? '';
    const body = match[2] ?? '';
    objects.set(id, { body, offset: match.index + match[0].indexOf(body) });
  }
  const field = (body: string, name: string): string | undefined =>
    new RegExp(`^[ \\t]*${name} = ("?)([^";\\n]*)\\1;$`, 'm').exec(body)?.[2];
  const found: PbxBundleId[] = [];
  for (const object of objects.values()) {
    if (!/^[ \t]*isa = PBXNativeTarget;$/m.test(object.body)) continue;
    const target = field(object.body, 'name') ?? '?';
    const listId = /^[ \t]*buildConfigurationList = ([0-9A-F]{24})\b/m.exec(object.body)?.[1];
    const list = listId === undefined ? undefined : objects.get(listId);
    const ids = /buildConfigurations = \(([^)]*)\);/.exec(list?.body ?? '')?.[1]?.match(/[0-9A-F]{24}/g) ?? [];
    for (const configId of ids) {
      const config = objects.get(configId);
      if (config === undefined) continue;
      const name = field(config.body, 'name') ?? '?';
      for (const setting of config.body.matchAll(BUNDLE_SETTING)) {
        found.push({
          target, config: name, condition: setting[1] ?? '', value: setting[3] ?? '',
          line: lineAt(text, config.offset + setting.index),
        });
      }
    }
  }
  return found;
}

/**
 * KAŻDA linia pliku, w której pada `PRODUCT_BUNDLE_IDENTIFIER` — szerzej niż parser celów (`pbxBundleIds`), żeby
 * kontrola pokrycia widziała też postać, której parser nie zna, i ustawienia poza celami.
 */
export function pbxBundleIdMentions(text: string): { line: number; text: string }[] {
  return text.split('\n').flatMap((content, index) =>
    (content.includes('PRODUCT_BUNDLE_IDENTIFIER') ? [{ line: index + 1, text: content.trim() }] : []));
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = (raw: string): string => raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] ?? '');

/** Komentarze XML zamienione na spacje (nowe linie zostają, więc numery linii też): zakomentowany klucz nie istnieje. */
const withoutComments = (xml: string): string =>
  xml.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));

/**
 * Wartość `<string>` pod kluczem `key` w plist XML (wszystkie wystąpienia klucza, z linią). Wystarcza dla
 * płaskich plistów apki; klucz zagnieżdżony (np. w `CFBundleURLTypes`) też znajduje, bo szuka po tekście.
 */
export function plistStrings(source: string, key: string): { value: string; line: number }[] {
  const xml = withoutComments(source);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...xml.matchAll(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`, 'g'))]
    .map((match) => ({ value: xmlText(match[1] ?? ''), line: lineAt(xml, match.index) }));
}

/** Napisy tablicy `<array>` pod kluczem `key` (każde wystąpienie klucza osobno), z linią klucza. */
export function plistArrays(source: string, key: string): { values: string[]; line: number }[] {
  const xml = withoutComments(source);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...xml.matchAll(new RegExp(`<key>${escaped}</key>\\s*<array>([\\s\\S]*?)</array>`, 'g'))].map((match) => ({
    values: [...(match[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((item) => xmlText(item[1] ?? '')),
    line: lineAt(xml, match.index),
  }));
}

/** Każda para `<key>K</key><string>V</string>` w plist XML (bez komentarzy), z linią klucza. */
export function plistStringEntries(source: string): { key: string; value: string; line: number }[] {
  const xml = withoutComments(source);
  return [...xml.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)].map((match) => ({
    key: xmlText(match[1] ?? ''), value: xmlText(match[2] ?? ''), line: lineAt(xml, match.index),
  }));
}

/**
 * Napisy i kawałki szablonów pliku TypeScript, które mogą trafić do człowieka: bez komentarzy (skaner
 * `source-scan.ts`) i bez specyfikatorów modułów (`from '…'`, `import '…'`, `import('…')`), z linią. Treść surowa:
 * znaki ucieczki nie są rozwijane, kawałek szablonu kończy się na `${`. Specyfikatorem bywa tylko napis otwarty
 * cudzysłowem albo grawisem: kawałek szablonu po interpolacji (`${from}`, `${o.import}`) zaczyna się za `}`.
 */
export function tsTextLiterals(source: string): { value: string; line: number }[] {
  const specifier = (offset: number): boolean => /['"`]/.test(source[offset - 1] ?? '')
    && /(?:\bfrom|\bimport)\s*\(?\s*$/.test(source.slice(0, Math.max(0, offset - 1)));
  return scan(source).literals
    .filter((literal) => !specifier(literal.offset))
    .map((literal) => ({ value: literal.text, line: lineAt(source, literal.offset) }));
}

/** Tekst, który widzi użytkownik apki: plik, miejsce (`plik:linia` albo `plik „klucz” [język]`) i wartość. */
export interface UserText {
  readonly file: string;
  readonly where: string;
  readonly value: string;
}

/** Katalog apki natywnej: leży w nim projekt Xcode ({@link PBXPROJ}). */
export const APP_DIR = path.posix.dirname(path.posix.dirname(PBXPROJ));
/** Nazwa apki w nazwach celów i pakietów (`<nazwa>Widgets`, `<nazwa>UI`): ostatni człon {@link APP_DIR}. */
const APP = path.posix.basename(APP_DIR);
export const APP_PLIST = `${APP_DIR}/Info.plist`;
export const WIDGET_PLIST = `${APP_DIR}/${APP}Widgets/Info.plist`;
export const NSE_PLIST = `${APP_DIR}/${APP}NotificationService/Info.plist`;
/** Katalog `Info.plist` apki w folderze celu apki: zdania zgód w każdym języku. */
export const APP_INFO_CATALOG = `${APP_DIR}/${APP}/InfoPlist.xcstrings`;
export const UI_CATALOG = `${APP_DIR}/Packages/${APP}UI/Sources/${APP}UI/Copy/Localizable.xcstrings`;
/** Katalog zdań serwera: `server.*` i `push.*` z `en` z rejestru i `pl`, wyjście `scripts/sentences-catalog.mjs`. */
export const CONTRACT_CATALOG = `${APP_DIR}/Packages/${APP}Contract/Sources/${APP}Contract/Copy/Localizable.xcstrings`;
/**
 * Adresy produktu w apce: polityka prywatności, instrukcja serwera, wsparcie i skrzynka pomocy. Ekran parowania
 * i sekcja „O apce” biorą je z tego pliku; to tekst, który użytkownik widzi w przeglądarce i w mailu.
 */
export const PRODUCT_LINKS = `${APP_DIR}/Packages/${APP}Core/Sources/${APP}Core/ProductLinks.swift`;
/** Link parowania: serwer (`/api/admin/pairings`) i `rarog pair` (`server/src/cli/devices.ts`) wołają tę funkcję. */
export const PAIRING_LINK = 'server/src/auth/admin.ts';
export const PUSH_CONTENT = 'server/src/notify/content.ts';
/** Teksty pushy: treść i fallbacki (`content.ts`), dzwonek kafla (`apns-payload.ts`), tytuły rodzajów (`notify-copy.ts`). */
export const PUSH_TEXT_SOURCES = [PUSH_CONTENT, 'server/src/notify/apns-payload.ts', 'shared/src/notify-copy.ts'];
/** Rejestr zdań serwera: plik obszaru z choć jednym wpisem (`en:`); obszar bez wpisów nie ma napisów. */
export const SENTENCES_DIR = 'shared/src/sentences';
export const SENTENCE_SOURCES = readdirSync(path.join(REPO, SENTENCES_DIR))
  .filter((name) => name.endsWith('.ts') && name !== 'index.ts').sort()
  .map((name) => `${SENTENCES_DIR}/${name}`)
  .filter((file) => /\ben:/u.test(readRepo(file)));
/**
 * Pliki serwera ze zdaniami, które docierają do ekranu apki: pliki obszarów rejestru zdań
 * ({@link SENTENCE_SOURCES}). Zdanie serwera dla apki (odmowa, błąd REST, stan sesji, notka dialogu, `detail`
 * statusu herdr, zdanie transkryptu, odpowiednik demo) powstaje tylko przez `say()` z kodem rejestru, więc jego
 * angielski szablon stoi tylko w tych plikach; tekst obcy (`foreign()`: herdr, Node, agent, treść demo) nie jest
 * zdaniem serwera.
 */
export const SERVER_TEXT_SOURCES = SENTENCE_SOURCES;

/** Wartości `stringUnit` jednego klucza katalogu `.xcstrings` we wszystkich językach (także w wariantach). */
export function catalogValues(rel: string, key: string): { where: string; value: string }[] {
  type Node = { stringUnit?: { value?: string }; variations?: Record<string, Record<string, Node>> };
  const catalog = JSON.parse(readRepo(rel)) as { strings: Record<string, { localizations?: Record<string, Node> }> };
  const out: { where: string; value: string }[] = [];
  const walk = (node: Node, where: string): void => {
    if (node.stringUnit?.value !== undefined) out.push({ where, value: node.stringUnit.value });
    for (const [kind, cases] of Object.entries(node.variations ?? {})) {
      for (const [name, child] of Object.entries(cases)) walk(child, `${where}/${kind}.${name}`);
    }
  };
  for (const [language, node] of Object.entries(catalog.strings[key]?.localizations ?? {})) {
    walk(node, `${rel} „${key}” [${language}]`);
  }
  return out;
}

/**
 * Katalogi copy apki i rozszerzeń (`*.xcstrings` pod {@link APP_DIR}) poza testami i wynikami buildu: dziś trzy
 * katalogi pakietów z copy, katalog zdań serwera ({@link CONTRACT_CATALOG}) i katalog `Info.plist` apki
 * ({@link APP_INFO_CATALOG}); nowy katalog wejdzie tu sam.
 */
export function copyCatalogs(dir = APP_DIR): string[] {
  const skip = (name: string): boolean => name.startsWith('.') || name.endsWith('Tests') || name === 'build'
    || name === 'DerivedData' || name.endsWith('.xcodeproj') || name.endsWith('.xcassets');
  return readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((item) => {
    const rel = `${dir}/${item.name}`;
    if (item.isDirectory()) return skip(item.name) ? [] : copyCatalogs(rel);
    return item.name.endsWith('.xcstrings') ? [rel] : [];
  }).sort();
}

/** Wartości wszystkich kluczy katalogów copy (każdy język, każdy wariant), z miejscem `plik „klucz” [język]`. */
export function catalogTexts(catalogs: readonly string[] = copyCatalogs()): UserText[] {
  return catalogs.flatMap((file) => {
    const catalog = JSON.parse(readRepo(file)) as { strings: Record<string, unknown> };
    return Object.keys(catalog.strings).flatMap((key) => catalogValues(file, key).map((entry) => ({ ...entry, file })));
  });
}

const USAGE_KEY = /^NS\w*UsageDescription$/;

/**
 * Zdania zgód (`NS…UsageDescription`): angielskie źródło w `Info.plist` apki, widżetu i NSE oraz każdy język katalogu
 * {@link APP_INFO_CATALOG}, z którego iOS bierze zdanie w języku apki. Ten sam katalog jest też w
 * `catalogTexts()` (wszystkie `*.xcstrings`); tu stoją tylko jego klucze zgód.
 */
export function consentTexts(): UserText[] {
  const plists = [APP_PLIST, WIDGET_PLIST, NSE_PLIST].flatMap((file) => plistStringEntries(readRepo(file))
    .filter((entry) => USAGE_KEY.test(entry.key))
    .map((entry) => ({ file, where: `${file}:${String(entry.line)} ${entry.key}`, value: entry.value })));
  const catalog = JSON.parse(readRepo(APP_INFO_CATALOG)) as { strings: Record<string, unknown> };
  const translated = Object.keys(catalog.strings).filter((key) => USAGE_KEY.test(key))
    .flatMap((key) => catalogValues(APP_INFO_CATALOG, key).map((entry) => ({ ...entry, file: APP_INFO_CATALOG })));
  return [...plists, ...translated];
}

/** Napisy plików TypeScript (bez komentarzy i importów, {@link tsTextLiterals}) z miejscem `plik:linia`. */
export function tsTexts(files: readonly string[]): UserText[] {
  return files.flatMap((file) => tsTextLiterals(readRepo(file))
    .map((entry) => ({ file, where: `${file}:${String(entry.line)}`, value: entry.value })));
}

/**
 * Stałe tekstowe pliku Swift: `static let <nazwa> = "…"` i `static let <nazwa> = URL(string: "…")!`, z linią (od 1).
 * Wystarcza dla pliku samych stałych ({@link PRODUCT_LINKS}); interpolacji i łańcuchów wieloliniowych nie zna.
 */
export function swiftStringConstants(source: string): { name: string; value: string; line: number }[] {
  const constant = /^[ \t]*(?:public |internal |private )?static let (\w+)(?:: [\w.]+)? = (?:URL\(string: )?"([^"\\\n]*)"\)?!?$/gm;
  return [...source.matchAll(constant)].map((match) => ({
    name: match[1] ?? '', value: match[2] ?? '', line: lineAt(source, match.index),
  }));
}

/** Adresy z {@link PRODUCT_LINKS} jako teksty dla użytkownika apki (`plik:linia nazwa`). */
export function productLinkTexts(): UserText[] {
  return swiftStringConstants(readRepo(PRODUCT_LINKS)).map((entry) => ({
    file: PRODUCT_LINKS, where: `${PRODUCT_LINKS}:${String(entry.line)} ${entry.name}`, value: entry.value,
  }));
}
