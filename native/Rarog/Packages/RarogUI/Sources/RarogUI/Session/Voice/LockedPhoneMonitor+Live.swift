import Foundation
import RarogCore

// The app's locked-phone monitor, built once when the app starts. Owner: voice agent.

extension LockedPhoneMonitor {
  /// The app's monitor: the app's one microphone (`DictationCenter.shared`, whose every claim and reported change
  /// runs `evaluate()`), the background rule from `store.voiceAgent` (so the app builds it after
  /// `attachVoiceAgent`), the store's question to the server and its `client.log` lines on the voice agent budget,
  /// and `holdServer` for the app's server connection. The app passes it every scene phase (`scene(_:)`).
  public static func live(store: RarogStore, holdServer: @escaping @MainActor (Bool) -> Void) -> LockedPhoneMonitor {
    let center = DictationCenter.shared
    let monitor = LockedPhoneMonitor(
      Parts(
        background: store.voiceAgent.background, use: { center.use }, scheduler: TaskVoiceScheduler(),
        holdServer: holdServer,
        serverAnswers: { [weak store] in await store?.serverAnswers() ?? false },
        trace: { [weak store] line in store?.trace(line, budget: .voiceAgent) }))
    center.observe { [weak monitor] in monitor?.evaluate() }
    return monitor
  }
}
