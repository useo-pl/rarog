/*
 * Strażnik zgodności docs ↔ kod.
 *
 * `docs/architecture.md` declares in its header that it describes the REAL state. Drift in such a document is worse
 * than no documentation: it sounds credible and leads the implementer straight onto a mine (code "fixed" to match
 * a stale description brings back a false context alarm; a herdr call the document promises but the allow-list
 * lacks ends with `HerdrMethodNotAllowedError`).
 *
 * Dlatego asercje NIE porównują docs z docs, tylko wyprowadzają fakty Z KODU (allow-lista metod,
 * stałe bramek, nazwy plików stanu, wariant `source` limitu okna) i pytają, czy dokument je niesie.
 * Nowa metoda w `ALLOWED_METHODS` albo nowy plik w `RAROG_DATA_DIR` ma tu przewrócić test, a nie
 * przejść niezauważony do najbliższego audytu.
 *
 * Dokumenty publiczne są po angielsku, więc kotwice
 * i przeczenia nad nimi mają jedno, angielskie brzmienie. Polskiego wariantu przeczenia tu nie ma, bo polskie zdanie
 * w dokumencie publicznym przewraca wcześniej `polski-tekst-zapadka.test.ts`. Asercje nad dokumentami prywatnymi
 * stoją w `prywatne/docs-zgodnosc.test.ts`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoFiles } from './source-scan.ts';
import { HERDR_AUDIT_FILENAME } from '../src/herdr/audit.ts';
import { HERDR_HIDDEN_FILENAME } from '../src/herdr/identity.ts';
import { CLIENT_LOG_FILENAME } from '../src/client-log.ts';
import { APNS_DEVICES_FILENAME } from '../src/notify/apns-devices.ts';
import { ADMIN_RUN_DIRNAME, ADMIN_SOCKET_FILENAME, DEVICES_FILENAME } from '../src/auth/index.ts';
import { CONSENT_SOCKET_FILENAME } from '../src/herdr/dialogs/layer1/contract.ts';
import {
  HOOK_GUARD_LOG_FILENAME, HOOK_ROOTS_FILENAME, HOOK_SEEN_FILENAME,
} from '../src/herdr/hook-config.ts';
import { HOOK_SHADOW_LOG_FILENAME } from '../src/herdr/dialogs/hook/contract.ts';
import { TERM_HERDR_STATE_FILENAME } from '../src/term/herdr-backend.ts';
import { NOTES_DIRNAME } from '../src/notes/store.ts';
import { SEND_REGISTRY_FILENAME } from '../src/sessions/send-registry.ts';
import { VERSIONS_SEEN_FILENAME } from '../src/version-watch.ts';
import { WEEKLY_LIMIT_ALERTS_FILENAME } from '../src/notify/weekly-limit.ts';
import { CONSENT_CANARY_PUSHED_FILENAME } from '../src/notify/consent-canary-push.ts';
import { PROMPT_QUEUE_FILENAME } from '../src/drivers/herdr/prompt-queue-store.ts';
import { INBOX_FILENAME } from '../src/inbox/index.ts';
import { SERVER_ENV } from '../src/config-env.ts';
import { USAGE } from '../src/cli/main.ts';
import { inExportView } from './private-guard.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const architektura = read('docs/architecture.md');

/** Sekcja od nagłówka `## X` do następnego `## `. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}`);
  expect(start, `zniknęła sekcja „${heading}”`).toBeGreaterThan(-1);
  const rest = markdown.slice(start + 3);
  const end = rest.indexOf('\n## ');
  return rest.slice(0, end === -1 ? undefined : end);
}

/** Zdanie „dokładnie trzy rzeczy” o trwałym stanie przeczy punktowi 1 rozdziału „Data model”. */
const DOKLADNIE_TRZY = /exactly three/i;
/** Zdanie o pustej liście `allowBuilds`; klasa znaków przepuszcza kropkę (nazwa pliku w zdaniu). */
const PUSTA_LISTA = /`allowBuilds`[^\n]*is\s+empty/i;
/** Wycięta zależność opisana jako obecna w manifeście. */
const ZOSTALA_W_MANIFESCIE =
  /(?:remained|remains|stayed|stays|is still|was left) in `package\.json`|(?:sits|lives) in `server\/package\.json`/i;

/**
 * Zdania, które przeczą terminalowi PTY, każde z przykładem, który łapie. Polskie brzmienia z kierunkowych
 * dokumentów prywatnych sprawdza `prywatne/docs-zgodnosc.test.ts`.
 */
const CONTRADICTIONS: readonly (readonly [RegExp, string])[] = [
  [/(?:does not|doesn't|will not|won't) become a terminal/i, 'Rarog does not become a terminal.'],
  [/there is no terminal|has no terminal/i, 'The app has no terminal.'],
  [/not there (?:yet|today)/i, 'A shell in the project directory is not there yet.'],
  [/terminal is a mirror/i, 'The terminal is a mirror of the herdr pane.'],
  [/live mirror/i, 'The app shows the pane through a live mirror.'],
  [/terminal emulator/i, 'The app ships a terminal emulator.'],
  [/terminal is planned/i, 'A terminal is planned.'],
  [/xterm` \(mirror\)/, 'The client draws the pane with `xterm` (mirror).'],
];

/**
 * Nazwy, których dokument nie wymienia jako całego słowa. Granica słowa obejmuje `_` i cyfry, więc `RAROG_TERM_MAX`
 * nie liczy się jako wystąpienie `RAROG_TERM`, a `RAROG_PUSH_E2E` jako wystąpienie `RAROG_PUSH`.
 */
function missingNames(markdown: string, names: readonly string[]): string[] {
  return names.filter((name) => !new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(markdown));
}

describe('kotwice i przeczenia: mechanizm (dane syntetyczne)', () => {
  it('brakująca nazwa zmiennej: dłuższa nazwa z tym samym początkiem jej nie zastępuje', () => {
    const doc = '- `RAROG_TERM_MAX` (default 4) and `RAROG_PUSH=1`; `HOME` passes.';
    expect(missingNames(doc, ['RAROG_TERM', 'RAROG_TERM_MAX', 'RAROG_PUSH', 'HOME', 'RAROG_YOLO_ROOTS']))
      .toEqual(['RAROG_TERM', 'RAROG_YOLO_ROOTS']);
  });


  it('sekcja: od nagłówka do następnego `## `; brak nagłówka to błąd', () => {
    const en = '# A\n## Configuration (x)\n`a.ts`\n## Next\nb\n';
    expect(section(en, 'Configuration')).toBe('Configuration (x)\n`a.ts`');
    expect(() => section('# A\n## Other\n', 'Configuration')).toThrow();
  });

  it('przeczenia łapią zakazane zdanie i przepuszczają poprawne', () => {
    const przypadki: readonly [RegExp, string, string][] = [
      [DOKLADNIE_TRZY, 'The server leaves exactly three things on disk.', 'The server leaves these files on disk:'],
      [PUSTA_LISTA, '`allowBuilds` in `pnpm-workspace.yaml` is empty —',
        '`allowBuilds` in `pnpm-workspace.yaml` lists refusals only (`esbuild: false`).'],
      [ZOSTALA_W_MANIFESCIE, 'The SDK stayed in `package.json` as an import.',
        'The SDK is a direct dependency of `server/package.json`.'],
    ];
    for (const [zakaz, zakazane, poprawne] of przypadki) {
      expect(zakazane).toMatch(zakaz);
      expect(poprawne).not.toMatch(zakaz);
    }
    for (const [zakaz, zdanie] of CONTRADICTIONS) expect(zdanie, String(zakaz)).toMatch(zakaz);
    const poprawne = 'open an emergency console: a full shell in the project directory, in a herdr pane of its own';
    expect(CONTRADICTIONS.filter(([zakaz]) => zakaz.test(poprawne)).map(String)).toEqual([]);
  });
});

describe('docs ↔ kod: terminal PTY ISTNIEJE, więc dokumenty kierunkowe nie mogą go negować', () => {
  /*
   * Zdania, które przeczą terminalowi: „Rarog NIE staje się terminalem",
   * xterm/pty jako antywymaganie, „terminalu DZIŚ NIE MA", a `README.md` — „terminal jest LUSTREM
   * panelu herdr". Fakt bierze się
   * z KODU: dopóki moduł terminala i jego killswitch są w drzewie, README nie niesie żadnego z tych
   * zdań, także jako historii: dokument publiczny opisuje stan bieżący, bez historii zmian i bez etykiet decyzji.
   * Powrót któregokolwiek z nich przewraca ten test, nie dokument. Zdania stoją w `CONTRADICTIONS` na górze pliku.
   */
  const termExists = existsSync(path.join(repoRoot, 'server/src/term/registry.ts'))
    && /RAROG_TERM\b/.test(read('server/src/config-env.ts'));

  const DOCS = ['README.md'] as const;

  it.each(DOCS)('%s: nie przeczy terminalowi PTY, także jako wzmianka o zmianie (dokument publiczny bez historii)', (doc) => {
    expect(termExists, 'terminal PTY zniknął z kodu — to już inny test, nie ten').toBe(true);
    const text = read(doc);
    const hits = CONTRADICTIONS.filter(([re]) => re.test(text)).map(([re]) => String(re));
    expect(hits, `${doc}: zdanie przeczy terminalowi PTY, który działa`).toEqual([]);
  });

  it.each(DOCS)('%s: opisuje terminal PTY jako konsolę awaryjną z własnym killswitchem', (doc) => {
    const text = read(doc);
    expect(text, `${doc} nie zna killswitcha RAROG_TERM`).toContain('RAROG_TERM');
    expect(text, `${doc} nie mówi, że terminal jest konsolą awaryjną`).toMatch(/emergency console/i);
  });
});

describe('docs ↔ kod: Web Push wypadł z Raroga, a rejestr decyzji to odnotował', () => {
  it('konfiguracja serwera nie zna kluczy VAPID', () => {
    // Config i rejestr zmiennych nie znają już tych nazw — gdyby znały, lista `env -i` byłaby jedyną bramką.
    for (const file of ['server/src/config.ts', 'server/src/config-env.ts']) {
      expect(read(file)).not.toContain('RAROG_VAPID');
    }
  });
});

describe('docs ↔ kod: architektura opisuje faktyczne środowisko i faktyczny dysk', () => {
  it('sekcja „Configuration" wymienia każdy moduł czytający `process.env`', () => {
    // Zbiór czytelników bierzemy ze skanu drzewa, nie z listy w teście: nowy moduł sięgający
    // po `process.env` ma tu przewrócić dokument, a nie doczekać następnego audytu.
    const readers = new Set<string>();
    const walk = (dir: string): void => {
      for (const item of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
        const rel = `${dir}/${item.name}`;
        if (item.isDirectory()) walk(rel);
        else if (item.name.endsWith('.ts') && /process\.env/.test(read(rel))) readers.add(item.name);
      }
    };
    walk('server/src');
    expect(readers, 'config.ts przestał czytać env — to już inny dokument').toContain('config.ts');

    const konfiguracja = section(architektura, 'Configuration');
    for (const file of readers) {
      if (file === 'config.ts') continue;
      expect(konfiguracja, `dokument deklaruje wyłączność \`config.ts\`, a \`${file}\` też czyta env`)
        .toContain(file);
    }
    // Druga strona tej samej równości: dokument nie może wymieniać wyjątku, który już nim nie jest.
    for (const mentioned of konfiguracja.matchAll(/`([a-z-]+\.ts)`/g)) {
      expect(readers, `sekcja wymienia \`${mentioned[1]}\`, a ten moduł nie czyta już \`process.env\``)
        .toContain(mentioned[1]);
    }
  });

  it('punkt „Persistent state on disk" wymienia wszystko, co serwer tam zostawia', () => {
    const start = architektura.indexOf('5. **Persistent state on disk**');
    expect(start, 'zniknął punkt 5 „Data model”').toBeGreaterThan(-1);
    const punkt = architektura.slice(start, architektura.indexOf('\n6. **', start));

    // Nazwy plików biorą się ze stałych modułów, a nie z pamięci — zmiana stałej wywraca test.
    for (const file of [
      HERDR_HIDDEN_FILENAME, HERDR_AUDIT_FILENAME, CLIENT_LOG_FILENAME,
      // Bridge hooków trzyma w `dataDir` dwa trwałe pliki — dokument wymieniający
      // je gołymi literałami przepuszczałby rename stałej na zielono, a lista runbookowa
      // cicho przestawałaby być pełna.
      HOOK_ROOTS_FILENAME, HOOK_SEEN_FILENAME,
      // Dziennik odmów strażnika wysokości dialogu — pisze go hook.
      HOOK_GUARD_LOG_FILENAME,
      // Dziennik cyklu trybu cienia — też pisze go hook, przy każdej zgodzie na narzędzie.
      HOOK_SHADOW_LOG_FILENAME,
      // Backend panelowy terminala dokłada jedyny plik stanu terminala.
      TERM_HERDR_STATE_FILENAME,
      // Notatki projektu — pierwsza TRWAŁA treść pisana ręką użytkownika
      // i jedyna BEZ retencji, więc runbook „co skasować" bez tego katalogu jest niepełny.
      `${NOTES_DIRNAME}/`,
      // Rejestr idempotentnych wysyłek — identyfikatory i skróty, bez treści.
      SEND_REGISTRY_FILENAME,
      // Rejestr tokenów APNs apki natywnej — adresy do wysyłki banerów; runbook
      // „utrata telefonu" kasuje go.
      APNS_DEVICES_FILENAME,
      // Klucze urządzeń z parowania — poświadczenia, z kopią `.bak`, i gniazdo
      // administracyjne `rarog pair`/`rarog devices`; runbook „zgubiony telefon” odpina z gniazda.
      DEVICES_FILENAME, `${DEVICES_FILENAME}.bak`, `${ADMIN_RUN_DIRNAME}/${ADMIN_SOCKET_FILENAME}`,
      // Gniazdo rejestracji kanału zgód (warstwa 1) obok administracyjnego — tylko w trybie kanału, który
      // wymaga rejestracji hooka; sekrety hooka żyją w pamięci, więc trwałego pliku poza gniazdem nie ma.
      `${ADMIN_RUN_DIRNAME}/${CONSENT_SOCKET_FILENAME}`,
      // Ostatnie widziane wersje Claude Code i herdr (sygnał nowej wersji, `docs/architecture.md`, „New version of
      // Claude Code or herdr”) — same numery wersji, bez treści sesji.
      VERSIONS_SEEN_FILENAME,
      // Weekly windows with a delivered weekly-limit push (`docs/architecture.md`, "Weekly plan limit") —
      // reset instants only.
      WEEKLY_LIMIT_ALERTS_FILENAME,
      // Releases with a pushed consent canary result (`docs/architecture.md`, "New version of Claude Code or herdr") —
      // release numbers and results only.
      CONSENT_CANARY_PUSHED_FILENAME,
      // Kolejka wklejeń z treścią wiadomości do pierwszego wklejenia.
      PROMPT_QUEUE_FILENAME,
      // Removed Inbox cards: session ids and opaque turn keys, no content.
      INBOX_FILENAME,
    ]) {
      expect(punkt, `brak \`${file}\` na liście trwałego stanu`).toContain(file);
    }
    // Rejestr subskrypcji Web Push wypadł z serwera razem z PWA — serwer go już nie pisze.
    expect(punkt, 'lista wymienia `push-subscriptions.json`, którego serwer nie pisze')
      .not.toContain('push-subscriptions.json');
    // Rotacja: oba dzienniki jadą do `.log.1`, więc na dysku bywa jeszcze jedna generacja.
    expect(read('server/src/herdr/audit.ts')).toContain('`${file}.1`');
    expect(read('server/src/client-log.ts')).toContain('`${file}.1`');
    expect(punkt, 'lista pomija starszą generację dziennika (rotacja `.1`)').toMatch(/\[\.1\]|\.log\.1/);
    // Sierota po rejestrze sesji i log serwera z `rarog restart` leżą w tym samym katalogu.
    expect(read('server/src/sessions/manager.ts')).toContain('sessions.json.bak');
    expect(punkt, 'lista pomija `sessions.json.bak`').toContain('sessions.json.bak');
    expect(read('server/src/cli/restart.ts')).toContain("RAROG_LOG: path.join(checked.dataDir, 'server.log')");
    expect(punkt, 'lista pomija domyślny log serwera').toContain('server.log');
    // Katalog zrzutów hooka: pełny `tool_input` (komenda, treść pliku, cały plan) na dysku,
    // 0600/0700 — runbook „co skasować" bez niego jest niepełny.
    expect(read('server/src/herdr/dialogs/hook/contract.ts')).toContain("HOOK_PENDING_DIRNAME = 'pending'");
    expect(read('server/src/herdr/dialogs/hook/dump.ts')).toContain('join(dataDir, HOOK_PENDING_DIRNAME');
    expect(punkt, 'lista pomija katalog `pending/` ze zrzutami hooka').toContain('pending/');
    expect(punkt, 'zdanie „dokładnie trzy rzeczy" przeczy punktowi 1 tego samego rozdziału')
      .not.toMatch(DOKLADNIE_TRZY);
  });
});

describe('łańcuch dostaw: zależności są WYBRANE, nie doklejone', () => {
  const manifest = JSON.parse(read('server/package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('lista zależności serwera jest zamknięta i każda pozycja ma powód', () => {
    /*
     * Lista jest ZAMKNIĘTA i każda pozycja musi mieć powód zapisany tutaj — inaczej za pół
     * roku nikt nie odróżni zależności wybranej od zależności doklejonej.
     *
     * - `zod` — walidacja kontraktu protokołu (od początku),
     * - `ws` — transport of PTY terminal frames. herdr creates the pseudoterminal and the shell lives in a herdr
     *   pane, so Rarog has no `node-pty`; without `ws` there is nothing to stream frames to the PWA with. Version
     *   ≥ 7 days from publication (repo rule).
     * - `@anthropic-ai/claude-agent-sdk` — kept on purpose despite its weight (107 packages, 334 MB) for one reader:
     *   `listSessions()`, the official CLI session list API, used instead of an own store parser
     *   (`session-list.ts`). The version is younger than 7 days by necessity: the package ships at the CLI's pace,
     *   almost daily, so the age rule cannot be met with the newest release, and an older one is an SDK out of step
     *   with the installed CLI. The exception is the user's call, recorded mechanically: `minimumReleaseAgeExclude`
     *   in `pnpm-workspace.yaml`.
     * - `@number0/iroh` — moduł nasłuchu iroh (QUIC, `server/src/iroh/`): droga apki do serwera bez sieci prywatnej.
     *   Jedyna zależność natywna: moduł N-API z gotowej paczki platformy (`optionalDependencies`, bez skryptu
     *   instalacyjnego), przypięty dokładnie, bo rejestr faktów o wiązaniu w `server/src/iroh/adapter.ts` jest
     *   zmierzony na tej wersji. Ładuje go wyłącznie `adapter.ts` (`server/test/iroh-granice.test.ts`).
     *
     * There is no Web Push package: APNs for the native app signs the JWT and sends HTTP/2 with `node:crypto` and
     * `node:http2` alone (`notify/apns.ts`).
     */
    expect(Object.keys(manifest.dependencies ?? {}).sort())
      .toEqual(['@anthropic-ai/claude-agent-sdk', '@number0/iroh', '@rarog/shared', 'ws', 'zod']);
    expect(manifest.dependencies?.['@number0/iroh'], 'wersja iroh przypięta dokładnie').toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('zależności korzenia repo są zamknięte: CLI `rarog` i uruchamiacz serwera, serwer ich nie importuje', () => {
    /*
     * - `qrcode` (MIT) — wypisuje kod QR parowania w terminalu (`rarog pair`). Bez skryptów
     *   instalacyjnych; przechodnio ciągnie stos `yargs` własnego CLI paczki (28 paczek, żadna z `install`),
     *   którego `rarog pair` nie ładuje. CLI `rarog` mieszka w repo
     *   (`server/src/cli/`), więc paczka też. Importuje ją wyłącznie
     *   `server/src/cli/devices.ts`.
     * - `tsx` (MIT) — uruchamia serwer w czasie działania: `rarog serve` robi `execve`
     *   na `node_modules/.bin/tsx server/src/index.ts`.
     *   Stoi w `dependencies`, bo instalacja bez zależności deweloperskich nie miałaby
     *   czym wystartować serwera. Ta sama wersja, ten sam lockfile (żadnej nowej paczki); przypięta dokładnie,
     *   bo `restart.sh` rozpoznaje proces po argv, które składa tsx. `bin/rarog.mjs` rejestruje go przez
     *   `tsx/esm/api`, żeby uruchomić CLI z `server/src/cli/`; moduły serwera go nie importują.
     */
    const root = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(root.dependencies ?? {}).sort()).toEqual(['qrcode', 'tsx']);
    expect(root.dependencies?.['qrcode']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(root.dependencies?.['tsx']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(root.devDependencies ?? {}, '`tsx` w dwóch sekcjach naraz').not.toHaveProperty('tsx');
    expect(read('server/src/cli/devices.ts')).toContain("from 'qrcode'");
    expect(read('bin/rarog.mjs')).toContain("import('tsx/esm/api')");
    const serverFiles = repoFiles(repoRoot, 'server/src').filter((file) => file.endsWith('.ts'));
    for (const file of serverFiles) {
      const forbidden = file === 'server/src/cli/devices.ts' ? /from 'tsx/ : /from '(?:qrcode|tsx)/;
      expect(read(file), file).not.toMatch(forbidden);
    }
  });

  it('docs podają aktualną liczbę zależności bezpośrednich backendu', () => {
    const count = Object.keys(manifest.dependencies ?? {}).length;
    expect(read('docs/security-model.md')).toContain(`backend ${String(count)} direct deps`);
  });

  it('wersja SDK jest PRZYPIĘTA — aktualizacja ma być decyzją, nie skutkiem ubocznym', () => {
    // 0.x: semver pozwala łamać API w wydaniach minor, a to jest cudze API czytane co żądanie.
    expect(manifest.dependencies?.['@anthropic-ai/claude-agent-sdk']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('instalacja SDK jest CIENKA — warunek powrotu zależności, nie optymalizacja', () => {
    /*
     * Bez tych dwóch ustawień `pnpm install` odtwarza dokładnie stan, który wyciął audyt:
     * natywne binarki CLI (~250 MB) plus peer-depsy z całym stosem HTTP (express, hono, ajv)
     * w projekcie stojącym na gołym `node:http`. Zmierzone: z nimi 278 MB, bez nich 4,6 MB
     * i jeden pakiet — a `listSessions()` działa tak samo, bo czyta pliki.
     */
    const workspace = read('pnpm-workspace.yaml');
    expect(workspace, 'brak `ignoredOptionalDependencies` — wrócą binarki platformowe')
      .toMatch(/ignoredOptionalDependencies:[\s\S]*claude-agent-sdk-\*/);
    expect(workspace, 'brak `autoInstallPeers: false` — wróci stos HTTP jako peer-depsy')
      .toMatch(/autoInstallPeers:\s*false/);
  });

  /*
   * `allowBuilds` jest listą ODMÓW, nie zgód. `.npmrc` niesie
   * `ignore-scripts=true`, więc każdy wpis `true` byłby wyłomem w regule „żadna paczka nie
   * uruchamia skryptu instalacyjnego". Placeholder `node-pty: set this to true or false`
   * przeżył w tym pliku wycięcie backendu tmux i czytał się jak niedokończona decyzja
   * o paczce, której w repo nie ma. Docs sprawdzamy razem z plikiem, bo lista przestała być
   * PUSTA (`esbuild: false`) i zdanie o pustce byłoby dziś nieprawdą.
   */
  it('`allowBuilds` nie daje zgody żadnej paczce, a docs nie mówią o pustej liście', () => {
    const workspace = read('pnpm-workspace.yaml');
    expect(workspace, 'placeholder pnpm został w `allowBuilds`')
      .not.toContain('set this to true or false');
    const blok = /^allowBuilds:\n((?:[ \t]+\S.*\n?)*)/m.exec(workspace)?.[1] ?? '';
    expect(blok.trim(), 'nie widzę bloku `allowBuilds` w `pnpm-workspace.yaml`').not.toBe('');
    for (const linia of blok.split('\n').filter((l) => l.trim() !== '')) {
      expect(linia, `zgoda na skrypt instalacyjny: ${linia}`).toMatch(/:\s*false\s*$/);
    }
    /*
     * Klasa znaków MUSI przepuszczać kropkę: skreślone zdanie brzmiało „`allowBuilds`
     * w `pnpm-workspace.yaml` jest PUSTE", a `[^.\n]*` rozbijało się o kropkę w nazwie pliku —
     * asercja przechodziła też PRZED naprawą, czyli nie pilnowała niczego.
     */
    // Wzorzec `PUSTA_LISTA` sprawdza na zakazanym zdaniu test mechanizmu na górze pliku.
    for (const doc of ['docs/security-model.md']) {
      expect(read(doc), `${doc} twierdzi, że \`allowBuilds\` jest puste`).not.toMatch(PUSTA_LISTA);
    }
  });

  it('docs nie twierdzą już, że zależność „została w package.json"', () => {
    for (const doc of ['docs/architecture.md', 'docs/security-model.md']) {
      expect(read(doc), `${doc} opisuje wyciętą zależność jako obecną`).not.toMatch(ZOSTALA_W_MANIFESCIE);
    }
  });
});

describe('rejestr decyzji: identyfikator jest KLUCZEM, więc musi być jeden', () => {
  it('indeks docs nie podaje ZAKRESU numerów, który dezaktualizuje się przy każdej decyzji', () => {
    /*
     * `docs/README.md` jest punktem wejścia do dokumentacji, więc agent dokładający
     * decyzję czyta go pierwszy. Zakres numerów starzeje się przy KAŻDYM nowym wpisie
     * i nikt tego nie zauważa — a wtedy pierwszy „wolny" numer jest już zajęty i powstaje
     * dubel identyfikatora. Bramka pilnuje dokumentów, które
     * przedstawiają rejestr JAKO CAŁOŚĆ, bo tylko one obiecują „to jest wszystko".
     */
    for (const doc of ['docs/README.md', 'README.md']) {
      expect(read(doc), `${doc} podaje zakres numerów decyzji — opisz rejestr bez liczby granicznej`)
        .not.toMatch(/D\d+[–-]D\d+/);
    }
  });
});

describe('docs ↔ kod: każda zmienna z rejestru serwera stoi w `docs/server-config.md`', () => {
  /*
   * Rejestr `server/src/config-env.ts` jest jedyną listą nazw, które serwer czyta, a `docs/server-config.md` obiecuje
   * w nagłówku, że nowa zmienna albo flaga idzie do niego. Nazwy bez słowa w dokumencie nie widać: kto jej szuka
   * w chwili zmiany konfiguracji, nie wie, że istnieje. Lista bierze się z rejestru, więc nowa nazwa bez opisu
   * przewraca ten test.
   */
  it('dokument wymienia każdą nazwę z `SERVER_ENV`', () => {
    const names = Object.keys(SERVER_ENV);
    expect(names, 'rejestr zmiennych jest pusty — to już inny test').toContain('RAROG_PORT');
    expect(missingNames(read('docs/server-config.md'), names), 'nazwy z rejestru bez opisu w docs/server-config.md')
      .toEqual([]);
  });
});

describe('docs ↔ kod: wiersz Codexa ISTNIEJE, więc dokumenty znają jego flagę', () => {
  /*
   * Fakt bierze się z KODU: dopóki rejestr `config-env.ts` zna `RAROG_CODEX_STATUS`, a filtr wejściowy herdr
   * wpuszcza `agent === 'codex'`, dokumenty MUSZĄ tę flagę wymieniać. Powód jest praktyczny i ten
   * sam, co przy `RAROG_TERM`: flaga, której nie ma w tabeli konfiguracji ani w rozdziale
   * o killswitchach, jest flagą, której nikt nie znajdzie w chwili, gdy trzeba ją przestawić —
   * a plik konfiguracji niczego nie tłumaczy, tylko podaje wartość. Wyjęcie flagi z kodu przewraca ten
   * test, a nie dokument.
   */
  const config = read('server/src/config.ts');
  const codexEnv = /CODEX_STATUS_ENV = '([A-Z_]+)'/.exec(read('server/src/config-env.ts'))?.[1];
  // Rozdział o flagach serwera: `docs/server-config.md`.
  const DOCS = [
    'docs/architecture.md', 'docs/security-model.md',
    'docs/server-config.md',
  ] as const;

  it('kod naprawdę zna flagę i naprawdę wpuszcza Codexa', () => {
    expect(codexEnv, 'zniknął `CODEX_STATUS_ENV` — to już inny test, nie ten')
      .toBe('RAROG_CODEX_STATUS');
    expect(config, 'config przestał wystawiać `codexStatusEnabled`').toContain('codexStatusEnabled');
    expect(read('server/src/herdr/client.ts'), 'filtr wejściowy przestał znać Codexa')
      .toMatch(/agent === 'codex'/);
  });

  it.each(DOCS)('%s wymienia `RAROG_CODEX_STATUS`', (doc) => {
    expect(read(doc), `${doc} nie zna flagi wiersza Codexa`).toContain(codexEnv as string);
  });

  it('runbook liczy pięć killswitchy, a flaga wiersza Codexa NIE jest szóstym', () => {
    // Liczba killswitchy jest twardym faktem runbooka — wiersz Codexa jej nie zmienia.
    const bezpieczenstwo = read('docs/security-model.md');
    expect(bezpieczenstwo, 'runbook nie podaje liczby killswitchy').toMatch(/\bFIVE killswitches\b/);
    expect(bezpieczenstwo, 'bezpieczeństwo nie tłumaczy, czemu wiersz Codexa to nie killswitch')
      .toMatch(/`RAROG_CODEX_STATUS=0`[^\n]*is NOT a sixth killswitch/);
  });
});

/*
 * Public documents give `rarog` commands. A reader with the npm package has `rarog` on `PATH` and no repo, so
 * `pnpm run restart`, `pnpm run hooks:…`, `pnpm rarog …` and `node bin/rarog.mjs …` do not run there. Clone forms
 * stay only where the text says it is clone work: all of `CONTRIBUTING.md`, a section whose heading names a clone or
 * a checkout (with its subsections), and a paragraph, list item or code line that itself says "in a clone" (or "in
 * the clone", "from a checkout"…). README states the rule once: in a clone `rarog <command>` runs as
 * `node bin/rarog.mjs <command>`.
 */
const CLONE_COMMAND = /pnpm run restart\b|pnpm run hooks:|pnpm rarog\b|node bin\/rarog\.mjs\b/;
const CLONE_MARK = /\b(?:in|from) (?:a|the) (?:repo )?(?:clone|checkout)\b/i;
const CLONE_HEADING = /\b(?:clone|checkout)\b/i;
const CLONE_FILES: ReadonlySet<string> = new Set(['CONTRIBUTING.md']);

interface DocUnit {
  readonly line: number;
  readonly text: string;
  readonly clone: boolean;
}

/**
 * A markdown file cut into units that can carry the clone mark: a paragraph, a list item, a heading, or one line of
 * a fenced code block. A unit inside a section whose heading names a clone or a checkout counts as clone work.
 */
function docUnits(markdown: string): DocUnit[] {
  const units: DocUnit[] = [];
  let open: { line: number; lines: string[]; section: boolean } | null = null;
  let fence = false;
  let cloneLevel: number | null = null;
  const close = (): void => {
    if (open === null) return;
    const text = open.lines.join('\n');
    units.push({ line: open.line, text, clone: open.section || CLONE_MARK.test(text) });
    open = null;
  };
  for (const [i, line] of markdown.split('\n').entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      close();
      fence = !fence;
      continue;
    }
    const section = cloneLevel !== null;
    if (fence) {
      units.push({ line: i + 1, text: line, clone: section || CLONE_MARK.test(line) });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      close();
      const level = heading[1]!.length;
      if (cloneLevel !== null && level <= cloneLevel) cloneLevel = null;
      if (cloneLevel === null && CLONE_HEADING.test(heading[2]!)) cloneLevel = level;
      units.push({ line: i + 1, text: line, clone: cloneLevel !== null });
      continue;
    }
    if (line.trim() === '') {
      close();
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) close();
    if (open === null) open = { line: i + 1, lines: [], section };
    open.lines.push(line);
  }
  close();
  return units;
}

/** Clone commands outside clone work, as `line: text` of the first line of the unit that has one. */
function cloneCommandsOutsideClone(markdown: string): string[] {
  return docUnits(markdown).filter((unit) => !unit.clone && CLONE_COMMAND.test(unit.text)).map((unit) => {
    const lines = unit.text.split('\n');
    const at = lines.findIndex((l) => CLONE_COMMAND.test(l));
    return `${unit.line + at}: ${lines[at]!.trim()}`;
  });
}

/** `rarog` commands from `USAGE`: the command name and the subcommand words of its usage lines. */
function usageCommands(usage: string): Map<string, Set<string>> {
  const commands = new Map<string, Set<string>>();
  for (const match of usage.matchAll(/^ {2}rarog (\S+)(.*)$/gm)) {
    const words = commands.get(match[1]!) ?? new Set<string>();
    for (const word of match[2]!.split(/[\s[\]|]+/)) if (/^[a-z][a-z-]*$/.test(word)) words.add(word);
    commands.set(match[1]!, words);
  }
  return commands;
}

/**
 * `rarog …` commands that `USAGE` does not know: inline code spans and code lines that start with `rarog `, in a
 * fenced block or in a block indented by four spaces. A
 * placeholder (`<command>`), a herdr tab name (`rarog <slot> · <directory>`) and a block format (`rarog {v: …}`) are
 * not commands.
 */
function unknownRarogCommands(markdown: string, commands: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const spans: { line: number; text: string }[] = [];
  let fence = false;
  for (const [i, line] of markdown.split('\n').entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      if (/^\s*rarog\s/.test(line)) spans.push({ line: i + 1, text: line.replace(/\s#.*$/, '').trim() });
      continue;
    }
    if (/^(?: {4,}|\t)rarog\s/.test(line)) {
      spans.push({ line: i + 1, text: line.replace(/\s#.*$/, '').trim() });
      continue;
    }
    for (const match of line.matchAll(/`(rarog\s[^`]*)`/g)) spans.push({ line: i + 1, text: match[1]! });
  }
  const bad: string[] = [];
  for (const span of spans) {
    if (span.text.includes('·')) continue;
    const [, first = '', second = ''] = span.text.split(/\s+/);
    if (/^[<{]/.test(first)) continue;
    for (const name of first.replace(/:$/, '').split('|')) {
      if (name === 'help' || name === '--help') continue;
      const words = commands.get(name);
      const subs = /^[a-z][a-z|-]*:?$/.test(second) && words !== undefined && words.size > 0
        ? second.replace(/:$/, '').split('|').filter((sub) => !words.has(sub))
        : [];
      if (words === undefined || subs.length > 0) bad.push(`${span.line}: ${span.text}`);
    }
  }
  return bad;
}

describe('public documents give `rarog` commands, clone forms only in clone work', () => {
  const publicDocs = repoFiles(repoRoot)
    .filter((file) => file.endsWith('.md') && inExportView(file) && !file.includes('/fixtures/'));
  const commands = usageCommands(USAGE);

  it('mechanism: clone commands outside clone work, with the clone mark, under a clone heading', () => {
    const doc = [
      '## Start',
      '',
      'Run `pnpm run restart`.',
      '- `pnpm run hooks:install` writes the copy.',
      '- `rarog hooks install` writes the copy.',
      '',
      'In a clone, run `node bin/rarog.mjs pair` from the repository directory.',
      '',
      'In a checkout:',
      '',
      '```bash',
      'node bin/rarog.mjs setup',
      'node bin/rarog.mjs service uninstall   # in the clone: service removed',
      'pnpm rarog devices',
      '```',
      '',
      '### Clone next to the package',
      '',
      '`pnpm run restart` from the clone refuses.',
      '',
      '#### Details',
      '',
      '`node bin/rarog.mjs service install` switches the service.',
      '',
      '## After',
      '',
      'Then `pnpm run restart`.',
    ].join('\n');
    expect(cloneCommandsOutsideClone(doc)).toEqual([
      '3: Run `pnpm run restart`.',
      '4: - `pnpm run hooks:install` writes the copy.',
      '12: node bin/rarog.mjs setup',
      '14: pnpm rarog devices',
      '27: Then `pnpm run restart`.',
    ]);
  });

  it('mechanism: a `rarog` command exists in `USAGE`, with its subcommand', () => {
    const usage = '  rarog hooks [print|install] [--local]\n  rarog restart\n  rarog devices revoke <deviceId>\n';
    const doc = [
      '`rarog hooks install`, `rarog hooks print|install`, `rarog restart`, `rarog restart: Nothing was stopped.`',
      '`rarog hooks uninstall`, `rarog reboot`, `rarog devices revoke`, `rarog devices list`',
      '`rarog <command>`, `rarog <slot> · <directory>`, `rarog {v: 3}`, `rarog help`, `rarog --help`',
      '```',
      'rarog restart                # restart',
      'rarog restarts',
      '```',
      '',
      '    rarog hooks install               # an indented code block',
      '    rarog hooks uninstall             # an unknown subcommand in one',
    ].join('\n');
    expect(unknownRarogCommands(doc, usageCommands(usage))).toEqual([
      '2: rarog hooks uninstall', '2: rarog reboot', '2: rarog devices list', '6: rarog restarts',
      '10: rarog hooks uninstall',
    ]);
  });

  it('the scope is the public documents', () => {
    expect(publicDocs).toEqual(expect.arrayContaining([
      'README.md', 'CONTRIBUTING.md', 'docs/distribution.md', 'docs/server-config.md', 'docs/security-model.md',
      'docs/dialogs.md', 'docs/architecture.md',
    ]));
    expect([...commands.keys()]).toEqual(expect.arrayContaining(['pair', 'devices', 'hooks', 'restart', 'service']));
  });

  it('no public document gives a clone command outside clone work', () => {
    const hits = publicDocs.filter((file) => !CLONE_FILES.has(file))
      .flatMap((file) => cloneCommandsOutsideClone(read(file)).map((hit) => `${file}:${hit}`));
    expect(hits, 'A public document gives a command that runs only in a repo clone. Write the `rarog <command>` form '
      + 'from `rarog help` (`USAGE` in `server/src/cli/main.ts`); keep the clone form only in clone work: a section '
      + 'whose heading names a clone, or a paragraph that says "In a clone, …".').toEqual([]);
  });

  it('every `rarog` command in a public document exists in `USAGE`', () => {
    const hits = publicDocs
      .flatMap((file) => unknownRarogCommands(read(file), commands).map((hit) => `${file}:${hit}`));
    expect(hits, 'A public document names a `rarog` command or subcommand that `rarog help` does not list '
      + '(`USAGE` in `server/src/cli/main.ts`).').toEqual([]);
  });
});
