import XCTest

/// Wygląd nagłówka sesji mierzony z pikseli zrzutu:
/// - wcięcia rzędów: pierwszy tekst zakładek i linia gita zaczynają się 16 pt od lewej krawędzi kolumny,
///   jak tekst transkryptu; prawą krawędź pigułek i pierścień kontekstu (demo ich
///   nie ma) mierzy `HeaderChromeTests` w `RarogUIKitTests`;
/// - jedna kreska: nagłówek oddziela od transkryptu kreska pod ostatnim rzędem — pod linią statusu,
///   a pod paskiem zakładek tylko wtedy, gdy linii statusu nie ma;
/// - ikony paska: ciche glify z celem dotyku 44 pt w skali średniej (≤ 18 pt, najszerszy ponad 16,5 pt);
/// - zakładka bez znaku stanu przed etykietą: stan niesie kolor kafelka z cyfrą albo kwadracika,
///   bieżąca stoi na płytce.
///
/// Demo: `demo-willow` ma gałąź i rozjazd (linia statusu stoi) i siostrę `demo-willow-parser`. Sesja bez
/// linii statusu to świeża sesja z „+" w projekcie map-view (demo nie zna jej gita); test ją zamyka.
final class HeaderChromeUITests: XCTestCase {
  /// Wspólne wcięcie treści ekranu sesji (tekst transkryptu).
  private static let inset: CGFloat = 16

  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testContentInsets() throws {
    // Pomiary są niezależne: raport ma pokazać każde odstępstwo naraz, nie tylko pierwsze.
    continueAfterFailure = true
    let app = try launchLoggedIn()
    let shot = try openSession(app, "demo-willow", "naglowek-wciecia")
    let column = shot.column

    // Pierwszy atrament zakładek: kafelek z cyfrą skrótu (klawiatura sprzętowa) albo kwadracik (bez niej), 8 pt od
    // brzegu celu. Tło liczy się w kadrze zakładki (`dominant`): bieżąca stoi na płytce, która
    // sięga brzegu celu. Pas w środku płytki (10 pt pod górą, 6 pt nad dołem celu); próg 6, bo cichy kafelek stoi
    // blisko tła. Cichy kafelek na płytce ma jej kolor — w demo bieżąca (`demo-willow`) czeka, więc kafelek jest
    // bursztynowy (klawisze osobno: `testShortcutKeysOnTabs`).
    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    let first = try XCTUnwrap(tabs.allElementsBoundByIndex.min { $0.frame.minX < $1.frame.minX }).frame
    let tabInk = try XCTUnwrap(
      shot.pixels.ink(in: Self.content(first), background: shot.pixels.dominant(in: first), threshold: 6),
      "kafelek albo kwadracik pierwszej zakładki")
    assertInset(tabInk.minX - column.minX, "pierwszy atrament pierwszej zakładki")

    // Bez znaku stanu przed etykietą. `demo-willow` czeka na zgodę: bursztyn stoi tylko w kafelku (albo
    // kwadraciku) 8 pt od brzegu celu — „!” za nim poszerzyłby bursztynowy pas o glif i odstęp.
    let waiting = element(app, "tab.demo-willow").frame
    let amber = try XCTUnwrap(
      shot.pixels.bounds(in: waiting, near: 0xFFB454) ?? shot.pixels.bounds(in: waiting, near: 0x9B5700),
      "bursztynowy kafelek albo kwadracik zakładki, która czeka")
    XCTAssertEqual(amber.minX - waiting.minX, 8, accuracy: 1.5, "bursztyn od brzegu celu")
    XCTAssertLessThanOrEqual(amber.maxX - waiting.minX, 8 + 20, "bez „!” za kafelkiem: \(amber)")

    // Linia gita: pierwszy jest tekst gałęzi albo pierścień kontekstu (demo-willow dostaje kontekst, gdy wcześniejsze
    // testy bramki wyślą do niej wiadomość). Tor pierścienia stoi w jasnym motywie blisko tła, a łuk małego procentu
    // zaczyna się na godzinie 12 — próg 48 brał łuk zamiast toru (23 pt zamiast 16), więc tu
    // atramentem jest każdy piksel inny niż tło.
    let git = element(app, "header.git")
    let gitInk = try XCTUnwrap(shot.pixels.ink(in: git.frame, background: shot.background, threshold: 6), "linia gita")
    assertInset(gitInk.minX - column.minX, "linia gita")
  }

  @MainActor
  func testSingleDividerUnderStatusLine() throws {
    let app = try launchLoggedIn()
    let shot = try openSession(app, "demo-willow", "naglowek-kreska")
    let status = element(app, "header.status").frame
    let statusRow = CGRect(x: shot.column.minX, y: status.minY, width: shot.column.width, height: status.height)
    XCTAssertTrue(shot.pixels.hasLine(atBottomOf: statusRow, background: shot.background), "kreska pod linią statusu")
    XCTAssertFalse(shot.pixels.hasLine(atBottomOf: shot.column, background: shot.background),
                   "bez kreski między paskiem zakładek a linią statusu")
  }

  /// Sesja bez linii statusu: kreska stoi pod paskiem zakładek, bo to on jest ostatnim rzędem nagłówka.
  @MainActor
  func testDividerUnderTabsWithoutStatusLine() throws {
    let app = try launchLoggedIn()
    DemoServer.reveal(app, "demo-map-view").tap()
    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    XCTAssertTrue(element(app, "tab.demo-map-view").waitForAppearance(timeout: 10), "projekt map-view otwarty")
    let before = tabs.count
    DemoServer.addFromPlus(app)
    XCTAssertTrue(wait(NSPredicate(format: "count == \(before + 1)"), tabs, timeout: 15), "nowa zakładka")
    let close = element(app, "header.close")
    XCTAssertTrue(close.waitForAppearance(timeout: 10))
    // Sprzątanie: własna sesja testu znika dwoma naciśnięciami „×" (sufit 6 paneli demo). Blok końca testu,
    // nie `defer`: przerwanie po porażce (`continueAfterFailure = false`) nie wykonuje `defer`.
    addTeardownBlock { @MainActor in
      guard close.exists else { return }
      close.tap()
      close.tap()
    }
    sleep(1)
    guard !element(app, "header.status").exists else {
      throw XCTSkip("świeża sesja demo ma już linię statusu — nie ma czego sprawdzić")
    }
    let shot = try capture(app, "naglowek-bez-linii-statusu")
    XCTAssertTrue(shot.pixels.hasLine(atBottomOf: shot.column, background: shot.background), "kreska pod paskiem zakładek")
  }

  /// Ikony paska („×", „Terminal w oknie"): ciche glify, cel dotyku ≥ 44 pt, skala średnia, najszerszy glif ≤ 18,5 pt
  /// (zmierzone: okno „Terminal w oknie" 17,5 × 13,5 pt; w skali małej ≤ 16 pt, systemowe bez stylu 17–25 pt).
  @MainActor
  func testQuietToolbarIcons() throws {
    continueAfterFailure = true
    let app = try launchLoggedIn()
    let shot = try openSession(app, "demo-willow", "naglowek-ikony")
    var widest: CGFloat = 0
    for id in ["header.close", "header.terminalPopup"] {
      let button = element(app, id)
      XCTAssertTrue(button.exists, "\(id) w nagłówku")
      guard button.exists else { continue }
      let frame = button.frame
      let ink = try XCTUnwrap(shot.pixels.ink(in: frame, background: shot.pixels.dominant(in: frame)), "glif \(id)")
      print("nagłówek: \(id) cel \(frame.size), glif \(ink.size)")
      widest = max(widest, ink.width, ink.height)
      XCTAssertLessThanOrEqual(max(ink.width, ink.height), 18.5, "\(id): glif \(ink.size) w celu \(frame.size)")
      XCTAssertGreaterThanOrEqual(min(frame.width, frame.height), 43.5, "\(id): cel dotyku \(frame.size)")
    }
    XCTAssertGreaterThan(widest, 16.5, "glify w skali średniej")
    // Jedna grupa: cele stoją co 2 pt (runda 3, `HeaderMetrics.iconSpacing`; osobne elementy paska stały co 12 pt).
    let frames = ["header.terminalPopup", "header.close"].map { element(app, $0).frame }
    for (left, right) in zip(frames, frames.dropFirst()) {
      XCTAssertEqual(right.minX - left.maxX, 2, accuracy: 0.5, "odstęp ikon nagłówka: \(left) → \(right)")
    }
    // Uzbrojone „×" mówi „Na pewno?" tekstem w tym samym miejscu paska (gaśnie samo po 5 s, nic nie zamyka).
    let close = element(app, "header.close")
    close.tap()
    XCTAssertTrue(wait(NSPredicate(format: "label BEGINSWITH 'Na pewno?'"), close, timeout: 3), "uzbrojone „×”")
    _ = try capture(app, "naglowek-uzbrojone-zamkniecie")
    XCTAssertLessThanOrEqual(close.frame.maxX, app.frame.maxX, "„Na pewno?” mieści się w pasku: \(close.frame)")
  }

  /// Kafelki skrótu Cmd na zakładkach (wybór użytkownika, w kolorze stanu): przy
  /// klawiaturze sprzętowej każda zakładka ma przed etykietą cyfrę na kafelku, a kafelek pierwszej stoi na wcięciu
  /// nagłówka; bieżąca stoi na płytce. Klawiaturę test udaje (`RAROG_UI_TEST_HW_KEYBOARD`), żeby wynik nie zależał
  /// od tego, czy symulator bramki ją zgłasza.
  @MainActor
  func testShortcutKeysOnTabs() throws {
    continueAfterFailure = true
    let app = try launchLoggedIn(environment: ["RAROG_UI_TEST_HW_KEYBOARD": "1"])
    let shot = try openSession(app, "demo-willow", "naglowek-klawisze")
    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    let frames = tabs.allElementsBoundByIndex.map(\.frame).sorted { $0.minX < $1.minX }
    XCTAssertGreaterThanOrEqual(frames.count, 2, "demo-willow ma siostrę")
    for (index, tab) in frames.enumerated() {
      // Tło zakładki: płytka bieżącej albo tło paska. Kafelek ma kolor stanu albo stoi blisko tła (próg 6); cyfrę
      // mierzy się wobec wnętrza kafelka: zaczyna się 5 pt za jego krawędzią.
      let key = try XCTUnwrap(
        shot.pixels.ink(in: Self.content(tab), background: shot.pixels.dominant(in: tab), threshold: 6),
        "zakładka \(index + 1): kafelek")
      let fill = shot.pixels.color(at: CGPoint(x: key.minX + 1.5, y: key.midY))
      // Środkowy pas kafelka (bez zaokrąglonych rogów, w których prześwituje tło) od drugiej kolumny pikseli.
      let inside = CGRect(x: key.minX + 1, y: key.minY + 4, width: 19, height: max(0, key.height - 8))
      let digit = try XCTUnwrap(shot.pixels.ink(in: inside, background: fill), "zakładka \(index + 1): cyfra")
      print(String(format: "nagłówek: kafelek %d od %.1f pt, cyfra %.1f pt dalej, wysokość %.1f pt, tło #%06X",
                   index + 1, key.minX - tab.minX, digit.minX - key.minX, key.height, fill))
      XCTAssertEqual(key.minX - tab.minX, 8, accuracy: 1.5, "zakładka \(index + 1): kafelek od brzegu celu")
      XCTAssertEqual(digit.minX - key.minX, 5, accuracy: 2, "zakładka \(index + 1): cyfra w kafelku")
      XCTAssertGreaterThan(key.height, 14, "zakładka \(index + 1): kafelek wyższy niż pismo etykiety")
    }
    let first = try XCTUnwrap(frames.first)
    let firstInk = try XCTUnwrap(
      shot.pixels.ink(in: Self.content(first), background: shot.pixels.dominant(in: first), threshold: 6),
      "kafelek pierwszej zakładki")
    assertInset(firstInk.minX - shot.column.minX, "kafelek pierwszej zakładki")
    // Bieżąca stoi na płytce: tło jej kadru odcina się od tła paska; siostry płytki nie mają. Płytka ma
    // kolor zaznaczonego wiersza listy (`surface2`): w jasnym #F7F7FA na #F2F2F7, czyli 5 na kanale (w ciemnym 18).
    let current = try XCTUnwrap(tabs.matching(NSPredicate(format: "selected == true")).allElementsBoundByIndex.first).frame
    XCTAssertGreaterThan(HeaderPixels.distance(shot.pixels.dominant(in: current), shot.background), 3, "płytka bieżącej")
    for tab in frames where tab != current {
      XCTAssertLessThanOrEqual(HeaderPixels.distance(shot.pixels.dominant(in: tab), shot.background), 2, "siostra bez płytki")
    }
  }

  /// Bez klawiatury sprzętowej (iPhone, iPad z samym ekranem) przed etykietą stoi kwadracik 10 pt w kolorze stanu
  /// — u każdej zakładki, także w ciszy, 8 pt od brzegu celu. Brak klawiatury test
  /// wymusza (`RAROG_UI_TEST_NO_HW_KEYBOARD`), bo symulator zgłasza ją raz tak, raz nie.
  @MainActor
  func testStateSquaresWithoutKeyboard() throws {
    continueAfterFailure = true
    let app = try launchLoggedIn(environment: ["RAROG_UI_TEST_NO_HW_KEYBOARD": "1"])
    let shot = try openSession(app, "demo-willow", "naglowek-kwadraciki")
    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    let frames = tabs.allElementsBoundByIndex.map(\.frame).sorted { $0.minX < $1.minX }
    XCTAssertGreaterThanOrEqual(frames.count, 2, "demo-willow ma siostrę")
    for (index, tab) in frames.enumerated() {
      // Pas przed etykietą: kwadracik stoi od 8 do 18 pt, etykieta zaczyna się 6 pt dalej.
      let content = Self.content(tab)
      let lead = CGRect(x: content.minX, y: content.minY, width: 18, height: content.height)
      let square = try XCTUnwrap(
        shot.pixels.ink(in: lead, background: shot.pixels.dominant(in: tab), threshold: 6),
        "zakładka \(index + 1): kwadracik")
      print(String(format: "nagłówek: kwadracik %d od %.1f pt, %.1f × %.1f pt",
                   index + 1, square.minX - tab.minX, square.width, square.height))
      XCTAssertEqual(square.minX - tab.minX, 8, accuracy: 1, "zakładka \(index + 1): kwadracik od brzegu celu")
      XCTAssertEqual(square.width, 10, accuracy: 1, "zakładka \(index + 1): bok kwadracika")
      XCTAssertEqual(square.height, 10, accuracy: 1, "zakładka \(index + 1): bok kwadracika")
    }
    // `demo-willow` czeka na zgodę: jej kwadracik jest bursztynowy.
    let waiting = element(app, "tab.demo-willow").frame
    XCTAssertNotNil(
      shot.pixels.bounds(in: waiting, near: 0xFFB454) ?? shot.pixels.bounds(in: waiting, near: 0x9B5700),
      "bursztynowy kwadracik zakładki, która czeka")
  }

  /// Pas treści zakładki wewnątrz płytki bieżącej (10 pt pod górą i 6 pt nad dołem celu, róg 8 pt):
  /// 14 pt pod górą celu, 10 pt nad dołem i 2 pt od boków — 4 pt w głąb płytki, bo w zaokrąglonych rogach przy
  /// brzegu celu prześwituje tło paska (zmierzone: przy 4 pt w głąb rogu płytka zaczyna się 1 pt od
  /// brzegu). Kafelek (~15 pt) stoi w środku pasa.
  private static func content(_ tab: CGRect) -> CGRect {
    CGRect(x: tab.minX + 2, y: tab.minY + 14, width: max(0, tab.width - 4), height: max(0, tab.height - 24))
  }

  // MARK: - Pomocnicze

  /// Zrzut ekranu sesji z paskiem zakładek: bitmapa, kolumna szczegółu i jej tło.
  private struct Shot {
    let pixels: HeaderPixels
    let column: CGRect
    let background: UInt32
  }

  /// Otwiera sesję z listy i robi zrzut (w wyniku testu pod nazwą `name`) bez klawiatury ekranowej.
  @MainActor
  private func openSession(_ app: XCUIApplication, _ id: String, _ name: String) throws -> Shot {
    DemoServer.reveal(app, id).tap()
    let bar = element(app, "tabs.bar")
    XCTAssertTrue(bar.waitForAppearance(timeout: 10) && element(app, "header.git").waitForAppearance(timeout: 10),
                  "pasek zakładek i linia gita")
    return try capture(app, name)
  }

  @MainActor
  private func capture(_ app: XCUIApplication, _ name: String) throws -> Shot {
    DemoServer.hideKeyboard(app)
    sleep(1)
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    let pixels = try XCTUnwrap(HeaderPixels(screenshot, pointsWidth: app.frame.width))
    let column = detailColumn(app, element(app, "tabs.bar"))
    // Tło paska tuż nad jego dolną krawędzią, przed pierwszą zakładką. Nie przy górnej krawędzi: ramka paska
    // w drzewie dostępności zaczyna się od góry ekranu (y = 0), pod paskiem nawigacji w innym kolorze.
    return Shot(pixels: pixels, column: column,
                background: pixels.color(at: CGPoint(x: column.minX + 3, y: column.maxY - 3)))
  }

  /// Pasek zakładek w poziomie przycięty do kolumny szczegółu. Na iPadzie (iOS 26+) pasek sięga pod listę
  /// (ramka od x = 0, treść wcięta obszarem bezpiecznym), więc lewą krawędzią kolumny jest prawa krawędź listy.
  /// W pionie ramka sięga od góry ekranu do dolnej krawędzi paska — liczy się tylko `maxY`.
  @MainActor
  private func detailColumn(_ app: XCUIApplication, _ bar: XCUIElement) -> CGRect {
    let list = element(app, "session.list")
    let left = list.exists && list.frame.maxX < bar.frame.midX ? max(bar.frame.minX, list.frame.maxX) : bar.frame.minX
    print(String(format: "nagłówek: kolumna od %.1f do %.1f pt", left, bar.frame.maxX))
    return CGRect(x: left, y: bar.frame.minY, width: bar.frame.maxX - left, height: bar.frame.height)
  }

  private func assertInset(_ value: CGFloat, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
    print(String(format: "nagłówek: %@ na %.1f pt", what, value))
    // Atrament litery stoi do ~1,5 pt za ramką tekstu (prawy odstęp znaku), nigdy przed nią.
    XCTAssertGreaterThanOrEqual(value, Self.inset - 0.5, "\(what): \(value) pt", file: file, line: line)
    XCTAssertLessThanOrEqual(value, Self.inset + 1.5, "\(what): \(value) pt", file: file, line: line)
  }

  @MainActor
  private func launchLoggedIn(environment: [String: String] = [:]) throws -> XCUIApplication {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port, environment: environment)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    return app
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func wait(_ predicate: NSPredicate, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: object)], timeout: timeout) == .completed
  }
}

/// Zrzut jako bitmapa sRGB: gdzie stoi atrament (piksele odróżnialne od tła) i czy w rzędzie stoi kreska.
struct HeaderPixels {
  private let width: Int
  private let height: Int
  private let scale: CGFloat
  private let bytes: [UInt8]

  @MainActor
  init?(_ screenshot: XCUIScreenshot, pointsWidth: CGFloat) {
    guard let image = screenshot.image.cgImage, pointsWidth > 0,
      let space = CGColorSpace(name: CGColorSpace.sRGB)
    else { return nil }
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
    guard drawn else { return nil }
    self.width = width
    self.height = height
    self.scale = CGFloat(width) / pointsWidth
    self.bytes = bytes
  }

  func color(at point: CGPoint) -> UInt32 {
    pixel(Int(point.x * scale), Int(point.y * scale))
  }

  /// Najczęstszy kolor kadru (tło pod glifem paska nawigacji).
  func dominant(in frame: CGRect) -> UInt32 {
    var counts: [UInt32: Int] = [:]
    let (x0, x1, y0, y1) = bounds(frame)
    for y in y0..<y1 { for x in x0..<x1 { counts[pixel(x, y), default: 0] += 1 } }
    return counts.max { $0.value < $1.value }?.key ?? 0
  }

  /// Ramka (w punktach) pikseli, które wyraźnie różnią się od tła; `nil` = w kadrze nic nie stoi.
  func ink(in frame: CGRect, background: UInt32, threshold: Int = 48) -> CGRect? {
    let (x0, x1, y0, y1) = bounds(frame)
    var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
    for y in y0..<y1 {
      for x in x0..<x1 where Self.distance(pixel(x, y), background) > threshold {
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
      }
    }
    guard maxX >= 0 else { return nil }
    return CGRect(x: CGFloat(minX) / scale, y: CGFloat(minY) / scale,
                  width: CGFloat(maxX - minX + 1) / scale, height: CGFloat(maxY - minY + 1) / scale)
  }

  /// Ramka (w punktach) pikseli kadru w kolorze bliskim podanemu (±40 na kanał); `nil` = takiego koloru nie ma.
  func bounds(in frame: CGRect, near color: UInt32) -> CGRect? {
    let (x0, x1, y0, y1) = bounds(frame)
    var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
    for y in y0..<y1 {
      for x in x0..<x1 where Self.distance(pixel(x, y), color) <= 40 {
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
      }
    }
    guard maxX >= 0 else { return nil }
    return CGRect(x: CGFloat(minX) / scale, y: CGFloat(minY) / scale,
                  width: CGFloat(maxX - minX + 1) / scale, height: CGFloat(maxY - minY + 1) / scale)
  }

  /// Liczba pikseli kadru w kolorze bliskim podanemu (±40 na kanał).
  func count(in frame: CGRect, near color: UInt32) -> Int {
    let (x0, x1, y0, y1) = bounds(frame)
    var n = 0
    for y in y0..<y1 { for x in x0..<x1 where Self.distance(pixel(x, y), color) <= 40 { n += 1 } }
    return n
  }

  /// Kreska przez całą szerokość w ostatnim punkcie kadru: ≥ 90 % próbek ostatniego rzędu odstaje od tła.
  func hasLine(atBottomOf frame: CGRect, background: UInt32) -> Bool {
    let y = min(height - 1, Int((frame.maxY * scale).rounded()) - 1)
    let (x0, x1, _, _) = bounds(frame.insetBy(dx: 24, dy: 0))
    let samples = stride(from: x0, to: x1, by: 3).map { pixel($0, y) }
    guard !samples.isEmpty else { return false }
    let off = samples.filter { Self.distance($0, background) > 6 }.count
    return Double(off) >= Double(samples.count) * 0.9
  }

  private func bounds(_ frame: CGRect) -> (Int, Int, Int, Int) {
    (max(0, Int((frame.minX * scale).rounded(.down))), min(width, Int((frame.maxX * scale).rounded(.up))),
     max(0, Int((frame.minY * scale).rounded(.down))), min(height, Int((frame.maxY * scale).rounded(.up))))
  }

  private func pixel(_ x: Int, _ y: Int) -> UInt32 {
    let i = (min(max(0, y), height - 1) * width + min(max(0, x), width - 1)) * 4
    return UInt32(bytes[i]) << 16 | UInt32(bytes[i + 1]) << 8 | UInt32(bytes[i + 2])
  }

  /// Największa różnica kanału.
  static func distance(_ a: UInt32, _ b: UInt32) -> Int {
    [16, 8, 0].map { shift in abs(Int((a >> UInt32(shift)) & 0xFF) - Int((b >> UInt32(shift)) & 0xFF)) }.max() ?? 0
  }
}
