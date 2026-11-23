// `truncation`: `{cut, footer}` przy tekście uciętym przez serwer — `PermissionRequest.displayText`
// i `ToolCallBlock.detail`. Obie liczby nieujemne, `footer` ≤ długość ciętego tekstu w skalarach Unicode
// (JS `[...text].length`, Swift `unicodeScalars.count`); inaczej ramka wypada jak w zodzie.
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("kontrakt: truncation — ucięcie tekstu w skalarach Unicode")
struct TruncationTests {
  /// Blok narzędzia z `detail` i opcjonalnym `truncation` (surowy JSON obiektu).
  private func toolCall(detail: String?, truncation: String?) throws -> ToolCallBlock {
    var fields = [#""toolName":"Read""#, #""summary":"ls""#]
    if let detail { fields.append(#""detail":\#(Self.quoted(detail))"#) }
    if let truncation { fields.append(#""truncation":\#(truncation)"#) }
    return try JSONDecoder().decode(ToolCallBlock.self, from: Data("{\(fields.joined(separator: ","))}".utf8))
  }

  private func permission(displayText: String, truncation: String) throws -> PermissionRequest {
    let json = #"""
      {"permId":"p1","sessionId":"s1","toolName":"Read","displayText":\#(Self.quoted(displayText)),"risk":"normal",
      "cwd":"/tmp","createdAt":"2026-11-06T10:00:00Z","truncation":\#(truncation)}
      """#
    return try JSONDecoder().decode(PermissionRequest.self, from: Data(json.utf8))
  }

  private static func quoted(_ text: String) -> String {
    String(decoding: try! JSONEncoder().encode(text), as: UTF8.self)
  }

  @Test("`{cut: 1200, footer: 30}` przy `detail` z 400 skalarów → poprawne")
  func validTruncation() throws {
    let block = try toolCall(detail: String(repeating: "a", count: 400), truncation: #"{"cut":1200,"footer":30}"#)
    #expect(block.truncation == Truncation(cut: 1200, footer: 30))
  }

  @Test("`footer` równy długości tekstu to jeszcze limit")
  func footerEqualToLength() throws {
    let block = try toolCall(detail: String(repeating: "a", count: 400), truncation: #"{"cut":1,"footer":400}"#)
    #expect(block.truncation?.footer == 400)
  }

  @Test(
    "zła stopka albo liczby odrzucają blok",
    arguments: [
      #"{"cut":1200,"footer":401}"#,
      #"{"cut":-1,"footer":0}"#,
      #"{"cut":0,"footer":-1}"#,
      #"{"cut":1.5,"footer":0}"#,
      #"{"cut":"1","footer":0}"#,
      #"{"cut":1}"#,
      #"{"footer":1}"#,
      #"null"#,
    ])
  func brokenTruncationRejects(truncation: String) {
    #expect(throws: DecodingError.self) {
      try toolCall(detail: String(repeating: "a", count: 400), truncation: truncation)
    }
  }

  @Test("`truncation` bez `detail` odrzuca blok — nie ma czego ucinać")
  func truncationWithoutDetailRejects() {
    #expect(throws: DecodingError.self) { try toolCall(detail: nil, truncation: #"{"cut":1,"footer":0}"#) }
  }

  @Test("emoji z modyfikatorem i znak łączący liczone w skalarach Unicode, nie w `Character`")
  func unicodeScalars() throws {
    // „e" + U+0301 i 👍 + U+1F3FD: dwa znaki `Character`, cztery skalary.
    let detail = "e\u{301}👍🏽"
    #expect(detail.count == 2 && detail.unicodeScalars.count == 4)
    #expect(try toolCall(detail: detail, truncation: #"{"cut":9,"footer":4}"#).truncation?.footer == 4)
    #expect(throws: DecodingError.self) { try toolCall(detail: detail, truncation: #"{"cut":9,"footer":5}"#) }
  }

  @Test("karta zgody: `footer` liczony wobec `displayText`")
  func permissionFooterAgainstDisplayText() throws {
    let card = try permission(displayText: "rm -rf build\n… (5 characters cut off)", truncation: #"{"cut":5,"footer":25}"#)
    #expect(card.truncation == Truncation(cut: 5, footer: 25))
    #expect(throws: DecodingError.self) { try permission(displayText: "ls", truncation: #"{"cut":5,"footer":3}"#) }
  }

  @Test("round-trip: `truncation` wraca dosłownie, brak pola nie wychodzi")
  func roundTrip() throws {
    let with = try toolCall(detail: "abc", truncation: #"{"cut":7,"footer":2}"#)
    let without = try toolCall(detail: "abc", truncation: nil)
    #expect(try JSONValue.parse(JSONEncoder().encode(with))
      == JSONValue.parse(Data(#"{"toolName":"Read","summary":"ls","detail":"abc","truncation":{"cut":7,"footer":2}}"#.utf8)))
    #expect(try JSONValue.parse(JSONEncoder().encode(without))
      == JSONValue.parse(Data(#"{"toolName":"Read","summary":"ls","detail":"abc"}"#.utf8)))
  }
}
