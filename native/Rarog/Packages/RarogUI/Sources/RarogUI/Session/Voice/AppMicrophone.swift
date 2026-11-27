import Foundation

// The app's one microphone (`DictationCenter`) for the app target, outside the app's screens: what records, what it
// does now and what it is about, every change of it, and the end and the Send from outside the screens. The voice Live
// Activity's controller in the app uses it. No UIKit here. Owner: voice agent.

/// What records on the app's one microphone, as the app target sees it.
@MainActor
public struct AppMicrophone {
  /// What records, what it does now and what it is about; the subject carries only a session's project and name.
  public struct Recording: Sendable, Equatable {
    /// A voice conversation or a message-field dictation.
    public enum Kind: Sendable, Equatable {
      case conversation
      case dictation
    }

    public let kind: Kind
    public let phase: MicrophonePhase
    public let subject: MicrophoneSubject
  }

  let center: DictationCenter

  /// The app's microphone (`DictationCenter.shared`).
  public static var shared: AppMicrophone { AppMicrophone(center: .shared) }

  /// What records now (`DictationCenter.use`); `nil` = nothing runs.
  public var recording: Recording? {
    center.use.map { Recording(kind: Self.kind($0.kind), phase: $0.phase, subject: $0.subject) }
  }

  /// Adds an observer of every claim and every change a host reports, for the center's life.
  public func observe(_ observer: @escaping @MainActor () -> Void) {
    center.observe(observer)
  }

  /// Ends what records as the user's own end does (`DictationCenter.endFromLockScreen()`): a dictation keeps its text
  /// in the field without sending. Returns what it ended; `nil` = nothing ran.
  @discardableResult
  public func endFromLockScreen() -> Recording.Kind? {
    center.endFromLockScreen().map(Self.kind)
  }

  /// Ends a message-field dictation as Send during it does: the last words land in the field, and the field goes to
  /// its session through the same send as Send on the screen, with the login of this moment
  /// (`DictationCenter.sendFromLockScreen()`). The task gives how it ended once the field's draft is on disk; a second
  /// call while it runs gets the same task. `nil` = nothing to send: no dictation records (a conversation, nothing).
  public func sendFromLockScreen() -> Task<LockScreenSend, Never>? {
    center.sendFromLockScreen()
  }

  private static func kind(_ kind: MicrophoneUse.Kind) -> Recording.Kind {
    switch kind {
    case .conversation: .conversation
    case .dictation: .dictation
    }
  }
}
