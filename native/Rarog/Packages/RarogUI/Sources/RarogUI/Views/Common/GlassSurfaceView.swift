#if os(iOS)
import UIKit

// The floating glass card's material: system Liquid Glass `.regular`, the measured layer and tint
// (`Palette.glassCardLayer`, `glassCardTint`), the 1 px light edge (`glassCardEdge`), and with Reduce Transparency
// the full `glassCardSolid` background; with `castsShadow` a delicate shadow outside the card. The
// session foot is UIKit: the field card, the narrow activity card and the "1 of N" dock header stand on it. Content
// goes in as subviews above the material. Owner: send.

final class GlassSurfaceView: UIView {
  /// Corner radius, capped at half the height: a one-line surface is a capsule.
  var radius: CGFloat {
    didSet { setNeedsLayout() }
  }

  /// The light edge line; the disabled field hides it and draws its dashed outline instead.
  var showsEdge = true {
    didSet { applyEdge() }
  }

  private let glass = UIVisualEffectView()
  private let tone = UIView()
  /// The card's delicate shadow (`Palette.cardShadow`), masked to the outside of the card: the glass is translucent,
  /// so a shadow under it would darken what shows through. Only on a surface made with `castsShadow`.
  private let shadow = CAShapeLayer()
  private let shadowMask = CAShapeLayer()
  /// Reduce Transparency from the system; a test passes its own reading.
  private let reduceTransparency: () -> Bool

  init(
    radius: CGFloat, castsShadow: Bool = false,
    reduceTransparency: @escaping () -> Bool = { UIAccessibility.isReduceTransparencyEnabled }
  ) {
    self.radius = radius
    self.reduceTransparency = reduceTransparency
    super.init(frame: .zero)
    isAccessibilityElement = false
    for item in [glass, tone] {
      item.isUserInteractionEnabled = false
      item.frame = bounds
      item.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      addSubview(item)
    }
    if castsShadow {
      shadow.fillColor = nil
      shadow.shadowOpacity = 1
      shadow.shadowRadius = PaletteTokens.cardShadowRadius
      shadow.shadowOffset = CGSize(width: 0, height: PaletteTokens.cardShadowY)
      shadowMask.fillRule = .evenOdd
      shadow.mask = shadowMask
      layer.insertSublayer(shadow, at: 0)
    }
    NotificationCenter.default.addObserver(
      self, selector: #selector(applyMaterial), name: UIAccessibility.reduceTransparencyStatusDidChangeNotification,
      object: nil)
    // Layer colors from the view's traits, not `UITraitCollection.current`; the edge follows Increase Contrast.
    registerForTraitChanges([
      UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self, UITraitDisplayScale.self,
    ]) { (self: GlassSurfaceView, _: UITraitCollection) in
      self.applyMaterial()
    }
    applyMaterial()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let corner = min(radius, bounds.height / 2)
    for item in [self, tone] as [UIView] {
      item.layer.roundCorners(corner)
    }
    // The glass draws its own shape (a capsule by default): the corner configuration gives it the card's radius, so
    // the glass, the layer and the edge share one outline on a tall card too.
    glass.cornerConfiguration = .corners(radius: .fixed(Double(corner)))
    guard shadow.superlayer != nil else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let card = UIBezierPath(roundedRect: bounds, cornerRadius: corner)
    shadow.frame = bounds
    shadow.shadowPath = card.cgPath
    let reach = 4 * PaletteTokens.cardShadowRadius
    let outside = UIBezierPath(rect: bounds.insetBy(dx: -reach, dy: -reach))
    outside.append(card)
    shadowMask.path = outside.cgPath
    CATransaction.commit()
  }

  /// Glass with the layer over it, or the solid card with Reduce Transparency. The tint is resolved for the view's
  /// theme: an effect keeps the color it was given.
  @objc private func applyMaterial() {
    if reduceTransparency() {
      glass.effect = nil
      glass.isHidden = true
      tone.backgroundColor = Palette.glassCardSolid
    } else {
      let effect = UIGlassEffect(style: .regular)
      effect.tintColor = Palette.glassCardTint.resolvedColor(with: traitCollection)
      glass.effect = effect
      glass.isHidden = false
      tone.backgroundColor = Palette.glassCardLayer
    }
    shadow.shadowColor = Palette.cardShadow.resolvedColor(with: traitCollection).cgColor
    applyEdge()
  }

  /// One pixel of `glassCardEdge`, drawn over the glass and the layer (a layer's border lies above its sublayers).
  private func applyEdge() {
    layer.borderWidth = showsEdge ? 1 / max(1, traitCollection.displayScale) : 0
    layer.borderColor = Palette.glassCardEdge.resolvedColor(with: traitCollection).cgColor
  }
}
#endif
