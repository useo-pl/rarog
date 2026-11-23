import Foundation
import RarogContract
import Testing

// Ciało odpowiedzi na kartę pytania i sufit wolnego tekstu.

@Suite("odpowiedź na pytanie: ciało i sufit tekstu")
struct AnswersContractTests {
  @Test("ciało: tablica wartości per pytanie, nic spoza schematu")
  func body() throws {
    let data = try JSONEncoder().encode(AnswersBody(answers: [["SQLite"], ["Jednostkowe", "Integracyjne"]]))
    let object = try JSONSerialization.jsonObject(with: data) as? [String: [[String]]]
    #expect(object == ["answers": [["SQLite"], ["Jednostkowe", "Integracyjne"]]])
  }

  @Test("notatki: równoległe do odpowiedzi, `null` jawnie; bez żadnej notatki klucza nie ma")
  func notes() throws {
    func object(_ body: AnswersBody) throws -> NSDictionary? {
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? NSDictionary
    }
    let withNote = try #require(try object(AnswersBody(answers: [["SQLite"], ["Jednostkowe"]], notes: ["bez paska", nil])))
    #expect(withNote["notes"] as? [Any] != nil)
    #expect((withNote["notes"] as? [Any])?.first as? String == "bez paska")
    #expect((withNote["notes"] as? [Any])?.last is NSNull, "brak notatki to `null`, nie pominięcie pozycji")
    // Same `nil` = ciało bez klucza `notes` (starszy serwer go nie zna).
    let none = try #require(try object(AnswersBody(answers: [["SQLite"]], notes: [nil])))
    #expect(none.allKeys as? [String] == ["answers"])
    #expect(AnswersBody(answers: [["SQLite"]], notes: [nil]) == AnswersBody(answers: [["SQLite"]]))
  }

  @Test("sufit notatki 8192 i suma żądania liczona jak na serwerze (wartości „, ” + notatki)")
  func noteLimits() {
    #expect(AnswerLimits.maxNoteUnits == 8_192 && AnswerLimits.maxTotalUnits == 32_768)
    let long = String(repeating: "x", count: AnswerLimits.maxNoteUnits - 1)
    #expect(AnswerLimits.clampNote(long + "🙂") == long, "emoji na granicy wypada całe")
    #expect(AnswerLimits.clampNote(long + "ąb") == long + "ą")
    #expect(AnswerLimits.totalUnits(answers: [["ab"], ["c", "d"]], notes: ["🙂", nil]) == 2 + 4 + 2)
  }

  @Test("sufit liczony jak w JavaScripcie (UTF-16) i bez rozcinania znaku")
  func clamp() {
    let ascii = String(repeating: "a", count: AnswerLimits.maxTextUnits)
    #expect(AnswerLimits.clamp(ascii) == ascii)
    #expect(AnswerLimits.clamp(ascii + "b") == ascii)
    // Emoji = dwie jednostki UTF-16: 1999 liter + emoji to 2001 jednostek, więc emoji wypada całe.
    let almost = String(repeating: "a", count: AnswerLimits.maxTextUnits - 1)
    let clamped = AnswerLimits.clamp(almost + "🙂")
    #expect(clamped == almost)
    #expect(clamped.utf16.count <= AnswerLimits.maxTextUnits)
    // Polskie litery to jedna jednostka — „ą" mieści się tak samo jak „a".
    #expect(AnswerLimits.clamp(almost + "ą") == almost + "ą")
  }
}
