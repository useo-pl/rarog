import Foundation
import RarogContract
import RarogCore

// Modele prezentacji sekcji PROJEKTY i paska zakładek (także zakładek terminali).
// Czyste — widoki tylko rysują. Właściciel: projekty i zakładki.

/// Wiersz projektu: nazwa z liczbą agentów w nawiasie (`agentsBadge`), pod spodem gałąź z rozjazdem i — tylko przy
/// niejednoznacznej nazwie — ścieżka. No state color and no glyph counters; the screen
/// reader hears the count and the state in `spoken`.
public struct ProjectRowModel: Sendable, Equatable, Identifiable {
  public let cwd: String
  public let name: String
  /// How many agents (sessions) live in the project; zero hides the bracket.
  public let agents: Int
  /// Najpilniejszy stan sesji projektu — dziś tylko w zdaniu czytnika; `nil` = projekt bez sesji.
  public let tone: StatusTone?
  public let branch: String?
  /// `↑n` / `↓n`; zero i brak upstreamu chowają strzałkę.
  public let ahead: Int?
  public let behind: Int?
  /// Skrócona ścieżka wyłącznie przy nazwie, która powtarza się w sekcji.
  public let path: String?
  /// Projekt otwarty obok (sesja albo ekran projektu z tego katalogu).
  public let open: Bool
  /// Projekt, do którego skoczy Cmd+L — tylko w etykiecie czytnika; w drzewie bez znacznika.
  public let jumpTarget: Bool
  /// Projekt ma notatkę: dopisek w zdaniu nagłówka. Glif notatki stoi przy każdym projekcie osobnym
  /// przyciskiem (`NoteTabModel`).
  public var hasNote = false

  public var id: String { cwd }

  /// The agent count after the project name, "willow (10)"; `nil` without agents.
  /// Decoration for the screen reader: the header's sentence carries the count.
  public var agentsBadge: String? { agents > 0 ? "(\(agents))" : nil }

  /// Druga linia ma treść (inaczej znika cała, zamiast zabierać wysokość).
  public var hasMeta: Bool { branch != nil || ahead != nil || behind != nil || path != nil }

  /// Wiersz jednym zdaniem dla VoiceOver.
  public var spoken: String {
    var parts = [name]
    if agents > 0 { parts.append(UICopy.agentsSpoken(agents)) }
    if let tone { parts.append(UICopy.toneSpoken(tone)) }
    if let branch { parts.append(UICopy.branchSpoken(branch)) }
    if let ahead { parts.append(UICopy.aheadSpoken(ahead)) }
    if let behind { parts.append(UICopy.behindSpoken(behind)) }
    if let path { parts.append(path) }
    if open { parts.append(UICopy.projectOpenSpoken) }
    if jumpTarget { parts.append(UICopy.projectJumpSpoken) }
    if hasNote { parts.append(UICopy.noteTreeSpoken) }
    return UICopy.list(parts, .comma)
  }
}

/// Zakładka paska projektu: stan niesie kafelek z cyfrą skrótu albo kwadracik przed etykietą (`mark(digit:)`,
/// `TabTokens`), „tu jesteś" — płytka pod zakładką i jasna etykieta.
public struct ProjectTabModel: Sendable, Equatable, Identifiable {
  public enum Kind: Sendable, Equatable {
    case session
    /// Terminal projektu (slot) — etykietą jest proces na pierwszym planie.
    case terminal
    /// Projekt bez terminala: tap zakłada slot 1. `enabled == false` (terminal wyłączony na serwerze) =
    /// wygaszone, tap mówi dlaczego.
    case invite(enabled: Bool)
  }

  /// Tożsamość w pasku (identyfikator dostępności `tab.<id>`): id sesji, `term.<id>` terminala,
  /// `terminal-invite` zaproszenia.
  public let id: String
  public let kind: Kind
  /// Dokąd prowadzi tap (`nil` = zaproszenie — zakłada, nie nawiguje).
  public let target: ProjectTabRef?
  public let label: String
  public let tone: StatusTone
  public let current: Bool
  public let spoken: String

  /// Zaproszenie przy wyłączonym terminalu: wygaszone (tap mówi dlaczego) — atrament ten sam co
  /// u sióstr (`muted2`, ≥ 4,5:1): `idleInk` oblewa audyt kontrastu (2,77:1), a nieczynna
  /// zakładka dalej jest celem z odpowiedzią.
  public var dimmed: Bool { kind == .invite(enabled: false) }

  /// Zaproszenie to sam glif terminala: zakładki jeszcze nie ma, więc nie ma czego
  /// nazwać, a napis w największym piśmie (290 pt) spychał „+" poza ekran. Zdanie niesie czytnik.
  public var showsLabel: Bool {
    if case .invite = kind { return false }
    return true
  }

  /// Identyfikator dostępności: `tab.<id>` zakładek, w których się stoi; zaproszenie to akcja paska jak „+"
  /// (`tabs.terminal-invite`), więc nie wchodzi do liczenia zakładek.
  public var accessibilityId: String {
    if case .invite = kind { return "tabs.terminal-invite" }
    return "tab.\(id)"
  }
}

extension AppState {
  /// Wiersze sekcji PROJEKTY w kolejności rdzenia.
  public func projectRows(openCwd: String?, jumpCwd: String?, calendar: Calendar = .current) -> [ProjectRowModel] {
    let groups = projectGroups(calendar: calendar)
    let names = Dictionary(grouping: groups, by: \.name).mapValues(\.count)
    return groups.map { group in
      let git = group.git
      return ProjectRowModel(
        cwd: group.cwd,
        name: group.name,
        agents: group.sessions.count,
        tone: group.tone,
        branch: git?.branch,
        ahead: git?.ahead.flatMap { $0 > 0 ? $0 : nil },
        behind: git?.behind.flatMap { $0 > 0 ? $0 : nil },
        path: (names[group.name] ?? 0) > 1 ? PathText.shortPath(group.cwd) : nil,
        open: openCwd == group.cwd,
        jumpTarget: jumpCwd == group.cwd && openCwd != group.cwd,
        hasNote: notesAvailable && hasNote(group.cwd) == true
      )
    }
  }

  /// Pasek projektu: sesje od najstarszej, potem terminale po slotach; projekt bez terminala
  /// dostaje jedno zaproszenie, gdy serwer zna terminal (wygaszone przy `termEnabled: false`, bez niego
  /// przy nieznanej sondzie). `current` = zakładka na ekranie; `opening` = na ekranie terminal, którego id
  /// jeszcze nie znamy (zaproszenie, „Nowy terminal") — stoi jako bieżąca zakładka bez celu.
  public func projectTabModels(cwd: String, current: ProjectTabRef?, opening: Bool = false) -> [ProjectTabModel] {
    let sessions = projectTabs(cwd).map { session in
      let isCurrent = current == .session(session.id)
      return ProjectTabModel(
        id: session.id, kind: .session, target: .session(session.id), label: UICopy.tabLabel(session),
        tone: session.statusTone, current: isCurrent, spoken: UICopy.tabSpoken(session, current: isCurrent))
    }
    let terminals = projectTerminals(cwd).map { entry in
      let isCurrent = current == .terminal(entry.id)
      // Bez tonu stanu: `live` to fakt techniczny (strumień podpięty), a zielony kafelek obiecywałby pracę.
      return ProjectTabModel(
        id: "term.\(entry.id)", kind: .terminal, target: .terminal(entry.id), label: UICopy.terminalTabLabel(entry),
        tone: .quiet, current: isCurrent, spoken: UICopy.terminalTabSpoken(entry, current: isCurrent))
    }
    var tabs = sessions + terminals
    let feature = terminalFeature
    if opening {
      tabs.append(ProjectTabModel(
        id: "terminal-opening", kind: .terminal, target: nil, label: UICopy.terminalTabFallback,
        tone: .quiet, current: true, spoken: UICopy.terminalTabSpoken(nil, current: true)))
    } else if case let .terminal(id)? = current, !terminals.contains(where: { $0.target == current }) {
      // Terminal, w którym się stoi, a którego lista jeszcze nie zna (świeży „Nowy terminal", wejście
      // z powiadomienia), jest w pasku zawsze — adres trasy jest pewniejszy od listy.
      tabs.append(ProjectTabModel(
        id: "term.\(id)", kind: .terminal, target: .terminal(id), label: UICopy.terminalTabFallback,
        tone: .quiet, current: true, spoken: UICopy.terminalTabSpoken(nil, current: true)))
    } else if terminals.isEmpty, feature != .unknown {
      let enabled = feature == .on
      tabs.append(ProjectTabModel(
        id: "terminal-invite", kind: .invite(enabled: enabled), target: nil, label: UICopy.terminalTabFallback,
        tone: .quiet, current: false, spoken: enabled ? UICopy.terminalInviteSpoken : UICopy.terminalOff))
    }
    return tabs
  }
}
