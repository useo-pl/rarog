#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

/// Tokeny kolorów z `docs/design.md` jako dynamiczne kolory systemu: ciemny jest trybem
/// pierwszym, jasny idzie za ustawieniem systemu. Kreska `border`, `muted2` i `done` idą też za
/// „Zwiększ kontrast”; reszta tokenów ma jedną wartość na motyw. Interfejs jest achromatyczny —
/// kolor znaczy STAN, a akcentem jest tylko akcja domyślna „Wyślij".
public enum Palette {
  static func dynamic(dark: UInt32, light: UInt32, darkAlpha: CGFloat = 1, lightAlpha: CGFloat = 1) -> UIColor {
    UIColor { traits in
      traits.userInterfaceStyle == .light ? UIColor(hex: light, alpha: lightAlpha) : UIColor(hex: dark, alpha: darkAlpha)
    }
  }

  /// Kolor z pary tokenów (`PaletteTokens`).
  static func dynamic(_ pair: PaletteTokens.Pair) -> UIColor {
    dynamic(dark: pair.dark, light: pair.light)
  }

  /// Kolor z pary tokenów, który przy „Zwiększ kontrast” (`accessibilityContrast == .high`) bierze
  /// mocniejszą parę `high`. Warstwa z `CGColor` sama za tym nie idzie: rejestruje się na
  /// `UITraitAccessibilityContrast` obok `UITraitUserInterfaceStyle`.
  static func dynamic(_ pair: PaletteTokens.Pair, high: PaletteTokens.Pair) -> UIColor {
    UIColor { traits in
      let chosen = traits.accessibilityContrast == .high ? high : pair
      return UIColor(hex: traits.userInterfaceStyle == .light ? chosen.light : chosen.dark)
    }
  }

  static let background = dynamic(PaletteTokens.background)
  static let surface = dynamic(PaletteTokens.surface)
  /// Tło boków iPada: lista obok sesji i prawy panel (`--sidebar`).
  static let sidebar = dynamic(PaletteTokens.sidebar)
  static let surface2 = dynamic(PaletteTokens.surface2)
  /// Selection and touch plate of the stacked list (`PaletteTokens.stackedPlate`).
  static let stackedPlate = dynamic(PaletteTokens.stackedPlate)
  /// Zaznaczony wiersz okna przełącznika sesji.
  static let switcherSelection = dynamic(PaletteTokens.switcherSelection)
  static let text = dynamic(PaletteTokens.text)
  /// Tekst drugiego planu (nazwa skończonego zadania, nazwa pliku drzewa zmian w spoczynku).
  static let text2 = dynamic(PaletteTokens.text2)
  /// Proza odpowiedzi agenta i jej pogrubienie z nagłówkami.
  static let prose = dynamic(PaletteTokens.prose)
  static let strong = dynamic(PaletteTokens.strong)
  static let muted = dynamic(PaletteTokens.muted)
  static let muted2 = dynamic(PaletteTokens.muted2, high: PaletteTokens.muted2High)
  /// Track of a switch that is on (`PaletteTokens.switchOn`), one value per theme.
  static let switchOn = dynamic(PaletteTokens.switchOn)
  static let listHeaderInk = dynamic(PaletteTokens.listHeaderInk)
  /// Atrament wiersza bezczynnego — świadomie poniżej AA: bezczynny wiersz ma być mocno wygaszony.
  static let idleInk = dynamic(PaletteTokens.idleInk)
  /// Kreska (włos, obrys, separator): biel w ciemnym, czerń w jasnym, w kryciu `PaletteTokens.borderAlpha`; przy
  /// „Zwiększ kontrast” `borderAlphaHigh`.
  static let border = UIColor { traits in
    let alpha = traits.accessibilityContrast == .high ? PaletteTokens.borderAlphaHigh : PaletteTokens.borderAlpha
    return traits.userInterfaceStyle == .light
      ? UIColor(hex: 0x000000, alpha: CGFloat(alpha.light)) : UIColor(hex: 0xFFFFFF, alpha: CGFloat(alpha.dark))
  }
  /// Kreska obrysowanej kontrolki pod wskaźnikiem: atrament `border` w kryciu `HoverTokens.outlineStroke`.
  static let hoverStroke = dynamic(
    dark: 0xFFFFFF, light: 0x000000, darkAlpha: HoverTokens.outlineStroke, lightAlpha: HoverTokens.outlineStroke)

  /// Wypełnienie kolorem stanu pod wskaźnikiem: domieszka atramentu tekstu (`HoverTokens.filledMix`), jak „Zatwierdź”
  /// na kartach — w ciemnym jaśniej, w jasnym ciemniej.
  static func filledHover(_ fill: PaletteTokens.Pair) -> UIColor {
    dynamic(
      dark: PaletteTokens.over(PaletteTokens.text.dark, alpha: HoverTokens.filledMix, on: fill.dark),
      light: PaletteTokens.over(PaletteTokens.text.light, alpha: HoverTokens.filledMix, on: fill.light))
  }
  static let input = dynamic(PaletteTokens.input)
  static let composerRest = dynamic(PaletteTokens.composerRest)
  static let micPlate = dynamic(PaletteTokens.micPlate)
  static let micPlateLive = dynamic(PaletteTokens.micPlateLive)
  static let ahead = dynamic(PaletteTokens.ahead)
  static let behind = dynamic(PaletteTokens.behind)
  /// Plama wiadomości człowieka: ciepły szary (5 % bursztynu), nigdy kolor stanu.
  static let userPlate = dynamic(PaletteTokens.userPlate)
  /// Dymek pod palcem (pasek cytatu promptu).
  static let userPlatePressed = dynamic(PaletteTokens.userPlatePressed)
  /// Szczyt pasma poświaty dymka w locie (`PlateShimmer`): biel nad dymkiem, brzegi pasma to ta sama biel w zerowym
  /// kryciu. Cały wiersz w locie ma krycie 0,55, więc na ekranie pasmo jest o połowę słabsze.
  static let userPlateShimmer = dynamic(dark: 0xFFFFFF, light: 0xFFFFFF, darkAlpha: 0.18, lightAlpha: 0.6)
  static let codeBackground = dynamic(dark: 0xFFFFFF, light: 0x000000, darkAlpha: 0.06, lightAlpha: 0.05)
  /// Kod w linii w transkrypcie (`CodeBlockTests`): wyraźniej niż `codeBackground` — przy 6 % „mało się odznacza
  /// od reszty tekstu”. Biel 13 % w ciemnym (na #0A0A0A ≈ #262626), czerń 8 % w jasnym.
  static let inlineCodeBackground = dynamic(
    dark: 0xFFFFFF, light: 0x000000, darkAlpha: CGFloat(PaletteTokens.inlineCodeFillAlpha.dark),
    lightAlpha: CGFloat(PaletteTokens.inlineCodeFillAlpha.light))
  /// Tło bloku kodu w transkrypcie — kryjące (linie bloku to osobne fragmenty układu, a nakładające
  /// się półprzezroczyste tła dawały szwy między liniami).
  static let codeBlockFill = dynamic(PaletteTokens.codeBlockFill)
  /// Tło bloku kodu w dymku człowieka (jasny: biel 50 % nad dymkiem).
  static let codeInPlateFill = dynamic(PaletteTokens.codeInPlateFill)
  static let inlineCodeInk = dynamic(PaletteTokens.inlineCodeInk)
  /// Glif notatki projektu z treścią: bursztyn z rodziny kodu w linii, nie `wait`.
  static let noteInk = dynamic(PaletteTokens.noteInk)
  /// Płytka bieżącej zakładki paska (`TabTokens.plate`, kolor zaznaczonego wiersza listy).
  static let tabPlate = dynamic(TabTokens.plate)
  /// The `err` wash under the armed "×" of the current tab (`TabTokens.closeArmedWashAlpha`).
  static let tabCloseWash = dynamic(
    dark: PaletteTokens.err.dark, light: PaletteTokens.err.light,
    darkAlpha: CGFloat(TabTokens.closeArmedWashAlpha.dark), lightAlpha: CGFloat(TabTokens.closeArmedWashAlpha.light))
  static let linkInk = dynamic(PaletteTokens.linkInk)

  static let wait = dynamic(PaletteTokens.wait)
  static let run = dynamic(PaletteTokens.run)
  static let err = dynamic(PaletteTokens.err)
  static let new = dynamic(PaletteTokens.new)
  /// Background of the prompt the voice conversation just wrote into the message field (fades after a few seconds).
  static let promptHighlight = dynamic(
    dark: PaletteTokens.new.dark, light: PaletteTokens.new.light, darkAlpha: 0.14, lightAlpha: 0.10)
  static let done = dynamic(PaletteTokens.done, high: PaletteTokens.doneHigh)
  static let runSmoked = dynamic(PaletteTokens.runSmoked)
  static let accent = wait
  /// Tekst na wypełnieniu kolorem stanu („Zatwierdź" na zieleni).
  static let onState = dynamic(PaletteTokens.onState)

  static func tone(_ tone: StatusTone) -> UIColor {
    switch tone {
    case .working: run
    case .waiting: wait
    case .failed: err
    case .unread: new
    case .quiet: done
    case .backgroundWait: runSmoked
    case .backgroundWaitLong: wait
    }
  }

  /// Tło szkła (pasek „na dół"): przy zmniejszonej przezroczystości pełne tło zamiast rozmycia. Pasek
  /// promptu stoi na pełnym dymku.
  static var glassFallback: UIColor { surface }

  // MARK: Kolory składni — tylko w bloku kodu i karcie narzędzia transkryptu

  private static let syntaxColors: [SyntaxClass: UIColor] = Dictionary(
    uniqueKeysWithValues: SyntaxClass.allCases.map { ($0, dynamic(PaletteTokens.syntax($0))) })

  /// Kolor klasy tokenu składni (``SyntaxHighlight``).
  static func syntax(_ kind: SyntaxClass) -> UIColor {
    syntaxColors[kind] ?? text
  }
}

extension UIColor {
  convenience init(hex: UInt32, alpha: CGFloat = 1) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: alpha)
  }
}

/// The app's UIKit fonts on both paths of the text size contract (`TextStyleScaling`). The standard path (iPad,
/// iPhone) builds a weighted or monospaced face at the default size (Large) and scales it by the style's metrics, so
/// the font carries its text style and a label with `adjustsFontForContentSizeCategory` follows a size change by
/// itself (a font with a bare `pointSize` would stay put). The flat path (the iPad app on a Mac, where every text
/// style has one size) takes the size from the table at the model's category (``category``); there the views set
/// their fonts again after a step (``follow(_:_:)``).
enum Fonts {
  /// The text size UIKit views follow. Tests of live views put a model on scratch `UserDefaults` here and restore
  /// `.shared` afterwards.
  @MainActor static var scale: TextScale = .shared

  /// The category UIKit fonts take on the flat path: the effective size of ``scale``. The standard path does not read
  /// it (`TextStyleScaling` scales by the traits there), so off the flat path, and off the main thread where the
  /// model cannot be read, it is Large.
  static var category: TextSizeCategory {
    guard TextStyleScaling.isFlat, Thread.isMainThread else { return .large }
    return MainActor.assumeIsolated { scale.effective }
  }

  /// Etykieta sekcji („głos maszyny” PWA, `.eyebrow`): mono `caption1`, kapitaliki robi `Eyebrow.text`.
  static func eyebrow(traits: UITraitCollection? = nil) -> UIFont { mono(.caption1, weight: .medium, traits: traits) }

  static func mono(
    _ style: UIFont.TextStyle, weight: UIFont.Weight = .regular, traits: UITraitCollection? = nil,
    category: TextSizeCategory? = nil
  ) -> UIFont {
    TextStyleScaling.font(
      style, category: category ?? self.category, weight: weight, design: .monospaced, traits: traits)
  }

  static func text(
    _ style: UIFont.TextStyle, weight: UIFont.Weight? = nil, traits: UITraitCollection? = nil,
    category: TextSizeCategory? = nil
  ) -> UIFont {
    TextStyleScaling.font(style, category: category ?? self.category, weight: weight, traits: traits)
  }

  /// The point size of `style` at the default size (Large): the base a derived size (a heading at 1.25 em, the
  /// quote one point over `footnote`) starts from before ``scaled(_:relativeTo:traits:category:)``.
  static func base(_ style: UIFont.TextStyle) -> CGFloat {
    TextStyleScaling.font(
      style, category: .large, traits: UITraitCollection(preferredContentSizeCategory: .large), flat: false
    ).pointSize
  }

  /// `font`, given at the default size, at the text size: the style's metrics with `traits` on the standard path,
  /// the table ratio of the style at ``category`` on the flat path.
  static func scaled(
    _ font: UIFont, relativeTo style: UIFont.TextStyle, traits: UITraitCollection? = nil,
    category: TextSizeCategory? = nil
  ) -> UIFont {
    TextStyleScaling.font(font, relativeTo: style, category: category ?? self.category, traits: traits)
  }

  /// A length given at the default size, at the text size (row heights, gaps that grow with a style).
  static func scaled(
    _ value: CGFloat, relativeTo style: UIFont.TextStyle, traits: UITraitCollection? = nil,
    category: TextSizeCategory? = nil
  ) -> CGFloat {
    TextStyleScaling.scale(value, relativeTo: style, category: category ?? self.category, traits: traits)
  }

  /// Calls `action` after a step of ``scale`` on the flat path, for as long as `owner` lives. The standard path gets
  /// the step as a trait change of the view (the scene's override), which the system's adjustment and the views'
  /// trait handlers already follow; setting a font there again could read the traits before the change arrives.
  /// Registers nothing on the standard path: a registration holds `action` until the next step, so views there would
  /// pile them up for a step that may never come.
  @MainActor static func follow(
    _ owner: AnyObject, scale: TextScale? = nil, _ action: @escaping @MainActor @Sendable () -> Void
  ) {
    guard TextStyleScaling.isFlat else { return }
    TextScaleObservation.follow(owner, scale: scale ?? self.scale) {
      guard TextStyleScaling.isFlat else { return }
      action()
    }
  }
}

/// Etykieta sekcji jak `.eyebrow` w PWA: mono, kapitaliki, rozstrzelenie 0,08 em, wyciszony atrament.
/// Jeden styl na wszystkie etykiety („AGENCI (9)”, „PROJEKTY”, „ZGODA · RYZYKOWNA”, „TOKEN”) kart, dymków
/// i inspektora. Nagłówki `Section` formularzy są systemowe, jak w Ustawieniach.
/// Pismo `.caption` (nie `caption2`: stałe 11 pt do Large, strażnik `DynamicTypeSourceTests`), więc rośnie
/// z Dynamic Type. Kapitaliki są tylko wizualne: czytnik dostaje zdanie zwykłą wielkością liter.
enum Eyebrow {
  /// Rozstrzelenie 0,08 em przy 12 pt (`caption1` w Large).
  static let tracking: CGFloat = 0.96
  /// Rozmiar `caption1` w Large — punkt odniesienia dla większych etykiet.
  static let baseSize: CGFloat = 12
  /// Etykiety sekcji prawego panelu („W tle", „Skończone ostatnio", „Zmiany w katalogu"): 14 pt przy domyślnym
  /// piśmie, 2 pt więcej niż reszta etykiet. Rośnie i maleje z Dynamic Type jak `caption`:
  /// przy piśmie systemu poniżej domyślnego zwykła etykieta ma 11 pt, a ta 13.
  static let panelSize: CGFloat = 14

  /// Napis do etykiety UIKit: wielkie litery i rozstrzelenie; kolor domyślnie `muted`.
  static func text(_ value: String, color: UIColor = Palette.muted) -> NSAttributedString {
    NSAttributedString(string: value.uppercased(with: CopyLocale.current), attributes: [
      .font: Fonts.eyebrow(), .kern: tracking, .foregroundColor: color,
    ])
  }
}

private struct EyebrowStyle: ViewModifier {
  var color: UIColor
  /// Rozmiar przy domyślnym piśmie; `nil` = `caption` (12 pt).
  var size: CGFloat?
  /// Ten sam rozmiar po Dynamic Type stylu `caption`. Skalowany jest ROZMIAR, nie mnożnik: mnożnik „1" system
  /// zaokrągla do piksela i przy piśmie poniżej domyślnego zostaje jedynką, więc etykieta stałaby na pełnych
  /// 14 pt obok zwykłych po 11.
  @AppScaledMetric private var scaled: CGFloat

  init(color: UIColor, size: CGFloat?) {
    self.color = color
    self.size = size
    _scaled = AppScaledMetric(wrappedValue: size ?? Eyebrow.baseSize, relativeTo: .caption)
  }

  /// The larger label: a fixed face at the scaled size.
  private var sizedFont: Font { .system(size: scaled, weight: .medium, design: .monospaced) }

  @ViewBuilder private func styled(_ content: Content) -> some View {
    if size != nil {
      content.font(sizedFont)
    } else {
      content.appFont(.caption.monospaced().weight(.medium))
    }
  }

  func body(content: Content) -> some View {
    styled(content)
      .textCase(.uppercase)
      .tracking(Eyebrow.tracking * (size ?? Eyebrow.baseSize) / Eyebrow.baseSize)
      .foregroundStyle(Color(uiColor: color))
  }
}

extension View {
  /// Etykieta sekcji w stylu PWA (`Eyebrow`); `size` tylko tam, gdzie etykieta ma być większa niż `caption`.
  func eyebrow(_ color: UIColor = Palette.muted, size: CGFloat? = nil) -> some View {
    modifier(EyebrowStyle(color: color, size: size))
  }
}
#endif
