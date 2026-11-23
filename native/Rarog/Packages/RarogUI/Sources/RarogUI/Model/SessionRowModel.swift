import Foundation
import RarogContract
import RarogCore

/// Słowo i ton stanu karty listy: ton daje rdzeń, słowo — copy.
public struct RowStatus: Sendable, Equatable {
  public let text: String
  public let tone: StatusTone

  public init(_ session: SessionSummary) {
    let tone = session.statusTone
    let base = session.state == .waitingInput && session.resultSeen
      ? UICopy.idleSeen
      : UICopy.stateLabel(session.state)
    // Czy tło jest pracą, mówi reguła rdzenia, ta sama, z której rdzeń liczy ton: sam subagent w postoju
    // pracą nie jest i słowo „pracuje w tle" przy nim nie pada.
    let backgroundWork = BackgroundTaskRules.tasksKeepRowWorking(session.backgroundTasks)
    let running = session.state == .running || session.state == .starting
    // Tura skończona, a coś dalej mieli w tle: barwa pracy i dwa słowa więcej.
    text = tone == .working && !running && backgroundWork ? UICopy.backgroundWork : base
    self.tone = tone
  }
}

/// Piętro rangi karty: wyznacza wyciszenie bezczynnych. Gasnącej
/// plamy przy zmianie piętra apka nie ma.
public enum RowSection: Sendable, Equatable {
  /// Decyzja, nieodebrany wynik, awaria.
  case attention
  case working
  /// Odebrany wynik, done, nieobsługiwana.
  case idle

  init(rank: Int) {
    self = rank < 2 ? .attention : rank > 2 ? .idle : .working
  }
}

/// Wiersz płaskiej listy sesji. Czysty model — widok tylko rysuje.
public struct SessionRowModel: Sendable, Equatable, Identifiable {
  public let id: String
  /// Nazwa projektu — nigdy nie przycinana jako pierwsza (odróżnia sesje kątem oka).
  public let project: String
  /// Człon sesji (pierwsze słowa promptu); `""` = brak.
  public private(set) var label: String
  /// Sufiks `#n` przy powtórzonej parze „projekt · nazwa"; liczony od najstarszej.
  public let ordinal: Int?
  public let status: RowStatus
  /// Wpis Codexa: sam stan z herdr, cicha metka `codex`.
  public let isCodex: Bool
  /// Linia „na co czeka": `nil` = bez linii; `""` = zarezerwowana, jeszcze bez treści (karta
  /// rośnie raz, zamiast migać napisem).
  public let waiting: String?
  /// Wyciszony wiersz bezczynny: lżejszy tytuł i przygaszony atrament. Tylko piętro
  /// `.idle` (odebrany wynik, done, nieobsługiwana) i tylko przy świeżych danych.
  public let quiet: Bool
  /// Dane nieświeże (brak kontaktu z herdr): wiersz wygaszony; wygrywa z wyciszeniem.
  public let stale: Bool
  /// Wiersz bez kontaktu ze źródłem: wygaszony, zegar STOI, bez linii etapu i bez
  /// linii „na co czeka" — stan zostaje ostatni znany. Tykanie obiecywałoby, że liczba jest żywa.
  public let frozen: Bool
  /// Wiersz z listy z pamięci podręcznej, przed świeżym stanem.
  public let cached: Bool
  /// Cicha linia etapu: delegacja (subagent, workflow) albo to, co stoi w tle —
  /// nigdy zwykłe narzędzie. `nil` = bez linii, także pod pracującą kartą bez delegacji i tła: pusta
  /// linia byłaby przerwą pod agentem.
  /// Rezerwę wysokości ma tylko linia „na co czeka" (`waiting`).
  public let stage: String?
  /// Segmenty paska workflow pod pracującą kartą, także po turze przy workflow w toku; `nil` = bez paska.
  public let progress: [ProgressSegment]?
  /// Zielona kropka „w tle" przy linii etapu, gdy pod kartą nie ma paska. To ZNAK PRACY:
  /// tylko przy czymś, co pracuje. Linia z pamięci tury kropki nie ma, linia o samych subagentach
  /// w postoju („czeka: subagent · …") też nie.
  public let backgroundDot: Bool
  public let section: RowSection
  /// The dot pulses: a fresh unread result nobody has taken yet (`AppState.freshResult`), with live data. A
  /// result marked unread by hand keeps a still dot; so does a frozen row (no live source).
  public let freshResult: Bool
  /// Wiersz pod nagłówkiem projektu w drzewie: bez członu projektu — projekt niesie nagłówek.
  public let showsProject: Bool
  /// Nazwa sesji bez projektu: człon promptu, a bez niego cztery znaki identyfikatora (jak zakładka).
  private(set) var sessionName: String
  let clockKind: ListClock.Kind
  let clockSince: Date?

  /// - Parameter listStale: cała lista pochodzi z pamięci podręcznej sprzed świeżego stanu
  ///   — każdy wiersz jest wtedy w tej samej sytuacji co sesja bez kontaktu z herdr.
  /// - Parameter turnStage: ostatni etap tury z rdzenia (`AppState.turnStage`).
  /// - Parameter showsProject: `false` = wiersz drzewa projektów, tytuł bez projektu.
  /// - Parameter freshResult: `AppState.freshResult` of the session; `false` where the dot stays still.
  public init(
    _ session: SessionSummary, ordinal: Int?, listStale: Bool = false, turnStage: TurnStage? = nil,
    showsProject: Bool = true, freshResult: Bool = false
  ) {
    id = session.id
    project = session.title
    label = (session.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    self.showsProject = showsProject
    sessionName = UICopy.tabLabel(session)
    self.ordinal = ordinal
    status = RowStatus(session)
    isCodex = session.engine == .codex
    let clock = session.listClock
    clockKind = clock.kind
    clockSince = ServerTime.parse(clock.since)
    stale = session.stale == true
    cached = listStale
    frozen = stale || listStale
    // Przy danych nieświeżych linia gaśnie: dialog mógł zostać odklikany przy biurku.
    let showsWaiting = session.isWaitingForDecision && !frozen && session.outOfScope != true
    waiting = showsWaiting ? UICopy.waitingLine(session) : nil
    section = RowSection(rank: session.listRank)
    // Wyciszenie liczy PIĘTRO rangi, nie ton kropki: „do wznowienia" ma szarą
    // kropkę, ale stoi wśród awarii i zostaje w pełnym kolorze; kolejność i wyciszenie się nie rozjadą.
    quiet = section == .idle && !frozen
    self.freshResult = freshResult && !frozen
    let stageLine = Self.stageLine(session, frozen: frozen, remembered: turnStage)
    stage = stageLine.text
    progress = stageLine.progress
    backgroundDot = stageLine.dot
  }

  /// Linia etapu. Decyzję opisuje linia „na co czeka", a przy danych nieświeżych linii nie ma:
  /// byłaby zmyślona. Potem, w trakcie tury i po niej, WORKFLOW W TOKU z listy zadań w tle (otwarty
  /// przebieg, `BackgroundTaskRules.openWorkflows`): faza, nazwa i pasek z rozkładu, kropka tylko bez paska
  /// (inaczej linia przeskakiwałaby na „subagent pracuje" przy każdym subagencie głównego agenta i na „2 w tle"
  /// po turze). Pracująca karta bez niego, w tej kolejności:
  /// ŻYWA delegacja (zdanie z licznikami agentów, pasek workflow, kropka bez paska), zadania w tle, ostatni
  /// etap tury z pamięci rdzenia (bez liczników, bez paska i bez kropki — kropka znaczy „pracuje"), inaczej
  /// bez linii. Zwykłe narzędzie, myślenie i czekanie linii NIE dają: wiersz skakałby wysokością przy każdym
  /// kroku agenta, a z pamięcią linia raz pokazana stoi do końca tury. Karta po turze
  /// z zadaniem w tle mówi, co tam stoi.
  ///
  /// Kropka przy linii zadań w tle to znak pracy i daje go reguła rdzenia
  /// (`BackgroundTaskRules.tasksKeepRowWorking`), nie sama obecność listy: przy samych subagentach
  /// w postoju linia mówi „czeka: subagent · …" i kropki nie ma.
  static func stageLine(
    _ session: SessionSummary, frozen: Bool, remembered: TurnStage? = nil
  ) -> (text: String?, progress: [ProgressSegment]?, dot: Bool) {
    if frozen || session.isWaitingForDecision { return (nil, nil, false) }
    let working = BackgroundTaskRules.tasksKeepRowWorking(session.backgroundTasks)
    if let workflow = ActivityText.liveWorkflow(BackgroundTaskRules.openWorkflows(session.backgroundTasks)) {
      let line = ActivityText.workflowStage(workflow)
      // Kropka pilnuje PASKA jak przy żywej delegacji; otwarty przebieg jest pracą, więc `working` stoi.
      return (line.text, line.segments, line.segments == nil && working)
    }
    let tasks = session.backgroundTasks ?? []
    // Zdanie o liście; puste = na liście nic nie stoi.
    let background = ActivityText.backgroundText(tasks)
    if session.state == .running || session.state == .starting {
      if let wire = session.activity, wire.kind == .tool, wire.delegation != nil {
        let activity = ViewActivity(wire)
        let segments = ActivityText.workflowSegments(activity)
        // Kropka pilnuje PASKA: delegacja bez paska dostaje znak życia w tle, z paskiem — nie.
        return (ActivityText.cardText(activity, tasks: tasks), segments, segments == nil)
      }
      if !background.isEmpty { return (background, nil, working) }
      let text = remembered.map(ActivityText.rememberedText) ?? ""
      return (text.isEmpty ? nil : text, nil, false)
    }
    return background.isEmpty ? (nil, nil, false) : (background, nil, working)
  }

  /// The same row under a name the server has not confirmed yet (`SessionRenamer.pendingName`).
  public func renamed(_ name: String) -> SessionRowModel {
    var row = self
    row.label = name
    row.sessionName = name
    return row
  }

  /// Tytuł karty: „projekt · nazwa #n".
  public var title: String { project + titleTail }

  /// Tytuł bez projektu: „ · nazwa #n" (`""` przy samym projekcie). Widok rysuje go lżej niż projekt,
  /// żeby projekt dało się wyłowić kątem oka.
  public var titleTail: String {
    var out = label.isEmpty ? "" : " · \(label)"
    if let ordinal { out += " #\(ordinal)" }
    return out
  }

  /// Tytuł wiersza drzewa: sama nazwa sesji z `#n`; bez członu promptu — `#abcd` jak zakładka.
  public var treeTitle: String {
    ordinal.map { "\(sessionName) #\($0)" } ?? sessionName
  }

  /// Chwila, od której liczy zegar karty: żywa karta — teraz; zamrożona — chwila zamrożenia
  /// (`frozenAt` trzyma widok od pierwszego pokazania w tym stanie). Odczyt zostaje uczciwy,
  /// przestaje tylko udawać, że jest mierzony teraz.
  public func clockNow(_ now: Date, frozenAt: Date?) -> Date {
    frozen ? (frozenAt ?? now) : now
  }

  /// Zegar karty na ekranie: sam czas („4 min") przy każdym rodzaju zegara (decyzja: od kiedy czeka; praca: tura;
  /// reszta: cisza). Stan obok mówi już „czeka na zgodę", więc linia to „czeka na zgodę · 4 min" bez drugiego
  /// „czeka". Czytnik dostaje „czeka od 4 minut" (`spoken`), bo słyszy czas osobno od stanu.
  public func clock(now: Date) -> String {
    guard let since = clockSince else { return "" }
    return RelativeTime.short(since: since, now: now)
  }

  /// Wiersz jednym zdaniem dla VoiceOver: tytuł, silnik, stan, czas, na co czeka.
  public func spoken(now: Date) -> String {
    var parts = label.isEmpty ? [project] : [project, label]
    if let ordinal { parts.append(UICopy.ordinalSpoken(ordinal)) }
    if isCodex { parts.append(UICopy.codexSpoken) }
    parts.append(status.text)
    if let since = clockSince {
      let value = RelativeTime.spokenSince(since: since, now: now)
      parts.append(clockKind == .waiting ? UICopy.cardWaitClock(value) : UICopy.sinceSpoken(value))
    }
    if let waiting, !waiting.isEmpty { parts.append(waiting) }
    if let stage, !stage.isEmpty { parts.append(stage) }
    if stale { parts.append(UICopy.staleSpoken) } else if cached { parts.append(UICopy.cachedRowSpoken) }
    return UICopy.list(parts, .comma)
  }
}

extension ActivityText {
  /// Linia z pamięci tury: ostatnia delegacja albo zadania w tle tej tury, BEZ liczników agentów,
  /// fazy i paska — liczby z pamięci kłamałyby, gdy przebieg już się skończył. Ta sama forma co na żywo:
  /// „subagent: opis", „workflow: nazwa", „w tle: komenda · pnpm test"; kilka zadań — same rodzaje.
  static func rememberedText(_ stage: TurnStage) -> String {
    switch stage {
    case let .delegation(wire, tasks):
      let activity = ViewActivity(wire)
      let lead = copy(activity).lead
      guard delegationForm(activity) == .subagent else { return lead }
      // Pojedynczy subagent: „subagent pracuje" kłamałoby po jego końcu — zostaje rodzaj i opis.
      // Opis z zadania bierze ta sama reguła co na żywo: agent, który wtedy pracował, nie stojący.
      let description = wire.summary.flatMap { $0.isEmpty ? nil : $0 }
        ?? tasks.lazy.filter(BackgroundTaskRules.workingAgent).map(taskText).first { !$0.isEmpty }
        ?? ""
      return description.isEmpty ? UICopy.activitySubagentShort : UICopy.subagentLead(description)
    case let .background(tasks):
      guard let first = tasks.first else { return "" }
      if tasks.count == 1 {
        let lead = UICopy.backgroundLead(UICopy.backgroundKind(first.kind))
        return UICopy.list([lead, taskText(first)].filter { !$0.isEmpty }, .dot)
      }
      // Rodzaje bez powtórzeń, w kolejności zadań — po rodzaju, nie po jego słowie.
      var kinds: [BackgroundTaskKind] = []
      for task in tasks where !kinds.contains(task.kind) { kinds.append(task.kind) }
      return UICopy.backgroundLead(UICopy.list(kinds.map(UICopy.backgroundKind), .comma))
    }
  }
}

/// The list row's selection plate and full ink. Beside the detail (iPad, wide window) it marks the session open
/// beside the list. In the stack (iPhone, narrow window) the list is on screen only without a session, so it marks
/// where the human just was: the last opened session the app still knows (`RarogNavigation.lastVisitedSession`).
/// While a session is being pushed, the selected one wins over the history: the visit reaches the history one view
/// update after the tap, and the plate must not jump to the previous row for that pass. The pop clears the selection
/// while the history already holds the same session, so the plate stays put through the back animation.
public enum ListRowHighlight {
  public static func isHighlighted(rowId: String, selectedId: String?, lastVisitedId: String?, besideDetail: Bool) -> Bool {
    if besideDetail { return rowId == selectedId }
    return rowId == (selectedId ?? lastVisitedId)
  }

  /// Własny pierścień fokusu klawiatury: systemowe halo komórki rysowałoby się na
  /// niebiesko wokół klikniętego agenta i zostawało tam. Fokus na zaznaczonym wierszu wskazuje
  /// tło `surface2`; pierścień dostaje tylko wiersz z fokusem BEZ zaznaczenia — zaznaczenie nie idzie za
  /// fokusem, więc strzałki ruszają sam pierścień, a wybór z zakładek albo
  /// skrótem przesuwa zaznaczenie, nie fokus.
  public static func showsFocusRing(focused: Bool, highlighted: Bool) -> Bool {
    focused && !highlighted
  }
}

extension DiagnosticsTrace {
  /// Ślad zmiany zaznaczenia z listy: „lista: zaznaczenie …-w1-p1 → …-w1-p2, 40 ms po zmianie
  /// ekranu". Odbicie po Cmd+L to zmiana z listy tuż po zmianie ekranu, z powrotem na sesję sprzed skrótu.
  /// Same końcówki identyfikatorów sesji — bez tytułów i treści.
  public static func listSelection(from: String?, to: String?, sinceScreenChange: TimeInterval?) -> String {
    let when = sinceScreenChange.map { "\(max(0, Int(($0 * 1000).rounded()))) ms po zmianie ekranu" } ?? "pierwszy ekran"
    return "lista: zaznaczenie \(shortSessionId(from)) → \(shortSessionId(to)), \(when)"
  }

  /// Ostatnie 6 znaków identyfikatora sesji (`nic` = brak zaznaczenia).
  static func shortSessionId(_ id: String?) -> String {
    guard let id else { return "nic" }
    return id.count <= 6 ? id : "…\(id.suffix(6))"
  }
}

extension AppState {
  /// Wiersze agentów w kolejności rdzenia, płasko, z prefiksem projektu: odczyt wyniku nie przesuwa wiersza
  /// (`listOrder`), linia etapu z pamięci tury. Lista w apce to drzewo projektów (`projectTreeRows`);
  /// ten widok płaski służy testom modelu wiersza.
  public var sessionRows: [SessionRowModel] {
    let ordinals = duplicateOrdinals
    return listOrder.map {
      SessionRowModel(
        $0, ordinal: ordinals[$0.id], listStale: listStale, turnStage: turnStage[$0.id], freshResult: freshResult($0))
    }
  }
}
