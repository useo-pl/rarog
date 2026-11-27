import AppIntents
import RarogActivity

/// App Intents of the widget extension: the buttons the voice Live Activity draws (Stop or End,
/// `EndVoiceActivityIntent`, and Send, `SendDictationActivityIntent`, both performed in the app's process) come from
/// the `RarogActivity` package.
struct RarogWidgetIntents: AppIntentsPackage {
  static var includedPackages: [any AppIntentsPackage.Type] { [RarogActivityIntents.self] }
}
