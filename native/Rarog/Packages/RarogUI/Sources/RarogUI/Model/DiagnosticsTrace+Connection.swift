import Foundation
import RarogCore

// Trace of one connection gap of a stream, written when the stream comes online again: how long it took, how it
// started and whether the connecting card stood. Owner: connectivity.

extension DiagnosticsTrace {
  /// Which stream the gap belongs to.
  public enum StreamName: Sendable, Equatable {
    case global
    case session(String)
  }

  /// Gaps shorter than this without a visible card give no line: the short reconnects are the expected ones, and
  /// the connectivity budget (60 per hour) is shared with the tunnel's lines.
  public static let connectionTraceFloor: TimeInterval = 1

  /// „connection: global online after 1840 ms, start or return, card gray 0 ms” — `before` is the stream's memory
  /// before the `online` status, `card` the card it gave then. `nil`: the stream was not away, or the gap was short
  /// and no card stood.
  public static func connection(_ stream: StreamName, before: ConnectionMemory, card: Banner?, now: Date) -> String? {
    guard let since = before.notOnlineSince else { return nil }
    let gap = max(0, now.timeIntervalSince(since))
    let cardText: String? =
      switch card {
      case let .connecting(visibleFrom) where visibleFrom <= now: "gray \(milliseconds(now.timeIntervalSince(visibleFrom))) ms"
      case .serverUnreachable: "red"
      case .transcriptStalled: "stalled transcript"
      default: nil
      }
    guard gap >= connectionTraceFloor || cardText != nil else { return nil }
    let name =
      switch stream {
      case .global: "global"
      case let .session(id): "session \(shortSessionId(id))"
      }
    let cause =
      if before.attemptFailed { "after a failed attempt" }
      else if before.droppedWhileOnline { before.anyAttemptFailed ? "dropped in use, a quick failed attempt" : "dropped in use" }
      else if before.failedSinceOnline { "start or return, a quick failed attempt" }
      else { "start or return" }
    return "connection: \(name) online after \(milliseconds(gap)) ms, \(cause), card \(cardText ?? "none")"
  }

  private static func milliseconds(_ interval: TimeInterval) -> Int {
    max(0, Int((interval * 1000).rounded()))
  }
}
