import XCTest

/// Nagłówek sesji przeciw serwerowi demo: linia statusu z kontekstem i gitem, rozwinięcie
/// gita z listą plików z ramki `git-status` (bez żądań diffa), okno diffa od stukniętego pliku,
/// pigułka modelu w rzędzie kontrolek pod polem wiadomości z arkuszem „Model i effort" — odmowa
/// serwera, która zostawia arkusz ze zdaniem, i blokada przy pracującej sesji.
///
/// Demo: sesja `done` ma kartę stanu ZAMIAST pola, więc pigułka modelu stoi
/// tylko przy sesji, która przyjmuje wiadomości — test arkusza zakłada WŁASNĄ sesję w projekcie
/// pipe-link (nikt inny tam nie zakłada) i na końcu ją zamyka. Stan pozostałych sesji zależy od kolejności testów
/// (`FlowUITests` odpowiada na karty i pisze do `demo-rarog`), więc na `demo-willow` test
/// sprawdza tylko linię statusu, która stoi w każdym stanie, a wariant zablokowany szuka sesji,
/// która akurat pracuje. Lista plików w dymku przychodzi ramką `git-status`, której sesja demo z seeda nie
/// dostaje przy wejściu (serwer produkcyjny wysyła ją zawsze), więc dymek z plikami test otwiera we własnej sesji
/// i ramkę wysyła sam. Diff demo ma trzy pliki (`server/src/demo/seeds.ts`, `demoDiffFiles`). Trybu panelu
/// demo nie raportuje, więc pigułki trybu tu nie ma (logikę trybu sprawdzają `StoreSessionTests`
/// i `HeaderModelTests`).
final class HeaderUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testStatusLineGitDetailsAndDiff() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("idle", label: "M1 nagłówek")
    let app = try launchLoggedIn()
    DemoServer.reveal(app, "demo-willow").tap()
    let git = element(app, "header.git")
    XCTAssertTrue(git.waitForAppearance(timeout: 10), "linia statusu z gitem")
    XCTAssertTrue(git.label.contains("gałąź main"), "zdanie linii: \(git.label)")
    XCTAssertTrue(git.label.contains("2 commity do wypchnięcia"), "rozjazd z upstreamem: \(git.label)")
    snapshot(app, "naglowek-linia")

    // Dymek gita jest tylko na iPadzie: na telefonie linia otwiera panel sesji jako arkusz
    // (`WindowsUITests.testPopoverFitsContentAndClosesOnPhone`).
    guard UIDevice.current.userInterfaceIdiom == .pad else {
      throw XCTSkip("telefon: linia gita otwiera panel sesji jako arkusz, dymka gita nie ma")
    }
    // Rozwinięcie w sesji odbioru: lista plików przychodzi ramką `git-status` (litera + bilans z `fileDetails`),
    // a dymek NICZEGO nie pobiera (do tego dnia pobierał cały diff sesji po litery i liczby).
    openReceiving(app, id)
    XCTAssertTrue(git.waitForDisappearance(timeout: 10), "sesja odbioru przed ramką nie ma linii gita")
    try await control.emitGitStatus(sessionId: id) { git.exists }
    DemoServer.hideKeyboard(app)
    git.tap()
    let panel = element(app, "header.git.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 5), "rozwinięcie gita")
    let files = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'header.git.file.'"))
    XCTAssertTrue(files.firstMatch.waitForAppearance(timeout: 10), "lista zmienionych plików")
    XCTAssertEqual(files.count, 3, "trzy pliki demo")
    XCTAssertEqual(
      element(app, "header.git.file.src/notes.ts").label, "src/notes.ts, zmieniony, 2 dodane linie, 2 usunięte linie")
    XCTAssertEqual(element(app, "header.git.file.src/notes.test.ts").label, "src/notes.test.ts, nowy, 9 dodanych linii")
    _ = try await control.stays("otwarcie dymka bez żądań diffa", for: .seconds(2)) { $0.diffRequests == 0 }
    snapshot(app, "naglowek-git")
    assertGitRowTargets(app, files, panel: panel)

    // Okno diffa od pliku stukniętego na liście: ten plik rozwinięty, pozostałe jako nagłówki; „×" zamyka.
    element(app, "header.git.file.src/notes.test.ts").tap()
    XCTAssertTrue(element(app, "diff.sheet").waitForAppearance(timeout: 10), "okno diffa")
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "dymek schodzi, gdy staje okno")
    let opened = element(app, "diff.file.src/notes.test.ts")
    XCTAssertTrue(opened.waitForAppearance(timeout: 10), "nagłówek stukniętego pliku")
    XCTAssertEqual(opened.value as? String, "rozwinięty")
    XCTAssertEqual(element(app, "diff.file.src/notes.ts").value as? String, "zwinięty")
    _ = try await control.wait("lista i patch stukniętego pliku") {
      $0.diffListRequests == 1 && $0.diffFilePaths == ["src/notes.test.ts"]
    }
    snapshot(app, "naglowek-diff")
    element(app, "diff.close").tap()
    XCTAssertTrue(element(app, "diff.sheet").waitForDisappearance(timeout: 5), "diff zamknięty")

    // „Pokaż diff" ze stopki dymka: okno od góry, wszystkie pliki zwinięte — idzie sama lista.
    git.tap()
    let footer = element(app, "header.git.diff")
    XCTAssertTrue(footer.waitForAppearance(timeout: 5), "„Pokaż diff” w stopce")
    footer.tap()
    XCTAssertTrue(element(app, "diff.sheet").waitForAppearance(timeout: 10), "okno diffa od góry")
    XCTAssertTrue(opened.waitForAppearance(timeout: 10))
    XCTAssertEqual(opened.value as? String, "zwinięty", "od góry nic nie jest rozwinięte")
    _ = try await control.wait("druga lista") { $0.diffListRequests == 2 }
    _ = try await control.stays("okno od góry bez patcha", for: .seconds(2)) { $0.diffFileRequests == 1 }
    element(app, "diff.close").tap()
    XCTAssertTrue(element(app, "diff.sheet").waitForDisappearance(timeout: 5), "diff zamknięty")
    app.terminate()
    try await control.reset()
  }

  @MainActor
  func testModelSheetApply() throws {
    let app = try launchLoggedIn()

    // Własna sesja (karta stanu sesji `done` zastępuje pole razem z pigułkami).
    DemoServer.reveal(app, "demo-pipe-link").tap()
    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    let before = tabs.count
    DemoServer.addFromPlus(app)
    XCTAssertTrue(wait(NSPredicate(format: "count == \(before + 1)"), tabs, timeout: 15), "nowa zakładka")
    let pill = element(app, "composer.model")
    XCTAssertTrue(pill.waitForAppearance(timeout: 15), "pigułka modelu")
    assertInComposerRow(app, pill)
    XCTAssertFalse(element(app, "header.model").exists, "w nagłówku pigułki modelu już nie ma")
    // Start blokuje zmianę modelu — arkusz otwieramy, gdy sesja już przyjmuje polecenia.
    let blocked = element(app, "model.blocked")
    var ready = false
    for _ in 0..<10 where !ready {
      pill.tap()
      XCTAssertTrue(element(app, "model.sheet").waitForAppearance(timeout: 10), "arkusz modelu")
      ready = !blocked.exists
      if !ready {
        element(app, "model.dismiss").tap()
        _ = element(app, "model.sheet").waitForDisappearance(timeout: 5)
        sleep(1)
      }
    }
    XCTAssertTrue(ready, "sesja wyszła ze startu")
    // Model and effort are chips in rows, ultracode a segmented control Yes / No.
    let chips = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'model.chip.'"))
    XCTAssertTrue(chips.firstMatch.waitForAppearance(timeout: 10), "model chips from the server's list")
    let efforts = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'model.effort.'"))
    XCTAssertTrue(efforts.firstMatch.exists, "effort chips")
    let apply = element(app, "model.apply")
    XCTAssertFalse(apply.isEnabled, "without a change Apply is dimmed")
    let selectedChip = chips.matching(NSPredicate(format: "isSelected == true"))
    XCTAssertEqual(selectedChip.count, 1, "the session's model chip is selected")
    let sessionChip = selectedChip.firstMatch.identifier
    // Ultracode: a segmented control for a model the server announces it for. The test's own session has no proof,
    // so no segment is selected (not No); a model without it (Haiku) hides the row together with the choice.
    let ultracode = app.segmentedControls["model.ultracode"]
    XCTAssertTrue(ultracode.waitForAppearance(timeout: 5), "Ultracode row")
    let yes = ultracode.buttons["Tak"]
    let no = ultracode.buttons["Nie"]
    XCTAssertFalse(yes.isSelected || no.isSelected, "without proof no segment is selected")
    snapshot(app, "naglowek-model-wiersze")
    yes.tap()
    XCTAssertTrue(wait(NSPredicate(format: "isSelected == true"), yes), "a tap only chooses")
    XCTAssertTrue(apply.isEnabled, "ultracode alone is a change")
    element(app, "model.chip.haiku").tap()
    XCTAssertTrue(ultracode.waitForDisappearance(timeout: 5), "Haiku without the Ultracode row")
    XCTAssertFalse(efforts.firstMatch.exists, "Haiku without effort chips")
    XCTAssertTrue(element(app, "model.effortNone").exists, "a sentence instead of the effort chips")
    element(app, sessionChip).tap()
    XCTAssertTrue(wait(NSPredicate(format: "isSelected == true"), element(app, sessionChip)), "the session's model back")
    XCTAssertTrue(ultracode.waitForAppearance(timeout: 5), "the row returns with a model that has it")
    XCTAssertFalse(yes.isSelected || no.isSelected, "the choice left with the row")
    XCTAssertFalse(apply.isEnabled, "the session's model is no change")
    no.tap()
    XCTAssertTrue(wait(NSPredicate(format: "isSelected == true"), no))
    XCTAssertTrue(apply.isEnabled, "No from unknown is a change")
    snapshot(app, "naglowek-model")
    apply.tap()
    // The demo accepts the command (a pane without a real CLI) — the sheet closes itself, and the demo driver reports
    // every command of the batch in the transcript: only the explicit ultracode `false` went, no `/model` and no
    // `/effort <level>`. The demo never reports the sent values back, so the pill spins until the deadline; the test
    // does not wait for it.
    XCTAssertTrue(element(app, "model.sheet").waitForDisappearance(timeout: 10), "arkusz zamknięty po przyjęciu")
    let sent = { (text: String) in
      app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }
    XCTAssertTrue(sent("/effort ultracode off").waitForAppearance(timeout: 10), "wysłany patch: ultracode false")
    XCTAssertFalse(sent("/model ").exists, "niezmieniony model nie leci")
    let effort = app.descendants(matching: .any).matching(
      NSPredicate(format: "label CONTAINS '/effort ' AND NOT (label CONTAINS 'ultracode')"))
    XCTAssertEqual(effort.count, 0, "niezmieniony effort nie leci")

    // Sprzątanie: własna sesja testu znika dwoma naciśnięciami „×".
    let close = element(app, "header.close")
    XCTAssertTrue(close.waitForAppearance(timeout: 5))
    close.tap()
    close.tap()
  }

  /// The blocked variant, on a session that works. A session that waits for a decision is blocked too, but its
  /// message field, and the model pill with it, gives way to the card, so there is no pill to tap there. A fresh demo
  /// has working sessions (`demo-rarog` streams), but flow tests earlier in the same run write to `demo-rarog`; then
  /// there is nothing to check and the test says so (`ReducerSessionTests` in `RarogCore` cover the block rule).
  @MainActor
  func testModelSheetBlockedWhileWorking() throws {
    let app = try launchLoggedIn()
    let busy = app.descendants(matching: .any).matching(NSPredicate(
      format: "identifier BEGINSWITH 'session.' AND label CONTAINS ', pracuje'"))
    guard busy.firstMatch.exists else {
      throw XCTSkip("no demo session works: earlier tests took their turn")
    }
    busy.firstMatch.tap()
    let pill = element(app, "composer.model")
    XCTAssertTrue(pill.waitForAppearance(timeout: 10), "pigułka modelu")
    pill.tap()
    let blocked = element(app, "model.blocked")
    XCTAssertTrue(blocked.waitForAppearance(timeout: 10), "arkusz w wariancie zablokowanym")
    XCTAssertTrue(blocked.label.contains("Agent pracuje"), blocked.label)
    element(app, "model.dismiss").tap()
    XCTAssertTrue(element(app, "model.sheet").waitForDisappearance(timeout: 10), "arkusz zamknięty")
  }

  // MARK: - Pomocnicze

  /// Własna sesja testu z listy; zwinięty projekt „rarog" rozwija stuknięcie w nagłówek (`DemoServer.openRow`).
  @MainActor
  private func openReceiving(_ app: XCUIApplication, _ id: String) {
    DemoServer.hideKeyboard(app)
    DemoServer.openRow(app, id, project: "rarog")
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 15), "sesja odbioru otwarta")
    DemoServer.hideKeyboard(app)
  }

  /// Wiersz pliku w dymku gita to cel dotyku co najmniej 44 pt (HIG), a cele sąsiednich wierszy się nie
  /// nakładają: rama wiersza to jego obszar stuknięcia (`contentShape` na całej ramie przycisku). Na iPhonie dymek
  /// stoi jako arkusz na niepełnym detencie, który system rysuje pomniejszony (iOS 27, iPhone 17 Pro: arkusz
  /// ułożony na 402 pt szerokości ekranu, narysowany na 386 pt, skala ~0,96), więc ramy XCUITest są w punktach
  /// ekranu mniejsze niż w układzie arkusza; próg idzie w tej samej skali (szerokość dymka / szerokość okna).
  @MainActor
  private func assertGitRowTargets(_ app: XCUIApplication, _ files: XCUIElementQuery, panel: XCUIElement) {
    DemoServer.waitUntilStill(files.firstMatch)
    let phone = UIDevice.current.userInterfaceIdiom == .phone
    let scale = phone ? min(1, panel.frame.width / app.windows.firstMatch.frame.width) : 1
    let frames = files.allElementsBoundByIndex.map(\.frame).sorted { $0.minY < $1.minY }
    XCTAssertEqual(frames.count, 3, "trzy wiersze plików")
    for frame in frames {
      XCTAssertGreaterThanOrEqual(frame.height, 44 * scale - 0.5, "cel dotyku wiersza gita (skala \(scale)): \(frame)")
    }
    for (upper, lower) in zip(frames, frames.dropFirst()) {
      XCTAssertGreaterThanOrEqual(lower.minY, upper.maxY - 0.5, "cele wierszy bez nakładania: \(upper) / \(lower)")
    }
  }

  /// Pigułka stoi w rzędzie kontrolek POD polem wiadomości, między spinaczem a „Wyślij"
  /// (`docs/design.md` „Composer").
  @MainActor
  private func assertInComposerRow(_ app: XCUIApplication, _ pill: XCUIElement) {
    let field = element(app, "composer.field")
    let attach = element(app, "composer.attach")
    let send = element(app, "composer.send")
    XCTAssertTrue(field.exists && attach.exists && send.exists, "pole i rząd kontrolek")
    XCTAssertGreaterThanOrEqual(pill.frame.minY, field.frame.maxY - 1, "pod polem: \(pill.frame) / \(field.frame)")
    XCTAssertEqual(pill.frame.midY, send.frame.midY, accuracy: 8, "w jednym rzędzie z „Wyślij”")
    XCTAssertGreaterThanOrEqual(pill.frame.minX, attach.frame.maxX - 1, "za spinaczem")
    XCTAssertLessThanOrEqual(pill.frame.maxX, send.frame.minX + 1, "przed „Wyślij”")
  }

  @MainActor
  private func launchLoggedIn() throws -> XCUIApplication {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    return app
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  /// Zrzut ekranu w wyniku testu (`xcresulttool export attachments`) — do oceny wzrokowej.
  @MainActor
  private func snapshot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func wait(_ predicate: NSPredicate, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: object)], timeout: timeout) == .completed
  }
}
