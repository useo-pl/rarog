/**
 * Strażnik wiedzy o Claude Code spoza dokumentacji i obserwacji, część repo publicznego: pliki widoku
 * eksportu. Mechanizm (wzorzec, konteksty, dwie drogi trafienia, reguły wpisów) i jego opis: `cli-bez-binarki.ts`;
 * opis dla człowieka: `docs/distribution.md`, „What the repo knows about Claude Code”.
 *
 * Pliki spoza widoku eksportu odcina `inExportView` z `private-guard.ts`, więc w eksporcie strażnik liczy to samo.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANGIELSKI_W_LINIACH, ANGIELSKI_W_NAPISACH, KONTEKSTY, plikiRepo, sprawdz, wyjatki, type Reguly, type Wyjatek,
} from './cli-bez-binarki.ts';
import { inExportView } from './private-guard.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = 'server/test/cli-bez-binarki-guard.test.ts';
/** Moduł mechanizmu: wzorzec, frazy kontekstów i ich opisy, więc cały plik jest wyjątkiem jak sam strażnik. */
const MECHANIZM = 'server/test/cli-bez-binarki.ts';

/**
 * Linie, które zostają na stałe: inne programy bez frazy z `KONTEKSTY`. Wpis o Claude Code tu nie wchodzi.
 */
const WYJATKI: readonly Wyjatek[] = [
  { plik: SELF, powod: 'strażnik: wzorzec, frazy, linie list i dane syntetyczne testów' },
  { plik: MECHANIZM, powod: 'mechanizm strażnika: wzorzec, frazy kontekstów i ich opisy' },
  ...wyjatki('native/Rarog/docs/tests.md', 'cel testów XCTest w `-only-testing` skryptu `ios-test.sh`', [
    'Several `<target>/<Class>[/<test>]` items go into one run; a target alone (a whole test bundle) is refused. The script',
  ]),
  ...wyjatki('scripts/ios-push.sh', 'bundle id apki iOS dla `xcrun simctl push`', [
    'local dir="$1" udid="$2" bundle="$3" request name result error',
    'if error="$(xcrun simctl push "$udid" "$bundle" "$request" 2>&1 >/dev/null)"; then',
  ]),
  ...wyjatki('server/src/cli-version.ts', 'dowiązanie instalatora natywnego i istnienie celu na dysku (obserwacja, klasa b)', [
    '* sprzątnięty, a dowiązanie nie) obiecywałoby restart na binarce, której nie ma. Instalacja',
  ]),
  ...wyjatki('server/src/config.ts', 'herdr (`RAROG_HERDR_BIN`)', [
    '* integracji rozmawia z herdr gniazdem, nie procesem. Binarkę spawnowaną z pełnią',
  ]),
  ...wyjatki('server/src/config/terminal.ts', 'herdr (`RAROG_HERDR_BIN`)', [
    '* Waliduje `RAROG_HERDR_BIN`: ścieżka bezwzględna bez `..`. To jest binarka spawnowana',
  ]),
  ...wyjatki('server/src/herdr/client.ts', 'skill wbudowany w herdr 0.9.0', [
    '* Skill wbudowany w binarkę 0.9.0 nazywa ten kod `timeout`, ale na 0.9.0 jest to',
    '* przy dzisiejszej stałej: własny próg stalla herdr to 5 s (skill wbudowany w binarkę 0.9.0),',
  ]),
  ...wyjatki('server/src/sessions/manager.ts', 'stary klient dawnej PWA (bundle z cache przeglądarki)', [
    '* ma skąd wysłać `allow-always` — a gdyby wysłał (stary bundle, ręczny POST), odmowa jest',
  ]),
  ...wyjatki('server/src/tailnet.ts', 'CLI Tailscale', [
    '* 2. **Nic nie rzuca.** Brak binarki, wyłączony backend, popsuty JSON, timeout — wszystko to',
    '* z App Store binarka NIE leży w żadnym `bin` — siedzi w pakiecie aplikacji. Lista jest',
    '* Ścieżki macOS stoją pierwsze, w niezmienionej kolejności, więc na Macu wygrywa ta sama binarka',
    '* nie mają jak wejść do obcej binarki, bo nie ma tu `...process.env`. Zmierzone: CLI odpowiada',
    '* Domyślny runner: pierwsza binarka z {@link TAILSCALE_BINARIES}, która odpowie JSON-em.',
  ]),
  ...wyjatki('server/src/term/backend.ts', 'herdr (atrapa backendu terminala)', [
    '* złożyć z dowolnymi rękami, a jego testy nie potrzebowały ani binarki, ani gniazda.',
  ]),
  ...wyjatki('server/src/term/herdr-backend.ts', '`argv0` procesu w panelu herdr', [
    '* `basename`, lowercase i obcięcie: herdr potrafi oddać w `argv0` pełną ścieżkę binarki.',
  ]),
  ...wyjatki('server/src/term/index.ts', '`tmux -V` dawnego backendu terminala i herdr', [
    '* health checku binarki jest po stronie herdr odmowa backendu',
  ]),
  ...wyjatki('server/test/config.test.ts', 'herdr (`RAROG_HERDR_BIN`)', [
    '// Binarkę spawnowaną z uprawnieniami użytkownika wskazujemy palcem, nie przez PATH.',
  ]),
  ...wyjatki('server/test/git-status.test.ts', 'przykładowa ścieżka w wyjściu `git status`', [
    '\'! dist/bundle.js\',',
  ]),
  ...wyjatki('server/test/git-status.test.ts', 'program git', [
    'it(\'nieudany git (nie-repo, brak binarki) daje null zamiast wyjątku\', async () => {',
  ]),
  ...wyjatki('server/test/product-identity.ts', 'ustawienie `PRODUCT_BUNDLE_IDENTIFIER` w pbxproj', [
    'const BUNDLE_SETTING = /^[ \\t]*"?PRODUCT_BUNDLE_IDENTIFIER((?:\\[[^\\]\\n]*\\])*)"? = ("?)([^";\\n]*)\\2;$/gm;',
    'for (const setting of config.body.matchAll(BUNDLE_SETTING)) {',
  ]),
  ...wyjatki('server/test/scripts-ios-app-languages.test.ts',
    'pakiet zasobów Apple (SwiftPM) w syntetycznym drzewie zbudowanej apki', [
      'files.set(path.join(rel, `${name}_${name}.bundle`, `${language}.lproj`, \'Localizable.strings\'), \'"k" = "v";\');',
    ]),
  ...wyjatki('server/test/scripts-launchd.test.ts', 'atrapy `launchctl`, `curl`, `pgrep`, `pkill`', [
    '* Atrapy binarek dla `restart.sh`: log wywołań `launchctl` do pliku, `curl` oddający zadany',
  ]),
  ...wyjatki('server/test/scripts-launchd.test.ts', 'programy systemowe macOS z `/bin` (`ps -E`)', [
    '// `node`, nie `sleep`: `ps -E` nie pokazuje środowiska binarek systemowych z `/bin` (zmierzone),',
  ]),
  ...wyjatki('server/test/tailnet.test.ts', 'CLI Tailscale', [
    '* się sprawdzić inaczej niż uruchamiając coś: że binarka dostaje NIEPUSTY `TERM` (bez niego',
    'it(\'podaje binarce niepusty TERM — inaczej CLI z App Store odpala GUI zamiast odpowiedzieć\', async () => {',
    'const raw = await spawnTailscaleStatus([\'/nie/ma/takiej/binarki\', bin])();',
    '// Mac z App Store trzyma binarkę w pakiecie aplikacji, nie w żadnym `bin`.',
  ]),
  ...wyjatki('server/test/term-herdr-backend.test.ts', 'herdr (proces kontrolera)', [
    '* Ani jednego panelu herdr, ani jednej binarki: proces kontrolera jest wstrzykiwany',
  ]),
  ...wyjatki('server/test/term-herdr-backend.test.ts', '`argv0` procesu w panelu herdr', [
    'it(\'pełna ścieżka binarki schodzi do samej nazwy pliku\', () => {',
  ]),
  ...wyjatki('server/test/term-herdr-stream.test.ts', 'herdr', [
    '* Bez procesu, bez gniazda i bez binarki: cały plik karmi czysty czytnik bajtami, bo dokładnie',
  ]),
  ...wyjatki('server/test/term-integration.test.ts', 'herdr', [
    '* Nie chodzi o brak binarki (tę wykryłby `existsSync`), tylko o SKUTKI: test zakłada',
  ]),
  ...wyjatki('shared/src/protocol.ts', 'stary klient dawnej PWA (bundle z cache przeglądarki)', [
    '* ({@link REFUSE_REASONS}). Stary bundle mapuje każdy nieznany status na „Nie udało się',
    '* `image` z pełnym `dataUrl`. Stary bundle liczy podpis echa jako „tekst + LICZBA bloków',
  ]),
  ...wyjatki('shared/src/protocol/terminal.ts', 'nazwa procesu na pigułce taba terminala', [
    '* a nie ścieżką binarki — dlatego serwer obcina ją u siebie, zamiast liczyć na to, że CSS',
  ]),
  ...wyjatki('shared/test/apns-fixtures.test.ts', 'bundle id apki iOS (temat APNs)', [
    'const BUNDLE = \'ai.rarog.app\';',
    '\'apns-topic\': z.literal(BUNDLE),',
  ]),
  ...wyjatki('shared/test/decode.test.ts', 'stary klient dawnej PWA (bundle z cache przeglądarki)', [
    'it(\'cliDialog: każda klasa przechodzi ściśle; ramka bez pola też; stary bundle pole odcina\', () => {',
  ]),
  ...wyjatki('shared/test/protocol.test.ts', 'stary klient dawnej PWA (bundle z cache przeglądarki)', [
    '// z pełnym `dataUrl`, a stary bundle liczy podpis echa po LICZBIE bloków `image` — więc',
  ]),
];

/** Wpisy bez `linia` (cały plik): sam strażnik i jego mechanizm. */
const CALE_PLIKI = [SELF, MECHANIZM];

describe('strażnik wiedzy o Claude Code: mechanizm (dane syntetyczne)', () => {
  const dwa = KONTEKSTY.filter((k) => k.nazwa === 'herdr' || k.nazwa === 'bundle id');
  const reguly = (wyjatki: readonly Wyjatek[] = []): Reguly => ({ konteksty: dwa, wyjatki });
  const pelne = (wyjatki: readonly Wyjatek[] = []): Reguly => ({ konteksty: KONTEKSTY, wyjatki });

  it('trafienie o Claude Code bez wpisu: błąd z plikiem, linią i treścią linii', () => {
    const raport = sprawdz(new Map([
      ['server/src/nowy.ts', 'const a = 1;\n// Przykład: fakt o CLI wzięty z binarki.\n'],
    ]), reguly());
    expect(raport.bezDrogi).toEqual(['server/src/nowy.ts:2: // Przykład: fakt o CLI wzięty z binarki.']);
  });

  it('fraza innego programu przechodzi; katalog `herdr/` w ścieżce kontekstem nie jest', () => {
    const raport = sprawdz(new Map([
      ['scripts/a.sh', '# --herdr <ścieżka>  binarka herdr (domyślnie ~/.local/bin/herdr)\n'],
      ['docs/b.md', 'Przykład z binarki CLI obok ścieżki `server/src/herdr/x.ts`.\n'],
    ]), reguly());
    expect(raport.bezDrogi).toEqual(['docs/b.md:1: Przykład z binarki CLI obok ścieżki `server/src/herdr/x.ts`.']);
    expect([...raport.uzyteKonteksty]).toEqual(['herdr']);
  });

  it('fraza herdr, SDK albo APNs w linii nie przepuszcza osobnego faktu z binarki obok niej (pełne KONTEKSTY)', () => {
    const raport = sprawdz(new Map([
      ['server/src/a.ts', [
        '// binarka herdr startuje panel.',
        '// binarka herdr startuje panel, a przykład obok niej pochodzi z binarki CLI.',
      ].join('\n')],
      ['pnpm-workspace.yaml', [
        '# paczki SDK niosą natywne binarki CLI (~250 MB na platformę)',
        '# paczki SDK niosą binarki platformowe; przykład obok z bundla CLI',
      ].join('\n')],
      ['docs/c.md', [
        'Temat Live Activity: `<bundle>.push-type.liveactivity`.',
        'Temat Live Activity: `<bundle>.push-type.liveactivity`, a przykład obok z binarki.',
      ].join('\n')],
    ]), pelne());
    expect(raport.bezDrogi).toEqual([
      'docs/c.md:2: Temat Live Activity: `<bundle>.push-type.liveactivity`, a przykład obok z binarki.',
      'pnpm-workspace.yaml:2: # paczki SDK niosą binarki platformowe; przykład obok z bundla CLI',
      'server/src/a.ts:2: // binarka herdr startuje panel, a przykład obok niej pochodzi z binarki CLI.',
    ]);
    expect([...raport.uzyteKonteksty].sort()).toEqual(['APNs i NSE', 'SDK', 'herdr']);
  });

  it('„nowy bundle” i „stary bundle” o Claude Code nie przechodzą; budżet bundla PWA przechodzi; po polsku i po '
    + 'angielsku (pełne KONTEKSTY)', () => {
    const raport = sprawdz(new Map([
      ['docs/d.md', [
        'Nowy bundle Claude Code: przykład zdania.',
        'stary bundle Claude Code: drugi przykład.',
        'Budżet bundla dawnej PWA: 180 kB.',
        'The new bundle ships the fix.',
        'An old bundle rejects the frame.',
        'The PWA bundle budget is 180 kB.',
      ].join('\n')],
    ]), pelne());
    expect(raport.bezDrogi).toEqual([
      'docs/d.md:1: Nowy bundle Claude Code: przykład zdania.',
      'docs/d.md:2: stary bundle Claude Code: drugi przykład.',
      'docs/d.md:4: The new bundle ships the fix.',
      'docs/d.md:5: An old bundle rejects the frame.',
    ]);
    expect([...raport.uzyteKonteksty]).toEqual(['bundle PWA']);
  });

  it('konteksty po angielsku: odpowiedniki polskich fraz i słowa `binary` przepuszczają tylko swoje słowo '
    + '(pełne KONTEKSTY, frazy)', () => {
    const linie = [
      'The herdr binary starts the pane.',
      "herdr's binary path comes from RAROG_HERDR_BIN.",
      'Rarog reads the native installer binary through the binary symlink.',
      'SDK packages carry platform binaries.',
      'npm ships native CLI binaries (~250 MB per platform).',
      'The startup bundle loads first; a bundle from before the deploy rejects the frame.',
      'The main bundle and the built bundles carry the strings.',
      'The NSE bundle receives the push.',
      'Each entry has `binary: true`; see `diff.file.binary.json` and `/fileDetails/1/binary`.',
      'Binary files a/x and b/x differ',
      'The scanner reads the `binaries` list.',
      'The herdr binary sits next to a binary taken from the CLI.',
      'SDK packages carry platform binaries; the CLI binary ships beside them.',
    ];
    const raport = sprawdz(new Map([['docs/en.md', linie.join('\n')]]), { ...pelne(), frazy: true });
    expect(raport.bezDrogi).toEqual([12, 13].map((n) => `docs/en.md:${String(n)}: ${linie[n - 1]!}`));
    expect([...raport.uzyteKonteksty].sort()).toEqual([
      'APNs i NSE', 'SDK', 'bundle PWA', 'herdr', 'instalator natywny', 'lista binaries', 'pakiet Apple', 'pole binary',
    ]);
  });

  it('wpis obejmuje CAŁĄ linię po `trim()`, nie numer linii; liczy się jako wyjątek', () => {
    const raport = sprawdz(new Map([
      ['docs/c.md', 'nowa linia na górze\n   Przykład z binarki (N).\n'],
    ]), reguly([{ plik: 'docs/c.md', linia: 'Przykład z binarki (N).', powod: 'x' }]));
    expect(raport).toMatchObject({ bezDrogi: [], nieaktualne: [], licznosc: [], niejednoznaczne: [] });
    expect(raport.podzial.wyjatki).toBe(1);
  });

  it('zmieniona linia: trafienie bez drogi i nieaktualny wpis; dopisek obok starej linii też bez drogi', () => {
    const wpis: Wyjatek = { plik: 'docs/c.md', linia: 'Przykład z binarki (N).', powod: 'x' };
    const zmieniona = sprawdz(new Map([
      ['docs/c.md', 'Przykład z binarki (N). Drugi przykład z binarki.\n'],
    ]), reguly([wpis]));
    expect(zmieniona.bezDrogi).toEqual(['docs/c.md:1: Przykład z binarki (N). Drugi przykład z binarki.']);
    expect(zmieniona.nieaktualne)
      .toEqual(['docs/c.md „Przykład z binarki (N).” (wyjątek) — nic nie trafia: usuń wpis']);
    const dopisek = sprawdz(new Map([
      ['docs/c.md', 'Przykład z binarki (N).\nDrugi przykład z binarki; Przykład z binarki (N).\n'],
    ]), reguly([wpis]));
    expect(dopisek).toMatchObject({
      bezDrogi: ['docs/c.md:2: Drugi przykład z binarki; Przykład z binarki (N).'], nieaktualne: [], licznosc: [],
    });
  });

  it('linia powtórzona: `ile` musi się zgadzać z liczbą linii, w obie strony', () => {
    const plik = new Map([['scripts/m.ts', '  const x = czytnikBundla(PLIK);\nx\n    const x = czytnikBundla(PLIK);\n']]);
    const wpis = (ile?: number): Wyjatek => ({ plik: 'scripts/m.ts', linia: 'const x = czytnikBundla(PLIK);', powod: 'x', ile });
    expect(sprawdz(plik, reguly([wpis()])).licznosc)
      .toEqual(['scripts/m.ts „const x = czytnikBundla(PLIK);” (wyjątek) — trafia 2 linii, wpis mówi 1']);
    expect(sprawdz(plik, reguly([wpis(2)]))).toMatchObject({ bezDrogi: [], nieaktualne: [], licznosc: [] });
    expect(sprawdz(plik, reguly([wpis(3)])).licznosc)
      .toEqual(['scripts/m.ts „const x = czytnikBundla(PLIK);” (wyjątek) — trafia 2 linii, wpis mówi 3']);
  });

  it('nieaktualny wpis (nic nie trafia albo pliku nie ma) przewraca test', () => {
    const raport = sprawdz(new Map([['docs/c.md', 'linia bez trafienia\n']]), reguly([
      { plik: 'docs/c.md', linia: 'brak binarki daje null', powod: 'git' },
      { plik: 'scripts/zniknal.ts', powod: 'x' },
    ]));
    expect(raport.nieaktualne).toEqual([
      'docs/c.md „brak binarki daje null” (wyjątek) — nic nie trafia: usuń wpis',
      'scripts/zniknal.ts (cały plik) (wyjątek) — nic nie trafia: usuń wpis',
    ]);
  });

  it('wpis trafiający tylko linię przepuszczoną kontekstem też jest nieaktualny', () => {
    const raport = sprawdz(new Map([['server/src/a.ts', '// binarka herdr\n']]), reguly(
      [{ plik: 'server/src/a.ts', linia: '// binarka herdr', powod: 'herdr' }],
    ));
    expect(raport.nieaktualne).toEqual(['server/src/a.ts „// binarka herdr” (wyjątek) — nic nie trafia: usuń wpis']);
  });

  it('kontekst użyty tylko w pliku z wyjątkiem na cały plik (strażnik) jest martwy', () => {
    const straznik = { plik: 'server/test/straznik.test.ts', powod: 'strażnik' };
    const tylkoStraznik = sprawdz(new Map([
      ['server/test/straznik.test.ts', '// binarka herdr\n// z binarki CLI\n'],
    ]), reguly([straznik]));
    expect(tylkoStraznik).toMatchObject({ bezDrogi: [], nieaktualne: [] });
    expect([...tylkoStraznik.uzyteKonteksty]).toEqual([]);
    const takzeGdzieIndziej = sprawdz(new Map([
      ['server/test/straznik.test.ts', '// binarka herdr\n// z binarki CLI\n'],
      ['scripts/a.sh', '# binarka herdr\n'],
    ]), reguly([straznik]));
    expect([...takzeGdzieIndziej.uzyteKonteksty]).toEqual(['herdr']);
  });

  it('`native/`, `relay/`, `bin/` i dokumenty `.md` korzenia są w zakresie; reszta (`.github/`, `promo/`, inny plik '
    + 'korzenia) jest pomijana', () => {
    const raport = sprawdz(new Map([
      ['native/Rarog/Info.plist', 'z binarki CLI'],
      ['relay/src/index.ts', '// bundle Workera z CLI'],
      ['bin/rarog.mjs', '// ekstraktor binarki'],
      ['CHANGELOG.md', 'z binarki CLI'],
      ['.github/workflows/check.yml', '# z binarki CLI'],
      ['promo/README.md', 'ekstraktor binarki'],
      ['LICENSE', 'z binarki CLI'],
      ['vitest.config.ts', '// bundle'],
    ]), reguly());
    expect(raport.bezDrogi).toEqual([
      'bin/rarog.mjs:1: // ekstraktor binarki',
      'CHANGELOG.md:1: z binarki CLI',
      'native/Rarog/Info.plist:1: z binarki CLI',
      'relay/src/index.ts:1: // bundle Workera z CLI',
    ]);
  });

  it('frazy przyznań i nazwy renderera liczą się tylko z `frazy: true`, po polsku i po angielsku, także '
    + 'w komentarzu; `Ink` z wielkością liter, `cli.json` nie', () => {
    const linie = [
      '// zawija jak w CLI',
      '// stała w kodzie CLI',
      '// nazwy z kodu programu',
      '// liczba z kodu CLI',
      '// ani menu, ani docs',
      '// zaciemnione nazwy kluczy',
      '// wynik `wrap-ansi` i `string-width`',
      '// renderer Ink',
      '// ink na papierze',
      '// fixture usage.cli.json',
      '// plik cli.js paczki',
      '// wraps as in the CLI',
      '// a constant in the CLI code',
      "// names from the program's code",
      '// a number from the code of the CLI',
      '// neither the menu nor the docs',
      '// obfuscated key names',
      '// taken from the CLI binary',
      '// the bundle of Claude Code',
      "// Claude Code's source code",
      '// like the CLI, Rarog waits for the prompt',
      '// the CLI source of truth: the transcript file',
    ];
    const pliki = new Map([['server/src/a.ts', linie.join('\n')]]);
    expect(sprawdz(pliki, reguly()).bezDrogi).toEqual([
      'server/src/a.ts:19: // the bundle of Claude Code',
    ]);
    const zFrazami = sprawdz(pliki, { ...reguly(), frazy: true });
    expect(zFrazami.bezDrogi).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
      .map((n) => `server/src/a.ts:${String(n)}: ${linie[n - 1]!}`));
  });

  it('konteksty Apple i ścieżki npm przepuszczają tylko swoje frazy (pełne KONTEKSTY, frazy)', () => {
    const raport = sprawdz(new Map([
      ['native/Rarog/A.swift', [
        'CopyLookup.string(key, bundle: .module, language: .pl)',
        'let format = bundle.localizedString(forKey: key)',
        '// renderer Ink łamie tekst',
        '// bundle CLI',
      ].join('\n')],
      ['server/src/b.ts', '// npm: `…/node_modules/…/cli.js`\n// CLI uruchamia cli.js\n// Renderer CLI: Ink\n'],
      ['docs/c.md', 'Renderer CLI: Ink zawija tekst.\n'],
    ]), { ...pelne(), frazy: true });
    expect(raport.bezDrogi).toEqual([
      'docs/c.md:1: Renderer CLI: Ink zawija tekst.',
      'native/Rarog/A.swift:3: // renderer Ink łamie tekst',
      'native/Rarog/A.swift:4: // bundle CLI',
      'server/src/b.ts:2: // CLI uruchamia cli.js',
      'server/src/b.ts:3: // Renderer CLI: Ink',
    ]);
    expect([...raport.uzyteKonteksty].sort()).toEqual(['Bundle w Swift', 'ścieżka npm']);
  });

  it('angielskie słowa: każda linia i ścieżka `.md`, skryptu powłoki i Pythona; w kodzie TS/JS tylko napisy; '
    + 'Swift i dane nie', () => {
    const raport = sprawdz(new Map([
      ['README.md', 'read from the CLI binary\nthe minified source\nan extractor script\nclean line\n'],
      ['docs/a.md', 'binaries of the CLI\n'],
      ['docs/binary-notes.md', 'clean line\n'],
      ['bin/README.md', 'diff of a binary file\n'],
      ['scripts/a.sh', 'echo "taken from the CLI binary"\n'],
      ['scripts/lib/a.py', "print('minified source')\n"],
      ['server/src/cli/a.ts', [
        "const m = 'read from the CLI binary';",
        'const binary = isBinary(bytes);',
        'const t = `ok ${binary} minified`;',
        '// komentarz: the extractor',
        'const w = `pierwsza linia',
        'druga: an extractor`;',
      ].join('\n')],
      ['server/src/binary-reader.ts', 'export const a = 1;\n'],
      ['native/Rarog/A.swift', 'let binary = "the CLI binary"\n'],
      ['shared/fixtures/x.json', '{"binary": "minified"}\n'],
    ]), reguly());
    expect(raport.bezDrogi).toEqual([
      'bin/README.md:1: diff of a binary file',
      'docs/a.md:1: binaries of the CLI',
      'docs/binary-notes.md: (ścieżka pliku)',
      'README.md:1: read from the CLI binary', 'README.md:2: the minified source', 'README.md:3: an extractor script',
      'scripts/a.sh:1: echo "taken from the CLI binary"',
      "scripts/lib/a.py:1: print('minified source')",
      "server/src/cli/a.ts:1: const m = 'read from the CLI binary';",
      'server/src/cli/a.ts:3: const t = `ok ${binary} minified`;',
      'server/src/cli/a.ts:6: druga: an extractor`;',
    ]);
  });

  it('ścieżka pliku też jest trafieniem; wpis na cały plik obejmuje ścieżkę i treść', () => {
    const pliki = new Map([['server/src/x/dane-z-binarki.json', '{"klucz": "wartość"}\n']]);
    expect(sprawdz(pliki, reguly()).bezDrogi).toEqual(['server/src/x/dane-z-binarki.json: (ścieżka pliku)']);
    const zWpisem = sprawdz(pliki, reguly([{ plik: 'server/src/x/dane-z-binarki.json', powod: 'x' }]));
    expect(zWpisem).toMatchObject({ bezDrogi: [], nieaktualne: [], podzial: { wyjatki: 1 } });
  });

  it('linia objęta dwoma wpisami (linia i cały plik): niejednoznaczna', () => {
    const raport = sprawdz(new Map([['docs/d.md', 'przykład z bundla i z binarki\n']]), reguly([
      { plik: 'docs/d.md', linia: 'przykład z bundla i z binarki', powod: 'x' },
      { plik: 'docs/d.md', powod: 'y' },
    ]));
    expect(raport.niejednoznaczne).toHaveLength(1);
    expect(raport.niejednoznaczne[0]).toContain('docs/d.md:1: przykład z bundla i z binarki');
    expect(raport.niejednoznaczne[0]).toContain('(wyjątek); docs/d.md (cały plik) (wyjątek)');
  });

  it('długa linia: komunikat pokazuje wycinek wokół trafienia', () => {
    const raport = sprawdz(new Map([['docs/e.md', `${'x'.repeat(300)} z binarki ${'y'.repeat(300)}`]]), reguly());
    expect(raport.bezDrogi[0]).toMatch(/^docs\/e\.md:1: …x+ z binarki y+…$/u);
    expect(raport.bezDrogi[0]!.length).toBeLessThan(230);
  });
});

describe('name condition in `native/` and `relay/`: a generic word needs a name in its unit', () => {
  const INSIDE = ['native/Rarog/', 'relay/src/'];
  const OUTSIDE = ['server/src/', 'scripts/', 'shared/src/', 'docs/', 'bin/'];
  /**
   * Made-up texts. `inside`: red lines in `native/` and `relay/`; `outside`: red lines elsewhere, the same as with
   * no condition. Line 0 is the file path. No contexts and no exceptions.
   */
  const CASES: readonly { name: string; file: string; text: string; inside: number[]; outside: number[] }[] = [
    {
      name: 'a file without a name, a generic word', file: 'A.swift',
      text: '// The resource bundle holds the .lproj folders.\nlet x = 1\n', inside: [], outside: [1],
    },
    {
      name: 'a code file with a name anywhere, a generic word', file: 'A.swift',
      text: '// A Claude Code session in the pane.\nlet x = 1\nlet bundle = load()\n', inside: [3], outside: [3],
    },
    {
      name: 'a `.md` file: the paragraph with a name is red, the one without is not', file: 'a.md',
      text: 'Claude Code keeps a bundle here.\n\nThe app bundle holds the .lproj folders.\n', inside: [1],
      outside: [1, 3],
    },
    {
      name: 'a bare CLI names Claude Code', file: 'A.swift',
      text: '// The CLI writes a file; the app bundle keeps it.\n', inside: [1], outside: [1],
    },
    {
      name: 'CLI right after another program does not', file: 'A.swift',
      text: '// The herdr CLI runs next to the app bundle.\n', inside: [], outside: [1],
    },
    {
      name: 'CLI right before another program does not', file: 'A.swift',
      text: '// Check it with CLI `rarog`; the app bundle is separate.\n', inside: [], outside: [1],
    },
    {
      name: 'an admission phrase has no condition', file: 'A.swift', text: '// obfuscated key names\n', inside: [1],
      outside: [1],
    },
    {
      name: 'the renderer name counts as a generic word', file: 'A.swift', text: '// The Ink renderer wraps text.\n',
      inside: [], outside: [1],
    },
    {
      name: 'Claude Code installation files in a Swift file', file: 'A.swift',
      text: '// Claude Code installs its bundle under ~/.local/share/claude.\nlet url = Bundle.main.bundleURL\n',
      inside: [1, 2], outside: [1, 2],
    },
    {
      name: 'a generic word in the path of a file without a name', file: 'Bundles.swift', text: 'let x = 1\n',
      inside: [], outside: [0],
    },
  ];
  const ROWS = CASES.flatMap((c) => [
    ...INSIDE.map((dir) => ({ ...c, dir, red: c.inside })),
    ...OUTSIDE.map((dir) => ({ ...c, dir, red: c.outside })),
  ]);

  it.each(ROWS)('$name: $dir', ({ dir, file, text, red }) => {
    const raport = sprawdz(new Map([[`${dir}${file}`, text]]), {
      konteksty: [], wyjatki: [], frazy: true,
    });
    expect(raport.bezDrogi.map((t) => Number(/^[^:]+:(\d+): /u.exec(t)?.[1] ?? 0))).toEqual(red);
  });
});

describe('strażnik wiedzy o Claude Code: repo', () => {
  const pliki = plikiRepo(REPO, inExportView);
  const raport = sprawdz(pliki, { konteksty: KONTEKSTY, wyjatki: WYJATKI, frazy: true });

  it('lista plików jest pełna (kod, skrypty, docs, apka, przekaźnik, `bin/` i ten plik w zakresie)', () => {
    for (const plik of [
      'server/src/index.ts', 'scripts/check.sh', 'shared/src/protocol.ts', 'docs/README.md', SELF, 'README.md',
      'native/Rarog/README.md', 'relay/README.md', 'bin/rarog.mjs',
    ]) {
      expect(pliki.has(plik), plik).toBe(true);
    }
    expect(pliki.has('.github/workflows/check.yml')).toBe(false);
    expect(pliki.size).toBeGreaterThan(1000);
  });

  it('każde trafienie przechodzi kontekstem albo wyjątkiem', () => {
    expect(raport.bezDrogi, 'Trafienia spoza KONTEKSTY i WYJATKI. Wiedza o Claude Code z jego kodu nie '
      + 'wchodzi do repo (fakt z dokumentacji albo z obserwacji, docs/distribution.md); słowo przy innym programie: '
      + `fraza w KONTEKSTY albo wyjątek z powodem i całą linią:\n${raport.bezDrogi.join('\n')}`).toEqual([]);
  });

  it('żaden wpis nie jest martwy ani nie ma złej liczności, żadna linia nie jest objęta dwoma wpisami', () => {
    expect(raport.nieaktualne, `Wpisy do usunięcia z listy:\n${raport.nieaktualne.join('\n')}`).toEqual([]);
    expect(raport.licznosc, `Wpisy z inną liczbą linii niż \`ile\`:\n${raport.licznosc.join('\n')}`).toEqual([]);
    expect(raport.niejednoznaczne, `Linie objęte kilkoma wpisami:\n${raport.niejednoznaczne.join('\n')}`).toEqual([]);
  });

  // Napis dopisany na końcu pliku kodu wychodzi tylko wtedy, gdy skaner napisów (`scan`) nie zjadł reszty pliku.
  // Skaner jest wolny na dużych plikach testów (ok. 6 s na całe repo), stąd dłuższy limit czasu.
  it('mutacja na każdym pliku: angielskie zdanie o binarce CLI w napisie, w linii `.md`, skryptu i Pythona, '
    + 'polskie w każdym pliku, daje trafienie w dopisanej linii', () => {
    const angielskie: Record<string, string> = {
      ts: "const proba = 'read from the CLI binary';", md: 'Read from the CLI binary.', sh: 'echo "the CLI binary"',
      py: "print('the CLI binary')",
    };
    const slepe: string[] = [];
    for (const [plik, tekst] of pliki) {
      // Wpis na cały plik obejmuje też dopisaną linię.
      if (CALE_PLIKI.includes(plik)) continue;
      const baza = tekst.replace(/\n?$/u, '\n');
      const ostatnia = baza.split('\n').length;
      const rodzaj = ANGIELSKI_W_NAPISACH.test(plik) ? 'ts' : ANGIELSKI_W_LINIACH.exec(plik)?.[0].slice(1);
      const proby = [`${baza}// Przykład z binarki CLI.\n`];
      if (rodzaj !== undefined) proby.push(`${baza}${angielskie[rodzaj]!}\n`);
      for (const proba of proby) {
        const wynik = sprawdz(new Map([[plik, proba]]), { konteksty: KONTEKSTY, wyjatki: WYJATKI });
        const widac = wynik.bezDrogi.some((t) => t.startsWith(`${plik}:${String(ostatnia)}: `));
        if (!widac) slepe.push(`${plik}: ${proba.slice(baza.length).trim()}`);
      }
    }
    expect(slepe).toEqual([]);
  }, 60_000);

  it('każdy kontekst przepuszcza choć jedno trafienie poza strażnikiem', () => {
    expect(KONTEKSTY.map((k) => k.nazwa).filter((nazwa) => !raport.uzyteKonteksty.has(nazwa))).toEqual([]);
  });

  it('wpisy na cały plik: zamknięta lista (strażnik i mechanizm)', () => {
    const cale = WYJATKI.filter((wpis) => wpis.linia === undefined).map((wpis) => wpis.plik);
    expect(cale.sort()).toEqual([...CALE_PLIKI].sort());
  });
});
