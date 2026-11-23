import Foundation
import RarogContract
import RarogTransport
import Testing

// Odpowiedź na kartę pytania na atrapie `URLProtocol`.

@Suite("klient REST: odpowiedź na kartę pytania")
struct AnswerClientTests {
  @Test("POST …/answers/<qId>: segmenty zakodowane, Origin, ciało z wartościami dosłownie")
  func post() async throws {
    let harness = MockHarness { _ in .json(200, #"{"ok":true}"#) }
    let body = AnswersBody(answers: [["SQLite (Recommended)"], ["Jednostkowe"]])
    try await harness.client.answerQuestion(sessionId: "w0:d4", qId: "screen:q:1", body)
    let request = try #require(harness.requests.first)
    #expect(request.method == "POST")
    #expect(request.path == "/api/sessions/w0%3Ad4/answers/screen%3Aq%3A1")
    #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
    let sent = try JSONSerialization.jsonObject(with: try #require(request.body)) as? [String: [[String]]]
    #expect(sent == ["answers": [["SQLite (Recommended)"], ["Jednostkowe"]]])
  }

  @Test("sukces z nieznanym ciałem dalej jest sukcesem (rozstrzygnięcie jedzie po SSE)")
  func tolerantSuccess() async throws {
    let harness = MockHarness { _ in .json(200, #"{"ok":true,"nowePole":1}"#) }
    try await harness.client.answerQuestion(sessionId: "s1", qId: "q1", AnswersBody(answers: [["A"]]))
  }

  @Test("odmowy serwera: kod, status i zdanie dochodzą do wołającego")
  func failures() async throws {
    let replies: [(Int, String)] = [
      (409, #"{"error":"bad-state","message":"Wielokrotny wybór zrób w terminalu — Rarog wyśle jedną odpowiedź."}"#),
      (410, #"{"error":"gone","message":"Prośba wygasła — wznów sesję."}"#),
      (400, #"{"error":"bad-request","message":"Własną odpowiedź wpisz w terminalu — Rarog wysyła cyfrę jednej z opcji."}"#),
    ]
    for (status, json) in replies {
      let harness = MockHarness { _ in .json(status, json) }
      do {
        try await harness.client.answerQuestion(sessionId: "s1", qId: "q1", AnswersBody(answers: [["A", "B"]]))
        Issue.record("odmowa \(status) powinna rzucić")
      } catch {
        guard case let .http(failure) = error else {
          Issue.record("zły błąd: \(error)")
          continue
        }
        #expect(failure.status == status)
        #expect(failure.message?.isEmpty == false)
      }
    }
  }

  @Test("bramka sesji nieobsługiwanej: odpowiedź nie wychodzi")
  func gate() async throws {
    let harness = MockHarness(policy: UnsupportedSessions(unsupported: ["x"])) { _ in .json(200, #"{"ok":true}"#) }
    do {
      try await harness.client.answerQuestion(sessionId: "x", qId: "q1", AnswersBody(answers: [["A"]]))
      Issue.record("bramka powinna odmówić")
    } catch {
      #expect(error == .refused(MutationRefusal(
        gate: .unsupportedSession(id: "x"), message: "Ta wersja apki nie obsługuje tej sesji.")))
    }
    #expect(harness.requests.isEmpty)
  }
}
