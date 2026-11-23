#if os(iOS)
import SwiftUI
import UIKit

// Pierścień zużycia — kontekst okna w nagłówku sesji. The list footer card draws limits and the machine
// with bars (`BarGauge`, `ColumnGauge`). Ozdoba obok liczby: znaczenie niesie procent
// i zdanie czytnika, więc pierścień czyta się też w monochromie. `UsageInk` dzielą nagłówek sesji i arkusz „Limity”.

/// Tor i łuk od góry zgodnie z ruchem wskazówek, w kolorze progu.
struct RingGauge: View {
  /// 0–1; wartości spoza zakresu są przycinane.
  let fraction: Double
  let tone: UsageTone
  /// Grubość kreski — stała jak maska pierścienia w PWA (2–2,5 px przy każdym rozmiarze pisma).
  let lineWidth: CGFloat
  @AppScaledMetric private var size: CGFloat

  /// - Parameters:
  ///   - size: średnica w zwykłym piśmie; rośnie z Dynamic Type. Nagłówek sesji: 14 pt.
  init(fraction: Double, tone: UsageTone, size: CGFloat = 14, lineWidth: CGFloat = 2.5) {
    self.fraction = fraction
    self.tone = tone
    self.lineWidth = lineWidth
    _size = AppScaledMetric(wrappedValue: size, relativeTo: .footnote)
  }

  var body: some View {
    ZStack {
      Circle().stroke(Color(uiColor: Palette.border), lineWidth: lineWidth)
      Circle()
        .trim(from: 0, to: min(1, max(0, fraction)))
        .stroke(Color(uiColor: UsageInk.color(tone)), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        .rotationEffect(.degrees(-90))
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// Kolor progu: spokojnie — atrament wyciszony, uwaga — bursztyn, gorąco — czerwień.
enum UsageInk {
  static func color(_ tone: UsageTone) -> UIColor {
    switch tone {
    case .calm: Palette.muted
    case .warn: Palette.wait
    case .hot: Palette.err
    }
  }

  /// Waga liczby: próg widać także bez koloru — spokój zwykłą, uwaga i gorąco pogrubioną.
  static func weight(_ tone: UsageTone) -> Font.Weight {
    tone == .calm ? .regular : .semibold
  }
}
#endif
