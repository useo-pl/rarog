#if os(iOS)
import SwiftUI

// Układ zwarty karty decyzji w doku (karta stoi w miejscu pola wiadomości).
// Właściciel: karty.

extension EnvironmentValues {
  /// Sufit wysokości CAŁEJ karty decyzji, gdy stoi w doku w miejscu pola. `nil` = karta w transkrypcie, bez sufitu,
  /// jak dotąd. Przy wartości nagłówek i stopka z przyciskami stoją zawsze w ramce karty, a treść między nimi
  /// (komenda, plan, pola kanału, sekcje pytania) przewija się wewnątrz karty, gdy się nie mieści.
  @Entry var decisionDockCeiling: CGFloat? = nil
}

/// Część przypięta karty w układzie zwartym (nagłówek albo zamknięcie z przyciskami). Wysokość naturalna, chyba że
/// układ karty przydzieli mniej (`DecisionDock.compactHeights`: same części przypięte nie mieszczą się pod sufitem,
/// duże pismo i niski sufit) — wtedy zajmuje przydział i przewija się w nim, więc przyciski i zdanie błędu zostają
/// osiągalne. Struktura (przewijany pojemnik) jest ta sama przy każdym suficie: zmiana sufitu nie zmienia tożsamości
/// widoków karty. Treść, która się mieści, nie przewija się ani nie odbija (`scrollBounceBehavior(.basedOnSize)`).
private struct DockPinned<Content: View>: View {
  let content: Content
  /// Wysokość treści zmierzona w karcie; 0 = przed pierwszym pomiarem.
  @State private var natural: CGFloat = 0

  var body: some View {
    // Wysokość naturalna części to wysokość treści zmierzona w karcie: `ScrollView` sam jej wiarygodnie nie podaje.
    DockPinnedLayout(natural: natural) {
      ScrollView(.vertical) {
        content
          .frame(maxWidth: .infinity, alignment: .leading)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { natural = $0 }
      }
      .scrollBounceBehavior(.basedOnSize)
      .scrollDismissesKeyboard(.never)
    }
  }
}

/// Wysokość części przypiętej: treść zmierzona (`natural`), najwyżej przydział układu karty; przed pierwszym pomiarem
/// wysokość, jaką podaje przewijany pojemnik.
private struct DockPinnedLayout: Layout {
  let natural: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let child = subviews.first else { return .zero }
    let measured = natural > 0
      ? natural : child.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil)).height
    return CGSize(width: proposal.width ?? child.sizeThatFits(.unspecified).width,
                  height: min(measured, proposal.height ?? .infinity))
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews.first?.place(
      at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
  }
}

extension View {
  /// Część przypięta karty w doku: nie wyższa niż przydział układu zwartego, w przydziale przewijana (`DockPinned`).
  func dockPinned() -> some View {
    DockPinned(content: self)
  }
}

extension DecisionDock {
  /// Wysokości trzech części karty pod sufitem (`compactHeights`) w punktach ekranu.
  static func compactHeights(_ natural: [CGFloat], ceiling: CGFloat) -> [CGFloat] {
    guard natural.count == 3 else { return natural }
    let split = compactHeights(
      header: Double(natural[0]), middle: Double(natural[1]), closing: Double(natural[2]), ceiling: Double(ceiling))
    return [CGFloat(split.header), CGFloat(split.middle), CGFloat(split.closing)]
  }
}
#endif
