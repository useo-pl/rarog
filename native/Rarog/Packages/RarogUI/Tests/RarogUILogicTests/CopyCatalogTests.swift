import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogUI
import Testing

// Katalog copy pakietu `RarogUI` (`docs/localization.md`): proces testów ma przypięty język, funkcja `L` sięga do
// `Bundle.module` pakietu, a każdy klucz katalogu oddaje literał z zamrożonego zrzutu rejestru Swift.
// Session switcher of recent sessions: the `switcher.*` entries of the snapshot say
// "Ostatnie" instead of "Aktywne"; the removed hint keys left the snapshot. The old activity row's silence tail keys
// (`activity.noNews`, `activity.longHint`) left it with that row.
@Suite("katalog copy RarogUI: język procesu, funkcja L i każdy klucz jak w zrzucie rejestru")
struct CopyCatalogTests {
  static let tests = URL(filePath: #filePath).deletingLastPathComponent()

  @Test("proces testów na pl (RAROG_COPY_LANGUAGE z bramki); brakujący klucz oddaje sam klucz w obu wariantach L")
  func pinnedAndReachable() {
    #expect(CopyLanguage.current == .pl)
    #expect(L("l0.brakujacy.klucz") == "l0.brakujacy.klucz")
    #expect(L("l0.brakujacy.klucz", language: .en) == "l0.brakujacy.klucz")
  }

  @Test("każdy klucz katalogu: L z próbnymi argumentami daje literał z zrzutu rejestru")
  func everyKeyMatchesBaseLiteral() throws {
    let catalog = Self.tests.deletingLastPathComponent().deletingLastPathComponent()
      .appending(path: "Sources/RarogUI/Copy/Localizable.xcstrings")
    let problems = try CopyCatalogBaseline.mismatches(
      fixture: Self.tests.appending(path: "Fixtures/copy-catalog-baseline.json"), catalog: catalog,
      lookup: { key, arguments in L(key, language: .pl, arguments: arguments) })
    #expect(problems.isEmpty, "\(problems.count) różnic:\n\(problems.prefix(40).joined(separator: "\n"))")
  }
}
