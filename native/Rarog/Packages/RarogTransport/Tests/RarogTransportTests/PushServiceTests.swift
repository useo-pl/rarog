// Logika rozszerzenia powiadomień (NSE) jako czysta funkcja: `PushServiceDecision.decide` na wektorach
// `shared/fixtures/push-crypto/vectors.v3.json` (format 3, produkuje je serwer), na złotej ramce banera
// `shared/fixtures/apns-v3/` (kody zdań `titleRef`/`bodyRef`) i na kopertach złożonych tutaj CryptoKitem
// (granica `exp + 300 s`, tekst jawny spoza kontraktu). Każda odmowa = oryginał z powodem, nigdy treść. Strażnik
// „handler dokładnie raz” (`OnceHandler`): zwykły koniec, koniec czasu, oba w dowolnej kolejności i naraz.
import CryptoKit
import Foundation
import RarogContract
import RarogContractFixtures
import RarogTransport
import Synchronization
import Testing

/// Klucze push po `kid` (atrapa czytnika): stała mapa albo jeden klucz dla każdego `kid`.
struct StaticKeys: PushKeyReader {
  var keys: [String: String] = [:]
  var any: String?
  var read: PushKeyRead?

  func pushKey(kid: String) -> PushKeyRead {
    if let read { return read }
    if let any { return .found(Data(any.utf8)) }
    return keys[kid].map { .found(Data($0.utf8)) } ?? PushKeyRead.none
  }
}

/// Dziennik wywołań handlera (atrapa systemu) — klasa, bo domknięcie handlera ucieka.
final class Calls<Value: Sendable>: Sendable {
  private let values = Mutex<[Value]>([])

  func append(_ value: Value) { values.withLock { $0.append(value) } }
  var all: [Value] { values.withLock { $0 } }
}

@Suite("NSE: decyzja dla banera v3 i strażnik handlera")
struct PushServiceTests {
  struct Vectors: Decodable {
    struct Expect: Decodable {
      let kind: String?
      let title: String?
      let body: String?
      let sessionId: String?
      let termId: String?
      let exp: Int
      let titleRef: SentenceRef?
      let bodyRef: SentenceRef?
    }

    struct Vector: Decodable {
      let name: String
      let pushKey: String
      let kid: String
      let n: String
      let c: String
      let expect: Expect
    }

    struct Envelope: Decodable {
      let v: Int
      let kid: String
      let n: String
      let c: String
    }

    struct Refusal: Decodable {
      let name: String
      let pushKey: String
      let envelope: Envelope
      let reason: String
    }

    let vectors: [Vector]
    let refusals: [Refusal]
  }

  static let file: Vectors = {
    do {
      let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/push-crypto/vectors.v3.json")
      return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    } catch {
      fatalError("wektory push-crypto: nie da się wczytać — \(error)")
    }
  }()

  /// Ładunek APNs v3 jak z serwera: tekst zastępczy w `aps.alert`, koperta w `rarog`, obcy klucz obok.
  static func userInfo(kid: String, n: String, c: String, version: Int = PushEnvelope.version) -> [AnyHashable: Any] {
    [
      "aps": [
        "alert": ["title": "Rarog", "body": "Nowe powiadomienie"], "mutable-content": 1, "sound": "default",
        "thread-id": "K1UbPufYGQNxj5QMe6m9nJVxH6axfrOP",
      ],
      "rarog": ["v": version, "kid": kid, "n": n, "c": c],
      "inny": "zostaje",
    ]
  }

  static func vector(_ name: String) throws -> Vectors.Vector {
    try #require(file.vectors.first { $0.name == name })
  }

  static func keys(for vector: Vectors.Vector) -> StaticKeys {
    StaticKeys(keys: [vector.kid: vector.pushKey])
  }

  static func at(_ seconds: Int) -> Date { Date(timeIntervalSince1970: TimeInterval(seconds)) }

  /// Koperta z dowolnym tekstem jawnym, szyfrowana parametrami formatu 3 (klucz 32×0x05, `kid` `f849d673`).
  static func sealed(_ plaintext: String) throws -> [AnyHashable: Any] {
    let pushKey = try PushCrypto.pushKey(base64URL: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU")
    let box = try ChaChaPoly.seal(
      Data(plaintext.utf8), using: PushCrypto.bannerKey(pushKey: pushKey), nonce: ChaChaPoly.Nonce(data: Data(count: 12)),
      authenticating: PushCrypto.aad(kid: "f849d673"))
    let nonce = box.nonce.withUnsafeBytes { Data($0) }
    return userInfo(kid: "f849d673", n: base64URL(nonce), c: base64URL(box.ciphertext + box.tag))
  }

  static func base64URL(_ data: Data) -> String {
    data.base64EncodedString().replacing("+", with: "-").replacing("/", with: "_").replacing("=", with: "")
  }

  static let ownKeys = StaticKeys(keys: ["f849d673": "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU"])

  /// Tłumacz NSE w testach: `pl`, niezależnie od języka procesu.
  static let polish = ServerText.renderer(language: .pl)

  @Test("wektory z alertem bez `*Ref`: tytuł i treść podstawione bez zmian, `rarogOpen` = rodzaj i cel (polskie znaki, emoji, ZWJ)")
  func vectorsReplace() throws {
    let alerts = Self.file.vectors.filter { $0.expect.title != nil && $0.expect.titleRef == nil && $0.expect.bodyRef == nil }
    #expect(alerts.count >= 4)
    for vector in alerts {
      let decision = PushServiceDecision.decide(
        userInfo: Self.userInfo(kid: vector.kid, n: vector.n, c: vector.c), keys: Self.keys(for: vector),
        now: Self.at(vector.expect.exp), renderer: Self.polish)
      let open = PushOpen(
        kind: vector.expect.kind.flatMap(ApnsPushKind.init(rawValue:)), sessionId: vector.expect.sessionId,
        termId: vector.expect.termId)
      #expect(
        decision == .replace(title: try #require(vector.expect.title), body: try #require(vector.expect.body), open: open),
        "\(vector.name)")
    }
  }

  @Test("wektor v3 z `titleRef`/`bodyRef`: tytuł i treść po polsku (godzina z argumentu), stary `exp` — oryginał")
  func vectorWithRefs() throws {
    let vector = try Self.vector("limit-zdania-z-kodem")
    let userInfo = Self.userInfo(kid: vector.kid, n: vector.n, c: vector.c)
    #expect(vector.expect.titleRef != nil && vector.expect.bodyRef != nil)
    let decision = PushServiceDecision.decide(
      userInfo: userInfo, keys: Self.keys(for: vector), now: Self.at(vector.expect.exp), renderer: Self.polish)
    guard case let .replace(title, body, open) = decision else {
      Issue.record("oczekiwano podstawienia, jest \(decision)")
      return
    }
    #expect(title == "Rarog")
    #expect(body.wholeMatch(of: /Limit planu — spróbuj po \d{1,2}:\d{2}\./) != nil, "\(body)")
    #expect(open == PushOpen(kind: .limit, sessionId: vector.expect.sessionId))
    #expect(PushServiceDecision.decide(
      userInfo: userInfo, keys: Self.keys(for: vector), now: Self.at(vector.expect.exp + 301), renderer: Self.polish)
      == .keep(.expired))
  }

  @Test("pełna droga: baner błędu sesji z `buildContent` serwera → renderer `pl` → polski tytuł i treść")
  func sessionErrorFromServer() throws {
    let vector = try Self.vector("blad-sesji-z-buildcontent")
    #expect(vector.expect.titleRef?.code == "push.title.error" && vector.expect.bodyRef?.code == "state.driver-error")
    let userInfo = Self.userInfo(kid: vector.kid, n: vector.n, c: vector.c)
    let open = PushOpen(kind: .error, sessionId: vector.expect.sessionId)
    #expect(PushServiceDecision.decide(
      userInfo: userInfo, keys: Self.keys(for: vector), now: Self.at(vector.expect.exp), renderer: Self.polish)
      == .replace(title: "❌ Błąd · willow", body: "silnik zakończył pracę błędem", open: open))
    // Ten sam szyfrogram w apce angielskiej: tekst serwera.
    #expect(PushServiceDecision.decide(
      userInfo: userInfo, keys: Self.keys(for: vector), now: Self.at(vector.expect.exp),
      renderer: ServerText.renderer(language: .en))
      == .replace(title: "❌ Error · willow", body: "the engine finished with an error", open: open))
  }

  @Test("nieznany kod w `bodyRef` albo zła liczba argumentów: angielski tekst serwera; znany `titleRef` tłumaczony")
  func unknownSentenceCode() throws {
    let plaintext = #"{"kind":"error","title":"❌ Error · willow","titleRef":{"code":"push.title.error","args":["willow"]},"#
      + #""body":"Something new happened.","bodyRef":{"code":"push.body.nowy-kod"},"sessionId":"s1","exp":1791367800}"#
    #expect(PushServiceDecision.decide(
      userInfo: try Self.sealed(plaintext), keys: Self.ownKeys, now: Self.at(1_791_367_800), renderer: Self.polish)
      == .replace(title: "❌ Błąd · willow", body: "Something new happened.", open: PushOpen(kind: .error, sessionId: "s1")))
    let wrongArgs = #"{"kind":"error","title":"❌ Error · willow","titleRef":{"code":"push.title.error"},"#
      + #""body":"x","sessionId":"s1","exp":1791367800}"#
    #expect(PushServiceDecision.decide(
      userInfo: try Self.sealed(wrongArgs), keys: Self.ownKeys, now: Self.at(1_791_367_800), renderer: Self.polish)
      == .replace(title: "❌ Error · willow", body: "x", open: PushOpen(kind: .error, sessionId: "s1")))
  }

  @Test("złota ramka zgody z serwera (`apns-v3/alert.blocking.v3.json`): renderer `pl` składa polski baner z `*Ref`")
  func blockingFrameFromServer() throws {
    let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/apns-v3/alert.blocking.v3.json")
    let document = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
    let payload = try #require(document?["payload"] as? [String: Any])
    let userInfo = Dictionary(uniqueKeysWithValues: payload.map { (AnyHashable($0.key), $0.value) })
    #expect(PushServiceDecision.decide(
      userInfo: userInfo, keys: Self.ownKeys, now: Self.at(1_791_367_800 - 3600), renderer: Self.polish)
      == .replace(
        title: "⏳ Czeka na zgodę · willow", body: "Edit — zapis notatek",
        open: PushOpen(kind: .permission, sessionId: "demo-willow")))
  }

  /// `version-changed` (nowa wersja Claude Code i herdr na serwerze): NSE podstawia tytuł i treść z tekstu
  /// jawnego, a `rarogOpen` niesie sam rodzaj bez sesji (tap otwiera ekran „Serwer”). Renderer, który kodów nie zna
  /// (apka z katalogiem sprzed tych zdań), zostawia tekst serwera.
  @Test("nowa wersja na serwerze (`apns-v3/alert.version-changed.v3.json`): NSE podstawia tytuł i treść, rodzaj bez sesji")
  func versionChangedFrameFromServer() throws {
    let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/apns-v3/alert.version-changed.v3.json")
    let document = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
    let payload = try #require(document?["payload"] as? [String: Any])
    let userInfo = Dictionary(uniqueKeysWithValues: payload.map { (AnyHashable($0.key), $0.value) })
    let now = Self.at(1_791_367_800 - 3600)
    let body = "Claude Code 2.1.321 → 2.1.322, herdr 0.9.5 → 0.9.6"
    #expect(PushServiceDecision.decide(userInfo: userInfo, keys: Self.ownKeys, now: now, renderer: { text, _ in text })
      == .replace(title: "🔄 Version changed", body: body, open: PushOpen(kind: .versionChanged)))
    #expect(PushServiceDecision.decide(userInfo: userInfo, keys: Self.ownKeys, now: now, renderer: Self.polish)
      == .replace(title: "🔄 Zmiana wersji", body: body, open: PushOpen(kind: .versionChanged)))
  }

  /// `weekly-limit` (weekly plan limit at 97%): the NSE replaces the title and the body from the plaintext, and
  /// `rarogOpen` carries the kind alone, without a session (a tap opens the session list). A renderer that does not know
  /// the codes keeps the server text; the `pl` renderer gives the Polish banner.
  @Test("weekly limit (`apns-v3/alert.weekly-limit.v3.json`): NSE replaces title and body, the kind without a session")
  func weeklyLimitFrameFromServer() throws {
    let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/apns-v3/alert.weekly-limit.v3.json")
    let document = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
    let payload = try #require(document?["payload"] as? [String: Any])
    let userInfo = Dictionary(uniqueKeysWithValues: payload.map { (AnyHashable($0.key), $0.value) })
    let now = Self.at(1_791_367_800 - 3600)
    let open = PushOpen(kind: .weeklyLimit)
    #expect(PushServiceDecision.decide(userInfo: userInfo, keys: Self.ownKeys, now: now, renderer: { text, _ in text })
      == .replace(title: "⚠️ Weekly limit at 97%", body: "Resets 2026-10-10T15:00:00.000Z.", open: open))
    let reset = Date(timeIntervalSince1970: 1_791_644_400)
    let locale = CopyLocale.resolve(language: .pl, device: .current, isTestProcess: true)
    let when = CopyDate.string(reset, template: "MMMdjmm", timeZone: .current, locale: locale)
    #expect(PushServiceDecision.decide(userInfo: userInfo, keys: Self.ownKeys, now: now, renderer: Self.polish)
      == .replace(title: "⚠️ Limit tygodniowy: 97%", body: "Reset \(when).", open: open))
  }

  @Test("nieznany rodzaj: podstawienie z `rarogOpen` bez rodzaju, cel tapnięcia przeżywa")
  func unknownKind() throws {
    let vector = try Self.vector("nieznany-rodzaj")
    let decision = PushServiceDecision.decide(
      userInfo: Self.userInfo(kid: vector.kid, n: vector.n, c: vector.c), keys: Self.keys(for: vector),
      now: Self.at(vector.expect.exp))
    #expect(decision == .replace(
      title: "Nowy rodzaj", body: "Serwer nowszy niż apka",
      open: PushOpen(kind: nil, sessionId: "a1b2c3d4-0000-4000-8000-000000000001")))
  }

  @Test("sama plakietka („skończył”): bez tytułu i treści — oryginał")
  func withoutAlert() throws {
    let vector = try Self.vector("skonczyl-bez-tytulu")
    let decision = PushServiceDecision.decide(
      userInfo: Self.userInfo(kid: vector.kid, n: vector.n, c: vector.c), keys: Self.keys(for: vector),
      now: Self.at(vector.expect.exp))
    #expect(decision == .keep(.withoutAlert))
  }

  @Test("granica świeżości `exp + 300 s`: przed i równo — podstawienie, po — oryginał")
  func freshness() throws {
    let vector = try Self.vector("probny-bez-sesji")
    let userInfo = Self.userInfo(kid: vector.kid, n: vector.n, c: vector.c)
    let keys = Self.keys(for: vector)
    let exp = vector.expect.exp
    let fresh = PushServiceDecision.replace(
      title: "🔔 Powiadomienia działają", body: "Tap otwiera Raroga.", open: PushOpen(kind: .test))
    #expect(PushServiceDecision.decide(userInfo: userInfo, keys: keys, now: Self.at(exp - 3600)) == fresh)
    #expect(PushServiceDecision.decide(userInfo: userInfo, keys: keys, now: Self.at(exp + 299)) == fresh)
    #expect(PushServiceDecision.decide(userInfo: userInfo, keys: keys, now: Self.at(exp + 300)) == fresh)
    #expect(PushServiceDecision.decide(userInfo: userInfo, keys: keys, now: Self.at(exp + 301)) == .keep(.expired))
    #expect(PushServiceDecision.decide(
      userInfo: userInfo, keys: keys, now: Date(timeIntervalSince1970: TimeInterval(exp) + 300.001)) == .keep(.expired))
  }

  @Test("podstawienie zostawia resztę `userInfo`: `aps`, blok `rarog` v3 i obce klucze; dochodzi tylko `rarogOpen`")
  func keepsOtherFields() throws {
    let vector = try Self.vector("zgoda-polskie-znaki")
    let userInfo = Self.userInfo(kid: vector.kid, n: vector.n, c: vector.c)
    let decision = PushServiceDecision.decide(userInfo: userInfo, keys: Self.keys(for: vector), now: Self.at(1))
    guard case let .replace(_, _, open) = decision else {
      Issue.record("oczekiwano podstawienia, jest \(decision)")
      return
    }
    let result = open.adding(to: userInfo)
    #expect(Set(result.keys) == Set(userInfo.keys).union([PushOpen.userInfoKey]))
    #expect(result["inny"] as? String == "zostaje")
    #expect(result["rarog"] as? [String: AnyHashable] == userInfo["rarog"] as? [String: AnyHashable])
    #expect(result["aps"] as? [String: AnyHashable] == userInfo["aps"] as? [String: AnyHashable])
    #expect(PushOpen(userInfoValue: result[PushOpen.userInfoKey]) == open)
  }

  @Test("odmowy wektorów: koperta spoza reguł → walidacja przed szyfrem, AEAD → porażka uwierzytelnienia")
  func vectorRefusals() {
    #expect(Self.file.refusals.count >= 10)
    for refusal in Self.file.refusals {
      let envelope = refusal.envelope
      let decision = PushServiceDecision.decide(
        userInfo: Self.userInfo(kid: envelope.kid, n: envelope.n, c: envelope.c, version: envelope.v),
        keys: StaticKeys(any: refusal.pushKey), now: Self.at(1))
      let expected: PushRefusal = refusal.reason == "envelope" ? .envelopeInvalid : .authenticationFailed
      #expect(decision == .keep(expected), "\(refusal.name)")
    }
  }

  @Test("odmowy: v ≠ 3, brak klucza dla `kid`, Keychain zablokowany i z błędem, klucz spoza 32 B, tekst jawny zły")
  func refusals() throws {
    let vector = try Self.vector("zgoda-polskie-znaki")
    let v3 = Self.userInfo(kid: vector.kid, n: vector.n, c: vector.c)
    let now = Self.at(vector.expect.exp)
    // Koperta pod `v: 2` (format 2) i `v: 4` to nie nasz baner: oryginał bez próby otwarcia.
    let notV3: [[AnyHashable: Any]] = [
      [:], ["aps": ["alert": "cudzy"]], ["rarog": "v3"], ["rarog": ["kind": "done"]],
      ["rarog": ["v": 1, "kind": "permission", "sessionId": "s-1"]], ["rarog": ["v": true, "kid": vector.kid]],
      Self.userInfo(kid: vector.kid, n: vector.n, c: vector.c, version: 2),
      Self.userInfo(kid: vector.kid, n: vector.n, c: vector.c, version: 4),
    ]
    for userInfo in notV3 {
      #expect(PushServiceDecision.decide(userInfo: userInfo, keys: Self.keys(for: vector), now: now) == .keep(.notV3))
    }
    #expect(PushServiceDecision.decide(userInfo: v3, keys: StaticKeys(), now: now) == .keep(.keyMissing))
    #expect(PushServiceDecision.decide(userInfo: v3, keys: StaticKeys(keys: ["00000000": vector.pushKey]), now: now)
      == .keep(.keyMissing), "zły kid: klucz innego urządzenia")
    #expect(PushServiceDecision.decide(userInfo: v3, keys: StaticKeys(read: .locked), now: now)
      == .keep(.keychainLocked), "errSecInteractionNotAllowed")
    #expect(PushServiceDecision.decide(userInfo: v3, keys: StaticKeys(read: .failed(-34_018)), now: now)
      == .keep(.keychainFailed(-34_018)))
    #expect(PushServiceDecision.decide(userInfo: v3, keys: StaticKeys(keys: [vector.kid: "BQUF"]), now: now)
      == .keep(.keyInvalid))
    let otherKey = "CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo"
    #expect(PushServiceDecision.decide(userInfo: v3, keys: StaticKeys(keys: [vector.kid: otherKey]), now: now)
      == .keep(.authenticationFailed))
    // Tekst jawny spoza kontraktu (bez `exp`, termId spoza TERM_ID_RE, nie JSON) — walidacja po odszyfrowaniu.
    for plaintext in [#"{"kind":"blocked","title":"t","body":"b"}"#,
                      #"{"kind":"blocked","title":"t","body":"b","termId":"../x","exp":1}"#, "nie json"] {
      #expect(PushServiceDecision.decide(userInfo: try Self.sealed(plaintext), keys: Self.ownKeys, now: Self.at(1))
        == .keep(.plaintextInvalid), "\(plaintext)")
    }
    #expect(PushServiceDecision.decide(
      userInfo: try Self.sealed(#"{"kind":"blocked","title":"t","body":"b","exp":10}"#), keys: Self.ownKeys,
      now: Self.at(10)) == .replace(title: "t", body: "b", open: PushOpen(kind: .blocked)))
  }

  @Test("„handler dokładnie raz”: zwykły koniec, koniec czasu, oba w dowolnej kolejności")
  func onceHandler() {
    let calls = Calls<String>()
    let normal = OnceHandler<String> { calls.append($0) }
    #expect(normal("podstawiony"))
    #expect(!normal("oryginał"), "koniec czasu po zwykłym końcu nic nie robi")
    #expect(calls.all == ["podstawiony"])

    let late = Calls<String>()
    let expired = OnceHandler<String> { late.append($0) }
    #expect(expired("oryginał"))
    #expect(!expired("podstawiony"), "spóźnione podstawienie po końcu czasu nic nie robi")
    #expect(late.all == ["oryginał"])
  }

  @Test("„handler dokładnie raz”: wywołania naraz z wielu wątków — jedno przechodzi")
  func onceHandlerConcurrent() async {
    let calls = Calls<Int>()
    let once = OnceHandler<Int> { calls.append($0) }
    let delivered = await withTaskGroup(of: Bool.self) { group in
      for index in 0..<64 { group.addTask { once(index) } }
      var total = 0
      for await result in group where result { total += 1 }
      return total
    }
    #expect(delivered == 1)
    #expect(calls.all.count == 1)
  }
}
