@testable import RarogUI
import UIKit
import XCTest

/// Geometria pola wiadomości na prawdziwym `ComposerView` w oknie (bez hosta apki i sieci).
@MainActor
final class ComposerLayoutTests: XCTestCase {
  /// Podpowiedź zaczyna się tam, gdzie zaczyna się wpisany tekst, więc kursor pustego pola stoi PRZED
  /// pierwszą literą, nie na niej. Tekst
  /// i kursor zaczynają się od wstawki kontenera plus marginesu fragmentu linii — także w największym piśmie.
  func testPlaceholderStartsWhereTypedTextStarts() throws {
    for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
      let (composer, window) = Self.host(category)
      defer { window.isHidden = true }
      let field = composer.textView
      let placeholder = try XCTUnwrap(Self.labels(in: composer).first { $0.text == UICopy.composerPlaceholder })
      let hint = placeholder.convert(placeholder.bounds, to: field)
      let caret = field.caretRect(for: field.beginningOfDocument)

      composer.text = "N"
      composer.layoutIfNeeded()
      let all = try XCTUnwrap(field.textRange(from: field.beginningOfDocument, to: field.endOfDocument))
      let typed = field.firstRect(for: all)

      XCTAssertEqual(hint.minX, typed.minX, accuracy: 1, "\(category.rawValue): podpowiedź tam, gdzie wpisany tekst")
      XCTAssertEqual(caret.minX, typed.minX, accuracy: 2, "\(category.rawValue): kursor pustego pola na początku tekstu")
      XCTAssertLessThanOrEqual(caret.midX, hint.minX + 1, "\(category.rawValue): kursor nie stoi na pierwszej literze")
    }
  }

  /// Pismo pola o 1 pt większe niż `subheadline` (16 pt w rozmiarze domyślnym), tekst i podpowiedź 14 pt od lewej
  /// krawędzi karty pola, prawa krawędź tekstu bez zmian.
  func testFieldTextIsCalloutAndStartsFourteenPointsFromCardEdge() throws {
    let (composer, window) = Self.host(.large)
    defer { window.isHidden = true }
    let field = composer.textView
    let card = try XCTUnwrap(field.superview, "karta pola")
    let placeholder = try XCTUnwrap(Self.labels(in: composer).first { $0.text == UICopy.composerPlaceholder })
    let callout = UIFont.preferredFont(forTextStyle: .callout, compatibleWith: window.traitCollection)
    XCTAssertEqual(placeholder.font.pointSize, callout.pointSize, accuracy: 0.01, "podpowiedź pismem pola")
    XCTAssertEqual(callout.pointSize, 16, accuracy: 0.01, "callout w rozmiarze domyślnym")
    XCTAssertEqual(placeholder.convert(placeholder.bounds, to: card).minX, 14, accuracy: 0.5, "podpowiedź 14 pt od karty")

    composer.text = "N"
    composer.layoutIfNeeded()
    XCTAssertEqual(field.font?.pointSize ?? 0, callout.pointSize, accuracy: 0.01, "wpisany tekst pismem pola")
    let all = try XCTUnwrap(field.textRange(from: field.beginningOfDocument, to: field.endOfDocument))
    let typed = field.convert(field.firstRect(for: all), to: card)
    XCTAssertEqual(typed.minX, 14, accuracy: 1, "wpisany tekst 14 pt od lewej krawędzi karty")
    XCTAssertEqual(card.bounds.maxX - field.convert(field.bounds, to: card).maxX, 10, accuracy: 0.5, "prawa krawędź pola bez zmian")
  }

  /// Podpowiedź idzie za szerokością pola w obie strony. Po chwilowym zwężeniu wraca do jednej linii, zamiast zostać
  /// złamana na starej szerokości i wystawać pod pole (druga linia na rzędzie kontrolek). W wąskim polu łamie się
  /// i mieści w polu.
  func testPlaceholderFollowsFieldWidth() throws {
    let (composer, window) = Self.host(.large)
    defer { window.isHidden = true }
    let field = composer.textView
    let placeholder = try XCTUnwrap(Self.labels(in: composer).first { $0.text == UICopy.composerPlaceholder })
    let line = placeholder.font.lineHeight

    for width: CGFloat in [700, 160, 700] {
      composer.frame.size.width = width
      composer.layoutIfNeeded()
      composer.layoutIfNeeded()
      let hint = placeholder.convert(placeholder.bounds, to: field)
      if width > 300 {
        XCTAssertLessThan(hint.height, line * 1.5, "\(width) pt: podpowiedź w jednej linii")
      } else {
        XCTAssertGreaterThan(hint.height, line * 1.5, "\(width) pt: podpowiedź łamie się w wąskim polu")
      }
      XCTAssertLessThanOrEqual(hint.maxX, field.bounds.maxX, "\(width) pt: podpowiedź nie wystaje w prawo")
      XCTAssertLessThanOrEqual(hint.maxY, field.bounds.maxY + 0.5, "\(width) pt: pole mieści całą podpowiedź")
    }
  }

  private static func host(_ category: UIContentSizeCategory) -> (ComposerView, UIWindow) {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
    window.traitOverrides.preferredContentSizeCategory = category
    let composer = ComposerView(frame: window.bounds)
    window.addSubview(composer)
    window.isHidden = false
    composer.setNeedsLayout()
    composer.layoutIfNeeded()
    composer.layoutIfNeeded()
    return (composer, window)
  }

  /// Mikrofon w rzędzie kontrolek, 16 pt przed „Wyślij”, a tekst idzie do krawędzi karty. „×” anulowania nie ma.
  func testMicStandsInRowBeforeSend() throws {
    let (composer, window) = Self.host(.large)
    defer { window.isHidden = true }
    let buttons = VoiceButtons()
    composer.installVoice(mic: buttons.mic, status: UIView())
    buttons.render(available: true, recording: false, enabled: true)
    composer.layoutIfNeeded()
    let field = composer.textView
    let card = try XCTUnwrap(field.superview, "karta pola")
    let send = try XCTUnwrap(Self.views(of: SendButton.self, in: composer).first)
    let mic = buttons.mic.convert(buttons.mic.bounds, to: card)
    let sendFrame = send.convert(send.bounds, to: card)
    XCTAssertEqual(mic.midY, sendFrame.midY, accuracy: 0.5, "mikrofon w rzędzie „Wyślij”")
    XCTAssertEqual(sendFrame.minX - mic.maxX, 16, accuracy: 0.5, "mikrofon 16 pt przed „Wyślij” (odstęp rzędu + 10)")
    XCTAssertGreaterThan(mic.minY, field.convert(field.bounds, to: card).maxY - 0.5, "mikrofon pod tekstem")
    XCTAssertEqual(card.bounds.maxX - field.convert(field.bounds, to: card).maxX, 10, accuracy: 0.5, "tekst do krawędzi karty")
    XCTAssertTrue(Self.views(of: UIButton.self, in: composer).allSatisfy { $0.accessibilityIdentifier != "composer.mic.cancel" }, "bez „×”")
    XCTAssertEqual(mic.size, sendFrame.size, "the mic plate is as big as Send")
    XCTAssertTrue(buttons.mic.point(inside: CGPoint(x: -1.5, y: -1.5), with: nil), "the touch target reaches 44 pt")
  }

  /// The voice agent button stands in the left group, not beside the mic: two voice controls side by side were
  /// easy to confuse, and its appearing or going does not move the mic or Send.
  func testVoiceAgentStandsAwayFromMic() throws {
    let (composer, window) = Self.host(.large)
    defer { window.isHidden = true }
    let buttons = VoiceButtons()
    composer.installVoice(mic: buttons.mic, status: UIView())
    buttons.render(available: true, recording: false, enabled: true)
    let agent = composer.voiceAgentButton
    let card = try XCTUnwrap(composer.textView.superview, "karta pola")
    let attach = composer.actionBar.attachButton
    func frame(_ view: UIView) -> CGRect { view.convert(view.bounds, to: card) }
    // The session screen gives the button its size (`buildVoiceAgent`); here the same 32 pt.
    agent.translatesAutoresizingMaskIntoConstraints = false
    let side = agent.widthAnchor.constraint(equalToConstant: 32)
    side.priority = .required - 1
    NSLayoutConstraint.activate([side, agent.heightAnchor.constraint(equalToConstant: 32)])

    agent.isHidden = false
    composer.layoutIfNeeded()
    let micWithAgent = frame(buttons.mic)
    XCTAssertLessThan(frame(agent).maxX, card.bounds.midX, "the agent button in the left half")
    XCTAssertGreaterThan(frame(agent).minX, frame(attach).maxX, "after the paper clip")
    XCTAssertGreaterThan(micWithAgent.minX - frame(agent).maxX, 44, "a gap between the agent button and the mic")

    agent.isHidden = true
    composer.layoutIfNeeded()
    XCTAssertEqual(frame(buttons.mic).minX, micWithAgent.minX, accuracy: 0.5, "the mic stays when the agent button goes")
  }

  /// Serwer bez dyktowania: schowany mikrofon nie zajmuje miejsca w rzędzie, a po sondzie wraca w pełnym rozmiarze.
  /// Szerokość 999 jak „Schowaj klawiaturę”: sztywna szerokość biła się z zerem schowanego elementu stosu.
  func testHiddenMicTakesNoRoomInRow() throws {
    let (composer, window) = Self.host(.large)
    defer { window.isHidden = true }
    let buttons = VoiceButtons()
    composer.installVoice(mic: buttons.mic, status: UIView())
    composer.layoutIfNeeded()
    XCTAssertEqual(buttons.mic.frame.width, 0, accuracy: 0.5, "schowany przy instalacji")
    // Własna szerokość mikrofonu, nie `UISV-hiding` stosu (szerokość 0, też na mikrofonie).
    let widths = buttons.mic.constraints.filter { $0.firstAttribute == .width && $0.secondItem == nil }
    let micWidth = try XCTUnwrap(widths.first { $0.constant == VoiceButtons.side }, "\(widths)")
    XCTAssertLessThan(micWidth.priority, .required, "szerokość ustępuje zeru schowanego elementu stosu: \(widths)")

    for (available, width) in [(true, VoiceButtons.side), (false, 0.0), (true, VoiceButtons.side)] {
      buttons.render(available: available, recording: false, enabled: true)
      composer.layoutIfNeeded()
      XCTAssertEqual(buttons.mic.frame.width, width, accuracy: 0.5, "dostępne: \(available)")
    }
  }

  private static func views<T: UIView>(of type: T.Type, in view: UIView) -> [T] {
    view.subviews.flatMap { ($0 as? T).map { [$0] } ?? [] + views(of: type, in: $0) }
  }

  private static func labels(in view: UIView) -> [UILabel] {
    view.subviews.flatMap { ($0 as? UILabel).map { [$0] } ?? [] + labels(in: $0) }
  }
}
