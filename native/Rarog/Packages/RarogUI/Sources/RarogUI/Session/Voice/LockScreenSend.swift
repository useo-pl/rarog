import Foundation

// The Send of a message-field dictation from outside the app's screens (`DictationCenter.sendFromLockScreen()`): what
// the press ends with, and the handover of the field's send to the press's operation once the last words are in the
// field. The send itself is the field's one send (`SessionViewController.sendField`). No UIKit here, so the rules run
// in the macOS tests. Owner: dictation.

/// How a Send from outside the app's screens ended, as the Lock Screen can say it.
public enum LockScreenSend: Sendable, Equatable {
  /// The server took the message.
  case sent
  /// The server took the message; it waits in the CLI queue for the end of the running turn.
  case queued
  /// Nothing went to the session; the text stays in the app (the field, the draft).
  case notSent
  /// Not known whether the message arrived; its entry waits in the send queue for "Retry".
  case unconfirmed

  /// What the field's send gave; `nil` = no send went (the field went away with its screen).
  init(_ result: ComposerSendResult?) {
    switch result {
    case .accepted(queued: false)?: self = .sent
    case .accepted(queued: true)?: self = .queued
    case .unconfirmed?, .stopped?: self = .unconfirmed
    case .refused?, .blocked?, .notSent?, .readOnly?, .appCommand?, .attachmentsLoading?, .attachmentsOverLimit?, nil:
      self = .notSent
    }
  }

  /// The `client.log` line of the result: one word, never the text.
  var traceLine: String {
    let word =
      switch self {
      case .sent: "sent"
      case .queued: "queued"
      case .notSent: "not-sent"
      case .unconfirmed: "unconfirmed"
      }
    return "dictation: live activity send \(word)"
  }
}

/// The field's send a Send from outside the screens waits for: given once, when the last words are in the field (or
/// `nil`: no send went). The operation may ask before or after it is given; a second give changes nothing.
@MainActor
final class FieldSendHandover {
  private var given = false
  private var send: Task<ComposerSendResult, Never>?
  private var waiters: [CheckedContinuation<Task<ComposerSendResult, Never>?, Never>] = []

  func give(_ send: Task<ComposerSendResult, Never>?) {
    guard !given else { return }
    given = true
    self.send = send
    let waiting = waiters
    waiters = []
    for waiter in waiting { waiter.resume(returning: send) }
  }

  /// The send once it is given.
  func value() async -> Task<ComposerSendResult, Never>? {
    if given { return send }
    return await withCheckedContinuation { waiters.append($0) }
  }
}
