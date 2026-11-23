#if os(iOS)
import UIKit

// Długi prompt zwinięty do 6 linii: przycisk na dole dymka i zanik ostatniej
// widocznej linii. Rysuje je `MessageContentView`; regułę zwijania liczy model (`PromptFolds`). Właściciel:
// transkrypt.

/// „Pokaż całość · N linii” / „Zwiń” na dole dymka, pod tekstem: cichy napis (`footnote`, `muted`, pod wskaźnikiem
/// i palcem pełny tekst), z ikoną kierunku, od lewej krawędzi tekstu. Cel dotyku daje ramka (≥ 44 pt), szersza
/// w pionie niż wiersz napisu.
@MainActor
final class PromptFoldButton: UIButton {
  /// Odstęp ikony od napisu.
  static let imagePadding: CGFloat = 6

  /// Wskaźnik nad przyciskiem (`RarogHoverTracker`) — reakcją jest kolor, nie systemowa plama.
  private(set) var hover: RarogHoverTracker?

  /// Szerokość ikony z napisem „Pokaż całość · N linii” w piśmie z `traits` — najdłuższy z dwóch napisów. Dymek
  /// krótkich linii jest co najmniej tak szeroki, więc napis mieści się w nim i rozwinięcie dymku nie zwęża.
  static func showWidth(lines: Int, traits: UITraitCollection) -> CGFloat {
    let font = Fonts.text(.footnote, traits: traits)
    let title = (UICopy.promptFoldShow(lines: lines) as NSString).size(withAttributes: [.font: font]).width
    let symbol = UIImage.SymbolConfiguration(font: font, scale: .small)
    let image = UIImage(systemName: "chevron.down", withConfiguration: symbol)?.size.width ?? 0
    return (image + imagePadding + title).rounded(.up) + 1
  }

  init() {
    super.init(frame: .zero)
    var config = UIButton.Configuration.plain()
    config.contentInsets = .zero
    config.imagePadding = Self.imagePadding
    config.titleLineBreakMode = .byTruncatingTail
    configuration = config
    contentHorizontalAlignment = .leading
    configurationUpdateHandler = { [weak self] button in
      let lit = button.isHighlighted || (self?.hover?.hovering ?? false)
      button.configuration?.baseForegroundColor = lit ? Palette.text : Palette.muted
    }
    hover = RarogHoverTracker(view: self) { [weak self] _ in self?.setNeedsUpdateConfiguration() }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  /// Napis i ikona dla stanu zwinięcia, pismo z cech komórki (Dynamic Type).
  func show(_ fold: PromptFold, traits: UITraitCollection, identifier: String) {
    let title = fold.expanded ? UICopy.promptFoldHide : UICopy.promptFoldShow(lines: fold.lines)
    let font = Fonts.text(.footnote, traits: traits)
    configuration?.title = title
    configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
      var out = incoming
      out.font = font
      return out
    }
    configuration?.image = UIImage(systemName: fold.expanded ? "chevron.up" : "chevron.down")
    configuration?.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(font: font, scale: .small)
    accessibilityLabel = title
    accessibilityIdentifier = identifier
    setNeedsUpdateConfiguration()
  }
}

/// Zanik na dole okna zwiniętego promptu: od przezroczystego do koloru dymku. Bez dotyku i bez czytnika.
final class PromptFoldFade: UIView {
  override class var layerClass: AnyClass { CAGradientLayer.self }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  /// Kolor dymku rozwiązany dla bieżących cech (warstwa nie zna kolorów dynamicznych).
  func paint(_ color: UIColor) {
    (layer as? CAGradientLayer)?.colors = [color.withAlphaComponent(0).cgColor, color.cgColor]
  }
}
#endif
