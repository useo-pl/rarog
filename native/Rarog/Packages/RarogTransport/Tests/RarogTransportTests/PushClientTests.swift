import Foundation
import RarogContract
import RarogTransport
import Testing

// Trasy APNs i Live Activity apki na atrapie `URLProtocol`: nagłówki mutacji, klucz urządzenia,
// ciała w kształcie schematów `@rarog/shared/rest` i odczyt statusu tokenu.

private let token = String(repeating: "a1b2c3d4", count: 8)

@Suite("klient REST: APNs i Live Activity")
struct PushClientTests {
  private static func reply(_ request: MockURLProtocol.Recorded) -> MockURLProtocol.Reply {
    switch request.path {
    case "/api/push/apns/status":
      .json(200, #"{"enabled":true,"registered":true,"alerts":false,"degradedSince":"2026-10-07T10:00:00.000Z"}"#)
    default:
      MockURLProtocol.Reply(status: 204)
    }
  }

  private func json(_ request: MockURLProtocol.Recorded) throws -> [String: Any] {
    let body = try #require(request.body)
    return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
  }

  @Test("rejestracja: Origin, etykieta i klucz urządzenia; etykieta z konfiguracji, `test` tylko przy próbnym, `topic` gdy jest")
  func register() async throws {
    let harness = MockHarness(device: testDevice) { Self.reply($0) }
    try await harness.client.registerApns(
      token: token, environment: .development, topic: "ai.example.app", alerts: true, test: false)
    try await harness.client.registerApns(token: token, environment: .production, topic: nil, alerts: false, test: true)
    let posts = harness.requests.filter { $0.path == "/api/push/apns" }
    #expect(posts.count == 2)
    for request in posts {
      #expect(request.method == "POST")
      #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
      #expect(request.header("Authorization") == testDeviceHeader)
      #expect(request.header("Content-Type") == "application/json")
    }
    let plain = try json(posts[0])
    #expect(plain["token"] as? String == token && plain["environment"] as? String == "development")
    #expect(plain["label"] as? String == "iPad·Rarog" && plain["alerts"] as? Bool == true && plain["test"] == nil)
    #expect(plain["topic"] as? String == "ai.example.app")
    // Deklaracja formatów banera w KAŻDEJ rejestracji: od niej serwer daje wpisowi format 3.
    #expect(plain["pushFormats"] as? [Int] == [3])
    let probe = try json(posts[1])
    #expect(probe["pushFormats"] as? [Int] == [3])
    #expect(probe["environment"] as? String == "production" && probe["alerts"] as? Bool == false)
    #expect(probe["test"] as? Bool == true)
    // Apka, która nie zna swojego bundle id, nie wysyła pola wcale — serwer da wpisowi temat legacy.
    #expect(probe["topic"] == nil)
  }

  @Test("status tokenu: POST z tokenem w ciele, nie w adresie; odpowiedź czytana kontraktem")
  func status() async throws {
    let harness = MockHarness { Self.reply($0) }
    let status = try await harness.client.apnsStatus(token: token)
    #expect(status.enabled && status.registered && !status.alerts)
    #expect(status.degradedSince == "2026-10-07T10:00:00.000Z")
    let request = try #require(harness.requests.first)
    // `path` atrapy niesie też zapytanie: dokładna równość = bez `?token=`.
    #expect(request.method == "POST" && request.path == "/api/push/apns/status")
    #expect(try json(request)["token"] as? String == token)
  }

  @Test("wyrejestrowanie i Live Activity: ścieżki i ciała z kontraktu")
  func otherRoutes() async throws {
    let harness = MockHarness { Self.reply($0) }
    let update = String(repeating: "0f1e2d3c", count: 10)
    try await harness.client.unregisterApns(token: token)
    try await harness.client.registerLiveActivity(
      LiveActivityRegisterBody(deviceToken: token, activityId: "akt-1", updateToken: update))
    try await harness.client.endLiveActivity(LiveActivityEndBody(deviceToken: token, activityId: "akt-1"))
    #expect(harness.requests.map(\.path)
      == ["/api/push/apns/unregister", "/api/push/live-activity", "/api/push/live-activity/end"])
    #expect(try json(harness.requests[0]).keys.sorted() == ["token"])
    #expect(try json(harness.requests[1])["updateToken"] as? String == update)
    #expect(try json(harness.requests[2])["activityId"] as? String == "akt-1")
  }

  @Test("429 pusha próbnego to `.rateLimited`; zła odpowiedź statusu nie cytuje treści")
  func failures() async throws {
    let throttled = MockHarness { _ in .json(429, #"{"error":"rate-limited","message":"Push próbny był przed chwilą."}"#) }
    await #expect {
      try await throttled.client.registerApns(token: token, environment: .development, topic: nil, alerts: true, test: true)
    } throws: { error in
      guard case let TransportError.rateLimited(failure) = error else { return false }
      return failure.message == "Push próbny był przed chwilą."
    }
    let broken = MockHarness { _ in .json(200, #"{"enabled":true}"#) }
    await #expect {
      _ = try await broken.client.apnsStatus(token: token)
    } throws: { error in
      guard case let TransportError.invalidResponse(message) = error else { return false }
      return message.contains("/api/push/apns/status") && !message.contains(token)
    }
  }

  @Test("bramka zgodności odmawia rejestracji, zanim cokolwiek wyjdzie")
  func gate() async {
    let harness = MockHarness(policy: IncompatiblePolicy()) { Self.reply($0) }
    await #expect(throws: TransportError.self) {
      try await harness.client.registerApns(token: token, environment: .development, topic: nil, alerts: true, test: false)
    }
    #expect(harness.requests.isEmpty)
  }
}
