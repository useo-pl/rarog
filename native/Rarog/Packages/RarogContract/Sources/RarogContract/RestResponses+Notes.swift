import Foundation

// Notatki projektu — odpowiedzi `GET /api/notes?cwd=` i `PUT /api/notes`, lustro `notesDocSchema`,
// `notesPutResponseSchema` i `notesConflictBodySchema` z `shared/src/protocol.ts`. Złote odpowiedzi: `notes.*.json`
// w `shared/fixtures/rest/`. Właściciel: notatki (apka natywna).

/// Dokument notatek jednego projektu: cały tekst i jego wersja. `updatedAt` to milisekundy zegara serwera
/// i zarazem WERSJA dokumentu (rośnie ściśle przy każdym zapisie); `0` = na dysku nie ma niczego. Typ liczbowy
/// jak w kontrakcie (`z.number()`): wersji nie zaokrąglamy, porównujemy dokładnie i odsyłamy tę samą liczbę.
public struct NotesDoc: Sendable, Equatable, Codable {
  public var text: String
  public var updatedAt: Double

  enum CodingKeys: String, CodingKey { case text, updatedAt }

  public init(text: String, updatedAt: Double) {
    self.text = text
    self.updatedAt = updatedAt
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    text = try c.required(.text)
    updatedAt = try c.required(.updatedAt)
  }

  /// Pusty dokument projektu bez notatek (`GET` bez pliku).
  public static let empty = NotesDoc(text: "", updatedAt: 0)
}

/// `PUT /api/notes` → 200: sama nowa wersja (tekst klient właśnie wysłał).
public struct NotesSaved: Sendable, Equatable, Decodable {
  public var updatedAt: Double

  enum CodingKeys: String, CodingKey { case updatedAt }

  public init(updatedAt: Double) {
    self.updatedAt = updatedAt
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    updatedAt = try c.required(.updatedAt)
  }
}

/// `PUT /api/notes` → 409: wersja na serwerze jest inna niż ta, na której pisał klient. `current` to AKTUALNY
/// dokument z dysku — apka stawia go obok swojego tekstu, serwer nigdy nie scala.
/// `message` to angielskie zdanie serwera, `messageRef` — jego kod zdania do tłumaczenia (``translate(_:)``).
public struct NotesConflictBody: Sendable, Equatable, Codable, SentenceBearing {
  public var error: String
  public var message: String
  public var current: NotesDoc
  public var messageRef: SentenceRef?

  enum CodingKeys: String, CodingKey { case error, message, current, messageRef }

  public init(error: String = "conflict", message: String, current: NotesDoc, messageRef: SentenceRef? = nil) {
    self.error = error
    self.message = message
    self.current = current
    self.messageRef = messageRef
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    error = try c.required(.error)
    // Kontrakt ma tu literał (`z.literal('conflict')`): 409 z innym kodem nie jest konfliktem wersji.
    guard error == "conflict" else {
      throw contractViolation(c.codingPath + [CodingKeys.error], "409 notatek bez kodu conflict: \(error)")
    }
    message = try c.required(.message)
    current = try c.required(.current)
    messageRef = try c.optional(.messageRef)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(error, forKey: .error)
    try c.encode(message, forKey: .message)
    try c.encode(current, forKey: .current)
    try c.encodeIfPresent(messageRef, forKey: .messageRef)
  }

  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    message = render(message, messageRef)
  }
}

/// Wynik zapisu: nowa wersja albo konflikt z aktualnym dokumentem.
public enum NotesSaveResult: Sendable, Equatable {
  case saved(Double)
  case conflict(NotesDoc)
}
