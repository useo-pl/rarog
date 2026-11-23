import Foundation
import RarogContract

// The hold rule of the activity line: a quick run of tools does not
// flicker the line. The view keeps one value per row (like `ConnectionMemory`) and paints at the returned wake-up
// instead of on every tick. Owner: activity.

/// What the activity line shows now, given the newest candidate line.
///
/// A shown line stays at least ``minimumShow``. A tool line gives way to thinking only after ``thinkingAfterTool``
/// of continuous thinking (43–56% of tool results arrive within 700 ms, so the next tool usually comes first). An
/// empty candidate (end of turn, a permission), an offline line, an interrupt and an agent start pass at once, and a
/// session switch starts over.
public struct ActivityLineHold: Sendable, Equatable {
  /// The shortest time a shown line stays.
  public static let minimumShow: TimeInterval = 0.7
  /// Continuous thinking that replaces a tool line.
  public static let thinkingAfterTool: TimeInterval = 1.5

  /// What to paint now and when to ask again.
  public struct Outcome: Sendable, Equatable {
    /// The line to show; `nil` = no line.
    public var line: ActivityRowLine?
    /// When the held candidate may take over: the view resolves again at this moment. `nil` = nothing waits.
    public var wakeAt: Date?
  }

  public private(set) var shown: ActivityRowLine?
  private var shownAt: Date?
  /// First moment of the current unbroken run of thinking candidates over a shown tool line.
  private var thinkingSince: Date?
  private var sessionId: String?

  public init() {}

  /// The newest candidate of `sessionId` at `now`. Call it on every render and at ``Outcome/wakeAt``.
  public mutating func resolve(_ candidate: ActivityRowLine?, sessionId: String, now: Date) -> Outcome {
    if self.sessionId != sessionId {
      self = ActivityLineHold()
      self.sessionId = sessionId
    }
    guard let candidate, !candidate.skipsHold, let shown, let shownAt else { return take(candidate, now: now) }
    if candidate.contentKey == shown.contentKey {
      // Same content, newer times: no change to hold back.
      self.shown = candidate
      thinkingSince = nil
      return Outcome(line: candidate)
    }
    var due = shownAt.addingTimeInterval(Self.minimumShow)
    if shown.kind == .tool, candidate.kind == .thinking {
      let since = thinkingSince ?? now
      thinkingSince = since
      due = max(due, since.addingTimeInterval(Self.thinkingAfterTool))
    } else {
      thinkingSince = nil
    }
    guard now < due else { return take(candidate, now: now) }
    // The held line keeps ticking: the turn clock is the same for every line of the turn.
    var held = shown
    held.clockSeconds = candidate.clockSeconds
    held.clock = candidate.clock
    self.shown = held
    return Outcome(line: held, wakeAt: due)
  }

  private mutating func take(_ candidate: ActivityRowLine?, now: Date) -> Outcome {
    shown = candidate
    shownAt = candidate == nil ? nil : now
    thinkingSince = nil
    return Outcome(line: candidate)
  }
}
