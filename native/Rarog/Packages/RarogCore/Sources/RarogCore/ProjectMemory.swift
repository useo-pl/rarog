import Foundation

// Pamięć urządzeniowa nawigacji (także układ listy i zwinięte projekty drzewa): same ścieżki katalogów i identyfikatory
// sesji albo terminali, zero treści. Wpisy są PODPOWIEDZIĄ — cel zawsze potwierdza żywy skład projektu
// (`AppState.projectTarget`). Właściciel: projekty i zakładki.

/// Magazyn preferencji urządzenia — `UserDefaults` w apce, słownik w testach.
public protocol PreferenceStore: AnyObject {
  func data(forKey key: String) -> Data?
  func bool(forKey key: String) -> Bool
  /// The raw value for a key, `nil` when there is none (tells a missing number from 0).
  func object(forKey key: String) -> Any?
  func set(_ value: Any?, forKey key: String)
}

extension UserDefaults: PreferenceStore {}

/// Preferencje w pamięci procesu (testy, podgląd).
public final class MemoryPreferences: PreferenceStore {
  private var values: [String: Any] = [:]

  public init() {}

  public func data(forKey key: String) -> Data? { values[key] as? Data }
  public func bool(forKey key: String) -> Bool { values[key] as? Bool ?? false }
  public func object(forKey key: String) -> Any? { values[key] }
  public func set(_ value: Any?, forKey key: String) { values[key] = value }
}

/// Klucze preferencji nawigacji i odczyt/zapis JSON-em. Uszkodzony wpis = brak pamięci (stan
/// legalny), nigdy awaria.
public enum NavigationPreferences {
  public static let projectTabs = "rarog.projectTabs"
  public static let projectHistory = "rarog.projectHistory"
  public static let listCollapsed = "rarog.listCollapsed"
  /// Zapamiętany model i effort nowej sesji (``NewSessionDefaults``; pisze formularz nowej sesji).
  public static let newSession = "rarog.newSession"
  /// Projekty zwinięte w drzewie listy (``CollapsedProjects``).
  public static let collapsedProjects = "rarog.collapsedProjects"
  /// Projects pinned in the list tree (``PinnedProjects``).
  public static let pinnedProjects = "rarog.pinnedProjects"
  /// Prawy panel sesji na iPadzie otwarty: zmienia go wyłącznie człowiek.
  public static let inspectorOpen = "rarog.inspectorOpen"
  /// Drzewo sekcji ZMIANY W KATALOGU prawego panelu zwinięte do nagłówka: jedna flaga
  /// urządzenia dla wszystkich sesji, zmienia ją wyłącznie człowiek.
  public static let inspectorChangesCollapsed = "rarog.inspectorChangesCollapsed"
  /// Width of the iPad right panel (Double, pt), set by dragging its divider; no entry means the default width.
  public static let inspectorWidth = "rarog.inspectorWidth"
  /// Sessions visited on this device, for the mark of the last visit on the list (``SessionHistory``).
  public static let sessionHistory = "rarog.sessionHistory"
  /// Preferencje zależne od serwera — ścieżki projektów i identyfikatory sesji: magazyn kasuje je przy wejściu
  /// w nową przestrzeń danych (`RarogStore+Spaces`). Ostatni klucz należy do RarogUI (`LastSeenMemory.key`).
  public static let serverScoped = [
    projectTabs, projectHistory, collapsedProjects, pinnedProjects, sessionHistory, "rarog.transcript.lastSeen",
  ]

  public static func load<T: Decodable>(_ type: T.Type, key: String, from store: PreferenceStore) -> T? {
    guard let data = store.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
  }

  public static func save(_ value: some Encodable, key: String, to store: PreferenceStore) {
    guard let data = try? JSONEncoder().encode(value) else { return }
    store.set(data, forKey: key)
  }
}

/// Zakładka paska projektu: sesja albo terminal. Sama tożsamość — wygląd składa `RarogUI`.
public enum ProjectTabRef: Sendable, Hashable {
  case session(String)
  case terminal(String)

  var id: String {
    switch self {
    case let .session(id), let .terminal(id): id
    }
  }
}

/// „Katalog → zakładka, w której TO urządzenie ostatnio stało": sesja albo terminal. Sufit 32;
/// wypada NAJDAWNIEJ UŻYTY, nie najdawniej zapisany — inaczej sufit wyrzucałby projekty w użyciu.
public struct ProjectTabMemory: Sendable, Equatable, Codable {
  public static let capacity = 32

  /// Na dysku `{cwd, sessionId}` albo `{cwd, terminalId}`: starszy wpis (sam `sessionId`) czyta się bez zmian.
  public struct Entry: Sendable, Equatable, Codable {
    public let cwd: String
    public let tab: ProjectTabRef

    public init(cwd: String, tab: ProjectTabRef) {
      self.cwd = cwd
      self.tab = tab
    }

    enum CodingKeys: String, CodingKey { case cwd, sessionId, terminalId }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      cwd = try c.decode(String.self, forKey: .cwd)
      if let terminal = try c.decodeIfPresent(String.self, forKey: .terminalId) {
        tab = .terminal(terminal)
      } else {
        tab = .session(try c.decode(String.self, forKey: .sessionId))
      }
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(cwd, forKey: .cwd)
      switch tab {
      case let .session(id): try c.encode(id, forKey: .sessionId)
      case let .terminal(id): try c.encode(id, forKey: .terminalId)
      }
    }
  }

  /// Najdawniej użyty pierwszy.
  public private(set) var entries: [Entry] = []

  public init() {}

  public func remembered(cwd: String) -> ProjectTabRef? {
    entries.last { $0.cwd == cwd }?.tab
  }

  /// Notuje zakładkę; `true` = coś się zmieniło (zapis tylko wtedy).
  @discardableResult
  public mutating func note(cwd: String, tab: ProjectTabRef) -> Bool {
    guard !cwd.isEmpty, !tab.id.isEmpty else { return false }
    let entry = Entry(cwd: cwd, tab: tab)
    if entries.last == entry { return false }
    entries.removeAll { $0.cwd == cwd }
    entries.append(entry)
    if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
    return true
  }

  /// Zakładka sesji — skrót dla wołających bez terminala.
  @discardableResult
  public mutating func note(cwd: String, sessionId: String) -> Bool {
    note(cwd: cwd, tab: .session(sessionId))
  }

  enum CodingKeys: String, CodingKey { case entries }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    // Wpis po wpisie: jeden uszkodzony (pusty, nieznany kształt) nie kasuje reszty pamięci.
    var raw: [Entry] = []
    if var items = try? c.nestedUnkeyedContainer(forKey: .entries) {
      while !items.isAtEnd {
        if let entry = try? items.decode(Entry.self) {
          raw.append(entry)
        } else {
          _ = try? items.decode(SkippedEntry.self)
        }
      }
    }
    entries = Array(raw.filter { !$0.cwd.isEmpty && !$0.tab.id.isEmpty }.suffix(Self.capacity))
  }
}

/// Pusty dekoder przesuwający kontener za wpis, którego nie umiemy przeczytać.
struct SkippedEntry: Decodable {
  init(from decoder: any Decoder) throws {}
}

/// Historia KATALOGÓW projektów pod Cmd+L (MRU, bez duplikatów, sufit 16). Katalogi, nie
/// zakładki: zakładka umiera z sesją, a projekt z pięcioma innymi sesjami dalej jest celem.
/// Najnowszy na końcu.
public struct ProjectHistory: Sendable, Equatable, Codable {
  public static let capacity = 16

  public private(set) var cwds: [String] = []

  public init() {}

  /// Notuje projekt, w którym stoi człowiek; `true` = zmiana (powtórzenie bieżącego nic nie robi).
  @discardableResult
  public mutating func note(_ cwd: String) -> Bool {
    guard !cwd.isEmpty, cwds.last != cwd else { return false }
    cwds.removeAll { $0 == cwd }
    cwds.append(cwd)
    if cwds.count > Self.capacity { cwds.removeFirst(cwds.count - Self.capacity) }
    return true
  }

  /// Katalog celu Cmd+L: najnowszy wpis INNY niż bieżący, który `alive` uznaje za żywy. Martwy
  /// jest pomijany, nie kasowany. `current == nil` (lista) = ostatnio odwiedzony projekt. Tę samą
  /// funkcję czyta kreska w sekcji PROJEKTY — skrót i znacznik nie mogą wskazać dwóch projektów.
  public func previous(current: String?, alive: (String) -> Bool) -> String? {
    for cwd in cwds.reversed() where cwd != current {
      if alive(cwd) { return cwd }
    }
    return nil
  }

  enum CodingKeys: String, CodingKey { case cwds }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let raw = (try? c.decode([String].self, forKey: .cwds)) ?? []
    cwds = Array(raw.filter { !$0.isEmpty }.suffix(Self.capacity))
  }
}

/// Projekty zwinięte w drzewie listy: katalogi, które człowiek SAM zwinął na tym urządzeniu.
/// Projekt spoza zbioru jest rozwinięty — apka niczego nie chowa sama, więc nowy projekt staje rozwinięty.
/// Najdawniej zwinięty pierwszy. Sufit 32 (jak pamięć zakładek) dotyczy HISTORII: wypada najdawniej zwinięty
/// katalog, którego dziś w drzewie nie ma. Projektów stojących w drzewie sufit nie rusza — wypchnięty rozwinąłby
/// się sam; gdy zwiniętych projektów w drzewie jest więcej niż 32, zbiór rośnie ponad sufit.
public struct CollapsedProjects: Sendable, Equatable, Codable {
  public static let capacity = 32
  /// Sufit odczytu z dysku: odczyt nie wie, które katalogi stoją dziś w drzewie, więc tnie dopiero przy rozdętym
  /// (albo uszkodzonym) zapisie — z zapasem na wszystkie projekty drzewa ponad historię.
  static let storedLimit = 128

  public private(set) var cwds: [String] = []

  public init() {}

  public func contains(_ cwd: String) -> Bool {
    cwds.contains(ProjectPath.normalized(cwd))
  }

  /// Zwija albo rozwija projekty (strzałka jednego, „Zwiń wszystkie”, „Rozwiń wszystkie”); `true` = zmiana
  /// (zapis tylko wtedy). Ponowne zwinięcie zwiniętego nie przesuwa go w kolejce sufitu. `present` = katalogi
  /// nagłówków stojących dziś w drzewie: sufit ich nie wypycha.
  @discardableResult
  public mutating func set(_ projects: [String], collapsed: Bool, present: Set<String> = []) -> Bool {
    let before = cwds
    for cwd in projects.map(ProjectPath.normalized) where !cwd.isEmpty {
      if collapsed {
        if !cwds.contains(cwd) { cwds.append(cwd) }
      } else {
        cwds.removeAll { $0 == cwd }
      }
    }
    trim(keeping: Set(present.map(ProjectPath.normalized)))
    return cwds != before
  }

  /// Sufit historii: najdawniej zwinięte katalogi spoza drzewa wypadają, aż zbiór zmieści się w ``capacity``.
  private mutating func trim(keeping present: Set<String>) {
    var excess = cwds.count - Self.capacity
    guard excess > 0 else { return }
    var kept: [String] = []
    for cwd in cwds {
      if excess > 0, !present.contains(cwd) {
        excess -= 1
      } else {
        kept.append(cwd)
      }
    }
    cwds = kept
  }

  enum CodingKeys: String, CodingKey { case cwds }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    // Wpis po wpisie: jeden uszkodzony nie rozwija reszty projektów.
    var raw: [String] = []
    if var items = try? c.nestedUnkeyedContainer(forKey: .cwds) {
      while !items.isAtEnd {
        if let cwd = try? items.decode(String.self) {
          raw.append(cwd)
        } else {
          _ = try? items.decode(SkippedEntry.self)
        }
      }
    }
    for cwd in raw.map(ProjectPath.normalized) where !cwd.isEmpty && !cwds.contains(cwd) { cwds.append(cwd) }
    if cwds.count > Self.storedLimit { cwds.removeFirst(cwds.count - Self.storedLimit) }
  }
}
