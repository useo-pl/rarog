import Foundation

// What the voice strip and the prompt block of an Inbox card show, without a view (`Views/Inbox/InboxVoice.swift`
// draws them): the strip's state with its tone and the moving side of its bars, and the read-along split of the
// block's text. Owner: Inbox. Tests: `InboxVoiceStripTests`.
//
// - The strip says the conversation's state (`UICopy.voiceAgentStatus`); while the app reads the block aloud it
//   says so instead, in the answer's tone with the output moving the bars. A muted microphone and the person's
//   speech over the reading keep their own state.
// - The split lights the block's text while its reading plays: the heard part, the word being said, the rest. The
//   heard prefix counts characters (`ReadingProgress.spokenPrefix`); a reading that ended, or no reading, shows the
//   text plain.

/// The state the voice strip of a card shows.
enum InboxVoiceStripState: Sendable, Equatable {
  case indicator(VoiceAgentIndicator)
  /// The app reads the prompt block aloud.
  case readingPrompt

  /// Opacity of the state's color under the strip's sentence, on the card's `surface`.
  static let tintAlpha = 0.14

  /// The strip's state for the conversation's `indicator` and its `block`; `nil` = no strip sentence.
  static func make(indicator: VoiceAgentIndicator?, block: InboxPromptBlock?) -> InboxVoiceStripState? {
    guard let indicator else { return nil }
    if block?.phase == .reading, indicator.isActive, indicator != .muted, indicator != .hearing {
      return .readingPrompt
    }
    return .indicator(indicator)
  }

  var tone: VoiceAgentIndicator.Tone {
    switch self {
    case let .indicator(indicator): indicator.tone
    case .readingPrompt: VoiceAgentIndicator.answering.tone
    }
  }

  var motion: VoiceAgentIndicator.Motion {
    switch self {
    case let .indicator(indicator): indicator.motion
    case .readingPrompt: VoiceAgentIndicator.answering.motion
    }
  }
}

/// The block's text split by its reading: the heard part, the word being said and the rest.
struct InboxPromptHighlight: Sendable, Equatable {
  let heard: String
  let now: String
  let rest: String

  /// `nil` = the text plain: no reading, a reading that ended, or every character heard.
  static func split(_ text: String, progress: ReadingProgress?) -> InboxPromptHighlight? {
    guard let progress, progress.end == nil else { return nil }
    let characters = Array(text)
    let heard = min(max(progress.spokenPrefix, 0), characters.count)
    guard heard < characters.count else { return nil }
    var start = heard
    if characters[start].isWhitespace {
      // Between words: the next word is the one being said.
      while start < characters.count, characters[start].isWhitespace { start += 1 }
      guard start < characters.count else { return nil }
    } else {
      // Inside a word: the whole word is the one being said.
      while start > 0, !characters[start - 1].isWhitespace { start -= 1 }
    }
    var end = start
    while end < characters.count, !characters[end].isWhitespace { end += 1 }
    return InboxPromptHighlight(
      heard: String(characters[..<start]), now: String(characters[start..<end]), rest: String(characters[end...]))
  }
}

extension InboxPromptBlock {
  /// The text the block shows: the person's edit while it is edited and while it goes, else the agent's text.
  var shownText: String { edited ?? text }
  /// The block shows the person's edit (its label says so and the read-along stays off).
  var showsEdit: Bool { phase == .editing || edited != nil }
}

extension VoiceAgentInboxConversation {
  /// The conversation of `cardId` runs or connects: the card's bottom row is the voice strip.
  func talks(_ cardId: String) -> Bool { isActive && target == cardId }
}
