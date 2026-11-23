import Foundation
import RarogContract
import XCTest

/// Język procesu testów UIKit (`docs/localization.md`, „Tests”). Testy UIKit idą bez apki-gospodarza, w procesie
/// testów na symulatorze, a asercje stoją na polskich zdaniach: język copy przypina zmienna `RAROG_COPY_LANGUAGE`
/// ze schematu `Rarog`, a język procesu `-testLanguage pl -testRegion PL` przy `xcodebuild test`
/// (`scripts/ios-check.sh`, przepis „Selected tests next to other sessions” w `native/Rarog/docs/tests.md`). Zmierzone:
/// `-testLanguage en -testRegion US` daje temu procesowi `["en"]` i `en_US`, więc na symulatorze w `en_US`
/// (symulator bramki) test łapie brak flag. Świeży symulator z `simctl create` bierze język Maca, tam brak przejdzie.
final class LanguagePinTests: XCTestCase {
  func testCopyLanguageIsPinnedToPolish() {
    XCTAssertEqual(ProcessInfo.processInfo.environment[CopyLanguage.environmentKey], "pl", "zmienna ze schematu Rarog")
    XCTAssertEqual(CopyLanguage.current, .pl)
  }

  func testProcessLanguageAndRegionArePolish() {
    let first = Locale.preferredLanguages.first.flatMap { Locale.Language(identifier: $0).languageCode?.identifier }
    XCTAssertEqual(first, "pl", "xcodebuild test bez -testLanguage pl: \(Locale.preferredLanguages)")
    XCTAssertEqual(Locale.current.region?.identifier, "PL", "xcodebuild test bez -testRegion PL: \(Locale.current)")
  }
}
