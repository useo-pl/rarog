import Foundation
import Security
import Synchronization

// Tożsamość iroh apki: klucz tajny endpointu (Ed25519, 32 B), jeden na urządzenie, niezależny od
// serwera i parowania, więc EndpointId apki przeżywa ponowne parowanie i „Zapomnij serwer”. Wpis Keychaina obok
// klucza urządzenia (`DeviceKeychain.swift`): usługa `ai.rarog.app.iroh`, konto `device`, grupa prywatna apki,
// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, bez synchronizacji. Treść: JSON
// `{"version": 1, "secret": "<base64, 32 B>", "createdAt": "<ISO 8601>"}`.
//
// Reguły:
// - Klucz powstaje tylko przy braku wpisu i trafia do Keychaina PRZED pierwszym użyciem; wpisu nikt nie przepisuje.
// - Każda porażka (Keychain zablokowany, odczyt odrzucony, wpis nieczytelny, zapis odrzucony, generator) to
//   „iroh niedostępne” z powodem do `client.log`: nigdy klucz tylko w pamięci, nigdy nowy klucz w miejsce wpisu,
//   którego nie da się przeczytać. HTTPS nie zależy od tego wpisu.
// - Odczyty idą przez jednego aktora: równoczesne odczyty bez wpisu dają jeden zapis. Drugi zapisujący spoza aktora
//   (inny proces) przegrywa na `errSecDuplicateItem` i czyta klucz zwycięzcy.
// - Kasuje wpis tylko reset testów UI.

/// Klucz iroh apki. Opis bez sekretu.
public struct IrohIdentity: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
  /// Klucz tajny endpointu, 32 B.
  public let secretKey: Data
  /// Chwila utworzenia z wpisu; `nil` = data nieczytelna (klucz i tak ważny).
  public let createdAt: Date?

  public var description: String { "IrohIdentity(utworzona \(createdAt.map { "\($0)" } ?? "?"))" }
  public var debugDescription: String { description }
}

/// Dlaczego tożsamości iroh nie ma. Każdy przypadek znaczy: iroh niedostępne do następnej próby, HTTPS bez zmian.
public enum IrohIdentityUnavailable: Sendable, Equatable, CustomStringConvertible {
  /// Telefon przed pierwszym odblokowaniem; następna próba po `protectedDataBecameAvailable`.
  case locked
  /// Odczyt odrzucony (`OSStatus`).
  case failed(Int32)
  /// Wpis jest, ale nie v1 albo sekret nie ma 32 B; wpis zostaje nietknięty.
  case unreadable
  /// Nowy klucz nie trafił do Keychaina (`OSStatus`), więc nie jest używany.
  case notSaved(Int32)
  /// Generator liczb losowych odmówił.
  case noRandom

  /// Linia do `client.log`, bez sekretu.
  public var description: String {
    switch self {
    case .locked: "iroh: identity unavailable (Keychain locked)"
    case let .failed(status): "iroh: identity unavailable (Keychain read, OSStatus \(status))"
    case .unreadable: "iroh: identity unavailable (entry unreadable, kept)"
    case let .notSaved(status): "iroh: identity unavailable (Keychain write, OSStatus \(status))"
    case .noRandom: "iroh: identity unavailable (key generator)"
    }
  }
}

/// Wynik prośby o tożsamość iroh.
public enum IrohIdentityRead: Sendable, Equatable {
  case ready(IrohIdentity)
  case unavailable(IrohIdentityUnavailable)
}

/// Surowy odczyt wpisu tożsamości.
public enum IrohIdentityItemRead: Sendable, Equatable {
  case found(Data)
  case none
  case locked
  case failed(Int32)
}

/// Wpis tożsamości w Keychainie: odczyt i jednorazowe dodanie. Produkcja: ``SystemIrohIdentityKeychain``; testy:
/// ``MemoryIrohIdentityKeychain``.
public protocol IrohIdentityKeychain: Sendable {
  func read() -> IrohIdentityItemRead
  /// Dodaje wpis; istniejący zostaje nietknięty, a wołający dostaje `errSecDuplicateItem`.
  func add(_ data: Data) throws(KeychainFailure)
  /// Kasuje wpis (wyłącznie reset testów UI).
  func delete()
}

/// Treść wpisu v1: kodowanie i odczyt.
enum IrohIdentityStored {
  static let version = 1
  static let secretLength = 32

  private struct Wire: Codable {
    var version: Int
    var secret: String
    var createdAt: String?
  }

  static func encode(secretKey: Data, createdAt: Date) -> Data? {
    let wire = Wire(
      version: version, secret: secretKey.base64EncodedString(),
      createdAt: createdAt.formatted(Date.ISO8601FormatStyle()))
    return try? JSONEncoder().encode(wire)
  }

  /// `nil` = wpis nieczytelny: zły JSON, `version` ≠ 1, sekret nie base64 albo nie 32 B. Nieznane klucze i zła data
  /// nie przeszkadzają.
  static func decode(_ data: Data) -> IrohIdentity? {
    guard let wire = try? JSONDecoder().decode(Wire.self, from: data), wire.version == version,
      let secret = Data(base64Encoded: wire.secret), secret.count == secretLength
    else { return nil }
    let createdAt = wire.createdAt.flatMap { try? Date.ISO8601FormatStyle().parse($0) }
    return IrohIdentity(secretKey: secret, createdAt: createdAt)
  }
}

/// Wpis tożsamości w Keychainie systemu. `group` z Info.plist apki (`RarogKeychainGroup`); `nil` = grupa domyślna.
public struct SystemIrohIdentityKeychain: IrohIdentityKeychain {
  public static let service = "ai.rarog.app.iroh"
  public static let account = "device"

  public let group: String?

  public init(group: String?) {
    self.group = group
  }

  private var match: [String: Any] {
    var query = SystemKeychain.query(Self.service, group: group)
    query[kSecAttrAccount as String] = Self.account
    return query
  }

  /// Zapytanie dodania wpisu z treścią `data`.
  func addQuery(_ data: Data) -> [String: Any] {
    var item = match
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    item[kSecAttrSynchronizable as String] = false
    return item
  }

  public func read() -> IrohIdentityItemRead {
    var query = match
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    switch status {
    case errSecSuccess:
      // Wpis bez danych traktujemy jak nieczytelny, nie jak brak: brak dałby nowy klucz w miejsce istniejącego.
      return .found(result as? Data ?? Data())
    case errSecItemNotFound: return .none
    case errSecInteractionNotAllowed: return .locked
    default: return .failed(status)
    }
  }

  public func add(_ data: Data) throws(KeychainFailure) {
    let status = SecItemAdd(addQuery(data) as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainFailure(status: status) }
  }

  public func delete() {
    SecItemDelete(match as CFDictionary)
  }
}

/// Wpis tożsamości w pamięci procesu — testy i podglądy. `locked` udaje telefon przed pierwszym odblokowaniem,
/// `readFailure` i `addFailure` odmowy Keychaina, `staleReads` drugi proces: tyle najbliższych odczytów widzi brak
/// wpisu, choć wpis już jest (okno między odczytem a zapisem), więc zapis kończy się `errSecDuplicateItem`.
public final class MemoryIrohIdentityKeychain: IrohIdentityKeychain {
  public struct Contents: Sendable, Equatable {
    public var data: Data?
    public var locked = false
    public var readFailure: Int32?
    public var addFailure: Int32?
    public var staleReads = 0
    /// Udane zapisy wpisu.
    public var writes = 0
    /// Zapisy odrzucone `errSecDuplicateItem`.
    public var duplicates = 0

    public init(
      data: Data? = nil, locked: Bool = false, readFailure: Int32? = nil, addFailure: Int32? = nil, staleReads: Int = 0
    ) {
      self.data = data
      self.locked = locked
      self.readFailure = readFailure
      self.addFailure = addFailure
      self.staleReads = staleReads
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

  public func read() -> IrohIdentityItemRead {
    contents.withLock { state in
      if state.locked { return .locked }
      if let status = state.readFailure { return .failed(status) }
      if state.staleReads > 0 {
        state.staleReads -= 1
        return .none
      }
      return state.data.map(IrohIdentityItemRead.found) ?? .none
    }
  }

  public func add(_ data: Data) throws(KeychainFailure) {
    let failure: Int32? = contents.withLock { state in
      if state.locked { return errSecInteractionNotAllowed }
      if let status = state.addFailure { return status }
      guard state.data == nil else {
        state.duplicates += 1
        return errSecDuplicateItem
      }
      state.data = data
      state.writes += 1
      return nil
    }
    if let failure { throw KeychainFailure(status: failure) }
  }

  public func delete() {
    contents.withLock { $0.data = nil }
  }
}

/// Jedyna droga do tożsamości iroh w procesie. Aktor szereguje odczyty, więc pierwszy zapis jest jeden; zapisany klucz
/// zostaje w pamięci aktora (porażki nie: następna prośba czyta Keychain od nowa).
public actor IrohIdentityStore {
  private let keychain: any IrohIdentityKeychain
  private let now: @Sendable () -> Date
  private let random: @Sendable () -> Data?
  private var cached: IrohIdentity?

  public init(
    keychain: any IrohIdentityKeychain, now: @escaping @Sendable () -> Date = { Date() },
    random: @escaping @Sendable () -> Data? = IrohIdentityStore.systemRandom
  ) {
    self.keychain = keychain
    self.now = now
    self.random = random
  }

  /// 32 B z `SecRandomCopyBytes`; `nil` = generator odmówił.
  public static func systemRandom() -> Data? {
    var bytes = [UInt8](repeating: 0, count: IrohIdentityStored.secretLength)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
    return Data(bytes)
  }

  /// Tożsamość z Keychaina, a przy braku wpisu nowa — zapisana, zanim wróci.
  public func identity() -> IrohIdentityRead {
    if let cached { return .ready(cached) }
    switch keychain.read() {
    case let .found(data): return accept(data)
    case .locked: return .unavailable(.locked)
    case let .failed(status): return .unavailable(.failed(status))
    case .none: return create()
    }
  }

  /// Kasuje wpis i pamięć aktora (reset testów UI).
  public func delete() {
    cached = nil
    keychain.delete()
  }

  private func accept(_ data: Data) -> IrohIdentityRead {
    guard let identity = IrohIdentityStored.decode(data) else { return .unavailable(.unreadable) }
    cached = identity
    return .ready(identity)
  }

  private func create() -> IrohIdentityRead {
    guard let secret = random(), secret.count == IrohIdentityStored.secretLength else {
      return .unavailable(.noRandom)
    }
    guard let data = IrohIdentityStored.encode(secretKey: secret, createdAt: now()) else {
      return .unavailable(.notSaved(errSecParam))
    }
    do throws(KeychainFailure) {
      try keychain.add(data)
    } catch where error.status == errSecDuplicateItem {
      // Ktoś zapisał między odczytem a zapisem: obowiązuje jego klucz.
      switch keychain.read() {
      case let .found(saved): return accept(saved)
      case .locked: return .unavailable(.locked)
      case let .failed(status): return .unavailable(.failed(status))
      case .none: return .unavailable(.notSaved(errSecDuplicateItem))
      }
    } catch {
      return .unavailable(.notSaved(error.status))
    }
    let identity = IrohIdentity(secretKey: secret, createdAt: IrohIdentityStored.decode(data)?.createdAt)
    cached = identity
    return .ready(identity)
  }
}
