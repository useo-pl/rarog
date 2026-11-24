#if os(iOS)
import UIKit

// The background of a code block in a message row, under the text. Owner: transcript, markdown.

/// Tło bloku kodu pod tekstem: kryjące `codeBlockFill` (w dymku człowieka `codeInPlateFill`), u góry pasek z językiem
/// (`barFill`) i włos pod nim. Kolory dynamiczne idą za motywem same. Nie łapie dotyku — zaznaczanie i ikona
/// kopiowania zostają tekstowi i przyciskowi nad nim.
final class CodeBlockBox: UIView {
  private let bar = UIView()
  private let hairline = UIView()

  /// Wysokość paska z językiem u góry pudełka (0 = bez paska).
  var barHeight: CGFloat = 0 {
    didSet { if oldValue != barHeight { setNeedsLayout() } }
  }

  /// Blok w dymku człowieka: w jasnym motywie jaśniejsze tło, które odcina się od dymku.
  var inPlate = false {
    didSet { backgroundColor = inPlate ? Palette.codeInPlateFill : Palette.codeBlockFill }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    backgroundColor = Palette.codeBlockFill
    layer.roundCorners(Radius.inner)
    clipsToBounds = true
    bar.backgroundColor = MarkdownColors.barFill
    hairline.backgroundColor = Palette.border
    addSubview(bar)
    addSubview(hairline)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    bar.frame = CGRect(x: 0, y: 0, width: bounds.width, height: barHeight)
    hairline.frame = CGRect(x: 0, y: barHeight - 0.5, width: bounds.width, height: 0.5)
    bar.isHidden = barHeight <= 0
    hairline.isHidden = barHeight <= 0
  }
}
#endif
