@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Footer of the New Session sheet while the browser is open: the Choose label stays inside
/// the sheet at any name length and text size, because the actions stack when they do not fit side by side; on a wide
/// sheet with a short name the hint and the actions share one line.
@MainActor
final class NewSessionChooseBarTests: XCTestCase {
  private let longName = String(repeating: "bardzo-dluga-nazwa-katalogu-", count: 3)

  private func bar(name: String?, warning: String? = nil, size: DynamicTypeSize) -> UIHostingController<some View> {
    UIHostingController(rootView: NewSessionChooseBar(
      warning: warning, targetName: name, canCancel: true,
      cancel: {}, choose: {}, dismissWarning: {}, chooseAnyway: {}
    ).environment(\.dynamicTypeSize, size))
  }

  private func fitting(_ host: UIHostingController<some View>, width: CGFloat) -> CGSize {
    host.sizeThatFits(in: CGSize(width: width, height: 4_000))
  }

  func testLongNameStaysInsideAPhoneSheet() {
    for size in [DynamicTypeSize.large, .accessibility3] {
      let fit = fitting(bar(name: longName, size: size), width: 343)
      XCTAssertLessThanOrEqual(fit.width, 343.5, "\(size): \(fit)")
    }
  }

  func testWarningActionsStayInsideAPhoneSheetAtLargestText() {
    let warning = "~/Projects/x nie jest repozytorium i nie było tu sesji. Agent dostanie dostęp do całego katalogu."
    let fit = fitting(bar(name: longName, warning: warning, size: .accessibility5), width: 343)
    XCTAssertLessThanOrEqual(fit.width, 343.5, "\(fit)")
  }

  func testShortNameOnAWideSheetIsOneLine() {
    let fit = fitting(bar(name: "willow", size: .large), width: 600)
    XCTAssertLessThanOrEqual(fit.width, 600.5)
    XCTAssertLessThan(fit.height, 60, "hint, Cancel and Choose on one line: \(fit)")
  }
}
