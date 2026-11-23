import Foundation
import RarogContract
import Synchronization

// Owner: the SSE stream loop. The stall guard of one stream attempt and the stall threshold shared by all streams.
//
// A stream is stalled when nothing came from the socket for the threshold, counted from the moment the request went
// out or from the last body byte, never from the last frame: one `data:` line of a transcript snapshot can be
// hundreds of kB and flow slowly through the relay. The byte loop of `RarogClient.openStream` stamps every byte, and
// both routes (direct HTTPS and the iroh tunnel) read through that loop, so one guard covers both. The stream
// supervisor in RarogCore races each attempt against ``StreamStallGuard/stalled()`` and ends a stalled stream like
// a dropped one.

/// Stall threshold shared by every stream of one login: 1.5 × the ping interval the server announced in the last
/// `hello` of the global stream, ``fallback`` without a valid interval or before the first `hello`. A change wakes
/// every guard that is waiting, so streams that are already open move to the new threshold at once.
public final class StallThreshold: Sendable {
  /// Threshold without a valid `heartbeatMs`: an older server pings at least every 25 s.
  public static let fallback: Duration = .seconds(60)

  private struct State {
    var limit = StallThreshold.fallback
    var version: UInt64 = 0
    var nextWaiter = 0
    var waiters: [Int: CheckedContinuation<Void, Never>] = [:]
    var cancelled: Set<Int> = []
  }

  private let state = Mutex(State())

  public init() {}

  /// Threshold for a ping interval: 1.5 × `heartbeatMs`, ``fallback`` for `nil`.
  public static func limit(heartbeatMs: Int?) -> Duration {
    guard let heartbeatMs else { return fallback }
    return .microseconds(heartbeatMs * 1500)
  }

  public var current: Duration { state.withLock { $0.limit } }

  /// Sets the threshold from a `hello` of the global stream; `hello` without a valid interval goes back to
  /// ``fallback``.
  public func apply(_ hello: HelloEvent) {
    set(Self.limit(heartbeatMs: hello.validHeartbeatMs))
  }

  /// Back to ``fallback``: logout or another server.
  public func reset() {
    set(Self.fallback)
  }

  func snapshot() -> (limit: Duration, version: UInt64) {
    state.withLock { ($0.limit, $0.version) }
  }

  /// Returns when the threshold changes after `version`, or at once when the task is cancelled.
  func changed(since version: UInt64) async {
    let id = state.withLock { state -> Int in
      defer { state.nextWaiter += 1 }
      return state.nextWaiter
    }
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let resumeNow = state.withLock { state -> Bool in
          if state.cancelled.remove(id) != nil || state.version != version { return true }
          state.waiters[id] = continuation
          return false
        }
        if resumeNow { continuation.resume() }
      }
    } onCancel: {
      let waiting = state.withLock { state -> CheckedContinuation<Void, Never>? in
        if let continuation = state.waiters.removeValue(forKey: id) { return continuation }
        state.cancelled.insert(id)
        return nil
      }
      waiting?.resume()
    }
  }

  private func set(_ limit: Duration) {
    let waiting = state.withLock { state -> [CheckedContinuation<Void, Never>] in
      guard state.limit != limit else { return [] }
      state.limit = limit
      state.version += 1
      defer { state.waiters = [:] }
      return Array(state.waiters.values)
    }
    for continuation in waiting { continuation.resume() }
  }
}

/// Stall guard of ONE stream attempt. The transport reports the request going out (``sent()``), every body byte
/// (``received()``) and the end of the byte source (``ended()``); the stream supervisor waits for the first byte
/// (``firstByte()``) and for a stall (``stalled()``). Before ``sent()`` the guard is not armed: waiting for a route
/// is not silence of the server.
public final class StreamStallGuard: Sendable {
  private struct State {
    /// The request went out or the last body byte came; `nil` = not armed yet.
    var last: ContinuousClock.Instant?
    var gotByte = false
    var ended = false
    /// Grows with every change a waiter can care about: armed, first byte, end.
    var epoch: UInt64 = 0
    var nextWaiter = 0
    var waiters: [Int: CheckedContinuation<Void, Never>] = [:]
    var cancelled: Set<Int> = []
  }

  private let threshold: StallThreshold
  private let timing: TunnelRuntime.Timing
  private let state = Mutex(State())

  /// - Parameters:
  ///   - threshold: shared threshold; it can change while the stream is open.
  ///   - timing: clock and sleep (tests: an artificial clock).
  public init(threshold: StallThreshold = StallThreshold(), timing: TunnelRuntime.Timing = .system) {
    self.threshold = threshold
    self.timing = timing
  }

  /// The request goes out now: silence counts from here.
  public func sent() {
    let now = timing.now()
    wake { state in
      state.last = now
      return true
    }
  }

  /// A body byte came. Runs for every byte of the stream, so after the first byte it only stamps the time.
  public func received() {
    let now = timing.now()
    let first = state.withLock { state -> Bool in
      state.last = now
      return !state.gotByte
    }
    guard first else { return }
    wake { state in
      guard !state.gotByte else { return false }
      state.gotByte = true
      return true
    }
  }

  /// The byte source finished (end, error or cancellation): a waiter for the first byte stops waiting.
  public func ended() {
    wake { state in
      guard !state.ended else { return false }
      state.ended = true
      return true
    }
  }

  /// True when a body byte came; false when the byte source ended without one or the task was cancelled.
  public func firstByte() async -> Bool {
    while true {
      let (gotByte, ended, epoch) = state.withLock { ($0.gotByte, $0.ended, $0.epoch) }
      if gotByte { return true }
      if ended || Task.isCancelled { return false }
      await changed(since: epoch)
    }
  }

  /// Returns when the stream has been silent for the threshold since ``sent()`` or the last byte; throws
  /// `CancellationError` when the task is cancelled. A new threshold applies at once, also during the wait.
  public func stalled() async throws {
    while true {
      try Task.checkCancellation()
      // The clock first: a byte or a new threshold that lands after this reading moves the deadline past `now`,
      // so it can never be judged against a time read after it.
      let now = timing.now()
      let (last, epoch) = state.withLock { ($0.last, $0.epoch) }
      guard let last else {
        await changed(since: epoch)
        continue
      }
      let (limit, version) = threshold.snapshot()
      let deadline = last + limit
      if now >= deadline { return }
      let timing = timing
      let threshold = threshold
      await withTaskGroup(of: Void.self) { group in
        group.addTask { try? await timing.sleep(deadline - now) }
        group.addTask { await threshold.changed(since: version) }
        await group.next()
        group.cancelAll()
      }
    }
  }

  /// Applies `change` under the lock and, when it returns true, bumps the epoch and wakes every waiter.
  private func wake(_ change: (inout State) -> Bool) {
    let waiting = state.withLock { state -> [CheckedContinuation<Void, Never>] in
      guard change(&state) else { return [] }
      state.epoch += 1
      defer { state.waiters = [:] }
      return Array(state.waiters.values)
    }
    for continuation in waiting { continuation.resume() }
  }

  /// Returns when the epoch moves past `epoch`, or at once when the task is cancelled.
  private func changed(since epoch: UInt64) async {
    let id = state.withLock { state -> Int in
      defer { state.nextWaiter += 1 }
      return state.nextWaiter
    }
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let resumeNow = state.withLock { state -> Bool in
          if state.cancelled.remove(id) != nil || state.epoch != epoch { return true }
          state.waiters[id] = continuation
          return false
        }
        if resumeNow { continuation.resume() }
      }
    } onCancel: {
      let waiting = state.withLock { state -> CheckedContinuation<Void, Never>? in
        if let continuation = state.waiters.removeValue(forKey: id) { return continuation }
        state.cancelled.insert(id)
        return nil
      }
      waiting?.resume()
    }
  }
}
