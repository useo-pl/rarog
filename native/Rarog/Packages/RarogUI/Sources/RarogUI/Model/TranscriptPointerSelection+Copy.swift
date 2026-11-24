import Foundation

// What the pointer selection highlights and copies. The highlight ranges per row are the one source of both: the copy
// is the plain text (`MarkdownPlainText.copy`) of exactly those ranges, so the paste holds what the screen showed
// selected and nothing else (no role headers, cards, tools or pictures). Owner: transcript.

/// The selected part of one text row: UTF-16 range in the row's rendered text.
public struct TranscriptSelectedRange: Equatable, Sendable {
  public let row: String
  public let range: NSRange

  public init(row: String, range: NSRange) {
    self.row = row
    self.range = range
  }
}

extension TranscriptPointerSelection {
  /// The selected range of each text row between the start and the end, in list order. Rows that are not text and
  /// rows whose range is empty (a start at the very end of a row) are left out. Each boundary widens to whole
  /// characters, so an emoji or a letter with a combining mark is never split.
  public func ranges(in rows: [TranscriptSelectionRow]) -> [TranscriptSelectedRange] {
    guard !isEmpty, let (start, end) = ordered(in: rows),
          let first = rows.firstIndex(where: { $0.id == start.row }),
          let last = rows.firstIndex(where: { $0.id == end.row })
    else { return [] }
    var out: [TranscriptSelectedRange] = []
    for index in first ... last {
      guard let text = rows[index].text else { continue }
      let string = text.string as NSString
      let low = Self.characterStart(string, index == first ? start.offset : 0)
      let high = Self.characterEnd(string, index == last ? end.offset : string.length)
      guard high > low else { continue }
      out.append(TranscriptSelectedRange(row: rows[index].id, range: NSRange(location: low, length: high - low)))
    }
    return out
  }

  /// The text for the clipboard: the plain text of each highlighted range, rows of the same message joined with a
  /// newline, different messages with an empty line. `nil` = nothing is highlighted, so copying does nothing.
  public func copyText(in rows: [TranscriptSelectionRow]) -> String? {
    var byId: [String: TranscriptSelectionRow] = [:]
    for row in rows { byId[row.id] = row }
    var out = ""
    var previous: TranscriptSelectionRow?
    for selected in ranges(in: rows) {
      guard let row = byId[selected.row], let text = row.text else { continue }
      let piece = MarkdownPlainText.copy(text.attributedSubstring(from: selected.range))
      guard !piece.isEmpty else { continue }
      if let previous {
        let sameMessage = previous.message != nil && previous.message == row.message
        out += sameMessage ? "\n" : "\n\n"
      }
      out += piece
      previous = row
    }
    return out.isEmpty ? nil : out
  }

  /// The start of the character at `offset`, clamped to the text.
  static func characterStart(_ string: NSString, _ offset: Int) -> Int {
    let clamped = min(max(offset, 0), string.length)
    guard clamped > 0, clamped < string.length else { return clamped }
    return string.rangeOfComposedCharacterSequence(at: clamped).location
  }

  /// The end of the character that `offset` falls inside, or `offset` itself on a character boundary.
  static func characterEnd(_ string: NSString, _ offset: Int) -> Int {
    let clamped = min(max(offset, 0), string.length)
    guard clamped > 0, clamped < string.length else { return clamped }
    let character = string.rangeOfComposedCharacterSequence(at: clamped)
    return character.location == clamped ? clamped : NSMaxRange(character)
  }
}
