import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

/// The iPad right panel narrows the session screen by its width (320 pt by default, live while its divider is
/// dragged) without a new controller: the width change goes through `holdPositionOnLayout`, like Cmd+B. A real
/// `SessionViewController` in a 13" landscape window (column 1056 pt → 736 pt with the panel and back, and drag-sized
/// steps): a pinned transcript stays at the bottom, an unpinned one on its reading row; the same with the on-screen
/// keyboard up, when the simulator shows it. Owner: panel.
@MainActor
final class InspectorWidthTests: XCTestCase {
  private static let wide: CGFloat = 1056
  private static let narrow: CGFloat = wide - 320

  func testPinnedTranscriptStaysAtBottomWhenPanelOpensAndCloses() throws {
    let (controller, window) = try Self.host()
    defer { window.isHidden = true }
    XCTAssertTrue(controller.pinned)
    XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "na dnie przed panelem")
    for width in [Self.narrow, Self.wide, Self.narrow] {
      Self.resize(window, width: width)
      XCTAssertEqual(controller.view.bounds.width, width, accuracy: 0.5)
      XCTAssertTrue(controller.pinned, "zmiana szerokości nie odpina (\(width) pt)")
      XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "na dnie przy \(width) pt")
    }
  }

  func testUnpinnedTranscriptKeepsReadingRowWhenPanelOpensAndCloses() throws {
    let (controller, window) = try Self.host()
    defer { window.isHidden = true }
    let reading = try Self.unpin(controller)
    for width in [Self.narrow, Self.wide] {
      Self.resize(window, width: width)
      XCTAssertFalse(controller.pinned, "zmiana szerokości nie przypina (\(width) pt)")
      XCTAssertEqual(Self.topRow(controller), reading, "czytany wiersz zostaje u góry przy \(width) pt")
    }
  }

  /// Dragging the panel's divider: 20 width changes of 8 pt, each laid out before the next without waiting for the
  /// run loop, as the live drag delivers them. A pinned transcript stays at the bottom, an unpinned one on its
  /// reading row.
  func testSmallWidthStepsKeepPinnedAndReadingRow() throws {
    let (controller, window) = try Self.host()
    defer { window.isHidden = true }
    for step in 1...20 {
      Self.step(window, width: Self.wide - CGFloat(8 * step))
      XCTAssertTrue(controller.pinned, "a drag step does not unpin (step \(step))")
    }
    Self.resize(window, width: window.frame.width)
    XCTAssertEqual(controller.view.bounds.width, Self.wide - 160, accuracy: 0.5)
    XCTAssertTrue(controller.pinned)
    XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "at the bottom after the drag")

    let reading = try Self.unpin(controller)
    for step in 1...20 {
      Self.step(window, width: Self.wide - 160 + CGFloat(8 * step))
      XCTAssertFalse(controller.pinned, "a drag step does not pin (step \(step))")
    }
    Self.resize(window, width: window.frame.width)
    XCTAssertFalse(controller.pinned)
    XCTAssertEqual(Self.topRow(controller), reading, "the reading row stays at the top after the drag")
  }

  /// Klawiatura ekranowa wysunięta (pole z fokusem): zmiana szerokości przy niej nie rusza przypięcia ani miejsca
  /// czytania. Symulator z klawiaturą sprzętową klawiatury ekranowej nie pokazuje — wtedy test mówi to wprost.
  func testWidthChangeWithOnScreenKeyboard() throws {
    let (controller, window) = try Self.host()
    defer {
      controller.composer.textView.resignFirstResponder()
      window.isHidden = true
    }
    controller.composer.textView.becomeFirstResponder()
    for _ in 0..<40 where controller.view.keyboardLayoutGuide.layoutFrame.height < 100 { SessionToastTests.spin(0.05) }
    guard controller.view.keyboardLayoutGuide.layoutFrame.height >= 100 else {
      throw XCTSkip("symulator nie pokazał klawiatury ekranowej (klawiatura sprzętowa) — przypadek niesprawdzony")
    }
    SessionToastTests.spin(0.5)
    Self.layout(window)
    XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "przypięty na dnie nad klawiaturą")
    Self.resize(window, width: Self.narrow)
    XCTAssertTrue(controller.pinned)
    XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "panel przy klawiaturze: dalej na dnie")
    let reading = try Self.unpin(controller)
    Self.resize(window, width: Self.wide)
    XCTAssertFalse(controller.pinned)
    XCTAssertEqual(Self.topRow(controller), reading, "czytany wiersz przy klawiaturze zostaje")
  }

  // MARK: - Pomocnicze

  private static func host() throws -> (SessionViewController, UIWindow) {
    let store = try SessionToastTests.makeStore(messages: 60)
    TranscriptMemory.positions.remember("s1", nil)
    let controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: wide, height: 1032))
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = controller
    window.isHidden = false
    layout(window)
    SessionToastTests.spin(0.2)
    layout(window)
    let list = try XCTUnwrap(controller.collectionView)
    XCTAssertGreaterThan(list.contentSize.height, list.bounds.height * 2, "treść dłuższa niż ekran")
    return (controller, window)
  }

  private static func layout(_ window: UIWindow) {
    for _ in 0..<3 {
      window.setNeedsLayout()
      window.layoutIfNeeded()
    }
  }

  /// Panel otwiera się albo zamyka: kolumna sesji zmienia szerokość, kontroler zostaje ten sam.
  private static func resize(_ window: UIWindow, width: CGFloat) {
    window.frame = CGRect(x: 0, y: 0, width: width, height: window.frame.height)
    layout(window)
    SessionToastTests.spin(0.1)
    layout(window)
  }

  /// One step of a live drag: the new width and a layout pass, without turning the run loop.
  private static func step(_ window: UIWindow, width: CGFloat) {
    window.frame = CGRect(x: 0, y: 0, width: width, height: window.frame.height)
    window.layoutIfNeeded()
  }

  /// Gest odjechał od dna i skończył się w środku treści — jak `scrollViewDidEndDragging`: odpięcie i zapis miejsca.
  private static func unpin(_ controller: SessionViewController) throws -> String {
    let list = try XCTUnwrap(controller.collectionView)
    list.setContentOffset(CGPoint(x: 0, y: list.contentSize.height / 2), animated: false)
    list.layoutIfNeeded()
    controller.pinned = false
    controller.rememberPosition()
    return try XCTUnwrap(topRow(controller), "wiersz u góry po odjechaniu")
  }

  /// Pierwszy wiersz, którego góra stoi w widocznej części (pod wstawką listy).
  private static func topRow(_ controller: SessionViewController) -> String? {
    guard let list = controller.collectionView else { return nil }
    let top = list.contentOffset.y + list.adjustedContentInset.top
    return list.indexPathsForVisibleItems
      .compactMap { index -> (String, CGFloat)? in
        guard let id = controller.dataSource.itemIdentifier(for: index),
          let frame = list.layoutAttributesForItem(at: index)?.frame, frame.maxY > top + 1
        else { return nil }
        return (id, frame.minY)
      }
      .min { $0.1 < $1.1 }?.0
  }
}
