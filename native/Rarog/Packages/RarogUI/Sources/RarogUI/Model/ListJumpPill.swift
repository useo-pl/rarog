import CoreGraphics
import RarogCore

// The jump pill of the session list ("3 below ↓ · 1 waiting, 1 failed, 1 unread"): the rule that counts the rows
// that need the human and stand off screen, above or below. Pure numbers, tested on macOS (`ListJumpPillTests`);
// texts: `Copy/UICopy+ListJump.swift`. Owner: list.

/// A session that waits for the human, failed or holds an unread result can stand under the scroll, where the list
/// does not show it. The pill says how many such rows stand below (or above) the visible part and scrolls to the
/// nearest. Work does not make a pill: nothing waits on the human there.
///
/// The rule takes the rows of the tree version the collection really holds and the rows' frames from the collection's
/// layout (estimated ones too). Two passes, no loop and no fixed bands:
/// 1. against the whole visible part: a row that is not on screen (``onScreen(_:top:bottom:)``) stands below when its
///    center is lower than the center of the visible part, otherwise above;
/// 2. only on a side that has a result from pass 1: rows that are on screen, but would stand under that side's pill
///    (the pill's measured height: its touch frame stands on that edge), count too, because the pill covers them. A row is under the pill
///    when it is not on screen in the visible part without the pill's band (the same half rule).
/// So a row visible whole just above the footer card does not call up a pill that would cover it.
public enum ListJumpPill {
  public typealias Viewport = ListReturnScroll.Viewport
  public typealias Span = ListReturnScroll.Span

  /// The state of a row that makes a pill. Counted from `SessionSummary.statusTone`, never from the row's color:
  /// a result held after reading has the quiet tone, so it is not unread; an unread result with a background task
  /// that works has the working tone, so it does not count.
  public enum Attention: Sendable, Equatable, CaseIterable {
    case waiting
    case failed
    case unread

    /// `nil` for working, quiet and waiting on a background task.
    public init?(_ tone: StatusTone) {
      switch tone {
      case .waiting: self = .waiting
      case .failed: self = .failed
      case .unread: self = .unread
      case .working, .quiet, .backgroundWait: return nil
      }
    }
  }

  public enum Direction: Sendable, Equatable {
    case above
    case below
  }

  /// One row of the tree, in the collection's order: a project header or an agent row.
  public struct Row: Sendable, Equatable {
    public let id: ProjectTreeID
    /// `nil` for a header and for a session that does not need the human.
    public let attention: Attention?
    /// The session's name as the row shows it; the pill shows it when it counts one session.
    public let name: String

    public init(id: ProjectTreeID, attention: Attention?, name: String) {
      self.id = id
      self.attention = attention
      self.name = name
    }

    public static func project(_ cwd: String) -> Row { Row(id: .project(cwd), attention: nil, name: "") }

    public static func session(_ id: String, tone: StatusTone, name: String) -> Row {
      Row(id: .session(id), attention: Attention(tone), name: name)
    }
  }

  /// Measured heights of the two pills; before the first measurement the view passes its estimate.
  public struct PillHeights: Sendable, Equatable {
    public var above: CGFloat
    public var below: CGFloat

    public init(above: CGFloat, below: CGFloat) {
      self.above = above
      self.below = below
    }
  }

  /// One side's pill: how many rows of each state, the name at a count of one, and where a tap scrolls.
  public struct Side: Sendable, Equatable {
    public var waiting: Int
    public var failed: Int
    public var unread: Int
    /// The session's name when the side counts exactly one row, otherwise `nil`.
    public var name: String?
    /// The nearest row off screen (session id): below — the first under the visible part, above — the last over it.
    public var target: String

    public init(waiting: Int = 0, failed: Int = 0, unread: Int = 0, name: String? = nil, target: String) {
      self.waiting = waiting
      self.failed = failed
      self.unread = unread
      self.name = name
      self.target = target
    }

    public var count: Int { waiting + failed + unread }

    public func count(_ attention: Attention) -> Int {
      switch attention {
      case .waiting: waiting
      case .failed: failed
      case .unread: unread
      }
    }

    mutating func add(_ attention: Attention) {
      switch attention {
      case .waiting: waiting += 1
      case .failed: failed += 1
      case .unread: unread += 1
      }
    }
  }

  /// Both pills; `nil` on a side means no pill there.
  public struct Result: Sendable, Equatable {
    public var above: Side?
    public var below: Side?

    public init(above: Side? = nil, below: Side? = nil) {
      self.above = above
      self.below = below
    }

    public static let none = Result()
  }

  /// Both pills for the rows on screen now, or `nil` when the collection holds another tree than `rows` (another
  /// count of items or other ids): the caller keeps its previous result and counts again after the collection
  /// applies the rows.
  /// - Parameters:
  ///   - rows: the current tree rows with their states, in order.
  ///   - applied: the ids the collection really holds (from the rows' `onChange`).
  ///   - items: the number of items in the collection.
  ///   - frame: a row's extent from the collection's layout by item index; `nil` — the row is skipped.
  public static func evaluate(
    rows: [Row], applied: [ProjectTreeID], items: Int, frame: (Int) -> Span?, viewport: Viewport,
    pillHeights: PillHeights
  ) -> Result? {
    guard items == rows.count, rows.map(\.id) == applied else { return nil }
    let top = viewport.visibleTop
    let bottom = viewport.visibleBottom
    guard bottom > top else { return Result.none }
    let middle = (top + bottom) / 2

    var candidates: [(index: Int, attention: Attention, span: Span)] = []
    for (index, row) in rows.enumerated() {
      guard case .session = row.id, let attention = row.attention, let span = frame(index) else { continue }
      candidates.append((index, attention, span))
    }

    // Pass 1: rows off screen, by the side of their center.
    var above: [Int] = []
    var below: [Int] = []
    for candidate in candidates where !onScreen(candidate.span, top: top, bottom: bottom) {
      if center(candidate.span) > middle { below.append(candidate.index) } else { above.append(candidate.index) }
    }
    let belowTarget = below.first
    let aboveTarget = above.last

    // Pass 2: rows on screen that the pill of a side with a result would cover. Coverage does not depend on the
    // row's half: a tall pill in a short visible part reaches past the middle. A row both pills would cover goes to
    // the side of its center, so it counts once.
    for candidate in candidates where onScreen(candidate.span, top: top, bottom: bottom) {
      let coveredBelow = belowTarget != nil
        && !onScreen(candidate.span, top: top, bottom: bottom - pillHeights.below)
      let coveredAbove = aboveTarget != nil
        && !onScreen(candidate.span, top: top + pillHeights.above, bottom: bottom)
      switch (coveredAbove, coveredBelow) {
      case (true, true):
        if center(candidate.span) > middle { below.append(candidate.index) } else { above.append(candidate.index) }
      case (false, true): below.append(candidate.index)
      case (true, false): above.append(candidate.index)
      case (false, false): continue
      }
    }

    return Result(
      above: side(above, target: aboveTarget, rows: rows), below: side(below, target: belowTarget, rows: rows))
  }

  /// A row is on screen when at least half of the smaller of two heights, the row's and the visible part's, lies in
  /// the visible part (within the layout's half-point rounding): a tall row at a large text size that fills the whole
  /// visible part is on screen. A visible part of zero or negative height shows nothing.
  public static func onScreen(_ span: Span, top: CGFloat, bottom: CGFloat) -> Bool {
    guard bottom > top else { return false }
    let overlap = min(span.maxY, bottom) - max(span.minY, top)
    let needed = min(span.maxY - span.minY, bottom - top) / 2
    return overlap + TreeListAnchorMath.edgeTolerance >= needed
  }

  private static func center(_ span: Span) -> CGFloat { (span.minY + span.maxY) / 2 }

  private static func side(_ indices: [Int], target: Int?, rows: [Row]) -> Side? {
    guard let target, case let .session(targetID) = rows[target].id else { return nil }
    var side = Side(target: targetID)
    for index in indices {
      if let attention = rows[index].attention { side.add(attention) }
    }
    side.name = side.count == 1 ? rows[target].name : nil
    return side
  }

  /// A part of the pill's text and how the view colors it.
  public struct Segment: Sendable, Equatable {
    public enum Role: Sendable, Equatable {
      /// Text ink: the count of rows, the direction, separators.
      case plain
      /// The color of the state: waiting amber, failed red, unread blue.
      case state(Attention)
      /// The session's name: text ink, truncated at its end when the pill runs out of room.
      case name
    }

    public let text: String
    public let role: Role

    public init(_ text: String, _ role: Role) {
      self.text = text
      self.role = role
    }
  }
}
