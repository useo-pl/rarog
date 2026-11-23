/// Rytm i wspólny zegar poświaty wpisów kolejki. Zegarem jest czas mediów
/// (`CACurrentMediaTime` na dymku i kaflu): każde pasmo startuje na granicy cyklu tego zegara, więc wszystkie dymki
/// w kolejce płyną w jednej fazie, także komórka po recyklingu i pasmo dodane od nowa po powrocie z tła. Zegar
/// ścienny się nie nadaje: w uśpieniu urządzenia idzie dalej, a czas mediów (i animacje Core Animation) stoi.
/// Bez UIKit, żeby testy logiki na macOS sprawdzały rytm. Właściciel: transkrypt.
enum PlateShimmerClock {
  /// Przejście pasma przez dymek i cały cykl razem z przerwą.
  static let sweep: Double = 1.4
  static let period: Double = 2.2

  /// Początek cyklu wspólnego zegara, w którym leży chwila `time`: od niego liczy się animacja pasma.
  static func cycleStart(at time: Double) -> Double {
    time - time.truncatingRemainder(dividingBy: period)
  }

  /// Lewa krawędź pasma w ułamkach szerokości w chwili `time`: od -0,6 do 1 w czasie przejścia, z łagodnym startem
  /// i końcem, potem przerwa poza kształtem (do końca cyklu `period`). Dla poświaty w SwiftUI (`EchoWaitShimmer`).
  static func bandStart(at time: Double) -> Double {
    let elapsed = time.truncatingRemainder(dividingBy: period)
    guard elapsed < sweep else { return 1 }
    let progress = elapsed / sweep
    let eased = progress * progress * (3 - 2 * progress)
    return -0.6 + 1.6 * eased
  }
}

#if os(iOS)
import SwiftUI
import UIKit

/// The glow of a queued entry's plate: a light band flows over the plate's BACKGROUND, as in a loading skeleton.
/// No status row under the plate: a row would add height and vanish with the echo, so the transcript would jump.
/// The text stays dimmed. Reduce Motion: no band, only the dimming.
/// The band flows while the entry waits for its echo — also in the CLI queue, sometimes for minutes.
/// „Nie potwierdzono” and a refusal — no band. Ruch jest
/// spokojny, z przerwą między przejściami, a wszystkie dymki płyną razem (``PlateShimmerClock``).
@MainActor
final class PlateShimmer {
  static let animationKey = "plateShimmer"
  /// Pasmo (brzeg, szczyt, brzeg) w ułamkach szerokości dymku: startuje przed lewą krawędzią, kończy za prawą,
  /// więc w przerwie między przejściami go nie widać.
  static let startLocations: [NSNumber] = [-0.6, -0.3, 0]
  static let endLocations: [NSNumber] = [1, 1.3, 1.6]

  let layer = CAGradientLayer()

  init() {
    // Lekki skos: pasmo idzie jak odblask, nie jak pionowa kreska.
    layer.startPoint = CGPoint(x: 0, y: 0.35)
    layer.endPoint = CGPoint(x: 1, y: 0.65)
    layer.locations = Self.startLocations
    layer.isHidden = true
  }

  /// Pasmo płynie tylko po dymku w locie, w oknie i bez ograniczonego ruchu.
  static func runs(inFlight: Bool, inWindow: Bool, reduceMotion: Bool) -> Bool {
    inFlight && inWindow && !reduceMotion
  }

  /// Włącza albo zdejmuje pasmo. Kolejne konfiguracje tej samej komórki nie zaczynają przejścia od nowa — inaczej
  /// każdy render transkryptu cofałby pasmo do lewej krawędzi. Nowe pasmo nie startuje od chwili dodania, tylko od
  /// początku cyklu wspólnego zegara (czas mediów), więc dołącza w fazie innych dymków.
  func update(running: Bool, traits: UITraitCollection) {
    layer.isHidden = !running
    guard running else {
      layer.removeAnimation(forKey: Self.animationKey)
      return
    }
    let peak = Palette.userPlateShimmer.resolvedColor(with: traits)
    layer.colors = [peak.withAlphaComponent(0).cgColor, peak.cgColor, peak.withAlphaComponent(0).cgColor]
    guard layer.animation(forKey: Self.animationKey) == nil else { return }
    let move = CABasicAnimation(keyPath: "locations")
    move.fromValue = Self.startLocations
    move.toValue = Self.endLocations
    move.duration = PlateShimmerClock.sweep
    move.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    let cycle = CAAnimationGroup()
    cycle.animations = [move]
    cycle.duration = PlateShimmerClock.period
    cycle.repeatCount = .infinity
    // Początek w czasie warstwy: granica cyklu wspólnego zegara, zwykle chwilę przed teraz, więc pasmo wchodzi
    // w trakcie przejścia, w tej samej fazie co pasma już płynące.
    cycle.beginTime = layer.convertTime(PlateShimmerClock.cycleStart(at: CACurrentMediaTime()), from: nil)
    // Zejście apki w tło zdejmuje animacje usuwalne po końcu — bez tego pasmo stałoby po powrocie.
    cycle.isRemovedOnCompletion = false
    layer.add(cycle, forKey: Self.animationKey)
  }

  /// Warstwa na całe tło dymku, bez niejawnej animacji ramki przy zmianie szerokości.
  func layout(_ bounds: CGRect) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.frame = bounds
    CATransaction.commit()
  }
}

/// Ta sama poświata na kaflu zdjęcia albo chipie pliku wpisu BEZ tekstu, który po 202 czeka na echo: pierścień
/// i przyciemnienie już zgasły, a dymka nie ma. Rytm, kolor i zegar jak ``PlateShimmer``
/// (czas mediów, ``PlateShimmerClock``), więc kafel płynie w fazie dymków; ograniczony ruch — bez pasma (czytnik
/// i tak słyszy „w drodze”).
struct EchoWaitShimmer: ViewModifier {
  let active: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content.overlay {
      if active && !reduceMotion {
        GeometryReader { proxy in
          // Harmonogram tylko budzi widok co klatkę; pozycję liczy wspólny zegar dymków, nie data klatki.
          TimelineView(.animation) { _ in
            let width = proxy.size.width
            LinearGradient(
              colors: [.clear, Color(uiColor: Palette.userPlateShimmer), .clear], startPoint: .leading, endPoint: .trailing)
              .frame(width: width * 0.6)
              .offset(x: PlateShimmerClock.bandStart(at: CACurrentMediaTime()) * width)
          }
        }
        .clipShape(RoundedRectangle.block)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
      }
    }
  }
}
#endif
