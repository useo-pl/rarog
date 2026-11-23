import Foundation

// Baner formatu 3 widziany z apki: koperta w bloku `rarog` (`{v: 3, kid, n, c}`) i tekst jawny po
// odszyfrowaniu (`{kind, title?, body?, sessionId?, termId?, exp}`). Kształt z `server/src/notify/apns-payload.ts`
// (`apnsAlertRequestE2e` z formatem 3) i `push-crypto.ts`; złote ramki `shared/fixtures/apns-v3/*.v3.json`, wektory
// `shared/fixtures/push-crypto/vectors.v3.json` (`PushCryptoTests`). Szyfr: `PushCrypto.swift`.
//
// Odbiorca waliduje kopertę PRZED szyfrem: `kid` = 8 znaków hex małymi literami, `n` = 16 znaków base64url
// (12 B), `c` = co najmniej 22 znaki base64url bez `=` (szyfrogram‖tag, tag 16 B). Nieznane pola bloku są
// pomijane jak w reszcie kontraktu; `null` i zły typ odrzucają kopertę.

/// Koperta banera formatu 3 — blok `rarog` z treścią zaszyfrowaną kluczem push urządzenia.
public struct PushEnvelope: Sendable, Equatable, Decodable {
  /// Wersja bloku `rarog` z zaszyfrowaną treścią (`APNS_RAROG_BLOCK_VERSION`).
  public static let version = 3

  /// Identyfikator klucza push: 8 znaków hex `sha256` surowych bajtów klucza (konto wpisu Keychaina).
  public let kid: String
  /// Nonce ChaCha20-Poly1305 (12 B), z `n`.
  public let nonce: Data
  /// Szyfrogram‖tag (≥ 16 B), z `c`.
  public let sealed: Data

  enum CodingKeys: String, CodingKey {
    case version = "v"
    case kid, n, c
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let version: Int = try c.required(.version)
    guard version == Self.version else {
      throw contractViolation(c.codingPath + [CodingKeys.version], "wersja koperty inna niż 3")
    }
    let kid: String = try c.required(.kid)
    guard PushWire.isKid(kid) else {
      throw contractViolation(c.codingPath + [CodingKeys.kid], "kid spoza 8 znaków hex")
    }
    let n: String = try c.required(.n)
    guard n.utf8.count == PushWire.nonceChars, let nonce = PushWire.base64URL(n), nonce.count == PushCrypto.nonceBytes
    else {
      throw contractViolation(c.codingPath + [CodingKeys.n], "n to nie 12 bajtów base64url")
    }
    let sealedText: String = try c.required(.c)
    guard sealedText.utf8.count >= PushWire.minSealedChars, let sealed = PushWire.base64URL(sealedText),
      sealed.count >= PushCrypto.tagBytes
    else {
      throw contractViolation(c.codingPath + [CodingKeys.c], "c krótsze niż tag albo spoza base64url")
    }
    self.kid = kid
    self.nonce = nonce
    self.sealed = sealed
  }
}

/// Tekst jawny banera po odszyfrowaniu. Tytuł i treść są tylko przy alercie („skończył” ich nie ma).
///
/// Reguły jak w bloku `rarog` v1 (`ApnsRarogPayload`): `kind` wymagany jako napis, a nieznany rodzaj zostaje
/// `nil`, ale cel tapnięcia przeżywa (nowszy serwer z nowym rodzajem nie gasi banera); `sessionId` niepusty;
/// `termId` z `TERM_ID_RE`. Sufit długości tytułu, treści i sesji: ``maxFieldBytes`` (UTF-8). Spacje za JSON-em
/// (dopełnienie do kubełka 256 B) dekoder toleruje.
public struct PushPlaintext: Sendable, Equatable, Decodable {
  /// Sufit bajtów UTF-8 jednego pola tekstowego — tekst jawny serwer przycina do 2048 B w całości.
  public static let maxFieldBytes = PushCrypto.plaintextMaxBytes

  /// `nil` = rodzaj, którego ta wersja apki nie zna.
  public var kind: ApnsPushKind?
  public var title: String?
  public var body: String?
  /// Sesja, której dotyczy powiadomienie; push próbny i `device-paired` jej nie mają.
  public var sessionId: String?
  /// Terminal Raroga wpisu Codexa (`TERM_ID_RE`).
  public var termId: String?
  /// `apns-expiration` wysyłki (sekundy epoki) — NSE po `exp + 300 s` zostawia tekst zastępczy.
  public var exp: Int
  /// Kody zdań `title` i `body`; brak = tekst bez kodu.
  public var titleRef: SentenceRef?
  public var bodyRef: SentenceRef?

  enum CodingKeys: String, CodingKey {
    case kind, title, body, sessionId, termId, exp, titleRef, bodyRef
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let rawKind: String = try c.required(.kind)
    kind = ApnsPushKind.wire(rawKind)
    title = try Self.capped(c, .title)
    body = try Self.capped(c, .body)
    if c.contains(.sessionId) {
      let session = try c.nonEmpty(.sessionId)
      guard session.utf8.count <= Self.maxFieldBytes else {
        throw contractViolation(c.codingPath + [CodingKeys.sessionId], "sessionId ponad sufit")
      }
      sessionId = session
    }
    termId = try c.optional(.termId)
    if let termId, !WireFormat.isTerminalId(termId) {
      throw contractViolation(c.codingPath + [CodingKeys.termId], "termId spoza TERM_ID_RE")
    }
    exp = try c.required(.exp)
    titleRef = try c.optional(.titleRef)
    bodyRef = try c.optional(.bodyRef)
  }

  private static func capped(_ c: ContractContainer<CodingKeys>, _ key: CodingKeys) throws -> String? {
    let value: String? = try c.optional(key)
    if let value, value.utf8.count > maxFieldBytes {
      throw contractViolation(c.codingPath + [key], "pole ponad sufit")
    }
    return value
  }
}

extension PushPlaintext: SentenceBearing {
  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    title = title.map { render($0, titleRef) }
    body = body.map { render($0, bodyRef) }
  }
}

/// Kształt łańcuchów koperty (lustro reguł odbiorcy z serwera).
enum PushWire {
  /// `n` = base64url 12 B bez dopełnienia.
  static let nonceChars = 16
  /// `c` = co najmniej sam tag (16 B) w base64url bez dopełnienia.
  static let minSealedChars = 22

  /// `^[0-9a-f]{8}$`.
  static func isKid(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    return bytes.count == 8 && bytes.allSatisfy { byte in
      (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(byte)
    }
  }

  /// base64url BEZ dopełnienia, wyłącznie alfabet `A–Z a–z 0–9 - _`; cokolwiek innego (także `=`) = `nil`.
  static func base64URL(_ text: String) -> Data? {
    let utf8 = text.utf8
    guard !utf8.isEmpty, utf8.count % 4 != 1 else { return nil }
    let alphabet = utf8.allSatisfy { byte in
      switch byte {
      case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
        UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "-"), UInt8(ascii: "_"):
        true
      default: false
      }
    }
    guard alphabet else { return nil }
    var standard = text.replacing("-", with: "+").replacing("_", with: "/")
    standard += String(repeating: "=", count: (4 - standard.utf8.count % 4) % 4)
    return Data(base64Encoded: standard)
  }
}
