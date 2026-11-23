import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Sekcja „O apce” i linki produktu na ekranie parowania: wiersz wersji z `Info.plist`, strona not licencji
// z zasobu apki, nazwy i adresy trzech linków, mail „Zgłoś problem”. Proces testów ma język pl, angielski idzie
// jawnym językiem.
@Suite("„O apce”: wersja, licencje, linki produktu i zgłoszenie problemu")
struct AboutTests {
  /// `THIRD-PARTY-NOTICES` z korzenia repo — ten sam plik, który cel apki bierze jako zasób.
  static let notices = URL(filePath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "THIRD-PARTY-NOTICES")

  @Test("wersja z Info.plist: en „Version 1.0 (123)”, pl „Wersja 1.0 (123)”")
  func version() {
    let info = AboutInfo(info: ["CFBundleShortVersionString": "1.0", "CFBundleVersion": "123"])
    #expect(info.version == "1.0")
    #expect(info.build == "123")
    #expect(UICopy.aboutVersion(info, language: .en) == "Version 1.0 (123)")
    #expect(UICopy.aboutVersion(info, language: .pl) == "Wersja 1.0 (123)")
    #expect(UICopy.aboutVersion(info) == "Wersja 1.0 (123)", "język procesu testów: pl")
  }

  @Test("brak kluczy, pusty słownik, pusta wartość albo inny typ: „—” w miejscu wartości, bez awarii")
  func versionMissing() {
    #expect(UICopy.aboutVersion(AboutInfo(info: nil), language: .pl) == "Wersja — (—)")
    #expect(UICopy.aboutVersion(AboutInfo(info: [:]), language: .en) == "Version — (—)")
    #expect(UICopy.aboutVersion(AboutInfo(info: ["CFBundleShortVersionString": "1.0"]), language: .pl)
      == "Wersja 1.0 (—)")
    #expect(UICopy.aboutVersion(AboutInfo(info: ["CFBundleShortVersionString": " ", "CFBundleVersion": 7]),
      language: .pl) == "Wersja — (—)")
  }

  @Test("licencje: zasób jest → strona zaczyna się od „THIRD-PARTY NOTICES”, tekst cały, w akapitach")
  func licensesPresent() throws {
    let page = LicensesPage(url: Self.notices)
    #expect(!page.missing)
    let first = try #require(page.blocks.first)
    #expect(first.hasPrefix("THIRD-PARTY NOTICES"), "\(first.prefix(80))")
    #expect(page.blocks.count > 10, "akapity, nie jeden blok")
    let whole = try String(contentsOf: Self.notices, encoding: .utf8)
    #expect(page.blocks.joined().count < whole.count, "puste linie między akapitami odcięte")
    #expect(page.blocks.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
    #expect(page.blocks.last.map { whole.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix($0) } == true,
      "ostatni akapit to koniec pliku")
  }

  @Test("licencje: brak zasobu albo plik, którego nie ma → zdanie „about.licensesMissing”")
  func licensesMissing() {
    let missing = L("about.licensesMissing")
    #expect(missing == "Ta wersja apki nie ma tekstu not licencyjnych.")
    for page in [LicensesPage(url: nil), LicensesPage(url: URL(filePath: "/nonexistent/THIRD-PARTY-NOTICES"))] {
      #expect(page.missing)
      #expect(page.blocks == [missing])
    }
    #expect(LicensesPage(url: nil, language: .en).blocks == ["This build of the app doesn't include the license notices."])
  }

  @Test("trzy linki produktu: adresy z ProductLinks, nazwy en i pl, identyfikatory ekranu parowania")
  func links() {
    #expect(AboutLink.allCases == [.privacy, .setup, .support])
    #expect(AboutLink.allCases.map(\.url) == [ProductLinks.privacy, ProductLinks.setup, ProductLinks.support])
    #expect(AboutLink.allCases.map { UICopy.aboutLink($0, language: .en) }
      == ["Privacy Policy", "Set Up a Server", "Support"])
    #expect(AboutLink.allCases.map { UICopy.aboutLink($0, language: .pl) }
      == ["Polityka prywatności", "Instalacja serwera", "Wsparcie"])
    #expect(AboutLink.allCases.map(\.id) == ["privacy", "setup", "support"])
  }

  /// Audyt `AccessibilityUITests` ekranu parowania (iPad, iOS 27): bez celu 44 pt każdy link to „Hit area is too
  /// small” (ramka 16 pt), a z `ViewThatFits` każdy dostaje „Dynamic Type font sizes are partially unsupported” —
  /// zmierzone wariantami widoku: zgłoszenie znika po zdjęciu `ViewThatFits`, a zostaje bez `fixedSize` i bez
  /// podkreślenia. Sam `HStack` w powiększonym piśmie daje „Text clipped”.
  @Test("linki ekranu parowania: kolumna bez ViewThatFits, każdy link z celem dotyku co najmniej 44 pt")
  func productLinksRowLayout() throws {
    let code = try TerminalWindowChromeSourceTests.code("Views/About/ProductLinksRow.swift")
    #expect(!code.contains("ViewThatFits"), "przełączanie układu przy zmianie pisma: audyt Dynamic Type")
    #expect(!code.contains("HStack"), "rząd obcina tekst w powiększonym piśmie")
    #expect(code.contains("VStack(alignment: .leading, spacing: 0)"), "kolumna; odstęp daje cel dotyku")
    #expect(code.contains(".frame(minWidth: 44, minHeight: 44, alignment: .leading)"), "cel dotyku 44 × 44 pt")
    #expect(code.contains(".contentShape(Rectangle())"), "cały cel przyjmuje dotyk, nie tylko glify")
  }

  @Test("„Zgłoś problem”: temat i zdanie z copy, linia techniczna z wersją, buildem, systemem i urządzeniem")
  func report() throws {
    let info = AboutInfo(info: ["CFBundleShortVersionString": "1.0", "CFBundleVersion": "123"])
    let url = AboutReport.mailURL(info: info, system: "26.1", device: .iPad, language: .pl)
    #expect(url.absoluteString.hasPrefix("mailto:support@rarog.ai?"))
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    #expect(items.first { $0.name == "subject" }?.value == "Rarog: zgłoszenie problemu")
    let body = try #require(items.first { $0.name == "body" }?.value)
    #expect(body == "Opisz, co się stało i co powinno się stać:\n\nRarog 1.0 (123) · iOS 26.1 · iPad")
    let english = AboutReport.mailURL(info: AboutInfo(info: nil), system: "26.0", device: .mac, language: .en)
    let englishBody = URLComponents(url: english, resolvingAgainstBaseURL: false)?.queryItems?
      .first { $0.name == "body" }?.value
    #expect(englishBody == "Describe what happened and what you expected instead:\n\nRarog — (—) · iOS 26.0 · Mac")
  }

  @Test("nazwy sekcji i wierszy: en i pl")
  func labels() {
    let keys = ["about.section", "about.reportProblem", "about.licenses", "about.licensesTitle"]
    #expect(keys.map { L($0, language: .en) } == ["About", "Report a Problem", "Licenses", "Third-Party Licenses"])
    #expect(keys.map { L($0, language: .pl) } == ["O apce", "Zgłoś problem", "Licencje", "Licencje składników zewnętrznych"])
    #expect(UICopy.aboutSection == "O apce")
  }
}
