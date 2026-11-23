import Foundation
import RarogCore
@testable import RarogUI
import Testing

// Ślad zmiany zaznaczenia listy: diagnoza odbicia po Cmd+L w `client.log`.
// Właściciel: lista.

@Suite("ślad zaznaczenia listy")
struct ListSelectionTraceTests {
  @Test("końcówki identyfikatorów i czas od zmiany ekranu; bez tytułów i treści")
  func line() {
    #expect(DiagnosticsTrace.listSelection(from: "herdr-w1-p1", to: "herdr-w1-p2", sinceScreenChange: 0.0414)
      == "lista: zaznaczenie …-w1-p1 → …-w1-p2, 41 ms po zmianie ekranu")
    #expect(DiagnosticsTrace.listSelection(from: nil, to: "s1", sinceScreenChange: nil)
      == "lista: zaznaczenie nic → s1, pierwszy ekran")
    #expect(DiagnosticsTrace.listSelection(from: "abc", to: nil, sinceScreenChange: 2.5)
      == "lista: zaznaczenie abc → nic, 2500 ms po zmianie ekranu")
  }

  @MainActor
  @Test("nawigacja notuje chwilę zmiany ekranu; ten sam ekran jej nie przesuwa")
  func screenChangedAt() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(navigation.screenChangedAt == nil)
    navigation.selectSession("s1")
    let first = navigation.screenChangedAt
    #expect(first != nil)
    navigation.selectSession("s1")
    #expect(navigation.screenChangedAt == first, "ta sama sesja to nie zmiana ekranu")
  }
}

@Suite("ślad Cmd+L")
struct ScreenTraceTests {
  @Test("Cmd+L z celem albo bez")
  func previousProjectLine() {
    #expect(DiagnosticsTrace.previousProject(target: "/Users/x/rarog") == "skrót Cmd+L: do …/rarog")
    #expect(DiagnosticsTrace.previousProject(target: nil) == "skrót Cmd+L: brak celu")
  }
}

@Suite("Cmd+L: jedno wciśnięcie = jeden skok")
@MainActor
struct PreviousProjectRepeatTests {
  @Test("drugie wywołanie w 0,3 s pominięte, osobne wciśnięcie po 1 s przyjęte; zegar wstecz nie blokuje")
  func repeatWindow() {
    let navigation = RarogNavigation()
    let start = Date(timeIntervalSince1970: 1_000)
    #expect(navigation.acceptsPreviousProject(at: start), "pierwsze wciśnięcie")
    #expect(!navigation.acceptsPreviousProject(at: start), "to samo wciśnięcie w tej samej milisekundzie")
    #expect(!navigation.acceptsPreviousProject(at: start.addingTimeInterval(0.29)), "w oknie 0,3 s")
    #expect(navigation.acceptsPreviousProject(at: start.addingTimeInterval(1.1)), "osobne wciśnięcie")
    #expect(navigation.acceptsPreviousProject(at: start), "zegar cofnięty — nie blokuje na zawsze")
  }
}
