import Foundation
import Security

// Stan klienta rejestru w Keychainie: dwa wpisy usługi tożsamości iroh (`ai.rarog.app.iroh`, obok konta `device`
// z `Tunnel/IrohIdentityStore.swift`, którego ten plik nie czyta i nie rusza), grupa prywatna apki
// (`RarogKeychainGroup`), `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, bez synchronizacji.
//
// - Konto `relay-access`: pamięć podręczna (``RelayAccessCache``). Treść spoza v1 to brak pamięci z linią logu.
// - Konto `relay-optout`: rezygnacja (``RelayOptOut``). Wpis, którego nie da się przeczytać, wstrzymuje automatyczną
//   rejestrację i zostaje nietknięty; skasować go może tylko jawne `deleteOptOut` (parowanie przez iroh).
//
// Zapis: `SecItemUpdate`, a przy braku wpisu `SecItemAdd`, więc drugi zapis aktualizuje, nie dubluje. Treść wpisów
// nie ma sekretów; linie logu i tak podają tylko powód.

/// Wywołania Keychaina systemu. Testy podstawiają pamięć: `swift test` nie ma uprawnienia do Keychaina z ochroną
/// danych.
struct RelayKeychainCalls: Sendable {
  var copy: @Sendable (_ query: [String: Any]) -> (status: OSStatus, data: Data?)
  var update: @Sendable (_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus
  var add: @Sendable (_ item: [String: Any]) -> OSStatus
  var delete: @Sendable (_ query: [String: Any]) -> OSStatus

  static let system = RelayKeychainCalls(
    copy: { query in
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      return (status, result as? Data)
    },
    update: { query, attributes in SecItemUpdate(query as CFDictionary, attributes as CFDictionary) },
    add: { item in SecItemAdd(item as CFDictionary, nil) },
    delete: { query in SecItemDelete(query as CFDictionary) })
}

/// Pamięć podręczna i rezygnacja klienta rejestru w Keychainie systemu. `group` z Info.plist apki
/// (`RarogKeychainGroup`); `nil` = grupa domyślna procesu.
public struct SystemRelayAccessStore: RelayAccessStore {
  public static let service = SystemIrohIdentityKeychain.service
  public static let cacheAccount = "relay-access"
  public static let optOutAccount = "relay-optout"

  public let group: String?
  private let log: @Sendable (String) -> Void
  private let calls: RelayKeychainCalls

  /// `log` dostaje linie do `client.log` (prefiks `relay-access:`), bez treści wpisów.
  public init(group: String?, log: @escaping @Sendable (String) -> Void) {
    self.init(group: group, log: log, calls: .system)
  }

  init(group: String?, log: @escaping @Sendable (String) -> Void, calls: RelayKeychainCalls) {
    self.group = group
    self.log = log
    self.calls = calls
  }

  // MARK: Pamięć podręczna

  public func loadCache() -> RelayStoredRead<RelayAccessCache> {
    switch read(Self.cacheAccount) {
    case .none: return .none
    case let .refused(reason): return .unreadable(reason)
    case let .found(data):
      switch Self.decode(RelayAccessCache.self, data) {
      case let .success(cache): return .found(cache)
      case let .failure(failure):
        log("relay-access: cache ignored (\(failure.reason))")
        return .none
      }
    }
  }

  public func saveCache(_ cache: RelayAccessCache) -> Bool {
    write(Self.cacheAccount, cache)
  }

  // MARK: Rezygnacja

  public func loadOptOut() -> RelayStoredRead<RelayOptOut> {
    switch read(Self.optOutAccount) {
    case .none: return .none
    case let .refused(reason): return .unreadable(reason)
    case let .found(data):
      switch Self.decode(RelayOptOut.self, data) {
      case let .success(optOut): return .found(optOut)
      case let .failure(failure): return .unreadable("\(Self.optOutAccount): \(failure.reason)")
      }
    }
  }

  public func saveOptOut(_ optOut: RelayOptOut) -> Bool {
    write(Self.optOutAccount, optOut)
  }

  public func deleteOptOut() -> Bool {
    delete(Self.optOutAccount)
  }

  /// Both items of the client, for the UI test reset in Debug (`AppEnvironment.resetForUITestsIfAsked`): the next
  /// start is a new device for the registry too. A missing item counts as deleted.
  public func deleteAll() -> Bool {
    let cache = delete(Self.cacheAccount)
    let optOut = delete(Self.optOutAccount)
    return cache && optOut
  }

  private func delete(_ account: String) -> Bool {
    let status = calls.delete(match(account))
    guard status == errSecSuccess || status == errSecItemNotFound else {
      log("relay-access: \(account) not deleted (OSStatus \(status))")
      return false
    }
    return true
  }

  // MARK: Zapytania

  /// Zapytanie o jeden wpis usługi: klasa, usługa, Keychain z ochroną danych, grupa, konto.
  func match(_ account: String) -> [String: Any] {
    var query = SystemKeychain.query(Self.service, group: group)
    query[kSecAttrAccount as String] = account
    return query
  }

  /// Atrybuty zapisu: treść i dostępność.
  func attributes(_ data: Data) -> [String: Any] {
    [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
  }

  /// Nowy wpis: zapytanie, atrybuty zapisu i brak synchronizacji.
  func addItem(_ account: String, _ data: Data) -> [String: Any] {
    var item = match(account)
    item.merge(attributes(data)) { $1 }
    item[kSecAttrSynchronizable as String] = false
    return item
  }

  // MARK: Wnętrze

  private enum RawRead {
    case found(Data)
    case none
    case refused(String)
  }

  private func read(_ account: String) -> RawRead {
    var query = match(account)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    let (status, data) = calls.copy(query)
    switch status {
    // Wpis bez danych to treść nieczytelna, nie brak wpisu (wzór `IrohIdentityStore`).
    case errSecSuccess: return .found(data ?? Data())
    case errSecItemNotFound: return .none
    case errSecInteractionNotAllowed: return .refused("\(account): Keychain locked")
    default: return .refused("\(account): Keychain read, OSStatus \(status)")
    }
  }

  private func write<Value: Encodable>(_ account: String, _ value: Value) -> Bool {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value) else {
      log("relay-access: \(account) not saved (encoding)")
      return false
    }
    var status = calls.update(match(account), attributes(data))
    if status == errSecItemNotFound { status = calls.add(addItem(account, data)) }
    guard status == errSecSuccess else {
      log("relay-access: \(account) not saved (OSStatus \(status))")
      return false
    }
    return true
  }

  /// Powód odrzucenia treści wpisu, bez treści.
  struct Unreadable: Error, Equatable {
    let reason: String
  }

  /// Treść wpisu albo powód odrzucenia: wersja spoza v1, JSON nie v1.
  static func decode<Value: Decodable>(_ type: Value.Type, _ data: Data) -> Result<Value, Unreadable> {
    do {
      return .success(try JSONDecoder().decode(type, from: data))
    } catch let mismatch as RelayStoredVersion.Mismatch {
      return .failure(Unreadable(reason: "version \(mismatch.found)"))
    } catch {
      return .failure(Unreadable(reason: "not JSON v1"))
    }
  }
}
