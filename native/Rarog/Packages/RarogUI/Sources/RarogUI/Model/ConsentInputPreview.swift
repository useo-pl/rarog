import Foundation
import RarogContract

// Long input of a permission card: the server sends the whole input up to the hook's 1 MiB, and a
// SwiftUI text that long in a transcript cell costs seconds of layout. The card block shows a preview cut at a line
// end, and "Show Full Request" opens the whole text in a window (`ConsentInputSheet`, one `UITextView`). Approve stays
// on the card: the window is reading only. Until the window's content appeared for the card, its consent stays greyed
// (`PermissionCardModel.consentAwaitsFullInput`, ``FullInputMarks``). Pure logic, tested
// on macOS. Owner: cards.

/// The whole input of a card whose block shows a preview: the command and every field (`name: value`), one per line.
public struct ConsentFullInput: Sendable, Equatable {
  public let text: String
  /// Text lines (newline count + 1).
  public let lines: Int
}

/// The window with the whole input of one card (``AppSheet/consentInput(_:)``): a snapshot from the moment it opened.
/// Equal by `id`, the token of this presentation.
public struct ConsentInputRequest: Identifiable, Hashable, Sendable {
  public let id: UUID
  /// Tool name in the window title.
  public let toolName: String
  public let text: String
  /// Tells the session screen that opened this presentation that its content appeared, with `id` (``FullInputMarks``).
  private let appeared: @MainActor @Sendable (UUID) -> Void

  public init(
    id: UUID = UUID(), toolName: String, text: String,
    appeared: @escaping @MainActor @Sendable (UUID) -> Void = { _ in }
  ) {
    self.id = id
    self.toolName = toolName
    self.text = text
    self.appeared = appeared
  }

  /// The window's content is on screen (`ConsentInputSheet`, its `onAppear`): only then the card's consent unlocks.
  @MainActor
  public func contentAppeared() { appeared(id) }

  public static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
  public func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// Full-input windows of one session screen: the consent of a long request unlocks only
/// once the content of a window this screen opened for that card appeared. A window that stood only in the navigation
/// state and was closed or replaced before its content appeared marks nothing; so does a window a form kept out (it
/// never appears) and a presentation this screen did not open. Owner: cards.
public struct FullInputMarks: Sendable, Equatable {
  /// Windows this screen opened, by presentation id: the `permId` of the card each one shows.
  private var opened: [UUID: String] = [:]
  /// Cards whose window content appeared on this screen.
  private var read: Set<String> = []

  public init() {}

  /// The screen asks for `presentation`, the window with the whole input of card `permId`. Nothing unlocks yet.
  mutating func open(_ presentation: UUID, permId: String) { opened[presentation] = permId }

  /// The content of `presentation` appeared on screen: its card unlocks. `true` = a card unlocked now.
  @discardableResult
  mutating func appeared(_ presentation: UUID) -> Bool {
    guard let permId = opened[presentation] else { return false }
    return read.insert(permId).inserted
  }

  /// The window with the whole input of card `permId` appeared on this screen.
  public func contains(_ permId: String) -> Bool { read.contains(permId) }

  /// Keeps the windows and marks of the cards still pending (`live`) only.
  mutating func keep(_ live: Set<String>) {
    opened = opened.filter { live.contains($0.value) }
    read = read.filter { live.contains($0) }
  }
}

public enum ConsentInputPreview {
  /// Ceiling of one card text (the command or one field value) in UTF-8 bytes. Below `SyntaxHighlight.maxLength`,
  /// so a shell preview keeps its colors.
  public static let maxBytes = 32 * 1024

  /// The preview of `text`: the longest prefix within `maxBytes` that ends at a line end in the second half of the
  /// budget, otherwise (a long line, such as the escaped `content` of a `Write` in JSON) the longest prefix that ends at
  /// a character boundary. `nil` = the text fits whole.
  public static func preview(_ text: String, maxBytes: Int = maxBytes) -> String? {
    let utf8 = text.utf8
    guard utf8.count > maxBytes else { return nil }
    var end = utf8.index(utf8.startIndex, offsetBy: maxBytes)
    // `samePosition(in:)` is `nil` inside a character: step back to the nearest character boundary.
    while end > utf8.startIndex, end.samePosition(in: text) == nil { end = utf8.index(before: end) }
    let head = text[..<end]
    if let newline = head.lastIndex(of: "\n"), head[..<newline].utf8.count >= maxBytes / 2 {
      return String(head[..<newline])
    }
    return String(head)
  }

  /// The card's command and fields with previews, and the whole input when any of them was cut (`nil` = all whole).
  static func card(command: String, fields: [ConsentInputField], maxBytes: Int = maxBytes)
    -> (command: String, fields: [ConsentInputField], full: ConsentFullInput?) {
    let shortCommand = preview(command, maxBytes: maxBytes)
    let shortValues = fields.map { preview($0.value, maxBytes: maxBytes) }
    guard shortCommand != nil || shortValues.contains(where: { $0 != nil }) else { return (command, fields, nil) }
    let text = ([command] + fields.map { UICopy.consentField(name: $0.name, value: $0.value) }).joined(separator: "\n")
    let lines = text.utf8.reduce(1) { $1 == UInt8(ascii: "\n") ? $0 + 1 : $0 }
    let shownFields = zip(fields, shortValues).map { field, short in
      ConsentInputField(name: field.name, value: short ?? field.value)
    }
    return (shortCommand ?? command, shownFields, ConsentFullInput(text: text, lines: lines))
  }
}
