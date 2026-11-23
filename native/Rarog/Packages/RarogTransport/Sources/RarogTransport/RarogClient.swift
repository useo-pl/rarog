import Foundation
import RarogContract
import Synchronization

/// Żądanie do API Raroga (ścieżka względem `baseURL`, segmenty już zakodowane).
public struct APIRequest: Sendable, Equatable {
  public var method: String
  public var path: String
  public var body: Data?
  /// `nil` = `RarogConfig.requestTimeout`. Dłuższy limit podają wyłącznie wołający z dłuższym
  /// limitem serwera (wysyłka z załącznikiem: 200 s).
  public var timeout: Duration?

  public init(method: String, path: String, body: Data? = nil, timeout: Duration? = nil) {
    self.method = method
    self.path = path
    self.body = body
    self.timeout = timeout
  }

  public static func get(_ path: String) -> APIRequest {
    APIRequest(method: "GET", path: path)
  }

  public static func post(_ path: String, json: some Encodable, timeout: Duration? = nil) throws(TransportError) -> APIRequest {
    try encoded("POST", path, json: json, timeout: timeout)
  }

  /// `PUT` z ciałem JSON — zapis całego zasobu (notatki projektu).
  public static func put(_ path: String, json: some Encodable) throws(TransportError) -> APIRequest {
    try encoded("PUT", path, json: json, timeout: nil)
  }

  private static func encoded(
    _ method: String, _ path: String, json: some Encodable, timeout: Duration?
  ) throws(TransportError) -> APIRequest {
    do {
      return APIRequest(method: method, path: path, body: try JSONEncoder().encode(json), timeout: timeout)
    } catch {
      throw .invalidResponse("nie da się zakodować ciała \(path): \(error)")
    }
  }
}

/// Odpowiedź 2xx.
public struct APIResponse: Sendable, Equatable {
  public let status: Int
  public let body: Data
}

/// Zakres strumienia SSE.
public enum StreamScope: Sendable, Equatable {
  /// `/api/stream`: `hello` → `sessions-snapshot` → zmiany listy.
  case global
  /// `/api/sessions/<id>/stream`: transkrypt sesji (kursor `Last-Event-ID`).
  case session(id: String)

  var path: String {
    switch self {
    case .global: "/api/stream"
    case let .session(id): "/api/sessions/\(RarogClient.segment(id))/stream"
    }
  }
}

/// Klient HTTP Raroga: REST, strumienie SSE, klucz urządzenia, nagłówki pochodzenia.
///
/// Poświadczenie jest JEDNO na klienta i nie zmienia się w jego życiu: klient z kluczem urządzenia dokłada
/// `Authorization: Rarog-Device <deviceId>.<sekret>`; klient bez klucza (`POST /api/pair`, apka bez serwera) nie ma
/// żadnego. Zmiana serwera albo poświadczenia to NOWY klient (`RarogStore` podmienia transport), więc spóźniona
/// odpowiedź starego klienta nie rusza nowego klucza.
///
/// Własność: jedno poświadczenie może mieć kilku klientów naraz (klient HTTPS, klient generacji
/// tunelu, drzwi uploadu). Dzielą wtedy JEDEN zatrzask odmowy z parametru `rejections:`, więc 401 `device-revoked`
/// z dowolnego z nich widzą wszyscy. Klient ma jednego właściciela, który kończy jego sesję URL przez
/// ``invalidate()``; inni posiadacze tylko go pożyczają (``GenerationTicket``).
///
/// Cookie apka nie zna (uwierzytelnia ją klucz z parowania): sesja URL bez magazynu cookie, żądania bez
/// nagłówka `Cookie`, `Set-Cookie` z odpowiedzi pomijany. Token logowania nie istnieje w apce.
///
/// Bez stanu mutowalnego (wszystkie pola `Sendable`), więc to wartość, nie aktor. Wspólny stan kopii to zatrzask
/// ostatniej odmowy klucza (``CredentialRejectionLatch``) i sesja URL z przepustkami wywołań (``ClientURLSession``;
/// ``invalidate()`` kończy ją dla każdej kopii).
///
/// Zdania serwera: każda odpowiedź `SentenceBearing` i każde ciało błędu przechodzą przy dekodowaniu przez
/// ``renderer`` — pole tekstu z kodem zdania (`*Ref`) dostaje zdanie w języku apki, pole bez kodu zostaje tekstem
/// serwera. Strumienie SSE i terminal tłumaczy odbiorca ramek (`RarogCore`).
public struct RarogClient: Sendable {
  public let config: RarogConfig
  public let gate: MutationGate
  /// Klucz urządzenia. `nil` = klient bez poświadczenia (parowanie, brak serwera).
  public let device: DeviceCredential?
  /// Ostatnia odmowa klucza (401) — czyta ją magazyn przy wylogowaniu (``credentialRejection``). Wspólna dla
  /// klientów jednego poświadczenia, gdy wołający poda ten sam zatrzask w `init`.
  let rejections: CredentialRejectionLatch
  /// Sesja URL i jej przepustki; każde wywołanie sesji (także w `RarogClient+Messages`, `+Uploads`, `+Terminal`)
  /// idzie przez nią. Poza modułem niewidoczna.
  let session: ClientURLSession
  /// Tłumacz zdań serwera dla odpowiedzi REST i ciał błędów.
  public let renderer: SentenceRenderer

  /// - Parameters:
  ///   - policy: bramki z `RarogCore` (zgodność, sesja `unsupported`).
  ///   - configuration: baza konfiguracji sesji (testy wstrzykują `protocolClasses`).
  ///   - device: klucz urządzenia.
  ///   - renderer: tłumacz zdań serwera; domyślnie w języku apki (testy podają własny).
  ///   - rejections: zatrzask odmowy klucza; ten sam obiekt dla każdego klienta jednego poświadczenia (domyślnie
  ///     własny zatrzask klienta).
  public init(
    config: RarogConfig,
    policy: any MutationPolicy = AllowAllMutations(),
    configuration: URLSessionConfiguration = .ephemeral,
    device: DeviceCredential? = nil,
    renderer: @escaping SentenceRenderer = ServerText.renderer(language: .current),
    rejections: CredentialRejectionLatch = CredentialRejectionLatch()
  ) {
    self.init(
      config: config, policy: policy, configuration: configuration, device: device, renderer: renderer,
      rejections: rejections, probe: nil)
  }

  /// `probe` = punkty testowe sesji URL (``SessionProbe``); produkcja woła init publiczny, bez nich.
  init(
    config: RarogConfig,
    policy: any MutationPolicy = AllowAllMutations(),
    configuration: URLSessionConfiguration = .ephemeral,
    device: DeviceCredential? = nil,
    renderer: @escaping SentenceRenderer = ServerText.renderer(language: .current),
    rejections: CredentialRejectionLatch = CredentialRejectionLatch(),
    probe: SessionProbe?
  ) {
    self.config = config
    self.device = device
    self.renderer = renderer
    self.rejections = rejections
    gate = MutationGate(policy: policy)
    let configuration = configuration.copy() as! URLSessionConfiguration
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    // Bez sieci żądanie ma paść od razu („nie ma sieci" ≠ „odpięte urządzenie").
    configuration.waitsForConnectivity = false
    session = ClientURLSession(configuration: configuration, probe: probe)
  }

  /// Czy klient ma czym się uwierzytelnić (klucz urządzenia).
  public var hasCredential: Bool { device != nil }

  /// Odmowa klucza urządzenia z ostatniego 401 (`nil` = klient bez klucza albo żadnej odmowy).
  public var credentialRejection: CredentialRejection? { rejections.value }

  /// Kończy klienta i każdą jego kopię: żądania i strumienie SSE w locie kończą się `.cancelled`, a każde późniejsze
  /// wywołanie (REST, strumień, wysyłka, zdjęcie, gniazdo terminala) kończy się `.cancelled` bez zadania sesji URL.
  /// Woła wyłącznie właściciel klienta, po zamknięciu biletu (``GenerationTicket/startClosing()``) i jego opróżnieniu
  /// albo po terminie. Wywołanie, które czekało w bramce mutacji dłużej niż termin, zastaje więc klienta
  /// unieważnionego i nie tworzy zadania (zadanie na unieważnionej sesji kończy proces wyjątkiem Foundation). Gniazda
  /// terminala otwarte przed unieważnieniem mają własną sesję URL i zostają otwarte do zamknięcia przez wołającego
  /// albo przez serwer.
  public func invalidate() {
    session.invalidate()
  }

  // MARK: - Endpointy podstawowe

  /// `GET /api/version` — sonda poświadczenia i flagi możliwości.
  public func version() async throws(TransportError) -> VersionInfo {
    let response = try await perform(.get("/api/version"))
    return try decode(VersionInfo.self, from: response.body, path: "/api/version")
  }

  // `POST /api/sessions/<id>/messages` (wysyłka z postępem i odpowiedzią z `clientMessageId`): `RarogClient+Messages`.

  /// `POST /api/sessions/<id>/permissions/<permId>`. 409 = decyzja zapadła na innym urządzeniu,
  /// 410 = karty już nie ma, 422 = odmowa z `reason` — wszystkie jako `.http` z kodem.
  public func decidePermission(sessionId: String, permId: String, _ body: PermissionDecisionBody) async throws(TransportError) {
    let path = "/api/sessions/\(Self.segment(sessionId))/permissions/\(Self.segment(permId))"
    _ = try await perform(.post(path, json: body))
  }

  /// `POST /api/presence` → 204.
  public func presence(_ body: PresenceBody) async throws(TransportError) {
    _ = try await perform(.post("/api/presence", json: body))
  }

  /// `POST /api/client-log` → 202.
  public func clientLog(_ body: ClientLogBody) async throws(TransportError) {
    _ = try await perform(.post("/api/client-log", json: body))
  }

  // MARK: - SSE

  /// Opens an SSE stream. A status other than 2xx throws at once (a 401 of the key goes to the refusal latch); after
  /// that the stream yields parser outputs and ends with a ``TransportError`` (`.timedOut` after `streamIdleTimeout`
  /// without a packet). `watch` hears the request going out, every body byte and the end of the byte loop; the stream
  /// supervisor in `RarogCore` decides on a stall, reconnects and keeps the cursor.
  public func openStream(
    _ scope: StreamScope, lastEventId: String? = nil, watch: StreamStallGuard = StreamStallGuard()
  ) async throws(TransportError) -> AsyncThrowingStream<SSEParser.Output, any Error> {
    let get = APIRequest(method: "GET", path: scope.path, timeout: config.streamIdleTimeout)
    var request = try makeRequest(get)
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
    if let lastEventId, !lastEventId.isEmpty {
      request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
    }

    let opened: ClientURLSession.OpenedBytes
    watch.sent()
    do {
      opened = try await session.bytes(for: request)
    } catch {
      throw Self.transportError(error)
    }
    let bytes = opened.bytes
    let pass = opened.pass
    // Przepustka przechodzi do zadania czytającego strumień; każde wcześniejsze wyjście ją oddaje.
    var streaming = false
    defer { if !streaming { pass.finish() } }
    guard let http = opened.response as? HTTPURLResponse else {
      throw .invalidResponse("odpowiedź strumienia nie jest HTTP")
    }

    guard (200..<300).contains(http.statusCode) else {
      var body = Data()
      do {
        for try await byte in bytes {
          body.append(byte)
          if body.count >= 64 * 1024 { break }
        }
      } catch {
        // Ciało błędu jest tylko opisem; jego brak nie zmienia statusu.
      }
      throw rejection(http, body: body, request: request)
    }
    guard http.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("text/event-stream") == true else {
      throw .invalidResponse("strumień bez Content-Type text/event-stream")
    }

    let (stream, continuation) = AsyncThrowingStream<SSEParser.Output, any Error>.makeStream()
    streaming = true
    let task = Task {
      defer {
        watch.ended()
        pass.finish()
      }
      var parser = SSEParser()
      do {
        for try await byte in bytes {
          // Every body byte, not every frame: a long `data:` line flowing slowly is not silence.
          watch.received()
          if let output = parser.push(byte) { continuation.yield(output) }
        }
        continuation.finish()
      } catch {
        continuation.finish(throwing: Self.transportError(error))
      }
    }
    continuation.onTermination = { _ in task.cancel() }
    return stream
  }

  // MARK: - Rdzeń

  /// Wysyła żądanie przez bramkę mutacji; zwraca odpowiedź 2xx albo rzuca typowany błąd. `accepting` = statusy
  /// spoza 2xx, które wołający czyta jak odpowiedź, bo ich CIAŁO jest treścią (409 notatek niesie aktualny
  /// dokument). Taka odpowiedź nie idzie przez `rejection` (ta zapisuje odmowę klucza przy 401).
  public func perform(_ api: APIRequest, accepting: Set<Int> = []) async throws(TransportError) -> APIResponse {
    do {
      try await gate.check(method: api.method, path: api.path)
    } catch {
      throw .refused(error)
    }
    let request = try makeRequest(api)
    let data: Data
    let http: HTTPURLResponse
    do {
      let (body, response) = try await session.run(.data) { try await $0.data(for: request) }
      guard let response = response as? HTTPURLResponse else {
        throw TransportError.invalidResponse("odpowiedź nie jest HTTP")
      }
      data = body
      http = response
    } catch {
      throw Self.transportError(error)
    }
    guard (200..<300).contains(http.statusCode) || accepting.contains(http.statusCode) else {
      throw rejection(http, body: data, request: request)
    }
    return APIResponse(status: http.statusCode, body: data)
  }

  func makeRequest(_ api: APIRequest) throws(TransportError) -> URLRequest {
    guard api.path.hasPrefix("/"), let url = URL(string: api.path, relativeTo: config.baseURL)?.absoluteURL else {
      throw .invalidResponse("zła ścieżka żądania: \(api.path)")
    }
    var request = URLRequest(url: url)
    request.httpMethod = api.method
    request.timeoutInterval = (api.timeout ?? config.requestTimeout).timeInterval
    request.httpShouldHandleCookies = false
    request.setValue(config.userAgent, forHTTPHeaderField: "User-Agent")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if MutationGate.isMutation(api.method) {
      // Bramka `Origin` serwera (router, krok 1) dotyczy POST/PUT/DELETE — także w demo.
      request.setValue(config.origin, forHTTPHeaderField: "Origin")
    }
    if let body = api.body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    // `POST /api/pair` jest publiczne: poświadczeniem jest kod z ciała, więc klucz z nim nie jedzie.
    if let device, api.path != Self.pairPath {
      request.setValue(device.authorization, forHTTPHeaderField: "Authorization")
    }
    return request
  }

  /// Odmowa serwera (status spoza 2xx) → błąd typowany. 401 żądania wysłanego z kluczem trafia do zatrzasku
  /// odmowy — magazyn wybiera po nim ekran (odpięte urządzenie albo „nie rozpoznał”).
  func rejection(_ response: HTTPURLResponse, body: Data, request: URLRequest) -> TransportError {
    let error = failure(status: response.statusCode, response: response, body: body)
    if let device, case .unauthorized = error, request.value(forHTTPHeaderField: "Authorization") != nil {
      rejections.record(Self.credentialRejection(body, deviceId: device.deviceId))
    }
    return error
  }

  /// Ciało 401 → odmowa klucza: `device-revoked` z datą i przyczyną (ścisły dekoder kontraktu), inaczej „nieznany”.
  static func credentialRejection(_ body: Data, deviceId: String) -> CredentialRejection {
    if let revoked = try? JSONDecoder().decode(DeviceRevokedBody.self, from: body) {
      return .revoked(deviceId: deviceId, revokedAt: revoked.revokedAt, revokedBy: revoked.revokedBy)
    }
    return .unknown(deviceId: deviceId)
  }

  /// Status i ciało odmowy → błąd typowany (bez skutków ubocznych; odmowę klucza zapisuje ``rejection(_:body:request:)``).
  /// `readsRetryAfter: false` = trasa bez dławika (zdjęcie z `/uploads`), nagłówek pomijany.
  func failure(status: Int, response: HTTPURLResponse, body: Data, readsRetryAfter: Bool = true) -> TransportError {
    // Ciało czytane tolerancyjnie: zdanie serwera przeżywa nieznany kształt.
    // Zdanie z kodem (`messageRef`) idzie przez tłumacza; uszkodzony kod wypadł już przy odczycie.
    let parsed = APIErrorTolerance.read(body)
    let retryAfter = readsRetryAfter ? response.value(forHTTPHeaderField: "Retry-After").flatMap { Int($0) } : nil
    let message = parsed.message.map { renderer($0, parsed.messageRef) }
    let failure = APIFailure(
      status: status, code: parsed.code, message: message, reason: parsed.reason, retryAfter: retryAfter
    )
    switch status {
    case 401: return .unauthorized(failure)
    case 403: return .forbidden(failure)
    case 429: return .rateLimited(failure)
    default: return .http(failure)
    }
  }

  /// Odpowiedź 2xx → typ kontraktu, przetłumaczony (``translated(_:)``). Jedyny dekoder odpowiedzi REST klienta:
  /// `decodeCatalog` i `decodeDevices` to jego nazwy obszarów.
  func decode<T: Decodable>(_ type: T.Type, from data: Data, path: String) throws(TransportError) -> T {
    let value: T
    do {
      value = try JSONDecoder().decode(type, from: data)
    } catch {
      throw .invalidResponse("\(path): odpowiedź spoza kontraktu (\(error))")
    }
    return translated(value)
  }

  /// Wartość `SentenceBearing` po tłumaczeniu rendererem klienta; każda inna bez zmian.
  func translated<T>(_ value: T) -> T {
    guard var bearing = value as? any SentenceBearing else { return value }
    bearing.translate(renderer)
    return (bearing as? T) ?? value
  }

  static func transportError(_ error: any Error) -> TransportError {
    if let error = error as? TransportError { return error }
    if let error = error as? URLError {
      switch error.code {
      case .timedOut: return .timedOut
      case .cancelled: return .cancelled
      default: return .offline(error.code)
      }
    }
    if error is CancellationError { return .cancelled }
    return .invalidResponse(String(describing: error))
  }

  /// Segment ścieżki zakodowany jak `encodeURIComponent` (identyfikatory sesji i kart).
  static func segment(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
  }

  /// RFC 3986 „unreserved", wyłącznie ASCII (`CharacterSet.alphanumerics` przepuściłby „ą").
  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  )
}

/// Wywołanie sesji URL klienta: rodzaj zadania, które tworzy (punkty testowe ``SessionProbe``).
enum SessionCall: Sendable, Hashable {
  case data, bytes, upload, terminalSocket
}

/// Punkty testowe sesji URL klienta (`@testable`); produkcja ich nie ma.
struct SessionProbe: Sendable {
  /// Przed przepustką: wywołanie nie ma jeszcze prawa utworzyć zadania. Wolno tu czekać.
  var beforePass: @Sendable (SessionCall) async -> Void = { _ in }
  /// Po przepustce, tuż przed wywołaniem `URLSession`. Wolno tu czekać.
  var afterPass: @Sendable (SessionCall) async -> Void = { _ in }
  /// Przed utworzeniem gniazda terminala. Wywołanie jest synchroniczne, więc czekanie blokuje wątek wołającego.
  var beforeSocket: @Sendable () -> Void = {}
  /// Przepustka wydana: zadanie sesji URL albo gniazdo terminala powstanie.
  var admitted: @Sendable (SessionCall) -> Void = { _ in }
  /// Sesja URL unieważniona naprawdę (`invalidateAndCancel`).
  var ended: @Sendable () -> Void = {}
}

/// Sesja URL klienta, wspólna dla jego kopii, z jednym stanem dla przepustek wywołań i unieważnienia.
///
/// Foundation kończy proces wyjątkiem, gdy zadanie powstaje na unieważnionej sesji. Zadanie tworzy wnętrze
/// asynchronicznego wywołania `URLSession` (`data`, `bytes`, `upload`), więc samego utworzenia nie da się wziąć pod
/// blokadę. Dlatego każde wywołanie sesji najpierw bierze przepustkę pod blokadą stanu, a ``invalidate()`` pod tą samą
/// blokadą przestaje je wydawać: wywołanie po unieważnieniu kończy się `.cancelled` i nie tworzy zadania. Wydane
/// przepustki ``invalidate()`` przerywa od razu (anulowanie wywołania albo zadania URL strumienia), a samą sesję
/// unieważnia dopiero powrót ostatniej z nich, bo wywołanie z przepustką może jeszcze tworzyć zadanie.
final class ClientURLSession: Sendable {
  /// Strumień bajtów odpowiedzi z przepustką, którą czytający oddaje po końcu czytania (``Pass/finish()``).
  struct OpenedBytes: Sendable {
    let bytes: URLSession.AsyncBytes
    let response: URLResponse
    let pass: Pass
  }

  /// Przepustka jednego wywołania sesji, od wydania do ``finish()``.
  final class Pass: Sendable {
    private let owner: ClientURLSession
    private let id: UInt64

    fileprivate init(owner: ClientURLSession, id: UInt64) {
      self.owner = owner
      self.id = id
    }

    /// Czym przerwać wywołanie przy ``ClientURLSession/invalidate()``; po unieważnieniu przerywa od razu.
    func onCancel(_ action: @escaping @Sendable () -> Void) {
      owner.setCancel(id, action)
    }

    /// Koniec wywołania (idempotentne). Ostatnia przepustka unieważnionej sesji kończy sesję URL.
    func finish() {
      owner.release(id)
    }

    deinit {
      owner.release(id)
    }
  }

  private struct Cancel: Sendable {
    var action: (@Sendable () -> Void)?
  }

  private struct State {
    var invalidated = false
    var ended = false
    var nextPass: UInt64 = 0
    /// Wydane przepustki i to, czym je przerwać (`nil` = jeszcze nic do przerwania).
    var passes: [UInt64: Cancel] = [:]
  }

  private let session: URLSession
  private let probe: SessionProbe?
  private let state = Mutex(State())

  init(configuration: URLSessionConfiguration, probe: SessionProbe?) {
    session = URLSession(configuration: configuration)
    self.probe = probe
  }

  /// Żądanie z całą odpowiedzią (`data`, `upload`). Bez przepustki (po ``invalidate()``) rzuca `.cancelled`.
  func run<T: Sendable>(
    _ call: SessionCall, _ work: @escaping @Sendable (URLSession) async throws -> T
  ) async throws -> T {
    await probe?.beforePass(call)
    let pass = try admit(call)
    defer { pass.finish() }
    let session = session
    let probe = probe
    let task = Task {
      await probe?.afterPass(call)
      // Przepustka przerwana przed wywołaniem: bez zadania.
      try Task.checkCancellation()
      return try await work(session)
    }
    pass.onCancel { task.cancel() }
    return try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
  }

  /// Strumień bajtów odpowiedzi (SSE, zdjęcie). Przepustka trwa do ``Pass/finish()`` czytającego, bo strumień
  /// przerywa się przez jego zadanie URL. Bez przepustki rzuca `.cancelled`.
  func bytes(for request: URLRequest) async throws -> OpenedBytes {
    await probe?.beforePass(.bytes)
    let pass = try admit(.bytes)
    let session = session
    let probe = probe
    let open = Task {
      await probe?.afterPass(.bytes)
      try Task.checkCancellation()
      return try await session.bytes(for: request)
    }
    pass.onCancel { open.cancel() }
    do {
      let (bytes, response) = try await withTaskCancellationHandler {
        try await open.value
      } onCancel: {
        open.cancel()
      }
      pass.onCancel { bytes.task.cancel() }
      return OpenedBytes(bytes: bytes, response: response, pass: pass)
    } catch {
      pass.finish()
      throw error
    }
  }

  /// Gniazdo terminala. Ma własną sesję URL, ale powstaje pod tą samą blokadą co ``invalidate()``, więc unieważniony
  /// klient gniazda już nie otwiera (`.cancelled`).
  func socket(_ make: () -> any TerminalSocketing) throws(TransportError) -> any TerminalSocketing {
    probe?.beforeSocket()
    return try state.withLock { state throws(TransportError) in
      guard !state.invalidated else { throw .cancelled }
      probe?.admitted(.terminalSocket)
      return make()
    }
  }

  /// Koniec sesji dla każdej kopii klienta: od teraz bez przepustek, wydane przerwane, sesja URL unieważniona od razu
  /// albo po powrocie ostatniej wydanej przepustki. Idempotentne.
  func invalidate() {
    let (cancels, endNow): ([@Sendable () -> Void], Bool) = state.withLock { state in
      guard !state.invalidated else { return ([], false) }
      state.invalidated = true
      state.ended = state.passes.isEmpty
      return (state.passes.values.compactMap(\.action), state.ended)
    }
    for cancel in cancels { cancel() }
    if endNow { end() }
  }

  private func admit(_ call: SessionCall) throws(TransportError) -> Pass {
    let id = try state.withLock { state throws(TransportError) in
      guard !state.invalidated else { throw .cancelled }
      defer { state.nextPass += 1 }
      state.passes[state.nextPass] = Cancel()
      probe?.admitted(call)
      return state.nextPass
    }
    return Pass(owner: self, id: id)
  }

  private func setCancel(_ id: UInt64, _ action: @escaping @Sendable () -> Void) {
    let now = state.withLock { state in
      guard state.passes[id] != nil else { return false }
      if state.invalidated { return true }
      state.passes[id] = Cancel(action: action)
      return false
    }
    if now { action() }
  }

  private func release(_ id: UInt64) {
    let last = state.withLock { state in
      guard state.passes.removeValue(forKey: id) != nil else { return false }
      guard state.invalidated, state.passes.isEmpty, !state.ended else { return false }
      state.ended = true
      return true
    }
    if last { end() }
  }

  private func end() {
    session.invalidateAndCancel()
    probe?.ended()
  }
}

/// Zatrzask ostatniej odmowy klucza urządzenia — wspólny dla kopii ``RarogClient`` (klient to wartość) i dla
/// wszystkich klientów jednego poświadczenia (parametr `rejections:`). `device-revoked` jest ostateczne: zatrzask nie
/// wraca z niego do słabszego stanu ani do `nil`. Zapisuje wyłącznie klient (401 żądania z kluczem).
public final class CredentialRejectionLatch: Sendable {
  private let mutex = Mutex<CredentialRejection?>(nil)

  public init() {}

  /// Ostatnia odmowa (`nil` = żadnej).
  public var value: CredentialRejection? { mutex.withLock { $0 } }

  func record(_ rejection: CredentialRejection) {
    // `device-revoked` jest ostateczne: późniejsze „nieznane” (inne żądanie w tej samej chwili) go nie zastępuje.
    mutex.withLock { current in
      if case .revoked = current { return }
      current = rejection
    }
  }
}
