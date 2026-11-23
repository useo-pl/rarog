import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Closing the pairing code screen revokes the code on the server: the screen
// clears at once, the store tries `DELETE /api/pairings` once and ignores every error (an old server answers 405).
// Code operations (issue, cancel) run one after another, so a cancel never overtakes the POST it cancels and a late
// cancel never removes a newer code.

extension StorePairingTests {
  /// A paired, logged-in store and its transport.
  private func codeStore() async throws -> (RarogStore, FakeServer, FakeTransport) {
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF")))
    let store = server.store()
    await store.start()
    let device = try #require(server.current)
    await until("stream of the paired transport") { !device.streamCalls.isEmpty }
    device.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    device.push(.global, json: #"{"type":"sessions-snapshot","sessions":[]}"#)
    await until("logged in") { store.state.auth == .loggedIn && store.state.compat == .ok }
    return (store, server, device)
  }

  private func issued(_ store: RarogStore) async -> IssuedPairingCode? {
    await until("code on screen") { if case .issued = store.state.pairing.issue { true } else { false } }
    if case let .issued(code) = store.state.pairing.issue { return code }
    return nil
  }

  /// Waits until every queued code operation has finished.
  private func codeOperationsDone(_ store: RarogStore) async {
    await store.serverRuntime.codeOperations?.value
  }

  @Test("clearPairingCode: the screen is clear at once, the cancel goes out once")
  func clearCancelsOnce() async throws {
    let (store, server, device) = try await codeStore()
    defer { withExtendedLifetime(server) {} }
    store.issuePairingCode()
    _ = await issued(store)
    let hold = Hold()
    device.set { $0.onCancelCode = { await hold.wait() } }

    store.clearPairingCode()
    #expect(store.state.pairing.issue == .idle, "the code leaves the screen before the server answers")
    await until("cancel sent") { device.read { $0.cancelCodeCalls } == 1 }
    hold.release()
    await codeOperationsDone(store)
    #expect(device.read { $0.cancelCodeCalls } == 1)
    #expect(device.read { $0.codeLog } == ["POST", "POST done", "DELETE", "DELETE done"])
    #expect(store.state.pairing.issue == .idle)
  }

  @Test("405 from an old server, no network and iroh without a session: no error on screen")
  func cancelErrorsIgnored() async throws {
    let failures: [TransportError] = [
      .http(APIFailure(status: 405)), .offline(.notConnectedToInternet), SwitchingTransport.noGeneration,
    ]
    for failure in failures {
      let (store, server, device) = try await codeStore()
      defer { withExtendedLifetime(server) {} }
      device.set { $0.cancelCodeResult = failure }
      store.issuePairingCode()
      _ = await issued(store)
      store.clearPairingCode()
      let cleared = store.state
      await codeOperationsDone(store)
      #expect(device.read { $0.cancelCodeCalls } == 1, "\(failure)")
      #expect(store.state.pairing == cleared.pairing, "\(failure)")
      #expect(store.state.pairing.issue == .idle, "\(failure)")
      #expect(store.state.notices.isEmpty && store.state.auth == .loggedIn, "\(failure)")
    }
  }

  @Test("screen closed while the code is issuing: the cancel goes out only after the POST answer")
  func closeWhileIssuing() async throws {
    let (store, server, device) = try await codeStore()
    defer { withExtendedLifetime(server) {} }
    let hold = Hold()
    device.set { $0.onIssue = { await hold.wait() } }
    store.issuePairingCode()
    await until("POST sent") { device.read { $0.issueCalls } == 1 }
    #expect(store.state.pairing.issue == .issuing)

    store.clearPairingCode()
    #expect(store.state.pairing.issue == .idle)
    try await Task.sleep(for: .milliseconds(50))
    #expect(device.read { $0.codeLog } == ["POST"], "no DELETE before the POST answer")
    hold.release()
    await codeOperationsDone(store)
    #expect(device.read { $0.codeLog } == ["POST", "POST done", "DELETE", "DELETE done"])
    #expect(store.state.pairing.issue == .idle, "the late POST answer does not bring the code back")
  }

  @Test("a new code while the cancel is late: the POST waits for the cancel, the newer code stays")
  func newCodeWaitsForLateCancel() async throws {
    let (store, server, device) = try await codeStore()
    defer { withExtendedLifetime(server) {} }
    store.issuePairingCode()
    _ = await issued(store)
    let hold = Hold()
    device.set { $0.onCancelCode = { await hold.wait() } }
    store.clearPairingCode()
    await until("cancel sent") { device.read { $0.cancelCodeCalls } == 1 }

    device.set { $0.issueResult = .success(PairingFixtures.issued(expiresAt: "2026-10-04T10:09:00.000Z")) }
    store.issuePairingCode()
    #expect(store.state.pairing.issue == .issuing)
    try await Task.sleep(for: .milliseconds(50))
    #expect(device.read { $0.codeLog } == ["POST", "POST done", "DELETE"], "the new POST waits for the cancel")
    hold.release()
    let code = await issued(store)
    await codeOperationsDone(store)
    #expect(device.read { $0.codeLog } == ["POST", "POST done", "DELETE", "DELETE done", "POST", "POST done"])
    #expect(code?.expiresAt == Date(timeIntervalSince1970: 1_791_108_540))
    #expect(device.read { $0.cancelCodeCalls } == 1)
    if case .issued = store.state.pairing.issue {} else { Issue.record("the newer code left the screen") }
  }

  @Test("a late cancel, a 401 and a retry with the same key: the new code still waits for the cancel")
  func retryWithSameKeyKeepsOrder() async throws {
    let (store, server, device) = try await codeStore()
    store.issuePairingCode()
    _ = await issued(store)
    let hold = Hold()
    device.set { $0.onCancelCode = { await hold.wait() } }
    store.clearPairingCode()
    await until("cancel sent") { device.read { $0.cancelCodeCalls } == 1 }

    // The server does not know the key for a moment; the key stays, and the retry logs in with it again.
    device.set { $0.rejection = .unknown(deviceId: "03030303030303030303030303030303") }
    device.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-unknown")))
    await until("logged out, key kept") { store.state.auth == .loggedOut(.deviceUnknown) }
    store.retryDeviceKey()
    let fresh = try #require(server.current)
    #expect(fresh !== device)
    await until("stream of the fresh transport") { !fresh.streamCalls.isEmpty }
    fresh.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    fresh.push(.global, json: #"{"type":"sessions-snapshot","sessions":[]}"#)
    await until("logged in again") { store.state.auth == .loggedIn && store.state.compat == .ok }

    // The late cancel carries the same key, so it would revoke a code issued before it lands.
    store.issuePairingCode()
    try await Task.sleep(for: .milliseconds(50))
    #expect(fresh.read { $0.issueCalls } == 0, "the new POST waits for the cancel of the same key")
    hold.release()
    await until("POST after the cancel") { fresh.read { $0.issueCalls } == 1 }
    await codeOperationsDone(store)
    #expect(device.read { $0.codeLog }.suffix(2) == ["DELETE", "DELETE done"])
  }
}
