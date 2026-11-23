import XCTest

/// Karty narzędzi, seria kroków, pasek „na dół", powrót na miejsce i znacznik godziny przeciw
/// serwerowi demo. `demo-data-loader` (done, bez tury) ma plan, cztery kroki narzędzi z rzędu,
/// zapis pliku z mini-diffem na 50 linii i odpowiedź; `demo-willow-parser` ma 31 min przerwy przed odpowiedzią.
/// Miejsce karty zapisu zależy od ekranu: na iPadzie stoi z ogonem mini-diffu przy dnie, a na telefonie sama
/// ostatnia odpowiedź jest wyższa niż lista (iPhone 17 Pro: 555 pt odpowiedzi na 510 pt listy nad
/// kartą stanu), więc do karty i jej ogona test jedzie ku starszym.
final class TranscriptToolsUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testToolCardsSeriesJumpBarAndReturn() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    let row = DemoServer.reveal(app, "demo-data-loader")
    XCTAssertTrue(row.exists, "sesja data-loader na liście")
    row.tap()
    DemoServer.hideKeyboard(app)
    let transcript = app.collectionViews["transcript"]
    let jump = app.buttons["transcript.jump"]

    // Otwarcie stoi na dnie: koniec ostatniej odpowiedzi tury na ekranie, paska „na dół" nie ma.
    let answer = app.textViews.matching(NSPredicate(
      format: "identifier BEGINSWITH 'message.m' AND label CONTAINS %@", "odpalić to samo")).firstMatch
    XCTAssertTrue(answer.waitForAppearance(timeout: 10), "ostatnia odpowiedź tury")
    XCTAssertTrue(
      transcript.frame.contains(CGPoint(x: answer.frame.midX, y: answer.frame.maxY - 1)),
      "koniec ostatniej odpowiedzi przy dnie: \(answer.frame) w \(transcript.frame)")
    XCTAssertFalse(jump.exists, "przy dnie paska nie ma")

    // Edycja pliku: mini-diff otwarty od razu, 12 linii, reszta pod rozwijakiem. Karta stoi nad
    // ostatnią odpowiedzią — na iPadzie przy dnie, na telefonie ponad listą.
    let edit = button(app, labelPrefix: "Write: src/import/report.ts")
    XCTAssertTrue(scroll(transcript, toReveal: edit, up: true), "karta zapisu nad odpowiedzią")
    XCTAssertTrue(edit.label.contains("50 dodanych linii"), edit.label)
    XCTAssertEqual(edit.value as? String, "rozwinięte")
    let more = app.buttons.matching(NSPredicate(format: "identifier ENDSWITH '.more'")).firstMatch
    XCTAssertTrue(more.exists, "ogon mini-diffu")
    XCTAssertEqual(more.label, "… jeszcze 38 linii")

    // Seria: rozwijak nad najnowszym krokiem, trzy wcześniejsze schowane; rozwinięcie
    // trzyma rozwijak pod palcem, więc kroki pojawiają się NAD nim.
    let chip = app.buttons["transcript.toolRun"]
    XCTAssertTrue(scroll(transcript, toReveal: chip, up: true), "rozwijak serii")
    XCTAssertEqual(chip.label, "wcześniejsze kroki (3)")
    let firstStep = button(app, labelPrefix: "Read: data/klienci.csv")
    XCTAssertFalse(firstStep.exists, "pierwszy krok schowany")
    chip.tap()
    XCTAssertTrue(wait("label == 'zwiń wcześniejsze kroki'", chip))
    XCTAssertTrue(scroll(transcript, toReveal: firstStep, up: true), "rozwinięta seria pokazuje wcześniejsze kroki")

    // Karta zwykła: zwinięta linia, tap rozwija pełne wejście z adresem, drugi zwija.
    let command = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "npm test -- import")).firstMatch
    XCTAssertTrue(scroll(transcript, toReveal: command, up: false), "najnowszy krok serii")
    XCTAssertEqual(command.value as? String, "zwinięte")
    command.tap()
    XCTAssertTrue(wait("value == 'rozwinięte'", command))
    let detail = app.descendants(matching: .any).matching(NSPredicate(format: "identifier ENDSWITH '.detail'")).firstMatch
    XCTAssertTrue(detail.waitForAppearance(timeout: 5), "pełne wejście")
    command.tap()
    XCTAssertTrue(detail.waitForDisappearance(timeout: 5), "zwinięte z powrotem")

    // Pasek „na dół" stoi po odjechaniu od dna. Przewijanie do karty mogło dojechać
    // z powrotem do dna (gest przypina), więc odjeżdżamy jawnie.
    transcript.swipeDown(velocity: .fast)
    XCTAssertTrue(jump.waitForAppearance(timeout: 5), "pasek po odjechaniu od dna")
    XCTAssertEqual(jump.label, "Przewiń na dół")

    // Powrót do sesji: odpięta wraca na zapamiętane miejsce, więc pasek stoi dalej.
    open(app, session: "demo-willow-parser")
    XCTAssertTrue(jump.waitForDisappearance(timeout: 5), "inna sesja, przypięta")
    open(app, session: "demo-data-loader")
    XCTAssertTrue(jump.waitForAppearance(timeout: 10), "odpięta sesja wróciła nad dno")
    jump.tap()
    XCTAssertTrue(jump.waitForDisappearance(timeout: 5), "skok na dno chowa pasek")

    // Ogon mini-diffu rozwija się w miejscu, a rosnąca treść nie zmienia przypięcia. Ogon przy dnie
    // (iPad): rozwija go przypięty transkrypt i zostaje na dnie. Ogon nad dnem (telefon): dojazd do niego
    // odpina, a rozwinięcie nie ściąga listy z powrotem na dno — pasek stoi dalej.
    let tailAtBottom = more.waitForAppearance(timeout: 5) && wait("hittable == true", more, timeout: 2)
    if !tailAtBottom {
      XCTAssertTrue(scroll(transcript, toReveal: more, up: true), "ogon nad dnem")
      XCTAssertTrue(jump.waitForAppearance(timeout: 5), "dojazd do ogona odpina")
    }
    more.tap()
    XCTAssertTrue(more.waitForDisappearance(timeout: 5), "rozwijak ogona znika")
    let tail = app.descendants(matching: .any).matching(NSPredicate(format: "identifier ENDSWITH '.diffTail'")).firstMatch
    XCTAssertTrue(tail.waitForAppearance(timeout: 5), "ogon rozwinięty")
    if tailAtBottom {
      XCTAssertFalse(jump.exists, "rosnąca treść nie odpina")
    } else {
      XCTAssertTrue(jump.exists, "rosnąca treść nie przypina")
    }
  }

  @MainActor
  func testTimeGapMarker() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    let row = DemoServer.reveal(app, "demo-willow-parser")
    XCTAssertTrue(row.exists, "sesja parsera na liście")
    row.tap()
    DemoServer.hideKeyboard(app)
    // 31 min ciszy między promptem a odpowiedzią.
    let gap = app.descendants(matching: .any)["transcript.timeGap"]
    XCTAssertTrue(gap.waitForAppearance(timeout: 10), "znacznik godziny po przerwie")
    XCTAssertTrue(gap.label.hasPrefix("Przerwa, dalej od "), gap.label)
  }

  /// Inna sesja z listy agentów. Na telefonie lista nie stoi obok szczegółu (stos lista → szczegół, kontenera
  /// `session.list` nie ma wtedy w drzewie), więc najpierw systemowe „wstecz" (jak w `PhoneTerminalUITests`).
  @MainActor
  private func open(_ app: XCUIApplication, session id: String) {
    let list = app.descendants(matching: .any)["session.list"]
    if !list.exists {
      let back = app.navigationBars.buttons.element(boundBy: 0)
      XCTAssertTrue(back.waitForAppearance(timeout: 5), "przycisk „wstecz”")
      back.tap()
      XCTAssertTrue(list.waitForAppearance(timeout: 5), "lista agentów")
    }
    DemoServer.reveal(app, id).tap()
  }

  @MainActor
  private func button(_ app: XCUIApplication, labelPrefix: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", labelPrefix)).firstMatch
  }

  /// Przewija transkrypt (`up` = ku starszym), aż element stanie na ekranie.
  @MainActor
  private func scroll(_ list: XCUIElement, toReveal element: XCUIElement, up: Bool) -> Bool {
    for _ in 0..<10 {
      if element.exists, element.isHittable { return true }
      if up { list.swipeDown(velocity: .slow) } else { list.swipeUp(velocity: .slow) }
    }
    return element.exists && element.isHittable
  }

  private func wait(_ format: String, _ element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: element)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }
}
