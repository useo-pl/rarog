import Foundation
import RarogContract

// Usługi systemu dla powiadomień i pracy w tle. Rdzeń jest bez UIKit, więc apka wstrzykuje
// adaptery (`UIApplication`, `UNUserNotificationCenter`) przez `RarogStore.attachSystem`; testy rdzenia
// podają atrapy. Właściciel: push.

/// Zgoda systemowa na powiadomienia (`UNAuthorizationStatus` bez UIKit).
public enum PushAuthorization: Sendable, Equatable {
  /// Apka jeszcze nie pytała — baner „Włącz powiadomienia" ma sens.
  case notDetermined
  /// Odmowa. Lepka: zmienia ją tylko Ustawienia systemu, więc apka już nie pyta.
  case denied
  /// Zgoda (także tymczasowa): system pokaże banery.
  case authorized
}

/// System powiadomień urządzenia.
@MainActor
public protocol PushSystem: AnyObject {
  /// Środowisko APNs z profilu podpisu (reguła ``ProvisioningProfile/pushEnvironment(profile:isSimulator:)``):
  /// `aps-environment` profilu; profil bez niej i symulator = `development`; brak profilu na urządzeniu
  /// (TestFlight, App Store) = `production`.
  var environment: ApnsEnvironment { get }
  /// Profil, z którego wyszło ``environment`` — tylko do śladu rejestracji w `client.log`.
  var profile: PushProfile { get }
  /// Temat APNs apki = jej bundle id: token przyjmuje pushe tylko pod nim, więc rejestracja go deklaruje,
  /// a serwer wysyła pod tematem z wpisu. `nil` = proces nie zna bundle id (rejestracja bez pola).
  var topic: String? { get }
  /// Prosi system o token urządzenia. Wynik wraca przez ``RarogStore/deviceTokenReceived(_:)`` albo
  /// ``RarogStore/deviceTokenFailed()``. Zgoda na powiadomienia nie jest do tego potrzebna.
  func registerForRemoteNotifications()
  /// Zrzeka się tokenu: urządzenie przestaje przyjmować pushe apki (wylogowanie), a APNs odpowiada
  /// serwerowi 410 i ten kasuje wpis. Po zalogowaniu ``registerForRemoteNotifications()`` wraca.
  func unregisterForRemoteNotifications()
  /// Bieżąca zgoda (człowiek mógł ją zmienić w Ustawieniach, gdy apka była w tle).
  func authorization() async -> PushAuthorization
  /// Systemowe pytanie o zgodę (banery, plakietka, dźwięk); wynik po odpowiedzi człowieka.
  func requestAuthorization() async -> PushAuthorization
  /// Plakietka na ikonie apki. Bez zgody system ją ignoruje.
  func setBadgeCount(_ count: Int)
}

/// Uchwyt pracy dokańczanej po zejściu apki w tło.
public struct BackgroundWorkToken: Sendable, Hashable {
  public let raw: Int

  public init(raw: Int) {
    self.raw = raw
  }
}

/// Czas od systemu na dokończenie pracy po zejściu w tło (`beginBackgroundTask`): bez niego iOS
/// usypia apkę w połowie `visible: false` i serwer przez ~40 s myśli, że ktoś patrzy. Jedyna droga apki do
/// zadań w tle systemu: `UIApplication.beginBackgroundTask` woła tylko adapter (strażnik
/// `server/test/native-background-work-guard.test.ts`).
@MainActor
public protocol BackgroundWork: AnyObject {
  /// `needsServer` = praca rozmawia z serwerem Raroga (obecność, Live Activity, zapis notatki, klucz dyktowania);
  /// `false` = praca bez serwera (kończenie nagrania, dźwięk idzie prosto do dostawcy mowy).
  /// `nil` = system odmówił (czas tła już się skończył) — żądanie idzie i tak, bez gwarancji.
  func begin(_ name: String, needsServer: Bool) -> BackgroundWorkToken?
  /// Koniec pracy; uchwyt, któremu system już odebrał czas, adapter zamknął sam (wtedy nic nie robi).
  func end(_ token: BackgroundWorkToken)
}
