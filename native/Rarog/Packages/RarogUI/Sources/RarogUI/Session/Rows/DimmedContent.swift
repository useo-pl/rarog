#if os(iOS)
import UIKit

// Przygaszenie transkryptu pod kartą decyzji. Właściciel: transkrypt.

extension TranscriptDim {
  /// Krycie wiersza z atramentem `ink` w bieżącym motywie: kolory z `Palette`, rozwiązane dla cech
  /// ekranu, więc zmiana motywu (przekonfigurowanie wszystkich komórek) liczy je od nowa.
  @MainActor
  static func alpha(_ ink: Ink, traits: UITraitCollection) -> CGFloat {
    // Wiersz `.text` pisze `text` (człowiek) albo ciemniejszą `prose` (agent): próg liczy się od ciemniejszej.
    let color = ink == .text ? Palette.prose : Palette.muted
    return CGFloat(alpha(ink: RGB(color, traits), background: RGB(Palette.background, traits)))
  }
}

extension TranscriptDim.RGB {
  init(_ color: UIColor, _ traits: UITraitCollection) {
    var (red, green, blue, alpha): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
    color.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    self.init(red: Double(red), green: Double(green), blue: Double(blue))
  }
}

/// Opakowanie konfiguracji wiersza tekstu, które mnoży jego krycie przez przygaszenie. Własny widok
/// treści wiersza zostaje nietknięty (ustawia własne `alpha` dla wpisu w locie) — dwa krycia się
/// mnożą, zamiast nadpisywać.
struct DimmedContentConfiguration: UIContentConfiguration {
  var base: any UIContentConfiguration
  var alpha: CGFloat

  func makeContentView() -> any UIView & UIContentView {
    DimmedContentView(configuration: self)
  }

  func updated(for state: any UIConfigurationState) -> DimmedContentConfiguration {
    var copy = self
    copy.base = base.updated(for: state)
    return copy
  }
}

final class DimmedContentView: UIView, UIContentView {
  private var inner: any UIView & UIContentView
  private var current: DimmedContentConfiguration

  var configuration: any UIContentConfiguration {
    get { current }
    set {
      guard let config = newValue as? DimmedContentConfiguration else { return }
      apply(config)
    }
  }

  init(configuration: DimmedContentConfiguration) {
    current = configuration
    inner = configuration.base.makeContentView()
    super.init(frame: .zero)
    install(inner)
    alpha = configuration.alpha
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  private func install(_ view: any UIView & UIContentView) {
    view.translatesAutoresizingMaskIntoConstraints = false
    addSubview(view)
    NSLayoutConstraint.activate([
      view.topAnchor.constraint(equalTo: topAnchor),
      view.bottomAnchor.constraint(equalTo: bottomAnchor),
      view.leadingAnchor.constraint(equalTo: leadingAnchor),
      view.trailingAnchor.constraint(equalTo: trailingAnchor),
    ])
  }

  private func apply(_ config: DimmedContentConfiguration) {
    current = config
    if inner.supports(config.base) {
      inner.configuration = config.base
    } else {
      inner.removeFromSuperview()
      inner = config.base.makeContentView()
      install(inner)
    }
    alpha = config.alpha
  }
}
#endif
