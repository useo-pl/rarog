import XCTest

/// Dyktowanie przeciw serwerowi demo z wyborem Soniox w pamięci apki
/// (`DemoServer.dictation`): mikrofon stoi w polu od razu, bez czekania na sondę `voiceEnabled` (trasa Soniox przy
/// nieznanym stanie serwera nagrywa, mint rozstrzyga), klucz idzie prawdziwą drogą (`POST /api/voice/token`),
/// a mikrofon i strumień Soniox grają scenariusz apki (`RAROG_UI_TEST_VOICE`, build Debug): hipoteza „Dyktuję z",
/// po zakończeniu z opóźnieniem 1,5 s domknięcie „ z iPada.". Odmowę mikrofonu test sprawdza na obu trasach. Ekran
/// „Dyktowanie” i wybór trasy: `DictationUITests`. Właściciel: dyktowanie.
///
/// Skrót dyktowania to ⌥⌘M (`DictationShortcut` w RarogUI — przy zmianie skrótu zmień też
/// `dictationKey` niżej). Gołe ⌘M od iPadOS 26 to systemowe „Zminimalizuj okno": w symulatorze
/// minimalizuje apkę, zanim skrót dotrze do łańcucha responderów (zmierzone).
final class VoiceUITests: XCTestCase {
  private let dictationKey: (key: String, modifiers: XCUIElement.KeyModifierFlags) = ("m", [.option, .command])

  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  private func launch(voice: String, dictation: String = "soniox") throws -> XCUIApplication {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port, environment: DemoServer.dictation(dictation, voice: voice))
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-rarog").tap()
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 15), "pole wiadomości")
    XCTAssertTrue(app.buttons["composer.mic"].waitForAppearance(timeout: 5), "mikrofon zawsze w polu")
    return app
  }

  /// Czeka, aż wartość pola będzie dokładnie taka.
  @MainActor
  private func waitField(_ app: XCUIApplication, equals text: String, timeout: TimeInterval = 10) -> Bool {
    let field = app.textViews["composer.field"]
    let predicate = NSPredicate { _, _ in (field.value as? String) == text }
    return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout) == .completed
  }

  @MainActor
  private func status(_ app: XCUIApplication) -> XCUIElement {
    app.staticTexts["composer.voice.status"]
  }

  @MainActor
  func testTapStartsSecondTapKeepsText() throws {
    let app = try launch(voice: "1")
    let field = app.textViews["composer.field"]
    let mic = app.buttons["composer.mic"]
    let send = app.buttons["composer.send"]
    // Mikrofon w rzędzie kontrolek, tuż przed „Wyślij”.
    XCTAssertTrue(mic.waitForAppearance(timeout: 5))
    XCTAssertEqual(mic.frame.midY, send.frame.midY, accuracy: 1, "mikrofon w rzędzie „Wyślij”")
    XCTAssertLessThan(mic.frame.maxX, send.frame.minX, "mikrofon przed „Wyślij”")

    field.tap()
    field.typeText("Notatka")
    mic.tap()
    XCTAssertTrue(waitField(app, equals: "Notatka Dyktuję z"), "hipoteza doklejona z jedną spacją: \(field.value ?? "")")
    XCTAssertEqual(status(app).label, "Nagrywam")
    XCTAssertFalse(app.buttons["composer.mic.cancel"].exists, "bez „×” także w trakcie nagrania")
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "dyktowanie-nagrywam"
    shot.lifetime = .keepAlways
    add(shot)

    // Drugi tap kończy z zatwierdzeniem: ostatnie słowa wchodzą do pola, nic się nie wysyła.
    mic.tap()
    XCTAssertTrue(waitField(app, equals: "Notatka Dyktuję z iPada."), "końcówka w polu: \(field.value ?? "")")
    XCTAssertTrue(status(app).waitForDisappearance(timeout: 5), "wiersz stanu gaśnie po zwykłym końcu")
    XCTAssertFalse(
      app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'pending.'")).firstMatch.exists,
      "dyktowanie nie wysyła")
  }

  @MainActor
  func testSendWhileFinishingKeepsTail() throws {
    let app = try launch(voice: "1")
    let field = app.textViews["composer.field"]
    let mic = app.buttons["composer.mic"]
    field.tap()
    mic.tap()
    XCTAssertTrue(waitField(app, equals: "Dyktuję z"), "nagranie od pustego pola: \(field.value ?? "")")

    // Drugi tap kończy; „Wyślij" w trakcie kończenia czeka na ostatnie słowa i wysyła całość.
    mic.tap()
    app.buttons["composer.send"].tap()
    XCTAssertTrue(waitField(app, equals: ""), "pole puste po wysyłce")
    DemoServer.hideKeyboard(app)
    let echo = app.textViews.matching(NSPredicate(
      format: "identifier BEGINSWITH 'message.m' AND (label == %@ OR label == %@)", "Ty: Dyktuję z iPada.",
      "Dyktuję z iPada.")).firstMatch
    var found = echo.waitForAppearance(timeout: 15)
    for _ in 0..<6 where !found {
      app.collectionViews["transcript"].swipeDown(velocity: .slow)
      found = echo.waitForAppearance(timeout: 1)
    }
    XCTAssertTrue(found, "echo wiadomości z końcówką dyktowania")
  }

  @MainActor
  func testOptionCommandMTogglesDictation() throws {
    let app = try launch(voice: "1")
    let field = app.textViews["composer.field"]
    field.tap()
    // Symulator zużywa pierwszy klawisz sprzętowy przy wysuniętej klawiaturze ekranowej na
    // przełączenie klawiatur — jałowa strzałka przed skrótem (jak w `ProjectsUITests`).
    app.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: [])
    app.typeKey(dictationKey.key, modifierFlags: dictationKey.modifiers)
    XCTAssertTrue(waitField(app, equals: "Dyktuję z"), "⌥⌘M zaczyna nagranie: \(field.value ?? "")")
    XCTAssertEqual(status(app).label, "Nagrywam")
    XCTAssertEqual(app.state, .runningForeground, "skrót nie minimalizuje apki")

    // Drugi raz kończy z zatwierdzeniem, jak drugi tap mikrofonu.
    app.typeKey(dictationKey.key, modifierFlags: dictationKey.modifiers)
    XCTAssertTrue(waitField(app, equals: "Dyktuję z iPada."), "końcówka w polu: \(field.value ?? "")")
    XCTAssertTrue(status(app).waitForDisappearance(timeout: 5), "nagranie zakończone")
  }

  @MainActor
  func testMicrophoneDeniedSaysWhereToFixIt() throws {
    try expectMicrophoneDenied(dictation: "soniox")
  }

  /// Trasa systemowa: ta sama odmowa mikrofonu, bez przejścia na Soniox.
  @MainActor
  func testMicrophoneDeniedOnSystemRouteSaysWhereToFixIt() throws {
    try expectMicrophoneDenied(dictation: "system")
  }

  @MainActor
  private func expectMicrophoneDenied(dictation: String) throws {
    let app = try launch(voice: "denied", dictation: dictation)
    app.buttons["composer.mic"].tap()
    let line = status(app)
    XCTAssertTrue(line.waitForAppearance(timeout: 5), "zdanie o odmowie")
    XCTAssertTrue(line.label.contains("Ustawieniach"), "odsyła do Ustawień: \(line.label)")
    XCTAssertTrue(app.buttons["composer.voice.settings"].exists, "przycisk Ustawień")
    XCTAssertTrue(waitField(app, equals: ""), "pole nietknięte")
  }
}
