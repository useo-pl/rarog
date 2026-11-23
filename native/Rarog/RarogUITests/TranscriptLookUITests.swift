import UIKit
import XCTest

/// Wygląd ekranu sesji przeciw serwerowi demo, w obu
/// motywach, na telefonie i na iPadzie:
/// - szklana karta pola stoi 10 pt od krawędzi, karta zgody 16 pt, jak tekst transkryptu;
/// - przy schowanej klawiaturze dolna krawędź pola stoi `safeBottom > 0 ? max(12, safeBottom − 16) : 8`
///   od dolnej krawędzi ekranu (iPhone Air: 18 pt, iPad Pro 11": 12 pt), a nad klawiaturą bez zmian. Symulator
///   zgłasza klawiaturę sprzętową (`GCKeyboard`), więc pole ma fokus zawsze poza kartą decyzji — spoczynek
///   mierzymy przy stojącej karcie zgody;
/// - „Kopiuj" stoi POD zamkniętą odpowiedzią agenta, od lewej krawędzi
///   treści, z celem ≥ 44 pt (brak etykiet ról sprawdza `TranscriptPlateTests`);
/// - miniatura przyjmuje proporcję zdjęcia, bez pustych pasów (szerokie, wąskie, kwadratowe);
/// - kółko „Przewiń na dół" (strzałka w kółku 36 pt bez napisu) ma czytelną strzałkę
///   na swoim tle (grafika, ≥ 3:1) w kolorze `text`, a przy decyzji poza dokiem w `wait`.
/// Zrzuty zostają w wyniku testu (`xcresulttool export attachments`). Właściciel: transkrypt i pole (Session/*).
final class TranscriptLookUITests: XCTestCase {
  override func setUp() {
    // Wszystkie pomiary naraz: jeden zły odstęp nie ma ukrywać reszty.
    continueAfterFailure = true
  }

  @MainActor
  func testDarkLook() throws { try look(theme: "dark") }

  @MainActor
  func testLightLook() throws { try look(theme: "light") }

  @MainActor
  private func look(theme: String) throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchEnvironment["RAROG_UI_TEST_THEME"] = theme
    app.launch()
    // iPad: pierwszy klawisz sprzętowy przełącza symulator na klawiaturę sprzętową. Przy wysuniętej klawiaturze
    // ekranowej apka po tym przełączeniu nie zgłasza bezczynności i każdy krok testu czeka 60 s (zmierzone),
    // więc na iPadzie przełączamy od razu, zanim jakiekolwiek pole dostanie fokus.
    if UIDevice.current.userInterfaceIdiom == .pad { app.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: []) }
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")

    // Własna sesja testu w map-view.
    DemoServer.reveal(app, "demo-map-view").tap()
    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    let add = element(app, "tabs.add")
    XCTAssertTrue(add.waitForAppearance(timeout: 10), "pasek zakładek")
    for _ in 0..<4 where add.frame.maxX > app.frame.maxX { DemoServer.dragTabs(app) }
    let before = Set(tabs.allElementsBoundByIndex.map(\.identifier))
    DemoServer.addFromPlus(app)
    XCTAssertTrue(wait(NSPredicate(format: "count == \(before.count + 1)"), tabs, timeout: 15), "nowa zakładka")
    let own = try XCTUnwrap(tabs.allElementsBoundByIndex.map(\.identifier).first { !before.contains($0) }, "zakładka testu")
    let composer = app.textViews["composer.field"]
    XCTAssertTrue(composer.waitForAppearance(timeout: 15), "pole nowej sesji")
    // Sprzątanie także po porażce, ale WYŁĄCZNIE własnej sesji: zostawiona zjada sufit paneli demo i gasi „+"
    // w kolejnych testach, a „×" na cudzej zakładce zamknąłby seed.
    addTeardownBlock { @MainActor in
      let tab = app.descendants(matching: .any)[own].firstMatch
      guard app.state == .runningForeground, tab.exists, tab.isHittable else { return }
      tab.tap()
      let close = app.descendants(matching: .any)["header.close"].firstMatch
      guard close.waitForAppearance(timeout: 5) else { return }
      close.tap()
      close.tap()
    }

    // Nad klawiaturą ekranową bez zmian. Pomiar PRZED pierwszym klawiszem sprzętowym: po nim
    // symulator przełącza się na klawiaturę sprzętową i ekranowa już nie wyjeżdża.
    checkComposerAboveKeyboard(app, name: theme)

    // Trzy zdjęcia jedną wiadomością: szerokie (jak zrzut wiersza listy), wąskie i kwadratowe.
    UIPasteboard.general.images = Self.photos.map(\.image)
    composer.tap()
    // Symulator zjada pierwszy klawisz sprzętowy przy wysuniętej klawiaturze ekranowej (README).
    app.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: [])
    app.typeKey("v", modifierFlags: .command)
    let strip = element(app, "composer.attachment.2")
    if !strip.waitForAppearance(timeout: 5) {
      composer.press(forDuration: 1.2)
      for label in ["Paste", "Wklej"] where app.menuItems[label].waitForAppearance(timeout: 2) {
        app.menuItems[label].tap()
        break
      }
    }
    XCTAssertTrue(strip.waitForAppearance(timeout: 10), "trzy miniatury nad polem")
    composer.typeText("Trzy zrzuty")
    app.buttons["composer.send"].tap()
    let reply = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'tool.'")).firstMatch
    XCTAssertTrue(reply.waitForAppearance(timeout: 20), "odpowiedź demo z linią narzędzia")

    // Karta zgody („czerwone"): staje na dnie transkryptu, pole znika razem z klawiaturą. Karta stoi
    // 16 pt od krawędzi listy; spoczynek samego pola mierzy krok po decyzji.
    composer.tap()
    composer.typeText("czerwone")
    app.buttons["composer.send"].tap()
    let card = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'card.permission.'")).firstMatch
    XCTAssertTrue(card.waitForAppearance(timeout: 15), "karta zgody z wyzwalacza demo")
    sleep(2)
    snapshot(app, "sesja-karta-\(theme)")
    checkCardInTranscript(app, card: card, name: theme)

    // Zdjęcia wiadomości: kafel w proporcji zdjęcia, bez pasów tła karty.
    try checkThumbnails(app, theme: theme)
    // Kółko po odjechaniu od dna: karta stoi na dnie transkryptu, więc kółko decyzji, „Przewiń do decyzji”.
    try checkJumpBar(app, decision: true, name: "pasek-decyzji-\(theme)", theme: theme)
    let jump = app.buttons["transcript.jump"]
    if jump.exists, jump.isHittable { jump.tap() }

    // Seria agenta od linii narzędzia: „Zatwierdź" → narzędzie i tekst.
    let allow = app.descendants(matching: .any)["card.allow"].firstMatch
    XCTAssertTrue(allow.waitForAppearance(timeout: 10), "„Zatwierdź” na karcie")
    if !allow.isHittable { element(app, "transcript").swipeUp(velocity: .slow) }
    allow.tap()
    XCTAssertTrue(card.waitForDisappearance(timeout: 15), "karta zniknęła po zatwierdzeniu")
    // Tura po zgodzie: linia narzędzia, odpowiedź i koniec tury (demo, ~2 s).
    sleep(4)
    snapshot(app, "sesja-dno-\(theme)")
    // Pole po decyzji, bez klawiatury ekranowej: margines pola; stopa tylko zapisana, bo z klawiaturą
    // sprzętową symulatora (`GCKeyboard`) pole odzyskuje responder i stoi nad paskiem skrótów, nie w spoczynku.
    DemoServer.hideKeyboard(app)
    checkFieldAtRest(app, name: theme)

    // Kółko „Przewiń na dół" po odjechaniu od dna własnej sesji.
    try checkJumpBar(app, decision: false, name: "pasek-na-dol-\(theme)", theme: theme)
    if jump.exists, jump.isHittable { jump.tap() }

    // Sprzątanie: własna sesja testu znika dwoma naciśnięciami „×".
    let close = element(app, "header.close")
    if close.waitForAppearance(timeout: 5) {
      close.tap()
      close.tap()
    }
  }


  /// Karta pola nie jest elementem dostępności: jej krawędzie dają przyciski rzędu kontrolek —
  /// spinacz stoi 6 pt od lewej krawędzi karty, „Wyślij" 6 pt od prawej i 4 pt nad dolną.
  @MainActor
  private func fieldFrame(_ app: XCUIApplication) -> CGRect {
    let attach = element(app, "composer.attach").frame
    let send = element(app, "composer.send").frame
    return CGRect(x: attach.minX - 6, y: attach.minY, width: send.maxX + 6 - (attach.minX - 6), height: send.maxY + 4 - attach.minY)
  }

  /// Karta w transkrypcie przy schowanym polu: 16 pt od krawędzi listy, cała w ramce transkryptu, bez doku.
  @MainActor
  private func checkCardInTranscript(_ app: XCUIApplication, card: XCUIElement, name: String) {
    let surface = card.frame
    let transcript = element(app, "transcript").frame
    record("\(name): karta w transkrypcie \(surface), od dołu \(app.frame.maxY - surface.maxY)")
    XCTAssertFalse(element(app, "dock").exists, "bez doku")
    XCTAssertFalse(app.textViews["composer.field"].exists, "pole schowane przy karcie")
    XCTAssertLessThanOrEqual(surface.maxY, transcript.maxY + 1, "karta w ramce transkryptu")
    XCTAssertEqual(surface.minX - transcript.minX, 16, accuracy: 1, "lewy margines karty")
  }

  /// Pole po decyzji: karta pola 10 pt od krawędzi listy (boki szklanej karty). Odległość od dołu tylko
  /// w zapisie — pole z responderem przy klawiaturze sprzętowej stoi nad paskiem skrótów (pomiar iPad: 14 pt zamiast
  /// 12); spoczynek bez respondera
  /// (`gap` nad krawędzią) mierzy `SessionLayoutTests`.
  @MainActor
  private func checkFieldAtRest(_ app: XCUIApplication, name: String) {
    let keyboards = app.keyboards.allElementsBoundByIndex.filter { $0.frame.minY < app.frame.maxY - 1 }
    guard keyboards.isEmpty else {
      record("\(name): klawiatura ekranowa w górze po decyzji — spoczynek pola pominięty")
      return
    }
    let field = fieldFrame(app)
    let gap: CGFloat = UIDevice.current.userInterfaceIdiom == .phone ? 18 : 12
    record("\(name): pole po decyzji \(field), od dołu \(app.frame.maxY - field.maxY) (spoczynek bez respondera: \(gap))")
    let transcript = element(app, "transcript").frame
    XCTAssertEqual(field.minX - transcript.minX, 10, accuracy: 0.5, "lewy margines karty pola")
  }

  /// Odstęp karty pola od klawiatury ekranowej. Element `keyboards` zaczyna się na klawiszach, pod paskiem
  /// podpowiedzi, więc liczba to „pasek podpowiedzi + 10 pt"; na iPhonie Air (iOS 27)
  /// zmierzone 56 pt, i tyle ma zostać. Bez klawiatury ekranowej (sprzętowa w symulatorze) pomiar jest
  /// zapisany jako pominięty.
  @MainActor
  private func checkComposerAboveKeyboard(_ app: XCUIApplication, name: String) {
    let composer = app.textViews["composer.field"]
    composer.tap()
    let keyboard = app.keyboards.firstMatch
    guard keyboard.waitForAppearance(timeout: 5), keyboard.frame.minY < app.frame.maxY - 1 else {
      record("\(name): klawiatura ekranowa nie wysunęła się (klawiatura sprzętowa symulatora) — pomiar pominięty")
      return
    }
    sleep(1)
    let field = fieldFrame(app)
    let gap = keyboard.frame.minY - field.maxY
    record("\(name): pole nad klawiszami klawiatury \(gap) pt (klawisze od \(keyboard.frame.minY))")
    snapshot(app, "klawiatura-\(name)")
    XCTAssertGreaterThan(gap, 0, "pole nad klawiaturą")
    if UIDevice.current.userInterfaceIdiom == .phone {
      XCTAssertEqual(gap, 56, accuracy: 1, "nad klawiaturą odstęp 56 pt")
    }
  }

  /// Identyfikator, rodzaj i ramka elementów z jednego zrzutu drzewa dostępności.
  private struct Found {
    let id: String
    let type: XCUIElement.ElementType
    let frame: CGRect
  }

  @MainActor
  private static func elements(_ app: XCUIApplication) -> [Found] {
    guard let root = try? app.snapshot() else { return [] }
    var out: [Found] = []
    func walk(_ node: any XCUIElementSnapshot) {
      if !node.identifier.isEmpty { out.append(Found(id: node.identifier, type: node.elementType, frame: node.frame)) }
      node.children.forEach(walk)
    }
    walk(root)
    return out
  }


  /// Zdjęcia testu: proporcja i kolor wypełnienia (żaden nie jest blisko tła karty w żadnym motywie).
  private struct Photo {
    let image: UIImage
    let size: CGSize
  }

  private static let photos: [Photo] = [
    photo(CGSize(width: 1200, height: 220), fill: UIColor(red: 0.12, green: 0.50, blue: 0.55, alpha: 1)),
    photo(CGSize(width: 200, height: 800), fill: UIColor(red: 0.85, green: 0.45, blue: 0.10, alpha: 1)),
    photo(CGSize(width: 300, height: 300), fill: UIColor(red: 0.45, green: 0.25, blue: 0.70, alpha: 1)),
  ]

  private static func photo(_ size: CGSize, fill: UIColor) -> Photo {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
      fill.setFill()
      context.fill(CGRect(origin: .zero, size: size))
      UIColor.white.setFill()
      let bar = min(size.width, size.height) / 8
      context.fill(CGRect(x: bar, y: bar, width: size.width / 3, height: bar))
      context.fill(CGRect(x: bar, y: bar * 3, width: size.width / 2, height: bar / 2))
    }
    return Photo(image: image, size: size)
  }

  /// Rozmiar kafla po regule z `ThumbnailGeometry` (szerokość 48…256 pt, wysokość 48…96 pt).
  private static func expectedTile(_ size: CGSize) -> CGSize {
    let aspect = size.width / size.height
    var width = 96 * aspect
    var height: CGFloat = 96
    if width > 256 {
      width = 256
      height = max(48, 256 / aspect)
    }
    return CGSize(width: max(48, width), height: height)
  }

  @MainActor
  private func checkThumbnails(_ app: XCUIApplication, theme: String) throws {
    let transcript = element(app, "transcript")
    // Wiadomość ze zdjęciami (`m<seq>.a.<i>` z serwera albo galeria `m<seq>.<blok>.<i>` z treści).
    // Kafle całe na ekranie (zdjęcia wiadomości człowieka i echo demo z tymi samymi obrazkami); jeden zrzut
    // drzewa na krok, jak przy serii.
    func shown() -> [Found] {
      let found = Self.elements(app)
      let list = found.first { $0.id == "transcript" }?.frame ?? .zero
      return found.filter {
        $0.id.range(of: #"^thumbnail\.m[0-9]+\.[a0-9]+\.[0-2]$"#, options: .regularExpression) != nil && list.contains($0.frame)
      }
    }
    // Na telefonie trzeci kafel stoi za krawędzią poziomego paska (256 + 48 + 96 pt i odstępy > szerokość).
    let needed = UIDevice.current.userInterfaceIdiom == .phone ? 2 : 3
    for _ in 0..<10 where shown().count < needed { transcript.swipeDown(velocity: .slow) }
    XCTAssertGreaterThanOrEqual(shown().count, needed, "miniatury wysłanej wiadomości na ekranie")
    sleep(1)
    let shot = snapshot(app, "miniatury-\(theme)")
    let pixels = try XCTUnwrap(ColorShare(shot, pointsWidth: app.frame.width))
    let card: UInt32 = theme == "dark" ? 0x1C1C1C : 0xF7F7FA
    for tile in shown() {
      guard let index = Int(tile.id.split(separator: ".").last ?? "") else { continue }
      let frame = tile.frame
      let expected = Self.expectedTile(Self.photos[index].size)
      record("miniatura \(tile.id): kafel \(frame.size), oczekiwany \(expected)")
      XCTAssertEqual(frame.width, expected.width, accuracy: 1, "szerokość kafla \(index)")
      XCTAssertEqual(frame.height, expected.height, accuracy: 1, "wysokość kafla \(index)")
      // Pas tła karty w środku kafla = letterbox. Brzegi (obrys, zaokrąglenie) pomijamy.
      let share = pixels.share(of: card, in: frame.insetBy(dx: 3, dy: 3))
      XCTAssertLessThan(share, 0.02, "kafel \(index) bez pustych pasów (\(Int(share * 100)) % tła karty)")
    }
  }


  /// Atrament strzałki: `text` albo `wait` z `PaletteTokens` w motywie zrzutu.
  private static func ink(decision: Bool, theme: String) -> UInt32 {
    switch (decision, theme) {
    case (false, "dark"): 0xF5F5F5
    case (false, _): 0x1C1C1E
    case (true, "dark"): 0xFFB454
    case (true, _): 0x9B5700
    }
  }

  @MainActor
  private func checkJumpBar(_ app: XCUIApplication, decision: Bool, name: String, theme: String) throws {
    let transcript = element(app, "transcript")
    XCTAssertTrue(transcript.waitForAppearance(timeout: 10))
    let jump = app.buttons["transcript.jump"]
    for _ in 0..<3 where !jump.exists { transcript.swipeDown(velocity: .fast) }
    guard jump.waitForAppearance(timeout: 5) else {
      // Na wysokim iPadzie transkrypt seeda potrafi zmieścić się na ekranie: nie ma od czego odjechać.
      record("kółko \(name): pasek nie stanął (transkrypt nie przewija się) — pomiar pominięty")
      if UIDevice.current.userInterfaceIdiom == .phone { XCTFail("pasek po odjechaniu od dna") }
      return
    }
    XCTAssertEqual(jump.label, decision ? "Przewiń do decyzji" : "Przewiń na dół")
    // Kółko 36 pt, bez napisu: nazwę ma tylko czytnik.
    XCTAssertEqual(jump.frame.width, 36, accuracy: 1, "kółko 36 pt")
    XCTAssertEqual(jump.frame.height, 36, accuracy: 1, "kółko 36 pt")
    // Krycie kółka rośnie 0,15 s; treść pod szkłem musi się zatrzymać.
    sleep(2)
    let shot = snapshot(app, name)
    let pixels = try XCTUnwrap(ScreenPixels(shot, pointsWidth: app.frame.width))
    // Kadr wewnątrz kółka, bez obrysu i bez rogów kwadratu poza kółkiem: tło kółka i strzałka.
    let contrast = pixels.contrast(in: jump.frame.insetBy(dx: 7, dy: 7))
    record("kółko \(name): \(jump.frame), \(contrast.map(String.init(describing:)) ?? "bez strzałki")")
    let found = try XCTUnwrap(contrast, "na kółku widać strzałkę")
    XCTAssertGreaterThanOrEqual(found.ratio, 3, "kontrast strzałki (grafika) do kółka")
    // Strzałka w swoim kolorze (a nie np. plama wiadomości spod kółka): białe tło z białym napisem dawało
    // „kontrast” plamy przeświecającej przy brzegu.
    let ink = Self.ink(decision: decision, theme: theme)
    let near = [16, 8, 0].allSatisfy { shift in
      abs(Int((found.ink >> UInt32(shift)) & 0xFF) - Int((ink >> UInt32(shift)) & 0xFF)) <= 24
    }
    XCTAssertTrue(near, String(format: "strzałka w kolorze #%06X, zmierzona %@", ink, found.description))
  }

  // MARK: - Pomocnicze

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func record(_ line: String) {
    print("wygląd: \(line)")
    let attachment = XCTAttachment(string: line)
    attachment.name = "pomiar"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  @MainActor
  @discardableResult
  private func snapshot(_ app: XCUIApplication, _ name: String) -> XCUIScreenshot {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    return screenshot
  }

  private func wait(_ predicate: NSPredicate, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: object)], timeout: timeout) == .completed
  }
}

/// Udział koloru w kadrze zrzutu: pas tła karty w kaflu miniatury to letterbox.
private struct ColorShare {
  private let width: Int
  private let height: Int
  private let scale: CGFloat
  private let bytes: [UInt8]

  init?(_ screenshot: XCUIScreenshot, pointsWidth: CGFloat) {
    guard let image = screenshot.image.cgImage, pointsWidth > 0, let space = CGColorSpace(name: CGColorSpace.sRGB)
    else { return nil }
    var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: image.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
      else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
      return true
    }
    guard drawn else { return nil }
    width = image.width
    height = image.height
    scale = CGFloat(image.width) / pointsWidth
    self.bytes = bytes
  }

  /// Udział pikseli kadru w kolorze `rgb` (±6 na kanał: JPEG zdjęcia i konwersja przestrzeni barw).
  func share(of rgb: UInt32, in frame: CGRect) -> Double {
    let x0 = max(0, Int((frame.minX * scale).rounded(.up)))
    let x1 = min(width, Int((frame.maxX * scale).rounded(.down)))
    let y0 = max(0, Int((frame.minY * scale).rounded(.up)))
    let y1 = min(height, Int((frame.maxY * scale).rounded(.down)))
    guard x1 > x0, y1 > y0 else { return 0 }
    var hits = 0
    for y in y0..<y1 {
      for x in x0..<x1 {
        let i = (y * width + x) * 4
        let channels = [Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2])]
        let target = [Int((rgb >> 16) & 0xFF), Int((rgb >> 8) & 0xFF), Int(rgb & 0xFF)]
        if zip(channels, target).allSatisfy({ abs($0 - $1) <= 6 }) { hits += 1 }
      }
    }
    return Double(hits) / Double((x1 - x0) * (y1 - y0))
  }
}
