import Foundation
import RarogContract

// Copy strony „O apce” w Ustawieniach i linków produktu na ekranie parowania. Adresy stoją w
// `RarogCore/ProductLinks.swift`, linia techniczna maila w `RarogCore/ProblemReport.swift` — to nie copy. Teksty not
// licencji zostają po angielsku, poza katalogiem (`docs/localization.md`).

extension UICopy {
  public static var aboutSection: String { L("about.section") }
  public static var aboutReportProblem: String { L("about.reportProblem") }
  public static var aboutLicenses: String { L("about.licenses") }
  public static var aboutLicensesTitle: String { L("about.licensesTitle") }

  /// Nazwa linku produktu: ta sama na ekranie parowania i na stronie „O apce”.
  static func aboutLink(_ link: AboutLink, language: CopyLanguage = .current) -> String {
    switch link {
    case .privacy: L("about.privacy", language: language)
    case .setup: L("about.setup", language: language)
    case .support: L("about.support", language: language)
    }
  }

  /// „Wersja 1.0 (123)”; brak wartości w `Info.plist` = „—” w jej miejscu.
  static func aboutVersion(_ info: AboutInfo, language: CopyLanguage = .current) -> String {
    L("about.version", language: language, info.version ?? AboutInfo.missing, info.build ?? AboutInfo.missing)
  }

  static func aboutLicensesMissing(language: CopyLanguage = .current) -> String {
    L("about.licensesMissing", language: language)
  }

  static func aboutReportSubject(language: CopyLanguage = .current) -> String {
    L("about.reportSubject", language: language)
  }

  static func aboutReportBody(language: CopyLanguage = .current) -> String {
    L("about.reportBody", language: language)
  }
}
