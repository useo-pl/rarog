#if os(iOS)
import UIKit

/// The "N new messages" pill: how many messages the reader missed. It stands at the top of the transcript, on the
/// column's axis, while the „NOWE" line lies above the screen; a tap scrolls to that line. It shows only when
/// something was missed and goes away once read.
///
/// Wygląd: materiał kółka „Przewiń na dół" (`JumpToBottomBar` — rozmycie i `surface2` w 55 %,
/// kreska `border`, cień, przy zmniejszonej przezroczystości pełne tło), napis i strzałka „↑" w błękicie `new` — tym,
/// którym linia „NOWE" i lista mówią „nieodebrane”. Wysokość z własnych stałych (``verticalInset`` wokół napisu
/// `footnote`). Cel dotyku
/// 44 pt przy niższej kapsule.
///
/// Po prawej, za cienką kreską, „×”: zamyka pigułkę i oznacza wiadomości jako przeczytane
/// (``onDismiss``). Czytnik dostaje to samo jako akcję pigułki — przycisk w przycisku nie
/// jest osobnym elementem dostępności. Właściciel: transkrypt.
final class NewMessagesPill: UIButton {
  private let reduceTransparency: () -> Bool
  /// Liczba na pigułce; 0 = jeszcze bez napisu.
  private(set) var count = 0
  /// „×”: zamknięcie i „przeczytane” (ekran sesji, `dismissNewLine`).
  var onDismiss: (() -> Void)?
  let closeButton = NewPillCloseButton()
  private let divider = UIView()
  /// Szerokość pola „×” na prawym końcu kapsuły.
  static let closeWidth: CGFloat = 30
  /// Odstęp napisu od kreski przed „×”.
  private static let dividerGap: CGFloat = 8
  /// Odstęp napisu od góry i dołu kapsuły (wysokość pigułki) i od jej lewego brzegu.
  static let verticalInset: CGFloat = 7
  static let leadingInset: CGFloat = 14

  override convenience init(frame: CGRect) {
    self.init(frame: frame, reduceTransparency: { UIAccessibility.isReduceTransparencyEnabled })
  }

  init(frame: CGRect, reduceTransparency: @escaping () -> Bool) {
    self.reduceTransparency = reduceTransparency
    super.init(frame: frame)
    var config = UIButton.Configuration.plain()
    config.cornerStyle = .capsule
    config.image = Self.arrow()
    config.imagePadding = 6
    config.contentInsets = NSDirectionalEdgeInsets(
      top: Self.verticalInset, leading: Self.leadingInset, bottom: Self.verticalInset,
      trailing: Self.dividerGap + 1 + Self.closeWidth)
    config.background.strokeColor = Palette.border
    config.background.strokeWidth = 1
    config.baseForegroundColor = Palette.new
    config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var out = attributes
      out.font = Fonts.text(.footnote, weight: .semibold)
      return out
    }
    configuration = config
    configurationUpdateHandler = { button in
      guard let pill = button as? NewMessagesPill else { return }
      pill.configuration?.background.backgroundColor = pill.fill(pressed: pill.isHighlighted)
    }
    JumpToBottomBar.lift(layer)
    applyGlass()
    buildClose()
    accessibilityIdentifier = "transcript.newPill"
    accessibilityTraits.insert(.button)
    accessibilityCustomActions = [
      UIAccessibilityCustomAction(name: UICopy.newPillDismiss) { [weak self] _ in
        self?.onDismiss?()
        return self != nil
      }
    ]
    alpha = 0
    isHidden = true
    NotificationCenter.default.addObserver(
      self, selector: #selector(applyGlass), name: UIAccessibility.reduceTransparencyStatusDidChangeNotification,
      object: nil)
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: NewMessagesPill, _: UITraitCollection) in
      self.updateShadow()
    }
    updateShadow()
    // A step on the flat path: the title's transformer reads the new size when the configuration is applied again.
    Fonts.follow(self) { [weak self] in
      guard let self else { return }
      self.configuration?.image = Self.arrow()
      self.setNeedsUpdateConfiguration()
      self.invalidateIntrinsicContentSize()
    }
  }

  /// The arrow before the title, as large as the title's text style.
  private static func arrow() -> UIImage? {
    let symbol =
      TextStyleScaling.isFlat
      ? UIImage.SymbolConfiguration(font: Fonts.text(.footnote), scale: .small)
      : UIImage.SymbolConfiguration(textStyle: .footnote, scale: .small)
    return UIImage(systemName: "arrow.up", withConfiguration: symbol)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  /// „×” na całą wysokość kapsuły, przed nim kreska `border` na połowę wysokości.
  private func buildClose() {
    closeButton.addAction(UIAction { [weak self] _ in self?.onDismiss?() }, for: .primaryActionTriggered)
    divider.backgroundColor = Palette.border
    divider.isUserInteractionEnabled = false
    for view in [divider, closeButton] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    NSLayoutConstraint.activate([
      closeButton.trailingAnchor.constraint(equalTo: trailingAnchor),
      closeButton.topAnchor.constraint(equalTo: topAnchor),
      closeButton.bottomAnchor.constraint(equalTo: bottomAnchor),
      closeButton.widthAnchor.constraint(equalToConstant: Self.closeWidth),
      divider.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor),
      divider.widthAnchor.constraint(equalToConstant: 1),
      divider.centerYAnchor.constraint(equalTo: centerYAnchor),
      divider.heightAnchor.constraint(equalTo: heightAnchor, multiplier: 0.5),
    ])
  }

  @objc private func applyGlass() {
    configuration?.background.visualEffect = JumpToBottomBar.blur(reduced: reduceTransparency())
    configuration?.background.backgroundColor = fill(pressed: isHighlighted)
  }

  private func fill(pressed: Bool) -> UIColor {
    JumpToBottomBar.fill(pressed: pressed, reduced: reduceTransparency())
  }

  private func updateShadow() {
    layer.shadowOpacity = JumpToBottomBar.shadowOpacity(traitCollection.userInterfaceStyle)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: bounds.height / 2).cgPath
    // Napis i tło konfiguracji przycisk dokłada jako własne podwidoki: „×” zostaje nad nimi.
    bringSubviewToFront(divider)
    bringSubviewToFront(closeButton)
  }

  /// Napis „7 nowych wiadomości"; czytnik słyszy jeszcze, co zrobi tap.
  func setCount(_ value: Int) {
    guard value != count else { return }
    count = value
    configuration?.title = UICopy.newPill(value)
    accessibilityLabel = UICopy.newPillSpoken(value)
  }

  /// Stan docelowy (animacja krycia bywa w połowie, gdy przychodzi zmiana zdania).
  private(set) var isShown = false

  /// Jak kółko „na dół": samo krycie, bez ruchu geometrii; `animated: false` (tap) staje od razu — informacją zwrotną
  /// jest ruch listy.
  func setShown(_ shown: Bool, animated: Bool = true) {
    guard animated else {
      isShown = shown
      layer.removeAllAnimations()
      alpha = shown ? 1 : 0
      isHidden = !shown
      return
    }
    guard shown != isShown else { return }
    isShown = shown
    if shown { isHidden = false }
    UIView.animate(withDuration: 0.15, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.alpha = shown ? 1 : 0
    } completion: { _ in
      if !self.isShown { self.isHidden = true }
    }
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    let grow = max(0, (44 - bounds.height) / 2)
    return bounds.insetBy(dx: 0, dy: -grow).contains(point)
  }
}

/// „×” pigułki: cichy glif `muted2`, pod wskaźnikiem w `text` (bez systemowego efektu), cel dotyku do 44 pt w pionie
/// jak sama pigułka.
final class NewPillCloseButton: UIButton {
  private(set) var hover: RarogHoverTracker?

  override init(frame: CGRect) {
    super.init(frame: frame)
    var config = UIButton.Configuration.plain()
    config.image = Self.glyph()
    config.contentInsets = .zero
    configuration = config
    isPointerInteractionEnabled = false
    configurationUpdateHandler = { [weak self] button in
      let lit = self?.hover?.hovering ?? false
      button.configuration?.baseForegroundColor = lit ? Palette.text : Palette.muted2
    }
    hover = RarogHoverTracker(view: self) { [weak self] _ in self?.setNeedsUpdateConfiguration() }
    accessibilityIdentifier = "transcript.newPill.close"
    // A step on the flat path, where no trait change comes: the glyph takes the new size.
    Fonts.follow(self) { [weak self] in
      self?.configuration?.image = Self.glyph()
      self?.invalidateIntrinsicContentSize()
    }
  }

  /// The "×" as large as the pill's title (`footnote`), like the arrow before the title.
  private static func glyph() -> UIImage? {
    let symbol =
      TextStyleScaling.isFlat
      ? UIImage.SymbolConfiguration(font: Fonts.text(.footnote), scale: .small)
      : UIImage.SymbolConfiguration(textStyle: .footnote, scale: .small)
    return UIImage(systemName: "xmark", withConfiguration: symbol)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    let grow = max(0, (44 - bounds.height) / 2)
    return bounds.insetBy(dx: 0, dy: -grow).contains(point)
  }
}
#endif
