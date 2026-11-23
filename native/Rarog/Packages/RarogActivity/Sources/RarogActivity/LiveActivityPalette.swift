import RarogContract

// Wartości kolorów kafla Live Activity jako liczby, POZA `#if os(iOS)`: test kontrastu stanów faz
// (`LiveActivityPhaseContrastTests`) liczy je w `swift test` na macOS. Kolory SwiftUI z tych liczb składa
// `LiveActivityViews.swift` (tylko iOS).

/// Kolory stanu kafla — te same pary co `PaletteTokens` apki (RarogUI do rozszerzenia nie wchodzi, więc
/// wartości stoją tu; strażnik zgodności: `LiveActivityViewTests.testPaletteMatchesAppTokens`).
public enum LiveActivityPalette {
  public static let waitPair: (dark: UInt32, light: UInt32) = (0xFFB454, 0x9B5700)
  public static let runPair: (dark: UInt32, light: UInt32) = (0x4ADE80, 0x1C773D)
  /// „Skończyły" — `PaletteTokens.new` (wynik do odebrania, jak kropka nowego na liście).
  public static let newPair: (dark: UInt32, light: UInt32) = (0x7EB6FF, 0x0B57D0)
  /// Próg czerwieni limitu i Maca — `PaletteTokens.err`.
  public static let errPair: (dark: UInt32, light: UInt32) = (0xF87171, 0xB31B1B)
  public static let quietPair: (dark: UInt32, light: UInt32) = (0x8E8E93, 0x6B6B73)
  /// Licznik zerowy: atrament bezczynnego wiersza listy, świadomie poniżej AA — zero ma zejść w tło.
  public static let zeroPair: (dark: UInt32, light: UInt32) = (0x58585F, 0x92929A)
  /// Tekst kafla (`PaletteTokens.text`): wartości procentów i pasek limitu poniżej progu.
  public static let textPair: (dark: UInt32, light: UInt32) = (0xF5F5F5, 0x1C1C1E)

  /// Tło, na którym stoi pasek: kafel w ciemnym motywie, wyspa (zawsze ciemna) i kafel w jasnym motywie.
  public enum Surface: Sendable, CaseIterable {
    case dark
    case island
    case light
  }

  /// Barwa i krycie, z którym kolor kładzie się na tle kafla.
  public struct Ink: Sendable, Equatable {
    public let hex: UInt32
    public let alpha: Double

    public init(hex: UInt32, alpha: Double) {
      self.hex = hex
      self.alpha = alpha
    }
  }

  /// Krycie skończonej fazy: przygaszona zieleń pracy. W jasnym motywie
  /// przygaszona wychodzi jaśniejsza od pełnej, w ciemnym ciemniejsza — „przygaszona” znaczy bliżej tła.
  public static let doneAlpha = 0.60

  /// Kolor segmentu fazy w stanie `state` na tle `surface` (pasek przy `states`): niezaczęta — szary
  /// (biel 0,28 na ciemnym kaflu, 0,26 na wyspie, czerń 0,20 na jasnym), w pracy — pełna zieleń `runPair`,
  /// skończona — ta sama zieleń w kryciu ``doneAlpha``. Progi kontrastu: `LiveActivityPhaseContrastTests`.
  public static func phase(_ state: LiveActivityContentState.PhaseState, on surface: Surface) -> Ink {
    let green = surface == .light ? runPair.light : runPair.dark
    switch (state, surface) {
    case (.pending, .dark): return Ink(hex: 0xFFFFFF, alpha: 0.28)
    case (.pending, .island): return Ink(hex: 0xFFFFFF, alpha: 0.26)
    case (.pending, .light): return Ink(hex: 0x000000, alpha: 0.20)
    case (.running, _): return Ink(hex: green, alpha: 1)
    case (.done, _): return Ink(hex: green, alpha: doneAlpha)
    }
  }
}
