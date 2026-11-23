import Foundation

// Typy tunelu iroh bez biblioteki natywnej. Spełnia je adapter IrohLib w osobnym pakiecie, który linkuje tylko apka,
// i atrapy testów; reszta kodu transportu widzi wyłącznie te protokoły.

/// Cel połączenia tunelu: serwer po EndpointId i jego relay.
public struct TunnelTarget: Sendable, Hashable {
  /// 64 znaki hex, małe litery (`PairingLinkWire.isEndpointId`).
  public let endpointId: String
  /// Postać kanoniczna pola `r` linku parowania.
  public let relay: URL

  public init(endpointId: String, relay: URL) {
    self.endpointId = endpointId
    self.relay = relay
  }
}

/// Porażka tunelu.
public enum TunnelFailure: Error, Sendable, Equatable {
  case bindFailed(String), connectFailed(String), timedOut
  /// Połączenie zamknięte; `code` to kod 0–5 serwera z `closeReason()`, `nil` bez kodu aplikacji.
  case closed(code: UInt64?, reason: String)
  /// Tunel niedostępny: tożsamość, sufit operacji natywnych, endpoint w zamykaniu.
  case unavailable(String)
}

/// Strumień dwukierunkowy tunelu: jedno połączenie HTTP/1.1.
public protocol TunnelStream: AnyObject, Sendable {
  /// Do `maxBytes` bajtów; pusty `Data` = FIN drugiej strony.
  func read(maxBytes: Int) async throws -> Data
  func write(_ data: Data) async throws
  /// FIN zapisu.
  func finish() async throws
  /// Reset i stop strumienia; termin pilnuje wołający.
  func abort(code: UInt64) async
}

/// Połączenie tunelu z serwerem.
public protocol TunnelConnection: AnyObject, Sendable {
  func openStream() async throws -> any TunnelStream
  /// Zamknięcie synchroniczne (`Connection.close`).
  func close(code: UInt64, reason: String)
  /// Czeka na koniec połączenia i oddaje powód.
  func closed() async -> TunnelFailure
}

/// Endpoint iroh apki: jedna tożsamość, połączenia do serwerów.
public protocol TunnelEndpoint: AnyObject, Sendable {
  var endpointId: String { get }
  func connect(to target: TunnelTarget, alpn: Data) async throws -> any TunnelConnection
  /// Dopisuje relay celu, gdy endpoint go nie zna.
  func ensureRelay(_ relay: URL) async throws
  func close() async
}

/// Fabryka endpointów iroh.
public protocol TunnelTransport: Sendable {
  /// Endpoint z kluczem tajnym (32 B) i relayem domowym.
  func bind(secretKey: Data, homeRelay: URL) async throws -> any TunnelEndpoint
}

/// Podpis kluczem iroh apki (Ed25519, 64 B); implementacja obok adaptera IrohLib.
public protocol TunnelSigner: Sendable {
  var endpointId: String { get }
  func sign(_ message: Data) throws -> Data
}
