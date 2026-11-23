import Foundation
import RarogContract
import RarogTransport
import UserNotifications

/// Rozszerzenie powiadomień (NSE): baner v3 przychodzi z tekstem zastępczym i `mutable-content: 1`, a tu
/// dostaje tytuł i treść odszyfrowane kluczem push z grupy współdzielonej Keychaina. Klasa tylko skleja: decyzję
/// składa czysta funkcja `PushServiceDecision.decide` (RarogTransport, testy pakietu), handler systemu pada
/// dokładnie raz (`OnceHandler`). Podstawienie: tytuł, treść i `rarogOpen` w `userInfo` (cel tapnięcia dla apki);
/// blok `rarog` v3 i `threadIdentifier` zostają. Każdy inny przypadek (v1, brak klucza, zablokowany telefon, zły
/// `kid`, AEAD, walidacja, stary `exp`, koniec czasu) — oryginał. Bez logów: treść nie wychodzi poza baner.
///
/// Zdania serwera z kodem (`titleRef`, `bodyRef`) tłumaczy ``renderer`` w języku rozszerzenia: `CFBundleLocalizations`
/// z Info.plist, wybór systemu jak w apce (`CopyLanguage.current`), katalog zdań z zasobów RarogContract.
///
/// Keychain WYŁĄCZNIE przez `PushKeyReader` (`SharedPushKeychain`, sam wpis współdzielony): rozszerzenie nie zna
/// sekretu urządzenia, a `DeviceKeychain` kasowałby wpisy. Entitlements: tylko grupa `ai.rarog.app.shared`.
final class NotificationService: UNNotificationServiceExtension {
  private var original: UNNotificationContent?
  private var finish: OnceHandler<UNNotificationContent>?

  override func didReceive(
    _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let finish = OnceHandler(contentHandler)
    self.finish = finish
    original = request.content
    let decision = PushServiceDecision.decide(
      userInfo: request.content.userInfo, keys: Self.keys(), now: Date(), renderer: Self.renderer)
    guard case let .replace(title, body, open) = decision,
      let content = request.content.mutableCopy() as? UNMutableNotificationContent
    else {
      finish(request.content)
      return
    }
    content.title = title
    content.body = body
    content.userInfo = open.adding(to: content.userInfo)
    finish(content)
  }

  /// Czas mija przed końcem (system daje ~30 s): oryginał, chyba że handler już padł.
  override func serviceExtensionTimeWillExpire() {
    guard let finish, let original else { return }
    finish(original)
  }

  /// Tłumacz zdań serwera rozszerzenia (język procesu NSE).
  private static let renderer = ServerText.renderer(language: .current)

  /// Grupa współdzielona z Info.plist rozszerzenia; nierozwinięta zmienna (`$(…)`) = grupa domyślna procesu.
  private static func keys() -> any PushKeyReader {
    let value = Bundle.main.object(forInfoDictionaryKey: "RarogKeychainSharedGroup") as? String
    let group = value.flatMap { $0.isEmpty || $0.contains("$(") ? nil : $0 }
    return SharedPushKeychain(group: group)
  }
}
