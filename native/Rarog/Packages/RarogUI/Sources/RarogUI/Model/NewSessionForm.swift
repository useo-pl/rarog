import Foundation
import RarogContract
import RarogCore

// Formularz „Nowa sesja": reguły pola ścieżki, przeglądarki katalogów, ustawień
// startu, podsumowań i listy rozmów do wznowienia. Testowane na macOS;
// widok w `Views/NewSession/`. Właściciel: sterowanie sesją.

/// Browser field: a value starting with `/` or `~` is a path — the directory you STAND in ends with a slash, and the
/// tail after the last slash filters the list (`~/Projects/pi` = "I am in ~/Projects, show what has «pi» in its
/// name"). Any other value filters the current list (`DirectoryBrowser.type`). `dir == nil` = the roots level
/// (`RAROG_PROJECT_ROOTS`), not the disk root.
public enum PathField {
  static let separator: Character = "/"

  public static func parse(_ value: String) -> (dir: String?, filter: String) {
    let text = value.trimmingCharacters(in: .whitespaces)
    if text.isEmpty { return (nil, "") }
    if text.hasSuffix("/") { return (text.count == 1 ? "/" : String(text.dropLast()), "") }
    guard let cut = text.lastIndex(of: separator) else { return (nil, text) }
    let dir = cut == text.startIndex ? "/" : String(text[..<cut])
    return (dir, String(text[text.index(after: cut)...]))
  }

  /// `cwd` do serwera: bez ukośnika-znacznika, ale z ogonem — wpisana nieistniejąca ścieżka ma
  /// dostać jasne 400, a nie cichy start w katalogu wyżej.
  public static func launchCwd(_ value: String) -> String {
    let text = value.trimmingCharacters(in: .whitespaces)
    return text.count > 1 && text.hasSuffix("/") ? String(text.dropLast()) : text
  }

  /// Filter by any part of the name, case-insensitive ("atlas" matches "Demo-Atlas").
  public static func filter(_ entries: [DirEntry], _ filter: String) -> [DirEntry] {
    guard !filter.isEmpty else { return entries }
    let needle = filter.lowercased(with: CopyLocale.current)
    return entries.filter { $0.name.lowercased(with: CopyLocale.current).contains(needle) }
  }

  /// The browser field takes focus on opening only with a hardware keyboard: on touch the on-screen keyboard would
  /// cover the list being tapped.
  public static func focusesOnBrowse(hardwareKeyboard: Bool) -> Bool { hardwareKeyboard }

  /// Ostatni segment ścieżki (`/a/b/c/` → `c`); pusto dla korzeni i pustego pola.
  public static func basename(_ cwd: String) -> String {
    cwd.split(separator: "/").last.map(String.init) ?? ""
  }

  /// Etykiety pigułek „Ostatnie": nazwa katalogu, przy kolizji `rodzic/nazwa`.
  public static func chipLabels(_ cwds: [String]) -> [String] {
    let names = cwds.map(basename)
    return names.enumerated().map { index, name in
      guard names.filter({ $0 == name }).count > 1 else { return name }
      let segments = cwds[index].split(separator: "/")
      return segments.count >= 2 ? "\(segments[segments.count - 2])/\(name)" : name
    }
  }
}

/// Stan przeglądarki katalogów do narysowania (bez widoku — `DirectoryBrowser` go produkuje).
public struct DirectoryView: Sendable, Equatable {
  public enum Status: Sendable, Equatable {
    case loading
    case ready
    case error(String)
  }

  /// Katalog listingu (`nil` = poziom korzeni).
  public var dir: String?
  public var filter: String
  public var status: Status
  public var listing: DirListing?

  public init(dir: String? = nil, filter: String = "", status: Status = .loading, listing: DirListing? = nil) {
    self.dir = dir
    self.filter = filter
    self.status = status
    self.listing = listing
  }

  /// Wpisy PO filtrze — dokładnie to, co widać na liście.
  public var entries: [DirEntry] {
    PathField.filter(listing?.entries ?? [], filter)
  }

  /// One sentence under the list, by URGENCY: error, empty, truncated list. Loading is told by the skeleton.
  public var statusLine: String? {
    switch status {
    case let .error(message): return message
    case .loading: return nil
    case .ready: break
    }
    guard let listing else { return nil }
    if entries.isEmpty {
      if !filter.isEmpty { return UICopy.dirNothingMatches(filter) }
      return listing.path == nil ? UICopy.dirNoRoots : UICopy.dirEmpty
    }
    return listing.truncated ? UICopy.dirTruncated(listing.entries.count) : nil
  }

  /// Muted row text (statuses as text, not capsules): "current · git · history".
  public static func marks(_ entry: DirEntry, current: String?) -> [DirMark] {
    var marks: [DirMark] = []
    if let current, ProjectPath.normalized(entry.path) == ProjectPath.normalized(current) { marks.append(.current) }
    if entry.git { marks.append(.git) }
    if entry.history { marks.append(.history) }
    return marks
  }
}

/// Browser row mark: the directory chosen in the window, a `git` repository, CLI conversation history.
public enum DirMark: Sendable, Equatable {
  case current
  case git
  case history
}

/// Tryb uprawnień nowego panelu (domyślnie `auto`, z ostrzeżeniem od pierwszej klatki;
/// trybu NIE pamiętamy). `bypassPermissions` nie ma: wolno go tylko dla katalogów z
/// `RAROG_YOLO_ROOTS`, a klient nie ma jak tego sprawdzić.
public enum StartMode: String, Sendable, CaseIterable, Identifiable {
  case auto
  case manual
  case acceptEdits
  case plan

  public static let `default` = StartMode.auto

  /// Kolejność przełącznika w oknie: od najmniejszej do największej swobody agenta.
  public static let segmentOrder: [StartMode] = [.plan, .manual, .acceptEdits, .auto]

  public var id: String { rawValue }

  public var permissionMode: CreateSessionPermissionMode {
    switch self {
    case .auto: .auto
    case .manual: .manual
    case .acceptEdits: .acceptEdits
    case .plan: .plan
    }
  }
}

/// Model i effort startu: zapamiętany wybór wygrywa, gdy serwer go zna;
/// bez niego `opus[1m]` i `xhigh`, jeśli lista je zna. „Model domyślny konta" (`""`) i effort
/// „auto" (`nil`) znaczą „nie wysyłaj pola" — oba wybrane świadomie też są pamiętane (ostatni
/// wybór urządzenia wygrywa).
public enum StartModel {
  public static let preferredModel = "opus[1m]"
  public static let preferredEffort = EffortLevel.xhigh
  public static let accountDefault = ""

  /// Lista z pozycją „model domyślny konta" na początku, bez duplikatu.
  public static func options(_ choices: [ModelChoice]) -> [ModelChoice] {
    choices.contains { $0.value == accountDefault }
      ? choices
      : [ModelChoice(value: accountDefault, label: UICopy.modelAccountDefault, effortLevels: [])] + choices
  }

  /// `chosen` = model wybrany ręką w tej prezentacji formularza: spóźniona lista (`GET /api/models`)
  /// go nie nadpisuje, póki go zna; zapamiętany wybór i podpowiedź działają tylko przed edycją.
  public static func resolveModel(_ choices: [ModelChoice], saved: NewSessionDefaults?, chosen: String? = nil) -> String {
    if let chosen, choices.contains(where: { $0.value == chosen }) { return chosen }
    if saved?.modelAccount == true { return accountDefault }
    if let model = saved?.model, choices.contains(where: { $0.value == model }) { return model }
    if choices.contains(where: { $0.value == preferredModel }) { return preferredModel }
    return accountDefault
  }

  /// Poziomy effortu wybranego modelu (pusta lista = model nie zna effortu).
  public static func effortLevels(_ choices: [ModelChoice], model: String) -> [EffortLevel] {
    choices.first { $0.value == model }?.effortLevels ?? []
  }

  /// Serwer umie wystartować wybrany model z ultracode (`ModelChoice.ultracode`). „Model domyślny konta” i
  /// Haiku tego pola nie mają, a serwer, który go nie zna, nie ogłasza go wcale — wtedy przełącznika nie ma.
  public static func ultracodeAvailable(_ choices: [ModelChoice], model: String) -> Bool {
    choices.first { $0.value == model }?.ultracode ?? false
  }

  /// `nil` = „auto". Bez zapisu idzie `xhigh`, o ile model go zna; zapis spoza listy modelu → „auto".
  /// `chosen` = effort wybrany ręką w tej prezentacji formularza (`.some(nil)` = „auto"): wygrywa z zapisem
  /// i idzie za modelem jak zapis — spoza listy nowego modelu daje „auto”, bez powrotu do zapisu i `xhigh`.
  public static func resolveEffort(
    _ levels: [EffortLevel], saved: NewSessionDefaults?, chosen: EffortLevel?? = nil
  ) -> EffortLevel? {
    if let chosen { return chosen.flatMap { levels.contains($0) ? $0 : nil } }
    guard let saved, saved.effort != nil || saved.effortAuto else {
      return levels.contains(preferredEffort) ? preferredEffort : nil
    }
    guard let effort = saved.effort else { return nil }
    return levels.contains(effort) ? effort : nil
  }
}

/// Ustawienia startu w formularzu i ich podsumowania.
public struct StartSettings: Sendable, Equatable {
  public var mode: StartMode
  public var model: String
  public var modelLabel: String
  /// Effort wybrany w menu (albo podpowiedź). Przy włączonym ultracode czeka pod spodem: formularz pokazuje
  /// i wysyła ``launchEffort``.
  public var effort: EffortLevel?
  /// Start z ultracode: domyślnie wyłączony i niepamiętany, więc każde włączenie to świadomy gest.
  /// Włącza go wyłącznie ``setUltracode(_:choices:)``, który pilnuje, że wybrany model ma tę możliwość.
  public private(set) var ultracode: Bool

  public init(
    mode: StartMode = .default, model: String = StartModel.accountDefault, modelLabel: String = "",
    effort: EffortLevel? = nil
  ) {
    self.mode = mode
    self.model = model
    self.modelLabel = modelLabel
    self.effort = effort
    self.ultracode = false
  }

  /// Effort startu: flaga ultracode ustawia poziom xhigh (docs Claude Code), więc przy włączonym
  /// przełączniku menu stoi na xhigh i jest wygaszone; po wyłączeniu wraca wybór z ``effort``.
  public var launchEffort: EffortLevel? { ultracode ? .xhigh : effort }

  /// Przełącznik ultracode: włącza się tylko przy modelu, przy którym serwer je ogłosił.
  public mutating func setUltracode(_ on: Bool, choices: [ModelChoice]) {
    ultracode = on && StartModel.ultracodeAvailable(choices, model: model)
  }

  /// Po zmianie modelu i po odświeżeniu listy: przełącznik znika razem z wyborem, gdy wybrany model go nie ma.
  public mutating func syncUltracode(choices: [ModelChoice]) {
    if !StartModel.ultracodeAvailable(choices, model: model) { ultracode = false }
  }

  /// „Auto · Opus · xhigh" — effort domyślny nie pada, model domyślny konta to „model konta";
  /// włączone ultracode na końcu.
  public var summary: String {
    var parts = [UICopy.startModeShort(mode)]
    parts.append(model == StartModel.accountDefault ? UICopy.modelAccountShort : modelLabel)
    if let effort = launchEffort { parts.append(effort.rawValue) }
    if ultracode { parts.append(Ultracode.name) }
    return UICopy.list(parts, .dot)
  }

  /// Zdanie w stopce obok „Uruchom": katalog · ustawienia; pusto bez katalogu.
  public func launchSummary(cwd: String) -> String {
    let dir = PathField.basename(cwd)
    return dir.isEmpty ? "" : "\(dir) · \(summary)"
  }

  /// Ciało `POST /api/sessions`: pola „bez zdania" nie lecą; tryb jedzie zawsze (jest wyborem); `ultracode` tylko
  /// przy włączonym przełączniku, z effortem xhigh (wyłączony = bez flagi, decydują ustawienia Claude Code).
  public func body(cwd: String, resumeFrom: String? = nil, fork: Bool = false) -> CreateSessionBody {
    CreateSessionBody(
      cwd: PathField.launchCwd(cwd), permissionMode: mode.permissionMode,
      model: model == StartModel.accountDefault ? nil : model, effort: launchEffort,
      resumeFrom: resumeFrom, fork: fork && resumeFrom != nil ? true : nil, ultracode: ultracode)
  }

  /// Zapis po udanym starcie: model i effort (tryb świadomie nie). Ultracode też nie (wyjątek
  /// od zapamiętywania ostatniego wyboru), a effort to wybór z menu, nie xhigh wymuszony przełącznikiem: „+” i Cmd+N startują bez ultracode
  /// na poziomie, który człowiek wybrał.
  public var defaults: NewSessionDefaults {
    var saved = NewSessionDefaults(model: model == StartModel.accountDefault ? nil : model, effort: effort)
    saved.effortAuto = effort == nil
    saved.modelAccount = model == StartModel.accountDefault
    return saved
  }
}

/// Recent project pills: the server list (`GET /api/projects/recent`, 7 days,
/// up to 13 entries) without the project the window opened in, at most 12, no Cmd+L history. The order holds while
/// the window is open: a refreshed list does not reorder the pills, new projects join at the end while there is room.
public enum RecentChips {
  public static let limit = 12

  public static func update(shown: [String], server: [String], excluding current: String?) -> [String] {
    let skip = current.map(ProjectPath.normalized)
    var out = shown
    var seen = Set(shown)
    for cwd in server.map(ProjectPath.normalized) where out.count < limit && !cwd.isEmpty && cwd != skip {
      if seen.insert(cwd).inserted { out.append(cwd) }
    }
    return out
  }
}

/// Wiersz rozmowy do wznowienia.
public enum ResumeRow {
  /// Tytuł: etykieta albo pierwszy prompt; wpis bez obu nie może być pustym wierszem.
  public static func title(_ entry: ResumableSession) -> String {
    let text = (entry.title ?? entry.firstPrompt).trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? UICopy.resumeUntitled : text
  }

  /// "4 min · fix/save · open" — machine metadata; the status of an open conversation is muted text at the end, not
  /// a capsule. A branch longer than ``branchLimit`` loses its middle: the contract allows 120
  /// characters, and a one-line row would then give its whole width to the metadata.
  public static func meta(_ entry: ResumableSession, now: Date) -> String {
    var parts: [String] = []
    if let at = ServerTime.parse(entry.mtime) { parts.append(RelativeTime.short(since: at, now: now)) }
    if let branch = entry.gitBranch, !branch.isEmpty { parts.append(shortBranch(branch)) }
    if entry.liveInHerdr { parts.append(UICopy.resumeLiveTag) }
    return UICopy.list(parts, .dot)
  }

  static let branchLimit = 24

  /// `feature/bardzo-dluga-nazwa-galezi` → `feature/ba…nazwa-galezi`: początek mówi rodzaj, koniec — czego dotyczy.
  static func shortBranch(_ branch: String) -> String {
    guard branch.count > branchLimit else { return branch }
    let tail = (branchLimit - 1) / 2
    return "\(branch.prefix(branchLimit - 1 - tail))…\(branch.suffix(tail))"
  }

  /// Przejście do otwartej rozmowy: karta z `sessionId` wpisu, gdy apka ją zna. Starszy
  /// serwer pola nie wysyła — wtedy tylko DOKŁADNIE jedna karta w katalogu, bo apka nie zgaduje.
  public static func openTarget(_ entry: ResumableSession, in state: AppState) -> String? {
    if let id = entry.sessionId { return state.sessions[id] == nil ? nil : id }
    let cwd = ProjectPath.normalized(entry.cwd)
    let matches = state.sessions.values.filter { ProjectPath.normalized($0.cwd) == cwd }
    return matches.count == 1 ? matches.first?.id : nil
  }

  /// Zdanie, gdy przejście nie ma celu.
  public static func openMiss(_ entry: ResumableSession, in state: AppState) -> String {
    if entry.sessionId != nil { return UICopy.resumeOpenMissing }
    let cwd = ProjectPath.normalized(entry.cwd)
    let count = state.sessions.values.filter { ProjectPath.normalized($0.cwd) == cwd }.count
    return count == 0 ? UICopy.resumeOpenMissing : UICopy.resumeOpenAmbiguous
  }
}

/// Conversations in two groups: "Open" above "Resumable", each in
/// server order; an empty group has no header.
public enum ResumeGroups {
  public enum Kind: Sendable, Hashable {
    case open
    case resumable
  }

  public struct Group: Sendable, Equatable, Identifiable {
    public var kind: Kind
    public var entries: [ResumableSession]

    public var id: Kind { kind }
  }

  public static func split(_ entries: [ResumableSession]) -> [Group] {
    [Group(kind: .open, entries: entries.filter(\.liveInHerdr)),
     Group(kind: .resumable, entries: entries.filter { !$0.liveInHerdr })]
      .filter { !$0.entries.isEmpty }
  }
}

/// Linia kontekstu pod projektem w oknie nowej sesji: „main · 9 zmian · 2 otwarte sesje”.
public enum ProjectContext {
  /// Gałąź i zmiany pochodzą z OTWARTEJ sesji tego katalogu (git liczy się tylko przy żywym panelu); bez
  /// otwartych sesji linii nie ma — apka nie pyta serwera o git katalogu, w którym nic nie pracuje.
  public static func line(cwd: String, in state: AppState) -> String? {
    let open = state.projectSessions(cwd).filter { $0.state != .done && $0.state != .resumable }
    guard !open.isEmpty else { return nil }
    var parts: [String] = []
    if let git = open.first(where: { $0.branch?.isEmpty == false }), let branch = git.branch {
      parts.append(branch)
      if let dirty = git.dirtyCount, dirty > 0 { parts.append(UICopy.dirtyFiles(dirty)) }
    }
    parts.append(UICopy.openSessions(open.count))
    return UICopy.list(parts, .dot)
  }
}
