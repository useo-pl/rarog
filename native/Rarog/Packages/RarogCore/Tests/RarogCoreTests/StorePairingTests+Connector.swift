import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Złącze serwera po zmianie celu parowania: `pairing` dostaje `PairingTarget` z linku, odpięcie
// poprzedniego klucza idzie przez `forgetTransport`, a przełączenie punktu końcowego kończy poprzednią tożsamość
// jednym `release`. Domyślne wartości nowych pól zachowują dzisiejsze zachowanie.

extension StorePairingTests {
  /// Magazyn z kluczem ``PairingFixtures/credential()`` z Keychaina, po starcie.
  private func pairedStore(_ server: FakeServer) async -> RarogStore {
    _ = try? server.keychain.save(PairingFixtures.credential(), pushKey: "BQUF")
    let store = server.store()
    await store.start()
    return store
  }

  @Test("cel parowania: link z adresem idzie jako .https(adres), jak dotąd pairing(adres)")
  func pairingTargetIsHTTPS() async {
    let server = FakeServer()
    let store = server.store()
    await store.start()
    let link = PairingFixtures.link(server: URL(string: "https://inny.example")!)
    store.offerPairing(link)
    #expect(await store.confirmPairing() == .paired)
    #expect(server.pairingTargets == [.https(link.server)])
    #expect(server.pairing.read { $0.pairBodies } == [PairBody(code: link.code, label: "iPhone·Rarog", build: 7)])
  }

  @Test("inny serwer: odpięcie starego klucza przez forgetTransport, release poprzedniego punktu końcowego raz")
  func otherServerForgetsAndReleases() async {
    let server = FakeServer()
    let store = await pairedStore(server)
    let previous = ServerEndpoint.device(PairingFixtures.credential())
    server.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", serverId: "inny"))
    }
    store.offerPairing(PairingFixtures.link(server: URL(string: "https://inny.example")!))
    #expect(await store.confirmPairing(replacing: true) == .paired)
    #expect(server.released == [previous])
    #expect(server.forgotten.map(\.endpoint) == [previous])
    let forgetting = server.forgotten.first?.transport
    await until("forget poprzedniego klucza") { forgetting?.read { $0.forgetCalls } == 1 }
    #expect(server.released == [previous], "release tylko raz")
  }

  @Test("ten sam klucz ponownie: bez forgetTransport, release poprzedniego punktu końcowego raz")
  func sameDeviceReleasesOnly() async {
    let server = FakeServer()
    let store = await pairedStore(server)
    store.offerPairing(PairingFixtures.link())
    #expect(await store.confirmPairing() == .paired)
    #expect(server.released == [.device(PairingFixtures.credential())])
    #expect(server.forgotten.isEmpty)
  }

  @Test("odmowa parowania: bez release i bez forgetTransport")
  func refusalReleasesNothing() async {
    let server = FakeServer()
    let store = await pairedStore(server)
    server.pairing.set { $0.pairResult = .failure(.http(APIFailure(status: 404, code: "pair-unknown"))) }
    store.offerPairing(PairingFixtures.link())
    #expect(await store.confirmPairing() == .failed(.codeRejected))
    #expect(server.released.isEmpty && server.forgotten.isEmpty)
  }

  @Test("wartości domyślne: forgetTransport = transport, release nic nie robi")
  func connectorDefaults() {
    let built = Built()
    let connector = ServerConnector(
      keychain: MemoryKeychain(), label: "iPhone·Rarog", build: 7,
      transport: { endpoint, rules in
        built.endpoints.append(endpoint)
        return FakeTransport(credential: false)
      },
      pairing: { _ in FakeTransport(credential: false) })
    let endpoint = ServerEndpoint.device(PairingFixtures.credential())
    _ = connector.forgetTransport(endpoint, MutationRules(timing: fastTiming))
    connector.release(endpoint)
    #expect(built.endpoints == [endpoint])
  }
}

/// Punkty końcowe, dla których złącze zbudowało transport.
@MainActor
private final class Built {
  var endpoints: [ServerEndpoint] = []
}
