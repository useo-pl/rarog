import Foundation
import RarogContract
import RarogCore
import UIKit
import UserNotifications

/// System powiadomień dla rdzenia (`PushSystem`): `UIApplication` i `UNUserNotificationCenter`.
final class UIKitPushSystem: PushSystem {
  private let reading = PushEnvironment.current()
  var environment: ApnsEnvironment { reading.environment }
  var profile: PushProfile { reading.profile }
  /// Temat APNs = bundle id TEGO procesu (`PRODUCT_BUNDLE_IDENTIFIER` celu apki), nie stała w kodzie.
  let topic = Bundle.main.bundleIdentifier

  func registerForRemoteNotifications() {
    UIApplication.shared.registerForRemoteNotifications()
  }

  func unregisterForRemoteNotifications() {
    UIApplication.shared.unregisterForRemoteNotifications()
  }

  func authorization() async -> PushAuthorization {
    Self.map(await UNUserNotificationCenter.current().notificationSettings().authorizationStatus)
  }

  func requestAuthorization() async -> PushAuthorization {
    // Błąd pytania (rzadki: brak entitlementu) to dalej odpowiedź „jaka jest zgoda" — czytamy ją wprost.
    _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
    return await authorization()
  }

  func setBadgeCount(_ count: Int) {
    UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
  }

  /// Zgoda tymczasowa i efemeryczna też pokazuje banery — dla rdzenia to zgoda.
  static func map(_ status: UNAuthorizationStatus) -> PushAuthorization {
    switch status {
    case .notDetermined: .notDetermined
    case .denied: .denied
    case .authorized, .provisional, .ephemeral: .authorized
    @unknown default: .denied
    }
  }
}

/// Środowisko APNs z profilu podpisu, nie z ręki: ten typ tylko czyta `embedded.mobileprovision`
/// i mówi, czy to symulator; regułę (brak profilu na urządzeniu = TestFlight albo App Store =
/// `production`) ma `ProvisioningProfile.pushEnvironment` w RarogCore, z testami.
enum PushEnvironment {
  static func current(bundle: Bundle = .main) -> PushEnvironmentReading {
    #if targetEnvironment(simulator)
      let isSimulator = true
    #else
      let isSimulator = false
    #endif
    // Plik jest, ale się nie czyta: profil BEZ odczytanego `aps-environment` (`development`), nie jego brak.
    let profile = bundle.url(forResource: "embedded", withExtension: "mobileprovision")
      .map { (try? Data(contentsOf: $0)) ?? Data() }
    return ProvisioningProfile.pushEnvironment(profile: profile, isSimulator: isSimulator)
  }
}
