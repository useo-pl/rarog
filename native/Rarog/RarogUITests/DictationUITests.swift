import XCTest

/// Ekran „Dyktowanie” i obie trasy dyktowania przeciw serwerowi demo, build domyślny (`RAROG_VOICE_SONIOX = YES`).
/// Wybór żyje w pamięci apki (`DemoServer.dictation`): `none` = brak wyboru, więc pierwsze stuknięcie mikrofonu
/// otwiera ekran i niczego nie nagrywa, a nagrywa dopiero następne. Demo zgłasza `voiceEnabled`, więc opcja
/// Soniox jest do wybrania. Mikrofon, gniazdo Soniox i rozpoznawanie systemowe grają scenariusz apki
/// (`RAROG_UI_TEST_VOICE`): obie trasy dają w polu „Dyktuję z”, a po zakończeniu „Dyktuję z iPada.”, w każdym języku
/// apki. Trasa Soniox bierze klucz z demo (`POST /api/voice/token`), systemowa nie. Build z `RAROG_VOICE_SONIOX = NO`:
/// `VoiceFlagUITests`.
final class DictationUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// Teksty ekranu w języku apki, przepisane z katalogu RarogUI (`Localizable.xcstrings`, klucz przy każdym): cel
  /// testów UI nie linkuje pakietów.
  private struct Texts {
    let chooseSystem: String  // dictation.system.choose
    let chooseSoniox: String  // dictation.soniox.choose
    let selected: String  // dictation.selected
    let privacy: String  // dictation.privacy
    let systemTitle: String  // dictation.system.title
    let sonioxTitle: String  // dictation.soniox.title

    static let pl = Texts(
      chooseSystem: "Wybierz dyktowanie systemowe", chooseSoniox: "Wybierz Soniox", selected: "Wybrane",
      privacy: "Dyktowanie w polityce prywatności", systemTitle: "Dyktowanie systemowe",
      sonioxTitle: "Soniox przez Twój serwer")
    static let en = Texts(
      chooseSystem: "Use System Dictation", chooseSoniox: "Use Soniox", selected: "Selected",
      privacy: "Dictation in the Privacy Policy", systemTitle: "System Dictation", sonioxTitle: "Soniox via Your Server")

    func title(_ choice: String) -> String { choice == "soniox" ? sonioxTitle : systemTitle }
  }

  // MARK: - Ekran z mikrofonu, wybór systemowego

  @MainActor
  func testFirstTapAsksThenSystemRecordsOnSecondTap() throws {
    try chooseSystemFromSheet(language: .pl, texts: .pl)
  }

  @MainActor
  func testFirstTapAsksThenSystemRecordsOnSecondTapInEnglish() throws {
    try chooseSystemFromSheet(language: .en, texts: .en)
  }

  // MARK: - Ekran z mikrofonu, wybór Soniox

  @MainActor
  func testChoosingSonioxRecordsThroughDemoKey() throws {
    try chooseSonioxFromSheet(language: .pl, texts: .pl)
  }

  @MainActor
  func testChoosingSonioxRecordsThroughDemoKeyInEnglish() throws {
    try chooseSonioxFromSheet(language: .en, texts: .en)
  }

  // MARK: - Ustawienia → „Dyktowanie”

  /// The Soniox choice in the Dictation row of the Settings list and the Soniox option on the Dictation page, selected
  /// and without a state line or setup steps, because the demo offers Soniox; switching to system dictation on the
  /// page works from the next mic tap, without the sheet.
  @MainActor
  func testSettingsShowSonioxAndSwitchToSystem() throws {
    let app = try openComposer(choice: "soniox")
    element(app, "list.settings").tap()
    let form = element(app, "settings.form")
    XCTAssertTrue(form.waitForAppearance(timeout: 10), "Settings")
    let row = DemoServer.revealSettings(app, "settings.row.dictation", in: form)
    XCTAssertTrue(row.exists, "Dictation row on the Settings list")
    XCTAssertTrue(waitText(row) { $0.contains("Soniox przez Twój serwer") }, "Soniox chosen: \(text(row))")

    let page = DemoServer.openSettingsPage(app, "dictation")
    let soniox = scroll(to: element(app, "dictation.choose.soniox"), in: page, up: false)
    XCTAssertTrue(soniox.waitForAppearance(timeout: 5))
    XCTAssertEqual(soniox.label, Texts.pl.selected, "Soniox wybrany")
    XCTAssertFalse(element(app, "dictation.soniox.state").exists, "the demo reports voiceEnabled: no state line")
    XCTAssertFalse(element(app, "dictation.soniox.setup.steps").exists, "no setup steps while Soniox is available")
    let system = scroll(to: element(app, "dictation.choose.system"), in: page, up: false)
    XCTAssertEqual(system.label, Texts.pl.chooseSystem)
    system.tap()
    XCTAssertTrue(waitLabel(system, Texts.pl.selected), "systemowe wybrane: \(system.label)")
    XCTAssertEqual(soniox.label, Texts.pl.chooseSoniox, "Soniox już niewybrany")
    XCTAssertTrue(page.exists, "w Ustawieniach wybór nie zamyka strony")

    let back = app.navigationBars["Dyktowanie"].buttons.element(boundBy: 0)
    XCTAssertTrue(back.waitForAppearance(timeout: 5), "„wstecz” na stronie „Dyktowanie”")
    back.tap()
    XCTAssertTrue(page.waitForDisappearance(timeout: 10), "powrót do Ustawień")
    XCTAssertTrue(waitText(row) { $0.contains("Dyktowanie systemowe") }, "wiersz z nowym wyborem: \(text(row))")
    element(app, "settings.close").tap()
    XCTAssertTrue(element(app, "settings.form").waitForDisappearance(timeout: 10), "Ustawienia zamknięte")

    app.buttons["composer.mic"].tap()
    XCTAssertTrue(waitField(app, equals: "Dyktuję z"), "nagrywa od razu: \(fieldValue(app))")
    XCTAssertFalse(element(app, "dictation.sheet").exists, "bez arkusza po wyborze w Ustawieniach")
    app.buttons["composer.mic"].tap()
    XCTAssertTrue(waitField(app, equals: "Dyktuję z iPada."), "końcówka w polu: \(fieldValue(app))")
  }

  // MARK: - „Dyktuj” z listy projektów bez wyboru

  /// Mikrofon w dymku notatki z drzewa projektów: formularz notatki otwiera się ze stroną „Dyktowanie” zamiast
  /// nagrania. Wybór wraca do pola i dalej nic nie nagrywa; nagrywa następne stuknięcie mikrofonu w pasku formularza.
  @MainActor
  func testNoteDictateFromTreeAsksInsideNote() async throws {
    let port = try DemoServer.requirePort()
    try await DemoControl(port: port).reset()
    let app = DemoServer.launch(port: port, environment: DemoServer.dictation("none"))
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    let header = DemoServer.revealProject(app, "data-loader")
    XCTAssertTrue(header.waitForAppearance(timeout: 10))
    header.press(forDuration: 1.0)
    let item = DemoServer.menuItem(app, id: "tree.note", label: "Notatka projektu")
    XCTAssertTrue(item.waitForAppearance(timeout: 5), "pozycja w menu nagłówka")
    item.tap()
    XCTAssertTrue(element(app, "note.panel").waitForAppearance(timeout: 10), "dymek notatki z drzewa")
    let panelMic = element(app, "note.panel.mic")
    XCTAssertTrue(panelMic.waitForAppearance(timeout: 10), "mikrofon w stopce dymka")
    panelMic.tap()

    let page = element(app, "dictation.page")
    XCTAssertTrue(page.waitForAppearance(timeout: 10), "strona „Dyktowanie” w formularzu notatki")
    XCTAssertTrue(element(app, "dictation.option.system").exists && element(app, "dictation.option.soniox").exists)
    XCTAssertFalse(waitLabel(element(app, "note.status"), "Nagrywam", timeout: 2), "nic nie nagrywa")

    element(app, "dictation.choose.system").tap()
    XCTAssertTrue(page.waitForDisappearance(timeout: 10), "wybór wraca do pola")
    let editor = app.textViews["note.editor"]
    XCTAssertTrue(editor.waitForAppearance(timeout: 10), "pole notatki")
    XCTAssertFalse(waitEditor(editor, timeout: 2) { $0.hasSuffix("Dyktuję z") }, "wybór nie nagrywa: \(editorValue(editor))")
    XCTAssertFalse(element(app, "note.status").label == "Nagrywam", "wiersz stanu bez nagrania")

    element(app, "note.mic").tap()
    XCTAssertTrue(waitEditor(editor) { $0.hasSuffix("Dyktuję z") }, "następne stuknięcie nagrywa: \(editorValue(editor))")
    XCTAssertEqual(element(app, "note.status").label, "Nagrywam")
    element(app, "note.mic").tap()
    XCTAssertTrue(waitEditor(editor) { $0.hasSuffix("Dyktuję z iPada.") }, "końcówka w polu: \(editorValue(editor))")
    element(app, "note.close").tap()
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10), "formularz zamknięty")
  }

  // MARK: - Przebiegi

  /// Arkusz z dwiema opcjami i linkiem prywatności; „systemowe” zamyka arkusz bez nagrania; drugie stuknięcie
  /// nagrywa.
  @MainActor
  private func chooseSystemFromSheet(language: DemoServer.AppLanguage, texts: Texts) throws {
    let app = try openComposer(choice: "none", language: language)
    let mic = app.buttons["composer.mic"]
    mic.tap()
    let sheet = expectSheet(app, texts: texts)
    XCTAssertFalse(mic.isSelected, "arkusz niczego nie nagrywa")
    XCTAssertTrue(fieldValue(app).isEmpty, "pole puste przy arkuszu: \(fieldValue(app))")

    element(app, "dictation.choose.system").tap()
    XCTAssertTrue(sheet.waitForDisappearance(timeout: 10), "wybór zamyka arkusz")
    expectIdle(app)

    mic.tap()
    XCTAssertTrue(waitField(app, equals: "Dyktuję z"), "drugie stuknięcie nagrywa: \(fieldValue(app))")
    XCTAssertFalse(element(app, "dictation.sheet").exists, "bez arkusza przy nagraniu")
    mic.tap()
    XCTAssertTrue(waitField(app, equals: "Dyktuję z iPada."), "końcówka w polu: \(fieldValue(app))")
    XCTAssertTrue(status(app).waitForDisappearance(timeout: 5), "nagranie zakończone")
    expectSettingsChoice(app, "system", texts: texts)
  }

  /// Wybór Soniox zamyka arkusz bez nagrania; stuknięcie nagrywa z kluczem z demo i skryptowym gniazdem.
  /// Scenariusz daje na obu trasach ten sam tekst, więc to, że arkusz zapisał Soniox, test sprawdza w Ustawieniach;
  /// to, że wybór `soniox` nagrywa silnikiem Soniox (klucz z serwera i gniazdo), pilnują testy UIKit
  /// `DictationRouteTests`.
  @MainActor
  private func chooseSonioxFromSheet(language: DemoServer.AppLanguage, texts: Texts) throws {
    let app = try openComposer(choice: "none", language: language)
    let mic = app.buttons["composer.mic"]
    mic.tap()
    let sheet = expectSheet(app, texts: texts)
    let soniox = element(app, "dictation.choose.soniox")
    soniox.tap()
    XCTAssertTrue(sheet.waitForDisappearance(timeout: 10), "wybór Soniox zamyka arkusz")
    expectIdle(app)

    mic.tap()
    XCTAssertTrue(waitField(app, equals: "Dyktuję z"), "nagranie przez Soniox: \(fieldValue(app))")
    XCTAssertFalse(element(app, "dictation.sheet").exists, "bez arkusza przy nagraniu")
    mic.tap()
    XCTAssertTrue(waitField(app, equals: "Dyktuję z iPada."), "końcówka w polu: \(fieldValue(app))")
    XCTAssertTrue(status(app).waitForDisappearance(timeout: 5), "nagranie zakończone")
    expectSettingsChoice(app, "soniox", texts: texts)
  }

  /// Settings → Dictation: the list row and the page show the choice saved on the sheet (`choice`: `system` or
  /// `soniox`), the other option is not chosen.
  @MainActor
  private func expectSettingsChoice(_ app: XCUIApplication, _ choice: String, texts: Texts) {
    element(app, "list.settings").tap()
    let form = element(app, "settings.form")
    XCTAssertTrue(form.waitForAppearance(timeout: 10), "Settings")
    let row = DemoServer.revealSettings(app, "settings.row.dictation", in: form)
    XCTAssertTrue(row.exists, "Dictation row on the Settings list")
    XCTAssertTrue(waitText(row) { $0.contains(texts.title(choice)) }, "\(choice) chosen in Settings: \(text(row))")
    DemoServer.openSettingsPage(app, "dictation")
    let other = choice == "soniox" ? "system" : "soniox"
    let chosen = element(app, "dictation.choose.\(choice)")
    XCTAssertTrue(chosen.waitForAppearance(timeout: 5))
    XCTAssertEqual(chosen.label, texts.selected, "\(choice) wybrany na stronie")
    XCTAssertTrue(chosen.isSelected, "\(choice) z cechą „wybrane”")
    let rest = element(app, "dictation.choose.\(other)")
    XCTAssertEqual(rest.label, other == "soniox" ? texts.chooseSoniox : texts.chooseSystem, "\(other) niewybrany")
  }

  /// Arkusz „Dyktowanie”: opcja systemowa i Soniox do wybrania (demo zgłasza `voiceEnabled`; sonda wersji może dojść
  /// dopiero przy otwartym arkuszu), link do polityki prywatności, przyciski w języku apki.
  @MainActor
  private func expectSheet(_ app: XCUIApplication, texts: Texts) -> XCUIElement {
    let sheet = element(app, "dictation.sheet")
    XCTAssertTrue(sheet.waitForAppearance(timeout: 10), "arkusz „Dyktowanie” po pierwszym stuknięciu")
    XCTAssertTrue(element(app, "dictation.option.system").exists, "opcja systemowa")
    XCTAssertTrue(element(app, "dictation.option.soniox").exists, "opcja Soniox")
    let system = element(app, "dictation.choose.system")
    XCTAssertEqual(system.label, texts.chooseSystem)
    XCTAssertTrue(system.isEnabled)
    let soniox = element(app, "dictation.choose.soniox")
    XCTAssertEqual(soniox.label, texts.chooseSoniox)
    XCTAssertTrue(waitEnabled(soniox), "Soniox dostępny na demo")
    // Link stoi pod opcjami: w arkuszu bywa poza ekranem, a komórek poza ekranem nie ma w drzewie dostępności.
    let privacy = scroll(to: element(app, "dictation.privacy"), in: sheet, up: true)
    XCTAssertTrue(privacy.exists, "link prywatności")
    XCTAssertTrue(privacy.label.contains(texts.privacy), "link prywatności: \(privacy.label)")
    _ = scroll(to: system, in: sheet, up: false)
    return sheet
  }

  /// Przewija arkusz, aż element stanie na ekranie (`up` = ku dołowi treści).
  @MainActor
  private func scroll(to target: XCUIElement, in container: XCUIElement, up: Bool) -> XCUIElement {
    for _ in 0..<5 {
      if target.exists, target.isHittable { return target }
      if up { container.swipeUp(velocity: .slow) } else { container.swipeDown(velocity: .slow) }
    }
    return target
  }

  /// Po wyborze mikrofon bezczynny: bez nagrania, bez wiersza stanu, pole nietknięte.
  @MainActor
  private func expectIdle(_ app: XCUIApplication) {
    XCTAssertFalse(waitField(app, equals: "Dyktuję z", timeout: 2), "wybór nie nagrywa: \(fieldValue(app))")
    XCTAssertFalse(app.buttons["composer.mic"].isSelected, "mikrofon bezczynny")
    XCTAssertFalse(status(app).exists, "bez wiersza stanu nagrania")
    XCTAssertTrue(fieldValue(app).isEmpty, "pole nietknięte: \(fieldValue(app))")
  }

  // MARK: - Pomocnicze

  @MainActor
  private func openComposer(choice: String, language: DemoServer.AppLanguage = .pl) throws -> XCUIApplication {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port, environment: DemoServer.dictation(choice), language: language)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-rarog").tap()
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 15), "pole wiadomości")
    XCTAssertTrue(app.buttons["composer.mic"].waitForAppearance(timeout: 5), "mikrofon zawsze w polu")
    return app
  }

  @MainActor
  private func fieldValue(_ app: XCUIApplication) -> String {
    (app.textViews["composer.field"].value as? String) ?? ""
  }

  /// Czeka, aż wartość pola wiadomości będzie dokładnie taka.
  @MainActor
  private func waitField(_ app: XCUIApplication, equals text: String, timeout: TimeInterval = 10) -> Bool {
    let field = app.textViews["composer.field"]
    let predicate = NSPredicate { _, _ in (field.value as? String) == text }
    return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout) == .completed
  }

  @MainActor
  private func editorValue(_ editor: XCUIElement) -> String {
    (editor.value as? String) ?? ""
  }

  /// Czeka, aż wartość pola notatki spełni warunek.
  @MainActor
  private func waitEditor(_ editor: XCUIElement, timeout: TimeInterval = 10, _ check: @escaping (String) -> Bool) -> Bool {
    let predicate = NSPredicate { _, _ in check((editor.value as? String) ?? "") }
    return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout) == .completed
  }

  /// Etykieta i wartość wiersza razem: `LabeledContent` w wierszu formularza podaje je różnie zależnie od rodzaju.
  @MainActor
  private func text(_ element: XCUIElement) -> String {
    [element.label, element.value as? String ?? ""].joined(separator: " ")
  }

  @MainActor
  private func waitText(_ element: XCUIElement, timeout: TimeInterval = 10, _ check: @escaping (String) -> Bool) -> Bool {
    let predicate = NSPredicate { _, _ in check(self.text(element)) }
    return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout) == .completed
  }

  @MainActor
  private func waitLabel(_ element: XCUIElement, _ label: String, timeout: TimeInterval = 10) -> Bool {
    let predicate = NSPredicate(format: "label == %@", label)
    return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: element)], timeout: timeout) == .completed
  }

  @MainActor
  private func waitEnabled(_ element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
    let predicate = NSPredicate(format: "enabled == true")
    return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: element)], timeout: timeout) == .completed
  }

  @MainActor
  private func status(_ app: XCUIApplication) -> XCUIElement {
    app.staticTexts["composer.voice.status"]
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }
}
