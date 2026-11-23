import XCTest

/// Renaming a session in place on the list row against the demo server: the context menu's Rename turns the row into
/// a field with the whole name selected; Return sends `/rename <name>` the ordinary way of a message and the row shows
/// the new name at once, Esc leaves the field without sending. The demo session is not Claude Code and never confirms
/// the name, so after 10 s the old name comes back with a sentence card. The item's rules and the pending name are
/// tested in the package (`SessionRenameTests`). Owner: list.
final class SessionRenameUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testReturnSendsRenameAndShowsTheNewName() async throws {
    let (app, control, id) = try await launch()
    let row = DemoServer.row(app, id)
    let field = app.textFields["list.renameField"]

    openField(app, row)
    XCTAssertTrue(field.waitForAppearance(timeout: 5), "the row became a field")
    XCTAssertEqual(field.value as? String, "Stara nazwa", "the field starts with the row's name")
    XCTAssertTrue(wait("hasKeyboardFocus == true", field, timeout: 5), "the field takes the keyboard focus")
    // Typing replaces the name: all of it was selected.
    field.typeText("Nowa nazwa\n")
    XCTAssertTrue(field.waitForDisappearance(timeout: 5), "Return leaves the field")
    XCTAssertTrue(wait("label CONTAINS %@", row, arguments: ["Nowa nazwa"], timeout: 5), "new name: \(row.label)")
    XCTAssertFalse(row.label.contains("Stara nazwa"), "the whole name was replaced: \(row.label)")
    let sent = try await control.wait("the server took one message") { $0.acceptedMessages.count == 1 }
    XCTAssertEqual(sent.receivedMessages.count, 1, "one Return = one POST")
    XCTAssertEqual(sent.driverSends, 1, "the message reached the session")

    // No label from the server within 10 s: the old name and a sentence card.
    XCTAssertTrue(wait("label CONTAINS %@", row, arguments: ["Stara nazwa"], timeout: 15), "old name back: \(row.label)")
    let notice = app.descendants(matching: .any)["tabs.notice"].firstMatch
    XCTAssertTrue(notice.waitForAppearance(timeout: 3), "the sentence card")
    XCTAssertTrue(notice.label.contains("Nazwa sesji się nie zmieniła"), "the sentence: \(notice.label)")

    // The message was `/rename Nowa nazwa`: its bubble stands in the session's transcript.
    row.tap()
    let bubble = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "/rename Nowa nazwa", "/rename Nowa nazwa"))
      .firstMatch
    XCTAssertTrue(bubble.waitForAppearance(timeout: 10), "the /rename bubble in the transcript")
  }

  @MainActor
  func testEscapeSendsNothing() async throws {
    let (app, control, id) = try await launch()
    let row = DemoServer.row(app, id)
    let field = app.textFields["list.renameField"]

    openField(app, row)
    XCTAssertTrue(field.waitForAppearance(timeout: 5), "the row became a field")
    XCTAssertTrue(wait("hasKeyboardFocus == true", field, timeout: 5), "the field takes the keyboard focus")
    let escape = probe(app, "escape")
    XCTAssertTrue(escape.hasPrefix("esc=RenameTextFieldView") && escape.contains("sent=true"), "Esc: \(escape)")
    XCTAssertTrue(field.waitForDisappearance(timeout: 5), "Esc leaves the field")
    XCTAssertTrue(row.waitForAppearance(timeout: 5) && row.label.contains("Stara nazwa"), "the old name: \(row.label)")
    try await Task.sleep(for: .seconds(1))
    let stats = try await control.stats()
    XCTAssertEqual(stats.receivedMessages.count, 0, "Esc sends nothing")
  }

  @MainActor
  func testATapOnTheListBesideTheFieldSendsNothing() async throws {
    if UIDevice.current.userInterfaceIdiom == .phone {
      throw XCTSkip("on the iPhone rows fill the list under the field and a tap there opens a session; "
        + "testOnThePhoneATapOnAnotherRowCancelsAndTheListComesBackWithoutAField covers it")
    }
    let (app, control, id) = try await launch()
    let row = DemoServer.row(app, id)
    let field = app.textFields["list.renameField"]

    openField(app, row)
    XCTAssertTrue(field.waitForAppearance(timeout: 5), "the row became a field")
    XCTAssertTrue(wait("hasKeyboardFocus == true", field, timeout: 5), "the field takes the keyboard focus")
    field.typeText("Inna")
    // The list's empty background under the rows.
    let list = app.descendants(matching: .any)["session.list"].firstMatch
    list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).tap()
    XCTAssertTrue(field.waitForDisappearance(timeout: 5), "a tap beside the field leaves it")
    XCTAssertTrue(row.waitForAppearance(timeout: 5) && row.label.contains("Stara nazwa"), "the old name: \(row.label)")
    try await Task.sleep(for: .seconds(1))
    let stats = try await control.stats()
    XCTAssertEqual(stats.receivedMessages.count, 0, "a tap beside the field sends nothing")
  }

  // MARK: Phone: the list is a screen of its own, the field is closed with the on-screen keyboard's return key

  /// Return on the on-screen keyboard closes the field at once and the row shows the new name; when Claude Code's
  /// name arrives within the window (the demo gives it like the custom title after `/rename`), no sentence follows.
  @MainActor
  func testOnThePhoneReturnClosesTheFieldAndTheServerNameConfirms() async throws {
    try requirePhone()
    let (app, control, id) = try await launch(touch: true)
    let row = DemoServer.row(app, id)
    let field = app.textFields["list.renameField"]

    openField(app, row)
    XCTAssertTrue(field.waitForAppearance(timeout: 5), "the row became a field")
    XCTAssertTrue(wait("hasKeyboardFocus == true", field, timeout: 5), "the field takes the keyboard focus")
    typeName(app, field, "nowa")
    pressReturn(app, field)
    XCTAssertTrue(field.waitForDisappearance(timeout: 3), "Return leaves the field")
    XCTAssertTrue(DemoServer.listShown(app, timeout: 1), "the list stays on screen")
    XCTAssertTrue(wait("label CONTAINS %@", row, arguments: ["Nowa"], timeout: 5), "new name: \(row.label)")
    let sent = try await control.wait("the server took one message") { $0.acceptedMessages.count == 1 }
    XCTAssertEqual(sent.receivedMessages.count, 1, "one Return = one POST")

    // Claude Code's name comes a moment later, as on a device; the window ends without a sentence.
    try await Task.sleep(for: .seconds(2))
    try await control.emit("title", sessionId: id, text: "Nowa")
    let notice = app.descendants(matching: .any)["tabs.notice"].firstMatch
    XCTAssertFalse(notice.waitForAppearance(timeout: 12), "no sentence after a confirmed rename: \(notice.label)")
    XCTAssertFalse(field.exists, "no field")
    XCTAssertTrue(row.label.contains("Nowa"), "the confirmed name stays: \(row.label)")
  }

  /// A tap on another row while the field is open cancels the edit and opens that row's session; back on the list
  /// no field is left and nothing more was sent. The field is the row's second one, after a rename: the list hands
  /// the next field of a row the same text field view.
  @MainActor
  func testOnThePhoneATapOnAnotherRowCancelsAndTheListComesBackWithoutAField() async throws {
    try requirePhone()
    let (app, control, id) = try await launch(touch: true)
    let row = DemoServer.row(app, id)
    let field = app.textFields["list.renameField"]

    openField(app, row)
    XCTAssertTrue(wait("hasKeyboardFocus == true", field, timeout: 5), "the first field takes the keyboard focus")
    typeName(app, field, "pierwsza")
    pressReturn(app, field)
    XCTAssertTrue(field.waitForDisappearance(timeout: 3), "the first Return leaves the field")
    _ = try await control.wait("the first message") { $0.acceptedMessages.count == 1 }
    try await control.emit("title", sessionId: id, text: "Pierwsza")
    XCTAssertTrue(wait("label CONTAINS %@", row, arguments: ["Pierwsza"], timeout: 5), "first name: \(row.label)")

    // The second field is not typed in: its focus and Return are the second rename's test, this one is the tap.
    openField(app, row)
    XCTAssertTrue(field.waitForAppearance(timeout: 5), "the row became a field again")
    let other = try XCTUnwrap(anotherRow(app, besides: id), "another row on screen")
    other.tap()
    let back = app.navigationBars.buttons.element(boundBy: 0)
    XCTAssertTrue(back.waitForAppearance(timeout: 10), "the other session opened")
    back.tap()
    XCTAssertTrue(DemoServer.listShown(app), "the list after back")
    XCTAssertTrue(DemoServer.reveal(app, id).waitForAppearance(timeout: 10), "the row after back")
    XCTAssertFalse(field.exists, "no field after back")
    XCTAssertTrue(row.label.contains("Pierwsza"), "the name before the cancelled edit: \(row.label)")
    let stats = try await control.stats()
    XCTAssertEqual(stats.receivedMessages.count, 1, "a tap on another row sends nothing")
  }

  /// Without a hardware keyboard the field has Cancel beside it: it closes the field the way Esc does, nothing is sent.
  @MainActor
  func testOnThePhoneCancelClosesTheFieldWithoutSending() async throws {
    try requirePhone()
    let (app, control, id) = try await launch(touch: true)
    let row = DemoServer.row(app, id)
    let field = app.textFields["list.renameField"]

    openField(app, row)
    XCTAssertTrue(wait("hasKeyboardFocus == true", field, timeout: 5), "the field takes the keyboard focus")
    typeName(app, field, "inna")
    let cancel = app.buttons["list.renameCancel"]
    XCTAssertTrue(cancel.waitForAppearance(timeout: 2), "Cancel beside the field on touch")
    XCTAssertEqual(cancel.label, "Anuluj")
    XCTAssertGreaterThanOrEqual(cancel.frame.height, 44, "Cancel is a 44 pt target: \(cancel.frame)")
    XCTAssertEqual(cancel.frame.midY, field.frame.midY, accuracy: 12, "Cancel stands on the field's line")
    cancel.tap()
    XCTAssertTrue(field.waitForDisappearance(timeout: 3), "Cancel leaves the field")
    XCTAssertTrue(DemoServer.listShown(app, timeout: 1), "the list stays on screen")
    XCTAssertTrue(row.label.contains("Stara nazwa"), "the old name: \(row.label)")
    try await Task.sleep(for: .seconds(1))
    let stats = try await control.stats()
    XCTAssertEqual(stats.receivedMessages.count, 0, "Cancel sends nothing")
  }

  /// Every Return acts: a second rename of the same row closes its field and sends its own name.
  @MainActor
  func testOnThePhoneASecondRenameOfTheSameRowWorks() async throws {
    try requirePhone()
    let (app, control, id) = try await launch(touch: true)
    let row = DemoServer.row(app, id)
    let field = app.textFields["list.renameField"]

    openField(app, row)
    XCTAssertTrue(wait("hasKeyboardFocus == true", field, timeout: 5), "the first field takes the keyboard focus")
    field.typeText("Pierwsza")
    pressReturn(app, field)
    XCTAssertTrue(field.waitForDisappearance(timeout: 3), "the first Return leaves the field")
    _ = try await control.wait("the first message") { $0.acceptedMessages.count == 1 }
    try await control.emit("title", sessionId: id, text: "Pierwsza")
    XCTAssertTrue(wait("label CONTAINS %@", row, arguments: ["Pierwsza"], timeout: 5), "first name: \(row.label)")

    openField(app, row)
    XCTAssertTrue(wait("hasKeyboardFocus == true", field, timeout: 5), "the second field takes the keyboard focus")
    XCTAssertEqual(field.value as? String, "Pierwsza", "the second field starts with the first name")
    field.typeText("Druga")
    pressReturn(app, field)
    XCTAssertTrue(field.waitForDisappearance(timeout: 3), "the second Return leaves the field")
    XCTAssertTrue(wait("label CONTAINS %@", row, arguments: ["Druga"], timeout: 5), "second name: \(row.label)")
    let sent = try await control.wait("the second message") { $0.acceptedMessages.count == 2 }
    XCTAssertEqual(sent.receivedMessages.count, 2, "two Returns = two POSTs")
  }

  @MainActor
  private func requirePhone() throws {
    guard UIDevice.current.userInterfaceIdiom == .phone else {
      throw XCTSkip("the list is a screen of its own on the iPhone; the iPad keeps it beside the session")
    }
  }

  /// The return key of the on-screen keyboard (a check mark for `.done`), as a finger presses it; a hardware Return
  /// when the simulator shows no on-screen keyboard.
  @MainActor
  private func pressReturn(_ app: XCUIApplication, _ field: XCUIElement) {
    let keyboard = app.keyboards.firstMatch
    if keyboard.exists, keyboard.frame.minY < app.frame.maxY - 1 {
      let key = keyboard.buttons.matching(
        NSPredicate(format: "label IN[c] %@ OR identifier IN[c] %@", Self.returnKeys, Self.returnKeys)).firstMatch
      if key.exists {
        key.tap()
        return
      }
      print("rename: no return key among \(keyboard.buttons.allElementsBoundByIndex.map(\.label))")
    }
    print("rename: no on-screen keyboard, a hardware Return")
    field.typeText("\n")
  }

  private static let returnKeys = ["Gotowe", "Done", "Return", "Powrót", "Wróć"]

  /// A session row other than `id` that a finger can tap now (the keyboard covers part of the list).
  @MainActor
  private func anotherRow(_ app: XCUIApplication, besides id: String) -> XCUIElement? {
    app.descendants(matching: .any)
      .matching(NSPredicate(
        format: "identifier BEGINSWITH %@ AND NOT identifier IN %@", "session.", ["session.list", "session.\(id)"]))
      .allElementsBoundByIndex
      .first { $0.isHittable }
  }

  /// Types `text` (lowercase letters) with the keys of the on-screen keyboard when it is up, as a finger does;
  /// otherwise as a hardware keyboard.
  @MainActor
  private func typeName(_ app: XCUIApplication, _ field: XCUIElement, _ text: String) {
    let keyboard = app.keyboards.firstMatch
    guard keyboard.waitForAppearance(timeout: 2), keyboard.frame.minY < app.frame.maxY - 1 else {
      print("rename: typing without an on-screen keyboard")
      field.typeText(text)
      return
    }
    print("rename: typing on the on-screen keyboard")
    for character in text {
      keyboard.keys.matching(NSPredicate(format: "label ==[c] %@", String(character))).firstMatch.tap()
    }
  }

  /// A fresh demo session named "Stara nazwa" on the list. The simulator does not hand Esc to the app, so the app runs
  /// with the probe, which fires the Esc key command of the first responder's chain as a hardware keyboard would
  /// (`UITestProbe`). `touch`: the app sees no hardware keyboard, like a phone in the hand (the simulator reports one).
  @MainActor
  private func launch(touch: Bool = false) async throws -> (XCUIApplication, DemoControl, String) {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("idle", label: "Stara nazwa")
    var environment = ["RAROG_UI_TEST_PROBE": "1"]
    if touch { environment["RAROG_UI_TEST_NO_HW_KEYBOARD"] = "1" }
    let app = DemoServer.launch(port: port, environment: environment)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "session list")
    DemoServer.hideKeyboard(app)
    XCTAssertTrue(DemoServer.reveal(app, id).waitForAppearance(timeout: 15), "the test session on the list")
    return (app, control, id)
  }

  /// Touch and hold on the row, then Rename.
  @MainActor
  private func openField(_ app: XCUIApplication, _ row: XCUIElement) {
    row.press(forDuration: 1.2)
    let item = app.buttons["Zmień nazwę"].firstMatch
    XCTAssertTrue(item.waitForAppearance(timeout: 5), "Rename in the row's context menu")
    item.tap()
  }

  /// Taps a probe button and reads its result (`UITestProbe`).
  @MainActor
  private func probe(_ app: XCUIApplication, _ action: String) -> String {
    let button = app.descendants(matching: .any)["probe.\(action)"].firstMatch
    guard button.waitForAppearance(timeout: 3) else { return "probe: no button \(action)" }
    button.tap()
    return (app.descendants(matching: .any)["probe.state"].firstMatch.value as? String) ?? "probe: no state"
  }

  @MainActor
  private func wait(_ predicate: String, _ object: Any, arguments: [Any] = [], timeout: TimeInterval = 15) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: predicate, argumentArray: arguments), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }
}
