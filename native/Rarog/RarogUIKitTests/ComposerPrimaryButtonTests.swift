import RarogCore
@testable import RarogUI
import UIKit
import XCTest

/// Przycisk pola „Wyślij"/Stop na prawdziwym `ComposerView`:
/// przycisk ma własną drogę z trybem z ekranu, a Enter z klawiatury sprzętowej zostaje przy wysyłce.
/// Właściciel: sterowanie sesją.
@MainActor
final class ComposerPrimaryButtonTests: XCTestCase {
  /// Enter przy pustym polu i pracującej turze nigdy nie przerywa: idzie do `onSend` (pusta wysyłka), choć
  /// przycisk obok mówi „Stop". Tap w przycisk niesie tryb, który był na ekranie.
  func testHardwareReturnSendsEvenWhenButtonIsStop() throws {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
    var sends = 0
    var taps: [ComposerPrimaryAction] = []
    composer.onSend = { sends += 1 }
    composer.onPrimaryAction = { taps.append($0) }
    composer.primaryAction = .stop(enabled: true)

    composer.textView.onHardwareReturn?()
    XCTAssertEqual(sends, 1, "Enter wysyła")
    XCTAssertEqual(taps, [], "Enter nie jest tapnięciem przycisku")

    let button = try XCTUnwrap(Self.button(in: composer))
    button.sendActions(for: .primaryActionTriggered)
    XCTAssertEqual(taps, [.stop(enabled: true)], "tap niesie tryb z ekranu")
    XCTAssertEqual(sends, 1, "Stop nie wysyła")
  }

  /// Jeden przycisk, jeden identyfikator; etykieta, podpowiedź i stan idą za trybem. „Wyślij" działa z polem,
  /// które przyjmuje tekst, Stop — według reguły przerwania (wygaszony, gdy przerwanie by nie doszło).
  func testModeDrivesLabelHintAndEnabled() throws {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
    let button = try XCTUnwrap(Self.button(in: composer))
    XCTAssertEqual(button.accessibilityLabel, UICopy.send)
    XCTAssertTrue(button.isEnabled)

    composer.primaryAction = .stop(enabled: true)
    XCTAssertEqual(button.accessibilityLabel, UICopy.stop)
    XCTAssertEqual(button.accessibilityHint, UICopy.stopHint)
    XCTAssertTrue(button.isEnabled)
    XCTAssertEqual(button.layer.shadowOpacity, 0, "cień ma tylko akcja domyślna „Wyślij”")

    composer.primaryAction = .stop(enabled: false)
    XCTAssertFalse(button.isEnabled, "Stop wygaszony, gdy przerwanie by nie doszło")

    composer.isEditable = false
    composer.primaryAction = .stop(enabled: true)
    XCTAssertTrue(button.isEnabled, "Stop działa także przy polu wygaszonym (np. przy karcie decyzji)")
    composer.primaryAction = .send
    XCTAssertFalse(button.isEnabled, "„Wyślij” dzieli los pola")
    XCTAssertEqual(button.accessibilityLabel, UICopy.send)
    XCTAssertNil(button.accessibilityHint)
    XCTAssertEqual(Self.buttons(in: composer).count, 1, "osobnego Stopu nie ma")
  }

  /// Gest zaczęty na „Wyślij" kończy się wysyłką, choć przycisk w trakcie stał się Stopem (koniec okna po
  /// wysyłce albo start tury pod palcem). Aktywacja bez dotyku (klawiatura, VoiceOver) idzie
  /// za trybem z ekranu.
  func testTouchKeepsModeFromTouchDown() async throws {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
    var taps: [ComposerPrimaryAction] = []
    composer.onPrimaryAction = { taps.append($0) }
    let button = try XCTUnwrap(Self.button(in: composer) as? SendButton)

    XCTAssertTrue(button.beginTracking(UITouch(), with: nil), "palec na „Wyślij”")
    composer.primaryAction = .stop(enabled: true)
    button.sendActions(for: .primaryActionTriggered)
    button.endTracking(nil, with: nil)
    XCTAssertEqual(taps, [.send], "gest kończy się tym, co było pod palcem przy dotknięciu")

    for _ in 0..<5 { await Task.yield() }
    button.sendActions(for: .primaryActionTriggered)
    XCTAssertEqual(taps, [.send, .stop(enabled: true)], "po geście aktywacja bez dotyku idzie za trybem z ekranu")

    composer.primaryAction = .send
    XCTAssertTrue(button.beginTracking(UITouch(), with: nil))
    button.cancelTracking(with: nil)
    composer.primaryAction = .stop(enabled: true)
    button.sendActions(for: .primaryActionTriggered)
    XCTAssertEqual(taps.last, .stop(enabled: true), "przerwany gest nie zostawia trybu z dotknięcia")
  }

  // MARK: - Wypełnienie „Wyślij”

  /// Puste pole: „Wyślij” w obrysie jak kółka obok (bez wypełnienia i cienia), dalej aktywny — tap daje fokus.
  /// Etykieta VoiceOver bez zmian.
  func testEmptyFieldDrawsOutlinedSendThatStaysEnabled() throws {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
    let button = try XCTUnwrap(Self.button(in: composer) as? SendButton)
    XCTAssertEqual(composer.primaryAction, .send)
    assertOutlined(button, "puste pole")
    XCTAssertTrue(button.isEnabled, "pusty „Wyślij” przyjmuje tap")
    XCTAssertEqual(button.accessibilityLabel, UICopy.send)
    XCTAssertNil(button.accessibilityHint)
  }

  /// Same spacje to „pusto” jak przy wysyłce (`RarogStore+Send` przycina); „a” wypełnia akcentem z cieniem.
  func testWhitespaceStaysOutlinedAndTextFills() throws {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
    let button = try XCTUnwrap(Self.button(in: composer) as? SendButton)
    composer.textView.insertText("   ")
    assertOutlined(button, "pole „   ”")
    composer.text = " \n "
    assertOutlined(button, "spacje i nowa linia z kodu")
    composer.text = "a"
    assertFilled(button, "tekst „a”")
  }

  /// Tryb zostaje `.send` przez całą drogę (setter trybu pomija ten sam tryb), a wypełnienie i tak idzie za treścią.
  func testFillFollowsTextWhileModeStaysSend() throws {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
    let button = try XCTUnwrap(Self.button(in: composer) as? SendButton)
    assertOutlined(button, "puste")
    composer.textView.insertText("a")
    composer.primaryAction = .send
    assertFilled(button, "„a”")
    composer.textView.deleteBackward()
    composer.primaryAction = .send
    XCTAssertEqual(composer.text, "")
    assertOutlined(button, "znów puste")
  }

  /// Załącznik bez tekstu to treść: dodanie wypełnia, zdjęcie ostatniego wraca do obrysu.
  func testAttachmentWithoutTextFillsAndRemovalOutlines() throws {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
    let button = try XCTUnwrap(Self.button(in: composer) as? SendButton)
    let shelf = AttachmentShelf()
    composer.bind(to: shelf, sessionId: "s1")
    assertOutlined(button, "pusty pasek")
    let file = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).txt")
    let attachment = ComposerAttachment(kind: .file, name: "notatka.txt", mime: "text/plain", bytes: 7, file: file)
    shelf.restore([attachment], for: "s1")
    XCTAssertEqual(composer.attachments.count, 1)
    assertFilled(button, "załącznik bez tekstu")
    shelf.remove([attachment.id], for: "s1")
    XCTAssertTrue(composer.attachments.isEmpty)
    assertOutlined(button, "po zdjęciu załącznika")
  }

  /// Trwające dyktowanie to wpis (reguła trybu): „Wyślij” wypełniony jak dotąd, także przy pustym polu.
  func testDictationKeepsSendFilled() throws {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
    let button = try XCTUnwrap(Self.button(in: composer) as? SendButton)
    composer.isDictating = true
    assertFilled(button, "dyktowanie przy pustym polu")
    composer.isDictating = false
    assertOutlined(button, "koniec dyktowania bez tekstu")
  }

  /// Stop bez zmian (czerwone wypełnienie, bez cienia); pole nieedytowalne wyłącza pusty „Wyślij”.
  func testStopUnchangedAndReadOnlyFieldDisablesSend() throws {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
    let button = try XCTUnwrap(Self.button(in: composer) as? SendButton)
    composer.primaryAction = .stop(enabled: true)
    XCTAssertEqual(resolved(button.configuration?.baseBackgroundColor), resolved(Palette.err), "Stop czerwony")
    XCTAssertEqual(button.configuration?.background.strokeWidth, 0, "Stop bez obrysu")
    XCTAssertEqual(button.layer.shadowOpacity, 0)

    composer.primaryAction = .send
    composer.isEditable = false
    XCTAssertFalse(button.isEnabled, "pole nieedytowalne: „Wyślij” wyłączony")
    assertOutlined(button, "wyłączony i pusty")
  }

  private let traits = UITraitCollection(userInterfaceStyle: .dark)

  private func resolved(_ color: UIColor?) -> UIColor? { color?.resolvedColor(with: traits) }

  private func assertOutlined(_ button: SendButton, _ what: String, line: UInt = #line) {
    let background = button.configuration?.background
    XCTAssertEqual(background?.strokeWidth, 1, "\(what): obrys", line: line)
    XCTAssertEqual(resolved(background?.strokeColor), resolved(Palette.border), "\(what): kreska `border`", line: line)
    XCTAssertEqual(background?.backgroundColor, .clear, "\(what): bez wypełnienia", line: line)
    XCTAssertNotEqual(
      resolved(button.configuration?.baseBackgroundColor), resolved(Palette.accent), "\(what): bez akcentu", line: line)
    XCTAssertEqual(resolved(button.configuration?.baseForegroundColor), resolved(Palette.muted), "\(what): ikona", line: line)
    XCTAssertEqual(button.layer.shadowOpacity, 0, "\(what): bez cienia", line: line)
  }

  private func assertFilled(_ button: SendButton, _ what: String, line: UInt = #line) {
    XCTAssertEqual(
      resolved(button.configuration?.baseBackgroundColor), resolved(Palette.accent), "\(what): akcent", line: line)
    XCTAssertEqual(button.configuration?.background.strokeWidth, 0, "\(what): bez obrysu", line: line)
    XCTAssertGreaterThan(button.layer.shadowOpacity, 0, "\(what): cień akcji domyślnej", line: line)
  }

  private static func buttons(in view: UIView) -> [UIButton] {
    var found: [UIButton] = []
    if let button = view as? UIButton, ["composer.send", "composer.stop"].contains(button.accessibilityIdentifier) {
      found.append(button)
    }
    for sub in view.subviews { found += buttons(in: sub) }
    return found
  }

  private static func button(in view: UIView) -> UIButton? {
    buttons(in: view).first { $0.accessibilityIdentifier == "composer.send" }
  }
}
