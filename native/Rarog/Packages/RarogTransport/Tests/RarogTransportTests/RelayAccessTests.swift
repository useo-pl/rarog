import Foundation
import RarogContract
@testable import RarogTransport
import RarogTransportTesting
import Synchronization
import Testing

// The iroh relay registry client actor: forget, pairing and one-operation-at-a-time interleavings on the live actor,
// the pairing preparation budget and the gate proof deadline on a manual clock, the store read only once the identity
// is available, the signature pinned to the operation, caller tickets, trigger coalescing and the status stream. The
// registry, gate, signature and store are `RarogTransportTesting` fakes; a response that must "hang" waits on the
// test's `Gate`. The machine's instant is fixed (`RX.t0`), because these tests check the queue, not deadlines.

private typealias F = FakeRelayAuthTransport
private typealias Route = RelayAuthWire.Route

/// Stałe testów: tożsamości, relaye, rejestr, chwile w sekundach epoki.
private enum RX {
  /// EndpointId podpisu atrapy (`FakeRelaySigner` domyślnie).
  static let app = String(repeating: "c3", count: 32)
  /// Druga tożsamość apki (nowy klucz iroh).
  static let otherApp = String(repeating: "d4", count: 32)
  static let k = String(repeating: "ab", count: 32)
  static let k2 = String(repeating: "cd", count: 32)
  static let relay = URL(string: "https://relay.rarog.ai/")!
  static let ownRelay = URL(string: "https://relay.example.net/")!
  static let registry = URL(string: "https://relay-auth.rarog.ai")!
  static let t0: Int64 = 1_800_000_000
  static let expires: Int64 = t0 + 90 * 86_400
  static let budget: Duration = .seconds(8)

  static func date(_ seconds: Int64) -> Date { Date(timeIntervalSince1970: TimeInterval(seconds)) }
  static func target(_ id: String = k, _ relay: URL = relay) -> TunnelTarget {
    TunnelTarget(endpointId: id, relay: relay)
  }

  static let registered = RelayAccessStatus.registered(appId: app, until: date(expires))

  /// Magazyn przed pierwszym odblokowaniem urządzenia: Keychain odmawia odczytu obu wpisów.
  static func locked(optOut: RelayOptOut? = nil) -> FakeRelayAccessStore {
    var contents = FakeRelayAccessStore.Contents(optOut: optOut, optOutUnreadable: "relay-optout: Keychain locked")
    contents.cacheUnreadable = "relay-access: Keychain locked"
    return FakeRelayAccessStore(contents)
  }
}

/// Tożsamość apki, którą test podmienia w biegu (`nil` = niedostępna, np. Keychain przed pierwszym odblokowaniem).
private final class IdentitySwitch: Sendable {
  private let current: Mutex<(any TunnelSigner)?>

  init(_ signer: (any TunnelSigner)?) { current = Mutex(signer) }

  var signer: (any TunnelSigner)? { current.withLock { $0 } }

  func set(_ signer: (any TunnelSigner)?) { current.withLock { $0 = signer } }
}

/// Actor z atrapami, zegarem ręcznym budżetu i terminu dowodu, podmienianą tożsamością i dziennikiem linii logu.
private struct AccessRig {
  let store: FakeRelayAccessStore
  let transport: FakeRelayAuthTransport
  let gate: FakeRelayGate
  let clock: ManualClock
  let identity: IdentitySwitch
  let logs: Recorder<String>
  let access: RelayAccess

  init(store: FakeRelayAccessStore = FakeRelayAccessStore(),
       transport: FakeRelayAuthTransport = FakeRelayAuthTransport(),
       gate: FakeRelayGate = FakeRelayGate(), signer: FakeRelaySigner? = FakeRelaySigner(),
       clock: ManualClock = ManualClock(), renewEvery: Duration = RelayAccessMachine.defaultRenewEvery) {
    let logs = Recorder<String>()
    let identity = IdentitySwitch(signer)
    self.store = store
    self.transport = transport
    self.gate = gate
    self.clock = clock
    self.identity = identity
    self.logs = logs
    access = RelayAccess(signer: { identity.signer }, gate: gate, transport: transport, store: store,
                         renewEvery: renewEvery, clock: clock, now: { RX.date(RX.t0) },
                         log: { logs.append($0) })
  }

  var routes: [Route] { transport.routes }

  /// Czeka, aż actor odda maszynie `count` wejść (`setServers`, `trigger`, `prepareForPairing`, `forget()`).
  func accepted(_ count: Int, sourceLocation: SourceLocation = #_sourceLocation) async throws {
    let access = access
    try await eventually("wejścia oddane maszynie: \(count)", sourceLocation: sourceLocation) {
      await access.acceptedInputs >= count
    }
  }
}

/// Rejestr atrapy, który odpowiada dopiero po `latch.open()`: renew z poręczeniem do zrobienia albo bez niego,
/// sponsor, register i forget z sukcesem.
private func latchedTransport(_ latch: Gate, unsponsored: [String] = []) -> FakeRelayAuthTransport {
  FakeRelayAuthTransport { call in
    await latch.wait()
    switch call.fields {
    case .renew: return F.renewed(expiresAt: RX.expires, unsponsored: unsponsored)
    case let .sponsor(server): return F.sponsored(server: server, expiresAt: RX.expires)
    case .register: return F.registered(endpointId: call.endpointId, expiresAt: RX.expires)
    case .forget: return F.forgotten()
    }
  }
}

/// Wszystkie statusy jednego subskrybenta, po kolei.
private final class StatusLog: Sendable {
  private let recorder = Recorder<RelayAccessStatus>()
  private let task: Task<Void, Never>

  init(_ stream: AsyncStream<RelayAccessStatus>) {
    let recorder = recorder
    task = Task {
      for await status in stream { recorder.append(status) }
    }
  }

  deinit { task.cancel() }

  var all: [RelayAccessStatus] { recorder.all }
  var last: RelayAccessStatus? { recorder.all.last }
}

/// Pierwszy element strumienia albo `nil`, gdy nie przyszedł w czasie rzeczywistym `limit`.
private func firstStatus(_ stream: AsyncStream<RelayAccessStatus>, limit: Duration = .seconds(5)) async
  -> RelayAccessStatus? {
  await withTaskGroup(of: RelayAccessStatus?.self) { group in
    group.addTask {
      var iterator = stream.makeAsyncIterator()
      return await iterator.next()
    }
    group.addTask {
      try? await Task.sleep(for: limit)
      return nil
    }
    let first = await group.next() ?? nil
    group.cancelAll()
    return first
  }
}

/// Chwila w czasie rzeczywistym na skutki, których nie powinno być (zadania żądań startują poza actorem).
private func quiet() async throws {
  try await Task.sleep(for: .milliseconds(150))
}

@Suite("actor klienta rejestru relaya iroh: kolejka, przeploty, budżet", .timeLimit(.minutes(1)))
struct RelayAccessTests {
  // MARK: - Przeploty

  @Test("przeplot 1: forget() w trakcie synchronizacji czekającej na proof() → po forget 200 zero register i sponsor")
  func forgetDuringProof() async throws {
    let latch = Gate()
    let transport = FakeRelayAuthTransport()
    transport.enqueue(.renew, F.failure(.notRegistered))
    transport.enqueue(.forget, F.forgotten())
    let rig = AccessRig(transport: transport, gate: FakeRelayGate(before: { _ in await latch.wait() }))
    let gate = rig.gate

    await rig.access.setServers([RX.target()])
    try await eventually("synchronizacja czeka na proof()") { gate.attempts == 1 }
    let forgetting = Task { await rig.access.forget() }
    try await rig.accepted(2)
    latch.open()

    #expect(await forgetting.value == .optedOut(appId: RX.app, removal: .confirmed))
    #expect(rig.routes == [.renew, .forget])
    #expect(rig.store.snapshot.optOut?.removal == .confirmed)

    // Spóźniony wyzwalacz i lista po rezygnacji: nadal ani register, ani sponsor.
    await rig.access.trigger(.foreground)
    await rig.access.setServers([RX.target()])
    try await rig.accepted(4)
    try await quiet()
    #expect(rig.routes == [.renew, .forget])
    #expect(gate.attempts == 1)
    #expect(transport.maxInFlight == 1)
  }

  @Test("przeplot 2: forget nieudany (pending), potem prepareForPairing(s) → forget, register, sponsor; późniejsze wyzwalacze bez forget")
  func pairAfterPendingForget() async throws {
    let transport = FakeRelayAuthTransport()
    transport.enqueue(.forget, .unreachable("offline"), F.forgotten())
    transport.enqueue(.renew, F.failure(.notRegistered))
    transport.enqueue(.register, F.registered(endpointId: RX.app, expiresAt: RX.expires))
    transport.enqueue(.sponsor, F.sponsored(server: RX.k, expiresAt: RX.expires))
    let rig = AccessRig(transport: transport)

    #expect(await rig.access.forget() == .optedOut(appId: RX.app, removal: .pending))
    #expect(rig.store.snapshot.optOut?.removal == .pending)

    #expect(await rig.access.prepareForPairing(RX.target(), budget: RX.budget) == .fresh)
    // Order: forget, register, sponsor (the renew with 404 is the machine's due sync and its not-registered
    // answer after the cleared memory).
    #expect(rig.routes == [.forget, .forget, .renew, .register, .sponsor])
    #expect(rig.store.snapshot.optOut == nil)

    let log = StatusLog(rig.access.statuses)
    await rig.access.setServers([RX.target()])
    await rig.access.trigger(.start)
    await rig.access.trigger(.foreground)
    await rig.access.trigger(.identityAvailable)
    await rig.access.trigger(.tunnelFailed)  // T-tunnel renews despite fresh memory, but without forget
    try await rig.accepted(7)
    try await eventually("T-tunel skończył synchronizację") {
      log.last == .problem(.unreachable, appId: RX.app, retryAt: RX.date(RX.t0 + 60))
    }
    try await quiet()
    #expect(rig.routes == [.forget, .forget, .renew, .register, .sponsor, .renew])
    #expect(rig.routes.filter { $0 == .forget }.count == 2)
    #expect(transport.maxInFlight == 1)
  }

  @Test("przeplot 3: saveOptOut false → zero forget i problem(optOutNotSaved); restart z rezygnacją confirmed → zero żądań")
  func optOutNotSavedThenRestart() async throws {
    var contents = FakeRelayAccessStore.Contents()
    contents.optOutSaveFails = true
    let rig = AccessRig(store: FakeRelayAccessStore(contents))
    rig.transport.enqueue(.forget, F.forgotten())

    #expect(await rig.access.forget() == .problem(.optOutNotSaved, appId: RX.app, retryAt: nil))
    #expect(rig.routes.isEmpty)
    #expect(rig.store.snapshot.optOut == nil)

    rig.store.update { $0.optOutSaveFails = false }
    #expect(await rig.access.forget() == .optedOut(appId: RX.app, removal: .confirmed))
    #expect(rig.routes == [.forget])

    // Restart procesu: nowy actor na tym samym magazynie.
    let restarted = AccessRig(store: FakeRelayAccessStore(rig.store.snapshot))
    let log = StatusLog(restarted.access.statuses)
    await restarted.access.setServers([RX.target()])
    await restarted.access.trigger(.start)
    await restarted.access.trigger(.foreground)
    await restarted.access.trigger(.tunnelFailed)
    try await restarted.accepted(4)
    try await eventually("status rezygnacji po restarcie") {
      log.last == .optedOut(appId: RX.app, removal: .confirmed)
    }
    try await quiet()
    #expect(restarted.routes.isEmpty)
    #expect(restarted.gate.attempts == 0)
  }

  // MARK: - Budżet przygotowania parowania

  @Test("prepareForPairing przy rejestrze bez odpowiedzi wraca po budżecie (≤ budżet + 50 ms zegara) z .unavailable; synchronizacja kończy się w tle")
  func pairingBudget() async throws {
    let latch = Gate()
    let rig = AccessRig(transport: latchedTransport(latch, unsponsored: [RX.k]))
    let clock = rig.clock
    let log = StatusLog(rig.access.statuses)
    let returned = Recorder<(RelayPrepareResult, Duration)>()

    let access = rig.access
    let pairing = Task {
      let result = await access.prepareForPairing(RX.target(), budget: RX.budget)
      returned.append((result, clock.now.offset))
    }
    try await eventually("budżet odmierzany na zegarze") { clock.sleeperCount >= 1 }
    try await eventually("renew w drodze") { rig.transport.calls.count == 1 }

    clock.advance(by: .milliseconds(7_990))
    try await quiet()
    #expect(returned.all.isEmpty, "przed końcem budżetu wynik nie wraca")

    clock.advance(by: .milliseconds(60))
    await pairing.value
    let (result, at) = try #require(returned.all.first)
    #expect(result == .unavailable)
    #expect(at >= RX.budget && at <= RX.budget + .milliseconds(50))
    try await eventually("linia budżetu w logu") { rig.logs.all.contains { $0.contains("budget") } }

    latch.open()
    try await eventually("synchronizacja skończona w tle") { log.last == RX.registered }
    #expect(rig.routes == [.renew, .sponsor])
    #expect(rig.store.snapshot.cache?.sponsored[RX.k] == RX.expires)
  }

  @Test("prepareForPairing: nowa rejestracja albo nowe poręczenie → .fresh, żywe poręczenie → .ready")
  func pairingResults() async throws {
    let registering = AccessRig()
    registering.transport.enqueue(.renew, F.failure(.notRegistered))
    registering.transport.enqueue(.register, F.registered(endpointId: RX.app, expiresAt: RX.expires))
    registering.transport.enqueue(.sponsor, F.sponsored(server: RX.k, expiresAt: RX.expires))
    #expect(await registering.access.prepareForPairing(RX.target(), budget: RX.budget) == .fresh)
    #expect(registering.routes == [.renew, .register, .sponsor])
    #expect(registering.gate.attempts == 1)

    let sponsoring = AccessRig()
    sponsoring.transport.enqueue(.renew, F.renewed(expiresAt: RX.expires, unsponsored: [RX.k]))
    sponsoring.transport.enqueue(.sponsor, F.sponsored(server: RX.k, expiresAt: RX.expires))
    #expect(await sponsoring.access.prepareForPairing(RX.target(), budget: RX.budget) == .fresh)
    #expect(sponsoring.routes == [.renew, .sponsor])

    let alive = AccessRig()
    alive.transport.enqueue(.renew, F.renewed(expiresAt: RX.expires, unsponsored: []))
    #expect(await alive.access.prepareForPairing(RX.target(), budget: RX.budget) == .ready(sponsoredAt: nil))
    #expect(alive.routes == [.renew])
  }

  @Test("prepareForPairing after a sponsorship in this process → .ready with the sponsorship's moment")
  func pairingReadyAfterSponsorship() async {
    let rig = AccessRig()
    rig.transport.enqueue(.renew, F.renewed(expiresAt: RX.expires, unsponsored: [RX.k]))
    rig.transport.enqueue(.sponsor, F.sponsored(server: RX.k, expiresAt: RX.expires))
    #expect(await rig.access.prepareForPairing(RX.target(), budget: RX.budget) == .fresh)
    rig.transport.enqueue(.renew, F.renewed(expiresAt: RX.expires, unsponsored: []))
    let second = await rig.access.prepareForPairing(RX.target(), budget: RX.budget)
    #expect(second == .ready(sponsoredAt: RX.date(RX.t0)))
    #expect(rig.routes == [.renew, .sponsor, .renew])
  }

  @Test("prepareForPairing bez tożsamości albo z relayem spoza mapy → .skipped bez żądań; forget() bez tożsamości → .inactive")
  func pairingSkipped() async throws {
    let foreign = AccessRig()
    #expect(await foreign.access.prepareForPairing(RX.target(RX.k, RX.ownRelay), budget: RX.budget) == .skipped)

    let anonymous = AccessRig(signer: nil)
    #expect(await anonymous.access.prepareForPairing(RX.target(), budget: RX.budget) == .skipped)
    #expect(await anonymous.access.forget() == .inactive)

    try await quiet()
    #expect(foreign.routes.isEmpty)
    #expect(anonymous.routes.isEmpty)
    #expect(anonymous.store.snapshot.optOut == nil)
  }

  // MARK: - Termin dowodu bramki

  @Test("proof() bez odpowiedzi: po budżecie .unavailable, po proofDeadline porażka bramki i wolna kolejka dla forget(); spóźniony dowód bez skutku")
  func proofDeadline() async throws {
    let latch = Gate()
    let transport = FakeRelayAuthTransport()
    transport.enqueue(.renew, F.failure(.notRegistered))
    transport.enqueue(.forget, F.forgotten())
    let rig = AccessRig(transport: transport, gate: FakeRelayGate(before: { _ in await latch.wait() }))
    let clock = rig.clock
    let log = StatusLog(rig.access.statuses)
    let access = rig.access

    let pairing = Task { await access.prepareForPairing(RX.target(), budget: RX.budget) }
    try await eventually("dowód bramki w drodze") { rig.gate.attempts == 1 }
    try await eventually("synchronizacja w toku") { log.last == .working }
    try await eventually("budżet parowania i termin dowodu na zegarze") { clock.sleeperCount >= 2 }
    try #require(clock.sleeperCount == 2, "bez terminu dowodu zawieszona bramka trzyma kolejkę")

    clock.advance(by: RX.budget)
    #expect(await pairing.value == .unavailable)
    try await quiet()
    #expect(log.last == .working, "przed terminem dowodu maszyna czeka")

    clock.advance(by: RelayAccess.proofDeadline - RX.budget)
    try await eventually("porażka bramki po terminie dowodu") { log.last != .working }
    #expect(log.last == .problem(.gateFailed, appId: RX.app, retryAt: RX.date(RX.t0 + 60)))
    #expect(rig.logs.all.contains("relay-access: gate proof timed out"))
    #expect(rig.logs.all.contains("relay-access: gate failed (proof timed out)"))

    // Kolejka wolna: rezygnacja zapisana, forget wysłany, wynik wraca.
    #expect(await access.forget() == .optedOut(appId: RX.app, removal: .confirmed))
    #expect(rig.routes == [.renew, .forget])
    #expect(rig.store.snapshot.optOutSaves == 2)

    // Spóźniony dowód: maszyna nie dostaje zdarzenia, register nie wychodzi.
    latch.open()
    try await quiet()
    #expect(rig.routes == [.renew, .forget])
    #expect(log.last == .optedOut(appId: RX.app, removal: .confirmed))
    #expect(!rig.logs.all.contains { $0.contains("unexpected result ignored") })
    #expect(rig.gate.attempts == 1)
    #expect(clock.sleeperCount == 0)
  }

  // MARK: - Tożsamość: odczyt magazynu i podpis operacji

  @Test("Keychain zablokowany: bez tożsamości zero żądań i inactive; po odblokowaniu magazyn czytany od nowa → forget z rezygnacji pending")
  func lockedKeychainThenPendingOptOut() async throws {
    let pending = RelayOptOut(appId: RX.app, registry: RX.registry, at: RX.t0 - 60, removal: .pending)
    let rig = AccessRig(store: RX.locked(optOut: pending), signer: nil)
    rig.transport.enqueue(.forget, F.forgotten())
    let log = StatusLog(rig.access.statuses)

    await rig.access.setServers([RX.target()])
    await rig.access.trigger(.start)
    try await rig.accepted(2)
    try await eventually("bieżący status u subskrybenta") { !log.all.isEmpty }
    try await quiet()
    #expect(rig.routes.isEmpty)
    #expect(log.all == [.inactive])
    #expect(rig.logs.all.contains("relay-access: identity unavailable"))

    // Pierwsze odblokowanie: Keychain oddaje wpisy, podpis daje tożsamość, apka zgłasza T-tożsamość.
    rig.store.update {
      $0.cacheUnreadable = nil
      $0.optOutUnreadable = nil
    }
    rig.identity.set(FakeRelaySigner())
    await rig.access.trigger(.identityAvailable)
    try await eventually("status po odblokowaniu") { log.last != .inactive }
    #expect(log.last == .optedOut(appId: RX.app, removal: .confirmed))
    try await quiet()
    #expect(rig.routes == [.forget])
    #expect(rig.transport.calls.first?.registry == RX.registry)
    #expect(rig.store.snapshot.optOut?.removal == .confirmed)
  }

  @Test("Keychain zablokowany, bez rezygnacji: po odblokowaniu renew z listą zapamiętaną przed nim, pamięć zapisana")
  func lockedKeychainThenRenewWithRememberedList() async throws {
    let rig = AccessRig(store: RX.locked(), signer: nil)
    rig.transport.enqueue(.renew, F.renewed(expiresAt: RX.expires, unsponsored: []))
    let log = StatusLog(rig.access.statuses)

    await rig.access.setServers([RX.target()])
    await rig.access.trigger(.start)
    try await rig.accepted(2)
    try await eventually("bieżący status u subskrybenta") { !log.all.isEmpty }
    try await quiet()
    #expect(rig.routes.isEmpty)
    #expect(log.all == [.inactive])

    rig.store.update {
      $0.cacheUnreadable = nil
      $0.optOutUnreadable = nil
    }
    rig.identity.set(FakeRelaySigner())
    await rig.access.trigger(.identityAvailable)
    try await eventually("status po odblokowaniu") { log.last != .inactive && log.last != .working }
    #expect(log.last == RX.registered)
    try await quiet()
    #expect(rig.transport.calls.map(\.fields) == [.renew(servers: [RX.k])])
    #expect(rig.store.snapshot.cache?.sponsored[RX.k] == RX.expires)
  }

  @Test("lista sprzed tożsamości przepada, gdy pierwsza paczka z tożsamością niesie setServers([]) → zero żądań, inactive")
  func rememberedListDroppedByEmptyList() async throws {
    let rig = AccessRig(signer: nil)
    // Gdyby zapamiętana lista poszła pierwsza: renew([k]) z 404, potem register i sponsor(k) mimo pustej listy.
    rig.transport.enqueue(.renew, F.failure(.notRegistered))
    rig.transport.enqueue(.register, F.registered(endpointId: RX.app, expiresAt: RX.expires))
    rig.transport.enqueue(.sponsor, F.sponsored(server: RX.k, expiresAt: RX.expires))
    let log = StatusLog(rig.access.statuses)

    await rig.access.setServers([RX.target()])
    try await rig.accepted(1)
    rig.identity.set(FakeRelaySigner())
    await rig.access.setServers([])
    try await rig.accepted(2)
    try await eventually("bieżący status u subskrybenta") { !log.all.isEmpty }
    try await quiet()
    #expect(rig.routes.isEmpty)
    #expect(rig.gate.attempts == 0)
    #expect(log.all == [.inactive])
  }

  @Test("lista sprzed tożsamości przepada, gdy pierwsza paczka z tożsamością niesie setServers([B]) → pierwszy renew tylko z B")
  func rememberedListReplacedByNewList() async throws {
    let rig = AccessRig(signer: nil)
    rig.transport.enqueue(.renew, F.renewed(expiresAt: RX.expires, unsponsored: []))
    let log = StatusLog(rig.access.statuses)

    await rig.access.setServers([RX.target(RX.k)])
    try await rig.accepted(1)
    rig.identity.set(FakeRelaySigner())
    await rig.access.setServers([RX.target(RX.k2)])
    try await rig.accepted(2)
    try await eventually("synchronizacja skończona") { log.last != .inactive && log.last != .working }
    try await quiet()
    #expect(rig.transport.calls.map(\.fields) == [.renew(servers: [RX.k2])])
    #expect(log.last == RX.registered)
  }

  @Test("podpis przypięty do operacji: A → B w trakcie proof() → register i sponsor z podpisem A, następna synchronizacja z B i nową pamięcią")
  func signerPinnedToOperation() async throws {
    let latch = Gate()
    let transport = FakeRelayAuthTransport()
    transport.enqueue(.renew, F.failure(.notRegistered), F.renewed(expiresAt: RX.expires, unsponsored: [RX.k]))
    transport.enqueue(.register, F.registered(endpointId: RX.app, expiresAt: RX.expires))
    transport.enqueue(.sponsor, F.sponsored(server: RX.k, expiresAt: RX.expires),
                      F.sponsored(server: RX.k, expiresAt: RX.expires))
    let rig = AccessRig(transport: transport, gate: FakeRelayGate(before: { _ in await latch.wait() }))
    let log = StatusLog(rig.access.statuses)

    await rig.access.setServers([RX.target()])
    try await eventually("synchronizacja A czeka na proof()") { rig.gate.attempts == 1 }
    rig.identity.set(FakeRelaySigner(endpointId: RX.otherApp))
    await rig.access.trigger(.foreground)
    try await rig.accepted(2)
    latch.open()

    let registeredB = RelayAccessStatus.registered(appId: RX.otherApp, until: RX.date(RX.expires))
    try await eventually("synchronizacja B skończona") { log.last == registeredB }
    #expect(rig.routes == [.renew, .register, .sponsor, .renew, .sponsor])
    #expect(transport.calls.map(\.endpointId) == [RX.app, RX.app, RX.app, RX.otherApp, RX.otherApp])
    #expect(log.all.contains(RX.registered), "operacja A kończy się wpisem A")
    #expect(rig.store.snapshot.cache?.appId == RX.otherApp)
    #expect(rig.logs.all.contains("relay-access: cache of another identity or registry replaced"))
    #expect(transport.maxInFlight == 1)
  }

  // MARK: - Bilety wołających

  @Test("bilety naraz: dwa prepareForPairing i forget(), jedno anulowane przed odpowiedzią → każde wywołanie ma jeden wynik, nic nie wisi")
  func overlappingTickets() async throws {
    let latch = Gate()
    let rig = AccessRig(transport: latchedTransport(latch, unsponsored: [RX.k]))
    let access = rig.access
    let log = StatusLog(access.statuses)

    let first = Task { await access.prepareForPairing(RX.target(), budget: RX.budget) }
    try await eventually("renew pierwszego parowania w drodze") { rig.transport.calls.count == 1 }
    let second = Task { await access.prepareForPairing(RX.target(RX.k2), budget: RX.budget) }
    try await rig.accepted(2)
    #expect(await first.value == .unavailable, "nowsze parowanie zastępuje starsze")
    second.cancel()
    #expect(await second.value == .unavailable, "anulowane przed odpowiedzią")
    let forgetting = Task { await access.forget() }
    try await rig.accepted(3)
    latch.open()

    #expect(await forgetting.value == .optedOut(appId: RX.app, removal: .confirmed))
    try await eventually("status rezygnacji u subskrybenta") {
      log.last == .optedOut(appId: RX.app, removal: .confirmed)
    }
    try await quiet()
    #expect(rig.routes == [.renew, .forget])
    #expect(await access.waitingCallers == 0)
    #expect(rig.clock.sleeperCount == 0)
  }

  @Test("odpowiedź rejestru w chwili końca budżetu: jeden wynik, linia budżetu tylko przy .unavailable, nic nie wisi")
  func replyExactlyAtBudget() async throws {
    // Odpowiedź renew na tym samym zegarze co budżet: oba terminy mijają jednym `advance`. Zwykle wygrywa budżet
    // (krótsza ścieżka), a wynik maszyny trafia chwilę później w rozstrzygniętą już odpowiedź; niezmienniki testu
    // obowiązują przy każdej kolejności, więc kilka przebiegów.
    for _ in 0..<12 {
      let clock = ManualClock()
      let transport = FakeRelayAuthTransport { _ in
        try? await clock.sleep(for: RX.budget)
        return F.renewed(expiresAt: RX.expires, unsponsored: [])
      }
      let rig = AccessRig(transport: transport, clock: clock)
      let access = rig.access
      let log = StatusLog(access.statuses)

      let pairing = Task { await access.prepareForPairing(RX.target(), budget: RX.budget) }
      try await eventually("budżet i odpowiedź rejestru na zegarze") { clock.sleeperCount == 2 }
      clock.advance(by: RX.budget)
      let result = await pairing.value
      #expect(result == .ready(sponsoredAt: nil) || result == .unavailable)

      try await eventually("synchronizacja skończona") { log.last == RX.registered }
      try await quiet()
      let budgetLines = rig.logs.all.filter { $0.contains("pairing budget elapsed") }.count
      #expect(budgetLines == (result == .unavailable ? 1 : 0), "linia budżetu tylko, gdy budżet wygrał")
      #expect(rig.routes == [.renew])
      #expect(await access.waitingCallers == 0)
      #expect(clock.sleeperCount == 0)
    }
  }

  // MARK: - Kolejka i statusy

  @Test("10 × T-front w trakcie synchronizacji = jedna następna synchronizacja")
  func foregroundTriggersCoalesce() async throws {
    let latch = Gate()
    // Okres odnowienia 0 s: każda należna synchronizacja woła renew, więc widać, ile ich było.
    let rig = AccessRig(transport: latchedTransport(latch), renewEvery: .zero)

    await rig.access.setServers([RX.target()])
    try await eventually("renew w drodze") { rig.transport.calls.count == 1 }
    for _ in 0..<10 { await rig.access.trigger(.foreground) }
    try await rig.accepted(11)
    latch.open()

    try await eventually("jedna następna synchronizacja") { rig.transport.calls.count == 2 }
    try await quiet()
    #expect(rig.routes == [.renew, .renew])
    #expect(rig.transport.maxInFlight == 1)
  }

  @Test("statuses daje bieżący status od razu każdemu subskrybentowi, potem zmiany")
  func statusesStartWithCurrent() async throws {
    let rig = AccessRig()
    rig.transport.enqueue(.renew, F.renewed(expiresAt: RX.expires, unsponsored: []))

    let early = StatusLog(rig.access.statuses)
    #expect(await firstStatus(rig.access.statuses) == .inactive)

    await rig.access.setServers([RX.target()])
    try await eventually("pierwszy subskrybent widzi zmiany") { early.last == RX.registered }
    #expect(early.all == [.inactive, .working, RX.registered])

    #expect(await firstStatus(rig.access.statuses) == RX.registered)
    #expect(await firstStatus(rig.access.statuses) == RX.registered)
  }
}
