import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogCore
import RarogTransport
import Testing

// The voice agent across sessions in the store: the session catalog, the last turns of one session, the pick-up of a
// result and the rule that offers the mode. Refusals by code; a result belongs to the login in which the request went
// out. Fake: `VoiceProbe`.
// Owner: voice agent.

private func golden(_ name: String) throws -> Data {
  try Data(contentsOf: try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest/\(name)"))
}

private func goldenCatalog() throws -> CompanionSessions {
  try JSONDecoder().decode(CompanionSessions.self, from: try golden("companion.sessions.json"))
}

private func goldenTurns() throws -> CompanionTurns {
  try JSONDecoder().decode(CompanionTurns.self, from: try golden("companion.turns.json"))
}

/// The golden version answer of a server with the mode across sessions, changed by `edit`.
private func version(_ edit: (inout [String: Any]) -> Void = { _ in }) throws -> VersionInfo {
  var object = try #require(
    try JSONSerialization.jsonObject(with: try golden("version.companion-sessions.json")) as? [String: Any])
  edit(&object)
  return try JSONDecoder().decode(VersionInfo.self, from: try JSONSerialization.data(withJSONObject: object))
}

/// Logged-in store on the area fake; `hello`: after the server's `hello`, so the compatibility gate lets the pick-up
/// (a mutation) out.
@MainActor
private func readStore(hello: Bool = false) async -> (RarogStore, VoiceProbe) {
  let probe = VoiceProbe(base: FakeTransport())
  let rules = MutationRules(timing: fastTiming)
  probe.base.gate = MutationGate(policy: rules)
  let store = RarogStore(transport: probe, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
  await store.start()
  await until("online") { store.state.global == .online }
  if hello {
    probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    await until("hello") { store.state.compat == .ok }
  }
  return (store, probe)
}

@MainActor
@Suite("store: the voice agent across sessions (catalog, turns, pick-up, availability)")
struct StoreCompanionSessionsTests {
  // MARK: Availability

  @Test("offered only with the voice agent offered, `companionSessions` and the capability `companion-sessions`")
  func availability() throws {
    func offered(_ info: VersionInfo?, sonioxAllowed: Bool = true) -> Bool {
      var state = AppState(clientBuild: 7)
      state.capabilities = info.map(Capabilities.init)
      return state.companionSessionsOffered(sonioxAllowed: sonioxAllowed)
    }
    #expect(offered(try version()), "all present")
    #expect(!offered(try version { $0.removeValue(forKey: "companionSessions") }), "no companionSessions")
    #expect(!offered(try version { object in
      object["capabilities"] = (object["capabilities"] as? [String])?.filter { $0 != "companion-sessions" }
    }), "no capability")
    #expect(!offered(try version { $0["companionEnabled"] = false }), "voice agent off on the server")
    #expect(!offered(try version { $0["companionSpeech"] = false }), "no Soniox voice on the server")
    #expect(!offered(try version(), sonioxAllowed: false), "build without Soniox")
    #expect(!offered(nil), "no answer from the server yet")
  }

  // MARK: Catalog

  @Test("catalog: the rows of the server's answer; every call is a new request")
  func catalog() async throws {
    let (store, probe) = await readStore()
    let catalog = try goldenCatalog()
    probe.set { $0.catalog = .success(catalog) }
    #expect(await store.loadCompanionSessions() == .sessions(catalog.sessions))
    #expect(await store.loadCompanionSessions() == .sessions(catalog.sessions))
    #expect(probe.probe.withLock { $0.catalogCalls } == 2)
  }

  @Test("catalog refusals by code: mode off or absent is one outcome, any other failure another")
  func catalogRefusals() async {
    let cases: [(TransportError, CompanionSessionsOutcome)] = [
      (.http(APIFailure(status: 404, code: "not-found", message: "No endpoint.")), .disabled(message: nil)),
      (.http(APIFailure(status: 503, code: "companion-disabled", message: "Off.")), .disabled(message: "Off.")),
      (
        .http(APIFailure(status: 503, code: "companion-sessions-disabled", message: "Mode off.")),
        .disabled(message: "Mode off.")
      ),
      // A 503 without a code (reverse proxy) is a passing failure, not a mode switched off.
      (.http(APIFailure(status: 503)), .failed(code: nil, message: nil)),
      (
        .http(APIFailure(status: 500, code: "internal", message: "Broke.")),
        .failed(code: "internal", message: "Broke.")
      ),
      (.timedOut, .failed(code: "timeout", message: nil)),
      (.offline(.networkConnectionLost), .failed(code: nil, message: nil)),
      (.invalidResponse("shape"), .failed(code: nil, message: nil)),
      (.cancelled, .cancelled),
    ]
    for (error, expected) in cases {
      let (store, probe) = await readStore()
      probe.set { $0.catalog = .failure(error) }
      #expect(await store.loadCompanionSessions() == expected, "\(error)")
      #expect(store.state.auth == .loggedIn)
    }
  }

  @Test("catalog 401 logs out; a late answer after logout belongs to the old login")
  func catalogLogin() async throws {
    let (store, probe) = await readStore()
    probe.set { $0.catalog = .failure(.unauthorized(APIFailure(status: 401))) }
    #expect(await store.loadCompanionSessions() == .loggedOut)
    #expect(store.state.auth != .loggedIn)

    let (late, lateProbe) = await readStore()
    let catalog = try goldenCatalog()
    lateProbe.set {
      $0.hold = true
      $0.catalog = .success(catalog)
    }
    let pending = Task { await late.loadCompanionSessions() }
    await until("request in flight") { lateProbe.probe.withLock { $0.catalogCalls } == 1 }
    lateProbe.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("logout") { late.state.auth != .loggedIn }
    lateProbe.release()
    #expect(await pending.value == .loggedOut)
  }

  // MARK: Turns

  @Test("turns: the answer kept whole (messages, conversation, stateSince, readMark, complete); session and count go")
  func turns() async throws {
    let (store, probe) = await readStore()
    let turns = try goldenTurns()
    probe.set { $0.turns = .success(turns) }
    let outcome = await store.loadCompanionTurns(sessionId: "s1", count: 2)
    #expect(outcome == .turns(turns))
    guard case let .turns(read) = outcome else { return }
    #expect(read.conversation == turns.conversation && read.readMark == turns.readMark)
    #expect(read.stateSince == turns.stateSince && read.complete == turns.complete && read.messages == turns.messages)
    let reads = probe.probe.withLock { $0.turnsReads }
    #expect(reads.count == 1 && reads.first?.sessionId == "s1" && reads.first?.count == 2)
  }

  @Test("turns refusals by code: outside the catalog, mode off and other failures are different outcomes")
  func turnsRefusals() async {
    let cases: [(TransportError, CompanionTurnsOutcome)] = [
      (
        .http(APIFailure(status: 404, code: "not-found", message: "Not the voice agent's session.")),
        .outsideCatalog(message: "Not the voice agent's session.")
      ),
      (.http(APIFailure(status: 503, code: "companion-disabled", message: "Off.")), .disabled(message: "Off.")),
      (
        .http(APIFailure(status: 503, code: "companion-sessions-disabled", message: "Mode off.")),
        .disabled(message: "Mode off.")
      ),
      (.http(APIFailure(status: 503)), .failed(code: nil, message: nil)),
      (
        .http(APIFailure(status: 400, code: "bad-request", message: "Count.")),
        .failed(code: "bad-request", message: "Count.")
      ),
      (.invalidResponse("count 4 outside 1...3"), .failed(code: nil, message: nil)),
      (.timedOut, .failed(code: "timeout", message: nil)),
      (.offline(.notConnectedToInternet), .failed(code: nil, message: nil)),
      (.cancelled, .cancelled),
    ]
    for (error, expected) in cases {
      let (store, probe) = await readStore()
      probe.set { $0.turns = .failure(error) }
      #expect(await store.loadCompanionTurns(sessionId: "s1", count: 1) == expected, "\(error)")
      #expect(store.state.auth == .loggedIn)
    }
  }

  @Test("turns 401 logs out")
  func turnsLogin() async {
    let (store, probe) = await readStore()
    probe.set { $0.turns = .failure(.unauthorized(APIFailure(status: 401))) }
    #expect(await store.loadCompanionTurns(sessionId: "s1", count: 1) == .loggedOut)
    #expect(store.state.auth != .loggedIn)
  }

  // MARK: Pick-up

  @Test("pick-up: by voice-agent with the read's conversation and readMark byte for byte; the app state is untouched")
  func pickUp() async throws {
    let (store, probe) = await readStore(hello: true)
    let before = store.state
    // A decomposed accent: equal to the composed one as a Swift string, different in bytes.
    let mark = "r1:2026-11-20T10:00:00.000Z:e\u{301}"
    #expect(await store.pickUpCompanionResult(sessionId: "s1", conversation: "Tjo8_3W~é", readMark: mark) == .pickedUp)
    let sent = probe.probe.withLock { $0.pickUps }
    #expect(sent.count == 1 && sent.first?.sessionId == "s1")
    let pickUp = try #require(sent.first?.pickUp)
    #expect(pickUp.by == .voiceAgent)
    #expect(Array(pickUp.conversation.utf8) == Array("Tjo8_3W~é".utf8))
    #expect(Array(pickUp.readMark.utf8) == Array(mark.utf8))
    #expect(store.state == before, "the session frame brings seenBy, the action writes nothing")
  }

  @Test("pick-up refusals by code: a changed result, outside the catalog, mode off and other failures")
  func pickUpRefusals() async {
    let cases: [(TransportError, CompanionPickUpOutcome)] = [
      (.http(APIFailure(status: 409, code: "bad-state", message: "Changed.")), .resultChanged),
      (.http(APIFailure(status: 404, code: "not-found", message: "Not the voice agent's session.")), .outsideCatalog),
      (.http(APIFailure(status: 503, code: "companion-disabled", message: "Off.")), .disabled),
      (.http(APIFailure(status: 503, code: "companion-sessions-disabled", message: "Mode off.")), .disabled),
      (.http(APIFailure(status: 503)), .failed),
      (.http(APIFailure(status: 400, code: "bad-request", message: "Body.")), .failed),
      (.timedOut, .timedOut),
      (.offline(.networkConnectionLost), .failed),
      (.invalidResponse("shape"), .failed),
      (.cancelled, .cancelled),
    ]
    for (error, expected) in cases {
      let (store, probe) = await readStore(hello: true)
      let before = store.state
      probe.set { $0.pickUp = .failure(error) }
      let outcome = await store.pickUpCompanionResult(sessionId: "s1", conversation: "c", readMark: "m")
      #expect(outcome == expected, "\(error)")
      #expect(store.state == before, "a refused pick-up changes nothing: \(error)")
    }
  }

  @Test("pick-up 401 logs out")
  func pickUpLogin() async {
    let (store, probe) = await readStore(hello: true)
    probe.set { $0.pickUp = .failure(.unauthorized(APIFailure(status: 401))) }
    #expect(await store.pickUpCompanionResult(sessionId: "s1", conversation: "c", readMark: "m") == .loggedOut)
    #expect(store.state.auth != .loggedIn)
  }

  // MARK: Late answers

  enum Read: CaseIterable, Sendable { case catalog, turns, pickUp }
  enum Answer: CaseIterable, Sendable { case ok, unauthorized }

  @Test(
    "an answer that arrives after a logout and a new login belongs to the old login and leaves the new one logged in",
    arguments: Read.allCases, Answer.allCases)
  func lateAnswerAfterRelogin(read: Read, answer: Answer) async throws {
    let (store, probe) = await readStore(hello: read == .pickUp)
    let catalog = try goldenCatalog()
    let turns = try goldenTurns()
    let unauthorized = TransportError.unauthorized(APIFailure(status: 401))
    probe.set {
      $0.hold = true
      $0.catalog = answer == .ok ? .success(catalog) : .failure(unauthorized)
      $0.turns = answer == .ok ? .success(turns) : .failure(unauthorized)
      $0.pickUp = answer == .ok ? .success(()) : .failure(unauthorized)
    }
    let pending = Task { () -> Bool in
      switch read {
      case .catalog: await store.loadCompanionSessions() == .loggedOut
      case .turns: await store.loadCompanionTurns(sessionId: "s1", count: 1) == .loggedOut
      case .pickUp: await store.pickUpCompanionResult(sessionId: "s1", conversation: "c", readMark: "m") == .loggedOut
      }
    }
    await until("request in flight") {
      probe.probe.withLock { state in
        switch read {
        case .catalog: state.catalogCalls == 1
        case .turns: state.turnsReads.count == 1
        case .pickUp: state.pickUps.count == 1
        }
      }
    }
    probe.base.end(.global, error: unauthorized)
    await until("logout") { store.state.auth != .loggedIn }
    await relogin(store, probe)
    probe.release()
    #expect(await pending.value, "the outcome is loggedOut")
    #expect(store.state.auth == .loggedIn, "the late answer does not touch the new login")
  }
}
