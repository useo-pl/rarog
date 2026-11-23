import Foundation
import RarogContract
import RarogCore

// Modele strony „O apce” i linków produktu, bez UIKit: kompilują się na macOS, więc `swift test` sprawdza je bez
// symulatora (`AboutTests`). Widoki: `Views/Settings/SettingsAboutPage.swift`, `LicensesView.swift`, `ProductLinksRow.swift`.

/// Wersja apki z `Info.plist` (`Bundle.main.infoDictionary`); test podaje słownik. Pusta albo nie-tekstowa wartość =
/// brak, a brak pokazuje się jako ``missing``.
struct AboutInfo: Equatable, Sendable {
  static let missing = "—"

  let version: String?
  let build: String?

  init(info: [String: Any]?) {
    version = Self.text(info?["CFBundleShortVersionString"])
    build = Self.text(info?["CFBundleVersion"])
  }

  private static func text(_ value: Any?) -> String? {
    guard let raw = value as? String else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

/// Trzy linki produktu: na ekranie parowania (przed sparowaniem) i na stronie „O apce” Ustawień, z tymi samymi nazwami.
enum AboutLink: String, CaseIterable, Identifiable, Sendable {
  case privacy
  case setup
  case support

  /// Końcówka identyfikatora dostępności (`pairing.link.<id>`, `settings.about.<id>`).
  var id: String { rawValue }

  var url: URL {
    switch self {
    case .privacy: ProductLinks.privacy
    case .setup: ProductLinks.setup
    case .support: ProductLinks.support
    }
  }
}

/// Strona not licencji: tekst `THIRD-PARTY-NOTICES` z paczki apki w akapitach (leniwa lista zamiast jednego bloku
/// 57 KB), albo jedno zdanie, gdy pliku nie ma.
struct LicensesPage: Equatable, Sendable {
  let blocks: [String]
  let missing: Bool

  init(url: URL?, language: CopyLanguage = .current) {
    guard let url, let text = try? String(contentsOf: url, encoding: .utf8) else {
      blocks = [UICopy.aboutLicensesMissing(language: language)]
      missing = true
      return
    }
    let paragraphs = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n\n")
      .map { $0.trimmingCharacters(in: .newlines) }
      .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    if paragraphs.isEmpty {
      blocks = [UICopy.aboutLicensesMissing(language: language)]
      missing = true
    } else {
      blocks = paragraphs
      missing = false
    }
  }

  /// Plik not w paczce apki: zasób celu `Rarog` (`../../THIRD-PARTY-NOTICES` w `project.pbxproj`).
  static func inApp() -> LicensesPage {
    LicensesPage(url: Bundle.main.url(forResource: "THIRD-PARTY-NOTICES", withExtension: nil))
  }
}

/// „Zgłoś problem”: temat i zdanie wstępne z copy, linia techniczna z rdzenia (`ProblemReport`).
enum AboutReport {
  static func mailURL(
    info: AboutInfo, system: String, device: ProblemReport.Device, language: CopyLanguage = .current
  ) -> URL {
    ProblemReport.mailURL(
      subject: UICopy.aboutReportSubject(language: language), body: UICopy.aboutReportBody(language: language),
      version: info.version ?? AboutInfo.missing, build: info.build ?? AboutInfo.missing, system: system,
      device: device)
  }
}
