import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogTransport
import RarogTransportTesting
import Synchronization
import Testing

// Klient HTTP rejestru relaya iroh na przypadkach `shared/fixtures/relay-auth/manifest.json`: każda odpowiedź 200
// trasy apki daje wynik trasy, każda odpowiedź błędu `.failure` z kodem i bramką, 200 bez wyniku albo nie do przyjęcia
// `.failure(200, nil, nil)`, brak sieci i termin `.unreachable`. Żądanie: `POST`, ścieżka trasy, oba nagłówki,
// ciało, które przechodzi `RelayAuthWire.parse` tej trasy, `sig` z atrapy podpisu, `issuedAt` z argumentu.

@Suite("klient rejestru relaya iroh: żądanie, odpowiedzi manifestu, walidacja 200")
struct RelayAuthClientTests {
  struct RequestCase: Sendable, Decodable {
    let route: String
    let body: JSONValue
    let signingText: String?
  }

  struct ResponseCase: Sendable, Decodable {
    let route: String?
    let status: Int
    let body: JSONValue
  }

  struct Key: Sendable, Decodable {
    let endpointId: String
  }

  struct Headers: Sendable, Decodable {
    let app: [String: String]
  }

  struct Manifest: Sendable, Decodable {
    let key: Key
    let headers: Headers
    let requests: [String: RequestCase]
    let responses: [String: ResponseCase]
  }

  static let manifest: Manifest = {
    do {
      let file = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/relay-auth/manifest.json")
      return try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: file))
    } catch {
      fatalError("rejestr relaya iroh: nie da się wczytać manifestu — \(error)")
    }
  }()

  /// Chwila żądań manifestu; odpowiedzi 200 mają `expiresAt` = ta chwila + 90 dni.
  static let issuedAt: Int64 = 1_793_700_000
  /// Górna granica `expiresAt` klienta z terminem 10 s: 90 d + 300 s tolerancji zegara + zapas 10 s + 1 s.
  static let latest = issuedAt + 90 * 86_400 + 300 + 11
  static let appId = manifest.key.endpointId
  static let serverA = String(repeating: "a1", count: 32)
  static let serverB = String(repeating: "b2", count: 32)

  static let appRoutes = Set(RelayAuthWire.Route.allCases.map(\.rawValue))
  static let okNames = manifest.responses
    .filter { $0.value.status == 200 && appRoutes.contains($0.value.route ?? "") }.keys.sorted()
  static let errorNames = manifest.responses.filter { $0.value.status != 200 }.keys.sorted()
  static let acceptedNames = manifest.requests.filter { $0.value.signingText != nil }.keys.sorted()

  /// Pola przyjętego żądania manifestu.
  static func fields(_ name: String) throws -> RelayAuthWire.Fields {
    let entry = try #require(manifest.requests[name])
    let route = try #require(RelayAuthWire.Route(rawValue: entry.route))
    return try RelayAuthWire.parse(route: route, json: entry.body.data).get().fields
  }

  /// Pola wysłane przy odpowiedzi trasy `route` (żądania manifestu z tymi serwerami, które odpowiedzi wymieniają).
  static func sent(_ route: String) throws -> RelayAuthWire.Fields {
    switch route {
    case "register": try fields("register.devicecheck")
    case "renew": try fields("renew.servers")
    case "sponsor": try fields("sponsor")
    default: .forget
    }
  }

  /// Klient na atrapie `URLSession`; port atrapy wyznacza rejestr.
  struct Harness {
    let port: Int
    let client: RelayAuthClient
    var registry: URL { URL(string: "http://127.0.0.1:\(port)")! }
    var requests: [MockURLProtocol.Recorded] { MockURLProtocol.requests(port: port) }

    init(_ handler: @escaping MockURLProtocol.Handler) {
      port = MockURLProtocol.register(handler)
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [MockURLProtocol.self]
      client = RelayAuthClient(appVersion: "0.1.0", build: "42", configuration: configuration)
    }

    func send(_ fields: RelayAuthWire.Fields, signer: any TunnelSigner = FakeRelaySigner(endpointId: appId))
      async -> RelayAuthReply {
      await client.send(fields, signer: signer, issuedAt: RelayAuthClientTests.issuedAt, registry: registry)
    }
  }

  static func reply(_ status: Int, _ body: Data) -> MockURLProtocol.Reply {
    MockURLProtocol.Reply(status: status, chunks: [body])
  }

  @Test("odpowiedź 200 trasy apki z manifestu → wynik trasy", arguments: RelayAuthClientTests.okNames)
  func okResponse(_ name: String) async throws {
    let entry = try #require(Self.manifest.responses[name])
    let route = try #require(entry.route)
    let body = entry.body.data
    let harness = Harness { _ in Self.reply(200, body) }
    let expected: RelayAuthReply =
      switch route {
      case "register": .registered(try RelayAuthWire.decode(RelayAuthWire.Registered.self, from: body))
      case "renew": .renewed(try RelayAuthWire.decode(RelayAuthWire.Renewed.self, from: body))
      case "sponsor": .sponsored(try RelayAuthWire.decode(RelayAuthWire.Sponsored.self, from: body))
      default: .forgotten(try RelayAuthWire.decode(RelayAuthWire.Forgotten.self, from: body))
      }
    #expect(await harness.send(try Self.sent(route)) == expected)
  }

  @Test("odpowiedź błędu z manifestu → .failure(status, kod, bramka)", arguments: RelayAuthClientTests.errorNames)
  func errorResponse(_ name: String) async throws {
    let entry = try #require(Self.manifest.responses[name])
    let failure = try RelayAuthWire.decode(RelayAuthWire.Failure.self, from: entry.body.data)
    let code = try #require(failure.code)
    let harness = Harness { _ in Self.reply(entry.status, entry.body.data) }
    let route = entry.route.flatMap { Self.appRoutes.contains($0) ? $0 : nil } ?? "forget"
    #expect(await harness.send(try Self.sent(route)) == .failure(status: entry.status, code: code, gate: failure.gateKind))
  }

  @Test("bramka przy gate-mismatch i kod spoza kontraktu: znana bramka albo nil, kod nil")
  func failureDetails() async throws {
    let mismatch = Harness { _ in .json(400, #"{"v":1,"error":"gate-mismatch","gate":"apns"}"#) }
    #expect(await mismatch.send(try Self.sent("register")) == .failure(status: 400, code: .gateMismatch, gate: .apns))
    let unknown = Harness { _ in .json(418, #"{"v":1,"error":"nowy-kod","gate":"nowa"}"#) }
    #expect(await unknown.send(.forget) == .failure(status: 418, code: nil, gate: nil))
    let html = Harness { _ in Self.reply(502, Data("<html>Bad gateway</html>".utf8)) }
    #expect(await html.send(.forget) == .failure(status: 502, code: nil, gate: nil))
  }

  @Test("200 bez wyniku trasy: v 2, bez v, nie JSON, puste, ciało innej trasy, 204 → .failure(status, nil, nil)",
    arguments: [
      (200, #"{"v":2,"forgotten":true}"#), (200, #"{"forgotten":true}"#), (200, "nie JSON"), (200, ""),
      (200, #"{"v":1,"endpointId":"\#(String(repeating: "a1", count: 32))","denied":false}"#), (204, ""),
    ])
  func okWithoutResult(status: Int, body: String) async throws {
    let harness = Harness { _ in Self.reply(status, Data(body.utf8)) }
    #expect(await harness.send(.forget) == .failure(status: status, code: nil, gate: nil))
    let register = Harness { _ in Self.reply(status, Data(body.utf8)) }
    #expect(await register.send(try Self.sent("register")) == .failure(status: status, code: nil, gate: nil))
  }

  @Test("walidacja 200: obcy EndpointId i serwer, termin poza zakresem, obce unsponsored, forgotten false → .failure")
  func okRejected() async throws {
    let max = Self.latest
    let cases: [(RelayAuthWire.Fields, String)] = [
      (try Self.sent("register"), #"{"v":1,"endpointId":"\#(Self.serverA)","expiresAt":\#(max)}"#),
      (try Self.sent("register"), #"{"v":1,"endpointId":"\#(Self.appId)","expiresAt":\#(Self.issuedAt)}"#),
      (try Self.sent("register"), #"{"v":1,"endpointId":"\#(Self.appId)","expiresAt":\#(max + 1)}"#),
      (.renew(servers: [Self.serverA]), #"{"v":1,"expiresAt":\#(max),"unsponsored":["\#(Self.serverB)"]}"#),
      (.renew(servers: []), #"{"v":1,"expiresAt":\#(max),"unsponsored":["\#(Self.serverA)"]}"#),
      (.renew(servers: [Self.serverA]), #"{"v":1,"expiresAt":\#(Self.issuedAt - 1),"unsponsored":[]}"#),
      (.sponsor(server: Self.serverB), #"{"v":1,"server":"\#(Self.serverA)","expiresAt":\#(max)}"#),
      (.sponsor(server: Self.serverA), #"{"v":1,"server":"\#(Self.serverA)","expiresAt":\#(max + 1)}"#),
      (.forget, #"{"v":1,"forgotten":false}"#),
    ]
    for (fields, body) in cases {
      let harness = Harness { _ in .json(200, body) }
      #expect(await harness.send(fields) == .failure(status: 200, code: nil, gate: nil), "\(fields.route) \(body)")
    }
  }

  @Test("walidacja 200: granica terminu teraz + 90 d + 300 s + zapas przyjęta, unsponsored ⊆ lista przyjęte")
  func okBoundary() async throws {
    let max = Self.latest
    let register = Harness { _ in .json(200, #"{"v":1,"endpointId":"\#(Self.appId)","expiresAt":\#(max)}"#) }
    #expect(await register.send(try Self.sent("register"))
      == FakeRelayAuthTransport.registered(endpointId: Self.appId, expiresAt: max))
    let renew = Harness { _ in
      .json(200, #"{"v":1,"expiresAt":\#(Self.issuedAt + 1),"unsponsored":["\#(Self.serverB)"],"extra":1}"#)
    }
    #expect(await renew.send(.renew(servers: [Self.serverA, Self.serverB]))
      == FakeRelayAuthTransport.renewed(expiresAt: Self.issuedAt + 1, unsponsored: [Self.serverB]))
  }

  @Test("termin wpisu liczony po obsłudze: zegar Workera +299 s i bramka 2 s → przyjęty; zapas = termin żądania + 1 s")
  func okAfterGateTime() async throws {
    let expiresAt = Self.issuedAt + 299 + 2 + 90 * 86_400
    let body = Data(#"{"v":1,"endpointId":"\#(Self.appId)","expiresAt":\#(expiresAt)}"#.utf8)
    let register = Harness { _ in Self.reply(200, body) }
    #expect(await register.send(try Self.sent("register"))
      == FakeRelayAuthTransport.registered(endpointId: Self.appId, expiresAt: expiresAt))
    let sent = try Self.sent("register")
    #expect(RelayAuthClient.reply(status: 200, body: body, sent: sent, endpointId: Self.appId, issuedAt: Self.issuedAt,
      slackSeconds: 0) == .failure(status: 200, code: nil, gate: nil))
    #expect(RelayAuthClient(appVersion: "0.1.0", build: "42").slackSeconds == 11)
    #expect(RelayAuthClient(appVersion: "0.1.0", build: "42", timeout: .milliseconds(2_500)).slackSeconds == 4)
  }

  @Test("żądanie z manifestu: POST, ścieżka trasy, oba nagłówki, ciało przechodzi parse, sig z atrapy, issuedAt z argumentu",
    arguments: RelayAuthClientTests.acceptedNames)
  func requestShape(_ name: String) async throws {
    let fields = try Self.fields(name)
    let signer = FakeRelaySigner(endpointId: Self.appId)
    let harness = Harness { _ in .json(503, #"{"v":1,"error":"unavailable"}"#) }
    let issuedAt: Int64 = 1_800_000_123
    _ = await harness.client.send(fields, signer: signer, issuedAt: issuedAt, registry: harness.registry)
    let recorded = try #require(harness.requests.first)
    #expect(harness.requests.count == 1)
    #expect(recorded.method == "POST")
    #expect(recorded.path == fields.route.path)
    for (header, value) in Self.manifest.headers.app where header != RelayAuthWire.clientHeader {
      #expect(recorded.header(header) == value, "\(header)")
    }
    #expect(Self.manifest.headers.app.keys.contains(RelayAuthWire.clientHeader))
    #expect(recorded.header(RelayAuthWire.clientHeader) == "rarog-app/0.1.0+42")
    let body = try #require(recorded.body)
    let parsed = try RelayAuthWire.parse(route: fields.route, json: body).get()
    #expect(parsed.endpointId == Self.appId && parsed.issuedAt == issuedAt && parsed.fields == fields)
    #expect(signer.messages == [parsed.signingBytes])
    let signature = FakeRelaySigner.signature(for: parsed.signingBytes)
    #expect(parsed.sig == signature.map { String(format: "%02x", $0) }.joined())
  }

  @Test("adres żądania: origin rejestru z mapy + ścieżka trasy, bez podwójnego ukośnika")
  func requestURL() throws {
    let registry = try #require(RelayAuthWire.registries["https://relay.rarog.ai/"])
    for route in RelayAuthWire.Route.allCases {
      let fields: RelayAuthWire.Fields =
        switch route {
        case .register: try Self.sent("register")
        case .renew: .renew(servers: [])
        case .sponsor: .sponsor(server: Self.serverA)
        case .forget: .forget
        }
      let request = try RelayAuthClient.request(
        fields, signer: FakeRelaySigner(endpointId: Self.appId), issuedAt: Self.issuedAt, registry: registry,
        clientHeader: "rarog-app/1+1"
      ).get()
      #expect(request.url?.absoluteString == "https://relay-auth.rarog.ai/v1/app/\(route.rawValue)")
    }
  }

  @Test("nagłówek klienta: rarog-app/<wersja>+<build>, najwyżej 128 znaków")
  func clientHeader() {
    #expect(RelayAuthClient.clientHeader(appVersion: "1.4.0", build: "317") == "rarog-app/1.4.0+317")
    let long = RelayAuthClient.clientHeader(appVersion: String(repeating: "9", count: 200), build: "1")
    #expect(long.count == 128 && long.hasPrefix("rarog-app/999"))
  }

  @Test("podpis rzuca → .unreachable bez żądania; treść błędu bez danych żądania")
  func signerFailure() async throws {
    let harness = Harness { _ in .json(200, #"{"v":1,"forgotten":true}"#) }
    let signer = FakeRelaySigner(endpointId: Self.appId, failure: .unavailable("identity"))
    let reply = await harness.send(.forget, signer: signer)
    guard case .unreachable = reply else {
      Issue.record("oczekiwane .unreachable, jest \(reply)")
      return
    }
    #expect(harness.requests.isEmpty)
  }

  @Test("brak sieci → .unreachable", arguments: [URLError.Code.notConnectedToInternet, .cannotConnectToHost,
    .networkConnectionLost, .timedOut])
  func noNetwork(_ code: URLError.Code) async throws {
    let harness = Harness { _ in MockURLProtocol.Reply(error: URLError(code)) }
    let reply = await harness.send(.forget)
    #expect(reply == .unreachable("network: URLError \(code.rawValue)"))
  }

  @Test("termin żądania: rejestr milczy → .unreachable po terminie, bez czekania w nieskończoność")
  func timeout() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SilentURLProtocol.self]
    let client = RelayAuthClient(appVersion: "0.1.0", build: "42", configuration: configuration,
      timeout: .milliseconds(300))
    let started = ContinuousClock.now
    let reply = await client.send(.forget, signer: FakeRelaySigner(endpointId: Self.appId), issuedAt: Self.issuedAt,
      registry: URL(string: "http://127.0.0.1:9")!)
    #expect(reply == .unreachable("network: URLError \(URLError.Code.timedOut.rawValue)"))
    #expect(ContinuousClock.now - started < .seconds(30))
    #expect(SilentURLProtocol.started.load(ordering: .relaxed) > 0, "żądanie doszło do atrapy")
  }

  @Test("klient z domyślną konfiguracją ma termin 10 s")
  func defaultTimeout() {
    let client = RelayAuthClient(appVersion: "1", build: "1")
    #expect(client.clientHeader == "rarog-app/1+1")
    #expect(client.session.configuration.timeoutIntervalForRequest == 10)
    #expect(client.session.configuration.timeoutIntervalForResource == 10)
  }
}

/// Rejestr, który przyjmuje żądanie i nigdy nie odpowiada.
final class SilentURLProtocol: URLProtocol, @unchecked Sendable {
  static let started = Atomic<Int>(0)

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() { Self.started.add(1, ordering: .relaxed) }
  override func stopLoading() {}
}
