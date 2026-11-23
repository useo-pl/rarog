import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Lista slash-komend oglądanej sesji do podpowiedzi po „/”: odczyt przy pierwszym „/”, rytm
// 60 s, odświeżenie po odmowie 400 wysyłki komendy, 401, zmiana sesji. Właściciel: pole.

private let list = CommandList(revision: "r1", commands: [
  CommandChoice(name: "compact", kind: .local, source: .builtin),
  CommandChoice(name: "handoff", kind: .prompt, source: .skill, description: "Opis", argumentHint: "[cel]"),
])

/// Zalogowany magazyn z sesjami `s1` i `s2` (obie czekają na wiadomość), `s1` na ekranie; zegar pod kontrolą testu.
@MainActor
private func commandStore() async throws -> (RarogStore, FakeTransport, VirtualClock) {
  let transport = FakeTransport()
  let clock = VirtualClock()
  let rules = MutationRules(timing: fastTiming)
  transport.gate = MutationGate(policy: rules)
  let store = RarogStore(
    transport: transport, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming,
    clock: { clock.now })
  await store.start()
  await until("online") { store.state.global == .online }
  transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
  let sessions = [Frames.summary("s1", state: "waiting-input"), Frames.summary("s2", state: "waiting-input")]
  transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(sessions.joined(separator: ","))]}"#)
  await until("lista") { store.state.sessionsLoaded }
  store.openSession("s1")
  transport.set { $0.commandLists["s1"] = list }
  return (store, transport, clock)
}

/// Zawór dla atrapy: odczyt stoi, dopóki test go nie otworzy.
private actor Gate {
  private var opened = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if opened { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func open() {
    opened = true
    for waiter in waiters { waiter.resume() }
    waiters.removeAll()
  }
}

@MainActor
@Suite("magazyn: lista slash-komend sesji")
struct StoreCommandsTests {
  @Test("pierwszy „/” czyta listę; kolejne przez 60 s nie pytają serwera, po 60 s — jedno żądanie")
  func rhythm() async throws {
    let (store, transport, clock) = try await commandStore()
    #expect(store.state.commandChoices(for: "s1").isEmpty, "przed pierwszym „/” nic")
    await store.loadCommandsIfNeeded("s1")
    #expect(store.state.commandChoices(for: "s1") == list.commands)
    #expect(store.state.commands.list?.revision == "r1")
    clock.advance(by: .seconds(59))
    await store.loadCommandsIfNeeded("s1")
    await store.loadCommandsIfNeeded("s1")
    #expect(transport.read(\.commandsCalls) == ["s1"])
    clock.advance(by: .seconds(1))
    await store.loadCommandsIfNeeded("s1")
    #expect(transport.read(\.commandsCalls) == ["s1", "s1"])
  }

  @Test("dwa „/” naraz: jedno żądanie")
  func singleFlight() async throws {
    let (store, transport, _) = try await commandStore()
    let first = Task { await store.loadCommandsIfNeeded("s1") }
    let second = Task { await store.loadCommandsIfNeeded("s1") }
    await first.value
    await second.value
    #expect(transport.read(\.commandsCalls) == ["s1"])
    #expect(store.state.commandChoices(for: "s1") == list.commands)
  }

  @Test("zmiana sesji czyści listę; odczyt dla sesji spoza ekranu nie idzie, spóźniona odpowiedź przepada")
  func sessionChange() async throws {
    let (store, transport, _) = try await commandStore()
    await store.loadCommandsIfNeeded("s1")
    store.openSession("s2")
    #expect(store.state.commandChoices(for: "s1").isEmpty)
    #expect(store.state.commandChoices(for: "s2").isEmpty)
    #expect(store.state.commands == CommandListState(), "lista innej sesji znika cała")
    await store.loadCommandsIfNeeded("s1")
    #expect(transport.read(\.commandsCalls) == ["s1"], "s1 nie stoi na ekranie — bez żądania")
    store.dispatch(.commands(.loaded(sessionId: "s1", list, at: Date(), refusals: 0)))
    #expect(store.state.commandChoices(for: "s1").isEmpty, "odpowiedź sesji spoza ekranu przepada")
    store.openSession("s1")
    await store.loadCommandsIfNeeded("s1")
    #expect(transport.read(\.commandsCalls) == ["s1", "s1"], "powrót do sesji = pierwszy „/” od nowa")
  }

  @Test("odmowa 400 wysyłki komendy czyta listę od razu, mimo rytmu 60 s; odmowa zwykłego tekstu — nie")
  func refusedCommand() async throws {
    let (store, transport, _) = try await commandStore()
    await store.loadCommandsIfNeeded("s1")
    transport.set {
      $0.sendResult = .http(APIFailure(status: 400, code: "bad-request", message: "Rarog nie przepuszcza /usa."))
    }
    _ = await store.send(text: "zwykły tekst", to: "s1")
    #expect(!store.state.commands.stale, "odmowa zwykłego tekstu nie dotyczy listy")
    _ = await store.send(text: "  /usa", to: "s1")
    await until("odczyt po odmowie") { transport.read(\.commandsCalls).count == 2 }
    #expect(transport.read(\.commandsCalls) == ["s1", "s1"])
    await until("świeża lista") { !store.state.commands.stale }
    transport.set { $0.sendResult = .http(APIFailure(status: 409, code: "conflict", message: "Sesja pracuje.")) }
    _ = await store.send(text: "/compact", to: "s1")
    try await Task.sleep(for: .milliseconds(30))
    #expect(transport.read(\.commandsCalls).count == 2, "inna odmowa niż 400 nie mówi nic o katalogu")
  }

  @Test("odmowa komendy w trakcie odczytu: starsza odpowiedź nie gasi unieważnienia, zaraz po niej drugi odczyt")
  func refusedDuringRead() async throws {
    let (store, transport, _) = try await commandStore()
    let gate = Gate()
    transport.set { $0.onCommands = { await gate.wait() } }
    let read = Task { await store.loadCommandsIfNeeded("s1") }
    await until("odczyt w drodze") { transport.read(\.commandsCalls).count == 1 }
    transport.set {
      $0.sendResult = .http(APIFailure(status: 400, code: "bad-request", message: "Rarog nie przepuszcza /usa."))
      $0.onCommands = nil
    }
    _ = await store.send(text: "/usa", to: "s1")
    #expect(store.state.commands.stale && store.state.commands.refusals == 1)
    try await Task.sleep(for: .milliseconds(20))
    #expect(transport.read(\.commandsCalls).count == 1, "drugi odczyt czeka na pierwszy")
    let fresh = CommandList(revision: "r2", commands: [CommandChoice(name: "clear", kind: .local, source: .builtin)])
    transport.set { $0.commandLists["s1"] = fresh }
    await gate.open()
    await read.value
    await until("drugi odczyt po odmowie") { transport.read(\.commandsCalls).count == 2 }
    await until("świeża lista") { store.state.commands.list == fresh }
    #expect(!store.state.commands.stale)
  }

  @Test("401 to utrata logowania; 400, 404/405 i zły kształt dają pustą listę bez komunikatu, w rytmie 60 s")
  func failures() async throws {
    let (store, transport, clock) = try await commandStore()
    transport.set { $0.commandsResult = .http(APIFailure(status: 400, code: "bad-request", message: "Poza zasięgiem.")) }
    await store.loadCommandsIfNeeded("s1")
    #expect(store.state.commandChoices(for: "s1").isEmpty)
    #expect(store.state.commands.list == .unavailable)
    await store.loadCommandsIfNeeded("s1")
    #expect(transport.read(\.commandsCalls).count == 1, "odpowiedź serwera liczy się do rytmu")
    transport.set {
      $0.commandsResult = nil
      $0.commandLists["s1"] = nil
    }
    clock.advance(by: .seconds(60))
    await store.loadCommandsIfNeeded("s1")
    #expect(store.state.commands.list == .unavailable, "serwer bez trasy (405) i 404 — pusta lista")
    clock.advance(by: .seconds(60))
    transport.set { $0.commandsResult = .unauthorized(APIFailure(status: 401, code: "unauthorized", message: nil)) }
    await store.loadCommandsIfNeeded("s1")
    #expect(store.state.auth == .loggedOut(.deviceUnknown), "401 idzie zwykłą drogą utraty logowania")
    #expect(store.state.commands == CommandListState())
  }

  @Test("zerwana sieć zostawia ostatnią listę i nie liczy się do rytmu: następny „/” pyta znowu")
  func offline() async throws {
    let (store, transport, clock) = try await commandStore()
    await store.loadCommandsIfNeeded("s1")
    clock.advance(by: .seconds(60))
    transport.set { $0.commandsResult = .offline(.notConnectedToInternet) }
    await store.loadCommandsIfNeeded("s1")
    #expect(store.state.commandChoices(for: "s1") == list.commands)
    transport.set { $0.commandsResult = nil }
    await store.loadCommandsIfNeeded("s1")
    #expect(transport.read(\.commandsCalls).count == 3)
  }

  @Test("reduktor: odmowa dotyczy tylko listy tej sesji; wylogowanie i zalogowanie czyszczą")
  func reducer() {
    var state = AppState(clientBuild: 1)
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    state.apply(.viewSession("s1"), now: now)
    state.apply(.commands(.loaded(sessionId: "s1", list, at: now, refusals: 0)), now: now)
    #expect(!state.commandListNeedsRead("s1", now: now.addingTimeInterval(59)))
    #expect(state.commandListNeedsRead("s1", now: now.addingTimeInterval(60)))
    #expect(state.commandListNeedsRead("s1", now: now.addingTimeInterval(-1)), "cofnięty zegar")
    #expect(state.commandListNeedsRead("s2", now: now), "inna sesja")
    state.apply(.commands(.refused(sessionId: "s2")), now: now)
    #expect(!state.commands.stale)
    state.apply(.commands(.refused(sessionId: "s1")), now: now)
    #expect(state.commands.stale && state.commandListNeedsRead("s1", now: now))
    #expect(state.commandChoices(for: "s1") == list.commands, "nieświeża lista dalej podpowiada")
    state.apply(.viewSession("s1"), now: now)
    #expect(state.commandChoices(for: "s1") == list.commands, "ta sama sesja nie czyści")
    let refusals = state.commands.refusals
    state.apply(.commands(.loaded(sessionId: "s1", list, at: now, refusals: refusals - 1)), now: now)
    #expect(state.commands.stale, "odpowiedź odczytu sprzed odmowy nie gasi unieważnienia")
    state.apply(.commands(.loaded(sessionId: "s1", list, at: now, refusals: refusals)), now: now)
    #expect(!state.commands.stale)
    state.apply(.loggedOut(.deviceUnknown), now: now)
    #expect(state.commands == CommandListState())
  }
}
