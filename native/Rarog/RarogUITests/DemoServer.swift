import UIKit
import XCTest

// Wspólne dla testów UI: apka startuje w trybie testowym przeciw serwerowi DEMO na loopbacku.
// Port przychodzi z `TEST_RUNNER_RAROG_DEMO_PORT` (xcodebuild przekazuje zmienne z tym prefiksem
// do procesu testów bez prefiksu). Bez portu testy przepływu są pomijane — nigdy żywy Rarog (8930).

enum DemoServer {
  static var port: Int? {
    ProcessInfo.processInfo.environment["RAROG_DEMO_PORT"].flatMap(Int.init)
  }

  static func requirePort() throws -> Int {
    guard let port else { throw XCTSkip("brak RAROG_DEMO_PORT — test przepływu wymaga serwera demo") }
    guard port != 8930 else { throw XCTSkip("8930 to żywy Rarog — testy celują wyłącznie w demo") }
    return port
  }

  /// Język i region apki pod testem (`docs/localization.md`, „Tests”): asercje i zapytania stoją na polskich
  /// etykietach, a symulator startuje w `en_US`. Bez tych argumentów apka mówiłaby po angielsku, gdy tylko katalog
  /// ma angielskie tłumaczenie; przypięcie nie zależy od stanu katalogu. Inny język test wybiera jawnie
  /// (`makeApp(language: .en)`, zestaw dymny `EnglishSmokeUITests`); język i region idą zawsze w parze.
  ///
  /// Zmiennej `RAROG_COPY_LANGUAGE` apka pod XCUITest nie dostaje: XCUITest uruchamia ją osobnym procesem, a język
  /// copy wybiera jej `CopyLanguage` tak jak na urządzeniu, z `Bundle.main.preferredLocalizations` (argumenty niżej
  /// to lista języków urządzenia). Zmienna przykryłaby ten wybór, który zestaw dymny ma sprawdzić.
  enum AppLanguage: String {
    case pl
    case en

    /// `-AppleLanguages` i `-AppleLocale` z regionem języka.
    var arguments: [String] {
      switch self {
      case .pl: ["-AppleLanguages", "(pl)", "-AppleLocale", "pl_PL"]
      case .en: ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
      }
    }
  }

  /// JEDYNE miejsce tworzenia `XCUIApplication` apki: apka zawsze startuje z argumentami języka ``AppLanguage``,
  /// domyślnie polskiego. Testy dokładają własne argumenty (`+=`), nie podstawiają listy i nie podają
  /// `-AppleLanguages` same (strażnik `server/test/native-test-language.test.ts`).
  @MainActor
  static func makeApp(language: AppLanguage = .pl) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += language.arguments
    return app
  }

  @MainActor
  static func launch(
    port: Int, reset: Bool = true, environment: [String: String] = [:], language: AppLanguage = .pl
  ) -> XCUIApplication {
    let app = makeApp(language: language)
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    if reset { app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1" }
    app.launchEnvironment.merge(environment) { $1 }
    app.launch()
    return app
  }

  /// Zmienne startu dyktowania (build Debug) dla `launch(port:environment:)`: wybór w pamięci apki
  /// (`RAROG_UI_TEST_DICTATION`: `none` = brak wyboru, czyli ekran „Dyktowanie”; `system`; `soniox`) i scenariusz
  /// mikrofonu, gniazda Soniox i rozpoznawania systemowego (`RAROG_UI_TEST_VOICE`: `1` albo `denied`). Wybór żyje
  /// tylko w procesie apki, więc każde uruchomienie zaczyna od podanego.
  static func dictation(_ choice: String, voice: String = "1") -> [String: String] {
    ["RAROG_UI_TEST_DICTATION": choice, "RAROG_UI_TEST_VOICE": voice]
  }

  /// Parowanie z demo (apka ma tylko parowanie): ekran parowania, kod „jak z Maca”
  /// z `POST /api/demo/pairing`, link otwarty przez system (``systemLink(_:)`` — ta sama droga co link z QR), karta
  /// „Sparować z 127.0.0.1?” → „Sparuj”. Czeka na tytuł listy „AGENCI (N)”. `waitForList: false` — zalogowanie
  /// wchodzi prosto w sesję (cel powiadomienia na iPhonie: listy nie ma na ekranie); test sprawdza listę sam.
  /// Każdy kod z demo odpina urządzenia demo, więc test zaczyna od świeżego klucza (`RAROG_UI_TEST_RESET=1` kasuje
  /// poprzedni z Keychaina symulatora, który przeżywa ponowne uruchomienie apki). „Mam link” sprawdza
  /// `PairingUITests`.
  @MainActor
  static func pair(_ app: XCUIApplication, waitForList: Bool = true) {
    let start = app.descendants(matching: .any)["pair.start"].firstMatch
    XCTAssertTrue(start.waitForAppearance(timeout: 15), "ekran parowania")
    guard let port, let raw = try? pairingLink(port: port), let link = systemLink(raw) else {
      XCTFail("demo nie wydało kodu parowania")
      return
    }
    XCUIDevice.shared.system.open(link)
    let confirm = app.descendants(matching: .any)["pair.confirm"].firstMatch
    XCTAssertTrue(confirm.waitForAppearance(timeout: 10), "karta „Sparować z 127.0.0.1?”")
    waitUntilStill(confirm)
    confirm.tap()
    if waitForList { expectList(app) }
  }

  /// The pairing link as the system opens it in the simulator. The server builds `https://rarog.ai/pair#…`, but the
  /// simulator has no association with that domain and would open the address in Safari, so the same fragment goes
  /// under the app's own scheme, which the app reads the same way. The universal link itself is checked on a device.
  static func systemLink(_ link: String) -> URL? {
    guard let hash = link.firstIndex(of: "#") else { return nil }
    return URL(string: "rarog://pair\(link[hash...])")
  }

  /// Link parowania z serwera demo (`POST /api/demo/pairing`, tylko demo): demo odpina swoje urządzenia
  /// i wydaje kod „jak z Maca”. Runner XCUITest nie ma gniazda administracyjnego `rarog pair`.
  static func pairingLink(port: Int) throws -> String {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/demo/pairing")!)
    request.httpMethod = "POST"
    request.setValue("http://127.0.0.1:\(port)", forHTTPHeaderField: "Origin")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data("{}".utf8)
    let done = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var body: Data?
    URLSession.shared.dataTask(with: request) { data, _, _ in
      body = data
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 10)
    let object = try body.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    return try XCTUnwrap(object?["link"] as? String, "demo bez trasy /api/demo/pairing")
  }

  /// Lista agentów na ekranie (tytuł „AGENCI (N)”).
  @MainActor
  static func expectList(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    let title = app.descendants(matching: .any)["list.title"].firstMatch
    XCTAssertTrue(title.waitForAppearance(timeout: 15), "tytuł listy", file: file, line: line)
  }

  /// „+" w pasku zakładek to menu: „Nowa sesja" albo „Nowy terminal". Tap w „+" i w pozycję.
  @MainActor
  static func addFromPlus(_ app: XCUIApplication, terminal: Bool = false) {
    app.descendants(matching: .any)["tabs.add"].firstMatch.tap()
    let item = menuItem(app, id: terminal ? "tabs.add.terminal" : "tabs.add.session",
                        label: terminal ? "Nowy terminal" : "Nowa sesja")
    XCTAssertTrue(item.waitForAppearance(timeout: 5), "menu „+”")
    item.tap()
  }

  /// Jedno przeciągnięcie paska zakładek palcem po jego dolnej części (`forward` = ku dalszym zakładkom, czyli
  /// w stronę „+”). NIE `swipeLeft()` na `tabs.bar`: ramka paska sięga od góry okna, więc tamten gest zaczynał
  /// się w połowie jej wysokości — na pasku nawigacji. iPadOS 26 bierze poziome przeciągnięcie w tym miejscu za
  /// przesuwanie okna: apka schodzi z pełnego ekranu i zostaje pływającym oknem także dla następnych testów
  /// i przebiegów bramki (zmierzone na nagraniu z `testLargestTextSize`).
  @MainActor
  static func dragTabs(_ app: XCUIApplication, forward: Bool = true) {
    let bar = app.descendants(matching: .any)["tabs.bar"].firstMatch
    let origin = app.coordinate(withNormalizedOffset: .zero)
    // W największym piśmie górę paska przykrywa pasek nawigacji — palec idzie tuż nad dolną krawędzią.
    let y = bar.frame.maxY - min(12, bar.frame.height / 3)
    let width = app.frame.width
    let (from, to) = forward ? (width * 0.8, width * 0.2) : (width * 0.2, width * 0.8)
    origin.withOffset(CGVector(dx: from, dy: y)).press(
      forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: to, dy: y)),
      withVelocity: .default, thenHoldForDuration: 0.2)
  }

  /// Pozycja otwartego menu: po identyfikatorze, a gdy system go nie przeniósł — po napisie w menu.
  @MainActor
  static func menuItem(_ app: XCUIApplication, id: String, label: String) -> XCUIElement {
    let byId = app.descendants(matching: .any)[id].firstMatch
    if byId.waitForAppearance(timeout: 2) { return byId }
    let inMenu = app.collectionViews.buttons[label].firstMatch
    return inMenu.waitForAppearance(timeout: 2) ? inMenu : app.buttons[label].firstMatch
  }

  /// Lista wczytana: na ekranie stoi choć jeden wiersz sesji. Nie konkretny wiersz — w drzewie projekty idą
  /// alfabetycznie, a komórek spoza ekranu (duże pismo, iPhone, sesje dołożone przez testy) nie ma w drzewie dostępności.
  @MainActor
  static func listShown(_ app: XCUIApplication, timeout: TimeInterval = 15) -> Bool {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'session.' AND identifier != 'session.list'"))
      .firstMatch.waitForAppearance(timeout: timeout)
  }

  /// Wiersz sesji na liście (identyfikator `session.<id>`).
  @MainActor
  static func row(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)["session.\(id)"].firstMatch
  }

  /// Chowa klawiaturę ekranową, jeśli stoi (symulator zgłasza klawiaturę sprzętową, więc pole
  /// dostaje fokus samo, a pół ekranu klawiatury zasłania transkrypt).
  @MainActor
  static func hideKeyboard(_ app: XCUIApplication) {
    for label in ["Ukryj klawiaturę", "Hide keyboard"] {
      let button = app.keyboards.buttons[label]
      guard button.exists, button.isHittable else { continue }
      button.tap()
      return
    }
  }

  /// Closes a popover or sheet (the "Usage" sheet and the like): Esc first, then a swipe down on the phone
  /// sheet, then a tap outside the popover. Waits for the sheet to disappear.
  @MainActor
  static func dismissSheet(_ app: XCUIApplication, _ sheet: XCUIElement) {
    app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
    if sheet.waitForDisappearance(timeout: 2) { return }
    if UIDevice.current.userInterfaceIdiom == .phone {
      sheet.swipeDown(velocity: .fast)
    } else {
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.04)).tap()
    }
    _ = sheet.waitForDisappearance(timeout: 5)
  }

  /// Czeka, aż element przestanie się przesuwać: ta sama ramka w trzech kolejnych odczytach co 0,2 s. Tap w element,
  /// który jedzie razem z formularzem (klawiatura ekranowa wysuwa się albo chowa), trafia w miejsce sprzed ruchu.
  @MainActor
  static func waitUntilStill(_ element: XCUIElement, timeout: TimeInterval = 6) {
    let deadline = Date().addingTimeInterval(timeout)
    var last = element.frame
    var still = 0
    while still < 3, Date() < deadline {
      Thread.sleep(forTimeInterval: 0.2)
      let now = element.frame
      still = now == last ? still + 1 : 0
      last = now
    }
  }

  /// Wiersz przewinięty CAŁY w widoczną część listy. Lista sięga pod pasek nawigacji i pod wstawkę
  /// PROJEKTY ze stopką limitów (`safeAreaInset`), a XCUITest uznaje komórkę pod wstawką za
  /// „hittable”: przy największym piśmie tap w jej środek trafiał w wiersz projektu.
  /// Komórek poza ekranem nie ma w drzewie dostępności — wtedy przewijanie na ślepo jak dawniej.
  @MainActor
  static func reveal(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    revealElement(app, row(app, id))
  }

  /// Nagłówek projektu w drzewie (identyfikator `project.<nazwa>`) przewinięty cały w widoczną część listy.
  @MainActor
  static func revealProject(_ app: XCUIApplication, _ name: String) -> XCUIElement {
    revealElement(app, app.descendants(matching: .any)["project.\(name)"].firstMatch)
  }

  /// Otwiera sesję z drzewa. Wiersza nie widać, bo projekt jest zwinięty: stuknięcie w nagłówek go rozwija
  /// (nagłówek zwija i rozwija, nie wchodzi w projekt). Wiersz jest, ale XCUITest nie uznaje go za
  /// klikalny (iPhone w największym piśmie): stuknięcie po współrzędnych w górną część wiersza.
  @MainActor
  static func openRow(_ app: XCUIApplication, _ id: String, project: String) {
    var row = reveal(app, id)
    if row.exists, row.isHittable {
      row.tap()
      return
    }
    // Nagłówek tylko wtedy, gdy wiersza nie ma w drzewie: przewinięcie do nagłówka przy istniejącym wierszu
    // wyprowadzałoby go z ekranu przed stuknięciem po współrzędnych.
    if !row.exists {
      let header = revealProject(app, project)
      if header.exists, (header.value as? String)?.hasPrefix("zwinięty") == true {
        header.tap()
        let expanded = XCTNSPredicateExpectation(
          predicate: NSPredicate(format: "value == 'rozwinięty'"), object: header)
        XCTAssertEqual(XCTWaiter.wait(for: [expanded], timeout: 10), .completed, "nagłówek \(project) rozwija projekt")
      }
      row = reveal(app, id)
      if row.exists, row.isHittable {
        row.tap()
        return
      }
    }
    XCTAssertTrue(row.exists, "wiersz \(id) w drzewie projektu \(project)")
    guard row.exists else { return }
    let point = CGPoint(x: row.frame.midX, y: row.frame.minY + min(16, row.frame.height / 2))
    XCTAssertTrue(app.frame.contains(point), "punkt stuknięcia wiersza \(id) na ekranie: \(point), \(row.frame)")
    guard app.frame.contains(point) else { return }
    let origin = app.coordinate(withNormalizedOffset: .zero)
    origin.withOffset(CGVector(dx: point.x, dy: point.y)).tap()
  }

  /// Element listy (wiersz agenta albo nagłówek projektu) przewinięty cały w widoczną część listy.
  ///
  /// Without the element in the tree the list is flung blind toward its end until the element shows up or the list
  /// stops moving, then back toward its start the same way. A fixed number of flings is not enough: in the largest
  /// text the rows are several hundred points tall and the visible part of the list a few hundred at most, so the
  /// last projects of the tree lay beyond six flings.
  @MainActor
  static func revealElement(_ app: XCUIApplication, _ element: XCUIElement) -> XCUIElement {
    let list = app.descendants(matching: .any)["session.list"].firstMatch
    var adjustments = 0
    var flings = 0
    var up = true
    var still = 0
    var ends = 0
    while adjustments < 8, flings < 40, ends < 2 {
      if element.exists, element.isHittable {
        let visible = visibleListArea(app, list)
        let frame = element.frame
        // Wiersz wyższy niż widoczna część: wystarczy jego środek.
        let fits = frame.height <= visible.height
        let shown = fits
          ? frame.minY >= visible.minY && frame.maxY <= visible.maxY
          : frame.midY > visible.minY && frame.midY < visible.maxY
        if shown { return element }
        scroll(app, list: list, within: visible, by: shift(frame, into: visible, fits: fits))
        adjustments += 1
        continue
      }
      let before = listPosition(app)
      fling(app, within: freeListArea(app, list), x: dragX(list), up: up)
      flings += 1
      // Two flings in a row without movement: the end of the list (one may start on a control that just appeared).
      still = listPosition(app) == before ? still + 1 : 0
      if still == 2 {
        up.toggle()
        still = 0
        ends += 1
      }
    }
    return element
  }

  /// Where the list stands: the identifier and top edge of the first row or project header in the tree. The same
  /// value before and after a fling means the list did not move, so it reached its end in that direction.
  @MainActor
  private static func listPosition(_ app: XCUIApplication) -> String {
    let first = app.descendants(matching: .any).matching(NSPredicate(
      format: "identifier BEGINSWITH 'project.' OR (identifier BEGINSWITH 'session.' AND identifier != 'session.list')"
    )).firstMatch
    guard first.exists else { return "" }
    return "\(first.identifier) \(first.frame.minY)"
  }

  /// Część listy, której nie zakrywa pasek nawigacji ani dolna wstawka (limity).
  @MainActor
  private static func visibleListArea(_ app: XCUIApplication, _ list: XCUIElement) -> CGRect {
    let frame = list.frame
    var top = frame.minY
    var bottom = frame.maxY
    for bar in app.navigationBars.allElementsBoundByIndex
    where bar.frame.minX < frame.maxX && bar.frame.maxX > frame.minX && bar.frame.maxY < frame.midY {
      top = max(top, bar.frame.maxY)
    }
    for id in ["list.usage"] {
      let inset = app.descendants(matching: .any)[id].firstMatch
      // The footer card stands at the bottom; in the largest text in landscape it starts above the list's middle.
      if inset.exists, inset.frame.minX < frame.maxX, inset.frame.midY > frame.midY {
        bottom = min(bottom, inset.frame.minY)
      }
    }
    return CGRect(x: frame.minX, y: top, width: frame.width, height: max(0, bottom - top))
  }

  /// Where a drag on the list lands horizontally: 16 pt from the list's leading edge, in the column of the tree
  /// guide. The jump pills are narrower than the list and centered, so they leave this column free; in the largest
  /// text in landscape they cover almost the whole height of the visible list.
  @MainActor
  private static func dragX(_ list: XCUIElement) -> CGFloat {
    list.frame.minX + 16
  }

  /// The visible part of the list in the drag column (`dragX`) without the controls that float over its rows there:
  /// the filter capsule and Inbox at the top, the jump pills at either end. A drag that starts on one of them does not
  /// move the list.
  @MainActor
  private static func freeListArea(_ app: XCUIApplication, _ list: XCUIElement) -> CGRect {
    let visible = visibleListArea(app, list)
    let x = dragX(list)
    var top = visible.minY
    var bottom = visible.maxY
    for id in ["list.filter", "list.inbox", "list.jump.above", "list.jump.below"] {
      let control = app.descendants(matching: .any)[id].firstMatch
      guard control.exists else { continue }
      let frame = control.frame
      guard frame.minX <= x, frame.maxX >= x, frame.maxY > top, frame.minY < bottom else { continue }
      if frame.midY < visible.midY {
        top = max(top, frame.maxY)
      } else {
        bottom = min(bottom, frame.minY)
      }
    }
    return CGRect(x: visible.minX, y: top, width: visible.width, height: max(0, bottom - top))
  }

  /// Przesunięcie treści (w punktach, dodatnie = w dół), po którym wiersz stoi w widocznej części.
  private static func shift(_ frame: CGRect, into visible: CGRect, fits: Bool) -> CGFloat {
    let margin: CGFloat = 24
    guard fits else { return visible.midY - frame.midY }
    return frame.maxY > visible.maxY ? visible.maxY - margin - frame.maxY : visible.minY + margin - frame.minY
  }

  /// Przewinięcie na ślepo (wiersza nie ma jeszcze w drzewie) rzutem wewnątrz widocznej części listy. Gest od
  /// środka całego elementu listy przy dużym piśmie zaczyna się na karcie PROJEKTY
  /// i przewija projekty zamiast agentów.
  ///
  /// The finger lands inside `free` and travels 400 pt, past `free` when it is shorter (once the drag moves the list,
  /// the finger may cross the filters or the footer): in the largest text in landscape the free part is about 200 pt
  /// and a row about 400 pt tall.
  @MainActor
  private static func fling(_ app: XCUIApplication, within free: CGRect, x: CGFloat, up: Bool) {
    let origin = app.coordinate(withNormalizedOffset: .zero)
    let window = app.frame
    let margin = min(24, free.height / 4)
    let from = up ? free.maxY - margin : free.minY + margin
    let to = up ? max(window.minY + 40, from - 400) : min(window.maxY - 40, from + 400)
    origin.withOffset(CGVector(dx: x, dy: from)).press(
      forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: x, dy: to)), withVelocity: .slow,
      thenHoldForDuration: 0)
  }

  /// Dokładne przeciągnięcie palcem wewnątrz widocznej części, z przytrzymaniem na końcu (bez
  /// rozpędu). Najwyżej pół wysokości naraz: start i koniec nie wychodzą pod pasek ani wstawkę.
  @MainActor
  private static func scroll(_ app: XCUIApplication, list: XCUIElement, within visible: CGRect, by delta: CGFloat) {
    let limit = max(40, visible.height / 2 - 24)
    let step = max(-limit, min(limit, delta))
    let origin = app.coordinate(withNormalizedOffset: .zero)
    // A drag that starts on a floating control (filters, jump pill) does not move the list: the finger lands in the
    // drag column, and at the edge of its free part when the middle of the visible list is covered there.
    let free = freeListArea(app, list)
    var y = visible.midY - step / 2
    if y < free.minY + 4 || y > free.maxY - 4 { y = step > 0 ? free.minY + 8 : free.maxY - 8 }
    let start = origin.withOffset(CGVector(dx: dragX(list), dy: y))
    start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: step)),
                withVelocity: .slow, thenHoldForDuration: 0.3)
  }
}

// MARK: - Settings

/// Settings is a list of rows (`settings.form`), each pushing its page (`settings.page.<page>`) in the same sheet.
/// Close (`settings.close`) stands on the list only, so a test on a page goes Back first.
extension DemoServer {
  /// Opens Settings from the list bar when they are closed, taps the list row `settings.row.<page>` and waits for
  /// the page container, which it returns.
  @MainActor
  @discardableResult
  static func openSettingsPage(
    _ app: XCUIApplication, _ page: String, file: StaticString = #filePath, line: UInt = #line
  ) -> XCUIElement {
    let form = app.descendants(matching: .any)["settings.form"].firstMatch
    if !form.exists {
      app.descendants(matching: .any)["list.settings"].firstMatch.tap()
      XCTAssertTrue(form.waitForAppearance(timeout: 10), "Settings open", file: file, line: line)
    }
    let row = revealSettings(app, "settings.row.\(page)", in: form)
    XCTAssertTrue(row.exists && row.isHittable, "Settings row \(page)", file: file, line: line)
    row.tap()
    let container = app.descendants(matching: .any)["settings.page.\(page)"].firstMatch
    XCTAssertTrue(container.waitForAppearance(timeout: 10), "Settings page \(page)", file: file, line: line)
    return container
  }

  /// Swipes the Settings list or a page container up until the element is on screen: cells off screen are not in
  /// the accessibility tree.
  @MainActor
  static func revealSettings(_ app: XCUIApplication, _ id: String, in container: XCUIElement) -> XCUIElement {
    let target = app.descendants(matching: .any)[id].firstMatch
    for _ in 0..<8 {
      if target.exists, target.isHittable { return target }
      container.swipeUp(velocity: .slow)
    }
    return target
  }

  /// The system's Back on a Settings page (its navigation bar carries the page title), then the list again.
  @MainActor
  static func settingsBack(
    _ app: XCUIApplication, from title: String, file: StaticString = #filePath, line: UInt = #line
  ) {
    let back = app.navigationBars[title].buttons.element(boundBy: 0)
    XCTAssertTrue(back.waitForAppearance(timeout: 5), "Back on the \(title) page", file: file, line: line)
    back.tap()
    let form = app.descendants(matching: .any)["settings.form"].firstMatch
    XCTAssertTrue(form.waitForAppearance(timeout: 10), "the Settings list after Back", file: file, line: line)
  }
}

extension XCUIElement {
  /// Czeka, aż element się pojawi; element, który już jest, zwraca od razu. `waitForExistence(timeout:)` sprawdza
  /// element pierwszy raz dopiero po ≥ 1 s, a jedno `exists` kosztuje ~0,14 s: w pełnej bramce 993 z 1103
  /// czekań kończy się na tym pierwszym sprawdzeniu, ~15 min na przebieg. Wariant na `XCTNSPredicateExpectation`
  /// odrzucony, bo zmienia rytm sprawdzeń przy nieobecnym elemencie. Testy wołają tylko ten helper (strażnik:
  /// `server/test/native-ui-test-waits.test.ts`).
  func waitForAppearance(timeout: TimeInterval) -> Bool {
    exists || waitForExistence(timeout: timeout)
  }

  /// Czeka, aż element zniknie.
  func waitForDisappearance(timeout: TimeInterval) -> Bool {
    let predicate = NSPredicate(format: "exists == false")
    let expectation = XCTNSPredicateExpectation(predicate: predicate, object: self)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }
}
