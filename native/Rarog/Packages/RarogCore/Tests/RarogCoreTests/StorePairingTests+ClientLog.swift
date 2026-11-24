import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// A `client.log` line about server A never reaches server B. The tests read every raw line a transport got: a send to
// A still in flight during the switch to B, the unpairing line, a line of A kept unsent across a Replace at the same
// address, the same text for both servers, late tunnel lines of A, and a key changed in place by a version probe.
// A line recorded before any login goes to the server of the first login, and a line recorded while pairing with B
// goes to B.

extension StorePairingTests {
  private static let otherServer = URL(string: "https://inny.example")!

  /// The `błąd:` lines a transport got; the pairing's own trace lines are left out.
  private func logged(_ transport: FakeTransport?) -> [String] {
    (transport?.read { $0.clientLogs.flatMap(\.events).map(\.msg) } ?? []).filter { $0.hasPrefix("błąd: ") }
  }

  @Test("a client-log send held at server A: lines recorded after the switch to B reach B only, also a line equal to A's")
  func clientLogFollowsTheServer() async throws {
    let server = FakeServer()
    let (store, first) = await paired(server)
    let valve = Valve()
    first.set { $0.onClientLog = { _ in await valve.wait() } }
    store.reportUnhandled("same line")
    await until("the send to A in flight") { self.logged(first) == ["błąd: same line"] }

    server.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", serverId: "serwer-b"))
    }
    guard let target = PairingTarget(serverURL: Self.otherServer, iroh: nil) else { preconditionFailure("a link has a route") }
    store.offerPairing(PairingLink(target: target, code: PairingFixtures.code))
    #expect(await store.confirmPairing(replacing: true) == .paired)
    let second = try #require(store.areaTransport as? FakeTransport, "the transport of the new pairing")
    #expect(second !== first)
    await until("B's global stream") { !second.streamCalls.isEmpty && store.state.global == .online }

    store.reportUnhandled("same line")
    store.reportUnhandled("only B")
    await until("both lines at B while A's send still waits") {
      Set(self.logged(second)) == ["błąd: same line", "błąd: only B"]
    }
    await valve.release()
    store.reportUnhandled("after A answered")
    await until("the next line at B") { self.logged(second).contains("błąd: after A answered") }
    #expect(logged(first) == ["błąd: same line"], "A gets nothing recorded after the switch")
    #expect(logged(second).count == 3)
  }

  @Test("a line recorded before the first pairing reaches the server of that pairing")
  func clientLogBeforeLoginReachesFirstServer() async {
    let server = FakeServer()
    let store = server.store()
    await store.start()
    store.reportUnhandled("before login")
    guard let target = PairingTarget(serverURL: PairingFixtures.server, iroh: nil) else {
      preconditionFailure("a link has a route")
    }
    store.offerPairing(PairingLink(target: target, code: PairingFixtures.code))
    #expect(await store.confirmPairing() == .paired)
    await until("the line at the paired server") {
      self.logged(store.areaTransport as? FakeTransport).contains("błąd: before login")
    }
  }

  /// Every line a transport got, traces included.
  private func allLines(_ transport: FakeTransport?) -> [String] {
    transport?.read { $0.clientLogs.flatMap(\.events).map(\.msg) } ?? []
  }

  /// A store paired with server A whose device server A has just revoked (the revoked screen is up), and server B's
  /// pairing link with its reply.
  private func revokedAtA() async throws -> (FakeServer, RarogStore, PairingLink) {
    let server = FakeServer()
    let (store, first) = await paired(server)
    first.set {
      $0.rejection = .revoked(
        deviceId: "03030303030303030303030303030303", revokedAt: "2026-10-04T10:03:00.000Z", revokedBy: "admin")
    }
    first.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-revoked")))
    await until("the revoked screen") { store.state.auth == .loggedOut(.deviceRevoked) }
    server.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", serverId: "serwer-b"))
    }
    let target = try #require(PairingTarget(serverURL: Self.otherServer, iroh: nil))
    return (server, store, PairingLink(target: target, code: PairingFixtures.code))
  }

  @Test("server A revokes the device, then pairing with B: no line about A's device reaches B")
  func clientLogOfRevokedServerStaysOffTheNextOne() async throws {
    let (server, store, link) = try await revokedAtA()
    defer { withExtendedLifetime(server) {} }
    store.offerPairing(link)
    #expect(await store.confirmPairing() == .paired)
    let second = try #require(store.areaTransport as? FakeTransport)
    await until("B's global stream") { !second.streamCalls.isEmpty && store.state.global == .online }
    store.reportUnhandled("after pairing with B")
    await until("B's own line") { self.logged(second).contains("błąd: after pairing with B") }
    #expect(!allLines(second).contains { $0.contains("03030303030303030303030303030303") }, "\(allLines(second))")
  }

  @Test("a line recorded while the store pairs with B reaches B")
  func clientLogWhilePairingReachesThatServer() async throws {
    let (server, store, link) = try await revokedAtA()
    defer { withExtendedLifetime(server) {} }
    store.offerPairing(link)
    store.reportUnhandled("while pairing with B")
    #expect(await store.confirmPairing() == .paired)
    let second = try #require(store.areaTransport as? FakeTransport)
    await until("the line at B") { self.logged(second).contains("błąd: while pairing with B") }
  }

  /// A store logged in to server A with the key `credential` and its first transport.
  private func loggedIn(_ credential: DeviceCredential) async -> (FakeServer, RarogStore, FakeTransport) {
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: credential, pushKey: "BQUF")))
    let (store, first) = await paired(server)
    return (server, store, first)
  }

  /// B's transport after a pairing, once its global stream is open and a line recorded after it got there: every
  /// earlier line that B could get has been sent by then.
  private func settledAtB(_ store: RarogStore) async throws -> FakeTransport {
    let second = try #require(store.areaTransport as? FakeTransport)
    await until("B's global stream") { !second.streamCalls.isEmpty && store.state.global == .online }
    store.reportUnhandled("marker at B")
    await until("the marker at B") { self.logged(second).contains("błąd: marker at B") }
    return second
  }

  private static let deviceA = "03030303030303030303030303030303"

  @Test("server A revokes the device while B's pairing sheet is open, then B is paired: no line about A reaches B")
  func revocationWithSheetOpenStaysOffTheNextServer() async throws {
    let server = FakeServer()
    let (store, first) = await paired(server)
    let target = try #require(PairingTarget(serverURL: Self.otherServer, iroh: nil))
    store.offerPairing(PairingLink(target: target, code: PairingFixtures.code))
    first.set { $0.rejection = .revoked(deviceId: Self.deviceA, revokedAt: "2026-10-04T10:03:00.000Z", revokedBy: "admin") }
    first.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-revoked")))
    await until("the revoked screen") { store.state.auth == .loggedOut(.deviceRevoked) }
    server.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", serverId: "serwer-b"))
    }
    #expect(await store.confirmPairing() == .paired)
    let second = try await settledAtB(store)
    #expect(!allLines(second).contains { $0.contains(Self.deviceA) }, "\(allLines(second))")
  }

  @Test("an unsent line of server A, then Replace with another iroh key at the same address: the line never reaches B")
  func anotherIrohKeyAtTheSameOriginGetsNoLineOfA() async throws {
    let (server, store, first) = await loggedIn(PairingFixtures.credential(iroh: PairingFixtures.iroh()))
    first.set { $0.clientLogResult = .offline(.notConnectedToInternet) }
    store.reportUnhandled("unsent at A")
    await until("the failed send to A") { self.logged(first).contains("błąd: unsent at A") }
    server.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(
        deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", serverId: "serwer-b",
        iroh: (PairingFixtures.otherEndpointId, PairingFixtures.relay)))
    }
    let other = PairingFixtures.iroh(PairingFixtures.otherEndpointId)
    store.offerPairing(PairingLink(target: .both(PairingFixtures.server, other), code: PairingFixtures.code))
    #expect(await store.confirmPairing(replacing: true) == .paired)
    let second = try await settledAtB(store)
    #expect(!allLines(second).contains("błąd: unsent at A"), "\(allLines(second))")
  }

  @Test("the same text recorded for A and, after A revoked the device, for B: B gets that line exactly once")
  func sameTextForTwoServers() async throws {
    let server = FakeServer()
    let (store, first) = await paired(server)
    first.set { $0.clientLogResult = .offline(.notConnectedToInternet) }
    store.reportUnhandled("same text")
    await until("the failed send to A") { self.logged(first).contains("błąd: same text") }
    first.set { $0.rejection = .revoked(deviceId: Self.deviceA, revokedAt: "2026-10-04T10:03:00.000Z", revokedBy: "admin") }
    first.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-revoked")))
    await until("the revoked screen") { store.state.auth == .loggedOut(.deviceRevoked) }
    server.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", serverId: "serwer-b"))
    }
    let target = try #require(PairingTarget(serverURL: Self.otherServer, iroh: nil))
    store.offerPairing(PairingLink(target: target, code: PairingFixtures.code))
    store.reportUnhandled("same text")
    #expect(await store.confirmPairing() == .paired)
    let second = try await settledAtB(store)
    #expect(allLines(second).filter { $0 == "błąd: same text" }.count == 1, "\(allLines(second))")
  }

  @Test("tunnel lines of server A that come after its unpairing and after B's login never reach B")
  func lateTunnelLinesOfAStayOffB() async throws {
    let (server, store, link) = try await revokedAtA()
    defer { withExtendedLifetime(server) {} }
    let keyA = try #require(ServerKey(PairingFixtures.credential()))
    store.trace("tunnel: late line of A after the unpairing", budget: .connectivity, server: keyA)
    store.offerPairing(link)
    #expect(await store.confirmPairing() == .paired)
    let second = try await settledAtB(store)
    store.trace("tunnel: late line of A after B's login", budget: .connectivity, server: keyA)
    store.trace("tunnel: line without a server", budget: .connectivity, server: nil)
    store.reportUnhandled("second marker at B")
    await until("the second marker at B") { self.logged(second).contains("błąd: second marker at B") }
    #expect(!allLines(second).contains { $0.hasPrefix("tunnel: ") }, "\(allLines(second))")
  }

  @Test("a version probe moves the key to another iroh EndpointId: an unsent line of the old key is not sent")
  func versionProbeKeyChangeDropsOldLines() async throws {
    let (server, store, first) = await loggedIn(PairingFixtures.credential(iroh: PairingFixtures.iroh()))
    first.set { $0.clientLogResult = .offline(.notConnectedToInternet) }
    store.reportUnhandled("before the key change")
    await until("the failed send") { self.logged(first).contains("błąd: before the key change") }
    let next = ServerIroh(endpointId: PairingFixtures.otherEndpointId, relay: PairingFixtures.relay)
    store.adoptServerIroh(next, sent: store.versionProbeStamp())
    #expect(server.routeChanges.count == 1, "the key changed in place")
    first.set { $0.clientLogResult = nil }
    let tries = logged(first).filter { $0 == "błąd: before the key change" }.count
    store.reportUnhandled("after the key change")
    await until("the new key's line") { self.logged(first).contains("błąd: after the key change") }
    #expect(logged(first).filter { $0 == "błąd: before the key change" }.count == tries, "\(allLines(first))")
  }
}
