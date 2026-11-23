import Foundation
@testable import RarogTransport
import Synchronization
import Testing

// Dzierżawa endpointu iroh: testy każdego przejścia na atrapie
// transportu z bramkami (`bind` i `close`, które wiszą do otwarcia) i na zegarze ręcznym. Atrapa liczy `bind`
// rozpoczęte i zakończone na klucz oraz endpointy żywe i szczytowe, więc testy sprawdzają stan ustalony, nie zero.

// MARK: - Zegar ręczny

final class ManualClock: Clock, Sendable {
  struct Instant: InstantProtocol {
    var offset: Duration
    func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
    func duration(to other: Instant) -> Duration { other.offset - offset }
    static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
  }

  private struct Sleeper {
    let deadline: Instant
    let continuation: CheckedContinuation<Void, any Error>
  }

  private struct State {
    var now = Instant(offset: .zero)
    var sleepers: [Int: Sleeper] = [:]
    var next = 0
  }

  private let state = Mutex(State())

  var now: Instant { state.withLock { $0.now } }
  var minimumResolution: Duration { .zero }
  var sleeperCount: Int { state.withLock { $0.sleepers.count } }

  func sleep(until deadline: Instant, tolerance: Duration?) async throws {
    let id = state.withLock { state in
      defer { state.next += 1 }
      return state.next
    }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        let immediate: Result<Void, any Error>? = state.withLock { state in
          if Task.isCancelled { return .failure(CancellationError()) }
          if deadline <= state.now { return .success(()) }
          state.sleepers[id] = Sleeper(deadline: deadline, continuation: continuation)
          return nil
        }
        if let immediate { continuation.resume(with: immediate) }
      }
    } onCancel: {
      let sleeper = state.withLock { $0.sleepers.removeValue(forKey: id) }
      sleeper?.continuation.resume(throwing: CancellationError())
    }
  }

  func advance(by duration: Duration) {
    let due: [Sleeper] = state.withLock { state in
      state.now = state.now.advanced(by: duration)
      let now = state.now
      let ids = state.sleepers.filter { $0.value.deadline <= now }.map(\.key)
      return ids.compactMap { state.sleepers.removeValue(forKey: $0) }
    }
    for sleeper in due { sleeper.continuation.resume() }
  }
}

// MARK: - Atrapa transportu

/// Bramka: operacja czeka do `open()`.
final class Gate: Sendable {
  private let state = Mutex<(open: Bool, waiters: [CheckedContinuation<Void, Never>])>((false, []))

  func wait() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let open = state.withLock { state in
        if state.open { return true }
        state.waiters.append(continuation)
        return false
      }
      if open { continuation.resume() }
    }
  }

  func open() {
    let waiters = state.withLock { state in
      state.open = true
      defer { state.waiters = [] }
      return state.waiters
    }
    for waiter in waiters { waiter.resume() }
  }
}

final class LeaseFakeTransport: TunnelTransport, Sendable {
  enum BindStep: Sendable { case immediate, gated(Gate), fail(TunnelFailure) }
  enum CloseStep: Sendable { case immediate, gated(Gate) }

  struct Counters: Sendable {
    var bindStarted = 0
    var bindReturned = 0
    var bindsInFlightPerKey: [Data: Int] = [:]
    var peakBindsPerKey = 0
    var alive = 0
    var peakAlive = 0
    var closeCalls = 0
    var keys: [Data] = []
    var relays: [URL] = []
  }

  private struct State {
    var binds: [BindStep] = []
    var closes: [CloseStep] = []
    var counters = Counters()
    var nextEndpoint = 0
  }

  private let state = Mutex(State())
  let order: Recorder<String>

  init(order: Recorder<String> = Recorder()) { self.order = order }

  var counters: Counters { state.withLock { $0.counters } }

  func planBinds(_ steps: BindStep...) { state.withLock { $0.binds += steps } }
  func planCloses(_ steps: CloseStep...) { state.withLock { $0.closes += steps } }

  func bind(secretKey: Data, homeRelay: URL) async throws -> any TunnelEndpoint {
    let step: BindStep = state.withLock { state in
      state.counters.bindStarted += 1
      state.counters.keys.append(secretKey)
      state.counters.relays.append(homeRelay)
      state.counters.bindsInFlightPerKey[secretKey, default: 0] += 1
      state.counters.peakBindsPerKey = max(state.counters.peakBindsPerKey,
                                           state.counters.bindsInFlightPerKey[secretKey] ?? 0)
      return state.binds.isEmpty ? .immediate : state.binds.removeFirst()
    }
    switch step {
    case .immediate:
      await Task.yield()
    case .gated(let gate):
      await gate.wait()
    case .fail(let failure):
      state.withLock { state in
        state.counters.bindReturned += 1
        state.counters.bindsInFlightPerKey[secretKey, default: 1] -= 1
      }
      throw failure
    }
    let id: Int = state.withLock { state in
      state.counters.bindReturned += 1
      state.counters.bindsInFlightPerKey[secretKey, default: 1] -= 1
      state.counters.alive += 1
      state.counters.peakAlive = max(state.counters.peakAlive, state.counters.alive)
      state.nextEndpoint += 1
      return state.nextEndpoint
    }
    return LeaseFakeEndpoint(number: id, transport: self)
  }

  fileprivate func closing(_ number: Int) -> CloseStep {
    order.append("close e\(number)")
    return state.withLock { state in
      state.counters.closeCalls += 1
      return state.closes.isEmpty ? .immediate : state.closes.removeFirst()
    }
  }

  fileprivate func closed() {
    state.withLock { $0.counters.alive -= 1 }
  }
}

final class LeaseFakeEndpoint: TunnelEndpoint, Sendable {
  let number: Int
  let transport: LeaseFakeTransport
  var endpointId: String { String(format: "%064x", number) }

  init(number: Int, transport: LeaseFakeTransport) {
    self.number = number
    self.transport = transport
  }

  func connect(to target: TunnelTarget, alpn: Data) async throws -> any TunnelConnection {
    throw TunnelFailure.connectFailed("atrapa")
  }

  func ensureRelay(_ relay: URL) async throws {}

  func close() async {
    if case .gated(let gate) = transport.closing(number) { await gate.wait() }
    transport.closed()
  }
}

final class Recorder<Value: Sendable>: Sendable {
  private let values = Mutex<[Value]>([])
  func append(_ value: Value) { values.withLock { $0.append(value) } }
  var all: [Value] { values.withLock { $0 } }
}

// MARK: - Pomocnicze

private let key = Data(repeating: 7, count: 32)
private let relay = URL(string: "https://relay.example/")!
private let u1 = LeaseUser(1)
private let u2 = LeaseUser(2)

private struct Harness {
  let transport: LeaseFakeTransport
  let clock = ManualClock()
  let readiness = Recorder<LeaseReadiness>()
  let logs = Recorder<String>()
  let lease: EndpointLease

  init(ceiling: Int = EndpointLease.nativeOperationCeiling, identity: LeaseIdentity? = LeaseIdentity(secretKey: key,
                                                                                                      homeRelay: relay)) {
    let order = Recorder<String>()
    let transport = LeaseFakeTransport(order: order)
    self.transport = transport
    let readiness = self.readiness
    let logs = self.logs
    lease = EndpointLease(transport: transport, identity: { identity }, clock: clock,
                          closeUsers: { users in order.append("users \(users.map(\.description).sorted())") },
                          onReadiness: { readiness.append($0) }, log: { logs.append($0) }, nativeCeiling: ceiling)
  }

  var order: [String] { transport.order.all }

  /// Zadanie `acquire` w tle: wynik endpoint albo porażka.
  func acquireTask(_ user: LeaseUser, budget: Duration = .seconds(15))
    -> Task<Result<any TunnelEndpoint, TunnelFailure>, Never> {
    let lease = self.lease
    return Task {
      do {
        return .success(try await lease.acquire(user, budget: budget))
      } catch let failure as TunnelFailure {
        return .failure(failure)
      } catch {
        return .failure(.unavailable("\(error)"))
      }
    }
  }

  func phase() async -> String { await lease.phaseName }
}

/// Czeka (czas rzeczywisty, do 5 s), aż warunek się spełni.
private func eventually(_ what: String = "", _ condition: @Sendable () async -> Bool) async {
  for _ in 0..<5000 {
    if await condition() { return }
    try? await Task.sleep(for: .milliseconds(1))
  }
  Issue.record("warunek nie spełnił się w 5 s: \(what)")
}

private func number(_ result: Result<any TunnelEndpoint, TunnelFailure>) -> Int? {
  guard case .success(let endpoint) = result else { return nil }
  return (endpoint as? LeaseFakeEndpoint)?.number
}

@Suite("dzierżawa endpointu iroh: przejścia")
struct EndpointLeaseTests {
  @Test("gotowość: ready przy zimnym starcie i po bind, rebinding w binding i closing, unavailable po progu")
  func readiness() async {
    let harness = Harness()
    let gate = Gate()
    harness.transport.planBinds(.gated(gate))
    #expect(await harness.lease.readiness == .ready)
    let task = harness.acquireTask(u1)
    await eventually("binding") { await harness.phase() == "binding" }
    #expect(await harness.lease.readiness == .rebinding)
    gate.open()
    _ = await task.value
    #expect(await harness.lease.readiness == .ready)

    let closeGate = Gate()
    harness.transport.planCloses(.gated(closeGate))
    await harness.lease.rebind(.policy)
    #expect(await harness.lease.readiness == .rebinding)
    await eventually("zegar progu close") { harness.clock.sleeperCount >= 1 }
    harness.clock.advance(by: .seconds(8))
    await eventually("unavailable po 8 s") { await harness.lease.readiness == .unavailable }
    closeGate.open()
    await eventually("ready po close") { await harness.lease.readiness == .ready }
    #expect(harness.readiness.all == [.rebinding, .ready, .rebinding, .unavailable, .ready])

    let missing = Harness(identity: nil)
    let failed = await missing.acquireTask(u1).value
    #expect(failed == .failure(.unavailable("iroh identity unavailable")))
    #expect(await missing.lease.readiness == .unavailable)
    #expect(missing.transport.counters.bindStarted == 0)
  }

  @Test("pierwszy acquire: jedno bind z kluczem i relayem domowym")
  func firstAcquireBinds() async {
    let harness = Harness()
    let result = await harness.acquireTask(u1).value
    #expect(number(result) == 1)
    #expect(harness.transport.counters.bindStarted == 1)
    #expect(Array(harness.transport.counters.keys) == [key])
    #expect(harness.transport.counters.relays == [relay])
  }

  @Test("acquire w binding czeka na tę samą próbę")
  func secondAcquireWaits() async {
    let harness = Harness()
    let gate = Gate()
    harness.transport.planBinds(.gated(gate))
    let first = harness.acquireTask(u1)
    await eventually("binding") { await harness.phase() == "binding" }
    let second = harness.acquireTask(u2)
    await eventually("drugi czeka") { harness.clock.sleeperCount >= 3 }
    #expect(harness.transport.counters.bindStarted == 1)
    gate.open()
    #expect(number(await first.value) == 1)
    #expect(number(await second.value) == 1)
  }

  @Test("wynik w budżecie: bound, czekający dostają endpoint, użytkownicy policzeni")
  func resultInBudget() async {
    let harness = Harness()
    let gate = Gate()
    harness.transport.planBinds(.gated(gate))
    let first = harness.acquireTask(u1)
    let second = harness.acquireTask(u2)
    await eventually("dwóch czeka") { harness.clock.sleeperCount >= 3 }
    gate.open()
    #expect(number(await first.value) == 1)
    #expect(number(await second.value) == 1)
    #expect(await harness.phase() == "bound")
    #expect(await harness.lease.userCount == 2)
  }

  @Test("budżet minął w binding: czekający dostaje timedOut, próba trwa, gotowość nie ready")
  func budgetElapsed() async {
    let harness = Harness()
    let gate = Gate()
    harness.transport.planBinds(.gated(gate))
    let task = harness.acquireTask(u1, budget: .seconds(5))
    await eventually("budżet i próg") { harness.clock.sleeperCount >= 2 }
    harness.clock.advance(by: .seconds(5))
    #expect(await task.value == .failure(.timedOut))
    #expect(await harness.phase() == "binding")
    #expect(await harness.lease.readiness == .rebinding)
    #expect(await harness.lease.userCount == 0)
    gate.open()
  }

  @Test("spóźniony endpoint idzie do close, a dopiero następny acquire wiąże od nowa")
  func lateEndpoint() async {
    let harness = Harness()
    let gate = Gate()
    harness.transport.planBinds(.gated(gate))
    let task = harness.acquireTask(u1, budget: .seconds(5))
    await eventually("budżet") { harness.clock.sleeperCount >= 2 }
    harness.clock.advance(by: .seconds(5))
    _ = await task.value
    gate.open()
    await eventually("unbound po close spóźnionego") { await harness.phase() == "unbound" }
    #expect(harness.transport.counters.closeCalls == 1)
    #expect(harness.transport.counters.alive == 0)
    #expect(harness.transport.counters.bindStarted == 1)
    #expect(number(await harness.acquireTask(u2).value) == 2)
    #expect(harness.transport.counters.bindStarted == 2)
  }

  @Test("bindFailed: unbound, czekający dostają porażkę")
  func bindFailed() async {
    let harness = Harness()
    harness.transport.planBinds(.fail(.bindFailed("x")))
    #expect(await harness.acquireTask(u1).value == .failure(.bindFailed("x")))
    #expect(await harness.phase() == "unbound")
    #expect(await harness.lease.readiness == .ready)
  }

  @Test("release w bound: endpoint żyje przy zerze użytkowników")
  func releaseKeepsEndpoint() async {
    let harness = Harness()
    _ = await harness.acquireTask(u1).value
    await harness.lease.release(u1)
    #expect(await harness.phase() == "bound")
    #expect(await harness.lease.userCount == 0)
    #expect(harness.transport.counters.closeCalls == 0)
    #expect(number(await harness.acquireTask(u2).value) == 1)
  }

  @Test("trzy kolejne porażki iroh: closing(broken); sukces zeruje licznik")
  func brokenAfterThreeFailures() async {
    let harness = Harness()
    _ = await harness.acquireTask(u1).value
    for success in [false, false, true, false, false] { await harness.lease.reportIroh(success: success) }
    #expect(await harness.phase() == "bound")
    #expect(harness.transport.counters.closeCalls == 0)
    await harness.lease.reportIroh(success: false)
    await eventually("close po trzeciej porażce") { harness.transport.counters.closeCalls == 1 }
    #expect(harness.logs.all.contains { $0.contains("broken") })
  }

  @Test("rebind w bound: najpierw połączenia użytkowników, potem close")
  func rebindOrder() async {
    let harness = Harness()
    _ = await harness.acquireTask(u1).value
    _ = await harness.acquireTask(u2).value
    await harness.lease.rebind(.policy)
    await eventually("close") { harness.transport.counters.closeCalls == 1 }
    #expect(harness.order == ["users [\"u1\", \"u2\"]", "close e1"])
  }

  @Test("close wrócił: unbound i leaseChanged(ready)")
  func closeReturned() async {
    let harness = Harness()
    _ = await harness.acquireTask(u1).value
    await harness.lease.rebind(.keyChanged)
    await eventually("unbound") { await harness.phase() == "unbound" }
    #expect(harness.readiness.all.last == .ready)
    #expect(harness.transport.counters.alive == 0)
  }

  @Test("close nie wraca: closing na stałe, log po 8 s i co 60 s, bez nowego bind")
  func closeHangs() async {
    let harness = Harness()
    _ = await harness.acquireTask(u1).value
    let gate = Gate()
    harness.transport.planCloses(.gated(gate))
    await harness.lease.rebind(.policy)
    await eventually("próg close") { harness.clock.sleeperCount >= 1 }
    harness.clock.advance(by: .seconds(8))
    await eventually("log po 8 s") { harness.logs.all.contains { $0.contains("close has not returned") } }
    await eventually("zegar 60 s") { harness.clock.sleeperCount >= 1 }
    harness.clock.advance(by: .seconds(60))
    await eventually("log po 60 s") { harness.logs.all.contains { $0.contains("close still has not returned") } }
    let waiting = harness.acquireTask(u2, budget: .seconds(15))
    await eventually("czeka w budżecie") { harness.clock.sleeperCount >= 2 }
    harness.clock.advance(by: .seconds(15))
    #expect(await waiting.value == .failure(.timedOut))
    #expect(await harness.phase() == "closing")
    #expect(harness.transport.counters.bindStarted == 1)
    gate.open()
  }

  @Test("bind nie wraca: po 15 s iroh niedostępne, log po 15 s i co 60 s")
  func bindHangs() async {
    let harness = Harness()
    let gate = Gate()
    harness.transport.planBinds(.gated(gate))
    let task = harness.acquireTask(u1, budget: .seconds(15))
    await eventually("budżet i próg") { harness.clock.sleeperCount >= 2 }
    harness.clock.advance(by: .seconds(15))
    #expect(await task.value == .failure(.timedOut))
    await eventually("unavailable") { await harness.lease.readiness == .unavailable }
    #expect(harness.logs.all.contains { $0.contains("bind has not returned") })
    #expect(await harness.acquireTask(u2).value == .failure(.unavailable("bind did not return")))
    await eventually("zegar 60 s") { harness.clock.sleeperCount >= 1 }
    harness.clock.advance(by: .seconds(60))
    await eventually("log po 60 s") { harness.logs.all.contains { $0.contains("bind still has not returned") } }
    #expect(harness.transport.counters.bindStarted == 1)
    gate.open()
  }

  @Test("sufit niezakończonych operacji natywnych: acquire dostaje unavailable")
  func nativeCeiling() async {
    #expect(EndpointLease.nativeOperationCeiling == 2)
    let harness = Harness(ceiling: 1)
    let gate = Gate()
    harness.transport.planBinds(.gated(gate))
    let first = harness.acquireTask(u1)
    await eventually("binding") { await harness.phase() == "binding" }
    #expect(await harness.acquireTask(u2).value == .failure(.unavailable("native operation ceiling")))
    #expect(await harness.lease.readiness == .unavailable)
    #expect(harness.logs.all.contains { $0.contains("unfinished native operations") })
    gate.open()
    #expect(number(await first.value) == 1)
  }

  @Test("release poprzedniej tożsamości w trakcie nowej generacji nie zamyka endpointu nowej")
  func releaseOfPreviousUser() async {
    let harness = Harness()
    _ = await harness.acquireTask(u1).value
    let next = harness.acquireTask(u2)
    await harness.lease.release(u1)
    #expect(number(await next.value) == 1)
    #expect(harness.transport.counters.closeCalls == 0)
    #expect(harness.transport.counters.alive == 1)
    #expect(await harness.lease.userCount == 1)
  }

  @Test("acquire w closing po rebind czeka na close i jedno nowe bind; wiszące close kończy timedOut")
  func acquireDuringRebind() async {
    let harness = Harness()
    _ = await harness.acquireTask(u1).value
    let gate = Gate()
    harness.transport.planCloses(.gated(gate))
    await harness.lease.rebind(.policy)
    let waiting = harness.acquireTask(u2, budget: .seconds(15))
    await eventually("czeka") { harness.clock.sleeperCount >= 2 }
    #expect(harness.transport.counters.bindStarted == 1)
    gate.open()
    #expect(number(await waiting.value) == 2)
    #expect(harness.transport.counters.bindStarted == 2)
    #expect(harness.transport.counters.peakAlive == 1)
  }

  @Test("rebind w trakcie binding: czekający dostaje endpoint z nowego bind, stary idzie do close")
  func rebindWhileBinding() async {
    let harness = Harness()
    let gate = Gate()
    harness.transport.planBinds(.gated(gate))
    let waiting = harness.acquireTask(u1)
    await eventually("binding") { await harness.phase() == "binding" }
    await harness.lease.rebind(.policy)
    #expect(await harness.lease.readiness == .rebinding)
    gate.open()
    #expect(number(await waiting.value) == 2)
    #expect(harness.transport.counters.bindStarted == 2)
    #expect(harness.order == ["close e1"])
    #expect(harness.transport.counters.peakAlive == 1)
  }

  @Test("współbieżne acquire, release i rebind: najwyżej jedno bind na klucz i jeden endpoint żywy")
  func concurrency() async {
    let harness = Harness()
    let lease = harness.lease
    await withTaskGroup(of: Void.self) { group in
      for index in 0..<200 {
        group.addTask {
          let user = LeaseUser(UInt64(index))
          switch index % 4 {
          case 0, 1:
            _ = try? await lease.acquire(user, budget: .seconds(15))
            await lease.release(user)
          case 2:
            await lease.rebind(index % 8 == 2 ? .policy : .keyChanged)
          default:
            await lease.reportIroh(success: Bool.random())
          }
        }
      }
    }
    await lease.shutdown()
    let counters = harness.transport.counters
    #expect(counters.peakBindsPerKey <= 1)
    #expect(counters.peakAlive <= 1)
    #expect(counters.alive == 0)
    #expect(counters.bindStarted == counters.bindReturned)
  }

  @Test("shutdown z każdego stanu: endpoint zamknięty, spóźniony odrzucony, liczniki zero, acquire unavailable")
  func shutdown() async {
    // unbound
    let unbound = Harness()
    await unbound.lease.shutdown()
    #expect(await unbound.acquireTask(u1).value == .failure(.unavailable("endpoint lease shut down")))
    #expect(await unbound.lease.readiness == .unavailable)

    // bound
    let bound = Harness()
    _ = await bound.acquireTask(u1).value
    await bound.lease.shutdown()
    #expect(bound.transport.counters.alive == 0)
    #expect(await bound.lease.userCount == 0)

    // binding: spóźniony endpoint zamknięty, czekający dostaje unavailable
    let binding = Harness()
    let gate = Gate()
    binding.transport.planBinds(.gated(gate))
    let waiting = binding.acquireTask(u1)
    await eventually("binding") { await binding.phase() == "binding" }
    let shutdown = Task { await binding.lease.shutdown() }
    #expect(await waiting.value == .failure(.unavailable("endpoint lease shut down")))
    gate.open()
    await shutdown.value
    #expect(binding.transport.counters.alive == 0)
    #expect(binding.transport.counters.bindStarted == binding.transport.counters.bindReturned)

    // closing
    let closing = Harness()
    _ = await closing.acquireTask(u1).value
    let closeGate = Gate()
    closing.transport.planCloses(.gated(closeGate))
    await closing.lease.rebind(.policy)
    let closingShutdown = Task { await closing.lease.shutdown() }
    await eventually("shutDown") { await closing.phase() == "shutDown" }
    closeGate.open()
    await closingShutdown.value
    #expect(closing.transport.counters.alive == 0)
    #expect(await closing.lease.unfinishedNativeOperations == 0)
    #expect(await closing.acquireTask(u2).value == .failure(.unavailable("endpoint lease shut down")))
  }

  @Test("pięć nieudanych prób generacji zwalnia swoich użytkowników w discard")
  func failedAttemptsReleaseUsers() async {
    let harness = Harness()
    let baseline = LeaseUser(100)
    _ = await harness.acquireTask(baseline).value
    let before = await harness.lease.userCount
    var machine = TunnelMachine.foreground(MachineFixture.irohOnly)
    var now = 0.0
    for round in 1...5 {
      _ = machine.send(.networkChanged, at: now)
      var commands = machine.send(.demand(MachineFixture.waiter(UInt64(round))), at: now)
      commands += machine.send(.opened(generation: UInt64(round)), at: now)
      commands += machine.send(.probeFinished(generation: UInt64(round), .transport), at: now + 1)
      for command in commands {
        switch command {
        case .open(let gen, .iroh, let budget): _ = try? await harness.lease.acquire(LeaseUser(gen), budget: budget)
        case .discard(let gen): await harness.lease.release(LeaseUser(gen))
        case .reportIroh(let success): await harness.lease.reportIroh(success: success)
        default: break
        }
      }
      _ = machine.send(.closed(generation: UInt64(round)), at: now + 2)
      _ = machine.send(.tick, at: now + 3)
      now += 10
    }
    await eventually("stan ustalony") { await harness.lease.unfinishedNativeOperations == 0 }
    #expect(await harness.lease.userCount == before)
    #expect(harness.transport.counters.closeCalls == 1)
    #expect(harness.transport.counters.peakAlive <= 1)
  }

  @Test("budżety bind i powroty z tła co ponad 2 min z zepsutym endpointem: trzecia porażka daje rebind(broken)")
  func repeatedBudgetsAndReturnsLeadToBroken() async {
    let harness = Harness()
    let gate = Gate()
    harness.transport.planBinds(.gated(gate))
    var machine = TunnelMachine(routes: MachineFixture.both)
    var now = 0.0
    var brokenAt: Int?
    for cycle in 1...3 {
      _ = machine.send(.scene(.active), at: now)
      let opening = machine.send(.demand(MachineFixture.waiter(UInt64(cycle))), at: now)
      guard case .open(let gen, .iroh, let budget) = opening.first else {
        Issue.record("cykl \(cycle): oczekiwano open(iroh), jest \(opening)")
        return
      }
      let acquire = harness.acquireTask(LeaseUser(gen), budget: budget)
      var result: [TunnelMachine.Command]
      if cycle == 1 {
        // Pierwszy cykl: bind nie mieści się w budżecie próby.
        await eventually("budżet") { harness.clock.sleeperCount >= 2 }
        harness.clock.advance(by: budget)
        #expect(await acquire.value == .failure(.timedOut))
        result = machine.send(.openFailed(generation: gen, .timedOut), at: now + 15)
        gate.open()
        await eventually("spóźniony zamknięty") { await harness.phase() == "unbound" }
      } else {
        #expect(number(await acquire.value) != nil)
        result = machine.send(.opened(generation: gen), at: now + 1)
        result += machine.send(.probeFinished(generation: gen, .transport), at: now + 2)
      }
      for command in result {
        switch command {
        case .discard(let gen): await harness.lease.release(LeaseUser(gen))
        case .reportIroh(let success): await harness.lease.reportIroh(success: success)
        default: break
        }
      }
      if brokenAt == nil, harness.logs.all.contains(where: { $0.contains("broken") }) { brokenAt = cycle }
      _ = machine.send(.closed(generation: gen), at: now + 16)
      _ = machine.send(.tick, at: now + 17)
      _ = machine.send(.scene(.background), at: now + 18)
      now += 150  // powrót z tła po ponad 2 min od porażki: pamięć porażki iroh wygasła
    }
    #expect(brokenAt == 3)
    await eventually("endpoint zepsuty zamknięty") { harness.transport.counters.alive == 0 }
    #expect(harness.transport.counters.peakAlive <= 1)
  }
}

extension Result where Success == any TunnelEndpoint, Failure == TunnelFailure {
  static func == (lhs: Self, rhs: Self) -> Bool {
    switch (lhs, rhs) {
    case (.failure(let left), .failure(let right)): left == right
    case (.success(let left), .success(let right)): left === right
    default: false
    }
  }
}
