import RarogContract
import RarogCore
@testable import RarogUI
import UIKit
import XCTest

/// Pole wiadomości w starcie agenta na prawdziwym `ComposerView` z modelem z rdzenia: pole przyjmuje
/// tekst i załączniki, ale „Wyślij” stoi wygaszony, a pod polem nie ma zdania. Start widać w wierszu aktywności NAD
/// polem (ikona startu i „Uruchamiam agenta…”, bez stałej animacji: ruch idzie z danych). Return
/// na prawdziwym `SessionViewController` nic nie wysyła i nie łamie linii, a koniec startu zdejmuje blokadę ze szkicem
/// w polu. Na końcu przycisk pola w trakcie tury (`starting` i `running`): wybór Stop idzie za surowym tekstem pola
/// i wypełnienie „Wyślij” za treścią po przycięciu. Właściciel: wysyłka.
@MainActor
final class ComposerStartingTests: XCTestCase {
  private var window: UIWindow?

  override func tearDown() {
    window?.isHidden = true
    window = nil
    super.tearDown()
  }

  private func composer() -> ComposerView {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
    let host = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 400))
    host.addSubview(composer)
    host.isHidden = false
    window = host
    return composer
  }

  /// Ten sam przebieg co `SessionViewController.renderComposer`: model z rdzenia → pole i linia komunikatu.
  private func render(_ composer: ComposerView, state sessionState: SessionState) {
    var state = AppState(clientBuild: 1)
    state.sessions["s1"] = Self.session(sessionState)
    state.sessionsLoaded = true
    state.global = .online
    let model = ComposerModel.make(state: state, sessionId: "s1")
    composer.isEditable = model.editable
    composer.canSend = model.sendable
    composer.setHint(model.editable ? nil : model.reason)
  }

  private static func session(_ state: SessionState) -> SessionSummary {
    let json = #"""
      {"id":"s1","cwd":"/tmp/p","title":"p","state":"\#(state.rawValue)",
       "stateSince":"2026-10-03T07:00:00.000Z","createdAt":"2026-10-03T07:00:00.000Z",
       "lastActivityAt":"2026-10-03T07:00:00.000Z"}
      """#
    // swiftlint:disable:next force_try
    return try! JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
  }

  func testStartingKeepsFieldOpenButSendDisabled() throws {
    let composer = composer()
    composer.text = "szkic"
    render(composer, state: .starting)

    XCTAssertTrue(composer.textView.isEditable, "pole przyjmuje tekst")
    XCTAssertEqual(composer.text, "szkic", "szkic zostaje")
    let send = try XCTUnwrap(Self.view(in: composer, id: "composer.send") as? UIButton)
    XCTAssertFalse(send.isEnabled, "„Wyślij” wygaszony")
    let attach = try XCTUnwrap(Self.view(in: composer, id: "composer.attach") as? UIButton)
    XCTAssertTrue(attach.isEnabled, "spinacz czynny: załącznik czeka w pasku")
    XCTAssertTrue(composer.sources.accepting(), "upuszczenie przyjęte")
    let hint = try XCTUnwrap(Self.view(in: composer, id: "composer.hint") as? UILabel)
    XCTAssertTrue(hint.isHidden, "pod polem bez zdania: start stoi w wierszu aktywności")

    // Return nie dochodzi do `onSend`: opakowanie dyktowania przed wysyłką kończy nagranie.
    var sends = 0
    composer.onSend = { sends += 1 }
    let enter = try XCTUnwrap(composer.textView.keyCommands?.first { $0.input == "\r" && $0.modifierFlags.isEmpty })
    let action = try XCTUnwrap(enter.action)
    XCTAssertTrue(composer.textView.canPerformAction(action, withSender: enter), "Return należy do pola: bez nowej linii")
    composer.textView.perform(action, with: enter)
    XCTAssertEqual(sends, 0, "Return w starcie nie woła wysyłki")
    XCTAssertEqual(composer.text, "szkic")
    render(composer, state: .waitingInput)
    composer.textView.perform(action, with: enter)
    XCTAssertEqual(sends, 1, "po starcie Return wysyła")
  }

  func testStartEndsStraightIntoRunningAndDraftStays() throws {
    let composer = composer()
    composer.text = "szkic"
    render(composer, state: .starting)
    render(composer, state: .running)

    XCTAssertTrue(composer.textView.isEditable)
    XCTAssertEqual(composer.text, "szkic", "szkic zostaje w polu")
    let send = try XCTUnwrap(Self.view(in: composer, id: "composer.send") as? UIButton)
    XCTAssertTrue(send.isEnabled, "blokada zdjęta")
  }

  func testTrustDialogAndFailedStartLockField() throws {
    let composer = composer()
    render(composer, state: .waitingPermission)
    XCTAssertFalse(composer.textView.isEditable, "decyzja wygrywa: pole do odczytu")
    let hint = try XCTUnwrap(Self.view(in: composer, id: "composer.hint") as? UILabel)
    XCTAssertFalse(hint.isHidden, "zdanie o decyzji pod polem")
    render(composer, state: .error)
    XCTAssertFalse(composer.textView.isEditable, "porażka startu: pole do odczytu")
  }

  // MARK: - Ekran sesji w starcie: wiersz nad polem, Return bez wysyłki

  func testStartingShowsInActivityRowAboveField() throws {
    let fixture = try Fixture(state: "starting")
    defer { fixture.close() }
    let row = try XCTUnwrap(Self.view(in: fixture.controller.view, id: "transcript.activity"))
    XCTAssertTrue(row.accessibilityLabel?.contains("Uruchamiam agenta… Wyślesz, gdy będzie gotowy.") == true,
      "zdanie startu w wierszu aktywności: \(row.accessibilityLabel ?? "nil")")
    let activity = try XCTUnwrap(row as? ActivityRowView)
    XCTAssertNotNil(activity.glyph.image, "ikona startu")
    XCTAssertGreaterThan(activity.glyph.alpha, 0, "ikona widoczna")
    XCTAssertTrue(activity.glyph.layer.animationKeys()?.isEmpty ?? true, "bez stałej animacji (ruch tylko z danych)")
    // The row is the first line of the field card: in the card, above the text.
    let text = fixture.composer.textView
    XCTAssertTrue(row.isDescendant(of: try XCTUnwrap(text.superview)), "wiersz w karcie pola")
    XCTAssertLessThanOrEqual(row.convert(row.bounds, to: nil).maxY, text.convert(text.bounds, to: nil).minY + 0.5,
      "wiersz stoi nad tekstem pola")
    let hint = try XCTUnwrap(Self.view(in: fixture.composer, id: "composer.hint") as? UILabel)
    XCTAssertTrue(hint.isHidden, "pod polem pusto")
  }

  func testReturnTypesButDoesNotSendWhileStarting() throws {
    let fixture = try Fixture(state: "starting")
    defer { fixture.close() }
    fixture.composer.textView.insertText("zrób to")
    XCTAssertEqual(fixture.composer.text, "zrób to", "pole przyjmuje pisanie")
    try fixture.press(.enter)
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    XCTAssertEqual(fixture.composer.text, "zrób to", "Return nie wysyła i nie łamie linii")
    XCTAssertEqual(fixture.calls.read(\.sends), [], "nic nie wyszło do serwera")
  }

  // MARK: - „Wyślij” w obrysie w trakcie tury

  /// Ekran sesji i transport: `CommandSuggestionsKeysTests.Fixture`.
  typealias Fixture = CommandSuggestionsKeysTests.Fixture

  /// Pracująca tura: „   ” z klawiatury to wpis dla wyboru trybu, więc „Wyślij”, nie Stop, ale w obrysie i aktywny.
  func testWhitespaceDuringRunningTurnIsOutlinedSendNotStop() throws {
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    let button = try XCTUnwrap(Self.view(in: fixture.composer, id: "composer.send") as? SendButton)
    fixture.controller.renderPrimaryAction()
    XCTAssertEqual(fixture.composer.primaryAction, .stop(enabled: true), "pusto w trakcie tury: Stop")
    XCTAssertEqual(resolved(button.configuration?.baseBackgroundColor), resolved(Palette.err), "Stop czerwony jak dotąd")

    fixture.composer.textView.insertText("   ")
    XCTAssertEqual(fixture.composer.primaryAction, .send, "„   ” to wpis dla wyboru trybu: „Wyślij”")
    XCTAssertEqual(button.accessibilityLabel, UICopy.send)
    assertOutlined(button, "„   ”")
    XCTAssertTrue(button.isEnabled, "pusty „Wyślij” przyjmuje tap")

    fixture.composer.textView.insertText("a")
    XCTAssertEqual(resolved(button.configuration?.baseBackgroundColor), resolved(Palette.accent), "tekst: akcent")
    XCTAssertGreaterThan(button.layer.shadowOpacity, 0, "tekst: cień akcji domyślnej")

    fixture.composer.text = ""
    XCTAssertEqual(fixture.composer.primaryAction, .stop(enabled: true), "pole wyczyszczone: znów Stop")
  }

  /// Start agenta: pole przyjmuje tekst, więc „   ” to „Wyślij”, nie Stop, w obrysie i wygaszony; tekst z treścią
  /// ma wypełnienie, ale dalej jest wygaszony i bez cienia. Puste pole: Stop jak dotąd.
  func testWhitespaceDraftDuringStartIsOutlinedDisabledSendNotStop() throws {
    let fixture = try Fixture(state: "starting")
    defer { fixture.close() }
    let button = try XCTUnwrap(Self.view(in: fixture.composer, id: "composer.send") as? SendButton)
    XCTAssertTrue(fixture.composer.textView.isEditable, "start agenta: pole przyjmuje tekst")
    fixture.controller.renderPrimaryAction()
    XCTAssertEqual(fixture.composer.primaryAction, .stop(enabled: true), "pusto w starcie: Stop")
    XCTAssertEqual(resolved(button.configuration?.baseBackgroundColor), resolved(Palette.err), "Stop czerwony jak dotąd")

    fixture.composer.textView.insertText("   ")
    XCTAssertEqual(fixture.composer.primaryAction, .send, "„   ” to wpis dla wyboru trybu: „Wyślij”")
    assertOutlined(button, "„   ” w starcie")
    XCTAssertFalse(button.isEnabled, "start agenta: „Wyślij” wygaszony")

    fixture.composer.textView.insertText("a")
    XCTAssertEqual(resolved(button.configuration?.baseBackgroundColor), resolved(Palette.accent), "tekst z treścią: akcent")
    XCTAssertEqual(button.configuration?.background.strokeWidth, 0, "tekst z treścią: bez obrysu")
    XCTAssertFalse(button.isEnabled, "start agenta: dalej wygaszony")
    XCTAssertEqual(button.layer.shadowOpacity, 0, "wygaszony leży: bez cienia")

    fixture.composer.text = ""
    XCTAssertEqual(fixture.composer.primaryAction, .stop(enabled: true), "pole wyczyszczone: znów Stop")
  }

  private let traits = UITraitCollection(userInterfaceStyle: .dark)

  private func resolved(_ color: UIColor?) -> UIColor? { color?.resolvedColor(with: traits) }

  /// Pusty „Wyślij” jak kółka obok: kreska `border`, cicha ikona, bez wypełnienia i cienia.
  private func assertOutlined(_ button: SendButton, _ what: String, line: UInt = #line) {
    let background = button.configuration?.background
    XCTAssertEqual(background?.strokeWidth, 1, "\(what): obrys", line: line)
    XCTAssertEqual(resolved(background?.strokeColor), resolved(Palette.border), "\(what): kreska `border`", line: line)
    XCTAssertEqual(background?.backgroundColor, .clear, "\(what): bez wypełnienia", line: line)
    XCTAssertEqual(resolved(button.configuration?.baseForegroundColor), resolved(Palette.muted), "\(what): ikona", line: line)
    XCTAssertEqual(button.layer.shadowOpacity, 0, "\(what): bez cienia", line: line)
  }

  private static func view(in view: UIView, id: String) -> UIView? {
    if view.accessibilityIdentifier == id { return view }
    for sub in view.subviews {
      if let found = Self.view(in: sub, id: id) { return found }
    }
    return nil
  }
}
