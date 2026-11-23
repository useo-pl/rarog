import XCTest

/// Zrzuty popoverów i arkuszy, które stoją na systemowym szkle (Liquid Glass), np. arkusz
/// promptów, który na szkle wychodzi szarą, rozmytą plamą nad ciemnym transkryptem. Render warstwy
/// w testach UIKit szkła ani rozmycia nie oddaje; wiarygodny obraz daje tylko `XCUIApplication.screenshot()`.
/// iPad w poziomie, jak u użytkownika. Kolejno: „Ostatnie sesje", rozwinięcie gita i okno diffa (plik stuknięty
/// w dymku rozwinięty, potem drugi obok), panel „w tle", „Model i effort", „Nowa sesja", menu kontekstowe wiersza
/// z zamknięciem i lista promptów. Dymek gita ma pliki z ramki `git-status`, więc stoi
/// w sesji odbioru, której test tę ramkę wysyła.
/// Terminala w demo nie ma (`PhoneTerminalUITests`), więc okna terminala i jego historii test nie otwiera.
/// Test pisze `<nazwa>-<motyw>.png` do `RAROG_SCREENSHOT_DIR`; bez katalogu jest pomijany: zrzuty robi się ręcznie,
/// poza bramką. Powierzchnia, której nie udało się otworzyć, nie zatrzymuje reszty (asercja zostaje w wyniku).
final class GlassScreenshotUITests: XCTestCase {
  private var directory: URL!
  /// Orientacja sprzed testu — sprzątanie wraca do niej, nie do sztywnego pionu.
  private var startOrientation: UIDeviceOrientation?

  override func setUpWithError() throws {
    continueAfterFailure = true
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else {
      throw XCTSkip("brak RAROG_SCREENSHOT_DIR — zrzuty robi się ręcznie, poza bramką")
    }
    guard UIDevice.current.userInterfaceIdiom == .pad else {
      throw XCTSkip("popovery stoją na szkle tylko na iPadzie — na telefonie to arkusze")
    }
    directory = URL(filePath: path, directoryHint: .isDirectory)
    startOrientation = XCUIDevice.shared.orientation
    XCUIDevice.shared.orientation = .landscapeLeft
  }

  override func tearDown() {
    if let startOrientation, startOrientation != XCUIDevice.shared.orientation {
      XCUIDevice.shared.orientation = startOrientation
    }
    super.tearDown()
  }

  @MainActor
  func testCaptureDark() async throws { try await capture(theme: "dark") }

  @MainActor
  func testCaptureLight() async throws { try await capture(theme: "light") }

  @MainActor
  private func capture(theme: String) async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let app = DemoServer.makeApp()
    // Sprzątanie także po błędzie w połowie (np. zapis zrzutu): apka zamknięta, demo bez sesji testu.
    addTeardownBlock { @MainActor in
      app.terminate()
      try? await control.reset()
    }
    // Sesja z przebiegiem workflow: pigułka „w tle" w nagłówku i pigułki modelu oraz trybu pod polem.
    let workflow = try await control.create("workflow", label: "Szkło workflow")
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchEnvironment["RAROG_UI_TEST_THEME"] = theme
    app.launch()
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)

    // „Ostatnie sesje" projektu (arkusz z zegara w nagłówku projektu na liście).
    _ = DemoServer.revealProject(app, "willow")
    let recent = element(app, "tree.recent.willow")
    if recent.waitForAppearance(timeout: 5) {
      recent.tap()
      let sheet = element(app, "recent.sheet")
      if sheet.waitForAppearance(timeout: 10) {
        settle(2)
        try shot(app, "ostatnie", theme)
        element(app, "recent.close").tap()
        XCTAssertTrue(sheet.waitForDisappearance(timeout: 5), "„Ostatnie sesje” zamknięte")
      } else {
        XCTFail("arkusz „Ostatnie sesje”")
      }
    }

    // Rozwinięcie gita (popover), okno diffa z niego, panel „w tle" (popover) i „Model i effort" (popover)
    // w sesji z przebiegiem workflow.
    openSession(app, workflow)
    if app.textViews["composer.field"].waitForAppearance(timeout: 15) {
      DemoServer.hideKeyboard(app)
      settle()
      let git = element(app, "header.git")
      try await control.emitGitStatus(sessionId: workflow) { git.exists }
      if git.exists {
        DemoServer.hideKeyboard(app)
        git.tap()
        let panel = element(app, "header.git.panel")
        let file = element(app, "header.git.file.src/notes.ts")
        if panel.waitForAppearance(timeout: 5), file.waitForAppearance(timeout: 10) {
          settle()
          try shot(app, "git", theme)
          file.tap()
          let diff = element(app, "diff.sheet")
          if diff.waitForAppearance(timeout: 10), element(app, "diff.file.src/notes.ts").waitForAppearance(timeout: 10) {
            settle(1.5)
            try shot(app, "diff", theme)
            element(app, "diff.file.src/notes.test.ts").tap()
            settle(1.5)
            try shot(app, "diff-dwa-pliki", theme)
            element(app, "diff.close").tap()
            XCTAssertTrue(diff.waitForDisappearance(timeout: 5), "diff zamknięty")
          } else {
            XCTFail("okno diffa")
          }
          // Dymek schodzi sam, gdy staje okno diffa; zostaje tylko wtedy, gdy okno nie stanęło.
          if panel.exists { dismissPopover(app, panel) }
        } else {
          XCTFail("rozwinięcie gita nie otwarte")
        }
      }
      let pill = element(app, "header.background")
      if pill.waitForAppearance(timeout: 15) {
        pill.tap()
        let panel = element(app, "header.background.panel")
        if panel.waitForAppearance(timeout: 10) {
          settle()
          try shot(app, "w-tle", theme)
          dismissPopover(app, panel)
        } else {
          XCTFail("panel „w tle”")
        }
      } else {
        XCTFail("pigułka „w tle”")
      }
      let model = element(app, "composer.model")
      if model.waitForAppearance(timeout: 10) {
        model.tap()
        let sheet = element(app, "model.sheet")
        if sheet.waitForAppearance(timeout: 10) {
          settle(1.5)
          try shot(app, "model", theme)
          dismissPopover(app, sheet)
        } else {
          XCTFail("popover „Model i effort”")
        }
      } else {
        XCTFail("pigułka modelu")
      }
    } else {
      XCTFail("sesja workflow otwarta")
    }

    // „Nowa sesja" (arkusz formularza) z paska listy.
    let newSession = element(app, "list.newSession")
    if newSession.waitForAppearance(timeout: 5) {
      newSession.tap()
      let sheet = element(app, "newSession.sheet")
      if sheet.waitForAppearance(timeout: 10) {
        DemoServer.hideKeyboard(app)
        settle(1.5)
        try shot(app, "nowa-sesja", theme)
        element(app, "newSession.cancel").tap()
        XCTAssertTrue(sheet.waitForDisappearance(timeout: 5), "„Nowa sesja” zamknięta")
      } else {
        XCTFail("arkusz „Nowa sesja”")
      }
    } else {
      XCTFail("„Nowa sesja” w pasku listy")
    }

    // Menu kontekstowe wiersza z zamknięciem. Pozycji test nie wybiera: lista zamyka
    // od razu, bez pytania.
    let row = DemoServer.reveal(app, workflow)
    if row.exists, row.isHittable {
      row.press(forDuration: 1.2)
      let item = ["Zamknij panel w herdr", "Usuń z listy"].lazy
        .map { app.buttons[$0].firstMatch }
        .first { $0.waitForAppearance(timeout: 3) }
      if item != nil {
        settle(1.5)
        try shot(app, "zamknij", theme)
        // Tap w transkrypt obok zamyka menu i niczego nie wybiera.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.55)).tap()
        settle()
      } else {
        XCTFail("menu kontekstowe wiersza")
      }
    }

    // Lista promptów (popover z paska cytatu) — punkt odniesienia zgłoszenia.
    DemoServer.reveal(app, "demo-data-loader").tap()
    DemoServer.hideKeyboard(app)
    let transcript = app.collectionViews["transcript"]
    if transcript.waitForAppearance(timeout: 10) {
      let bar = app.buttons["transcript.promptBar"]
      for _ in 0..<8 where !bar.exists {
        let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
        start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 50)),
                    withVelocity: .slow, thenHoldForDuration: 0.3)
      }
      if bar.waitForAppearance(timeout: 5) {
        bar.tap()
        if element(app, "prompts.sheet").waitForAppearance(timeout: 5) {
          settle()
          try shot(app, "prompty", theme)
        }
      }
    }
  }

  // MARK: - Pomocnicze

  @MainActor
  private func shot(_ app: XCUIApplication, _ name: String, _ theme: String) throws {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = "szklo-\(name)-\(theme)"
    attachment.lifetime = .keepAlways
    add(attachment)
    let file = directory.appending(path: "\(name)-\(theme).png")
    // Zrzut XCUITest iPada w poziomie wychodzi na symulatorze iOS 27 obrócony i ucięty: przy
    // `RAROG_SCREENSHOT_SYNC=1` zrzut robi strona Maca (`scripts/ios-shots.sh`) na prośbę `<plik>.request`.
    // Stary plik udawałby odpowiedź, więc najpierw znika.
    try? FileManager.default.removeItem(at: file)
    if ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_SYNC"] == "1" {
      let request = file.appendingPathExtension("request")
      try Data().write(to: request)
      for _ in 0..<80 where !FileManager.default.fileExists(atPath: file.path) { settle(0.25) }
      if FileManager.default.fileExists(atPath: file.path) { return }
      // Bez odpowiedzi: prośba znika, żeby spóźniona strona Maca nie zapisała pod tą nazwą późniejszego ekranu.
      try? FileManager.default.removeItem(at: request)
    }
    try screenshot.pngRepresentation.write(to: file)
  }

  /// Tap obok popovera (w rogu ekranu najdalej od niego): na iPadzie zamyka go i nie trafia w nic pod spodem.
  @MainActor
  private func dismissPopover(_ app: XCUIApplication, _ panel: XCUIElement) {
    let frame = panel.frame
    let screen = app.frame
    let x = frame.midX > screen.midX ? 30 : screen.width - 30
    let y = frame.midY > screen.midY ? screen.height * 0.12 : screen.height * 0.88
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "popover zamknięty: \(panel.identifier)")
  }

  /// Wiersz sesji z listy; zwinięty projekt „rarog" (tam zakłada sesje sterowanie demo) rozwija stuknięcie
  /// w nagłówek (`DemoServer.openRow`).
  @MainActor
  private func openSession(_ app: XCUIApplication, _ id: String) {
    DemoServer.openRow(app, id, project: "rarog")
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  /// Chwila na koniec animacji prezentacji (szkło dociera do pełnego krycia po wjeździe).
  private func settle(_ seconds: TimeInterval = 1) {
    Thread.sleep(forTimeInterval: seconds)
  }
}
