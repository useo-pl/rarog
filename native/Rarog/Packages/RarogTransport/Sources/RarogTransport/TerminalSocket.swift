import Foundation
import RarogContract
import Synchronization

// Gniazdo WS terminala: `URLSessionWebSocketTask` z `URLRequest`
// (zmierzone: ręczne nagłówki poświadczenia i `Origin` przechodzą upgrade, a pong na ping
// serwera co 25 s URLSession wysyła sam — gniazdo żyje 200 s bez żadnej ramki).
//
// Treść terminala nigdy nie trafia do logów, na dysk ani do pamięci podręcznej: ten plik
// nie loguje ani nie zapisuje niczego, a opis błędu transportu nie wychodzi poza zdarzenie `closed`.

/// Zdarzenie gniazda terminala — w kolejności odbioru, a `closed` zawsze jako ostatnie i dokładnie raz.
public enum TerminalSocketEvent: Sendable, Hashable {
  /// Upgrade przeszedł. Pierwszą ramką tekstową będzie `hello` (albo `err` przy odmowie `attach`).
  case opened
  /// Ramka binarna: surowe bajty PTY, prosto do emulatora — bez żadnej interpretacji.
  case bytes(Data)
  /// Ramka tekstowa w kontrakcie (nieznany typ jest pomijany, nie zrywa gniazda).
  case frame(TerminalServerFrame)
  /// Koniec gniazda z dowolnego powodu: odmowa upgrade'u (serwer robi `socket.destroy()`), zamknięcie
  /// przez serwer, błąd sieci albo ``TerminalSocketing/close()``.
  case closed
}

/// Gniazdo terminala widziane z rdzenia. Produkcja: ``TerminalSocket``; testy: atrapa.
public protocol TerminalSocketing: AnyObject, Sendable {
  /// Zdarzenia w kolejności odbioru; strumień kończy się po `closed`.
  var events: AsyncStream<TerminalSocketEvent> { get }
  /// Wysyła ramkę tekstową. `false` = nic nie poszło: gniazdo nie żyje albo ramka byłaby ponad sufit
  /// ``TerminalWire/maxFrameBytes`` (serwer zerwałby za nią gniazdo).
  func send(_ frame: TerminalClientFrame) async -> Bool
  /// Zamyka gniazdo (`1000`). Idempotentne; po nim przychodzi już tylko `closed`.
  func close()
}

/// Czysty builder żądania upgrade'u — testowany bez sieci (atrapa `URLProtocol` nie przechwyci
/// `URLSessionWebSocketTask`).
public enum TerminalRequestBuilder {
  /// `ws(s)://<host>/api/term/<id>?fresh=1&direct=1&c=&r=` z poświadczeniem (`Authorization` klucza
  /// urządzenia), `Origin` (bramka upgrade'u w `ws.ts`: `SameSite=Strict` nie broni WS),
  /// `User-Agent` — jak REST.
  ///
  /// - Parameters:
  ///   - fresh: emulator po naszej stronie bez stanu — serwer respawnuje kontroler i pierwsza ramka jest
  ///     pełna (`ESC[2J`).
  ///   - direct: gniazdo próby BEZ poprzedzającego `POST /api/term` (id znane). Serwer odmawia mu
  ///     zamknięciem tam, gdzie wyjście zna tylko `POST` (`TermRegistry.attachableDirect`); serwer bez tej
  ///     bramki parametr pomija.
  ///   - grid: rozmiar zmierzony PRZED upgrade'em: kontroler panelu wstaje od razu w tym rozmiarze, bez
  ///     pary SIGWINCH i „schodka" promptu (`termWsUrl` w PWA).
  ///   - authorization: nagłówek klucza urządzenia; `nil` = upgrade bez poświadczenia (serwer odmówi).
  public static func request(
    config: RarogConfig, authorization: String? = nil, id: String, fresh: Bool,
    direct: Bool = false, grid: TerminalGrid?
  ) throws(TransportError) -> URLRequest {
    guard TerminalWire.isTerminalId(id) else {
      throw .invalidResponse("id terminala spoza kształtu TERM_ID_RE")
    }
    guard var components = URLComponents(url: config.baseURL, resolvingAgainstBaseURL: false),
      let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http"
    else {
      throw .invalidResponse("adres serwera bez http(s) — nie ma z czego zbudować gniazda")
    }
    components.scheme = scheme == "https" ? "wss" : "ws"
    // Ścieżka absolutna, jak `RarogClient.makeRequest` (`/api/...` względem bazy podmienia jej ścieżkę).
    components.path = "/api/term/\(id)"
    var items: [URLQueryItem] = []
    if fresh { items.append(URLQueryItem(name: "fresh", value: "1")) }
    if direct { items.append(URLQueryItem(name: "direct", value: "1")) }
    if let grid {
      items.append(URLQueryItem(name: "c", value: String(grid.cols)))
      items.append(URLQueryItem(name: "r", value: String(grid.rows)))
    }
    components.queryItems = items.isEmpty ? nil : items
    components.fragment = nil
    guard let url = components.url else {
      throw .invalidResponse("nie da się zbudować adresu gniazda terminala")
    }
    var request = URLRequest(url: url)
    // Limit dotyczy otwarcia gniazda; bezczynnego gniazda nie zamyka (pomiar: limit 15 s, ping serwera co
    // 25 s, gniazdo żyje 200 s).
    request.timeoutInterval = config.requestTimeout.timeInterval
    request.httpShouldHandleCookies = false
    request.setValue(config.userAgent, forHTTPHeaderField: "User-Agent")
    request.setValue(config.origin, forHTTPHeaderField: "Origin")
    if let authorization {
      request.setValue(authorization, forHTTPHeaderField: "Authorization")
    }
    return request
  }

  /// Tekst wiadomości WS dla ramki albo `nil`, gdy gotowa ramka przekracza sufit 8 KiB (jej wysłanie
  /// zerwałoby gniazdo). Jedyna droga ramki na drut w ``TerminalSocket``.
  public static func message(for frame: TerminalClientFrame) -> String? {
    let data = TerminalFrameEncoder.data(frame)
    guard !data.isEmpty, data.count <= TerminalWire.maxFrameBytes else { return nil }
    return String(decoding: data, as: UTF8.self)
  }
}

/// Gniazdo terminala na `URLSessionWebSocketTask`. Każde gniazdo ma własną `URLSession` (delegat zdarzeń
/// otwarcia i zamknięcia, kolejka szeregowa = kolejność zdarzeń), unieważnianą przy końcu.
public final class TerminalSocket: TerminalSocketing, Sendable {
  public let events: AsyncStream<TerminalSocketEvent>

  private struct State {
    var finished = false
    var task: URLSessionWebSocketTask?
    var session: URLSession?
  }

  private let continuation: AsyncStream<TerminalSocketEvent>.Continuation
  private let state = Mutex(State())

  /// Największa ramka od serwera. Pełna ramka herdr dużego ekranu z kolorami to dziesiątki kB; domyślny
  /// sufit URLSession (1 MiB) wystarcza z zapasem, a 4 MiB nie zrywa gniazda przy ekranie 400×200.
  static let maximumMessageSize = 4 << 20

  /// Tworzy i od razu otwiera gniazdo. Zdarzenia buforuje strumień, więc nic nie ginie przed subskrypcją.
  public init(request: URLRequest) {
    let (stream, continuation) = AsyncStream<TerminalSocketEvent>.makeStream()
    events = stream
    self.continuation = continuation

    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.urlCache = nil
    configuration.waitsForConnectivity = false
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    queue.name = "rarog.terminal.socket"
    let session = URLSession(configuration: configuration, delegate: Delegate(owner: self), delegateQueue: queue)
    let task = session.webSocketTask(with: request)
    task.maximumMessageSize = Self.maximumMessageSize
    state.withLock {
      $0.task = task
      $0.session = session
    }
    task.resume()
    receive(task)
  }

  public func send(_ frame: TerminalClientFrame) async -> Bool {
    guard let message = TerminalRequestBuilder.message(for: frame),
      let task = state.withLock({ $0.finished ? nil : $0.task })
    else { return false }
    do {
      try await task.send(.string(message))
      return true
    } catch {
      return false
    }
  }

  public func close() {
    let task = state.withLock { $0.finished ? nil : $0.task }
    task?.cancel(with: .normalClosure, reason: nil)
    finish()
  }

  /// Pętla odbioru: każda wiadomość przed następną (kolejność bajtów PTY jest kontraktem).
  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case let .success(.data(data)):
        self.emit(.bytes(data))
        self.receive(task)
      case let .success(.string(text)):
        if let frame = TerminalServerFrame.decode(text) { self.emit(.frame(frame)) }
        self.receive(task)
      case .success:
        self.receive(task)
      case .failure:
        self.finish()
      }
    }
  }

  fileprivate func emit(_ event: TerminalSocketEvent) {
    // Pod zamkiem: po `finish` nic już nie wychodzi, a `closed` jest ostatnim zdarzeniem.
    state.withLock { state in
      guard !state.finished else { return }
      continuation.yield(event)
    }
  }

  fileprivate func finish() {
    let session: URLSession? = state.withLock { state in
      guard !state.finished else { return nil }
      state.finished = true
      continuation.yield(.closed)
      continuation.finish()
      defer { state.session = nil; state.task = nil }
      return state.session
    }
    // Unieważnienie zwalnia delegata (sesja trzyma go mocno do końca).
    session?.invalidateAndCancel()
  }

  private final class Delegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    weak var owner: TerminalSocket?

    init(owner: TerminalSocket) {
      self.owner = owner
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
      owner?.emit(.opened)
    }

    func urlSession(
      _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
      didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
      owner?.finish()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
      owner?.finish()
    }
  }
}
