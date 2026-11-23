import Foundation
import RarogContract

// Klient rejestru relaya iroh (Worker `relay-auth/`, kontrakt `RelayAuthWire`): typy i protokoły wspólne dla klienta
// HTTP (`RelayAuthClient.swift`), wpisów Keychaina (`RelayAccessStore.swift`) i atrap testów
// (`RarogTransportTesting/FakeRelayAuth.swift`). Cały kod klienta rejestru leży w katalogu `RelayAccess/`; tunel
// (`Tunnel/`) go nie zna, a ten katalog nie zna `RarogCore`, IrohLib, DeviceCheck ani UIKit: podpis przychodzi przez
// `TunnelSigner`, dowód urządzenia przez `RelayGate`. Rejestr nigdy nie blokuje iroh: każda porażka to stan
// i podpowiedź, nie odmowa połączenia.

// MARK: Bramka

/// Dowód urządzenia dla `register` (DeviceCheck albo APNs); produkcja w celu apki, testy atrapa.
public protocol RelayGate: Sendable {
  var kind: RelayAuthWire.Gate { get }
  /// `false` = bez `register`, status `.unsupported`.
  var isSupported: Bool { get }
  /// Nowy token na każdą próbę (token DeviceCheck traktujemy jak jednorazowy).
  func proof() async throws(RelayGateFailure) -> RelayAuthWire.Proof
}

/// Dlaczego bramka nie dała dowodu.
public enum RelayGateFailure: Error, Sendable, Equatable {
  case unsupported
  case failed(String)
}

// MARK: Rejestr

/// Wynik jednego żądania do rejestru.
public enum RelayAuthReply: Sendable, Equatable {
  case registered(RelayAuthWire.Registered)
  case renewed(RelayAuthWire.Renewed)
  case sponsored(RelayAuthWire.Sponsored)
  case forgotten(RelayAuthWire.Forgotten)
  /// Odpowiedź bez znanego wyniku: kod błędu (`code` = `nil` przy kodzie spoza kontraktu albo ciele bez JSON v1),
  /// także 2xx bez wyniku trasy i 200, które nie przeszło walidacji.
  case failure(status: Int, code: RelayAuthWire.ErrorCode?, gate: RelayAuthWire.Gate?)
  /// Brak odpowiedzi: sieć, termin żądania (10 s) albo żądanie, które nie wyszło (podpis).
  case unreachable(String)
}

/// Wysyłka żądania trasy apki do rejestru. Produkcja ``RelayAuthClient``, testy atrapa.
public protocol RelayAuthTransport: Sendable {
  /// Żądanie `fields` od `signer.endpointId` z chwilą `issuedAt` (sekundy epoki), podpisane `signer`, do rejestru
  /// `registry` (origin Workera bez ukośnika).
  func send(_ fields: RelayAuthWire.Fields, signer: any TunnelSigner, issuedAt: Int64, registry: URL) async
    -> RelayAuthReply
}

// MARK: Stan zapisany

/// Pamięć podręczna klienta (konto `relay-access`). Czasy w sekundach epoki. Treść: JSON
/// `{"version":1, "appId", "registry", "registeredUntil"?, "lastSyncAt"?, "sponsored":{serwer: s}, "failures",
/// "retryAt"?, "problem"?, "lastTunnelCheckAt"?}`; nieznane klucze pominięte, `version` ≠ 1 albo zły JSON = brak
/// pamięci.
public struct RelayAccessCache: Sendable, Equatable, Codable {
  public static let version = 1

  /// EndpointId apki (64 znaki hex), dla którego zapisano stan.
  public var appId: String
  /// Origin Workera rejestru.
  public var registry: URL
  /// Termin wpisu apki w rejestrze.
  public var registeredUntil: Int64?
  /// Ostatnia udana synchronizacja.
  public var lastSyncAt: Int64?
  /// Żywe poręczenia: EndpointId serwera → termin.
  public var sponsored: [String: Int64]
  /// Kolejne porażki `unreachable` (przerwa wykładnicza).
  public var failures: Int
  /// Najbliższa dozwolona próba po porażce.
  public var retryAt: Int64?
  public var problem: RelayAccessProblem?
  /// Ostatnie sprawdzenie po porażce tunelu.
  public var lastTunnelCheckAt: Int64?

  public init(
    appId: String, registry: URL, registeredUntil: Int64? = nil, lastSyncAt: Int64? = nil,
    sponsored: [String: Int64] = [:], failures: Int = 0, retryAt: Int64? = nil, problem: RelayAccessProblem? = nil,
    lastTunnelCheckAt: Int64? = nil
  ) {
    self.appId = appId
    self.registry = registry
    self.registeredUntil = registeredUntil
    self.lastSyncAt = lastSyncAt
    self.sponsored = sponsored
    self.failures = failures
    self.retryAt = retryAt
    self.problem = problem
    self.lastTunnelCheckAt = lastTunnelCheckAt
  }

  private enum Key: String, CodingKey {
    case version, appId, registry, registeredUntil, lastSyncAt, sponsored, failures, retryAt, problem
    case lastTunnelCheckAt
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: Key.self)
    try RelayStoredVersion.check(container, .version, Self.version)
    appId = try container.decode(String.self, forKey: .appId)
    registry = try container.decode(URL.self, forKey: .registry)
    registeredUntil = try container.decodeIfPresent(Int64.self, forKey: .registeredUntil)
    lastSyncAt = try container.decodeIfPresent(Int64.self, forKey: .lastSyncAt)
    sponsored = try container.decode([String: Int64].self, forKey: .sponsored)
    failures = try container.decode(Int.self, forKey: .failures)
    retryAt = try container.decodeIfPresent(Int64.self, forKey: .retryAt)
    problem = try container.decodeIfPresent(RelayAccessProblem.self, forKey: .problem)
    lastTunnelCheckAt = try container.decodeIfPresent(Int64.self, forKey: .lastTunnelCheckAt)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: Key.self)
    try container.encode(Self.version, forKey: .version)
    try container.encode(appId, forKey: .appId)
    try container.encode(registry, forKey: .registry)
    try container.encodeIfPresent(registeredUntil, forKey: .registeredUntil)
    try container.encodeIfPresent(lastSyncAt, forKey: .lastSyncAt)
    try container.encode(sponsored, forKey: .sponsored)
    try container.encode(failures, forKey: .failures)
    try container.encodeIfPresent(retryAt, forKey: .retryAt)
    try container.encodeIfPresent(problem, forKey: .problem)
    try container.encodeIfPresent(lastTunnelCheckAt, forKey: .lastTunnelCheckAt)
  }
}

/// Rezygnacja z rejestru (konto `relay-optout`). Należy do urządzenia, nie do EndpointId: wpis z innym `appId` też
/// wstrzymuje automatyczną rejestrację. Treść: JSON `{"version":1, "appId", "registry", "at", "removal"}`.
public struct RelayOptOut: Sendable, Equatable, Codable {
  public static let version = 1

  /// EndpointId apki w chwili rezygnacji.
  public var appId: String
  /// Origin Workera rejestru, do którego idzie `forget`.
  public var registry: URL
  /// Chwila rezygnacji (sekundy epoki).
  public var at: Int64
  public var removal: RelayRemoval

  public init(appId: String, registry: URL, at: Int64, removal: RelayRemoval) {
    self.appId = appId
    self.registry = registry
    self.at = at
    self.removal = removal
  }

  private enum Key: String, CodingKey {
    case version, appId, registry, at, removal
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: Key.self)
    try RelayStoredVersion.check(container, .version, Self.version)
    appId = try container.decode(String.self, forKey: .appId)
    registry = try container.decode(URL.self, forKey: .registry)
    at = try container.decode(Int64.self, forKey: .at)
    removal = try container.decode(RelayRemoval.self, forKey: .removal)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: Key.self)
    try container.encode(Self.version, forKey: .version)
    try container.encode(appId, forKey: .appId)
    try container.encode(registry, forKey: .registry)
    try container.encode(at, forKey: .at)
    try container.encode(removal, forKey: .removal)
  }
}

/// Wersja treści wpisu: inna niż oczekiwana = wpis nieczytelny.
enum RelayStoredVersion {
  /// Błąd dekodowania, którego opis podaje znalezioną wersję (linia logu bez treści wpisu).
  struct Mismatch: Error, Sendable, Equatable {
    let found: Int
  }

  static func check<K: CodingKey>(_ container: KeyedDecodingContainer<K>, _ key: K, _ expected: Int) throws {
    let found = try container.decode(Int.self, forKey: key)
    guard found == expected else { throw Mismatch(found: found) }
  }
}

/// Odczyt wpisu.
public enum RelayStoredRead<Value: Sendable & Equatable>: Sendable, Equatable {
  case found(Value)
  case none
  /// Jest wpis, ale nie do odczytu (zła treść albo odczyt odrzucony); powód bez treści wpisu.
  case unreadable(String)
}

/// Pamięć podręczna i rezygnacja. Produkcja ``SystemRelayAccessStore`` (Keychain), testy pamięć.
public protocol RelayAccessStore: Sendable {
  /// Pamięć: wpis z treścią spoza v1 to `none` (z linią logu), odczyt odrzucony to `unreadable`.
  func loadCache() -> RelayStoredRead<RelayAccessCache>
  /// `false` = praca w pamięci procesu.
  func saveCache(_ cache: RelayAccessCache) -> Bool
  /// Rezygnacja: wpis z treścią spoza v1 albo odczyt odrzucony to `unreadable`, wpis zostaje nietknięty.
  func loadOptOut() -> RelayStoredRead<RelayOptOut>
  /// `false` = rezygnacji nie ma, więc bez `forget`.
  func saveOptOut(_ optOut: RelayOptOut) -> Bool
  /// Kasuje rezygnację, także wpis nieczytelny; `true` także przy braku wpisu.
  func deleteOptOut() -> Bool
}

// MARK: Stan dla apki

/// Problem klienta rejestru. Kolejność przypadków = ważność przy kilku naraz.
public enum RelayAccessProblem: String, Sendable, Equatable, Codable, CaseIterable {
  case denied, serverDenied, quota, serverQuota, limited, clock, gateMismatch, proofRejected, gateFailed
  case `internal`, unreachable, storage, optOutNotSaved
}

/// Stan usunięcia z rejestru po rezygnacji.
public enum RelayRemoval: String, Sendable, Equatable, Codable {
  case confirmed, pending, blockedByAdmin
}

/// Stan klienta rejestru dla apki (ekran „Serwer”).
public enum RelayAccessStatus: Sendable, Equatable {
  /// Brak serwera na relayu z mapy albo brak tożsamości.
  case inactive
  case working
  case registered(appId: String, until: Date)
  case unsupported(appId: String)
  case optedOut(appId: String, removal: RelayRemoval)
  case problem(RelayAccessProblem, appId: String, retryAt: Date?)
}

/// Wyzwalacz automatyczny synchronizacji.
public enum RelayAccessTrigger: Sendable, Equatable {
  case start, foreground, identityAvailable, tunnelFailed
}

/// Wynik przygotowania parowania przez iroh.
public enum RelayPrepareResult: Sendable, Equatable {
  /// Relay spoza mapy, brak tożsamości albo bramki: parowanie jak bez rejestru.
  case skipped
  /// Apka i serwer miały już żywy wpis i poręczenie.
  case ready
  /// W tym wywołaniu nowy `register` albo nowe poręczenie: relay wpuści z opóźnieniem.
  case fresh
  /// Budżet minął albo porażka: parowanie idzie dalej, synchronizacja w tle.
  case unavailable
}
