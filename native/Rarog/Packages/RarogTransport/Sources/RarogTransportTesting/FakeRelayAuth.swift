import Foundation
import RarogContract
import RarogTransport
import Synchronization

// Atrapy klienta rejestru relaya iroh (`RelayAccess/`) dla testów tego pakietu i pakietów nad nim: rejestr
// (``FakeRelayAuthTransport``), bramka (``FakeRelayGate``), podpis (``FakeRelaySigner``) i magazyn w pamięci
// (``FakeRelayAccessStore``). Bez sieci, bez Keychaina, bez IrohLib i bez DeviceCheck.
//
// Każda atrapa ustawia w `init` pole `marker` na ``relayFakeMarker``, a atrapa bramki wkłada znacznik do tokenu, więc
// plik wykonywalny, który użyłby atrapy, niesie napis `RAROG_TEST_ONLY_RELAY_FAKE` (oględziny `strings` przed
// wydaniem). Apka tej biblioteki nie linkuje.

/// Znacznik atrap rejestru: napis na ścieżce wykonania każdej atrapy.
public let relayFakeMarker = "RAROG_TEST_ONLY_RELAY_FAKE"

// MARK: Rejestr

/// Rejestr atrapy: zapisuje każde żądanie i oddaje odpowiedzi z kolejki trasy, a bez nich z `responder`
/// (domyślnie `.unreachable`). `responder` może czekać (zegar atrapy, ciągłość), więc test steruje chwilą odpowiedzi.
public final class FakeRelayAuthTransport: RelayAuthTransport {
  /// Żądanie, które dotarło do atrapy.
  public struct Call: Sendable, Equatable {
    public let fields: RelayAuthWire.Fields
    public let endpointId: String
    public let issuedAt: Int64
    public let registry: URL

    public var route: RelayAuthWire.Route { fields.route }
  }

  public typealias Responder = @Sendable (Call) async -> RelayAuthReply

  private struct State {
    var calls: [Call] = []
    var queued: [RelayAuthWire.Route: [RelayAuthReply]] = [:]
    var inFlight = 0
    var maxInFlight = 0
  }

  public let marker: String
  private let responder: Responder
  private let state = Mutex(State())

  public init(_ responder: Responder? = nil) {
    marker = relayFakeMarker
    self.responder = responder ?? { _ in .unreachable("\(relayFakeMarker): no reply") }
  }

  /// Dokłada odpowiedzi trasy (pierwsza w kolejce idzie do najbliższego żądania tej trasy).
  public func enqueue(_ route: RelayAuthWire.Route, _ replies: RelayAuthReply...) {
    state.withLock { $0.queued[route, default: []].append(contentsOf: replies) }
  }

  /// Żądania w kolejności nadejścia.
  public var calls: [Call] { state.withLock { $0.calls } }
  /// Trasy żądań w kolejności nadejścia.
  public var routes: [RelayAuthWire.Route] { calls.map(\.route) }
  /// Najwięcej żądań w toku naraz.
  public var maxInFlight: Int { state.withLock { $0.maxInFlight } }

  public func send(_ fields: RelayAuthWire.Fields, signer: any TunnelSigner, issuedAt: Int64, registry: URL) async
    -> RelayAuthReply {
    let call = Call(fields: fields, endpointId: signer.endpointId, issuedAt: issuedAt, registry: registry)
    let queued = state.withLock { state -> RelayAuthReply? in
      state.calls.append(call)
      state.inFlight += 1
      state.maxInFlight = max(state.maxInFlight, state.inFlight)
      guard var replies = state.queued[call.route], !replies.isEmpty else { return nil }
      let reply = replies.removeFirst()
      state.queued[call.route] = replies
      return reply
    }
    let reply: RelayAuthReply
    if let queued { reply = queued } else { reply = await responder(call) }
    state.withLock { $0.inFlight -= 1 }
    return reply
  }

  // Odpowiedzi 200 trasy: typy kontraktu nie mają publicznego `init`, więc powstają z ciała JSON.

  public static func registered(endpointId: String, expiresAt: Int64) -> RelayAuthReply {
    .registered(decode(#"{"v":1,"endpointId":"\#(endpointId)","expiresAt":\#(expiresAt)}"#))
  }

  public static func renewed(expiresAt: Int64, unsponsored: [String] = []) -> RelayAuthReply {
    let list = unsponsored.map { "\"\($0)\"" }.joined(separator: ",")
    return .renewed(decode(#"{"v":1,"expiresAt":\#(expiresAt),"unsponsored":[\#(list)]}"#))
  }

  public static func sponsored(server: String, expiresAt: Int64) -> RelayAuthReply {
    .sponsored(decode(#"{"v":1,"server":"\#(server)","expiresAt":\#(expiresAt)}"#))
  }

  public static func forgotten() -> RelayAuthReply {
    .forgotten(decode(#"{"v":1,"forgotten":true}"#))
  }

  /// Błąd kontraktu z jego statusem HTTP.
  public static func failure(_ code: RelayAuthWire.ErrorCode, gate: RelayAuthWire.Gate? = nil) -> RelayAuthReply {
    .failure(status: code.status, code: code, gate: gate)
  }

  private static func decode<T: Decodable>(_ json: String) -> T {
    do {
      return try RelayAuthWire.decode(T.self, from: Data(json.utf8))
    } catch {
      fatalError("\(relayFakeMarker): odpowiedź atrapy nie dekoduje się — \(error)")
    }
  }
}

// MARK: Bramka

/// Bramka atrapy: każdy `proof()` daje nowy token ze znacznikiem i numerem próby (DeviceCheck: base64, APNs: hex),
/// porażki z kolejki ``failNext(_:)`` idą przed tokenem, a `before` może wstrzymać próbę.
public final class FakeRelayGate: RelayGate {
  private struct State {
    var supported: Bool
    var attempts = 0
    var failures: [RelayGateFailure] = []
  }

  public let marker: String
  public let kind: RelayAuthWire.Gate
  public let environment: RelayAuthWire.Environment
  private let before: (@Sendable (_ attempt: Int) async -> Void)?
  private let state: Mutex<State>

  public init(
    kind: RelayAuthWire.Gate = .devicecheck, environment: RelayAuthWire.Environment = .development,
    isSupported: Bool = true, before: (@Sendable (_ attempt: Int) async -> Void)? = nil
  ) {
    marker = relayFakeMarker
    self.kind = kind
    self.environment = environment
    self.before = before
    state = Mutex(State(supported: isSupported))
  }

  public var isSupported: Bool {
    get { state.withLock { $0.supported } }
    set { state.withLock { $0.supported = newValue } }
  }

  /// Rozpoczęte próby `proof()`.
  public var attempts: Int { state.withLock { $0.attempts } }

  /// Najbliższe próby kończą się tymi porażkami, po kolei.
  public func failNext(_ failures: RelayGateFailure...) {
    state.withLock { $0.failures.append(contentsOf: failures) }
  }

  public func proof() async throws(RelayGateFailure) -> RelayAuthWire.Proof {
    let attempt = state.withLock { state in
      state.attempts += 1
      return state.attempts
    }
    if let before { await before(attempt) }
    let failure = state.withLock { state -> RelayGateFailure? in
      state.failures.isEmpty ? nil : state.failures.removeFirst()
    }
    if let failure { throw failure }
    return RelayAuthWire.Proof(kind: kind, environment: environment, token: Self.token(kind, attempt: attempt))
  }

  /// Token próby `attempt` w kształcie bramki `kind`, z ``relayFakeMarker`` w treści.
  public static func token(_ kind: RelayAuthWire.Gate, attempt: Int) -> String {
    let bytes = Data("\(relayFakeMarker)-\(attempt)".utf8)
    switch kind {
    case .devicecheck: return bytes.base64EncodedString()
    case .apns: return bytes.map { String(format: "%02x", $0) }.joined()
    }
  }
}

// MARK: Podpis

/// Podpis atrapy: 64 B wyliczone z treści (nie Ed25519), więc test sprawdza, które bajty podpisano. `failure` =
/// każdy podpis rzuca.
public final class FakeRelaySigner: TunnelSigner {
  public let marker: String
  public let endpointId: String
  private let failure: TunnelFailure?
  private let signed = Mutex<[Data]>([])

  public init(endpointId: String = String(repeating: "c3", count: 32), failure: TunnelFailure? = nil) {
    marker = relayFakeMarker
    self.endpointId = endpointId
    self.failure = failure
  }

  /// Podpisane treści, po kolei.
  public var messages: [Data] { signed.withLock { $0 } }

  public func sign(_ message: Data) throws -> Data {
    if let failure { throw failure }
    signed.withLock { $0.append(message) }
    return Self.signature(for: message)
  }

  /// 64 B: FNV-1a 64 treści, potem osiem kolejnych mieszań.
  public static func signature(for message: Data) -> Data {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in message {
      hash ^= UInt64(byte)
      hash &*= 0x0000_0100_0000_01b3
    }
    var out = Data()
    for round in 0..<8 {
      hash ^= UInt64(round)
      hash &*= 0x0000_0100_0000_01b3
      withUnsafeBytes(of: hash.bigEndian) { out.append(contentsOf: $0) }
    }
    return out
  }
}

// MARK: Magazyn

/// Magazyn w pamięci z odmowami: wpis nieczytelny (`cacheUnreadable`, `optOutUnreadable` wygrywają z treścią),
/// nieudany zapis i kasowanie. Liczniki pokazują, ile razy coś zapisano. Nowy magazyn na tych samych `Contents` to
/// „restart procesu”.
public final class FakeRelayAccessStore: RelayAccessStore {
  public struct Contents: Sendable, Equatable {
    public var cache: RelayAccessCache?
    public var optOut: RelayOptOut?
    /// Wpis pamięci jest, ale odczyt odrzucony (powód).
    public var cacheUnreadable: String?
    /// Wpis rezygnacji jest, ale nie do odczytu (powód).
    public var optOutUnreadable: String?
    public var cacheSaveFails = false
    public var optOutSaveFails = false
    public var optOutDeleteFails = false
    /// Udane zapisy pamięci.
    public var cacheSaves = 0
    /// Udane zapisy rezygnacji.
    public var optOutSaves = 0
    /// Udane kasowania rezygnacji.
    public var optOutDeletes = 0

    public init(cache: RelayAccessCache? = nil, optOut: RelayOptOut? = nil, optOutUnreadable: String? = nil) {
      self.cache = cache
      self.optOut = optOut
      self.optOutUnreadable = optOutUnreadable
    }
  }

  public let marker: String
  private let contents: Mutex<Contents>

  public init(_ contents: Contents = Contents()) {
    marker = relayFakeMarker
    self.contents = Mutex(contents)
  }

  public var snapshot: Contents { contents.withLock { $0 } }

  public func update(_ change: (inout Contents) -> Void) {
    contents.withLock { change(&$0) }
  }

  public func loadCache() -> RelayStoredRead<RelayAccessCache> {
    contents.withLock { state in
      if let reason = state.cacheUnreadable { return .unreadable(reason) }
      return state.cache.map(RelayStoredRead.found) ?? .none
    }
  }

  public func saveCache(_ cache: RelayAccessCache) -> Bool {
    contents.withLock { state in
      guard !state.cacheSaveFails else { return false }
      state.cache = cache
      state.cacheUnreadable = nil
      state.cacheSaves += 1
      return true
    }
  }

  public func loadOptOut() -> RelayStoredRead<RelayOptOut> {
    contents.withLock { state in
      if let reason = state.optOutUnreadable { return .unreadable(reason) }
      return state.optOut.map(RelayStoredRead.found) ?? .none
    }
  }

  public func saveOptOut(_ optOut: RelayOptOut) -> Bool {
    contents.withLock { state in
      guard !state.optOutSaveFails else { return false }
      state.optOut = optOut
      state.optOutUnreadable = nil
      state.optOutSaves += 1
      return true
    }
  }

  public func deleteOptOut() -> Bool {
    contents.withLock { state in
      guard !state.optOutDeleteFails else { return false }
      state.optOut = nil
      state.optOutUnreadable = nil
      state.optOutDeletes += 1
      return true
    }
  }
}
