import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Komenda apki `/usage` na prawdziwym `SessionViewController` z fokusem w polu: `/usage`, `/cost`
/// i `/stats` wysłane przyciskiem „Wyślij” albo Returnem otwierają arkusz „Limity” — ekran prezentuje go sam, dymkiem
/// przy „Wyślij” na pełnym tle; do serwera nie idzie wysyłka, nie ma wpisu kolejki ani echa, a pole jest puste.
/// W oknie tego testu treść SwiftUI prezentowanego arkusza nie rusza (jego `.task` nie wywołuje
/// odczytu w 3 s), więc odczyt szczegółów i wiersze sprawdza `UsageUITests.testUsageCommandOpensLimitsSheet`
/// (demo), a źródła i godziny — `UsageSheetModelTests` (RarogUI). Ekran i transport:
/// `CommandSuggestionsKeysTests.Fixture`. Właściciel: pole.
@MainActor
final class UsageSheetUIKitTests: XCTestCase {
  typealias Fixture = CommandSuggestionsKeysTests.Fixture

  func testUsageAndSendOpensLimitsSheetAndSendsNothing() throws {
    let fixture = try Fixture(state: "waiting-input", pills: true)
    defer { close(fixture) }
    try fixture.type("/usa")
    XCTAssertEqual(
      fixture.composer.suggestionsView.rowViews.map(\.accessibilityIdentifier), ["commands.suggestion.usage"],
      "komenda apki na liście podpowiedzi")
    try fixture.press(.enter)
    XCTAssertEqual(fixture.composer.text, "/usage ", "pierwszy Return wstawia komendę apki jak każdą inną")
    try sendButton(fixture).sendActions(for: .primaryActionTriggered)
    fixture.wait("arkusz „Limity”") { self.presented(fixture) != nil }
    let sheet = try XCTUnwrap(presented(fixture))
    XCTAssertEqual(sheet.modalPresentationStyle, .popover)
    XCTAssertTrue(
      sheet.popoverPresentationController?.sourceView === fixture.composer.sendButtonView, "dymek przy „Wyślij”")
    XCTAssertEqual(sheet.view.backgroundColor, Palette.surface, "pełne tło zamiast szkła")
    XCTAssertEqual(sheet.popoverPresentationController?.backgroundColor, Palette.surface, "tło pod strzałką")
    XCTAssertTrue(sheet is UIHostingController<UsageSheet>, "arkusz „Limity”, nie dymek modelu")
    XCTAssertEqual(
      (sheet as? UIHostingController<UsageSheet>)?.rootView.ownSurface, true,
      "host UIKit: pełne tło stawia sam arkusz (popover stopki stawia je w swojej treści)")
    XCTAssertEqual(fixture.composer.text, "", "pole się czyści")
    XCTAssertFalse(fixture.composer.commandSuggestionsOpen, "lista zamknięta")
    settle()
    XCTAssertEqual(fixture.calls.read(\.sends), [], "nic nie idzie do panelu")
    XCTAssertTrue(fixture.store.state.outbox.isEmpty, "bez wpisu kolejki i bez echa")
  }

  /// Aliasy CLI `/cost` i `/stats` (z Returnem z klawiatury sprzętowej) otwierają ten sam arkusz; drugi „Wyślij”
  /// przy stojącym arkuszu nie otwiera drugiego okna, a tekst zostaje w polu.
  func testAliasesWithReturnOpenTheSameSheet() throws {
    for alias in ["/cost", "/Stats"] {
      let fixture = try Fixture(state: "running", pills: true)
      fixture.composer.textView.insertText(alias)
      XCTAssertFalse(fixture.composer.commandSuggestionsOpen, "\(alias): aliasów nie ma na liście")
      try fixture.press(.enter)
      fixture.wait("arkusz po \(alias)") { self.presented(fixture) != nil }
      XCTAssertEqual(fixture.composer.text, "", "\(alias): pole puste także przy pracującej turze")
      let sheet = presented(fixture)
      fixture.composer.textView.insertText("/usage")
      try sendButton(fixture).sendActions(for: .primaryActionTriggered)
      settle()
      XCTAssertTrue(presented(fixture) === sheet, "\(alias): stojący arkusz zostaje, drugiego okna nie ma")
      XCTAssertEqual(fixture.composer.text, "/usage", "\(alias): tekst zostaje do ponownego „Wyślij”")
      XCTAssertEqual(fixture.calls.read(\.sends), [], "\(alias): nic nie wychodzi")
      XCTAssertEqual(fixture.calls.read(\.interrupts), [], "\(alias): tura pracuje dalej")
      close(fixture)
    }
  }

  /// Dymek pigułki modelu prezentuje host pigułek — dziecko ekranu: `/usage` nad nim nie otwiera drugiego okna,
  /// tekst zostaje, nic nie wychodzi. Warunek to `overlayPresented`, ten sam co przy Esc (w tym
  /// oknie testu i sam `presentedViewController` ekranu widział dymek dziecka — zmierzone).
  func testUsageOverModelSheetOpensNothing() throws {
    let fixture = try Fixture(state: "waiting-input", pills: true)
    defer { close(fixture) }
    fixture.composer.textView.insertText("/model")
    try sendButton(fixture).sendActions(for: .primaryActionTriggered)
    fixture.wait("dymek modelu") { self.childPresented(fixture) != nil }
    let model = childPresented(fixture)
    fixture.composer.textView.insertText("/usage")
    try sendButton(fixture).sendActions(for: .primaryActionTriggered)
    settle()
    XCTAssertFalse(presented(fixture) is UIHostingController<UsageSheet>, "„Limity” nie wstają nad dymkiem modelu")
    XCTAssertTrue(childPresented(fixture) === model, "dymek modelu zostaje jedynym oknem")
    XCTAssertEqual(fixture.composer.text, "/usage", "tekst zostaje")
    XCTAssertEqual(fixture.calls.read(\.sends), [], "nic nie idzie do panelu")
  }

  /// The update steps from the list footer's "Server update available" row: the WINDOW size decides the popover
  /// (`stacked` from `MainSplitView` through `SessionListView`), not the size class of the list column, which is
  /// `compact` beside the detail too. Outside a view tree the environment has no size class — like the list column,
  /// not `regular`. A server that is not older than the app has no steps.
  func testFooterSheetFollowsWindowNotColumn() throws {
    let store = try ProjectTreeListTests.store()
    XCTAssertNil(ListFooter(store: store, stacked: false).updateSheet, "no probed version: no update steps")
    let version = #"{"version":"0.1.0","protocolVersion":3,"serverStartId":"test"}"#
    store.dispatch(.versionProbed(try JSONDecoder().decode(VersionInfo.self, from: Data(version.utf8))))
    let beside = try XCTUnwrap(ListFooter(store: store, stacked: false).updateSheet)
    XCTAssertFalse(beside.compact, "list beside the detail: a popover sized to its content (600 pt ceiling)")
    XCTAssertEqual(beside.update.server, "0.1.0", "the probed server version reaches the steps")
    XCTAssertTrue(try XCTUnwrap(ListFooter(store: store, stacked: true).updateSheet).compact, "stack: a sheet")
  }

  // MARK: - Pomocnicze

  /// Okno prezentowane przez dziecko ekranu (host pigułek: dymek modelu).
  private func childPresented(_ fixture: Fixture) -> UIViewController? {
    fixture.controller.children.lazy.compactMap(\.presentedViewController).first
  }

  private func presented(_ fixture: Fixture) -> UIViewController? {
    fixture.controller.presentedViewController
  }

  private func sendButton(_ fixture: Fixture) throws -> UIButton {
    try XCTUnwrap(fixture.composer.sendButtonView as? UIButton, "„Wyślij”")
  }

  /// Czas na żądanie, które nie powinno wyjść (wysyłka idzie w `Task`).
  private func settle() {
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
  }

  private func close(_ fixture: Fixture) {
    for sheet in [presented(fixture), childPresented(fixture)].compactMap({ $0 }) {
      sheet.presentingViewController?.dismiss(animated: false)
    }
    fixture.close()
  }
}
