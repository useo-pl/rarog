import RarogContract
@testable import RarogCore
@testable import RarogUI
import UIKit
import XCTest

/// Komendy apki na prawdziwym `SessionViewController` z pigułkami pod polem i fokusem w polu:
/// `/model` i `/effort` wysłane przyciskiem „Wyślij” albo Returnem z klawiatury sprzętowej otwierają dymek pigułki
/// modelu i nic nie wysyłają — bez żądania i bez wpisu kolejki; `/modelx` idzie zwykłą ścieżką. Model rozpoznania
/// i drogi: `AppCommandsTests` (RarogUI). Ekran i transport: `CommandSuggestionsKeysTests.Fixture`. Właściciel: pole.
@MainActor
final class AppCommandsUIKitTests: XCTestCase {
  typealias Fixture = CommandSuggestionsKeysTests.Fixture

  func testModelAndSendOpensModelSheetAndSendsNothing() throws {
    let fixture = try Fixture(state: "waiting-input", pills: true)
    defer { close(fixture) }
    try fixture.type("/model")
    XCTAssertEqual(
      fixture.composer.suggestionsView.rowViews.map(\.accessibilityIdentifier), ["commands.suggestion.model"],
      "komenda apki na liście podpowiedzi")
    try sendButton(fixture).sendActions(for: .primaryActionTriggered)
    fixture.wait("dymek modelu") { presented(fixture) != nil }
    XCTAssertEqual(fixture.composer.text, "", "pole się czyści")
    XCTAssertFalse(fixture.composer.commandSuggestionsOpen, "lista zamknięta")
    settle()
    XCTAssertEqual(fixture.calls.read(\.sends), [], "nic nie idzie do serwera")
    XCTAssertTrue(fixture.store.state.outbox.isEmpty, "bez wpisu kolejki i bez echa")
  }

  func testEffortWithHardwareReturnOpensModelSheet() throws {
    let fixture = try Fixture(state: "waiting-input", pills: true)
    defer { close(fixture) }
    try fixture.type("/eff")
    try fixture.press(.enter)
    XCTAssertEqual(fixture.composer.text, "/effort ", "pierwszy Return wstawia komendę apki jak każdą inną")
    XCTAssertNil(presented(fixture), "wstawienie niczego nie otwiera")
    try fixture.press(.enter)
    fixture.wait("dymek modelu po drugim Returnie") { presented(fixture) != nil }
    XCTAssertEqual(fixture.composer.text, "")
    settle()
    XCTAssertEqual(fixture.calls.read(\.sends), [])
    XCTAssertTrue(fixture.store.state.outbox.isEmpty)
  }

  func testModelxGoesTheUsualWay() throws {
    let fixture = try Fixture(state: "waiting-input", pills: true)
    defer { close(fixture) }
    fixture.composer.textView.insertText("/modelx")
    XCTAssertFalse(fixture.composer.commandSuggestionsOpen, "/modelx nie ma trafień")
    try sendButton(fixture).sendActions(for: .primaryActionTriggered)
    fixture.wait("zwykła wysyłka") { fixture.calls.read(\.sends) == ["/modelx"] }
    XCTAssertNil(presented(fixture), "bez dymku")
    XCTAssertEqual(fixture.composer.text, "")
  }

  /// Tura pracuje: pigułka otwiera dymek z jednym zdaniem dlaczego i „Zamknij” — komenda tak samo, ale tekst zostaje
  /// w polu do ponownego „Wyślij”, a lista podpowiedzi się zamyka.
  func testBlockedModelSheetKeepsText() throws {
    let fixture = try Fixture(state: "running", pills: true)
    defer { close(fixture) }
    try fixture.type("/model")
    try sendButton(fixture).sendActions(for: .primaryActionTriggered)
    fixture.wait("dymek modelu z powodem") { presented(fixture) != nil }
    XCTAssertEqual(fixture.composer.text, "/model", "tekst zostaje")
    XCTAssertFalse(fixture.composer.commandSuggestionsOpen, "lista zamknięta jak po wysyłce")
    settle()
    XCTAssertEqual(fixture.calls.read(\.sends), [])
    XCTAssertTrue(fixture.store.state.outbox.isEmpty)
  }

  /// Nowe wiersze pod otwartą listą (lista sesji doszła po komendach apki albo się odświeżyła): wiersz wybrany
  /// klawiszem zostaje wybrany i w widoku, a Return wstawia właśnie jego.
  func testNewRowsUnderListKeepKeyboardPick() throws {
    let fixture = try Fixture(state: "waiting-input", pills: true)
    defer { close(fixture) }
    try fixture.type("/")
    let list = fixture.composer.suggestionsView
    fixture.wait("lista sesji") { list.rowViews.count == 11 }
    fixture.controller.view.layoutIfNeeded()
    for _ in 0..<7 { try fixture.press(.down) }
    let extra = (1...5).map { CommandChoice(name: "a\($0)", kind: .local, source: .builtin) }
    fixture.composer.setCommandChoices(AppCommand.merged(with: extra + fixture.store.state.commandChoices(for: "s1")))
    fixture.controller.view.layoutIfNeeded()
    XCTAssertEqual(list.rowViews.count, 16, "pięć nowych wierszy przed /model")
    let row = try XCTUnwrap(list.rowViews.first { $0.accessibilityIdentifier == "commands.suggestion.model" })
    XCTAssertTrue(row.accessibilityTraits.contains(.selected), "wybór z klawiatury zostaje na /model")
    let visible = list.convert(list.bounds, to: nil)
    let frame = row.convert(row.bounds, to: nil)
    XCTAssertTrue(visible.contains(CGPoint(x: frame.midX, y: frame.midY)), "wybrany wiersz w widoku: \(visible), \(frame)")
    try fixture.press(.enter)
    XCTAssertEqual(fixture.composer.text, "/model ", "Return wstawia wybrany wiersz")
    try fixture.press(.enter)
    fixture.wait("dymek modelu") { presented(fixture) != nil }
    settle()
    XCTAssertEqual(fixture.calls.read(\.sends), [])
  }

  // MARK: - Pomocnicze

  /// Okno nad ekranem sesji: dymek pigułki prezentuje host pigułek (dziecko kontrolera).
  private func presented(_ fixture: Fixture) -> UIViewController? {
    fixture.controller.presentedViewController
      ?? fixture.controller.children.lazy.compactMap(\.presentedViewController).first
  }

  private func sendButton(_ fixture: Fixture) throws -> UIButton {
    try XCTUnwrap(buttons(in: fixture.composer).first { $0.accessibilityIdentifier == "composer.send" }, "„Wyślij”")
  }

  private func buttons(in view: UIView) -> [UIButton] {
    let own = (view as? UIButton).map { [$0] } ?? []
    return own + view.subviews.flatMap { buttons(in: $0) }
  }

  /// Czas na żądanie, które nie powinno wyjść (wysyłka idzie w `Task`).
  private func settle() {
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
  }

  private func close(_ fixture: Fixture) {
    if let sheet = presented(fixture) { sheet.presentingViewController?.dismiss(animated: false) }
    fixture.close()
  }
}
