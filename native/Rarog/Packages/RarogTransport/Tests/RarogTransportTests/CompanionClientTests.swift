import Foundation
import RarogContract
import RarogTransport
import Testing

// Klucz krótki OpenAI agenta głosowego na atrapie `URLProtocol`.

/// Syntetyczny klucz: prawdziwego testy nie znają.
private let secret = "ek_test_yyyyyyyyyyyyyyyyyyyyyyyy"
private let tokenJSON = #"""
  {"value":"ek_test_yyyyyyyyyyyyyyyyyyyyyyyy","expiresAt":"2026-11-10T12:01:00.000Z","model":"gpt-realtime-2.1"}
  """#

@Suite("klient REST: klucz krótki agenta głosowego")
struct CompanionClientTests {
  @Test("POST /api/companion/token: puste ciało, Origin, klucz i model z odpowiedzi")
  func mint() async throws {
    let harness = MockHarness { _ in .json(200, tokenJSON) }
    let token = try await harness.client.companionToken()
    #expect(token.value == secret && token.model == "gpt-realtime-2.1")
    let request = try #require(harness.requests.first)
    #expect(request.method == "POST" && request.path == "/api/companion/token")
    #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
    // Serwer odrzuca ciało z polami (`strictObject({})`): model i ważność ustala on.
    #expect(request.body.map { String(decoding: $0, as: UTF8.self) } == "{}")
  }

  @Test("„wyłączone” (404, 503) i „nie teraz” (429, 502) to różne błędy ze zdaniem serwera")
  func refusals() async {
    let replies: [(Int, String)] = [
      (503, #"{"error":"companion-disabled","message":"The voice agent has no OpenAI key on the server."}"#),
      (503, #"{"error":"companion-openai-key","message":"OpenAI rejected the server's key."}"#),
      (404, #"{"error":"not-found","message":"That endpoint doesn't exist."}"#),
      (429, #"{"error":"companion-throttled","message":"Too soon."}"#),
      (429, #"{"error":"companion-openai-limit","message":"The OpenAI account limit is reached."}"#),
      (502, #"{"error":"companion-openai","message":"OpenAI didn't give the voice agent a key."}"#),
    ]
    for (status, body) in replies {
      let harness = MockHarness { _ in .json(status, body) }
      do {
        _ = try await harness.client.companionToken()
        Issue.record("\(status) powinno rzucić")
      } catch {
        switch (status, error) {
        case let (429, .rateLimited(failure)): #expect(failure.message != nil)
        case let (_, .http(failure)): #expect(failure.status == status && failure.message != nil)
        default: Issue.record("\(status): nieoczekiwany błąd \(error)")
        }
      }
    }
  }

  @Test("odpowiedź spoza kontraktu: błąd nazywa pole, nigdy nie cytuje klucza")
  func malformed() async {
    // Każda odpowiedź niesie syntetyczny klucz obok uszkodzenia: komunikat nie może go zacytować.
    let cases: [(String, String)] = [
      (tokenJSON.replacing(#""model":"gpt-realtime-2.1""#, with: #""model":"""#), "model"),
      (tokenJSON.replacing(#""expiresAt":"2026-11-10T12:01:00.000Z""#, with: #""expiresAt":5"#), "expiresAt"),
      (#"{"value":"ek_test_yyyyyyyyyyyyyyyyyyyyyyyy","expiresAt":"2026-11-10T12:01:00.000Z"}"#, "model"),
      (#"{"value":"ek_test_yyyyyyyyyyyyyyyyyyyyyyyy","expiresAt":"2026-"#, "spoza kontraktu"),
      (#"["ek_test_yyyyyyyyyyyyyyyyyyyyyyyy"]"#, "spoza kontraktu"),
    ]
    for (broken, named) in cases {
      let harness = MockHarness { _ in .json(200, broken) }
      do {
        _ = try await harness.client.companionToken()
        Issue.record("odpowiedź powinna rzucić: \(named)")
      } catch {
        guard case let .invalidResponse(message) = error else {
          Issue.record("zły błąd: \(error)")
          continue
        }
        #expect(message.contains(named), "komunikat: \(message)")
        for text in [message, String(describing: error), String(reflecting: error)] {
          #expect(!text.contains(secret), "klucz w błędzie: \(text)")
        }
      }
    }
  }

  @Test("POST /api/sessions/<id>/companion/ask: pytanie i identyfikator w ciele, odpowiedź, limit 75 s")
  func ask() async throws {
    let harness = MockHarness { _ in
      .json(200, #"{"answer":"The session does not say.","found":false,"prompt":"Check the deploy key."}"#)
    }
    let answer = try await harness.client.companionAsk(
      sessionId: "w0:d4", CompanionAskBody(question: "Which key?", clientRequestId: "req-1"))
    #expect(answer.answer == "The session does not say." && !answer.found && answer.prompt == "Check the deploy key.")
    let request = try #require(harness.requests.first)
    #expect(request.method == "POST" && request.path == "/api/sessions/w0%3Ad4/companion/ask")
    let body = try #require(request.body)
    let object = try JSONSerialization.jsonObject(with: body) as? [String: String]
    #expect(object == ["question": "Which key?", "clientRequestId": "req-1"])
    // Sonnet ma na Macu 60 s: domyślne 10 s ucięłoby odpowiedź.
    #expect(RarogClient.companionAskTimeout == .seconds(75))
  }

  @Test("pytanie o sesję: limit subskrypcji i zajętość jako 429 ze zdaniem, wyłączone jako 503")
  func askRefusals() async {
    let replies: [(Int, String, String)] = [
      (429, "companion-limit", #"{"error":"companion-limit","message":"The Claude limit is reached."}"#),
      (429, "companion-busy", #"{"error":"companion-busy","message":"One question at a time."}"#),
      (503, "companion-disabled", #"{"error":"companion-disabled","message":"Off."}"#),
    ]
    for (status, code, body) in replies {
      let harness = MockHarness { _ in .json(status, body) }
      do {
        _ = try await harness.client.companionAsk(
          sessionId: "s1", CompanionAskBody(question: "q", clientRequestId: "r"))
        Issue.record("\(status) powinno rzucić")
      } catch {
        switch (status, error) {
        case let (429, .rateLimited(failure)), let (503, .http(failure)): #expect(failure.code == code)
        default: Issue.record("\(status): nieoczekiwany błąd \(error)")
        }
      }
    }
  }

  @Test("bramka zgodności odmawia, zanim cokolwiek wyjdzie")
  func gate() async {
    let harness = MockHarness(policy: IncompatiblePolicy()) { _ in .json(200, tokenJSON) }
    do {
      _ = try await harness.client.companionToken()
      Issue.record("bramka powinna odmówić")
    } catch {
      guard case let .refused(refusal) = error else {
        Issue.record("zły błąd: \(error)")
        return
      }
      #expect(refusal.message == "Apka jest za stara.")
    }
    #expect(harness.requests.isEmpty)
  }

  // MARK: Soniox speech key

  /// Synthetic Soniox key: the tests never know a real one.
  private static let speechSecret = "temp:test-zzzzzzzzzzzzzzzzzzzzzzzz"
  private static let speechJSON =
    #"{"apiKey":"temp:test-zzzzzzzzzzzzzzzzzzzzzzzz","expiresAt":"2026-11-11T12:10:00.000Z","#
    + #""webSocketUri":"wss://tts-rt.eu.soniox.com/tts-websocket","model":"tts-rt-v2","voice":"Maya","#
    + #""sampleRate":24000}"#

  @Test("POST /api/companion/speech-token: empty body, Origin, key, address, voice and rate from the reply")
  func speechMint() async throws {
    let harness = MockHarness { _ in .json(200, Self.speechJSON) }
    let token = try await harness.client.companionSpeechToken()
    #expect(token.apiKey == Self.speechSecret && token.voice == "Maya" && token.sampleRate == 24000)
    #expect(token.webSocketUri == "wss://tts-rt.eu.soniox.com/tts-websocket" && token.model == "tts-rt-v2")
    let request = try #require(harness.requests.first)
    #expect(request.method == "POST" && request.path == "/api/companion/speech-token")
    #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
    // The server rejects a body with fields (`strictObject({})`): voice, model and lifetimes are its own.
    #expect(request.body.map { String(decoding: $0, as: UTF8.self) } == "{}")
  }

  @Test("speech key refusals: 404, 503 and 502 as `.http`, 429 as `.rateLimited`, each with the server's sentence")
  func speechRefusals() async {
    let replies: [(Int, String)] = [
      (503, #"{"error":"companion-speech-unconfigured","message":"No Soniox key on the server."}"#),
      (404, #"{"error":"not-found","message":"That endpoint doesn't exist."}"#),
      (429, #"{"error":"companion-speech-throttled","message":"Too soon."}"#),
      (502, #"{"error":"companion-speech-upstream","message":"Soniox didn't give the voice agent a key."}"#),
    ]
    for (status, body) in replies {
      let harness = MockHarness { _ in .json(status, body) }
      do {
        _ = try await harness.client.companionSpeechToken()
        Issue.record("\(status) should throw")
      } catch {
        switch (status, error) {
        case let (429, .rateLimited(failure)): #expect(failure.message != nil)
        case let (_, .http(failure)): #expect(failure.status == status && failure.message != nil)
        default: Issue.record("\(status): unexpected error \(error)")
        }
      }
    }
  }

  @Test("speech key reply outside the contract: the error names the field and never quotes the key")
  func speechMalformed() async {
    let cases: [(String, String)] = [
      (Self.speechJSON.replacing(#""voice":"Maya""#, with: #""voice":"""#), "voice"),
      (Self.speechJSON.replacing(#""sampleRate":24000"#, with: #""sampleRate":"24000""#), "sampleRate"),
      (#"{"apiKey":"temp:test-zzzzzzzzzzzzzzzzzzzzzzzz","expiresAt":"2026-11-11T12:10:00.000Z"}"#, "webSocketUri"),
      (#"{"apiKey":"temp:test-zzzzzzzzzzzzzzzzzzzzzzzz","expiresAt":"2026-"#, "spoza kontraktu"),
    ]
    for (broken, named) in cases {
      let harness = MockHarness { _ in .json(200, broken) }
      do {
        _ = try await harness.client.companionSpeechToken()
        Issue.record("the reply should throw: \(named)")
      } catch {
        guard case let .invalidResponse(message) = error else {
          Issue.record("wrong error: \(error)")
          continue
        }
        #expect(message.contains(named), "message: \(message)")
        for text in [message, String(describing: error), String(reflecting: error)] {
          #expect(!text.contains(Self.speechSecret), "key in the error: \(text)")
        }
      }
    }
  }

  @Test("speech key: the compatibility gate refuses before anything goes out")
  func speechGate() async {
    let harness = MockHarness(policy: IncompatiblePolicy()) { _ in .json(200, Self.speechJSON) }
    do {
      _ = try await harness.client.companionSpeechToken()
      Issue.record("the gate should refuse")
    } catch {
      guard case .refused = error else {
        Issue.record("wrong error: \(error)")
        return
      }
    }
    #expect(harness.requests.isEmpty)
  }
}
