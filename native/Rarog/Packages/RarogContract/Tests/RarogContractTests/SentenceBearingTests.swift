// Odpowiedzi REST ze zdaniami serwera: lista `sentenceResponses` = `SENTENCE_RESPONSES` z `shared/test/rest-fixtures.test.ts`
// (identyfikator = nazwa schematu w `SCHEMAS` i klucz mapy dekoderów `RestFixturesTests`, typ Swift, złoty plik
// niosący pola `*Ref`). Test TS czyta tę listę ze źródła, więc każda pozycja stoi w jednej linii w tym kształcie.
// Każdy typ z listy tłumaczy się (`SentenceBearing`) i koduje (round-trip złotego pliku jest dosłowny).
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

/// Pozycja `SENTENCE_RESPONSES`: identyfikator schematu, typ Swift i złoty plik w `shared/fixtures/rest/`.
struct SentenceResponse: Sendable, CustomTestStringConvertible {
  let id: String
  let type: any (Decodable & Sendable).Type
  let file: String

  var testDescription: String { id }
}

@Suite("kontrakt REST: odpowiedzi ze zdaniami serwera (`sentenceResponses`) tłumaczą się i kodują")
struct SentenceBearingTests {
  static let sentenceResponses: [SentenceResponse] = [
    SentenceResponse(id: "errorBody", type: APIErrorBody.self, file: "error.not-found.json"),
    SentenceResponse(id: "decisionRefusedBody", type: APIErrorBody.self, file: "error.decision-refused.json"),
    SentenceResponse(id: "notesConflict", type: NotesConflictBody.self, file: "notes.conflict.json"),
    SentenceResponse(id: "deviceRevokedBody", type: DeviceRevokedBody.self, file: "error.device-revoked.json"),
    SentenceResponse(id: "sessionModelResponse", type: SessionModelAccepted.self, file: "model-accepted.json"),
    SentenceResponse(id: "modelList", type: ModelList.self, file: "models.json"),
    SentenceResponse(id: "interruptResponse", type: InterruptResponse.self, file: "interrupt.json"),
    SentenceResponse(id: "fileTooLargeBody", type: FileTooLargeBody.self, file: "error.file-too-large.json"),
  ]

  /// Renderer testowy: znany `ref` → `PL:<kod>`, brak `ref` → tekst z drutu.
  static let renderer: SentenceRenderer = { text, ref in ref.map { "PL:" + $0.code } ?? text }

  @Test("lista ma siedem pozycji o różnych identyfikatorach, każdy w mapie dekoderów złotych odpowiedzi")
  func listShape() {
    let ids = Self.sentenceResponses.map(\.id)
    #expect(ids.count == 8)
    #expect(Set(ids).count == ids.count)
    #expect(Set(ids).subtracting(RestFixturesTests.decoders.keys).sorted() == [])
  }

  @Test("typ z listy jest `SentenceBearing` i `Encodable`", arguments: SentenceBearingTests.sentenceResponses)
  func typeConforms(_ entry: SentenceResponse) {
    #expect(entry.type is any SentenceBearing.Type, "\(entry.id): \(entry.type) bez SentenceBearing")
    #expect(entry.type is any Encodable.Type, "\(entry.id): \(entry.type) bez Encodable")
  }

  /// Złote pliki, które już są w katalogu (pozycje bez pliku sprawdza test TS: pozycja bez pliku jest tam czerwona).
  static let presentFiles: [SentenceResponse] = sentenceResponses.filter {
    FileManager.default.fileExists(atPath: RestFixturesTests.directory.appending(path: $0.file).path)
  }

  @Test("złoty plik pozycji: wpis manifestu ze schematem = identyfikator", arguments: SentenceBearingTests.presentFiles)
  func manifestSchema(_ entry: SentenceResponse) throws {
    let manifest = try #require(RestFixturesTests.manifest[entry.file], "\(entry.file): brak w manifeście")
    #expect(manifest.schema == entry.id)
  }

  @Test("złoty plik pozycji: round-trip dosłowny i `translate` zgodny z `*Ref`", arguments: SentenceBearingTests.presentFiles)
  func goldenRoundTripAndTranslate(_ entry: SentenceResponse) throws {
    let data = try RestFixturesTests.body(entry.file)
    let value = try Self.decode(entry.type, data)
    let encodable = try #require(value as? any Encodable, "\(entry.id): bez Encodable")
    let stored = try JSONValue.parse(data)
    #expect(JSONValue.differences(expected: stored, actual: try JSONValue.parse(JSONEncoder().encode(encodable))) == [])

    // Tłumaczenie: każde pole tekstu z parą `*Ref` dostaje `PL:<kod>`, reszta dokumentu bez zmian, `*Ref` zostaje.
    var bearing = try #require(value as? any SentenceBearing, "\(entry.id): bez SentenceBearing")
    bearing.translate(Self.renderer)
    let translated = try #require(bearing as? any Encodable)
    let expected = Self.translatedByRefs(stored)
    #expect(JSONValue.differences(expected: expected, actual: try JSONValue.parse(JSONEncoder().encode(translated))) == [])
  }

  private static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> any Decodable {
    try JSONDecoder().decode(type, from: data)
  }

  /// Oczekiwany dokument po tłumaczeniu rendererem testowym: pole `x` obok `xRef` staje się `PL:<kod>`.
  static func translatedByRefs(_ value: JSONValue) -> JSONValue {
    switch value {
    case let .array(items):
      return .array(items.map(translatedByRefs))
    case let .object(fields):
      var out = fields.mapValues(translatedByRefs)
      for (key, ref) in fields where key.hasSuffix("Ref") {
        let text = String(key.dropLast(3))
        if case let .object(refFields) = ref, case let .string(code)? = refFields["code"], out[text] != nil {
          out[text] = .string("PL:" + code)
        }
      }
      return .object(out)
    default:
      return value
    }
  }

  @Test("oczekiwanie tłumaczenia: pole obok `*Ref` po kodzie, pole bez pary bez zmian")
  func translatedByRefsHelper() throws {
    let doc = try JSONValue.parse(Data(#"{"message":"m","messageRef":{"code":"a.b"},"error":"x","list":[{"label":"l"}]}"#.utf8))
    let expected = try JSONValue.parse(
      Data(#"{"message":"PL:a.b","messageRef":{"code":"a.b"},"error":"x","list":[{"label":"l"}]}"#.utf8))
    #expect(Self.translatedByRefs(doc) == expected)
  }
}
