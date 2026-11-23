import Foundation

// Przewijanie palcem w terminalu. Historia żyje w panelu herdr (`scrollback: 0`
// w emulatorze), więc palec PROSI o nią ramką `sc` z komórką pod palcem — herdr kieruje kółko do panelu
// programu, który tam leży (lazygit: diff albo lista). Czysta arytmetyka bez UIKit (testy na macOS):
// piksele → pełne wiersze z resztą na następne zdarzenie i rozpęd po puszczeniu palca. Właściciel: terminal.

/// Akumulator przeciągnięcia: punkty → pełne wiersze, wzmocnienie 2.
public struct ScrollAccumulator: Sendable, Equatable {
  public static let gain: Double = 2

  /// Ruch, który nie złożył się jeszcze na pełny wiersz.
  public private(set) var rest: Double = 0

  public init() {}

  /// `delta` dodatnie = treść jedzie W DÓŁ historii (palec w górę). Zwraca pełne wiersze do wysłania.
  public mutating func push(_ delta: Double, cellHeight: Double) -> Int {
    guard cellHeight > 0, delta.isFinite else {
      rest = 0
      return 0
    }
    let total = rest + delta * Self.gain
    let lines = Int((total / cellHeight).rounded(.towardZero))
    rest = total - Double(lines) * cellHeight
    return lines
  }

  public mutating func reset() { rest = 0 }
}

/// Rozpęd po puszczeniu palca: prędkość gaśnie jak `UIScrollView.DecelerationRate.normal` (×0,998 na ms).
public struct ScrollMomentum: Sendable, Equatable {
  /// Poniżej tej prędkości (pt/s) puszczenie palca nie daje rozpędu — zwykłe, wolne przeciągnięcie.
  public static let startSpeed: Double = 200
  /// Poniżej tej prędkości rozpęd się kończy.
  public static let stopSpeed: Double = 60
  public static let decayPerMillisecond: Double = 0.998

  /// pt/s; dodatnie = treść w dół historii.
  public private(set) var velocity: Double

  /// `nil` = za wolno na rozpęd.
  public init?(velocity: Double) {
    guard velocity.isFinite, abs(velocity) > Self.startSpeed else { return nil }
    self.velocity = velocity
  }

  /// Jedna klatka: przesunięcie w punktach i czy rozpęd trwa dalej.
  public mutating func step(seconds: Double) -> (delta: Double, running: Bool) {
    let dt = max(seconds, 1.0 / 120)
    let delta = velocity * dt
    velocity *= pow(Self.decayPerMillisecond, dt * 1000)
    return (delta, abs(velocity) >= Self.stopSpeed)
  }
}
