import XCTest

// The Files section's toggle and search field against the demo project (`server/src/demo/files.ts`): a readme and a
// guide in Markdown, `package.json`, `tsconfig.json`, `src/…`, `dist/…` (ignored), changes in `src`. A directory with
// a change starts open, `docs` starts closed, and the demo server sends the file index.
extension InspectorUITests {
  /// Files ↔ Changed Only changes the rows: Changed Only keeps only the changed files (the deleted one included) under
  /// open directories; a tap on a directory there folds it in that tree only, and back on Files the whole tree stands
  /// with the hand toggles as they were.
  @MainActor
  func testFilesModeToggleChangesRows() async throws {
    let (app, control) = try await openFiles("files mode")
    let unchanged = element(app, "inspector.git.file.package.json")
    let modified = element(app, "inspector.git.file.src/notes.ts")
    let deleted = element(app, "inspector.git.file.src/notes-legacy.ts")
    let source = element(app, "inspector.git.dir.src")
    XCTAssertTrue(unchanged.waitForAppearance(timeout: 10), "the whole tree on Files")
    XCTAssertTrue(element(app, "inspector.git.dir.dist").exists, "an ignored directory of the whole tree")
    let mode = element(app, "inspector.files.mode")
    XCTAssertTrue(mode.waitForAppearance(timeout: 5), "the toggle under the header")
    XCTAssertTrue(mode.buttons["Pliki"].isSelected, "Files by default")

    mode.buttons["Tylko zmienione"].tap()
    XCTAssertTrue(unchanged.waitForDisappearance(timeout: 5), "Changed Only drops the unchanged files")
    XCTAssertFalse(element(app, "inspector.git.dir.dist").exists, "and the directories without a change")
    XCTAssertTrue(modified.exists && deleted.exists, "the changed files stay, the deleted one too")
    XCTAssertEqual(source.value as? String, "rozwinięty")
    source.tap()
    XCTAssertTrue(modified.waitForDisappearance(timeout: 5), "a tap folds the directory in Changed Only")
    XCTAssertEqual(source.value as? String, "zwinięty")

    mode.buttons["Pliki"].tap()
    XCTAssertTrue(unchanged.waitForAppearance(timeout: 5), "back to the whole tree")
    XCTAssertTrue(modified.waitForAppearance(timeout: 5), "the fold of Changed Only is not a hand toggle")
    XCTAssertEqual(source.value as? String, "rozwinięty")
    app.terminate()
    try await control.reset()
  }

  /// A query gives the tree of the hits, with a file from a closed directory whose listing never came (the file index
  /// confirms it: a tap opens its preview); the closed directory stands open in the result only.
  @MainActor
  func testSearchShowsHitFromClosedDirectory() async throws {
    let (app, control) = try await openFiles("files search")
    let docs = element(app, "inspector.git.dir.docs")
    let guide = element(app, "inspector.git.file.docs/guide.md")
    let unchanged = element(app, "inspector.git.file.package.json")
    XCTAssertTrue(docs.waitForAppearance(timeout: 10), "the docs directory")
    XCTAssertEqual(docs.value as? String, "zwinięty", "docs starts closed")
    XCTAssertFalse(guide.exists, "its file is not on screen")

    let field = type(app, "GUIDE")
    XCTAssertTrue(guide.waitForAppearance(timeout: 10), "the hit from the closed directory, letter case aside")
    XCTAssertFalse(unchanged.exists, "a file that does not match leaves")
    XCTAssertEqual(docs.value as? String, "rozwinięty", "the directory of a hit stands open in the result")
    DemoServer.hideKeyboard(app)
    guide.tap()
    let close = element(app, "QLOverlayDoneButtonAccessibilityIdentifier")
    XCTAssertTrue(close.waitForAppearance(timeout: 10), "a hit from the index opens its preview")
    close.tap()
    XCTAssertTrue(close.waitForDisappearance(timeout: 5))

    field.tap()
    field.typeText("zzz")
    let none = element(app, "inspector.files.note.noMatch")
    XCTAssertTrue(none.waitForAppearance(timeout: 5), "no hit: the sentence")
    XCTAssertEqual(none.label, "Brak plików pasujących do „GUIDEzzz”.")
    XCTAssertFalse(element(app, "inspector.git.clean").exists, "not the clean sentence of the tree")
    app.terminate()
    try await control.reset()
  }

  /// `.*` makes the query a regular expression: `[` does not compile, so the sentence under the field and no rows;
  /// `\.md$` gives the Markdown files only.
  @MainActor
  func testSearchRegexErrorSentence() async throws {
    let (app, control) = try await openFiles("files regex")
    XCTAssertTrue(element(app, "inspector.git.file.package.json").waitForAppearance(timeout: 10))
    let regex = element(app, "inspector.files.searchRegex")
    XCTAssertTrue(regex.waitForAppearance(timeout: 5), "the .* button")
    regex.tap()
    XCTAssertTrue(regex.isSelected, ".* on")

    let field = type(app, "[")
    let error = element(app, "inspector.files.note.invalidPattern")
    XCTAssertTrue(error.waitForAppearance(timeout: 5), "the sentence about the expression")
    XCTAssertEqual(error.label, "To wyrażenie regularne jest błędne.")
    XCTAssertFalse(element(app, "inspector.git.dir.src").exists, "no rows")
    XCTAssertFalse(element(app, "inspector.git.file.package.json").exists, "no rows")

    clear(app)
    field.tap()
    field.typeText("\\.md$")
    XCTAssertTrue(element(app, "inspector.git.file.docs/guide.md").waitForAppearance(timeout: 10), "a .md file")
    XCTAssertTrue(element(app, "inspector.git.file.README.md").exists, "the other .md file")
    XCTAssertFalse(element(app, "inspector.git.file.package.json").exists, "no other file")
    XCTAssertFalse(error.exists, "the error went with the query")
    app.terminate()
    try await control.reset()
  }

  /// "×" returns to the tree with the hand toggles intact: `src` folded by hand opens in the result, and after the
  /// clear stands folded again. Esc in the non-empty field clears it too and takes the key itself; in the empty field
  /// on the iPad it still takes the key and does nothing, so the session screen never gets it (no interrupt).
  @MainActor
  func testSearchClearReturnsTreeWithHandToggles() async throws {
    let (app, control) = try await openFiles("files clear", environment: ["RAROG_UI_TEST_PROBE": "1"])
    let source = element(app, "inspector.git.dir.src")
    let modified = element(app, "inspector.git.file.src/notes.ts")
    let unchanged = element(app, "inspector.git.file.package.json")
    XCTAssertTrue(modified.waitForAppearance(timeout: 10))
    DemoServer.hideKeyboard(app)
    source.tap()
    XCTAssertTrue(modified.waitForDisappearance(timeout: 5), "src folded by hand")

    let field = type(app, "notes")
    XCTAssertTrue(modified.waitForAppearance(timeout: 10), "the hit under the folded directory")
    XCTAssertEqual(source.value as? String, "rozwinięty", "open in the result")
    XCTAssertFalse(unchanged.exists)
    clear(app)
    XCTAssertTrue(unchanged.waitForAppearance(timeout: 5), "the tree is back")
    XCTAssertFalse(modified.exists, "src folded by hand again")
    XCTAssertEqual(source.value as? String, "zwinięty")
    XCTAssertEqual(field.value as? String, "Szukaj plików", "the field is empty")

    // Esc, through the key command chain of the focused field (the simulator gives the app no Esc key).
    field.tap()
    field.typeText("notes")
    XCTAssertTrue(modified.waitForAppearance(timeout: 10))
    let escape = probe(app, "escape")
    XCTAssertTrue(escape.hasPrefix("esc=FileSearchTextFieldView") && escape.contains("sent=true"), "Esc: \(escape)")
    XCTAssertTrue(unchanged.waitForAppearance(timeout: 5), "Esc cleared the field: the tree is back")
    XCTAssertEqual(source.value as? String, "zwinięty")
    let empty = probe(app, "escape")
    XCTAssertTrue(empty.hasPrefix("esc=FileSearchTextFieldView"), "the empty field keeps Esc: \(empty)")
    XCTAssertTrue(unchanged.exists && element(app, "inspector.panel").exists, "and nothing else happens")
    app.terminate()
    try await control.reset()
  }

  /// A screenshot of the search result for visual review, so without `RAROG_SCREENSHOT_DIR` the test is skipped. The
  /// pointer over a row is in `testScreensDark` ("zmiany-wskaznik"), on the same section.
  @MainActor
  func testFilesScreens() async throws {
    guard ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] != nil else {
      throw XCTSkip("no RAROG_SCREENSHOT_DIR: screenshots are taken by hand, outside the gate")
    }
    let (app, control) = try await openFiles("files screens")
    XCTAssertTrue(element(app, "inspector.git.file.src/notes.ts").waitForAppearance(timeout: 10))
    DemoServer.hideKeyboard(app)
    settle()
    _ = type(app, "notes")
    XCTAssertTrue(element(app, "inspector.git.file.src/notes.test.ts").waitForAppearance(timeout: 10))
    DemoServer.hideKeyboard(app)
    settle()
    try shot(app, "pliki-szukanie", "dark")
    app.terminate()
    try await control.reset()
  }

  /// iPhone: the panel sheet carries the toggle and the search field; Esc in the non-empty field clears it and the
  /// sheet stays, Esc in the empty field closes the sheet as before.
  @MainActor
  func testPhoneSheetSearchField() async throws {
    guard UIDevice.current.userInterfaceIdiom == .phone else {
      throw XCTSkip("the panel is a sheet only on a phone; an iPad keeps it as a column")
    }
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    var environment = ["RAROG_UI_TEST_PROBE": "1"]
    if ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] != nil { environment["RAROG_UI_TEST_THEME"] = "dark" }
    let app = DemoServer.launch(port: port, environment: environment)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "session list")
    DemoServer.reveal(app, "demo-rarog-stop").tap()
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 10), "the session screen")
    DemoServer.hideKeyboard(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 10), "the panel button")
    button.tap()
    let panel = element(app, "inspector.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 5), "the panel sheet")
    let field = app.textFields["inspector.files.search"]
    XCTAssertTrue(field.waitForAppearance(timeout: 10), "the search field in the sheet")
    XCTAssertTrue(element(app, "inspector.files.mode").exists, "the toggle in the sheet")
    if !field.isHittable { panel.swipeUp() }
    field.tap()
    field.typeText("notes")
    XCTAssertTrue(element(app, "inspector.git.file.src/notes.ts").waitForAppearance(timeout: 10), "the result")
    if ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] != nil {
      DemoServer.hideKeyboard(app)
      settle()
      try shot(app, "pliki-szukanie-telefon", "dark")
      field.tap()
    }
    let escape = probe(app, "escape")
    XCTAssertTrue(escape.hasPrefix("esc=FileSearchTextFieldView") && escape.contains("sent=true"), "Esc: \(escape)")
    XCTAssertTrue(element(app, "inspector.git.file.package.json").waitForAppearance(timeout: 5), "cleared")
    XCTAssertTrue(panel.exists, "the sheet stays")
    let empty = probe(app, "escape")
    XCTAssertTrue(empty.contains("sent=true") && !empty.hasPrefix("esc=FileSearchTextFieldView"), "Esc: \(empty)")
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "Esc in the empty field closes the sheet")
    app.terminate()
    try await control.reset()
  }

  // MARK: - Helpers

  /// A new demo session with its panel open on the iPad.
  @MainActor
  private func openFiles(
    _ label: String, environment: [String: String] = [:]
  ) async throws -> (XCUIApplication, DemoControl) {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("idle", label: label)
    let app = try launch(
      port: port, theme: ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] != nil ? "dark" : nil,
      environment: environment)
    openTab(app, id)
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 15))
    button.tap()
    XCTAssertTrue(element(app, "inspector.panel").waitForAppearance(timeout: 5))
    return (app, control)
  }

  /// Types into the search field and returns it.
  @MainActor
  private func type(_ app: XCUIApplication, _ text: String) -> XCUIElement {
    let field = app.textFields["inspector.files.search"]
    XCTAssertTrue(field.waitForAppearance(timeout: 5), "the search field")
    field.tap()
    field.typeText(text)
    return field
  }

  /// "×" at the end of the field.
  @MainActor
  private func clear(_ app: XCUIApplication) {
    let clear = element(app, "inspector.files.searchClear")
    XCTAssertTrue(clear.waitForAppearance(timeout: 5), "the clear button")
    clear.tap()
    XCTAssertTrue(clear.waitForDisappearance(timeout: 5), "the field is empty")
  }

  /// Taps a probe button and reads its result (`UITestProbe`).
  @MainActor
  private func probe(_ app: XCUIApplication, _ action: String) -> String {
    let button = app.descendants(matching: .any)["probe.\(action)"].firstMatch
    guard button.waitForAppearance(timeout: 3) else { return "probe: no button \(action)" }
    button.tap()
    return (app.descendants(matching: .any)["probe.state"].firstMatch.value as? String) ?? "probe: no state"
  }
}
