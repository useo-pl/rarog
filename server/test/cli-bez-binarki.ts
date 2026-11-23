/**
 * Mechanizm strażnika wiedzy o Claude Code spoza dokumentacji i obserwacji; opis: `docs/distribution.md`,
 * „What the repo knows about Claude Code”. Lista `WYJATKI` i test repo stoją w strażniku
 * (`cli-bez-binarki-guard.test.ts`), który ten moduł woła.
 *
 * Po co: repo ma być opublikowane jako open source, a warunki Anthropic zakazują reverse engineeringu. Fakt o CLI
 * wchodzi do repo tylko z dokumentacji albo udokumentowanego interfejsu (klasa a) albo z obserwacji działającego
 * programu (klasa b), nigdy z czytania jego kodu (klasa c). Z samej treści nie widać, skąd fakt pochodzi, więc
 * test łapie słowa, którymi repo mówi o kodzie programu: `WZORZEC` w każdej linii i w ścieżce każdego pliku
 * z zakresu (ścieżka łapie plik danych bez słowa-klucza w treści).
 *
 * Każde trafienie przechodzi jedną z dwóch dróg:
 * 1. `KONTEKSTY` — fraza, która ZAWIERA słowo z `WZORZEC` i wiąże je z innym programem albo innym znaczeniem
 *    słowa („binarka herdr”, „bundle id”, „budżet bundla”…). Przepuszcza tylko trafienia, które sama obejmuje:
 *    inne słowo z `WZORZEC` w tej samej linii liczy się osobno;
 * 2. `WYJATKI` — linia spoza kontekstów, która zostaje na stałe, z powodem.
 * Konteksty i wyjątki są tylko dla innych programów: trafienie o Claude Code nie ma drogi.
 *
 * In `native/` and `relay/` (`NAME_CONDITION_DIRS`) a generic word is a hit only when its unit names Claude Code:
 * a paragraph of a `.md` file, the whole file elsewhere (`unitNamesClaudeCode`). `FRAZY` are hits there too, with
 * no condition.
 *
 * Wpis `WYJATKI` to CAŁA linia po `trim()` (wielkość liter ma znaczenie), nie numer linii: numery
 * się przesuwają, a zmieniona linia przestaje pasować i wraca do przeglądu. Linia powtórzona w pliku ma `ile`.
 * Wpis bez `linia` obejmuje cały plik — tylko sam strażnik i ten moduł (lista zamknięta, test w strażniku).
 *
 * Test pada na trafieniu spoza dwóch dróg (`plik:linia: treść`), na wpisie, który nic już nie trafia (lista się
 * nie starzeje), na wpisie, który trafia inną liczbę linii niż `ile` (domyślnie 1), na linii objętej dwoma
 * wpisami naraz i na kontekście, który niczego nie przepuszcza. Użycie kontekstu liczy się tylko poza plikami
 * z wyjątkiem na cały plik (strażnik): fraza żyjąca tylko w jego przykładach jest martwa.
 *
 * Zakres: pliki repo (`repoFiles`: śledzone i nowe nieignorowane, także w eksporcie bez `.git`), które strażnik
 * liczy, w `server/`, `scripts/`, `shared/`, `docs/`, `native/`, `relay/`, `bin/` oraz pliki `.md` w korzeniu repo,
 * `package.json` i `pnpm-workspace.yaml`, bez plików binarnych. Repo publiczne przechodzi na angielski, więc
 * strażnik szuka też `WZORZEC_ANGIELSKI` tam, gdzie stoi proza (każda linia `.md`, skryptu powłoki i Pythona,
 * napisy kodu TypeScript i JavaScript). Wołający z `frazy: true` liczy też `FRAZY` i `FRAZY_NAZWY`: przyznania
 * metody i nazwy z wnętrza renderera CLI, po polsku i po angielsku.
 *
 * Drugi mechanizm modułu (sekcja na końcu) to zakaz zdań o zachowaniu CLI bez dowodu: `zdaniaBezDowodu` znajduje
 * bloki tekstu ze słowem „CLI”, czasownikiem zachowania i bez znacznika dowodu. Pilnuje go test
 * `cli-fakty-zapadka.test.ts`, a listę wypisuje `scripts/audit-cli-facts.ts`.
 */
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repoFiles, scan } from './source-scan.ts';

/**
 * Słowa, którymi repo mówi o kodzie programu (bez wielkości liter): binarka w każdej formie (z „binarce” i „binarek”,
 * które `binark` nie łapie), bundle, ekstraktor, kod zminifikowany. Szeroko celowo: fałszywe trafienia odsiewają
 * `KONTEKSTY` i `WYJATKI`.
 */
export const WZORZEC = /binark|binarc|binarek|bundl|ekstraktor|zminifik/giu;

/**
 * Angielskie odpowiedniki słów `WZORZEC`: binarka, ekstraktor, kod zminifikowany („bundle” łapie już `bundl`).
 * Repo publiczne jest po angielsku, więc wzorzec obowiązuje tam, gdzie stoi proza: w każdej linii (i ścieżce)
 * dokumentu `.md`, skryptu powłoki i Pythona
 * (`ANGIELSKI_W_LINIACH`) oraz w treści napisów i szablonów kodu TypeScript i JavaScript (`ANGIELSKI_W_NAPISACH`).
 * Poza napisami „binary” to pole diffa i nazwy zmiennych, a w Swift i plikach danych pole kontraktu diffa.
 * Komentarze kodu są po polsku i pilnuje ich `WZORZEC`; angielskie zdanie o binarce CLI w komentarzu łapią `FRAZY`.
 */
export const WZORZEC_ANGIELSKI = /binar(?:y|ies)|extractor|minifi/giu;

/** Pliki, w których `WZORZEC_ANGIELSKI` liczy każdą linię i ścieżkę pliku. */
export const ANGIELSKI_W_LINIACH = /\.(?:md|sh|py)$/u;

/** Pliki kodu, w których `WZORZEC_ANGIELSKI` liczy tylko treść napisów i szablonów (`scan` z `source-scan.ts`). */
export const ANGIELSKI_W_NAPISACH = /\.(?:ts|mts|cts|js|mjs|cjs)$/u;

/**
 * Przyznania metody po polsku: „jak w CLI”, „w kodzie CLI”, „z kodu programu”, „z kodu CLI”, „ani menu, ani docs”,
 * „zaciemn…”.
 */
const FRAZY_POLSKIE = /jak w CLI|w kodzie CLI|z kodu (?:programu|CLI)|ani menu, ani docs|zaciemn/u;

/**
 * Te same przyznania po angielsku („as in the CLI”, „in the CLI code”, „from the program's code”, „neither the
 * menu nor the docs”, „obfuscat…”) i binarka, bundle albo kod źródłowy CLI lub Claude Code nazwane wprost (po
 * polsku łapie je `WZORZEC`).
 */
const FRAZY_ANGIELSKIE = new RegExp([
  /\b(?:as|like) in (?:the )?CLI\b/u,
  /\bin (?:the )?CLI(?:'s)? (?:source )?code\b/u,
  /\bfrom (?:the )?(?:program|CLI)(?:'s)? (?:source )?code\b|\bfrom the (?:source )?code of the (?:program|CLI)\b/u,
  /\bneither (?:the )?menu nor (?:the )?docs\b/u,
  /obfuscat/u,
  /\b(?:CLI|Claude Code)(?:'s)? (?:binar(?:y|ies)|bundles?|source code)\b/u,
  /\b(?:binar(?:y|ies)|bundles?|source code) of (?:the )?(?:CLI|Claude Code)\b/u,
].map((wzorzec) => wzorzec.source).join('|'), 'u');

/**
 * Frazy, którymi tekst przyznaje się do wiedzy z kodu programu albo nazywa wnętrze renderera terminala CLI (bez
 * wielkości liter): `FRAZY_POLSKIE`, `FRAZY_ANGIELSKIE`, plik `cli.js` i nazwy bibliotek renderera (`wrap-ansi`,
 * `string-width`). `cli.js` z granicą słowa, bo `usage.cli.json` to nazwa fixture'u.
 */
export const FRAZY = new RegExp(
  [FRAZY_POLSKIE, FRAZY_ANGIELSKIE, /cli\.js\b|wrap-ansi|string-width/u].map((wzorzec) => wzorzec.source).join('|'),
  'giu',
);

/** Nazwa biblioteki renderera z wielkością liter: `Ink`. Małą literą „ink” to zwykłe słowo. */
export const FRAZY_NAZWY = /\bInk\b/gu;

/**
 * Directories with the name condition: here a generic word (`WZORZEC`, `WZORZEC_ANGIELSKI`, `FRAZY_NAZWY`) is a hit
 * only when its unit names Claude Code (`unitNamesClaudeCode`). The app and the relay mention Claude Code in few
 * files, and their generic words are about Apple bundles and other programs. `FRAZY` stay hits everywhere.
 */
export const NAME_CONDITION_DIRS = ['native/', 'relay/'] as const;

/** Claude Code by name: `claude` in any form (command, `~/.claude`, identifiers) and the `@anthropic-ai/` scope. */
const CLAUDE_NAME = /claude|@anthropic-ai\//iu;

/**
 * Other programs that the repo calls a CLI. A bare “CLI” right next to one of them (“herdr CLI”, “the `rarog`
 * CLI”, “CLI Tailscale”) does not name Claude Code; any other bare “CLI” does.
 */
export const OTHER_PROGRAMS = ['gh', 'git', 'herdr', 'npm', 'rarog', 'tailscale', 'wrangler', 'xcrun'] as const;

const OTHER_BEFORE = new RegExp(`\\b(?:${OTHER_PROGRAMS.join('|')})\`?(?:'s)?\\s+\`?$`, 'iu');
const OTHER_AFTER = new RegExp(`^\`?\\s+\`?(?:${OTHER_PROGRAMS.join('|')})\\b`, 'iu');

/** Whether a unit of text names Claude Code: `CLAUDE_NAME` or a bare “CLI” not next to `OTHER_PROGRAMS`. */
export function unitNamesClaudeCode(text: string): boolean {
  if (CLAUDE_NAME.test(text)) return true;
  return [...text.matchAll(/\bCLI\b/gu)].some((m) => !OTHER_BEFORE.test(text.slice(0, m.index))
    && !OTHER_AFTER.test(text.slice(m.index + 3)));
}

/**
 * Whether the unit of each line names Claude Code (line 0 is the file path). The unit is a paragraph (lines between
 * blank lines) in a `.md` file and the whole file with its path elsewhere; the path of a `.md` file has the whole
 * file as its unit.
 */
function namedUnits(plik: string, tekst: string): (linia: number) => boolean {
  const wholeFile = unitNamesClaudeCode(`${plik}\n${tekst}`);
  if (!plik.endsWith('.md')) return () => wholeFile;
  const named = new Map<number, boolean>();
  let paragraph: number[] = [];
  const close = (lines: readonly string[]): void => {
    const has = unitNamesClaudeCode(paragraph.map((n) => lines[n - 1]!).join('\n'));
    for (const n of paragraph) named.set(n, has);
    paragraph = [];
  };
  const lines = tekst.split('\n');
  lines.forEach((line, i) => {
    if (line.trim() === '') close(lines);
    else paragraph.push(i + 1);
  });
  close(lines);
  return (linia) => (linia === 0 ? wholeFile : named.get(linia) ?? false);
}

const KATALOGI = ['server/', 'scripts/', 'shared/', 'docs/', 'native/', 'relay/', 'bin/'] as const;
/** Pliki korzenia spoza dokumentów `.md`; dokumenty `.md` korzenia wchodzą w zakres wszystkie, bez listy nazw. */
const PLIKI_KORZENIA = ['package.json', 'pnpm-workspace.yaml'] as const;
const dokumentKorzenia = (plik: string): boolean => /^[^/]+\.md$/u.test(plik);

/**
 * Patterns for every line of a file: `WZORZEC` always, `FRAZY` and `FRAZY_NAZWY` with `frazy`. `generic` tells
 * whether a match is a generic word, which needs a name in its unit under `NAME_CONDITION_DIRS`.
 */
const wzorceDla = (frazy: boolean): readonly { wzorzec: RegExp; generic: boolean }[] => [
  { wzorzec: WZORZEC, generic: true },
  ...(frazy ? [{ wzorzec: FRAZY, generic: false }, { wzorzec: FRAZY_NAZWY, generic: true }] : []),
];

/** Zakres kolumn `[od, do)` w linii. */
type Odcinek = readonly [number, number];

/**
 * Gdzie w pliku liczy się `WZORZEC_ANGIELSKI`: `'linie'` (każda linia i ścieżka), mapa linia → odcinki napisów
 * (kod TypeScript i JavaScript; linie od 1) albo `null` (nigdzie).
 */
export function zakresAngielski(plik: string, tekst: string): 'linie' | ReadonlyMap<number, readonly Odcinek[]> | null {
  if (ANGIELSKI_W_LINIACH.test(plik)) return 'linie';
  if (!ANGIELSKI_W_NAPISACH.test(plik)) return null;
  const poczatki = [0];
  for (let i = 0; i < tekst.length; i += 1) if (tekst[i] === '\n') poczatki.push(i + 1);
  const odcinki = new Map<number, Odcinek[]>();
  /** Indeks linii (od 0) początku bieżącego napisu; napisy idą w kolejności źródła. */
  let start = 0;
  for (const { text, offset } of scan(tekst).literals) {
    while (start + 1 < poczatki.length && poczatki[start + 1]! <= offset) start += 1;
    text.split('\n').forEach((kawalek, i) => {
      const od = i === 0 ? offset - poczatki[start]! : 0;
      const lista = odcinki.get(start + i + 1) ?? [];
      lista.push([od, od + kawalek.length]);
      odcinki.set(start + i + 1, lista);
    });
  }
  return odcinki;
}

/** Czy plik (ścieżka względem korzenia repo) należy do zakresu strażnika. */
export function wZakresie(plik: string): boolean {
  return KATALOGI.some((katalog) => plik.startsWith(katalog)) || (PLIKI_KORZENIA as readonly string[]).includes(plik)
    || dokumentKorzenia(plik);
}

export interface Kontekst {
  readonly nazwa: string;
  /** Fraza ze słowem z `WZORZEC`; przepuszcza tylko trafienia wewnątrz swojego dopasowania. */
  readonly wzorzec: RegExp;
  /** Ścieżki plików, w których kontekst obowiązuje; bez pola we wszystkich. */
  readonly plik?: RegExp;
}

export interface Wpis {
  readonly plik: string;
  /** Cała linia po `trim()`; bez niej wpis obejmuje każde trafienie w pliku, także w jego ścieżce. */
  readonly linia?: string;
  /** Ile linii pliku ma dokładnie tę treść (domyślnie 1); tylko przy `linia`. */
  readonly ile?: number;
}

export interface Wyjatek extends Wpis {
  readonly powod: string;
}

/** Linia wpisu: sama treść albo treść powtórzona `ile` razy w pliku. */
export type Linia = string | { readonly linia: string; readonly ile: number };

const zLinii = (linia: Linia): Pick<Wpis, 'linia' | 'ile'> => (typeof linia === 'string' ? { linia } : linia);

/** Kilka wpisów `WYJATKI` jednego pliku i powodu. */
export function wyjatki(plik: string, powod: string, linie: readonly Linia[]): Wyjatek[] {
  return linie.map((linia) => ({ plik, powod, ...zLinii(linia) }));
}

/**
 * Inne programy i inne znaczenia słów, każde jako fraza ze słowem z `WZORZEC` albo `WZORZEC_ANGIELSKI`. Lista ma
 * być krótka i trafna: fraza, która przepuściłaby też słowo o kodzie Claude Code, tu nie wchodzi. Wiedza o Claude
 * Code z jego kodu NIGDY nie przechodzi kontekstem. Fraza po polsku ma obok angielski odpowiednik (repo publiczne
 * przechodzi na angielski), więc kontekst żyje w obu językach; angielskie odmiany sprawdza test mechanizmu.
 */
export const KONTEKSTY: readonly Kontekst[] = [
  // Multiplekser herdr: jego binarka (`RAROG_HERDR_BIN`).
  { nazwa: 'herdr', wzorzec: /binark\p{L}* herdr|herdr(?:'s)? binar(?:y|ies)|binar(?:y|ies) of herdr/giu },
  // Rarog czyta dowiązanie instalatora natywnego i uruchamia program z pełnej ścieżki.
  // To obserwacja pliku na dysku (klasa b), nie kod programu.
  {
    nazwa: 'instalator natywny',
    wzorzec: /binark\p{L}* instalator\p{L}* natywn\p{L}*|dowiązani\p{L}* binark\p{L}*|native installer(?:'s)? binary|binary symlink/giu,
  },
  // Cienka instalacja `@anthropic-ai/claude-agent-sdk`: paczki npm z natywnymi binarkami CLI (~250 MB), których
  // Rarog nie instaluje (`pnpm-workspace.yaml`). O paczkach npm, nie o kodzie programu.
  {
    nazwa: 'SDK',
    wzorzec: /binarki platformowe|natywne binarki CLI(?=[^.]*~250 MB)|platform binaries|native CLI binaries(?=[^.]*~250 MB)/giu,
  },
  // Bundle JavaScript dawnej PWA: budżet, ścieżka startowa, klient sprzed deployu. Gołe „stary bundle” albo
  // „nowy bundle” (old, new bundle) tu nie wchodzi (mogłoby mówić o CLI): takie linie są w `WYJATKI`.
  {
    nazwa: 'bundle PWA',
    wzorzec: new RegExp([
      /budż\p{L}* bundl\p{L}*|budzet-bundla|bundl\p{L}* (?:dawnej )?PWA|startow\p{L}* bundl\p{L}*/u,
      /bundl\p{L}* sprzed (?:\p{L}+ )?deploy\p{L}*/u,
      /bundle budget|bundle-budget|PWA(?:'s)? bundle|bundle of the (?:former )?PWA|startup bundle/u,
      /bundle from before (?:the |a )?deploy\p{L}*/u,
    ].map((wzorzec) => wzorzec.source).join('|'), 'giu'),
  },
  // Apple: bundle id apki i celów (`IOS_BUNDLE_ID`, `PRODUCT_BUNDLE_IDENTIFIER`, `bundleId`), klucze `CFBundle…`,
  // `Info.plist` z dopiskiem „(bundle” złamanym przed „id” (ta linia niesie Team ID właściciela,
  // więc nie wchodzi do `WYJATKI` tego pliku — pilnuje tego `distribution-guard.test.ts`).
  // Ustawienia Xcode `PRODUCT_BUNDLE_…` (np. `$(PRODUCT_BUNDLE_PACKAGE_TYPE)` w `Info.plist`).
  { nazwa: 'bundle id', wzorzec: /bundle[ _-]?id\w*|CFBundle\w*|PRODUCT_BUNDLE_\w+|Info\.plist\W*\(bundle\b/giu },
  // Apple Foundation w Swift: argument `bundle:` (`.main`, `.module`, `nil`, zmienna), metody zmiennej `bundle`
  // (`object`, `url`, `localizedString`, `bundlePath`) i pole `let bundle: String` klucza pamięci tekstów apki.
  {
    nazwa: 'Bundle w Swift',
    wzorzec: /\bbundle: bundle\.bundlePath\b|\bbundle: (?:\.main|\.module|nil|bundle|Bundle)\b|\bbundle\.(?:object|url|localizedString)\b|\blet bundle: String\b/gu,
  },
  // Ścieżka paczki npm na dysku (`node_modules/…/cli.js`): obserwacja instalacji (klasa b), nie kod programu.
  { nazwa: 'ścieżka npm', wzorzec: /node_modules\/[^\s`'"]*cli\.js\b/gu },
  // Wejście programu npm (`npm-cli.js` paczki npm obok węzła), które `rarog setup` woła do pobrania SDK: plik npm,
  // nie kod Claude Code.
  { nazwa: 'npm-cli.js', wzorzec: /\bnpm-cli\.js\b/gu },
  // Apple, z wielkością liter: API `Bundle.…`, główny pakiet procesu (main bundle), pakiet zasobów `….bundle`
  // i zasoby w zbudowanych pakietach (built bundles), `table:bundle:` lokalizacji, `-resultBundlePath` xcodebuild.
  {
    nazwa: 'pakiet Apple',
    wzorzec: /\bBundle\.\w+|[Gg]łówn\p{L}* bundl\p{L}*|[Mm]ain bundle\b|\w\.bundle\b|zbudowanych bundlach|built bundles\b|table:bundle:|resultBundle\w*/gu,
  },
  // APNs i rozszerzenie powiadomień apki (NSE): temat Live Activity, bundle celu `….notification-service`.
  {
    nazwa: 'APNs i NSE',
    wzorzec: /bundl\p{L}* `[^`]*notification-service`|bundle NSE|NSE bundle|bundle[>}]?\.push-type\.liveactivity/giu,
  },
  // Apple `altool`: flagi wysyłki IPA do App Store Connect (wysyłka do TestFlightu; man `altool`).
  { nazwa: 'altool', wzorzec: /--bundle-(?:short-version-string|version)\b/gu },
  // Ruby Bundler w przykładowych komendach (`bundle exec rspec`).
  { nazwa: 'Bundler', wzorzec: /\bbundle exec\b/gu },
  // npm: pole `bundleDependencies` manifestu paczki (paczki dołączone do tarballa, dokumentacja `package.json`)
  // i ta sama lista w wyniku `npm pack --json` (`result.bundled`). Pakowacz paczki npm Raroga, nie kod programu.
  { nazwa: 'pole npm', wzorzec: /\bbundleDependencies\b|\bresult\.bundled\b/gu },
  // npm i sigstore: pole `attestationBundles` wyniku `npm audit signatures --json --include-attestations` (w manifeście
  // pacote `_attestationBundles`) i klucz `bundle` jego wpisu (pakiet sigstore z atestacją, także w JSON-ie odpowiedzi
  // rejestru), które czyta `rarog update`. Format npm, nie kod programu.
  { nazwa: 'atestacje npm', wzorzec: /\b_?attestationBundles\b|\bbundle(?="?: (?:\{|provenanceAttestation\())/gu },
  // Nazwy plików tego strażnika i jego mechanizmu w dokumentach, które je opisują.
  { nazwa: 'strażnik', wzorzec: /cli-bez-binarki(?:-guard)?/gu },
  // Termin z dokumentacji Claude Code: „Bundled skills” (code.claude.com/docs/en/skills) i nazwy, które go niosą
  // (`BUNDLED_SKILLS`, `BundledSkill`, `'bundled-skill'`). Klasa a.
  { nazwa: 'bundled skills', wzorzec: /BUNDLED_SKILLS|BundledSkill|bundled-skill|[Bb]undled skills?/gu },
  // Pole `binary` diffa i szczegółów pliku (git nie liczy linii pliku), nazwy fixture'ów z nim
  // (`diff.file.binary.json`, `git-status.null-file-binary`), wskaźnik JSON `/binary` i wyjście gita
  // „Binary files … differ” (bez granicy słowa z przodu: w napisie stoi za `\n`). Słowo angielskie, więc liczy się
  // tylko w zakresie `WZORZEC_ANGIELSKI`.
  { nazwa: 'pole binary', wzorzec: /`binary`|\bbinary(?:\?|: (?:true|false|null)\b)|[./-]binary\b|Binary files\b/gu },
  // Pole `binaries` konfiguracji wydania: lista plików binarnych, które skaner prywatności przepuszcza
  // (`scripts/lib/private-scan.mjs`), także w jego komunikacie `allowlist: binaries (…)`.
  {
    nazwa: 'lista binaries',
    wzorzec: /`binaries`|"binaries"|'binaries'|\bbinaries(?=[:[])|\ballowlist: binaries\b/gu,
  },
  // Pliki binarne repo, które skaner prywatności czyta jako napisy (`scripts/lib/private-scan.mjs`, plik z bajtem
  // zerowym w pierwszych 8000 bajtach), w opisie skanera w dokumencie publikacji.
  { nazwa: 'pliki binarne skanera', wzorzec: /\bbinary files?\b/gu, plik: /^docs\/publishing\.md$/u },
  // Tekst dialogu Bash Claude Code w fixturze ekranu (obserwacja, klasa b): powód ostrzeżenia o poleceniu.
  { nazwa: 'dialog Bash', wzorzec: /\(expansion obfuscation\)/gu },
  // Typ węzła ESTree `BinaryExpression` w strażnikach testów, które czytają kod przez `parseAst` z `vitest/node`.
  { nazwa: 'węzeł AST', wzorzec: /\bBinaryExpression\b/gu },
  // Tag YAML `!!binary` (base64) w nagłówku skilla albo agenta: kontrola listy hooków zabiera za niego dowód
  // ukryty (`server/src/herdr/dialogs/layer1/hook-list/hook-list.ts`), w testach tej kontroli i w jej opisie
  // w `docs/dialogs.md`.
  { nazwa: 'tag YAML', wzorzec: /!!binary\b/gu },
];

export interface Reguly {
  readonly konteksty: readonly Kontekst[];
  readonly wyjatki: readonly Wyjatek[];
  /** Czy liczyć też `FRAZY` i `FRAZY_NAZWY` (domyślnie nie). */
  readonly frazy?: boolean;
}

/** Linia z trafieniem, którego nie przepuścił żaden kontekst. `linia` 0 to ścieżka pliku. */
export interface Trafienie {
  readonly plik: string;
  readonly linia: number;
  readonly tekst: string;
  /** Pozycja pierwszego nieprzepuszczonego trafienia w linii (do wycinka w komunikacie). */
  readonly od: number;
}

export interface Raport {
  /** Trafienia spoza dwóch dróg: `plik:linia: treść`. */
  readonly bezDrogi: string[];
  /** Wpisy `WYJATKI`, które nic nie trafiają. */
  readonly nieaktualne: string[];
  /** Wpisy z `linia`, które trafiają inną liczbę linii niż `ile` (domyślnie 1). */
  readonly licznosc: string[];
  /** Linie objęte więcej niż jednym wpisem. */
  readonly niejednoznaczne: string[];
  /** Nazwy kontekstów, które przepuściły choć jedno trafienie poza plikami z wyjątkiem na cały plik. */
  readonly uzyteKonteksty: ReadonlySet<string>;
  /** Liczba linii z trafieniem wzorca (z liniami ścieżek). */
  readonly linieZTrafieniem: number;
  /** Linie przepuszczone kontekstem i objęte wyjątkiem. */
  readonly podzial: {
    readonly konteksty: number;
    readonly wyjatki: number;
  };
}

/** Wszystkie dopasowania wyrażenia (z flagą `g`, bez względu na to, czy wzorzec ją ma). */
function dopasowania(wzorzec: RegExp, tekst: string): { od: number; do: number }[] {
  const globalny = new RegExp(wzorzec.source, wzorzec.flags.includes('g') ? wzorzec.flags : `${wzorzec.flags}g`);
  return [...tekst.matchAll(globalny)].map((m) => ({ od: m.index, do: m.index + m[0].length }));
}

/**
 * Linie pliku (ze ścieżką jako linią 0) z trafieniami, których żadna fraza nie objęła. `uzyte` dostaje nazwy
 * kontekstów, gdy `liczUzycie`.
 */
function trafieniaPliku(
  plik: string, tekst: string, reguly: Reguly, liczUzycie: boolean, uzyte: Set<string>,
  licznik: { linie: number; konteksty: number },
): Trafienie[] {
  const wynik: Trafienie[] = [];
  const konteksty = reguly.konteksty.filter((k) => k.plik === undefined || k.plik.test(plik));
  const wzorce = wzorceDla(reguly.frazy === true);
  /** `zakresAngielski` pliku, liczony przy pierwszym angielskim słowie (skaner napisów jest drogi). */
  let angielski: ReturnType<typeof zakresAngielski> | undefined;
  /** Trafienia `WZORZEC_ANGIELSKI` w linii: wszystkie, tylko w napisach albo żadne (`zakresAngielski`). */
  const angielskie = (tresc: string, linia: number): { od: number; do: number }[] => {
    const wszystkie = dopasowania(WZORZEC_ANGIELSKI, tresc);
    if (wszystkie.length === 0) return [];
    if (angielski === undefined) angielski = zakresAngielski(plik, tekst);
    if (angielski === null) return [];
    if (angielski === 'linie') return wszystkie;
    const odcinki = angielski.get(linia) ?? [];
    return wszystkie.filter((t) => odcinki.some(([od, koniec]) => od <= t.od && t.do <= koniec));
  };
  const condition = NAME_CONDITION_DIRS.some((katalog) => plik.startsWith(katalog));
  /** `namedUnits` of the file, computed at the first generic word under the condition. */
  let named: ((linia: number) => boolean) | undefined;
  [plik, ...tekst.split('\n')].forEach((tresc, linia) => {
    const wszystkie = [
      ...wzorce.flatMap(({ wzorzec, generic }) => dopasowania(wzorzec, tresc)
        .map((t) => ({ ...t, generic }))),
      ...angielskie(tresc, linia).map((t) => ({ ...t, generic: true })),
    ].sort((a, b) => a.od - b.od);
    const unnamed = condition && wszystkie.some((t) => t.generic)
      && !(named ??= namedUnits(plik, tekst))(linia);
    const trafienia = unnamed ? wszystkie.filter((t) => !t.generic) : wszystkie;
    if (trafienia.length === 0) return;
    licznik.linie += 1;
    const frazy = konteksty.flatMap((k) => dopasowania(k.wzorzec, tresc)
      .map((zakres) => ({ nazwa: k.nazwa, ...zakres })));
    const otwarte = trafienia.filter((t) => {
      const obejmuje = frazy.filter((z) => z.od <= t.od && t.do <= z.do);
      if (liczUzycie) for (const z of obejmuje) uzyte.add(z.nazwa);
      return obejmuje.length === 0;
    });
    if (otwarte.length === 0) {
      licznik.konteksty += 1;
      return;
    }
    wynik.push({ plik, linia, tekst: tresc, od: otwarte[0]!.od });
  });
  return wynik;
}

const obejmuje = (wpis: Wpis, t: Trafienie): boolean =>
  wpis.plik === t.plik && (wpis.linia === undefined || t.tekst.trim() === wpis.linia);

/** Linia do komunikatu: cała, gdy krótka; inaczej wycinek wokół trafienia. */
function pokaz(t: Trafienie): string {
  if (t.linia === 0) return `${t.plik}: (ścieżka pliku)`;
  const tresc = t.tekst.trim();
  if (tresc.length <= 200) return `${t.plik}:${String(t.linia)}: ${tresc}`;
  const od = Math.max(0, t.od - 90);
  const wycinek = t.tekst.slice(od, t.od + 110);
  return `${t.plik}:${String(t.linia)}: ${od > 0 ? '…' : ''}${wycinek}${t.od + 110 < t.tekst.length ? '…' : ''}`;
}

const opisWpisu = (wpis: Wyjatek): string => {
  const gdzie = wpis.linia === undefined
    ? '(cały plik)'
    : `„${wpis.linia.length > 100 ? `${wpis.linia.slice(0, 100)}…` : wpis.linia}”`;
  return `${wpis.plik} ${gdzie} (wyjątek)`;
};

/** Sprawdza pliki (ścieżka względem korzenia → treść); pliki spoza zakresu pomija. */
export function sprawdz(pliki: ReadonlyMap<string, string>, reguly: Reguly): Raport {
  const uzyte = new Set<string>();
  const licznik = { linie: 0, konteksty: 0 };
  const bezUzycia = new Set(reguly.wyjatki.filter((wpis) => wpis.linia === undefined).map((wpis) => wpis.plik));
  const trafienia: Trafienie[] = [];
  for (const [plik, tekst] of [...pliki].sort(([a], [b]) => a.localeCompare(b))) {
    if (!wZakresie(plik)) continue;
    trafienia.push(...trafieniaPliku(plik, tekst, reguly, !bezUzycia.has(plik), uzyte, licznik));
  }
  const bezDrogi: string[] = [];
  const niejednoznaczne: string[] = [];
  let wyjatki = 0;
  const trafione = new Map<Wyjatek, number>();
  for (const t of trafienia) {
    const w = reguly.wyjatki.filter((wpis) => obejmuje(wpis, t));
    for (const wpis of w) trafione.set(wpis, (trafione.get(wpis) ?? 0) + 1);
    if (w.length === 0) bezDrogi.push(pokaz(t));
    else if (w.length > 1) niejednoznaczne.push(`${pokaz(t)} — ${w.map(opisWpisu).join('; ')}`);
    else wyjatki += 1;
  }
  const wszystkie = reguly.wyjatki;
  const nieaktualne = wszystkie.filter((wpis) => !trafione.has(wpis))
    .map((wpis) => `${opisWpisu(wpis)} — nic nie trafia: usuń wpis`);
  const licznosc = wszystkie
    .filter((wpis) => wpis.linia !== undefined && trafione.has(wpis) && trafione.get(wpis) !== (wpis.ile ?? 1))
    .map((wpis) => `${opisWpisu(wpis)} — trafia ${String(trafione.get(wpis))} linii, wpis mówi ${String(wpis.ile ?? 1)}`);
  return {
    bezDrogi, nieaktualne, licznosc, niejednoznaczne, uzyteKonteksty: uzyte, linieZTrafieniem: licznik.linie,
    podzial: { konteksty: licznik.konteksty, wyjatki },
  };
}

/**
 * Pliki repo `root` w zakresie, dla których `liczy` daje `true` (śledzone i nowe nieignorowane; bez `.git` —
 * spacer z regułami `.gitignore`, `repoFiles`), jako tekst; binarne (bajt zerowy) i nie-pliki pominięte.
 */
export function plikiRepo(root: string, liczy: (plik: string) => boolean): Map<string, string> {
  const pliki = new Map<string, string>();
  for (const plik of repoFiles(root)) {
    if (!wZakresie(plik) || !liczy(plik)) continue;
    const pelna = path.join(root, plik);
    let jestPlikiem = false;
    try {
      jestPlikiem = lstatSync(pelna).isFile();
    } catch {
      // Plik w indeksie, ale skasowany z drzewa roboczego — nie ma czego czytać.
    }
    if (!jestPlikiem) continue;
    const bajty = readFileSync(pelna);
    if (bajty.subarray(0, 8000).includes(0)) continue;
    pliki.set(plik, bajty.toString('utf8'));
  }
  return pliki;
}

/*
 * Zakaz zdań o zachowaniu CLI bez dowodu. Jednostką jest blok: akapit dokumentu `.md` (punkt listy, nagłówek,
 * wiersz tabeli i linia bloku kodu to osobne bloki), ciąg linii komentarza w kodzie (pusta linia komentarza dzieli
 * blok) albo pojedyncza linia kodu (tytuł testu, napis). Blok liczy się, gdy ma słowo „CLI” (`PODMIOT`), czasownik
 * zachowania (`CZASOWNIK`) i nie ma znacznika dowodu (`DOWOD`): wersji `x.y.z`, fixture'u, „docs”, dokumentacji,
 * changelogu ani dopisku „niezmierzone”. Pliki: `.md`, kod TypeScript, JavaScript i Swift, skrypty powłoki; dane
 * (JSON, fixture'y tekstowe) i pliki mechanizmu (`MECHANIZM_FAKTOW`) odpadają.
 *
 * Heurystyka jest niepełna w obie strony: łapie zdania o Rarogu obok słowa „CLI” i przepuszcza zdania z innym
 * czasownikiem. Test zakazu przewraca każdy taki blok w widoku eksportu; poprawka to dowód przy zdaniu, wycięcie
 * zdania albo zdanie przepisane tak, żeby nie mówiło o zachowaniu CLI.
 */

/** Podmiot zdania: słowo „CLI” (z wielkością liter, całe słowo). */
export const PODMIOT = /\bCLI\b/u;

/**
 * Czasowniki zachowania w 3. osobie liczby pojedynczej, całe słowa, po polsku i po angielsku (zapisuje: writes,
 * saves; rysuje: draws, renders; ucina: truncates, cuts; szuka: searches; bierze: takes; liczy: counts; zamienia:
 * replaces; kasuje: deletes, removes; przepisuje: rewrites).
 */
export const CZASOWNIK = new RegExp(`(?<!\\p{L})(?:${[
  'zapisuje', 'rysuje', 'ucina', 'szuka', 'bierze', 'liczy', 'zamienia', 'kasuje', 'przepisuje',
  'writes', 'saves', 'draws', 'renders', 'truncates', 'cuts', 'searches', 'takes', 'counts', 'replaces', 'deletes',
  'removes', 'rewrites',
].join('|')})(?!\\p{L})`, 'u');

/**
 * Znacznik dowodu: wersja `x.y.z`, fixture, docs, dokumentacja (documentation), changelog albo dopisek
 * „niezmierzone” (unmeasured).
 */
export const DOWOD =
  /\b\d+\.\d+\.\d+\b|fixture|(?<!\p{L})docs(?!\p{L})|dokumentacj|documentation|changelog|niezmierzon|unmeasured/iu;

/** Pliki mechanizmu (wzorce, linie list strażnika, dane syntetyczne testów): zapadka ich nie liczy. */
export const MECHANIZM_FAKTOW: readonly string[] = [
  'scripts/audit-cli-facts.ts',
  'server/test/cli-bez-binarki-guard.test.ts',
  'server/test/cli-bez-binarki.ts',
  'server/test/cli-fakty-zapadka.test.ts',
];

const ROZSZERZENIA_KODU: ReadonlySet<string> = new Set(['.ts', '.mts', '.mjs', '.js', '.swift']);

export interface Blok {
  /** Pierwsza i ostatnia linia bloku (od 1). */
  readonly od: number;
  readonly do: number;
  readonly tekst: string;
}

export interface ZdanieBezDowodu extends Blok {
  readonly plik: string;
}

/** Zbiera kolejne linie w bloki. */
class Bloki {
  readonly lista: Blok[] = [];
  #od = 0;
  #do = 0;
  #linie: string[] = [];

  dodaj(n: number, linia: string): void {
    if (this.#linie.length === 0) this.#od = n;
    this.#do = n;
    this.#linie.push(linia);
  }

  zamknij(): void {
    if (this.#linie.length > 0) this.lista.push({ od: this.#od, do: this.#do, tekst: this.#linie.join('\n') });
    this.#linie = [];
  }

  osobno(n: number, linia: string): void {
    this.zamknij();
    this.dodaj(n, linia);
    this.zamknij();
  }
}

/**
 * Bloki dokumentu `.md`: akapity, a punkt listy, nagłówek, wiersz tabeli i linia bloku kodu osobno. Blok kodu
 * zamyka znacznik z tego samego znaku, nie krótszy od otwierającego i bez dopisku (CommonMark), więc ``` wewnątrz
 * bloku z czterech grawisów jest treścią.
 */
function blokiDokumentu(linie: readonly string[]): Blok[] {
  const bloki = new Bloki();
  /** Otwierający znacznik bloku kodu (`` ``` ``, `~~~~`…) albo `null` poza blokiem. */
  let plot: string | null = null;
  linie.forEach((linia, i) => {
    const tresc = linia.trim();
    const znacznik = /^(`{3,}|~{3,})(.*)$/u.exec(tresc);
    const otwiera = znacznik !== null && plot === null;
    const zamyka = znacznik !== null && plot !== null && znacznik[1]![0] === plot[0]
      && znacznik[1]!.length >= plot.length && znacznik[2]!.trim() === '';
    if (otwiera || zamyka) {
      bloki.zamknij();
      plot = otwiera ? znacznik[1]! : null;
    } else if (tresc === '') {
      bloki.zamknij();
    } else if (plot !== null || /^#{1,6}\s/u.test(tresc) || tresc.startsWith('|')) {
      bloki.osobno(i + 1, linia);
    } else {
      if (/^(?:[-*+]|\d+[.)])\s/u.test(tresc)) bloki.zamknij();
      bloki.dodaj(i + 1, linia);
    }
  });
  bloki.zamknij();
  return bloki.lista;
}

/**
 * Treść komentarza w linii kodu albo `null` (linia kodu). `stan.wBloku` niesie komentarz blokowy przez linie;
 * `#` liczy się jako komentarz tylko w skrypcie powłoki.
 */
function komentarz(tresc: string, powloka: boolean, stan: { wBloku: boolean }): string | null {
  const bezKonca = (tekst: string): string => tekst.replace(/\*\/.*$/u, '').replace(/^\*+/u, '');
  if (stan.wBloku) {
    if (tresc.includes('*/')) stan.wBloku = false;
    return bezKonca(tresc);
  }
  if (tresc.startsWith('//')) return tresc.replace(/^\/{2,}/u, '');
  if (tresc.startsWith('/*')) {
    const reszta = tresc.slice(2);
    stan.wBloku = !reszta.includes('*/');
    return bezKonca(reszta);
  }
  if (powloka && tresc.startsWith('#') && !tresc.startsWith('#!')) return tresc.replace(/^#+/u, '');
  return null;
}

/** Bloki kodu: ciągi linii komentarza (pusta linia komentarza dzieli) i każda linia kodu osobno. */
function blokiKodu(linie: readonly string[], powloka: boolean): Blok[] {
  const bloki = new Bloki();
  const stan = { wBloku: false };
  linie.forEach((linia, i) => {
    const tresc = linia.trim();
    const tekst = komentarz(tresc, powloka, stan);
    if (tekst === null) {
      if (tresc === '') bloki.zamknij();
      else bloki.osobno(i + 1, linia);
    } else if (tekst.trim() === '') {
      bloki.zamknij();
    } else {
      bloki.dodaj(i + 1, linia);
    }
  });
  bloki.zamknij();
  return bloki.lista;
}

/** Bloki pliku, które liczy zapadka: „CLI” i czasownik zachowania bez znacznika dowodu. */
export function blokiBezDowodu(plik: string, tekst: string): Blok[] {
  const rozszerzenie = path.extname(plik);
  const linie = tekst.split('\n');
  let bloki: Blok[] = [];
  if (rozszerzenie === '.md') bloki = blokiDokumentu(linie);
  else if (ROZSZERZENIA_KODU.has(rozszerzenie)) bloki = blokiKodu(linie, false);
  else if (rozszerzenie === '.sh') bloki = blokiKodu(linie, true);
  return bloki.filter((blok) => PODMIOT.test(blok.tekst) && CZASOWNIK.test(blok.tekst) && !DOWOD.test(blok.tekst));
}

/** Zdania bez dowodu w plikach w zakresie (ścieżka → treść), po pliku i linii; pliki mechanizmu pominięte. */
export function zdaniaBezDowodu(pliki: ReadonlyMap<string, string>): ZdanieBezDowodu[] {
  return [...pliki]
    .filter(([plik]) => wZakresie(plik) && !MECHANIZM_FAKTOW.includes(plik))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([plik, tekst]) => blokiBezDowodu(plik, tekst).map((blok) => ({ plik, ...blok })));
}

/** Liczba zdań bez dowodu per plik (tylko pliki z co najmniej jednym). */
export function liczbyZdan(zdania: readonly ZdanieBezDowodu[]): Map<string, number> {
  const liczby = new Map<string, number>();
  for (const zdanie of zdania) liczby.set(zdanie.plik, (liczby.get(zdanie.plik) ?? 0) + 1);
  return liczby;
}

/**
 * Miejsce zdania na liście audytu: `plik:od-do` (`plik:linia` dla bloku z jednej linii). Bez treści linii: lista
 * idzie na ekran i do logów, a linia repo może nieść literał, którego nie wolno wypisać.
 */
export const miejsceZdania = (zdanie: ZdanieBezDowodu): string =>
  `${zdanie.plik}:${String(zdanie.od)}${zdanie.do === zdanie.od ? '' : `-${String(zdanie.do)}`}`;
