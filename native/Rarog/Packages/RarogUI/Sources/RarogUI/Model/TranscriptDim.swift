import Foundation

/// Przygaszenie transkryptu pod kartą decyzji: przyciszenie, nie ukrycie —
/// przygaszona treść zostaje powyżej 7:1. Jedno krycie dla wszystkiego (PWA `--dim-soft` 0,8)
/// trzyma próg tylko dla tekstu: wyciszony atrament (`Palette.muted`: wiadomości systemowe,
/// linie narzędzi, ślady) schodził w ciemnym motywie z 7,85 do 5,32:1. Krycie zależy więc od
/// atramentu wiersza. Czysta matematyka WCAG, testowana na macOS; kolory podaje widok (iOS).
/// Właściciel: transkrypt.
public enum TranscriptDim {
  /// Najmocniejsze przygaszenie (PWA `--dim-soft`).
  public static let soft = 0.8
  /// Próg czytelności przygaszonej treści.
  public static let minContrast = 7.0

  /// Atrament, którym wiersz pisze swoją treść — od niego zależy, ile wolno przygasić.
  public enum Ink: Sendable, Equatable {
    case text
    /// Wyciszony: wiadomość systemowa, linia narzędzia, ślad, znacznik.
    case muted
  }

  /// Kolor w sRGB, składowe 0…1.
  public struct RGB: Sendable, Equatable {
    public let red: Double
    public let green: Double
    public let blue: Double

    public init(red: Double, green: Double, blue: Double) {
      self.red = red
      self.green = green
      self.blue = blue
    }

    public init(hex: UInt32) {
      self.init(
        red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
  }

  /// Atrament wiersza transkryptu. Karty decyzji nie przygasają wcale — o nich decyduje widok.
  public static func ink(_ row: TranscriptRow) -> Ink {
    switch row {
    case let .text(_, role, _, _, _): role == .system ? .muted : .text
    case .open, .pending: .text
    default: .muted
    }
  }

  /// Krycie treści w kolorze `ink` na tle `background`: tak blisko `soft`, jak pozwala próg 7:1.
  /// Atrament, który już bez przygaszenia nie sięga progu, nie przygasa wcale — każde krycie
  /// poniżej 1 zabrałoby mu czytelność, której i tak ma za mało.
  public static func alpha(ink: RGB, background: RGB) -> Double {
    guard contrast(ink, background) > minContrast else { return 1 }
    if dimmedContrast(ink, background, alpha: soft) >= minContrast { return soft }
    // Kontrast rośnie z kryciem, więc bisekcja w [soft, 1]; `high` zawsze trzyma próg.
    var low = soft
    var high = 1.0
    for _ in 0..<24 {
      let mid = (low + high) / 2
      if dimmedContrast(ink, background, alpha: mid) >= minContrast { high = mid } else { low = mid }
    }
    return high
  }

  /// Kontrast treści przygaszonej kryciem `alpha` (mieszanie z tłem) wobec tła.
  public static func dimmedContrast(_ ink: RGB, _ background: RGB, alpha: Double) -> Double {
    let mixed = RGB(
      red: alpha * ink.red + (1 - alpha) * background.red,
      green: alpha * ink.green + (1 - alpha) * background.green,
      blue: alpha * ink.blue + (1 - alpha) * background.blue)
    return contrast(mixed, background)
  }

  /// Współczynnik kontrastu WCAG 2.
  public static func contrast(_ a: RGB, _ b: RGB) -> Double {
    let (la, lb) = (luminance(a), luminance(b))
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
  }

  static func luminance(_ color: RGB) -> Double {
    func channel(_ c: Double) -> Double {
      c <= 0.040_45 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue)
  }
}
