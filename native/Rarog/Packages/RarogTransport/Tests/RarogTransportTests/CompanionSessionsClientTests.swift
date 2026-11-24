import Foundation
import RarogContract
import RarogContractFixtures
import RarogTransport
import Testing

// The voice agent's mode across sessions on the `URLProtocol` fake: the session catalog, the last turns of one
// session and the pick-up of a result. Headers and the 4xx shapes common to all routes stand in `RarogClientTests`.

@Suite("REST client: the voice agent's session catalog, turns and pick-up")
struct CompanionSessionsClientTests {
  /// `export const <name> = <number>;` from `shared/src/rest.ts`.
  private static func restConstant(_ name: String) throws -> Int {
    let file = try GoldenFrames.repoRoot().appending(path: "shared/src/rest.ts")
    let source = String(decoding: try Data(contentsOf: file), as: UTF8.self)
    let pattern = try Regex("export const \(name) = ([0-9]+);")
    let match = try #require(source.firstMatch(of: pattern), "no \(name) in shared/src/rest.ts")
    let digits = match.output[1].substring.map(String.init) ?? ""
    return try #require(Int(digits), "\(name) is not a number")
  }

  @Test("GET /api/companion/sessions decodes the golden answer; a read without Origin")
  func catalog() async throws {
    let golden = try goldenRest("companion.sessions.json")
    let harness = MockHarness { _ in .json(200, golden) }
    let catalog = try await harness.client.companionSessions()
    #expect(catalog.sessions.map(\.id) == ["s1", "s2"])
    #expect(catalog.sessions.map(\.asksOwner) == [true, false])
    #expect(catalog.sessions.first?.conversation == "Tjo8_3WvcQtfOj3emIfRG3")
    let request = try #require(harness.requests.first)
    #expect(request.method == "GET" && request.path == "/api/companion/sessions")
    #expect(request.header("Origin") == nil)
  }

  @Test("GET …/companion/turns?count=N decodes the golden answer whole; the session id is one encoded segment")
  func turns() async throws {
    let golden = try goldenRest("companion.turns.json")
    let expected = try JSONDecoder().decode(CompanionTurns.self, from: Data(golden.utf8))
    let harness = MockHarness { _ in .json(200, golden) }
    let turns = try await harness.client.companionTurns(sessionId: "w0:d4", count: 3)
    #expect(turns.conversation == expected.conversation && turns.readMark == expected.readMark)
    #expect(turns.stateSince == expected.stateSince && turns.complete == expected.complete)
    #expect(turns.messages.map(\.seq) == expected.messages.map(\.seq))
    #expect(!turns.messages.isEmpty)
    let request = try #require(harness.requests.first)
    #expect(request.method == "GET" && request.path == "/api/sessions/w0%3Ad4/companion/turns?count=3")
    #expect(request.header("Origin") == nil)
  }

  @Test("turns: a server sentence in a message goes through the client's renderer, agent text does not")
  func turnsTranslated() async throws {
    let golden = try goldenRest("companion.turns.json")
    let harness = MockHarness(renderer: { text, ref in ref.map { "<\($0.code)>" } ?? text }) { _ in
      .json(200, golden)
    }
    let turns = try await harness.client.companionTurns(sessionId: "s1", count: 1)
    let texts = turns.messages.flatMap(\.blocks).compactMap { block -> (String, SentenceRef?)? in
      guard case let .text(text, ref) = block else { return nil }
      return (text, ref)
    }
    let withRef = texts.filter { $0.1 != nil }
    #expect(!withRef.isEmpty, "the golden answer carries a server sentence")
    #expect(withRef.allSatisfy { $0.0 == "<\($0.1?.code ?? "")>" })
    #expect(texts.contains { $0.1 == nil && $0.0 == "prompt 1" })
  }

  @Test("count outside 1…COMPANION_TURNS_MAX is refused before any request; the limit mirrors the server's")
  func countLimit() async throws {
    #expect(RarogClient.companionTurnsMax == (try Self.restConstant("COMPANION_TURNS_MAX")))
    let golden = try goldenRest("companion.turns.json")
    let harness = MockHarness { _ in .json(200, golden) }
    for count in [0, RarogClient.companionTurnsMax + 1, -1] {
      do {
        _ = try await harness.client.companionTurns(sessionId: "s1", count: count)
        Issue.record("count \(count) should be refused")
      } catch {
        guard case .invalidResponse = error else {
          Issue.record("count \(count): wrong error \(error)")
          continue
        }
      }
    }
    #expect(harness.requests.isEmpty)
    for count in 1...RarogClient.companionTurnsMax {
      _ = try await harness.client.companionTurns(sessionId: "s1", count: count)
    }
    #expect(harness.requests.map(\.path) == (1...RarogClient.companionTurnsMax).map {
      "/api/sessions/s1/companion/turns?count=\($0)"
    })
  }

  @Test("POST …/seen with the pick-up: segment in the path, Origin, the body carries by, conversation and readMark")
  func pickUp() async throws {
    let harness = MockHarness { _ in .json(200, #"{"ok":true}"#) }
    let pickUp = SeenPickUp(by: .voiceAgent, conversation: "c0nversat10nT0ken-abcd", readMark: "m3moryN4me.42")
    try await harness.client.pickUpResult(sessionId: "s 1", pickUp)
    let request = try #require(harness.requests.first)
    #expect(request.method == "POST" && request.path == "/api/sessions/s%201/seen")
    #expect(request.header("Origin") != nil)
    let body = try JSONSerialization.jsonObject(with: try #require(request.body)) as? [String: String]
    #expect(body == ["by": "voice-agent", "conversation": "c0nversat10nT0ken-abcd", "readMark": "m3moryN4me.42"])
  }

  @Test("pick-up 409 comes as `.http` with the server's code")
  func pickUpChanged() async {
    let harness = MockHarness { _ in .json(409, #"{"error":"bad-state","message":"The result changed."}"#) }
    let pickUp = SeenPickUp(by: .voiceAgent, conversation: "c", readMark: "m")
    do {
      try await harness.client.pickUpResult(sessionId: "s1", pickUp)
      Issue.record("409 should throw")
    } catch {
      #expect(error == .http(APIFailure(status: 409, code: "bad-state", message: "The result changed.")))
    }
  }

  @Test("404 and both 503 codes come as `.http` with the server's code and sentence, on both routes")
  func refusals() async {
    let replies: [(Int, String, String)] = [
      (404, "not-found", #"{"error":"not-found","message":"That endpoint doesn't exist."}"#),
      (503, "companion-disabled", #"{"error":"companion-disabled","message":"Off."}"#),
      (503, "companion-sessions-disabled", #"{"error":"companion-sessions-disabled","message":"Mode off."}"#),
    ]
    for (status, code, body) in replies {
      let harness = MockHarness { _ in .json(status, body) }
      do {
        _ = try await harness.client.companionSessions()
        Issue.record("catalog \(status) should throw")
      } catch {
        guard case let .http(failure) = error else {
          Issue.record("catalog \(status): unexpected error \(error)")
          continue
        }
        #expect(failure.status == status && failure.code == code && failure.message != nil)
      }
      do {
        _ = try await harness.client.companionTurns(sessionId: "s1", count: 2)
        Issue.record("turns \(status) should throw")
      } catch {
        guard case let .http(failure) = error else {
          Issue.record("turns \(status): unexpected error \(error)")
          continue
        }
        #expect(failure.status == status && failure.code == code && failure.message != nil)
      }
    }
  }

  @Test("an answer outside the contract is `.invalidResponse`")
  func malformed() async {
    let cases: [(String, String)] = [
      (#"{"sessions":[{"id":"s1","asksOwner":false,"conversation":"c","stateSince":""}]}"#, "catalog"),
      (#"{"messages":[],"conversation":"c","stateSince":"","complete":true}"#, "turns"),
    ]
    for (body, route) in cases {
      let harness = MockHarness { _ in .json(200, body) }
      do {
        if route == "catalog" {
          _ = try await harness.client.companionSessions()
        } else {
          _ = try await harness.client.companionTurns(sessionId: "s1", count: 1)
        }
        Issue.record("\(route) should throw")
      } catch {
        guard case .invalidResponse = error else {
          Issue.record("\(route): wrong error \(error)")
          continue
        }
      }
    }
  }
}
