import Foundation
import Synchronization

/// Czas atrapy tunelu pod kontrolą testu. Sen kończy się wyłącznie krokiem czasu (``advance(by:)``) albo
/// anulowaniem zadania, więc wynik testu terminów (2 s przerwania par, 15 s budżetu próby) nie zależy od
/// obciążenia maszyny. ``sleep`` pasuje do parametru `sleep` proxy i przyszłych aktorów tunelu.
public final class FakeTunnelClock: Sendable {
  private struct Nap {
    let until: Int64
    let continuation: CheckedContinuation<Bool, Never>
  }

  private struct State {
    var elapsed: Int64 = 0
    var nextId = 0
    var naps: [Int: Nap] = [:]
    var cancelled: Set<Int> = []
  }

  private let state = Mutex(State())

  public init() {}

  /// Czas od startu zegara.
  public var now: Duration { .nanoseconds(state.withLock { $0.elapsed }) }

  /// Liczba trwających snów (zadania czekające na termin).
  public var sleepers: Int { state.withLock { $0.naps.count } }

  /// Sen jak `Task.sleep(for:)`: kończy go termin albo anulowanie zadania (wtedy `CancellationError`).
  public func sleep(for duration: Duration) async throws {
    guard await nap(duration, cancellable: true) else { throw CancellationError() }
  }

  /// Sen, którego anulowanie zadania nie skraca (wywołanie natywne, które nie zna anulowania).
  public func sleepIgnoringCancellation(for duration: Duration) async {
    _ = await nap(duration, cancellable: false)
  }

  /// Domknięcie snu do wstrzyknięcia (parametr `sleep` proxy).
  public var sleep: @Sendable (Duration) async throws -> Void {
    { [self] duration in try await self.sleep(for: duration) }
  }

  /// Przesuwa czas; sny, którym minął termin, kończą się.
  public func advance(by duration: Duration) {
    let due = state.withLock { state -> [CheckedContinuation<Bool, Never>] in
      state.elapsed += Self.nanoseconds(duration)
      let ready = state.naps.filter { $0.value.until <= state.elapsed }
      for id in ready.keys { state.naps[id] = nil }
      return ready.values.map(\.continuation)
    }
    for continuation in due { continuation.resume(returning: true) }
  }

  /// Czeka (w czasie rzeczywistym, do `limit`), aż liczba snów dojdzie co najmniej do `count`. Prawda, gdy doszła.
  public func waitForSleepers(_ count: Int, limit: Duration = .seconds(5)) async -> Bool {
    let deadline = ContinuousClock.now + limit
    while sleepers < count {
      guard ContinuousClock.now < deadline else { return false }
      try? await Task.sleep(for: .milliseconds(2))
    }
    return true
  }

  /// Prawda: termin minął; fałsz: anulowanie zadania.
  private func nap(_ duration: Duration, cancellable: Bool) async -> Bool {
    let id = state.withLock { state -> Int in
      defer { state.nextId += 1 }
      return state.nextId
    }
    let wait = {
      await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
        let resumeNow: Bool? = self.state.withLock { state in
          if state.cancelled.remove(id) != nil { return false }
          let until = state.elapsed + Self.nanoseconds(duration)
          if until <= state.elapsed { return true }
          state.naps[id] = Nap(until: until, continuation: continuation)
          return nil
        }
        if let resumeNow { continuation.resume(returning: resumeNow) }
      }
    }
    guard cancellable else { return await wait() }
    return await withTaskCancellationHandler {
      await wait()
    } onCancel: {
      let waiting = state.withLock { state -> CheckedContinuation<Bool, Never>? in
        if let nap = state.naps.removeValue(forKey: id) { return nap.continuation }
        state.cancelled.insert(id)
        return nil
      }
      waiting?.resume(returning: false)
    }
  }

  private static func nanoseconds(_ duration: Duration) -> Int64 {
    let (seconds, attoseconds) = duration.components
    return seconds * 1_000_000_000 + attoseconds / 1_000_000_000
  }
}
