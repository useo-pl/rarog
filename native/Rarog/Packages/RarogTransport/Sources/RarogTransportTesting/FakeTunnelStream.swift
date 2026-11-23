import Foundation
import RarogTransport
import Synchronization

/// Usterka strumienia atrapy. Liczy się od bajtów żądania, które dotarły do serwera, więc działa przy każdym
/// obsłużeniu strumienia przez serwer atrapy (echo, HTTP, własne).
public enum FakeStreamFault: Sendable, Equatable {
  /// Serwer resetuje strumień (oba kierunki) po odebraniu `afterBytes` bajtów; 0 = od razu po otwarciu.
  case reset(afterBytes: Int, code: UInt64 = 0)
  /// Serwer kończy swój kierunek (FIN) po odebraniu `afterBytes` bajtów; 0 = od razu po otwarciu.
  case fin(afterBytes: Int)
  /// Odczyt i zapis po stronie apki wiszą bez sygnału serwera; `abort` ich nie budzi, budzi je dopiero
  /// zamknięcie połączenia (jak strumień QUIC na zerwanej ścieżce bez pakietów).
  case blockedBoth
}

/// Jeden kierunek strumienia: bufor z oknem (zapis czeka, gdy okno pełne), FIN i porażka.
final class FakePipe: Sendable {
  private struct State {
    var buffer = Data()
    var finished = false
    var failure: TunnelFailure?
    var delivered = 0
    /// Rośnie przy każdej zmianie; czekający zasypia tylko, gdy od sprawdzenia nic się nie zmieniło.
    var version = 0
    var waiters: [CheckedContinuation<Void, Never>] = []
  }

  private let state = Mutex(State())
  private let capacity: Int
  /// Wiszące wywołania czekają wyłącznie na porażkę (zamknięcie połączenia), nie na dane.
  private let blocked: Bool
  private let changed: @Sendable () -> Void

  init(capacity: Int, blocked: Bool, changed: @escaping @Sendable () -> Void) {
    self.capacity = max(1, capacity)
    self.blocked = blocked
    self.changed = changed
  }

  /// Bajty przyjęte do bufora od początku (do usterek „po N bajtach”).
  var delivered: Int { state.withLock { $0.delivered } }

  /// Kierunek skończony: FIN albo porażka.
  var done: Bool { state.withLock { $0.finished || $0.failure != nil } }

  func write(_ data: Data) async throws {
    while true {
      let (outcome, seen): (Result<Bool, TunnelFailure>, Int) = state.withLock { state in
        if let failure = state.failure { return (.failure(failure), state.version) }
        if blocked { return (.success(false), state.version) }
        if state.finished { return (.failure(.unavailable("zapis po FIN")), state.version) }
        guard state.buffer.count < capacity else { return (.success(false), state.version) }
        state.buffer.append(data)
        state.delivered += data.count
        return (.success(true), state.version)
      }
      switch outcome {
      case let .failure(failure): throw failure
      case .success(true):
        wakeAll()
        return
      case .success(false): await waitForChange(after: seen)
      }
    }
  }

  /// Do `maxBytes` bajtów; pusty `Data` = FIN.
  func read(maxBytes: Int) async throws -> Data {
    while true {
      let (outcome, seen): (Result<Data?, TunnelFailure>, Int) = state.withLock { state in
        if let failure = state.failure { return (.failure(failure), state.version) }
        if blocked { return (.success(nil), state.version) }
        if !state.buffer.isEmpty {
          let chunk = Data(state.buffer.prefix(max(1, maxBytes)))
          state.buffer.removeFirst(chunk.count)
          return (.success(chunk), state.version)
        }
        return (.success(state.finished ? Data() : nil), state.version)
      }
      switch outcome {
      case let .failure(failure): throw failure
      case let .success(chunk?):
        wakeAll()
        return chunk
      case .success(nil): await waitForChange(after: seen)
      }
    }
  }

  func finish() {
    state.withLock { $0.finished = true }
    wakeAll()
    changed()
  }

  /// Porażka kierunku: bufor przepada, każde czekające i następne wywołanie dostaje `failure`. Pierwsza wygrywa.
  func fail(_ failure: TunnelFailure) {
    state.withLock { state in
      guard state.failure == nil else { return }
      state.failure = failure
      state.buffer.removeAll()
    }
    wakeAll()
    changed()
  }

  /// Sen do następnej zmiany po wersji `seen`; zmiana między sprawdzeniem a zaśnięciem budzi od razu.
  private func waitForChange(after seen: Int) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let changed = state.withLock { state -> Bool in
        guard state.version == seen else { return true }
        state.waiters.append(continuation)
        return false
      }
      if changed { continuation.resume() }
    }
  }

  private func wakeAll() {
    let woken = state.withLock { state -> [CheckedContinuation<Void, Never>] in
      state.version += 1
      defer { state.waiters.removeAll() }
      return state.waiters
    }
    for waiter in woken { waiter.resume() }
  }
}

/// Wspólny stan strumienia: oba kierunki, usterka i koniec liczony raz.
final class FakeStreamCore: Sendable {
  let index: Int
  let fault: FakeStreamFault?
  let toServer: FakePipe
  let toApp: FakePipe
  private let ended = Mutex(false)
  private let triggered = Mutex(false)
  private let abortCodes = Mutex<[UInt64]>([])
  private let onEnd: @Sendable (FakeStreamCore) -> Void

  init(index: Int, window: Int, fault: FakeStreamFault?, onEnd: @escaping @Sendable (FakeStreamCore) -> Void) {
    self.index = index
    self.fault = fault
    self.onEnd = onEnd
    let blocked = fault == .blockedBoth
    let check = Mutex<(@Sendable () -> Void)?>(nil)
    let changed: @Sendable () -> Void = { check.withLock { $0 }?() }
    toServer = FakePipe(capacity: window, blocked: false, changed: changed)
    toApp = FakePipe(capacity: window, blocked: blocked, changed: changed)
    // Blokada działa w obu kierunkach po stronie apki: zapis apki czeka tak samo jak odczyt.
    blockedWrite = blocked
    check.withLock { $0 = { [weak self] in self?.checkEnded() } }
  }

  let blockedWrite: Bool
  /// Kody `abort` wywołane przez apkę (także przy `blockedBoth`, gdzie nic nie budzą).
  var aborts: [UInt64] { abortCodes.withLock { $0 } }

  func recordAbort(_ code: UInt64) { abortCodes.withLock { $0.append(code) } }

  /// Usterka „po N bajtach” po każdym zapisie apki (i przy otwarciu dla N = 0).
  func applyFault() {
    let threshold: Int
    switch fault {
    case let .reset(afterBytes, _): threshold = afterBytes
    case let .fin(afterBytes): threshold = afterBytes
    case .blockedBoth, nil: return
    }
    guard toServer.delivered >= threshold, triggered.withLock({ fired in defer { fired = true }; return !fired })
    else { return }
    switch fault {
    case let .reset(_, code): reset(code: code)
    case .fin: toApp.finish()
    case .blockedBoth, nil: break
    }
  }

  /// Reset strumienia przez serwer: oba kierunki padają.
  func reset(code: UInt64) {
    let failure = TunnelFailure.closed(code: code, reason: "stream reset by the server")
    toApp.fail(failure)
    toServer.fail(failure)
  }

  /// Zamknięcie połączenia: oba kierunki padają z powodem połączenia (budzi też `blockedBoth`).
  func connectionClosed(_ failure: TunnelFailure) {
    toApp.fail(failure)
    toServer.fail(failure)
  }

  private func checkEnded() {
    guard toServer.done, toApp.done else { return }
    guard ended.withLock({ value in defer { value = true }; return !value }) else { return }
    onEnd(self)
  }
}

/// Strona apki strumienia atrapy (to, co dostaje proxy przez `TunnelConnection.openStream()`).
final class FakeTunnelStream: TunnelStream {
  private let core: FakeStreamCore
  private let gate: FakePipe

  init(core: FakeStreamCore) {
    self.core = core
    // Zapis przy `blockedBoth` czeka na tę samą porażkę co odczyt.
    gate = core.toApp
  }

  func read(maxBytes: Int) async throws -> Data {
    try await core.toApp.read(maxBytes: maxBytes)
  }

  func write(_ data: Data) async throws {
    if core.blockedWrite {
      _ = try await gate.read(maxBytes: 1)  // wisi do porażki kierunku (zamknięcia połączenia)
    }
    try await core.toServer.write(data)
    core.applyFault()
  }

  func finish() async throws {
    if core.blockedWrite {
      _ = try await gate.read(maxBytes: 1)
    }
    core.toServer.finish()
  }

  func abort(code: UInt64) async {
    core.recordAbort(code)
    guard core.fault != .blockedBoth else { return }  // bez sygnału: nic nie budzi
    let failure = TunnelFailure.closed(code: code, reason: "stream aborted by the app")
    core.toServer.fail(failure)
    core.toApp.fail(failure)
  }
}

/// Strona serwera strumienia atrapy: obsługa w ``FakeTunnelServer``.
public final class FakeServerStream: Sendable {
  let core: FakeStreamCore

  init(core: FakeStreamCore) {
    self.core = core
  }

  /// Numer strumienia w transporcie atrapy (od 0, w kolejności otwarcia).
  public var index: Int { core.index }

  /// Bajty żądania od apki; pusty `Data` = FIN apki; rzuca po `abort` apki albo zamknięciu połączenia.
  public func read(maxBytes: Int = 64 * 1024) async throws -> Data {
    try await core.toServer.read(maxBytes: maxBytes)
  }

  /// Wszystko do FIN apki.
  public func readToEnd() async throws -> Data {
    var all = Data()
    while true {
      let chunk = try await read()
      if chunk.isEmpty { return all }
      all.append(chunk)
    }
  }

  public func write(_ data: Data) async throws {
    try await core.toApp.write(data)
  }

  /// FIN serwera.
  public func finish() {
    core.toApp.finish()
  }

  /// Reset strumienia przez serwer (oba kierunki).
  public func reset(code: UInt64 = 0) {
    core.reset(code: code)
  }

  /// Kody `abort` wywołane przez apkę na tym strumieniu.
  public var appAborts: [UInt64] { core.aborts }
}
