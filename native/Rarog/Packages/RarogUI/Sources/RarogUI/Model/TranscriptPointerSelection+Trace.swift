import Foundation

// Trace lines of the transcript's pointer selection for `client.log`: facts only (the kind of touch, which recognizer
// won, how many autoscroll frames), never transcript text. The app shares one trace budget, so a process writes each
// touch kind once and only its first few selection gestures; that is enough to tell on a Mac whether a click arrives
// as a pointer and whether the list or the text field took the drag. Owner: transcript.

/// The kind of a touch that began in a transcript row's text, as the trace names it.
public enum TranscriptTouchKind: String, Sendable, Equatable, CaseIterable {
  case direct
  case indirect
  case pencil
  case indirectPointer
}

/// One selection gesture of the pointer, from press to release.
public struct TranscriptPointerGestureTrace: Sendable, Equatable {
  /// The list's pointer recognizer selected (`true`), or a system selection appeared in a text field during the press.
  public var listWon: Bool
  /// The press was a double or triple click (word, paragraph).
  public var clicks: Int
  /// Autoscroll frames that moved the list during the press.
  public var autoscrollFrames: Int

  public init(listWon: Bool, clicks: Int, autoscrollFrames: Int) {
    self.listWon = listWon
    self.clicks = clicks
    self.autoscrollFrames = autoscrollFrames
  }

  /// "transcript pointer: selection by list, clicks 1, autoscroll frames 42".
  public var traceLine: String {
    "transcript pointer: selection by \(listWon ? "list" : "text field"), clicks \(max(1, clicks)), "
      + "autoscroll frames \(max(0, autoscrollFrames))"
  }
}

/// Which pointer selection facts reach `client.log` in one process.
public struct TranscriptPointerTraceBudget: Sendable, Equatable {
  /// Selection gestures traced per process.
  public static let gestures = 3
  private var touchKinds: Set<TranscriptTouchKind> = []
  private var gesturesTraced = 0

  public init() {}

  /// The line for a touch that began in a transcript row's text, the first time this kind is seen; `nil` after that.
  public mutating func touch(_ kind: TranscriptTouchKind) -> String? {
    guard touchKinds.insert(kind).inserted else { return nil }
    return "transcript touch: first press of kind \(kind.rawValue) in a message text"
  }

  /// The line for a finished selection gesture while the budget lasts; `nil` after that.
  public mutating func gesture(_ gesture: TranscriptPointerGestureTrace) -> String? {
    guard gesturesTraced < Self.gestures else { return nil }
    gesturesTraced += 1
    return gesture.traceLine
  }
}
