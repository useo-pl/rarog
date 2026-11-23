import Foundation
import RarogContract
import RarogTransport
import Testing

// Karty na atrapie `URLProtocol`: dialog w panelu i „Wznów".

@Suite("klient REST: dialog w panelu i Wznów")
struct DecisionsClientTests {
  @Test("POST …/permission, …/resume: ścieżki, ciała, Origin")
  func requests() async throws {
    let summary = #"""
      {"id":"w0:a","cwd":"/x","title":"x","state":"starting","stateSince":"2026-10-04T10:00:00.000Z",
       "createdAt":"2026-10-04T10:00:00.000Z","lastActivityAt":"2026-10-04T10:00:00.000Z"}
      """#
    let harness = MockHarness { request in
      if request.path.hasSuffix("/resume") { return .json(200, #"{"sessionId":"w0:a","session":\#(summary)}"#) }
      return .json(200, #"{"ok":true}"#)
    }
    try await harness.client.decideDialog(sessionId: "w0:a", PermissionDecisionBody(decision: .deny))
    let resumed = try await harness.client.resumeSession(sessionId: "w0:a")
    #expect(resumed.sessionId == "w0:a" && resumed.session.state == .starting)
    #expect(harness.requests.map { "\($0.method) \($0.path)" } == [
      "POST /api/sessions/w0%3Aa/permission", "POST /api/sessions/w0%3Aa/resume",
    ])
    let bodies = harness.requests.map { String(decoding: $0.body ?? Data(), as: UTF8.self) }
    #expect(bodies == [#"{"decision":"deny"}"#, "{}"])
    #expect(harness.requests.allSatisfy { $0.header("Origin") == "http://127.0.0.1:\(harness.port)" })
  }

  @Test("odmowy serwera wracają kodem i zdaniem; odpowiedź spoza kontraktu = błąd")
  func refusals() async throws {
    let harness = MockHarness { request in
      request.path.hasSuffix("/resume")
        ? .json(409, #"{"error":"bad-state","message":"Sesja jest w stanie, który nie pozwala na tę akcję."}"#)
        : .json(422, #"{"error":"refused","reason":"send-failed","message":"Nic nie doszło do panelu."}"#)
    }
    do {
      _ = try await harness.client.resumeSession(sessionId: "s1")
      Issue.record("409 powinno rzucić")
    } catch {
      guard case let .http(failure) = error else { Issue.record("zły błąd: \(error)"); return }
      #expect(failure.status == 409 && failure.code == "bad-state")
    }
    do {
      try await harness.client.decideDialog(sessionId: "s1", PermissionDecisionBody(decision: .allow))
      Issue.record("422 powinno rzucić")
    } catch {
      guard case let .http(failure) = error else { Issue.record("zły błąd: \(error)"); return }
      #expect(failure.status == 422 && failure.reason == "send-failed" && failure.message == "Nic nie doszło do panelu.")
    }
    let broken = MockHarness { _ in .json(200, #"{"ok":false}"#) }
    await #expect(throws: TransportError.self) {
      try await broken.client.decideDialog(sessionId: "s1", PermissionDecisionBody(decision: .deny))
    }
  }

  @Test("bramka sesji nieobsługiwanej: żadna z tras kart nie wychodzi")
  func gate() async {
    let harness = MockHarness(policy: UnsupportedSessions(unsupported: ["x"])) { _ in .json(200, #"{"ok":true}"#) }
    await #expect(throws: TransportError.self) {
      try await harness.client.decideDialog(sessionId: "x", PermissionDecisionBody(decision: .deny))
    }
    await #expect(throws: TransportError.self) { _ = try await harness.client.resumeSession(sessionId: "x") }
    #expect(harness.requests.isEmpty)
  }

  // MARK: - Zdania serwera z kodem, renderer `pl`

  @Test("422 `multi-select` (złoty plik) → polskie zdanie odmowy, powód bez zmian; 409 `bad-state` po polsku")
  func refusalsTranslated() async throws {
    let refused = try goldenRest("error.decision-refused.json")
    let harness = MockHarness { request in
      request.path.hasSuffix("/resume")
        ? .json(409, #"{"error":"bad-state","message":"The session is in a state that doesn't allow this action.","messageRef":{"code":"rest.bad-state"}}"#)
        : .json(422, refused)
    }
    let decision = await #expect(throws: TransportError.self) {
      try await harness.client.decideDialog(sessionId: "s1", PermissionDecisionBody(decision: .allow))
    }
    #expect(decision == .http(APIFailure(
      status: 422, code: "refused", message: "Wielokrotny wybór zrób w terminalu — Rarog wysyła jedną cyfrę.",
      reason: "multi-select")))
    let resume = await #expect(throws: TransportError.self) { _ = try await harness.client.resumeSession(sessionId: "s1") }
    #expect(resume == .http(APIFailure(
      status: 409, code: "bad-state", message: "Sesja jest w stanie, który nie pozwala na tę akcję.")))
  }

  @Test("Wznów: sesja z odpowiedzi tłumaczona (`labelRef` etykiety zapasowej)")
  func resumeTranslated() async throws {
    let body = #"""
      {"sessionId":"w0:a","session":{"id":"w0:a","cwd":"/x","title":"x","state":"starting",
       "stateSince":"2026-10-04T10:00:00.000Z","createdAt":"2026-10-04T10:00:00.000Z",
       "lastActivityAt":"2026-10-04T10:00:00.000Z","label":"session 2",
       "labelRef":{"code":"session.fallback-label","args":["2"]}}}
      """#
    let harness = MockHarness { _ in .json(200, body) }
    let resumed = try await harness.client.resumeSession(sessionId: "w0:a")
    #expect(resumed.session.label == "sesja 2")
    #expect(resumed.session.labelRef == SentenceRef(code: "session.fallback-label", args: ["2"]))
  }
}
