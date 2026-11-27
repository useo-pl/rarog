#if canImport(ActivityKit) && os(iOS)
import AppIntents

// The Send button of the dictation's voice Live Activity. Owner: voice agent.
//
// Like the Stop button (`EndVoiceActivityIntent`), it runs in the app's process, reaches the app's microphone
// through ``handler``, which the app installs at launch, and carries the id of the activity it stands on
// (``activityID``). The handler returns once the send has started, not with its outcome. The intent does not end the
// activity itself: the app shows the send and its outcome on it.

/// Ends the message-field dictation and sends the message field to its session, from the dictation's Live Activity.
public struct SendDictationActivityIntent: LiveActivityIntent {
  public static let title: LocalizedStringResource = "Send Dictation"
  /// Only the Live Activity's button runs it: not offered in Shortcuts or Spotlight.
  public static let isDiscoverable = false
  public static let openAppWhenRun = false
  /// Declares that it may run while the device is locked.
  public static let authenticationPolicy = IntentAuthenticationPolicy.alwaysAllowed

  /// The app's send for the pressed activity's id: start ending and sending the dictation, return once it runs.
  /// `nil` (no app wiring) = nothing.
  @MainActor public static var handler: (@MainActor (_ activityID: String?) async -> Void)?

  /// The id of the activity whose button runs the intent (`ActivityViewContext.activityID`).
  @Parameter(title: "Activity")
  public var activityID: String?

  public init() {}

  public init(activityID: String) {
    self.activityID = activityID
  }

  @MainActor
  public func perform() async throws -> some IntentResult {
    if let handler = Self.handler { await handler(activityID) }
    return .result()
  }
}
#endif
