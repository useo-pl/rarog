import Foundation
import RarogContract
import RarogContractFixtures
import RarogTransport
import Testing

// The queue take-back route on the `URLProtocol` stub: path, body, the server's golden answers, and the limits that
// must outlast the server's wait. Owner: send.

@Suite("REST client: queue take-back")
struct QueueTakeBackClientTests {
  /// `export const <name> = <number>;` from `server/src/drivers/herdr/queue-take-back.ts`, in milliseconds.
  private static func serverWait(_ name: String) throws -> Int {
    let file = try GoldenFrames.repoRoot().appending(path: "server/src/drivers/herdr/queue-take-back.ts")
    let source = try String(contentsOf: file, encoding: .utf8)
    let pattern = try Regex("export const \(name) = ([0-9_]+);")
    let match = try #require(source.firstMatch(of: pattern), "no \(name) in queue-take-back.ts")
    let digits = try #require(match.output[1].substring).replacing("_", with: "")
    return try #require(Int(digits))
  }

  @Test("POST …/queue/take-back: segment, Origin, operationId lowercase; golden 200 with and without clientMessageId")
  func takeBack() async throws {
    let body = try goldenRest("queue.take-back.json")
    let harness = MockHarness { _ in .json(200, body) }
    let operation = try #require(UUID(uuidString: "7E1D3C5B-2A4F-4C8E-9B6D-0F1E2D3C4B5A"))
    let reply = try await harness.client.takeBackQueue(sessionId: "w0:d4", operationId: operation)
    #expect(reply.items.map(\.text) == ["A note while the agent works.", "Typed at the Mac."])
    #expect(reply.items.map(\.clientMessageId) == ["7e1d3c5b-2a4f-4c8e-9b6d-0f1e2d3c4b5a", nil])
    #expect(!reply.incomplete)
    let request = try #require(harness.requests.first)
    #expect(request.method == "POST" && request.path == "/api/sessions/w0%3Ad4/queue/take-back")
    #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
    #expect(String(decoding: request.body ?? Data(), as: UTF8.self)
      == #"{"operationId":"7e1d3c5b-2a4f-4c8e-9b6d-0f1e2d3c4b5a"}"#)
  }

  @Test("refusal 409 carries the server's sentence; 404 stays a 404 (a server without the route)")
  func refusals() async throws {
    let refused = try goldenRest("error.take-back-refused.json")
    let harness = MockHarness { request in
      request.path.contains("old") ? .json(404, #"{"error":"not-found"}"#) : .json(409, refused)
    }
    do {
      _ = try await harness.client.takeBackQueue(sessionId: "s1", operationId: UUID())
      Issue.record("a refusal throws")
    } catch {
      guard case let .http(failure) = error else { Issue.record("wrong error: \(error)"); return }
      #expect(failure.status == 409 && failure.message?.isEmpty == false)
    }
    do {
      _ = try await harness.client.takeBackQueue(sessionId: "old", operationId: UUID())
      Issue.record("a 404 throws")
    } catch {
      guard case let .http(failure) = error else { Issue.record("wrong error: \(error)"); return }
      #expect(failure.status == 404)
    }
  }

  /// The driver waits for `popAll` and then for a half-drawn field, each up to `TAKE_BACK_POP_WAIT_MS`. A take-back
  /// limit at or below that would end a take-back that is still proving its keys, and a text send, which the server
  /// holds until a running take-back answers, would turn Not confirmed while the take-back works.
  @Test("limits outlast the server's worst take-back wait: the take-back itself and a text send held behind it")
  func limitsOutlastServerWait() throws {
    let worst = Duration.milliseconds(2 * (try Self.serverWait("TAKE_BACK_POP_WAIT_MS")))
    #expect(RarogClient.queueTakeBackTimeout > worst)
    #expect(RarogConfig.test(port: 1).requestTimeout > worst)
  }
}
