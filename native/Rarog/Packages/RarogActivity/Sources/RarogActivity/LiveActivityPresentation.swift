import Foundation
import RarogContract

/// What the Live Activity tile says: pure copy built from the aggregate state (a board with phase bars).
///
/// The tile stays up to 8 h on the lock screen, so its copy is built ONLY from state fields: counters, plan
/// limits, Mac load, project, workflow run name and phase number with title. The state has no question text,
/// command, permission tool, session label or working time (contract `LiveActivityContentState`), so the tile
/// cannot show them: it says how many wait, not on what.
public struct LiveActivityPresentation: Sendable, Equatable {
  /// Kolor stanu kafla (obwódka wyspy, wyspa minimalna): bursztyn = coś czeka na decyzję, zieleń = praca
  /// albo przebieg w tle, szarość = cisza.
  public enum Tone: Sendable, Equatable {
    case waiting
    case working
    case quiet
  }

  /// Limit planu Claude: okno, etykieta, procent i próg koloru.
  public struct Limit: Sendable, Equatable {
    public enum Window: Sendable, Equatable {
      case fiveHour
      case weekly
    }

    /// Próg koloru: od ``highLimit`` bursztyn, od ``criticalLimit`` czerwień; niżej — kolor tekstu.
    public enum Level: Sendable, Equatable {
      case normal
      case high
      case critical
    }

    public let window: Window
    /// „limit 5h" / „limit 7d" (ekran blokady).
    public let label: String
    /// „5h" / „7d" (wyspa — róg obok kamery jest wąski).
    public let shortLabel: String
    public let percent: Int
    /// „42%".
    public let percentText: String
    /// Wypełnienie paska 0…1.
    public let fraction: Double
    public let level: Level
  }

  /// Jeden przebieg workflow: tytuł, postęp słowami i pasek z segmentem na fazę planu.
  public struct WorkflowRow: Sendable, Equatable {
    /// „rarog · audyt-ux" (ekran blokady).
    public let title: String
    /// „audyt-ux" (wyspa — projekt się nie mieści).
    public let name: String
    /// „faza 2/4 · Weryfikacja", „faza 2/4" (tytuł pusty albo za długi), bez planu faz — „agenci 3/7".
    public let progress: String
    /// Wypełnienie segmentów 0…1 w kolejności skryptu (bez planu — jeden segment całości).
    public let segments: [Double]
    /// Indeks segmentu bieżącej fazy (jaśniejszy tor); `nil` bez planu faz.
    public let current: Int?
    /// Stan każdej fazy, po jednym na segment: pasek rysuje wtedy segmenty w kolorze stanu, bez
    /// wypełnienia i bez toru fazy bieżącej. `nil` (przebieg bez planu albo serwer bez pola) = pasek z procentów.
    public let states: [LiveActivityContentState.PhaseState]?
    /// Postęp całości 0…1 (średnia segmentów) — pierścień zwiniętej wyspy.
    public let overall: Double
    /// Zdanie dla VoiceOvera: „rarog, audyt-ux: faza 2 z 4, Weryfikacja", przy ``states`` ze stanem każdej fazy po
    /// numerze („…; faza 1 skończona, faza 2 w toku, faza 3 jeszcze nie ruszyła").
    let spoken: String
  }

  /// Jedna metryka Maca: „CPU" + „35%" i poziom progu (`RarogContract.MacMetric` — te same progi co stopka
  /// listy apki): procent pogrubiony, w kolorze zwykłego atramentu, bursztynu albo czerwieni.
  public struct MacMetric: Sendable, Equatable {
    public let label: String
    public let value: String
    /// Wypełnienie słupka 0…1 (ekran blokady).
    public let fraction: Double
    public let level: MacLoadLevel
  }

  public let tone: Tone
  /// Liczniki tablicy, każdy ze słowem odmienionym po liczebniku („2" + „czekają", „1" + „skończyła").
  public let waiting: Int
  public let working: Int
  public let finished: Int
  public let waitingWord: String
  public let workingWord: String
  public let finishedWord: String
  /// Liczba w wyspie minimalnej: czekające, a bez nich pracujące; 0 = cisza.
  public let count: Int
  /// Limity w stałej kolejności (5h, 7d), tylko okna obecne w stanie.
  public let limits: [Limit]
  /// Do dwóch przebiegów workflow (kolejność serwera: najstarszy pierwszy).
  public let workflows: [WorkflowRow]
  /// „+1 workflow", gdy przebiegów jest więcej niż na kaflu; inaczej `nil`.
  public let more: String?
  /// Metryki Maca obecne w stanie (CPU, RAM, dysk — w tej kolejności).
  public let mac: [MacMetric]
  /// „Mac  CPU 35% · RAM 70% · dysk 60%" (na VPS-ie „VPS  …”); `nil` bez żadnej metryki.
  public let macLine: String?
  /// Zdanie ciszy (0 czeka, 0 pracuje, 0 skończyło, bez przebiegów) w miejscu workflow; poza ciszą `nil`.
  public let quietNote: String?
  /// Postęp całości pierwszego przebiegu (pierścień zwiniętej wyspy); `nil` bez przebiegów.
  public let ring: Double?
  /// Adres tapnięcia w tło kafla i w zwiniętą wyspę (`widgetURL`): lista agentów.
  /// Liczby mają własne adresy (``jumpLink(_:)``).
  public let link: URL
  /// Zdanie dla VoiceOvera (kafel na ekranie blokady czyta się jednym ciągiem).
  public let spoken: String
  /// Chwila wyliczenia stanu — źródło zdania o nieświeżych danych.
  public let updatedAt: Date

  /// Tytuł fazy dłuższy niż to zostaje samym numerem (jak linia karty listy, `UICopy.phaseTitleMax`).
  public static let phaseTitleMax = 24
  /// Limit od tylu procent jest bursztynowy (blisko końca okna). Progi kafla 60/90 (prośba
  /// użytkownika: „czerwony powinien być od 90%”) — panel limitów apki ma własne 60/85.
  public static let highLimit = 60
  /// Limit od tylu procent jest czerwony.
  public static let criticalLimit = 90
  /// Treść ``quietNote``.
  static var quietNoteText: String { L("liveActivity.quietNote") }

  /// Człony listy złączone separatorem z katalogu: kropka środkowa na kaflu, przecinek w zdaniu
  /// czytnika, spacja między całymi zdaniami.
  enum ListSeparator {
    case dot
    case comma
    case sentence
  }

  static func list(_ items: [String], _ separator: ListSeparator) -> String {
    let glue =
      switch separator {
      case .dot: L("liveActivity.list.dot")
      case .comma: L("liveActivity.list.comma")
      case .sentence: L("liveActivity.list.sentence")
      }
    return items.joined(separator: glue)
  }

  /// „42%” — procent z katalogu (miejsce i odstęp znaku procentu to rzecz języka).
  static func percent(_ value: Int) -> String { L("liveActivity.percent", value) }
  /// Początek linii limitów na ekranie blokady („usage   5h 42%   7d 81%”).
  public static var usageLead: String { L("liveActivity.usageLead") }

  /// `machine` = słowo maszyny serwera z atrybutów aktywności (``RarogActivityAttributes/machine``).
  public init(_ state: LiveActivityContentState, machine: ServerMachine) {
    let waiting = max(0, state.waiting)
    let working = max(0, state.working)
    let finished = max(0, state.finished)
    let workflows = (state.workflows ?? []).map(Self.row)
    self.waiting = waiting
    self.working = working
    self.finished = finished
    waitingWord = L("liveActivity.waitingWord", waiting)
    workingWord = L("liveActivity.workingWord", working)
    finishedWord = L("liveActivity.finishedWord", finished)
    tone = waiting > 0 ? .waiting : working > 0 || !workflows.isEmpty ? .working : .quiet
    count = waiting > 0 ? waiting : working
    limits = Self.limits(state.limits)
    self.workflows = workflows
    more = state.moreWorkflows.flatMap { $0 > 0 ? L("liveActivity.moreWorkflows", $0) : nil }
    mac = Self.mac(state.mac)
    let metrics = Self.list(mac.map { L("liveActivity.macLine.metric", $0.label, $0.value) }, .dot)
    macLine = mac.isEmpty ? nil : machine == .mac ? L("liveActivity.macLine", metrics) : L("liveActivity.macLine.vps", metrics)
    let quiet = waiting == 0 && working == 0 && finished == 0 && workflows.isEmpty
    quietNote = quiet ? Self.quietNoteText : nil
    ring = workflows.first?.overall
    link = Self.listLink
    updatedAt = Date(timeIntervalSince1970: TimeInterval(state.updatedEpoch))
    spoken = Self.spoken(
      waiting: waiting, working: working, finished: finished, quiet: quiet, workflows: workflows,
      more: state.moreWorkflows ?? 0, limits: limits, mac: mac, machine: machine)
  }

  /// Limit danego okna, gdy jest w stanie.
  public func limit(_ window: Limit.Window) -> Limit? {
    limits.first { $0.window == window }
  }

  // MARK: - Copy

  static func limits(_ limits: LiveActivityContentState.Limits?) -> [Limit] {
    var out: [Limit] = []
    if let value = limits?.fiveHour { out.append(limit(.fiveHour, L("liveActivity.limit.fiveHour"), value)) }
    if let value = limits?.weekly { out.append(limit(.weekly, L("liveActivity.limit.weekly"), value)) }
    return out
  }

  static func limit(_ window: Limit.Window, _ short: String, _ raw: Int) -> Limit {
    let percent = min(100, max(0, raw))
    let level: Limit.Level = percent >= criticalLimit ? .critical : percent >= highLimit ? .high : .normal
    return Limit(
      window: window, label: L("liveActivity.limit.label", short), shortLabel: short, percent: percent, percentText: Self.percent(percent),
      fraction: Double(percent) / 100, level: level)
  }

  static func mac(_ mac: LiveActivityContentState.Mac?) -> [MacMetric] {
    guard let mac else { return [] }
    let metrics: [(String, RarogContract.MacMetric)] = [(L("liveActivity.mac.cpu"), .cpu), (L("liveActivity.mac.ram"), .ram), (L("liveActivity.mac.disk"), .disk)]
    return metrics.compactMap { label, metric in
      mac.value(metric).map { raw in
        let percent = min(100, max(0, raw))
        return MacMetric(
          label: label, value: Self.percent(percent), fraction: Double(percent) / 100, level: macLevel(metric, percent))
      }
    }
  }

  /// Poziom metryki słowem dla czytnika — próg, który oko widzi kolorem i wagą.
  /// Progi Maca NA KAFLU: CPU i RAM od 60 % bursztyn, od 80 % czerwień,
  /// dysk od 80 % i 90 %. Stopka listy apki zostaje przy progach kontraktu (`RarogContract.MacMetric.level`).
  static func macLevel(_ metric: RarogContract.MacMetric, _ percent: Int) -> MacLoadLevel {
    let (warning, critical) = metric == .disk ? (80, 90) : (60, 80)
    return percent >= critical ? .critical : percent >= warning ? .warning : .normal
  }

  static func levelWord(_ level: MacLoadLevel) -> String? {
    switch level {
    case .normal: nil
    case .warning: L("liveActivity.levelWord.warning")
    case .critical: L("liveActivity.levelWord.critical")
    }
  }

  static func row(_ workflow: LiveActivityContentState.Workflow) -> WorkflowRow {
    let segments = workflow.segments.map { Double(min(100, max(0, $0))) / 100 }
    let progress: String
    let spokenProgress: String
    var current: Int?
    if let phase = workflow.phase {
      let title = phase.title.trimmingCharacters(in: .whitespacesAndNewlines)
      let named = !title.isEmpty && title.count <= phaseTitleMax
      progress = named
        ? L("liveActivity.row.phase.titled", phase.index, phase.count, title) : L("liveActivity.row.phase", phase.index, phase.count)
      spokenProgress = named
        ? L("liveActivity.row.phaseSpoken.titled", phase.index, phase.count, title)
        : L("liveActivity.row.phaseSpoken", phase.index, phase.count)
      current = segments.indices.contains(phase.index - 1) ? phase.index - 1 : nil
    } else {
      // Bez planu faz (skrypt bez `meta.phases`): fazy z samych tagów miałyby rosnący mianownik, więc
      // kafel liczy agentów.
      progress = L("liveActivity.row.agents", workflow.done, workflow.agents)
      spokenProgress = L("liveActivity.row.agentsSpoken", workflow.done, workflow.agents)
    }
    // Stan faz tylko przy planie i po jednym na segment (kontrakt `LiveActivityContentState.Workflow.states`).
    let states = workflow.phase != nil && workflow.states?.count == segments.count ? workflow.states : nil
    let spoken =
      if let states {
        L(
          "liveActivity.row.spoken.states", workflow.project, workflow.name, spokenProgress,
          list(states.enumerated().map { phaseStateSpoken($0.offset + 1, $0.element) }, .comma))
      } else {
        L("liveActivity.row.spoken", workflow.project, workflow.name, spokenProgress)
      }
    return WorkflowRow(
      title: L("liveActivity.row.title", workflow.project, workflow.name), name: workflow.name, progress: progress,
      segments: segments, current: current, states: states,
      overall: segments.isEmpty ? 0 : segments.reduce(0, +) / Double(segments.count), spoken: spoken)
  }

  /// „faza 2 w toku” — stan fazy słowem dla czytnika (stan nie stoi samym kolorem paska).
  static func phaseStateSpoken(_ number: Int, _ state: LiveActivityContentState.PhaseState) -> String {
    switch state {
    case .pending: L("liveActivity.row.phaseStateSpoken.pending", number)
    case .running: L("liveActivity.row.phaseStateSpoken.running", number)
    case .done: L("liveActivity.row.phaseStateSpoken.done", number)
    }
  }

  static func spoken(
    waiting: Int, working: Int, finished: Int, quiet: Bool, workflows: [WorkflowRow], more: Int, limits: [Limit],
    mac: [MacMetric], machine: ServerMachine
  ) -> String {
    // Każdy człon to całe zdanie z kropką z katalogu (`liveActivity.sentence`); zdania łączy separator z katalogu.
    var parts: [String] = []
    if quiet {
      // Czytnik słyszy to samo zdanie ciszy co oko; na początku zdania osobny klucz.
      parts.append(L("liveActivity.spoken.quiet"))
      parts.append(L("liveActivity.spoken.quietNote"))
    } else {
      var line = [waiting == 0 ? L("liveActivity.spoken.nothingWaiting") : L("liveActivity.spoken.waiting", waiting)]
      if working > 0 { line.append(L("liveActivity.spoken.working", working)) }
      if finished > 0 { line.append(L("liveActivity.spoken.finished", finished)) }
      parts.append(list(line, .comma))
    }
    parts += workflows.map(\.spoken)
    if more > 0 { parts.append(L("liveActivity.spoken.moreWorkflows", more)) }
    if !limits.isEmpty {
      let windows = limits.map {
        $0.window == .fiveHour ? L("liveActivity.spoken.limit.fiveHour", $0.percent) : L("liveActivity.spoken.limit.weekly", $0.percent)
      }
      parts.append(L("liveActivity.spoken.limits", list(windows, .comma)))
    }
    if !mac.isEmpty {
      let metrics = mac.map { metric in
        levelWord(metric.level).map { L("liveActivity.spoken.metric.level", metric.label, metric.value, $0) }
          ?? L("liveActivity.spoken.metric", metric.label, metric.value)
      }
      let joined = list(metrics, .comma)
      parts.append(machine == .mac ? L("liveActivity.spoken.mac", joined) : L("liveActivity.spoken.mac.vps", joined))
    }
    return list(parts.map { L("liveActivity.sentence", $0) }, .sentence)
  }

  /// Zdanie dla VoiceOvera z uwzględnieniem nieświeżości: przy `isStale` czytnik słyszy to samo
  /// ostrzeżenie co oko („nieaktualne · stan z HH:MM" pełnym zdaniem — osobny klucz, nie podmiana w tekście).
  public func spokenLabel(isStale: Bool, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current) -> String {
    guard isStale else { return spoken }
    return L("liveActivity.spokenLabel.stale", spoken, CopyDate.clock(updatedAt, timeZone: timeZone, locale: locale))
  }

  /// Zdanie kafla, gdy dane są starsze niż `stale-date` (serwer nie dosłał aktualizacji przez 15 min):
  /// „nieaktualne · stan z 10:42". Godzina bezwzględna, nie „sprzed N min": kafel bez aktualizacji
  /// nie przelicza się sam, więc liczba minut zastygłaby i kłamała. Godzina według regionu (`CopyDate.clock`).
  public static func staleNote(updatedAt: Date, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current) -> String {
    L("liveActivity.staleNote", CopyDate.clock(updatedAt, timeZone: timeZone, locale: locale))
  }

  // MARK: - Adres tapnięcia

  /// Schemat adresów apki (`CFBundleURLTypes`); rdzeń czyta je w `PushRouting.target(url:)`.
  public static let scheme = "rarog"

  /// Liczba na kaflu — rodzaj sesji, do której prowadzi tap (`rarog://jump/<rodzaj>`).
  public enum Tally: String, Sendable, CaseIterable {
    case waiting
    case working
    case finished
  }

  /// Tło kafla i zwinięta wyspa: lista agentów.
  public static let listLink = URL(string: "\(scheme)://list")!

  /// Liczba większa od zera (`Link` nad licznikiem): `rarog://jump/<rodzaj>`. Sesję wybiera apka przy otwarciu —
  /// pierwszą tego rodzaju w kolejności listy, a bez takiej otwiera listę. Adres rodzaju, nie sesji: kafel bywa
  /// spóźniony, a sesja zapisana w adresie mogłaby już nie czekać.
  public static func jumpLink(_ tally: Tally) -> URL {
    URL(string: "\(scheme)://jump/\(tally.rawValue)")!
  }
}
