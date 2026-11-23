import XCTest

/// Notatki projektu przeciw serwerowi demo: notatki demo żyją w pamięci serwera, zasiew to jedna notatka
/// w projekcie `data-loader` (sesja bez tury — pracujący `demo-rarog` strumieniuje, a XCUITest czekałby na spoczynek
/// apki przed każdym krokiem). Dowody idą z liczników serwera (`notesGets`, `notesPuts`, `noteText` w `/api/demo/control`):
/// dymek czyta, zamknięcie formularza zapisuje.
final class NotesUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// Ikona w pasku projektu z notatką → dymek do czytania z treścią → „Edytuj" → formularz; dopisek i zamknięcie
  /// zapisują na serwerze.
  @MainActor
  func testTabIconReadsThenFormSaves() async throws {
    let (app, control) = try await launchLoggedIn()
    openProject(app, session: "demo-data-loader")
    let icon = element(app, "tabs.note")
    XCTAssertTrue(icon.waitForAppearance(timeout: 10), "ikona notatki w pasku projektu")
    XCTAssertTrue(waitValue(icon, "jest treść"), "projekt z notatką: kształt „jest treść”")
    icon.tap()
    let panel = element(app, "note.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 10), "dymek do czytania")
    XCTAssertTrue(element(app, "note.reader").waitForAppearance(timeout: 10))
    XCTAssertTrue(
      app.textViews["note.reader"].value.map { "\($0)".contains("Przed deployem") } ?? false, "treść notatki demo")
    _ = try await control.wait("dymek czyta") { $0.notesGets >= 1 }

    element(app, "note.panel.edit").tap()
    let editor = app.textViews["note.editor"]
    XCTAssertTrue(editor.waitForAppearance(timeout: 10), "formularz po „Edytuj”")
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "dymek zszedł")
    // Bez stuknięcia w pole: „Edytuj” stawia kursor na końcu i daje klawiaturę (tap przeniósłby kursor).
    editor.typeText("\n- dopisek z testu UI")
    element(app, "note.close").tap()
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10), "formularz zamknięty")
    let stats = try await control.wait("zamknięcie zapisało") { $0.notesPuts >= 1 }
    XCTAssertTrue(stats.noteText?.hasSuffix("- dopisek z testu UI") == true, "dopisek na serwerze")
  }

  /// ⌘J otwiera formularz notatki bieżącego projektu, drugie ⌘J go zamyka; bez zmiany nic nie idzie na serwer.
  /// W pasku formularza stoi samo „×”, jak w innych formularzach: bez systemowego „wstecz” na pierwszej stronie.
  @MainActor
  func testCommandJTogglesForm() async throws {
    let (app, control) = try await launchLoggedIn()
    openProject(app, session: "demo-data-loader")
    XCTAssertTrue(element(app, "tabs.note").waitForAppearance(timeout: 10))
    app.typeKey("j", modifierFlags: .command)
    let editor = app.textViews["note.editor"]
    XCTAssertTrue(editor.waitForAppearance(timeout: 10), "⌘J otwiera formularz")
    let bar = app.navigationBars.containing(.button, identifier: "note.close").firstMatch
    XCTAssertTrue(bar.exists, "pasek formularza")
    XCTAssertEqual(bar.buttons.count, 1, "w pasku tylko „×”: \(bar.buttons.debugDescription)")
    app.typeKey("j", modifierFlags: .command)
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10), "drugie ⌘J zamyka")
    _ = try await control.stays("bez zmiany nie ma zapisu") { $0.notesPuts == 0 }
  }

  /// Esc i ⌘W zamykają formularz z zapisem przed upływem autozapisu (2 s): zakończenie prezentacji zapisuje każdą
  /// drogą, nie tylko przyciskiem. Symulator nie podaje apce klawisza Esc, więc Esc wykonuje sonda
  /// (`RAROG_UI_TEST_PROBE`): bierze polecenie Esc z łańcucha pierwszego respondenta tak, jak zrobiłaby to klawiatura.
  @MainActor
  func testEscapeAndCommandWSave() async throws {
    let (app, control) = try await launchLoggedIn(environment: ["RAROG_UI_TEST_PROBE": "1"])
    openProject(app, session: "demo-data-loader")
    XCTAssertTrue(element(app, "tabs.note").waitForAppearance(timeout: 10))
    app.typeKey("j", modifierFlags: .command)
    let editor = app.textViews["note.editor"]
    XCTAssertTrue(editor.waitForAppearance(timeout: 10))
    editor.typeText(" esc")
    let escape = probe(app, "escape")
    XCTAssertTrue(escape.hasPrefix("esc=NoteTextView") && escape.contains("sent=true"), "Esc trafia do pola: \(escape)")
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10), "Esc zamyka formularz")
    var stats = try await control.wait("Esc zapisało") { $0.notesPuts >= 1 }
    XCTAssertTrue(stats.noteText?.hasSuffix(" esc") == true)

    app.typeKey("j", modifierFlags: .command)
    XCTAssertTrue(editor.waitForAppearance(timeout: 10))
    editor.typeText(" w")
    app.typeKey("w", modifierFlags: .command)
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10), "⌘W zamyka formularz")
    stats = try await control.wait("⌘W zapisało") { $0.notesPuts >= 2 }
    XCTAssertTrue(stats.noteText?.hasSuffix(" esc w") == true)
  }

  /// Projekt bez notatki: kształt „pusta”, stuknięcie otwiera od razu formularz (bez dymka).
  @MainActor
  func testEmptyNoteOpensFormDirectly() async throws {
    let (app, _) = try await launchLoggedIn()
    openProject(app, session: "demo-willow")
    let icon = element(app, "tabs.note")
    XCTAssertTrue(icon.waitForAppearance(timeout: 10))
    XCTAssertTrue(waitValue(icon, "pusta"), "projekt bez notatki: kształt „pusta”")
    icon.tap()
    XCTAssertTrue(app.textViews["note.editor"].waitForAppearance(timeout: 10), "formularz od razu")
    XCTAssertFalse(element(app, "note.panel").exists, "bez dymka")
    element(app, "note.close").tap()
  }

  /// Menu kontekstowe nagłówka projektu w drzewie: „Notatka projektu” stawia dymek przy nagłówku.
  @MainActor
  func testTreeContextMenuOpensNote() async throws {
    let (app, _) = try await launchLoggedIn()
    let header = DemoServer.revealProject(app, "data-loader")
    XCTAssertTrue(header.waitForAppearance(timeout: 10))
    header.press(forDuration: 1.0)
    let item = DemoServer.menuItem(app, id: "tree.note", label: "Notatka projektu")
    XCTAssertTrue(item.waitForAppearance(timeout: 5), "pozycja w menu nagłówka")
    item.tap()
    XCTAssertTrue(element(app, "note.panel").waitForAppearance(timeout: 10), "dymek notatki z drzewa")
  }

  /// Glif notatki przy nagłówku projektu w drzewie jest przyciskiem: projekt bez notatki
  /// (willow) → formularz od razu, bez dymka; projekt z notatką (data-loader) → dymek do czytania przy nagłówku.
  @MainActor
  func testTreeGlyphOpensFormOrBubble() async throws {
    let (app, _) = try await launchLoggedIn()
    XCTAssertTrue(DemoServer.revealProject(app, "willow").waitForAppearance(timeout: 10))
    let empty = element(app, "tree.note-glyph.willow")
    XCTAssertTrue(empty.waitForAppearance(timeout: 10), "glif przy projekcie bez notatki")
    XCTAssertTrue(waitValue(empty, "pusta"), "projekt bez notatki: „pusta”")
    XCTAssertEqual(empty.elementType, .button, "glif to przycisk, osobny od nagłówka")
    empty.tap()
    let editor = app.textViews["note.editor"]
    XCTAssertTrue(editor.waitForAppearance(timeout: 10), "formularz od razu")
    XCTAssertFalse(element(app, "note.panel").exists, "bez dymka")
    element(app, "note.close").tap()
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10))

    XCTAssertTrue(DemoServer.revealProject(app, "data-loader").waitForAppearance(timeout: 10))
    let present = element(app, "tree.note-glyph.data-loader")
    XCTAssertTrue(present.waitForAppearance(timeout: 10), "glif przy projekcie z notatką")
    XCTAssertTrue(waitValue(present, "jest treść"), "projekt z notatką: „jest treść”")
    present.tap()
    XCTAssertTrue(element(app, "note.panel").waitForAppearance(timeout: 10), "dymek notatki z glifu w drzewie")
    XCTAssertFalse(editor.exists, "z treścią najpierw dymek, nie formularz")
  }

  /// Mikrofon w dymku: formularz bez klawiatury, nagranie od razu, dopisek od nowej linii. Zamknięcie w trakcie
  /// nagrania zapisuje hipotezę (przejęcie mikrofonu przez zamknięcie). Potem ⌘J, ⌥⌘M w polu (dopisek po spacji)
  /// i mikrofon w pasku formularza, który kończy z ostatnimi słowami. Głos ze scenariusza apki
  /// (`RAROG_UI_TEST_VOICE`): hipoteza „Dyktuję z", po zakończeniu „Dyktuję z iPada.".
  @MainActor
  func testBubbleMicDictatesOnNewLineAndClosingKeepsText() async throws {
    let (app, control) = try await launchLoggedIn(environment: ["RAROG_UI_TEST_VOICE": "1"])
    openProject(app, session: "demo-data-loader")
    let icon = element(app, "tabs.note")
    XCTAssertTrue(icon.waitForAppearance(timeout: 10))
    XCTAssertTrue(waitValue(icon, "jest treść"))
    icon.tap()
    let mic = element(app, "note.panel.mic")
    XCTAssertTrue(mic.waitForAppearance(timeout: 10), "mikrofon w stopce dymka")
    mic.tap()
    let editor = app.textViews["note.editor"]
    XCTAssertTrue(editor.waitForAppearance(timeout: 10), "formularz po mikrofonie")
    XCTAssertTrue(waitEditor(editor) { $0.hasSuffix("herdr.dev\nDyktuję z") }, "hipoteza od nowej linii: \(editor.value ?? "")")
    XCTAssertEqual(element(app, "note.status").label, "Nagrywam", "wiersz stanu mówi o nagraniu")
    element(app, "note.close").tap()
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10))
    var stats = try await control.wait("zamknięcie w nagraniu zapisało hipotezę") { $0.notesPuts >= 1 }
    XCTAssertTrue(stats.noteText?.hasSuffix("herdr.dev\nDyktuję z") == true, "na serwerze: \(stats.noteText ?? "nil")")

    app.typeKey("j", modifierFlags: .command)
    XCTAssertTrue(editor.waitForAppearance(timeout: 10))
    app.typeKey("m", modifierFlags: [.option, .command])
    XCTAssertTrue(waitEditor(editor) { $0.hasSuffix("Dyktuję z Dyktuję z") }, "⌥⌘M dopisuje po spacji: \(editor.value ?? "")")
    element(app, "note.mic").tap()
    XCTAssertTrue(waitEditor(editor) { $0.hasSuffix("Dyktuję z Dyktuję z iPada.") }, "drugi tap: ostatnie słowa w polu")
    element(app, "note.close").tap()
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10))
    stats = try await control.wait("zamknięcie zapisało dyktowanie") { $0.notesPuts >= 2 }
    XCTAssertTrue(stats.noteText?.hasSuffix("\nDyktuję z Dyktuję z iPada.") == true, "na serwerze: \(stats.noteText ?? "nil")")
  }

  /// ⌥⌘M działa w całym formularzu, nie tylko z kursorem w polu: mikrofon w dymku otwiera formularz BEZ klawiatury
  /// (klawiaturę trzyma kotwica arkusza), a skrót kończy nagranie z ostatnimi słowami, jak drugi tap mikrofonu.
  @MainActor
  func testDictationShortcutWithoutFieldFocus() async throws {
    let (app, _) = try await launchLoggedIn(environment: ["RAROG_UI_TEST_VOICE": "1"])
    openProject(app, session: "demo-data-loader")
    let icon = element(app, "tabs.note")
    XCTAssertTrue(icon.waitForAppearance(timeout: 10))
    XCTAssertTrue(waitValue(icon, "jest treść"))
    icon.tap()
    let mic = element(app, "note.panel.mic")
    XCTAssertTrue(mic.waitForAppearance(timeout: 10), "mikrofon w stopce dymka")
    mic.tap()
    let editor = app.textViews["note.editor"]
    XCTAssertTrue(editor.waitForAppearance(timeout: 10), "formularz po mikrofonie")
    XCTAssertTrue(waitEditor(editor) { $0.hasSuffix("herdr.dev\nDyktuję z") }, "nagranie trwa: \(editor.value ?? "")")
    XCTAssertEqual(element(app, "note.status").label, "Nagrywam")
    app.typeKey("m", modifierFlags: [.option, .command])
    XCTAssertTrue(
      waitEditor(editor) { $0.hasSuffix("herdr.dev\nDyktuję z iPada.") }, "⌥⌘M kończy nagranie: \(editor.value ?? "")")
    XCTAssertFalse(waitLabel(element(app, "note.status"), "Nagrywam", timeout: 2), "nagranie skończone")
    element(app, "note.close").tap()
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10))
  }

  /// Pusta notatka: wiersz stanu uprzedza, zamknięcie kasuje na serwerze, a dymek „Cofnij” przywraca treść.
  @MainActor
  func testEmptyingDeletesAndToastUndoes() async throws {
    let (app, control) = try await launchLoggedIn()
    openProject(app, session: "demo-data-loader")
    XCTAssertTrue(element(app, "tabs.note").waitForAppearance(timeout: 10))
    let original = try await control.wait("zasiew") { $0.noteText?.isEmpty == false }.noteText
    app.typeKey("j", modifierFlags: .command)
    let editor = app.textViews["note.editor"]
    XCTAssertTrue(editor.waitForAppearance(timeout: 10))
    app.typeKey("a", modifierFlags: .command)
    editor.typeText(XCUIKeyboardKey.delete.rawValue)
    XCTAssertTrue(waitEditor(editor) { $0.isEmpty }, "pole wyczyszczone: \(editor.value ?? "")")
    let status = element(app, "note.status")
    XCTAssertTrue(status.waitForAppearance(timeout: 5))
    XCTAssertEqual(status.label, "pusta — zamknięcie usunie notatkę")
    element(app, "note.close").tap()
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10))
    _ = try await control.wait("zamknięcie skasowało") { $0.notesPuts >= 1 && $0.noteText == "" }
    let undo = element(app, "toast.note.undo")
    XCTAssertTrue(undo.waitForAppearance(timeout: 10), "dymek z „Cofnij”")
    undo.tap()
    let stats = try await control.wait("„Cofnij” przywróciło") { $0.notesPuts >= 2 && $0.noteText?.isEmpty == false }
    XCTAssertEqual(stats.noteText, original, "treść sprzed skasowania")
    XCTAssertTrue(undo.waitForDisappearance(timeout: 5), "dymek zgasł po akcji")
  }

  /// Konflikt: zapis „z innego urządzenia” (kontrola demo) przy polu w nagraniu — pole brudne, autozapis stoi — daje
  /// baner z „Połącz” (obie strony tylko dopisały) i „Porównaj”. Strona porównania bierze klawiaturę (pole wiadomości
  /// pod arkuszem nie dostaje Return), Esc z niej wraca do pola. „Połącz” w trakcie nagrania najpierw oddaje
  /// nagranie: wynik idzie jednym `PUT` (wersja z serwera, potem mój dopisek) i nic go potem nie nadpisuje.
  @MainActor
  func testRemoteChangeWhileDictatingShowsBannerAndMerges() async throws {
    let (app, control) = try await launchLoggedIn(
      environment: ["RAROG_UI_TEST_VOICE": "1", "RAROG_UI_TEST_PROBE": "1"])
    let original = try await control.wait("zasiew") { $0.noteText?.isEmpty == false }.noteText ?? ""
    openProject(app, session: "demo-data-loader")
    XCTAssertTrue(element(app, "tabs.note").waitForAppearance(timeout: 10))
    app.typeKey("j", modifierFlags: .command)
    let editor = app.textViews["note.editor"]
    XCTAssertTrue(editor.waitForAppearance(timeout: 10))
    app.typeKey("m", modifierFlags: [.option, .command])
    XCTAssertTrue(waitEditor(editor) { $0.hasSuffix("herdr.dev Dyktuję z") }, "nagranie trwa: \(editor.value ?? "")")

    let theirs = original + "\n- z drugiego urządzenia"
    try await control.noteRemote(theirs)
    let banner = element(app, "note.banner")
    XCTAssertTrue(banner.waitForAppearance(timeout: 10), "baner konfliktu nad polem")
    XCTAssertTrue(element(app, "note.merge").exists, "same dopiski: „Połącz” na banerze")
    XCTAssertEqual(element(app, "note.status").label, "Nagrywam", "nagranie trwa mimo konfliktu")

    element(app, "note.compare").tap()
    let page = element(app, "note.compare.page")
    XCTAssertTrue(page.waitForAppearance(timeout: 10), "strona „Porównaj”")
    XCTAssertTrue(element(app, "note.version.server").exists && element(app, "note.version.mine").exists)
    XCTAssertTrue(element(app, "note.keepMine").exists && element(app, "note.takeTheirs").exists)
    let keyboard = probe(app, "inspect")
    XCTAssertTrue(keyboard.hasPrefix("fr=AnchorView"), "klawiatura na stronie, nie pod arkuszem: \(keyboard)")
    let escape = probe(app, "escape")
    XCTAssertTrue(escape.contains("sent=true"), "Esc ma odbiorcę na stronie: \(escape)")
    XCTAssertTrue(page.waitForDisappearance(timeout: 10), "Esc wraca do pola")
    let after = probe(app, "inspect")
    XCTAssertTrue(element(app, "note.close").waitForAppearance(timeout: 5), "formularz trwa po Esc: \(escape) | \(after)")
    XCTAssertTrue(editor.waitForAppearance(timeout: 5), "pole po powrocie")
    XCTAssertTrue(banner.waitForAppearance(timeout: 5), "baner po powrocie")

    // Systemowa strzałka „wstecz” stoi tylko na stronie (na pierwszej stronie jest samo „×”) i też wraca do pola.
    element(app, "note.compare").tap()
    XCTAssertTrue(page.waitForAppearance(timeout: 10))
    let back = app.navigationBars.containing(.any, identifier: "note.compare.title").firstMatch.buttons.element(boundBy: 0)
    XCTAssertTrue(back.waitForAppearance(timeout: 5), "strzałka „wstecz” na stronie „Porównaj”")
    back.tap()
    XCTAssertTrue(page.waitForDisappearance(timeout: 10), "strzałka wraca do pola")
    XCTAssertTrue(editor.waitForAppearance(timeout: 5) && banner.exists, "pole i baner po strzałce")

    element(app, "note.compare").tap()
    XCTAssertTrue(page.waitForAppearance(timeout: 10))
    _ = try await control.stays("konflikt nie zapisuje sam", for: .seconds(2)) { $0.notesPuts == 0 }
    element(app, "note.compare.merge").tap()
    XCTAssertTrue(page.waitForDisappearance(timeout: 10), "powrót do pola")
    XCTAssertTrue(banner.waitForDisappearance(timeout: 10), "baner znika po wyborze")
    let merged = theirs + "\n Dyktuję z"
    _ = try await control.wait("„Połącz” zapisało") { $0.notesPuts >= 1 }
    XCTAssertTrue(element(app, "note.status").label.hasPrefix("połączono z wersją z"), "„Cofnij” w wierszu stanu")
    // Nagranie oddane przed wyborem: spóźniona końcówka nie nadpisuje wyniku ani w polu, ani na serwerze.
    let stats = try await control.stays("wynik zostaje", for: .seconds(4)) { $0.notesPuts == 1 && $0.noteText == merged }
    XCTAssertEqual(stats.noteText, merged, "wersja z serwera, potem mój dopisek")
    XCTAssertEqual(editor.value as? String, merged)
  }

  /// Lustro markdownu zmienia wygląd, nie tekst: znaczniki wpisane z klawiatury zostają co do znaku, a kursor
  /// stoi tam, gdzie pisał człowiek (dalszy tekst dopisuje się na końcu, nie w środku przestylowanej linii).
  @MainActor
  func testMarkdownMirrorKeepsTextAndCursor() async throws {
    let (app, control) = try await launchLoggedIn()
    openProject(app, session: "demo-data-loader")
    XCTAssertTrue(element(app, "tabs.note").waitForAppearance(timeout: 10))
    app.typeKey("j", modifierFlags: .command)
    let editor = app.textViews["note.editor"]
    XCTAssertTrue(editor.waitForAppearance(timeout: 10))
    editor.typeText("\n## Nagłówek **gruby** `kod`\n- punkt")
    editor.typeText(" dalej")
    let typed = "\n## Nagłówek **gruby** `kod`\n- punkt dalej"
    XCTAssertTrue(waitEditor(editor) { $0.hasSuffix(typed) }, "pole co do znaku: \(editor.value ?? "")")
    element(app, "note.close").tap()
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10))
    let stats = try await control.wait("zamknięcie zapisało") { $0.notesPuts >= 1 }
    XCTAssertTrue(stats.noteText?.hasSuffix("herdr.dev" + typed) == true, "na serwerze: \(stats.noteText ?? "nil")")
  }

  // MARK: - Pomocnicze

  @MainActor
  private func waitLabel(_ element: XCUIElement, _ label: String, timeout: TimeInterval = 10) -> Bool {
    let predicate = NSPredicate(format: "label == %@", label)
    return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: element)], timeout: timeout) == .completed
  }

  /// Czeka, aż wartość pola notatki spełni warunek (placeholder to nie wartość: puste pole daje `""`).
  @MainActor
  private func waitEditor(_ editor: XCUIElement, timeout: TimeInterval = 10, _ check: @escaping (String) -> Bool) -> Bool {
    let predicate = NSPredicate { _, _ in check((editor.value as? String) ?? "") }
    return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout) == .completed
  }

  @MainActor
  private func launchLoggedIn(environment: [String: String] = [:]) async throws -> (XCUIApplication, DemoControl) {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let app = DemoServer.launch(port: port, environment: environment)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    return (app, control)
  }

  @MainActor
  private func openProject(_ app: XCUIApplication, session: String) {
    DemoServer.reveal(app, session).tap()
    XCTAssertTrue(element(app, "tab.\(session)").waitForAppearance(timeout: 10), "sesja otwarta")
    DemoServer.hideKeyboard(app)
  }

  /// Przycisk sondy `probe.<akcja>` i jej zapis stanu (wzór: `WindowsUITests`).
  @MainActor
  private func probe(_ app: XCUIApplication, _ action: String) -> String {
    let button = element(app, "probe.\(action)")
    guard button.waitForAppearance(timeout: 3) else { return "sonda: brak przycisku \(action)" }
    button.tap()
    return (element(app, "probe.state").value as? String) ?? "sonda: brak stanu"
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  @MainActor
  private func waitValue(_ element: XCUIElement, _ value: String, timeout: TimeInterval = 10) -> Bool {
    let predicate = NSPredicate(format: "value == %@", value)
    let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }
}
