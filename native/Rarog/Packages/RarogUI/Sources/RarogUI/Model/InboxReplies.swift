import Foundation

// The reply fields of the Inbox result cards: the text of each field, the turn the person wrote it against and the
// sentence under it after a reply that did not go out. Pure values, tested on macOS (`InboxRepliesTests`); the
// screen's host (`Views/Inbox/InboxReplyHost.swift`) keeps them, persists the text in the session's draft
// (`ComposerDrafts`) and sends. Owner: Inbox.

/// One card's reply field.
public struct InboxReplyField: Sendable, Equatable {
  public var text: String
  /// The card's `turnId` when the text was written; `nil` while the field is empty. ↑ sends only while the card still
  /// shows this turn.
  public var turnId: String?
  /// Why the text came back, under the field; the next edit clears it.
  public var note: String?
  public var noteIsError = false

  public init(text: String = "", turnId: String? = nil, note: String? = nil, noteIsError: Bool = false) {
    self.text = text
    self.turnId = turnId
    self.note = note
    self.noteIsError = noteIsError
  }
}

/// The reply fields by session id.
public struct InboxReplies: Sendable, Equatable {
  public private(set) var fields: [String: InboxReplyField] = [:]

  public init() {}

  public func field(_ sessionId: String) -> InboxReplyField? {
    fields[sessionId]
  }

  /// The field of `sessionId` appears with the session's draft text under the turn its card shows; a field already
  /// here keeps what it has.
  public mutating func load(_ sessionId: String, draft: String, note: String?, shownTurn: String) {
    guard fields[sessionId] == nil else { return }
    fields[sessionId] = InboxReplyField(
      text: draft, turnId: draft.isEmpty ? nil : shownTurn, note: note, noteIsError: note != nil)
  }

  /// The person edited the text while the card showed `shownTurn`: the first character records the turn, an emptied
  /// field forgets it, and the sentence under the field goes.
  public mutating func edit(_ sessionId: String, text: String, shownTurn: String) {
    var field = fields[sessionId] ?? InboxReplyField()
    field.text = text
    field.note = nil
    field.noteIsError = false
    if text.isEmpty {
      field.turnId = nil
    } else if field.turnId == nil {
      field.turnId = shownTurn
    }
    fields[sessionId] = field
  }

  /// ↑: the text to send and the turn it answers, with the field emptied. `nil` = nothing to send (an empty field, or
  /// only spaces and new lines, which stay).
  public mutating func take(_ sessionId: String) -> (text: String, turnId: String)? {
    guard let field = fields[sessionId], let turnId = field.turnId,
      !field.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return nil }
    fields[sessionId] = InboxReplyField()
    return (field.text, turnId)
  }

  /// A reply that did not go out comes back on top of what the person typed since, with the sentence why. The text now
  /// answers the turn the card shows, which the person reads together with that sentence, so the next ↑ sends it.
  public mutating func giveBack(
    _ sessionId: String, text: String, note: String?, isError: Bool, shownTurn: String
  ) {
    var field = fields[sessionId] ?? InboxReplyField()
    if !text.isEmpty { field.text = field.text.isEmpty ? text : "\(text)\n\(field.text)" }
    field.turnId = field.text.isEmpty ? nil : shownTurn
    field.note = note
    field.noteIsError = isError
    fields[sessionId] = field
  }

  /// Texts that came into the session's draft while the field stood (a send that came back, a queue take-back) join
  /// the field before it writes the draft, on top, as on the session screen; their reason, when they bring one,
  /// stands under the field. An empty field takes the turn the card shows, so ↑ can send them.
  public mutating func placeWaiting(_ sessionId: String, text: String, note: String?, shownTurn: String) {
    guard !text.isEmpty else { return }
    var field = fields[sessionId] ?? InboxReplyField()
    field.text = field.text.isEmpty ? text : "\(text)\n\(field.text)"
    if field.turnId == nil { field.turnId = shownTurn }
    if let note {
      field.note = note
      field.noteIsError = true
    }
    fields[sessionId] = field
  }

  /// The sentence under a field after a send whose text did not come back to it.
  public mutating func setNote(_ sessionId: String, _ note: String, isError: Bool) {
    var field = fields[sessionId] ?? InboxReplyField()
    field.note = note
    field.noteIsError = isError
    fields[sessionId] = field
  }

  /// The field is read again from the session's draft when it next appears (the screen left, or the text went to the
  /// draft).
  public mutating func forget(_ sessionId: String) {
    fields[sessionId] = nil
  }

  public mutating func forgetAll() {
    fields = [:]
  }
}
