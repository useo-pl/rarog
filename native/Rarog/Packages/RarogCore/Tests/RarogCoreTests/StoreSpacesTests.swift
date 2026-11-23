import Foundation
@testable import RarogCore
import RarogTransport
import Testing

// Magazyn na wskaźniku przestrzeni zapisanym przez build sprzed pola `identity`: aktualizacja apki nie zmienia
// przestrzeni, więc kolejka wysyłki i szkice zostają na miejscu, a nic nie idzie do kosza. Przestrzeń wybiera
// tożsamość serwera z klucza (`ServerIdentity`); dla klucza z adresem to ten sam `ServerOrigin` co w starszym buildzie.
// Reszta reguł przestrzeni: `StorePairingTests`.

@MainActor
@Suite("magazyn: przestrzeń ze wskaźnika sprzed pola identity i wybór po tożsamości serwera")
struct StoreSpacesTests {
  private func entry(_ text: String) -> OutboxEntry {
    OutboxEntry(sessionId: "sesja-a", text: text, createdAt: Date(), state: .unconfirmed)
  }

  /// Przestrzeń z danymi na dysku i złotym wskaźnikiem: kolejka (jeden wpis) i szkice pola oraz notatki.
  private func seed(_ server: FakeServer, pointer: Data) async throws -> (ServerSpace, [URL]) {
    let space = try JSONDecoder().decode(ServerSpace.self, from: pointer)
    let directory = server.spaces.directory(space)
    try FileManager.default.createDirectory(at: server.spaces.root, withIntermediateDirectories: true)
    try pointer.write(to: server.spaces.pointerFile)
    try await OutboxPersistence(directory: directory.appending(path: ServerSpaces.outbox)).save(entry("z kolejki main"))
    var drafts: [URL] = []
    for folder in [ServerSpaces.drafts, ServerSpaces.noteDrafts] {
      let file = directory.appending(path: folder, directoryHint: .isDirectory).appending(path: "szkic.json")
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data(#"{"text":"szkic"}"#.utf8).write(to: file)
      drafts.append(file)
    }
    return (space, drafts)
  }

  /// Wpisy kosza, które pochodzą z `servers/` (katalog roboczy procesu `scratch-…` się nie liczy).
  private func trashed(_ server: FakeServer) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: server.spaces.trash.path)) ?? []).filter { !$0.hasPrefix("scratch-") }
  }

  @Test("złoty wskaźnik main: nowy magazyn wchodzi w tę samą przestrzeń, kolejka i szkice na miejscu, kosz pusty")
  func goldenMainPointerKeepsSpace() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let (space, drafts) = try await seed(server, pointer: GoldenPointers.main)
    let store = server.store()
    await store.start()
    #expect(store.dataSpaceDirectory == server.spaces.directory(space))
    #expect(store.state.outbox.map(\.text) == ["z kolejki main"] && server.wipes == 0)
    #expect(server.spaceNames == ["8e62cbe8f9e21edf-1654d564"] && server.pointer == space)
    for file in drafts { #expect(FileManager.default.fileExists(atPath: file.path), "\(file.lastPathComponent)") }
    #expect(trashed(server).isEmpty, "nic z servers/ w koszu")
    // Wskaźnik zostaje bajt w bajt: wybór tej samej przestrzeni go nie przepisuje.
    #expect(try Data(contentsOf: server.spaces.pointerFile) == GoldenPointers.main)
  }

  @Test("złoty wskaźnik main i klucz pod równoważnym adresem (wielkość liter, :443, ukośnik): ta sama przestrzeń")
  func goldenMainPointerEquivalentAddress() async throws {
    let credential = PairingFixtures.credential(server: URL(string: "https://RAROG.example:443/")!)
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: credential, pushKey: "BQUF")))
    let (space, _) = try await seed(server, pointer: GoldenPointers.main)
    let store = server.store()
    await store.start()
    #expect(store.dataSpaceDirectory == server.spaces.directory(space) && store.state.outbox.count == 1)
  }

  @Test("złoty wskaźnik main innego serwera: nowa przestrzeń z `identity`, stara do kosza, kolejka pusta")
  func goldenMainPointerOtherServer() async throws {
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF")))
    let (old, _) = try await seed(server, pointer: GoldenPointers.mainPort)
    let store = server.store()
    await store.start()
    let space = try #require(server.pointer)
    #expect(space.name != old.name && space.identity == .origin(GoldenPointers.rarog))
    #expect(store.state.outbox.isEmpty && server.spaceNames.allSatisfy { $0 != old.name })
    let json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: server.spaces.pointerFile)) as? [String: Any])
    #expect(json["identity"] as? String == "https://rarog.example:443" && json["origin"] != nil)
  }

  @Test("wskaźnik `.iroh` i klucz z adresem: inny serwer, nowa przestrzeń po adresie")
  func irohPointerWithAddressKey() async throws {
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF")))
    let (old, _) = try await seed(server, pointer: GoldenPointers.iroh)
    let store = server.store()
    await store.start()
    let space = try #require(server.pointer)
    #expect(space.name != old.name && space.identity == .origin(GoldenPointers.rarog))
    #expect(store.state.outbox.isEmpty && server.spaceNames.allSatisfy { $0 != old.name })
  }

  @Test("main pointer, key without an iroh pair, link `u`+`k` to that address: warning; after Replace the queue and drafts are gone")
  func goldenMainPointerReplacedByKeyedLink() async throws {
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF")))
    let (space, drafts) = try await seed(server, pointer: GoldenPointers.main)
    let store = server.store()
    await store.start()
    #expect(store.state.outbox.count == 1)
    // A key saved before iroh has no server key to compare with `k`, so this is another server.
    let link = PairingLink(target: .both(PairingFixtures.server, PairingFixtures.iroh()), code: PairingFixtures.code)
    store.offerPairing(link)
    #expect(store.state.pairing.paired != nil && store.state.pairing.replacedServer == store.state.pairing.paired)
    #expect(await store.confirmPairing() == .ignored && server.pairingTargets.isEmpty, "nothing sent without Replace")
    server.pairing.set { $0.pairResult = .success(PairingFixtures.response(deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a")) }
    #expect(await store.confirmPairing(replacing: true) == .paired)
    let pointer = try #require(server.pointer)
    #expect(pointer.identity == .origin(GoldenPointers.rarog) && pointer.name != space.name)
    #expect(store.state.outbox.isEmpty && server.wipes == 1 && !server.spaceNames.contains(space.name))
    for file in drafts { #expect(!FileManager.default.fileExists(atPath: file.path), "\(file.lastPathComponent)") }
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.state.outbox.isEmpty)
  }

  @Test("złoty wskaźnik main bez klucza: przestrzeń ze wskaźnika czeka na parowanie z tym serwerem")
  func goldenMainPointerWithoutKey() async throws {
    let server = FakeServer()
    let (space, drafts) = try await seed(server, pointer: GoldenPointers.main)
    let store = server.store()
    await store.start()
    #expect(store.dataSpaceDirectory == server.spaces.directory(space) && server.pointer == space)
    store.offerPairing(PairingFixtures.link())
    #expect(await store.confirmPairing() == .paired)
    #expect(store.dataSpaceDirectory == server.spaces.directory(space) && server.wipes == 0)
    for file in drafts { #expect(FileManager.default.fileExists(atPath: file.path), "\(file.lastPathComponent)") }
  }
}
