import Foundation
import RarogContract
import RarogContractFixtures
import RarogTransport
@testable import RarogCore
import Testing

// Baner v3 po stronie apki: `PushRouting.note` czyta po kolei `rarogOpen` z NSE, blok `rarog` v3
// odszyfrowany kluczem apki i jawny v1 — na złotych ramkach `shared/fixtures/apns-v3/*.v3.json` (klucz 32×0x05,
// `kid` `f849d673`) i próbkach v1 inline (``PlainV1``), deterministycznie, bez symulatora. Magazyn: push próbny v3
// daje dymek, `device-paired` i `version-changed` v3 baner na wierzchu i stronę Ustawień, `weekly-limit` baner
// na wierzchu i listę, sesja — cel tapnięcia;
// źródło celu jedną linią `client.log`. A format 2 banner (block under the old key, `v: 2`) is a rejection case,
// built from the format 3 frame.

/// Payload of a golden APNs frame as `userInfo`: `*.v3.json` from `apns-v3/`, the rest (Live Activity) from `apns/`.
func apnsFrame(_ name: String) throws -> [AnyHashable: Any] {
  let directory = name.hasSuffix(".v3.json") ? "apns-v3" : "apns"
  let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/\(directory)/\(name)")
  let document = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
  let payload = try #require(document?["payload"] as? [String: Any])
  return Dictionary(uniqueKeysWithValues: payload.map { (AnyHashable($0.key), $0.value) })
}

/// Jawny baner v1 (blok `rarog` bez koperty), który apka dalej przyjmuje. „Bez treści” = tekst zastępczy
/// z `mutable-content` i ten sam blok `rarog`.
enum PlainV1 {
  static var rarog: [String: Any] { ["v": 1, "kind": "permission", "sessionId": "demo-willow"] }

  static var blocking: [AnyHashable: Any] {
    [
      "aps": [
        "alert": ["title": "⏳ Czeka na zgodę · willow", "body": "Edit — zapis notatek"], "badge": 2,
        "sound": "default", "thread-id": "demo-willow",
      ] as [String: Any],
      "rarog": rarog,
    ]
  }

  static var placeholder: [AnyHashable: Any] {
    [
      "aps": [
        "alert": ["title": "Rarog", "body": "Nowe powiadomienie"], "mutable-content": 1, "badge": 2,
        "sound": "default", "thread-id": "demo-willow",
      ] as [String: Any],
      "rarog": rarog,
    ]
  }
}

/// Klucz push złotych ramek banerów (32×0x05) i jego `kid`.
enum FramesKey {
  static let pushKey = "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU"
  static let kid = "f849d673"

  /// Keychain apki z kluczem ramek: wpis współdzielony i kopia prywatna (jak po parowaniu).
  static func keychain(kid: String = kid) -> MemoryKeychain {
    MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: pushKey)).withShared([kid: pushKey])
  }
}

extension MemoryKeychain {
  func withShared(_ shared: [String: String]) -> MemoryKeychain {
    update { $0.shared = shared }
    return self
  }
}

@Suite("powiadomienia v3: rarogOpen, odszyfrowanie w apce, v1, format 2 odrzucony")
struct PushV3RoutingTests {
  static let blocking = PushNote(kind: .permission, target: PushTarget(sessionId: "demo-willow"), source: .app)

  @Test("v3 bez `rarogOpen` z kluczem apki: rodzaj i cel z odszyfrowania w apce (NSE nie zdążył)")
  func appFallback() throws {
    #expect(PushRouting.note(userInfo: try apnsFrame("alert.blocking.v3.json"), keys: FramesKey.keychain())
      == Self.blocking)
    #expect(PushRouting.note(userInfo: try apnsFrame("alert.done.v3.json"), keys: FramesKey.keychain())
      == PushNote(kind: .done, target: PushTarget(sessionId: "demo-codex", termId: "0123456789abcdef"), source: .app))
    let probe = try #require(PushRouting.note(userInfo: try apnsFrame("alert.test.v3.json"), keys: FramesKey.keychain()))
    #expect(probe == PushNote(kind: .test, target: nil, source: .app))
    let paired = try #require(
      PushRouting.note(userInfo: try apnsFrame("alert.device-paired.v3.json"), keys: FramesKey.keychain()))
    #expect(paired.kind == .devicePaired && paired.target == nil && paired.source == .app)
    #expect(paired.showsBannerInForeground && paired.opensSettings == .pairing)
  }

  @Test("kind → Settings screen and foreground banner: `device-paired` → Pairing, `version-changed` → Server, others none")
  func settingsScreenKinds() throws {
    let version = try #require(
      PushRouting.note(userInfo: try apnsFrame("alert.version-changed.v3.json"), keys: FramesKey.keychain()))
    #expect(version == PushNote(kind: .versionChanged, target: nil, source: .app))
    #expect(version.opensSettings == .server && version.showsBannerInForeground)
    let paired = PushNote(kind: .devicePaired, target: nil)
    #expect(paired.opensSettings == .pairing && paired.showsBannerInForeground)
    for kind: ApnsPushKind in [.permission, .done, .test, .weeklyLimit] {
      let note = PushNote(kind: kind, target: kind == .permission || kind == .done ? PushTarget(sessionId: "s-1") : nil)
      #expect(note.opensSettings == nil, "\(kind)")
    }
    #expect(PushNote(kind: nil, target: nil).opensSettings == nil, "unknown kind")
  }

  @Test("weekly limit (`alert.weekly-limit.v3.json`): banner in the foreground, tap to the list, not to the server screen")
  func weeklyLimitKind() throws {
    let weekly = try #require(
      PushRouting.note(userInfo: try apnsFrame("alert.weekly-limit.v3.json"), keys: FramesKey.keychain()))
    #expect(weekly == PushNote(kind: .weeklyLimit, target: nil, source: .app))
    #expect(weekly.showsBannerInForeground && weekly.opensList && weekly.opensSettings == nil)
  }

  @Test("foreground banner: `weekly-limit`, `device-paired` and `version-changed` yes; session kinds, test and unknown no")
  func foregroundBannerKinds() {
    for kind: ApnsPushKind in [.weeklyLimit, .devicePaired, .versionChanged] {
      #expect(PushNote(kind: kind, target: nil).showsBannerInForeground, "\(kind)")
    }
    let sessionKinds: [ApnsPushKind] = [.permission, .question, .blocked, .done, .error, .limit]
    for kind in sessionKinds {
      let note = PushNote(kind: kind, target: PushTarget(sessionId: "s-1"))
      #expect(!note.showsBannerInForeground && !note.opensList, "\(kind)")
    }
    for note in [PushNote(kind: .test, target: nil), PushNote(kind: nil, target: nil)] {
      #expect(!note.showsBannerInForeground && !note.opensList, "\(String(describing: note.kind))")
    }
    #expect(!PushNote(kind: .devicePaired, target: nil).opensList)
    #expect(!PushNote(kind: .versionChanged, target: nil).opensList)
  }

  @Test("rodzaj nieznany apce (nowszy serwer): rodzaj nil, bez ekranu „Serwer” i bez banera na wierzchu")
  func unknownKind() throws {
    var fromNSE = try apnsFrame("alert.version-changed.v3.json")
    fromNSE[PushOpen.userInfoKey] = ["kind": "nowy-rodzaj"]
    let plain: [AnyHashable: Any] = [
      "aps": ["alert": ["title": "t", "body": "b"]], "rarog": ["v": 1, "kind": "nowy-rodzaj"],
    ]
    let notes = [
      try #require(PushRouting.note(userInfo: fromNSE, keys: MemoryKeychain())),
      try #require(PushRouting.note(userInfo: plain, keys: MemoryKeychain())),
    ]
    #expect(notes == [
      PushNote(kind: nil, target: nil, source: .serviceExtension), PushNote(kind: nil, target: nil, source: .v1),
    ])
    for note in notes {
      #expect(note.opensSettings == nil && !note.showsBannerInForeground && !note.opensList, "\(note.source)")
    }
  }

  @Test("v3 z kopią klucza we wpisie prywatnym (grupa współdzielona pusta): apka dalej odszyfrowuje")
  func privateCopy() throws {
    let keychain = FramesKey.keychain().withShared([:])
    #expect(PushRouting.note(userInfo: try apnsFrame("alert.blocking.v3.json"), keys: keychain) == Self.blocking)
  }

  @Test("pierwszeństwo `rarogOpen` z NSE; nieczytelny `rarogOpen` przy poprawnym v3 → odszyfrowanie w apce")
  func rarogOpenFirst() throws {
    var userInfo = try apnsFrame("alert.blocking.v3.json")
    userInfo[PushOpen.userInfoKey] = ["kind": "question", "sessionId": "z-nse"]
    #expect(PushRouting.note(userInfo: userInfo, keys: FramesKey.keychain())
      == PushNote(kind: .question, target: PushTarget(sessionId: "z-nse"), source: .serviceExtension))
    // Klucz niepotrzebny: cel z NSE nie wymaga Keychaina apki.
    #expect(PushRouting.note(userInfo: userInfo, keys: MemoryKeychain())?.source == .serviceExtension)
    for broken: Any in ["napis", ["kind": 7], ["kind": "done", "sessionId": ""], ["termId": "../x"]] {
      userInfo[PushOpen.userInfoKey] = broken
      #expect(PushRouting.note(userInfo: userInfo, keys: FramesKey.keychain()) == Self.blocking, "\(broken)")
    }
  }

  @Test("NSE → apka: decyzja rozszerzenia na ramce v3, `userInfo` z `rarogOpen` czytane jako źródło NSE")
  func serviceExtensionOutput() throws {
    let userInfo = try apnsFrame("alert.blocking.v3.json")
    // Ramka niesie angielski tekst serwera z kodami zdań; rozszerzenie polskiej apki składa z nich polski baner.
    let decision = PushServiceDecision.decide(
      userInfo: userInfo, keys: SharedOnly(FramesKey.keychain()), now: Date(timeIntervalSince1970: 1_791_367_800),
      renderer: ServerText.renderer(language: .pl))
    guard case let .replace(title, body, open) = decision else {
      Issue.record("oczekiwano podstawienia, jest \(decision)")
      return
    }
    #expect(title == "⏳ Czeka na zgodę · willow" && body == "Edit — zapis notatek")
    // Bez klucza w apce (np. wpis prywatny nieczytelny) cel i tak dochodzi — z NSE.
    #expect(PushRouting.note(userInfo: open.adding(to: userInfo), keys: MemoryKeychain())
      == PushNote(kind: .permission, target: PushTarget(sessionId: "demo-willow"), source: .serviceExtension))
  }

  @Test("v3, którego apka nie otworzy: nieznany `kid`, AEAD, Keychain zablokowany, zła koperta → powód, `note` nil")
  func unopenedV3() throws {
    let userInfo = try apnsFrame("alert.blocking.v3.json")
    let other = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: FramesKey.pushKey))
      .withShared(["0a0b0c0d": FramesKey.pushKey])
    other.update { $0.credential?.kid = "0a0b0c0d" }
    #expect(PushRouting.inspect(userInfo: userInfo, keys: other) == .unreadableV3(.keyMissing), "nieznany kid")
    #expect(PushRouting.note(userInfo: userInfo, keys: other) == nil, "nieznany kid: tap otwiera samą apkę")
    // Ten sam `kid`, inny klucz (32×0x06): porażka AEAD.
    let wrongKey = FramesKey.keychain().withShared([FramesKey.kid: "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY"])
    #expect(PushRouting.inspect(userInfo: userInfo, keys: wrongKey) == .unreadableV3(.authenticationFailed))
    #expect(PushRouting.note(userInfo: userInfo, keys: wrongKey) == nil)
    let locked = FramesKey.keychain()
    locked.update { $0.locked = true }
    #expect(PushRouting.inspect(userInfo: userInfo, keys: locked) == .unreadableV3(.keychainLocked))
    #expect(PushRouting.note(userInfo: userInfo, keys: locked) == nil)
    let bare: [AnyHashable: Any] = ["rarog": ["v": 3, "sessionId": "s-1", "kind": "done"]]
    #expect(PushRouting.inspect(userInfo: bare, keys: FramesKey.keychain()) == .unreadableV3(.envelopeInvalid),
      "v3 bez koperty nie spada do v1")
    #expect(PushRouting.note(userInfo: bare, keys: FramesKey.keychain()) == nil)
    // Cudzy push i wersja spoza kontraktu (także `v: 2` pod `rarog`): bez powodu (nie nasz kształt, bez linii
    // w `client.log`).
    #expect(PushRouting.inspect(userInfo: ["aps": ["alert": "cudzy"]], keys: FramesKey.keychain()) == .foreign)
    for version in [2, 4] {
      #expect(PushRouting.inspect(userInfo: ["rarog": ["v": version, "kind": "done"]], keys: FramesKey.keychain())
        == .foreign, "v: \(version)")
    }
  }

  @Test("format 2 (block under the old key, `v: 2`): the app does not see its block — a foreign push, the NSE keeps the original")
  func format2Rejected() throws {
    let legacyBlock = "pilot" // stara-nazwa
    for name in ["alert.blocking.v3.json", "alert.done.v3.json", "alert.test.v3.json", "alert.device-paired.v3.json"] {
      var userInfo = try apnsFrame(name)
      var block = try #require(userInfo.removeValue(forKey: "rarog") as? [String: Any], "\(name)")
      block["v"] = 2
      userInfo[legacyBlock] = block
      #expect(PushRouting.inspect(userInfo: userInfo, keys: FramesKey.keychain()) == .foreign, "\(name)")
      #expect(PushRouting.note(userInfo: userInfo, keys: FramesKey.keychain()) == nil, "\(name)")
      let decision = PushServiceDecision.decide(
        userInfo: userInfo, keys: SharedOnly(FramesKey.keychain()), now: Date(timeIntervalSince1970: 1_791_367_800))
      #expect(decision == .keep(.notV3), "\(name)")
    }
  }

  @Test("„v1 bez treści” i v1 bez zmian: jawny blok `rarog`, źródło v1")
  func v1() throws {
    #expect(PushRouting.note(userInfo: PlainV1.placeholder, keys: MemoryKeychain())
      == PushNote(kind: .permission, target: PushTarget(sessionId: "demo-willow"), source: .v1))
    let plain = try #require(PushRouting.note(userInfo: PlainV1.blocking, keys: MemoryKeychain()))
    #expect(plain.source == .v1 && plain.kind == .permission && plain.target != nil)
  }
}

/// Czytnik NSE na atrapie: tylko wpis współdzielony (bez kopii prywatnej), jak `SharedPushKeychain`.
private struct SharedOnly: PushKeyReader {
  let keychain: MemoryKeychain

  init(_ keychain: MemoryKeychain) {
    self.keychain = keychain
  }

  func pushKey(kid: String) -> PushKeyRead {
    keychain.snapshot.shared[kid].map { .found(Data($0.utf8)) } ?? PushKeyRead.none
  }
}

@MainActor
@Suite("magazyn: powiadomienia v3")
struct StorePushV3Tests {
  static let tokenData = Data((0..<16).map { UInt8($0 * 17) })

  private func bringOnline(_ store: RarogStore, _ transport: FakeTransport) async {
    await until("strumień globalny") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("demo-willow"))]}"#)
    await until("świeża lista") { store.state.sessionsLoaded && store.state.compat == .ok }
  }

  private func messages(_ transport: FakeTransport) -> [String] {
    transport.read { $0.clientLogs.flatMap(\.events).map(\.msg) }
  }

  @Test("push próbny v3 odszyfrowany w apce → dymek „Powiadomienia działają”; linia źródła bez treści")
  func probeBubble() async throws {
    let (store, transport) = makeStore()
    let system = FakePushSystem(status: .notDetermined)
    store.pushTiming = PushTiming(testWait: .seconds(5), snooze: 7 * 24 * 3600)
    store.attachSystem(push: system, background: FakeBackgroundWork(log: EventLog()), preferences: MemoryPreferences())
    store.simulateApnsChannelForUITests()
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await bringOnline(store, transport)
    await store.enablePush()
    #expect(store.state.push.notice == nil)
    let note = try #require(PushRouting.note(userInfo: try apnsFrame("alert.test.v3.json"), keys: FramesKey.keychain()))
    store.pushReceived(note)
    #expect(store.state.push.notice?.kind == .working)
    await until("linia źródła") { messages(transport).contains { $0.hasPrefix("push: na wierzchu") } }
    #expect(messages(transport).contains("push: na wierzchu — źródło apka, rodzaj test, bez celu"))
    for text in ["Powiadomienia działają", "Notifications are working"] {
      #expect(!messages(transport).joined().contains(text), "bez treści banera w client.log")
    }
  }

  @Test("tap w sesję v3: cel czeka na listę, potem wchodzi; linia źródła NSE / apka / v1")
  func sessionTap() async throws {
    let (store, transport) = makeStore()
    store.attachSystem(
      push: FakePushSystem(), background: FakeBackgroundWork(log: EventLog()), preferences: MemoryPreferences())
    var fromNSE = try apnsFrame("alert.blocking.v3.json")
    fromNSE[PushOpen.userInfoKey] = PushOpen(kind: .permission, sessionId: "demo-willow").userInfoValue
    let tapped = try #require(PushRouting.note(userInfo: fromNSE, keys: MemoryKeychain()))
    store.pushTapped(tapped)
    #expect(store.state.readyPushTarget == nil, "przed zalogowaniem i listą")
    await store.start()
    await bringOnline(store, transport)
    #expect(store.state.readyPushTarget == PushTarget(sessionId: "demo-willow"))
    let app = try #require(PushRouting.note(userInfo: try apnsFrame("alert.blocking.v3.json"), keys: FramesKey.keychain()))
    store.pushTapped(app)
    let legacy = try #require(PushRouting.note(userInfo: PlainV1.placeholder, keys: MemoryKeychain()))
    store.pushTapped(legacy)
    await until("trzy linie źródła") { messages(transport).filter { $0.hasPrefix("push: tap") }.count == 3 }
    #expect(messages(transport).filter { $0.hasPrefix("push: tap") } == [
      "push: tap — źródło NSE, rodzaj permission, z celem",
      "push: tap — źródło apka, rodzaj permission, z celem",
      "push: tap — źródło v1, rodzaj permission, z celem",
    ])
    #expect(!messages(transport).joined().contains("demo-willow"), "bez id sesji w client.log")
  }

  @Test("tap w `version-changed` v3: ekran „Serwer” bez sesji; rodzaj nieznany apce otwiera samą apkę")
  func versionChangedTap() async throws {
    let (store, transport) = makeStore()
    store.attachSystem(
      push: FakePushSystem(), background: FakeBackgroundWork(log: EventLog()), preferences: MemoryPreferences())
    await store.start()
    await bringOnline(store, transport)
    let version = try #require(
      PushRouting.note(userInfo: try apnsFrame("alert.version-changed.v3.json"), keys: FramesKey.keychain()))
    store.pushTapped(version)
    #expect(store.state.pairing.settingsScreenRequested == .server)
    #expect(store.state.readyPushTarget == nil)
    store.consumeSettingsScreenRequest()
    var unknown = try apnsFrame("alert.version-changed.v3.json")
    unknown[PushOpen.userInfoKey] = ["kind": "nowy-rodzaj"]
    store.pushTapped(try #require(PushRouting.note(userInfo: unknown, keys: MemoryKeychain())))
    #expect(store.state.pairing.settingsScreenRequested == nil, "unknown kind: no Settings screen")
    #expect(store.state.readyPushTarget == nil, "bez celu: sama apka")
    #expect(store.state.readyLink == nil, "unknown kind: no list link")
    await until("dwie linie tapnięcia") { messages(transport).filter { $0.hasPrefix("push: tap") }.count == 2 }
    #expect(messages(transport).filter { $0.hasPrefix("push: tap") } == [
      "push: tap — źródło apka, rodzaj version-changed, bez celu",
      "push: tap — źródło NSE, rodzaj nieznany, bez celu",
    ])
  }

  @Test("tap on `weekly-limit` v3 (NSE and app): the list link waits for a fresh list, then enters; no server screen")
  func weeklyLimitTap() async throws {
    let (store, transport) = makeStore()
    store.attachSystem(
      push: FakePushSystem(), background: FakeBackgroundWork(log: EventLog()), preferences: MemoryPreferences())
    var fromNSE = try apnsFrame("alert.weekly-limit.v3.json")
    fromNSE[PushOpen.userInfoKey] = PushOpen(kind: .weeklyLimit).userInfoValue
    let tapped = try #require(PushRouting.note(userInfo: fromNSE, keys: MemoryKeychain()))
    #expect(tapped == PushNote(kind: .weeklyLimit, target: nil, source: .serviceExtension))
    // Cold start: the tap arrives before login and before the list.
    store.pushTapped(tapped)
    #expect(store.state.readyLink == nil, "before login and the list")
    await store.start()
    await bringOnline(store, transport)
    #expect(store.state.readyLink == .list)
    #expect(store.state.readyPushTarget == nil && store.state.pairing.settingsScreenRequested == nil)
    store.consumeLink(.list)
    #expect(store.state.readyLink == nil)
    let app = try #require(
      PushRouting.note(userInfo: try apnsFrame("alert.weekly-limit.v3.json"), keys: FramesKey.keychain()))
    store.pushTapped(app)
    #expect(store.state.readyLink == .list && store.state.pairing.settingsScreenRequested == nil)
    await until("two tap lines") { messages(transport).filter { $0.hasPrefix("push: tap") }.count == 2 }
    #expect(messages(transport).filter { $0.hasPrefix("push: tap") } == [
      "push: tap — źródło NSE, rodzaj weekly-limit, bez celu",
      "push: tap — źródło apka, rodzaj weekly-limit, bez celu",
    ])
  }

  @Test("`weekly-limit` received in the foreground: no test push bubble, no device list read, no navigation")
  func weeklyLimitReceived() async throws {
    let keychain = FramesKey.keychain()
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    await store.start()
    try await Task.sleep(for: .milliseconds(50))
    let calls = server.current?.read { $0.devicesCalls } ?? 0
    let weekly = try #require(
      PushRouting.note(userInfo: try apnsFrame("alert.weekly-limit.v3.json"), keys: keychain))
    #expect(weekly.kind == .weeklyLimit)
    store.pushReceived(weekly)
    try await Task.sleep(for: .milliseconds(50))
    #expect((server.current?.read { $0.devicesCalls } ?? 0) == calls, "no device list read")
    #expect(store.state.push.notice == nil, "no test push bubble")
    #expect(store.state.push.pendingLink == nil && store.state.push.pendingTarget == nil, "receiving does not navigate")
    // Control: in the same setup `device-paired` does read the list, so the check above can fail.
    store.pushReceived(PushNote(kind: .devicePaired, target: nil, source: .app))
    await until("device list read after device-paired") { (server.current?.read { $0.devicesCalls } ?? 0) > calls }
  }

  @Test("v3, którego apka nie otworzy: linia z powodem na wierzchu i przy tapnięciu, bez celu i bez rozstrzygania „Włącz”")
  func unreadableLine() async throws {
    let (store, transport) = makeStore()
    store.pushTiming = PushTiming(testWait: .seconds(5), snooze: 7 * 24 * 3600)
    store.attachSystem(
      push: FakePushSystem(status: .notDetermined), background: FakeBackgroundWork(log: EventLog()),
      preferences: MemoryPreferences())
    store.simulateApnsChannelForUITests()
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await bringOnline(store, transport)
    await store.enablePush()
    // Klucz z innego parowania: `kid` ramki nieznany — push próbny dotarł, apka go nie otworzy.
    let elsewhere = MemoryKeychain().withShared(["0a0b0c0d": FramesKey.pushKey])
    for name in ["alert.test.v3.json", "alert.blocking.v3.json"] {
      guard case let .unreadableV3(reason) = PushRouting.inspect(userInfo: try apnsFrame(name), keys: elsewhere) else {
        Issue.record("\(name): oczekiwano v3 nieczytelnego")
        return
      }
      store.pushUnreadable(reason, tapped: name.hasPrefix("alert.blocking"))
    }
    #expect(store.state.push.notice == nil, "„Włącz” czeka dalej: dymek tylko po próbnym, który apka przeczyta")
    #expect(store.state.readyPushTarget == nil, "bez celu: tap otwiera samą apkę")
    await until("dwie linie") { messages(transport).filter { $0.contains("v3 nieczytelne") }.count == 2 }
    #expect(messages(transport).filter { $0.contains("v3 nieczytelne") } == [
      "push: na wierzchu — v3 nieczytelne: keyMissing",
      "push: tap — v3 nieczytelne: keyMissing",
    ])
    #expect(!messages(transport).joined().contains("demo-willow"), "bez id sesji w client.log")
  }
}
