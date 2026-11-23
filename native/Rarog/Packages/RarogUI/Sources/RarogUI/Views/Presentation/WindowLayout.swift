import CoreGraphics

// Geometria okien apki: duże arkusze z treścią do czytania albo pracy — terminal Cmd+F, lazygit Cmd+G,
// historia terminala i diff. Wszystkie mają tę samą szerokość: prawie całe okno APKI (nie kolumny szczegółu, która
// jest węższa o listę). Mierzy ją korzeń (`measuresAppWindowWidth()`); w Stage Managerze okno bywa węższe niż ekran
// — arkusz nigdy nie wychodzi poza okno. W klasie `compact` (iPhone, wąskie okno) rozmiar zostaje systemowy.
// Promień rogów arkusza jest systemowy (iPad 32 pt), więc treść trzyma odstęp od łuku rogu.
// Okno terminala (Cmd+F/Cmd+G) trzyma go bez zapasu (``terminalBottomInset(radius:)``): narożnik
// siatki może dotknąć łuku, a pas pod nią ma kolor dolnego wiersza.

/// Geometria okna — czyste funkcje (testy na macOS).
public enum WindowLayout {
  /// Odstęp arkusza od krawędzi okna z każdej strony.
  public static let windowMargin: CGFloat = 16
  /// Część szerokości okna, którą arkusz chce zająć…
  public static let widthFraction: CGFloat = 0.92
  /// …w tych granicach: poniżej lazygit się nie mieści, powyżej linie terminala są za długie do czytania.
  public static let widthRange: ClosedRange<CGFloat> = 720...1400
  /// Margines ramy wokół terminala w oknie Cmd+F/Cmd+G (boki i dół).
  public static let contentInset: CGFloat = 8
  /// Odstęp treści okna od jego bocznej krawędzi (tekst diffa, stopka historii, siatka terminala).
  public static let sideInset: CGFloat = 16
  /// Najmniejszy odstęp treści od dolnej krawędzi okna.
  public static let minimumBottomInset: CGFloat = 8
  /// Najmniejsza odległość narożnika treści od łuku rogu okna.
  public static let cornerGap: CGFloat = 6
  /// Dolny odstęp przewijanej treści okna (diff, stopka historii): narożnik treści stoi ``cornerGap`` od łuku
  /// rogu arkusza, który rysuje system (`Radius.systemSheet`).
  public static let scrollBottomInset = bottomInset(radius: Radius.systemSheet)

  /// Dolny odstęp terminala w oknie Cmd+F/Cmd+G:
  /// narożnik treści 16 pt od boku dotyka łuku rogu, ale go nie przekracza — bez zapasu od łuku i bez
  /// minimum ``minimumBottomInset``. iPad (promień 32 pt): 5 pt zamiast 12 pt. Historia i diff zostają przy
  /// ``bottomInset(radius:sideInset:gap:minimum:)`` z zapasem.
  public static func terminalBottomInset(radius: CGFloat) -> CGFloat {
    bottomInset(radius: radius, gap: 0, minimum: 0)
  }

  /// Szerokość arkusza dla okna o szerokości `window`; `nil` = rozmiar systemowy (`compact`, okno nieznane).
  /// `min(okno − 2 × 16; clamp(okno × 0,92; 720…1400))` — nigdy szerzej niż okno.
  public static func sheetWidth(window: CGFloat?, compact: Bool) -> CGFloat? {
    guard !compact, let window, window.isFinite, window > 0 else { return nil }
    let wanted = min(max(window * widthFraction, widthRange.lowerBound), widthRange.upperBound)
    return max(0, min(window - 2 * windowMargin, wanted))
  }

  /// Dolny odstęp, przy którym narożnik treści odsuniętej o `sideInset` od boku stoi co najmniej `gap` od łuku
  /// rogu o promieniu `radius` (łuk kołowy; krzywa ciągła systemu leży nieco dalej od narożnika, więc wynik
  /// jest bezpieczny). Nigdy mniej niż `minimum` (domyślnie ``minimumBottomInset``).
  public static func bottomInset(
    radius: CGFloat, sideInset: CGFloat = sideInset, gap: CGFloat = cornerGap,
    minimum: CGFloat = minimumBottomInset
  ) -> CGFloat {
    let reach = radius - gap
    let across = radius - sideInset
    // Treść poza strefą rogu w poziomie albo róg bez promienia: wystarczy odstęp podstawowy.
    guard radius.isFinite, radius > 0, reach > 0, across > 0 else { return minimum }
    // Wcięcie boczne nie większe niż wymagany zapas: narożnik musi wyjść nad całą strefę rogu i jeszcze odsunąć
    // się od KOŃCA łuku (punkt na krawędzi, na wysokości promienia).
    guard across < reach else {
      let past = max(0, gap * gap - sideInset * sideInset).squareRoot()
      return max(minimum, (radius + past).rounded(.up))
    }
    let needed = radius - (reach * reach - across * across).squareRoot()
    return max(minimum, needed.rounded(.up))
  }
}

#if os(iOS)
import SwiftUI

extension EnvironmentValues {
  /// Szerokość okna apki (scena), z korzenia (`measuresAppWindowWidth()`); `nil` = nie zmierzona.
  @Entry public var appWindowWidth: CGFloat? = nil
}

extension View {
  /// Mierzy szerokość widoku i podaje ją w dół jako ``EnvironmentValues/appWindowWidth``. Stawiać na widoku,
  /// który zajmuje CAŁE okno (korzeń sceny, podział lista ↔ szczegół).
  public func measuresAppWindowWidth() -> some View {
    modifier(AppWindowWidthReader())
  }
}

private struct AppWindowWidthReader: ViewModifier {
  @State private var width: CGFloat?

  func body(content: Content) -> some View {
    content
      .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
      .environment(\.appWindowWidth, width)
  }
}

/// Rozmiar arkusza okna: wysokość jak `.page`, szerokość z ``WindowLayout``; bez szerokości — całe `.page`.
struct WindowSizing: PresentationSizing {
  let width: CGFloat?

  func proposedSize(for root: PresentationSizingRoot, context: PresentationSizingContext) -> ProposedViewSize {
    let page = PagePresentationSizing.page.proposedSize(for: root, context: context)
    guard let width else { return page }
    return ProposedViewSize(width: width, height: page.height)
  }
}
#endif
