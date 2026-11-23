// Odpowiedź na kartę pytania — lustro `answersBodySchema`, `MAX_ANSWER_NOTE_CHARS`
// i `MAX_ANSWERS_TOTAL_CHARS` z `shared/src/rest.ts` oraz `MAX_ANSWER_TEXT_CHARS` z
// `shared/src/protocol.ts`. Właściciel: karty pytań.

/// Sufity odpowiedzi.
///
/// Serwer liczy je jak JavaScript (`string.length`), czyli w jednostkach UTF-16, a nie w znakach
/// widzianych przez człowieka: emoji to dwie jednostki. Liczony po swojemu (`String.count`) sufit
/// przepuszczałby tekst, który serwer odrzuci 400.
public enum AnswerLimits {
  /// JEDNA wartość odpowiedzi (wolny tekst z pola „Własna odpowiedź").
  public static let maxTextUnits = 2_000
  /// JEDNA notatka do wybranej opcji — sufit Raroga (`MAX_ANSWER_NOTE_CHARS`), niezmierzony w CLI.
  public static let maxNoteUnits = 8_192
  /// Suma odpowiedzi (wartości pytania sklejone „, ") i notatek jednego żądania.
  public static let maxTotalUnits = 32_768

  /// Tekst przycięty do sufitu bez rozcinania znaku (granica klastra grafemów).
  public static func clamp(_ text: String, to limit: Int = maxTextUnits) -> String {
    guard text.utf16.count > limit else { return text }
    var units = 0
    var end = text.startIndex
    for index in text.indices {
      let next = text.index(after: index)
      let width = text[index..<next].utf16.count
      if units + width > limit { break }
      units += width
      end = next
    }
    return String(text[..<end])
  }

  /// Notatka przycięta do sufitu notatki.
  public static func clampNote(_ text: String) -> String { clamp(text, to: maxNoteUnits) }

  /// Długość żądania tak, jak liczy ją serwer przy notatkach: wartości każdego pytania sklejone
  /// „, " plus wszystkie notatki (`null` = 0).
  public static func totalUnits(answers: [[String]], notes: [String?]) -> Int {
    answers.reduce(0) { $0 + $1.joined(separator: ", ").utf16.count }
      + notes.reduce(0) { $0 + ($1?.utf16.count ?? 0) }
  }
}

/// `POST /api/sessions/<id>/answers/<qId>`: per pytanie tablica wartości — etykiety opcji
/// (dosłownie) albo wolny tekst z pola „Własna odpowiedź"; jednokrotny wybór = jedna wartość.
///
/// `notes` — RÓWNOLEGŁE do `answers`: notatka do wybranej opcji pytania o tym samym
/// indeksie albo `null`. Pole idzie wyłącznie z co najmniej jedną notatką; bez niej klucz
/// jest pominięty, nie `null`.
public struct AnswersBody: Sendable, Equatable, Encodable {
  public var answers: [[String]]
  public var notes: [String?]?

  public init(answers: [[String]], notes: [String?]? = nil) {
    self.answers = answers
    self.notes = notes.flatMap { $0.contains { $0 != nil } ? $0 : nil }
  }
}
