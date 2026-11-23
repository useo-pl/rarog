import CoreGraphics
import RarogCore

/// Pasek zakładek w nagłówku sesji: płytka bieżącej zakładki, kafelek z cyfrą skrótu Cmd i kwadracik bez cyfry —
/// wszystkie liczby wyglądu w jednym miejscu, żeby strojenie było zmianą jednej stałej (promienie stoją w skali
/// `Radius`, tu tylko odsyłacze). Bez drabiny pilności: znak stanu ma
/// kolor kropki z listy sesji. Czyste wartości, testowane na macOS
/// (`TabTokensTests`, kontrast cyfry: `PaletteContrastTests`); widok `Views/Projects/ProjectTabBar`. Właściciel:
/// projekty i zakładki.
public enum TabTokens {
  /// Krycie w obu motywach.
  public struct Alpha: Sendable, Equatable {
    public let dark: Double
    public let light: Double

    public init(dark: Double, light: Double) {
      self.dark = dark
      self.light = light
    }

    public static let opaque = Alpha(dark: 1, light: 1)
  }

  /// Atrament neutralnych wypełnień: biel w ciemnym motywie, czerń w jasnym (jak tło kodu w linii).
  public static let neutralInk = PaletteTokens.Pair(dark: 0xFFFFFF, light: 0x000000)

  // MARK: Płytka bieżącej zakładki

  /// Płytka w kolorze zaznaczonego wiersza agenta na liście (`surface2`, #1C1C1C / #F7F7FA; `SessionListView`).
  /// Pasek i lista stoją na tym samym tle (`background`), więc płytka wygląda jak zaznaczony wiersz.
  public static let plate = PaletteTokens.surface2
  /// Róg płytki (`Radius.inner`, 8 pt).
  public static let plateRadius = Radius.inner
  /// Płytka zostawia 6 pt nad dołem celu dotyku…
  public static let plateBottomInset: CGFloat = 6
  /// …i zaczyna się 10 pt pod jego górą: w celu 44 pt ma 28 pt i środek w osi etykiety, która stoi `tabLabelDrop`
  /// niżej środka celu. Płytka 36 pt (wstawki 6 pt i 2 pt) stała za blisko górnej linii.
  public static let plateTopInset: CGFloat = plateBottomInset + 2 * HeaderMetrics.tabLabelDrop

  // MARK: Wygaszenie krawędzi przewiniętego paska

  /// Szerokość wygaszenia przy krawędzi kolumny: tyle, ile margines tekstu nagłówka (16 pt). Bez niego
  /// zakładka urwana w pół litery przy krawędzi czytała się jak błąd renderu, nie jak „dalej jest więcej”. Wygaszenie
  /// stoi tylko po stronie, za którą chowa się treść.
  public static let edgeFadeWidth: CGFloat = HeaderMetrics.contentInset

  /// Krycie treści paska na obu krawędziach kolumny (1 = bez wygaszenia) i obszar bezpieczny za nimi: na iPadzie
  /// pasek sięga pod listę sesji, a treść scrolla zaczyna się za nią.
  public struct EdgeFade: Sendable, Equatable {
    public var leading: Double
    public var trailing: Double
    public var leadingInset: CGFloat
    public var trailingInset: CGFloat

    public static let off = EdgeFade(leading: 1, trailing: 1, leadingInset: 0, trailingInset: 0)
  }

  /// Krycie na krawędzi, za którą chowa się `hidden` pt treści: 1 bez schowanej treści, 0 od `edgeFadeWidth`, liniowo
  /// między nimi — wygaszenie narasta z przewinięciem, zamiast wskoczyć przy pierwszym punkcie.
  public static func edgeOpacity(hidden: CGFloat) -> Double {
    Double(1 - min(max(hidden, 0), edgeFadeWidth) / edgeFadeWidth)
  }

  /// Wygaszenie z geometrii przewinięcia: `offset` jak `contentOffset.x` (w spoczynku na początku `-leadingInset`),
  /// szerokość treści bez wcięć, szerokość widoku i wcięcia treści (obszar bezpieczny).
  public static func edgeFade(
    offset: CGFloat, contentWidth: CGFloat, containerWidth: CGFloat, leadingInset: CGFloat, trailingInset: CGFloat
  ) -> EdgeFade {
    let hiddenLeading = offset + leadingInset
    let hiddenTrailing = contentWidth + trailingInset - containerWidth - offset
    return EdgeFade(
      leading: edgeOpacity(hidden: hiddenLeading), trailing: edgeOpacity(hidden: hiddenTrailing),
      leadingInset: max(leadingInset, 0), trailingInset: max(trailingInset, 0))
  }

  // MARK: Kafelek z cyfrą (klawiatura sprzętowa)

  /// Kafelek w ciszy: neutralne wypełnienie jak klawisz (biel 13 %, czerń 8 %).
  public static let keyNeutralAlpha = Alpha(dark: 0.13, light: 0.08)

  /// Wygląd kafelka: wypełnienie, cyfra i jej waga.
  public struct KeyLook: Sendable, Equatable {
    /// Wypełnienie KRYJĄCE: kolor złożony na tle paska, więc na płytce bieżącej kafelek wygląda i kontrastuje tak
    /// samo jak u sióstr. Półprzezroczysty składa się z płytką: na płytce
    /// #2A2A2A / #DFDFE3 cyfra spada pod 4,5:1 (cisza w ciemnym 3,74:1, zieleń w jasnym 3,44:1).
    public let fill: PaletteTokens.Pair
    public let ink: PaletteTokens.Pair
    public let semibold: Bool
  }

  /// Cisza neutralnie (cyfra `muted`); każdy inny stan w kolorze kropki z listy sesji (`PaletteTokens.tone`, jak
  /// `SessionRow`) z cyfrą w kolorze tła (`onState`).
  public static func key(_ tone: StatusTone) -> KeyLook {
    guard tone != .quiet else {
      return KeyLook(
        fill: composite(neutralInk, keyNeutralAlpha, on: PaletteTokens.background), ink: PaletteTokens.muted,
        semibold: false)
    }
    // Na przydymionej zieleni biel w jasnym nie trzyma 4,5:1, więc cyfra jest ciemna w obu motywach.
    let ink = tone == .backgroundWait ? PaletteTokens.onRunSmoked : PaletteTokens.onState
    return KeyLook(fill: PaletteTokens.tone(tone), ink: ink, semibold: true)
  }

  // MARK: Kwadracik (bez cyfry)

  /// Bok kwadracika: stoi tam, gdzie kafelek, gdy cyfry nie ma (iPhone, iPad bez klawiatury, zakładka dziewiąta
  /// i dalsze poza ostatnią) — także w ciszy, żeby szerokość zakładki nie skakała przy zmianie stanu.
  public static let squareSide: CGFloat = 10
  /// Róg kwadracika (`Radius.tabSquare`, 2,5 pt).
  public static let squareRadius = Radius.tabSquare

  /// Wygląd kwadracika: kolor i krycie nad tym, co pod nim (tło paska albo płytka). Bez tekstu, więc bez progu
  /// kontrastu tekstu — a na płytce cichy kwadracik zostaje widoczny (kryjący miałby jej kolor i zostawiał dziurę).
  public struct SquareLook: Sendable, Equatable {
    public let color: PaletteTokens.Pair
    public let alpha: Alpha
  }

  /// Cisza neutralnie jak cichy kafelek, każdy inny stan w pełnym kolorze kropki z listy sesji (jak ``key(_:)``).
  public static func square(_ tone: StatusTone) -> SquareLook {
    tone == .quiet
      ? SquareLook(color: neutralInk, alpha: keyNeutralAlpha)
      : SquareLook(color: PaletteTokens.tone(tone), alpha: .opaque)
  }

  // MARK: Znak stanu przed etykietą („Rozróżniaj bez koloru”)

  /// Krycie znaku stanu siostry: bieżąca zakładka ma znak w pełnym kryciu.
  public static let siblingMarkAlpha = Alpha(dark: 0.7, light: 0.7)

  /// Krycie znaku stanu (`StateGlyph.mark`) nad tłem paska albo płytką. Przydymiona zieleń jest już
  /// przygaszona w samym kolorze: w 70 % dawałaby w jasnym ~2,15:1, poniżej 3:1 dla elementu stanu, więc jej znak
  /// stoi kryjąco także u siostry (`PaletteContrastTests`).
  public static func markAlpha(_ tone: StatusTone, current: Bool) -> Alpha {
    current || tone == .backgroundWait ? .opaque : siblingMarkAlpha
  }

  /// Kolor `top` w kryciu `alpha` na `bottom`, w obu motywach.
  public static func composite(_ top: PaletteTokens.Pair, _ alpha: Alpha, on bottom: PaletteTokens.Pair)
    -> PaletteTokens.Pair
  {
    PaletteTokens.Pair(
      dark: PaletteTokens.over(top.dark, alpha: alpha.dark, on: bottom.dark),
      light: PaletteTokens.over(top.light, alpha: alpha.light, on: bottom.light))
  }
}

/// Co stoi przed etykietą zakładki.
public enum TabMark: Sendable, Equatable {
  /// Zaproszenie terminala: nic (zakładki jeszcze nie ma).
  case none
  /// Kafelek z cyfrą skrótu Cmd.
  case key(Int)
  /// Kwadracik bez cyfry.
  case square
}

extension ProjectTabModel {
  /// Kafelek przy cyfrze skrótu, kwadracik bez niej, nic przy zaproszeniu terminala.
  public func mark(digit: Int?) -> TabMark {
    if case .invite = kind { return .none }
    return digit.map(TabMark.key) ?? .square
  }
}
