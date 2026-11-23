import Foundation
import RarogContract
import RarogTransport
import Testing

/// Atrapa serwera Raroga w miniaturze: wersja, mutacje 202/204.
private func fakeRarog(_ request: MockURLProtocol.Recorded) -> MockURLProtocol.Reply {
  switch (request.method, request.path) {
  case ("GET", "/api/version"):
    .json(200, #"""
      {"version":"0.1.0","protocolVersion":3,"serverStartId":"x","voiceEnabled":false,
      "tailnet":null,"release":null,"hookSeenAgo":null}
      """#)
  case ("POST", "/api/presence"):
    MockURLProtocol.Reply(status: 204, headers: [:], chunks: [])
  default:
    .json(202, #"{"ok":true}"#)
  }
}

/// Bramka z ustalonymi odmowami.
private struct FixedPolicy: MutationPolicy {
  var compat: String?
  var unsupported: Set<String> = []

  func compatibilityRefusal() async -> PolicyRefusal? { compat.map { PolicyRefusal($0) } }
  func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? {
    unsupported.contains(sessionId) ? PolicyRefusal("Ta wersja apki nie obsługuje tej sesji.") : nil
  }
}

@Suite("klient REST: nagłówki, błędy, bramka")
struct RarogClientTests {
  @Test("GET z kluczem urządzenia, bez Origin; wersja dekodowana (null w tailnet)")
  func credentialOnGet() async throws {
    let harness = MockHarness(device: testDevice, handler: fakeRarog)
    let version = try await harness.client.version()
    #expect(version.protocolVersion == 3)
    #expect(version.voiceEnabled == false)
    #expect(version.tailnet == nil)

    let get = try #require(harness.requests.last)
    #expect(get.path == "/api/version")
    #expect(get.header("Authorization") == testDeviceHeader)
    #expect(get.header("User-Agent") == "RarogApp/42")
    #expect(get.header("Origin") == nil)
  }

  @Test("każda mutacja niesie Origin, UA i klucz urządzenia, bez nagłówka etykiety; segmenty ścieżki zakodowane")
  func mutationHeaders() async throws {
    let harness = MockHarness(device: testDevice, handler: fakeRarog)
    try await harness.client.sendMessage(sessionId: "herdr-w1/p1 ą", MessageBody(text: "cześć"))
    try await harness.client.decidePermission(
      sessionId: "s1", permId: "toolu_21", PermissionDecisionBody(decision: .allowAlways)
    )
    try await harness.client.presence(PresenceBody(clientId: "scena-1", visible: true, sessionId: "s1"))
    try await harness.client.clientLog(ClientLogBody(events: [.init(at: "t", level: "info", msg: "start")]))

    let mutations = harness.requests
    #expect(mutations.map(\.path) == [
      "/api/sessions/herdr-w1%2Fp1%20%C4%85/messages",
      "/api/sessions/s1/permissions/toolu_21",
      "/api/presence",
      "/api/client-log",
    ])
    for request in mutations {
      #expect(request.method == "POST")
      #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)", "\(request.path)")
      #expect(request.header("X-Rarog-Client") == nil, "\(request.path)")
      #expect(request.header("User-Agent") == "RarogApp/42", "\(request.path)")
      #expect(request.header("Authorization") == testDeviceHeader, "\(request.path)")
      #expect(request.header("Content-Type") == "application/json", "\(request.path)")
    }
    let decision = try JSONSerialization.jsonObject(with: try #require(mutations.dropFirst().first?.body))
    #expect(decision as? [String: String] == ["decision": "allow-always"])
  }

  @Test("cancelPairingCode: DELETE /api/pairings with the device key and Origin, without a body")
  func cancelPairingCode() async throws {
    let harness = MockHarness(device: testDevice) { _ in MockURLProtocol.Reply(status: 204, headers: [:], chunks: []) }
    try await harness.client.cancelPairingCode()

    let request = try #require(harness.requests.last)
    #expect(harness.requests.count == 1)
    #expect(request.method == "DELETE" && request.path == "/api/pairings")
    #expect(request.header("Authorization") == testDeviceHeader)
    #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
    #expect(request.body?.isEmpty ?? true, "the server refuses a body on this route")
    #expect(request.header("Content-Type") == nil)
  }

  @Test("401 → błąd typowany i odmowa klucza w zatrzasku")
  func unauthorized() async throws {
    let harness = MockHarness(device: testDevice) { _ in
      .json(401, #"{"error":"unauthorized","message":"Zaloguj się ponownie."}"#)
    }
    let error = await #expect(throws: TransportError.self) { try await harness.client.version() }
    #expect(error == .unauthorized(APIFailure(status: 401, code: "unauthorized", message: "Zaloguj się ponownie.")))
    #expect(harness.client.credentialRejection == .unknown(deviceId: testDevice.deviceId))
  }

  @Test("401 `device-revoked` (złoty plik): zdanie po polsku, odmowa klucza z datą w zatrzasku")
  func revokedTranslated() async throws {
    let body = try goldenRest("error.device-revoked.json")
    let harness = MockHarness(device: testDevice) { _ in .json(401, body) }
    let error = await #expect(throws: TransportError.self) { try await harness.client.version() }
    #expect(error == .unauthorized(APIFailure(
      status: 401, code: "device-revoked", message: "To urządzenie odpięto — sparuj je z serwerem ponownie.")))
    guard case let .revoked(deviceId, _, revokedBy)? = harness.client.credentialRejection else {
      Issue.record("oczekiwano odmowy `revoked`, jest \(String(describing: harness.client.credentialRejection))")
      return
    }
    #expect(deviceId == testDevice.deviceId && revokedBy == "admin")
  }

  @Test("statusy błędów: 429 z Retry-After, 403 z Caddy, 422 z powodem")
  func failures() async throws {
    let harness = MockHarness { request in
      switch request.path {
      case "/api/presence":
        .json(429, #"{"error":"too-many-requests","message":"Za dużo prób."}"#, headers: ["Retry-After": "30"])
      case "/api/version":
        MockURLProtocol.Reply(status: 403, headers: ["Content-Type": "text/html"], chunks: [Data("<html>".utf8)])
      default: .json(422, #"{"error":"refused","reason":"no-digit","message":"Nie wiem, która opcja."}"#)
      }
    }
    let client = harness.client
    let limited = await #expect(throws: TransportError.self) {
      try await client.presence(PresenceBody(clientId: "c", visible: true))
    }
    #expect(limited == .rateLimited(
      APIFailure(status: 429, code: "too-many-requests", message: "Za dużo prób.", retryAfter: 30)))
    let caddy = await #expect(throws: TransportError.self) { try await client.version() }
    #expect(caddy == .forbidden(APIFailure(status: 403)))
    let refused = await #expect(throws: TransportError.self) {
      try await client.decidePermission(sessionId: "s", permId: "p", PermissionDecisionBody(decision: .allow))
    }
    #expect(refused == .http(APIFailure(status: 422, code: "refused", message: "Nie wiem, która opcja.", reason: "no-digit")))
  }

  @Test("bramka zgodności: mutacja nie wychodzi; obecność, log i odczyty przechodzą")
  func compatibilityGate() async throws {
    let harness = MockHarness(policy: FixedPolicy(compat: "Zaktualizuj apkę."), handler: fakeRarog)
    let client = harness.client
    try await client.presence(PresenceBody(clientId: "c", visible: false))
    try await client.clientLog(ClientLogBody(events: []))
    _ = try await client.version()
    let error = await #expect(throws: TransportError.self) {
      try await client.sendMessage(sessionId: "s1", MessageBody(text: "x"))
    }
    #expect(error == .refused(MutationRefusal(gate: .compatibility, message: "Zaktualizuj apkę.")))
    #expect(harness.requests.map(\.path) == ["/api/presence", "/api/client-log", "/api/version"])
  }

  @Test("bramka sesji unsupported: tylko mutacje tej sesji są odmawiane, przed wysłaniem")
  func unsupportedSessionGate() async throws {
    let harness = MockHarness(policy: FixedPolicy(unsupported: ["s/1"]), handler: fakeRarog)
    let client = harness.client
    let error = await #expect(throws: TransportError.self) {
      try await client.decidePermission(sessionId: "s/1", permId: "p", PermissionDecisionBody(decision: .deny))
    }
    #expect(error == .refused(MutationRefusal(
      gate: .unsupportedSession(id: "s/1"), message: "Ta wersja apki nie obsługuje tej sesji.")))
    try await client.sendMessage(sessionId: "s2", MessageBody(text: "x"))
    #expect(harness.requests.map(\.path) == ["/api/sessions/s2/messages"])
  }

  @Test("brak sieci i przekroczony czas → osobne błędy (nie wylogowanie)")
  func networkErrors() async {
    let harness = MockHarness { request in
      MockURLProtocol.Reply(error: URLError(request.path == "/api/version" ? .timedOut : .notConnectedToInternet))
    }
    let timeout = await #expect(throws: TransportError.self) { try await harness.client.version() }
    #expect(timeout == .timedOut)
    let offline = await #expect(throws: TransportError.self) {
      try await harness.client.presence(PresenceBody(clientId: "c", visible: true))
    }
    #expect(offline == .offline(.notConnectedToInternet))
  }

  @Test("strumień: Accept, Last-Event-ID i klucz urządzenia; CRLF i UTF-8 rozcięte między kawałkami")
  func stream() async throws {
    let chunks = [
      "retry: 3000\r\n\r\nid: x:1\r\ndata: {\"type\":\"hello\",\"protocolVersion\":3,\"serverStartId\":\"x\"}\r",
      "\n\r\n: ping\r\ndata: {\"type\":\"delta\",\"sessionId\":\"s\",\"text\":\"Za\u{017C}",
      "\u{00F3}\u{0142}\u{0107}\"}\n\n",
    ].map { Data($0.utf8) }
    // Rozcięcie w środku „ż": ostatni bajt pierwszego znaku wielobajtowego trafia do kolejnego kawałka.
    let split = [chunks[0], chunks[1].dropLast(), chunks[1].suffix(1) + chunks[2]]
    let harness = MockHarness(device: testDevice) { _ in
      MockURLProtocol.Reply(status: 200, headers: ["Content-Type": "text/event-stream; charset=utf-8"], chunks: split)
    }
    var outputs: [SSEParser.Output] = []
    for try await output in try await harness.client.openStream(.session(id: "s 1"), lastEventId: "x:0") {
      outputs.append(output)
    }

    let request = try #require(harness.requests.last)
    #expect(request.path == "/api/sessions/s%201/stream")
    #expect(request.header("Accept") == "text/event-stream")
    #expect(request.header("Last-Event-ID") == "x:0")
    #expect(request.header("Authorization") == testDeviceHeader)

    #expect(outputs.count == 4)
    #expect(outputs.first == .retry(3000))
    #expect(outputs[2] == .comment(" ping"))
    guard case let .event(hello) = outputs[1], case let .event(delta) = outputs[3] else {
      Issue.record("brak zdarzeń: \(outputs)")
      return
    }
    #expect(hello.lastEventId == "x:1")
    #expect(EventDecoder.decodeEvent(Data(hello.data.utf8))?.event.wireType == .hello)
    #expect(delta.data.hasSuffix("Zażółć\"}"))
    #expect(delta.lastEventId == "x:1")
    #expect(delta.id == nil)
  }

  @Test("strumień: 401 rzuca przed pierwszym bajtem; zły Content-Type to błąd odpowiedzi")
  func streamFailures() async throws {
    let unauthorized = MockHarness { _ in .json(401, #"{"error":"unauthorized","message":"Zaloguj się ponownie."}"#) }
    let error = await #expect(throws: TransportError.self) { _ = try await unauthorized.client.openStream(.global) }
    #expect(error == .unauthorized(APIFailure(status: 401, code: "unauthorized", message: "Zaloguj się ponownie.")))

    let html = MockHarness { _ in MockURLProtocol.Reply(status: 200, headers: ["Content-Type": "text/html"], chunks: []) }
    let wrongType = await #expect(throws: TransportError.self) { _ = try await html.client.openStream(.global) }
    guard case .invalidResponse? = wrongType else {
      Issue.record("oczekiwano invalidResponse, jest \(String(describing: wrongType))")
      return
    }
  }
}

@Suite("konfiguracja i bramka: czyste funkcje")
struct RarogConfigTests {
  @Test("Origin z adresu bazowego: schemat, host, port, bez ścieżki")
  func origin() {
    #expect(RarogConfig.origin(of: URL(string: "https://rarog.example.ts.net")!) == "https://rarog.example.ts.net")
    #expect(RarogConfig.origin(of: URL(string: "http://127.0.0.1:18930/")!) == "http://127.0.0.1:18930")
    let test = RarogConfig.test(port: 18_930, build: 7)
    #expect(test.origin == "http://127.0.0.1:18930")
    #expect(test.userAgent == "RarogApp/7")
    #expect(test.requestTimeout == .seconds(10))
  }

  @Test("bramka rozpoznaje mutacje i sesję w ścieżce jak `request()` PWA")
  func gatePaths() async throws {
    let gate = MutationGate(policy: GateProbe())
    try await gate.check(method: "GET", path: "/api/sessions/zly/stream")
    try await gate.check(method: "POST", path: "/api/sessions")
    await #expect(throws: MutationRefusal.self) { try await gate.check(method: "POST", path: "/api/sessions/zly/seen") }
    await #expect(throws: MutationRefusal.self) { try await gate.check(method: "DELETE", path: "/api/sessions/zly/") }
    await #expect(throws: MutationRefusal.self) { try await gate.check(method: "POST", path: "/api/sessions/z%6Cy/close") }
    try await gate.check(method: "POST", path: "/api/sessions/dobry/close")
    // Trasa po identyfikatorze trafia do polityki: sesja z cache zamyka się po samej liście.
    try await gate.check(method: "POST", path: "/api/sessions/tylko-lista/close")
    await #expect(throws: MutationRefusal.self) {
      try await gate.check(method: "POST", path: "/api/sessions/tylko-lista/answers/q1")
    }
    await #expect(throws: MutationRefusal.self) { try await gate.check(method: "DELETE", path: "/api/sessions/tylko-lista/") }
  }

  private struct GateProbe: MutationPolicy {
    func compatibilityRefusal() async -> PolicyRefusal? { nil }
    func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? {
      sessionId == "zly" || (sessionId == "tylko-lista" && route != "close") ? PolicyRefusal("nie") : nil
    }
  }
}
