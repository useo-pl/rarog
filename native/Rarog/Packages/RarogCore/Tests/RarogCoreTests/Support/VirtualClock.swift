import Foundation
@testable import RarogCore
import Testing

/// Czas pod kontrolą testu: zegar magazynu (`now`) i sen pętli odpytywania (`sleep`). Sen kończy się
/// wyłącznie krokiem czasu (`advance(by:)`) albo anulowaniem, więc wynik testu rytmu nie zależy od
/// obciążenia maszyny (testy z oknami 500–800 ms padają przy równoległych buildach).
final class VirtualClock: @unchecked Sendable {
  private struct Nap {
    /// Termin w nanosekundach od startu zegara.
    let until: Int64
    let duration: Duration
    let continuation: CheckedContinuation<Void, Never>
  }

  private let lock = NSLock()
  /// Czas w całych nanosekundach od daty odniesienia: różnice dat liczone na Double są wtedy
  /// dokładne (przy dacie z 2026 r. 0,4 s wychodziło 0,39999998 s i termin „nie mijał").
  private var elapsed: Int64 = 0
  private var naps: [UUID: Nap] = [:]
  private var cancelled: Set<UUID> = []

  var now: Date { lock.withLock { Date(timeIntervalSinceReferenceDate: Double(elapsed) / 1e9) } }

  /// Długości trwających snów (pętla czeka na termin); pusto = nikt nie śpi.
  var sleeping: [Duration] { lock.withLock { naps.values.map(\.duration) } }

  /// Sen do terminu `now + duration`; anulowanie zadania kończy go od razu (jak `Task.sleep`).
  func sleep(_ duration: Duration) async {
    let id = UUID()
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let resumeNow = lock.withLock { () -> Bool in
          if cancelled.remove(id) != nil { return true }
          naps[id] = Nap(until: elapsed + Self.nanoseconds(duration), duration: duration, continuation: continuation)
          return false
        }
        if resumeNow { continuation.resume() }
      }
    } onCancel: {
      let waiting = lock.withLock { () -> CheckedContinuation<Void, Never>? in
        if let nap = naps.removeValue(forKey: id) { return nap.continuation }
        cancelled.insert(id)
        return nil
      }
      waiting?.resume()
    }
  }

  /// Przesuwa czas; sny, którym minął termin, kończą się.
  func advance(by duration: Duration) {
    let due = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      elapsed += Self.nanoseconds(duration)
      let ready = naps.filter { $0.value.until <= elapsed }
      for id in ready.keys { naps[id] = nil }
      return ready.values.map(\.continuation)
    }
    for continuation in due { continuation.resume() }
  }

  /// Krok czasu i czekanie, aż pętla, którą obudził, znów zaśnie (albo nikogo nie obudził).
  @MainActor
  func step(_ duration: Duration, sourceLocation: SourceLocation = #_sourceLocation) async {
    advance(by: duration)
    await until("pętla znów śpi", sourceLocation: sourceLocation) { sleeping.count == 1 }
  }

  /// Krok tuż za termin (+1 ms): prawdziwy sen zawsze kończy się trochę po terminie, a krok co do
  /// nanosekundy porównywałby czasy na Double na samej granicy.
  @MainActor
  func stepPast(_ term: Duration, sourceLocation: SourceLocation = #_sourceLocation) async {
    await step(term + .milliseconds(1), sourceLocation: sourceLocation)
  }

  private static func nanoseconds(_ duration: Duration) -> Int64 {
    let (seconds, attoseconds) = duration.components
    return seconds * 1_000_000_000 + attoseconds / 1_000_000_000
  }
}

extension RarogStore {
  /// Pętla odpytywania śpi na wirtualnym zegarze testu (przed `start()`).
  func useVirtualSleep(_ clock: VirtualClock) {
    usagePolling.sleep = { await clock.sleep($0) }
  }
}
