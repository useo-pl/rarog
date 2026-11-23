import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogActivity
import Testing

// Copy catalog of the `RarogActivity` package (`docs/localization.md`): the test process has a pinned language, `L`
// reaches the package `Bundle.module`, and every catalog key gives the literal of the registry baseline snapshot.
@Suite("katalog copy RarogActivity: język procesu, funkcja L i każdy klucz jak w zrzucie bazowym")
struct CopyCatalogTests {
  static let tests = URL(filePath: #filePath).deletingLastPathComponent()

  @Test("proces testów na pl (RAROG_COPY_LANGUAGE z bramki); brakujący klucz oddaje sam klucz w obu wariantach L")
  func pinnedAndReachable() {
    #expect(CopyLanguage.current == .pl)
    #expect(L("l0.brakujacy.klucz") == "l0.brakujacy.klucz")
    #expect(L("l0.brakujacy.klucz", language: .en) == "l0.brakujacy.klucz")
  }

  @Test("każdy klucz zrzutu bazowego: L z próbnymi argumentami daje literał rejestru z gałęzi bazowej (zrzut)")
  func everyKeyMatchesBaseLiteral() throws {
    let catalog = Self.tests.deletingLastPathComponent().deletingLastPathComponent()
      .appending(path: "Sources/RarogActivity/Copy/Localizable.xcstrings")
    let problems = try CopyCatalogBaseline.mismatches(
      fixture: Self.tests.appending(path: "Fixtures/copy-catalog-baseline.json"), catalog: catalog,
      lookup: { key, arguments in L(key, language: .pl, arguments: arguments) })
    #expect(problems.isEmpty, "\(problems.count) różnic:\n\(problems.prefix(40).joined(separator: "\n"))")
  }
}
