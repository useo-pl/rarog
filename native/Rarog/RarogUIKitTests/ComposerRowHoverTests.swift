import RarogCore
@testable import RarogUI
import UIKit
import XCTest

/// Wskaźnik nad rzędem pod polem wiadomości: kółka (spinacz, mikrofon)
/// reagują jak pigułki — ikona w `text`, kreska `hoverStroke`, ciemniejsza od napisu; „Wyślij” i Stop rozjaśniają
/// wypełnienie domieszką tekstu. Systemowy efekt wskaźnika jest zdjęty. Symulator nie daje wskaźnika: stan podawany
/// wprost (`RarogHoverTracker.set`). Właściciel: wysyłka.
@MainActor
final class ComposerRowHoverTests: XCTestCase {
  private let traits = UITraitCollection(userInterfaceStyle: .dark)

  private func resolved(_ color: UIColor?) -> UIColor? { color?.resolvedColor(with: traits) }

  func testRingLightsInkAndSoftStrokeUnderPointer() throws {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
    let attach = try XCTUnwrap(Self.views(of: RingButton.self, in: composer).first { $0.accessibilityIdentifier == "composer.attach" })
    XCTAssertFalse(attach.isPointerInteractionEnabled, "bez systemowego efektu wskaźnika")
    let hover = try XCTUnwrap(attach.hover)

    XCTAssertEqual(resolved(attach.configuration?.baseForegroundColor), resolved(Palette.muted), "spoczynek: ikona")
    XCTAssertEqual(resolved(attach.configuration?.background.strokeColor), resolved(Palette.border), "spoczynek: kreska")
    // Przezroczyste wprost: tło `nil` bierze kolor odcienia i kółko robi się białe.
    XCTAssertEqual(attach.configuration?.background.backgroundColor, .clear, "spoczynek: bez wypełnienia")
    hover.set(true)
    XCTAssertEqual(resolved(attach.configuration?.baseForegroundColor), resolved(Palette.text), "pod wskaźnikiem: ikona")
    XCTAssertEqual(resolved(attach.configuration?.background.strokeColor), resolved(Palette.hoverStroke), "kreska przygaszona")
    XCTAssertNotEqual(resolved(Palette.hoverStroke), resolved(Palette.text), "kreska nie w pełnym tekście")
    hover.set(false)
    XCTAssertEqual(resolved(attach.configuration?.background.strokeColor), resolved(Palette.border), "po zejściu wraca")

    // Wygaszone pole: spinacz nie reaguje.
    composer.isEditable = false
    hover.set(true)
    XCTAssertEqual(resolved(attach.configuration?.background.strokeColor), resolved(Palette.border), "wyłączony bez reakcji")
  }

  /// The mic is a plate: `text` icon on `micPlate`, lightened under the pointer like a filled button. Recording
  /// lights it in the state color (outline, icon, `micPlateLive`), which the pointer lightens but does not drop.
  func testMicPlateLightensAndKeepsRecordingColor() throws {
    let buttons = VoiceButtons()
    let mic = buttons.mic
    XCTAssertFalse(mic.isPointerInteractionEnabled, "mikrofon bez systemowego efektu")
    buttons.render(available: true, recording: false, enabled: true)
    XCTAssertEqual(resolved(mic.configuration?.baseForegroundColor), resolved(Palette.text), "rest: icon in text")
    XCTAssertEqual(resolved(mic.configuration?.background.backgroundColor), resolved(Palette.micPlate), "rest: plate")
    XCTAssertEqual(mic.configuration?.background.strokeWidth, 0, "rest: no outline")
    let hover = try XCTUnwrap(mic.hover)
    hover.set(true)
    XCTAssertEqual(
      resolved(mic.configuration?.background.backgroundColor), resolved(Palette.filledHover(PaletteTokens.micPlate)),
      "pointer: lighter plate")

    buttons.render(available: true, recording: true, enabled: true)
    XCTAssertEqual(resolved(mic.configuration?.baseForegroundColor), resolved(Palette.err), "nagranie: ikona w kolorze stanu")
    XCTAssertEqual(resolved(mic.configuration?.background.strokeColor), resolved(Palette.err), "nagranie: kreska w kolorze stanu")
    XCTAssertEqual(
      resolved(mic.configuration?.background.backgroundColor), resolved(Palette.filledHover(PaletteTokens.micPlateLive)),
      "recording under the pointer: lighter live plate")
    hover.set(false)
    XCTAssertEqual(
      resolved(mic.configuration?.background.backgroundColor), resolved(Palette.micPlateLive), "recording: live plate")
  }

  /// Pusty „Wyślij” (obrys) reaguje jak kółka obok: ikona w `text`, kreska `hoverStroke`.
  func testEmptySendReactsLikeRing() throws {
    let send = SendButton(type: .system)
    let hover = try XCTUnwrap(send.hover)
    XCTAssertFalse(send.filled, "nowy przycisk: nic do wysłania")
    XCTAssertEqual(resolved(send.configuration?.background.strokeColor), resolved(Palette.border), "spoczynek: kreska")
    XCTAssertEqual(resolved(send.configuration?.baseForegroundColor), resolved(Palette.muted), "spoczynek: ikona")
    hover.set(true)
    XCTAssertEqual(resolved(send.configuration?.baseForegroundColor), resolved(Palette.text), "pod wskaźnikiem: ikona")
    XCTAssertEqual(resolved(send.configuration?.background.strokeColor), resolved(Palette.hoverStroke), "kreska")
    XCTAssertEqual(send.configuration?.background.backgroundColor, .clear, "bez wypełnienia także pod wskaźnikiem")
    hover.set(false)
    XCTAssertEqual(resolved(send.configuration?.background.strokeColor), resolved(Palette.border), "po zejściu wraca")
  }

  func testSendAndStopLightenFillUnderPointer() throws {
    let send = SendButton(type: .system)
    XCTAssertFalse(send.isPointerInteractionEnabled, "bez systemowego efektu wskaźnika")
    let hover = try XCTUnwrap(send.hover)
    // Wypełnienie ma tylko „Wyślij” z treścią; pusty rysuje obrys (test wyżej).
    send.filled = true
    XCTAssertEqual(resolved(send.configuration?.baseBackgroundColor), resolved(Palette.accent))
    hover.set(true)
    XCTAssertEqual(resolved(send.configuration?.baseBackgroundColor), resolved(Palette.filledHover(PaletteTokens.wait)))
    send.setMode(.stop(enabled: true))
    XCTAssertEqual(resolved(send.configuration?.baseBackgroundColor), resolved(Palette.filledHover(PaletteTokens.err)))
    send.isEnabled = false
    XCTAssertEqual(resolved(send.configuration?.baseBackgroundColor), resolved(Palette.err), "wyłączony bez reakcji")
    send.isEnabled = true
    hover.set(false)
    XCTAssertEqual(resolved(send.configuration?.baseBackgroundColor), resolved(Palette.err), "po zejściu wraca")
  }

  private static func views<T: UIView>(of type: T.Type, in root: UIView) -> [T] {
    root.subviews.flatMap { ($0 as? T).map { [$0] } ?? [] + views(of: type, in: $0) }
  }
}
