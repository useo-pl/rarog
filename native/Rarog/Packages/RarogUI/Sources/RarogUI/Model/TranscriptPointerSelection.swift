import Foundation

// One pointer selection over transcript rows (trackpad or mouse press and drag), kept by row id and UTF-16 offset
// instead of the system selection of one text view, so it can span many messages and survive cell reuse. A pure model:
// the screen hands it a snapshot of the rows in list order with their rendered text, and asks it for the ordered
// bounds, the highlight ranges per row and the copy text (`TranscriptPointerSelection+Copy.swift`). The edge autoscroll
// curve: `TranscriptPointerSelection+Autoscroll.swift`. The gestures and the highlight live on the session screen.
// Owner: transcript.

/// A place in the text of one transcript row: row id and UTF-16 offset into the row's rendered text.
public struct TranscriptTextPoint: Hashable, Sendable {
  public let row: String
  public let offset: Int

  public init(row: String, offset: Int) {
    self.row = row
    self.offset = offset
  }
}

/// One transcript row as the selection sees it, in list order. Built by the screen, which owns the renderer; rows off
/// screen carry their text as well (from the renderer's cache).
public struct TranscriptSelectionRow {
  public enum Kind: Equatable, Sendable {
    /// A text row (`m<seq>.<block>`, `open`, a queued prompt `o<uuid>`): selectable, part of the copy.
    case text
    /// A card, tool, marker or media row: never selected; a focus over it snaps to a text row.
    case other
  }

  public let id: String
  /// The message `seq`. Text rows with the same non-nil `message` join with one newline in the copy; a row without it
  /// (the streaming answer, a queued prompt) is always a message of its own.
  public let message: Int?
  public let kind: Kind
  /// The rendered text; non-nil exactly for ``Kind/text``.
  public let text: NSAttributedString?

  public static func text(id: String, message: Int?, text: NSAttributedString) -> TranscriptSelectionRow {
    TranscriptSelectionRow(id: id, message: message, kind: .text, text: text)
  }

  public static func other(id: String, message: Int? = nil) -> TranscriptSelectionRow {
    TranscriptSelectionRow(id: id, message: message, kind: .other, text: nil)
  }

  var length: Int { text?.length ?? 0 }
}

/// Where the pointer is while dragging, as the screen resolves it against the list.
public enum TranscriptPointerTarget: Equatable, Sendable {
  /// Over the text field of a row at this offset. A row that is not text (or unknown) counts as ``row(_:)``.
  case text(TranscriptTextPoint)
  /// Over a row but not over text in it: a card, a tool, a marker, or the margin of a text row.
  case row(String)
  /// In the gap between the row with this id and the next one.
  case gap(after: String)
  /// Above the first row.
  case aboveRows
  /// Below the last row.
  case belowRows
}

/// The pointer selection: the anchor stays where the press began, the focus follows the pointer. Each point keeps the
/// UTF-16 text of its row up to its offset, so a new snapshot whose text before the point changed drops the selection
/// (``validated(in:)``) instead of highlighting other text.
public struct TranscriptPointerSelection: Equatable {
  public private(set) var anchor: TranscriptTextPoint
  public private(set) var focus: TranscriptTextPoint
  private var anchorPrefix: [UInt16]
  private var focusPrefix: [UInt16]
  /// The highest message `seq` in the last snapshot the selection saw: a streaming answer that vanishes moves only
  /// onto a message newer than that.
  private var seenMessage: Int?
  /// The whole UTF-16 text of the streaming answer (`open`) in the last snapshot the selection saw: the message it
  /// closes into starts with it, and a new streaming answer does not.
  private var answerText: [UInt16]?

  /// A selection that starts at `point`; `nil` when the row is missing from the snapshot or is not text. The offset is
  /// clamped to the row's text.
  public init?(at point: TranscriptTextPoint, in rows: [TranscriptSelectionRow]) {
    guard let row = rows.first(where: { $0.id == point.row }), let text = row.text else { return nil }
    let start = TranscriptTextPoint(row: point.row, offset: min(max(point.offset, 0), text.length))
    anchor = start
    focus = start
    anchorPrefix = Self.prefix(text, start.offset)
    focusPrefix = anchorPrefix
    seenMessage = Self.newestMessage(rows)
    answerText = Self.answer(in: rows)
  }

  /// Anchor and focus coincide: nothing is selected.
  public var isEmpty: Bool { anchor == focus }

  /// Moves the focus to the pointer. Over a row that is not text or in a gap, the focus stands at the end of the
  /// nearest earlier text row when the pointer is after the anchor, at the start of the nearest later one when it is
  /// before; above all rows at the start of the first text row, below all rows at the end of the last. A target the
  /// snapshot does not know, or a snapshot without the anchor row, leaves the selection as it was. Run
  /// ``validated(in:)`` on every new snapshot first: only it moves points and records the newest message.
  public mutating func extend(to target: TranscriptPointerTarget, in rows: [TranscriptSelectionRow]) {
    guard let anchorIndex = rows.firstIndex(where: { $0.id == anchor.row }) else { return }
    guard let point = Self.resolve(target, anchorIndex: anchorIndex, in: rows) else { return }
    guard let text = rows.first(where: { $0.id == point.row })?.text else { return }
    focus = point
    focusPrefix = Self.prefix(text, point.offset)
  }

  /// Anchor and focus in list order; `nil` when a point's row is missing from the snapshot.
  public func ordered(in rows: [TranscriptSelectionRow]) -> (start: TranscriptTextPoint, end: TranscriptTextPoint)? {
    guard let a = rows.firstIndex(where: { $0.id == anchor.row }),
          let f = rows.firstIndex(where: { $0.id == focus.row })
    else { return nil }
    let anchorFirst = a < f || (a == f && anchor.offset <= focus.offset)
    return anchorFirst ? (anchor, focus) : (focus, anchor)
  }

  /// The selection against a new snapshot. Each point's row must still exist, be text and start with the same text up
  /// to the point; otherwise the selection disappears (`nil`). Points on the streaming answer (`open`) move together,
  /// at the same offset, onto the row the answer closed into (``closedAnswer(in:)``), also when the same snapshot
  /// already streams a new answer.
  public func validated(in rows: [TranscriptSelectionRow]) -> TranscriptPointerSelection? {
    let closed = closedAnswer(in: rows)
    guard let newAnchor = relocate(anchor, prefix: anchorPrefix, closed: closed, in: rows),
          let newFocus = relocate(focus, prefix: focusPrefix, closed: closed, in: rows)
    else { return nil }
    var next = self
    next.anchor = newAnchor
    next.focus = newFocus
    next.seenMessage = Self.newestMessage(rows) ?? seenMessage
    next.answerText = Self.answer(in: rows)
    return next
  }

  // MARK: - Internals

  static let openRow = "open"

  private func relocate(
    _ point: TranscriptTextPoint, prefix: [UInt16], closed: String?, in rows: [TranscriptSelectionRow]
  ) -> TranscriptTextPoint? {
    if point.row == Self.openRow, let closed { return TranscriptTextPoint(row: closed, offset: point.offset) }
    guard let text = rows.first(where: { $0.id == point.row })?.text, Self.starts(text, with: prefix) else { return nil }
    return point
  }

  /// The row the streaming answer closed into, found by the answer's own text rather than by the points' prefixes (a
  /// point at its start has an empty prefix that fits any row): the first text row of a message newer than the last
  /// snapshot that starts with the whole answer text of that snapshot. `nil` when no point is on the answer, when
  /// `open` still continues that text (the same answer, still streaming), or when no row qualifies; then a point on
  /// `open` stays only if `open` still starts with its prefix (a re-render that shortened the tail).
  private func closedAnswer(in rows: [TranscriptSelectionRow]) -> String? {
    guard anchor.row == Self.openRow || focus.row == Self.openRow, let answerText else { return nil }
    if let open = rows.first(where: { $0.id == Self.openRow })?.text, Self.starts(open, with: answerText) {
      return nil
    }
    return rows.first { row in
      guard let message = row.message, let text = row.text else { return false }
      if let seenMessage, message <= seenMessage { return false }
      return Self.starts(text, with: answerText)
    }?.id
  }

  private static func answer(in rows: [TranscriptSelectionRow]) -> [UInt16]? {
    rows.first { $0.id == openRow }?.text.map { Array($0.string.utf16) }
  }

  private static func resolve(
    _ target: TranscriptPointerTarget, anchorIndex: Int, in rows: [TranscriptSelectionRow]
  ) -> TranscriptTextPoint? {
    switch target {
    case let .text(point):
      guard let index = rows.firstIndex(where: { $0.id == point.row }) else { return nil }
      guard let text = rows[index].text else { return resolve(.row(point.row), anchorIndex: anchorIndex, in: rows) }
      return TranscriptTextPoint(row: point.row, offset: min(max(point.offset, 0), text.length))
    case let .row(id):
      guard let index = rows.firstIndex(where: { $0.id == id }) else { return nil }
      if rows[index].kind == .text {
        if index == anchorIndex { return nil }
        return index > anchorIndex ? end(of: rows[index]) : start(of: rows[index])
      }
      return index > anchorIndex
        ? lastText(in: rows, through: index - 1) : firstText(in: rows, from: index + 1)
    case let .gap(after: id):
      guard let index = rows.firstIndex(where: { $0.id == id }) else { return nil }
      return index >= anchorIndex ? lastText(in: rows, through: index) : firstText(in: rows, from: index + 1)
    case .aboveRows:
      return firstText(in: rows, from: 0)
    case .belowRows:
      return lastText(in: rows, through: rows.count - 1)
    }
  }

  private static func start(of row: TranscriptSelectionRow) -> TranscriptTextPoint {
    TranscriptTextPoint(row: row.id, offset: 0)
  }

  private static func end(of row: TranscriptSelectionRow) -> TranscriptTextPoint {
    TranscriptTextPoint(row: row.id, offset: row.length)
  }

  private static func firstText(in rows: [TranscriptSelectionRow], from index: Int) -> TranscriptTextPoint? {
    guard index < rows.count else { return nil }
    return rows[max(index, 0)...].first { $0.kind == .text }.map(start(of:))
  }

  private static func lastText(in rows: [TranscriptSelectionRow], through index: Int) -> TranscriptTextPoint? {
    guard index >= 0, !rows.isEmpty else { return nil }
    return rows[...min(index, rows.count - 1)].last { $0.kind == .text }.map(end(of:))
  }

  private static func newestMessage(_ rows: [TranscriptSelectionRow]) -> Int? {
    rows.compactMap(\.message).max()
  }

  /// UTF-16 units, not `String`: an offset between the halves of a surrogate pair must compare exactly.
  private static func prefix(_ text: NSAttributedString, _ offset: Int) -> [UInt16] {
    Array(text.string.utf16.prefix(offset))
  }

  private static func starts(_ text: NSAttributedString, with prefix: [UInt16]) -> Bool {
    let units = text.string.utf16
    guard units.count >= prefix.count else { return false }
    return units.prefix(prefix.count).elementsEqual(prefix)
  }
}
