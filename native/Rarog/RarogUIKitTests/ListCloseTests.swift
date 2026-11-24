import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import XCTest

// Zamykanie z listy bez pytania: przesunięcie wiersza zamyka od razu, więc dwa szybkie
// przesunięcia różnych wierszy muszą wyjść oba. Do tego dnia drugie zamknięcie, wysłane w trakcie pierwszego,
// przepadało bez słowa (jedna blokada na całą apkę).

private let project = "/Users/demo/Projects/willow"

@MainActor
final class ListCloseTests: XCTestCase {
  /// Dwa zamknięcia różnych sesji w drodze naraz: oba wychodzą, to samo drugi raz nie. „×" w nagłówku (uzbrojenie,
  /// Cmd+X) innej sesji działa w trakcie, tej samej — nie.
  func testConcurrentClosesBothGoOut() async throws {
    let hold = CloseHold()
    let store = try makeStore(hold)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    XCTAssertEqual(navigation.requestClose("a", state: store.state, now: Date()), .armed, "„×” bez zamknięć w drodze")
    navigation.disarmClose()
    let first = Task { await navigation.close("a", store: store) }
    let started = await waitUntil { await hold.requested == ["a"] }
    XCTAssertTrue(started)
    XCTAssertEqual(navigation.requestClose("a", state: store.state, now: Date()), .unavailable, "ta sama w drodze")
    XCTAssertEqual(navigation.requestClose("b", state: store.state, now: Date()), .armed, "inna sesja w trakcie")
    navigation.disarmClose()
    let second = Task { await navigation.close("b", store: store) }
    let both = await waitUntil { await hold.requested == ["a", "b"] }
    XCTAssertTrue(both, "drugie zamknięcie wychodzi od razu")
    XCTAssertEqual(navigation.closing, ["a", "b"])
    await navigation.close("a", store: store)
    let requested = await hold.requested
    XCTAssertEqual(requested, ["a", "b"], "to samo zamknięcie drugi raz nie wychodzi")
    await hold.releaseAll()
    await first.value
    await second.value
    XCTAssertTrue(navigation.closing.isEmpty)
  }

  /// The current tab's "×" turns into a spinner while its close is on the way and takes no press, then the screen
  /// goes to the sister the human came from.
  func testTabCloseSpinsWhileClosing() async throws {
    let hold = CloseHold()
    let store = try makeStore(hold)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("a")
    XCTAssertEqual(navigation.tabClose(store.state)?.glyph, .idle)
    let close = Task { await navigation.close("a", store: store) }
    let started = await waitUntil { await hold.requested == ["a"] }
    XCTAssertTrue(started)
    let closing = try XCTUnwrap(navigation.tabClose(store.state))
    XCTAssertEqual(closing.glyph, .closing, "a spinner in place of the “×”")
    XCTAssertFalse(closing.acts, "no press while the close is on its way")
    await hold.releaseAll()
    await close.value
    XCTAssertEqual(navigation.detail, .session("b"), "the screen goes to the sister")
  }

  /// Siostra, do której wraca ekran, sama jest zamykana: po zamknięciu lista, nie zamykana sesja.
  func testReturnTargetBeingClosedFallsBackToList() async throws {
    let hold = CloseHold()
    let store = try makeStore(hold)
    XCTAssertEqual(store.state.closeReturnSession("a"), "b", "bez drugiego zamknięcia ekran wróciłby do b")
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("a")
    let first = Task { await navigation.close("a", store: store) }
    let started = await waitUntil { await hold.requested == ["a"] }
    XCTAssertTrue(started)
    let second = Task { await navigation.close("b", store: store) }
    let both = await waitUntil { await hold.requested == ["a", "b"] }
    XCTAssertTrue(both)
    await hold.release("a")
    await first.value
    XCTAssertNil(navigation.detail, "lista zamiast sesji w trakcie zamykania")
    await hold.releaseAll()
    await second.value
  }

  /// Siostra zamknięta PIERWSZA, a lista (ramka SSE) jeszcze jej nie zdjęła: po zamknięciu sesji z ekranu dalej
  /// lista, nie zamknięta już siostra.
  func testReturnTargetClosedFirstFallsBackToList() async throws {
    let hold = CloseHold()
    let store = try makeStore(hold)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("a")
    let first = Task { await navigation.close("a", store: store) }
    let started = await waitUntil { await hold.requested == ["a"] }
    XCTAssertTrue(started)
    let second = Task { await navigation.close("b", store: store) }
    let both = await waitUntil { await hold.requested == ["a", "b"] }
    XCTAssertTrue(both)
    await hold.release("b")
    await second.value
    XCTAssertNotNil(store.state.sessions["b"], "bez ramki SSE lista dalej ma b")
    await hold.release("a")
    await first.value
    XCTAssertNil(navigation.detail, "lista zamiast zamkniętej siostry")
  }

  // MARK: - Pomocnicze

  /// Prawdziwy magazyn z dwiema sesjami jednego projektu: `b` ostatnio aktywna, więc to ona jest celem powrotu z `a`.
  private func makeStore(_ hold: CloseHold) throws -> RarogStore {
    let store = RarogStore(
      transport: UIKitTransport.holdingCloses(hold), rules: MutationRules(),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), clientBuild: 1)
    store.dispatch(.loggedIn)
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    try frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#)
    let sessions = [("a", 600), ("b", 10)].map { id, activityAgo in
      #"""
      {"id":"\#(id)","cwd":"\#(project)","title":"willow","state":"done","stateSince":"\#(iso(30))",
       "createdAt":"\#(iso(900))","lastActivityAt":"\#(iso(TimeInterval(activityAgo)))"}
      """#
    }
    try frame(store, #"{"type":"sessions-snapshot","sessions":[\#(sessions.joined(separator: ","))]}"#)
    return store
  }

  private func frame(_ store: RarogStore, _ json: String) throws {
    let event = try EventDecoder.decode(Data(json.utf8)).get().event
    store.dispatch(.frame(event, source: .global, cursor: nil))
  }

  private func iso(_ secondsAgo: TimeInterval) -> String {
    Date().addingTimeInterval(-secondsAgo).formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true))
  }

  private func waitUntil(_ condition: @MainActor () async -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + .seconds(3)
    while !(await condition()) {
      if ContinuousClock.now > deadline { return false }
      try? await Task.sleep(for: .milliseconds(5))
    }
    return true
  }
}
