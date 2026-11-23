@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Tytuł w lewym górnym rogu nagłówka sesji (runda 4): pasek narzędzi proponuje elementowi z boku jego minimum,
/// a sama elastyczna ramka dawała wtedy zero szerokości (tytuł znikał obok przycisku, zmierzone na iOS 27).
@MainActor
final class HeaderLeadingTitleTests: XCTestCase {
  func testTitleKeepsIdealWidthUnderZeroProposal() {
    let title = HeaderLeadingTitle(title: "willow", subtitle: "~/Projects/willow", maxWidth: 284)
    let host = UIHostingController(rootView: title)
    let squeezed = host.sizeThatFits(in: .zero)
    let free = host.sizeThatFits(in: CGSize(width: 1_000, height: 200))
    XCTAssertGreaterThan(squeezed.width, 60, "propozycja zera nie ściska tytułu: \(squeezed)")
    XCTAssertEqual(squeezed.width, free.width, accuracy: 0.5, "szerokość to ideał tekstu")
    XCTAssertLessThan(free.width, 284, "krótki tytuł nie zajmuje całego sufitu")
  }

  /// Długi tytuł i ścieżka zatrzymują się na suficie (`HeaderMetrics.titleMaxWidth`) i tam się ucinają.
  func testLongTitleStopsAtCeiling() {
    let long = String(repeating: "bardzo-dluga-nazwa-projektu-", count: 4)
    let title = HeaderLeadingTitle(title: long, subtitle: "~/Projects/ACME/\(long)", maxWidth: 200)
    let host = UIHostingController(rootView: title)
    XCTAssertLessThanOrEqual(host.sizeThatFits(in: .zero).width, 200.5)
    XCTAssertLessThanOrEqual(host.sizeThatFits(in: CGSize(width: 1_000, height: 200)).width, 200.5)
  }
}
