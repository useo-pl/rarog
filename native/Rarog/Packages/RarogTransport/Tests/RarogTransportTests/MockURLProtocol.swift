import Foundation
import RarogContract
import RarogTransport
import Synchronization

/// Atrapa serwera dla `URLSession`: odpowiedzi i zapis żądań PER PORT, więc testy mogą biec
/// równolegle (każdy dostaje własny port w `RarogConfig.test`).
final class MockURLProtocol: URLProtocol, @unchecked Sendable {
  struct Reply: Sendable {
    var status: Int = 200
    var headers: [String: String] = ["Content-Type": "application/json"]
    var chunks: [Data] = []
    var error: URLError?
    /// No answer: the request stays open until its task is cancelled or times out (``held(port:)``).
    var hold = false
    /// What follows the chunks of an answer: the end of the body, a failure, or a body that stays open until its task
    /// is cancelled (counted in ``held(port:)``).
    var afterChunks: AfterChunks = .finish

    enum AfterChunks: Sendable {
      case finish
      case fail(URLError)
      case stayOpen
    }

    static let held = Reply(hold: true)

    static func json(_ status: Int, _ body: String, headers: [String: String] = [:]) -> Reply {
      Reply(
        status: status,
        headers: ["Content-Type": "application/json"].merging(headers) { $1 },
        chunks: [Data(body.utf8)]
      )
    }
  }

  struct Recorded: Sendable {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data?

    func header(_ name: String) -> String? {
      headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
  }

  typealias Handler = @Sendable (Recorded) -> Reply

  private static let handlers = Mutex<[Int: Handler]>([:])
  private static let recorded = Mutex<[Int: [Recorded]]>([:])
  private static let nextPort = Atomic<Int>(41_000)
  private static let holding = Mutex<[Int: Int]>([:])
  /// Port of this request while it holds its answer (``Reply/hold``).
  private let heldPort = Mutex<Int?>(nil)

  /// Rejestruje atrapę i oddaje jej port.
  static func register(_ handler: @escaping Handler) -> Int {
    let port = nextPort.add(1, ordering: .relaxed).newValue
    handlers.withLock { $0[port] = handler }
    return port
  }

  static func requests(port: Int) -> [Recorded] {
    recorded.withLock { $0[port] ?? [] }
  }

  /// Requests on `port` that hold their answer and are still open (not yet cancelled or timed out).
  static func held(port: Int) -> Int {
    holding.withLock { $0[port] ?? 0 }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let port = url.port,
      let handler = Self.handlers.withLock({ $0[port] })
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
      return
    }
    var path = url.path(percentEncoded: true)
    if let query = url.query(percentEncoded: true) { path += "?\(query)" }
    let entry = Recorded(
      method: request.httpMethod ?? "GET",
      path: path,
      headers: request.allHTTPHeaderFields ?? [:],
      body: request.httpBody ?? request.httpBodyStream.map(Self.read)
    )
    Self.recorded.withLock { $0[port, default: []].append(entry) }

    let reply = handler(entry)
    if reply.hold {
      heldPort.withLock { $0 = port }
      Self.holding.withLock { $0[port, default: 0] += 1 }
      return
    }
    if let error = reply.error {
      client?.urlProtocol(self, didFailWithError: error)
      return
    }
    let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    for chunk in reply.chunks { client?.urlProtocol(self, didLoad: chunk) }
    switch reply.afterChunks {
    case .finish:
      client?.urlProtocolDidFinishLoading(self)
    case let .fail(error):
      client?.urlProtocol(self, didFailWithError: error)
    case .stayOpen:
      heldPort.withLock { $0 = port }
      Self.holding.withLock { $0[port, default: 0] += 1 }
    }
  }

  override func stopLoading() {
    guard let port = heldPort.withLock({ value -> Int? in
      defer { value = nil }
      return value
    }) else { return }
    Self.holding.withLock { $0[port, default: 0] -= 1 }
  }

  private static func read(_ stream: InputStream) -> Data {
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count <= 0 { break }
      data.append(buffer, count: count)
    }
    return data
  }
}

/// Klucz urządzenia testów tras: `MockHarness(device: testDevice)` to klient po parowaniu.
let testDevice = DeviceCredential(
  deviceId: "05050505050505050505050505050505", secret: "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY",
  serverURL: URL(string: "http://127.0.0.1:1")!, serverId: "01010101010101010101010101010101",
  serverName: "mac-demo", label: "iPad·Rarog", kid: "f849d673", pairedAt: Date(timeIntervalSince1970: 1_792_000_000))
/// Nagłówek `Authorization`, z którym klient z ``testDevice`` wysyła każde żądanie.
let testDeviceHeader = "Rarog-Device 05050505050505050505050505050505.BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY"

/// Klient z atrapą; `device` = klucz urządzenia przypięty do adresu atrapy (`nil` = klient bez poświadczenia).
/// Zdania serwera z kodem tłumaczy renderer `pl` (niezależnie od języka procesu testów).
struct MockHarness {
  let port: Int
  let client: RarogClient

  init(
    policy: any MutationPolicy = AllowAllMutations(), device: DeviceCredential? = nil,
    renderer: @escaping SentenceRenderer = ServerText.renderer(language: .pl),
    handler: @escaping MockURLProtocol.Handler
  ) {
    port = MockURLProtocol.register(handler)
    let config = RarogConfig.test(port: port, build: 42, clientLabel: "iPad·Rarog")
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MockURLProtocol.self]
    var bound = device
    bound?.serverURL = config.baseURL
    client = RarogClient(config: config, policy: policy, configuration: configuration, device: bound, renderer: renderer)
  }

  var requests: [MockURLProtocol.Recorded] { MockURLProtocol.requests(port: port) }
}

/// Compatibility gate that refuses every mutation (the app is too old); reads still go out.
struct IncompatiblePolicy: MutationPolicy {
  func compatibilityRefusal() async -> PolicyRefusal? { PolicyRefusal("Apka jest za stara.") }
  func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? { nil }
}

/// Gate that refuses the listed sessions as unsupported by this app version.
struct UnsupportedSessions: MutationPolicy {
  let unsupported: Set<String>

  func compatibilityRefusal() async -> PolicyRefusal? { nil }
  func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? {
    unsupported.contains(sessionId) ? PolicyRefusal("Ta wersja apki nie obsługuje tej sesji.") : nil
  }
}
