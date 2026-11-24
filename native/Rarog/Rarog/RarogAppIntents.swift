import AppIntents
import RarogActivity

/// App Intents of the app: the End button of the voice Live Activity (`EndVoiceActivityIntent`) comes from the
/// `RarogActivity` package, whose metadata the system finds through this list. Owner: voice agent.
struct RarogAppIntents: AppIntentsPackage {
  static var includedPackages: [any AppIntentsPackage.Type] { [RarogActivityIntents.self] }
}
