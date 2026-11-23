// Złote ramki APNs, strona klienta Swift — lustro `shared/test/apns-fixtures.test.ts` na
// tych samych plikach (`shared/fixtures/apns/` i `shared/fixtures/apns-v3/`, produkuje je kod serwera). ActivityKit dekoduje
// `aps.content-state` SAM, typem `LiveActivityContentState`, więc test przechodzi CAŁĄ ramkę tak,
// jak przyjdzie z APNs: nagłówki, `aps.timestamp`, `event`, `stale-date`/`dismissal-date` i stan —
// produkcyjnym `LiveActivityPayload`. Ramkę banera (format Apple i klucz `rarog`) opisuje typ
// lokalny testu; cel tapnięcia z niej czyta `PushRouting` (`PushV3RoutingTests`).
// `aps.alert` ramki kafla (dźwięk „skończył”) czyta ActivityKit sam —
// `LiveActivityPayload` go nie dekoduje; test pilnuje, że to wyłącznie stała z serwera.
// Banery formatu 3 (`apns-v3/*.v3.json`): blok `rarog` to koperta (`PushEnvelope`), którą test otwiera
// PRODUKCYJNYM `PushCrypto` kluczem testowym ramek (32×`0x05`); wątek to skrót sesji (`topicFor`), a alert = tekst
// zastępczy z `mutable-content: 1`. A format 2 banner (block under the old key `legacyBlock`, `v: 2`) is a REJECTION
// case: the test builds it from the format 3 frame and the app does not see its own block in it. Jawny blok v1
// apka dalej przyjmuje (próbki inline: `ApnsPayloadTests`).
// Warianty z kluczami lokalizacji (w manifeście `"locKeys": true`): wpis z deklaracją `locKeys` dostaje tekst
// zastępczy banera (`title-loc-key`/`loc-key`) i dzwonek kafla (`{title: {loc-key}, body: {loc-key}}`) kluczami
// katalogu apki; ramka bazowa tych samych wejść nosi nazwę bez członu `.loc-keys`.
import CryptoKit
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("złote ramki APNs: Live Activity i banery")
struct ApnsFramesTests {
  struct Entry: Sendable, Decodable {
    let pushType: String
    let event: String?
    /// Ramka wpisu z deklaracją `locKeys`: tekst zastępczy i dzwonek kluczami katalogu apki.
    let locKeys: Bool?
  }

  /// Ramka `liveactivity`: nagłówki i ładunek produkcyjnym typem `LiveActivityPayload` — to, co
  /// ActivityKit dostaje w `aps`.
  struct LiveActivityFrame: Decodable {
    let headers: [String: String]
    let payload: LiveActivityPayload
  }

  /// Ramka `alert`: baner i cel tapnięcia w kluczu `rarog` poza `aps`; „skończył” to sama plakietka (bez `alert`).
  struct AlertFrame: Decodable {
    /// Tekst zastępczy literałem (`title`, `body`) albo kluczami katalogu apki (`title-loc-key`, `loc-key`).
    struct Alert: Decodable {
      let title: String?
      let body: String?
      let titleLocKey: String?
      let locKey: String?

      enum CodingKeys: String, CodingKey {
        case title, body
        case titleLocKey = "title-loc-key"
        case locKey = "loc-key"
      }
    }

    struct Aps: Decodable {
      let alert: Alert?
      let badge: Int?
      let sound: String?
      let threadId: String?
      let mutableContent: Int?

      enum CodingKeys: String, CodingKey {
        case alert, badge, sound
        case threadId = "thread-id"
        case mutableContent = "mutable-content"
      }
    }

    /// Blok `rarog` v1: cel tapnięcia jawnie.
    struct RarogV1: Decodable {
      let v: Int
      let kind: String
      let sessionId: String?
      let termId: String?
    }

    /// Blok `rarog`: v1 albo koperta v3 — wariant po `v`.
    enum Rarog: Decodable {
      case v1(RarogV1)
      case v3(PushEnvelope)

      private enum Key: String, CodingKey { case v }

      init(from decoder: any Decoder) throws {
        let version = try decoder.container(keyedBy: Key.self).decode(Int.self, forKey: .v)
        self = version == PushEnvelope.version ? .v3(try PushEnvelope(from: decoder)) : .v1(try RarogV1(from: decoder))
      }

      var v1: RarogV1? {
        if case let .v1(rarog) = self { rarog } else { nil }
      }

      var v3: PushEnvelope? {
        if case let .v3(envelope) = self { envelope } else { nil }
      }
    }

    struct Payload: Decodable {
      let aps: Aps
      let rarog: Rarog
    }

    let headers: [String: String]
    let payload: Payload
  }

  static func fixtures(_ path: String) -> URL {
    do {
      return try GoldenFrames.repoRoot().appending(path: path, directoryHint: .isDirectory)
    } catch {
      fatalError("złote ramki APNs: brak katalogu repo — \(error)")
    }
  }

  static func manifest(in directory: URL) -> [String: Entry] {
    do {
      let data = try Data(contentsOf: directory.appending(path: "manifest.json"))
      return try JSONDecoder().decode([String: Entry].self, from: data)
    } catch {
      fatalError("złote ramki APNs: nie da się wczytać manifestu \(directory.lastPathComponent) — \(error)")
    }
  }

  /// Live Activity frames.
  static let directory = fixtures("shared/fixtures/apns")
  static let manifest = manifest(in: directory)
  /// Banery formatu 3 — jedyne, które apka czyta.
  static let directoryV3 = fixtures("shared/fixtures/apns-v3")
  static let manifestV3 = manifest(in: directoryV3)
  /// Format 3 banners without the localization-key variant: one per kind.
  static let bannersV3 = [
    "alert.blocking.v3.json", "alert.device-paired.v3.json", "alert.done.v3.json", "alert.test.v3.json",
    "alert.version-changed.v3.json", "alert.weekly-limit.v3.json",
  ]
  /// Block key of the format 2 banner, which no code produces any more: a rejection case.
  static let legacyBlock = "pilot" // stara-nazwa

  static func data(_ name: String) throws -> Data {
    try Data(contentsOf: directory.appending(path: name))
  }

  static func dataV3(_ name: String) throws -> Data {
    try Data(contentsOf: directoryV3.appending(path: name))
  }

  static func live(_ name: String) throws -> LiveActivityFrame {
    try JSONDecoder().decode(LiveActivityFrame.self, from: data(name))
  }

  /// Baner formatu 3 z `apns-v3/`.
  static func alert(_ name: String) throws -> AlertFrame {
    try JSONDecoder().decode(AlertFrame.self, from: dataV3(name))
  }

  /// Ramki `liveactivity` z manifestu, posortowane.
  static var liveFrames: [String] {
    manifest.keys.sorted().filter { manifest[$0]?.pushType == "liveactivity" }
  }

  /// Dźwięk „skończył” z kafla — DOSŁOWNA kopia `LIVE_ACTIVITY_CHIME`
  /// z `server/src/notify/apns-payload.ts`. Kafel nie niesie treści: inny tekst to błąd kontraktu.
  static let chimeAlert: [String: String] = [
    "title": "Agent skończył", "body": "Wynik czeka w Rarogu", "sound": "skonczyl.caf",
  ]
  static let chimeFrame = "live-activity.update.chime.json"
  /// Ten sam dzwonek kluczami katalogu apki (wpis z `locKeys`) w postaci zagnieżdżonej kafla.
  static var chimeKeysAlert: NSDictionary {
    ["title": ["loc-key": "push.chime.title"], "body": ["loc-key": "push.chime.body"], "sound": "skonczyl.caf"]
  }
  static let chimeKeysFrame = "live-activity.update.chime.loc-keys.json"

  /// Klucz push TESTOWY ramek banerów (producent: `server/test/apns-fixtures-producenci.test.ts`).
  static let framePushKey = SymmetricKey(data: Data(repeating: 5, count: 32))

  /// `topicFor` serwera (`content.ts`): 32 znaki base64url `sha256(sessionId)` — wątek banera.
  static func topicFor(_ sessionId: String) -> String {
    let digest = Data(SHA256.hash(data: Data(sessionId.utf8))).base64EncodedString()
      .replacing("+", with: "-").replacing("/", with: "_").replacing("=", with: "")
    return String(digest.prefix(32))
  }

  /// Ramka formatu 3 otwarta produkcyjnym `PushCrypto`.
  static func opened(_ name: String) throws -> (frame: AlertFrame, plaintext: PushPlaintext) {
    let frame = try alert(name)
    let envelope = try #require(frame.payload.rarog.v3, "\(name): blok `rarog` to nie v3")
    return (frame, try PushCrypto.openPlaintext(envelope, pushKey: framePushKey))
  }

  @Test("manifest ↔ directory both ways (`apns/` and `apns-v3/`); `apns/` holds Live Activity only, `apns-v3/` v3 banners only: one per kind and the `locKeys` variants")
  func manifestMatchesDirectory() throws {
    for (directory, manifest) in [(Self.directory, Self.manifest), (Self.directoryV3, Self.manifestV3)] {
      let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        .filter { $0 != "manifest.json" }
        .sorted()
      #expect(files == manifest.keys.sorted(), "\(directory.lastPathComponent)")
    }
    #expect(Self.manifestV3.values.allSatisfy { $0.pushType == "alert" })
    #expect(Self.manifest.values.allSatisfy { $0.pushType == "liveactivity" })
    let base = Self.manifestV3.keys.filter { Self.manifestV3[$0]?.locKeys != true }.sorted()
    #expect(base == Self.bannersV3)
    // Wariant kluczy ma ramkę bazową tych samych wejść: tę samą nazwę bez `.loc-keys`.
    for (manifest, name) in [Self.manifest, Self.manifestV3].flatMap({ m in m.keys.map { (m, $0) } })
    where manifest[name]?.locKeys == true {
      #expect(manifest[name.replacing(".loc-keys", with: "")] != nil, "\(name): brak ramki bazowej")
    }
  }

  @Test("każda ramka dekoduje się w całości swoim rodzajem", arguments: ApnsFramesTests.manifest.keys.sorted())
  func frame(_ name: String) throws {
    let entry = try #require(Self.manifest[name])
    switch entry.pushType {
    case "liveactivity":
      let frame = try Self.live(name)
      #expect(frame.headers["apns-push-type"] == "liveactivity")
      #expect(frame.headers["apns-topic"] == "ai.rarog.app.push-type.liveactivity")
      #expect(frame.payload.aps.event.rawValue == entry.event)
      #expect(frame.payload.aps.contentState.updatedEpoch == frame.payload.aps.timestamp)
    default:
      Issue.record("nieznany rodzaj ramki \(entry.pushType)")
    }
  }

  /// Format 2 banner built from the format 3 frame of the same kind: the block under the old key with `v: 2`. The app
  /// sees no `rarog` block in it, and a `v: 2` block does not pass `PushEnvelope`. The refusal `koperta-formatu-2` in
  /// `PushCryptoTests` rejects the format 2 ciphertext under `v: 3`.
  @Test("format 2 banner: the app does not see its block, the `v: 2` envelope is rejected", arguments: ApnsFramesTests.bannersV3)
  func rejectsFormat2(_ name: String) throws {
    let raw = try JSONSerialization.jsonObject(with: Self.dataV3(name)) as? [String: Any]
    let current = try #require(raw?["payload"] as? [String: Any], "\(name): no `payload`")
    var block = try #require(current["rarog"] as? [String: Any], "\(name): no `rarog` block")
    block["v"] = 2
    let payload: [String: Any] = ["aps": current["aps"] as Any, Self.legacyBlock: block]
    let envelope = try JSONDecoder().decode(
      ApnsAlertEnvelope.self, from: JSONSerialization.data(withJSONObject: payload))
    #expect(envelope.rarog == nil, "\(name): the app sees its block in a format 2 frame")
    #expect(throws: (any Error).self, "\(name): koperta v2") {
      _ = try JSONDecoder().decode(PushEnvelope.self, from: JSONSerialization.data(withJSONObject: block))
    }
  }

  @Test("baner formatu 3 dekoduje się w całości: koperta v3, alert ⇔ nie „skończył”, wątek, `exp`",
        arguments: ApnsFramesTests.manifestV3.keys.sorted())
  func bannerV3(_ name: String) throws {
    #expect(name.hasSuffix(".v3.json"))
    let frame = try Self.alert(name)
    #expect(frame.headers["apns-push-type"] == "alert")
    guard case .v3 = frame.payload.rarog else {
      Issue.record("\(name): blok `rarog` to nie v3")
      return
    }
    let plaintext = try Self.opened(name).plaintext
    let aps = frame.payload.aps
    // Alert (tekst zastępczy z `mutable-content`) ⇔ rodzaj inny niż „skończył”; wątek = skrót sesji.
    #expect((aps.alert != nil) == (plaintext.kind != .done))
    #expect((aps.mutableContent == 1) == (aps.alert != nil))
    if let alert = aps.alert {
      if Self.manifestV3[name]?.locKeys == true {
        #expect(alert.titleLocKey == "push.placeholder.title" && alert.locKey == "push.placeholder.body", "\(name)")
        #expect(alert.title == nil && alert.body == nil, "\(name)")
      } else {
        #expect(alert.title == "Rarog" && alert.body == "Nowe powiadomienie", "\(name)")
        #expect(alert.titleLocKey == nil && alert.locKey == nil, "\(name)")
      }
      #expect(aps.sound == "default")
      #expect(aps.threadId == plaintext.sessionId.map(Self.topicFor))
    } else {
      #expect(aps.threadId == nil && aps.sound == nil)
    }
    #expect(String(plaintext.exp) == frame.headers["apns-expiration"])
  }

  @Test("Live Activity: seedy z limitami i Makiem, Codex do terminala, dwa przebiegi i „+N”, koniec bez treści")
  func liveActivityValues() throws {
    let update = try Self.live("live-activity.update.json").payload.aps
    #expect(update.event == .update && update.staleDate == update.timestamp + 900 && update.dismissalDate == nil)
    let seeds = update.contentState
    #expect(seeds.waiting == 2 && seeds.working == 2 && seeds.finished == 0)
    #expect(seeds.top == .init(sessionId: "demo-willow") && seeds.workflows == nil && seeds.moreWorkflows == nil)
    #expect(seeds.limits == .init(fiveHour: 42, weekly: 81) && seeds.mac == .init(cpu: 35, ram: 70, disk: 60))

    let codex = try Self.live("live-activity.update.codex.json").payload.aps.contentState
    #expect(codex.top == .init(sessionId: "demo-codex", termId: "0123456789abcdef"))
    #expect(codex.waiting == 1 && codex.limits == nil && codex.mac == nil)

    let workflow = try Self.live("live-activity.update.workflow.json").payload.aps.contentState
    // Sesja po turze z przebiegiem w locie „pracuje w tle" — praca, nie wynik do odebrania.
    #expect(workflow.waiting == 0 && workflow.working == 2 && workflow.finished == 0)
    #expect(workflow.top == .init(sessionId: "demo-atlas"))
    #expect(workflow.workflows == [
      .init(
        sessionId: "demo-rarog", project: "rarog", name: "audyt-docs", agents: 4, done: 3,
        phase: .init(index: 2, count: 3, title: "A2 Weryfikacja"), segments: [100, 50, 0],
        states: [.done, .running, .pending]),
      .init(sessionId: "demo-atlas", project: "atlas-web", name: "review-changes", agents: 3, done: 1, segments: [33]),
    ])
    #expect(workflow.moreWorkflows == 1)

    let end = try Self.live("live-activity.end.json").payload.aps
    #expect(end.event == .end && end.dismissalDate == end.timestamp && end.staleDate == nil)
    #expect(end.contentState == LiveActivityContentState(waiting: 0, working: 0, finished: 0, updatedEpoch: end.timestamp))
  }

  @Test("stan z ramki przeżywa lokalne kodowanie ActivityKit (round-trip)")
  func roundTrip() throws {
    for name in Self.liveFrames {
      let state = try Self.live(name).payload.aps.contentState
      let again = try JSONDecoder().decode(LiveActivityContentState.self, from: JSONEncoder().encode(state))
      #expect(again == state, "\(name)")
    }
  }

  /// Strażnik kompletu pól: `roundTrip` porównuje stan zdekodowany z ponownie
  /// zdekodowanym, więc pole, które Swift zgubi już przy PIERWSZYM dekodowaniu (nowe pole serwera bez pola
  /// w typie), przechodzi go po cichu. Tu oryginalny obiekt `aps.content-state` z pliku ramki staje obok
  /// wyniku `JSONEncoder` na zdekodowanym stanie — oba przez `JSONSerialization`, porównanie obiektów (kolejność
  /// kluczy bez znaczenia). Brakujące pole, `null` w miejscu braku albo inna liczba przewracają test.
  @Test("stan zakodowany przez Swift = obiekt `content-state` z ramki (żadne pole nie ginie)")
  func encodesBackToFrame() throws {
    for name in Self.liveFrames {
      let raw = try JSONSerialization.jsonObject(with: Self.data(name))
      let original = try #require(
        ((raw as? [String: Any])?["payload"] as? [String: Any])?["aps"] as? [String: Any], "\(name): brak `aps`")
      let frameState = try #require(original["content-state"] as? NSDictionary, "\(name): brak `content-state`")
      let state = try Self.live(name).payload.aps.contentState
      let encoded = try #require(
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? NSDictionary, "\(name): kodowanie")
      #expect(encoded == frameState, "\(name): Swift zakodował \(encoded), ramka ma \(frameState)")
    }
  }

  /// Tekst jawny banera po odszyfrowaniu i jawne pola ramki — wartości wejść producenta ramek
  /// (`server/test/apns-fixtures-producenci.test.ts`).
  /// Oczekiwany baner: tytuł i treść ramki (angielski tekst serwera) i ich tłumaczenie z `titleRef`/`bodyRef`
  /// rendererem `pl` — to samo zdanie, które pokazuje rozszerzenie powiadomień polskiej apki.
  struct ExpectedAlert: Sendable {
    let frame: String
    let kind: ApnsPushKind
    let title: String?
    let body: String?
    let titlePl: String?
    let bodyPl: String?
    let sessionId: String?
    let termId: String?
    let badge: Int?
    let priority: String
  }

  static let expectedAlerts = [
    ExpectedAlert(
      frame: "alert.blocking.v3.json", kind: .permission, title: "⏳ Waiting for permission · willow",
      body: "Edit — zapis notatek", titlePl: "⏳ Czeka na zgodę · willow", bodyPl: "Edit — zapis notatek",
      sessionId: "demo-willow", termId: nil, badge: 2, priority: "10"),
    // „Skończył” bez banera i dźwięku — sama plakietka (`frame` pilnuje `aps`).
    ExpectedAlert(
      frame: "alert.done.v3.json", kind: .done, title: nil, body: nil, titlePl: nil, bodyPl: nil,
      sessionId: "demo-codex", termId: "0123456789abcdef", badge: 0, priority: "5"),
    ExpectedAlert(
      frame: "alert.test.v3.json", kind: .test, title: "🔔 Notifications are working",
      body: "Tapping this opens Rarog. Notifications from sessions take you straight to the session.",
      titlePl: "🔔 Powiadomienia działają",
      bodyPl: "Tap otwiera Raroga. Powiadomienia z sesji prowadzą prosto do niej.", sessionId: nil, termId: nil,
      badge: nil, priority: "10"),
    // Sparowano nowe urządzenie: baner bez sesji i bez wątku.
    ExpectedAlert(
      frame: "alert.device-paired.v3.json", kind: .devicePaired, title: "🔐 New device paired",
      body: "iPad·Rarog. If this wasn't you, revoke it on the Mac: rarog devices",
      titlePl: "🔐 Sparowano nowe urządzenie",
      bodyPl: "iPad·Rarog — jeśli to nie Ty, odepnij je na Macu: rarog devices", sessionId: nil, termId: nil,
      badge: nil, priority: "10"),
  ]

  @Test("banery formatu 3: po odszyfrowaniu cel tapnięcia i treść z wejść producenta, plakietka i priorytet jawnie")
  func alertValues() throws {
    for expected in Self.expectedAlerts {
      let name = expected.frame
      let (frame, plaintext) = try Self.opened(name)
      #expect(plaintext.kind == expected.kind, "\(name)")
      #expect(plaintext.title == expected.title && plaintext.body == expected.body, "\(name)")
      #expect(plaintext.sessionId == expected.sessionId && plaintext.termId == expected.termId, "\(name)")
      #expect(frame.payload.aps.badge == expected.badge, "\(name)")
      #expect(frame.headers["apns-priority"] == expected.priority, "\(name)")
      #expect(frame.headers["apns-topic"] == "ai.rarog.app", "\(name)")
      #expect(frame.payload.rarog.v3?.kid == "f849d673", "\(name)")
    }
  }

  /// A new Claude Code or herdr version on the server (`version-changed`): the envelope and the plaintext pass the
  /// production `PushEnvelope`, `PushCrypto` and `PushPlaintext`, the kind is known, and the title, body and their
  /// codes survive. A push without a session: the tap target is the kind alone (the Settings "Server" page,
  /// `PushNote.opensSettings`).
  @Test("nowa wersja na serwerze (`alert.version-changed.v3.json`): rodzaj `versionChanged`, bez sesji, treść zostaje")
  func versionChanged() throws {
    let (frame, plaintext) = try Self.opened("alert.version-changed.v3.json")
    #expect(plaintext.kind == .versionChanged)
    #expect(plaintext.title == "🔄 Version changed")
    #expect(plaintext.body == "Claude Code 2.1.321 → 2.1.322, herdr 0.9.5 → 0.9.6")
    #expect(plaintext.sessionId == nil && plaintext.termId == nil)
    #expect(plaintext.titleRef == SentenceRef(code: "push.version-title"))
    #expect(
      plaintext.bodyRef == SentenceRef(code: "push.version-body.both", args: ["2.1.321", "2.1.322", "0.9.5", "0.9.6"]))
    #expect(frame.payload.aps.threadId == nil && frame.payload.aps.badge == nil)
    #expect(frame.headers["apns-priority"] == "10")
    #expect(PushOpen(plaintext) == PushOpen(kind: .versionChanged))
  }

  /// Weekly plan limit at 97% (`weekly-limit`): the envelope and the plaintext pass the production `PushEnvelope`,
  /// `PushCrypto` and `PushPlaintext`, the kind is known, and the title, the body and their codes survive. A sessionless
  /// push: the tap target is the kind alone (the session list, `PushNote.opensList`). With the catalog the `pl`
  /// renderer composes the Polish banner, the reset formatted with the app's date template.
  @Test("weekly limit (`alert.weekly-limit.v3.json`): kind `weeklyLimit`, no session, texts stay, Polish banner from the catalog")
  func weeklyLimit() throws {
    let reset = "2026-10-10T15:00:00.000Z"
    let (frame, opened) = try Self.opened("alert.weekly-limit.v3.json")
    var plaintext = opened
    #expect(plaintext.kind == .weeklyLimit)
    #expect(plaintext.title == "⚠️ Weekly limit at 97%")
    #expect(plaintext.body == "Resets \(reset).")
    #expect(plaintext.sessionId == nil && plaintext.termId == nil)
    #expect(plaintext.titleRef == SentenceRef(code: "push.weekly-limit-title", args: ["97"]))
    #expect(plaintext.bodyRef == SentenceRef(code: "push.weekly-limit-body", args: [reset]))
    #expect(frame.payload.aps.threadId == nil && frame.payload.aps.badge == nil)
    #expect(frame.headers["apns-priority"] == "10")
    #expect(frame.headers["apns-collapse-id"] == Self.topicFor("rarog:weekly-limit:\(reset)"))
    #expect(PushOpen(plaintext) == PushOpen(kind: .weeklyLimit))
    plaintext.translate(ServerText.renderer(language: .pl))
    let locale = CopyLocale.resolve(language: .pl, device: .current, isTestProcess: true)
    let date = Date(timeIntervalSince1970: 1_791_644_400)
    let when = CopyDate.string(date, template: "MMMdjmm", timeZone: .current, locale: locale)
    #expect(plaintext.title == "⚠️ Limit tygodniowy: 97%")
    #expect(plaintext.body == "Reset \(when).")
  }

  @Test("banery formatu 3 z kodami zdań: `titleRef`/`bodyRef` przy każdym tekście, renderer `pl` daje polski baner")
  func alertSentences() throws {
    for expected in Self.expectedAlerts {
      let name = expected.frame
      var plaintext = try Self.opened(name).plaintext
      #expect((plaintext.titleRef != nil) == (expected.title != nil), "\(name)")
      #expect((plaintext.bodyRef != nil) == (expected.body != nil), "\(name)")
      plaintext.translate(ServerText.renderer(language: .pl))
      #expect(plaintext.title == expected.titlePl && plaintext.body == expected.bodyPl, "\(name)")
    }
  }

  @Test("prywatność ekranu blokady: ramka Live Activity nie ma kluczy na treść")
  func privacy() throws {
    func keys(_ value: Any, into set: inout Set<String>) {
      if let dict = value as? [String: Any] {
        for (key, inner) in dict {
          set.insert(key)
          keys(inner, into: &set)
        }
      } else if let array = value as? [Any] {
        for inner in array { keys(inner, into: &set) }
      }
    }
    for name in Self.liveFrames {
      var found: Set<String> = []
      keys(try JSONSerialization.jsonObject(with: Self.data(name)), into: &found)
      #expect(found.isDisjoint(with: [
        "text", "summary", "lastSummary", "displayText", "command", "tool", "label", "kind", "description",
      ]), "\(name)")
    }
  }

  @Test("dźwięk „skończył”: alert tylko w ramce dźwięku, równy stałej, przy `update`; priorytet 10, wygaśnięcie 30 s")
  func chime() throws {
    var withAlert: [String] = []
    for name in Self.liveFrames {
      let raw = try JSONSerialization.jsonObject(with: Self.data(name))
      let aps = try #require(
        ((raw as? [String: Any])?["payload"] as? [String: Any])?["aps"] as? [String: Any], "\(name): brak `aps`")
      guard let alert = aps["alert"] else { continue }
      withAlert.append(name)
      if Self.manifest[name]?.locKeys == true {
        #expect(alert as? NSDictionary == Self.chimeKeysAlert, "\(name): alert inny niż klucze stałej")
      } else {
        #expect(alert as? [String: String] == Self.chimeAlert, "\(name): alert inny niż stała")
      }
      #expect(aps["event"] as? String == "update", "\(name): alert poza `update`")
    }
    #expect(withAlert == [Self.chimeFrame, Self.chimeKeysFrame])
    for name in [Self.chimeFrame, Self.chimeKeysFrame] {
      let frame = try Self.live(name)
      #expect(frame.payload.aps.event == .update, "\(name)")
      #expect(frame.headers["apns-priority"] == "10", "\(name)")
      #expect(frame.headers["apns-expiration"] == String(frame.payload.aps.timestamp + 30), "\(name)")
    }
  }
}
