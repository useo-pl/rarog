// `SentenceRef`: lustro `sentenceRefSchema` z `shared/src/sentences/index.ts`. Pole `ref` czytane
// `ContractContainer.optional` jak każde pole `*Ref` w typach kontraktu; uszkodzony `ref` odrzuca ramkę tak samo
// jak zod po stronie serwera.
import Foundation
@testable import RarogContract
import Testing

@Suite("kontrakt: SentenceRef — kod zdania serwera z argumentami")
struct SentenceRefTests {
  /// Kontener testowy: obiekt z jednym opcjonalnym polem `ref`.
  struct Holder: Decodable {
    var ref: SentenceRef?

    enum CodingKeys: String, CodingKey { case ref }

    init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      ref = try c.optional(.ref)
    }
  }

  private func decode(_ json: String) throws -> SentenceRef? {
    try JSONDecoder().decode(Holder.self, from: Data(json.utf8)).ref
  }

  private func encode(_ ref: SentenceRef) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(ref), as: UTF8.self)
  }

  @Test("brak pola `ref` → nil")
  func missingField() throws {
    #expect(try decode(#"{}"#) == nil)
  }

  @Test(
    "uszkodzony `ref` odrzuca obiekt",
    arguments: [
      #"{"ref":null}"#,
      #"{"ref":"x"}"#,
      #"{"ref":{"code":""}}"#,
      #"{"ref":{}}"#,
      #"{"ref":{"code":1}}"#,
      #"{"ref":{"code":"a.b","args":["1","2","3","4","5","6","7","8","9"]}}"#,
      #"{"ref":{"code":"a.b","args":["1",2]}}"#,
      #"{"ref":{"code":"a.b","args":null}}"#,
      #"{"ref":{"code":"a.b","args":"1"}}"#,
    ])
  func brokenRefRejects(json: String) {
    #expect(throws: DecodingError.self) { try decode(json) }
  }

  @Test("sam `code` → pusta lista argumentów")
  func codeOnly() throws {
    #expect(try decode(#"{"ref":{"code":"a.b"}}"#) == SentenceRef(code: "a.b", args: []))
  }

  @Test("argumenty w kolejności z drutu")
  func withArgs() throws {
    let ref = try #require(try decode(#"{"ref":{"code":"a.b","args":["1","x"]}}"#))
    #expect(ref == SentenceRef(code: "a.b", args: ["1", "x"]))
  }

  @Test("osiem argumentów to jeszcze limit, nie błąd")
  func eightArgsAccepted() throws {
    let ref = try #require(try decode(#"{"ref":{"code":"a.b","args":["1","2","3","4","5","6","7","8"]}}"#))
    #expect(ref.args.count == SentenceRef.maxArgs)
  }

  @Test("nieznany klucz obok `code` jest pomijany")
  func unknownKeyIgnored() throws {
    #expect(try decode(#"{"ref":{"code":"a.b","future":1}}"#) == SentenceRef(code: "a.b", args: []))
  }

  @Test("encode pomija puste `args`, jak `say()` po stronie serwera")
  func encodeWithoutEmptyArgs() throws {
    #expect(try encode(SentenceRef(code: "a.b", args: [])) == #"{"code":"a.b"}"#)
  }

  @Test("encode z argumentami → round-trip bez zmian")
  func encodeRoundTrip() throws {
    let ref = SentenceRef(code: "a.b", args: ["1", "x"])
    let json = try encode(ref)
    #expect(json == #"{"args":["1","x"],"code":"a.b"}"#)
    #expect(try decode(#"{"ref":\#(json)}"#) == ref)
  }

  /// Przykładowy typ z polem tekstu i parą `*Ref` oraz polem bez pary.
  struct Bearer: SentenceBearing {
    var message: String
    var messageRef: SentenceRef?
    var detail: String

    mutating func translate(_ render: (String, SentenceRef?) -> String) {
      message = render(message, messageRef)
      detail = render(detail, nil)
    }
  }

  @Test("SentenceBearing: renderer dostaje tekst z `ref`, `ref` zostaje bez zmian")
  func bearingTranslates() {
    let ref = SentenceRef(code: "a.b", args: ["1"])
    var value = Bearer(message: "Request rejected.", messageRef: ref, detail: "obcy")
    let renderer: SentenceRenderer = { text, ref in ref.map { "[\($0.code)]" } ?? text }
    value.translate(renderer)
    #expect(value.message == "[a.b]")
    #expect(value.messageRef == ref)
    #expect(value.detail == "obcy")
  }
}
