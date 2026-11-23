import Foundation
import RarogActivity
import RarogContract
import Testing

// Kontrast trzech stanów fazy na pasku kafla: współczynnik kontrastu WCAG między
// tłem, `pending`, `done` i `running`, po złożeniu krycia na tle tak jak SwiftUI w przestrzeni sRGB. Progi idą po
// jasności, więc stany rozróżnia też osoba z daltonizmem czerwono-zielonym. Tła odniesienia: tła zastępcze testów
// widoku (biel 0,12 i 0,95, `LiveActivityViewTests.lockScreen`), czysta czerń i biel, wyspa na czerni. Prawdziwe
// tło kafla (rozmycie tapety) mierzy dopiero odbiór na telefonie. Test wypisuje liczby każdego tła.
@Suite("Live Activity: kontrast stanów faz paska na tłach odniesienia")
struct LiveActivityPhaseContrastTests {
  typealias RGB = (r: Double, g: Double, b: Double)

  struct Background {
    let name: String
    let surface: LiveActivityPalette.Surface
    let rgb: RGB
  }

  static let backgrounds: [Background] = [
    Background(name: "ciemny 0,12", surface: .dark, rgb: (0.12, 0.12, 0.12)),
    Background(name: "czerń", surface: .dark, rgb: (0, 0, 0)),
    Background(name: "wyspa", surface: .island, rgb: (0, 0, 0)),
    Background(name: "jasny 0,95", surface: .light, rgb: (0.95, 0.95, 0.95)),
    Background(name: "biel", surface: .light, rgb: (1, 1, 1)),
  ]

  static func rgb(_ hex: UInt32) -> RGB {
    (Double((hex >> 16) & 0xFF) / 255, Double((hex >> 8) & 0xFF) / 255, Double(hex & 0xFF) / 255)
  }

  /// Kolor z kryciem złożony na tle (mieszanie wartości sRGB, jak w kontekście sRGB renderera).
  static func composite(_ ink: LiveActivityPalette.Ink, on background: RGB) -> RGB {
    let color = rgb(ink.hex)
    let a = ink.alpha
    return (
      color.r * a + background.r * (1 - a), color.g * a + background.g * (1 - a), color.b * a + background.b * (1 - a)
    )
  }

  /// Luminancja względna WCAG 2.x.
  static func luminance(_ color: RGB) -> Double {
    func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
  }

  static func ratio(_ a: RGB, _ b: RGB) -> Double {
    let (la, lb) = (luminance(a), luminance(b))
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
  }

  @Test("kolory stanów: szary niezaczętej, pełna zieleń runPair w pracy, ta sama zieleń w kryciu 0,60 po skończeniu")
  func inks() {
    typealias P = LiveActivityPalette
    #expect(P.phase(.pending, on: .dark) == P.Ink(hex: 0xFFFFFF, alpha: 0.28))
    #expect(P.phase(.pending, on: .island) == P.Ink(hex: 0xFFFFFF, alpha: 0.26))
    #expect(P.phase(.pending, on: .light) == P.Ink(hex: 0x000000, alpha: 0.20))
    for surface in [P.Surface.dark, .island] {
      #expect(P.phase(.running, on: surface) == P.Ink(hex: P.runPair.dark, alpha: 1), "\(surface)")
      #expect(P.phase(.done, on: surface) == P.Ink(hex: P.runPair.dark, alpha: 0.60), "\(surface)")
    }
    #expect(P.phase(.running, on: .light) == P.Ink(hex: P.runPair.light, alpha: 1))
    #expect(P.phase(.done, on: .light) == P.Ink(hex: P.runPair.light, alpha: 0.60))
  }

  @Test("kolejność jasności i progi kontrastu na każdym tle odniesienia (test wypisuje liczby)")
  func contrast() {
    print("live-activity: kontrast stanów faz (tło | pend/tło | done/pend | run/done | run/pend | done/tło)")
    for background in Self.backgrounds {
      let bg = background.rgb
      let pending = Self.composite(LiveActivityPalette.phase(.pending, on: background.surface), on: bg)
      let done = Self.composite(LiveActivityPalette.phase(.done, on: background.surface), on: bg)
      let running = Self.composite(LiveActivityPalette.phase(.running, on: background.surface), on: bg)
      let pendBg = Self.ratio(pending, bg)
      let donePend = Self.ratio(done, pending)
      let runDone = Self.ratio(running, done)
      let runPend = Self.ratio(running, pending)
      let doneBg = Self.ratio(done, bg)
      print(
        "live-activity: " + background.name + " | "
          + [pendBg, donePend, runDone, runPend, doneBg].map { String(format: "%.2f", $0) }.joined(separator: " | "))
      let name = background.name
      let (lBg, lPend, lDone, lRun) = (
        Self.luminance(bg), Self.luminance(pending), Self.luminance(done), Self.luminance(running)
      )
      if background.surface == .light {
        #expect(lBg > lPend && lPend > lDone && lDone > lRun, "\(name): tło > pending > done > running")
        #expect(pendBg >= 1.4, "\(name): pending/tło \(pendBg) < 1,4")
        #expect(donePend >= 1.4, "\(name): done/pending \(donePend) < 1,4")
        #expect(runDone >= 1.8, "\(name): running/done \(runDone) < 1,8")
      } else {
        #expect(lBg < lPend && lPend < lDone && lDone < lRun, "\(name): tło < pending < done < running")
        #expect(pendBg >= 2.0, "\(name): pending/tło \(pendBg) < 2,0")
        #expect(donePend >= 1.5, "\(name): done/pending \(donePend) < 1,5")
        #expect(runDone >= 2.0, "\(name): running/done \(runDone) < 2,0")
      }
      #expect(runPend >= 2.0, "\(name): running/pending \(runPend) < 2,0")
      #expect(doneBg >= 2.0, "\(name): done/tło \(doneBg) < 2,0")
    }
  }
}
