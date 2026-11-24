import UIKit
import XCTest

/// Prawy panel sesji na iPadzie przeciw serwerowi demo. Panel staje od 920 pt kolumny
/// szczegółu, więc testy stoją na iPadzie w POZIOMIE i robią miejsce, gdy go brak: na 13" kolumna z listą ma 1056 pt,
/// a na 11" (urządzenie bramki) 890 pt — wtedy test zwija listę (1210 pt, `makeRoom`), a do przejścia na inną sesję
/// z listy rozwija ją z powrotem (stojący panel trzyma się do 880 pt). Sprawdzają: panel otwiera i zamyka wyłącznie człowiek (przycisk, Cmd+I — jedno
/// naciśnięcie, jedno przełączenie), preferencja przeżywa zmianę sesji i ponowne uruchomienie BEZ resetu, histerezę
/// (obrót, Cmd+B, największe pismo), kotwicę jednego przewijania przy rosnącym przebiegu workflow i tykaniu zegara,
/// pigułkę „w tle" i tap w linię gita przy widocznym panelu, zwijanie drzewa zmian oraz ZERO odczytów diffa bez
/// stuknięcia (licznik `diffRequests` kontroli demo — żądania, które naprawdę doszły do serwera), a po stuknięciu
/// pliku okno diffa z listą i patchem TYLKO tego pliku (`diffListRequests`, `diffFilePaths`). Układ listy:
/// drzewo, ustawiany jawnie przy każdym uruchomieniu i potwierdzany na tytule listy.
final class InspectorUITests: XCTestCase {
  private let task = "m1-workflow"

  override func setUp() {
    continueAfterFailure = false
  }

  /// Domyślnie zamknięty; przycisk i Cmd+I przełączają po jednym razie; inna sesja — panel stoi; ponowne
  /// uruchomienie BEZ resetu — panel wraca sam; zamknięcie zapisuje się tak samo.
  @MainActor
  func testOpensOnlyByHandAndSurvivesRelaunch() throws {
    let port = try DemoServer.requirePort()
    var app = try launch(port: port, shortcuts: true)
    open(app, "demo-willow")
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 10), "przycisk panelu w nagłówku")
    let panel = element(app, "inspector.panel")
    XCTAssertFalse(panel.exists, "panel nigdy nie pojawia się sam")
    XCTAssertFalse(button.isSelected)

    button.tap()
    XCTAssertTrue(panel.waitForAppearance(timeout: 5), "przycisk otwiera panel")
    XCTAssertTrue(button.isSelected, "przycisk mówi, że panel stoi")
    XCTAssertEqual(panel.frame.width, 320, accuracy: 1, "szerokość panelu")
    let transcript = app.collectionViews["transcript"]
    XCTAssertTrue(transcript.waitForAppearance(timeout: 10))
    XCTAssertLessThanOrEqual(transcript.frame.maxX, panel.frame.minX + 1, "transkrypt kończy się przy panelu")
    XCTAssertTrue(element(app, "inspector.git.title").exists, "sekcja zmian w katalogu")
    snapshot(app, "otwarty")

    // Jedno Cmd+I = jedno przełączenie (jedno wciśnięcie potrafi dojść dwa razy).
    app.typeKey("i", modifierFlags: .command)
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "Cmd+I zamyka")
    settle()
    XCTAssertFalse(panel.exists, "jedno Cmd+I nie otwiera z powrotem")
    app.typeKey("i", modifierFlags: .command)
    XCTAssertTrue(panel.waitForAppearance(timeout: 5), "Cmd+I otwiera")
    settle()
    XCTAssertTrue(panel.exists, "jedno Cmd+I nie zamyka z powrotem")

    // Inna sesja: preferencja stoi (na 11" lista wraca, a stojący panel trzyma się przy 890 pt).
    setList(app, visible: true)
    open(app, "demo-data-loader")
    XCTAssertTrue(
      wait(NSPredicate(format: "selected == true"), element(app, "tab.demo-data-loader")), "the other session in view")
    XCTAssertTrue(element(app, "inspector.git.title").waitForAppearance(timeout: 10), "the other session's Files")
    XCTAssertTrue(panel.exists)

    // Ponowne uruchomienie BEZ resetu: zalogowany plikiem podpisu, panel wraca sam.
    app.terminate()
    app = relaunch(port: port)
    XCTAssertTrue(DemoServer.listShown(app), "lista bez ponownego logowania")
    open(app, "demo-willow")
    makeRoom(app)
    XCTAssertTrue(element(app, "inspector.panel").waitForAppearance(timeout: 10), "preferencja po ponownym uruchomieniu")
    element(app, "header.inspector").tap()
    XCTAssertTrue(element(app, "inspector.panel").waitForDisappearance(timeout: 5))
    setList(app, visible: true)
    app.terminate()
    app = relaunch(port: port)
    XCTAssertTrue(DemoServer.listShown(app))
    open(app, "demo-willow")
    makeRoom(app)
    XCTAssertTrue(element(app, "header.inspector").waitForAppearance(timeout: 10))
    settle()
    XCTAssertFalse(element(app, "inspector.panel").exists, "zamknięcie też się pamięta")
    setList(app, visible: true)
    app.terminate()
  }

  /// Obrót i lista: poziomo bez listy (13": 1376 pt, 11": 1210 pt) panel staje; pionowo z listą (712 i 514 pt)
  /// chowa się razem z przyciskiem, a po powrocie wraca bez ręki. Zamknięty panel przy za wąskiej kolumnie: Cmd+I
  /// mówi „mieści się od ~920 pt" i NIE otwiera na zapas. Pasmo 880–920 pt sprawdzają testy logiki
  /// (`InspectorRoomTests`) i `testLargestTextFollowsColumnWidth` — na tych dwóch urządzeniach obrót go nie daje.
  @MainActor
  func testHysteresisRotationAndListToggle() throws {
    let port = try DemoServer.requirePort()
    let app = try launch(port: port, shortcuts: true)
    open(app, "demo-willow")
    let button = element(app, "header.inspector")
    let panel = element(app, "inspector.panel")
    setList(app, visible: false)
    XCTAssertTrue(button.waitForAppearance(timeout: 10), "poziomo bez listy panel się mieści")
    button.tap()
    XCTAssertTrue(panel.waitForAppearance(timeout: 5))

    XCUIDevice.shared.orientation = .portrait
    setList(app, visible: true)
    XCTAssertTrue(panel.waitForDisappearance(timeout: 10), "pionowo z listą: panel się chowa")
    XCTAssertFalse(button.exists, "bez miejsca nie ma przycisku")
    snapshot(app, "pion-z-lista")
    XCUIDevice.shared.orientation = .landscapeLeft
    setList(app, visible: false)
    XCTAssertTrue(panel.waitForAppearance(timeout: 10), "poziomo bez listy: preferencja stoi, panel wraca sam")

    // Zamknięty panel i za wąsko: dymek, bez zapisu na później.
    app.typeKey("i", modifierFlags: .command)
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5))
    XCUIDevice.shared.orientation = .portrait
    setList(app, visible: true)
    XCTAssertTrue(button.waitForDisappearance(timeout: 10))
    app.typeKey("i", modifierFlags: .command)
    let toast = element(app, "toast.notice")
    XCTAssertTrue(toast.waitForAppearance(timeout: 5), "Cmd+I mówi, dlaczego panelu nie ma")
    XCTAssertTrue(toast.label.contains("920"), toast.label)
    XCUIDevice.shared.orientation = .landscapeLeft
    setList(app, visible: false)
    XCTAssertTrue(button.waitForAppearance(timeout: 10), "miejsce poziomo bez listy: przycisk wraca")
    settle()
    XCTAssertFalse(panel.exists, "Cmd+I przy braku miejsca nie zmienił preferencji")
    setList(app, visible: true)
    app.terminate()
  }

  /// Największe pismo: lista szersza (do 460 pt), więc o przycisku decyduje zmierzona kolumna szczegółu; po Cmd+B
  /// panel się mieści, a powrót listy chowa go dopiero poniżej 880 pt (histereza).
  @MainActor
  func testLargestTextFollowsColumnWidth() throws {
    let port = try DemoServer.requirePort()
    let app = try launch(port: port, largest: true, shortcuts: true)
    open(app, "demo-willow")
    XCTAssertTrue(element(app, "header.git").waitForAppearance(timeout: 10), "ekran sesji")
    settle()
    let list = element(app, "session.list")
    let column = app.windows.firstMatch.frame.width - list.frame.width
    let button = element(app, "header.inspector")
    XCTAssertEqual(button.exists, column >= 920, "kolumna \(column) pt (lista \(list.frame.width) pt)")
    app.typeKey("b", modifierFlags: .command)
    XCTAssertTrue(button.waitForAppearance(timeout: 10), "lista zwinięta: panel się mieści")
    button.tap()
    XCTAssertTrue(element(app, "inspector.panel").waitForAppearance(timeout: 5))
    snapshot(app, "najwieksze-pismo")
    app.typeKey("b", modifierFlags: .command)
    settle(1.5)
    XCTAssertEqual(element(app, "inspector.panel").exists, column >= 880, "histereza przy kolumnie \(column) pt")
    app.terminate()
  }

  /// A finger drag on the panel's left divider widens it: the UIKit view that carries the resize pointer under the
  /// handle must not take the touch from the SwiftUI drag gesture.
  @MainActor
  func testDividerDragWidensPanel() throws {
    let port = try DemoServer.requirePort()
    let app = try launch(port: port, shortcuts: true)
    open(app, "demo-willow")
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 10))
    button.tap()
    let panel = element(app, "inspector.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 5))
    XCTAssertEqual(panel.frame.width, 320, accuracy: 1, "default width")
    let handle = element(app, "inspector.resize")
    XCTAssertTrue(handle.exists, "handle on the divider")
    let start = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    start.press(forDuration: 0.2, thenDragTo: start.withOffset(CGVector(dx: -100, dy: 0)),
                withVelocity: .slow, thenHoldForDuration: 0.2)
    settle()
    XCTAssertEqual(panel.frame.width, 420, accuracy: 12, "the drag widened the panel")
    // The other way, past the minimum.
    let edge = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    edge.press(forDuration: 0.2, thenDragTo: edge.withOffset(CGVector(dx: 200, dy: 0)),
               withVelocity: .slow, thenHoldForDuration: 0.2)
    settle()
    XCTAssertEqual(panel.frame.width, 280, accuracy: 1, "a drag past the minimum stops at 280 pt")
    element(app, "header.inspector").tap()
    setList(app, visible: true)
    app.terminate()
  }

  /// Przebieg workflow w panelu: pigułki „w tle" nie ma, fazy i agenci jak w popoverze (z przedrostkiem
  /// `inspector.`), a JEDNA kotwica panelu trzyma czytany wiersz, gdy rozkład rośnie nad nim i gdy tyka zegar.
  @MainActor
  func testWorkflowRowsKeepPanelAnchor() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("workflow", label: "M1 panel")
    let app = try launch(port: port)
    openTab(app, id)
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 15))
    XCTAssertTrue(element(app, "header.background").exists, "pigułka „w tle” przy zamkniętym panelu")
    button.tap()
    let panel = element(app, "inspector.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 5))
    XCTAssertTrue(element(app, "header.background").waitForDisappearance(timeout: 5), "przy panelu pigułki nie ma")

    let summary = element(app, "inspector.workflow.\(task).summary")
    XCTAssertTrue(summary.waitForAppearance(timeout: 10))
    let impl = phase(app, "Implementacja")
    let review = phase(app, "Review")
    XCTAssertEqual(review.value as? String, "rozwinięte", "bieżąca faza rozwinięta sama")
    XCTAssertEqual(impl.value as? String, "zwinięte")
    let live = agent(app, "review:45")
    XCTAssertTrue(live.waitForAppearance(timeout: 5))
    XCTAssertTrue(live.isHittable && panel.frame.contains(live.frame), "żywy agent widoczny bez przewijania")
    snapshot(app, "workflow")

    // Ręka: rozwinięcia przeżywają nowy rozkład, dopisany agent niczego nad sobą nie przesuwa.
    impl.tap()
    let reviewDone = doneGroup(app, "Review")
    XCTAssertTrue(reviewDone.waitForAppearance(timeout: 5))
    reviewDone.tap()
    XCTAssertTrue(agent(app, "review:01").waitForAppearance(timeout: 5))
    settle()
    let reviewBefore = review.frame
    try await control.emit("workflow-agent", sessionId: id)
    XCTAssertTrue(agent(app, "review:46").waitForAppearance(timeout: 10), "nowy żywy pod żywymi")
    XCTAssertEqual(impl.value as? String, "rozwinięte", "ręcznie otwarta faza zostaje")
    XCTAssertEqual(review.frame.minY, reviewBefore.minY, accuracy: 1, "dopisany agent nie przesunął fazy nad sobą")

    // Kotwica: czytany wiersz Review u góry panelu, rozkład rośnie NAD nim (Implementacja dostaje agenta), zegar tyka.
    // Przewinięcie, aż dwudziesty skończony agent Review stanie w górnej połowie panelu: nad nim są wtedy same
    // skończone wiersze Review, więc kotwica panelu leży POD miejscem, w którym rośnie rozkład (wyżej kotwicą byłaby
    // faza Implementacja i wiersz pod nią słusznie by się przesunął). Warunek „faza Review zniknęła” zawodził pod
    // obciążeniem: chwilowy brak elementu w zapytaniu kończył przewijanie za wcześnie.
    // Klawiatura ekranowa (pole wiadomości bierze fokus samo; w serii klas symulator ją pokazuje, pojedynczo — nie)
    // zmienia wysokość panelu i przesuwa czytany wiersz o 18,5 pt. Test mierzy kotwicę
    // przy rozkładzie i zegarze, więc warunki mają być te same w każdym przebiegu.
    DemoServer.hideKeyboard(app)
    settle()
    let deep = agent(app, "review:20")
    scrollDown(app, panel, until: { deep.exists && deep.isHittable && deep.frame.minY < panel.frame.midY })
    let reference = try XCTUnwrap(topVisibleAgent(app, panel, prefix: "review:"), "czytany wiersz Review w panelu")
    let referenceY = reference.frame.minY
    try await control.emit("workflow-agent", sessionId: id, text: "Implementacja")
    let deadline = Date().addingTimeInterval(3.5)
    while Date() < deadline {
      XCTAssertEqual(reference.frame.minY, referenceY, accuracy: 2, "rozkład nad wierszem i tyk zegara go nie przesuwają")
      try await Task.sleep(for: .milliseconds(150))
    }
    snapshot(app, "workflow-kotwica")

    // Koniec przebiegu: sekcja mówi „Nic nie leci w tle.", panel zostaje (zamyka go tylko człowiek).
    try await control.emit("workflow-end", sessionId: id)
    scrollUp(app, panel)
    XCTAssertTrue(element(app, "inspector.background.empty").waitForAppearance(timeout: 10), "pusta sekcja W TLE")
    XCTAssertTrue(panel.exists, "koniec przebiegu nie zamyka panelu")
    // Sprzątanie w treści testu, nie w bloku po nim: asynchroniczny blok sprzątania po porażce zawiesza przebieg,
    // a każdy test i tak zaczyna od `reset` demo. Lista wraca, bo apka pamięta jej zwinięcie.
    setList(app, visible: true)
    app.terminate()
    try await control.reset()
  }

  /// Stopka popovera „w tle": przy miejscu na panel popover ma przejście „Otwórz w panelu z prawej";
  /// stuknięcie zamyka popover, a DOPIERO potem panel staje na sekcji W TLE i pigułka (źródło popovera) znika.
  @MainActor
  func testPopoverFooterOpensPanel() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("workflow", label: "M1 stopka")
    let app = try launch(port: port)
    openTab(app, id)
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 15))
    let pill = element(app, "header.background")
    XCTAssertTrue(pill.waitForAppearance(timeout: 10), "pigułka „w tle” przy zamkniętym panelu")
    pill.tap()
    let popover = element(app, "header.background.panel")
    XCTAssertTrue(popover.waitForAppearance(timeout: 5), "popover „w tle”")
    let footer = element(app, "header.background.openPanel")
    XCTAssertTrue(footer.waitForAppearance(timeout: 5), "stopka z przejściem do panelu")
    XCTAssertEqual(footer.label, "Otwórz w panelu z prawej, Cmd+I")
    snapshot(app, "popover-stopka")
    footer.tap()
    XCTAssertTrue(popover.waitForDisappearance(timeout: 5), "popover zamknięty")
    let panel = element(app, "inspector.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 5), "panel stanął po zamknięciu popovera")
    XCTAssertTrue(pill.waitForDisappearance(timeout: 5), "przy panelu pigułki nie ma")
    XCTAssertTrue(element(app, "inspector.workflow.\(task).summary").waitForAppearance(timeout: 10), "sekcja W TLE")
    // Sprzątanie w treści testu: panel zamknięty (preferencja urządzenia), lista z powrotem.
    button.tap()
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "panel zamknięty")
    setList(app, visible: true)
    app.terminate()
    try await control.reset()
  }

  /// The Files section against the demo project (`server/src/demo/files.ts`): the whole tree from the listings,
  /// the change markers from the change list (letter, name, counts), and ZERO patch reads without the Diff item of a
  /// file's menu: at the panel opening, a `git-status` frame and a session switch. A tap on an existing file does not
  /// open the diff window; a tap on a deleted file opens it on that file. Long press → Diff opens the window: three
  /// headers, only that file open, the patch of THAT file goes to the server; the second header adds its path, and
  /// folding and unfolding fetches nothing. The section header folds the whole tree and the fold survives a session
  /// switch. With the panel the git line tap opens no popover, without it it does.
  @MainActor
  func testChangesFromFileDetailsWithoutDiff() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("idle", label: "M1 zmiany")
    let app = try launch(port: port)
    openTab(app, id)
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 15))
    button.tap()
    let panel = element(app, "inspector.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 5))

    // The tree of the demo project with the three demo changes, before any git frame.
    let modified = element(app, "inspector.git.file.src/notes.ts")
    XCTAssertTrue(modified.waitForAppearance(timeout: 10), "the tree from the listings and the change list")
    XCTAssertEqual(modified.label, "notes.ts, zmieniony, 2 dodane linie, 2 usunięte linie")
    XCTAssertEqual(element(app, "inspector.git.file.src/notes.test.ts").label, "notes.test.ts, nowy, 9 dodanych linii")
    let deleted = element(app, "inspector.git.file.src/notes-legacy.ts")
    XCTAssertEqual(deleted.label, "notes-legacy.ts, usunięty, 4 usunięte linie")
    let unchanged = element(app, "inspector.git.file.package.json")
    XCTAssertEqual(unchanged.label, "package.json", "an unchanged file of the listing")
    XCTAssertEqual(element(app, "inspector.git.dir.dist").label, "dist, ignorowany")
    XCTAssertFalse(element(app, "inspector.git.commit").exists, "panel nie pokazuje ostatniego commita")
    _ = try await control.stays("opening the panel reads no patch", for: .seconds(2)) { $0.diffFileRequests == 0 }

    // A git frame changes nothing in the reads of patches.
    try await control.emit("git-status", sessionId: id)
    _ = try await control.stays("a git frame reads no patch", for: .seconds(2)) { $0.diffFileRequests == 0 }
    // A directory with changes starts open; a tap folds it (its files leave) and unfolds it.
    let directory = element(app, "inspector.git.dir.src")
    XCTAssertTrue(directory.exists, "katalog drzewa")
    XCTAssertEqual(directory.label, "src, zmiany w środku: 3")
    XCTAssertEqual(directory.value as? String, "rozwinięty")
    DemoServer.hideKeyboard(app)
    settle()
    directory.tap()
    XCTAssertTrue(modified.waitForDisappearance(timeout: 5), "zwinięty katalog chowa pliki")
    XCTAssertEqual(directory.value as? String, "zwinięty")
    directory.tap()
    XCTAssertTrue(modified.waitForAppearance(timeout: 5), "rozwinięty katalog oddaje pliki")
    // No separate diff button; the section header is the toggle of the tree.
    let title = element(app, "inspector.git.title")
    XCTAssertFalse(element(app, "inspector.git.diff").exists, "bez pigułki „Diff”")
    XCTAssertEqual(title.value as? String, "rozwinięte", "drzewo startuje rozwinięte")
    snapshot(app, "zmiany")

    // A tap on an existing file is its preview, not the diff window; QuickLook's close button returns to the panel.
    unchanged.tap()
    let close = element(app, "QLOverlayDoneButtonAccessibilityIdentifier")
    XCTAssertTrue(close.waitForAppearance(timeout: 10), "a tap on an existing file opens its preview")
    XCTAssertFalse(element(app, "diff.sheet").exists, "a tap on an existing file opens no diff")
    _ = try await control.stays("a tap on an existing file reads no patch", for: .seconds(1)) { $0.diffFileRequests == 0 }
    close.tap()
    XCTAssertTrue(close.waitForDisappearance(timeout: 5), "the preview closed")
    XCTAssertTrue(unchanged.waitForAppearance(timeout: 5), "closing the preview returns to the panel")

    // Linia gita przy panelu przewija panel, popovera nie ma.
    let git = element(app, "header.git")
    XCTAssertTrue(git.waitForAppearance(timeout: 10), "linia gita po ramce")
    git.tap()
    settle()
    XCTAssertFalse(element(app, "header.git.panel").exists, "przy panelu tap w gita nie otwiera popovera")

    // Całe drzewo zwinięte do nagłówka: katalogi i pliki znikają, liczba w nagłówku zostaje.
    DemoServer.hideKeyboard(app)
    settle()
    title.tap()
    XCTAssertTrue(directory.waitForDisappearance(timeout: 5), "zwinięte drzewo: sam nagłówek")
    XCTAssertFalse(modified.exists, "zwinięte drzewo chowa pliki")
    XCTAssertEqual(title.value as? String, "zwinięte")
    XCTAssertTrue(title.label.hasSuffix("3"), "liczba zmian w nagłówku: \(title.label)")

    // Session switch: the other session's panel, the fold stays, still no patch read; back — this session's tree.
    // On 11" the list comes back and the standing panel holds at 890 pt (hysteresis).
    setList(app, visible: true)
    open(app, "demo-willow")
    XCTAssertTrue(
      wait(NSPredicate(format: "selected == true"), element(app, "tab.demo-willow")), "the other session in view")
    XCTAssertTrue(title.waitForAppearance(timeout: 10), "Files of the other session")
    XCTAssertFalse(modified.exists, "the folded tree shows no rows")
    _ = try await control.stays("a session switch reads no patch", for: .seconds(2)) { $0.diffFileRequests == 0 }
    // Powrót wierszem sesji odbioru w drzewie; zwinięty projekt rozwija stuknięcie w nagłówek.
    DemoServer.openRow(app, id, project: "rarog")
    XCTAssertTrue(
      wait(NSPredicate(format: "exists == true AND selected == true"), element(app, "tab.\(id)")), "powrót do sesji odbioru")
    DemoServer.hideKeyboard(app)
    // Zwinięte ręką zostaje zwinięte: inna sesja i powrót go nie rozwijają.
    XCTAssertTrue(wait(NSPredicate(format: "value == %@", "zwinięte"), title), "powrót do sesji: drzewo dalej zwinięte")
    XCTAssertFalse(modified.exists, "zwinięte drzewo po powrocie bez plików")
    title.tap()
    XCTAssertTrue(modified.waitForAppearance(timeout: 10), "rozwinięte drzewo: lista tej sesji")
    XCTAssertEqual(title.value as? String, "rozwinięte")

    // Long press → Diff: the window reads the patch of THAT file only, the rest are headers.
    menu(app, modified, "Diff")
    XCTAssertTrue(element(app, "diff.sheet").waitForAppearance(timeout: 10))
    let opened = element(app, "diff.file.src/notes.ts")
    let second = element(app, "diff.file.src/notes.test.ts")
    let third = element(app, "diff.file.src/notes-legacy.ts")
    XCTAssertTrue(opened.waitForAppearance(timeout: 10), "header of the chosen file")
    XCTAssertTrue(second.exists && third.exists, "pozostałe pliki jako nagłówki")
    XCTAssertEqual(opened.value as? String, "rozwinięty", "the chosen file open at once")
    XCTAssertEqual(second.value as? String, "zwinięty")
    XCTAssertEqual(third.value as? String, "zwinięty")
    XCTAssertEqual(opened.label, "src/notes.ts, zmieniony, 2 dodane linie, 2 usunięte linie")
    XCTAssertTrue(element(app, "diff.title").label.hasPrefix("Zmiany · 3"), element(app, "diff.title").label)
    _ = try await control.wait("the patch of the chosen file") { $0.diffFilePaths == ["src/notes.ts"] }
    _ = try await control.stays("folded files without a patch", for: .seconds(2)) { $0.diffFileRequests == 1 }
    // Drugi nagłówek: dochodzi patch TEGO pliku.
    second.tap()
    XCTAssertTrue(wait(NSPredicate(format: "value == %@", "rozwinięty"), second), "stuknięty nagłówek rozwija plik")
    _ = try await control.wait("patch drugiego pliku") { $0.diffFilePaths == ["src/notes.ts", "src/notes.test.ts"] }
    // Zwinięcie nie kasuje pobranego patcha: ponowne rozwinięcie niczego nie pobiera.
    second.tap()
    XCTAssertTrue(wait(NSPredicate(format: "value == %@", "zwinięty"), second), "nagłówek zwija plik")
    second.tap()
    XCTAssertTrue(wait(NSPredicate(format: "value == %@", "rozwinięty"), second))
    _ = try await control.stays("zwinąć i rozwinąć bez ponownego żądania", for: .seconds(2)) { $0.diffFileRequests == 2 }
    element(app, "diff.close").tap()
    XCTAssertTrue(element(app, "diff.sheet").waitForDisappearance(timeout: 5))

    // A tap on a deleted file opens the diff window on that file.
    deleted.tap()
    XCTAssertTrue(element(app, "diff.sheet").waitForAppearance(timeout: 10), "a deleted file opens the diff")
    XCTAssertTrue(
      wait(NSPredicate(format: "value == %@", "rozwinięty"), element(app, "diff.file.src/notes-legacy.ts")),
      "the deleted file open in the window")
    _ = try await control.wait("the patch of the deleted file") { $0.diffFilePaths.last == "src/notes-legacy.ts" }
    element(app, "diff.close").tap()
    XCTAssertTrue(element(app, "diff.sheet").waitForDisappearance(timeout: 5))
    let reads = try await control.stats().diffFileRequests

    // Zamknięty panel: linia gita otwiera popover jak przed panelem — z wierszami z ramki i bez żądań patcha.
    button.tap()
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5))
    git.tap()
    XCTAssertTrue(element(app, "header.git.panel").waitForAppearance(timeout: 5), "bez panelu — popover gita")
    XCTAssertTrue(element(app, "header.git.file.src/notes.ts").waitForAppearance(timeout: 5), "wiersze dymka z ramki")
    _ = try await control.stays("the git popover reads no patch", for: .seconds(2)) { $0.diffFileRequests == reads }
    app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
    app.terminate()
    try await control.reset()
  }

  /// Closing a full-screen file preview keeps what the app knows about the server. Two previews of an unchanged file,
  /// the second within the version probe's 10 s floor: right after the second close the Files tree still lists that
  /// file from the server's listing, instead of only the changed files until the next probe.
  @MainActor
  func testFilesTreeKeepsListingAfterTwoPreviews() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("idle", label: "M1 preview")
    let app = try launch(port: port)
    openTab(app, id)
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 15))
    button.tap()
    XCTAssertTrue(element(app, "inspector.panel").waitForAppearance(timeout: 5))
    let unchanged = element(app, "inspector.git.file.package.json")
    XCTAssertTrue(unchanged.waitForAppearance(timeout: 10), "an unchanged file of the listing")
    DemoServer.hideKeyboard(app)

    // No pause between the two previews: the second close falls inside the probe floor of the first.
    let close = element(app, "QLOverlayDoneButtonAccessibilityIdentifier")
    for round in 1...2 {
      XCTAssertTrue(unchanged.waitForAppearance(timeout: 5), "package.json listed before preview \(round)")
      unchanged.tap()
      XCTAssertTrue(close.waitForAppearance(timeout: 10), "preview \(round) opens")
      close.tap()
      XCTAssertTrue(close.waitForDisappearance(timeout: 5), "preview \(round) closed")
    }
    XCTAssertTrue(unchanged.waitForAppearance(timeout: 5), "package.json listed right after the second close")
    XCTAssertFalse(unchanged.waitForDisappearance(timeout: 3), "package.json stays listed after the second close")
    app.terminate()
    try await control.reset()
  }

  /// Stany okna diffa, których zwykłe demo nie pokaże, na trasach sterowanych kontrolą demo: lista jak na
  /// serwerze sprzed tras per plik (405) to zdanie o starszym serwerze, a ponowienie po „restarcie” otwiera okno od
  /// stukniętego pliku; patch w drodze to „Wczytuję…” pod nagłówkiem, a drugi stuknięty plik czeka w kolejce
  /// (żądania idą po jednym); awaria gita (503) to zdanie pod nagłówkiem z „Spróbuj ponownie”, które po naprawie
  /// pobiera plik. Zrzuty stanów idą do `RAROG_SCREENSHOT_DIR`, gdy jest ustawiony.
  @MainActor
  func testDiffWindowStatesFromControlledRoutes() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("idle", label: "M1 okno diffa")
    let app = try launch(port: port, theme: "dark")
    openTab(app, id)
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 15))
    button.tap()
    XCTAssertTrue(element(app, "inspector.panel").waitForAppearance(timeout: 5))
    let modified = element(app, "inspector.git.file.src/notes.ts")
    try await control.emitGitStatus(sessionId: id) { modified.exists }
    DemoServer.hideKeyboard(app)

    // Serwer sprzed tras per plik: lista odpowiada 405, okno mówi zdaniem i daje ponowienie.
    try await control.configure(diffList: "outdated")
    menu(app, modified, "Diff")
    XCTAssertTrue(element(app, "diff.sheet").waitForAppearance(timeout: 10), "okno diffa")
    let failure = element(app, "diff.failure")
    XCTAssertTrue(failure.waitForAppearance(timeout: 10), "zdanie zamiast listy")
    XCTAssertEqual(failure.label, "Serwer jest starszy niż apka — zrestartuj go.")
    _ = try await control.stays("bez listy nie idzie żaden patch", for: .seconds(1)) { $0.diffFileRequests == 0 }
    settle()
    try shot(app, "okno-diff-starszy-serwer", "dark")

    // „Restart”: lista przechodzi, patch stukniętego pliku stoi w drodze, drugi plik czeka w kolejce.
    try await control.configure(diffList: "pass", diffFile: "hold")
    element(app, "diff.retry").tap()
    let opened = element(app, "diff.file.src/notes.ts")
    let second = element(app, "diff.file.src/notes.test.ts")
    let third = element(app, "diff.file.src/notes-legacy.ts")
    XCTAssertTrue(opened.waitForAppearance(timeout: 10), "the retry opens the window at the chosen file")
    XCTAssertEqual(opened.value as? String, "rozwinięty")
    XCTAssertTrue(element(app, "diff.loading.src/notes.ts").waitForAppearance(timeout: 5), "„Wczytuję…” pod nagłówkiem")
    _ = try await control.wait("patch pierwszego pliku wstrzymany") { $0.held.diffs == 1 }
    second.tap()
    XCTAssertTrue(element(app, "diff.loading.src/notes.test.ts").waitForAppearance(timeout: 5), "drugi plik czeka")
    _ = try await control.stays("żądania idą po jednym", for: .seconds(1.5)) {
      $0.diffFilePaths == ["src/notes.ts"] && $0.held.diffs == 1
    }
    try shot(app, "okno-diff-wczytuje", "dark")
    try await control.release("diff")
    _ = try await control.wait("po pierwszym pliku idzie drugi") {
      $0.diffFilePaths == ["src/notes.ts", "src/notes.test.ts"]
    }
    XCTAssertTrue(element(app, "diff.loading.src/notes.ts").waitForDisappearance(timeout: 5), "patch pierwszego pliku")
    XCTAssertTrue(element(app, "diff.loading.src/notes.test.ts").waitForDisappearance(timeout: 5), "patch drugiego pliku")

    // Awaria gita przy trzecim pliku: zdanie serwera i ponowienie, które po naprawie pobiera plik. Dwa pierwsze
    // pliki idą w nagłówki, żeby trzeci stał na ekranie niezależnie od długości ich patchy (leniwy stos nie
    // buduje nagłówka poza ekranem).
    opened.tap()
    second.tap()
    XCTAssertTrue(wait(NSPredicate(format: "value == %@", "zwinięty"), second), "drugi plik zwinięty")
    XCTAssertTrue(third.waitForAppearance(timeout: 5), "trzeci nagłówek na ekranie")
    try await control.configure(diffFile: "fail")
    third.tap()
    let failed = element(app, "diff.failed.src/notes-legacy.ts")
    XCTAssertTrue(failed.waitForAppearance(timeout: 10), "zdanie porażki pod nagłówkiem")
    XCTAssertEqual(failed.label, "Git nie odpowiedział. Spróbuj ponownie.")
    XCTAssertEqual(third.value as? String, "rozwinięty", "plik zostaje rozwinięty")
    settle()
    try shot(app, "okno-diff-blad", "dark")
    try await control.configure(diffFile: "pass")
    element(app, "diff.failed.src/notes-legacy.ts.retry").tap()
    XCTAssertTrue(failed.waitForDisappearance(timeout: 10), "ponowienie pobiera plik")
    // The list count is not asserted: the Files tree reads the change list too.
    _ = try await control.wait("jedno ponowienie, jedno żądanie") {
      $0.diffFilePaths == ["src/notes.ts", "src/notes.test.ts", "src/notes-legacy.ts", "src/notes-legacy.ts"]
    }
    element(app, "diff.close").tap()
    XCTAssertTrue(element(app, "diff.sheet").waitForDisappearance(timeout: 5))
    button.tap()
    XCTAssertTrue(element(app, "inspector.panel").waitForDisappearance(timeout: 5), "panel zamknięty")
    setList(app, visible: true)
    app.terminate()
    try await control.reset()
  }

  /// Długi plik w oknie diffa, na patchach z bramki `diffFile: long` (400 linii; pliki demo mają po kilka).
  /// Nagłówek czytanego pliku zostaje przyklejony u góry. Zwinięcie pliku czytanego w środku zostawia na ekranie
  /// jego nagłówek i resztę listy — także wtedy, gdy pod nim stoi drugi długi plik — a plik, który przy
  /// odświeżeniu wraca krótszy, nie zostawia pustego okna. Regresja: leniwy stos z przyklejonymi nagłówkami
  /// zostawał bez wierszy na ekranie, gdy treść kurczyła się pod miejscem czytania.
  @MainActor
  func testLongFileCollapseAndShrinkKeepWindowContent() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("idle", label: "M1 długi diff")
    let app = try launch(port: port, theme: "dark")
    openTab(app, id)
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 15))
    button.tap()
    XCTAssertTrue(element(app, "inspector.panel").waitForAppearance(timeout: 5))
    let file = element(app, "inspector.git.file.src/notes.test.ts")
    try await control.emitGitStatus(sessionId: id) { file.exists }
    DemoServer.hideKeyboard(app)
    try await control.configure(diffFile: "long")
    menu(app, file, "Diff")
    let sheet = element(app, "diff.sheet")
    XCTAssertTrue(sheet.waitForAppearance(timeout: 10), "okno diffa")
    let first = element(app, "diff.file.src/notes.ts")
    let reading = element(app, "diff.file.src/notes.test.ts")
    let third = element(app, "diff.file.src/notes-legacy.ts")
    XCTAssertTrue(reading.waitForAppearance(timeout: 10), "nagłówek stukniętego pliku")
    XCTAssertTrue(wait(NSPredicate(format: "value == %@", "rozwinięty"), reading))
    settle(1.5)
    // Okno otwiera się od stukniętego pliku: jego nagłówek stoi u góry, a po przewinięciu w głąb zostaje tam.
    let pinnedY = reading.frame.minY
    func isVisible(_ header: XCUIElement) -> Bool { header.exists && header.isHittable }
    func deep() {
      let middle = sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
      for _ in 0..<3 {
        middle.press(
          forDuration: 0.05, thenDragTo: middle.withOffset(CGVector(dx: 0, dy: -420)), withVelocity: .slow,
          thenHoldForDuration: 0.3)
      }
      settle(1)
    }
    deep()
    XCTAssertTrue(isVisible(reading), "nagłówek czytanego pliku przyklejony")
    XCTAssertEqual(reading.frame.minY, pinnedY, accuracy: 2, "przyklejony stoi u góry okna")
    XCTAssertFalse(third.exists, "pod długim plikiem następnego nagłówka jeszcze nie widać")
    try shot(app, "okno-diff-dlugi-plik", "dark")

    // Zwinięcie w środku pliku: treść krótsza niż okno — widać całą listę, nie pustkę.
    reading.tap()
    XCTAssertTrue(wait(NSPredicate(format: "value == %@", "zwinięty"), reading), "plik zwinięty")
    XCTAssertTrue(isVisible(first) && isVisible(reading) && isVisible(third), "po zwinięciu widać trzy nagłówki")

    // Dwa długie pliki: zwinięcie pierwszego w środku stawia jego nagłówek u góry, a pod nim drugi plik.
    third.tap()
    XCTAssertTrue(wait(NSPredicate(format: "value == %@", "rozwinięty"), third))
    reading.tap()
    XCTAssertTrue(wait(NSPredicate(format: "value == %@", "rozwinięty"), reading))
    deep()
    XCTAssertTrue(isVisible(reading), "nagłówek czytanego pliku przyklejony")
    reading.tap()
    XCTAssertTrue(wait(NSPredicate(format: "value == %@", "zwinięty"), reading), "pierwszy z dwóch zwinięty")
    XCTAssertTrue(isVisible(reading) && isVisible(third), "zwinięty nagłówek i następny plik na ekranie")
    XCTAssertEqual(reading.frame.minY, pinnedY, accuracy: 2, "zwinięty nagłówek został u góry")
    XCTAssertEqual(third.frame.minY, reading.frame.maxY, accuracy: 2, "następny plik zaraz pod nim")
    XCTAssertEqual(third.value as? String, "rozwinięty")

    // Czytany plik wraca przy odświeżeniu krótszy (zwykły patch demo): okno pokazuje listę, nie pustkę.
    deep()
    XCTAssertTrue(isVisible(third), "nagłówek drugiego pliku przyklejony")
    try await control.configure(diffFile: "pass")
    try await control.emit("git-status", sessionId: id)
    // Ramka to nowa rewizja repozytorium: lista i rozwinięty plik idą od nowa, zwinięty — nie.
    _ = try await control.wait("odświeżenie pobiera rozwinięty plik od nowa") {
      $0.diffListRequests >= 2 && $0.diffFilePaths.count >= 3
        && Array($0.diffFilePaths.prefix(2)) == ["src/notes.test.ts", "src/notes-legacy.ts"]
        && $0.diffFilePaths.dropFirst(2).allSatisfy { $0 == "src/notes-legacy.ts" }
    }
    settle(1.5)
    XCTAssertTrue(isVisible(first) && isVisible(reading) && isVisible(third), "po skróceniu pliku widać trzy nagłówki")
    XCTAssertEqual(third.value as? String, "rozwinięty", "odświeżony plik zostaje rozwinięty")
    element(app, "diff.close").tap()
    XCTAssertTrue(sheet.waitForDisappearance(timeout: 5))
    button.tap()
    XCTAssertTrue(element(app, "inspector.panel").waitForDisappearance(timeout: 5), "panel zamknięty")
    setList(app, visible: true)
    app.terminate()
    try await control.reset()
  }

  /// Scenariusz `artifacts`: sekcja ARTEFAKTY stoi nad ZMIANAMI W KATALOGU z dwoma wierszami w kolejności
  /// serwera. Zwykły artefakt jest linkiem (cecha `.isLink`, zdanie czytnika kończy „Otwiera przeglądarkę.”),
  /// a stuknięcie oddaje adres systemowi — na pierwszy plan wychodzi Safari. Usunięty to tekst bez przycisku i bez
  /// linku. Notka o końcu obserwacji nie stawia sekcji „Skończone ostatnio”. Zrzut panelu (motyw ciemny) idzie do
  /// `RAROG_SCREENSHOT_DIR`, gdy jest ustawiony.
  @MainActor
  func testArtifactsSection() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("artifacts", label: "M1 artefakty")
    let app = try launch(port: port, theme: "dark")
    openTab(app, id)
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 15))
    button.tap()
    let panel = element(app, "inspector.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 5))
    let title = element(app, "inspector.artifacts.title")
    XCTAssertTrue(title.waitForAppearance(timeout: 10), "nagłówek sekcji ARTEFAKTY")
    XCTAssertEqual(title.label, "ARTEFAKTY")

    let reportId = "inspector.artifact.https://claude.ai/artifact/RaportTygodniowy7Kq2Wn"
    let draftId = "inspector.artifact.https://claude.ai/artifact/SzkicPrezentacji4Hm9Zx"
    let report = app.links[reportId]
    XCTAssertTrue(report.waitForAppearance(timeout: 10), "zwykły artefakt jest linkiem")
    XCTAssertFalse(app.buttons[reportId].exists, "link, nie zwykły przycisk")
    XCTAssertTrue(
      report.label.hasPrefix("Artefakt Raport tygodniowy, opublikowany 2 godziny temu, o "), report.label)
    XCTAssertTrue(report.label.hasSuffix(". Otwiera przeglądarkę."), report.label)
    let draft = element(app, draftId)
    XCTAssertTrue(draft.exists, "usunięty artefakt zostaje na liście")
    XCTAssertEqual(draft.elementType, .staticText, "usunięty to tekst")
    XCTAssertFalse(app.buttons[draftId].exists || app.links[draftId].exists, "usunięty bez przycisku i bez linku")
    XCTAssertTrue(
      draft.label.hasPrefix("Artefakt Szkic prezentacji, usunięty, opublikowany 1 dzień temu, "), draft.label)
    XCTAssertFalse(draft.label.contains("przeglądark"), draft.label)
    // Kolejność: nagłówek, najnowsza publikacja, usunięty szkic, dopiero potem ZMIANY W KATALOGU.
    let changes = element(app, "inspector.git.title")
    XCTAssertTrue(changes.exists, "sekcja zmian pod artefaktami")
    XCTAssertLessThan(title.frame.maxY, report.frame.minY)
    XCTAssertLessThan(report.frame.maxY, draft.frame.minY + 1)
    XCTAssertLessThan(draft.frame.maxY, changes.frame.minY)
    XCTAssertFalse(element(app, "inspector.finished.title").exists, "koniec obserwacji artefaktu to nie zakończenie zadania")
    // Pasek skrótów nad klawiaturą ekranową przykrywa pas panelu — schodzi przed zrzutem i stuknięciem.
    DemoServer.hideKeyboard(app)
    settle()
    try shot(app, "artefakty", "dark")

    // Stuknięcie: adres idzie do systemu (`openURL`), przeglądarki w apce nie ma.
    report.tap()
    let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 20), "stuknięcie otwiera Safari")
    safari.terminate()
    app.activate()
    XCTAssertTrue(panel.waitForAppearance(timeout: 10), "powrót do apki: panel stoi")
    button.tap()
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "panel zamknięty")
    setList(app, visible: true)
    app.terminate()
    try await control.reset()
  }

  /// Scenariusz `pull-requests`: sekcja PULL REQUESTY stoi nad ZMIANAMI W KATALOGU tylko wtedy, gdy sesja ma
  /// PR-y (seed `demo-willow` jej nie ma; kontrola demo trzyma jedną sesję odbioru naraz). Trzy PR-y, linkami (cecha
  /// `.isLink`): bez tytułu i draft na widoku, scalony z tytułem zwinięty pod wierszem „Scalone i zamknięte (1)”. Wiersz PR-a jest w kolorze linku (`linkInk` motywu
  /// ciemnego, piksele zrzutu wiersza), a stuknięcie oddaje adres systemowi — na pierwszy plan wychodzi Safari.
  @MainActor
  func testPullRequestsSection() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("pull-requests", label: "M1 pull requesty")
    let app = try launch(port: port, theme: "dark")
    open(app, "demo-willow")
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 15))
    button.tap()
    let panel = element(app, "inspector.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 5))
    XCTAssertTrue(element(app, "inspector.git.title").waitForAppearance(timeout: 10), "panel sesji bez PR-ów stoi")
    XCTAssertFalse(element(app, "inspector.pullRequests.title").exists, "bez PR-ów nie ma sekcji")

    setList(app, visible: true)
    openTab(app, id)
    makeRoom(app)
    XCTAssertTrue(panel.waitForAppearance(timeout: 10), "panel stoi w drugiej sesji")
    let title = element(app, "inspector.pullRequests.title")
    XCTAssertTrue(title.waitForAppearance(timeout: 10), "nagłówek sekcji PULL REQUESTY")
    XCTAssertEqual(title.label, "PULL REQUESTY")
    let titledId = "inspector.pullRequest.https://github.com/acme/widget/pull/42"
    let bareId = "inspector.pullRequest.https://github.com/acme/widget-docs/pull/7"
    let draftId = "inspector.pullRequest.https://github.com/acme/widget/pull/45"
    let bare = app.links[bareId]
    XCTAssertTrue(bare.waitForAppearance(timeout: 10), "PR bez tytułu jest linkiem")
    // The bare PR has no GitHub state in the demo and reads as before states existed.
    XCTAssertTrue(bare.label.hasPrefix("Pull request acme/widget-docs#7, utworzony 1 dzień temu, "), bare.label)
    let draft = app.links[draftId]
    XCTAssertTrue(draft.exists, "draft PR stays in view")
    XCTAssertTrue(
      draft.label.hasPrefix("Pull request acme/widget#45, Import notes from Markdown, draft, utworzony 2 dni temu, "),
      draft.label)
    // The merged PR folds under "Scalone i zamknięte (1)" at the end of the section, folded by default.
    XCTAssertFalse(app.links[titledId].exists, "merged PR folded")
    let settled = app.buttons["inspector.pullRequests.settled"]
    XCTAssertTrue(settled.exists, "folded row of merged and closed PRs")
    XCTAssertEqual(settled.label, "Scalone i zamknięte: 1")
    XCTAssertEqual(settled.value as? String, "zwinięte")
    settled.tap()
    let titled = app.links[titledId]
    XCTAssertTrue(titled.waitForAppearance(timeout: 5), "tap unfolds the merged PR, a link")
    XCTAssertEqual(settled.value as? String, "rozwinięte")
    XCTAssertFalse(app.buttons[titledId].exists, "link, nie zwykły przycisk")
    XCTAssertTrue(
      titled.label.hasPrefix("Pull request acme/widget#42, Add CSV export, scalony, utworzony 2 godziny temu, o "),
      titled.label)
    XCTAssertTrue(titled.label.hasSuffix(". Otwiera przeglądarkę."), titled.label)
    // Order: header, the PRs in view (server order), the folded row, the unfolded PR, then CHANGES; no artifacts.
    let changes = element(app, "inspector.git.title")
    XCTAssertTrue(changes.exists, "sekcja zmian pod PR-ami")
    XCTAssertLessThan(title.frame.maxY, bare.frame.minY)
    XCTAssertLessThan(bare.frame.maxY, draft.frame.minY + 1)
    XCTAssertLessThan(draft.frame.maxY, settled.frame.minY + 1)
    XCTAssertLessThan(settled.frame.maxY, titled.frame.minY + 1)
    XCTAssertLessThan(titled.frame.maxY, changes.frame.minY)
    XCTAssertFalse(element(app, "inspector.artifacts.title").exists, "bez artefaktów nie ma ich sekcji")
    DemoServer.hideKeyboard(app)
    settle()
    try shot(app, "pull-requesty", "dark")
    // Kolor linku: piksele `linkInk` motywu ciemnego (#93B5DD) w zrzucie wiersza — glif i tytuł, nie sama linia stanu.
    let ink = Self.pixels(near: 0x93B5DD, in: titled.screenshot())
    XCTAssertGreaterThanOrEqual(ink, 40, "wiersz PR w kolorze linkInk (\(ink) px)")

    titled.tap()
    let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 20), "stuknięcie otwiera Safari")
    safari.terminate()
    app.activate()
    XCTAssertTrue(panel.waitForAppearance(timeout: 10), "powrót do apki: panel stoi")
    button.tap()
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "panel zamknięty")
    setList(app, visible: true)
    app.terminate()
    try await control.reset()
  }

  /// Scenario `scheduled-tasks`: the SCHEDULED TASKS section stands above CHANGES with the one-shot task first (newest
  /// creation) and the recurring one under it, each one static text with one VoiceOver sentence. Times depend on the
  /// demo's clock, so the labels are checked up to the schedule word. The panel screenshot (dark theme) goes to
  /// `RAROG_SCREENSHOT_DIR` when it is set.
  @MainActor
  func testScheduledTasksSection() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("scheduled-tasks", label: "M1 zaplanowane")
    let app = try launch(port: port, theme: "dark")
    openTab(app, id)
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 15))
    button.tap()
    let panel = element(app, "inspector.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 5))
    let title = element(app, "inspector.scheduled.title")
    XCTAssertTrue(title.waitForAppearance(timeout: 10), "SCHEDULED TASKS section header")
    XCTAssertEqual(title.label, "ZAPLANOWANE ZADANIA")
    let once = element(app, "inspector.scheduled.a7e3f904")
    let recurring = element(app, "inspector.scheduled.5d0c1a2b")
    XCTAssertTrue(once.waitForAppearance(timeout: 10), "one-shot row")
    XCTAssertEqual(once.elementType, .staticText, "a row has no action")
    XCTAssertTrue(
      once.label.hasPrefix(
        "Zaplanowane zadanie Check whether the nightly import finished and summarise the errors, jednorazowo, "),
      once.label)
    XCTAssertTrue(recurring.exists, "recurring row")
    XCTAssertTrue(
      recurring.label.hasPrefix("Zaplanowane zadanie Run the flaky export tests and report new failures, co 30 minut, "),
      recurring.label)
    XCTAssertFalse(app.buttons["inspector.scheduled.a7e3f904"].exists, "not a button")
    let changes = element(app, "inspector.git.title")
    XCTAssertTrue(changes.exists, "changes section under the scheduled tasks")
    XCTAssertLessThan(title.frame.maxY, once.frame.minY)
    XCTAssertLessThan(once.frame.maxY, recurring.frame.minY + 1)
    XCTAssertLessThan(recurring.frame.maxY, changes.frame.minY)
    DemoServer.hideKeyboard(app)
    settle()
    try shot(app, "zaplanowane", "dark")
    button.tap()
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "panel closed")
    setList(app, visible: true)
    app.terminate()
    try await control.reset()
  }

  /// Ile pikseli zrzutu ma kolor `rgb` (±8 na kanał — rdzeń kreski pisma, bez krawędzi antyaliasingu). Liczy cały
  /// obraz, więc obrót zrzutu w poziomie nie zmienia wyniku.
  private static func pixels(near rgb: UInt32, in screenshot: XCUIScreenshot) -> Int {
    guard let image = screenshot.image.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return 0 }
    let width = image.width
    let height = image.height
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
      else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard drawn else { return 0 }
    let target = [Int(rgb >> 16 & 0xFF), Int(rgb >> 8 & 0xFF), Int(rgb & 0xFF)]
    return stride(from: 0, to: bytes.count, by: 4).count { index in
      (0..<3).allSatisfy { abs(Int(bytes[index + $0]) - target[$0]) <= 8 }
    }
  }

  // MARK: - Zrzuty (ocena wzrokowa): zadania w tle, pusto, zmiany, okno diffa — oba motywy

  @MainActor
  func testScreensDark() async throws { try await screens(theme: "dark") }

  @MainActor
  func testScreensLight() async throws { try await screens(theme: "light") }

  /// Screenshots for visual review, so without `RAROG_SCREENSHOT_DIR` both `testScreens*` tests are skipped. Their
  /// checks repeat the tests above; the one about the changes section after the git tap also passes with the panel
  /// anchor switched off (the short panel shows the section without scrolling), so it guards nothing in the gate.
  @MainActor
  private func screens(theme: String) async throws {
    guard ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] != nil else {
      throw XCTSkip("no RAROG_SCREENSHOT_DIR: screenshots are taken by hand, outside the gate")
    }
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("workflow", label: "Przegląd sidebara")
    let app = try launch(port: port, theme: theme)
    // Zadania w tle (makieta `Main.dc.html`).
    openTab(app, id)
    makeRoom(app)
    let button = element(app, "header.inspector")
    XCTAssertTrue(button.waitForAppearance(timeout: 15))
    button.tap()
    XCTAssertTrue(element(app, "inspector.workflow.\(task).summary").waitForAppearance(timeout: 10))
    try await control.emit("git-status", sessionId: id)
    XCTAssertTrue(element(app, "inspector.git.file.src/notes.ts").waitForAppearance(timeout: 10))
    settle()
    try shot(app, "w-tle", theme)
    // Zmiany: tap w linię gita przewija panel do sekcji (kotwica panelu).
    let panel = element(app, "inspector.panel")
    let git = element(app, "header.git")
    XCTAssertTrue(git.waitForAppearance(timeout: 10))
    // Klawiatura ekranowa (pole wiadomości bierze fokus samo; w serii klas symulator ją pokazuje) stawia nad sobą pasek
    // skrótów systemu, który przykrywa prawy panel w pasie y 406–455. Krótka treść panelu nie przewija się, więc
    // nagłówek zmian zostaje pod paskiem (wyższe wiersze „w tle” potrafią zsunąć go o 23,5 pt). Test sprawdza
    // kotwicę, nie klawiaturę — warunki mają być te same w każdym przebiegu, jak w `testWorkflowRowsKeepPanelAnchor`.
    DemoServer.hideKeyboard(app)
    settle()
    git.tap()
    settle()
    let title = element(app, "inspector.git.title")
    XCTAssertTrue(title.isHittable && panel.frame.contains(title.frame), "sekcja zmian w panelu po tapie w gita")
    try shot(app, "zmiany", theme)
    // Wskaźnik nad plikiem: nazwa w pełnym atramencie i pionowe linie poziomów — do oceny wzrokowej na zrzucie
    // (koloru ani linii drzewo dostępności nie niesie).
    if XCUIDevice.shared.supportsPointerInteraction {
      element(app, "inspector.git.file.src/notes.ts").hover()
      settle()
      try shot(app, "zmiany-wskaznik", theme)
    }
    // The diff window from the menu: the chosen file open, the rest as headers; then the second file open beside it.
    menu(app, element(app, "inspector.git.file.src/notes.ts"), "Diff")
    let diff = element(app, "diff.sheet")
    XCTAssertTrue(diff.waitForAppearance(timeout: 10), "okno diffa")
    XCTAssertTrue(element(app, "diff.file.src/notes.ts").waitForAppearance(timeout: 10), "nagłówek stukniętego pliku")
    settle(1.5)
    try shot(app, "okno-diff", theme)
    element(app, "diff.file.src/notes-legacy.ts").tap()
    settle(1.5)
    try shot(app, "okno-diff-dwa", theme)
    element(app, "diff.close").tap()
    XCTAssertTrue(diff.waitForDisappearance(timeout: 5), "okno diffa zamknięte")
    // A tap on an existing file: its preview over the panel, closed by QuickLook's close button.
    element(app, "inspector.git.file.src/notes.ts").tap()
    let close = element(app, "QLOverlayDoneButtonAccessibilityIdentifier")
    XCTAssertTrue(close.waitForAppearance(timeout: 10), "the file preview stands")
    // The first preview starts the QuickLook process, which draws the content later than the frame.
    settle(4)
    try shot(app, "podglad", theme)
    close.tap()
    XCTAssertTrue(close.waitForDisappearance(timeout: 5), "the file preview closed")
    // Drzewo zwinięte do nagłówka i z powrotem (zwinięcie pamięta urządzenie, więc test je cofa).
    title.tap()
    XCTAssertTrue(element(app, "inspector.git.file.src/notes.ts").waitForDisappearance(timeout: 5), "zwinięte drzewo")
    settle()
    try shot(app, "zmiany-zwiniete", theme)
    title.tap()
    XCTAssertTrue(element(app, "inspector.git.file.src/notes.ts").waitForAppearance(timeout: 5), "rozwinięte drzewo")
    // Pusto, skończone ostatnio (notki harnessu seeda) i zmiany bez listy (makieta `PanelPusty.dc.html`).
    setList(app, visible: true)
    open(app, "demo-pipe-link")
    XCTAssertTrue(element(app, "inspector.background.empty").waitForAppearance(timeout: 10))
    settle()
    try shot(app, "pusto", theme)
    // Another session with the Files tree of the demo project.
    open(app, "demo-data-loader")
    XCTAssertTrue(element(app, "inspector.git.title").waitForAppearance(timeout: 10))
    settle()
    try shot(app, "inna-sesja", theme)
    app.terminate()
    try await control.reset()
  }

  // MARK: - Pomocnicze

  /// iPad w poziomie na czas testu; sprzątanie wraca do orientacji sprzed niego, a gdy ta nie była orientacją
  /// interfejsu (`unknown` na starcie przebiegu, `faceUp`) — do pionu. „Powrót” do `unknown` zostawiał symulator
  /// w poziomie i następne klasy (zrzuty pikseli pytań, Cmd+B listy) widziały obrócony ekran.
  @MainActor
  private func landscape() throws {
    guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("prawy panel jest tylko na iPadzie") }
    let start = XCUIDevice.shared.orientation
    let back: UIDeviceOrientation = start.isValidInterfaceOrientation ? start : .portrait
    XCUIDevice.shared.orientation = .landscapeLeft
    addTeardownBlock { @MainActor in
      XCUIDevice.shared.orientation = back
    }
  }

  @MainActor
  func launch(
    port: Int, theme: String? = nil, largest: Bool = false, shortcuts: Bool = false,
    environment: [String: String] = [:]
  ) throws -> XCUIApplication {
    try landscape()
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchEnvironment.merge(environment) { $1 }
    if let theme { app.launchEnvironment["RAROG_UI_TEST_THEME"] = theme }
    if largest {
      app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    }
    app.launch()
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    if shortcuts { primeKeyboard(app) }
    return app
  }

  /// Ponowne uruchomienie BEZ resetu (zalogowany plikiem podpisu, preferencje zostają) w teście skrótów, więc też
  /// z rozruchem klawiatury.
  @MainActor
  private func relaunch(port: Int) -> XCUIApplication {
    let app = DemoServer.launch(port: port, reset: false)
    if DemoServer.listShown(app) { primeKeyboard(app) }
    return app
  }

  /// Rozruch klawiatury sprzętowej w każdym procesie apki testu ze skrótami (`launch(shortcuts: true)`, `relaunch`):
  /// na symulatorze, który dostał już klawisz od XCUITest, PIERWSZE Cmd+B, Cmd+I albo Cmd+U nowego procesu do apki
  /// nie dochodzi, a po dowolnym dostarczonym klawiszu już tak (`native/Rarog/docs/tests.md`, „Tests”). Jałowa strzałka
  /// w prawo na liście sesji, bez fokusu w polu tekstowym (sesja jeszcze nie otwarta), niczego na ekranie nie zmienia.
  /// Nie sam Shift: gubił się. Tylko w testach skrótów: proces, który dostał klawisz, układa okno diffa inaczej
  /// (`testLongFileCollapseAndShrinkKeepWindowContent` z rozruchem pada na nagłówku przyklejonym 44 pt wyżej).
  @MainActor
  private func primeKeyboard(_ app: XCUIApplication) {
    app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: [])
  }

  /// Miejsce na panel: przycisk panelu już stoi — nic do zrobienia; inaczej (11" poziomo z listą: 890 pt) zwinięcie
  /// listy daje kolumnę 1210 pt.
  @MainActor
  func makeRoom(_ app: XCUIApplication) {
    let button = element(app, "header.inspector")
    if button.waitForAppearance(timeout: 3) { return }
    setList(app, visible: false)
    XCTAssertTrue(button.waitForAppearance(timeout: 10), "miejsce na panel po zwinięciu listy")
  }

  /// Lista agentów obok szczegółu albo zwinięta — przyciskiem w nagłówku (ten sam stan co Cmd+B). Stan czyta z napisu
  /// przycisku („Ukryj listę sesji” przy rozwiniętej): element listy drzewa nie bywa „hittable” także wtedy, gdy
  /// stoi na ekranie. Apka pamięta zwinięcie także po ponownym uruchomieniu i resecie testów, więc testy zostawiają
  /// listę rozwiniętą.
  @MainActor
  func setList(_ app: XCUIApplication, visible: Bool) {
    let toggle = element(app, "header.listToggle")
    XCTAssertTrue(toggle.waitForAppearance(timeout: 10), "przycisk listy w nagłówku")
    let hide = "Ukryj listę sesji"
    guard (toggle.label == hide) != visible else { return }
    toggle.tap()
    let state = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: visible ? "label == %@" : "label != %@", hide), object: toggle)
    XCTAssertEqual(
      XCTWaiter.wait(for: [state], timeout: 10), .completed, visible ? "lista rozwinięta" : "lista zwinięta")
    settle(0.8)
  }

  /// Sesja z listy; pole wiadomości bierze fokus samo, więc klawiatura ekranowa symulatora idzie w dół.
  @MainActor
  func open(_ app: XCUIApplication, _ id: String) {
    DemoServer.hideKeyboard(app)
    let row = DemoServer.reveal(app, id)
    XCTAssertTrue(row.waitForAppearance(timeout: 10), "wiersz \(id)")
    row.tap()
    settle(0.5)
    DemoServer.hideKeyboard(app)
  }

  /// Sesja odbioru z listy; zwinięty projekt „rarog" rozwija stuknięcie w nagłówek (`DemoServer.openRow`).
  @MainActor
  func openTab(_ app: XCUIApplication, _ id: String) {
    DemoServer.openRow(app, id, project: "rarog")
    settle(0.5)
    DemoServer.hideKeyboard(app)
  }

  @MainActor
  func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  @MainActor
  private func phase(_ app: XCUIApplication, _ title: String) -> XCUIElement {
    element(app, "inspector.workflow.\(task).phase.\(title)")
  }

  @MainActor
  private func doneGroup(_ app: XCUIApplication, _ title: String) -> XCUIElement {
    element(app, "inspector.workflow.\(task).done.\(title)")
  }

  @MainActor
  private func agent(_ app: XCUIApplication, _ label: String) -> XCUIElement {
    element(app, "inspector.workflow.\(task).agent.m1-wf-\(label)")
  }

  /// Przeciągnięcie w panelu bez rozpędu, z przytrzymaniem na końcu.
  @MainActor
  private func drag(_ app: XCUIApplication, _ panel: XCUIElement, by delta: CGFloat) {
    let frame = panel.frame
    let span = min(abs(delta), frame.height * 0.5)
    let step = delta < 0 ? -span : span
    let origin = app.coordinate(withNormalizedOffset: .zero)
    let start = origin.withOffset(CGVector(dx: frame.midX, dy: frame.midY - step / 2))
    start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: step)),
                withVelocity: .slow, thenHoldForDuration: 0.3)
  }

  @MainActor
  private func scrollDown(_ app: XCUIApplication, _ panel: XCUIElement, until done: () -> Bool) {
    for _ in 0..<12 where !done() {
      drag(app, panel, by: -300)
    }
    drag(app, panel, by: -300)
    settle()
  }

  @MainActor
  private func scrollUp(_ app: XCUIApplication, _ panel: XCUIElement) {
    for _ in 0..<12 {
      drag(app, panel, by: 500)
    }
    settle()
  }

  /// Najwyższy w pełni widoczny wiersz agenta z danym prefiksem etykiety — miejsce czytania.
  @MainActor
  private func topVisibleAgent(_ app: XCUIApplication, _ panel: XCUIElement, prefix: String) -> XCUIElement? {
    let rows = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH %@", "inspector.workflow.\(task).agent.m1-wf-\(prefix)"))
      .allElementsBoundByIndex
    let top = panel.frame.minY + 8
    let visible = rows.filter { $0.isHittable && $0.frame.minY >= top && $0.frame.maxY <= panel.frame.maxY }
    guard let first = visible.min(by: { $0.frame.minY < $1.frame.minY }) else { return nil }
    return element(app, first.identifier)
  }

  func wait(_ predicate: NSPredicate, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: object)], timeout: timeout) == .completed
  }

  /// Chwila na koniec animacji przed pomiarem ramek.
  func settle(_ seconds: TimeInterval = 0.8) {
    Thread.sleep(forTimeInterval: seconds)
  }

  /// Long press on a row of the Files section (a right click on a Mac) and one item of its menu.
  @MainActor
  func menu(_ app: XCUIApplication, _ row: XCUIElement, _ item: String) {
    row.press(forDuration: 1.2)
    let button = app.buttons[item]
    XCTAssertTrue(button.waitForAppearance(timeout: 5), "menu item \(item)")
    button.tap()
  }

  @MainActor
  private func snapshot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "panel-\(name)"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// Zrzut do wyniku testu, a przy `RAROG_SCREENSHOT_DIR` — także plik `panel-<nazwa>-<motyw>.png`. Zrzut XCUITest
  /// iPada w POZIOMIE wychodzi obrócony i ucięty do 1032 pt szerokości (symulator iOS 27) — panel przy
  /// prawej krawędzi w ogóle się nie mieści. Dlatego przy `RAROG_SCREENSHOT_SYNC=1` test zostawia w katalogu prośbę
  /// `<plik>.request` i czeka, aż skrypt po stronie Maca zrobi zrzut `xcrun simctl io … screenshot`; bez odpowiedzi
  /// w 20 s zostaje zrzut XCUITest.
  @MainActor
  func shot(_ app: XCUIApplication, _ name: String, _ theme: String) throws {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = "panel-\(name)-\(theme)"
    attachment.lifetime = .keepAlways
    add(attachment)
    let environment = ProcessInfo.processInfo.environment
    guard let path = environment["RAROG_SCREENSHOT_DIR"] else { return }
    let file = URL(filePath: path, directoryHint: .isDirectory).appending(path: "panel-\(name)-\(theme).png")
    // Zrzut z poprzedniego przebiegu udawałby odpowiedź: test szedłby dalej, a strona Maca łapała ekran po czasie
    // (zrzut stanu błędu pokazałby plik już po ponowieniu).
    try? FileManager.default.removeItem(at: file)
    if environment["RAROG_SCREENSHOT_SYNC"] == "1" {
      let request = file.appendingPathExtension("request")
      try Data().write(to: request)
      for _ in 0..<80 where !FileManager.default.fileExists(atPath: file.path) { settle(0.25) }
      if FileManager.default.fileExists(atPath: file.path) { return }
      // Bez odpowiedzi: prośba znika, żeby spóźniona strona Maca nie zapisała pod tą nazwą późniejszego ekranu.
      try? FileManager.default.removeItem(at: request)
    }
    try screenshot.pngRepresentation.write(to: file)
  }
}
