import Foundation
import Network
import Synchronization

// Proxy na pętli zwrotnej nad jednym połączeniem tunelu. `RarogClient` mówi zwykłym HTTP/1.1 do
// `http://127.0.0.1:<port>`, a proxy każde przyjęte połączenie TCP („parę”) przepina na nowy strumień
// dwukierunkowy tunelu. Dwie pompy na parę z backpressure: następny odczyt dopiero po potwierdzonym zapisie po
// drugiej stronie. Półzamknięcie przechodzi w obie strony: FIN klienta → `finish()` strumienia, FIN serwera → FIN
// do klienta od razu. Błąd po którejkolwiek stronie przerywa parę: klient lokalny zerwany bez FIN, strumień
// `abort(code:)`. Para, która nie skończy się w terminie przerwania (2 s), daje zdarzenie `abortTimedOut`;
// połączenie tunelu zamyka wtedy jego właściciel, po stronie apki, bez udziału serwera. Proxy nie zamyka
// połączenia samo i nie ponawia niczego.

/// Liczniki proxy do kryteriów stanu ustalonego: nasłuchy (od `start()` do faktycznego zatrzymania) i pary (od
/// przyjęcia do końca obu pomp). Jeden obiekt może liczyć wiele proxy (generacja i drzwi uploadu).
public final class TunnelProxyCounters: Sendable {
  private struct State {
    var listeners = 0
    var pairs = 0
  }

  private let state = Mutex(State())

  public init() {}

  public var listeners: Int { state.withLock { $0.listeners } }
  public var pairs: Int { state.withLock { $0.pairs } }

  func listenerOpened() { state.withLock { $0.listeners += 1 } }
  func listenerClosed() { state.withLock { $0.listeners -= 1 } }
  func pairOpened() { state.withLock { $0.pairs += 1 } }
  func pairClosed() { state.withLock { $0.pairs -= 1 } }
}

/// Zdarzenie proxy dla właściciela połączenia.
public enum TunnelProxyEvent: Sendable, Equatable {
  /// Przerwana para nie skończyła się w terminie: właściciel zamyka połączenie tunelu po stronie apki.
  /// Najwyżej raz na proxy.
  case abortTimedOut
}

public final class TunnelProxy: Sendable {
  /// Termin przerwania par.
  public static let abortDeadline: Duration = .seconds(2)
  static let chunkSize = 64 * 1024

  private struct State {
    var listener: NWListener?
    var port: Int?
    var closed = false
    var listenerStopped = false
    var stopWaiters: [CheckedContinuation<Void, Never>] = []
    var pairs: [Int: ProxyPair] = [:]
    var nextPair = 0
    var timedOutReported = false
  }

  private let connection: any TunnelConnection
  private let counters: TunnelProxyCounters
  private let deadline: Duration
  private let sleep: @Sendable (Duration) async throws -> Void
  private let queue = DispatchQueue(label: "rarog.tunnel-proxy")
  private let state = Mutex(State())
  private let sink: AsyncStream<TunnelProxyEvent>.Continuation

  /// Zdarzenia proxy (jeden konsument); kończą się po ``close(code:)``.
  public let events: AsyncStream<TunnelProxyEvent>

  /// - Parameters:
  ///   - connection: połączenie tunelu; jego zamknięcie należy do wołającego.
  ///   - counters: liczniki nasłuchów i par (wspólne dla wielu proxy jednego właściciela).
  ///   - abortDeadline: termin przerwania par.
  ///   - sleep: sen terminu przerwania (testy podają sztuczny zegar).
  public init(
    connection: any TunnelConnection,
    counters: TunnelProxyCounters = TunnelProxyCounters(),
    abortDeadline: Duration = TunnelProxy.abortDeadline,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) {
    self.connection = connection
    self.counters = counters
    deadline = abortDeadline
    self.sleep = sleep
    (events, sink) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(1))
  }

  /// Port nasłuchu na `127.0.0.1` po udanym ``start()``.
  public var port: Int? { state.withLock { $0.port } }

  /// Nasłuch na `127.0.0.1` z portem od systemu; oddaje port. Drugi start albo start po zamknięciu rzuca.
  public func start() async throws -> Int {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener: NWListener
    do {
      listener = try NWListener(using: parameters)
    } catch {
      throw TunnelFailure.unavailable("proxy listener: \(error)")
    }
    let fresh = state.withLock { state -> Bool in
      guard state.listener == nil, !state.closed else { return false }
      state.listener = listener
      return true
    }
    guard fresh else { throw TunnelFailure.unavailable("proxy already started or closed") }
    counters.listenerOpened()
    listener.newConnectionHandler = { [weak self] local in
      guard let self else { return local.cancel() }
      self.accept(local)
    }
    let resumed = Mutex(false)
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int, any Error>) in
      let resume: @Sendable (Result<Int, any Error>) -> Void = { result in
        guard resumed.withLock({ done in defer { done = true }; return !done }) else { return }
        continuation.resume(with: result)
      }
      listener.stateUpdateHandler = { [weak self] update in
        switch update {
        case .ready:
          guard let port = listener.port.map({ Int($0.rawValue) }) else { return }
          self?.state.withLock { $0.port = port }
          resume(.success(port))
        case let .failed(error):
          resume(.failure(TunnelFailure.unavailable("proxy listener: \(error)")))
          listener.cancel()
        case .cancelled:
          resume(.failure(TunnelFailure.unavailable("proxy closed")))
          self?.listenerStopped()
        default:
          break
        }
      }
      listener.start(queue: queue)
    }
  }

  /// Zatrzymuje nasłuch i przerywa każdą parę kodem `code`. Prawda, gdy wszystkie pary skończyły się
  /// w terminie przerwania; fałsz = `abortTimedOut` (także jako zdarzenie). Połączenia tunelu nie zamyka.
  public func close(code: UInt64 = 0) async -> Bool {
    let (listener, pairs) = state.withLock { state in
      state.closed = true
      return (state.listener, Array(state.pairs.values))
    }
    listener?.cancel()
    for pair in pairs { abort(pair, code: code) }
    if listener != nil { await waitListenerStopped() }
    let drained = await Self.ended(pairs, within: deadline, sleep: sleep)
    if !drained { reportTimedOut() }
    sink.finish()
    return drained
  }

  // MARK: - Pary

  private func accept(_ local: NWConnection) {
    let pair = state.withLock { state -> ProxyPair? in
      guard !state.closed else { return nil }
      let pair = ProxyPair(id: state.nextPair, local: local)
      state.nextPair += 1
      state.pairs[pair.id] = pair
      return pair
    }
    guard let pair else { return local.cancel() }
    counters.pairOpened()
    local.start(queue: queue)
    Task { await self.run(pair) }
  }

  private func run(_ pair: ProxyPair) async {
    let stream: any TunnelStream
    do {
      stream = try await connection.openStream()
    } catch {
      abort(pair, code: 0)
      return finish(pair)
    }
    if let code = pair.attach(stream) {
      // Przerwana, zanim strumień powstał: strumień dostaje ten sam kod.
      await stream.abort(code: code)
      return finish(pair)
    }
    await withTaskGroup(of: Void.self) { group in
      group.addTask { await self.pumpToTunnel(pair, stream) }
      group.addTask { await self.pumpToClient(pair, stream) }
    }
    if !pair.isAborted { pair.local.cancel() }
    finish(pair)
  }

  /// Klient lokalny → strumień: zapis do tunelu przed następnym odczytem; FIN klienta → `finish()`.
  private func pumpToTunnel(_ pair: ProxyPair, _ stream: any TunnelStream) async {
    while true {
      let (data, complete, error) = await Self.receive(pair.local)
      if let data, !data.isEmpty {
        do {
          try await stream.write(data)
        } catch {
          return abort(pair, code: 0)
        }
      }
      if error != nil { return abort(pair, code: 0) }
      if complete {
        do {
          try await stream.finish()
        } catch {
          abort(pair, code: 0)
        }
        return
      }
    }
  }

  /// Strumień → klient lokalny: wysyłka potwierdzona przed następnym odczytem; FIN serwera → FIN od razu.
  private func pumpToClient(_ pair: ProxyPair, _ stream: any TunnelStream) async {
    while true {
      let data: Data
      do {
        data = try await stream.read(maxBytes: Self.chunkSize)
      } catch {
        return abort(pair, code: 0)
      }
      let error = await Self.send(pair.local, data.isEmpty ? nil : data, final: data.isEmpty)
      if error != nil { return abort(pair, code: 0) }
      if data.isEmpty { return }
    }
  }

  /// Przerwanie pary (raz): klient lokalny zerwany bez FIN, strumień `abort`, termin na koniec obu pomp.
  private func abort(_ pair: ProxyPair, code: UInt64) {
    guard let stream = pair.markAborted(code: code) else { return }
    pair.local.forceCancel()
    if let stream {
      Task { await stream.abort(code: code) }
    }
    Task {
      if await !Self.ended([pair], within: deadline, sleep: sleep) { reportTimedOut() }
    }
  }

  private func finish(_ pair: ProxyPair) {
    let removed = state.withLock { $0.pairs.removeValue(forKey: pair.id) != nil }
    if removed { counters.pairClosed() }
    pair.markEnded()
  }

  private func reportTimedOut() {
    let first = state.withLock { state -> Bool in
      defer { state.timedOutReported = true }
      return !state.timedOutReported
    }
    if first { sink.yield(.abortTimedOut) }
  }

  // MARK: - Nasłuch

  private func listenerStopped() {
    // Licznik schodzi dokładnie raz: przy pierwszym przejściu w `.cancelled`.
    let waiters = state.withLock { state -> [CheckedContinuation<Void, Never>]? in
      guard !state.listenerStopped else { return nil }
      state.listenerStopped = true
      state.closed = true
      defer { state.stopWaiters.removeAll() }
      return state.stopWaiters
    }
    guard let waiters else { return }
    counters.listenerClosed()
    for waiter in waiters { waiter.resume() }
  }

  private func waitListenerStopped() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let stopped = state.withLock { state -> Bool in
        if state.listenerStopped { return true }
        state.stopWaiters.append(continuation)
        return false
      }
      if stopped { continuation.resume() }
    }
  }

  // MARK: - Pomocnicze

  /// Czy wszystkie pary skończyły się przed terminem.
  private static func ended(
    _ pairs: [ProxyPair],
    within limit: Duration,
    sleep: @escaping @Sendable (Duration) async throws -> Void
  ) async -> Bool {
    if pairs.allSatisfy(\.isEnded) { return true }
    return await withTaskGroup(of: Bool.self) { group in
      group.addTask {
        for pair in pairs { await pair.waitEnded() }
        return !Task.isCancelled
      }
      group.addTask {
        try? await sleep(limit)
        return false
      }
      let first = await group.next() ?? false
      group.cancelAll()
      return first
    }
  }

  private static func receive(_ local: NWConnection) async -> (Data?, Bool, NWError?) {
    await withCheckedContinuation { continuation in
      local.receive(minimumIncompleteLength: 1, maximumLength: chunkSize) { data, _, complete, error in
        continuation.resume(returning: (data, complete, error))
      }
    }
  }

  /// Wysyłka z potwierdzeniem; `final` = FIN po danych.
  private static func send(_ local: NWConnection, _ data: Data?, final: Bool) async -> NWError? {
    await withCheckedContinuation { continuation in
      local.send(
        content: data,
        contentContext: final ? .finalMessage : .defaultMessage,
        isComplete: true,
        completion: .contentProcessed { error in continuation.resume(returning: error) }
      )
    }
  }
}

/// Jedna para: połączenie lokalne i strumień tunelu.
private final class ProxyPair: Sendable {
  private struct State {
    var stream: (any TunnelStream)?
    var abortCode: UInt64?
    var ended = false
    var nextWaiter = 0
    var waiters: [Int: CheckedContinuation<Void, Never>] = [:]
  }

  let id: Int
  let local: NWConnection
  private let state = Mutex(State())

  init(id: Int, local: NWConnection) {
    self.id = id
    self.local = local
  }

  var isAborted: Bool { state.withLock { $0.abortCode != nil } }
  var isEnded: Bool { state.withLock { $0.ended } }

  /// Dołącza strumień; przy parze już przerwanej oddaje kod przerwania (strumień trzeba przerwać).
  func attach(_ stream: any TunnelStream) -> UInt64? {
    state.withLock { state in
      state.stream = stream
      return state.abortCode
    }
  }

  /// Pierwsze przerwanie: `.some(strumień albo nil, gdy jeszcze go nie ma)`; kolejne: `nil`.
  func markAborted(code: UInt64) -> (any TunnelStream)?? {
    state.withLock { state in
      guard state.abortCode == nil else { return nil }
      state.abortCode = code
      return .some(state.stream)
    }
  }

  func markEnded() {
    let waiters = state.withLock { state -> [CheckedContinuation<Void, Never>] in
      state.ended = true
      defer { state.waiters.removeAll() }
      return Array(state.waiters.values)
    }
    for waiter in waiters { waiter.resume() }
  }

  /// Czeka na koniec pary; anulowanie zadania kończy czekanie od razu.
  func waitEnded() async {
    let id = state.withLock { state -> Int in
      defer { state.nextWaiter += 1 }
      return state.nextWaiter
    }
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let resumeNow = state.withLock { state -> Bool in
          if state.ended || Task.isCancelled { return true }
          state.waiters[id] = continuation
          return false
        }
        if resumeNow { continuation.resume() }
      }
    } onCancel: {
      state.withLock { $0.waiters.removeValue(forKey: id) }?.resume()
    }
  }
}
