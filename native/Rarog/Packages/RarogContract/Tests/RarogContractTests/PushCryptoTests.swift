// Szyfr i koperta banera formatu 3 po stronie apki — `PushCrypto` i `PushEnvelope` na wektorach
// `shared/fixtures/push-crypto/vectors.v3.json` (produkuje je `server/test/notify-push-crypto.test.ts`).
//
// - Sekcja `rfc` (RFC 5869 A.1 i RFC 8439 §2.8.2) jest wpisana ręcznie z RFC: CryptoKit liczy ją tu niezależnie
//   od Node — sprawdzian spoza obu implementacji protokołu.
// - Wektory protokołu: klucz po HKDF, otwarcie, dopełnienie do kubełka, tekst jawny (polskie znaki, emoji
//   4-bajtowe, ZWJ, nieznany rodzaj z celem tapnięcia, sufit 2 KB).
// - Odmowy: koperta odrzucona przed szyfrem albo otwarcie bez powodzenia — zawsze błąd, nigdy treść.
// - Format 2: the app does not open it — a `v: 2` envelope is rejected before the cipher (`envelopeVersion`), and the
//   format 2 ciphertext under `v: 3` (refusal `koperta-formatu-2`, sealed by the producer) fails AEAD (other `info`
//   and AAD).
import CryptoKit
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("szyfr banera formatu 3: wektory RFC i protokołu, odmowy, format 2 odrzucony")
struct PushCryptoTests {
  struct Vectors: Decodable, Sendable {
    struct Rfc: Decodable, Sendable {
      struct Hkdf: Decodable, Sendable {
        let ikm: String
        let salt: String
        let info: String
        let length: Int
        let prk: String
        let okm: String
      }

      struct Aead: Decodable, Sendable {
        let key: String
        let nonce: String
        let aad: String
        let plaintext: String
        let ciphertext: String
        let tag: String
      }

      let hkdf: Hkdf
      let aead: Aead
    }

    struct ProtocolSection: Decodable, Sendable {
      let info: String
      let aadPrefix: String
      let salt: String
      let bucketBytes: Int
      let maxPlaintextBytes: Int
      let nonceBytes: Int
      let tagBytes: Int
    }

    struct Expect: Decodable, Sendable {
      let kind: String?
      let title: String?
      let body: String?
      let sessionId: String?
      let termId: String?
      let exp: Int
    }

    struct Vector: Decodable, Sendable, CustomTestStringConvertible {
      let name: String
      let pushKey: String
      let kid: String
      let bannerKey: String
      let n: String
      let aad: String
      let plaintext: String
      let paddedBytes: Int
      let c: String
      let cLengthMod4: Int
      let expect: Expect
      var testDescription: String { name }
    }

    struct Envelope: Codable, Sendable {
      let v: Int
      let kid: String
      let n: String
      let c: String
    }

    struct Refusal: Decodable, Sendable, CustomTestStringConvertible {
      let name: String
      let pushKey: String
      let envelope: Envelope
      let reason: String
      var testDescription: String { name }
    }

    let rfc: Rfc
    let `protocol`: ProtocolSection
    let vectors: [Vector]
    let refusals: [Refusal]
  }

  static func load(_ name: String) -> Vectors {
    do {
      let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/push-crypto/\(name)")
      return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    } catch {
      fatalError("wektory push-crypto \(name): nie da się wczytać — \(error)")
    }
  }

  /// Wektory formatu 3 — jedynego, który apka otwiera.
  static let file = load("vectors.v3.json")

  static func hex(_ text: String) -> Data {
    var data = Data()
    var index = text.startIndex
    while index < text.endIndex {
      let next = text.index(index, offsetBy: 2)
      data.append(UInt8(text[index..<next], radix: 16) ?? 0)
      index = next
    }
    return data
  }

  static func hexString(_ data: some Sequence<UInt8>) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }

  static func envelope(_ value: Vectors.Envelope) throws -> PushEnvelope {
    try JSONDecoder().decode(PushEnvelope.self, from: JSONEncoder().encode(value))
  }

  static func envelope(of vector: Vectors.Vector) throws -> PushEnvelope {
    try envelope(.init(v: PushEnvelope.version, kid: vector.kid, n: vector.n, c: vector.c))
  }

  // MARK: - RFC

  @Test("RFC 5869 A.1: HKDF-SHA256 w CryptoKit (PRK i OKM)")
  func rfcHkdf() {
    let rfc = Self.file.rfc.hkdf
    let prk = HKDF<SHA256>.extract(inputKeyMaterial: SymmetricKey(data: Self.hex(rfc.ikm)), salt: Self.hex(rfc.salt))
    #expect(Self.hexString(Data(prk)) == rfc.prk)
    let okm = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: Self.hex(rfc.ikm)), salt: Self.hex(rfc.salt), info: Self.hex(rfc.info),
      outputByteCount: rfc.length)
    #expect(okm.withUnsafeBytes { Self.hexString($0) } == rfc.okm)
  }

  @Test("RFC 8439 §2.8.2: ChaCha20-Poly1305 w CryptoKit (szyfrogram, tag, otwarcie)")
  func rfcAead() throws {
    let rfc = Self.file.rfc.aead
    let key = SymmetricKey(data: Self.hex(rfc.key))
    let box = try ChaChaPoly.seal(
      Data(rfc.plaintext.utf8), using: key, nonce: ChaChaPoly.Nonce(data: Self.hex(rfc.nonce)),
      authenticating: Self.hex(rfc.aad))
    #expect(Self.hexString(box.ciphertext) == rfc.ciphertext)
    #expect(Self.hexString(box.tag) == rfc.tag)
    #expect(try ChaChaPoly.open(box, using: key, authenticating: Self.hex(rfc.aad)) == Data(rfc.plaintext.utf8))
  }

  // MARK: - Protokół

  @Test("stałe protokołu = sekcja `protocol` wektorów; sól pusta = 32 bajty zera")
  func constants() throws {
    let section = Self.file.protocol
    #expect(section.info == PushCrypto.keyInfo && section.aadPrefix == PushCrypto.aadPrefix && section.salt.isEmpty)
    #expect(section.bucketBytes == PushCrypto.plaintextBucketBytes)
    #expect(section.maxPlaintextBytes == PushCrypto.plaintextMaxBytes)
    #expect(section.nonceBytes == PushCrypto.nonceBytes && section.tagBytes == PushCrypto.tagBytes)
    let ikm = try PushCrypto.pushKey(base64URL: try #require(Self.file.vectors.first).pushKey)
    let zeros = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: ikm, salt: Data(count: 32), info: Data(PushCrypto.keyInfo.utf8), outputByteCount: 32)
    #expect(PushCrypto.bannerKey(pushKey: ikm) == zeros)
  }

  @Test("pokrycie wektorów: reszta 2 i 3 mod 4 długości `c`, sufit 2 KB, nieznany rodzaj")
  func coverage() {
    let vectors = Self.file.vectors
    #expect(Set(vectors.map(\.cLengthMod4)).isSuperset(of: [2, 3]))
    #expect(vectors.contains { $0.paddedBytes == PushCrypto.plaintextMaxBytes })
    #expect(vectors.contains { $0.expect.kind == nil })
  }

  @Test("wektor: klucz po HKDF, otwarcie, dopełnienie spacjami, tekst jawny", arguments: PushCryptoTests.file.vectors)
  func vector(_ vector: Vectors.Vector) throws {
    let pushKey = try PushCrypto.pushKey(base64URL: vector.pushKey)
    #expect(PushCrypto.bannerKey(pushKey: pushKey).withUnsafeBytes { Self.hexString($0) } == vector.bannerKey)
    let envelope = try Self.envelope(of: vector)
    #expect(envelope.kid == vector.kid && envelope.nonce.count == 12)
    #expect(PushCrypto.aad(kid: envelope.kid) == Data(vector.aad.utf8))
    let raw = try PushCrypto.open(envelope, pushKey: pushKey)
    #expect(raw.count == vector.paddedBytes && raw.count % PushCrypto.plaintextBucketBytes == 0)
    let text = try #require(String(data: raw, encoding: .utf8))
    #expect(text.hasPrefix(vector.plaintext))
    #expect(text.dropFirst(vector.plaintext.count).allSatisfy { $0 == " " })
    let plaintext = try PushCrypto.openPlaintext(envelope, pushKey: pushKey)
    let want = vector.expect
    #expect(plaintext.kind == want.kind.flatMap(ApnsPushKind.init(rawValue:)))
    #expect(plaintext.title == want.title && plaintext.body == want.body)
    #expect(plaintext.sessionId == want.sessionId && plaintext.termId == want.termId && plaintext.exp == want.exp)
  }

  @Test("odmowa: koperta przed szyfrem albo otwarcie bez powodzenia", arguments: PushCryptoTests.file.refusals)
  func refusal(_ refusal: Vectors.Refusal) throws {
    if refusal.reason == "envelope" {
      #expect(throws: (any Error).self) { _ = try Self.envelope(refusal.envelope) }
      return
    }
    let envelope = try Self.envelope(refusal.envelope)
    let key = try PushCrypto.pushKey(base64URL: refusal.pushKey)
    #expect(throws: PushCrypto.Failure.authenticationFailed) { _ = try PushCrypto.open(envelope, pushKey: key) }
  }

  // MARK: - Klucz z Keychaina

  @Test("wartość wpisu Keychaina (tekst base64url w UTF-8) → ten sam klucz; zła wartość → `keyInvalid`")
  func keychainValue() throws {
    let vector = try #require(Self.file.vectors.first)
    let fromKeychain = try PushCrypto.pushKey(keychainValue: Data(vector.pushKey.utf8))
    #expect(fromKeychain == (try PushCrypto.pushKey(base64URL: vector.pushKey)))
    // Nie UTF-8, 31 bajtów, dopełnienie `=`, alfabet standardowy (`+`), długość niemożliwa w base64, pusto.
    for bad in [
      Data([0xFF, 0xFE]), Data(String(vector.pushKey.dropLast()).utf8), Data((vector.pushKey + "=").utf8),
      Data(("+" + vector.pushKey.dropFirst()).utf8), Data("A".utf8), Data(),
    ] {
      #expect(throws: PushCrypto.Failure.keyInvalid) { _ = try PushCrypto.pushKey(keychainValue: bad) }
    }
  }

  // MARK: - Tekst jawny

  private func plaintext(_ json: String) throws -> PushPlaintext {
    try JSONDecoder().decode(PushPlaintext.self, from: Data(json.utf8))
  }

  @Test("tekst jawny: nieznany rodzaj = `nil`, cel przeżywa; spacje za JSON-em tolerowane")
  func plaintextTolerance() throws {
    let unknown = try plaintext(#"{"kind":"nowy","sessionId":"s-9","termId":"0123456789abcdef","exp":1}   "#)
    #expect(unknown.kind == nil && unknown.sessionId == "s-9" && unknown.termId == "0123456789abcdef")
    let done = try plaintext(#"{"kind":"done","sessionId":"s","exp":5}"#)
    #expect(done.kind == .done && done.title == nil && done.body == nil && done.exp == 5)
  }

  @Test("tekst jawny: brak rodzaju albo `exp`, `null`, pusta sesja, zły terminal, pole ponad sufit — odrzucony")
  func plaintextRejections() {
    let long = String(repeating: "ż", count: PushPlaintext.maxFieldBytes / 2 + 1)
    for json in [
      #"{"sessionId":"s","exp":1}"#,
      #"{"kind":"done","sessionId":"s"}"#,
      #"{"kind":7,"exp":1}"#,
      #"{"kind":"done","sessionId":null,"exp":1}"#,
      #"{"kind":"done","sessionId":"","exp":1}"#,
      #"{"kind":"done","sessionId":"s","termId":"XYZ","exp":1}"#,
      #"{"kind":"question","title":null,"exp":1}"#,
      #"{"kind":"question","body":"\#(long)","exp":1}"#,
      #"{"kind":"question","exp":"1"}"#,
    ] {
      #expect(throws: (any Error).self, "\(json)") { _ = try plaintext(json) }
    }
  }

  @Test("koperta z poprawnym kluczem i zepsutym tekstem jawnym → `plaintextInvalid`, nie treść")
  func invalidPlaintext() throws {
    let vector = try #require(Self.file.vectors.first)
    let pushKey = try PushCrypto.pushKey(base64URL: vector.pushKey)
    let nonce = try ChaChaPoly.Nonce(data: Data(repeating: 9, count: 12))
    let box = try ChaChaPoly.seal(
      Data(#"{"kind":"done"}"#.utf8), using: PushCrypto.bannerKey(pushKey: pushKey), nonce: nonce,
      authenticating: PushCrypto.aad(kid: vector.kid))
    let sealed = (box.ciphertext + box.tag).base64EncodedString()
      .replacing("+", with: "-").replacing("/", with: "_").replacing("=", with: "")
    let envelope = try Self.envelope(.init(v: PushEnvelope.version, kid: vector.kid, n: "CQkJCQkJCQkJCQkJ", c: sealed))
    #expect(throws: PushCrypto.Failure.plaintextInvalid) { _ = try PushCrypto.openPlaintext(envelope, pushKey: pushKey) }
  }

  @Test("koperta: wersja inna niż 3 i brak pól odrzucają blok")
  func envelopeVersion() throws {
    #expect(PushEnvelope.version == 3)
    let vector = try #require(Self.file.vectors.first)
    for version in [1, 2, 4] {
      #expect(throws: (any Error).self, "v: \(version)") {
        _ = try Self.envelope(.init(v: version, kid: vector.kid, n: vector.n, c: vector.c))
      }
    }
    #expect(throws: (any Error).self) {
      _ = try JSONDecoder().decode(PushEnvelope.self, from: Data(#"{"v":3,"kid":"f849d673","n":"AAAAAAAAAAAAAAAA"}"#.utf8))
    }
  }

  // MARK: - Format 2 odrzucony

  @Test("format 2: the format 2 ciphertext under `v: 3` is among the AEAD refusals")
  func format2Rejected() {
    #expect(Self.file.refusals.contains { $0.name == "koperta-formatu-2" && $0.reason == "aead" })
  }
}
