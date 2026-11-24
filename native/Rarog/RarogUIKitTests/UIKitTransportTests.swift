import Foundation
import RarogContract
import RarogTransport
import Synchronization
import XCTest

// The shared test transport of the UIKit target (`UIKitTransport.swift`): the behaviours the test files rely on.

final class UIKitTransportTests: XCTestCase {
  /// Closes wait in the hold, each until its own release; `releaseAll` lets the rest go.
  func testCloseWaitsUntilReleased() async throws {
    let hold = CloseHold()
    let transport = UIKitTransport.holdingCloses(hold)
    let first = Task { try await transport.closeSession(sessionId: "a", CloseSessionBody()) }
    let second = Task { try await transport.closeSession(sessionId: "b", CloseSessionBody()) }
    let both = await waitUntil { await hold.requested.sorted() == ["a", "b"] }
    XCTAssertTrue(both, "both closes reach the transport")
    await hold.release("b")
    try await second.value
    let firstDone = Mutex(false)
    let watcher = Task {
      try await first.value
      firstDone.withLock { $0 = true }
    }
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertFalse(firstDone.withLock { $0 }, "a waits until its own release")
    await hold.releaseAll()
    try await watcher.value
    XCTAssertTrue(firstDone.withLock { $0 })
  }

  /// A held read waits until the release, which `reached` always precedes; a read after the release returns at once.
  func testReadWaitsUntilReleased() async throws {
    let reached = expectation(description: "the read waits")
    let hold = ReadHold { reached.fulfill() }
    let done = Mutex(false)
    let read = Task {
      await hold.pause()
      done.withLock { $0 = true }
    }
    await fulfillment(of: [reached], timeout: 3)
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertFalse(done.withLock { $0 }, "the read waits until the release")
    await hold.release()
    await read.value
    XCTAssertTrue(done.withLock { $0 })
    await hold.pause()
  }

  /// `voiceToken()` answers from the queue in order, then `otherwise`; a script without `otherwise` falls back to the
  /// result from `init`. Every call counts.
  func testVoiceTokenResultsInOrder() async throws {
    let refusal = TransportError.http(APIFailure(status: 403))
    let offline = TransportError.offline(.notConnectedToInternet)
    let script = VoiceTokenScript(otherwise: .success(token))
    let transport = UIKitTransport.scriptedVoiceTokens(script)
    script.script([.success(token), .failure(refusal)], otherwise: .failure(offline))
    let first = try await transport.voiceToken()
    XCTAssertEqual(first, token)
    await assertThrows(refusal) { () throws(TransportError) in _ = try await transport.voiceToken() }
    await assertThrows(offline) { () throws(TransportError) in _ = try await transport.voiceToken() }
    await assertThrows(offline) { () throws(TransportError) in _ = try await transport.voiceToken() }
    XCTAssertEqual(script.mints, 4)
    script.script([.failure(refusal)])
    await assertThrows(refusal) { () throws(TransportError) in _ = try await transport.voiceToken() }
    let fallback = try await transport.voiceToken()
    XCTAssertEqual(fallback, token, "back to the result from init")
    XCTAssertEqual(script.mints, 6)
  }

  /// A route the test did not give refuses with its name, also a route that another test gives; presence and the
  /// client log go through.
  func testUnexpectedCallsRefused() async throws {
    let transport = UIKitTransport()
    await assertThrows(UIKitTransport.refusal("version()")) { () throws(TransportError) in
      _ = try await transport.version()
    }
    await assertThrows(UIKitTransport.refusal("closeSession(sessionId:_:)")) { () throws(TransportError) in
      try await transport.closeSession(sessionId: "a", CloseSessionBody())
    }
    await assertThrows(UIKitTransport.refusal("voiceToken()")) { () throws(TransportError) in
      _ = try await transport.voiceToken()
    }
    await assertThrows(UIKitTransport.refusal("commands(sessionId:)")) { () throws(TransportError) in
      _ = try await transport.commands(sessionId: "s1")
    }
    await assertThrows(UIKitTransport.refusal("companionSessions()")) { () throws(TransportError) in
      _ = try await transport.companionSessions()
    }
    try await transport.presence(PresenceBody(clientId: "c1", visible: true))
    XCTAssertTrue(transport.hasCredential)
  }

  // MARK: - Helpers

  private let token: VoiceToken = {
    let json = #"""
      {"apiKey":"snx_temp_test_a","expiresAt":"2026-08-23T12:00:00.000Z",
       "webSocketUri":"wss://stt-rt.eu.soniox.com/transcribe-websocket","model":"stt-rt-v6","maxSessionSeconds":900,
       "config":{"languageHints":["pl","en"],"audioFormat":"pcm_s16le","sampleRate":16000,"numChannels":1}}
      """#
    // swiftlint:disable:next force_try
    return try! JSONDecoder().decode(VoiceToken.self, from: Data(json.utf8))
  }()

  private func assertThrows(
    _ expected: TransportError, file: StaticString = #filePath, line: UInt = #line,
    _ call: () async throws(TransportError) -> Void
  ) async {
    do {
      try await call()
      XCTFail("expected \(expected)", file: file, line: line)
    } catch {
      XCTAssertEqual(error, expected, file: file, line: line)
    }
  }

  private func waitUntil(_ condition: () async -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + .seconds(3)
    while !(await condition()) {
      if ContinuousClock.now > deadline { return false }
      try? await Task.sleep(for: .milliseconds(5))
    }
    return true
  }
}
