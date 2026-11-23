import Foundation
@testable import RarogCore
import Testing

// „Zgłoś problem”: `mailto:` do skrzynki pomocy z tematem i treścią z copy oraz linią techniczną (wersja, build,
// system, rodzaj urządzenia), którą składa rdzeń. Kodowanie przez `URLComponents`.
@Suite("zgłoszenie problemu: adres mailto z wersją, buildem i systemem")
struct ProblemReportTests {
  /// Wartość parametru zapytania po zdekodowaniu (tak, jak odczyta ją klient poczty).
  static func query(_ url: URL, _ name: String) -> String? {
    URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value
  }

  @Test("mailto do support@rarog.ai; treść kończy linia „Rarog 1.0 (123) · iOS 26.1 · iPad”")
  func technicalLine() {
    let url = ProblemReport.mailURL(
      subject: "Rarog: problem", body: "What happened:", version: "1.0", build: "123", system: "26.1", device: .iPad)
    #expect(url.scheme == "mailto")
    let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
    #expect(parts?.path == "support@rarog.ai")
    #expect(Self.query(url, "subject") == "Rarog: problem")
    let body = Self.query(url, "body") ?? ""
    #expect(body.contains("Rarog 1.0 (123) · iOS 26.1 · iPad"), "\(body)")
    #expect(body.hasPrefix("What happened:"), "\(body)")
    #expect(ProblemReport.technicalLine(version: "1.0", build: "123", system: "26.1", device: .iPhone)
      == "Rarog 1.0 (123) · iOS 26.1 · iPhone")
    #expect(ProblemReport.technicalLine(version: "1.0", build: "123", system: "26.1", device: .mac)
      == "Rarog 1.0 (123) · iOS 26.1 · Mac")
  }

  @Test("temat i treść po polsku (ą, ł, „”) i znaki zapytania (&, =, +, #, ?): round-trip URLComponents bez zmian")
  func polishRoundTrip() throws {
    let subject = "Rarog: zgłoszenie problemu „ąłę” & co=dalej + #1?"
    let body = "Opisz, co się stało:\nżółć & 50% = „pół”"
    let url = ProblemReport.mailURL(
      subject: subject, body: body, version: "1.0", build: "7", system: "26.0", device: .iPhone)
    let text = url.absoluteString
    #expect(text.hasPrefix("mailto:support@rarog.ai?"), "\(text)")
    #expect(!text.contains(" "), "spacje zakodowane: \(text)")
    #expect(!text.contains("ą"), "znaki spoza ASCII zakodowane: \(text)")
    #expect(!text.contains("+"), "plus zakodowany (klient poczty mógłby wziąć go za spację): \(text)")
    #expect(!text.contains("#"), "krzyżyk zakodowany (inaczej ucina adres jako fragment): \(text)")
    #expect(Self.query(url, "subject") == subject)
    let decoded = try #require(Self.query(url, "body"))
    #expect(decoded == "\(body)\n\n" + ProblemReport.technicalLine(version: "1.0", build: "7", system: "26.0", device: .iPhone))
    // Ten sam adres przeczytany od nowa z tekstu daje te same pola.
    let again = try #require(URL(string: text))
    #expect(Self.query(again, "subject") == subject)
    #expect(Self.query(again, "body") == decoded)
  }
}
