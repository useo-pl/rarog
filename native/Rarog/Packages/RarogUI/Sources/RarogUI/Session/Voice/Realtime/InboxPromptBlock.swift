import Foundation

// The prompt block of the voice conversation at an Inbox card, without a view: the prompt `show_prompt` puts in its
// own block above the voice strip, which the app reads aloud exactly as written, the person edits in place, and its
// Send button or the model's `send_prompt` sends to the card's turn. Owner: voice agent. Tests:
// `InboxPromptBlockTests`. A send the person did not hear whole cannot go out by voice, so every doubt about the voice
// lock ends in a refusal with nothing sent, and nothing goes out twice.
//
// - No block is `nil` at the owner. `show_prompt` over no block, a reading or a ready block makes the next version
//   (1 over none) with the new text and turn and starts its reading; editing and sending refuse it, and so does a text
//   longer than ``maxCharacters``, the limit of one reading. A refused show leaves the block as it was, except that
//   a text too long over a reading or ready block withdraws the standing version from a voice send: the model meant
//   to replace it, so voice needs a new show; the block and its Send button stay.
// - The reading's end counts only for the version being read and only while it reads: read whole makes the version
//   heard whole, a cut or a reading that did not play leaves it unheard. Edit and Send during the reading stop it
//   (the owner stops the playback), and the version stays unheard.
// - Edit turns the block into its own text field with the agent's text, Cancel goes back to the agent's text. A ready
//   block never holds the person's text, so a voice send sends only what was read.
// - The Send button sends from every phase but sending; `send_prompt` sends a ready version only when it was heard
//   whole, the model's response is not the one that showed it, no later show was refused, the person spoke after
//   the reading, the login of the start holds, and no send of this version reached sending before (a button send
//   counts). Each send carries the turn of its show and a ticket id from the owner.
// - A send's outcome counts only for the send in flight with the same ticket, so the outcome of an older send, also
//   one of a block that ended, never changes a newer block. The outcomes follow the field's recovery
//   (`SendRecovery`): accepted or queued drops the block; the text back in the field puts the block back in ready, or
//   in editing when the person's text went, with the reason; an entry kept in the transcript drops the block; a draft
//   drops the block and hands its text back.
// - The end of the conversation drops the block and hands back the person's text, or else the agent's; a send in
//   flight keeps its text to its own recovery.

/// The prompt of a card's voice conversation in its block.
struct InboxPromptBlock: Sendable, Equatable {
  enum Phase: Sendable, Equatable {
    /// The app reads the version aloud.
    case reading
    case ready
    /// The block is a text field with ``edited``.
    case editing
    /// A send of the block is in flight (``inFlight``).
    case sending
  }

  /// How the app's reading of a version ended.
  enum ReadEnd: Sendable, Equatable {
    /// Every character was said and played.
    case whole
    /// The person's speech cut it.
    case cut
    /// It did not play out: no audio, the stream limit, the playback lost.
    case notRead
  }

  /// Why `show_prompt` shows nothing, with its `client.log` code.
  enum ShowRefusal: String, Sendable, Equatable {
    case tooLong = "too-long"
    /// The person edits the block.
    case editing
    case sending
  }

  /// Why `send_prompt` sends nothing, with its `client.log` code.
  enum VoiceSendRefusal: String, Error, Sendable, Equatable {
    /// The login of the start no longer holds.
    case loggedOut = "logged-out"
    case sending
    case editing
    /// The response that showed the prompt sends it: the person has not answered.
    case sameResponse = "same-response"
    /// The reading still runs.
    case reading
    /// The version was not heard to its end: it must be shown again.
    case notHeardWhole = "not-heard-whole"
    /// A later `show_prompt` was refused: the version goes by voice only after a new show.
    case withdrawn
    /// The person has not spoken since the reading.
    case notConfirmed = "not-confirmed"
    /// A send of this version already reached sending.
    case attempted
  }

  /// One send of the block: what goes to the card's reply, and the ticket its outcome brings back.
  struct Send: Sendable, Equatable {
    /// The owner's id of this send.
    let id: UUID
    let version: Int
    let text: String
    /// The card's turn at the show.
    let turnId: String
  }

  /// What the owner does after a send's outcome.
  enum Settlement: Sendable, Equatable {
    /// Not the send in flight of this block: the block stays as it is; the text finds its way by the field's rule.
    case notMine
    /// Accepted or queued: the block is gone, and the strip says the prompt was sent.
    case sent
    /// The text came back: the block stands again with it and the reason.
    case restored
    /// The entry stays in the transcript with Retry: the block is gone, and the text lives in the entry.
    case keptInTranscript
    /// The block is gone, and its text goes to the card's field or to the session's draft.
    case handOver(String)
  }

  /// The longest prompt `show_prompt` takes, in characters: one reading is one Soniox stream.
  static let maxCharacters = VoiceAgentSessionsHost.promptMaxCharacters

  /// The agent's text of this version.
  private(set) var text: String
  /// The person's text while editing, and while sending it; `nil` otherwise.
  private(set) var edited: String?
  /// The card's turn at the show; edits keep it.
  private(set) var turnId: String
  /// The show's number in this block's life, from 1.
  private(set) var version: Int
  /// This version's reading played out whole and no Edit or Send stopped it.
  private(set) var heardWhole = false
  private(set) var phase = Phase.reading
  /// The reason a send came back with; a new send or version drops it.
  private(set) var reason: String?
  /// The send in flight, exactly while ``phase`` is sending.
  private(set) var inFlight: Send?
  /// The model's response that showed this version.
  private var response: String
  /// A send of this version reached sending.
  private var attempted = false
  /// A later `show_prompt` over this version was refused for its length.
  private var withdrawn = false
  /// The send in flight left editing.
  private var sentFromEditing = false

  private init(text: String, turnId: String, version: Int, response: String) {
    self.text = text
    self.turnId = turnId
    self.version = version
    self.response = response
  }

  /// `show_prompt` of `text` at the card's turn `turnId` by the model's response `response`: on success `block` is
  /// the next version, reading, and the owner reads its text; a refusal leaves `block` as it was, but one for the
  /// length withdraws the standing version from a voice send.
  static func show(_ text: String, turnId: String, response: String, on block: inout Self?) -> ShowRefusal? {
    switch block?.phase {
    case .editing: return .editing
    case .sending: return .sending
    case .reading, .ready, nil: break
    }
    guard text.count <= maxCharacters else {
      block?.withdrawn = true
      return .tooLong
    }
    block = Self(text: text, turnId: turnId, version: (block?.version ?? 0) + 1, response: response)
    return nil
  }

  /// The reading of `version` ended with `end`.
  mutating func readingEnded(version: Int, _ end: ReadEnd) {
    guard phase == .reading, version == self.version else { return }
    heardWhole = end == .whole
    phase = .ready
  }

  /// Edit: the block becomes a text field with the agent's text. `true`: it was reading, and the owner stops the
  /// reading now.
  @discardableResult
  mutating func edit() -> Bool {
    switch phase {
    case .reading:
      heardWhole = false
    case .ready:
      break
    case .editing, .sending:
      return false
    }
    let wasReading = phase == .reading
    edited = text
    phase = .editing
    return wasReading
  }

  /// The person's text in the field while editing.
  mutating func editText(_ text: String) {
    guard phase == .editing else { return }
    edited = text
  }

  /// Cancel: back to the agent's text; heard whole stays as it was.
  mutating func cancelEdit() {
    guard phase == .editing else { return }
    edited = nil
    phase = .ready
  }

  /// The block's Send button, with the owner's ticket `id`: the agent's text, or the person's while editing. `nil`: a
  /// send is in flight. `stopsReading`: it was reading, and the owner stops the reading now.
  mutating func send(id: UUID) -> (send: Send, stopsReading: Bool)? {
    switch phase {
    case .sending:
      return nil
    case .reading:
      heardWhole = false
      return (begin(id), true)
    case .ready, .editing:
      return (begin(id), false)
    }
  }

  /// The model's `send_prompt` in `response`, with the owner's ticket `id`. `utteranceAfterReading`: the person spoke
  /// after the reading ended; `loggedIn`: the login of the conversation's start holds.
  mutating func sendByVoice(
    id: UUID, response: String, utteranceAfterReading: Bool, loggedIn: Bool
  ) -> Result<Send, VoiceSendRefusal> {
    guard loggedIn else { return .failure(.loggedOut) }
    switch phase {
    case .sending: return .failure(.sending)
    case .editing: return .failure(.editing)
    case .reading, .ready: break
    }
    // The show's own response meets the reading still running; the model must hear that the person has to answer.
    guard response != self.response else { return .failure(.sameResponse) }
    guard phase == .ready else { return .failure(.reading) }
    guard heardWhole else { return .failure(.notHeardWhole) }
    guard !withdrawn else { return .failure(.withdrawn) }
    guard utteranceAfterReading else { return .failure(.notConfirmed) }
    guard !attempted else { return .failure(.attempted) }
    return .success(begin(id))
  }

  /// The outcome of `send` as the field's recovery plans it (`SendRecovery.plan`), with the reason the field would
  /// show for a text that came back.
  static func settle(_ block: inout Self?, send: Send, _ recovery: SendRecovery, reason: String?) -> Settlement {
    guard var current = block, current.phase == .sending, current.inFlight == send else { return .notMine }
    switch recovery {
    case .none:
      block = nil
      return .sent
    case .restoreToField:
      current.phase = current.sentFromEditing ? .editing : .ready
      current.inFlight = nil
      current.reason = reason
      block = current
      return .restored
    case .keepEntry:
      block = nil
      return .keptInTranscript
    case .saveDraft:
      block = nil
      return .handOver(send.text)
    }
  }

  /// The end of the conversation: the block goes; the text to hand back, `nil` while a send is in flight.
  static func end(_ block: inout Self?) -> String? {
    defer { block = nil }
    guard let current = block, current.phase != .sending else { return nil }
    return current.edited ?? current.text
  }

  private mutating func begin(_ id: UUID) -> Send {
    let send = Send(id: id, version: version, text: edited ?? text, turnId: turnId)
    sentFromEditing = phase == .editing
    phase = .sending
    inFlight = send
    attempted = true
    reason = nil
    return send
  }
}
