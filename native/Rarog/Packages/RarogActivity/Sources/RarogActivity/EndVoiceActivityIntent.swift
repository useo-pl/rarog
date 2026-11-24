#if canImport(ActivityKit) && os(iOS)
import ActivityKit
import AppIntents

// The End (Stop for a dictation) button of the voice Live Activity. Owner: voice agent.
//
// A `LiveActivityIntent` runs in the app's process (Apple, WidgetKit, "Adding interactivity to widgets and Live
// Activities"), but this package does not see the app's microphone (`RarogUI`), so the app installs ``handler`` at
// launch. Ending only stops the recording and sends nothing, so the intent declares no unlock and opens no app.

/// Ends the running voice conversation or message-field dictation from its Live Activity.
public struct EndVoiceActivityIntent: LiveActivityIntent {
  public static let title: LocalizedStringResource = "End Voice Recording"
  /// Only the Live Activity's button runs it: not offered in Shortcuts or Spotlight.
  public static let isDiscoverable = false
  public static let openAppWhenRun = false
  /// Declares that it may run while the device is locked, without an unlock: it only stops the microphone.
  public static let authenticationPolicy = IntentAuthenticationPolicy.alwaysAllowed

  /// The app's end: stop what records and write its line. `nil` (no app wiring) = only the leftover activity ends.
  @MainActor public static var handler: (@MainActor () async -> Void)?

  public init() {}

  @MainActor
  public func perform() async throws -> some IntentResult {
    // The activities that stand at the press: the handler waits, and one a recording started meanwhile stays.
    let pressed = Self.activityIds()
    if let handler = Self.handler { await handler() }
    // The process may not run long after the microphone closes, so the activity ends here, before the return.
    await Self.end(pressed)
    return .result()
  }

  private nonisolated static func activityIds() -> [String] {
    Activity<VoiceActivityAttributes>.activities.map(\.id)
  }

  // `Activity` is not `Sendable`: the handles are looked up and ended in the same nonisolated context.
  private nonisolated static func end(_ ids: [String]) async {
    for activity in Activity<VoiceActivityAttributes>.activities where ids.contains(activity.id) {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }
}

/// The package's App Intents for the app and the widget extension (`AppIntentsPackage.includedPackages`).
public struct RarogActivityIntents: AppIntentsPackage {}
#endif
