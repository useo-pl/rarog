import Foundation

// The reply field of one Inbox result card as dictation sees it (`VoiceTextTarget`). The field is a SwiftUI text field
// whose text lives in the screen's reply host (`InboxReplies`), so the target reads and writes through that host by
// the card's session id; dictation appends at the end of the field. No UIKit here, so the rule also runs in the macOS
// tests. The recording itself: `Views/Inbox/InboxDictation.swift`. Owner: Inbox.

/// One card's reply field seen by dictation.
@MainActor
final class InboxDictationTarget: VoiceTextTarget {
  /// The card's session: the field's key in the reply host.
  let sessionId: String
  private let read: @MainActor (String) -> String
  private let write: @MainActor (String, String) -> Void

  /// - Parameters:
  ///   - read: the field's text by session id (empty when the host has no field).
  ///   - write: puts the dictation's value into the field, as typed text.
  init(
    sessionId: String, read: @escaping @MainActor (String) -> String,
    write: @escaping @MainActor (String, String) -> Void
  ) {
    self.sessionId = sessionId
    self.read = read
    self.write = write
  }

  var text: String { read(sessionId) }

  /// The SwiftUI field exposes no marked text, so a write never waits for a composition; the Polish and English
  /// keyboards compose none.
  var isComposing: Bool { false }

  func writeDictation(_ value: String) {
    write(sessionId, value)
  }
}
