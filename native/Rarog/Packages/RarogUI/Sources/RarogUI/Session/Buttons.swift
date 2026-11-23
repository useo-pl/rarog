#if os(iOS)
import GameController
import RarogContract
import RarogCore
import SwiftUI

// Przyciski kart i wierszy: zgoda wyłącznie gestem i style obrysu/wypełnienia.
// Wspólne dla obszarów; zmiana istniejącego stylu = zmiana u wszystkich.

/// Geometria przycisku stopki jak `.btn--foot` w PWA: kapsuła 36 pt dla oka, cel 44 pt dla palca
/// — brakujące 4 pt nad i pod kapsułą to przezroczysty odstęp, który przyjmuje dotyk.
enum FootButtonMetrics {
  static let visible: CGFloat = 36
  static let touchSlack: CGFloat = (44 - visible) / 2
  static let horizontalPadding: CGFloat = 14
  /// Odstęp tekstu od obrysu, gdy długa etykieta łamie się na linie.
  static let verticalPadding: CGFloat = 6
  /// Wnętrze kafla „zawsze” na karcie zgody (dwa wiersze w prostokącie `inner`).
  static let tileHorizontalPadding: CGFloat = 12
  static let tileVerticalPadding: CGFloat = 8
}

/// Kształt przycisku stopki: kapsuła (każdy przycisk) albo kafel — prostokąt `inner` dla opcji „zawsze” na karcie
/// zgody, której dwa wiersze w kapsule wyglądały jak pigułka z akapitem. Wypełnienie,
/// obrys i reakcja na wskaźnik (`ButtonHover`) biorą ten sam kształt.
struct FootButtonShape: InsettableShape {
  enum Kind: Sendable {
    case capsule
    case tile
  }

  let kind: Kind
  private var insetAmount: CGFloat = 0

  init(_ kind: Kind) {
    self.kind = kind
  }

  func path(in rect: CGRect) -> Path {
    switch kind {
    case .capsule: Capsule().inset(by: insetAmount).path(in: rect)
    case .tile: RoundedRectangle.inner.inset(by: insetAmount).path(in: rect)
    }
  }

  func inset(by amount: CGFloat) -> FootButtonShape {
    var copy = self
    copy.insetAmount += amount
    return copy
  }
}

/// Przycisk zgody — reaguje WYŁĄCZNIE na gest (``ApprovalGate``): dotyk i klik wskaźnikiem przez
/// `onTapGesture`, VoiceOver przez domyślną akcję dostępności (dwukrotne stuknięcie). Tę samą akcję
/// wyzwala Spacja w Full Keyboard Access i VO+Spacja z klawiatury sprzętowej — system nie mówi skąd,
/// więc przy podłączonej klawiaturze (i zawsze bez VoiceOvera) akcja jest obsłużona i POMINIĘTA
/// (obsłużona, żeby system nie dosłał w jej miejsce syntetycznego dotyku), a czytnik słyszy dlaczego.
/// Nie przyjmuje fokusu klawiatury. Wskaźnik nad przyciskiem zmienia WYŁĄCZNIE wygląd (`ButtonHover`), aktywacja
/// zostaje przy geście.
struct GestureOnlyButton: View {
  let title: String
  let fill: Color
  let text: Color
  /// Obrys (opcja eskalująca na karcie zgody): neutralny przycisk tej samej rangi co decyzja.
  var stroke: Color = .clear
  /// Kapsuła (każdy przycisk stopki) albo kafel `inner` (opcja „zawsze” na karcie zgody).
  var shape: FootButtonShape.Kind = .capsule
  /// Drugi, drobny wiersz pod tytułem (zakres reguły kafla „zawsze”): tekst `caption`
  /// w `muted2`, ścieżki (``AlwaysLabelParts/scopeRuns(_:)``) pismem stałej szerokości w `muted`; `nil` = sam tytuł.
  var detail: String?
  /// Nazwa dostępna, gdy ma powiedzieć więcej niż napis; `nil` = napis.
  var spoken: String?
  let action: () -> Void
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let outline = FootButtonShape(shape)
    VStack(alignment: .leading, spacing: 1) {
      Text(title)
        .appFont(.subheadline.weight(.semibold))
        .foregroundStyle(text)
      if let detail {
        Text(Self.scope(detail, typeSize))
      }
    }
    // Długa etykieta (dosłowna opcja eskalująca) łamie się, nigdy nie jest ucinana.
    .multilineTextAlignment(.leading)
    .fixedSize(horizontal: false, vertical: true)
    .padding(
      .horizontal, shape == .tile ? FootButtonMetrics.tileHorizontalPadding : FootButtonMetrics.horizontalPadding)
    .padding(.vertical, shape == .tile ? FootButtonMetrics.tileVerticalPadding : FootButtonMetrics.verticalPadding)
    .frame(minHeight: FootButtonMetrics.visible)
    .modifier(ButtonHover(kind: stroke == .clear ? .filled : .outline(stroke), enabled: true, shape: shape))
    .background(outline.fill(fill))
    .overlay(outline.strokeBorder(stroke, lineWidth: 1))
    .padding(.vertical, FootButtonMetrics.touchSlack)
    .contentShape(Rectangle())
    .onTapGesture { activate(.touchOrPointer) }
    .focusable(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(spoken ?? title)
    .accessibilityAddTraits(.isButton)
    .accessibilityAction { activate(.accessibilityActivation) }
  }

  /// Zakres reguły odcinkami: zwykły tekst `caption` w `muted2`, ścieżka `caption` stałej szerokości w `muted`.
  private static func scope(_ detail: String, _ typeSize: DynamicTypeSize) -> AttributedString {
    var out = AttributedString()
    for run in AlwaysLabelParts.scopeRuns(detail) {
      var piece = AttributedString(run.text)
      piece.setAppFont(run.isPath ? .caption.monospaced() : .caption, typeSize)
      piece.swiftUI.foregroundColor = Color(uiColor: run.isPath ? Palette.muted : Palette.muted2)
      out += piece
    }
    return out
  }

  private func activate(_ input: ApprovalInput) {
    let voiceOver = UIAccessibility.isVoiceOverRunning
    let keyboard = GCKeyboard.coalesced != nil
    if ApprovalGate.accepts(input, voiceOverRunning: voiceOver, hardwareKeyboard: keyboard) {
      action()
    } else if let refusal = ApprovalGate.refusalSpoken(input, voiceOverRunning: voiceOver, hardwareKeyboard: keyboard) {
      Announcer.shared.say(refusal)
    }
  }
}

/// Przycisk z obrysem: interfejs achromatyczny, reakcją na dotyk jest tło, nigdy skala. Pod wskaźnikiem
/// tło w kolorze obrysu 8 % (pod palcem 14 %), jak `.btn--deny:hover` w PWA.
struct OutlineButtonStyle: ButtonStyle {
  let color: Color

  func makeBody(configuration: Configuration) -> some View {
    StyledButton(
      configuration: configuration, fill: color.opacity(configuration.isPressed ? 0.14 : 0), text: color, stroke: color,
      hover: configuration.isPressed ? nil : .outline(color))
  }
}

/// Akcja główna prezentacji („Uruchom" w formularzu, „Zatwierdź" w dymku modelu) — najwyżej jedna na prezentację.
/// Wypełnienie atramentem tekstu, achromatycznie: bursztyn należy do „Wyślij", a w formularzu znaczy tryb
/// auto. Dwie geometrie: na całą szerokość 44 pt albo w linii 36 pt (cel dotyku 44 pt). Wciśnięcie: krycie 0,8;
/// wskaźnik: `inkFill`. Wygaszona NIE ma wypełnienia — obrys `border` i etykieta `muted2`: wypełnienie `surface2`
/// z obrysem wyglądałoby jak czynny przycisk neutralny.
struct PrimaryButtonStyle: ButtonStyle {
  enum Size {
    case fullWidth
    case inline
  }

  var size: Size = .fullWidth
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .appFont(.subheadline.weight(.semibold))
      .foregroundStyle(Color(uiColor: isEnabled ? Palette.background : Palette.muted2))
      .multilineTextAlignment(.center)
      .padding(.horizontal, 16)
      .frame(maxWidth: size == .fullWidth ? .infinity : nil, minHeight: size == .fullWidth ? 44 : 36)
      .modifier(ButtonHover(kind: configuration.isPressed || !isEnabled ? nil : .inkFill, enabled: isEnabled))
      .background(
        Capsule().fill(Color(uiColor: Palette.text).opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0)))
      .overlay(Capsule().strokeBorder(Color(uiColor: Palette.border)).opacity(isEnabled ? 0 : 1))
      .frame(minHeight: 44)
      .contentShape(Rectangle())
  }
}

/// Neutralny przycisk stopki („Nowa sesja” na karcie stanu): wypełnienie `surface2` z kreską `border`,
/// jak `.btn--foot` w PWA — ciszej od decyzji obok (obrys w kolorze tekstu był równie głośny jak „Odrzuć").
/// Pod wskaźnikiem kreska w kolorze tekstu, jak `.btn:hover` w PWA.
struct NeutralButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    StyledButton(
      configuration: configuration,
      fill: configuration.isPressed ? Color(uiColor: Palette.text).opacity(0.14) : Color(uiColor: Palette.surface2),
      text: Color(uiColor: Palette.text), stroke: Color(uiColor: Palette.border),
      hover: configuration.isPressed ? nil : .neutral)
  }
}

/// Przycisk wypełniony kolorem stanu („Zatwierdź" na zieleni pracy). Pod wskaźnikiem domieszka tekstu 14 %, jak
/// `.btn--accent:hover` w PWA; wypełniony atramentem tekstu (akcja główna) bierze `hover: .inkFill`.
struct FilledButtonStyle: ButtonStyle {
  let fill: Color
  let text: Color
  var hover: ButtonHover.Kind = .filled

  func makeBody(configuration: Configuration) -> some View {
    StyledButton(
      configuration: configuration, fill: fill.opacity(configuration.isPressed ? 0.8 : 1), text: text, stroke: .clear,
      hover: configuration.isPressed ? nil : hover)
  }
}

private struct StyledButton: View {
  let configuration: ButtonStyleConfiguration
  let fill: Color
  let text: Color
  let stroke: Color
  /// Reakcja na wskaźnik (`nil` pod palcem: wciśnięcie ma własne tło).
  var hover: ButtonHover.Kind?
  @Environment(\.isEnabled) private var enabled

  var body: some View {
    configuration.label
      .appFont(.subheadline.weight(.semibold))
      .foregroundStyle(text)
      .multilineTextAlignment(.leading)
      .padding(.horizontal, FootButtonMetrics.horizontalPadding)
      .padding(.vertical, FootButtonMetrics.verticalPadding)
      .frame(minHeight: FootButtonMetrics.visible)
      .modifier(ButtonHover(kind: hover, enabled: enabled))
      .background(Capsule().fill(fill))
      .overlay(Capsule().strokeBorder(stroke, lineWidth: 1))
      .padding(.vertical, FootButtonMetrics.touchSlack)
      .contentShape(Rectangle())
      .opacity(enabled ? 1 : 0.4)
  }
}

/// Wskaźnik nad kapsułą przycisku: obrys
/// w kolorze → jego tło 8 %, wypełniony kolorem → domieszka tekstu 14 %, wypełniony atramentem tekstu → domieszka
/// tła 12 %, neutralny → kreska w kolorze tekstu.
/// Stoi na etykiecie PRZED wypełnieniem kapsuły: warstwa leży między wypełnieniem a napisem, nie na napisie.
/// Kształt warstwy = kształt przycisku (`shape`: kapsuła albo kafel „zawsze”).
/// Tylko wygląd: gest, fokus i bramka zgody (``ApprovalGate``) bez zmian.
struct ButtonHover: ViewModifier {
  enum Kind {
    case outline(Color)
    case filled
    /// Wypełnienie atramentem tekstu (akcja główna): domieszka tła (`HoverTokens.inkFillMix`).
    case inkFill
    case neutral
  }

  let kind: Kind?
  let enabled: Bool
  var shape: FootButtonShape.Kind = .capsule

  func body(content: Content) -> some View {
    let outline = FootButtonShape(shape)
    return RarogHoverReader(enabled: enabled && kind != nil) { hovered in
      content
        .background {
          if hovered, let kind {
            switch kind {
            case let .outline(color): outline.fill(color.opacity(HoverTokens.outlineTint))
            case .filled: outline.fill(Color(uiColor: Palette.text).opacity(HoverTokens.filledMix))
            case .inkFill: outline.fill(Color(uiColor: Palette.background).opacity(HoverTokens.inkFillMix))
            case .neutral: outline.strokeBorder(Color(uiColor: Palette.text), lineWidth: 1)
            }
          }
        }
    }
  }
}
#endif
