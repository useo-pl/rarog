import UIKit
import XCTest

/// Notka o prompcie zablokowanym przez hook z przyciskiem „Uruchom ponownie i wyślij” przeciw
/// sterowanemu scenariuszowi demo `prompt-blocked` (`server/src/demo/scenarios.ts`): prompt idzie zwykłą
/// wysyłką managera, a hook demo blokuje każdy prompt. Pod dymkiem promptu stoi notka z tytułem i powodem od hooka,
/// pod nią przycisk. Panel demo nie ma restartu, więc tapnięcie daje zdanie serwera pod przyciskiem w kolorze
/// błędu, a przycisk zostaje (odmowa przed `/exit`). Zrzut notki z przyciskiem zostaje w wyniku testu, a przy
/// `RAROG_SCREENSHOT_DIR` — także plik `prompt-blocked-<urządzenie>.png`. iPhone i iPad.
final class PromptBlockedUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  @MainActor
  func testBlockedNoteOffersResendAndShowsRefusal() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("prompt-blocked", label: "M1 hook")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.openRow(app, id, project: "rarog")

    let note = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'promptBlocked.m' AND label BEGINSWITH %@",
        "Uwaga: Prompt nie wysłany — zablokował go hook."))
      .firstMatch
    XCTAssertTrue(note.waitForAppearance(timeout: 15), "notka blokady")
    XCTAssertTrue(note.label.contains("send the prompt once more"), "powód od hooka w notce: \(note.label)")
    XCTAssertFalse(note.label.contains("Prompt: "), "prompt z Raroga stoi dymkiem, notka go nie cytuje")
    let resend = app.buttons["promptBlocked.resend"]
    XCTAssertTrue(resend.waitForAppearance(timeout: 5), "przycisk pod notką")
    XCTAssertEqual(resend.label, "Uruchom ponownie i wyślij")
    XCTAssertTrue(resend.isEnabled)
    XCTAssertGreaterThanOrEqual(resend.frame.minY, note.frame.maxY - 1, "przycisk stoi pod notką")
    let prompt = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'message.m'")).allElementsBoundByIndex
      .last { $0.frame.maxY <= note.frame.minY + 1 }
    XCTAssertNotNil(prompt, "dymek promptu nad notką")

    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 15), "pole wiadomości")
    DemoServer.hideKeyboard(app)
    settle()
    shot(app, "prompt-blocked-\(device)")

    // Jedno tapnięcie: serwer odmawia przed `/exit` (panel demo bez restartu) — zdanie pod przyciskiem, przycisk zostaje.
    resend.tap()
    let refusal = app.descendants(matching: .any)["promptBlocked.error"].firstMatch
    XCTAssertTrue(refusal.waitForAppearance(timeout: 15), "zdanie odmowy pod przyciskiem")
    XCTAssertEqual(refusal.label, "Ten panel nie obsługuje restartu z Raroga.")
    XCTAssertGreaterThan(refusal.frame.minY, resend.frame.minY, "odmowa pod przyciskiem")
    XCTAssertTrue(resend.exists && resend.isEnabled, "przycisk zostaje po odmowie")
    XCTAssertEqual(resend.label, "Uruchom ponownie i wyślij")
    settle()
    shot(app, "prompt-blocked-\(device)-odmowa")
    // Sprzątanie w treści testu, jak w `StandbyAgentUITests`.
    app.terminate()
    try await control.reset()
  }

  // MARK: - Pomocnicze

  @MainActor private var device: String { UIDevice.current.userInterfaceIdiom == .phone ? "iphone" : "ipad" }

  /// Chwila na koniec animacji (chowanie klawiatury, przebudowa komórki) przed pomiarem i zrzutem.
  private func settle() {
    Thread.sleep(forTimeInterval: 0.8)
  }

  @MainActor
  private func shot(_ app: XCUIApplication, _ name: String) {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else { return }
    let file = URL(filePath: path, directoryHint: .isDirectory).appending(path: "\(name).png")
    try? screenshot.pngRepresentation.write(to: file)
  }
}
