// Stan treści zbiorczej Live Activity — lustro `liveActivityContentStateSchema`
// z `shared/src/rest.ts`. Ten typ jest `ContentState` aktywności: ActivityKit dekoduje go SAM
// z `aps.content-state` w ładunku APNs (przez `init(from:)` niżej) i koduje przy lokalnym starcie
// (synteza `Encodable`), więc:
// - czasy to całkowite sekundy epoki Unix, nie `Date` (domyślny `JSONDecoder` czyta `Date` jako
//   sekundy od 2001 roku);
// - kodowanie POMIJA pola `nil` (synteza `Encodable` pisze opcjonalne `encodeIfPresent`): kontrakt zna
//   brak pola, nie `null`, a stan zakodowany z powrotem ma być tym samym JSON-em co ramka (strażnik
//   `ApnsFramesTests.encodesBackToFrame`);
// - wartość spoza zakresu schematu (procent > 100, faza większa niż liczba faz, za długi łańcuch)
//   ODRZUCA cały stan — tak samo jak zod po stronie serwera; nieznane pola są ignorowane; wyjątek to stan faz
//   przebiegu (`states`): błędny znika w całości, a reszta stanu zostaje;
// - typ NIE MA pól na treść pytania, komendę, wynik, narzędzie zgody ani etykietę sesji — wisi do 8 h
//   na ekranie blokady, więc mówi, ile czeka, a nie na co.

/// `aps.content-state` zbiorczej Live Activity urządzenia.
public struct LiveActivityContentState: Sendable, Hashable, Codable {
  /// `LIVE_ACTIVITY_TEXT_MAX`: sufit łańcucha (projekt, nazwa przebiegu, tytuł fazy) w jednostkach UTF-16 —
  /// tak liczy `z.string().max()`.
  public static let textMax = 60
  /// `LIVE_ACTIVITY_WORKFLOWS_MAX`: najwięcej przebiegów na kaflu; reszta to sama liczba (`moreWorkflows`).
  public static let workflowsMax = 2
  /// `LIVE_ACTIVITY_SEGMENTS_MAX`: najwięcej segmentów paska jednego przebiegu (i faz planu).
  public static let segmentsMax = 12

  /// Sesje stojące na decyzji (zgoda, pytanie).
  public var waiting: Int
  /// Sesje w pracy.
  public var working: Int
  /// Sesje po turze z nieodebranym wynikiem (lustro `isFinished` PWA).
  public var finished: Int
  /// Sesja wiodąca — WYŁĄCZNIE cel tapnięcia; `nil` = nic nie czeka i nic nie pracuje.
  public var top: Top?
  /// Do ``workflowsMax`` przebiegów workflow z rozkładem; `nil` = żaden (pusta tablica nie istnieje).
  public var workflows: [Workflow]?
  /// Ile przebiegów nie zmieściło się w ``workflows`` (≥ 1, inaczej pola nie ma).
  public var moreWorkflows: Int?
  /// Limity planu Claude w procentach; `nil` = brak żywego okna.
  public var limits: Limits?
  /// Obciążenie Maca w procentach zajętych; `nil` = brak odczytu.
  public var mac: Mac?
  /// Chwila wyliczenia stanu (sekundy epoki).
  public var updatedEpoch: Int

  /// Sesja wiodąca (cel tapnięcia). `termId` = wpis Codexa w terminalu Raroga (tap prowadzi do terminala).
  public struct Top: Sendable, Hashable, Codable {
    public var sessionId: String
    public var termId: String?

    enum CodingKeys: String, CodingKey { case sessionId, termId }

    public init(sessionId: String, termId: String? = nil) {
      self.sessionId = sessionId
      self.termId = termId
    }

    public init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      sessionId = try c.nonEmpty(.sessionId)
      let term: String? = try c.optional(.termId)
      if let term, !WireFormat.isTerminalId(term) {
        throw contractViolation(c.codingPath + [CodingKeys.termId], "termId spoza kształtu TERM_ID_RE")
      }
      termId = term
    }
  }

  /// Bieżąca faza przebiegu z PLANEM faz: „faza `index`/`count` `title`" (numer od 1, jak copy PWA).
  public struct Phase: Sendable, Hashable, Codable {
    public var index: Int
    public var count: Int
    /// Pusty, gdy faza nie ma tytułu — wtedy copy kończy się na numerze.
    public var title: String

    enum CodingKeys: String, CodingKey { case index, count, title }

    public init(index: Int, count: Int, title: String) {
      self.index = index
      self.count = count
      self.title = title
    }

    public init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      index = try c.required(.index)
      count = try c.required(.count)
      title = try c.text(.title, allowEmpty: true)
      guard index >= 1, (1...LiveActivityContentState.segmentsMax).contains(count), index <= count else {
        throw contractViolation(c.codingPath, "faza poza 1…liczba faz albo liczba faz poza 1…12")
      }
    }
  }

  /// Stan fazy planu na pasku kafla (`liveActivityPhaseStateSchema`): `pending` = żaden agent
  /// fazy nie ruszył, `running` = ktoś w niej jeszcze pracuje, `done` = wszyscy, którzy ruszyli, skończyli.
  public enum PhaseState: String, Sendable, Hashable, Codable, CaseIterable {
    case pending, running, done
  }

  /// Jeden przebieg workflow na kaflu. `name` = nazwa skryptu (`workflowName`), nigdy opis; `agents`/`done` =
  /// agenci, którzy ruszyli i skończyli; `segments` = wypełnienie każdej fazy w procentach, w kolejności
  /// skryptu — przy planie faz tyle, ile faz, bez planu jeden segment całości i bez `phase`. `states` = stan
  /// każdej fazy (tylko przy `phase`, po jednym na segment); `nil` = kafel rysuje pasek z samych procentów.
  public struct Workflow: Sendable, Hashable, Codable {
    public var sessionId: String
    public var project: String
    public var name: String
    public var agents: Int
    public var done: Int
    public var phase: Phase?
    public var segments: [Int]
    public var states: [PhaseState]?

    enum CodingKeys: String, CodingKey { case sessionId, project, name, agents, done, phase, segments, states }

    public init(
      sessionId: String, project: String, name: String, agents: Int, done: Int, phase: Phase? = nil, segments: [Int],
      states: [PhaseState]? = nil
    ) {
      self.sessionId = sessionId
      self.project = project
      self.name = name
      self.agents = agents
      self.done = done
      self.phase = phase
      self.segments = segments
      self.states = states
    }

    public init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      sessionId = try c.nonEmpty(.sessionId)
      project = try c.text(.project, allowEmpty: false)
      name = try c.text(.name, allowEmpty: false)
      agents = try c.required(.agents)
      done = try c.required(.done)
      guard agents >= 0, done >= 0, done <= agents else {
        throw contractViolation(c.codingPath, "agenci przebiegu: ujemni albo skończonych więcej niż agentów")
      }
      phase = try c.optional(.phase)
      segments = try c.required(.segments)
      guard (1...LiveActivityContentState.segmentsMax).contains(segments.count) else {
        throw contractViolation(c.codingPath + [CodingKeys.segments], "segmentów poza 1…12")
      }
      for (offset, value) in segments.enumerated() where !LiveActivityContentState.isPercent(value) {
        throw contractViolation(
          c.codingPath + [CodingKeys.segments, IndexKey(offset)], "wypełnienie segmentu poza 0…100")
      }
      // Pasek planu ma segment na KAŻDĄ fazę — inaczej „faza 2/4" stałaby nad trzema segmentami.
      if let phase, phase.count != segments.count {
        throw contractViolation(c.codingPath + [CodingKeys.segments], "segment na każdą fazę planu")
      }
      // Stan faz to dodatek do wyglądu: pole spoza kontraktu znika w całości, a kafel wraca do pasków
      // z samych procentów — nie odrzucamy stanu, bo przyszła wartość nie może zamrozić kafla.
      let states = c.phaseStates(.states)
      self.states = phase != nil && states?.count == segments.count ? states : nil
    }
  }

  /// Limity planu Claude w procentach (okno 5 h i tydzień); brak pola = brak żywego okna.
  public struct Limits: Sendable, Hashable, Codable {
    public var fiveHour: Int?
    public var weekly: Int?

    enum CodingKeys: String, CodingKey { case fiveHour, weekly }

    public init(fiveHour: Int? = nil, weekly: Int? = nil) {
      self.fiveHour = fiveHour
      self.weekly = weekly
    }

    public init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      fiveHour = try c.percent(.fiveHour)
      weekly = try c.percent(.weekly)
    }
  }

  /// Obciążenie Maca w procentach ZAJĘTYCH, zaokrąglone do 5 (`server/src/mac-stats.ts`).
  public struct Mac: Sendable, Hashable, Codable {
    public var cpu: Int?
    public var ram: Int?
    public var disk: Int?

    enum CodingKeys: String, CodingKey { case cpu, ram, disk }

    public init(cpu: Int? = nil, ram: Int? = nil, disk: Int? = nil) {
      self.cpu = cpu
      self.ram = ram
      self.disk = disk
    }

    public init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      cpu = try c.percent(.cpu)
      ram = try c.percent(.ram)
      disk = try c.percent(.disk)
    }
  }

  enum CodingKeys: String, CodingKey {
    case waiting, working, finished, top, workflows, moreWorkflows, limits, mac, updatedEpoch
  }

  public init(
    waiting: Int, working: Int, finished: Int, top: Top? = nil, workflows: [Workflow]? = nil,
    moreWorkflows: Int? = nil, limits: Limits? = nil, mac: Mac? = nil, updatedEpoch: Int
  ) {
    self.waiting = waiting
    self.working = working
    self.finished = finished
    self.top = top
    self.workflows = workflows
    self.moreWorkflows = moreWorkflows
    self.limits = limits
    self.mac = mac
    self.updatedEpoch = updatedEpoch
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    waiting = try c.required(.waiting)
    working = try c.required(.working)
    finished = try c.required(.finished)
    guard waiting >= 0, working >= 0, finished >= 0 else {
      throw contractViolation(c.codingPath, "licznik sesji ujemny")
    }
    top = try c.optional(.top)
    workflows = try c.optional(.workflows)
    if let workflows, !(1...Self.workflowsMax).contains(workflows.count) {
      throw contractViolation(c.codingPath + [CodingKeys.workflows], "przebiegów poza 1…2 (brak = pole nieobecne)")
    }
    moreWorkflows = try c.optional(.moreWorkflows)
    if let moreWorkflows, moreWorkflows < 1 {
      throw contractViolation(c.codingPath + [CodingKeys.moreWorkflows], "„+N” od 1 (zero = pole nieobecne)")
    }
    limits = try c.optional(.limits)
    mac = try c.optional(.mac)
    updatedEpoch = try c.epochSeconds(.updatedEpoch)
  }

  /// Procent kafla: całość 0–100 (limity planu, obciążenie Maca, wypełnienie segmentu).
  static func isPercent(_ value: Int) -> Bool { (0...100).contains(value) }
}

/// Indeks tablicy w ścieżce kodowania (JSON Pointer odrzucenia wskazuje zły segment).
private struct IndexKey: CodingKey {
  let intValue: Int?
  let stringValue: String

  init(_ index: Int) {
    intValue = index
    stringValue = String(index)
  }

  init?(stringValue: String) { nil }
  init?(intValue: Int) { self.init(intValue) }
}

extension ContractContainer {
  /// Całkowite sekundy epoki Unix (≥ 0). Ułamek i łańcuch odrzuca już dekodowanie `Int`.
  func epochSeconds(_ key: Key) throws -> Int {
    let value: Int = try required(key)
    guard value >= 0 else { throw contractViolation(codingPath + [key], "czas sprzed epoki Unix") }
    return value
  }

  /// Opcjonalny procent kafla (0–100); `null` i wartość spoza zakresu odrzucają stan.
  func percent(_ key: Key) throws -> Int? {
    guard let value: Int = try optional(key) else { return nil }
    guard LiveActivityContentState.isPercent(value) else {
      throw contractViolation(codingPath + [key], "procent poza 0…100")
    }
    return value
  }

  /// Tablica znanych stanów faz albo `nil`: brak pola, `null`, skalar, element spoza trzech wartości (także
  /// `null` i liczba) — całe pole znika, reszta przebiegu dekoduje się dalej.
  func phaseStates(_ key: Key) -> [LiveActivityContentState.PhaseState]? {
    guard base.contains(key), let raw = try? base.decode([String].self, forKey: key) else { return nil }
    let states = raw.compactMap(LiveActivityContentState.PhaseState.init(rawValue:))
    return states.count == raw.count ? states : nil
  }

  /// Łańcuch kafla z sufitem `LIVE_ACTIVITY_TEXT_MAX` liczonym w jednostkach UTF-16 (jak zod).
  func text(_ key: Key, allowEmpty: Bool) throws -> String {
    let value: String = try allowEmpty ? required(key) : nonEmpty(key)
    guard value.utf16.count <= LiveActivityContentState.textMax else {
      throw contractViolation(codingPath + [key], "łańcuch dłuższy niż \(LiveActivityContentState.textMax)")
    }
    return value
  }
}
