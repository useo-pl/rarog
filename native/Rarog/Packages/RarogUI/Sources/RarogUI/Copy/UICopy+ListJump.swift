import Foundation
import RarogContract

// Texts of the jump pill of the session list (`Model/ListJumpPill.swift`). Owner: list.
extension UICopy {
  /// The pill's text in parts the view colors by role: the state phrases in the state's color, the rest in ink.
  /// One session: "1 waiting below ↓ · rotate keys"; several: "3 below ↓ · 1 waiting, 1 failed, 1 unread", with
  /// only the non-zero states, in the order waiting, failed, unread.
  static func listJumpSegments(
    _ side: ListJumpPill.Side, _ direction: ListJumpPill.Direction, language: CopyLanguage = .current
  ) -> [ListJumpPill.Segment] {
    let dot = ListJumpPill.Segment(L("app.list.dot", language: language), .plain)
    let parts = listJumpStateParts(side, language: language)
    if side.count == 1, let name = side.name, let part = parts.first {
      return listJumpOneHead(part, direction, language: language) + [dot, ListJumpPill.Segment(name, .name)]
    }
    let head =
      switch direction {
      case .below: L("list.jump.many.below", language: language, side.count)
      case .above: L("list.jump.many.above", language: language, side.count)
      }
    let comma = ListJumpPill.Segment(L("app.list.comma", language: language), .plain)
    var segments = [ListJumpPill.Segment(head, .plain), dot]
    for (index, part) in parts.enumerated() {
      if index > 0 { segments.append(comma) }
      segments.append(part)
    }
    return segments
  }

  /// The pill's VoiceOver label: "3 sessions below: 1 waiting, 1 failed, 1 unread"; one session adds its name
  /// ("1 session below: 1 waiting, rotate keys").
  static func listJumpSpoken(
    _ side: ListJumpPill.Side, _ direction: ListJumpPill.Direction, language: CopyLanguage = .current
  ) -> String {
    var items = listJumpStateParts(side, language: language).map(\.text)
    if side.count == 1, let name = side.name { items.append(name) }
    let detail = items.joined(separator: L("app.list.comma", language: language))
    return switch direction {
    case .below: L("list.jump.spoken.below", language: language, side.count, detail)
    case .above: L("list.jump.spoken.above", language: language, side.count, detail)
    }
  }

  /// The pill's VoiceOver hint: what a tap does.
  static func listJumpHint(language: CopyLanguage = .current) -> String { L("list.jump.hint", language: language) }

  /// "1 waiting", "2 failed", "5 unread" for every non-zero state, in the order waiting, failed, unread.
  private static func listJumpStateParts(_ side: ListJumpPill.Side, language: CopyLanguage) -> [ListJumpPill.Segment] {
    ListJumpPill.Attention.allCases.compactMap { attention in
      let count = side.count(attention)
      guard count > 0 else { return nil }
      let text =
        switch attention {
        case .waiting: L("list.jump.state.waiting", language: language, count)
        case .failed: L("list.jump.state.failed", language: language, count)
        case .unread: L("list.jump.state.unread", language: language, count)
        }
      return ListJumpPill.Segment(text, .state(attention))
    }
  }

  /// "1 waiting below ↓" with the state phrase as its own part. The word order belongs to the language, so the
  /// sentence is formatted with a marker in place of the phrase and cut around it; a translation without the
  /// parameter comes out whole, in ink.
  private static func listJumpOneHead(
    _ part: ListJumpPill.Segment, _ direction: ListJumpPill.Direction, language: CopyLanguage
  ) -> [ListJumpPill.Segment] {
    let format: (String) -> String = { phrase in
      switch direction {
      case .below: L("list.jump.one.below", language: language, phrase)
      case .above: L("list.jump.one.above", language: language, phrase)
      }
    }
    let marker = "\u{FFFC}"
    let pieces = format(marker).components(separatedBy: marker)
    guard pieces.count == 2 else { return [ListJumpPill.Segment(format(part.text), .plain)] }
    return [
      ListJumpPill.Segment(pieces[0], .plain), part, ListJumpPill.Segment(pieces[1], .plain),
    ].filter { !$0.text.isEmpty }
  }
}
