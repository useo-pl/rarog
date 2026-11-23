import RarogCore
import RarogTransport
import UIKit
import UserNotifications

/// Wejścia systemu, których cykl życia SwiftUI nie daje sceną: token APNs, porażka rejestracji
/// i powiadomienia — odebrane na wierzchu oraz tapnięte. Wszystko idzie do rdzenia przez `PushInbox`.
/// Rodzaj i cel czyta `PushRouting.inspect`: `rarogOpen` z rozszerzenia powiadomień, a bez niego blok `rarog` v3
/// odszyfrowany kluczem push z Keychaina apki (czytnik bez skutków ubocznych, `PushKeyReader`) albo jawny v1; v3,
/// którego apka nie otworzy, idzie do rdzenia z powodem (linia `client.log`).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Przed końcem startu: tap, który URUCHOMIŁ apkę (zimny start), trafia do delegata ustawionego tutaj.
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    PushInbox.shared.deviceToken(deviceToken)
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
    // Bez szczegółów błędu: linię w `client.log` składa rdzeń („push: rejestracja nieudana").
    PushInbox.shared.registrationFailed()
  }

  /// Push na wierzchu: banera nie ma (obecność i tak wycisza serwer, a o innej
  /// sesji mówi dymek apki); próbny daje dymek „Powiadomienia działają". Exceptions: the kinds in
  /// `PushNote.showsBannerInForeground`
  /// (`device-paired`; `version-changed`; `weekly-limit`) show a banner in the foreground too.
  ///
  /// Warianty z `completionHandler`, nie `async`: asynchroniczny delegat bez izolacji oddaje wynik
  /// z wątku puli, a UIKit przy tapnięciu (`didReceive`) wymaga głównego — zmierzone na iOS 27:
  /// SIGABRT w `_performBlockAfterCATransactionCommitSynchronizes`.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let inspection = PushRouting.inspect(
      userInfo: notification.request.content.userInfo, keys: AppEnvironment.keychain())
    nonisolated(unsafe) let done = completionHandler
    Self.onMain {
      PushInbox.shared.received(inspection)
      guard case let .note(note) = inspection, note.showsBannerInForeground else { return done([]) }
      done([.banner, .list, .sound])
    }
  }

  /// Tap w baner: cel czeka w rdzeniu na zalogowanie i świeżą listę.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    let inspection = PushRouting.inspect(userInfo: userInfo, keys: AppEnvironment.keychain())
    nonisolated(unsafe) let done = completionHandler
    Self.onMain {
      PushInbox.shared.tapped(inspection)
      done()
    }
  }

  /// System woła delegata na głównym wątku; gdyby nie, praca i odpowiedź i tak idą na główny.
  private nonisolated static func onMain(_ work: @escaping @MainActor @Sendable () -> Void) {
    if Thread.isMainThread {
      MainActor.assumeIsolated { work() }
    } else {
      Task { @MainActor in work() }
    }
  }
}

/// Skrzynka między delegatem a magazynem. Magazyn powstaje w `RarogApp.init`, czyli przed delegatem,
/// ale kolejność startu SwiftUI nie jest kontraktem — to, co przyjdzie przed nim, czeka tutaj.
@MainActor
final class PushInbox {
  static let shared = PushInbox()

  private var store: RarogStore?
  private var pending: [(RarogStore) -> Void] = []

  func attach(_ store: RarogStore) {
    self.store = store
    for delivery in pending { delivery(store) }
    pending = []
  }

  func deviceToken(_ token: Data) {
    deliver { $0.deviceTokenReceived(token) }
  }

  func registrationFailed() {
    deliver { $0.deviceTokenFailed() }
  }

  func received(_ inspection: PushInspection) {
    route(inspection, tapped: false)
  }

  func tapped(_ inspection: PushInspection) {
    route(inspection, tapped: true)
  }

  /// The core picks the target (`device-paired` → the Settings "Pairing" page) and writes the source line to
  /// `client.log`; a v3 the app cannot open gets only the line with the reason; a foreign push gets nothing.
  private func route(_ inspection: PushInspection, tapped: Bool) {
    switch inspection {
    case let .note(note): deliver { tapped ? $0.pushTapped(note) : $0.pushReceived(note) }
    case let .unreadableV3(reason): deliver { $0.pushUnreadable(reason, tapped: tapped) }
    case .foreign: break
    }
  }

  private func deliver(_ delivery: @escaping (RarogStore) -> Void) {
    if let store { delivery(store) } else { pending.append(delivery) }
  }
}
