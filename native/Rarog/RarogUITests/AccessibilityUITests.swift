import UIKit
import XCTest

/// Dostępność całej apki przeciw serwerowi demo: audyt Accessibility Inspectora
/// (`performAccessibilityAudit`) na głównych ekranach — logowanie, lista, sesja, sesja z kartą zgody,
/// arkusz modelu, formularz nowej sesji, panel „w tle" z przebiegiem workflow — i te same ekrany
/// w największym rozmiarze pisma (`accessibilityExtraExtraExtraLarge`) z audytem obciętego tekstu. Zrzuty
/// i pełny raport audytu każdego ekranu zostają w wyniku testu (`xcresulttool export attachments`) do oceny
/// wzrokowej.
///
/// Kartę zgody test stawia we WŁASNEJ sesji (wyzwalacz demo „czerwone" = karta ryzykowna; karty
/// seedów należą do `FlowUITests`) w projekcie data-loader i na końcu ją zamyka.
///
/// Zgłoszenie oblewa test, chyba że pasuje do jawnego wyjątku (`exception`). Kontrast pikseli też
/// oblewa test poza wyciszonym bezczynnym wierszem. Brak identyfikatora sam nie uzasadnia
/// pominięcia obcięcia ani Dynamic Type; zgłoszenie, w którym audyt nie wskazał ŻADNEGO elementu, idzie
/// do raportu, a rozstrzyga je przegląd zrzutów AX5. Progi tokenów dodatkowo pilnuje `PaletteContrastTests`.
final class AccessibilityUITests: AccessibilityAudit {
  @MainActor
  func testAuditMainScreens() throws {
    try walkMainScreens(largestText: false)
  }

  @MainActor
  func testLargestTextSize() throws {
    try walkMainScreens(largestText: true)
  }

  /// Panel „w tle" z przebiegiem workflow osobno od przejścia głównych ekranów: własny scenariusz demo,
  /// sprzątany resetem kontroli.
  @MainActor
  func testAuditWorkflowPanel() async throws {
    try await auditWorkflowPanel(largestText: false)
  }

  @MainActor
  func testAuditWorkflowPanelLargestText() async throws {
    try await auditWorkflowPanel(largestText: true)
  }

  /// Pomiar kontrastu nie daje się zagłuszyć: słaby tekst obok czarnej dekoracji w tym samym kadrze oblewa.
  func testPixelContrastSeesWeakTextNextToStrongDecoration() throws {
    let contrast = try XCTUnwrap(ScreenPixels.contrast(counts: [0xFFFFFF: 9000, 0x999999: 900, 0x000000: 100]))
    XCTAssertEqual(contrast.ink, 0x999999)
    XCTAssertLessThan(contrast.ratio, 4.5)
    let single = try XCTUnwrap(ScreenPixels.contrast(counts: [0xFFFFFF: 9000, 0x51515A: 900, 0xA0A0A0: 20]))
    XCTAssertEqual(single.ink, 0x51515A, "rzadki odcień antyaliasingu nie jest atramentem")
    // Małe pismo: odcienie krawędzi przekraczają 1/10 rdzenia (zmierzone na „27%”: #C8C8CB, #ABABAF).
    let small = try XCTUnwrap(ScreenPixels.contrast(
      counts: [0xFFFFFF: 400, 0x51515A: 120, 0xC8C8CB: 30, 0xABABAF: 25, 0x8A8A90: 20]))
    XCTAssertEqual(small.ink, 0x51515A, "antyaliasing małego pisma nie jest atramentem")
    XCTAssertGreaterThan(small.ratio, 7)
    // Dwa teksty o porównywalnej masie: liczy się słabszy.
    let mixed = try XCTUnwrap(ScreenPixels.contrast(counts: [0xFFFFFF: 9000, 0x1C1C1E: 600, 0xA2A3A8: 400]))
    XCTAssertEqual(mixed.ink, 0xA2A3A8)
  }
}

/// The walk through the main screens and the audit of one screen, shared by `AccessibilityUITests` and
/// `TextScaleUITests` (the app's own text size set over the system's). No tests of its own, so XCTest runs nothing
/// twice.
class AccessibilityAudit: XCTestCase {
  /// Zgłoszenia audytu ze wszystkich ekranów przebiegu; oblewają test na końcu, po sprzątaniu.
  private var findings: [String] = []
  /// Audit types left out of this walk (see `walkMainScreens`, `appTextSize`).
  private var skippedAuditTypes: XCUIAccessibilityAuditType = []

  override func setUp() {
    continueAfterFailure = false
    findings = []
  }

  // MARK: - Przejście przez ekrany

  /// - Parameters:
  ///   - systemSize: the system's text size for the app (`-UIPreferredContentSizeCategoryName`), e.g.
  ///     `UICTContentSizeCategoryS`; `largestText` sets the largest accessibility size instead.
  ///   - appTextSize: the app's own text size stored at launch (a `TextSizeCategory` raw value), which the app puts
  ///     on its scene over the system's size.
  ///   - label: the suffix of the screenshot names.
  @MainActor
  func walkMainScreens(
    largestText: Bool, systemSize: String? = nil, appTextSize: String? = nil, label: String = ""
  ) throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    // Audyt idzie Z klawiszami skrótu na zakładkach. Bez tego ich obecność zależy od tego, czy
    // symulator zgłosi klawiaturę sprzętową (w jednym przebiegu są, w następnym nie), a z nią wynik.
    app.launchEnvironment["RAROG_UI_TEST_HW_KEYBOARD"] = "1"
    if largestText {
      app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    } else if let systemSize {
      app.launchArguments += ["-UIPreferredContentSizeCategoryName", systemSize]
    }
    // The Dynamic Type check changes the SYSTEM text size and expects the text to follow it. The app's own text size
    // holds the scene on its step on purpose, so under it the check flags every text as "partially unsupported";
    // clipped text, contrast and the other checks still run at the app's size.
    skippedAuditTypes = appTextSize == nil ? [] : .dynamicType
    if let appTextSize { app.launchEnvironment["RAROG_UI_TEST_TEXT_SIZE"] = appTextSize }
    app.launch()
    let suffix = largestText ? "-ax5" : label

    XCTAssertTrue(
      app.descendants(matching: .any)["pair.start"].firstMatch.waitForAppearance(timeout: 15), "ekran parowania")
    try audit(app, "parowanie\(suffix)", largestText: largestText)

    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    sleep(1)
    try audit(app, "lista\(suffix)", largestText: largestText)

    // Sesja z kartą zgody: własna zakładka w data-loader, wyzwalacz „czerwone".
    openProject(app, "data-loader")
    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    let add = element(app, "tabs.add")
    XCTAssertTrue(add.waitForAppearance(timeout: 10), "pasek zakładek")
    // W piśmie dostępności „+" stoi za zakładkami, poza ekranem — pasek przewija się w poziomie.
    for _ in 0..<4 where add.frame.maxX > app.frame.maxX { DemoServer.dragTabs(app) }
    let before = tabs.count
    DemoServer.addFromPlus(app)
    XCTAssertTrue(wait(NSPredicate(format: "count == \(before + 1)"), tabs, timeout: 15), "nowa zakładka")
    let composer = app.textViews["composer.field"]
    XCTAssertTrue(composer.waitForAppearance(timeout: 15), "pole nowej sesji")
    sleep(1)
    try audit(app, "sesja\(suffix)", largestText: largestText)
    composer.tap()
    composer.typeText("czerwone")
    // The field moves after typing (the keyboard bar comes in); a tap during the move missed the button.
    let send = app.buttons["composer.send"]
    DemoServer.waitUntilStill(send)
    send.tap()
    let card = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'card.permission.'")).firstMatch
    XCTAssertTrue(card.waitForAppearance(timeout: 15), "karta zgody z wyzwalacza demo")
    sleep(1)
    try audit(app, "sesja-karta\(suffix)", largestText: largestText)
    let deny = app.buttons["card.deny"]
    if !deny.isHittable { element(app, "transcript").swipeUp(velocity: .slow) }
    deny.tap()
    XCTAssertTrue(card.waitForDisappearance(timeout: 15), "karta zniknęła po odrzuceniu")

    // Arkusz modelu z pigułki pod polem (wariant zablokowany też się liczy — audyt widoku).
    let pill = element(app, "composer.model")
    XCTAssertTrue(pill.waitForAppearance(timeout: 15), "pigułka modelu")
    pill.tap()
    XCTAssertTrue(element(app, "model.sheet").waitForAppearance(timeout: 10), "arkusz modelu")
    sleep(1)
    try audit(app, "arkusz-modelu\(suffix)", largestText: largestText, modal: true)
    // Popover na iPadzie zamyka stuknięcie obok (wariant zablokowany ma własne „Zamknij").
    if element(app, "model.dismiss").exists {
      element(app, "model.dismiss").tap()
    } else {
      // Stuknięcie w transkrypt OBOK popovera (w największym piśmie popover zakrywa środek).
      let sheet = element(app, "model.sheet").frame
      let transcript = element(app, "transcript").frame
      let x = sheet.maxX + 20 < transcript.maxX ? (sheet.maxX + transcript.maxX) / 2 : (transcript.minX + sheet.minX) / 2
      app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: transcript.minY + 30)).tap()
    }
    XCTAssertTrue(element(app, "model.sheet").waitForDisappearance(timeout: 10), "arkusz modelu zamknięty")

    // Sprzątanie: własna sesja testu znika dwoma naciśnięciami „×".
    let close = element(app, "header.close")
    XCTAssertTrue(close.waitForAppearance(timeout: 5))
    close.tap()
    close.tap()

    // Formularz nowej sesji z paska listy. Wejście w projekt na pionowym iPadzie zwija listę — Cmd+B
    // ją rozwija (jałowa strzałka przed skrótem: symulator zjada pierwszy klawisz sprzętowy). iPhone (lista jako
    // stos) po zamknięciu sesji staje na pozostałej zakładce projektu, a Cmd+B nic tam nie daje — do listy wraca
    // systemowy „wstecz” (padało tak samo na `main`).
    let newSession = element(app, "list.newSession")
    if !newSession.waitForAppearance(timeout: 3) {
      if UIDevice.current.userInterfaceIdiom == .phone {
        DemoServer.hideKeyboard(app)
        let back = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForAppearance(timeout: 5), "przycisk „wstecz” do listy")
        back.tap()
      } else {
        app.typeKey(XCUIKeyboardKey.leftArrow, modifierFlags: [])
        app.typeKey("b", modifierFlags: .command)
      }
    }
    XCTAssertTrue(newSession.waitForAppearance(timeout: 10), "„Nowa sesja” na pasku listy")
    newSession.tap()
    XCTAssertTrue(element(app, "newSession.sheet").waitForAppearance(timeout: 10), "arkusz „Nowa sesja”")
    sleep(1)
    try audit(app, "nowa-sesja\(suffix)", largestText: largestText, modal: true)
    element(app, "newSession.cancel").tap()
    XCTAssertTrue(element(app, "newSession.sheet").waitForDisappearance(timeout: 10), "arkusz zamknięty")
    // Zgłoszenia oblewają test dopiero tu: przejście kończy się sprzątaniem własnej sesji (demo ma sufit
    // 6 paneli — sesja zostawiona przez przerwany audyt wygaszała „+" w kolejnych testach przebiegu).
    XCTAssertTrue(findings.isEmpty, "audyt: \(findings.count) zgłoszeń\n" + findings.joined(separator: "\n"))
  }

  /// Sterowany scenariusz demo `workflow` (sesja bezczynna z przebiegiem w tle); reset kontroli zamyka
  /// jego sesję, a z nią pigułkę i panel — nic nie zostaje dla kolejnych testów.
  @MainActor
  func auditWorkflowPanel(largestText: Bool) async throws {
    // Zmierzone: na iPhonie (arkusz) audyt zgłaszał Dynamic Type i obcięcie z ramkami układu ze
    // swojego przebiegu zmiany pisma — „review:10" na y = 743 pt, na zrzucie z tej chwili na ≈ 410 pt — a ten
    // sam typ zgłoszeń ma arkusz modelu w przejściu głównych ekranów. Wiersze panelu są te same co w popoverze
    // iPada. The `WorkflowPanelUITests` AX5 screenshots (taken by hand with `RAROG_SCREENSHOT_DIR`) show the iPad
    // popover only; no screenshot shows the iPhone sheet at that size.
    guard UIDevice.current.userInterfaceIdiom == .pad else {
      throw XCTSkip("audyt panelu „w tle” tylko w popoverze iPada: na iPhonie ramki z przebiegu zmiany pisma")
    }
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    let workflow = try await control.create("workflow", label: "M1 audyt workflow")
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    if largestText {
      app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    }
    app.launch()
    DemoServer.pair(app)
    XCTAssertTrue(element(app, "session.list").waitForAppearance(timeout: 15), "lista sesji")
    let row = DemoServer.reveal(app, workflow)
    XCTAssertTrue(row.exists, "sesja z przebiegiem w tle na liście")
    row.tap()
    let pill = element(app, "header.background")
    XCTAssertTrue(pill.waitForAppearance(timeout: 15), "pigułka „w tle”")
    _ = hideKeyboard(app)
    pill.tap()
    let panel = element(app, "header.background.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 10), "panel „w tle”")
    sleep(1)
    try audit(app, "panel-w-tle\(largestText ? "-ax5" : "")", largestText: largestText, modal: true, clip: panel.frame)
    try await control.reset()
    XCTAssertTrue(pill.waitForDisappearance(timeout: 15), "reset kontroli zdjął sesję przebiegu")
    XCTAssertTrue(findings.isEmpty, "audyt: \(findings.count) zgłoszeń\n" + findings.joined(separator: "\n"))
  }

  // MARK: - Audyt

  /// Audyt jednego ekranu: zrzut i raport do wyniku; zgłoszenia spoza wyjątków trafiają do `findings`.
  /// W największym piśmie liczy się obcięty tekst i Dynamic Type; w zwykłym — cały zestaw.
  /// - Parameter clip: widoczna część przewijanego panelu nad ekranem (popover „w tle"): wiersz leniwej listy
  ///   przewinięty poza nią wciąż stoi w drzewie dostępności, a piksele jego ramki należą do tego, co pod spodem.
  @MainActor
  private func audit(
    _ app: XCUIApplication, _ screen: String, largestText: Bool, modal: Bool = false, clip: CGRect? = nil
  ) throws {
    // Klawiatura ekranowa to nie ekran apki (jej klawisze audyt liczy jako tekst bez opisu).
    let keyboard = hideKeyboard(app)
    snapshot(app, screen)
    let summaries = summarizingFrames(app)
    let rows = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'session.' AND identifier != 'session.list'"))
      .allElementsBoundByIndex.map { $0.frame.insetBy(dx: -1, dy: -1) }
    // Tytuł nagłówka sesji obok przycisku listy (iPad, runda 4). Audyt wskazuje jego dwa teksty osobno i bez
    // identyfikatora (element `header.title` łączy je dla czytnika), więc rozpoznaje je ramka sprzed audytu.
    let headerTitle = app.descendants(matching: .any).matching(identifier: "header.title").firstMatch
    let titleFrame = headerTitle.exists ? headerTitle.frame.insetBy(dx: -1, dy: -1) : nil
    // Formularz „Nowa sesja”: etykietę przełącznika ultracode audyt wskazuje osobno i bez identyfikatora,
    // więc rozpoznaje ją ramka przełącznika sprzed audytu; stopkę — ramki jej elementów (``formFooter``).
    let ultracodeToggle = app.switches["newSession.ultracode"]
    let ultracodeFrame = ultracodeToggle.exists ? ultracodeToggle.frame.insetBy(dx: -1, dy: -1) : nil
    let footer = Self.formFooter(app)
    // Rząd zakładek paska projektu: przy klawiaturze sprzętowej każda zakładka niesie klawisz z cyfrą skrótu Cmd.
    // Klawisz jest ukryty dla czytnika, więc nie ma go w drzewie — rozpoznaje go położenie w rzędzie.
    // Rząd, nie ramka jednej zakładki: pasek przewija się w poziomie (nowa zakładka dojeżdża na środek) i ramki
    // sprzed audytu rozjeżdżały się z audytem. Lewa krawędź to koniec listy: jej wiersze stoją na tej samej
    // wysokości i też mają jednocyfrowe liczniki.
    let tabFrames = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
      .allElementsBoundByIndex.map(\.frame)
    let list = app.descendants(matching: .any).matching(identifier: "session.list").firstMatch
    var tabRow: CGRect?
    if let top = tabFrames.map(\.minY).min(), let bottom = tabFrames.map(\.maxY).max() {
      let left = list.exists ? list.frame.maxX : app.frame.minX
      tabRow = CGRect(x: left, y: top - 1, width: max(0, app.frame.maxX - left), height: bottom - top + 2)
    }
    let types = (largestText ? [.textClipped, .dynamicType] : XCUIAccessibilityAuditType.all)
      .subtracting(skippedAuditTypes)
    var verdicts: [(issue: XCUIAccessibilityAuditIssue, element: XCUIElement?, line: [String], facts: Facts)] = []
    // Obsługa zgłoszenia musi być szybka: wiersze listy odświeża zegar co sekundę, a element zgłoszenia
    // odnajduje się tylko chwilę po audycie (wolny zrzut w obsłudze dawał „brak elementu"). Ramkę i etykietę
    // bierzemy od razu, werdykt zapada po audycie.
    try app.performAccessibilityAudit(for: types) { issue in
      let element = issue.element
      let id = element?.identifier ?? ""
      var facts = Facts(modal: modal, keyboard: keyboard, largestText: largestText, hasElement: element != nil)
      facts.phoneModelSheet = UIDevice.current.userInterfaceIdiom == .phone && screen.hasPrefix("arkusz-modelu")
      let frame = element?.frame
      if let frame {
        facts.inSummary = summaries.contains { $0.contains(frame) }
        facts.inRow = rows.contains { $0.contains(frame) }
        facts.inHeaderTitle = titleFrame?.contains(frame) ?? false
        facts.inUltracodeToggle = ultracodeFrame?.contains(frame) ?? false
        facts.underFooter = footer.map { footer in
          frame.midY > footer.top && !footer.frames.contains { $0.contains(frame) }
        } ?? false
        // Po środku ramki, nie po całej: w największym piśmie ramka cyfry wystaje 0,5 pt pod zakładkę.
        facts.inTab = tabRow?.contains(CGPoint(x: frame.midX, y: frame.midY)) ?? false
        facts.shortcutDigit = facts.inTab && Self.isShortcutDigit(element?.label)
        facts.frame = frame
        facts.outsideClip = clip.map { !$0.insetBy(dx: -1, dy: -1).contains(frame) } ?? false
      }
      let line = [
        screen, Self.name(issue.auditType), id.isEmpty ? "-" : id, element?.label ?? "-", issue.compactDescription,
        frame.map { "\($0)" } ?? "-",
      ]
      verdicts.append((issue, element, line, facts))
      return true
    }
    // Werdykt kontrastu dają piksele kadru elementu na zrzucie zaraz po audycie: ramki pochodzą z tej samej
    // chwili, a audyt przestawia pismo i potrafi przesunąć przewijane sekcje (zmierzone: 20 pt).
    let pixels = verdicts.contains { $0.issue.auditType == .contrast }
      ? ScreenPixels(app.screenshot(), pointsWidth: app.frame.width) : nil
    var report: [String] = []
    var failures: [String] = []
    for var verdict in verdicts {
      if verdict.issue.auditType == .contrast, let frame = verdict.facts.frame {
        verdict.facts.contrast = pixels?.contrast(in: verdict.facts.inTab ? Self.tabText(frame) : frame)
        if verdict.facts.contrast == nil, let element = verdict.element {
          verdict.facts.visible = element.exists && element.isHittable
        }
      }
      let line = (verdict.line + [verdict.facts.contrast.map { "piksele \($0)" } ?? "-"]).joined(separator: " | ")
      if let reason = Self.exception(verdict.issue, identifier: verdict.line[2], verdict.facts) {
        report.append("wyjątek (\(reason)): \(line)")
        continue
      }
      print("AUDYT BŁĄD: \(line) | kontenery ze zdaniem: \(summaries)")
      report.append("BŁĄD: \(line)")
      // Każde zgłoszenie oblewa test niżej, RAZEM z pozostałymi z tego ekranu: `false` z obsługi przerywał
      // audyt na pierwszym, a kolejność zgłoszeń zmienia się między przebiegami (raz „7D", raz „łączę…").
      failures.append(line)
    }
    let attachment = XCTAttachment(string: report.joined(separator: "\n"))
    attachment.name = "audyt-\(screen)"
    attachment.lifetime = .keepAlways
    add(attachment)
    findings += failures
  }

  /// Fakty o zgłoszeniu zebrane przed werdyktem: ekran, położenie elementu i pomiar jego pikseli.
  private struct Facts {
    var modal: Bool
    var keyboard: Bool
    var largestText: Bool
    /// Audyt wskazał element (bez niego nie ma ramki ani identyfikatora).
    var hasElement: Bool
    /// Element leży w kontenerze, który daje czytnikowi zdanie zamiast znaków.
    var inSummary = false
    /// Element leży w wierszu listy sesji.
    var inRow = false
    /// Element leży w tytule nagłówka sesji (`header.title`, iPad): nazwa projektu albo ścieżka.
    var inHeaderTitle = false
    /// Element leży w rzędzie zakładek paska projektu (`tab.<id>`).
    var inTab = false
    /// Element to cyfra klawisza skrótu Cmd na zakładce.
    var shortcutDigit = false
    /// Ramka elementu w chwili zgłoszenia; `nil` = audyt nie wskazał elementu.
    var frame: CGRect?
    /// Kontrast z pikseli kadru elementu na zrzucie zaraz po audycie; `nil` = w kadrze nie ma tekstu.
    var contrast: ScreenPixels.Contrast?
    /// Tekst elementu widać: jest w kadrze albo element przyjmuje dotyk (nie jest ucięty ani zasłonięty).
    var visible = true
    /// Element leży poza widoczną częścią przewijanego panelu (`clip`), choć wciąż stoi w drzewie.
    var outsideClip = false
    /// Element leży w przełączniku ultracode formularza „Nowa sesja” (etykieta bez identyfikatora).
    var inUltracodeToggle = false
    /// Element formularza „Nowa sesja” leży pod kryjącą stopką, a nie jest jej elementem.
    var underFooter = false
    /// Arkusz modelu na iPhonie (ekran `arkusz-modelu…` na telefonie).
    var phoneModelSheet = false
  }

  /// Świadome wyjątki (opisane w `native/Rarog/README.md`); `nil` = zgłoszenie oblewa test.
  private static func exception(_ issue: XCUIAccessibilityAuditIssue, identifier: String, _ facts: Facts) -> String? {
    let type = issue.auditType
    if facts.outsideClip {
      // Zmierzone (panel „w tle" na iPadzie): wiersze przewinięte poza dół popovera, ramka nad
      // sekcją PROJEKTY — piksele 3,71:1 to cudzy tekst pod popoverem, nie wiersz panelu (7:1 z tokenów).
      return "poza widoczną częścią przewijanego panelu: piksele i obcięcie należą do treści pod nim"
    }
    if facts.underFooter {
      // Zmierzone na iPadzie z wierszem ultracode: wiersz „Rozmów” pod zgięciem stoi pod kryjącą stopką
      // formularza (`formFooterBar`), a w jego ramce są piksele stopki i przyciemnienia pod arkuszem (1,89:1).
      // Przy wyłączonym przełączniku (bez zdania o koszcie) pod stopką jest drugi wiersz, nie pierwszy.
      return "pod kryjącą stopką formularza: piksele i obcięcie należą do stopki"
    }
    if type == .textClipped, facts.phoneModelSheet {
      // Zmierzone (iPhone, iOS 27): audyt zgłasza obcięcie nagłówków MODEL i EFFORT, opcji i „Zatwierdź”
      // arkusza modelu w obu rozmiarach pisma, a na zrzutach z tej samej chwili każdy z tych tekstów stoi w całości.
      // To samo zjawisko co w panelu „w tle” na iPhonie (`auditWorkflowPanel`): ramki z przebiegu zmiany pisma.
      // Zgłoszenia zostają w raporcie.
      // Tak samo nagłówek ULTRACODE i jego dwa wybory: na zrzucie `arkusz-modelu` z iPhone'a stoją w całości.
      return "arkusz modelu na iPhonie: obcięcie z ramek przebiegu zmiany pisma, rozstrzyga zrzut (raport)"
    }
    if facts.shortcutDigit, type == .dynamicType || type == .contrast {
      // Klawisz skrótu na zakładce to podpowiedź dla klawiatury sprzętowej, nie treść: czytnik go nie słyszy
      // (zdanie niesie przycisk zakładki), a pismo `caption2`, o 1 pt mniejsze od etykiety, wybrał użytkownik
      // (ten sam wyjątek ma `DynamicTypeSourceTests`). Audyt widzi cyfrę mimo ukrycia.
      // Kontrast: cyfra trzyma ≥ 4,5:1 na kafelku każdego stanu (kafelek niesie stan; w ciszy
      // `muted` 5,9:1 w jasnym), ale glif jest tak drobny, że pomiar pikseli brał odcień antyaliasingu za atrament
      // (zmierzone w kadrze „1”: #51515A 28 px, #9E9EA4 13 px → „2,01:1”). Kolory pilnuje `PaletteContrastTests`
      // (kafelek skrótu na zakładce).
      return "klawisz skrótu Cmd na zakładce: podpowiedź klawiatury w `caption2`, ukryta dla czytnika"
    }
    if type == .contrast {
      // Werdykt kontrastu audyt liczy nie z tego, co widać: na iOS 27 zgłaszał tekst o zmierzonych 7,8–17:1
      // („27%" #51515A na #FFFFFF, nazwa projektu #1C1C1E na #FFFFFF), a ten sam tekst z dokładnie tymi samymi
      // pikselami raz zgłaszał, raz nie — zależnie od budowy widoku. Rozstrzyga pomiar.
      if let contrast = facts.contrast {
        if contrast.ratio >= 4.5 { return "fałszywy alarm audytu: piksele \(contrast)" }
        if facts.inRow, contrast.isIdleInk { return "świadomie wyciszony wiersz bezczynny: \(contrast)" }
        return nil
      }
      if !facts.hasElement {
        // Wiersz listy przebudowany w trakcie audytu (zegar co sekundę, strumień demo) nie ma już elementu,
        // więc nie ma czego zmierzyć. W przebiegach, w których element się odnalazł, każde takie zgłoszenie
        // dawało ≥ 4,5:1 albo atrament wiersza bezczynnego (README); tokeny pilnuje `PaletteContrastTests`.
        return "audyt nie wskazał elementu: nie da się zmierzyć (raport)"
      }
      return facts.visible ? nil : "tekstu nie ma w kadrze: element ucięty albo zasłonięty, audyt mierzył cudze piksele"
    }
    if type == .elementDetection, facts.inSummary {
      return "znaki w elemencie, który niesie zdanie zamiast nich"
    }
    if type == .textClipped, facts.inSummary, !facts.largestText {
      return "zwykłe pismo: skrót treści kontenera z pełnym zdaniem czytnika"
    }
    if type == .elementDetection, !facts.hasElement {
      // Bez elementu nie da się wskazać, co to jest: treść pod modalnym arkuszem (czytnik słusznie jej
      // nie czyta), klawiatura i pasek skrótów systemu albo tekst zastępczy pustego pola (czytnik
      // dostaje go nazwą pola). Raport z wyniku testu przegląda się przy odbiorze.
      if facts.modal { return "treść pod modalnym arkuszem" }
      if facts.keyboard { return "klawiatura systemu" }
    }
    if !facts.hasElement, [.dynamicType, .textClipped, .elementDetection].contains(where: { type.contains($0) }) {
      // Zgłoszenie bez elementu nie ma ramki ani identyfikatora: nie da się go zmierzyć ani przypisać.
      // Na iOS 27 przychodzą tak teksty SwiftUI w komórkach `UIHostingConfiguration` (transkrypt, karta,
      // formularz nowej sesji), a w zrzutach AX5 każdy z nich rośnie z pismem. The decision comes
      // from reviewing the `AcceptanceScreenshotUITests` screenshots at the largest text size (taken by hand with
      // `RAROG_SCREENSHOT_DIR`, outside the gate); the finding stays in the report.
      // Tylko te trzy typy: cel dotyku, opis i cechy bez elementu dalej oblewają, bo zrzut ich nie rozstrzyga.
      return "audyt nie wskazał elementu: rozstrzygają zrzuty w największym piśmie (raport)"
    }
    if type == .dynamicType, facts.inHeaderTitle {
      // Pasek nawigacji ma stałą wysokość: tytuł obok przycisku listy rośnie do xxLarge jak tytuł systemu,
      // dalej podgląd dużej treści (zmierzone: nazwa 20,5 pt w Large, 25,5 pt w AX5).
      return "tytuł nagłówka w pasku nawigacji: sufit xxLarge jak tytuł systemu i podgląd dużej treści"
    }
    if type == .dynamicType, facts.inUltracodeToggle {
      // Ten sam przypadek co zdanie o trybie niżej: wiersz ultracode stoi tuż nad zgięciem arkusza. Audyt
      // widzi przełącznik wyłączony, więc bez zdania o koszcie (pokazuje się tylko przy włączonym). Pismo etykiety
      // `Toggle` to `body` bez sufitu; w największym piśmie wiersz stoi pod zgięciem, a audyt `nowa-sesja-ax5`
      // nic mu nie zgłasza (iPad, iOS 27).
      return "wiersz ultracode nad zgięciem formularza: style tekstowe bez sufitu, w AX5 audyt bez zgłoszeń"
    }
    switch identifier {
    case "newSession.cancel":
      // Systemowy przycisk paska narzędzi na szkle: sufit rozmiaru daje system.
      if type == .dynamicType { return "systemowy przycisk paska narzędzi" }
    case "composer.model", "composer.mode":
      if type == .dynamicType { return "pigułki paska kontrolek: sufit xxxLarge i podgląd dużej treści" }
    case "list.title":
      // Pasek nawigacji systemu: napis rośnie z pismem tylko do sufitu paska (zmierzone: 16 pt w Large,
      // 20,5 pt w AX5, gdy etykieta okna limitów poza paskiem rośnie do 48 pt) — sufit daje system.
      if type == .dynamicType { return "napis w systemowym pasku nawigacji: sufit rozmiaru daje system" }
    case "newSession.path":
      // Jednowierszowe pole tekstowe przewija treść w poziomie — tak działa `UITextField`.
      if type == .textClipped { return "jednowierszowe pole ścieżki przewija tekst" }
    case "newSession.modeHint", "newSession.resumeHeader", "newSession.resumeOpen", "newSession.resumeResumable":
      // Zmierzone: audyt zgłasza Dynamic Type tekstom formularza tuż nad zgięciem arkusza,
      // z ramkami ze swojego przebiegu zmiany pisma — wyżej stojące teksty tej samej budowy przechodzą, a zgłoszenie
      // nie zniknęło ani po zdjęciu `fixedSize`, ani `ViewThatFits`. Nagłówek rozmów jest systemowym nagłówkiem
      // `Section` (pismo daje system, jak w Ustawieniach). The growth
      // with text size shows on the AX5 screenshot `nowa-sesja-start` from `AcceptanceScreenshotUITests`, taken by hand with
      // `RAROG_SCREENSHOT_DIR` (the iPhone sheet gets the same kind of finding, README).
      // Group labels "Open" / "Resumable" are `.caption` text that scales; the audit flags the
      // one standing at the fold in the same way.
      if type == .dynamicType { return "tekst nad zgięciem formularza: wzrost pokazuje zrzut AX5 nowa-sesja-start" }
    default:
      break
    }
    return nil
  }

  /// Stopka formularza „Nowa sesja”: górna krawędź (najwyższy element minus odstęp stopki 12 pt) i ramki jej
  /// elementów; `nil` poza tym formularzem. Stopka jest kryjąca (`formFooterBar`), więc wiersz formularza przewinięty
  /// pod nią wciąż stoi w drzewie, a piksele jego ramki należą do stopki albo do przyciemnienia pod arkuszem.
  @MainActor
  private static func formFooter(_ app: XCUIApplication) -> (top: CGFloat, frames: [CGRect])? {
    let any = app.descendants(matching: .any)
    guard any.matching(identifier: "newSession.sheet").firstMatch.exists else { return nil }
    let ids = [
      "newSession.formError", "newSession.launchBlocked", "newSession.footerWarning", "newSession.launchSummary",
      "newSession.launch", "newSession.browseHint", "newSession.browseCancel", "newSession.choose",
      "newSession.chooseWarning", "newSession.warningCancel", "newSession.chooseAnyway",
    ]
    let frames = ids.compactMap { id -> CGRect? in
      let element = any.matching(identifier: id).firstMatch
      return element.exists ? element.frame.insetBy(dx: -1, dy: -1) : nil
    }
    guard let top = frames.map(\.minY).min() else { return nil }
    return (top - 12, frames)
  }

  /// Etykieta klawisza skrótu na zakładce: jedna cyfra 1–9 (Cmd+1…9).
  private static func isShortcutDigit(_ label: String?) -> Bool {
    guard let label, label.count == 1, let digit = Int(label) else { return false }
    return (1...9).contains(digit)
  }

  /// Kadr tekstu zakładki: bez dolnych 8 pt celu. W tym pasie stoi tylko dół płytki bieżącej i tło paska
  /// (między sobą < 1,5:1, więc pomiar ich nie liczy). Kafelek w kolorze stanu stoi w kadrze.
  private static func tabText(_ frame: CGRect) -> CGRect {
    CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: max(0, frame.height - 8))
  }

  private static func name(_ type: XCUIAccessibilityAuditType) -> String {
    let names: [(XCUIAccessibilityAuditType, String)] = [
      (.contrast, "contrast"), (.elementDetection, "elementDetection"), (.hitRegion, "hitRegion"),
      (.sufficientElementDescription, "description"), (.dynamicType, "dynamicType"),
      (.textClipped, "textClipped"), (.trait, "trait"),
    ]
    return names.first { type.contains($0.0) }?.1 ?? "inne(\(type.rawValue))"
  }

  // MARK: - Pomocnicze

  /// Elementy, które czytnikowi dają ZDANIE zamiast widocznych znaków (wiersz listy,
  /// projekt, zakładka, linia limitów, linia gita): skróty w środku („7D", „↑2") audyt widzi jako
  /// tekst bez opisu, a to jest zamierzone.
  @MainActor
  private func summarizingFrames(_ app: XCUIApplication) -> [CGRect] {
    let predicate = NSPredicate(
      format: "(identifier BEGINSWITH 'session.' AND identifier != 'session.list') OR identifier BEGINSWITH 'project.'"
        + " OR identifier BEGINSWITH 'tab.' OR identifier IN {'list.usage', 'header.git'}")
    let matches = app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
    return matches.compactMap { $0.exists ? $0.frame.insetBy(dx: -1, dy: -1) : nil }
      .filter { !$0.isEmpty && $0.width < app.frame.width }
  }

  /// Chowa klawiaturę ekranową, gdy się da. `true` = system wciąż rysuje coś do pisania: klawiaturę
  /// albo — przy polu z fokusem i klawiaturze sprzętowej — pasek skrótów iPadOS u dołu ekranu; jego
  /// znaki audyt widzi jako tekst bez opisu (wyjątek „klawiatura systemu").
  @MainActor
  private func hideKeyboard(_ app: XCUIApplication) -> Bool {
    if app.keyboards.count > 0 {
      for label in ["Ukryj klawiaturę", "Hide keyboard"] {
        let button = app.keyboards.buttons[label]
        if button.exists, button.isHittable {
          button.tap()
          break
        }
      }
      sleep(1)
    }
    let field = app.textViews["composer.field"]
    let typing = field.exists && (field.value(forKey: "hasKeyboardFocus") as? Bool ?? false)
    return app.keyboards.count > 0 || typing
  }

  /// Projekt z drzewa: wiersz jego sesji `demo-<nazwa>` otwiera zakładki projektu (pasek z „+"). Nagłówek tylko
  /// zwija i rozwija.
  @MainActor
  private func openProject(_ app: XCUIApplication, _ name: String) {
    DemoServer.openRow(app, "demo-\(name)", project: name)
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
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

/// Zrzut ekranu jako bitmapa sRGB: kontrast tekstu mierzony z pikseli kadru elementu.
struct ScreenPixels {
  struct Contrast: CustomStringConvertible {
    let ink: UInt32
    let background: UInt32
    let ratio: Double

    var description: String { String(format: "#%06X na #%06X = %.2f:1", ink, background, ratio) }

    /// Atrament wiersza bezczynnego (`PaletteTokens.idleInk`: jasny `#92929A`, ciemny `#58585F`).
    var isIdleInk: Bool { [0x92929A, 0x58585F].contains { ScreenPixels.close($0, ink) } }
  }

  private let width: Int
  private let height: Int
  private let scale: CGFloat
  private let bytes: [UInt8]

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

  /// Tło to najczęstszy kolor kadru. Tekst to dominujący kolor odróżnialny od tła, a gdy w kadrze stoją kolory
  /// o porównywalnej masie (≥ połowa dominującego) — najsłabszy z nich. Najmocniejszy z częstych przepuszczał
  /// słaby tekst obok drobnej kontrastowej ikony; najsłabszy z częstych łapał jasne odcienie
  /// antyaliasingu krawędzi małego pisma („27%” #51515A brał jako #C8C8CB, 1,67:1). `nil` = w kadrze nie ma tekstu.
  func contrast(in frame: CGRect) -> Contrast? {
    let x0 = max(0, Int((frame.minX * scale).rounded(.down)))
    let x1 = min(width, Int((frame.maxX * scale).rounded(.up)))
    let y0 = max(0, Int((frame.minY * scale).rounded(.down)))
    let y1 = min(height, Int((frame.maxY * scale).rounded(.up)))
    guard x1 > x0, y1 > y0 else { return nil }
    var counts: [UInt32: Int] = [:]
    for y in y0..<y1 {
      for x in x0..<x1 {
        let i = (y * width + x) * 4
        counts[UInt32(bytes[i]) << 16 | UInt32(bytes[i + 1]) << 8 | UInt32(bytes[i + 2]), default: 0] += 1
      }
    }
    return Self.contrast(counts: counts)
  }

  /// Werdykt z histogramu kolorów kadru (wydzielony, żeby dało się go sprawdzić bez symulatora).
  static func contrast(counts: [UInt32: Int]) -> Contrast? {
    guard let background = counts.max(by: { $0.value < $1.value })?.key else { return nil }
    let candidates = counts.filter { Self.ratio($0.key, background) >= 1.5 }
    guard candidates.values.reduce(0, +) >= 8, let top = candidates.values.max() else { return nil }
    let comparable = candidates.filter { $0.value * 2 >= top }.keys
    guard let ink = comparable.min(by: { Self.ratio($0, background) < Self.ratio($1, background) }) else { return nil }
    return Contrast(ink: ink, background: background, ratio: Self.ratio(ink, background))
  }

  /// Kontrast WCAG dwóch kolorów sRGB.
  static func ratio(_ a: UInt32, _ b: UInt32) -> Double {
    let (la, lb) = (luminance(a), luminance(b))
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
  }

  static func luminance(_ rgb: UInt32) -> Double {
    func channel(_ shift: UInt32) -> Double {
      let value = Double((rgb >> shift) & 0xFF) / 255
      return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
  }

  /// Ten sam kolor z dokładnością konwersji przestrzeni barw (±2 na kanał).
  static func close(_ a: UInt32, _ b: UInt32) -> Bool {
    [16, 8, 0].allSatisfy { shift in abs(Int((a >> UInt32(shift)) & 0xFF) - Int((b >> UInt32(shift)) & 0xFF)) <= 2 }
  }
}
