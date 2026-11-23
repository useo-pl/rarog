import Foundation
import IrohLib
import RarogTransport
import Synchronization

// Adapter IrohLib 1.2.0 do protokołów tunelu z `RarogTransport` (`Tunnel/TunnelTypes.swift`). Tu kończy się
// IrohLib: typy biblioteki nie wychodzą poza ten pakiet, a jej błędy wychodzą jako `TunnelFailure`.
//
// Fakty o wiązaniu, na których stoi ten plik (testy `IrohLiveTests`, IrohLib 1.2.0, macOS na Apple silicon):
//
// 1. `connect` nie czeka na `online()`: adres celu niesie relay serwera, a `online()` bez osiągalnego relaya
//    domowego nie kończy się nigdy i nie da się go anulować.
// 2. `Connection.close` jest synchroniczne i kończy wiszące `read` i `writeAll` błędem w kilka milisekund.
// 3. `reset` czeka na wiszące `writeAll`, a `stop` na wiszące `read` (mutex na każdą połowę strumienia), więc
//    `abort` woła oba naraz, a górną granicę czasu pilnuje wołający (zamknięciem połączenia).
// 4. Anulowanie zadania Swifta nie dochodzi do Rusta: spóźniony `bind` i tak tworzy endpoint, który trzeba
//    zamknąć (pilnuje tego wołający z budżetem, nie adapter).
// 5. `closed()` i `closeReason()` oddają napis, nie kod: kod aplikacji drugiej strony wyciąga `IrohCloseReason`
//    (`closed by peer: 3`, z powodem `closed by peer: revoked (code 3)`; zamknięcie lokalne: `closed`).
// 6. Porzucony `SendStream` biblioteka kończy FIN-em, nie resetem: strumień, którego nikt nie zamknął jawnie,
//    wygląda po drugiej stronie na kompletny. Przerwanie strumienia to zawsze `abort`.

/// Fabryka endpointów iroh na IrohLib: `presetMinimal` (bez publikacji adresu i bez wyszukiwania), klucz 32 B
/// i relay domowy jako jedyny relay endpointu.
public struct IrohTunnelTransport: TunnelTransport {
  /// Relaye endpointu.
  enum Relays: Sendable, Equatable {
    /// Relay domowy z `bind` (`RelayMode.customFromUrls`); relaye celów dokłada `ensureRelay`.
    case home
    /// Bez relaya: dwa endpointy w jednym procesie, bez sieci zewnętrznej (testy żywe).
    case disabled
  }

  let relays: Relays
  /// Adresy bezpośrednie celu (`host:port`) dokładane do adresu połączenia; w apce puste, bo drogę znajduje relay.
  let directAddresses: @Sendable (TunnelTarget) -> [String]

  public init() {
    self.init(relays: .home, directAddresses: { _ in [] })
  }

  init(relays: Relays, directAddresses: @escaping @Sendable (TunnelTarget) -> [String]) {
    self.relays = relays
    self.directAddresses = directAddresses
  }

  public func bind(secretKey: Data, homeRelay: URL) async throws -> any TunnelEndpoint {
    guard secretKey.count == 32 else {
      throw TunnelFailure.bindFailed("secret key has \(secretKey.count) bytes, expected 32")
    }
    let mode: RelayMode
    switch relays {
    case .home:
      do { mode = try RelayMode.customFromUrls(urls: [homeRelay.absoluteString]) } catch {
        throw TunnelFailure.bindFailed(IrohFailure.describe(error))
      }
    case .disabled:
      mode = RelayMode.disabled()
    }
    let options = EndpointOptions(preset: presetMinimal(), secretKey: secretKey, relayMode: mode)
    let endpoint: Endpoint
    do { endpoint = try await Endpoint.bind(options: options) } catch {
      throw TunnelFailure.bindFailed(IrohFailure.describe(error))
    }
    let known: Set<String> = relays == .home ? [homeRelay.absoluteString] : []
    return IrohTunnelEndpoint(endpoint, knownRelays: known, directAddresses: directAddresses)
  }
}

/// Endpoint iroh apki: jedna tożsamość, połączenia do serwerów.
final class IrohTunnelEndpoint: TunnelEndpoint {
  /// Dołożenie relaya do endpointu; testy podstawiają własne, żeby sprawdzić czekanie i błąd.
  typealias RelayInsert = @Sendable (Endpoint, String) async throws -> Void

  static let insertRelayLive: RelayInsert = { endpoint, url in
    try await endpoint.insertRelay(config: RelayConfig(url: url, quicPort: nil, authToken: nil))
  }

  let endpoint: Endpoint
  let endpointId: String
  private let directAddresses: @Sendable (TunnelTarget) -> [String]
  private let insertRelay: RelayInsert
  private let state: Mutex<State>

  private struct State {
    /// Relaye, które endpoint zna (domowy i dołożone przez `ensureRelay`), w postaci z linku parowania. Relay trafia
    /// tu dopiero po udanym dołożeniu.
    var knownRelays: Set<String>
    /// Dołożenia w toku, po relayu: równoczesne `ensureRelay` czekają na to samo zadanie i dostają jego wynik.
    var inserting: [String: Task<Void, any Error>] = [:]
    /// Ile razy `ensureRelay` dołożył relay do endpointu (testy).
    var relaysInserted = 0
    var closing = false
  }

  init(
    _ endpoint: Endpoint, knownRelays: Set<String>, directAddresses: @escaping @Sendable (TunnelTarget) -> [String],
    insertRelay: @escaping RelayInsert = IrohTunnelEndpoint.insertRelayLive
  ) {
    self.endpoint = endpoint
    endpointId = endpoint.id().description
    self.directAddresses = directAddresses
    self.insertRelay = insertRelay
    state = Mutex(State(knownRelays: knownRelays))
  }

  /// Ile razy `ensureRelay` dołożył relay (testy).
  var relaysInserted: Int { state.withLock { $0.relaysInserted } }

  func connect(to target: TunnelTarget, alpn: Data) async throws -> any TunnelConnection {
    let id: EndpointId
    do { id = try EndpointId.fromString(s: target.endpointId) } catch {
      throw TunnelFailure.connectFailed(IrohFailure.describe(error))
    }
    let address = EndpointAddr(id: id, relayUrl: target.relay.absoluteString, addresses: directAddresses(target))
    do { return IrohTunnelConnection(try await endpoint.connect(addr: address, alpn: alpn)) } catch {
      throw TunnelFailure.connectFailed(IrohFailure.describe(error))
    }
  }

  func ensureRelay(_ relay: URL) async throws {
    let url = relay.absoluteString
    let endpoint = endpoint
    let insertRelay = insertRelay
    let task: Task<Void, any Error>? = state.withLock { state in
      if state.knownRelays.contains(url) { return nil }
      if let running = state.inserting[url] { return running }
      let started = Task { try await insertRelay(endpoint, url) }
      state.inserting[url] = started
      return started
    }
    guard let task else { return }
    do {
      try await task.value
      state.withLock { state in
        // Pierwszy, który zobaczy koniec, zapisuje relay jako znany; reszta czekających nic nie liczy drugi raz.
        guard state.inserting.removeValue(forKey: url) != nil else { return }
        state.knownRelays.insert(url)
        state.relaysInserted += 1
      }
    } catch {
      state.withLock { _ = $0.inserting.removeValue(forKey: url) }
      throw TunnelFailure.connectFailed("relay \(url): \(IrohFailure.describe(error))")
    }
  }

  /// Zamyka endpoint raz; drugie wołanie wraca od razu. Błąd zamknięcia nie ma odbiorcy: endpoint i tak przestaje
  /// służyć, a wiszące zamknięcie liczy wołający (termin i log).
  func close() async {
    let first = state.withLock { state in
      defer { state.closing = true }
      return !state.closing
    }
    guard first else { return }
    try? await endpoint.close()
  }
}

/// Połączenie QUIC z serwerem.
final class IrohTunnelConnection: TunnelConnection {
  let connection: Connection

  init(_ connection: Connection) {
    self.connection = connection
  }

  func openStream() async throws -> any TunnelStream {
    do {
      let pair = try await connection.openBi()
      return IrohTunnelStream(send: pair.send(), recv: pair.recv(), connection: connection)
    } catch {
      throw IrohFailure.stream(error, connection: connection)
    }
  }

  func close(code: UInt64, reason: String) {
    // Wiązanie przyjmuje kod ze znakiem i odrzuca ujemny; kody apki to 0 i 1.
    try? connection.close(errorCode: Int64(clamping: code), reason: Data(reason.utf8))
  }

  func closed() async -> TunnelFailure {
    IrohCloseReason.failure(await connection.closed())
  }
}

/// Strumień dwukierunkowy: jedno połączenie HTTP/1.1.
final class IrohTunnelStream: TunnelStream {
  private let send: SendStream
  private let recv: RecvStream
  private let connection: Connection

  init(send: SendStream, recv: RecvStream, connection: Connection) {
    self.send = send
    self.recv = recv
    self.connection = connection
  }

  func read(maxBytes: Int) async throws -> Data {
    // Pusty bufor z biblioteki znaczy FIN, więc limit jest co najmniej 1 B.
    let limit = UInt32(clamping: max(maxBytes, 1))
    do { return try await recv.read(sizeLimit: limit) } catch {
      throw IrohFailure.stream(error, connection: connection)
    }
  }

  func write(_ data: Data) async throws {
    do { try await send.writeAll(buf: data) } catch {
      throw IrohFailure.stream(error, connection: connection)
    }
  }

  func finish() async throws {
    do { try await send.finish() } catch {
      throw IrohFailure.stream(error, connection: connection)
    }
  }

  func abort(code: UInt64) async {
    // `reset` czeka na wiszące `writeAll`, a `stop` na wiszące `read`: oba naraz, żeby żadne nie czekało na drugie.
    let send = send
    let recv = recv
    async let reset: Void = { try? await send.reset(errorCode: code) }()
    async let stop: Void = { try? await recv.stop(errorCode: code) }()
    _ = await (reset, stop)
  }
}
