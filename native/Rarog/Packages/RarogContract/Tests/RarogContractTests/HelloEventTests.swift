import Foundation
import RarogContract
import RarogContractFixtures
import Testing

// `hello.heartbeatMs` decodes any positive integer; only `validHeartbeatMs` applies the range the app trusts, so a
// server with another ping interval never rejects `hello` (and with it the compatibility check).
@Suite("hello: heartbeat interval")
struct HelloEventTests {
  @Test(
    "validHeartbeatMs: inside 1000...60000 the value, outside it or absent nil",
    arguments: [
      (Int?.none, Int?.none), (999, nil), (1000, 1000), (10000, 10000), (60000, 60000), (60001, nil), (90000, nil),
    ])
  func validHeartbeat(wire: Int?, expected: Int?) throws {
    let hello = try decodeHello(heartbeatMs: wire)
    #expect(hello.heartbeatMs == wire)
    #expect(hello.validHeartbeatMs == expected)
  }

  @Test("heartbeatRange mirrors HELLO_HEARTBEAT_MS in shared/src/protocol.ts")
  func rangeMirrorsServer() throws {
    let file = try GoldenFrames.repoRoot().appending(path: "shared/src/protocol.ts")
    let source = try String(contentsOf: file, encoding: .utf8)
    let pattern = try Regex("export const HELLO_HEARTBEAT_MS = \\{ min: ([0-9_]+), max: ([0-9_]+) \\} as const;")
    let match = try #require(source.firstMatch(of: pattern), "HELLO_HEARTBEAT_MS missing in shared/src/protocol.ts")
    let bound = { (index: Int) -> Int? in match.output[index].substring.flatMap { Int($0.replacing("_", with: "")) } }
    #expect(bound(1) == HelloEvent.heartbeatRange.lowerBound)
    #expect(bound(2) == HelloEvent.heartbeatRange.upperBound)
  }

  private func decodeHello(heartbeatMs: Int?) throws -> HelloEvent {
    let field = heartbeatMs.map { ", \"heartbeatMs\": \($0)" } ?? ""
    let json = "{\"type\": \"hello\", \"protocolVersion\": 3, \"serverStartId\": \"s\"\(field)}"
    let decoded = try EventDecoder.decode(Data(json.utf8)).get()
    guard case let .hello(hello) = decoded.event else { throw HelloTestError() }
    return hello
  }
}

private struct HelloTestError: Error {}
