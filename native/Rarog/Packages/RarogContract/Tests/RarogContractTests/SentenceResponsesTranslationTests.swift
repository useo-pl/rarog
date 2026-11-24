// Odpowiedzi REST ze zdaniami serwera przez prawdziwy tłumacz: `ServerText.renderer(language: .pl)` na złotym
// pliku każdej z siedmiu pozycji `SENTENCE_RESPONSES` (identyfikator schematu, typ Swift, plik w `shared/fixtures/rest/`).
// Każde pole tekstu z parą `*Ref` ma wyjść po polsku, reszta dokumentu i pola `*Ref` bez zmian. Brak złotego pliku
// pozycji to porażka, nie pominięcie.
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

/// Pozycja listy: identyfikator `SENTENCE_RESPONSES`, złoty plik i oczekiwane polskie zdania po ścieżce pola.
struct SentenceTranslation: Sendable, CustomTestStringConvertible {
  let id: String
  let file: String
  let translate: @Sendable (Data, SentenceRenderer) throws -> any Encodable
  /// Ścieżka pola (`models.0.label`) → zdanie po polsku.
  let polish: [String: String]

  var testDescription: String { id }

  init<T: Decodable & Encodable & SentenceBearing>(
    _ id: String, _ type: T.Type, _ file: String, _ polish: [String: String]
  ) {
    self.id = id
    self.file = file
    self.polish = polish
    translate = { data, renderer in
      var value = try JSONDecoder().decode(T.self, from: data)
      value.translate(renderer)
      return value
    }
  }
}

@Suite("zdania serwera: siedem odpowiedzi `SENTENCE_RESPONSES` po polsku przez prawdziwy tłumacz")
struct SentenceResponsesTranslationTests {
  static let entries: [SentenceTranslation] = [
    SentenceTranslation("errorBody", APIErrorBody.self, "error.not-found.json", ["message": "Nie ma takiej sesji."]),
    SentenceTranslation("decisionRefusedBody", APIErrorBody.self, "error.decision-refused.json", [
      "message": "Wielokrotny wybór zrób w terminalu — Rarog wysyła jedną cyfrę.",
    ]),
    SentenceTranslation("notesConflict", NotesConflictBody.self, "notes.conflict.json", [
      "message": "Notatki zmieniły się na innym urządzeniu.",
    ]),
    SentenceTranslation("deviceRevokedBody", DeviceRevokedBody.self, "error.device-revoked.json", [
      "message": "To urządzenie odpięto — sparuj je z serwerem ponownie.",
    ]),
    SentenceTranslation("sessionModelResponse", SessionModelAccepted.self, "model-accepted.json", [
      "warning": #"Zmiana leci do panelu jako polecenie „/model", a Claude Code zapisuje ją w ustawieniach konta: nowe sesje — także zakładane w terminalu — ruszą od tej chwili na tym modelu. Rarog nie przywróci poprzedniej wartości."#,
    ]),
    SentenceTranslation("modelList", ModelList.self, "models.json", [
      "models.0.label": "Model domyślny konta",
      "models.0.description": "Bez flagi --model: dokładnie to, co masz ustawione w Claude Code.",
    ]),
    SentenceTranslation("interruptResponse", InterruptResponse.self, "interrupt.json", ["session.label": "sesja 1"]),
    SentenceTranslation("fileTooLargeBody", FileTooLargeBody.self, "error.file-too-large.json", [
      "message": "Ten plik ma 51 MB. Serwer wysyła pliki do 50 MB (RAROG_FILES_MAX_MB).",
    ]),
  ]

  @Test("lista = `sentenceResponses` (identyfikatory i pliki w tej samej kolejności)")
  func sameList() {
    #expect(Self.entries.map(\.id) == SentenceBearingTests.sentenceResponses.map(\.id))
    #expect(Self.entries.map(\.file) == SentenceBearingTests.sentenceResponses.map(\.file))
  }

  @Test("złoty plik → pola z `*Ref` po polsku, reszta i `*Ref` bez zmian", arguments: SentenceResponsesTranslationTests.entries)
  func translated(_ entry: SentenceTranslation) throws {
    let url = RestFixturesTests.directory.appending(path: entry.file)
    try #require(FileManager.default.fileExists(atPath: url.path), "\(entry.id): brak złotego pliku \(entry.file)")
    let data = try Data(contentsOf: url)
    let stored = try JSONValue.parse(data)

    // Każde pole z parą `*Ref` ma oczekiwane zdanie (nic nie zostaje niesprawdzone).
    #expect(Self.pathsWithRef(stored).sorted() == entry.polish.keys.sorted(), "\(entry.id)")

    let value = try entry.translate(data, ServerText.renderer(language: .pl))
    let actual = try JSONValue.parse(JSONEncoder().encode(value))
    var expected = stored
    for (path, text) in entry.polish {
      expected = Self.replacing(expected, at: path.split(separator: ".").map(String.init), with: .string(text))
    }
    #expect(JSONValue.differences(expected: expected, actual: actual) == [], "\(entry.id)")
  }

  /// Ścieżki pól `x`, obok których stoi `xRef` (indeksy tablic jako liczby).
  static func pathsWithRef(_ value: JSONValue, prefix: [String] = []) -> [String] {
    switch value {
    case let .array(items):
      return items.enumerated().flatMap { pathsWithRef($0.element, prefix: prefix + [String($0.offset)]) }
    case let .object(fields):
      let own = fields.keys.filter { $0.hasSuffix("Ref") && fields[String($0.dropLast(3))] != nil }
        .map { (prefix + [String($0.dropLast(3))]).joined(separator: ".") }
      return own + fields.flatMap { pathsWithRef($0.value, prefix: prefix + [$0.key]) }
    default:
      return []
    }
  }

  /// Dokument z wartością podmienioną pod ścieżką; ścieżka spoza dokumentu zostawia go bez zmian.
  static func replacing(_ value: JSONValue, at path: [String], with new: JSONValue) -> JSONValue {
    guard let head = path.first else { return new }
    let rest = Array(path.dropFirst())
    switch value {
    case var .object(fields):
      guard let child = fields[head] else { return value }
      fields[head] = replacing(child, at: rest, with: new)
      return .object(fields)
    case var .array(items):
      guard let index = Int(head), items.indices.contains(index) else { return value }
      items[index] = replacing(items[index], at: rest, with: new)
      return .array(items)
    default:
      return value
    }
  }
}
