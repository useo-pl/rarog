import UIKit
import XCTest

/// Geometria listy sesji przeciw serwerowi demo (poprawki wyglądu z iPhone'a): nagłówek
/// w jednym wierszu paska, który nie zmienia wysokości przy przewijaniu, stopka limitów przy krawędzi
/// ekranu i równy panel limitów. Właściciel: lista.
final class ListUITests: XCTestCase {
  override func setUp() {
    // Każde zgłoszenie osobno: czerwony przebieg ma pokazać wszystkie rozjazdy naraz.
    continueAfterFailure = true
  }

  /// „Header za duży, powinien być w jednej linii z Tailscale; przy przewijaniu animacja haczy":
  /// pasek bez dużego tytułu ma stałą wysokość, a „AGENCI (N)" stoi w jednym wierszu z „Nową sesją".
  @MainActor
  func testHeaderIsOneLineAndKeepsHeightWhileScrolling() async throws {
    let port = try DemoServer.requirePort()
    // Większe pismo i dodatkowa sesja: lista musi wystawać poza ekran, inaczej przewinięcie odbija
    // i nie ma czego mierzyć (osiem seedów demo mieści się na iPhonie w zwykłym piśmie).
    let control = DemoControl(port: port)
    try await control.reset()
    _ = try await control.create("idle", label: "M1 nagłówek")
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"]
    app.launch()
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    let newSession = element(app, "list.newSession")
    XCTAssertTrue(newSession.waitForAppearance(timeout: 5))
    let bar = app.navigationBars.containing(.any, identifier: "list.newSession").firstMatch
    XCTAssertTrue(bar.exists, "pasek listy")
    let list = element(app, "session.list")
    // Pierwszy wiersz na ekranie, nie konkretna sesja: w drzewie projekty stoją alfabetycznie, a przy dużym
    // piśmie komórek spoza ekranu nie ma w drzewie dostępności.
    let visible = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'session.' AND identifier != 'session.list'")).firstMatch
    XCTAssertTrue(visible.waitForAppearance(timeout: 5), "wiersz na ekranie")
    let first = element(app, visible.identifier)
    let barBefore = bar.frame
    let rowBefore = first.frame
    list.swipeUp(velocity: .slow)
    sleep(1)
    // Na iPadzie cała lista mieści się w kolumnie i nie ma czego przewijać; pasek mierzy się wtedy tylko
    // w spoczynku (duży tytuł zwijał się wyłącznie w stosie na iPhonie). Wiersz, który wyjechał poza ekran, zniknął
    // z drzewa dostępności — też przewinięcie; jego ramki się nie czyta.
    if !first.exists || first.frame.minY != rowBefore.minY {
      XCTAssertEqual(bar.frame.height, barBefore.height, accuracy: 0.5, "przewijanie nie zmienia wysokości paska")
      list.swipeDown(velocity: .fast)
      list.swipeDown(velocity: .fast)
    }

    let title = element(app, "list.title")
    XCTAssertTrue(title.waitForAppearance(timeout: 5), "„AGENCI (N)” w pasku listy")
    XCTAssertTrue(title.label.hasPrefix("Agenci ("), "czytnik słyszy zwykłą wielkość liter: \(title.label)")
    XCTAssertTrue(title.elementType == .other || title.elementType == .staticText)
    XCTAssertEqual(title.frame.midY, newSession.frame.midY, accuracy: 4, "jeden wiersz z „Nową sesją”")
    XCTAssertLessThan(title.frame.maxX, newSession.frame.minX, "tytuł po lewej")
    XCTAssertLessThan(bar.frame.height, 70, "bez dużego tytułu pod paskiem: \(bar.frame)")
    app.terminate()
    try await control.reset()
  }

  /// The footer card floats over the list: its edges stand 10 pt from the column, its bottom 14 pt above
  /// the screen edge on iPad (18 pt on an iPhone with a 34 pt home indicator), and the list scrolls under it — the
  /// list reaches the bottom of the screen. There is no expanded panel any more. The card is not a control, so the
  /// test sees only its content (the VoiceOver element) and adds the card's padding.
  @MainActor
  func testUsageCardFloatsOverTheListEdge() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "session list")
    let card = element(app, "list.usage")
    let loaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "27 procent"), object: card)
    XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 15), .completed, "demo numbers")
    let screen = app.windows.firstMatch.frame
    let column = element(app, "session.list").frame
    // `list.usage` is one static VoiceOver element, and its frame is the card's content: it sits inside the card's
    // padding (`ListFooterMetrics.cardPaddingSide` 6 pt, `cardPaddingBottom` 4 pt). Card edge = content edge + padding;
    // the content sits `contentDrop` (3 pt) lower in the bar.
    let side: CGFloat = 10 + 6
    let bottom: CGFloat = (UIDevice.current.userInterfaceIdiom == .pad ? 14 : 18) + 4 - 3
    XCTAssertEqual(screen.maxY - card.frame.maxY, bottom, accuracy: 1, "card above the screen edge: \(card.frame)")
    XCTAssertEqual(card.frame.minX - column.minX, side, accuracy: 1, "left edge: \(card.frame), column \(column)")
    // The content is as wide as its widest line, so on the right it may stop short of the padding, never past it.
    XCTAssertGreaterThanOrEqual(column.maxX - card.frame.maxX, side - 1, "right edge: \(card.frame), column \(column)")
    XCTAssertGreaterThanOrEqual(card.frame.height, 44, "card height")
    XCTAssertEqual(column.maxY, screen.maxY, accuracy: 1, "the list reaches the screen edge under the card")
    XCTAssertFalse(element(app, "list.usage.panel").exists, "no expanded panel")
  }

  /// Zamknięcie przesunięciem bez pytania i bez popovera: krótkie przesunięcie w lewo pokazuje czerwony przycisk, który
  /// zamyka od razu, a pełne przesunięcie zamyka bez stuknięcia — jak przełącznik „Przeczytane”. Sesje zakłada test
  /// (sterowanie demo); zasiewu nie zamyka.
  @MainActor
  func testSwipeClosesWithoutQuestion() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    // Sterowanie demo trzyma jedną sesję testu naraz (`create` zamyka poprzednią), więc druga powstaje po
    // zamknięciu pierwszej, przy działającej apce.
    let tapped = try await control.create("idle", label: "Zamknij stuknięciem")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)

    // Krótkie przesunięcie: czerwony przycisk, stuknięcie zamyka bez pytania.
    let first = DemoServer.reveal(app, tapped)
    XCTAssertTrue(first.exists, "sesja do zamknięcia stuknięciem")
    first.swipeLeft()
    let action = app.buttons["Zamknij panel w herdr"].firstMatch
    XCTAssertTrue(action.waitForAppearance(timeout: 5), "czerwony przycisk po przesunięciu")
    shot("przesuniecie")
    action.tap()
    XCTAssertTrue(first.waitForDisappearance(timeout: 10), "stuknięcie zamyka sesję")
    XCTAssertFalse(app.popovers.firstMatch.exists, "bez dymka z pytaniem")
    XCTAssertFalse(app.sheets.firstMatch.exists, "bez arkusza z pytaniem")

    // Pełne przesunięcie przez cały wiersz: zamyka bez stuknięcia.
    let swiped = try await control.create("idle", label: "Zamknij przesunięciem")
    XCTAssertTrue(DemoServer.row(app, swiped).waitForAppearance(timeout: 15), "druga sesja na liście")
    let second = DemoServer.reveal(app, swiped)
    XCTAssertTrue(second.exists, "sesja do zamknięcia przesunięciem")
    DemoServer.waitUntilStill(second)
    // Palec rusza z 3/4 wiersza, nie przy prawej krawędzi: na iPadzie kolumna listy kończy się 12 pt za wierszem
    // i start przy niej nie przesuwa wiersza (kolumna 300 pt).
    let row = second.frame
    let origin = app.coordinate(withNormalizedOffset: .zero)
    origin.withOffset(CGVector(dx: row.minX + row.width * 0.75, dy: row.midY)).press(
      forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: row.minX + 2, dy: row.midY)),
      withVelocity: .fast, thenHoldForDuration: 0)
    shot("pelne-przesuniecie")
    XCTAssertTrue(second.waitForDisappearance(timeout: 10), "pełne przesunięcie zamyka sesję: wiersz \(row)")
    XCTAssertFalse(app.popovers.firstMatch.exists, "bez dymka z pytaniem")
    XCTAssertFalse(app.sheets.firstMatch.exists, "bez arkusza z pytaniem")
  }

  private func shot(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }
}
