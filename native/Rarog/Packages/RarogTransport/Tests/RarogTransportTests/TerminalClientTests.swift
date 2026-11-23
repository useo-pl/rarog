import Foundation
import RarogContract
import RarogContractFixtures
import RarogTransport
import Testing

// REST terminala i żądanie upgrade'u gniazda. Odpowiedzi to złote pliki `shared/fixtures/rest/term.*`
// (produkuje je kod serwera). Gniazda nie przechwyci atrapa `URLProtocol` (`URLSessionWebSocketTask`),
// więc jego nagłówki sprawdza czysty builder, a sam drut — `TerminalSocketLoopbackTests`.

private struct TerminalPolicy: MutationPolicy {
  var compat: String?
  var terminal: String?

  func compatibilityRefusal() async -> PolicyRefusal? { compat.map { PolicyRefusal($0) } }
  func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? { nil }
  func terminalInputRefusal() async -> PolicyRefusal? { terminal.map { PolicyRefusal($0) } }
}

private struct CompatOnlyPolicy: MutationPolicy {
  func compatibilityRefusal() async -> PolicyRefusal? { PolicyRefusal("Zaktualizuj apkę.") }
  func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? { nil }
}

private func golden(_ name: String) throws -> String {
  let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest/\(name)")
  return try String(contentsOf: url, encoding: .utf8)
}

@Suite("klient REST terminala i żądanie gniazda")
struct TerminalClientTests {
  static let id = "fd413e13ed78ca03"

  @Test("POST /api/term: ciało kontraktu, Origin, odpowiedź ze złotego pliku")
  func open() async throws {
    let reply = try golden("term.open.json")
    let harness = MockHarness { _ in .json(200, reply) }
    let body = try #require(TerminalOpenBody(cwd: "/Users/demo/Projects/rarog", slot: .number(2), role: .shell))
    let opened = try await harness.client.openTerminal(body)
    #expect(opened.id == Self.id && opened.slot == 1 && opened.role == .shell)
    let request = try #require(harness.requests.first)
    #expect(request.method == "POST" && request.path == "/api/term")
    #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
    let sent = try JSONSerialization.jsonObject(with: try #require(request.body)) as? [String: AnyHashable]
    #expect(sent == ["cwd": "/Users/demo/Projects/rarog", "slot": 2, "role": "shell"])
  }

  @Test("POST /api/term: 409 ze zdaniem serwera; bramka zgodności nie wypuszcza żądania")
  func openRefusals() async throws {
    let limit = try golden("error.term-limit.json")
    let refused = MockHarness { _ in .json(409, limit) }
    let body = try #require(TerminalOpenBody(cwd: "/p", slot: .next))
    await #expect(throws: TransportError.self) { _ = try await refused.client.openTerminal(body) }
    do {
      _ = try await refused.client.openTerminal(body)
    } catch {
      guard case let .http(failure) = error else { Issue.record("oczekiwano .http, jest \(error)"); return }
      #expect(failure.status == 409 && failure.code == "term-limit" && failure.message?.isEmpty == false)
    }
    let gated = MockHarness(policy: TerminalPolicy(compat: "Zaktualizuj apkę.")) { _ in .json(200, "{}") }
    do {
      _ = try await gated.client.openTerminal(body)
      Issue.record("bramka przepuściła POST")
    } catch {
      #expect(error == .refused(MutationRefusal(gate: .compatibility, message: "Zaktualizuj apkę.")))
    }
    #expect(gated.requests.isEmpty)
  }

  @Test("GET /api/term i historia: odczyty bez Origin, `lines` w query, złote odpowiedzi")
  func reads() async throws {
    let list = try golden("term.list.json")
    let history = try golden("term.history.json")
    let harness = MockHarness { request in request.path.hasSuffix("/api/term") ? .json(200, list) : .json(200, history) }
    let terminals = try await harness.client.terminals()
    #expect(terminals.terminals.map(\.role) == [.shell, .lazygit, .shell])
    let text = try await harness.client.terminalHistory(id: Self.id, lines: 1000)
    #expect(text.truncated && !text.text.isEmpty)
    #expect(harness.requests.map(\.path) == ["/api/term", "/api/term/\(Self.id)/history?lines=1000"])
    #expect(harness.requests.allSatisfy { $0.method == "GET" && $0.header("Origin") == nil })
  }

  @Test("historia spoza kontraktu: błąd bez cytatu odpowiedzi")
  func historyErrorCarriesNoContent() async throws {
    let harness = MockHarness { _ in .json(200, #"{"text":"tajne-hasło-z-ekranu","truncated":"nie"}"#) }
    do {
      _ = try await harness.client.terminalHistory(id: Self.id, lines: 10)
      Issue.record("zły kształt przeszedł")
    } catch {
      #expect(!"\(error)".contains("tajne"))
    }
  }

  @Test("DELETE /api/term/<id>: mutacja z Origin; id spoza TERM_ID_RE nie wychodzi z klienta")
  func close() async throws {
    let harness = MockHarness { _ in .json(200, "{}") }
    try await harness.client.closeTerminal(id: Self.id)
    let request = try #require(harness.requests.first)
    #expect(request.method == "DELETE" && request.path == "/api/term/\(Self.id)")
    #expect(request.header("Origin") != nil)
    await #expect(throws: TransportError.self) { try await harness.client.closeTerminal(id: "../../etc") }
    await #expect(throws: TransportError.self) { _ = try await harness.client.terminalHistory(id: "ABC", lines: 1) }
    #expect(harness.requests.count == 1)
  }

  @Test("bramka wejścia: odmowa trwała z polityki terminala; polityka bez niej pyta o zgodność")
  func inputGate() async throws {
    let open = MockHarness(policy: TerminalPolicy(compat: "Brak połączenia.", terminal: nil)) { _ in .json(200, "{}") }
    await #expect(throws: Never.self) { try await open.client.checkTerminalInput() }
    let blocked = MockHarness(policy: TerminalPolicy(terminal: "Zaktualizuj apkę.")) { _ in .json(200, "{}") }
    await #expect(throws: MutationRefusal(gate: .compatibility, message: "Zaktualizuj apkę.")) {
      try await blocked.client.checkTerminalInput()
    }
    let fallback = MockHarness(policy: CompatOnlyPolicy()) { _ in .json(200, "{}") }
    await #expect(throws: MutationRefusal.self) { try await fallback.client.checkTerminalInput() }
  }

  @Test("żądanie upgrade'u: wss z https, ścieżka i query, klucz urządzenia, Origin, UA, bez nagłówka etykiety")
  func socketRequest() throws {
    let config = RarogConfig(baseURL: URL(string: "https://rarog.example.ts.net/baza/")!, clientLabel: "iPad·Rarog", build: 1207)
    let grid = try #require(TerminalGrid(cols: 104, rows: 41))
    let request = try TerminalRequestBuilder.request(
      config: config, authorization: testDeviceHeader, id: Self.id, fresh: true, grid: grid)
    #expect(request.url?.absoluteString == "wss://rarog.example.ts.net/api/term/\(Self.id)?fresh=1&c=104&r=41")
    #expect(request.value(forHTTPHeaderField: "Authorization") == testDeviceHeader)
    #expect(request.value(forHTTPHeaderField: "Origin") == "https://rarog.example.ts.net")
    #expect(request.value(forHTTPHeaderField: "User-Agent") == "RarogApp/1207")
    #expect(request.value(forHTTPHeaderField: "X-Rarog-Client") == nil)
    #expect(request.httpShouldHandleCookies == false)
    #expect(request.timeoutInterval == 10)

    let local = RarogConfig.test(port: 18_971)
    let plain = try TerminalRequestBuilder.request(config: local, id: Self.id, fresh: false, grid: nil)
    #expect(plain.url?.absoluteString == "ws://127.0.0.1:18971/api/term/\(Self.id)")
    #expect(plain.value(forHTTPHeaderField: "Authorization") == nil)

    // Gniazdo bez `POST`: znacznik `direct=1` — serwer czyta go jako `direct === '1'` (`termAttachFromUrl`).
    let direct = try TerminalRequestBuilder.request(
      config: local, id: Self.id, fresh: true, direct: true, grid: grid)
    #expect(direct.url?.absoluteString == "ws://127.0.0.1:18971/api/term/\(Self.id)?fresh=1&direct=1&c=104&r=41")
    let reconnect = try TerminalRequestBuilder.request(config: local, id: Self.id, fresh: false, direct: true, grid: nil)
    #expect(reconnect.url?.absoluteString == "ws://127.0.0.1:18971/api/term/\(Self.id)?direct=1")
  }

  @Test("żądanie upgrade'u: id spoza TERM_ID_RE i adres bez http(s) nie dają żądania")
  func socketRequestRejects() {
    let config = RarogConfig.test(port: 18_971)
    #expect(throws: TransportError.self) {
      _ = try TerminalRequestBuilder.request(config: config, id: "../x", fresh: true, grid: nil)
    }
    let ftp = RarogConfig(baseURL: URL(string: "ftp://rarog")!, clientLabel: "x", build: 1)
    #expect(throws: TransportError.self) {
      _ = try TerminalRequestBuilder.request(config: ftp, id: Self.id, fresh: true, grid: nil)
    }
  }

  @Test("klient bierze klucz urządzenia, z którym idzie REST")
  func socketRequestFromClient() throws {
    let harness = MockHarness(device: testDevice) { _ in .json(200, "{}") }
    let request = try harness.client.terminalSocketRequest(id: Self.id, fresh: true, grid: nil)
    #expect(request.value(forHTTPHeaderField: "Authorization") == testDeviceHeader)
    #expect(request.url?.scheme == "ws")
    #expect(request.url?.query == "fresh=1", "bez `direct` — gniazdo zwykłe")
    let direct = try harness.client.terminalSocketRequest(id: Self.id, fresh: true, direct: true, grid: nil)
    #expect(direct.url?.query == "fresh=1&direct=1")
  }
}
