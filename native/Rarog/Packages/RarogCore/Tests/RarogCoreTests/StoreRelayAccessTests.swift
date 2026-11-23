import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// The app's status in the iroh relay registry in the store (`RarogStore+RelayAccess`): the app passes the registry
// client's statuses on, and "Remove me from the registry" calls the client's `forget` once.

/// Calls of the fake registry client's `forget`, counted on the main actor.
@MainActor
private final class ForgetCalls {
  var count = 0
}

@MainActor
@Suite("store: relay registry status and removal")
struct StoreRelayAccessTests {
  private static let appId = String(repeating: "ab", count: 32)

  @Test("relayAccessChanged(s) → state.relayAccess == s for every status; start without a key leaves it")
  func statusFollowsClient() async {
    let server = FakeServer()
    let store = server.store()
    #expect(store.state.relayAccess == .inactive)
    let statuses: [RelayAccessStatus] = [
      .working,
      .registered(appId: Self.appId, until: Date(timeIntervalSince1970: 1_800_000_000)),
      .unsupported(appId: Self.appId),
      .optedOut(appId: Self.appId, removal: .pending),
      .problem(.unreachable, appId: Self.appId, retryAt: Date(timeIntervalSince1970: 1_800_000_060)),
      .problem(.storage, appId: Self.appId, retryAt: nil),
      .inactive,
    ]
    for status in statuses {
      store.relayAccessChanged(status)
      #expect(store.state.relayAccess == status)
    }
    // The status belongs to the device: the logout-like start without a key (`resetView`) keeps it.
    let registered = RelayAccessStatus.registered(appId: Self.appId, until: Date(timeIntervalSince1970: 1_800_000_000))
    store.relayAccessChanged(registered)
    await store.start()
    #expect(store.state.auth == .loggedOut(.notLoggedIn))
    #expect(store.state.relayAccess == registered)
    // The connector's closures hold the fake server unowned.
    withExtendedLifetime(server) {}
  }

  @Test("forgetRelayRegistration() calls relayForget once and keeps its status; two quick calls = one relayForget")
  func forgetOnce() async {
    let server = FakeServer()
    let store = server.store()
    let calls = ForgetCalls()
    let hold = Hold()
    let removed = RelayAccessStatus.optedOut(appId: Self.appId, removal: .confirmed)
    store.serverRuntime.connector?.relayForget = {
      calls.count += 1
      await hold.wait()
      return removed
    }
    let first = Task { await store.forgetRelayRegistration() }
    await until("relayForget in flight") { calls.count == 1 }
    // The second tap while the first is in flight returns at once, without a call.
    await store.forgetRelayRegistration()
    #expect(calls.count == 1)
    hold.release()
    await first.value
    #expect(calls.count == 1)
    #expect(store.state.relayAccess == removed)
    // After the first one ends, the next tap calls again.
    await store.forgetRelayRegistration()
    #expect(calls.count == 2)
    withExtendedLifetime(server) {}
  }

  @Test("a status from the client's stream during the removal is newer than the removal's answer and stays")
  func streamStatusDuringForgetWins() async {
    let server = FakeServer()
    let store = server.store()
    let removed = RelayAccessStatus.optedOut(appId: Self.appId, removal: .confirmed)
    store.serverRuntime.connector?.relayForget = {
      // The client reports the removal and then the empty server list queued behind it before `forget` returns here.
      store.relayAccessChanged(removed)
      store.relayAccessChanged(.inactive)
      return removed
    }
    await store.forgetRelayRegistration()
    #expect(store.state.relayAccess == .inactive)
    withExtendedLifetime(server) {}
  }
}
