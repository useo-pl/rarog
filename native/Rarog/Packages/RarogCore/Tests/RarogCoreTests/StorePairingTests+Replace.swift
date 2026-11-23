import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// A link to another server than the paired one (one server per app): the store names the pairing the
// link would replace (`PairingState.replacedServer`, the sheet's warning), sends nothing without "Replace"
// (`confirmPairing(replacing: true)`), and after "Replace" the new key never opens the data space of the replaced
// pairing, not even after a process killed right after the Keychain write. A link to the same server and the first
// pairing go as before. Pairing again over iroh with proof of the server key: `StorePairingTests+Iroh`; the
// space on the pointer of a build before the `identity` field: `StoreSpacesTests`.

extension StorePairingTests {
  private static let otherOrigin = URL(string: "https://inny.example")!
  private static let keyOne = PairingFixtures.iroh()
  private static let keyTwo = PairingFixtures.iroh(PairingFixtures.otherEndpointId)
  /// The device key of the new pairing (the paired one is `0303…`).
  private static let newDevice = "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"

  private func link(_ server: URL?, _ iroh: ServerIrohConfig?) -> PairingLink {
    guard let target = PairingTarget(serverURL: server, iroh: iroh) else { preconditionFailure("a link has a route") }
    return PairingLink(target: target, code: PairingFixtures.code)
  }

  /// A store paired with `credential` (from the Keychain), online, with one queued entry on the disk of its space. The
  /// next pairing answers with another device key and no iroh pair in the reply.
  private func pairedWithQueue(_ credential: DeviceCredential) async throws -> (FakeServer, RarogStore, ServerSpace) {
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: credential, pushKey: "BQUF")))
    let (store, _) = await paired(server)
    let space = try #require(server.pointer)
    try await #require(server.outbox()).save(entryA())
    server.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(deviceId: Self.newDevice, serverId: "serwer-b"))
    }
    return (server, store, space)
  }

  /// The sheet for `link` warns about the paired server, and plain "Pair" sends nothing: the sheet, the Keychain and
  /// the transport stay.
  private func expectWarned(
    _ store: RarogStore, _ server: FakeServer, _ link: PairingLink, sourceLocation: SourceLocation = #_sourceLocation
  ) async {
    store.offerPairing(link)
    let paired = store.state.pairing.paired
    #expect(paired != nil && store.state.pairing.replacedServer == paired, "warning", sourceLocation: sourceLocation)
    let key = server.keychain.load()
    let transport = server.current
    #expect(await store.confirmPairing() == .ignored, "Pair without Replace", sourceLocation: sourceLocation)
    #expect(store.state.pairing.flow == .confirming(link), "the sheet stays", sourceLocation: sourceLocation)
    #expect(server.pairingTargets.isEmpty && server.pairing.read { $0.pairBodies }.isEmpty, sourceLocation: sourceLocation)
    #expect(server.keychain.load() == key && server.current === transport, sourceLocation: sourceLocation)
  }

  /// After "Replace": the new key reads a fresh space, the replaced pairing's space is in the trash, and a restart
  /// reads nothing of it either.
  private func expectFreshSpace(
    _ store: RarogStore, _ server: FakeServer, replaced space: ServerSpace, sourceLocation: SourceLocation = #_sourceLocation
  ) async throws {
    let pointer = try #require(server.pointer, sourceLocation: sourceLocation)
    #expect(pointer.name != space.name, "a fresh space", sourceLocation: sourceLocation)
    #expect(store.dataSpaceDirectory == server.spaces.directory(pointer), sourceLocation: sourceLocation)
    #expect(store.state.outbox.isEmpty && server.wipes == 1, sourceLocation: sourceLocation)
    #expect(!server.spaceNames.contains(space.name), "the replaced space in the trash", sourceLocation: sourceLocation)
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.state.outbox.isEmpty, "a restart reads nothing of the replaced pairing", sourceLocation: sourceLocation)
  }

  @Test("another server: the full key when the link has `k`, the origin when it has none; none on first pairing")
  func replacedServerRule() {
    let addressAndKey = PairingFixtures.credential(iroh: Self.keyOne)
    let addressOnly = PairingFixtures.credential()
    let keyOnly = PairingFixtures.credential(server: nil, iroh: Self.keyOne)
    let origin = PairingFixtures.server
    let rows: [(String, DeviceCredential?, PairingLink, Bool)] = [
      ("1 same origin and key", addressAndKey, link(origin, Self.keyOne), false),
      ("2 same origin, another key", addressAndKey, link(origin, Self.keyTwo), true),
      ("3 another key, server only over iroh", keyOnly, link(nil, Self.keyTwo), true),
      ("4 first pairing", nil, link(origin, Self.keyOne), false),
      ("5 no `k`, another origin", addressOnly, link(Self.otherOrigin, nil), true),
      ("5 no `k`, paired server only over iroh", keyOnly, link(origin, nil), true),
      ("6 paired without an iroh key: the key cannot be compared", addressOnly, link(origin, Self.keyOne), true),
      ("no `k`, the same origin spelled otherwise", addressOnly, link(URL(string: "https://RAROG.example:443")!, nil), false),
      ("the same key under another origin", addressAndKey, link(Self.otherOrigin, Self.keyOne), false),
      ("the same key, link only over iroh", addressAndKey, link(nil, Self.keyOne), false),
    ]
    for (label, credential, link, replaces) in rows {
      var state = PairingState()
      if let credential { state.binding = .device(PairedServer(credential)) }
      state.flow = .confirming(link)
      #expect(state.replacedServer == (replaces ? state.paired : nil), "\(label)")
      state.flow = .failed(link, .codeRejected)
      #expect(state.replacedServer == (replaces ? state.paired : nil), "\(label), refused")
    }
    var state = PairingState()
    state.binding = .device(PairedServer(addressOnly))
    #expect(state.replacedServer == nil, "no link in the sheet")
    state.flow = .rejected(.badCode)
    #expect(state.replacedServer == nil, "a refused link names no server")
  }

  @Test("1 and 4: the same server or the first pairing pairs without a warning; the same server keeps its space")
  func sameServerAndFirstPairingWithoutWarning() async throws {
    let (server, store, space) = try await pairedWithQueue(PairingFixtures.credential(iroh: Self.keyOne))
    store.offerPairing(link(PairingFixtures.server, Self.keyOne))
    #expect(store.state.pairing.replacedServer == nil)
    #expect(await store.confirmPairing() == .paired)
    #expect(server.pointer?.name == space.name && server.wipes == 0)
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.state.outbox.map(\.text) == ["do serwera A"], "the queue stays in the same space")

    let fresh = FakeServer()
    let first = fresh.store()
    await first.start()
    first.offerPairing(link(PairingFixtures.server, Self.keyOne))
    #expect(first.state.pairing.replacedServer == nil)
    #expect(await first.confirmPairing() == .paired)
    #expect(fresh.pointer?.identity == .origin(GoldenPointers.rarog))
  }

  @Test("2 same origin, another key: warning; after Replace a fresh space is on disk before the Keychain holds the key")
  func replaceAnotherKeyAtTheSameOrigin() async throws {
    let (server, store, space) = try await pairedWithQueue(PairingFixtures.credential(iroh: Self.keyOne))
    let other = link(PairingFixtures.server, Self.keyTwo)
    await expectWarned(store, server, other)
    let file = server.spaces.pointerFile
    let atKeySave = PointerSnapshot()
    server.keychainProbe.afterNextSave { atKeySave.take(file) }
    #expect(await store.confirmPairing(replacing: true) == .paired)
    #expect(server.pairingTargets == [.both(PairingFixtures.server, Self.keyTwo)])
    let pointer = try #require(server.pointer)
    #expect(pointer.identity == .origin(GoldenPointers.rarog))
    // A process killed right after the Keychain write restarts with the new key on this pointer: a space without the
    // replaced pairing's queue and drafts.
    let left = try JSONDecoder().decode(ServerSpace.self, from: try #require(atKeySave.data))
    #expect(left.name != space.name && left == pointer, "the fresh space before the key")
    try await expectFreshSpace(store, server, replaced: space)
    #expect(server.forgotten.map { $0.endpoint.credential?.deviceId } == ["03030303030303030303030303030303"])
  }

  @Test("3 another key of a server only over iroh: warning; after Replace a fresh space, also when the reply names the replaced key")
  func replaceAnotherIrohOnlyKey() async throws {
    for reply in [nil, Self.keyOne] {
      let (server, store, space) = try await pairedWithQueue(PairingFixtures.credential(server: nil, iroh: Self.keyOne))
      let iroh = reply.map { (endpointId: $0.endpointId, relay: $0.relay.absoluteString) }
      server.pairing.set {
        $0.pairResult = .success(PairingFixtures.response(deviceId: Self.newDevice, serverId: "serwer-b", iroh: iroh))
      }
      let other = link(nil, Self.keyTwo)
      await expectWarned(store, server, other)
      #expect(await store.confirmPairing(replacing: true) == .paired)
      let key = reply ?? Self.keyTwo
      #expect(server.pointer?.identity == .iroh(endpointId: key.endpointId), "reply \(String(describing: reply))")
      try await expectFreshSpace(store, server, replaced: space)
    }
  }

  @Test("5 a link without `k` to another origin: warning; after Replace the space of that origin")
  func replaceAnotherOriginWithoutKey() async throws {
    for (credential, target) in [
      (PairingFixtures.credential(), Self.otherOrigin),
      (PairingFixtures.credential(server: nil, iroh: Self.keyOne), PairingFixtures.server),
    ] {
      let (server, store, space) = try await pairedWithQueue(credential)
      await expectWarned(store, server, link(target, nil))
      #expect(await store.confirmPairing(replacing: true) == .paired)
      #expect(server.pointer?.origin == ServerOrigin(target))
      try await expectFreshSpace(store, server, replaced: space)
    }
  }

  @Test("Keychain refuses the key after Replace: the pointer returns to the replaced pairing's space, its queue stays")
  func replaceKeychainRefusalRestoresSpace() async throws {
    let credential = PairingFixtures.credential(iroh: Self.keyOne)
    let (server, store, space) = try await pairedWithQueue(credential)
    server.keychain.update { $0.saveFailure = -25_308 }
    store.offerPairing(link(PairingFixtures.server, Self.keyTwo))
    #expect(await store.confirmPairing(replacing: true) == .failed(.keychain(-25_308)))
    #expect(server.pointerDisk.writes.contains { $0.saved && $0.space?.name != space.name }, "the fresh space came first")
    #expect(server.pointer == space && server.spaceNames == [space.name] && server.wipes == 0)
    #expect(server.keychain.load() == .found(credential, pushKey: "BQUF"))
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.state.outbox.map(\.text) == ["do serwera A"])
  }

  @Test("disk refuses the fresh space after Replace: refusal before the Keychain, the paired key keeps its space")
  func replaceDiskRefusal() async throws {
    let credential = PairingFixtures.credential(iroh: Self.keyOne)
    let (server, store, space) = try await pairedWithQueue(credential)
    let first = server.current
    server.pointerDisk.refuse { $0.name != space.name }
    let other = link(PairingFixtures.server, Self.keyTwo)
    store.offerPairing(other)
    #expect(await store.confirmPairing(replacing: true) == .failed(.failed(nil)))
    #expect(store.state.pairing.flow == .failed(other, .failed(nil)))
    #expect(server.keychain.load() == .found(credential, pushKey: "BQUF"))
    #expect(server.pointer == space && server.wipes == 0)
    #expect(server.current === first && store.state.auth == .loggedIn)
  }

  // The sheet's button runs in a task: a link offered between the tap and the task must not get the tap's consent.
  @Test("the confirmation is bound to the link the sheet showed: another link offered meanwhile is not paired")
  func confirmationBoundToTheShownLink() async throws {
    let (server, store, space) = try await pairedWithQueue(PairingFixtures.credential(iroh: Self.keyOne))
    let shown = link(PairingFixtures.server, Self.keyTwo)
    let later = link(Self.otherOrigin, nil)
    store.offerPairing(shown)
    store.offerPairing(later)
    #expect(await store.confirmPairing(replacing: true, shown: shown) == .ignored)
    #expect(await store.confirmPairing(shown: shown) == .ignored)
    #expect(store.state.pairing.flow == .confirming(later), "the sheet shows the later link")
    #expect(server.pairingTargets.isEmpty && server.pairing.read { $0.pairBodies }.isEmpty)
    #expect(server.pointer == space && server.wipes == 0)
    #expect(await store.confirmPairing(replacing: true, shown: later) == .paired)
  }
}
