import Foundation

// Droga do OpenAI Realtime: klucz krótki od wstrzykniętego dostawcy (serwer Raroga bije go z kluczem OpenAI ze swojej
// konfiguracji, jak klucz Soniox) i gniazdo WebSocket z tym kluczem. Właściciel: agent głosowy.
// Stałego klucza OpenAI apka nie ma i nie woła `client_secrets`.
//
// Osobna, efemeryczna sesja URL bez ciasteczek, pamięci podręcznej i poświadczeń Raroga (wzór
// `URLSessionVoiceSocket`): klucz urządzenia ani `Origin` Raroga nie mają prawa pojechać do OpenAI. Żaden opis typu
// w tym pliku nie drukuje klucza.

/// Klucz krótki Realtime od serwera. `model` — gdy serwer go poda, trafia do adresu gniazda; model i tak wiąże klucz.
struct RealtimeEphemeralKey: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
  let value: String
  let expiresAt: Date?
  let model: String?

  init(value: String, expiresAt: Date? = nil, model: String? = nil) {
    self.value = value
    self.expiresAt = expiresAt
    self.model = model
  }

  var description: String { "RealtimeEphemeralKey(value: <redacted>, model: \(model ?? "-"))" }
  var debugDescription: String { description }
}

/// Dlaczego klucza krótkiego nie ma.
enum RealtimeKeyError: Error, Sendable, Equatable {
  /// Serwer nie ma klucza OpenAI w konfiguracji.
  case keyMissing
  /// OpenAI odrzucił klucz serwera (401/403 przy `client_secrets`).
  case keyRejected
  /// Limit konta OpenAI (429).
  case limit
  /// Serwer Raroga dławi pobieranie kluczy (429 `companion-throttled`): za dużo prób z rzędu.
  case throttled
  /// Sieć, serwer niedostępny, inna odmowa.
  case unavailable
}

/// Dostawca klucza krótkiego; implementację (trasa serwera) dopina ekran rozmowy.
@MainActor
protocol RealtimeEphemeralKeyProvider: AnyObject {
  func ephemeralKey() async throws(RealtimeKeyError) -> RealtimeEphemeralKey
}

enum RealtimeEndpoint {
  /// Jak klucz krótki jedzie w żądaniu otwarcia gniazda.
  enum SocketAuth: Sendable, Equatable {
    /// Nagłówek `Authorization: Bearer` (tak łączył się pomiar z Node). Apple zastrzega nagłówek `Authorization`
    /// dla systemu (`URLRequest`, „Reserved HTTP headers”), więc na iOS może zostać pominięty.
    case header
    /// Lista protokołów WebSocket `realtime` i `openai-insecure-api-key.<klucz>` — droga, którą docs OpenAI
    /// podają dla przeglądarki (tam nagłówka ustawić się nie da). Tą drogą jedzie klucz Soniox (`SonioxKey`).
    case subprotocol
  }

  /// How the ephemeral key travels: as a WebSocket subprotocol,
  /// as with Soniox.
  static let socketAuth: SocketAuth = .subprotocol

  static let subprotocolName = "realtime"
  static let subprotocolKeyPrefix = "openai-insecure-api-key."

  /// Adres gniazda; `model` w zapytaniu tylko, gdy serwer podał go z kluczem.
  static func socketURL(model: String?) -> URL {
    var components = URLComponents(string: "wss://api.openai.com/v1/realtime")!
    if let model, !model.isEmpty { components.queryItems = [URLQueryItem(name: "model", value: model)] }
    return components.url!
  }

  static func socketRequest(model: String?, secret: String, auth: SocketAuth = socketAuth) -> RealtimeSocketRequest {
    let url = socketURL(model: model)
    switch auth {
    case .header:
      return RealtimeSocketRequest(url: url, protocols: [], headers: ["Authorization": "Bearer \(secret)"])
    case .subprotocol:
      return RealtimeSocketRequest(url: url, protocols: [subprotocolName, subprotocolKeyPrefix + secret], headers: [:])
    }
  }
}

/// Żądanie otwarcia gniazda; opis bez klucza (w protokołach albo w nagłówku).
struct RealtimeSocketRequest: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
  let url: URL
  let protocols: [String]
  let headers: [String: String]

  var description: String {
    "RealtimeSocketRequest(url: \(url.absoluteString), protocols: \(protocols.count), headers: \(headers.keys.sorted()))"
  }
  var debugDescription: String { description }
}

/// Gniazdo rozmowy; zdarzenia jak w dyktowaniu (`VoiceSocketEvents`: nigdy synchronicznie przy zakładaniu, nic po
/// `close()`).
typealias RealtimeSocketFactory = @MainActor (RealtimeSocketRequest, VoiceSocketEvents) -> any VoiceSocket

enum RealtimeNetwork {
  static let socket: RealtimeSocketFactory = { request, events in
    URLSessionRealtimeSocket(request: request, events: events)
  }
}

/// Gniazdo WebSocket do OpenAI na `URLSessionWebSocketTask`, odpowiednik `URLSessionVoiceSocket` z nagłówkami
/// żądania. Delegat i odbiór na głównej kolejce, w kolejności przyjścia; po `close()` żadne zdarzenie nie wychodzi.
@MainActor
final class URLSessionRealtimeSocket: VoiceSocket {
  /// `session.updated` odsyła całe instrukcje (do 165 tys. znaków), więc sufit wiadomości nad domyślnym 1 MB.
  static let maximumMessageSize = 4 * 1024 * 1024

  private let session: URLSession
  private let task: URLSessionWebSocketTask
  private let events: VoiceSocketEvents
  private var closed = false

  init(request: RealtimeSocketRequest, events: VoiceSocketEvents) {
    self.events = events
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.urlCredentialStorage = nil
    configuration.waitsForConnectivity = false
    let delegate = RealtimeSocketDelegate()
    session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: .main)
    if request.headers.isEmpty {
      task =
        request.protocols.isEmpty
        ? session.webSocketTask(with: request.url) : session.webSocketTask(with: request.url, protocols: request.protocols)
    } else {
      var urlRequest = URLRequest(url: request.url)
      for (name, value) in request.headers { urlRequest.setValue(value, forHTTPHeaderField: name) }
      if !request.protocols.isEmpty {
        urlRequest.setValue(request.protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
      }
      task = session.webSocketTask(with: urlRequest)
    }
    task.maximumMessageSize = Self.maximumMessageSize
    delegate.opened = { [weak self] in self?.opened() }
    delegate.ended = { [weak self] in self?.ended() }
    task.resume()
  }

  func send(text: String) {
    guard !closed else { return }
    task.send(.string(text)) { _ in }
  }

  func send(data: Data) {
    guard !closed else { return }
    task.send(.data(data)) { _ in }
  }

  func close() {
    guard !closed else { return }
    closed = true
    task.cancel(with: .normalClosure, reason: nil)
    session.invalidateAndCancel()
  }

  private func opened() {
    guard !closed else { return }
    events.opened()
    receive()
  }

  private func receive() {
    task.receive { [weak self] result in
      let text: String?
      switch result {
      case let .success(.string(value)): text = value
      case let .success(.data(data)): text = String(data: data, encoding: .utf8)
      case .success: text = nil
      case .failure: text = nil
      }
      let failed = if case .failure = result { true } else { false }
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, !self.closed else { return }
          if failed {
            self.ended()
            return
          }
          if let text { self.events.message(text) }
          self.receive()
        }
      }
    }
  }

  private func ended() {
    guard !closed else { return }
    closed = true
    session.invalidateAndCancel()
    events.closed()
  }
}

/// Delegat sesji URL na głównej kolejce (`delegateQueue: .main`).
private final class RealtimeSocketDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
  var opened: (@MainActor () -> Void)?
  var ended: (@MainActor () -> Void)?

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    MainActor.assumeIsolated { opened?() }
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    MainActor.assumeIsolated { ended?() }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    MainActor.assumeIsolated { ended?() }
  }
}
