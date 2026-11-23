#if os(iOS)
import UIKit

// Nakładka pasa w kolorze krawędzi siatki. Leży w widoku ekranu terminala NAD stosem (przykrywa też wąski
// pas wewnątrz widoku SwiftTerm, który renderer zawsze maluje swoim tłem) i POD linią stanu (ta ma własne tło).
// Maluje wyłącznie prostokąty z `TerminalEdgeBands` — poza siatką, bez paska klawiszy i pasa pod nim. Bez dotyku
// i bez dostępności: dla czytnika i gestów jej nie ma. Właściciel: terminal.

/// Widok pasa wokół siatki terminala.
final class TerminalEdgeFill: UIView {
  /// Pasy w układzie tego widoku; pusta lista = nic nie maluje (ekran wygląda jak bez pasa).
  var bands: [TerminalEdgeBands.Band] = [] {
    didSet { if bands != oldValue { setNeedsDisplay() } }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    contentMode = .redraw
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) nieużywany") }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    for band in bands where band.rect.intersects(rect) {
      context.setFillColor(band.color.uiColor.cgColor)
      context.fill(band.rect)
    }
  }
}

extension TerminalEdgeColor {
  /// Ten sam przelicznik co renderer (`UIColor` z 16 bitów na kanał), więc pas i komórka mają jeden kolor.
  var uiColor: UIColor {
    UIColor(red: CGFloat(red) / 65535, green: CGFloat(green) / 65535, blue: CGFloat(blue) / 65535, alpha: 1)
  }
}
#endif
