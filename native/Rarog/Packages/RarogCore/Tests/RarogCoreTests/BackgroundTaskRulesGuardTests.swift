import Foundation
import RarogContractFixtures
import Testing

// Strażnik „jednego miejsca" reguł pracy w tle w apce — lustro bloku „co jest pracą" z
// `server/test/herdr-background-boundary.test.ts`.
//
// `BackgroundTaskRules.swift` ma sens tylko wtedy, gdy pytanie „czy lista zadań w tle jest pracą" naprawdę
// w nim ZOSTAJE. Dobra wola tego nie utrzyma: kolejna kopia reguły powstaje jako jedna wygodna linia
// w selektorze albo w modelu widoku (`!(session.backgroundTasks ?? []).isEmpty`) i rozjeżdża się z resztą
// przy pierwszej zmianie definicji pracy. Tak było z postojem subagenta: rdzeń przestał liczyć
// czekającego jako pracę, a modele `RarogUI` z własną kopią reguły dalej rysowały przy nim zieloną kropkę.
// Dlatego test jest GREPOWY: taka linia ma się pokazać jako czerwony test, a nie w review.
//
// Zakres: kod `RarogCore/Sources` i `RarogUI/Sources` po zdjęciu komentarzy (komentarzom wolno cytować
// wszystko), bez `BackgroundTaskRules.swift`. Strażnik stoi w testach rdzenia, bo tu mieszka plik reguł;
// źródła `RarogUI` czyta z dysku jak własne. Celu apki i rozszerzenia widżetu nie obejmuje: listy zadań nie
// dotykają.
//
// Co wolno w `RarogUI` bez pytania reguł: OPISAĆ zadanie (rodzaj, opis, komenda, czas) i narysować listę.
// Nie wolno rozstrzygać, czy lista albo zadanie jest pracą: znak pracy, słowo „pracuje w tle" i stan
// „czeka" biorą odpowiedź z `BackgroundTaskRules`. Zdanie, które listę wyjmuje, żeby ją opisać albo
// narysować, stoi na zamkniętej liście `allowed` z powodem.
//
// Granice strażnika:
// - listy pod inną nazwą (zmienna lokalna, ładunek `TurnStage`) nie śledzi. Dlatego pilnuje samego
//   WYJĘCIA listy z sesji: każde zdanie ze słowem `backgroundTasks`, które nie jest pytaniem do
//   `BackgroundTaskRules`, musi stać na zamkniętej liście `allowed` z powodem. Co model robi z listą
//   potem, pilnują testy zachowania (`SessionRowStageTests`, `BackgroundRowTests` w `RarogUILogicTests`);
// - rozkładu `run` w `RarogUI` nie pilnuje (reguła `byRun` jest tylko dla rdzenia): tam rozkład rysuje
//   `WorkflowRunModel`, a `.run` to także token palety i ton pigułki;
// - widzi tyle, ile zostawi skaner komentarzy (`SwiftSource`), a ten nie zna literałów wyrażeń
//   regularnych. Zjedzony kod łapie osobny test „skaner nie połyka kodu" (`swallowed`).

@Suite("strażnik źródeł: czy lista zadań w tle jest pracą, rozstrzyga tylko BackgroundTaskRules.swift")
struct BackgroundTaskRulesGuardTests {
  /// Sposób rozstrzygania na własną rękę. Nazwa mówi, co wzorzec łapie.
  struct Rule: Sendable {
    let name: String
    /// Fragmenty kodu, które są w porządku — zdejmowane przed szukaniem `pattern`. Dopasowanie może
    /// obejmować kilka linii.
    let fine: String?
    let pattern: String
    /// Katalogi źródeł, w których reguła obowiązuje (podzbiór `scope`).
    var scopes: [String] = BackgroundTaskRulesGuardTests.scope
  }

  /// Zdanie spoza `BackgroundTaskRules.swift`, któremu wolno dotknąć listy: plik, dosłowna linia kodu, powód.
  struct Allowed: Sendable {
    let file: String
    let statement: String
    let reason: String
  }

  struct Offence: Equatable, CustomStringConvertible {
    let file: String
    let line: Int
    let rule: String
    let code: String
    var description: String { "\(file):\(line): \(rule): \(code)" }
  }

  static let packages = "native/Rarog/Packages/"
  static let core = "RarogCore/Sources/"
  static let ui = "RarogUI/Sources/"
  /// Katalogi źródeł pod strażnikiem, względem `packages`.
  static let scope = [core, ui]
  static let rulesFile = "RarogCore/Sources/RarogCore/BackgroundTaskRules.swift"
  static let selectors = [
    "RarogCore/Sources/RarogCore/Selectors.swift",
    "RarogCore/Sources/RarogCore/Selectors+LiveActivity.swift",
  ]
  /// Modele i widoki `RarogUI`, które pytają o pracę w tle: bez własnej kopii reguły „lista niepusta".
  static let uiAskers = [
    "RarogUI/Sources/RarogUI/Model/SessionRowModel.swift",
    "RarogUI/Sources/RarogUI/Model/SessionPillsModel.swift",
    "RarogUI/Sources/RarogUI/Model/HeaderStatusModel.swift",
    "RarogUI/Sources/RarogUI/Model/ActivityText.swift",
  ]

  static let listOutsideRules = "lista zadań poza pytaniem do BackgroundTaskRules"
  static let byKind = "rozstrzyganie po rodzaju zadania"
  static let byRun = "rozstrzyganie po rozkładzie przebiegu workflow"
  static let byStandby = "rozstrzyganie po postoju subagenta"
  static let byWaitStage = "deciding by the wait stage of a subagent"
  static let byOwnTasks = "deciding by the own commands of a subagent"

  static let rules: [Rule] = [
    Rule(
      // Pustość, `contains`, `count`, pętla, kopia do zmiennej: wszystko zaczyna się od słowa
      // `backgroundTasks`. W porządku jest tylko podanie listy wprost do reguły, also after plain leading arguments
      // (`stuckWait(session.state, session.backgroundTasks)`).
      name: listOutsideRules,
      fine: #"\bBackgroundTaskRules\.\w+\(\s*(?:[\w$.?!]+\s*,\s*)*(?:[\w$]+[?!]?\.)*backgroundTasks\s*\)"#,
      pattern: #"\bbackgroundTasks\b"#
    ),
    Rule(
      // Rodzaj zadania porównany z wartością `BackgroundTaskKind`, w obie strony. Ten sam kształt ma
      // rodzaj notki transkryptu (`NoticeKind`); gdyby rdzeń zaczął go porównywać, zdanie idzie na
      // listę `allowed` z tym powodem.
      name: byKind,
      fine: nil,
      pattern: #"\.kind\s*[!=]=\s*\.(?:command|agent|workflow|monitor)\b"#
        + #"|\.(?:command|agent|workflow|monitor)\s*[!=]=\s*[\w$.?!]*\bkind\b"#
    ),
    Rule(
      // Odczyt rozkładu `run` (przypisanie i wywołanie metody `run(…)` to co innego) albo liczenie
      // jego agentów. Tylko rdzeń: w `RarogUI` rozkład rysuje `WorkflowRunModel`, a `.run` to także
      // token palety (`Palette.run`) i ton pigułki.
      name: byRun,
      fine: nil,
      pattern: #"\.run\b(?!\s*(?:\(|=(?!=)))"#
        + #"|\bagents\s*\.\s*(?:isEmpty|count|contains|allSatisfy|filter|first|last)\b"#,
      scopes: [core]
    ),
    Rule(
      // Pole `waitingSince`: czy subagent stoi w postoju, mówi `BackgroundTaskRules.waitingAgent`.
      // Rdzeń poza plikiem reguł nie ma dziś powodu czytać tego pola. `RarogUI` czyta je w jednym
      // miejscu, do licznika czasu (lista `allowed`); kolejny odczyt idzie tam z powodem albo znika.
      name: byStandby,
      fine: nil,
      pattern: #"\bwaitingSince\b"#
    ),
    Rule(
      // The wait stage field `ownCommandWait`: what follows from it (the row's tone and rank, the Live Activity
      // counter) answers `BackgroundTaskRules`; no source file outside the rules file reads the field. Asking the rule
      // of the same name (`BackgroundTaskRules.ownCommandWait(of:in:)`) is fine.
      name: byWaitStage,
      fine: #"\bBackgroundTaskRules\.ownCommandWait\("#,
      pattern: #"\bownCommandWait\b"#
    ),
    Rule(
      // The own commands of a subagent (`ownTasks`): whether a subagent waits on its own command, and how long, is
      // the server's stage in `ownCommandWait`, never the app's own reading of the list. Lines that only draw the
      // commands or strip them before the disk stand on the `allowed` list.
      name: byOwnTasks,
      fine: nil,
      pattern: #"\bownTasks\b"#
    ),
  ]

  /// Lista ZAMKNIĘTA. Pliki rdzenia listę przechowują albo kopiują, pliki `RarogUI` ją opisują albo rysują;
  /// żaden nie mówi, czy sesja albo zadanie pracuje. Nowy wpis wymaga powodu, a wpis, którego zdania już
  /// nie ma w pliku, przewraca test niżej.
  static let allowed: [Allowed] = [
    Allowed(
      file: "RarogCore/Sources/RarogCore/Reducer+List.swift",
      statement: "let tasks = session.backgroundTasks ?? []",
      reason: "pamięć etapu tury: reduktor zapisuje listę jako fakt z drutu; jej pustość mówi tylko,"
        + " czy jest co zapamiętać, a nie czy sesja pracuje"
    ),
    Allowed(
      file: "RarogCore/Sources/RarogCore/SnapshotCacheFile.swift",
      statement: "copy.backgroundTasks = session.backgroundTasks?.map { task in",
      reason: "`scrub`: kopia listy bez opisów, komend i rozkładu przed zapisem na dysk; liczba zadań zostaje"
    ),
    Allowed(
      file: "RarogCore/Sources/RarogCore/SnapshotCacheFile.swift",
      statement: "bare.ownTasks = task.ownTasks?.map { own in",
      reason: "`scrub`: the subagent's own commands lose their command text before the disk; the entries stay and"
        + " decide nothing"
    ),
    Allowed(
      file: "RarogUI/Sources/RarogUI/Model/SessionRowModel.swift",
      statement: "let tasks = session.backgroundTasks ?? []",
      reason: "linia etapu wiersza OPISUJE listę (rodzaj, opis, liczba); znak pracy przy niej daje"
        + " `tasksKeepRowWorking`, a zdanie o samych czekających `onlyWaitingAgents`"
    ),
    Allowed(
      file: "RarogUI/Sources/RarogUI/Model/HeaderStatusModel.swift",
      statement: "let tasks = session.backgroundTasks ?? []",
      reason: "plakietka „N w tle” liczy i opisuje wszystkie zadania; czy plakietka w ogóle stoi, mówi"
        + " `hasTasks`, a czy ma znak pracy, `tasksKeepRowWorking`"
    ),
    Allowed(
      file: "RarogUI/Sources/RarogUI/Views/Header/BackgroundTasksPanel.swift",
      statement: "let tasks = state.sessions[sessionId]?.backgroundTasks ?? []",
      reason: "popover pigułki RYSUJE wiersze zadań; stan każdego wiersza liczy model (`BackgroundTaskRow`)"
    ),
    Allowed(
      file: "RarogUI/Sources/RarogUI/Views/Inspector/InspectorPanel.swift",
      statement: "let tasks = session?.backgroundTasks ?? []",
      reason: "prawy panel RYSUJE wiersze zadań i liczbę w nagłówku sekcji („W TLE · N”, wszystkie zadania)"
    ),
    Allowed(
      file: "RarogUI/Sources/RarogUI/Model/ActivityText.swift",
      statement: #"let phase = first.kind == .workflow ? phaseCopy(first.run.flatMap(WorkflowRunModel.phaseCounts)) : """#,
      reason: "opis: fazę planu w linii etapu mówi tylko zadanie workflow; o pracy nie rozstrzyga"
    ),
    Allowed(
      file: "RarogUI/Sources/RarogUI/Model/HeaderStatusModel.swift",
      statement: "guard task.kind == .workflow, let run = task.run else { return nil }",
      reason: "rysowanie: sekcję przebiegu pod wierszem ma tylko zadanie workflow z rozkładem"
    ),
    Allowed(
      file: "RarogUI/Sources/RarogUI/Model/HeaderStatusModel.swift",
      statement: "standbySince = waiting ? task.waitingSince.flatMap(ServerTime.parse) : nil",
      reason: "LICZNIK postoju: wiersz subagenta liczy czas od początku postoju; czy agent czeka, mówi linia"
        + " wyżej (`BackgroundTaskRules.waitingAgent`), a pole daje tylko chwilę"
    ),
    Allowed(
      file: "RarogUI/Sources/RarogUI/Model/HeaderStatusModel.swift",
      statement: "let rows = (task.ownTasks ?? []).map { BackgroundPanelLine.ownTask(OwnTaskRow($0, task: task.id, awaited: awaited)) }",
      reason: "drawing: the subagent's own commands under its row in the background section; whether the agent"
        + " waits on them comes from `waitingAgent`, how long from the server's stage"
    ),
  ]

  /// Pliki `.swift` z katalogów `scope`, ścieżki względem `native/Rarog/Packages/`.
  static func sources() throws -> [(path: String, text: String)] {
    let root = try GoldenFrames.repoRoot().appending(path: packages, directoryHint: .isDirectory)
    let rootPath = root.standardizedFileURL.path + "/"
    var out: [(String, String)] = []
    for directory in scope {
      let start = root.appending(path: directory, directoryHint: .isDirectory)
      guard let walker = FileManager.default.enumerator(at: start, includingPropertiesForKeys: nil) else { continue }
      for case let url as URL in walker where url.pathExtension == "swift" {
        let path = url.standardizedFileURL.path.replacing(rootPath, with: "")
        out.append((path, try String(contentsOf: url, encoding: .utf8)))
      }
    }
    return out.sorted { $0.0 < $1.0 }
  }

  /// Linie kodu (bez komentarzy), które łapie któraś reguła — bez pliku reguł, z listą `allowed` włącznie.
  /// Reguła patrzy tylko na pliki ze swoich katalogów (`Rule.scopes`).
  static func offences(in files: [(path: String, text: String)]) throws -> [Offence] {
    var out: [Offence] = []
    for rule in rules {
      // Proste granice słów (`\b` jak w JS): w UAX#29 `session.backgroundTasks` to JEDNO słowo.
      let pattern = try Regex(rule.pattern).wordBoundaryKind(.simple)
      let fine = try rule.fine.map { try Regex($0).wordBoundaryKind(.simple) }
      for file in files where file.path != rulesFile && rule.scopes.contains(where: file.path.hasPrefix) {
        let code = SwiftSource.stripComments(file.text)
        // Pytanie do reguły bywa złamane na kilka linii, więc zdejmujemy je z całego źródła. Znaki nowej
        // linii zostają: numery linii się nie przesuwają.
        let rest = fine.map { fine in
          code.replacing(fine) { match in String(code[match.range].filter(\.isNewline)) }
        } ?? code
        let lines = code.split(separator: "\n", omittingEmptySubsequences: false)
        for (index, line) in rest.split(separator: "\n", omittingEmptySubsequences: false).enumerated()
        where line.contains(pattern) {
          out.append(Offence(
            file: file.path, line: index + 1, rule: rule.name,
            code: lines[index].trimmingCharacters(in: .whitespaces)))
        }
      }
    }
    return out
  }

  /// Linie, które skaner komentarzy zdjął w całości, choć w źródle nie są ani puste, ani komentarzem
  /// liniowym.
  ///
  /// `SwiftSource` nie zna literałów wyrażeń regularnych: `/*` w klasie znaków (`/[/*]/`) bierze za
  /// początek komentarza blokowego i zjada kod do najbliższego `*/` albo do końca pliku. Strażnik by
  /// wtedy milczał, bo zjedzonego kodu nie widzi. Stąd miara niezależna od
  /// skanera: linia, która w źródle zaczyna się kodem, nie może po nim być pusta. Wyjście z takiego
  /// alarmu: zapisać wzorzec bez sąsiadujących `/` i `*` (np. `[*/]`). Cena miary: komentarz blokowy
  /// zajmujący całą linię też tu wpada — w rdzeniu komentarze są liniowe (`//`). Zjedzonego kawałka
  /// w obrębie jednej linii miara nie widzi.
  static func swallowed(in files: [(path: String, text: String)]) -> [String] {
    var out: [String] = []
    for file in files {
      let source = file.text.split(separator: "\n", omittingEmptySubsequences: false)
      let kept = SwiftSource.stripComments(file.text).split(separator: "\n", omittingEmptySubsequences: false)
      guard source.count == kept.count else {
        out.append("\(file.path): skaner zgubił numerację linii")
        continue
      }
      for (index, line) in source.enumerated() {
        let code = line.trimmingCharacters(in: .whitespaces)
        if code.isEmpty || code.hasPrefix("//") { continue }
        if kept[index].trimmingCharacters(in: .whitespaces).isEmpty {
          out.append("\(file.path):\(index + 1): \(code)")
        }
      }
    }
    return out
  }

  static func isAllowed(_ offence: Offence) -> Bool {
    allowed.contains { $0.file == offence.file && $0.statement == offence.code }
  }

  /// Nazwy reguł, które łapią pojedyncze zdanie w pliku rdzenia.
  static func hits(_ line: String) throws -> [String] {
    try offences(in: [("RarogCore/Sources/RarogCore/Probka.swift", line)]).map(\.rule)
  }

  /// To samo dla pliku `RarogUI` (tam nie obowiązuje reguła rozkładu `run`).
  static func uiHits(_ line: String) throws -> [String] {
    try offences(in: [("RarogUI/Sources/RarogUI/Model/Probka.swift", line)]).map(\.rule)
  }

  @Test("skan obejmuje źródła rdzenia i RarogUI, a zdjęcie komentarzy nie zjada kodu")
  func scanCoversCore() throws {
    let files = try Self.sources()
    let paths = Set(files.map(\.path))
    #expect(files.filter { $0.path.hasPrefix(Self.core) }.count > 40, "skan widzi za mało plików rdzenia")
    #expect(files.filter { $0.path.hasPrefix(Self.ui) }.count > 100, "skan widzi za mało plików RarogUI")
    for path in Self.selectors + Self.uiAskers + [Self.rulesFile] + Self.allowed.map(\.file) {
      #expect(paths.contains(path), "skan nie widzi \(path)")
    }
    let rulesSource = try #require(files.first { $0.path == Self.rulesFile })
    #expect(SwiftSource.stripComments(rulesSource.text).contains("public enum BackgroundTaskRules"))
  }

  @Test("skaner nie połyka kodu: żadna linia kodu rdzenia ani RarogUI nie znika razem z komentarzami")
  func scannerKeepsCode() throws {
    #expect(try Self.swallowed(in: Self.sources()) == [], "strażnik nie widzi tych linii — patrz `swallowed`")
    // Literał wyrażenia regularnego z `/*` w klasie znaków: skaner bierze go za komentarz i zjada kod
    // pod nim, więc sam zakaz by milczał. Ta miara to widzi.
    let path = "RarogCore/Sources/RarogCore/Probka.swift"
    let eaten = "let re = #/[/*]/#\nreturn !(session.backgroundTasks ?? []).isEmpty\n"
    #expect(try Self.offences(in: [(path, eaten)]) == [], "skaner nauczył się wzorców — ta próbka jest do wymiany")
    #expect(Self.swallowed(in: [(path, eaten)]) == ["\(path):2: return !(session.backgroundTasks ?? []).isEmpty"])
    // Zwykły kod z komentarzami liniowymi i końcowymi niczego nie gubi.
    let plain = "// nagłówek\nlet a = 1 // końcowy\n\n  /// opis\n  let b = \"x // nie komentarz\"\n"
    #expect(Self.swallowed(in: [(path, plain)]) == [])
  }

  @Test("poza BackgroundTaskRules.swift żaden plik rdzenia ani RarogUI nie rozstrzyga sam, czy lista zadań jest pracą")
  func noOwnRules() throws {
    let offenders = try Self.offences(in: Self.sources()).filter { !Self.isAllowed($0) }
    #expect(offenders == [], "zapytaj regułę z BackgroundTaskRules.swift (BackgroundTaskRules)")
  }

  @Test("selektory listy i kafla oraz modele RarogUI biorą odpowiedź z BackgroundTaskRules")
  func selectorsAsk() throws {
    let files = try Self.sources()
    for path in Self.selectors + Self.uiAskers {
      let file = try #require(files.first { $0.path == path })
      #expect(SwiftSource.stripComments(file.text).contains("BackgroundTaskRules."), "\(path) nie pyta reguł")
    }
  }

  @Test("lista wyjątków jest zamknięta: każdy ma powód, a jego zdanie dalej stoi w pliku i dalej go potrzebuje")
  func allowedAreNeeded() throws {
    let caught = try Self.offences(in: Self.sources())
    #expect(Self.allowed.map(\.file) == [
      "RarogCore/Sources/RarogCore/Reducer+List.swift", "RarogCore/Sources/RarogCore/SnapshotCacheFile.swift",
      "RarogCore/Sources/RarogCore/SnapshotCacheFile.swift", "RarogUI/Sources/RarogUI/Model/SessionRowModel.swift", "RarogUI/Sources/RarogUI/Model/HeaderStatusModel.swift",
      "RarogUI/Sources/RarogUI/Views/Header/BackgroundTasksPanel.swift",
      "RarogUI/Sources/RarogUI/Views/Inspector/InspectorPanel.swift",
      "RarogUI/Sources/RarogUI/Model/ActivityText.swift", "RarogUI/Sources/RarogUI/Model/HeaderStatusModel.swift",
      "RarogUI/Sources/RarogUI/Model/HeaderStatusModel.swift", "RarogUI/Sources/RarogUI/Model/HeaderStatusModel.swift",
    ])
    for entry in Self.allowed {
      #expect(!entry.reason.trimmingCharacters(in: .whitespaces).isEmpty, "\(entry.file): wyjątek bez powodu")
      // Zdania nie ma albo reguły go już nie łapią — wyjątek jest do zdjęcia.
      #expect(
        caught.contains { $0.file == entry.file && $0.code == entry.statement },
        "\(entry.file): wyjątek „\(entry.statement)” niczego już nie przepuszcza")
    }
  }

  @Test("wzorce łapią zdania sprzed refaktoru (inaczej zakaz byłby pusty)")
  func catchesOldSentences() throws {
    // Dosłowne linie z `Selectors.swift` i `Selectors+LiveActivity.swift` sprzed refaktoru.
    let old: [(line: String, rules: [String])] = [
      ("var hasBackgroundWork: Bool { !(backgroundTasks ?? []).isEmpty }", [Self.listOutsideRules]),
      ("return (session.backgroundTasks ?? []).contains(where: openWorkflow)", [Self.listOutsideRules]),
      (
        "(session.backgroundTasks ?? []).contains { $0.kind != .workflow || openWorkflow($0) }",
        [Self.listOutsideRules, Self.byKind]
      ),
      ("guard task.kind == .workflow else { return false }", [Self.byKind]),
      ("guard let run = task.run else { return true }", [Self.byRun]),
      ("return run.agents.isEmpty || run.agents.contains { !$0.done }", [Self.byRun]),
    ]
    // Reguła postoju poza plikiem reguł: własna kopia definicji „czeka".
    #expect(try Self.hits("return task.kind == .agent && task.waitingSince != nil") == [Self.byKind, Self.byStandby])
    #expect(try Self.hits("let waiting = tasks.filter { $0.waitingSince != nil }") == [Self.byStandby])
    // A copy of the stuck wait rule outside the rules file, in the core and in `RarogUI`.
    #expect(try Self.hits("|| tasks.contains { $0.ownCommandWait == .stuck }") == [Self.byWaitStage])
    #expect(try Self.uiHits("if task.ownCommandWait == .long { tone = .backgroundWait }") == [Self.byWaitStage])
    // The app's own reading of a subagent's own commands: the predicate the server computes, copied into a selector
    // or a row model, alone or next to the standby rule.
    #expect(try Self.hits("let onOwnCommand = !(task.ownTasks ?? []).isEmpty") == [Self.byOwnTasks])
    #expect(try Self.hits("return BackgroundTaskRules.waitingAgent(task) && task.ownTasks?.isEmpty == false")
      == [Self.byOwnTasks])
    #expect(try Self.uiHits("if task.waitingSince != nil, let own = task.ownTasks, !own.isEmpty { text = stuck }")
      == [Self.byStandby, Self.byOwnTasks])
    for sample in old {
      #expect(try Self.hits(sample.line) == sample.rules, "wzorce nie łapią: \(sample.line)")
    }
    // Inne sposoby liczenia na własną rękę, których dawny kod nie używał. Dwa ostatnie to kopia reguły
    // monitora (monitor patrzy, nie pracuje) w selektorze albo modelu widoku.
    let other: [(line: String, rules: [String])] = [
      ("let count = session.backgroundTasks?.count ?? 0", [Self.listOutsideRules]),
      ("for task in session.backgroundTasks ?? [] {", [Self.listOutsideRules]),
      ("if let tasks = session.backgroundTasks, !tasks.isEmpty {", [Self.listOutsideRules]),
      ("return BackgroundTaskRules.hasOpenWorkflow(session.backgroundTasks) || session.backgroundTasks != nil",
       [Self.listOutsideRules]),
      ("tasks.contains { .agent == $0.kind }", [Self.byKind]),
      ("if task.run == nil { return true }", [Self.byRun]),
      ("return task.run?.agents.allSatisfy(\\.done) ?? false", [Self.byRun]),
      ("let working = tasks.contains { $0.kind != .monitor }", [Self.byKind]),
      ("if tasks.allSatisfy({ .monitor == $0.kind }) { return .quiet }", [Self.byKind]),
    ]
    for sample in other {
      #expect(try Self.hits(sample.line) == sample.rules, "wzorce nie łapią: \(sample.line)")
    }
  }

  @Test("wzorce przepuszczają pytanie do reguły, komentarz i cudze `kind` oraz `run`")
  func passesQuestions() throws {
    let fine = [
      "return rank > 2 && BackgroundTaskRules.tasksKeepRowWorking(backgroundTasks) ? 2 : rank",
      "return BackgroundTaskRules.hasOpenWorkflow(session.backgroundTasks)",
      "quietStates.contains($0.state) && BackgroundTaskRules.hasBackgroundWork($0.backgroundTasks)",
      "let stuck = BackgroundTaskRules.stuckWait(session.state, session.backgroundTasks)",
      "waitingStates.contains($0.state) || BackgroundTaskRules.stuckWait($0.state, $0.backgroundTasks)",
      "let stage = BackgroundTaskRules.ownCommandWait(of: task, in: session.state)",
      "let strongest = BackgroundTaskRules.strongestOwnCommandWait(session.state, session.backgroundTasks)",
      "// stary zapis: !(session.backgroundTasks ?? []).isEmpty",
      "/* task.kind == .workflow */ let x = 1",
      "if var activity = session.activity, activity.kind == .tool, activity.delegation != nil {",
      "let task = Task.detached { await supervisor.run(cursor: cursor) }",
      "bare.run = nil",
      "case .starting, .running: ListClock(kind: .turn, since: stateSince)",
      "turnStage[session.id] = .background(tasks)",
      // Pytanie złamane na kilka linii to dalej pytanie.
      "return BackgroundTaskRules.hasBackgroundWork(\n  session.backgroundTasks\n)",
    ]
    for line in fine {
      #expect(try Self.hits(line) == [], "fałszywy alarm: \(line)")
    }
  }

  @Test("RarogUI: dawne kopie reguły są łapane, pytania do reguł i opis zadania przechodzą")
  func catchesOldUISentences() throws {
    // Verbatim lines of `RarogUI` models and views that copied a rule instead of asking it.
    let old: [(line: String, rules: [String])] = [
      ("let backgroundWork = !(session.backgroundTasks ?? []).isEmpty", [Self.listOutsideRules]),
      ("!inPanel && !(session.backgroundTasks ?? []).isEmpty", [Self.listOutsideRules]),
      (
        "if StatusPills.background(session, inPanel: backgroundInPanel), let tasks = session.backgroundTasks {",
        [Self.listOutsideRules]
      ),
      ("for task in tasks where task.kind == .agent {", [Self.byKind]),
      ("?? tasks.lazy.filter { $0.kind == .agent }.map(taskText).first { !$0.isEmpty }", [Self.byKind]),
    ]
    for sample in old {
      #expect(try Self.uiHits(sample.line) == sample.rules, "wzorce nie łapią: \(sample.line)")
    }
    // Własna definicja postoju w widoku: stan „czeka" liczy `BackgroundTaskRules.waitingAgent`.
    #expect(try Self.uiHits("let waiting = task.waitingSince != nil") == [Self.byStandby])
    // Wyjątek licznika jest wąski: to jedno zdanie w jednym pliku. Odczyt pola gdzie indziej albo inaczej
    // (np. stan liczony z samego pola) dalej przewraca strażnika.
    let clock = "standbySince = waiting ? task.waitingSince.flatMap(ServerTime.parse) : nil"
    let model = "RarogUI/Sources/RarogUI/Model/HeaderStatusModel.swift"
    #expect(try Self.offences(in: [(model, clock)]).allSatisfy(Self.isAllowed))
    #expect(try !Self.offences(in: [("RarogUI/Sources/RarogUI/Model/SessionRowModel.swift", clock)]).contains(where: Self.isAllowed))
    #expect(try !Self.offences(in: [(model, "waiting = task.waitingSince != nil")]).contains(where: Self.isAllowed))
    #expect(try Self.uiHits("if task.kind == .agent, task.waitingSince != nil {") == [Self.byKind, Self.byStandby])
    let fine = [
      "let backgroundWork = BackgroundTaskRules.tasksKeepRowWorking(session.backgroundTasks)",
      "!inPanel && BackgroundTaskRules.hasTasks(session.backgroundTasks)",
      "if BackgroundTaskRules.onlyWaitingAgents(tasks) {",
      "for task in tasks where BackgroundTaskRules.workingAgent(task) {",
      "waiting = BackgroundTaskRules.waitingAgent(task)",
      "kind = UICopy.backgroundKind(task.kind)",
      // Rozkład `run` i token palety: w `RarogUI` poza regułami strażnika.
      "let done = run.agents.filter(\\.done).count",
      "PillLabel(text: badge.text, tone: .run, leadingDot: badge.working ? Palette.run : nil, bordered: false)",
    ]
    for line in fine {
      #expect(try Self.uiHits(line) == [], "fałszywy alarm w RarogUI: \(line)")
    }
    // Ta sama linia w rdzeniu dalej jest rozstrzyganiem po rozkładzie.
    #expect(try Self.hits("let done = run.agents.filter(\\.done).count") == [Self.byRun])
  }

  @Test("pytanie złamane na linie nie przesuwa numerów linii następnych znalezisk")
  func multilineQuestionKeepsLineNumbers() throws {
    let source = """
      let a = BackgroundTaskRules.hasBackgroundWork(
        session.backgroundTasks
      )
      let b = session.backgroundTasks?.count
      """
    let found = try Self.offences(in: [("RarogCore/Sources/RarogCore/Probka.swift", source)])
    #expect(found == [Offence(
      file: "RarogCore/Sources/RarogCore/Probka.swift", line: 4, rule: Self.listOutsideRules,
      code: "let b = session.backgroundTasks?.count")])
  }

  @Test("plik reguł i wyjątki: plik reguł pominięty w całości, wyjątek działa tylko w swoim pliku")
  func exemptionsAreNarrow() throws {
    let sentence = "let tasks = session.backgroundTasks ?? []"
    #expect(try Self.offences(in: [(Self.rulesFile, sentence)]) == [])
    let inReducer = try Self.offences(in: [("RarogCore/Sources/RarogCore/Reducer+List.swift", sentence)])
    let elsewhere = try Self.offences(in: [("RarogCore/Sources/RarogCore/Selectors.swift", sentence)])
    #expect(inReducer.count == 1 && inReducer.allSatisfy(Self.isAllowed))
    #expect(elsewhere.count == 1 && !elsewhere.contains(where: Self.isAllowed))
  }

  @Test("zdejmowanie komentarzy: zagnieżdżone bloki, łańcuchy z `//`, interpolacja, surowe łańcuchy")
  func commentStripping() {
    let source = #"""
      let a = "x // nie komentarz" // komentarz
      /* zewn /* wewn */ dalej komentarz */ let b = 1
      let c = "\(f("y")) // też łańcuch"
      let d = #"surowy " // wciąż łańcuch"#
      """#
    let stripped = SwiftSource.stripComments(source)
    #expect(stripped.contains(#""x // nie komentarz""#))
    #expect(!stripped.contains("// komentarz"))
    #expect(!stripped.contains("wewn"))
    #expect(stripped.contains("let b = 1"))
    #expect(stripped.contains("// też łańcuch"))
    #expect(stripped.contains("// wciąż łańcuch"))
    #expect(stripped.split(separator: "\n", omittingEmptySubsequences: false).count == 4)
  }
}
