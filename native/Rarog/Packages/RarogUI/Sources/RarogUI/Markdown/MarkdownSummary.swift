import Foundation

// The summary an agent puts in its reply: a paragraph that starts with a bold marker ("TLDR:" or "TL;DR:"), on its
// own or as the first block of a quote (`> **TLDR:** …`). One definition of the rule; ``MarkdownFold`` reads it to
// lead a collapsed card with the summary instead of the first paragraph. Only a top-level block counts: a marker
// in a list item, a heading, a code block or a quote inside a quote is a quotation or an example, not the summary.
// The bold-marker check is the one ``MarkdownQuestion/start(in:)`` makes for the question marker.
// Owner: transcript, markdown.
public enum MarkdownSummary {
  /// The markers literally, with the colon and the letter case.
  public static let markers = ["TLDR:", "TL;DR:"]

  /// Index of the first top-level block that is the summary: a paragraph whose first inline fragment is bold and
  /// starts with a marker (`**TLDR:** …`, `__TL;DR:__ …`), or a quote whose first block is such a paragraph.
  /// After a single line break the marker sits inside the paragraph, so it does not count. `nil` = no summary.
  public static func start(in blocks: [MarkdownBlock]) -> Int? {
    blocks.firstIndex { block in
      switch block {
      case let .paragraph(text):
        return opensWithMarker(text)
      case let .quote(inner):
        guard case let .paragraph(text)? = inner.first else { return false }
        return opensWithMarker(text)
      default:
        return false
      }
    }
  }

  /// The marker stands literally at the start of the source, right after the bold characters, and the first inline
  /// fragment is bold and starts with that same marker. The literal check comes first because the inline parser
  /// drops escapes: `**TLDR\:**` would otherwise give a bold "TLDR:".
  private static func opensWithMarker(_ text: String) -> Bool {
    let source = text.drop(while: { $0 == "*" || $0 == "_" })
    guard let marker = markers.first(where: { source.hasPrefix($0) }),
      let first = MarkdownInlineParser.spans(text).first
    else { return false }
    return first.style.contains(.bold) && first.text.hasPrefix(marker)
  }
}
