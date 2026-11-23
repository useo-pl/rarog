import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Terminale w magazynie: sesje a faza sceny, wylogowanie i zgodność; zamknięcie przed `DELETE`;
// lista terminali co ≤ 5 s tylko na ekranie projektu.

private let cwd = "/Users/demo/Projects/rarog"
private let termId = "0123456789abcdef"

@MainActor
private func loggedInStore(terminal: Bool = true, renderer: SentenceRenderer? = nil) async throws
  -> (RarogStore, FakeTransport, VirtualClock)
{
  let (store, transport) = makeStore(renderer: renderer)
  let clock = VirtualClock()
  store.terminalArea.sleep = { await clock.sleep($0) }
  await store.start()
  await until("połączenie") { store.state.global == .online }
  transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
  await until("zgodność") { store.state.compat == .ok }
  let version = #"{"version":"1","protocolVersion":3,"serverStartId":"s1","termEnabled":\#(terminal)}"#
  store.dispatch(.versionProbed(try JSONDecoder().decode(VersionInfo.self, from: Data(version.utf8))))
  return (store, transport, clock)
}

/// Sesja połączona i żywa — gniazdo otwarte.
@MainActor
private func liveSession(_ store: RarogStore, _ transport: FakeTransport, _ target: TerminalTarget) async throws
  -> (TerminalSession, FakeTerminalSocket)
{
  let session = try #require(store.terminalSession(target))
  let before = transport.terminal.sockets.count
  session.start()
  await until("gniazdo") { transport.terminal.sockets.count == before + 1 }
  let socket = try #require(transport.terminal.lastSocket)
  socket.emit(.opened)
  await until("żywe") { session.phase == .live }
  return (session, socket)
}

@MainActor
@Suite("magazyn: terminale")
struct StoreTerminalTests {
  @Test("bez zalogowania nie ma sesji terminala")
  func noSessionWhenLoggedOut() async throws {
    let (store, _) = makeStore(transport: FakeTransport(credential: false))
    await store.start()
    let target = try #require(TerminalTarget.shell(cwd: cwd))
    #expect(store.terminalSession(target) == nil)
  }

  @Test("sesja terminala z magazynu tłumaczy ramkę `err` rendererem magazynu, nie domyślnym")
  func terminalUsesStoreRenderer() async throws {
    let marker: SentenceRenderer = { text, ref in ref.map { "R:\($0.code)" } ?? text }
    let (store, transport, _) = try await loggedInStore(renderer: marker)
    let (session, socket) = try await liveSession(store, transport, try #require(TerminalTarget.shell(cwd: cwd)))
    socket.emit(.frame(.error(message: "The terminal was taken over. Open it again.", ref: SentenceRef(code: "term.taken-over"))))
    await until("zatrzymanie") { session.phase.isHalted }
    #expect(session.phase == .failed(.server("R:term.taken-over")))
    session.stop()
  }

  @Test("tło usypia sesję (gniazdo zamknięte), powrót budzi ją gniazdem `fresh=1` — bez POST, bo id jest znane")
  func scenePhase() async throws {
    let (store, transport, _) = try await loggedInStore()
    let (session, socket) = try await liveSession(store, transport, try #require(TerminalTarget.shell(cwd: cwd)))
    store.setScenePhase(.inactive)
    #expect(session.phase == .live)
    store.setScenePhase(.background)
    #expect(session.phase == .suspended)
    #expect(socket.closedByClient)
    store.setScenePhase(.active)
    await until("nowe gniazdo") { transport.terminal.sockets.count == 2 }
    #expect(transport.terminal.opens.count == 1, "powrót bez `POST`")
    #expect(transport.terminal.socketCalls.map(\.fresh) == [true, true])
    #expect(transport.terminal.socketCalls.map(\.direct) == [false, true])
  }

  @Test("401 przy POST po odmowie gniazda bez POST wylogowuje, jak każdy 401 terminala")
  func unauthorizedAfterDirectRefusalLogsOut() async throws {
    let (store, transport, _) = try await loggedInStore()
    let (session, _) = try await liveSession(store, transport, try #require(TerminalTarget.shell(cwd: cwd)))
    store.setScenePhase(.background)
    // Klucz odrzucony w tle: serwer odmawia upgrade'u (zamknięcie bez `opened`), a `POST` po odmowie dostaje 401.
    transport.terminal.set { $0.openReplies = [.failure(.unauthorized(APIFailure(status: 401)))] }
    store.setScenePhase(.active)
    await until("gniazdo bez POST") { transport.terminal.sockets.count == 2 }
    let refused = try #require(transport.terminal.lastSocket)
    #expect(refused.direct)
    refused.drop()
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    #expect(transport.terminal.opens.count == 2, "jeden `POST` po odmowie")
    #expect(session.phase == .idle)
    #expect(transport.terminal.sockets.count == 2, "po wylogowaniu bez kolejnego gniazda")
  }

  @Test("401 strumienia: wylogowanie kończy sesje terminala, nic po nim nie wraca")
  func logoutStopsSessions() async throws {
    let (store, transport, _) = try await loggedInStore()
    let (session, socket) = try await liveSession(store, transport, try #require(TerminalTarget.shell(cwd: cwd)))
    transport.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    #expect(session.phase == .idle)
    #expect(socket.closedByClient)
    #expect(store.state.terminals == TerminalListState())
  }

  @Test("401 przy POST terminala wylogowuje (ta sama droga co reszta akcji)")
  func unauthorizedOpenLogsOut() async throws {
    let (store, transport, _) = try await loggedInStore()
    transport.terminal.set { $0.openReplies = [.failure(.unauthorized(APIFailure(status: 401)))] }
    let target = try #require(TerminalTarget.shell(cwd: cwd))
    let session = try #require(store.terminalSession(target))
    session.start()
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    #expect(session.phase == .idle)
  }

  @Test("niezgodność trwała po `hello`: żywe terminale stają ze zdaniem bramki")
  func incompatibleBlocks() async throws {
    let (store, transport, _) = try await loggedInStore()
    let (session, socket) = try await liveSession(store, transport, try #require(TerminalTarget.popup(cwd: cwd, role: .popup)))
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1","minClientBuild":99}"#)
    await until("blokada") { session.phase.isHalted }
    #expect(session.phase == .failed(.incompatible(CoreCopy.updateApp)))
    #expect(socket.closedByClient)
  }

  @Test("zamknięcie: sesja tego terminala staje PRZED `DELETE` (bez POST, który by go wskrzesił), wpis znika")
  func closeStopsSessionFirst() async throws {
    let (store, transport, clock) = try await loggedInStore()
    transport.terminal.set { $0.list = .make([(termId, cwd, 1, .shell), ("fedcba9876543210", cwd, 2, .shell)]) }
    store.refreshTerminalsNow()
    await until("lista") { store.state.terminals.entries.count == 2 }
    let entry = try #require(store.state.terminals.entry(id: termId))
    let (session, socket) = try await liveSession(store, transport, .existing(entry))
    // Serwer po `DELETE` już go nie zna — świeża lista po zamknięciu to potwierdza.
    transport.terminal.set { $0.list = .make([("fedcba9876543210", cwd, 2, .shell)]) }
    #expect(await store.closeTerminal(id: termId) == .closed)
    #expect(session.phase == .idle)
    #expect(socket.closedByClient)
    #expect(transport.terminal.read(\.closes) == [termId])
    #expect(store.state.terminals.shells(in: cwd).map(\.slot) == [2])
    // Zamknięte gniazdo z serwera i czas nie dają nowego POST ani gniazda (wpis z listy łączył się bez POST).
    socket.drop()
    clock.advance(by: .seconds(30))
    try? await Task.sleep(for: .milliseconds(30))
    #expect(transport.terminal.opens.isEmpty)
    #expect(transport.terminal.sockets.count == 1)
    // Serwer już go nie zna: 404 = „nie ma", wpis i tak znika.
    transport.terminal.set {
      $0.closeResult = .http(APIFailure(status: 404, code: "not-found"))
      $0.list = .empty
    }
    #expect(await store.closeTerminal(id: "fedcba9876543210") == .gone)
    #expect(store.state.terminals.entries.isEmpty)
    await until("świeża lista po zamknięciu") { transport.terminal.read(\.listCalls) >= 3 }
    try? await Task.sleep(for: .milliseconds(30))
    #expect(store.state.terminals.entries.isEmpty)
  }

  @Test("lista wysłana PRZED zamknięciem terminala nie przywraca go po nim; po zamknięciu idzie świeża")
  func staleListAfterClose() async throws {
    let (store, transport, _) = try await loggedInStore()
    let other = "fedcba9876543210"
    transport.terminal.set { $0.list = .make([(termId, cwd, 1, .shell), (other, cwd, 2, .shell)]) }
    store.refreshTerminalsNow()
    await until("lista") { store.state.terminals.entries.count == 2 }
    // Odczyt w drodze ze starym stanem serwera (jeszcze z terminalem A).
    transport.terminal.hold("list")
    store.refreshTerminalsNow()
    await until("odczyt w drodze") { transport.terminal.heldCount("list") == 1 }
    transport.terminal.set { $0.list = .make([(other, cwd, 2, .shell)]) }
    #expect(await store.closeTerminal(id: termId) == .closed)
    await until("świeży odczyt po zamknięciu") { transport.terminal.heldCount("list") == 2 }
    transport.terminal.release("list")
    await until("świeża lista") { transport.terminal.read(\.listCalls) == 3 && store.state.terminals.loadedAt != nil }
    try? await Task.sleep(for: .milliseconds(30))
    #expect(store.state.terminals.entries.map(\.id) == [other])
  }

  @Test("historia, która wraca po wylogowaniu, nie trafia na ekran")
  func historyAfterLogout() async throws {
    let (store, transport, _) = try await loggedInStore()
    transport.terminal.hold("history")
    let pending = Task { await store.terminalHistory(id: termId) }
    await until("historia w drodze") { transport.terminal.heldCount("history") == 1 }
    transport.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    transport.terminal.release("history")
    #expect(await pending.value == .failed(nil))
  }

  @Test("lista: co 5 s tylko na ekranie projektu, na wierzchu i przy włączonym terminalu serwera")
  func listPolling() async throws {
    let (store, transport, clock) = try await loggedInStore()
    transport.terminal.set { $0.list = .make([(termId, cwd, 1, .shell), ("00000000000000ff", cwd, 0, .lazygit)]) }
    store.watchTerminals(true)
    await until("pierwsza lista") { store.state.terminals.loadedAt != nil }
    #expect(store.state.terminals.shells(in: cwd).map(\.id) == [termId])
    #expect(store.state.terminals.popup(in: cwd, role: .lazygit)?.slot == 0)
    await until("sen pętli") { clock.sleeping == [.seconds(5)] }
    clock.advance(by: .seconds(5))
    await until("druga lista") { transport.terminal.read(\.listCalls) == 2 }
    store.watchTerminals(false)
    await until("pętla stoi") { clock.sleeping.isEmpty }
    clock.advance(by: .seconds(30))
    try? await Task.sleep(for: .milliseconds(30))
    #expect(transport.terminal.read(\.listCalls) == 2)
    // Porażka odczytu zostawia ostatnią listę.
    transport.terminal.set { $0.listResult = .offline(.notConnectedToInternet) }
    await store.fetchTerminals()
    #expect(store.state.terminals.refreshFailed && store.state.terminals.entries.count == 2)
  }

  @Test("serwer bez terminala (`termEnabled: false`): lista nie pyta wcale")
  func listNeedsCapability() async throws {
    let (store, transport, _) = try await loggedInStore(terminal: false)
    store.watchTerminals(true)
    await store.fetchTerminals()
    #expect(transport.terminal.read(\.listCalls) == 0)
    store.watchTerminals(false)
  }

  @Test("historia wraca do wołającego i nie zostaje w stanie magazynu")
  func historyNotStored() async throws {
    let (store, transport, _) = try await loggedInStore()
    let before = store.state
    guard case let .loaded(history) = await store.terminalHistory(id: termId) else {
      Issue.record("historia nie przyszła")
      return
    }
    #expect(history.text == "$ ls\n")
    #expect(transport.terminal.read(\.historyCalls).map(\.lines) == [1000])
    #expect(store.state == before)
  }
}
