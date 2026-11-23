import Foundation
import Security

// Odczyt klucza push po `kid` — JEDYNE wejście rozszerzenia powiadomień (NSE) do Keychaina. Wąski
// protokół zamiast `DeviceKeychain`: `load()` kasuje nieczytelny wpis klucza urządzenia, a `delete` kasuje też wpis
// współdzielony, czyli jedyny klucz NSE i apki. NSE dostaje ``SharedPushKeychain`` (sam wpis współdzielony), apka —
// ``SystemKeychain`` (wpis współdzielony, a bez niego kopia z wpisu prywatnego przy zgodnym `kid`).

/// Wynik odczytu klucza push. `locked` to NIE „brak klucza”: przed pierwszym odblokowaniem telefonu po restarcie
/// wpis istnieje, ale jest nieczytelny (`errSecInteractionNotAllowed`).
public enum PushKeyRead: Sendable, Equatable {
  /// Wartość wpisu: tekst base64url klucza push w UTF-8 (`PushCrypto.pushKey(keychainValue:)`).
  case found(Data)
  case none
  case locked
  /// Inny błąd Keychaina (`OSStatus`).
  case failed(Int32)
}

/// Klucz push po `kid` — bez skutków ubocznych: odczyt niczego nie kasuje ani nie zapisuje.
public protocol PushKeyReader: Sendable {
  func pushKey(kid: String) -> PushKeyRead
}

/// Sam wpis współdzielony (usługa ``SystemKeychain/pushService``, konto = `kid`) w grupie `group` — czytnik NSE.
/// `nil` = grupa domyślna procesu (nierozwinięta zmienna w Info.plist).
public struct SharedPushKeychain: PushKeyReader {
  public let group: String?

  public init(group: String?) {
    self.group = group
  }

  public func pushKey(kid: String) -> PushKeyRead {
    var query = SystemKeychain.query(SystemKeychain.pushService, group: group)
    query[kSecAttrAccount as String] = kid
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    switch status {
    case errSecSuccess:
      guard let data = result as? Data else { return .failed(errSecDecode) }
      return .found(data)
    case errSecItemNotFound:
      return .none
    case errSecInteractionNotAllowed:
      return .locked
    default:
      return .failed(status)
    }
  }
}
