import Foundation
import RarogContract
import RarogCore

// Linia statusu w nagłówku sesji: pierścień kontekstu, git i plakietka
// zadań w tle. Czyste funkcje, testowane na macOS.
// Właściciel: nagłówek.

/// Kontekst okna sesji: procent do pierścienia i tekstu, próg koloru, zdanie dla czytnika.
public struct ContextGauge: Sendable, Equatable {
  /// `12%` przy znanym limicie, `~67%` przy szacunku.
  public let text: String
  /// 0–100 — wypełnienie pierścienia (tekst może nieść tyldę, liczba nie).
  public let percent: Int
  public let tone: UsageTone
  /// Limit niepotwierdzony — procent liczony od założonego okna.
  public let estimated: Bool
  public let spoken: String

  /// Założone okna przy niepotwierdzonym limicie: najmniejsze ≥ liczbie tokenów (procent
  /// zamiast „184 tys."). Sesja 1M poniżej 200k pokaże procent od 200k —
  /// tylda i zdanie czytnika mówią wprost, że to szacunek.
  static let assumedLimits = [200_000, 1_000_000]

  /// `context` (transkrypt: tokeny + czy limit jest znany) wypiera `usage` tam, gdzie jest — tylko
  /// on wie, czy wolno pokazać twardy procent. `usage` zostaje zapasem dla sesji, o których
  /// transkrypt jeszcze nic nie powiedział. `nil` = nie wiem; zero byłoby kłamstwem.
  public static func make(context: ContextLimitState?, usage: SessionUsage?) -> ContextGauge? {
    switch context {
    case let .unknown(tokens, atLeast)?:
      guard tokens >= 0 else { return nil }
      // Drabinka od tego, co sesja UNIOSŁA: po `/compact` tokeny spadają, a własne granice
      // kompakcji dowodzą większego okna — inaczej widget namawiałby do kompaktowania tuż po nim.
      let floor = max(tokens, atLeast ?? 0)
      let limit = assumedLimits.first { floor <= $0 } ?? assumedLimits[assumedLimits.count - 1]
      let percent = clamp(tokens, limit)
      return ContextGauge(
        text: "~\(percent)%", percent: percent, tone: UsageTone(percent: percent), estimated: true,
        spoken: UICopy.contextEstimateSpoken(percent, assumedLimit: limit))
    case let .known(tokens, limit, _)?:
      return hard(tokens: tokens, limit: limit)
    case nil:
      return usage.flatMap { hard(tokens: $0.contextTokens, limit: $0.contextLimit) }
    }
  }

  private static func hard(tokens: Int, limit: Int) -> ContextGauge? {
    guard tokens >= 0, limit > 0 else { return nil }
    let percent = clamp(tokens, limit)
    return ContextGauge(
      text: "\(percent)%", percent: percent, tone: UsageTone(percent: percent), estimated: false,
      spoken: UICopy.contextSpoken(percent))
  }

  /// Sufit 100 %: silnik potrafi podać stan sprzed kompakcji, a „112 %" nic nie wnosi.
  private static func clamp(_ tokens: Int, _ limit: Int) -> Int {
    min(100, Int((Double(tokens) / Double(limit) * 100).rounded()))
  }
}

/// Segment linii gita: `main · ↓2 ↑1 · +3 ~5 −1`.
public struct GitSegment: Sendable, Equatable, Identifiable {
  public enum Kind: Sendable, Equatable {
    case branch, behind, ahead, added, modified, deleted
    /// Sam licznik brudnych plików, gdy serwer nie podał rodzajów.
    case files
  }

  public let kind: Kind
  public let text: String
  /// Klei się z poprzednim (para strzałek, trójka plików) — bez kropki rozdzielającej.
  public let glued: Bool

  public var id: String { "\(kind)" }
}

/// Git sesji z dwóch źródeł: podsumowanie (przeżywa restart serwera, to samo co karta listy)
/// i ramka `git-status` (ma listę plików, ratuje przypadek, w którym wyprzedziła listę).
public struct GitMeta: Sendable, Equatable {
  public var branch: String?
  public var dirtyCount: Int?
  public var ahead: Int?
  public var behind: Int?
  public var fileKinds: GitFileKinds?
  public var lastCommit: GitCommit?
  /// Ścieżki brudnych plików — wyłącznie z ramki `git-status`.
  public var files: [String]

  /// `session == nil` (sesja zniknęła z listy) = sama ramka albo nic.
  public init(session: SessionSummary?, fresh: GitStatusEvent?) {
    branch = session?.branch ?? fresh?.branch
    dirtyCount = session?.dirtyCount ?? fresh?.dirtyCount
    ahead = session?.ahead ?? fresh?.ahead
    behind = session?.behind ?? fresh?.behind
    fileKinds = session?.fileKinds ?? fresh?.fileKinds
    lastCommit = session?.lastCommit ?? fresh?.lastCommit
    files = fresh?.files ?? []
  }

  /// Katalog jest repozytorium (gałąź znana).
  public var isRepo: Bool { !(branch ?? "").isEmpty }

  /// Segmenty linii. Liczy PLIKI, nie linie; zera nie tworzą segmentu; brak
  /// upstreamu chowa strzałki; najpierw to, co trzeba pobrać.
  public var segments: [GitSegment] {
    var out: [GitSegment] = []
    if let branch, !branch.isEmpty { out.append(GitSegment(kind: .branch, text: branch, glued: false)) }
    let behind = self.behind ?? 0
    let ahead = self.ahead ?? 0
    if behind > 0 { out.append(GitSegment(kind: .behind, text: "↓\(behind)", glued: false)) }
    if ahead > 0 { out.append(GitSegment(kind: .ahead, text: "↑\(ahead)", glued: behind > 0)) }
    guard let kinds = fileKinds else {
      let dirty = dirtyCount ?? 0
      if dirty > 0 { out.append(GitSegment(kind: .files, text: UICopy.filesCount(dirty), glued: false)) }
      return out
    }
    var glued = false
    // `−` to MINUS (U+2212): w cyfrach tabelarycznych ma szerokość plusa, więc linia nie tańczy.
    for (kind, n, sign) in [(GitSegment.Kind.added, kinds.added, "+"), (.modified, kinds.modified, "~"), (.deleted, kinds.deleted, "−")]
    where n > 0 {
      out.append(GitSegment(kind: kind, text: "\(sign)\(n)", glued: glued))
      glued = true
    }
    return out
  }

  /// Cała linia jednym zdaniem — w kolejności segmentów (oko i ucho dostają tę samą listę).
  public func spoken(context: ContextGauge?) -> String {
    var parts: [String] = []
    if let context { parts.append(context.spoken) }
    if let branch, !branch.isEmpty { parts.append(UICopy.branchSpoken(branch)) }
    if let sync = UICopy.aheadBehindSpoken(ahead: ahead ?? 0, behind: behind ?? 0) { parts.append(sync) }
    if let kinds = fileKinds,
      let said = UICopy.fileKindsSpoken(added: kinds.added, modified: kinds.modified, deleted: kinds.deleted)
    {
      parts.append(said)
    } else if let dirty = dirtyCount {
      // Bez trójki (albo z trójką samych zer) zostaje licznik, a czyste drzewo mówi „bez zmian"
      // wprost: cisza w tym miejscu wyglądała jak brak odczytu.
      parts.append(UICopy.dirtySpoken(dirty))
    }
    return UICopy.list(parts, .comma)
  }
}

/// Linia statusu w nagłówku stoi, gdy ma o czym mówić: kontekst, git albo pigułka. Pusty
/// pas z kreską byłby szumem. Pyta też pasek zakładek: nagłówek oddziela od transkryptu JEDNA kreska, pod
/// ostatnim rzędem — pod paskiem tylko wtedy, gdy linii nie ma.
public enum StatusLine {
  /// `backgroundInPanel`: prawy panel pokazuje „w tle", więc pigułka nie trzyma linii.
  public static func isShown(
    _ session: SessionSummary, fresh: GitStatusEvent?, backgroundInPanel: Bool = false, restarting: Bool = false
  ) -> Bool {
    ContextGauge.make(context: session.context, usage: session.usage) != nil
      || !GitMeta(session: session, fresh: fresh).segments.isEmpty
      || StatusPills.visible(session, backgroundInPanel: backgroundInPanel, restarting: restarting)
  }

  /// Linia gita otwiera rozwinięcie z diffem tylko przy repozytorium i sesji z własnym ekranem. Codex i sesja
  /// nieobsługiwana diffa nie mają (serwer: 400). Agent w terminalu Raroga też nie: ramki repozytorium jadą
  /// strumieniem sesji, którego nad terminalem nie ma, więc otwarty diff nie wiedziałby, że repo się zmieniło.
  public static func gitExpands(_ session: SessionSummary, isRepo: Bool) -> Bool {
    isRepo && session.engine == nil && !session.isUnsupported && session.showsTranscript
  }
}

/// Zadanie w tle w panelu: znak stanu i PEŁNY opis, pod nim linia „stan · czas", potem linia meta `rodzaj ·
/// narzędzia komendy · kto i czym`. Rodzaj nie stoi w pierwszej linii, bo z czasem zjadałby połowę szerokości
/// i ucinał opis.
///
/// Subagent ma w panelu trzy stany: pracuje (kropka pracy, licznik od startu), czeka na własne zadanie
/// (klepsydra, pod opisem „czeka na własne zadanie · 18 min", licznik od początku postoju), skończył (wiersza
/// nie ma; koniec pokazuje sekcja „Skończone ostatnio"). Czy agent czeka, mówi reguła rdzenia.
public struct BackgroundTaskRow: Sendable, Equatable, Identifiable {
  public let id: String
  public let kind: String
  /// Opis albo komenda; pusty = „—".
  public let text: String
  /// Typ agenta, model i podsumowanie (`Explore · Opus 5`); pusty = bez tych członów w linii meta.
  public let meta: String
  /// Komenda w jednej linii pod opisem: jest tylko wtedy, gdy pierwsza linia pokazuje OPIS, a zadanie ma też
  /// komendę. Bez opisu komenda jest samym `text`.
  public let command: String?
  /// To samo skrócone do narzędzi (`batch-run.sh review`, `grep | head`; `CommandTools`) —
  /// to stoi w linii meta. Gdy skrót niczego nie rozpozna, linia meta mówi sam rodzaj („komenda"): opis już
  /// nazywa zadanie, a cała komenda zalewałaby wiersz przypisaniami zmiennych.
  public let tools: String?
  /// Komenda z kontraktu bez obróbki (nowe linie zostają) — do „Kopiuj komendę". `nil` = zadanie bez komendy.
  /// Serwer tnie ją do 1000 znaków, więc to nie zawsze komenda źródłowa w całości.
  public let rawCommand: String?
  /// Start zadania; `nil` = start sprzed okna ogona (licznik od „teraz" kłamałby).
  public let startedAt: Date?
  /// Subagent w postoju: skończył turę i czeka na własne zadanie w tle (`BackgroundTaskRules.waitingAgent`).
  public let waiting: Bool
  /// Od kiedy stoi. `nil` przy zadaniu, które nie czeka, i wtedy, gdy czas z serwera nie jest czasem.
  /// Nazwa inna niż pole kontraktu celowo: słowo `waitingSince` poza plikiem reguł łapie strażnik źródeł,
  /// a jedyny dozwolony odczyt pola to zdanie w `init`, które bierze z niego chwilę do licznika.
  public let standbySince: Date?

  public init(_ task: BackgroundTask, choices: [ModelChoice] = []) {
    id = task.id
    kind = UICopy.backgroundKind(task.kind)
    var parts = [task.agentType, task.model.map { ModelLabel.format($0, choices: choices) }]
      .compactMap { $0 }
      .filter { !$0.isEmpty }
    if let summary = task.summary, !summary.isEmpty { parts.append(summary) }
    meta = UICopy.list(parts, .dot)
    rawCommand = task.command.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    let described = !(task.description ?? "").isEmpty
    let oneLine = OwnTaskRow.oneLine(rawCommand)
    let short = rawCommand.flatMap(CommandTools.summary)
    // Bez opisu pierwszą linią jest komenda: jej narzędzia, a gdy skrót niczego nie rozpozna — sam początek.
    // Pełną ma „Kopiuj komendę".
    text = described
      ? ActivityText.taskText(task) : (short ?? oneLine.map(CommandTools.clipped) ?? ActivityText.taskText(task))
    command = described ? oneLine : nil
    tools = described ? short : nil
    startedAt = task.startedAt.flatMap(ServerTime.parse)
    waiting = BackgroundTaskRules.waitingAgent(task)
    standbySince = waiting ? task.waitingSince.flatMap(ServerTime.parse) : nil
  }

  /// Zadanie pracuje (kropka pracy w kolumnie znaku); jedyny inny stan wiersza to postój subagenta.
  public var working: Bool { !waiting }

  /// Słowa stanu pod opisem. Ma je tylko subagent w postoju; zadanie, które pracuje, mówi stan kropką.
  public var state: String? { waiting ? UICopy.agentWaitingOwnTask : nil }

  /// Linia meta bez rodzaju (rodzaj stoi na jej początku cichszym atramentem): narzędzia komendy pod opisem,
  /// potem kto i czym. Pusta = w linii stoi sam rodzaj.
  public var detail: String {
    UICopy.list([tools, meta].compactMap { $0 }.filter { !$0.isEmpty }, .dot)
  }

  /// Linia „stan · czas" pod opisem (jak „pracuje · 6 min" na liście sesji): słowa stanu
  /// postoju i licznik; po godzinie osobno „od 20:33" (`since(now:)`). Pusta = wiersz bez tej linii.
  public func status(now: Date) -> [String] {
    [state, clockSince.map { RelativeTime.short(since: $0, now: now) }].compactMap { $0 }
  }

  /// Od kiedy liczy licznik wiersza: postój od swojego początku, praca od startu zadania. Ten sam licznik,
  /// inna chwila: agent, który stoi od 18 minut, nie pokazuje „2 h" od startu jak ktoś, kto dalej mieli.
  public var clockSince: Date? { waiting ? standbySince : startedAt }

  /// „od 20:33" pod licznikiem, gdy liczy ponad godzinę: przy długich zadaniach sam licznik („3 h 12") nie mówi,
  /// kiedy zadanie ruszyło (albo agent stanął), a to po godzinie odróżnia żywe zadanie od zapomnianego.
  public func since(now: Date, timeZone: TimeZone = .current) -> String? {
    guard let clockSince, now.timeIntervalSince(clockSince) >= 3600 else { return nil }
    return UICopy.backgroundSince(ServerTime.clock(clockSince, timeZone: timeZone))
  }

  /// Wiersz jednym zdaniem dla czytnika: rodzaj i opis, stan z czasem („pracuje, od 6 minut" albo „czeka na
  /// własne zadanie od 18 minut"), komenda pod opisem, kto i czym. Oko widzi stan po znaku, ucho słyszy słowo.
  public func spoken(now: Date) -> String {
    let what = text.isEmpty ? kind : UICopy.taskNamed(kind: kind, name: text)
    var parts: [String]
    if waiting {
      parts = [what, UICopy.agentWaitingSpoken(since: standbySince, now: now)]
    } else {
      parts = [UICopy.backgroundTaskWorking(what)]
      if let startedAt { parts.append(UICopy.sinceSpoken(RelativeTime.spokenSince(since: startedAt, now: now))) }
    }
    if let tools { parts.append(UICopy.backgroundTaskTools(tools)) }
    if !meta.isEmpty { parts.append(meta) }
    return UICopy.list(parts, .comma)
  }

  /// Zdanie dla czytnika: ile i co — bez czasu (w zdaniu nie tyka). Subagent w postoju mówi swój stan
  /// („subagent Research czeka na własne zadanie"): liczba obejmuje wszystkie zadania, więc zdanie nie może
  /// udawać, że wszystkie pracują.
  public static func spoken(_ tasks: [BackgroundTask]) -> String {
    UICopy.backgroundSpoken(tasks.map { task in
      let text = ActivityText.taskText(task)
      let kind = UICopy.backgroundKind(task.kind)
      let what = text.isEmpty ? kind : UICopy.taskNamed(kind: kind, name: text)
      return BackgroundTaskRules.waitingAgent(task) ? UICopy.backgroundTaskWaiting(what) : what
    })
  }
}

/// Plakietka „N w tle" na pigułce linii statusu: sama liczba („opis pierwszego zadania kłamał
/// przez przemilczenie"). Liczy WSZYSTKIE zadania z listy, także subagentów w postoju. Znak pracy (zielona
/// kropka) ma tylko wtedy, gdy na liście jest coś, co pracuje: sami czekający subagenci dają „1 w tle" bez
/// kropki. Obie odpowiedzi daje reguła rdzenia, plakietka tylko liczy i opisuje.
public struct BackgroundBadge: Sendable, Equatable {
  /// „3 w tle".
  public let text: String
  /// Znak pracy: na liście jest zadanie, które nie jest subagentem w postoju.
  public let working: Bool
  /// Zdanie dla czytnika: ile i co.
  public let spoken: String

  /// `nil` = na liście nic nie stoi, plakietki nie ma.
  public init?(_ session: SessionSummary) {
    guard BackgroundTaskRules.hasTasks(session.backgroundTasks) else { return nil }
    let tasks = session.backgroundTasks ?? []
    text = UICopy.backgroundBadge(tasks.count)
    working = BackgroundTaskRules.tasksKeepRowWorking(session.backgroundTasks)
    spoken = BackgroundTaskRow.spoken(tasks)
  }
}

/// Nagłówek sekcji „w tle" (panel i popover): liczba zadań i — gdy ktoś stoi w postoju — podział „2 pracują
/// · 1 czeka". Sama liczba przy postoju wprowadzałaby w błąd: „W TLE · 2" przy dwóch czekających znaczy, że nic
/// nie mieli (ta sama reguła zdejmuje wtedy kropkę z pigułki). Zera nie tworzą członu.
public struct BackgroundHeader: Sendable, Equatable {
  public let count: Int
  /// `nil`, gdy nikt nie stoi w postoju — wtedy liczba mówi całą prawdę.
  public let split: String?

  public init(_ tasks: [BackgroundTask]) {
    count = tasks.count
    let waiting = tasks.filter(BackgroundTaskRules.waitingAgent).count
    split = waiting > 0 ? UICopy.backgroundSplit(working: tasks.count - waiting, waiting: waiting) : nil
  }
}

/// Własna komenda subagenta pod jego wierszem (`BackgroundTask.ownTasks`): narzędzia komendy i czas od jej
/// startu. Puścił ją subagent, nie główny agent; przy agencie w postoju to na nią czeka.
public struct OwnTaskRow: Sendable, Equatable, Identifiable {
  /// Zadanie (subagent), pod którym komenda stoi.
  public let task: String
  /// Identyfikator komendy u tego agenta.
  public let ownId: String
  /// Komenda w jednej linii; `nil` = serwer jej treści nie zna (albo lista jest z pamięci podręcznej, która
  /// treści komend nie zapisuje) i wiersz mówi samo „komenda". Wiersz pokazuje jej skrót (`tools`).
  public let command: String?
  /// Komenda z kontraktu bez sklejania linii — do „Kopiuj komendę" (heredoc sklejony spacją byłby inną komendą).
  public let rawCommand: String?
  /// Start komendy; `nil` = serwer go nie zna i wiersz stoi bez licznika.
  public let startedAt: Date?
  /// Agent stoi w postoju, więc na tę komendę czeka: zdanie czytnika zaczyna się od „czeka na".
  public let awaited: Bool

  public var id: String { "own:\(task):task:\(ownId)" }

  init(_ own: AgentOwnTask, task: String, awaited: Bool) {
    self.task = task
    ownId = own.id
    command = Self.oneLine(own.command)
    rawCommand = command == nil ? nil : own.command
    startedAt = own.startedAt.flatMap(ServerTime.parse)
    self.awaited = awaited
  }

  /// Komenda skrócona do narzędzi (`CommandTools`); gdy skrót niczego nie rozpozna, sam jej początek (`clipped`).
  public var tools: String? { rawCommand.flatMap(CommandTools.summary) ?? command.map(CommandTools.clipped) }

  /// Tekst wiersza: narzędzia komendy, a bez komendy słowo „komenda".
  public var text: String { tools ?? UICopy.backgroundKind(.command) }

  /// Wiersz jednym zdaniem dla czytnika: „czeka na: pnpm test, od 21 minut".
  public func spoken(now: Date) -> String {
    UICopy.ownTaskSpoken(command: tools, awaited: awaited, since: startedAt, now: now)
  }

  /// Komenda wieloliniowa (heredoc, `&&` w kilku wierszach) w jednej linii: linie sklejone spacją, odstępy
  /// w środku linii zostają. Pusta komenda to brak komendy.
  static func oneLine(_ command: String?) -> String? {
    guard let command else { return nil }
    let line = command.split(whereSeparator: \.isNewline)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
      .joined(separator: " ")
    return line.isEmpty ? nil : line
  }
}

/// Linia panelu „w tle": wiersz zadania, linia własnej komendy subagenta albo linia sekcji przebiegu
/// workflow.
public enum BackgroundPanelLine: Sendable, Equatable, Identifiable {
  case task(BackgroundTaskRow)
  /// „czeka na:" nad własnymi komendami subagenta w postoju; `task` to zadanie agenta.
  case ownLabel(task: String)
  case ownTask(OwnTaskRow)
  case workflow(WorkflowLine)

  public var id: String {
    switch self {
    case let .task(row): "task:\(row.id)"
    case let .ownLabel(task): "own:\(task):label"
    case let .ownTask(row): row.id
    case let .workflow(line): line.id
    }
  }
}

/// Panel „w tle" płaską listą: pod wierszem zadania `workflow` z rozkładem stoi jego sekcja jako
/// RODZEŃSTWO (wiersz zadania łączy dzieci w jedno zdanie dla czytnika, więc sekcja pod nim byłaby
/// niema), każdy przebieg ma swoją. Tak samo stoją własne komendy subagenta: każda jest osobną linią
/// pod jego wierszem. Płaska lista ze stałymi tożsamościami trzyma kotwicę przewinięcia na widocznym
/// wierszu, gdy rozkład rośnie.
public enum BackgroundPanel {
  public static func lines(
    _ tasks: [BackgroundTask], choices: [ModelChoice] = [], expansion: WorkflowExpansion
  ) -> [BackgroundPanelLine] {
    var out: [BackgroundPanelLine] = []
    for task in tasks {
      let row = BackgroundTaskRow(task, choices: choices)
      out.append(.task(row))
      out += ownLines(task, awaited: row.waiting)
      guard let section = section(task) else { continue }
      out += section.lines(expansion).map(BackgroundPanelLine.workflow)
    }
    return out
  }

  /// Własne komendy subagenta pod jego wierszem. Przy agencie w postoju poprzedza je linia „czeka na:", bo to
  /// na nie agent czeka; przy agencie, który pracuje, stoją bez tych słów. Brak komend to brak linii: serwer
  /// chowa komendy o nieznanym losie, więc agent potrafi czekać bez listy (`docs/background-tasks.md`).
  static func ownLines(_ task: BackgroundTask, awaited: Bool) -> [BackgroundPanelLine] {
    let rows = (task.ownTasks ?? []).map { BackgroundPanelLine.ownTask(OwnTaskRow($0, task: task.id, awaited: awaited)) }
    guard awaited, !rows.isEmpty else { return rows }
    return [.ownLabel(task: task.id)] + rows
  }

  /// Fazy bieżące wszystkich przebiegów — do `WorkflowExpansion.noteCurrent`.
  public static func currentKeys(_ tasks: [BackgroundTask]) -> Set<WorkflowExpansion.Key> {
    Set(tasks.compactMap { section($0)?.currentKey })
  }

  /// Sekcję ma tylko zadanie `workflow` z rozkładem (`run` żyje, dopóki zadanie jest otwarte).
  static func section(_ task: BackgroundTask) -> WorkflowSection? {
    guard task.kind == .workflow, let run = task.run else { return nil }
    return WorkflowSection(taskId: task.id, run: run)
  }
}
