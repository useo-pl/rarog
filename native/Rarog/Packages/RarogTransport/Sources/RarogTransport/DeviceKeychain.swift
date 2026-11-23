import Foundation
import Security
import Synchronization

// Keychain klucza urządzenia: DWA wpisy `kSecClassGenericPassword`,
// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, bez synchronizacji iCloud.
//
// 1. Klucz urządzenia — usługa `ai.rarog.app.server`, konto = host serwera, a dla serwera tylko przez iroh
//    `iroh:<EndpointId>`, grupa PRYWATNA apki (`$(AppIdentifierPrefix)ai.rarog.app`). Treść: JSON
//    z `DeviceCredential` (z sekretem) i kluczem push.
// 2. Klucz push — usługa `ai.rarog.app.push`, konto = `kid`, grupa WSPÓŁDZIELONA z rozszerzeniem powiadomień
//    (`$(AppIdentifierPrefix)ai.rarog.app.shared`, NSE). NSE czyta wyłącznie ten wpis, przez `PushKeyReader`
//    (`PushKeys.swift`) — nigdy sekretu urządzenia. Kopia klucza push w pierwszym wpisie zostaje na wypadek, gdyby
//    zapis do grupy współdzielonej się nie udał (np. build bez uprawnienia): start apki z kluczem odtwarza z niej
//    drugi wpis bez parowania (`restoreSharedPushKey`, woła `RarogStore`), a apka do tej pory czyta kopię.
// Nazwy usług idą za identyfikatorem apki. Wpisów pod nazwami sprzed zmiany apka nie czyta i nie migruje:
// urządzenia paruje się od nowa, a „Zapomnij serwer” na starym buildzie kasuje stare wpisy.
//
// Tożsamość iroh apki leży w trzecim wpisie, poza tym plikiem (`Tunnel/IrohIdentityStore.swift`).
//
// Apka zna JEDEN serwer naraz: zapis nowego klucza kasuje wpisy innych kont. Kasowanie jest adresowane
// `deviceId`, więc spóźnione 401 starego klucza nie skasuje świeżego parowania (strażnik generacji).

/// Wynik odczytu klucza. `locked` to NIE „brak klucza”: przed pierwszym odblokowaniem telefonu po restarcie
/// wpis istnieje, ale jest nieczytelny — apka czeka zamiast pokazać ekran parowania.
public enum KeychainRead: Sendable, Equatable {
  case found(DeviceCredential, pushKey: String)
  case none
  case locked
  /// Inny błąd Keychaina (`OSStatus`) — dla apki brak klucza, dla `client.log` linia z kodem.
  case failed(Int32)
}

/// Odmowa zapisu klucza urządzenia (`OSStatus`). Parowanie kończy się wtedy błędem: bez trwałego klucza apka
/// po restarcie nie miałaby jak się połączyć, a serwer drugi raz sekretu nie wyda.
public struct KeychainFailure: Error, Sendable, Equatable {
  public let status: Int32

  public init(status: Int32) {
    self.status = status
  }
}

/// Magazyn klucza urządzenia. Produkcja: ``SystemKeychain``; testy i podglądy: ``MemoryKeychain``. Klucz push po `kid`
/// (``PushKeyReader``) czyta wpis współdzielony, a bez niego kopię z wpisu prywatnego przy zgodnym `kid`.
public protocol DeviceKeychain: PushKeyReader {
  func load() -> KeychainRead
  /// Zapisuje klucz (i jego kopię klucza push) pod kontem `credential.account`; wpisy innych kont znikają.
  /// Poświadczenie bez żadnej trasy (bez adresu i bez pary iroh) odrzuca `errSecParam`: odczyt by go nie przeczytał
  /// i skasował razem z kluczem push. Rzucony błąd = stary wpis nietknięty. Wynik: czy klucz push trafił też do grupy
  /// współdzielonej (`false` = wpis prywatny już zapisany, klucz push tylko w jego kopii; parowania nie przerywa).
  @discardableResult
  func save(_ credential: DeviceCredential, pushKey: String) throws(KeychainFailure) -> Bool
  /// Kasuje klucz urządzenia `deviceId` i klucze push; `nil` = wszystko („Zapomnij serwer”). Klucz INNEGO
  /// urządzenia zostaje (`false`).
  @discardableResult
  func delete(deviceId: String?) -> Bool
  /// Odtwarza wpis współdzielony klucza push z kopii we wpisie prywatnym (start z kluczem). Idempotentnie: wpis z tą
  /// samą wartością zostaje nietknięty; zapis (wpisu brak albo ma inną wartość) usuwa inne `kid` z grupy jak
  /// parowanie. Wynik: czy wpis współdzielony jest po wywołaniu.
  @discardableResult
  func restoreSharedPushKey(kid: String, pushKey: String) -> Bool
}

/// Keychain systemu (`Security`). Grupy dostępu przychodzą z Info.plist apki (`RarogKeychainGroup`,
/// `RarogKeychainSharedGroup` z `$(AppIdentifierPrefix)`); `nil` = grupa domyślna procesu (testy, macOS).
public struct SystemKeychain: DeviceKeychain {
  public static let deviceService = "ai.rarog.app.server"
  public static let pushService = "ai.rarog.app.push"

  public let appGroup: String?
  public let sharedGroup: String?

  public init(appGroup: String?, sharedGroup: String?) {
    self.appGroup = appGroup
    self.sharedGroup = sharedGroup
  }

  /// Treść pierwszego wpisu. `version` pozwala zmienić kształt bez gubienia klucza.
  struct Stored: Codable {
    var version = 1
    var credential: DeviceCredential
    var pushKey: String
  }

  /// Odczyt wpisu prywatnego BEZ skutków ubocznych: nieczytelną treść kasuje dopiero ``load()``.
  private enum PrivateRead {
    case found(Stored)
    case unreadable
    case none
    case locked
    case failed(Int32)
  }

  public func load() -> KeychainRead {
    switch readPrivate() {
    case let .found(stored):
      return .found(stored.credential, pushKey: stored.pushKey)
    case .unreadable:
      // Nieczytelny wpis to brak klucza; zostawiony wracałby przy każdym starcie.
      _ = delete(deviceId: nil)
      return .none
    case .none:
      return .none
    case .locked:
      return .locked
    case let .failed(status):
      return .failed(status)
    }
  }

  /// Wpis współdzielony, a gdy go nie ma (albo grupa odmawia) — kopia z wpisu prywatnego przy zgodnym `kid`.
  public func pushKey(kid: String) -> PushKeyRead {
    let shared = SharedPushKeychain(group: sharedGroup).pushKey(kid: kid)
    switch shared {
    case .found, .locked:
      return shared
    case .none, .failed:
      break
    }
    switch readPrivate() {
    case let .found(stored) where stored.credential.kid == kid:
      return .found(Data(stored.pushKey.utf8))
    case .locked:
      return .locked
    default:
      return shared
    }
  }

  /// Treść wpisu prywatnego: jedyna droga kodowania (`save` i testy zgodności ze starszym buildem). `JSONEncoder`
  /// bez ustawień, więc kolejność kluczy jest przypadkowa, a data to `timeIntervalSinceReferenceDate`.
  static func encode(_ credential: DeviceCredential, pushKey: String) throws(KeychainFailure) -> Data {
    guard credential.hasRoute else { throw KeychainFailure(status: errSecParam) }
    do {
      return try JSONEncoder().encode(Stored(credential: credential, pushKey: pushKey))
    } catch {
      throw KeychainFailure(status: errSecParam)
    }
  }

  /// Odczyt treści wpisu prywatnego: `nil` = nieczytelny (zły JSON, `version` ≠ 1, poświadczenie bez trasy).
  static func decode(_ data: Data) -> Stored? {
    guard let stored = try? JSONDecoder().decode(Stored.self, from: data), stored.version == 1 else { return nil }
    return stored
  }

  @discardableResult
  public func save(_ credential: DeviceCredential, pushKey: String) throws(KeychainFailure) -> Bool {
    let data = try Self.encode(credential, pushKey: pushKey)
    // Najpierw nowy wpis (aktualizacja tego samego hosta albo nowy), potem sprzątanie innych hostów:
    // porażka w środku nie zostawia apki bez żadnego klucza.
    try upsert(Self.deviceService, account: credential.account, group: appGroup, data: data)
    removeOthers(Self.deviceService, keeping: credential.account, group: appGroup)
    return writeShared(kid: credential.kid, pushKey: pushKey)
  }

  @discardableResult
  public func restoreSharedPushKey(kid: String, pushKey: String) -> Bool {
    if case let .found(value) = SharedPushKeychain(group: sharedGroup).pushKey(kid: kid), value == Data(pushKey.utf8) {
      return true
    }
    return writeShared(kid: kid, pushKey: pushKey)
  }

  @discardableResult
  public func delete(deviceId: String?) -> Bool {
    if let deviceId {
      guard case let .found(current, _) = load(), current.deviceId == deviceId else { return false }
    }
    SecItemDelete(Self.query(Self.deviceService, group: appGroup) as CFDictionary)
    SecItemDelete(Self.query(Self.pushService, group: sharedGroup) as CFDictionary)
    return true
  }

  // MARK: - Wnętrze

  /// Zapytanie o wpisy usługi w grupie (`nil` = grupa domyślna procesu); wspólne z ``SharedPushKeychain``.
  static func query(_ service: String, group: String?) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecUseDataProtectionKeychain as String: true,
    ]
    if let group { query[kSecAttrAccessGroup as String] = group }
    return query
  }

  private func readPrivate() -> PrivateRead {
    var query = Self.query(Self.deviceService, group: appGroup)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    switch status {
    case errSecSuccess:
      guard let data = result as? Data, let stored = Self.decode(data) else { return .unreadable }
      return .found(stored)
    case errSecItemNotFound:
      return .none
    case errSecInteractionNotAllowed:
      return .locked
    default:
      return .failed(status)
    }
  }

  /// Klucz push do grupy współdzielonej (inne `kid` znikają). `false` = grupa odmówiła zapisu.
  private func writeShared(kid: String, pushKey: String) -> Bool {
    do {
      try upsert(Self.pushService, account: kid, group: sharedGroup, data: Data(pushKey.utf8))
      removeOthers(Self.pushService, keeping: kid, group: sharedGroup)
      return true
    } catch {
      return false
    }
  }

  private func upsert(_ service: String, account: String, group: String?, data: Data) throws(KeychainFailure) {
    var match = Self.query(service, group: group)
    match[kSecAttrAccount as String] = account
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let updated = SecItemUpdate(match as CFDictionary, attributes as CFDictionary)
    if updated == errSecSuccess { return }
    guard updated == errSecItemNotFound else { throw KeychainFailure(status: updated) }
    var item = match
    item.merge(attributes) { $1 }
    item[kSecAttrSynchronizable as String] = false
    let added = SecItemAdd(item as CFDictionary, nil)
    guard added == errSecSuccess else { throw KeychainFailure(status: added) }
  }

  private func removeOthers(_ service: String, keeping account: String, group: String?) {
    var query = Self.query(service, group: group)
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    query[kSecReturnAttributes as String] = true
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let items = result as? [[String: Any]]
    else { return }
    for item in items {
      guard let other = item[kSecAttrAccount as String] as? String, other != account else { continue }
      var delete = Self.query(service, group: group)
      delete[kSecAttrAccount as String] = other
      SecItemDelete(delete as CFDictionary)
    }
  }
}

/// Keychain w pamięci procesu — testy pakietów i podglądy. `locked` udaje telefon przed pierwszym odblokowaniem,
/// `saveFailure` odmowę zapisu, `sharedFailure` brak grupy współdzielonej, `unreadable` nieczytelną treść wpisu
/// prywatnego (``load()`` kasuje wtedy wszystko jak ``SystemKeychain``, odczyt klucza push niczego nie rusza).
public final class MemoryKeychain: DeviceKeychain {
  public struct Contents: Sendable, Equatable {
    public var credential: DeviceCredential?
    public var pushKey: String?
    /// Klucz push w grupie współdzielonej (`kid` → klucz).
    public var shared: [String: String] = [:]
    public var locked = false
    public var saveFailure: Int32?
    public var sharedFailure = false
    public var unreadable = false
    /// Ile razy coś zapisało wpis współdzielony (parowanie, odtworzenie) — idempotencję widać po liczniku.
    public var sharedWrites = 0

    public init(credential: DeviceCredential? = nil, pushKey: String? = nil) {
      self.credential = credential
      self.pushKey = pushKey
      if let credential, let pushKey { shared = [credential.kid: pushKey] }
    }
  }

  private let contents: Mutex<Contents>

  public init(_ contents: Contents = Contents()) {
    self.contents = Mutex(contents)
  }

  public var snapshot: Contents { contents.withLock { $0 } }

  public func update(_ change: (inout Contents) -> Void) {
    contents.withLock { change(&$0) }
  }

  public func load() -> KeychainRead {
    contents.withLock { state in
      if state.locked { return .locked }
      if state.unreadable {
        state.credential = nil
        state.pushKey = nil
        state.shared = [:]
        state.unreadable = false
        return .none
      }
      guard let credential = state.credential, let pushKey = state.pushKey else { return .none }
      return .found(credential, pushKey: pushKey)
    }
  }

  public func pushKey(kid: String) -> PushKeyRead {
    contents.withLock { state in
      if state.locked { return .locked }
      if let value = state.shared[kid] { return .found(Data(value.utf8)) }
      if !state.unreadable, let credential = state.credential, credential.kid == kid, let pushKey = state.pushKey {
        return .found(Data(pushKey.utf8))
      }
      return .none
    }
  }

  @discardableResult
  public func save(_ credential: DeviceCredential, pushKey: String) throws(KeychainFailure) -> Bool {
    let failure: Int32? = contents.withLock { state in
      if let status = state.saveFailure { return status }
      // Jak `SystemKeychain`: wpisu bez trasy odczyt by nie przeczytał.
      guard credential.hasRoute else { return errSecParam }
      state.credential = credential
      state.pushKey = pushKey
      state.unreadable = false
      if !state.sharedFailure {
        state.shared = [credential.kid: pushKey]
        state.sharedWrites += 1
      }
      return nil
    }
    if let failure { throw KeychainFailure(status: failure) }
    return !snapshot.sharedFailure
  }

  @discardableResult
  public func restoreSharedPushKey(kid: String, pushKey: String) -> Bool {
    contents.withLock { state in
      if state.shared[kid] == pushKey { return true }
      guard !state.sharedFailure else { return false }
      state.shared = [kid: pushKey]
      state.sharedWrites += 1
      return true
    }
  }

  @discardableResult
  public func delete(deviceId: String?) -> Bool {
    contents.withLock { state in
      if let deviceId, state.credential?.deviceId != deviceId { return false }
      state.credential = nil
      state.pushKey = nil
      state.shared = [:]
      state.unreadable = false
      return true
    }
  }
}
