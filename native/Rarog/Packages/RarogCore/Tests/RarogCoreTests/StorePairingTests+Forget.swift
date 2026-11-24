import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Forget Server waits one tunnel attempt for the server's answer: an iroh tunnel that is still connecting
// after a return from the background answers within `TunnelMachine.attemptBudget`, not within 4 s. Time runs on the
// virtual clock of the test: both the limit and the server's answer sleep on it.

extension StorePairingTests {
  /// A paired store whose Forget limit sleeps on `clock`, and its current transport.
  private func forgetStore(on clock: VirtualClock) async throws -> (RarogStore, FakeServer, FakeTransport) {
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF")))
    let store = server.store()
    store.serverRuntime.forgetSleep = { await clock.sleep($0) }
    await store.start()
    return (store, server, try #require(server.current))
  }

  @Test("Forget Server: an answer after 8 s still revokes the device, then the key goes")
  func forgetWaitsForSlowAnswer() async throws {
    let clock = VirtualClock()
    let (store, server, device) = try await forgetStore(on: clock)
    let answered = Box()
    device.set {
      $0.onForget = {
        await clock.sleep(.seconds(8))
        if !Task.isCancelled { answered.set() }
      }
    }
    let forgetting = Task { await store.forgetServer() }
    await until("the answer and the limit wait on the clock") { clock.sleeping.count == 2 }
    clock.advance(by: .seconds(7))
    // A limit shorter than 7 s has cancelled the request by now (its sleep is gone).
    await until("the request either still waits or was cancelled") { clock.sleeping.count != 1 }
    clock.advance(by: .seconds(1))
    let forgotten = await forgetting.value
    #expect(answered.value, "the server's answer after 8 s came before the limit")
    #expect(forgotten)
    #expect(device.read { $0.forgetCalls } == 1)
    #expect(server.keychain.load() == .none && store.state.pairing.binding == .none)
    #expect(!store.state.pairing.forgetting)
  }

  @Test("Forget Server: no answer means the local cleanup after the limit, as before")
  func forgetCleansUpAfterLimit() async throws {
    let clock = VirtualClock()
    let (store, server, device) = try await forgetStore(on: clock)
    let answered = Box()
    device.set {
      $0.onForget = {
        await clock.sleep(.seconds(3600))
        if !Task.isCancelled { answered.set() }
      }
    }
    let forgetting = Task { await store.forgetServer() }
    await until("the answer and the limit wait on the clock") { clock.sleeping.count == 2 }
    clock.advance(by: TunnelMachine.attemptBudget - .seconds(1))
    // A shorter limit has cancelled the request by now (both sleeps gone).
    await until("the request either still waits or was cancelled") { clock.sleeping.count != 1 }
    #expect(clock.sleeping.count == 2 && store.state.pairing.forgetting, "one second before the limit Forget waits")
    clock.advance(by: .seconds(1))
    #expect(await forgetting.value)
    #expect(!answered.value)
    #expect(server.keychain.load() == .none && store.state.pairing.binding == .none)
    #expect(store.state.auth == .loggedOut(.notLoggedIn) && !store.state.pairing.forgetting)
  }

  @Test("Forget Server: the known devices and the new device notices of that server go, other servers keep theirs")
  func forgetRemovesDeviceRecords() async throws {
    let (store, server, _) = try await forgetStore(on: VirtualClock())
    let serverId = PairingFixtures.credential().serverId
    let otherId = "0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"
    for id in [serverId, otherId] {
      server.preferences.set(Data("{}".utf8), forKey: RarogStore.knownDevicesKey(id))
      server.preferences.set(Data("[]".utf8), forKey: RarogStore.deviceNoticesKey(id))
    }
    #expect(await store.forgetServer())
    #expect(server.preferences.data(forKey: RarogStore.knownDevicesKey(serverId)) == nil)
    #expect(server.preferences.data(forKey: RarogStore.deviceNoticesKey(serverId)) == nil)
    #expect(server.preferences.data(forKey: RarogStore.knownDevicesKey(otherId)) != nil)
    #expect(server.preferences.data(forKey: RarogStore.deviceNoticesKey(otherId)) != nil)
  }

  @Test("Forget Server: the production limit is one tunnel attempt (TunnelMachine.attemptBudget, 15 s)")
  func forgetLimitIsAttemptBudget() {
    #expect(ServerRuntime().forgetLimit == TunnelMachine.attemptBudget)
    #expect(TunnelMachine.attemptBudget == .seconds(15))
  }
}
