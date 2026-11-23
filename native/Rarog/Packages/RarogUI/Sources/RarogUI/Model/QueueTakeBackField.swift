import Foundation
import RarogContract

/// The message field after a queue take-back: the taken texts one per line in queue order, before the text that
/// already stood in the field, as Claude Code puts its queue into the prompt field. The cursor is an offset in UTF-16
/// units (`NSString`, `UITextView.selectedRange`). Owner: send.
enum QueueTakeBackField {
  struct Result: Equatable {
    var text: String
    var cursor: Int
  }

  /// The taken texts as one block, one per line.
  static func taken(_ items: [QueueTakeBackItem]) -> String {
    items.map(\.text).joined(separator: "\n")
  }

  /// `tapped`: the `clientMessageId` of the tapped bubble. The cursor stands at the end of that item's text; without
  /// a tapped bubble (Up) or without a match it stands at the end of the field.
  static func merge(_ items: [QueueTakeBackItem], into field: String, tapped: String?) -> Result {
    guard !items.isEmpty else { return Result(text: field, cursor: (field as NSString).length) }
    let block = taken(items)
    let text = field.isEmpty ? block : "\(block)\n\(field)"
    guard let tapped, let index = items.firstIndex(where: { $0.clientMessageId == tapped }) else {
      return Result(text: text, cursor: (text as NSString).length)
    }
    let upTo = items[...index].map(\.text).joined(separator: "\n")
    return Result(text: text, cursor: (upTo as NSString).length)
  }
}
