import XCTest

/// Zestaw dymny po angielsku (`docs/localization.md`, „Tests”). Apka startuje z `-AppleLanguages (en)
/// -AppleLocale en_US` (`DemoServer.launch(…, language: .en)`), więc język copy wybiera jej `CopyLanguage`
/// z `.lproj` apki, tak jak na urządzeniu po angielsku. Test przechodzi parowanie demo, listę, „Settings” z wierszem
/// „Language” i wierszem „Pairing” oraz sesję z kartą zgody, a na każdym ekranie sprawdza kilka angielskich etykiet.
///
/// Etykiety stoją tu dosłownie, przepisane z katalogu RarogUI (`Localizable.xcstrings`, klucz przy każdej): cel
/// testów UI nie linkuje pakietów, więc funkcji `L` tu nie ma. Zdanie serwera test sprawdza jedno: karta stanu
/// `demo-map-view` zaczyna się od zdania limitu po angielsku, które apka składa z kodu `state.limit-reached`
/// (na drucie stoi token `resetAt=<ISO>`, nie zdanie), z katalogu zdań serwera RarogContract. Pełne przypadki zdań
/// serwera w obu językach: `ServerSentenceUITests`. Podpowiedź wiersza „Language” dla VoiceOver test słyszy przez
/// VoiceOvera (``expectSpokenHint(of:_:)``, iOS 27).
///
/// Karty zgody z seedów demo (`demo-willow`) test nie rozstrzyga: seedy są wspólne dla całego przebiegu bramki
/// (`FlowUITests`).
final class EnglishSmokeUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testPairListSettingsAndCardInEnglish() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port, language: .en)

    // Parowanie: ekran startu i karta potwierdzenia linku z systemu (`rarog://pair#…`).
    let title = element(app, "pair.start.title")
    XCTAssertTrue(title.waitForAppearance(timeout: 15), "ekran parowania")
    XCTAssertEqual(title.label, "Pair with a Server")  // pairing.title
    let lead = element(app, "pair.start.lead").label
    XCTAssertTrue(lead.contains("run rarog pair"), "komenda w akapicie: \(lead)")  // pairing.lead
    XCTAssertTrue(lead.contains("Settings → Pairing → Pair New Device"), "ścieżka w akapicie: \(lead)")  // pairing.lead
    XCTAssertEqual(element(app, "pair.haveLink").label, "I Have a Link")  // pairing.haveLink
    XCUIDevice.shared.system.open(try XCTUnwrap(DemoServer.systemLink(try DemoServer.pairingLink(port: port))))
    let confirmTitle = element(app, "pair.confirm.title")
    XCTAssertTrue(confirmTitle.waitForAppearance(timeout: 10), "karta potwierdzenia parowania")
    XCTAssertEqual(confirmTitle.label, "Pair with 127.0.0.1?")  // pairing.confirmTitle
    let confirm = element(app, "pair.confirm")
    XCTAssertEqual(confirm.label, "Pair")  // pairing.confirm
    DemoServer.waitUntilStill(confirm)
    confirm.tap()

    // Lista: tytuł z liczbą agentów i „Ustawienia” w pasku.
    DemoServer.expectList(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    let listTitle = element(app, "list.title")
    XCTAssertTrue(listTitle.label.hasPrefix("Agents ("), "tytuł listy: \(listTitle.label)")  // list.titleCount
    let settings = element(app, "list.settings")
    XCTAssertEqual(settings.label, "Settings")  // pairing.settingsTitle

    // "Settings" → "Pairing": the list row that leads to Pair New Device. It stands above "Language", so it is checked
    // first: the loops below only swipe up.
    settings.tap()
    let form = element(app, "settings.form")
    XCTAssertTrue(form.waitForAppearance(timeout: 10), "Settings")
    let pairing = DemoServer.revealSettings(app, "settings.row.pairing", in: form)
    XCTAssertEqual(pairing.label, "Pairing")  // pairing.issueSection
    // "Settings" → "Language": the label and the app language's name in itself.
    let language = element(app, "settings.language")
    XCTAssertTrue(language.waitForAppearance(timeout: 10), "wiersz „Language”")
    for _ in 0..<4 where !language.isHittable { form.swipeUp(velocity: .slow) }
    XCTAssertEqual(language.label, "Language")  // pairing.languageLabel
    XCTAssertEqual(language.value as? String, "English")  // pairing.languageValue
    if #available(iOS 27.0, *) {
      try expectSpokenHint(of: language, "Opens Rarog settings")  // pairing.languageHint
    }
    let close = element(app, "settings.close")
    XCTAssertEqual(close.label, "Close Settings")  // pairing.settingsClose
    close.tap()
    XCTAssertTrue(language.waitForDisappearance(timeout: 5), "„Close Settings” zamyka formularz")

    // Zdanie serwera z kodu: limit planu na karcie stanu (`server.state.limit-reached` katalogu RarogContract).
    DemoServer.reveal(app, "demo-map-view").tap()
    XCTAssertTrue(element(app, "card.state").waitForAppearance(timeout: 10), "karta stanu")
    let limit = element(app, "state.text").label
    XCTAssertTrue(limit.hasPrefix("Plan limit reached. Try again after "), "zdanie limitu po angielsku: \(limit)")

    // Sesja z kartą zgody: przyciski decyzji po angielsku.
    DemoServer.reveal(app, "demo-willow").tap()
    let card = element(app, "card.permission.demo-perm-willow")
    XCTAssertTrue(card.waitForAppearance(timeout: 15), "karta zgody")
    XCTAssertEqual(element(app, "card.allow").label, "Allow")  // cards.allow
    XCTAssertEqual(element(app, "card.deny").label, "Deny")  // cards.deny
  }

  /// Podpowiedź dla VoiceOver: atrybutów elementu XCUITest jej nie podaje, ale mowa VoiceOvera ją niesie
  /// (`XCUIVoiceOverService`, iOS 27). Pomiar (Xcode 27, symulator iOS 27.0): stuknięcie przy włączonym
  /// VoiceOverze stawia na elemencie fokus, a `currentSpeech()` oddaje etykietę, wartość, cechę i podpowiedź, uciętą
  /// na 64 znakach („Language English Button Opens Rarog settings, where you can chan”). Cechę („Button”) VoiceOver
  /// mówi językiem systemu symulatora, więc test szuka samego początku podpowiedzi. VoiceOver gaśnie przed
  /// następnym stuknięciem, a po teście w każdym wypadku: przy włączonym następne testy bramki trafiałyby fokusem.
  @available(iOS 27.0, *)
  @MainActor
  private func expectSpokenHint(of element: XCUIElement, _ hint: String) throws {
    let voiceOver = XCUIDevice.shared.voiceOverService
    addTeardownBlock { @MainActor in
      if voiceOver.isEnabled { try? voiceOver.disable() }
    }
    try voiceOver.enable()
    var spoken = ""
    for _ in 0..<5 where !spoken.contains(hint) {
      element.tap()
      Thread.sleep(forTimeInterval: 1)
      spoken = (try? voiceOver.currentSpeech())?.utterance ?? ""
    }
    try voiceOver.disable()
    XCTAssertFalse(voiceOver.isEnabled, "VoiceOver wyłączony po sprawdzeniu")
    XCTAssertTrue(spoken.hasPrefix("\(element.label) \(element.value as? String ?? "") "), "mowa VoiceOvera: \(spoken)")
    XCTAssertTrue(spoken.contains(hint), "podpowiedź w mowie VoiceOvera: \(spoken)")
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }
}
