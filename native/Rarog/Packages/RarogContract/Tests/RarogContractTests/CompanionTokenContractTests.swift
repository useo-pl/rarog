// Klucz krótki OpenAI agenta głosowego: kształt z `companionTokenSchema`, reguły odczytu i opis bez klucza.
import Foundation
import RarogContract
import Testing

@Suite("kontrakt REST: klucz krótki agenta głosowego")
struct CompanionTokenContractTests {
  /// Syntetyczny klucz: prawdziwego testy nie znają.
  static let secret = "ek_test_xxxxxxxxxxxxxxxxxxxxxxxx"
  static let valid = #"""
    {"value":"ek_test_xxxxxxxxxxxxxxxxxxxxxxxx","expiresAt":"2026-11-10T12:01:00.000Z","model":"gpt-realtime-2.1",
     "nowe":"pole"}
    """#

  private func decode(_ json: String) throws -> CompanionToken {
    try JSONDecoder().decode(CompanionToken.self, from: Data(json.utf8))
  }

  @Test("przepuszcza kontrakt serwera, obce klucze odcięte")
  func valid() throws {
    let token = try decode(Self.valid)
    #expect(token.value == Self.secret)
    #expect(token.expiresAt == "2026-11-10T12:01:00.000Z" && token.model == "gpt-realtime-2.1")
  }

  @Test("pusty klucz, pusty model, null, zły typ i brak pola odrzucają odpowiedź")
  func rejects() {
    for broken in [
      Self.valid.replacing(#""value":"ek_test_xxxxxxxxxxxxxxxxxxxxxxxx""#, with: #""value":"""#),
      Self.valid.replacing(#""model":"gpt-realtime-2.1""#, with: #""model":"""#),
      Self.valid.replacing(#""expiresAt":"2026-11-10T12:01:00.000Z""#, with: #""expiresAt":null"#),
      Self.valid.replacing(#""value":"ek_test_xxxxxxxxxxxxxxxxxxxxxxxx""#, with: #""value":1"#),
      #"{"value":"ek_test_xxxxxxxxxxxxxxxxxxxxxxxx"}"#,
    ] {
      #expect(throws: DecodingError.self) { try decode(broken) }
    }
  }

  @Test("opis, opis debug i lustro (`dump`) nie zdradzają klucza")
  func redacted() throws {
    let token = try decode(Self.valid)
    var dumped = ""
    dump(token, to: &dumped)
    for text in [String(describing: token), String(reflecting: token), "\(token)", dumped] {
      #expect(!text.contains(Self.secret), "klucz w opisie: \(text)")
      #expect(text.contains("gpt-realtime-2.1"))
    }
  }

  @Test("błąd dekodowania uszkodzonej odpowiedzi nie cytuje klucza")
  func brokenDoesNotQuote() {
    for broken in [
      Self.valid.replacing(#""model":"gpt-realtime-2.1""#, with: #""model":["x"]"#),
      #"{"value":"ek_test_xxxxxxxxxxxxxxxxxxxxxxxx","expiresAt":"2026-"#,
    ] {
      do {
        _ = try decode(broken)
        Issue.record("uszkodzona odpowiedź powinna rzucić")
      } catch {
        for text in [String(describing: error), String(reflecting: error)] {
          #expect(!text.contains(Self.secret), "klucz w błędzie: \(text)")
        }
      }
    }
  }
}
