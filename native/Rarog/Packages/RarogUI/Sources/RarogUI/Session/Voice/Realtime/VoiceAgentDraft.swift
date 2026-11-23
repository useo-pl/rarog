import Foundation

// The prompt of the voice conversation in the message field, without a view: where `show_prompt` writes (the
// "Prompt in the field" rules) and how the prompt follows the edits of the field until a send takes it or it leaves
// the field. The session screen keeps one per conversation (`SessionViewController+VoiceAgent.swift`); ranges are in
// UTF-16 units, like `UITextView`. Owner: voice agent. Tests: `VoiceAgentDraftTests`.

/// "P": the prompt of the last `show_prompt` while it stands in the message field, as written or edited by the user
/// ("P'"). A send of the field (voice or ↑) takes it; an edit that covers it whole makes it gone.
struct VoiceAgentDraft: Sendable, Equatable {
  struct Prompt: Sendable, Equatable {
    /// The number `show_prompt` gave it in this conversation (`RealtimeConversation.promptVersion`).
    let version: Int
    /// Where it stands in the field.
    var range: NSRange
    /// The user changed its text (P'): the next prompt goes under it instead of taking its place.
    var edited: Bool

    init(version: Int, range: NSRange, edited: Bool) {
      self.version = version
      self.range = range
      self.edited = edited
    }
  }

  /// What `show_prompt` writes: the whole new text of the field, where the prompt went and its range.
  struct Insertion: Sendable, Equatable {
    let text: String
    let placement: RealtimePromptPlacement
    let range: NSRange
  }

  /// One edit of the field as the text view reports it before applying it: the range in the text before the edit
  /// and the new text there.
  struct Change: Sendable, Equatable {
    let range: NSRange
    let replacement: String
  }

  private(set) var prompt: Prompt?
  /// The field as the draft last saw it.
  private var field = ""

  init() {}

  /// The prompt with this version still stands in the field.
  func holds(version: Int) -> Bool { prompt?.version == version }

  /// The new text of the field with `text` as the prompt `version`. An untouched prompt at the end of the field gives
  /// way to the new one; otherwise the new one goes on a new line under the field, whose trailing whitespace becomes
  /// that one new line.
  mutating func place(_ text: String, version: Int, in field: String) -> Insertion {
    observe(field)
    var base = field as NSString
    var replaced = false
    if let prompt, !prompt.edited, NSMaxRange(prompt.range) == base.length {
      base = base.substring(to: prompt.range.location) as NSString
      replaced = true
    }
    var kept = base as String
    while let last = kept.last, last.isWhitespace { kept.removeLast() }
    let full: String
    let placement: RealtimePromptPlacement
    if kept.isEmpty {
      full = text
      placement = replaced ? .replacedAlone : .alone
    } else {
      full = kept + "\n" + text
      placement = replaced ? .replacedUnderUserText : prompt == nil ? .underUserText : .underEditedPrompt
    }
    let length = (text as NSString).length
    let range = NSRange(location: (full as NSString).length - length, length: length)
    prompt = Prompt(version: version, range: range, edited: false)
    self.field = full
    return Insertion(text: full, placement: placement, range: range)
  }

  /// The field after a change (typing, paste, text from code). The prompt moves with text inserted before it, becomes
  /// P' with an edit inside it or right at its end, and is gone when one edit covers it whole. `change`: the range the
  /// field reported for the edit, which decides (text from code reports the whole field); without one (an edit the
  /// text view does not report, a check before a send), or with one that does not turn the last seen field into `text`, the edit is read from the two
  /// texts, which takes a replacement of the whole prompt sharing its first or last characters for an edit inside
  /// it. `true` = it was there and is gone now.
  @discardableResult
  mutating func observe(_ text: String, change: Change? = nil) -> Bool {
    defer { field = text }
    guard var current = prompt else { return false }
    let edit: (location: Int, removed: Int, inserted: Int)
    if let change, let reported = Self.edit(change, from: field, to: text) {
      edit = reported
    } else {
      guard text != field else { return false }
      edit = Self.edit(from: field, to: text)
    }
    let start = current.range.location
    let end = NSMaxRange(current.range)
    let editEnd = edit.location + edit.removed
    let delta = edit.inserted - edit.removed
    if editEnd <= start {
      current.range.location += delta
    } else if edit.location <= start, editEnd >= end {
      prompt = nil
      return true
    } else if edit.location > end || (edit.location == end && edit.inserted == 0) {
      return false
    } else {
      let location = min(start, edit.location)
      current.range = NSRange(location: location, length: max(end, editEnd) + delta - location)
      current.edited = true
    }
    prompt = current
    return false
  }

  /// A send took the field with the prompt: text that comes back to the field is the user's.
  mutating func take() {
    prompt = nil
  }

  /// The conversation started or ended: no prompt of the agent in the field.
  mutating func reset() {
    self = VoiceAgentDraft()
  }

  /// The reported edit when it changes something and turns `old` into `new`; `nil` otherwise (UTF-16).
  static func edit(_ change: Change, from old: String, to new: String) -> (location: Int, removed: Int, inserted: Int)? {
    let before = old as NSString
    guard change.range.length > 0 || !change.replacement.isEmpty, NSMaxRange(change.range) <= before.length,
      before.replacingCharacters(in: change.range, with: change.replacement) == new
    else { return nil }
    return (change.range.location, change.range.length, (change.replacement as NSString).length)
  }

  /// One edit between two texts: the longest common prefix, then the longest common suffix of the rest (UTF-16).
  static func edit(from old: String, to new: String) -> (location: Int, removed: Int, inserted: Int) {
    let a = Array(old.utf16)
    let b = Array(new.utf16)
    var prefix = 0
    while prefix < a.count, prefix < b.count, a[prefix] == b[prefix] { prefix += 1 }
    var suffix = 0
    while suffix < a.count - prefix, suffix < b.count - prefix, a[a.count - 1 - suffix] == b[b.count - 1 - suffix] {
      suffix += 1
    }
    return (prefix, a.count - prefix - suffix, b.count - prefix - suffix)
  }
}
