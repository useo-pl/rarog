import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Pairing over iroh with the relay registry (`RarogStore+RelayAccess`): the registry client prepares the app and the
// link's server before `POST /api/pair` (at most the core's ceiling), and after a fresh sponsorship the sheet waits for
// the relay with "Cancel" from the first pairing request on, repeating it after a transport failure in a readiness
// window. Times in milliseconds; the production values are checked by `relayTimingProduction`. The fake `relayPrepare`
// answers at once (or the test holds it), so every test but `relayPrepareCeiling` keeps the ceiling far away: a short
// one would race that answer when the main actor is busy, and a lost race turns `.fresh` into `.unavailable`.

/// What the fake registry client and the pairing transport saw, in order.
@MainActor
private final class RelayRecord {
  /// `prepare` and `pair`, in call order.
  var events: [String] = []
  /// Targets given to `relayPrepare`.
  var prepared: [PairingTarget] = []
  /// When the last `relayPrepare` answered: the store takes the start of the readiness window after it.
  var prepareEnded: Date?
  /// The sheet's state at each pairing request.
  var flows: [PairingFlow] = []
}

extension StorePairingTests {
  /// Test times with the preparation ceiling out of reach; the default window is ended by the test's own outcome
  /// (success, an HTTP answer, "Cancel").
  private static func relayTiming(window: Duration = .seconds(30), retry: Duration = .milliseconds(40))
    -> RelayPairingTiming
  {
    RelayPairingTiming(prepareCeiling: .seconds(30), readinessWindow: window, retryEvery: retry)
  }

  private var relayIroh: ServerIrohConfig { PairingFixtures.iroh() }

  private func relayLink(server: URL? = nil) -> PairingLink {
    PairingLink(target: server.map { .both($0, relayIroh) } ?? .iroh(relayIroh), code: PairingFixtures.code)
  }

  /// A store without a key whose registry client answers `prepare`, and whose pairing transport answers the n-th
  /// request with `replies[n-1]` (`nil` and past the end: success). `hold` keeps request number `holdAt` until
  /// released.
  private func relayStore(
    timing: RelayPairingTiming = relayTiming(), replies: [TransportError?] = [], holdAt: Int? = nil, hold: Hold? = nil,
    prepare: @escaping @MainActor @Sendable (PairingTarget) async -> RelayPrepareResult
  ) async -> (FakeServer, RarogStore, RelayRecord) {
    let server = FakeServer()
    let store = server.store()
    await store.start()
    let record = RelayRecord()
    store.serverRuntime.relay.timing = timing
    store.serverRuntime.connector?.relayPrepare = { target in
      record.events.append("prepare")
      record.prepared.append(target)
      let result = await prepare(target)
      record.prepareEnded = Date()
      return result
    }
    let pairing = server.pairing
    pairing.set {
      $0.onPair = {
        let number = await MainActor.run {
          record.events.append("pair")
          record.flows.append(store.state.pairing.flow)
          let number = record.flows.count
          let reply = number <= replies.count ? replies[number - 1] : nil
          pairing.set { $0.pairResult = reply.map { .failure($0) } ?? .success(PairingFixtures.response(iroh: nil)) }
          return number
        }
        if number == holdAt, let hold { await hold.wait() }
      }
    }
    return (server, store, record)
  }

  private func isWaiting(_ flow: PairingFlow, _ link: PairingLink) -> Bool {
    if case .waitingForRelay(link, _) = flow { return true }
    return false
  }

  @Test("relay times: core ceiling 10 s over the 8 s registry budget, readiness window 60 s, retry every 10 s")
  func relayTimingProduction() {
    #expect(RelayPairingTiming.production.prepareCeiling == .seconds(10))
    #expect(RelayPairingTiming.production.prepareCeiling > RelayAccess.pairingBudget)
    #expect(RelayPairingTiming.production.readinessWindow == .seconds(60))
    #expect(RelayPairingTiming.production.retryEvery == .seconds(10))
  }

  @Test("relay first: `k`+`r` → relayPrepare(.iroh), then POST /api/pair; `u`+`k`+`r` → .both first; `u` → none")
  func relayPrepareOrder() async {
    let cases: [(PairingLink, [PairingTarget])] = [
      (relayLink(), [.iroh(relayIroh)]),
      (relayLink(server: PairingFixtures.server), [.both(PairingFixtures.server, relayIroh)]),
      (PairingFixtures.link(), []),
    ]
    for (link, expected) in cases {
      let (server, store, record) = await relayStore { _ in .ready }
      store.offerPairing(link)
      #expect(await store.confirmPairing() == .paired)
      #expect(record.prepared == expected, "\(link.target)")
      #expect(record.events == (expected.isEmpty ? ["pair"] : ["prepare", "pair"]), "\(link.target)")
      #expect(server.pairingTargets == [link.target])
    }
  }

  @Test("relayPrepare that never returns: POST /api/pair starts after the ceiling, pairing ends normally")
  func relayPrepareCeiling() async {
    let ceiling = Duration.milliseconds(150)
    let late = Hold()
    var timing = Self.relayTiming()
    timing.prepareCeiling = ceiling
    let (server, store, record) = await relayStore(timing: timing) { _ in
      await late.wait()
      return .fresh
    }
    let link = relayLink()
    store.offerPairing(link)
    let start = ContinuousClock.now
    #expect(await store.confirmPairing() == .paired)
    #expect(ContinuousClock.now - start >= ceiling)
    #expect(record.events == ["prepare", "pair"])
    #expect(record.flows == [.pairing(link)])
    // The late `.fresh` after the ceiling changes nothing.
    late.release()
    try? await Task.sleep(for: .milliseconds(100))
    #expect(store.state.pairing.flow == .idle && server.pairingTargets.count == 1)
  }

  @Test("`.fresh` and the first request in flight → .waitingForRelay until the end of the preparation + the window")
  func freshWaitsFromFirstRequest() async throws {
    let held = Hold()
    let (server, store, record) = await relayStore(holdAt: 1, hold: held) { _ in .fresh }
    let link = relayLink()
    store.offerPairing(link)
    let pairing = Task { await store.confirmPairing() }
    await until("first request in flight") { record.flows.count == 1 }
    let seen = Date()
    let flow = store.state.pairing.flow
    held.release()
    #expect(await pairing.value == .paired)
    #expect(server.pairingTargets == [link.target])
    guard case let .waitingForRelay(waiting, deadline) = flow else {
      Issue.record("the sheet during the first request: \(flow)")
      return
    }
    #expect(waiting == link)
    #expect(record.flows == [flow], "the request went out already waiting")
    let window = Self.relayTiming().readinessWindow.timeInterval
    let prepared = try #require(record.prepareEnded)
    #expect(deadline >= prepared.addingTimeInterval(window) && deadline <= seen.addingTimeInterval(window))
  }

  @Test("`.fresh` and the first request succeeds → paired as without a registry, one pairing call")
  func freshFirstRequestPairs() async {
    let (server, store, record) = await relayStore { _ in .fresh }
    let link = relayLink()
    store.offerPairing(link)
    #expect(await store.confirmPairing() == .paired)
    #expect(server.pairingTargets == [link.target])
    #expect(record.flows.count == 1 && record.flows.allSatisfy { isWaiting($0, link) }, "\(record.flows)")
    #expect(store.state.pairing.flow == .idle && store.state.pairing.paired != nil)
    #expect(store.state.auth == .loggedIn && server.keychain.load() != .none)
  }

  @Test("`.fresh`, two transport failures, then success: .waitingForRelay from the first request → .idle, 3 calls")
  func freshWaitsThenPairs() async throws {
    let (server, store, record) = await relayStore(replies: [.offline(.cannotConnectToHost), .timedOut]) { _ in .fresh }
    let link = relayLink()
    store.offerPairing(link)
    let start = Date()
    #expect(await store.confirmPairing() == .paired)
    #expect(server.pairingTargets == [link.target, link.target, link.target])
    #expect(record.flows.count == 3)
    #expect(record.flows.allSatisfy { isWaiting($0, link) }, "\(record.flows)")
    // The window counts from the end of the preparation.
    guard case let .waitingForRelay(_, until) = try #require(record.flows.last) else { return }
    #expect(until > start && until <= Date().addingTimeInterval(Self.relayTiming().readinessWindow.timeInterval))
    #expect(store.state.pairing.flow == .idle && store.state.pairing.paired != nil)
    #expect(store.state.auth == .loggedIn)
  }

  @Test("the last pause reaches the end of the window: no request starts after it, the window ends the pairing")
  func freshNoRequestAfterWindow() async {
    let timing = Self.relayTiming(window: .milliseconds(60), retry: .milliseconds(300))
    let (server, store, record) = await relayStore(timing: timing, replies: [.offline(.cannotConnectToHost)]) { _ in
      .fresh
    }
    let link = relayLink()
    store.offerPairing(link)
    #expect(await store.confirmPairing() == .failed(.offline))
    #expect(store.state.pairing.flow == .failed(link, .offline))
    #expect(record.flows.count == 1, "the second request (a success) would start after the window")
    #expect(server.keychain.load() == .none)
  }

  @Test("`.fresh` and transport failures to the end of the window → .failed as today, no request after it")
  func freshWindowEnds() async {
    // A window of 25 retries: a stall of the main actor shorter than the window still leaves one.
    let timing = Self.relayTiming(window: .seconds(1))
    let failures = [TransportError?](repeating: .offline(.cannotConnectToHost), count: 200)
    let (server, store, record) = await relayStore(timing: timing, replies: failures) { _ in .fresh }
    let link = relayLink()
    store.offerPairing(link)
    let start = ContinuousClock.now
    #expect(await store.confirmPairing() == .failed(.offline))
    #expect(ContinuousClock.now - start >= timing.readinessWindow)
    #expect(store.state.pairing.flow == .failed(link, .offline))
    #expect(server.pairingTargets.count >= 2, "retries inside the window")
    #expect(record.flows.dropFirst().allSatisfy { isWaiting($0, link) })
    let requests = server.pairingTargets.count
    try? await Task.sleep(for: .milliseconds(150))
    #expect(server.pairingTargets.count == requests)
    #expect(server.keychain.load() == .none)
  }

  @Test("`.ready`, `.unavailable`, `.skipped` and a transport failure → .failed without waiting")
  func notFreshFailsAtOnce() async {
    // A long window: waiting would take at least `retryEvery` and repeat the request.
    let timing = Self.relayTiming(window: .seconds(5), retry: .seconds(1))
    for prepared in [RelayPrepareResult.ready, .unavailable, .skipped] {
      let (server, store, record) = await relayStore(timing: timing, replies: [.offline(.cannotConnectToHost)]) { _ in
        prepared
      }
      let link = relayLink()
      store.offerPairing(link)
      let start = ContinuousClock.now
      #expect(await store.confirmPairing() == .failed(.offline), "\(prepared)")
      #expect(ContinuousClock.now - start < timing.retryEvery, "\(prepared)")
      #expect(server.pairingTargets.count == 1 && record.flows == [.pairing(link)], "\(prepared)")
      #expect(store.state.pairing.flow == .failed(link, .offline), "\(prepared)")
    }
  }

  @Test("an HTTP answer of the server in the window (401 for the code) → .failed at once")
  func httpAnswerInWindowFails() async {
    let timing = Self.relayTiming(window: .seconds(5))
    let refused = TransportError.unauthorized(APIFailure(status: 401, message: "bad code"))
    let replies: [TransportError?] = [.offline(.cannotConnectToHost), refused]
    let (server, store, record) = await relayStore(timing: timing, replies: replies) { _ in .fresh }
    let link = relayLink()
    store.offerPairing(link)
    let start = ContinuousClock.now
    #expect(await store.confirmPairing() == .failed(.failed("bad code")))
    #expect(ContinuousClock.now - start < timing.readinessWindow)
    #expect(server.pairingTargets.count == 2)
    #expect(record.flows.dropFirst().first.map { isWaiting($0, link) } == true, "\(record.flows)")
    #expect(store.state.pairing.flow == .failed(link, .failed("bad code")))
  }

  @Test("Cancel in the pause between requests → .idle, result .ignored, no further request; a new link waits for it")
  func cancelWhileWaiting() async {
    // The pause (2 s) dwarfs the failing first request, so "Cancel" lands in the pause, not in a request.
    let timing = Self.relayTiming(window: .seconds(5), retry: .seconds(2))
    let failures = [TransportError?](repeating: .offline(.cannotConnectToHost), count: 200)
    let (server, store, _) = await relayStore(timing: timing, replies: failures) { _ in .fresh }
    let link = relayLink()
    store.offerPairing(link)
    let pairing = Task { await store.confirmPairing() }
    await until("waiting for the relay") { isWaiting(store.state.pairing.flow, link) }
    // A link offered meanwhile does not swap the sheet under the finger.
    store.offerPairing(PairingFixtures.link())
    #expect(isWaiting(store.state.pairing.flow, link))
    await until("first request failed, pause running") { server.pairingTargets.count == 1 }
    let requests = server.pairingTargets.count
    store.cancelPairing()
    #expect(store.state.pairing.flow == .idle)
    #expect(await pairing.value == .ignored)
    try? await Task.sleep(for: .milliseconds(400))
    #expect(server.pairingTargets.count == requests)
    #expect(store.state.pairing.flow == .idle && server.keychain.load() == .none)
  }

  @Test("`.fresh`, Cancel during the first request → .idle at once; the late success is ignored, no key, no switch")
  func cancelDuringFirstRequest() async {
    let held = Hold()
    let (server, store, record) = await relayStore(holdAt: 1, hold: held) { _ in .fresh }
    let link = relayLink()
    store.offerPairing(link)
    let transports = server.built.count
    let pairing = Task { await store.confirmPairing() }
    await until("first request in flight") { record.flows.count == 1 }
    store.cancelPairing()
    #expect(store.state.pairing.flow == .idle)
    held.release()
    #expect(await pairing.value == .ignored)
    #expect(server.keychain.load() == .none && store.state.pairing.paired == nil)
    #expect(store.serverEndpoint == .none && server.built.count == transports, "no switch to a new transport")
    #expect(store.state.pairing.flow == .idle && server.pairingTargets.count == 1)
  }

  @Test("`.fresh`, Cancel during the first request, a new pairing pairs; the old late success changes nothing")
  func cancelledFirstRequestLandsAfterNewPairing() async {
    let held = Hold()
    let (server, store, record) = await relayStore(holdAt: 1, hold: held) { _ in .fresh }
    let first = relayLink()
    store.offerPairing(first)
    let old = Task { await store.confirmPairing() }
    await until("first request in flight") { record.flows.count == 1 }
    store.cancelPairing()
    let second = relayLink(server: URL(string: "https://second.example.test")!)
    store.offerPairing(second)
    #expect(await store.confirmPairing() == .paired)
    let saved = server.keychain.load()
    let paired = store.state.pairing.paired
    let transports = server.built.count
    #expect(saved != .none && server.pairingTargets == [first.target, second.target])
    held.release()
    #expect(await old.value == .ignored)
    #expect(server.keychain.load() == saved && store.state.pairing.paired == paired)
    #expect(server.built.count == transports && store.state.pairing.flow == .idle, "no switch, no sheet")
  }

  @Test("`.ready`, `.unavailable`, `.skipped`: .pairing through the whole request, Cancel does nothing, it pairs")
  func notFreshPairsWithoutCancel() async {
    for prepared in [RelayPrepareResult.ready, .unavailable, .skipped] {
      let held = Hold()
      let (server, store, record) = await relayStore(holdAt: 1, hold: held) { _ in prepared }
      let link = relayLink()
      store.offerPairing(link)
      let pairing = Task { await store.confirmPairing() }
      await until("request in flight") { record.flows.count == 1 }
      #expect(store.state.pairing.flow == .pairing(link), "\(prepared)")
      store.cancelPairing()
      #expect(store.state.pairing.flow == .pairing(link), "\(prepared)")
      held.release()
      #expect(await pairing.value == .paired, "\(prepared)")
      #expect(record.flows == [.pairing(link)] && server.pairingTargets == [link.target], "\(prepared)")
    }
  }

  @Test("Cancel during a retry in flight: the late success is ignored, no key saved")
  func cancelDuringRetry() async {
    let timing = Self.relayTiming(window: .seconds(5))
    let held = Hold()
    let (server, store, _) = await relayStore(
      timing: timing, replies: [.offline(.cannotConnectToHost)], holdAt: 2, hold: held
    ) { _ in .fresh }
    let link = relayLink()
    store.offerPairing(link)
    let pairing = Task { await store.confirmPairing() }
    await until("second request in flight") { server.pairingTargets.count == 2 }
    store.cancelPairing()
    #expect(store.state.pairing.flow == .idle)
    held.release()
    #expect(await pairing.value == .ignored)
    #expect(server.keychain.load() == .none && store.state.pairing.paired == nil)
    #expect(store.state.pairing.flow == .idle && server.pairingTargets.count == 2)
  }

  @Test("Cancel in .pairing (preparation in flight) still does nothing; pairing goes on")
  func cancelWhilePairingDoesNothing() async {
    let held = Hold()
    let (server, store, record) = await relayStore { _ in
      await held.wait()
      return .ready
    }
    let link = relayLink()
    store.offerPairing(link)
    let pairing = Task { await store.confirmPairing() }
    await until("preparation in flight") { record.events == ["prepare"] }
    store.cancelPairing()
    #expect(store.state.pairing.flow == .pairing(link))
    held.release()
    #expect(await pairing.value == .paired)
    #expect(record.events == ["prepare", "pair"] && server.pairingTargets == [link.target])
  }
}
