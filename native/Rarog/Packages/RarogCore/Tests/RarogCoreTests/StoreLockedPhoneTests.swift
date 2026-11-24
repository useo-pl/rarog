import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

// The store's question to the server for the locked-phone monitor (`RarogStore+LockedPhone`): one
// `GET /api/version`, no state change, nothing while signed out. Owner: voice agent.

private func versionInfo(tailnet: String) -> VersionInfo {
  let json = #"{"version":"0.1.0","protocolVersion":3,"serverStartId":"s","tailnet":"\#(tailnet)"}"#
  // swiftlint:disable:next force_try
  return try! JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
}

/// Requests that reached `GET /api/version` of the fake.
private final class VersionRequests: Sendable {
  private let value = Mutex(0)

  var count: Int { value.withLock { $0 } }
  func add() { value.withLock { $0 += 1 } }
}

/// A started store whose own version probe already ended (it failed: the fake has no answer yet). The helper runs
/// the probe itself: the usage loop may have looked for a due probe before the login stood, and then it sends none
/// for a whole interval, so waiting for the loop's request would hang.
@MainActor
private func startedStore(credential: Bool = true) async -> (RarogStore, FakeTransport, VersionRequests) {
  let calls = VersionRequests()
  let (store, transport) = makeStore(transport: FakeTransport(credential: credential))
  transport.set { $0.onVersion = { calls.add() } }
  await store.start()
  if credential {
    await until("online") { store.state.global == .online }
    await store.probeVersion(recheck: false)
    await until("the store's own version probe ended") { store.usagePolling.versionRead == nil }
  }
  return (store, transport, calls)
}

@MainActor
@Suite("store: the locked-phone monitor's question to the server")
struct StoreLockedPhoneTests {
  // Catches a question that changes the store (reusing the version probe would write the answer into the state every
  // heartbeat), or a wrong answer for a server that answers or fails.
  @Test("one request; true when the server gives its version, false when it fails; the state does not change")
  func answers() async {
    let (store, transport, calls) = await startedStore()
    let before = calls.count
    transport.set { $0.version = versionInfo(tailnet: "probe.example") }
    #expect(await store.serverAnswers())
    #expect(calls.count == before + 1, "one request")
    #expect(store.state.tailnet != "probe.example", "the answer does not reach the state")
    transport.set { $0.version = nil }
    #expect(await store.serverAnswers() == false)
  }

  // Catches a request that goes out without a login, where the transport has no device key to send.
  @Test("signed out: false without a request")
  func signedOut() async {
    let (store, transport, calls) = await startedStore(credential: false)
    #expect(store.state.auth != .loggedIn)
    transport.set { $0.version = versionInfo(tailnet: "probe.example") }
    #expect(await store.serverAnswers() == false)
    #expect(calls.count == 0)
  }

  // Catches an answer of a login that ended while the question was out, reported as the current server answering.
  @Test("an answer that comes after the login ended is false")
  func loginEnded() async {
    let (store, transport, calls) = await startedStore()
    let before = calls.count
    let valve = Valve()
    transport.set {
      $0.version = versionInfo(tailnet: "probe.example")
      $0.onVersion = {
        calls.add()
        await valve.wait()
      }
    }
    let answer = Task { await store.serverAnswers() }
    await until("the question is out") { calls.count == before + 1 }
    store.retire(.loggedOut(.deviceUnknown), unregisterPush: false)
    await valve.release()
    #expect(await answer.value == false)
  }
}
