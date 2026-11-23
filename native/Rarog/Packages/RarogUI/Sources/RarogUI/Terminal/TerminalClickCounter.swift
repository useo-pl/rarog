import CoreGraphics
import Foundation

// Liczenie kliknięć wskaźnika (gładzik, mysz) na powierzchni terminala — zaznaczanie jak na Macu:
// ×1 kotwica i przeciąganie po znakach, ×2 słowo, ×3 wiersz. Stuknięcia palcem liczy SwiftTerm
// swoimi rozpoznawaczami; kliknięć wskaźnika one nie widzą (`allowedTouchTypes` bez `.indirectPointer`), więc
// powierzchnia liczy je sama. Logika bez UIKit testuje się na macOS. Właściciel: terminal.

/// Licznik kolejnych kliknięć w tym samym miejscu.
public struct TerminalClickCounter: Sendable {
  /// Najdłuższy odstęp między wciśnięciami jednej serii.
  public static let interval: TimeInterval = 0.35
  /// Najdalsze przesunięcie wskaźnika między wciśnięciami jednej serii.
  public static let slop: CGFloat = 5
  /// Wyżej nie liczymy: czwarte kliknięcie dalej zaznacza wiersz (jak na Macu).
  public static let maxCount = 3

  private var last: (point: CGPoint, time: TimeInterval, count: Int)?

  public init() {}

  /// Wciśnięcie w `point` o czasie `time` (sekundy, zegar monotoniczny) → numer kliknięcia w serii (1…3).
  public mutating func register(at point: CGPoint, time: TimeInterval) -> Int {
    var count = 1
    if let last, time >= last.time, time - last.time < Self.interval,
      hypot(point.x - last.point.x, point.y - last.point.y) < Self.slop
    {
      count = min(last.count + 1, Self.maxCount)
    }
    last = (point, time, count)
    return count
  }
}
