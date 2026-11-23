import Foundation
import RarogContract

// Pamięć listy po stronie urządzenia: etap tury pod pracującym wierszem i wyniki trzymane w kolejności
// po odczycie; w drzewie projektów zaznaczony wiersz i ostatnio otwarte, trzymane w zwiniętym
// projekcie. Zmienia ją wyłącznie reduktor — widzi każdą ramkę, a `onChange` widoku zlewa ramki i gubił
// krótką delegację. Właściciel: lista.

/// Ostatni etap tury, który wiersz listy pokazuje do jej końca: delegacja (subagent, workflow) albo
/// zadania w tle. Same fakty z drutu — zdanie bez liczników składa RarogUI. Zwykłe narzędzie, myślenie
/// i czekanie na silnik etapem NIE są: linia pod wierszem skakała przy każdym kroku agenta.
public enum TurnStage: Sendable, Equatable {
  /// Aktywność z delegacją (bez licznika sekund) i zadania w tle z tej samej chwili — opis subagenta,
  /// gdy puls aktywności go zgubił.
  case delegation(Activity, tasks: [BackgroundTask])
  /// Ostatni niepusty zestaw zadań w tle tej tury.
  case background([BackgroundTask])
}

/// Zdarzenia pamięci listy spoza ramek (gałąź `CoreEvent.list`).
public enum ListEvent: Sendable, Equatable {
  /// Apka zeszła w tło: obejrzane wyniki wracają na miejsca swojej rangi, gdy nikt nie patrzy, a ostatnio
  /// otwarte wiersze znikają ze zwiniętych projektów.
  case appBackgrounded
  /// Zaznaczenie listy po zmianie trasy (`nil` = trasa bez wiersza albo sama lista). Wiersz, z którego się
  /// zeszło, staje się ostatnio otwartym — w TYM SAMYM kroku, więc nie ma chwili, w której nie byłby ani
  /// zaznaczony, ani trzymany.
  case selected(String?)
  /// Człowiek sam zwinął albo rozwinął te projekty (katalogi): ich ostatnio otwarte wiersze przestają być trzymane.
  case projectsToggled([String])
}

extension AppState {
  /// Stany tury: od startu do jej końca, z decyzją po drodze (zgoda w środku tury nie kończy jej etapu).
  static let turnStates: Set<SessionState> = [.starting, .running, .waitingPermission, .waitingQuestion]

  mutating func applyList(_ event: ListEvent) {
    switch event {
    case .appBackgrounded:
      heldUnread.removeAll()
      heldOpen.removeAll()
    case let .selected(id):
      guard id != listSelection else { return }
      if let left = listSelection, let session = sessions[left] { heldOpen[left] = session.stateSince }
      listSelection = id
    case let .projectsToggled(cwds):
      let toggled = Set(cwds.map(ProjectPath.normalized))
      heldOpen = heldOpen.filter { id, _ in
        sessions[id].map { !toggled.contains(ProjectPath.normalized($0.cwd)) } ?? false
      }
    }
  }

  /// Pamięć listy po zmianie podsumowania sesji (pełny stan, `session-changed`, `state`, `activity`,
  /// odpowiedź na przerwanie). Sesja, której lista już nie zna, zapomina wszystko.
  mutating func noteListMemory(_ id: String) {
    guard let session = sessions[id] else {
      turnStage[id] = nil
      heldUnread[id] = nil
      heldOpen[id] = nil
      turnControl.manualUnread.remove(id)
      turnControl.manualUnreadConfirmed.remove(id)
      return
    }
    // Ręczne „nieprzeczytane” dotyczy stojącego wyniku: nowa tura da nowy wynik, a ten ekran ma odebrać jak zwykle.
    if Self.turnStates.contains(session.state) { turnControl.manualUnread.remove(id) }
    // The server's `markedUnseen` confirms the hand mark: from then on the card alone decides the pulse.
    if !turnControl.manualUnread.contains(id) {
      turnControl.manualUnreadConfirmed.remove(id)
    } else if session.markedUnseen == true {
      turnControl.manualUnreadConfirmed.insert(id)
    }
    noteTurnStage(session)
    noteHeldUnread(session)
    // Ostatnio otwarty wiersz zwalnia nowy stan sesji, jak wynik trzymany w kolejności.
    if let held = heldOpen[id], held != session.stateSince { heldOpen[id] = nil }
  }

  /// Pełny stan listy: pamięć liczy się OD NOWA z bieżących podsumowań. Pełny stan to utrata ciągłości strumienia
  /// (powrót z tła, nowe połączenie), więc pamięć sprzed niego nie wie, czy tura się w międzyczasie nie skończyła
  /// i nie ruszyła następna — etap starej tury wisiałby pod nową. Wyniki trzymane
  /// w kolejności i ostatnio otwarte wiersze zwiniętych projektów wracają na miejsca swojej rangi (lista i tak się
  /// przestawia), etap wraca z żywej delegacji albo zadań w tle; zwykłe narzędzie w chwili powrotu daje wiersz bez
  /// linii aż do następnej delegacji.
  mutating func noteListMemory(snapshot listed: Set<String>) {
    turnStage.removeAll()
    heldUnread.removeAll()
    heldOpen.removeAll()
    // Blokada ręcznego „nieprzeczytane” przeżywa ponowne połączenie — sesja otwarta obok listy nie odbiera
    // wyniku przy powrocie z tła; znika z sesją spoza listy, a nową turę rozpozna `noteListMemory(_:)`.
    turnControl.manualUnread.formIntersection(listed)
    turnControl.manualUnreadConfirmed.formIntersection(listed)
    for id in listed { noteListMemory(id) }
  }

  /// Etap tury: delegacja z bieżącej aktywności, inaczej zadania w tle; bez żadnego z nich
  /// pamięć stoi. Koniec tury (stan spoza ``turnStates``) ją kasuje — `message` i `activity: idle` nie.
  private mutating func noteTurnStage(_ session: SessionSummary) {
    guard Self.turnStates.contains(session.state) else {
      turnStage[session.id] = nil
      return
    }
    let tasks = session.backgroundTasks ?? []
    if var activity = session.activity, activity.kind == .tool, activity.delegation != nil {
      // Licznik sekund tyka w każdej ramce; pamięć trzyma fakt, nie czas.
      activity.elapsedSeconds = nil
      turnStage[session.id] = .delegation(activity, tasks: tasks)
    } else if !tasks.isEmpty {
      turnStage[session.id] = .background(tasks)
    }
  }

  /// Wynik do odebrania widziany tutaj: zapamiętany razem ze swoim `stateSince`. Odczyt (`seen`)
  /// go nie zwalnia — zwalnia nowy stan sesji (inny `stateSince`), pełny stan listy, tło i wylogowanie.
  private mutating func noteHeldUnread(_ session: SessionSummary) {
    if let held = heldUnread[session.id], held != session.stateSince { heldUnread[session.id] = nil }
    if session.state == .waitingInput, !session.resultSeen { heldUnread[session.id] = session.stateSince }
  }
}
