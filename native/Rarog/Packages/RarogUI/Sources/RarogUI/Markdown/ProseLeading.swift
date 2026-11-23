#if os(iOS)
import Synchronization
import UIKit

/// Interlinia prozy transkryptu: odstęp linii bazowych ~1,5 stopnia pisma w akapitach,
/// listach, cytatach i nagłówkach. Kod, tabela i linia pozioma zostają przy swoich wysokościach.
///
/// Metoda z pomiaru (`TextKitTypesetProbeTests`): `lineSpacing`, nie `minimumLineHeight` ani `lineHeightMultiple` —
/// te dwa kładą dopełnienie NAD glifami, także nad pierwszą linią akapitu (wstawka dymku i odstępy akapitów rosłyby
/// o tyle samo), a `lineSpacing` zostawia pierwszą linię przy krawędzi i nie dokłada niczego po końcu tekstu. Tło kodu
/// w linii i zaznaczenie w żadnej metodzie nie rosną. Dopełnienie liczy się od NATURALNEGO odstępu z układu TextKit 2,
/// nie od `UIFont.lineHeight`: przy 16 pt TextKit 2 stawia linie co 21 pt, choć metryka pisma mówi 19,09 (zmierzone:
/// 14 pt → 19, 22 pt → 28, 51 pt → 60), więc dopełnienie z metryki przestrzeliwałoby cel o ~2 pt.
enum ProseLeading {
  /// Docelowy odstęp linii bazowych jako wielokrotność stopnia pisma.
  static let ratio: CGFloat = 1.5

  private static let pitches = Mutex<[String: CGFloat]>([:])

  /// `lineSpacing` akapitu w piśmie `font`: brakujące do `ratio × stopień` ponad naturalny odstęp linii (≥ 0).
  static func lineSpacing(for font: UIFont) -> CGFloat {
    max(0, font.pointSize * ratio - naturalPitch(font))
  }

  /// Naturalny odstęp linii bazowych TextKit 2 dla pisma — zmierzony raz na krój i stopień (dwie linie jednego
  /// akapitu rozdzielone U+2028) i zapamiętany na czas procesu.
  static func naturalPitch(_ font: UIFont) -> CGFloat {
    let key = "\(font.fontName)|\(font.pointSize)"
    if let known = pitches.withLock({ $0[key] }) { return known }
    let measured = measure(font) ?? font.lineHeight
    pitches.withLock { $0[key] = measured }
    return measured
  }

  private static func measure(_ font: UIFont) -> CGFloat? {
    let storage = NSTextContentStorage()
    let manager = NSTextLayoutManager()
    storage.addTextLayoutManager(manager)
    let container = NSTextContainer(size: CGSize(width: 10_000, height: 0))
    container.lineFragmentPadding = 0
    manager.textContainer = container
    storage.attributedString = NSAttributedString(string: "Ag\u{2028}Ag", attributes: [.font: font])
    manager.ensureLayout(for: manager.documentRange)
    var baselines: [CGFloat] = []
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      let frame = fragment.layoutFragmentFrame
      for line in fragment.textLineFragments where line.characterRange.length > 0 {
        baselines.append(frame.minY + line.typographicBounds.minY + line.glyphOrigin.y)
      }
      return true
    }
    guard baselines.count >= 2 else { return nil }
    let pitch = baselines[1] - baselines[0]
    return pitch > 0 ? pitch : nil
  }
}
#endif
