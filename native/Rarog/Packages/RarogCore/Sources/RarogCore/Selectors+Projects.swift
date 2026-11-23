import Foundation
import RarogContract

// Selektory projektów i zakładek: czyste
// odczyty stanu. Copy składa RarogUI. Właściciel: projekty i zakładki.

/// Git projektu: gałąź i rozjazd z upstreamem — wszystko z TEJ SAMEJ sesji.
public struct ProjectGit: Sendable, Equatable {
  public let branch: String
  public let ahead: Int?
  public let behind: Int?
}

/// Projekt = katalog (tożsamością jest ścieżka, nie nazwa). Grupa patrzy na sesje z drugiej
/// strony niż płaska lista agentów: sesji nie zabiera, tylko je liczy i prowadzi do nich.
public struct ProjectGroup: Sendable, Equatable, Identifiable {
  public let cwd: String
  /// Nazwa do wiersza: `title` najstarszej sesji (basename katalogu).
  public let name: String
  /// Sesje projektu od najstarszej (`createdAt`) — kolejność zakładek, stała przy zmianach stanu.
  public let sessions: [SessionSummary]
  /// Ostatnia aktywność: ostatnio aktywna sesja projektu.
  public let activityAt: Date?

  public var id: String { cwd }

  /// Ton licznika agentów: najpilniejszy stan sesji projektu, `nil` bez sesji (stan
  /// projektu niesie kolor licznika, nie kropka). Nie pierwsza sesja, tylko CAŁA grupa — inaczej
  /// projekt z pracującym agentem świeciłby szaro, gdy świeższa była sesja bezczynna.
  public var tone: StatusTone? {
    sessions.map(\.statusTone).min { Self.urgency($0) < Self.urgency($1) }
  }

  /// Pierwsza sesja, która zna gałąź, razem z JEJ rozjazdem (liczby jednej gałęzi przy nazwie
  /// drugiej byłyby kłamstwem po przełączeniu gałęzi w jednej z sesji).
  public var git: ProjectGit? {
    guard let session = sessions.first(where: { !($0.branch ?? "").isEmpty }), let branch = session.branch else {
      return nil
    }
    return ProjectGit(branch: branch, ahead: session.ahead, behind: session.behind)
  }

  /// Ostatnio aktywna sesja — cel wejścia w projekt bez zapamiętanej zakładki (jak aktywacja
  /// workspace'u w herdr). Remis: młodsza sesja. `nil` = projekt bez sesji.
  public var lastActiveSession: SessionSummary? {
    AppState.lastActive(sessions)
  }

  /// Ranga tonu: błąd, czeka, nieodebrany wynik, praca, czekanie na zadanie w tle, cisza (`GROUP_TONE_RANK` z PWA;
  /// czekanie na zadanie w tle między pracą a ciszą).
  static func urgency(_ tone: StatusTone) -> Int {
    switch tone {
    case .failed: 0
    case .waiting: 1
    case .unread: 2
    case .working: 3
    case .backgroundWait: 4
    case .quiet: 5
    }
  }
}

/// Dokąd prowadzi wejście w projekt.
public enum ProjectTarget: Sendable, Equatable {
  case session(String)
  /// Zapamiętany terminal projektu, który wciąż stoi na liście `GET /api/term`.
  case terminal(String)
  /// Projekt bez żywej sesji: ekran projektu z „Nową sesją w tym katalogu".
  case empty(cwd: String)
}

/// Terminal po stronie serwera, z ustalonym znaczeniem braku sondy.
public enum TerminalFeature: Sendable, Equatable {
  /// Sonda wersji jeszcze nie odpowiedziała: zaproszenia do terminala nie ma — ani obietnicy, ani odmowy.
  case unknown
  /// `termEnabled: false` (`RAROG_TERM=0`, demo): zaproszenie i „Nowy terminal" stoją wygaszone ze zdaniem.
  case off
  case on
}

/// Ścieżki projektów: tożsamość bez ogonowego ukośnika i nazwa do wiersza.
public enum ProjectPath {
  public static func normalized(_ cwd: String) -> String {
    var path = cwd
    while path.count > 1, path.hasSuffix("/") { path.removeLast() }
    return path
  }

  public static func name(_ cwd: String) -> String {
    let path = normalized(cwd)
    return path.split(separator: "/").last.map(String.init) ?? path
  }
}

extension AppState {
  /// Sekcja PROJEKTY: katalogi sesji z listy, tylko z co najmniej jedną sesją.
  /// Ostatnie projekty z historii CLI (`catalog.recent`) stoją wyłącznie w oknie nowej sesji, więc projekt znika
  /// z listy w tej samej aktualizacji stanu, w której znika jego ostatnia sesja.
  ///
  /// Kolejność: DOBA ostatniej aktywności malejąco, w obrębie doby alfabet polski z liczbami
  /// naturalnie („rarog2" przed „rarog10"), remis rozstrzyga ścieżka. Doba, nie znacznik czasu:
  /// projekt skacze w górę najwyżej raz na dobę, a w trakcie pracy w dwóch projektach nic nie
  /// mruga. Granicą jest północ TEGO, kto patrzy (`calendar`).
  public func projectGroups(calendar: Calendar = .current) -> [ProjectGroup] {
    var byCwd: [String: [SessionSummary]] = [:]
    for session in sessions.values {
      byCwd[ProjectPath.normalized(session.cwd), default: []].append(session)
    }
    let groups: [ProjectGroup] = byCwd.map { cwd, members in
      let ordered = Self.byAge(members)
      let last = Self.lastActive(ordered)
      return ProjectGroup(
        cwd: cwd, name: ordered.first?.title ?? ProjectPath.name(cwd), sessions: ordered,
        activityAt: last.flatMap { ISOTime.parse($0.lastActivityAt) })
    }
    // Kolejność nazw według języka apki: ta sama reguła porządku co tekst, który widać.
    let locale = CopyLocale.current
    return groups.sorted { a, b in
      let dayA = a.activityAt.map { calendar.startOfDay(for: $0) }
      let dayB = b.activityAt.map { calendar.startOfDay(for: $0) }
      if dayA != dayB { return (dayA ?? .distantPast) > (dayB ?? .distantPast) }
      let byName = a.name.compare(b.name, options: [.numeric], range: nil, locale: locale)
      if byName != .orderedSame { return byName == .orderedAscending }
      return a.cwd < b.cwd
    }
  }

  /// Sesje projektu od najstarszej — sesyjna część paska zakładek. Agent stojący
  /// w terminalu Raroga (`termId`: Codex, a także Claude uruchomiony tam ręcznie)
  /// własnej zakładki nie ma: jego zakładką jest zakładka tego terminala — druga prowadziłaby pod ten sam panel.
  public func projectTabs(_ cwd: String) -> [SessionSummary] {
    let key = ProjectPath.normalized(cwd)
    return Self.byAge(sessions.values.filter { ProjectPath.normalized($0.cwd) == key && $0.termId == nil })
  }

  /// Wszystkie sesje projektu od najstarszej, także wpis agenta w terminalu — z nich wybiera się cel wejścia
  /// w projekt: taki wpis prowadzi przez `.session(id)` do swojego terminala.
  public func projectSessions(_ cwd: String) -> [SessionSummary] {
    let key = ProjectPath.normalized(cwd)
    return Self.byAge(sessions.values.filter { ProjectPath.normalized($0.cwd) == key })
  }

  /// Terminale projektu po slotach (taby powłoki, bez okien Cmd+F/Cmd+G) — tylko przy `termEnabled`:
  /// po wyłączeniu ficzeru ostatnia znana lista nie może dalej rysować zakładek.
  public func projectTerminals(_ cwd: String) -> [TerminalListEntry] {
    guard capabilities?.terminal == true else { return [] }
    let key = ProjectPath.normalized(cwd)
    return terminals.entries
      .filter { !$0.role.isPopup && ProjectPath.normalized($0.cwd) == key }
      .sorted { $0.slot < $1.slot }
  }

  /// Panel okna tej roli w katalogu projektu (Cmd+F `popup`, Cmd+G `lazygit`), gdy lista już go zna — ścieżki
  /// porównane po normalizacji, jak ``projectTerminals(_:)``, i tylko przy `termEnabled`. Okno Cmd+F
  /// z takim wpisem łączy się wprost do jego id, bez `POST`.
  public func projectPopupTerminal(_ cwd: String, role: TerminalRole) -> TerminalListEntry? {
    guard capabilities?.terminal == true, role.isPopup else { return nil }
    let key = ProjectPath.normalized(cwd)
    return terminals.entries.first { $0.role == role && ProjectPath.normalized($0.cwd) == key }
  }

  /// Katalog projektu sesji (`nil` = sesji nie ma na liście).
  public func projectCwd(ofSession id: String) -> String? {
    sessions[id].map { ProjectPath.normalized($0.cwd) }
  }

  /// Katalog terminala z listy `GET /api/term` (`nil` = lista go nie zna).
  public func projectCwd(ofTerminal id: String) -> String? {
    terminals.entry(id: id).map { ProjectPath.normalized($0.cwd) }
  }

  /// Terminal Raroga, w którym stoi agent tej sesji (`termId`; Codex i
  /// Claude); `nil` dla reszty — Codex bez terminala zostaje ekranem samego stanu, Claude ekranem sesji.
  public func hostTerminal(ofSession id: String) -> String? {
    sessions[id]?.termId
  }

  /// Sesja, której strumień transkryptu ma stać przy wyborze `id`. Sesja jeszcze nieznana liście (założona
  /// przed chwilą) — tak; wpis Codexa i agent w terminalu Raroga — nie (``SessionSummary/showsTranscript``).
  /// Liczone z bieżących danych sesji: `termId` zmienia się także bez zmiany wyboru.
  public func transcriptTarget(_ id: String?) -> String? {
    guard let id else { return nil }
    guard let session = sessions[id] else { return id }
    return session.showsTranscript ? id : nil
  }

  /// Sesja agenta stojącego w tym terminalu Raroga (`nil` = goła powłoka). Panel ma jednego agenta naraz;
  /// gdyby lista przez chwilę niosła dwa wpisy (stary i następca), wygrywa ostatnio aktywny.
  public func hostedSession(inTerminal termId: String) -> String? {
    Self.lastActive(sessions.values.filter { $0.termId == termId })?.id
  }

  /// Terminal po stronie serwera (`termEnabled` z sondy wersji).
  public var terminalFeature: TerminalFeature {
    capabilities.map { $0.terminal ? .on : .off } ?? .unknown
  }

  /// Cel wejścia w projekt: zapamiętana zakładka TEGO urządzenia, jeśli żyje
  /// w składzie projektu (martwy adres to ślepy zaułek; terminal potwierdza lista `GET /api/term`);
  /// inaczej ostatnio aktywna sesja; inaczej ekran projektu bez sesji. Wpisu po chybieniu nie kasujemy
  /// — lista terminali bywa jeszcze w drodze.
  /// Wybór idzie po WSZYSTKICH sesjach projektu (`projectSessions`): projekt z samym Codexem w terminalu nie
  /// jest pusty, a starszy zapamiętany wpis Codexa (sam `sessionId`) dalej prowadzi do niego.
  public func projectTarget(_ cwd: String, remembered: ProjectTabRef?) -> ProjectTarget {
    let tabs = projectSessions(cwd)
    switch remembered {
    case let .session(id)? where tabs.contains(where: { $0.id == id }):
      return .session(id)
    case let .terminal(id)? where projectTerminals(cwd).contains(where: { $0.id == id }):
      return .terminal(id)
    default:
      break
    }
    if let last = Self.lastActive(tabs) { return .session(last.id) }
    return .empty(cwd: ProjectPath.normalized(cwd))
  }

  /// Cel skoku nawigacyjnego (Cmd+L): jak tap w projekt, ale projekt bez żywej zakładki NIE jest
  /// celem — ekran nowej sesji nie jest miejscem, w którym się było.
  public func projectJumpTarget(_ cwd: String, remembered: ProjectTabRef?) -> ProjectTabRef? {
    switch projectTarget(cwd, remembered: remembered) {
    case let .session(id): .session(id)
    case let .terminal(id): .terminal(id)
    case .empty: nil
    }
  }

  /// Dokąd wraca ekran po zamknięciu terminala „×" (`termExitTarget` w PWA): ostatnio aktywna
  /// sesja projektu, bez niej ostatnio aktywna sesja w ogóle; `nil` = lista. Wpis agenta, który stał
  /// w zamkniętym terminalu, odpada — jego ekranem był ten terminal.
  public func terminalExitSession(cwd: String?, closedTerminal: String) -> String? {
    let pool = sessions.values.filter { $0.termId != closedTerminal }
    let key = cwd.map(ProjectPath.normalized)
    let inProject = key.map { key in pool.filter { ProjectPath.normalized($0.cwd) == key } } ?? []
    return Self.lastActive(inProject.isEmpty ? Array(pool) : inProject)?.id
  }

  /// Dokąd wraca ekran po zamknięciu sesji: ostatnio aktywna siostra Claude (Codex
  /// i nieznany silnik nie mają transkryptu do pokazania), `nil` = na listę. Liczone w chwili
  /// tapnięcia — po odpowiedzi serwera zamykanej sesji może już nie być w mapie.
  public func closeReturnSession(_ closedId: String) -> String? {
    guard let cwd = projectCwd(ofSession: closedId) else { return nil }
    let siblings = projectTabs(cwd).filter { $0.id != closedId && $0.engine == nil }
    return Self.lastActive(siblings)?.id
  }

  /// Zakładanie zablokowane na liście z cache albo przy `canLaunch == false`.
  /// Po świeżej liście brak `herdr` = „nie wiem", nie „nie wolno":
  /// wygaszenie jedynej akcji na ułamek sekundy przed ramką startową byłoby migotaniem, a granicą
  /// i tak jest serwer.
  public var launchBlocked: Bool { listStale || (herdr.map { !$0.canLaunch } ?? false) }

  /// Zdanie serwera, dlaczego nie wolno zakładać (`HerdrStatus.detail`); `nil` = copy zapasowe UI.
  public var launchBlockedDetail: String? {
    if listStale { return CoreCopy.noConnection }
    return launchBlocked ? herdr?.detail : nil
  }

  // MARK: - Pomocnicze

  static func byAge(_ list: [SessionSummary]) -> [SessionSummary] {
    list.sorted { a, b in
      let (bornA, bornB) = (ISOTime.parse(a.createdAt), ISOTime.parse(b.createdAt))
      if bornA != bornB { return (bornA ?? .distantPast) < (bornB ?? .distantPast) }
      return a.id < b.id
    }
  }

  static func lastActive(_ list: [SessionSummary]) -> SessionSummary? {
    var best: (session: SessionSummary, at: Date, born: Date)?
    for session in list {
      let at = ISOTime.parse(session.lastActivityAt) ?? .distantPast
      let born = ISOTime.parse(session.createdAt) ?? .distantPast
      guard let current = best else {
        best = (session, at, born)
        continue
      }
      if at > current.at || (at == current.at && born > current.born) { best = (session, at, born) }
    }
    return best?.session
  }
}

extension SessionSummary {
  /// „×" istnieje: Codex, nieznany silnik i sesja nieobsługiwana go nie mają —
  /// nigdy martwy przycisk.
  public var canClose: Bool { engine == nil && !isUnsupported }

  /// „×" na karcie `done` zdejmuje samą kartę (panelu już nie ma) — etykieta mówi skutek.
  public var closeForgetsCard: Bool { state == .done }
}
