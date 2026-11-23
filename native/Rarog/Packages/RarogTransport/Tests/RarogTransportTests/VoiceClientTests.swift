import Foundation
import RarogContract
import RarogTransport
import Testing

// Klucz tymczasowy dyktowania na atrapie `URLProtocol`.

private let tokenJSON = #"""
  {"apiKey":"tmp-key-sekret","expiresAt":"2026-08-23T12:00:00.000Z",
   "webSocketUri":"wss://stt-rt.eu.soniox.com/transcribe-websocket","model":"stt-rt-v6","maxSessionSeconds":900,
   "config":{"languageHints":["pl","en"],"audioFormat":"pcm_s16le","sampleRate":16000,"numChannels":1}}
  """#

@Suite("klient REST: klucz dyktowania")
struct VoiceClientTests {
  @Test("POST /api/voice/token: puste ciało, Origin, klucz z odpowiedzi")
  func mint() async throws {
    let harness = MockHarness { _ in .json(200, tokenJSON) }
    let token = try await harness.client.voiceToken()
    #expect(token.apiKey == "tmp-key-sekret" && token.config.sampleRate == 16000)
    let request = try #require(harness.requests.first)
    #expect(request.method == "POST" && request.path == "/api/voice/token")
    #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
    // Serwer odrzuca ciało z polami (`strictObject({})`): parametry strumienia ustala on.
    #expect(request.body.map { String(decoding: $0, as: UTF8.self) } == "{}")
  }

  @Test("„wyłączone” (404, 503) i „nie teraz” (429, 502) to różne błędy ze zdaniem serwera")
  func refusals() async {
    let replies: [(Int, String)] = [
      (503, #"{"error":"voice_unconfigured","message":"Dyktowanie wyłączone — brak klucza Soniox na Macu."}"#),
      (404, #"{"error":"not-found","message":"Nie ma takiej trasy."}"#),
      (429, #"{"error":"voice_throttled","message":"Za szybko — poczekaj chwilę."}"#),
      (502, #"{"error":"voice_upstream","message":"Soniox nie odpowiedział — spróbuj za chwilę."}"#),
    ]
    for (status, body) in replies {
      let harness = MockHarness { _ in .json(status, body) }
      do {
        _ = try await harness.client.voiceToken()
        Issue.record("\(status) powinno rzucić")
      } catch {
        switch (status, error) {
        case let (429, .rateLimited(failure)): #expect(failure.message == "Za szybko — poczekaj chwilę.")
        case let (_, .http(failure)): #expect(failure.status == status && failure.message != nil)
        default: Issue.record("\(status): nieoczekiwany błąd \(error)")
        }
      }
    }
  }

  @Test("odpowiedź spoza kontraktu: błąd nazywa pole, nigdy nie cytuje klucza")
  func malformed() async {
    let broken = tokenJSON.replacing("wss://", with: "ws://")
    let harness = MockHarness { _ in .json(200, broken) }
    do {
      _ = try await harness.client.voiceToken()
      Issue.record("ws:// powinno rzucić")
    } catch {
      guard case let .invalidResponse(message) = error else {
        Issue.record("zły błąd: \(error)")
        return
      }
      #expect(message.contains("webSocketUri"))
      #expect(!message.contains("tmp-key-sekret"))
    }
  }

  @Test("bramka zgodności odmawia, zanim cokolwiek wyjdzie")
  func gate() async {
    let harness = MockHarness(policy: IncompatiblePolicy()) { _ in .json(200, tokenJSON) }
    do {
      _ = try await harness.client.voiceToken()
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
}
