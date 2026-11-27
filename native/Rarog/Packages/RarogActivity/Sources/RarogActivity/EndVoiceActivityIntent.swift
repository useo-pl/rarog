#if canImport(ActivityKit) && os(iOS)
import ActivityKit
import AppIntents

// The End (Stop for a dictation) button of the voice Live Activity. Owner: voice agent.
//
// A `LiveActivityIntent` runs in the app's process (Apple, WidgetKit, "Adding interactivity to widgets and Live
// Activities"), but this package does not see the app's microphone (`RarogUI`), so the app installs ``handler`` at
// launch. Ending only stops the recording and sends nothing, so the intent declares no unlock and opens no app. The
// button carries the id of the activity it stands on (``activityID``): the app acts only on its current activity, so
// a press on an older one does not end a recording that started since.

/// Ends the running voice conversation or message-field dictation from its Live Activity.
public struct EndVoiceActivityIntent: LiveActivityIntent {
  public static let title: LocalizedStringResource = "End Voice Recording"
  /// Only the Live Activity's button runs it: not offered in Shortcuts or Spotlight.
  public static let isDiscoverable = false
  public static let openAppWhenRun = false
  /// Declares that it may run while the device is locked, without an unlock: it only stops the microphone.
  public static let authenticationPolicy = IntentAuthenticationPolicy.alwaysAllowed

  /// The app's end for the pressed activity's id: stop what records and write its line, then end the activities it
  /// decides on. `nil` (no app wiring) = only the pressed activity ends.
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
    // The handler ends what it decides on before it returns, while the process still runs: an activity that shows a
    // send on its way is the app's to end, not this button's.
    if let handler = Self.handler {
      await handler(activityID)
    } else if let activityID {
      await Self.end(activityID)
    }
    return .result()
  }

  // `Activity` is not `Sendable`: the handle is looked up and ended in the same nonisolated context.
  private nonisolated static func end(_ id: String) async {
    for activity in Activity<VoiceActivityAttributes>.activities where activity.id == id {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }
}

/// The package's App Intents for the app and the widget extension (`AppIntentsPackage.includedPackages`).
public struct RarogActivityIntents: AppIntentsPackage {}
#endif
