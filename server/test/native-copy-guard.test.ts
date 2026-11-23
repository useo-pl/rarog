/**
 * Strażnik literałów copy apki natywnej (`docs/localization.md`, „Guards”) — wzór
 * `distribution-guard.test.ts`: allow-lista z DOKŁADNĄ liczbą wystąpień per plik.
 *
 * Po co: każdy tekst dla człowieka idzie przez rejestr (`UICopy`, `CoreCopy`, copy kafla)
 * do katalogu języka. Tekst wpisany wprost w widok albo model ominąłby katalog i został po polsku w każdym języku.
 * Strażnik liczy w źródłach Swift apki (bez testów) dwa rodzaje literałów poza rejestrem:
 * - `call` — literał z literą w wywołaniu, które pokazuje tekst (`Text("…")`, `Button("…")`, `Label("…")`,
 *   `title:`, `placeholder:`, `prompt:`, `message:`, `text:`, `.accessibilityLabel("…")`, `UIKeyCommand(title:)`,
 *   przypisanie `x.accessibilityLabel = "…"`, `x.text = "…"`, …);
 * - `polish` — literał z polskim znakiem (ą, ć, ę, ł, ń, ó, ś, ź, ż), gdziekolwiek.
 * Komentarze się nie liczą. Diagnostyka (ślady, raporty, błędy kontraktu i transportu, `fatalError`) jest wolna:
 * to tekst dla człowieka przy Macu w `client.log`, nie copy apki.
 *
 * Dwie listy, obie z dokładną liczbą (więcej = nowy literał, przewraca test z miejscem; mniej = lista do skrócenia):
 * - `NOT_COPY` — stałe wyjątki z powodem (szkielety ładowania, dane podglądów Xcode i seamów demo, glif klawisza,
 *   diagnostyka poza wywołaniem śladu);
 * - `PENDING` — copy, które jeszcze nie przeszło do rejestru albo rejestr, który nie leży w `Copy/`. Jest pusta,
 *   z sufitem `PENDING_CEILING` = 0.
 *
 * Czego strażnik NIE udowodni: braku tekstu złożonego w modelu ze zmiennych i słów bez polskich znaków poza
 * wywołaniem prezentacyjnym (np. `parts.append("od \(x)")` w zdaniu dla czytnika) — to łapie przebieg
 * z `-NSShowNonLocalizedStrings YES` i przegląd. Nie odróżnia też copy od identyfikatora w etykiecie
 * `title:` innego niż widok; takie miejsca stoją w `NOT_COPY` z powodem.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoFiles } from './source-scan.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO, 'scripts', 'l10n-check.mjs');

interface Literal {
  line: number; start: number; text: string; calls: (string | null)[]; label: string | null; assigned: string | null;
}
interface Module { swiftStringLiterals: (source: string) => { literals: Literal[]; masked: string } }
const { swiftStringLiterals } = await import(pathToFileURL(SCRIPT).href) as Module;

type Kind = 'call' | 'polish';
type Allowed = Readonly<Record<string, Readonly<Partial<Record<Kind, number>>>>>;

const PREFIX = 'native/Rarog/';
/** Źródła apki: kod apki, rozszerzeń (widżet, powiadomienia) i pakietów, bez testów i biblioteki złotych ramek. */
const inScope = (file: string): boolean => file.endsWith('.swift') && (
  /^native\/Rarog\/(?:Rarog|RarogWidgets|RarogNotificationService)\//.test(file)
  || /^native\/Rarog\/Packages\/[^/]+\/Sources\/(?!RarogContractFixtures\/)/.test(file));
/** Rejestr copy: tu literały stoją z definicji (przechodzą do katalogu). */
const REGISTRY = [
  /^native\/Rarog\/Packages\/RarogUI\/Sources\/RarogUI\/Copy\//,
  /^native\/Rarog\/Packages\/RarogCore\/Sources\/RarogCore\/Copy\//,
  /^native\/Rarog\/Packages\/RarogActivity\/Sources\/RarogActivity\/Copy\//,
];
/** Pliki samej diagnostyki (tekst do `client.log` i śladów, nigdy na ekran). */
const DIAGNOSTIC_FILES = [
  /\/DiagnosticsTrace[^/]*\.swift$/, /\/TerminalOpenTrace\.swift$/, /\/TerminalReturnTrace\.swift$/,
  /\/RarogContract\/Copy\/CopyLanguage\.swift$/,
];
/** Wywołania diagnostyki: literał w ich argumentach (na każdej głębokości) nie jest copy. */
const DIAGNOSTIC_CALLS = new Set([
  'trace', 'reportUnhandled', 'contractViolation', 'invalidResponse', 'io', 'fatalError', 'preconditionFailure',
  'precondition', 'assert', 'assertionFailure', 'print', 'debugPrint', 'NSLog', 'os_log', 'Logger',
]);
/** Wywołania, które pokazują tekst pierwszym argumentem bez etykiety. */
const PRESENTING = new Set([
  'Text', 'Button', 'Label', 'TextField', 'SecureField', 'TextEditor', 'Toggle', 'Section', 'Menu', 'Picker', 'Link',
  'LabeledContent', 'ContentUnavailableView', 'NavigationLink', 'Tab', 'ShareLink', 'ControlGroup',
  'accessibilityLabel', 'accessibilityHint', 'accessibilityValue', 'accessibilityAction', 'navigationTitle', 'help',
  'alert', 'confirmationDialog', 'badge', 'setTitle', 'UIKeyCommand', 'UIAction', 'UIMenu', 'UIAlertController',
  'UIAlertAction', 'UIContextualAction', 'UIAccessibilityCustomAction', 'AttributedString', 'NSAttributedString',
]);
/** Etykiety argumentów z tekstem dla człowieka (w każdym wywołaniu poza `NON_TEXT_CALLS`). */
const TEXT_LABELS = new Set([
  'title', 'subtitle', 'placeholder', 'prompt', 'label', 'message', 'hint', 'discoverabilityTitle', 'text',
  'accessibilityLabel', 'accessibilityHint', 'accessibilityValue',
]);
/** Tekst z atrybutami z etykietą `string:` (`NSAttributedString(string: "…")`). */
const ATTRIBUTED = new Set(['NSAttributedString', 'NSMutableAttributedString']);
/** Wywołania z etykietą `label:`, które nie pokazują tekstu (nazwa kolejki, wątku). */
const NON_TEXT_CALLS = new Set(['DispatchQueue', 'Thread', 'OSLog']);
/** Właściwości z tekstem dla człowieka (przypisanie `x.<właściwość> = "…"`). */
const TEXT_PROPERTIES = new Set([
  'accessibilityLabel', 'accessibilityHint', 'accessibilityValue', 'placeholder', 'text', 'title', 'attributedText',
  'discoverabilityTitle', 'attributedTitle', 'attributedPlaceholder',
]);
const POLISH = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
const LETTER = /\p{L}/u;

/**
 * Stałe wyjątki: nie copy apki. Ścieżki względem `native/Rarog/`. Skracać wolno zawsze; wydłużać tylko z powodem
 * przy wpisie.
 */
const NOT_COPY: Allowed = {
  // Loading skeletons: `.redacted(reason: .placeholder)` and `accessibilityHidden`, so the text is neither shown nor
  // read; its length gives the skeleton its shape. In `NewSessionSheet+Project` also the `Text("git")` mark of a
  // directory row: a tool name, the same in every language (the history mark comes from the catalog,
  // `newSession.historyMarker`).
  'Packages/RarogUI/Sources/RarogUI/Views/NewSession/NewSessionSheet+Project.swift': { call: 2 },
  'Packages/RarogUI/Sources/RarogUI/Views/NewSession/RecentSessionsSheet.swift': { call: 1 },
  // Próbka do pomiaru wysokości linii pisma („Ag” z separatorem linii) — mierzona, nie rysowana.
  'Packages/RarogUI/Sources/RarogUI/Markdown/ProseLeading.swift': { call: 1 },
  // Glif skrótu klawiatury (⌘J) — ten sam w każdym języku.
  'Packages/RarogUI/Sources/RarogUI/Views/Notes/NotePanel.swift': { call: 1 },
  // Dane podglądów Xcode (`#Preview`, `PreviewStates`): nazwy przebiegów, faz i podglądów, nie trafiają do apki.
  'RarogWidgets/RarogLiveActivity.swift': { call: 2, polish: 2 },
  // Diagnostyka poza wywołaniem śladu: powody w enumach i zmiennych, które idą do `trace`/`client.log`.
  'Packages/RarogUI/Sources/RarogUI/Terminal/TerminalKeyRepeat.swift': { polish: 7 },
  'Packages/RarogUI/Sources/RarogUI/Views/List/TreeListAnchor.swift': { polish: 6 },
  'Rarog/SystemSignals.swift': { polish: 4 },
  'Packages/RarogCore/Sources/RarogCore/ContractReporter.swift': { polish: 1 },
  // Powody końca kafla dla `trace`: brak kanału APNs i inne słowo maszyny serwera.
  'Packages/RarogCore/Sources/RarogCore/RarogStore+LiveActivity.swift': { polish: 2 },
  'Packages/RarogTransport/Sources/RarogTransport/RarogClient+Voice.swift': { polish: 1 },
  // Ścieżka pola w błędzie dekodowania klucza krótkiego agenta głosowego, ten sam wzór co wpis wyżej.
  'Packages/RarogTransport/Sources/RarogTransport/RarogClient+Companion.swift': { polish: 1 },
  // Linia śladu końca nagrania systemowego (`DictationTrace.systemEnd`): idzie do `trace`, nie na ekran.
  'Packages/RarogUI/Sources/RarogUI/Session/Voice/VoiceServices.swift': { polish: 1 },
  // Seam testów UI: wynik dyktowania udany przez demo (tekst „od człowieka”, nie copy).
  'Packages/RarogUI/Sources/RarogUI/Session/Voice/ScriptedVoice.swift': { polish: 1 },
  // Sonda testów UI (tylko DEBUG): etykiety dostępności przycisków sondy to identyfikatory dla XCUITest.
  'Rarog/UITestProbe.swift': { call: 2 },
};

/**
 * Copy jeszcze poza rejestrem. Pusta: copy kafla Live Activity jest w katalogu RarogActivity. Lista zostaje
 * jako mechanizm z sufitem zero — nowy wpis tu to tekst poza katalogiem języka.
 */
const PENDING: Allowed = {};
/** Sufit `PENDING`: zero. */
const PENDING_CEILING = 0;

interface Hit { readonly line: number; readonly kind: Kind; readonly text: string }

/** Trafienia w jednym pliku (`file` względem korzenia repo). */
function hitsIn(file: string, source: string): Hit[] {
  if (DIAGNOSTIC_FILES.some((rule) => rule.test(file))) return [];
  const hits: Hit[] = [];
  for (const literal of swiftStringLiterals(source).literals) {
    if (literal.calls.some((call) => call !== null && DIAGNOSTIC_CALLS.has(call))) continue;
    const visible = literal.text.replaceAll('\u0000', '');
    // Litera ze znaku ucieczki (`\n`, `\t`, `\u{…}`) nie jest tekstem.
    const letters = visible.replace(/\\(?:u\{[0-9A-Fa-f]+\}|.)/g, '');
    const inner = literal.calls.at(-1) ?? null;
    // `Text(verbatim: "…")` z literałem też pokazuje stały tekst (verbatim omija tylko wyszukanie w katalogu).
    const presenting = (literal.label === null && literal.assigned === null && inner !== null && PRESENTING.has(inner))
      || (literal.label === 'verbatim' && inner === 'Text')
      || (literal.label === 'string' && inner !== null && ATTRIBUTED.has(inner));
    const labelled = literal.label !== null && TEXT_LABELS.has(literal.label)
      && !(inner !== null && NON_TEXT_CALLS.has(inner));
    const assigned = literal.assigned !== null && TEXT_PROPERTIES.has(literal.assigned);
    if (LETTER.test(letters) && (presenting || labelled || assigned)) hits.push({ line: literal.line, kind: 'call', text: visible });
    if (POLISH.test(visible)) hits.push({ line: literal.line, kind: 'polish', text: visible });
  }
  return hits;
}

interface Report { readonly unexpected: string[]; readonly stale: string[] }

/** Pliki (ścieżka względem korzenia → tekst) przeciw obu listom. */
function checkCopy(files: ReadonlyMap<string, string>, lists: readonly Allowed[]): Report {
  const unexpected: string[] = [];
  const stale: string[] = [];
  const limitOf = (file: string, kind: Kind): number =>
    lists.reduce((sum, list) => sum + (list[file.slice(PREFIX.length)]?.[kind] ?? 0), 0);
  for (const [file, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!inScope(file) || REGISTRY.some((rule) => rule.test(file))) continue;
    const hits = hitsIn(file, text);
    for (const kind of ['call', 'polish'] as const) {
      const found = hits.filter((hit) => hit.kind === kind);
      const limit = limitOf(file, kind);
      if (found.length > limit) {
        const where = limit === 0 ? 'poza allow-listą' : `allow-lista pozwala na ${String(limit)}, jest ${String(found.length)}`;
        for (const hit of found) unexpected.push(`${file}:${String(hit.line)}: [${kind}] „${hit.text}” — ${where}`);
      } else if (found.length < limit) {
        stale.push(`${file}: [${kind}] allow-lista mówi ${String(limit)}, w pliku ${String(found.length)}: skróć listę`);
      }
    }
  }
  for (const list of lists) {
    for (const [file, counts] of Object.entries(list)) {
      if (files.has(PREFIX + file)) continue;
      for (const [kind, limit] of Object.entries(counts)) {
        stale.push(`${PREFIX}${file}: [${kind}] allow-lista mówi ${String(limit)}, pliku nie ma: skróć listę`);
      }
    }
  }
  return { unexpected, stale };
}

/** Pliki Swift w zakresie: z gitem jak `git ls-files`, bez `.git` spacer z regułami `.gitignore` (`repoFiles`). */
function repoSwiftFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of repoFiles(REPO, 'native/Rarog').filter((name) => inScope(name))) {
    try {
      files.set(file, readFileSync(path.join(REPO, file), 'utf8'));
    } catch {
      // W indeksie, ale skasowany z drzewa roboczego.
    }
  }
  return files;
}

const sum = (list: Allowed): number =>
  Object.values(list).reduce((total, counts) => total + (counts.call ?? 0) + (counts.polish ?? 0), 0);

describe('strażnik literałów copy apki natywnej: mechanizm', () => {
  const file = 'native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Probka.swift';
  const kinds = (source: string): string[] => hitsIn(file, source).map((hit) => `${hit.kind}:${hit.text}`);

  it('wywołania prezentacyjne i etykiety tekstu: tak; identyfikatory, ikony, verbatim i komentarze: nie', () => {
    expect(kinds('Text("Zapisz")\nButton("Wyślij") {}\nLabel("Kopiuj", systemImage: on ? "checkmark" : "doc")')).toEqual([
      'call:Zapisz', 'call:Wyślij', 'polish:Wyślij', 'call:Kopiuj']);
    expect(kinds('UIKeyCommand(title: "Nowa linia", action: #selector(x), input: "\\r")')).toEqual(['call:Nowa linia']);
    expect(kinds('Marker(text: "historia")\nMarker(text: UICopy.historyMarker)'), 'etykieta text: własnego widoku')
      .toEqual(['call:historia']);
    expect(kinds('view.accessibilityLabel = "Zamknij"\n.accessibilityLabel(flag ? "Plan: \\(a)" : "Komenda: \\(a)")'))
      .toEqual(['call:Zamknij', 'call:Plan: ', 'call:Komenda: ']);
    expect(kinds('Button(title: x ? "\\(a)\\n\\(b)" : y)'), 'sam znak ucieczki to nie tekst').toEqual([]);
    expect(kinds('Text(verbatim: "Zapisz")\nview.text = flag ? "Tak" : "Nie"\nview.title =\n  "Tytuł"'))
      .toEqual(['call:Zapisz', 'call:Tak', 'call:Nie', 'call:Tytuł', 'polish:Tytuł']);
    expect(kinds('let x = view.text == "a" ? f("b") : "c"\nview.text = String(localized: "d")'),
      'porównanie i argument wywołania po prawej stronie to nie przypisanie tekstu').toEqual([]);
    expect(kinds('Text(verbatim: name)\nImage(systemName: "xmark")\n.accessibilityIdentifier("list.title")\n'
      + 'DispatchQueue(label: "pl.useo.queue")\nText("·")\n// Text("komentarz ąę")\n/* Text("blok") */')).toEqual([]);
  });

  it('przypisanie: przez wywołanie w kilku liniach, po domknięciu, w nawiasie grupującym; wzorzec case to nie przypisanie', () => {
    expect(kinds('view.text = String(\n  count\n) + " sesji"')).toEqual(['call: sesji']);
    expect(kinds('view.text = normalize(value: { view.tag = 1; return value }()) ?? "Brak"')).toEqual(['call:Brak']);
    expect(kinds('view.text = (flag ? "Tak" : "Nie")')).toEqual(['call:Tak', 'call:Nie']);
    expect(kinds('if case .text = block, kind == "tool_use" { handle(block) }\nguard case .title = x else { return }'),
      'wzorzec case i wiązanie to nie przypisanie tekstu').toEqual([]);
    expect(kinds('label.attributedText = NSAttributedString(string: "Zapisz", attributes: a)')).toEqual(['call:Zapisz']);
  });

  it('znak ucieczki w łańcuchu surowym nie kończy literału: kolejne wywołania dalej widać', () => {
    expect(kinds('let s = #"cytat \\#"# dalej"#\nText("Zapisz")')).toEqual(['call:Zapisz']);
  });

  it('polskie znaki poza diagnostyką; interpolacja i łańcuchy surowe rozpoznane', () => {
    expect(kinds('let a = "gałąź \\(name)"\ntrace("ślad: \\(x)")\nthrow .invalidResponse("zła ścieżka")')).toEqual(['polish:gałąź ']);
    expect(kinds('let b = #"surowy "cytat" ż"#\nlet c = """\n  wiele\n  linii ó\n  """')).toEqual([
      'polish:surowy "cytat" ż', 'polish:\n  wiele\n  linii ó\n  ']);
    expect(kinds('Text("\\(count) \\(UICopy.x)")'), 'sama interpolacja to nie tekst').toEqual([]);
    expect(hitsIn('native/Rarog/Packages/RarogUI/Sources/RarogUI/Model/DiagnosticsTrace.swift', 'let s = "ślad"')).toEqual([]);
  });

  it('dokładna liczba: nowe wystąpienie przewraca, mniejsze każe skrócić listę', () => {
    const files = new Map([[file, 'Text("Zapisz")\nText("Usuń")']]);
    const report = checkCopy(files, [{ 'Packages/RarogUI/Sources/RarogUI/Views/Probka.swift': { call: 1, polish: 2 } }]);
    expect(report.unexpected).toEqual([
      `${file}:1: [call] „Zapisz” — allow-lista pozwala na 1, jest 2`,
      `${file}:2: [call] „Usuń” — allow-lista pozwala na 1, jest 2`,
    ]);
    expect(report.stale).toEqual([`${file}: [polish] allow-lista mówi 2, w pliku 1: skróć listę`]);
    const registry = new Map([['native/Rarog/Packages/RarogUI/Sources/RarogUI/Copy/UICopy+X.swift', 'static let a = "Zażółć"']]);
    expect(checkCopy(registry, [])).toEqual({ unexpected: [], stale: [] });
  });
});

describe('strażnik literałów copy apki natywnej: repo', () => {
  const files = repoSwiftFiles();

  it('skan widzi apkę, rozszerzenie i pakiety, a nie widzi testów', () => {
    expect(files.has('native/Rarog/Rarog/RarogApp.swift')).toBe(true);
    expect(files.has('native/Rarog/RarogWidgets/RarogLiveActivity.swift')).toBe(true);
    expect(files.has('native/Rarog/RarogNotificationService/NotificationService.swift')).toBe(true);
    expect(files.has('native/Rarog/Packages/RarogUI/Sources/RarogUI/Copy/UICopy.swift')).toBe(true);
    expect([...files.keys()].some((file) => file.includes('/Tests/') || file.includes('RarogUITests/'))).toBe(false);
    expect(files.size).toBeGreaterThan(300);
  });

  it('literały copy poza rejestrem stoją wyłącznie tam, gdzie pozwalają listy, w dokładnej liczbie', () => {
    const report = checkCopy(files, [NOT_COPY, PENDING]);
    expect(report.unexpected, `Tekst poza rejestrem (przenieś do UICopy / CoreCopy / copy kafla, docs/localization.md):\n${
      report.unexpected.join('\n')}`).toEqual([]);
    expect(report.stale, `Lista do skrócenia:\n${report.stale.join('\n')}`).toEqual([]);
  });

  it('lista PENDING nie rośnie (sufit) i nie dubluje NOT_COPY', () => {
    expect(sum(PENDING)).toBeLessThanOrEqual(PENDING_CEILING);
    expect(Object.keys(PENDING).filter((file) => file in NOT_COPY)).toEqual([]);
  });
});
