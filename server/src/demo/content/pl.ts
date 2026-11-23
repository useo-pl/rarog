/**
 * Zestaw treści demo po polsku: seedy, „Wznów istniejącą”, diff, ostatni commit, notatka i odpowiedzi
 * atrapy silnika. Kontrakt i podział na treść i strukturę: `types.ts`.
 *
 * Teksty udają rozmowę człowieka z agentem; ścieżki są fikcyjne (`/Users/demo/Projects/...`).
 */
import type { DemoSeed } from '../seeds.ts';
import type { DemoContent, DemoProjectKey, DemoSeedKit } from './types.ts';

const MIN = 60_000;

/** Nazwy projektów demo według roli (testy UI apki szukają ich po tych nazwach). */
const PROJECTS: Readonly<Record<DemoProjectKey, string>> = {
  main: 'willow',
  stream: 'rarog',
  cleanup: 'fleet-ops',
  import: 'data-loader',
  bridge: 'pipe-link',
  panel: 'map-view',
};

/**
 * Raport z importu zapisany przez agenta `data-loader` — 50 linii, żeby karta edycji w demo
 * pokazała mini-diff z ogonem „… jeszcze N linii".
 */
const IMPORT_REPORT = [
  "import type { ImportRow } from './types.ts';",
  '',
  'export interface ImportReport {',
  '  total: number;',
  '  imported: number;',
  '  duplicates: number;',
  '  rejected: RejectedRow[];',
  '}',
  '',
  'export interface RejectedRow {',
  '  line: number;',
  '  reason: string;',
  '}',
  '',
  'export function buildReport(rows: ImportRow[], saved: Set<string>): ImportReport {',
  '  const seen = new Set<string>();',
  '  const rejected: RejectedRow[] = [];',
  '  let duplicates = 0;',
  '  rows.forEach((row, index) => {',
  "    if (row.id === '') {",
  "      rejected.push({ line: index + 2, reason: 'pusty identyfikator' });",
  '      return;',
  '    }',
  '    if (seen.has(row.id)) {',
  '      duplicates += 1;',
  '      return;',
  '    }',
  '    seen.add(row.id);',
  '  });',
  '  const imported = [...seen].filter((id) => saved.has(id)).length;',
  '  return { total: rows.length, imported, duplicates, rejected };',
  '}',
  '',
  'export function formatReport(report: ImportReport): string {',
  '  const lines = [',
  '    `Rekordów w pliku: ${report.total}`,',
  '    `Zaimportowano: ${report.imported}`,',
  '    `Duplikaty: ${report.duplicates}`,',
  '  ];',
  '  if (report.rejected.length === 0) {',
  "    lines.push('Rozbieżności: brak');",
  '  } else {',
  "    lines.push('Rozbieżności:');",
  '    for (const row of report.rejected) {',
  '      lines.push(`  linia ${row.line}: ${row.reason}`);',
  '    }',
  '  }',
  "  return lines.join('\\n');",
  '}',
  '',
].join('\n');

/** Patch diffu demo — trzy pliki: modyfikacja, nowy plik, skasowany stary moduł. */
const DIFF_PATCH = [
  'diff --git a/src/notes.ts b/src/notes.ts',
  'index 8f4c1d2..3ab97e5 100644',
  '--- a/src/notes.ts',
  '+++ b/src/notes.ts',
  '@@ -12,8 +12,12 @@ export interface Note {',
  ' export async function saveNote(note: Note): Promise<void> {',
  '-  emitter.emit("note-saved", note.id);',
  '-  await store.write(note);',
  '+  await store.write(note);',
  '+  emitter.emit("note-saved", note.id);',
  ' }',
  '',
  'diff --git a/src/notes.test.ts b/src/notes.test.ts',
  'new file mode 100644',
  'index 0000000..7c1e4b8',
  '--- /dev/null',
  '+++ b/src/notes.test.ts',
  '@@ -0,0 +1,9 @@',
  '+import { describe, expect, it } from "vitest";',
  '+import { saveNote } from "./notes.ts";',
  '+',
  '+describe("saveNote", () => {',
  '+  it("zapisuje przed rozgłoszeniem", async () => {',
  '+    await saveNote({ id: "a", text: "x" });',
  '+    expect(store.written).toEqual(["a"]);',
  '+  });',
  '+});',
  '',
  'diff --git a/src/notes-legacy.ts b/src/notes-legacy.ts',
  'deleted file mode 100644',
  'index 5b2e9c4..0000000',
  '--- a/src/notes-legacy.ts',
  '+++ /dev/null',
  '@@ -1,4 +0,0 @@',
  '-export function saveNoteLegacy(note: Note): void {',
  '-  // Zapis bez kolejki — zastąpiony przez saveNote.',
  '-  fs.writeFileSync(note.path, note.text);',
  '-}',
  '',
].join('\n');

/** Odpowiedzi tury interaktywnej — ~60 słów, markdown z fence. */
const REPLIES: readonly string[] = [
  [
    '## Plan',
    '',
    'Zaczynam od najcieńszej warstwy, żeby test złapał regresję zanim dotknę reszty:',
    '',
    '1. wydzielam czystą funkcję z handlera,',
    '2. dopisuję test na przypadek brzegowy (pusty wynik),',
    '3. dopiero potem podmieniam wywołanie w widoku.',
    '',
    'Podmiana wygląda tak:',
    '',
    '```ts',
    'export function normalize(input: string): string {',
    '  return input.trim().toLowerCase();',
    '}',
    '```',
    '',
    'Jeśli test przejdzie, zostaje tylko usunięcie starej gałęzi `if` i krótki commit.',
  ].join('\n'),
  [
    '## Co znalazłem',
    '',
    'Błąd nie jest w renderze, tylko w kolejności zapisu — stan leci do UI, zanim rejestr',
    'zdąży się zapisać. Efekt widać dopiero po restarcie, więc łatwo go przegapić.',
    '',
    '- zapis na dysk jest asynchroniczny,',
    '- broadcast idzie synchronicznie,',
    '- przy restarcie w tym oknie wpis wraca w starym stanie.',
    '',
    '```ts',
    'await store.save();',
    'broadcast(sessionChanged(summary));',
    '```',
    '',
    'Poprawka to jedna linia kolejności plus test, który wymusza zapis przed rozgłoszeniem.',
  ].join('\n'),
  [
    '## Wynik',
    '',
    'Testy przechodzą lokalnie, łącznie z tym, który wcześniej migotał. Wąskim gardłem był',
    'timer w teście, nie kod produkcyjny — po podmianie na zegar wstrzykiwany jest stabilnie.',
    '',
    '- 34 testy, 0 pominiętych,',
    '- czas: 1,8 s,',
    '- brak ostrzeżeń typów.',
    '',
    '```sh',
    'pnpm vitest run server/test',
    '```',
    '',
    'Zostawiam podsumowanie w commicie i czekam na dalsze polecenia.',
  ].join('\n'),
];

/** Fragmenty strumienia dla scenariusza „streaming" (seed „rarog"). */
const STREAM_FRAGMENTS: readonly string[] = [
  '### Przeglądam moduł sesji\n\n',
  'Manager trzyma ring buffer per sesja, ',
  'więc `Last-Event-ID` wraca dokładnie do ostatniej domkniętej wiadomości. ',
  'Delty są ulotne — nie dostają `id`, ',
  'przez co reconnect nie próbuje odtworzyć połowy zdania.\n\n',
  '- stan liczy wyłącznie serwer,\n',
  '- klient jest w pełni odtwarzalny,\n',
  '- pending decyzje żyją w RAM.\n\n',
  '```ts\nconst seq = ring.push(event);\n```\n\n',
  // Cykl się zapętla, więc OSTATNI fragment musi domknąć akapit — inaczej po zawinięciu
  // powstaje '...na mock-driverze. ### Przeglądam moduł sesji', a wtedy renderer
  // (poprawnie, wg CommonMark) traktuje hasze jako zwykły tekst zamiast nagłówka.
  'Następny krok to domknięcie testu integracyjnego na mock-driverze.\n\n',
];

/**
 * Definicje 8 sesji startowych (spec, sekcja „Demo mode").
 *
 * Kolejność ma znaczenie dla demo: dwie sesje czekają na człowieka (pas uwagi pokazuje „2").
 */
function seeds(kit: DemoSeedKit): DemoSeed[] {
  const { project, text, toolStep, sync } = kit;
  return [
    {
      id: 'demo-willow',
      model: 'claude-fable-5-1',
      effort: 'high',
      engineSessionId: `demo-engine-${PROJECTS.main}-0`,
      cwd: project('main'),
      title: PROJECTS.main,
      label: 'zapis notatek',
      state: 'waiting-permission',
      stateSinceAgoMs: 4 * MIN,
      createdAtAgoMs: 12 * MIN,
      lastActivityAgoMs: 4 * MIN,
      branch: 'main',
      dirtyCount: 2,
      ...sync('main'),
      messages: [
        {
          role: 'user',
          agoMs: 12 * MIN,
          blocks: text('Popraw zapis notatek — po restarcie gubi ostatnią zmianę. Dopisz test.'),
        },
        {
          role: 'assistant',
          agoMs: 11 * MIN,
          blocks: text([
            '## Diagnoza',
            '',
            'Zapis leci do pliku po rozgłoszeniu zmiany, więc restart w tym oknie gubi ostatnią notatkę.',
            '',
            '- zapis jest asynchroniczny,',
            '- UI dostaje potwierdzenie od razu,',
            '- brak testu na kolejność.',
          ].join('\n')),
        },
        {
          role: 'assistant',
          agoMs: 6 * MIN,
          blocks: text([
            'Zmieniam kolejność i domykam zapis przed powiadomieniem:',
            '',
            '```ts',
            'export async function saveNote(note: Note): Promise<void> {',
            '  await store.write(note);',
            '  emitter.emit("note-saved", note.id);',
            '}',
            '```',
            '',
            'Teraz uruchomię testy jednostkowe modułu notatek.',
          ].join('\n')),
        },
        {
          role: 'assistant',
          agoMs: 5 * MIN,
          blocks: kit.editStep(
            'src/notes.ts',
            '--- src/notes.ts\n+++ src/notes.ts\n@@\n-  emitter.emit("note-saved", note.id);\n-  await store.write(note);\n+  await store.write(note);\n+  emitter.emit("note-saved", note.id);',
          ),
        },
      ],
      permission: kit.shellPermission('demo-perm-willow', 'npm test -- --run src/notes.test.ts', 4 * MIN),
      live: { kind: 'awaiting-permission', reqId: 'demo-perm-willow' },
    },
    {
      // Druga sesja w TYM SAMYM projekcie co `demo-willow` — bez niej demo nie ma jak pokazać
      // pigułek sióstr (spec punkt 4 wymaga projektu z ≥2 sesjami) ani sensownej grupy
      // w sekcji „PROJEKTY". Stan `done`, żeby nie zmieniała licznika pasa uwagi.
      id: 'demo-willow-parser',
      model: 'claude-fable-5-1',
      cwd: project('main'),
      title: PROJECTS.main,
      label: 'parser dat',
      state: 'done',
      stateSinceAgoMs: 33 * MIN,
      createdAtAgoMs: 64 * MIN,
      lastActivityAgoMs: 33 * MIN,
      branch: 'main',
      dirtyCount: 2,
      ...sync('main'),
      lastSummary: 'Parser dat wydzielony, 9 testów zielonych.',
      messages: [
        {
          role: 'user',
          agoMs: 64 * MIN,
          blocks: text('Wydziel parser dat do osobnego modułu i dopisz testy formatów.'),
        },
        {
          role: 'assistant',
          agoMs: 33 * MIN,
          blocks: text([
            '## Gotowe',
            '',
            'Parser siedzi w `src/dates.ts`, a testy pokrywają trzy formaty wejścia:',
            '',
            '- ISO 8601,',
            '- `DD.MM.RRRR`,',
            '- znacznik uniksowy w sekundach.',
          ].join('\n')),
        },
        {
          // Pełny markdown odpowiedzi: tabela, cytat, linia, lista zagnieżdżona,
          // przekreślenie i goły adres — przegląd renderera klientów (apka natywna).
          role: 'assistant',
          agoMs: 33 * MIN,
          blocks: text([
            '### Formaty w liczbach',
            '',
            '| Format | Przykład | Testy |',
            '|:--|:--|--:|',
            '| ISO 8601 | `2026-10-05T09:00:00Z` | 4 |',
            '| `DD.MM.RRRR` | 05.10.2026 | 3 |',
            '| uniksowy | 1790000000 | 2 |',
            '',
            '> **Uwaga:** strefa czasowa idzie z ustawień urządzenia, więc test _uniksowego_ formatu'
              + ' przypina `UTC`.',
            '',
            '---',
            '',
            '1. Parser zwraca `null` zamiast rzucać wyjątkiem.',
            '2. Stary helper ~~formatDate~~ zniknął:',
            '   - wywołania przeszły na `parseDate`,',
            '   - typy w `src/types.ts` bez zmian.',
            '',
            'Specyfikacja formatu: https://www.rfc-editor.org/rfc/rfc3339.',
          ].join('\n')),
        },
      ],
    },
    {
      id: 'demo-rarog',
      model: 'claude-opus-4-6',
      effort: 'xhigh',
      ultracode: true,
      cwd: project('stream'),
      title: PROJECTS.stream,
      label: 'resync transkryptu',
      state: 'running',
      stateSinceAgoMs: 40_000,
      createdAtAgoMs: 3 * MIN,
      lastActivityAgoMs: 2_000,
      branch: 'main',
      dirtyCount: 3,
      ...sync('stream'),
      messages: [
        {
          role: 'user',
          agoMs: 3 * MIN,
          blocks: text('Opisz, jak działa resync transkryptu po powrocie z tła na iPhonie.'),
        },
      ],
      live: { kind: 'streaming' },
    },
    {
      id: 'demo-fleet-ops',
      model: 'claude-sonnet-5',
      effort: 'medium',
      cwd: project('cleanup'),
      title: PROJECTS.cleanup,
      label: 'czyszczenie builda',
      state: 'waiting-permission',
      stateSinceAgoMs: 1 * MIN,
      createdAtAgoMs: 8 * MIN,
      lastActivityAgoMs: 1 * MIN,
      branch: 'main',
      dirtyCount: 1,
      messages: [
        {
          role: 'user',
          agoMs: 8 * MIN,
          blocks: text('Wyczyść build i wypchnij poprawioną historię na main.'),
        },
        {
          role: 'assistant',
          agoMs: 2 * MIN,
          blocks: text([
            '## Uwaga',
            '',
            'To jest operacja niszcząca: kasuje katalog `dist` i nadpisuje historię na zdalnym repo.',
            'Poproszę o wyraźne potwierdzenie, zanim cokolwiek wykonam.',
          ].join('\n')),
        },
      ],
      permission: kit.shellPermission(
        'demo-perm-fleet-ops', 'rm -rf ./dist && git push --force origin main', 1 * MIN,
      ),
      // Jedyny seed z odmową drivera (kontrakt `DecisionOutcome`): „Zatwierdź" wraca 422,
      // karta ZOSTAJE z powodem przy przycisku. Operacja niszcząca to najlepsze miejsce, żeby
      // pokazać tę ścieżkę — `deny` działa normalnie, więc demo da się przeklikać do końca.
      live: {
        kind: 'awaiting-permission', reqId: 'demo-perm-fleet-ops', refuse: 'terminal-only',
      },
    },
    {
      id: 'demo-data-loader',
      model: 'claude-haiku-4-5',
      cwd: project('import'),
      title: PROJECTS.import,
      label: 'import CSV',
      state: 'done',
      stateSinceAgoMs: 26 * MIN,
      createdAtAgoMs: 55 * MIN,
      lastActivityAgoMs: 26 * MIN,
      branch: 'main',
      dirtyCount: 0,
      lastSummary: 'Zaimportowano 214 rekordów, testy zielone.',
      messages: [
        {
          role: 'user',
          agoMs: 55 * MIN,
          blocks: text('Zaimportuj dane z CSV i sprawdź, czy nic nie zgubiliśmy.'),
        },
        {
          role: 'assistant',
          agoMs: 50 * MIN,
          blocks: text([
            '## Plan',
            '',
            '1. Policzę wiersze w pliku i sprawdzę nagłówek.',
            '2. Odpalę testy importu na kopii bazy.',
            '3. Zapiszę raport rozbieżności obok modułu importu.',
            '',
            'Format pliku z eksportu:',
            '',
            '```csv',
            'id;nazwa;miasto;nip;utworzono',
            '1042;Kowalski i Syn;Poznań;7781234567;2024-03-11',
            '1043;Nowak Serwis;Gdańsk;5832345678;2024-03-12',
            '1044;Zielińska Biuro;Kraków;;2024-03-12',
            '```',
            '',
            'Kolumna `nip` bywa pusta — takie wiersze trafią do raportu, nie do bazy.',
          ].join('\n')),
        },
        // Seria kroków narzędzi (zwija się do najnowszego) i edycja z długim mini-diffem.
        {
          role: 'assistant',
          agoMs: 40 * MIN,
          blocks: toolStep('Read', 'data/klienci.csv', { file_path: 'data/klienci.csv' }),
        },
        {
          role: 'assistant',
          agoMs: 39 * MIN,
          blocks: toolStep('Grep', 'id;nazwa', { pattern: 'id;nazwa', path: 'data' }),
        },
        {
          role: 'assistant',
          agoMs: 38 * MIN,
          blocks: toolStep('Bash', 'wc -l data/klienci.csv', { command: 'wc -l data/klienci.csv' }),
        },
        {
          role: 'assistant',
          agoMs: 37 * MIN,
          blocks: toolStep('Bash', 'npm test -- import', {
            command: 'npm test -- import && open https://example.com/raport-importu',
          }),
        },
        {
          role: 'assistant',
          agoMs: 30 * MIN,
          blocks: kit.writeStep('src/import/report.ts', IMPORT_REPORT),
        },
        {
          role: 'assistant',
          agoMs: 26 * MIN,
          blocks: text([
            '## Import zakończony',
            '',
            '- 214 rekordów w bazie,',
            '- 0 duplikatów,',
            '- 12 testów zielonych.',
            '',
            'Raport rozbieżności jest pusty — nic nie wypadło po drodze.',
            '',
            'Co sprawdziłem po drodze:',
            '',
            '1. Nagłówek pliku zgadza się ze schematem tabeli.',
            '2. Puste `nip` trafiają do raportu, nie do bazy — w tym pliku takich nie było.',
            '3. Ponowny import tego samego pliku nie tworzy duplikatów.',
            '4. Daty `utworzono` mieszczą się w zakresie eksportu.',
            '',
            'Raport leży w `src/import/report.ts`; uruchomisz go przez `npm run import:report`.',
            'Przy następnym eksporcie wystarczy podmienić plik w `data/` i odpalić to samo.',
          ].join('\n')),
        },
      ],
    },
    {
      id: 'demo-pipe-link',
      model: 'claude-sonnet-5',
      effort: 'low',
      cwd: project('bridge'),
      title: PROJECTS.bridge,
      label: 'mostek zdarzeń',
      state: 'resumable',
      stateDetail: kit.backendRestarted(),
      stateSinceAgoMs: 18 * MIN,
      createdAtAgoMs: 70 * MIN,
      lastActivityAgoMs: 18 * MIN,
      branch: 'feat/bridge',
      dirtyCount: 2,
      messages: [
        {
          role: 'user',
          agoMs: 70 * MIN,
          blocks: text('Dorób mostek zdarzeń i log obecności.'),
        },
        // Notki harnessu i zdjęcia: zadania w tle skończone, zatrzymane i nieudane,
        // zdjęcie z serwera, z historii bez nazwy i wagi, zdjęcie po sprzątaniu 48 h, plik PDF i obrazek
        // w treści odpowiedzi agenta.
        kit.commandCompleted(48 * MIN, 'pnpm test -- bridge'),
        {
          role: 'user',
          agoMs: 44 * MIN,
          blocks: text('Tak wygląda log obecności na iPadzie po przełączeniu sieci — zrzut i notatki z testu.'),
          attachments: kit.bridgeLogAttachments('notatki-obecnosc.pdf'),
        },
        {
          role: 'user',
          agoMs: 42 * MIN,
          blocks: text('Jeszcze zrzut z telefonu i ten z wczoraj.'),
          attachments: kit.bridgePhoneAttachments(),
        },
        {
          role: 'assistant',
          agoMs: 36 * MIN,
          blocks: [
            { type: 'text', text: 'Zdarzenia obecności z ostatniej godziny — przerwy pokrywają się z przełączeniem sieci:' },
            kit.chartImage('Wykres zdarzeń obecności'),
          ],
        },
        kit.agentStopped(30 * MIN, 'przegląd logu obecności'),
        kit.commandFailed(22 * MIN, 'pnpm run e2e:presence', 1),
        {
          role: 'assistant',
          agoMs: 19 * MIN,
          blocks: text([
            'Mam już szkielet mostka i zapisuję zdarzenia do bufora. Zostało podpięcie',
            'retry przy zerwanym połączeniu — wracam do tego po restarcie.',
          ].join('\n')),
        },
      ],
    },
    {
      // Limit planu to stan, który na glance MUSI być widoczny po ludzku („spróbuj po 14:00"),
      // a nie surowym `resetAt=<ISO>` — dlatego demo ma go w stałym zestawie startowym.
      id: 'demo-map-view',
      model: 'claude-fable-5-1',
      effort: 'max',
      cwd: project('panel'),
      title: PROJECTS.panel,
      label: 'nowy layout panelu',
      state: 'limit-reached',
      stateDetail: kit.limitReset(),
      stateSinceAgoMs: 9 * MIN,
      createdAtAgoMs: 95 * MIN,
      lastActivityAgoMs: 9 * MIN,
      branch: 'feat/panel',
      dirtyCount: 4,
      messages: [
        {
          role: 'user',
          agoMs: 95 * MIN,
          blocks: text('Przepisz panel klienta na nowy layout i zaktualizuj testy widoków.'),
        },
        {
          role: 'assistant',
          agoMs: 10 * MIN,
          blocks: text([
            '## Stan prac',
            '',
            'Layout jest przepisany, zostały dwa widoki listy i migracja testów:',
            '',
            '- nagłówek i nawigacja gotowe,',
            '- tabela klientów przeniesiona na grid,',
            '- testy widoków w połowie.',
          ].join('\n')),
        },
        {
          // Pytanie do użytkownika: od pogrubionego „Do Ciebie:” do końca tekstu apka stawia
          // pomarańczową kreskę — przez listę, blok kodu i tabelę. Treści tej sesji nie czyta żaden test.
          role: 'assistant',
          agoMs: 9 * MIN,
          blocks: text([
            'Zanim przeniosę dwa ostatnie widoki listy, potrzebuję jednej decyzji.',
            '',
            '**Do Ciebie:** przenosimy listy na nowy grid teraz, czy zostają na starym układzie'
              + ' do następnego wydania?',
            '',
            '1. Grid teraz — jeden komponent tabeli dla całego panelu, testy widoków do przepisania.',
            '2. Stary układ — mniej zmian dziś, dwa komponenty do utrzymania do wydania.',
            '',
            'Po decyzji odpalę testy widoków:',
            '',
            '```bash',
            'pnpm test -- --run src/views',
            '```',
            '',
            '| Wariant | Pliki | Testy do zmiany |',
            '| --- | --- | --- |',
            '| grid teraz | 6 | 14 |',
            '| stary układ | 2 | 3 |',
          ].join('\n')),
        },
      ],
    },
    {
      /*
       * Tura do przerwania (apka natywna, 2F: Stop i Esc). Pracuje, ale driver
       * NIE strumieniuje (`idle`): XCUITest nie czeka na spoczynek apki przed każdym krokiem,
       * a Stop ma co przerwać także wtedy, gdy wcześniejsze testy odebrały turę `demo-rarog`.
       */
      id: 'demo-rarog-stop',
      model: 'claude-opus-4-6',
      effort: 'high',
      cwd: project('stream'),
      title: PROJECTS.stream,
      label: 'przegląd pokrycia',
      state: 'running',
      stateSinceAgoMs: 20_000,
      createdAtAgoMs: 4 * MIN,
      lastActivityAgoMs: 20_000,
      branch: 'main',
      dirtyCount: 3,
      ...sync('stream'),
      messages: [
        {
          role: 'user',
          agoMs: 20_000,
          blocks: text('Policz pokrycie testami modułu transkryptu i wypisz luki.'),
        },
      ],
      live: { kind: 'idle' },
    },
  ];
}

export const demoContentPl: DemoContent = {
  projects: PROJECTS,
  seeds,
  resumable: [
    {
      // Wpis `-0`: w projekcie `main` to rozmowa ŻYWEJ karty `demo-willow` (wiersz „otwarta”); w pozostałych
      // projektach zwykła zamknięta rozmowa.
      firstPrompt: 'Dopisz zapis notatek przy wyjściu z edytora.',
      agoMs: 4 * MIN,
      branch: 'main',
    },
    {
      firstPrompt: 'Przenieś parser CSV do osobnego modułu i dopisz testy na puste kolumny.',
      agoMs: 35 * MIN,
      branch: 'feat/csv-parser',
    },
    {
      firstPrompt: 'Znajdź, dlaczego lista gubi ostatni element po odświeżeniu.',
      agoMs: 4 * 60 * MIN,
      branch: 'fix/lista-ostatni',
    },
    {
      firstPrompt: 'Zrób przegląd zależności i wypisz te bez wydania od roku.',
      agoMs: 26 * 60 * MIN,
      branch: 'main',
    },
  ],
  diffPatch: DIFF_PATCH,
  lastCommitSubject: 'feat(notes): zapis notatki po każdej zmianie',
  noteText: [
    '## Przed deployem',
    '- `pnpm run restart` po każdej zmianie w `server/`',
    '- sprawdź `/health`: `herdr: true`',
    '',
    'Changelog herdr: https://herdr.dev',
  ].join('\n'),
  driver: {
    replies: REPLIES,
    streamFragments: STREAM_FRAGMENTS,
    questions: [
      {
        question: 'Jak zapisujemy rejestr sesji?',
        header: 'Zapis',
        multiSelect: false,
        options: [
          { label: 'JSON + rename', description: 'Zapis atomowy, zero zależności.' },
          { label: 'SQLite', description: 'Transakcje, ale nowa zależność natywna.' },
        ],
      },
      {
        question: 'Które testy dopisać przy okazji?',
        header: 'Testy',
        multiSelect: true,
        options: [
          { label: 'Jednostkowe', description: 'Czyste funkcje i parser.' },
          { label: 'Integracyjne', description: 'Manager na mock-driverze.' },
          { label: 'Property-based', description: 'Maszyna stanów na losowych ciągach.' },
        ],
      },
    ],
    // Słowa porównywane z tekstem promptu; testy XCUITest apki je wysyłają.
    triggers: { question: ['pytanie'], red: ['czerwone'], limit: ['limit'], error: ['błąd', 'blad'] },
    imagesEcho: (count) => {
      // Polska odmiana: 1 obrazek, 2–4 obrazki, 5 obrazków.
      const noun = count === 1 ? 'obrazek' : (count < 5 ? 'obrazki' : 'obrazków');
      return `Dostałem ${String(count)} ${noun} — odbijam, żeby było widać, co przyszło:`;
    },
    imageAlt: (index) => `Załącznik ${String(index)}`,
    deniedReply: 'Nie wykonuję tej komendy — odmowa przyjęta. Czekam na dalsze polecenia.',
    deniedSummary: 'Komenda odrzucona przez użytkownika.',
    turnSummary: 'Zmiana wprowadzona, testy przechodzą.',
  },
  review: { serverName: 'Mac demo', model: 'claude-fable-5-1', effort: 'high' },
  tailnet: 'example.ts.net',
};
