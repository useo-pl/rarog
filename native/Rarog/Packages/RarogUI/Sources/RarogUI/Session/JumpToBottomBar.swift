#if os(iOS)
import UIKit

/// Kółko „Przewiń na dół": strzałka w kółku 36 pt, bez napisu, na osi kolumny (safe area, jak karta pola),
/// unosi się nad transkryptem i nie przesuwa układu.
/// Nazwę przycisku niosą `accessibilityLabel` i `largeContentTitle` (czytnik i duży podgląd przy dużym piśmie). Przy
/// stojącej decyzji poza dokiem nazwa to „Przewiń do decyzji”, a glif i obrys biorą kolor czekania — karta stoi na
/// dnie, więc skok w dół jest skokiem do niej; karta w doku decyzji stoi zawsze na ekranie, więc przy niej
/// kółko jest zwykłe (`finishReading`). Strzałki „↑" nie ma. Pigułka „N nowych
/// wiadomości" u góry transkryptu (`NewMessagesPill`) to osobna rzecz: stoi tylko, gdy linia „NOWE" leży nad
/// ekranem, i znika po doczytaniu. Cel dotyku 44 × 44 pt wokół kółka. Właściciel: transkrypt.
///
/// Materiał jak dymek PWA (`.jump-latest`, `--snack-bg`): rozmycie systemowe i na nim `surface2`
/// w 55 % krycia, kreska `border`, cień. Tło ZAWSZE jawnym kolorem: `nil` w tle konfiguracji przycisku
/// znaczy „kolor odcienia", a korzeń apki daje odcień w kolorze tekstu — na iPhonie
/// w ciemnym motywie kapsuła wyszłaby całkiem biała, z białym napisem. Ten sam materiał
/// niesie pigułka „N nowych": wartości stoją tu, jako statyczne.
final class JumpToBottomBar: UIButton {
  private(set) var decision = false
  /// Nazwa nadana (`setDecision`).
  private var named = false
  private let reduceTransparency: () -> Bool

  /// Średnica kółka i cel dotyku wokół niego.
  static let diameter: CGFloat = 36
  static let touchTarget: CGFloat = 44
  /// Glif strzałki: stały rozmiar, bo kółko ma stałą średnicę; przy dużym piśmie strzałkę i nazwę pokazuje duży
  /// podgląd (`largeContentTitle`).
  static let arrow = UIImage(
    systemName: "arrow.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))

  /// Wypełnienie kapsuły na szkle (`--snack-bg` w PWA: `surface-2` w 55 %), dynamiczne jak tokeny.
  static let glassFill = Palette.dynamic(
    dark: PaletteTokens.surface2.dark, light: PaletteTokens.surface2.light, darkAlpha: 0.55, lightAlpha: 0.55)

  /// Wypełnienie kapsuły: pełne `surface` przy zmniejszonej przezroczystości, inaczej `surface2` w 55 %
  /// na rozmyciu; pod palcem `surface2` kryjący (jak `--snack-bg-press`), reakcją jest tło, nie skala.
  static func fill(pressed: Bool, reduced: Bool) -> UIColor {
    if pressed { return Palette.surface2 }
    return reduced ? Palette.glassFallback : glassFill
  }

  /// Szkło, a przy zmniejszonej przezroczystości bez rozmycia.
  static func blur(reduced: Bool) -> UIVisualEffect? {
    reduced ? nil : UIBlurEffect(style: .systemThinMaterial)
  }

  /// Cień: kapsuła leży NAD treścią. Wąski i mocniejszy, w skali uniesienia „Wyślij” — szerokiego (promień 12, 30 %)
  /// na prawie czarnym tle ciemnego motywu nie widać.
  static func lift(_ layer: CALayer) {
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOffset = CGSize(width: 0, height: 3)
    layer.shadowRadius = 6
  }

  static func shadowOpacity(_ style: UIUserInterfaceStyle) -> Float {
    style == .light ? 0.12 : 0.5
  }

  override convenience init(frame: CGRect) {
    self.init(frame: frame, reduceTransparency: { UIAccessibility.isReduceTransparencyEnabled })
  }

  init(frame: CGRect, reduceTransparency: @escaping () -> Bool) {
    self.reduceTransparency = reduceTransparency
    super.init(frame: frame)
    var config = UIButton.Configuration.plain()
    config.cornerStyle = .capsule
    config.image = Self.arrow
    config.contentInsets = .zero
    config.background.strokeColor = Palette.border
    config.background.strokeWidth = 1
    configuration = config
    // Pod palcem kryjące `surface2` (jak `--snack-bg-press`): reakcją na dotyk jest tło.
    configurationUpdateHandler = { button in
      guard let bar = button as? JumpToBottomBar else { return }
      bar.configuration?.background.backgroundColor = bar.fill(pressed: bar.isHighlighted)
    }
    Self.lift(layer)
    applyGlass()
    accessibilityIdentifier = "transcript.jump"
    showsLargeContentViewer = true
    largeContentImage = Self.arrow
    scalesLargeContentImage = true
    addInteraction(UILargeContentViewerInteraction())
    setDecision(false)
    alpha = 0
    isHidden = true
    NotificationCenter.default.addObserver(
      self, selector: #selector(applyGlass), name: UIAccessibility.reduceTransparencyStatusDidChangeNotification,
      object: nil)
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: JumpToBottomBar, _: UITraitCollection) in
      self.updateShadow()
    }
    updateShadow()
  }

  /// Szkło, a przy zmniejszonej przezroczystości pełne tło.
  @objc private func applyGlass() {
    configuration?.background.visualEffect = Self.blur(reduced: reduceTransparency())
    configuration?.background.backgroundColor = fill(pressed: isHighlighted)
  }

  private func fill(pressed: Bool) -> UIColor {
    Self.fill(pressed: pressed, reduced: reduceTransparency())
  }

  private func updateShadow() {
    layer.shadowOpacity = Self.shadowOpacity(traitCollection.userInterfaceStyle)
  }

  override var intrinsicContentSize: CGSize { CGSize(width: Self.diameter, height: Self.diameter) }

  override func layoutSubviews() {
    super.layoutSubviews()
    layer.shadowPath = UIBezierPath(ovalIn: bounds).cgPath
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  /// Nazwa przycisku dla czytnika i dużego podglądu; decyzję oku pokazuje sam kolor glifu i obrysu (`wait`).
  /// Pierwsze wywołanie (z `init`) nadaje nazwę zawsze: `accessibilityLabel` przycisku bez własnej nazwy nie jest
  /// `nil`, tylko opisem symbolu strzałki („W dół”), więc nie nadaje się na znacznik „jeszcze bez nazwy”.
  func setDecision(_ on: Bool) {
    guard on != decision || !named else { return }
    named = true
    decision = on
    let name = UICopy.jumpLabel(decision: on)
    accessibilityLabel = name
    largeContentTitle = name
    configuration?.baseForegroundColor = on ? Palette.wait : Palette.text
    configuration?.background.strokeColor = on ? Palette.wait : Palette.border
  }

  /// Stan docelowy (animacja krycia bywa w połowie, gdy przychodzi zmiana zdania).
  private(set) var isShown = false

  /// Pokazanie i schowanie bez ruchu geometrii — samo krycie. `animated: false` (stuknięcie w kółko) przerywa
  /// trwające krycie i staje od razu: informacją zwrotną jest ruch listy, a zanikanie kapsuły ze szkłem równolegle
  /// z animowanym skokiem „haczy” na iPadzie (w symulatorze oba idą płynnie).
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

  /// Cel dotyku 44 × 44 pt: kółko 36 pt rośnie w obu osiach.
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    let dx = max(0, (Self.touchTarget - bounds.width) / 2)
    let dy = max(0, (Self.touchTarget - bounds.height) / 2)
    return bounds.insetBy(dx: -dx, dy: -dy).contains(point)
  }
}
#endif
