import Foundation
import RarogContract
import RarogCore

// Nawigacja terminala: trasa
// terminala i jej tożsamość, zakładanie terminala (zaproszenie, „Nowy terminal", Cmd+Shift+N), okna nad
// ekranem (Cmd+F powłoka, Cmd+G lazygit) i historia trasy. Ekran terminala robi resztę sam (połączenie,
// „×", schowek). Treści terminala tu nie ma: id, katalogi i role. Właściciel: terminal.

/// Terminal zakładany z tego urządzenia, którego id jeszcze nie znamy.
public struct TerminalOpening: Hashable, Sendable {
  public enum Slot: Hashable, Sendable {
    /// Zakładka-zaproszenie projektu bez terminala: slot 1 (idempotentny — drugi raz to ta sama powłoka).
    case first
    /// Świadome „Nowy terminal" i Cmd+Shift+N: najniższy wolny slot wybiera serwer (`slot: next`).
    case next
  }

  public let cwd: String
  public let slot: Slot
  /// Tożsamość ekranu: dwa „Nowe terminale" z rzędu to dwa ekrany, nie jeden.
  public let token: UUID

  public init(cwd: String, slot: Slot, token: UUID = UUID()) {
    self.cwd = cwd
    self.slot = slot
    self.token = token
  }
}

/// Okno terminala nad ekranem: rola popupowa w katalogu projektu.
public struct TerminalPopupRequest: Identifiable, Hashable, Sendable {
  public let cwd: String
  /// `popup` (Cmd+F, goła powłoka) albo `lazygit` (Cmd+G).
  public let role: TerminalRole

  public var id: String { "\(role.rawValue)\u{0}\(cwd)" }
}

/// Arkusz historii jednego terminala.
public struct TerminalHistoryRequest: Identifiable, Hashable, Sendable {
  public let terminalId: String

  public var id: String { terminalId }
}

/// Ekran „Nowego terminala" (albo terminala przeniesionego przez serwer pod inne id), który dostał id:
/// trasa mówi już `.terminal(id)`, a widok trzyma tożsamość, z którą powstał — bez nowego kontrolera,
/// sesji i połączenia.
struct AdoptedScreen: Equatable {
  let terminalId: String
  let key: String
}

/// Co rysuje trasa terminala.
public struct TerminalRoute: Equatable {
  /// Tożsamość ekranu (`.id` widoku): zmiana = nowy widok. Ekran tego samego terminala może wrócić z parkingu
  /// (do 2 min), inny terminal to nowy kontroler i nowe połączenie.
  public let key: String
  /// Cel sesji terminala w chwili POWSTANIA ekranu (ekran nie zmienia celu w trakcie życia).
  public let target: TerminalTarget
  /// Katalog projektu (`nil` = terminal spoza listy bez podpowiedzi, np. z powiadomienia).
  public let cwd: String?
  /// Terminal zakładany z tego urządzenia, którego id jeszcze nie znamy (`nil` = id znany).
  public var opening: TerminalOpening?
}

extension RarogNavigation {
  /// Katalog terminala: lista `GET /api/term`, a bez niej podpowiedź z chwili otwarcia.
  func terminalCwd(_ id: String, state: AppState) -> String? {
    state.projectCwd(ofTerminal: id) ?? terminalCwds[id]
  }

  // MARK: - Trasa

  /// Terminal na ekranie: trasa terminala, „Nowy terminal" przed odpowiedzią i wpis agenta z `termId`
  /// (tap w wiersz prowadzi do terminala, w którym ten agent stoi). `nil` = na ekranie nie ma
  /// terminala (albo id spoza kształtu `TERM_ID_RE`).
  public func terminalRoute(_ state: AppState) -> TerminalRoute? {
    switch detail {
    case let .terminal(id):
      return route(terminal: id, state: state, cwdHint: nil)
    case let .session(id):
      guard let termId = state.hostTerminal(ofSession: id) else { return nil }
      return route(terminal: termId, state: state, cwdHint: state.projectCwd(ofSession: id))
    case let .openingTerminal(opening):
      let target = opening.slot == .first
        ? TerminalTarget.shell(cwd: opening.cwd, slot: 1) : TerminalTarget.newShell(cwd: opening.cwd)
      return target.map { TerminalRoute(key: opening.token.uuidString, target: $0, cwd: opening.cwd, opening: opening) }
    case .project, nil:
      return nil
    }
  }

  /// Wpis agenta stojącego w terminalu Raroga: trasa `.session(id)` przechodzi na trasę tego
  /// terminala. Karta takiego agenta znika z listy razem z procesem (`/exit`), a powłoka zostaje — trasa
  /// trzymana przez id sesji zgubiłaby wtedy ekran, na który człowiek patrzy. Tożsamość ekranu jest ta sama
  /// (kluczem trasy jest id terminala), więc przepięcie nie buduje nowego kontrolera i nie jest zmianą ekranu.
  public func settleHostedRoute(_ state: AppState) {
    guard case let .session(id) = detail, let termId = state.hostTerminal(ofSession: id) else { return }
    // Katalog z sesji, zanim lista terminali pozna ten wpis (wejście z powiadomienia): nagłówek i pasek zakładek.
    if terminalCwds[termId] == nil, let cwd = state.projectCwd(ofSession: id) { terminalCwds[termId] = cwd }
    adopting = true
    detail = .terminal(termId)
    adopting = false
  }

  /// Id terminala na ekranie, gdy jest znane.
  public var currentTerminalId: String? {
    if case let .terminal(id) = detail { return id }
    return nil
  }

  private func route(terminal id: String, state: AppState, cwdHint: String?) -> TerminalRoute? {
    let key = adopted?.terminalId == id ? adopted?.key ?? id : id
    // Wpis z listy: każde ponowienie wysyła ten sam katalog, slot i rolę (powłoka wraca po restarcie Raroga).
    if let entry = state.terminals.entry(id: id) {
      return TerminalRoute(key: key, target: .existing(entry), cwd: ProjectPath.normalized(entry.cwd))
    }
    guard let target = TerminalTarget.id(id) else { return nil }
    return TerminalRoute(key: key, target: target, cwd: terminalCwds[id] ?? cwdHint)
  }

  /// Ekran poznał id terminala (pierwsza odpowiedź `POST`, terminal przeniesiony przez serwer): trasa
  /// „Nowego terminala" przechodzi na `.terminal(id)` — inaczej ekran odtworzony od nowa (inna klasa
  /// rozmiaru, powrót z innego projektu) poprosiłby o KOLEJNĄ powłokę. Tożsamość widoku zostaje. Zgłoszenie
  /// ekranu, który już nie stoi na trasie, nic nie zmienia.
  public func terminalIdentified(_ id: String, screen key: String, state: AppState) {
    guard let route = terminalRoute(state), route.key == key else { return }
    // Katalog zapamiętany, póki lista go zna: udany `DELETE` zdejmuje wpis z listy PRZED `onClose`, a powrót
    // po „×" ma trafić do sesji TEGO projektu, nie do ostatnio aktywnej w ogóle.
    if let cwd = route.cwd { terminalCwds[id] = cwd }
    switch detail {
    case .openingTerminal:
      break
    case let .terminal(current) where current != id:
      break
    default:
      // Ten sam terminal albo wpis agenta (jego `termId` poprawi lista sesji).
      return
    }
    adopted = AdoptedScreen(terminalId: id, key: key)
    adopting = true
    detail = .terminal(id)
    adopting = false
  }

  /// Czy ten widok trasy może prosić serwer o NOWĄ powłokę (`slot: next`). Prosi tylko widok, który pierwszy
  /// narysował dane otwarcie: widok odtworzony przed pierwszą odpowiedzią `POST` (ponowne zalogowanie,
  /// przebudowa kolumny) nie zna przydziału w drodze, a drugi `next` założyłby drugą powłokę — dostaje
  /// zdanie „nie wiadomo, czy powstał" i świadome „Spróbuj od nowa". Slot 1 (zaproszenie) jest idempotentny.
  public func claimsOpening(_ opening: TerminalOpening, view: UUID) -> Bool {
    guard opening.slot == .next else { return true }
    if let owner = openingOwners[opening.token] { return owner == view }
    openingOwners[opening.token] = view
    return true
  }

  /// „×" zamknął powłokę: ostatnio aktywna sesja projektu, inna sesja albo lista.
  public func terminalClosed(screen key: String, state: AppState) {
    guard let route = terminalRoute(state), route.key == key else { return }
    let closed: String? = switch detail {
    case let .terminal(id): id
    case let .session(id): state.hostTerminal(ofSession: id)
    default: nil
    }
    detail = state.terminalExitSession(cwd: route.cwd, closedTerminal: closed ?? "").map(Detail.session)
  }

  // MARK: - Zakładanie

  /// Zaproszenie (slot 1) albo „Nowy terminal" / Cmd+Shift+N (`slot: next`). Odmowa mówi zdanie pod paskiem
  /// i nie zmienia ekranu; zgoda otwiera ekran, który sam zakłada powłokę.
  public func openTerminal(_ slot: TerminalOpening.Slot, in cwd: String, state: AppState, token: UUID = UUID()) {
    if let refusal = terminalRefusal(slot, in: cwd, state: state) {
      post(refusal)
      return
    }
    detail = .openingTerminal(TerminalOpening(cwd: ProjectPath.normalized(cwd), slot: slot, token: token))
  }

  /// Dlaczego nie wolno założyć terminala; `nil` = wolno. Te same bramki co „+" sesji (zakładanie wyłączone,
  /// lista z pamięci podręcznej), plus sufit slotów projektu — powrót do istniejącego terminala ich nie zna.
  public func terminalRefusal(_ slot: TerminalOpening.Slot, in cwd: String, state: AppState) -> String? {
    guard state.terminalFeature == .on else { return UICopy.terminalOff }
    if state.launchBlocked { return UICopy.launchBlocked(state.launchBlockedDetail) }
    if slot == .next, state.projectTerminals(cwd).count >= TerminalSlot.max { return UICopy.terminalSlotsFull }
    return nil
  }

  // MARK: - Okna Cmd+F i Cmd+G

  /// Czy jest komu otworzyć okno: projekt na ekranie i serwer, który zna terminal (sonda wersji doszła).
  /// Bramka skrótów terminala w menu i przycisku nagłówka; wyłączony terminal mówi zdanie dopiero po naciśnięciu.
  public func canTogglePopup(_ state: AppState) -> Bool {
    popupProjectCwd(state) != nil && state.terminalFeature != .unknown
  }

  /// The project a window shortcut acts on: the open window's own project first (the tree's terminal glyph can open
  /// another project's window, or one with no project on screen), else the project on screen.
  private func popupProjectCwd(_ state: AppState) -> String? {
    popup?.cwd ?? currentProjectCwd(state)
  }

  /// Skrót okna jest przełącznikiem PARY (rola, katalog): ten sam skrót nad tym samym projektem zamyka,
  /// inny przełącza (Cmd+F nad lazygitem pokazuje powłokę). Otwarte okno zostaje przy swoim projekcie; bez okna
  /// i bez projektu na ekranie nic się nie dzieje;
  /// wyłączony terminal mówi zdanie.
  public func togglePopup(_ role: TerminalRole, state: AppState) {
    togglePopup(role, in: popupProjectCwd(state), state: state)
  }

  /// The same toggle for a named project: the terminal glyph in a project header of the tree opens the shell window
  /// in that project (`ProjectRowModel.cwd`, already normalized), whatever stands on the screen. `nil` does nothing.
  public func togglePopup(_ role: TerminalRole, in cwd: String?, state: AppState) {
    guard role.isPopup, let cwd else { return }
    // Formularz trzyma: skrót okna przy otwartym formularzu milczy.
    guard sheet?.isForm != true else { return }
    guard state.terminalFeature == .on || Self.demoTerminal else {
      post(UICopy.terminalOff)
      return
    }
    let request = TerminalPopupRequest(cwd: cwd, role: role)
    // Nad innym oknem (diff, historia) skrót je zastępuje: jeden arkusz naraz.
    sheet = popup == request ? nil : .terminal(request, token: UUID())
  }

  /// Whether a project header of the tree shows the pop-up terminal glyph: only with the terminal on (off, the glyph
  /// would stand dead at every project), or in the UI test seam.
  func showsProjectPopupGlyph(_ state: AppState) -> Bool {
    state.terminalFeature == .on || Self.demoTerminal
  }

  /// Okno terminala w demo bez terminala — tylko build Debug i szew testów UI (``TerminalDemoSeam``).
  private static var demoTerminal: Bool {
    #if DEBUG
    TerminalDemoSeam.isOn
    #else
    false
    #endif
  }

  /// „×", tap w tło, `exit` w oknie — zamknięcie tylko odpina, powłoka żyje dalej.
  public func closePopup() {
    if popup != nil { sheet = nil }
  }

  // MARK: - Historia

  public func showTerminalHistory(_ terminalId: String) {
    openSheet(.history(TerminalHistoryRequest(terminalId: terminalId), token: UUID()))
  }

  public func closeTerminalHistory() {
    if terminalHistory != nil { sheet = nil }
  }
}
