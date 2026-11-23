import Foundation
import RarogContract
@testable import RarogTransport
import RarogTransportTesting
import Testing

// The iroh relay registry client machine: a test per rule of the machine, a renewal-period sequence and random
// sequences with a fixed seed. Tests run through `Driver`, which does what the `RelayAccess` actor does: it runs store
// commands at once on the fake and hands the result to the machine, and keeps a request and a proof in flight until
// the test answers.

private typealias M = RelayAccessMachine
private typealias C = RelayAccessMachine.Command
private typealias F = FakeRelayAuthTransport
private typealias Route = RelayAuthWire.Route

/// Stałe testów: tożsamości, relaye, rejestr, chwile w sekundach epoki.
private enum RA {
  static let app = String(repeating: "c3", count: 32)
  static let otherApp = String(repeating: "d4", count: 32)
  static let k = String(repeating: "ab", count: 32)
  static let k2 = String(repeating: "cd", count: 32)
  static let k3 = String(repeating: "ef", count: 32)
  static let relay = URL(string: "https://relay.rarog.ai/")!
  static let ownRelay = URL(string: "https://relay.example.net/")!
  static let registry = URL(string: "https://relay-auth.rarog.ai")!
  static let customRegistry = URL(string: "https://registry.example.net")!
  static let t0: Int64 = 1_800_000_000
  static let hour: Int64 = 3_600
  static let day: Int64 = 86_400
  static let term: Int64 = 90 * 86_400

  static func date(_ seconds: Int64) -> Date { Date(timeIntervalSince1970: TimeInterval(seconds)) }
  static func target(_ id: String, _ relay: URL = relay) -> TunnelTarget { TunnelTarget(endpointId: id, relay: relay) }

  static func proof(_ attempt: Int) -> RelayAuthWire.Proof {
    RelayAuthWire.Proof(kind: .devicecheck, environment: .development,
                        token: FakeRelayGate.token(.devicecheck, attempt: attempt))
  }

  /// Pamięć po udanej synchronizacji w chwili `sync`: wpis i poręczenia `sponsored` na 90 dni.
  static func fresh(at sync: Int64, sponsored: [String], appId: String = app) -> RelayAccessCache {
    RelayAccessCache(appId: appId, registry: registry, registeredUntil: sync + term, lastSyncAt: sync,
                     sponsored: Dictionary(uniqueKeysWithValues: sponsored.map { ($0, sync + term) }))
  }

  /// Pamięć sprzed tygodnia: wpis żywy, okres odnowienia minął.
  static func stale(sponsored: [String] = []) -> RelayAccessCache { fresh(at: t0 - 7 * day, sponsored: sponsored) }

  static func optOut(_ removal: RelayRemoval, registry: URL = registry, appId: String = app) -> RelayOptOut {
    RelayOptOut(appId: appId, registry: registry, at: t0 - day, removal: removal)
  }
}

/// Wykonawca poleceń maszyny jak actor: magazyn atrapy od razu, żądanie i dowód w drodze do odpowiedzi testu.
private struct Driver {
  var machine: RelayAccessMachine
  let store: FakeRelayAccessStore
  var gateSupported: Bool
  var now: Int64
  /// Polecenia od początku albo od `clear()`, z liniami logu.
  var commands: [C] = []
  /// Żądanie albo dowód, na który maszyna czeka.
  var outstanding: C?
  var replies: [Route: [RelayAuthReply]] = [:]
  var proofQueue: [Result<RelayAuthWire.Proof, RelayGateFailure>] = []
  var proofAttempts = 0
  /// Naruszenia jednego polecenia w drodze (zbiera je test losowy, testy wierszy sprawdzają, że puste).
  var violations: [String] = []

  init(_ contents: FakeRelayAccessStore.Contents = .init(), gateSupported: Bool = true, now: Int64 = RA.t0) {
    store = FakeRelayAccessStore(contents)
    self.gateSupported = gateSupported
    self.now = now
    machine = RelayAccessMachine(cache: store.loadCache(), optOut: store.loadOptOut(), gateSupported: gateSupported)
  }

  /// Restart procesu: nowa maszyna na tym samym magazynie, polecenie w drodze przepada.
  mutating func restart() {
    machine = RelayAccessMachine(cache: store.loadCache(), optOut: store.loadOptOut(), gateSupported: gateSupported)
    outstanding = nil
  }

  /// Zdarzenie; polecenia magazynu wykonuje od razu i oddaje wynik. Zwraca wszystkie polecenia tego kroku.
  @discardableResult
  mutating func feed(_ event: M.Event) -> [C] {
    var emitted: [C] = []
    var queue = [event]
    while !queue.isEmpty {
      let next = queue.removeFirst()
      let out = machine.handle(next, now: RA.date(now))
      let awaited = out.filter(Self.awaitsResult)
      if awaited.count > 1 || (awaited.count == 1 && outstanding != nil) {
        violations.append("dwa polecenia z wynikiem naraz: \(awaited), w drodze \(String(describing: outstanding))")
      }
      for command in out {
        switch command {
        case let .saveCache(cache): queue.append(.cacheSaved(store.saveCache(cache)))
        case let .saveOptOut(record, generation):
          queue.append(.optOutSaved(generation: generation, store.saveOptOut(record)))
        case let .deleteOptOut(generation): queue.append(.optOutDeleted(generation: generation, store.deleteOptOut()))
        case .send, .proof: outstanding = command
        default: break
        }
      }
      emitted += out
    }
    commands += emitted
    return emitted
  }

  static func awaitsResult(_ command: C) -> Bool {
    switch command {
    case .send, .proof, .saveOptOut, .deleteOptOut: true
    default: false
    }
  }

  mutating func enqueue(_ route: Route, _ replies: RelayAuthReply...) {
    self.replies[route, default: []].append(contentsOf: replies)
  }

  /// Odpowiada na polecenie w drodze: `reply`/`proof` albo kolejka trasy (domyślnie `.unreachable` i nowy dowód).
  @discardableResult
  mutating func step(reply: RelayAuthReply? = nil, proof: Result<RelayAuthWire.Proof, RelayGateFailure>? = nil)
    -> Bool {
    guard let pending = outstanding else { return false }
    outstanding = nil
    switch pending {
    case let .send(fields, _, _, generation):
      var answer = reply
      if answer == nil, var queued = replies[fields.route], !queued.isEmpty {
        answer = queued.removeFirst()
        replies[fields.route] = queued
      }
      feed(.replied(generation: generation, answer ?? .unreachable("no reply")))
    case let .proof(generation):
      proofAttempts += 1
      let result = proof ?? (proofQueue.isEmpty ? .success(RA.proof(proofAttempts)) : proofQueue.removeFirst())
      feed(.proved(generation: generation, result))
    default:
      break
    }
    return true
  }

  /// Odpowiada, dopóki coś jest w drodze.
  mutating func settle() {
    var steps = 0
    while step() {
      steps += 1
      if steps > 64 {
        violations.append("pętla żądań")
        return
      }
    }
  }

  mutating func clear() { commands = [] }

  var requests: [C] {
    commands.filter { if case .send = $0 { return true }; if case .proof = $0 { return true }; return false }
  }
  var sends: [RelayAuthWire.Fields] {
    commands.compactMap { if case let .send(fields, _, _, _) = $0 { return fields }; return nil }
  }
  var routes: [Route] { sends.map(\.route) }
  var proofs: Int { commands.filter { if case .proof = $0 { return true }; return false }.count }
  var logs: [String] { commands.compactMap { if case let .log(line) = $0 { return line }; return nil } }
  var statuses: [RelayAccessStatus] {
    commands.compactMap { if case let .status(status) = $0 { return status }; return nil }
  }
  var prepared: [M.Ticket: [RelayPrepareResult]] {
    var out: [M.Ticket: [RelayPrepareResult]] = [:]
    for case let .prepareResult(ticket, result) in commands { out[ticket, default: []].append(result) }
    return out
  }
  var forgot: [M.Ticket: [RelayAccessStatus]] {
    var out: [M.Ticket: [RelayAccessStatus]] = [:]
    for case let .forgetResult(ticket, status) in commands { out[ticket, default: []].append(status) }
    return out
  }
  var cacheSaves: Int { commands.filter { if case .saveCache = $0 { return true }; return false }.count }
  var cache: RelayAccessCache? { store.snapshot.cache }
  var status: RelayAccessStatus { machine.status }

  /// Problem z przerwą w sekundach od teraz.
  func problem(_ problem: RelayAccessProblem, after seconds: Int64) -> RelayAccessStatus {
    .problem(problem, appId: RA.app, retryAt: RA.date(now + seconds))
  }

  func registered(until: Int64) -> RelayAccessStatus { .registered(appId: RA.app, until: RA.date(until)) }
}

private let list = [RA.target(RA.k)]
private let list2 = [RA.target(RA.k), RA.target(RA.k2)]

@Suite("maszyna klienta rejestru relaya iroh: reguły")
struct RelayAccessMachineTests {
  // MARK: - Kiedy synchronizować

  @Test("wyzwalacz automatyczny przy pustej liście albo tylko relayu spoza mapy: bez żądań, inactive")
  func emptyList() {
    var d = Driver(.init(cache: RA.stale(sponsored: [RA.k])))
    d.feed(.trigger(.start, appId: RA.app))
    d.feed(.servers([RA.target(RA.k, RA.ownRelay)], appId: RA.app))
    for trigger in [RelayAccessTrigger.foreground, .identityAvailable, .tunnelFailed] {
      d.feed(.trigger(trigger, appId: RA.app))
    }
    #expect(d.requests.isEmpty && d.status == .inactive && d.statuses.isEmpty)

    var opted = Driver(.init(optOut: RA.optOut(.confirmed)))
    opted.feed(.trigger(.foreground, appId: RA.app))
    #expect(opted.requests.isEmpty && opted.status == .inactive)
    #expect(d.violations.isEmpty && opted.violations.isEmpty)
  }

  @Test("brak tożsamości: bez żądań, inactive i linia w logu; T-tożsamość powtarza wyzwalacz")
  func noIdentity() {
    var d = Driver(.init(cache: RA.stale(sponsored: [RA.k])))
    d.feed(.servers(list, appId: nil))
    d.feed(.trigger(.start, appId: nil))
    #expect(d.requests.isEmpty && d.status == .inactive)
    #expect(d.logs.contains { $0.hasPrefix("relay-access: ") && $0.contains("identity") })
    d.feed(.trigger(.identityAvailable, appId: RA.app))
    #expect(d.routes == [.renew] && d.status == .working)
    #expect(d.violations.isEmpty)
  }

  @Test("rezygnacja pending: sam forget do rejestru z zapisu niezależnie od listy i mapy; confirmed: bez żądań")
  func optedOut() {
    var d = Driver(.init(optOut: RA.optOut(.pending, registry: RA.customRegistry)))
    d.enqueue(.forget, F.forgotten())
    let first = d.feed(.trigger(.start, appId: RA.app))
    #expect(first.contains(.send(.forget, registry: RA.customRegistry, issuedAt: RA.t0, generation: 1)))
    d.settle()
    #expect(d.routes == [.forget])
    #expect(d.status == .optedOut(appId: RA.app, removal: .confirmed))
    #expect(d.store.snapshot.optOut == RA.optOut(.confirmed, registry: RA.customRegistry))

    d.clear()
    d.feed(.servers(list2, appId: RA.app))
    for trigger in [RelayAccessTrigger.start, .foreground, .identityAvailable, .tunnelFailed] {
      d.feed(.trigger(trigger, appId: RA.app))
    }
    #expect(d.requests.isEmpty && d.status == .optedOut(appId: RA.app, removal: .confirmed))

    var blocked = Driver(.init(optOut: RA.optOut(.blockedByAdmin)))
    blocked.feed(.servers(list, appId: RA.app))
    #expect(blocked.requests.isEmpty && blocked.status == .optedOut(appId: RA.app, removal: .blockedByAdmin))
    #expect(d.violations.isEmpty && blocked.violations.isEmpty)
  }

  @Test("rezygnacja nieczytelna: bez żądań, problem(storage), wpis nietknięty do T-parowania")
  func unreadableOptOut() {
    var d = Driver(.init(cache: RA.stale(sponsored: [RA.k]), optOutUnreadable: "relay-optout: Keychain locked"))
    d.feed(.servers(list2, appId: RA.app))
    for trigger in [RelayAccessTrigger.start, .foreground, .identityAvailable, .tunnelFailed] {
      d.feed(.trigger(trigger, appId: RA.app))
    }
    #expect(d.requests.isEmpty)
    #expect(d.status == .problem(.storage, appId: RA.app, retryAt: nil))
    let snapshot = d.store.snapshot
    #expect(snapshot.optOutUnreadable != nil && snapshot.optOutSaves == 0 && snapshot.optOutDeletes == 0)
    #expect(d.logs.contains { $0.contains("opt-out unreadable") })
    #expect(d.violations.isEmpty)
  }

  @Test("okres odnowienia, żywe poręczenie każdego serwera listy, bez retryAt: bez żądań, registered z pamięci")
  func freshFromMemory() {
    let cache = RA.fresh(at: RA.t0 - RA.hour, sponsored: [RA.k])
    var d = Driver(.init(cache: cache))
    d.feed(.servers(list, appId: RA.app))
    d.feed(.trigger(.foreground, appId: RA.app))
    #expect(d.requests.isEmpty && d.status == d.registered(until: cache.registeredUntil!))

    d.now = RA.t0 - RA.hour + 6 * RA.hour
    d.feed(.trigger(.foreground, appId: RA.app))
    #expect(d.routes == [.renew])
    #expect(d.violations.isEmpty)
  }

  @Test("okres odnowienia, sekwencja: setServers([k]) → T-start → T-front w okresie odnowienia, żywe poręczenie k = zero send")
  func cardSequence() {
    let cache = RA.fresh(at: RA.t0 - 2 * RA.hour, sponsored: [RA.k])
    var d = Driver(.init(cache: cache))
    d.feed(.servers(list, appId: RA.app))
    d.now += 60
    d.feed(.trigger(.start, appId: RA.app))
    d.now += 3 * RA.hour
    d.feed(.trigger(.foreground, appId: RA.app))
    #expect(d.sends.isEmpty && d.proofs == 0 && d.cacheSaves == 0)
    #expect(d.status == d.registered(until: cache.registeredUntil!))
    #expect(d.violations.isEmpty)
  }

  @Test("now < retryAt: bez żądań, problem z pamięci; po retryAt synchronizacja")
  func retryAt() {
    var cache = RA.stale(sponsored: [RA.k])
    cache.problem = .limited
    cache.retryAt = RA.t0 + 600
    var d = Driver(.init(cache: cache))
    d.feed(.servers(list, appId: RA.app))
    d.feed(.trigger(.foreground, appId: RA.app))
    d.feed(.trigger(.start, appId: RA.app))
    #expect(d.requests.isEmpty)
    #expect(d.status == .problem(.limited, appId: RA.app, retryAt: RA.date(RA.t0 + 600)))

    d.now = RA.t0 + 600
    d.feed(.trigger(.foreground, appId: RA.app))
    #expect(d.routes == [.renew])
    #expect(d.violations.isEmpty)
  }

  @Test("T-lista z serwerem bez żywego poręczenia omija okres odnowienia i przerwę do retryAt: jedna synchronizacja")
  func newServer() {
    var cache = RA.fresh(at: RA.t0 - RA.hour, sponsored: [RA.k])
    cache.problem = .limited
    cache.retryAt = RA.t0 + RA.hour
    var d = Driver(.init(cache: cache))
    d.feed(.servers(list, appId: RA.app))
    #expect(d.requests.isEmpty)
    d.feed(.servers(list2, appId: RA.app))
    #expect(d.sends == [.renew(servers: [RA.k, RA.k2])])

    // po nieudanej synchronizacji T-front z tą samą listą nie omija przerwy do retryAt
    d.step(reply: .unreachable("network"))
    d.now += 30
    d.feed(.trigger(.foreground, appId: RA.app))
    #expect(d.sends == [.renew(servers: [RA.k, RA.k2])])
    #expect(d.status == .problem(.unreachable, appId: RA.app, retryAt: RA.date(RA.t0 + 60)))
    #expect(d.violations.isEmpty)
  }

  @Test("T-tunel omija okres odnowienia, nie omija przerwy do retryAt; najwyżej raz na 10 min (lastTunnelCheckAt)")
  func tunnelFailed() {
    let cache = RA.fresh(at: RA.t0 - RA.hour, sponsored: [RA.k])
    var d = Driver(.init(cache: cache))
    d.feed(.servers(list, appId: RA.app))
    d.enqueue(.renew, F.renewed(expiresAt: RA.t0 + RA.term), F.renewed(expiresAt: RA.t0 + 700 + RA.term))
    d.feed(.trigger(.tunnelFailed, appId: RA.app))
    #expect(d.routes == [.renew])
    d.settle()
    #expect(d.cache?.lastTunnelCheckAt == RA.t0)

    d.now = RA.t0 + 599
    d.feed(.trigger(.tunnelFailed, appId: RA.app))
    #expect(d.routes == [.renew])
    d.now = RA.t0 + 700
    d.feed(.trigger(.tunnelFailed, appId: RA.app))
    #expect(d.routes == [.renew, .renew])
    d.settle()

    var blocked = cache
    blocked.problem = .denied
    blocked.retryAt = RA.t0 + RA.day
    var r6 = Driver(.init(cache: blocked))
    r6.feed(.servers(list, appId: RA.app))
    r6.feed(.trigger(.tunnelFailed, appId: RA.app))
    #expect(r6.requests.isEmpty && r6.status == .problem(.denied, appId: RA.app, retryAt: RA.date(RA.t0 + RA.day)))
    #expect(d.violations.isEmpty && r6.violations.isEmpty)
  }

  @Test("synchronizacja należna: renew(lista) do rejestru z mapy, chwila i generacja w poleceniu")
  func renewDue() {
    var d = Driver(.init(cache: RA.stale(sponsored: [RA.k])))
    d.feed(.trigger(.start, appId: RA.app))
    let out = d.feed(.servers(list2, appId: RA.app))
    #expect(out.contains(.send(.renew(servers: [RA.k, RA.k2]), registry: RA.registry, issuedAt: RA.t0, generation: 1)))
    #expect(d.machine.generation == 1 && d.status == .working)
    #expect(d.violations.isEmpty)
  }

  // MARK: - Wyniki żądań

  @Test("renew 200: wpis, lastSyncAt, failures 0, bez retryAt i problemu; poręczenia, sponsor dla unsponsored")
  func renewed() {
    var cache = RA.stale()
    cache.failures = 3
    cache.retryAt = RA.t0 - 1
    cache.problem = .unreachable
    var d = Driver(.init(cache: cache))
    d.feed(.servers(list2, appId: RA.app))
    d.now += 5
    let expires = RA.t0 + RA.term
    d.step(reply: F.renewed(expiresAt: expires, unsponsored: [RA.k2]))
    var expected = RA.stale()
    expected.registeredUntil = expires
    expected.lastSyncAt = RA.t0 + 5
    expected.sponsored = [RA.k: expires]
    #expect(d.machine.cache == expected)
    #expect(d.sends.last == .sponsor(server: RA.k2))
    d.step(reply: F.sponsored(server: RA.k2, expiresAt: expires + 1))
    expected.sponsored[RA.k2] = expires + 1
    #expect(d.cache == expected && d.status == d.registered(until: expires))
    #expect(d.outstanding == nil && d.violations.isEmpty)
  }

  @Test("renew 404 not-registered: dowód bramki, potem register z tym dowodem")
  func notRegistered() {
    var d = Driver(.init(cache: RA.stale(sponsored: [RA.k])))
    d.feed(.servers(list, appId: RA.app))
    d.step(reply: F.failure(.notRegistered))
    #expect(d.outstanding == .proof(generation: 1))
    d.step()
    #expect(d.sends.last == .register(proof: RA.proof(1)))
    #expect(d.cache?.registeredUntil == nil && d.cache?.sponsored == [:])
    #expect(d.violations.isEmpty)
  }

  @Test("bramka bez wsparcia: po renew 404 bez dowodu i register, unsupported")
  func unsupported() {
    var d = Driver(.init(cache: RA.stale(sponsored: [RA.k])), gateSupported: false)
    d.feed(.servers(list, appId: RA.app))
    d.step(reply: F.failure(.notRegistered))
    #expect(d.routes == [.renew] && d.proofs == 0 && d.outstanding == nil)
    #expect(d.status == .unsupported(appId: RA.app))

    // bramka mówi `unsupported` przy próbie: ten sam wynik
    var thrown = Driver(.init(cache: RA.stale()))
    thrown.feed(.servers(list, appId: RA.app))
    thrown.step(reply: F.failure(.notRegistered))
    thrown.step(proof: .failure(.unsupported))
    #expect(thrown.routes == [.renew] && thrown.status == .unsupported(appId: RA.app))
    #expect(d.violations.isEmpty && thrown.violations.isEmpty)
  }

  @Test("po unsupported wyzwalacze automatyczne bez żądań przez 24 h; parowanie pyta rejestr dalej")
  func unsupportedPause() {
    var d = Driver(.init(cache: RA.stale(sponsored: [RA.k])), gateSupported: false)
    d.feed(.servers(list, appId: RA.app))
    d.step(reply: F.failure(.notRegistered))
    d.clear()
    d.now = RA.t0 + RA.hour
    d.feed(.trigger(.foreground, appId: RA.app))
    d.feed(.trigger(.tunnelFailed, appId: RA.app))
    d.feed(.servers(list2, appId: RA.app))
    #expect(d.requests.isEmpty && d.status == .unsupported(appId: RA.app))

    d.feed(.pair(RA.target(RA.k), ticket: 3, appId: RA.app))
    d.step(reply: F.failure(.notRegistered))
    #expect(d.routes == [.renew] && d.prepared == [3: [.skipped]])

    // unsupported przy parowaniu odnawia przerwę: liczy się od t0 + 1 h
    d.clear()
    d.now = RA.t0 + RA.day
    d.feed(.trigger(.foreground, appId: RA.app))
    #expect(d.requests.isEmpty)
    d.now = RA.t0 + RA.hour + RA.day
    d.feed(.trigger(.foreground, appId: RA.app))
    #expect(d.routes == [.renew])
    #expect(d.violations.isEmpty)
  }

  @Test("proof() rzuca: problem(gateFailed), przerwa jak przy unreachable")
  func gateFailed() {
    var d = Driver(.init(cache: RA.stale()))
    d.feed(.servers(list, appId: RA.app))
    d.step(reply: F.failure(.notRegistered))
    d.step(proof: .failure(.failed("DCError 1")))
    #expect(d.routes == [.renew] && d.status == d.problem(.gateFailed, after: 60))
    #expect(d.cache?.failures == 1 && d.cache?.retryAt == RA.t0 + 60 && d.cache?.problem == .gateFailed)
    #expect(d.logs.contains { $0.contains("gate failed") && $0.contains("DCError 1") })

    d.now = RA.t0 + 60
    d.feed(.trigger(.foreground, appId: RA.app))
    d.step(reply: F.failure(.notRegistered))
    d.step(proof: .failure(.failed("DCError 1")))
    #expect(d.cache?.failures == 2 && d.status == d.problem(.gateFailed, after: 120))
    #expect(d.violations.isEmpty)
  }

  @Test("register 200: jak renew 200 i sponsor dla całej listy po kolei")
  func registerOk() {
    var d = Driver(.init(cache: RA.stale(sponsored: [RA.k])))
    d.feed(.servers(list2, appId: RA.app))
    d.step(reply: F.failure(.notRegistered))
    d.step()
    let expires = RA.t0 + RA.term
    d.step(reply: F.registered(endpointId: RA.app, expiresAt: expires))
    #expect(d.cache?.registeredUntil == expires && d.cache?.lastSyncAt == RA.t0 && d.cache?.failures == 0)
    d.enqueue(.sponsor, F.sponsored(server: RA.k, expiresAt: expires), F.sponsored(server: RA.k2, expiresAt: expires))
    d.settle()
    #expect(d.sends.suffix(2) == [.sponsor(server: RA.k), .sponsor(server: RA.k2)])
    #expect(d.cache?.sponsored == [RA.k: expires, RA.k2: expires] && d.status == d.registered(until: expires))
    #expect(d.violations.isEmpty)
  }

  @Test("register 400 gate-mismatch: problem(gateMismatch) na 24 h, linia z bramką Workera")
  func gateMismatch() {
    var d = Driver(.init(cache: RA.stale()))
    d.feed(.servers(list, appId: RA.app))
    d.step(reply: F.failure(.notRegistered))
    d.step()
    d.step(reply: F.failure(.gateMismatch, gate: .apns))
    #expect(d.status == d.problem(.gateMismatch, after: RA.day) && d.outstanding == nil)
    #expect(d.logs.contains { $0.contains("gate mismatch") && $0.contains("apns") && $0.contains("devicecheck") })
    #expect(d.violations.isEmpty)
  }

  @Test("register 422: od razu nowy dowód i register; druga 422 → problem(proofRejected) na 1 h")
  func proofRejected() {
    var d = Driver(.init(cache: RA.stale()))
    d.feed(.servers(list, appId: RA.app))
    d.step(reply: F.failure(.notRegistered))
    d.step()
    d.step(reply: F.failure(.proofRejected))
    #expect(d.outstanding == .proof(generation: 1))
    d.step()
    d.step(reply: F.failure(.proofRejected))
    #expect(d.sends == [.renew(servers: [RA.k]), .register(proof: RA.proof(1)), .register(proof: RA.proof(2))])
    #expect(d.status == d.problem(.proofRejected, after: RA.hour) && d.outstanding == nil)

    var ok = Driver(.init(cache: RA.stale()))
    ok.feed(.servers(list, appId: RA.app))
    ok.enqueue(.renew, F.failure(.notRegistered))
    ok.enqueue(.register, F.failure(.proofRejected), F.registered(endpointId: RA.app, expiresAt: RA.t0 + RA.term))
    ok.enqueue(.sponsor, F.sponsored(server: RA.k, expiresAt: RA.t0 + RA.term))
    ok.settle()
    #expect(ok.routes == [.renew, .register, .register, .sponsor] && ok.status == ok.registered(until: RA.t0 + RA.term))
    #expect(d.violations.isEmpty && ok.violations.isEmpty)
  }

  @Test("429 limited → limited na 1 h; 429 quota-exceeded przy register → quota na 24 h")
  func limits() {
    var limited = Driver(.init(cache: RA.stale()))
    limited.feed(.servers(list, appId: RA.app))
    limited.step(reply: F.failure(.limited))
    #expect(limited.status == limited.problem(.limited, after: RA.hour))

    var quota = Driver(.init(cache: RA.stale()))
    quota.feed(.servers(list, appId: RA.app))
    quota.step(reply: F.failure(.notRegistered))
    quota.step()
    quota.step(reply: F.failure(.quotaExceeded))
    #expect(quota.status == quota.problem(.quota, after: RA.day) && quota.cache?.retryAt == RA.t0 + RA.day)
    #expect(limited.violations.isEmpty && quota.violations.isEmpty)
  }

  @Test("401 clock-skew → problem(clock) na 1 h")
  func clock() {
    var d = Driver(.init(cache: RA.stale()))
    d.feed(.servers(list, appId: RA.app))
    d.step(reply: F.failure(.clockSkew))
    #expect(d.status == d.problem(.clock, after: RA.hour) && d.cache?.problem == .clock)
    #expect(d.violations.isEmpty)
  }

  @Test("403 denied na trasie apki poza forget → problem(denied) na 24 h")
  func denied() {
    var renew = Driver(.init(cache: RA.stale()))
    renew.feed(.servers(list, appId: RA.app))
    renew.step(reply: F.failure(.denied))
    #expect(renew.status == renew.problem(.denied, after: RA.day))

    var register = Driver(.init(cache: RA.stale()))
    register.feed(.servers(list, appId: RA.app))
    register.step(reply: F.failure(.notRegistered))
    register.step()
    register.step(reply: F.failure(.denied))
    #expect(register.status == register.problem(.denied, after: RA.day))
    #expect(renew.violations.isEmpty && register.violations.isEmpty)
  }

  @Test("brak odpowiedzi i ≥ 500 → unreachable, przerwa wykładnicza (sufit 6 h); inna odpowiedź → internal na 24 h")
  func unreachableAndInternal() {
    var d = Driver(.init(cache: RA.stale()))
    d.feed(.servers(list, appId: RA.app))
    d.step(reply: .unreachable("network: URLError -1001"))
    #expect(d.status == d.problem(.unreachable, after: 60) && d.cache?.failures == 1)
    let start = d.now
    d.now = start + 60
    d.feed(.trigger(.foreground, appId: RA.app))
    d.step(reply: F.failure(.unavailable))
    #expect(d.status == d.problem(.unreachable, after: 120) && d.cache?.failures == 2)
    d.now += 120
    d.feed(.trigger(.foreground, appId: RA.app))
    d.step(reply: .failure(status: 500, code: nil, gate: nil))
    #expect(d.status == d.problem(.unreachable, after: 240))

    var cap = RA.stale()
    cap.failures = 40
    var capped = Driver(.init(cache: cap))
    capped.feed(.servers(list, appId: RA.app))
    capped.step(reply: .unreachable("network"))
    #expect(capped.status == capped.problem(.unreachable, after: 6 * RA.hour) && capped.cache?.failures == 41)

    let others: [RelayAuthReply] = [
      F.failure(.badRequest), F.failure(.badSignature), .failure(status: 418, code: nil, gate: nil),
      .failure(status: 429, code: nil, gate: nil), .failure(status: 204, code: nil, gate: nil),
      F.failure(.quotaExceeded), F.failure(.kindConflict),
    ]
    for reply in others {
      var other = Driver(.init(cache: RA.stale()))
      other.feed(.servers(list, appId: RA.app))
      other.step(reply: reply)
      #expect(other.status == other.problem(.internal, after: RA.day), "\(reply)")
      #expect(other.cache?.failures == 0 && other.violations.isEmpty)
    }
    #expect(d.violations.isEmpty && capped.violations.isEmpty)
  }

  @Test("kod błędu bez swojego statusu z kontraktu się nie liczy: ≥ 500 → unreachable, inny → internal")
  func codeWithoutItsStatus() {
    func fail(_ status: Int, _ code: RelayAuthWire.ErrorCode, gate: RelayAuthWire.Gate? = nil) -> RelayAuthReply {
      .failure(status: status, code: code, gate: gate)
    }
    let expires = RA.t0 + RA.term

    // renew 503 not-registered: bez dowodu i register (dowód i register tylko przy 404)
    var renew = Driver(.init(cache: RA.stale()))
    renew.feed(.servers(list, appId: RA.app))
    renew.step(reply: fail(503, .notRegistered))
    #expect(renew.routes == [.renew] && renew.proofs == 0 && renew.status == renew.problem(.unreachable, after: 60))
    #expect(renew.logs.contains { $0.contains("not-registered") && $0.contains("503") })

    // register 503 proof-rejected i 502 gate-mismatch: bez drugiego dowodu, bez gateMismatch
    for reply in [fail(503, .proofRejected), fail(502, .gateMismatch, gate: .apns)] {
      var register = Driver(.init(cache: RA.stale()))
      register.feed(.servers(list, appId: RA.app))
      register.step(reply: F.failure(.notRegistered))
      register.step()
      register.step(reply: reply)
      #expect(register.routes == [.renew, .register] && register.proofs == 1, "\(reply)")
      #expect(register.status == register.problem(.unreachable, after: 60), "\(reply)")
      #expect(register.violations.isEmpty)
    }

    // sponsor 503 not-registered: bez register (register tylko przy 404), synchronizacja staje
    var sponsor = Driver(.init(cache: RA.stale()))
    sponsor.feed(.servers(list, appId: RA.app))
    sponsor.enqueue(.renew, F.renewed(expiresAt: expires, unsponsored: [RA.k]))
    sponsor.enqueue(.sponsor, fail(503, .notRegistered))
    sponsor.settle()
    #expect(sponsor.routes == [.renew, .sponsor] && sponsor.status == sponsor.problem(.unreachable, after: 60))
    #expect(sponsor.cache?.registeredUntil == expires)

    // inny status 4xx z kodem cudzego statusu → internal, nie denied
    var other = Driver(.init(cache: RA.stale()))
    other.feed(.servers(list, appId: RA.app))
    other.step(reply: fail(400, .denied))
    #expect(other.status == other.problem(.internal, after: RA.day))

    // forget 503 denied: pending i ponowienie przy następnym wyzwalaczu (blockedByAdmin tylko przy 403)
    var forget = Driver(.init(cache: RA.stale()))
    forget.feed(.forget(ticket: 1, appId: RA.app))
    forget.step(reply: fail(503, .denied))
    #expect(forget.store.snapshot.optOut?.removal == .pending)
    #expect(forget.forgot == [1: [.optedOut(appId: RA.app, removal: .pending)]])
    forget.feed(.trigger(.foreground, appId: RA.app))
    #expect(forget.routes == [.forget, .forget])
    #expect(renew.violations.isEmpty && sponsor.violations.isEmpty && other.violations.isEmpty)
    #expect(forget.violations.isEmpty)
  }

  @Test("sponsor 200 → sponsored[s] = expiresAt z odpowiedzi")
  func sponsored() {
    var d = Driver(.init(cache: RA.stale()))
    d.feed(.servers(list, appId: RA.app))
    d.step(reply: F.renewed(expiresAt: RA.t0 + RA.term, unsponsored: [RA.k]))
    d.step(reply: F.sponsored(server: RA.k, expiresAt: RA.t0 + 1234))
    #expect(d.cache?.sponsored == [RA.k: RA.t0 + 1234] && d.status == d.registered(until: RA.t0 + RA.term))
    #expect(d.violations.isEmpty)
  }

  @Test("sponsor 404 bez udanego register w tej synchronizacji: jeden register i jeden sponsor; inaczej internal")
  func sponsorNotRegistered() {
    let expires = RA.t0 + RA.term
    var d = Driver(.init(cache: RA.stale()))
    d.feed(.servers(list, appId: RA.app))
    d.enqueue(.renew, F.renewed(expiresAt: expires, unsponsored: [RA.k]))
    d.enqueue(.sponsor, F.failure(.notRegistered), F.sponsored(server: RA.k, expiresAt: expires))
    d.enqueue(.register, F.registered(endpointId: RA.app, expiresAt: expires))
    d.settle()
    #expect(d.routes == [.renew, .sponsor, .register, .sponsor] && d.status == d.registered(until: expires))

    var twice = Driver(.init(cache: RA.stale()))
    twice.feed(.servers(list, appId: RA.app))
    twice.enqueue(.renew, F.renewed(expiresAt: expires, unsponsored: [RA.k]))
    twice.enqueue(.sponsor, F.failure(.notRegistered), F.failure(.notRegistered))
    twice.enqueue(.register, F.registered(endpointId: RA.app, expiresAt: expires))
    twice.settle()
    #expect(twice.routes == [.renew, .sponsor, .register, .sponsor])
    #expect(twice.status == twice.problem(.internal, after: RA.day))

    var registered = Driver(.init(cache: RA.stale()))
    registered.feed(.servers(list, appId: RA.app))
    registered.enqueue(.renew, F.failure(.notRegistered))
    registered.enqueue(.register, F.registered(endpointId: RA.app, expiresAt: expires))
    registered.enqueue(.sponsor, F.failure(.notRegistered))
    registered.settle()
    #expect(registered.routes == [.renew, .register, .sponsor])
    #expect(registered.status == registered.problem(.internal, after: RA.day))
    #expect(d.violations.isEmpty && twice.violations.isEmpty && registered.violations.isEmpty)
  }

  @Test("sponsor 429 quota → serverQuota, 403 → serverDenied (24 h), 409 → internal; następny serwer idzie dalej")
  func sponsorFailures() {
    let expires = RA.t0 + RA.term
    let cases: [(RelayAuthReply, RelayAccessProblem, Int64)] = [
      (F.failure(.quotaExceeded), .serverQuota, RA.day), (F.failure(.denied), .serverDenied, RA.day),
      (F.failure(.kindConflict), .internal, RA.day),
    ]
    for (reply, problem, delay) in cases {
      var d = Driver(.init(cache: RA.stale()))
      d.feed(.servers(list2, appId: RA.app))
      d.enqueue(.renew, F.renewed(expiresAt: expires, unsponsored: [RA.k, RA.k2]))
      d.enqueue(.sponsor, reply, F.sponsored(server: RA.k2, expiresAt: expires))
      d.settle()
      #expect(d.routes == [.renew, .sponsor, .sponsor], "\(reply)")
      #expect(d.status == d.problem(problem, after: delay) && d.cache?.sponsored == [RA.k2: expires], "\(reply)")
      #expect(d.violations.isEmpty)
    }

    // limited, clock i brak odpowiedzi dotyczą apki: synchronizacja staje
    for (reply, problem, delay) in [
      (F.failure(.limited), RelayAccessProblem.limited, RA.hour), (F.failure(.clockSkew), .clock, RA.hour),
      (RelayAuthReply.unreachable("network"), .unreachable, 60),
    ] {
      var d = Driver(.init(cache: RA.stale()))
      d.feed(.servers(list2, appId: RA.app))
      d.enqueue(.renew, F.renewed(expiresAt: expires, unsponsored: [RA.k, RA.k2]))
      d.enqueue(.sponsor, reply)
      d.settle()
      #expect(d.routes == [.renew, .sponsor] && d.status == d.problem(problem, after: delay), "\(reply)")
      #expect(d.violations.isEmpty)
    }
  }

  // MARK: - Wyzwalacze użytkownika

  @Test("T-zapomnij: generacja + 1, zapis rezygnacji pending, pamięć wyczyszczona, forget → confirmed")
  func forget() {
    var d = Driver(.init(cache: RA.fresh(at: RA.t0 - RA.hour, sponsored: [RA.k])))
    d.feed(.servers(list, appId: RA.app))
    let generation = d.machine.generation
    let out = d.feed(.forget(ticket: 7, appId: RA.app))
    #expect(d.machine.generation == generation + 1)
    let pending = RelayOptOut(appId: RA.app, registry: RA.registry, at: RA.t0, removal: .pending)
    #expect(out.contains(.saveOptOut(pending, generation: generation + 1)))
    #expect(d.cache == RelayAccessCache(appId: RA.app, registry: RA.registry))
    #expect(d.outstanding == .send(.forget, registry: RA.registry, issuedAt: RA.t0, generation: generation + 1))
    #expect(d.status == .optedOut(appId: RA.app, removal: .pending))
    d.step(reply: F.forgotten())
    #expect(d.store.snapshot.optOut?.removal == .confirmed && d.status == .optedOut(appId: RA.app, removal: .confirmed))
    #expect(d.forgot == [7: [.optedOut(appId: RA.app, removal: .confirmed)]])
    #expect(d.violations.isEmpty)
  }

  @Test("zapis rezygnacji nieudany: bez forget, rezygnacji nie ma, problem(optOutNotSaved)")
  func optOutNotSaved() {
    var contents = FakeRelayAccessStore.Contents(cache: RA.stale(sponsored: [RA.k]))
    contents.optOutSaveFails = true
    var d = Driver(contents)
    d.feed(.forget(ticket: 1, appId: RA.app))
    #expect(d.requests.isEmpty && d.store.snapshot.optOut == nil)
    #expect(d.status == .problem(.optOutNotSaved, appId: RA.app, retryAt: nil))
    #expect(d.forgot == [1: [.problem(.optOutNotSaved, appId: RA.app, retryAt: nil)]])
    #expect(d.cache == RA.stale(sponsored: [RA.k]))
    #expect(d.violations.isEmpty)
  }

  @Test("forget 403 → blockedByAdmin bez ponowień; inna porażka → pending i następny wyzwalacz ponawia sam forget")
  func forgetFailures() {
    var blocked = Driver(.init(cache: RA.stale()))
    blocked.feed(.forget(ticket: 1, appId: RA.app))
    blocked.step(reply: F.failure(.denied))
    #expect(blocked.store.snapshot.optOut?.removal == .blockedByAdmin)
    #expect(blocked.forgot == [1: [.optedOut(appId: RA.app, removal: .blockedByAdmin)]])
    blocked.feed(.servers(list, appId: RA.app))
    blocked.feed(.trigger(.foreground, appId: RA.app))
    #expect(blocked.routes == [.forget])

    var pending = Driver(.init(cache: RA.stale()))
    pending.feed(.forget(ticket: 2, appId: RA.app))
    pending.step(reply: .unreachable("network"))
    #expect(pending.store.snapshot.optOut?.removal == .pending)
    #expect(pending.forgot == [2: [.optedOut(appId: RA.app, removal: .pending)]])
    pending.feed(.trigger(.foreground, appId: RA.app))
    #expect(pending.routes == [.forget, .forget])
    pending.step(reply: F.forgotten())
    #expect(pending.status == .optedOut(appId: RA.app, removal: .confirmed))
    #expect(blocked.violations.isEmpty && pending.violations.isEmpty)
  }

  @Test("zapis confirmed po forget 200 nieudany: pamięć = Keychain (pending), następny wyzwalacz ponawia forget")
  func removalNotSaved() {
    var d = Driver(.init(cache: RA.stale()))
    d.feed(.forget(ticket: 1, appId: RA.app))
    d.store.update { $0.optOutSaveFails = true }
    d.step(reply: F.forgotten())
    let pending = RelayOptOut(appId: RA.app, registry: RA.registry, at: RA.t0, removal: .pending)
    #expect(d.store.snapshot.optOut == pending && d.machine.optOut == .found(pending))
    #expect(d.forgot == [1: [.optedOut(appId: RA.app, removal: .confirmed)]])
    #expect(d.logs.contains { $0.contains("removal state not saved") })
    d.feed(.trigger(.foreground, appId: RA.app))
    #expect(d.routes == [.forget, .forget])
    #expect(d.violations.isEmpty)
  }

  @Test("T-zapomnij w trakcie renew: żądanie w drodze kończy się pierwsze, potem tylko zapis i forget")
  func forgetDuringSync() {
    var d = Driver(.init(cache: RA.stale()))
    d.feed(.servers(list, appId: RA.app))
    #expect(d.outstanding == .send(.renew(servers: [RA.k]), registry: RA.registry, issuedAt: RA.t0, generation: 1))
    let out = d.feed(.forget(ticket: 3, appId: RA.app))
    #expect(out.isEmpty && d.machine.generation == 2)
    d.enqueue(.sponsor, F.sponsored(server: RA.k, expiresAt: RA.t0 + RA.term))
    d.step(reply: F.renewed(expiresAt: RA.t0 + RA.term, unsponsored: [RA.k]))
    #expect(d.routes == [.renew, .forget] && d.store.snapshot.optOut?.removal == .pending)
    d.step(reply: F.forgotten())
    #expect(d.routes == [.renew, .forget] && d.forgot == [3: [.optedOut(appId: RA.app, removal: .confirmed)]])
    #expect(d.cache?.registeredUntil == nil)
    #expect(d.violations.isEmpty)
  }

  @Test("T-parowanie z rezygnacją pending: forget, deleteOptOut, synchronizacja listy ∪ {s}, wynik fresh")
  func pairAfterOptOut() {
    let expires = RA.t0 + RA.term
    var d = Driver(.init(cache: RA.stale(), optOut: RA.optOut(.pending)))
    d.feed(.servers(list, appId: RA.app))
    #expect(d.routes == [.forget])
    d.step(reply: .unreachable("network"))
    d.clear()
    let generation = d.machine.generation
    d.enqueue(.forget, F.forgotten())
    d.enqueue(.renew, F.failure(.notRegistered))
    d.enqueue(.register, F.registered(endpointId: RA.app, expiresAt: expires))
    d.enqueue(.sponsor, F.sponsored(server: RA.k2, expiresAt: expires), F.sponsored(server: RA.k, expiresAt: expires))
    d.feed(.pair(RA.target(RA.k2), ticket: 9, appId: RA.app))
    #expect(d.machine.generation == generation + 1)
    d.settle()
    #expect(d.sends == [.forget, .renew(servers: [RA.k2, RA.k]), .register(proof: RA.proof(1)),
                        .sponsor(server: RA.k2), .sponsor(server: RA.k)])
    #expect(d.prepared == [9: [.fresh]] && d.store.snapshot.optOut == nil && d.store.snapshot.optOutDeletes == 1)
    #expect(d.status == d.registered(until: expires))

    // później żaden wyzwalacz nie wysyła forget
    d.clear()
    d.now += 7 * RA.hour
    d.enqueue(.renew, F.renewed(expiresAt: d.now + RA.term))
    d.feed(.trigger(.foreground, appId: RA.app))
    d.settle()
    #expect(d.routes == [.renew])
    #expect(d.violations.isEmpty)
  }

  @Test("forget przed parowaniem nieudany: wynik unavailable bez rejestracji")
  func pairForgetFails() {
    var d = Driver(.init(cache: RA.stale(), optOut: RA.optOut(.pending)))
    d.feed(.pair(RA.target(RA.k), ticket: 1, appId: RA.app))
    d.step(reply: .unreachable("network"))
    #expect(d.routes == [.forget] && d.outstanding == nil)
    #expect(d.prepared == [1: [.unavailable]] && d.store.snapshot.optOut?.removal == .pending)
    #expect(d.status == .optedOut(appId: RA.app, removal: .pending))

    var denied = Driver(.init(cache: RA.stale(), optOut: RA.optOut(.pending)))
    denied.feed(.pair(RA.target(RA.k), ticket: 2, appId: RA.app))
    denied.step(reply: F.failure(.denied))
    #expect(denied.routes == [.forget] && denied.prepared == [2: [.unavailable]])
    #expect(denied.store.snapshot.optOut?.removal == .blockedByAdmin)
    #expect(d.violations.isEmpty && denied.violations.isEmpty)
  }

  @Test("rezygnacja confirmed, blockedByAdmin, nieczytelna: deleteOptOut i sync; kasowanie nieudane → unavailable")
  func pairDeletesOptOut() {
    for contents in [
      FakeRelayAccessStore.Contents(optOut: RA.optOut(.confirmed)),
      FakeRelayAccessStore.Contents(optOut: RA.optOut(.blockedByAdmin)),
      FakeRelayAccessStore.Contents(optOutUnreadable: "relay-optout: not JSON v1"),
    ] {
      var d = Driver(contents)
      d.feed(.pair(RA.target(RA.k), ticket: 1, appId: RA.app))
      #expect(d.store.snapshot.optOutDeletes == 1 && d.store.snapshot.optOut == nil)
      #expect(d.routes == [.renew])
      #expect(d.violations.isEmpty)
    }

    var contents = FakeRelayAccessStore.Contents(optOut: RA.optOut(.confirmed))
    contents.optOutDeleteFails = true
    var failing = Driver(contents)
    failing.feed(.pair(RA.target(RA.k), ticket: 4, appId: RA.app))
    #expect(failing.requests.isEmpty && failing.prepared == [4: [.unavailable]])
    #expect(failing.status == .problem(.storage, appId: RA.app, retryAt: nil))
    #expect(failing.violations.isEmpty)
  }

  @Test("parowanie omija okres odnowienia i przerwę do retryAt: serwer z żywym poręczeniem → ready, nowe poręczenie → fresh")
  func pairReadyOrFresh() {
    var cache = RA.fresh(at: RA.t0 - RA.hour, sponsored: [RA.k])
    cache.problem = .limited
    cache.retryAt = RA.t0 + RA.hour
    var ready = Driver(.init(cache: cache))
    ready.feed(.servers(list, appId: RA.app))
    #expect(ready.requests.isEmpty)
    ready.enqueue(.renew, F.renewed(expiresAt: RA.t0 + RA.term))
    ready.feed(.pair(RA.target(RA.k), ticket: 1, appId: RA.app))
    ready.settle()
    #expect(ready.routes == [.renew] && ready.prepared == [1: [.ready]])

    var fresh = Driver(.init(cache: cache))
    fresh.feed(.servers(list, appId: RA.app))
    fresh.enqueue(.renew, F.renewed(expiresAt: RA.t0 + RA.term, unsponsored: [RA.k2]))
    fresh.enqueue(.sponsor, F.sponsored(server: RA.k2, expiresAt: RA.t0 + RA.term))
    fresh.feed(.pair(RA.target(RA.k2), ticket: 2, appId: RA.app))
    fresh.settle()
    #expect(fresh.sends == [.renew(servers: [RA.k2, RA.k]), .sponsor(server: RA.k2)])
    #expect(fresh.prepared == [2: [.fresh]])

    var failed = Driver(.init(cache: cache))
    failed.enqueue(.renew, F.renewed(expiresAt: RA.t0 + RA.term, unsponsored: [RA.k2]))
    failed.enqueue(.sponsor, F.failure(.quotaExceeded))
    failed.feed(.pair(RA.target(RA.k2), ticket: 3, appId: RA.app))
    failed.settle()
    #expect(failed.prepared == [3: [.unavailable]] && failed.status == failed.problem(.serverQuota, after: RA.day))
    #expect(ready.violations.isEmpty && fresh.violations.isEmpty && failed.violations.isEmpty)
  }

  @Test("200 bez walidacji przychodzi jako failure(200): internal na 24 h; przy forget optedOut(pending)")
  func invalidOK() {
    let invalid = RelayAuthReply.failure(status: 200, code: nil, gate: nil)
    var renew = Driver(.init(cache: RA.stale()))
    renew.feed(.servers(list, appId: RA.app))
    renew.step(reply: invalid)
    #expect(renew.status == renew.problem(.internal, after: RA.day))

    var forget = Driver(.init(cache: RA.stale()))
    forget.feed(.forget(ticket: 1, appId: RA.app))
    forget.step(reply: invalid)
    #expect(forget.status == .optedOut(appId: RA.app, removal: .pending))
    #expect(forget.store.snapshot.optOut?.removal == .pending)

    // wynik innej trasy też nie przechodzi: internal
    var mismatch = Driver(.init(cache: RA.stale()))
    mismatch.feed(.servers(list, appId: RA.app))
    mismatch.step(reply: F.sponsored(server: RA.k, expiresAt: RA.t0 + RA.term))
    #expect(mismatch.status == mismatch.problem(.internal, after: RA.day))

    var wrongServer = Driver(.init(cache: RA.stale()))
    wrongServer.feed(.servers(list, appId: RA.app))
    wrongServer.step(reply: F.renewed(expiresAt: RA.t0 + RA.term, unsponsored: [RA.k]))
    wrongServer.step(reply: F.sponsored(server: RA.k2, expiresAt: RA.t0 + RA.term))
    #expect(wrongServer.status == wrongServer.problem(.internal, after: RA.day) && wrongServer.cache?.sponsored == [:])
    #expect(renew.violations.isEmpty && forget.violations.isEmpty && mismatch.violations.isEmpty)
  }

  @Test("T-parowanie z relayem spoza mapy albo bez tożsamości: bez żądań, skipped, generacja bez zmian")
  func pairOutsideMap() {
    var d = Driver(.init(cache: RA.stale(), optOut: RA.optOut(.pending)))
    let out = d.feed(.pair(RA.target(RA.k, RA.ownRelay), ticket: 5, appId: RA.app))
    #expect(out == [.prepareResult(ticket: 5, .skipped)] && d.machine.generation == 0)
    d.feed(.pair(RA.target(RA.k), ticket: 6, appId: nil))
    #expect(d.requests.isEmpty && d.prepared == [5: [.skipped], 6: [.skipped]] && d.machine.generation == 0)
    #expect(d.store.snapshot.optOut == RA.optOut(.pending))
    #expect(d.violations.isEmpty)
  }

  @Test("appId pamięci ≠ EndpointId podpisu: nowa pamięć i renew; rezygnacja z innym appId zostaje")
  func otherIdentity() {
    let foreign = RA.fresh(at: RA.t0 - RA.hour, sponsored: [RA.k], appId: RA.otherApp)
    var d = Driver(.init(cache: foreign))
    d.feed(.servers(list, appId: RA.app))
    #expect(d.routes == [.renew])
    #expect(d.cache == RelayAccessCache(appId: RA.app, registry: RA.registry))

    var opted = Driver(.init(cache: foreign, optOut: RA.optOut(.confirmed, appId: RA.otherApp)))
    opted.feed(.servers(list, appId: RA.app))
    #expect(opted.requests.isEmpty && opted.status == .optedOut(appId: RA.app, removal: .confirmed))
    #expect(opted.store.snapshot.optOut == RA.optOut(.confirmed, appId: RA.otherApp))
    #expect(d.violations.isEmpty && opted.violations.isEmpty)
  }

  @Test("jedna operacja naraz: wyzwalacze w trakcie łączą się w jedną następną synchronizację z ostatnią listą")
  func coalescing() {
    let expires = RA.t0 + RA.term
    var d = Driver(.init(cache: RA.stale(sponsored: [RA.k])))
    d.feed(.servers(list, appId: RA.app))
    for _ in 0..<10 { #expect(d.feed(.trigger(.foreground, appId: RA.app)).isEmpty) }
    #expect(d.feed(.servers(list2, appId: RA.app)).isEmpty)
    d.feed(.trigger(.tunnelFailed, appId: RA.app))
    d.enqueue(.renew, F.renewed(expiresAt: expires), F.renewed(expiresAt: expires, unsponsored: [RA.k2]))
    d.enqueue(.sponsor, F.sponsored(server: RA.k2, expiresAt: expires))
    d.settle()
    #expect(d.sends == [.renew(servers: [RA.k]), .renew(servers: [RA.k, RA.k2]), .sponsor(server: RA.k2)])
    #expect(d.status == d.registered(until: expires))
    #expect(d.violations.isEmpty)
  }

  @Test("T-parowanie i T-zapomnij przed czekającą synchronizacją; operacja ze starszą generacją nic nie wysyła")
  func preemption() {
    let expires = RA.t0 + RA.term
    var d = Driver(.init(cache: RA.stale()))
    d.feed(.servers(list, appId: RA.app))
    d.feed(.trigger(.foreground, appId: RA.app))
    d.feed(.pair(RA.target(RA.k2), ticket: 1, appId: RA.app))
    // stara synchronizacja dostaje wynik z unsponsored, ale nie wysyła sponsor ani nie zapisuje pamięci
    let saves = d.cacheSaves
    d.step(reply: F.renewed(expiresAt: expires, unsponsored: [RA.k]))
    #expect(d.cacheSaves == saves)
    #expect(d.outstanding == .send(.renew(servers: [RA.k2, RA.k]), registry: RA.registry, issuedAt: RA.t0,
                                   generation: 2))
    // drugie parowanie zastępuje pierwsze: wynik unavailable od razu
    d.feed(.pair(RA.target(RA.k3), ticket: 2, appId: RA.app))
    #expect(d.prepared == [1: [.unavailable]])
    d.feed(.forget(ticket: 3, appId: RA.app))
    #expect(d.prepared == [1: [.unavailable], 2: [.unavailable]])
    d.step(reply: F.renewed(expiresAt: expires))
    #expect(d.routes == [.renew, .renew, .forget])
    d.step(reply: F.forgotten())
    #expect(d.routes == [.renew, .renew, .forget] && d.outstanding == nil)
    #expect(d.forgot == [3: [.optedOut(appId: RA.app, removal: .confirmed)]])
    #expect(d.violations.isEmpty)
  }

  @Test("jedna synchronizacja: najwyżej renew, dwa register (nowy dowód po 422 albo po 404 sponsora), sponsor na serwer plus jego powtórka")
  func bounds() {
    let expires = RA.t0 + RA.term
    // Nowy dowód po 422, potem 404 przy sponsor: bez powtórki sponsora
    var a = Driver(.init(cache: RA.stale()))
    a.feed(.servers(list2, appId: RA.app))
    a.enqueue(.renew, F.failure(.notRegistered))
    a.enqueue(.register, F.failure(.proofRejected), F.registered(endpointId: RA.app, expiresAt: expires))
    a.enqueue(.sponsor, F.failure(.notRegistered), F.sponsored(server: RA.k2, expiresAt: expires))
    a.settle()
    #expect(a.routes == [.renew, .register, .register, .sponsor])
    #expect(a.proofs == 2 && a.status == a.problem(.internal, after: RA.day))

    // Powtórka sponsora po 404, potem 422 przy jej register: bez nowego dowodu
    var b = Driver(.init(cache: RA.stale()))
    b.feed(.servers(list2, appId: RA.app))
    b.enqueue(.renew, F.renewed(expiresAt: expires, unsponsored: [RA.k, RA.k2]))
    b.enqueue(.sponsor, F.failure(.notRegistered))
    b.enqueue(.register, F.failure(.proofRejected))
    b.settle()
    #expect(b.routes == [.renew, .sponsor, .register] && b.status == b.problem(.proofRejected, after: RA.hour))

    // Powtórka sponsora dla pierwszego serwera, potem 404 dla drugiego: internal bez trzeciego register
    var c = Driver(.init(cache: RA.stale()))
    c.feed(.servers(list2, appId: RA.app))
    c.enqueue(.renew, F.renewed(expiresAt: expires, unsponsored: [RA.k, RA.k2]))
    c.enqueue(.sponsor, F.failure(.notRegistered), F.sponsored(server: RA.k, expiresAt: expires),
              F.failure(.notRegistered))
    c.enqueue(.register, F.registered(endpointId: RA.app, expiresAt: expires))
    c.settle()
    #expect(c.routes == [.renew, .sponsor, .register, .sponsor, .sponsor])
    #expect(c.status == c.problem(.internal, after: RA.day))
    #expect(a.violations.isEmpty && b.violations.isEmpty && c.violations.isEmpty)
  }

  // MARK: - Pamięć i odpowiedzi

  @Test("zapis pamięci nieudany: praca w pamięci procesu z linią w logu; następny start bez okresu odnowienia")
  func cacheNotSaved() {
    var contents = FakeRelayAccessStore.Contents()
    contents.cacheSaveFails = true
    var d = Driver(contents)
    d.feed(.servers(list, appId: RA.app))
    d.enqueue(.renew, F.renewed(expiresAt: RA.t0 + RA.term))
    d.settle()
    #expect(d.status == d.registered(until: RA.t0 + RA.term) && d.store.snapshot.cache == nil)
    #expect(d.logs.contains { $0.contains("cache kept in memory") })
    d.clear()
    d.now += RA.hour
    d.feed(.trigger(.foreground, appId: RA.app))
    #expect(d.requests.isEmpty)

    d.restart()
    d.feed(.servers(list, appId: RA.app))
    d.feed(.trigger(.start, appId: RA.app))
    #expect(d.routes == [.renew])
    #expect(d.violations.isEmpty)
  }

  @Test("pamięć nieczytelna przy starcie: brak pamięci bez zapisu, synchronizacja, linia w logu")
  func cacheUnreadable() {
    var contents = FakeRelayAccessStore.Contents(cache: RA.fresh(at: RA.t0 - RA.hour, sponsored: [RA.k]))
    contents.cacheUnreadable = "relay-access: Keychain locked"
    var d = Driver(contents)
    d.feed(.servers(list, appId: RA.app))
    d.enqueue(.renew, F.renewed(expiresAt: RA.t0 + RA.term))
    d.settle()
    #expect(d.routes == [.renew] && d.status == d.registered(until: RA.t0 + RA.term))
    #expect(d.cacheSaves == 0 && d.store.snapshot.cacheUnreadable != nil)
    #expect(d.logs.contains { $0.contains("cache unreadable") })
    #expect(d.violations.isEmpty)
  }

  @Test("nieznane pola odpowiedzi pominięte")
  func unknownFields() throws {
    func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
      try RelayAuthWire.decode(type, from: Data(json.utf8))
    }
    let expires = RA.t0 + RA.term
    let renewed = try decode(RelayAuthWire.Renewed.self,
      #"{"v":1,"expiresAt":\#(expires),"unsponsored":["\#(RA.k)"],"note":"x","extra":{"a":[1,2]}}"#)
    let sponsored = try decode(RelayAuthWire.Sponsored.self,
      #"{"v":1,"server":"\#(RA.k)","expiresAt":\#(expires),"kind":"server","more":null}"#)
    let forgotten = try decode(RelayAuthWire.Forgotten.self, #"{"v":1,"forgotten":true,"at":1}"#)
    var d = Driver(.init(cache: RA.stale()))
    d.feed(.servers(list, appId: RA.app))
    d.step(reply: .renewed(renewed))
    d.step(reply: .sponsored(sponsored))
    #expect(d.status == d.registered(until: expires) && d.cache?.sponsored == [RA.k: expires])
    d.feed(.forget(ticket: 1, appId: RA.app))
    d.step(reply: .forgotten(forgotten))
    #expect(d.status == .optedOut(appId: RA.app, removal: .confirmed))
    #expect(d.violations.isEmpty)
  }
}

// MARK: - Sekwencje losowe

@Suite("maszyna klienta rejestru relaya iroh: sekwencje losowe")
struct RelayAccessMachineRandomTests {
  /// Odpowiedź atrapy rejestru na żądanie `fields` w chwili `now`.
  private static func reply(_ fields: RelayAuthWire.Fields, now: Int64, _ random: inout SplitMix64) -> RelayAuthReply {
    let expires = now + RA.term
    switch random.next() % 12 {
    case 0..<5:
      switch fields {
      case let .renew(servers):
        return F.renewed(expiresAt: expires, unsponsored: servers.filter { _ in random.next() % 2 == 0 })
      case .register: return F.registered(endpointId: RA.app, expiresAt: expires)
      case let .sponsor(server): return F.sponsored(server: server, expiresAt: expires)
      case .forget: return F.forgotten()
      }
    case 5: return .unreachable("network")
    case 6: return F.failure(.notRegistered)
    case 7: return F.failure(.proofRejected)
    case 8: return F.failure(.denied)
    case 9: return .failure(status: 200, code: nil, gate: nil)
    default:
      let codes = RelayAuthWire.ErrorCode.allCases
      return F.failure(codes[Int(random.next() % UInt64(codes.count))])
    }
  }

  private static func targets(_ random: inout SplitMix64) -> [TunnelTarget] {
    let all = [RA.target(RA.k), RA.target(RA.k2), RA.target(RA.k3, RA.ownRelay)]
    return all.filter { _ in random.next() % 2 == 0 }
  }

  @Test("2000 przebiegów, stałe ziarno: jedno polecenie w drodze, bez register przy rezygnacji i starej generacji, limit żądań synchronizacji")
  func randomSequences() {
    var random = SplitMix64(seed: 0x52_41_57_32_31_62)
    var failures: [String] = []
    for run in 0..<2000 where failures.count < 5 {
      var contents = FakeRelayAccessStore.Contents()
      switch random.next() % 4 {
      case 0: contents.cache = RA.fresh(at: RA.t0 - RA.hour, sponsored: [RA.k])
      case 1: contents.cache = RA.stale(sponsored: [RA.k2])
      case 2: contents.cache = RA.fresh(at: RA.t0 - RA.hour, sponsored: [RA.k], appId: RA.otherApp)
      default: break
      }
      switch random.next() % 5 {
      case 0: contents.optOut = RA.optOut(.pending)
      case 1: contents.optOut = RA.optOut(.confirmed)
      case 2: contents.optOutUnreadable = "relay-optout: not JSON v1"
      default: break
      }
      if random.next() % 10 == 0 { contents.cacheUnreadable = "relay-access: Keychain locked" }
      contents.cacheSaveFails = random.next() % 10 == 0
      contents.optOutSaveFails = random.next() % 7 == 0
      contents.optOutDeleteFails = random.next() % 7 == 0
      var d = Driver(contents, gateSupported: random.next() % 10 != 0)
      var ticket: M.Ticket = 0
      var tickets: (pair: Set<M.Ticket>, forget: Set<M.Ticket>) = ([], [])
      var minGeneration: M.Generation = 0
      var optedOutSincePair = false
      var counts: [M.Generation: [Route: Int]] = [:]
      var renewLists: [M.Generation: [String]] = [:]
      var proofs: [M.Generation: Int] = [:]

      func check(_ out: [C], _ d: Driver) -> [String] {
        var found: [String] = []
        for command in out {
          switch command {
          case let .send(fields, _, _, generation):
            if generation != d.machine.generation {
              found.append("send generacji \(generation) przy \(d.machine.generation)")
            }
            if generation < minGeneration {
              found.append("send generacji \(generation) po T-zapomnij \(minGeneration)")
            }
            counts[generation, default: [:]][fields.route, default: 0] += 1
            if case let .renew(servers) = fields { renewLists[generation] = servers }
            if case .register = fields {
              let snapshot = d.store.snapshot
              if snapshot.optOut != nil || snapshot.optOutUnreadable != nil || optedOutSincePair {
                found.append("register przy rezygnacji bez T-parowania")
              }
            }
            if case let .sponsor(server) = fields, !(renewLists[generation] ?? []).contains(server) {
              found.append("sponsor spoza listy renew")
            }
            let route = counts[generation]!
            let servers = renewLists[generation]?.count ?? 0
            if route[.renew, default: 0] > 1 || route[.register, default: 0] > 2 || route[.forget, default: 0] > 1
              || route[.sponsor, default: 0] > servers + 1 {
              found.append("ponad limit żądań synchronizacji w generacji \(generation): \(route)")
            }
          case let .proof(generation):
            proofs[generation, default: 0] += 1
            if proofs[generation]! > 2 { found.append("ponad dwa dowody w generacji \(generation)") }
          default:
            break
          }
        }
        return found
      }

      var trace: [String] = []
      for _ in 0..<40 {
        let roll = random.next() % 100
        var out: [C] = []
        let appId: String? = random.next() % 20 == 0 ? nil : RA.app
        switch roll {
        case 0..<35:
          guard let pending = d.outstanding else { continue }
          switch pending {
          case let .send(fields, _, _, _):
            let reply = Self.reply(fields, now: d.now, &random)
            trace.append("reply \(fields.route) \(reply)")
            let before = d.commands.count
            d.step(reply: reply)
            out = Array(d.commands[before...])
          default:
            let result: Result<RelayAuthWire.Proof, RelayGateFailure> =
              switch random.next() % 10 {
              case 0: .failure(.failed("DCError"))
              case 1: .failure(.unsupported)
              default: .success(RA.proof(Int(random.next() % 100)))
              }
            trace.append("proof \(result)")
            let before = d.commands.count
            d.step(proof: result)
            out = Array(d.commands[before...])
          }
        case 35..<50:
          let triggers: [RelayAccessTrigger] = [.start, .foreground, .identityAvailable, .tunnelFailed]
          let trigger = triggers[Int(random.next() % 4)]
          trace.append("trigger \(trigger)")
          out = d.feed(.trigger(trigger, appId: appId))
        case 50..<60:
          let targets = Self.targets(&random)
          trace.append("servers \(targets.map { $0.endpointId.prefix(2) })")
          out = d.feed(.servers(targets, appId: appId))
        case 60..<68:
          ticket += 1
          let all = [RA.target(RA.k), RA.target(RA.k2), RA.target(RA.k3), RA.target(RA.k, RA.ownRelay)]
          let target = all[Int(random.next() % 4)]
          trace.append("pair \(ticket) \(target.endpointId.prefix(2))")
          if target.relay == RA.relay, appId != nil { optedOutSincePair = false }
          tickets.pair.insert(ticket)
          out = d.feed(.pair(target, ticket: ticket, appId: appId))
        case 68..<73:
          ticket += 1
          trace.append("forget \(ticket)")
          tickets.forget.insert(ticket)
          let saves = d.store.snapshot.optOutSaves
          out = d.feed(.forget(ticket: ticket, appId: appId))
          if appId != nil { minGeneration = d.machine.generation }
          if d.store.snapshot.optOutSaves > saves, d.store.snapshot.optOut?.removal == .pending {
            optedOutSincePair = true
          }
        case 73..<75:
          trace.append("restart")
          d.restart()
          minGeneration = 0
          counts = [:]
          renewLists = [:]
          proofs = [:]
          tickets = ([], [])
        default:
          d.now += Int64(random.next() % 8) * RA.hour + Int64(random.next() % 600)
          trace.append("now +")
        }
        // rezygnacja zapisana przez zastąpioną operację T-zapomnij też wstrzymuje register
        for case let .saveOptOut(record, _) in out
        where record.removal == .pending && d.store.snapshot.optOut == record {
          optedOutSincePair = true
        }
        let found = check(out, d)
        if !found.isEmpty || !d.violations.isEmpty {
          failures.append("przebieg \(run): \(found + d.violations)\n  \(trace.suffix(12).joined(separator: "\n  "))")
          break
        }
      }
      guard failures.isEmpty else { break }
      // dokończenie: każde polecenie w drodze dostaje odpowiedź, każdy bilet dokładnie jeden wynik
      d.settle()
      for pair in tickets.pair where d.prepared[pair]?.count != 1 {
        failures.append("przebieg \(run): bilet parowania \(pair) ma wyniki \(d.prepared[pair] ?? [])")
      }
      for forget in tickets.forget where d.forgot[forget]?.count != 1 {
        failures.append("przebieg \(run): bilet forget \(forget) ma wyniki \(d.forgot[forget] ?? [])")
      }
      if !d.violations.isEmpty { failures.append("przebieg \(run): \(d.violations)") }
    }
    #expect(failures.isEmpty, "\(failures.joined(separator: "\n"))")
  }
}
