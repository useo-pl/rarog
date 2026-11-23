import XCTest

/// Settings → About against the demo: once paired, the list row "O apce" carries the version in its subtitle and opens
/// the page with three product links, "Zgłoś problem", "Licencje" and the version row from `Info.plist`; "Licencje"
/// opens the page with the `THIRD-PARTY-NOTICES` notices from the app bundle.
/// The links are not tapped (Safari and Mail are other processes; acceptance on a device checks that they open).
final class AboutUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testAboutSectionShowsVersionAndOpensLicenses() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)

    element(app, "list.settings").tap()
    let form = element(app, "settings.form")
    XCTAssertTrue(form.waitForAppearance(timeout: 10), "Settings")
    let row = DemoServer.revealSettings(app, "settings.row.about", in: form)
    XCTAssertEqual(row.label, "O apce", "the About row on the Settings list")
    let subtitle = row.value as? String ?? ""
    XCTAssertTrue(subtitle.hasPrefix("Wersja "), "version in the row's subtitle: \(subtitle)")

    let page = DemoServer.openSettingsPage(app, "about")
    XCTAssertTrue(app.navigationBars["O apce"].exists, "title of the About page")
    let section = DemoServer.revealSettings(app, "settings.about.version", in: page)
    XCTAssertTrue(section.exists, "version row on the About page")
    let version = section.label
    XCTAssertNotNil(version.range(of: #"^Wersja \d+\.\d+ \(\d+\)$"#, options: .regularExpression), version)

    for (id, label) in [("privacy", "Polityka prywatności"), ("setup", "Instalacja serwera"), ("support", "Wsparcie")] {
      let link = element(app, "settings.about.\(id)")
      XCTAssertTrue(link.exists, "link \(id)")
      XCTAssertTrue(link.label.contains(label), "\(id): \(link.label)")
    }
    let report = element(app, "settings.about.report")
    XCTAssertTrue(report.exists, "„Zgłoś problem”")
    XCTAssertTrue(report.label.contains("Zgłoś problem"), report.label)

    let licenses = DemoServer.revealSettings(app, "settings.about.licenses", in: page)
    XCTAssertTrue(licenses.label.contains("Licencje"), licenses.label)
    licenses.tap()
    let head = element(app, "about.licenses.head")
    XCTAssertTrue(head.waitForAppearance(timeout: 10), "licenses page")
    XCTAssertTrue(head.label.hasPrefix("THIRD-PARTY NOTICES"), String(head.label.prefix(80)))
    XCTAssertTrue(app.navigationBars["Licencje składników zewnętrznych"].exists, "title of the licenses page")
  }

  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }
}
