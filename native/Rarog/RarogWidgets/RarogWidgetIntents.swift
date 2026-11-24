import AppIntents
import RarogActivity

/// App Intents of the widget extension: the End button the voice Live Activity draws (`EndVoiceActivityIntent`,
/// performed in the app's process) comes from the `RarogActivity` package.
struct RarogWidgetIntents: AppIntentsPackage {
  static var includedPackages: [any AppIntentsPackage.Type] { [RarogActivityIntents.self] }
}
