import Foundation
import RarogContract
import RarogTransport
import Testing

// Katalog projektów, zakładanie i zamykanie sesji na atrapie `URLProtocol`.

/// Bramka z ustalonymi odmowami (zgodność, sesja nieobsługiwana).
private struct CatalogPolicy: MutationPolicy {
  var compat: String?
  var unsupported: Set<String> = []

  func compatibilityRefusal() async -> PolicyRefusal? { compat.map { PolicyRefusal($0) } }
  func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? {
    unsupported.contains(sessionId) ? PolicyRefusal("Ta wersja apki nie obsługuje tej sesji.") : nil
  }
}

@Suite("klient REST: projekty, nowa sesja, zamknięcie")
struct CatalogClientTests {
  @Test("GET /api/projects/recent: lista projektów, GET bez Origin")
  func recentProjects() async throws {
    let harness = MockHarness { _ in
      .json(200, #"{"projects":[{"cwd":"/Users/demo/Projects/willow","mtime":"2026-10-04T22:22:43.682Z"}]}"#)
    }
    let list = try await harness.client.recentProjects()
    #expect(list.projects.map(\.cwd) == ["/Users/demo/Projects/willow"])
    let request = try #require(harness.requests.first)
    #expect(request.method == "GET" && request.path == "/api/projects/recent")
    #expect(request.header("Origin") == nil)
  }

  @Test("POST /api/sessions: ciało bez pustych pól, Origin, odpowiedź 202 z identyfikatorem")
  func createSession() async throws {
    let harness = MockHarness { _ in .json(202, #"{"sessionId":"w0:d4","state":"starting","trustPrompt":true}"#) }
    let reply = try await harness.client.createSession(
      CreateSessionBody(cwd: "/Users/demo/Projects/willow", model: "opus[1m]", effort: .xhigh))
    #expect(reply.sessionId == "w0:d4")
    #expect(reply.trustPrompt)
    let request = try #require(harness.requests.first)
    #expect(request.method == "POST" && request.path == "/api/sessions")
    #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
    let body = try JSONSerialization.jsonObject(with: try #require(request.body)) as? [String: String]
    #expect(body == ["cwd": "/Users/demo/Projects/willow", "model": "opus[1m]", "effort": "xhigh"])
  }

  @Test("POST /api/sessions: bez modelu nie leci ani model, ani effort; wartownik effortu odcięty")
  func createBodyDropsEmpty() throws {
    let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
      CreateSessionBody(cwd: "/x", model: "  ", effort: .high))) as? [String: String]
    #expect(plain == ["cwd": "/x"])
    let sentinel = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
      CreateSessionBody(cwd: "/x", model: "sonnet", effort: .unsupported))) as? [String: String]
    #expect(sentinel == ["cwd": "/x", "model": "sonnet"])
  }

  @Test("POST /api/sessions: ultracode leci jako `true` także bez modelu; wyłączone nie leci wcale")
  func createBodyUltracode() async throws {
    let harness = MockHarness { _ in .json(202, #"{"sessionId":"w0:d4","state":"starting"}"#) }
    _ = try await harness.client.createSession(CreateSessionBody(cwd: "/x", ultracode: true))
    let request = try #require(harness.requests.first)
    // Słownik ogólny, bo ciało niesie bool obok tekstu.
    let sent = try JSONSerialization.jsonObject(with: try #require(request.body)) as? NSDictionary
    #expect(sent == ["cwd": "/x", "ultracode": true] as NSDictionary)
    let off = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
      CreateSessionBody(cwd: "/x", ultracode: false))) as? NSDictionary
    #expect(off == ["cwd": "/x"] as NSDictionary)
  }

  @Test("POST /api/sessions: odmowa serwera wraca z kodem i zdaniem; bramka zgodności nie puszcza")
  func createRefusals() async throws {
    let harness = MockHarness { _ in
      .json(400, #"{"error":"model-unknown","message":"Ten model nie jest dostępny na tym koncie."}"#)
    }
    do {
      _ = try await harness.client.createSession(CreateSessionBody(cwd: "/x", model: "stary"))
      Issue.record("odmowa powinna rzucić")
    } catch {
      guard case let .http(failure) = error else { Issue.record("zły błąd: \(error)"); return }
      #expect(failure.status == 400 && failure.code == "model-unknown")
      #expect(failure.message == "Ten model nie jest dostępny na tym koncie.")
    }

    let gated = MockHarness(policy: CatalogPolicy(compat: "zaktualizuj apkę")) { _ in .json(202, "{}") }
    do {
      _ = try await gated.client.createSession(CreateSessionBody(cwd: "/x"))
      Issue.record("bramka powinna odmówić")
    } catch {
      guard case let .refused(refusal) = error else { Issue.record("zły błąd: \(error)"); return }
      #expect(refusal.gate == .compatibility)
    }
    #expect(gated.requests.isEmpty, "nic nie wyszło do serwera")
  }

  @Test("POST /api/sessions/<id>/close: closePanel true, segment zakodowany, bramka sesji nieobsługiwanej")
  func closeSession() async throws {
    let harness = MockHarness { _ in .json(200, #"{"ok":true}"#) }
    try await harness.client.closeSession(sessionId: "w0:d4", CloseSessionBody())
    let request = try #require(harness.requests.first)
    #expect(request.path == "/api/sessions/w0%3Ad4/close")
    let body = try JSONSerialization.jsonObject(with: try #require(request.body)) as? [String: Bool]
    #expect(body == ["closePanel": true])

    let gated = MockHarness(policy: CatalogPolicy(unsupported: ["x"])) { _ in .json(200, #"{"ok":true}"#) }
    do {
      try await gated.client.closeSession(sessionId: "x", CloseSessionBody())
      Issue.record("bramka powinna odmówić")
    } catch {
      guard case let .refused(refusal) = error else { Issue.record("zły błąd: \(error)"); return }
      #expect(refusal.gate == .unsupportedSession(id: "x"))
    }
    #expect(gated.requests.isEmpty)
  }

  @Test("odpowiedź spoza kontraktu: null w trustPrompt, pusty sessionId, ok:false")
  func contractViolations() async throws {
    for body in [#"{"sessionId":"a","trustPrompt":null}"#, #"{"sessionId":""}"#] {
      let harness = MockHarness { _ in .json(202, body) }
      await #expect(throws: TransportError.self, "\(body)") {
        _ = try await harness.client.createSession(CreateSessionBody(cwd: "/x"))
      }
    }
    let close = MockHarness { _ in .json(200, #"{"ok":false}"#) }
    await #expect(throws: TransportError.self) {
      try await close.client.closeSession(sessionId: "s", CloseSessionBody())
    }
  }
}
