import Foundation
import Synchronization

// Dzierżawa endpointu iroh apki: jeden endpoint na klucz, dzielony przez generacje tunelu. Lease liczy
// użytkowników, ale endpointu przy zerze nie zamyka; zamyka go `rebind` (polityka powrotu z tła, zmiana klucza,
// endpoint zepsuty po kolejnych porażkach) albo `shutdown()`. Operacje natywne (`bind`, `close`) idą po jednej:
// nowy `bind` rusza dopiero po powrocie poprzedniego `close`, a spóźniony endpoint zostaje zamknięty. Zegar jest
// wstrzyknięty (budżety, progi wiszących operacji). Przejścia mają testy
// w `EndpointLeaseTests`.

/// Użytkownik endpointu: zwykle jedna generacja tunelu albo jedne drzwi uploadu.
public struct LeaseUser: Hashable, Sendable, CustomStringConvertible {
  public let raw: UInt64
  public init(_ raw: UInt64) { self.raw = raw }
  public var description: String { "u\(raw)" }
}

/// Powód ponownego wiązania endpointu.
public enum RebindReason: Sendable, Equatable, CustomStringConvertible {
  /// Polityka powrotu z tła albo zmiany sieci.
  case policy
  /// Nowy klucz tożsamości iroh.
  case keyChanged
  /// Kolejne porażki iroh na tym endpoincie.
  case broken

  public var description: String {
    switch self {
    case .policy: "policy"
    case .keyChanged: "keyChanged"
    case .broken: "broken"
    }
  }
}

/// Gotowość lease widziana przez maszyny generacji.
public enum LeaseReadiness: Sendable, Equatable, CustomStringConvertible {
  /// Endpoint związany albo gotowy do związania.
  case ready
  /// `bind` albo `close` w toku, w granicach progu.
  case rebinding
  /// Wisząca operacja natywna po progu, sufit operacji, brak tożsamości albo lease zamknięty.
  case unavailable

  public var description: String {
    switch self {
    case .ready: "ready"
    case .rebinding: "rebinding"
    case .unavailable: "unavailable"
    }
  }
}

/// Klucz tajny endpointu i relay domowy.
public struct LeaseIdentity: Sendable, Equatable {
  public let secretKey: Data
  public let homeRelay: URL
  public init(secretKey: Data, homeRelay: URL) {
    self.secretKey = secretKey
    self.homeRelay = homeRelay
  }
}

/// Dzierżawa endpointu iroh: jedno `bind` naraz, co najwyżej jeden endpoint żywy.
public actor EndpointLease {
  /// `bind` dłuższy niż próg: iroh niedostępne, dopóki nie wróci.
  public static let bindHangThreshold: Duration = .seconds(15)
  /// `close` dłuższy niż próg: lease w zamykaniu bez nowego `bind`, dopóki nie wróci.
  public static let closeHangThreshold: Duration = .seconds(8)
  /// Co ile powtarza się linia logu o wiszącej operacji natywnej.
  public static let hangLogInterval: Duration = .seconds(60)
  /// Tyle kolejnych porażek iroh oznacza endpoint zepsuty.
  public static let brokenAfterFailures = 3
  /// Sufit niezakończonych operacji natywnych.
  public static let nativeOperationCeiling = 2

  private enum Phase {
    case unbound
    case binding
    case bound(any TunnelEndpoint)
    case closing
    case shutDown
  }

  private struct Waiter {
    let user: LeaseUser
    let promise: EndpointPromise
    var timer: Task<Void, Never>?
  }

  private let transport: any TunnelTransport
  private let identity: @Sendable () async -> LeaseIdentity?
  private let clock: any Clock<Duration>
  private let closeUsers: @Sendable ([LeaseUser]) async -> Void
  private let onReadiness: @Sendable (LeaseReadiness) -> Void
  private let onIrohFailure: @Sendable () -> Void
  private let log: @Sendable (String) -> Void
  private let nativeCeiling: Int

  private var phase: Phase = .unbound
  private var users: Set<LeaseUser> = []
  private var waiters: [UInt64: Waiter] = [:]
  private var nextWaiter: UInt64 = 0
  private var failures = 0
  private var inFlight = 0
  private var nextOperation: UInt64 = 0
  private var activeOperation: UInt64?
  private var bindHung = false
  private var closeHung = false
  /// Wynik bieżącego `bind` nie trafi do użytkowników (rebind w trakcie wiązania): po powrocie idzie do `close`.
  private var abandonBind = false
  private var identityMissing = false
  private var published: LeaseReadiness = .ready
  private var hangWatch: Task<Void, Never>?
  private var drainWaiters: [CheckedContinuation<Void, Never>] = []

  /// - Parameters:
  ///   - identity: klucz i relay domowy, czytane przy każdym `bind`; `nil` = tożsamość niedostępna.
  ///   - clock: zegar budżetów i progów.
  ///   - closeUsers: zamyka połączenia użytkowników przed `close()` endpointu przy `rebind`.
  ///   - onReadiness: każda zmiana gotowości (i stan po `rebind`) do maszyn jako `leaseChanged`.
  ///   - onIrohFailure: an observer of every failed iroh attempt reported through `reportIroh(success: false)`; the
  ///     app hands it on as a trigger without waiting. The lease does not know who listens.
  public init(transport: any TunnelTransport,
              identity: @escaping @Sendable () async -> LeaseIdentity?,
              clock: any Clock<Duration>,
              closeUsers: @escaping @Sendable ([LeaseUser]) async -> Void = { _ in },
              onReadiness: @escaping @Sendable (LeaseReadiness) -> Void = { _ in },
              onIrohFailure: @escaping @Sendable () -> Void = {},
              log: @escaping @Sendable (String) -> Void = { _ in }) {
    self.init(transport: transport, identity: identity, clock: clock, closeUsers: closeUsers,
              onReadiness: onReadiness, onIrohFailure: onIrohFailure, log: log,
              nativeCeiling: Self.nativeOperationCeiling)
  }

  init(transport: any TunnelTransport,
       identity: @escaping @Sendable () async -> LeaseIdentity?,
       clock: any Clock<Duration>,
       closeUsers: @escaping @Sendable ([LeaseUser]) async -> Void,
       onReadiness: @escaping @Sendable (LeaseReadiness) -> Void,
       onIrohFailure: @escaping @Sendable () -> Void = {},
       log: @escaping @Sendable (String) -> Void,
       nativeCeiling: Int) {
    self.transport = transport
    self.identity = identity
    self.clock = clock
    self.closeUsers = closeUsers
    self.onReadiness = onReadiness
    self.onIrohFailure = onIrohFailure
    self.log = log
    self.nativeCeiling = nativeCeiling
  }

  // MARK: - API

  /// Endpoint dla użytkownika w jego budżecie. Związany endpoint od razu; inaczej czekanie na jedno wspólne
  /// `bind` (także po trwającym `close`). Po budżecie `.timedOut`, a próba trwa dalej.
  public func acquire(_ user: LeaseUser, budget: Duration) async throws -> any TunnelEndpoint {
    if case .shutDown = phase { throw TunnelFailure.unavailable("endpoint lease shut down") }
    if bindHung { throw TunnelFailure.unavailable("bind did not return") }
    if inFlight >= nativeCeiling {
      log("lease: \(inFlight) unfinished native operations, acquire refused")
      throw TunnelFailure.unavailable("native operation ceiling")
    }
    if case .bound(let endpoint) = phase {
      users.insert(user)
      return endpoint
    }
    nextWaiter += 1
    let id = nextWaiter
    let promise = EndpointPromise()
    let clock = self.clock
    let timer = Task { [weak self] in
      do { try await clock.sleep(for: budget) } catch { return }
      await self?.expire(id)
    }
    waiters[id] = Waiter(user: user, promise: promise, timer: timer)
    startBindIfNeeded()
    return try await withTaskCancellationHandler {
      try await promise.value()
    } onCancel: {
      if promise.resolve(.failure(CancellationError())) {
        Task { await self.drop(id) }
      }
    }
  }

  /// Koniec użytkownika. Endpoint żyje także przy zerze użytkowników.
  public func release(_ user: LeaseUser) {
    users.remove(user)
  }

  /// Wynik próby iroh do bieżącego serwera; kolejne porażki na związanym endpoincie kończą się `rebind(.broken)`.
  /// Each failure also goes to `onIrohFailure`.
  public func reportIroh(success: Bool) {
    if success {
      failures = 0
      return
    }
    onIrohFailure()
    failures += 1
    guard failures >= Self.brokenAfterFailures, case .bound = phase else { return }
    log("lease: \(failures) consecutive iroh failures, endpoint broken")
    rebind(.broken)
  }

  /// Ponowne wiązanie: związany endpoint idzie do zamknięcia (najpierw połączenia użytkowników, potem
  /// `close()`); wynik trwającego `bind` zostanie zamknięty. Nowy `bind` przy następnym popycie.
  public func rebind(_ reason: RebindReason) {
    identityMissing = false
    if reason != .policy { failures = 0 }
    switch phase {
    case .bound(let endpoint):
      log("lease: rebind (\(reason))")
      beginClose(endpoint, closingUsers: Array(users))  // publikuje `rebinding`
    case .binding:
      abandonBind = true
      publish()
    case .unbound, .closing, .shutDown:
      publish(force: true)  // bez zmiany stanu: maszyny dostają bieżącą gotowość po swoim `rebindEndpoint`
    }
  }

  public var readiness: LeaseReadiness {
    if case .shutDown = phase { return .unavailable }
    if inFlight >= nativeCeiling { return .unavailable }
    switch phase {
    case .unbound: return identityMissing ? .unavailable : .ready
    case .bound: return .ready
    case .binding: return bindHung ? .unavailable : .rebinding
    case .closing: return closeHung ? .unavailable : .rebinding
    case .shutDown: return .unavailable
    }
  }

  /// Zamknięcie na koniec: żywy endpoint do `close()`, spóźniony wynik `bind` też; czekający dostają
  /// `.unavailable`. Wraca po zakończeniu wszystkich operacji natywnych; potem `acquire` dostaje `.unavailable`.
  public func shutdown() async {
    let previous = phase
    phase = .shutDown
    failWaiters(.unavailable("endpoint lease shut down"))
    if case .bound(let endpoint) = previous { beginClose(endpoint, closingUsers: Array(users)) }
    users = []
    publish()
    if inFlight > 0 {
      await withCheckedContinuation { drainWaiters.append($0) }
    }
    hangWatch?.cancel()
    hangWatch = nil
  }

  // MARK: - Do testów

  var userCount: Int { users.count }
  /// Consecutive iroh failures reported since the last success or rebind.
  var irohFailures: Int { failures }
  var unfinishedNativeOperations: Int { inFlight }
  var phaseName: String {
    switch phase {
    case .unbound: "unbound"
    case .binding: "binding"
    case .bound: "bound"
    case .closing: "closing"
    case .shutDown: "shutDown"
    }
  }

  // MARK: - Wiązanie i zamykanie

  private func startBindIfNeeded() {
    guard case .unbound = phase, !waiters.isEmpty else { return }
    guard inFlight < nativeCeiling else {
      failWaiters(.unavailable("native operation ceiling"))
      return
    }
    let operation = beginOperation(threshold: Self.bindHangThreshold, what: "bind")
    phase = .binding
    abandonBind = false
    publish()
    let transport = self.transport
    let identity = self.identity
    Task {
      guard let key = await identity() else {
        self.bindFinished(operation, .failure(.unavailable("iroh identity unavailable")), identityMissing: true)
        return
      }
      let result: Result<any TunnelEndpoint, TunnelFailure>
      do {
        result = .success(try await transport.bind(secretKey: key.secretKey, homeRelay: key.homeRelay))
      } catch let failure as TunnelFailure {
        result = .failure(failure)
      } catch {
        result = .failure(.bindFailed(String(describing: error)))
      }
      self.bindFinished(operation, result, identityMissing: false)
    }
  }

  private func bindFinished(_ operation: UInt64, _ result: Result<any TunnelEndpoint, TunnelFailure>,
                            identityMissing missing: Bool) {
    endOperation(operation)
    bindHung = false
    let shutDown = isShutDown
    switch result {
    case .success(let endpoint):
      if shutDown || abandonBind || waiters.isEmpty {
        if !shutDown && !abandonBind { log("lease: late endpoint after budget, closing it") }
        beginClose(endpoint, closingUsers: [])
      } else {
        phase = .bound(endpoint)
        identityMissing = false
        fulfillWaiters(endpoint)
      }
    case .failure(let failure):
      identityMissing = missing
      if !shutDown { phase = .unbound }
      failWaiters(failure)
    }
    abandonBind = false
    publish()
    checkDrained()
  }

  private func beginClose(_ endpoint: any TunnelEndpoint, closingUsers: [LeaseUser]) {
    let operation = beginOperation(threshold: Self.closeHangThreshold, what: "close")
    if !isShutDown { phase = .closing }
    closeHung = false
    publish()
    let closeUsers = self.closeUsers
    Task {
      if !closingUsers.isEmpty { await closeUsers(closingUsers) }
      await endpoint.close()
      self.closeFinished(operation)
    }
  }

  private func closeFinished(_ operation: UInt64) {
    endOperation(operation)
    closeHung = false
    if case .closing = phase { phase = .unbound }
    publish()
    startBindIfNeeded()
    checkDrained()
  }

  private var isShutDown: Bool {
    if case .shutDown = phase { return true }
    return false
  }

  // MARK: - Operacje natywne i progi

  private func beginOperation(threshold: Duration, what: String) -> UInt64 {
    nextOperation += 1
    let operation = nextOperation
    inFlight += 1
    activeOperation = operation
    hangWatch?.cancel()
    let clock = self.clock
    hangWatch = Task { [weak self] in
      do { try await clock.sleep(for: threshold) } catch { return }
      guard await self?.markHung(operation, what: what, after: threshold) == true else { return }
      while true {
        do { try await clock.sleep(for: EndpointLease.hangLogInterval) } catch { return }
        guard await self?.stillHung(operation, what: what) == true else { return }
      }
    }
    return operation
  }

  private func endOperation(_ operation: UInt64) {
    inFlight -= 1
    if activeOperation == operation {
      activeOperation = nil
      hangWatch?.cancel()
      hangWatch = nil
    }
  }

  private func markHung(_ operation: UInt64, what: String, after threshold: Duration) -> Bool {
    guard activeOperation == operation else { return false }
    if what == "bind" { bindHung = true } else { closeHung = true }
    log("lease: \(what) has not returned after \(threshold)")
    publish()
    return true
  }

  private func stillHung(_ operation: UInt64, what: String) -> Bool {
    guard activeOperation == operation else { return false }
    log("lease: \(what) still has not returned")
    return true
  }

  private func checkDrained() {
    guard inFlight == 0, !drainWaiters.isEmpty else { return }
    let waiting = drainWaiters
    drainWaiters = []
    for continuation in waiting { continuation.resume() }
  }

  // MARK: - Czekający

  private func expire(_ id: UInt64) {
    guard let waiter = waiters.removeValue(forKey: id) else { return }
    _ = waiter.promise.resolve(.failure(TunnelFailure.timedOut))
  }

  private func drop(_ id: UInt64) {
    waiters.removeValue(forKey: id)?.timer?.cancel()
  }

  private func fulfillWaiters(_ endpoint: any TunnelEndpoint) {
    let pending = waiters.sorted { $0.key < $1.key }.map(\.value)
    waiters = [:]
    for waiter in pending {
      waiter.timer?.cancel()
      if waiter.promise.resolve(.success(endpoint)) { users.insert(waiter.user) }
    }
  }

  private func failWaiters(_ failure: TunnelFailure) {
    let pending = waiters.sorted { $0.key < $1.key }.map(\.value)
    waiters = [:]
    for waiter in pending {
      waiter.timer?.cancel()
      _ = waiter.promise.resolve(.failure(failure))
    }
  }

  private func publish(force: Bool = false) {
    let current = readiness
    guard force || current != published else { return }
    published = current
    onReadiness(current)
  }
}

/// Jednorazowy wynik dla jednego czekającego: pierwsze rozstrzygnięcie wygrywa (endpoint, porażka, anulowanie).
private final class EndpointPromise: Sendable {
  private struct State {
    var result: Result<any TunnelEndpoint, any Error>?
    var continuation: CheckedContinuation<any TunnelEndpoint, any Error>?
  }

  private let state = Mutex(State())

  /// Prawda, gdy to rozstrzygnięcie wygrało.
  func resolve(_ result: Result<any TunnelEndpoint, any Error>) -> Bool {
    let (won, waiting) = state.withLock { state -> (Bool, CheckedContinuation<any TunnelEndpoint, any Error>?) in
      guard state.result == nil else { return (false, nil) }
      state.result = result
      defer { state.continuation = nil }
      return (true, state.continuation)
    }
    waiting?.resume(with: result)
    return won
  }

  func value() async throws -> any TunnelEndpoint {
    try await withCheckedThrowingContinuation { continuation in
      let ready = state.withLock { state -> Result<any TunnelEndpoint, any Error>? in
        if let result = state.result { return result }
        state.continuation = continuation
        return nil
      }
      if let ready { continuation.resume(with: ready) }
    }
  }
}
