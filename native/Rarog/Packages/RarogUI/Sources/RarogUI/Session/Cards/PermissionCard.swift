import RarogContract
import RarogCore
#if os(iOS)
import SwiftUI

// Karta zgody w transkrypcie. Właściciel: karty.

/// Karta zgody i planu: nagłówek ze słownika, pełna komenda (albo plan)
/// pismem stałej szerokości z przewijaniem zamiast ucinania (komenda powłoki w kolorach składni), jedna
/// stopka od lewej: para „Zatwierdź” i „Odrzuć” w jednym wierszu, a pod nią, w osobnym wierszu, kafel opcji
/// eskalującej z dosłowną etykietą (gdy serwer ją poda). Zgoda i eskalacja tylko
/// gestem — żaden klawisz ich nie daje; Esc z fokusem na karcie = „Odrzuć" (kontroler transkryptu).
/// Karta kanału zgód dokłada pola wejścia i ostrzeżenie o sandboksie pod komendą i zdanie stanu od serwera.
/// Karta bez zgody ma samo „Odrzuć” i zdanie; przycisku, który pokazuje coś w herdr, nie ma.
/// Karta kanału, której hook już nie słucha, nie ma żadnego przycisku i stoi bez stopki.
struct PermissionCardView: View {
  let card: PermissionCardModel
  let decide: (PermissionDecision) -> Void
  /// Opens the window with the whole input (``PermissionCardModel/fullInput``); the card block shows a preview.
  var showFullInput: () -> Void = {}
  @Environment(\.horizontalSizeClass) private var sizeClass
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(\.decisionDockCeiling) private var dockCeiling
  @State private var commandHeight: CGFloat = 0

  var body: some View {
    // W doku (sufit) komenda, pola kanału i wycinek ekranu przewijają się między nagłówkiem a stopką
    // (`CardDockColumn`); bez sufitu karta stoi jak dotąd.
    CardDockColumn {
      header
    } content: {
      // Ostrzeżenie o wyłączonym sandboksie w doku otwiera przewijaną treść, nie stoi pod długimi polami: widać je
      // od razu. Nad stopką by nie weszło: przy piśmie dostępności samo z nagłówkiem i przyciskami przerasta sufit.
      if dockCeiling != nil, card.hookChannel, let warning = card.sandboxWarning {
        sandboxWarning(warning)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 12)
          .padding(.bottom, 8)
      }
      command
      if card.hookChannel { consentDetails }
      if card.approvalUnavailable != nil { denyOnly }
    } footer: {
      if let locked = card.lockedReason {
        Text(locked)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .padding(.horizontal, 12)
          .padding(.top, 8)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let hint = card.fullInputHint {
        // A long request: why the consent buttons below are greyed.
        Text(hint)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .padding(.horizontal, 12)
          .padding(.top, 8)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("card.fullInputHint")
      }
      footer
      CardResultLine(text: card.error, isError: true, identifier: "card.error")
      CardResultLine(text: card.error == nil ? card.note : nil, isError: false, identifier: "card.note")
    }
    .cardSurface()
    .padding(.vertical, 8)
    // Fokus klawiatury i Esc obsługuje komórka transkryptu (`SessionViewController+KeysCards`): SwiftUI
    // `.focusable()` w komórce `UICollectionView` fokusu z klawiatury nie dostaje.
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("card.permission.\(card.permId)")
  }

  private var header: some View {
    // Jeden wiersz, w którym kurczy się tylko metadana (nigdy rodzaj ani zegar); przy piśmie
    // dostępności — stos bez ucinania.
    let layout = typeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
    return layout {
      Text(card.eyebrow)
        .eyebrow(card.risky ? Palette.err : Palette.wait)
        .layoutPriority(2)
      meta
        .appFont(.footnote.monospaced())
        // W doku (sufit) metadana zostaje w jednej linii także przy piśmie dostępności: dwie linie ścieżki zjadały
        // miejsce treści pod sufitem; pełna ścieżka zostaje w etykiecie czytnika.
        .lineLimit(typeSize.isAccessibilitySize && dockCeiling == nil ? nil : 1)
        // Ryzykowna: nazwa narzędzia z przodu zostaje, kurczy się środek ścieżki (przy ucinaniu
        // od początku narzędzie znikało pierwsze w piśmie dostępności); sam katalog — koniec ścieżki zostaje.
        .truncationMode(card.risky ? .middle : .head)
        // Metadana bierze wolne miejsce przed `Spacer`.
        .layoutPriority(1)
      if !typeSize.isAccessibilitySize { Spacer(minLength: 4) }
      if let since = card.createdAt {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          Text(RelativeTime.short(since: since, now: context.date))
            .appFont(.footnote.monospaced())
            .monospacedDigit()
            .foregroundStyle(Color(uiColor: Palette.muted2))
        }
        .layoutPriority(2)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 12)
    .padding(.top, 10)
    .padding(.bottom, 8)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(card.spokenHeader)
    .accessibilityAddTraits(.isHeader)
  }

  /// Metadana nagłówka: przy ryzykownej nazwa narzędzia pogrubiona w kolorze tekstu (słowo
  /// „ryzykowna" w etykiecie nie mówi, czego dotyczy zgoda), za nią katalog wyciszony.
  private var meta: Text {
    let path = Text(verbatim: card.cwd).foregroundStyle(Color(uiColor: Palette.muted))
    guard card.risky else { return path }
    let tool = Text(verbatim: card.toolName).fontWeight(.semibold).foregroundStyle(Color(uiColor: Palette.text))
    return Text("\(tool) \(path)")
  }

  /// Sufit bloku w liniach (10, szeroko 16) rośnie razem z pismem. Plan to treść do
  /// PRZECZYTANIA przed zgodą: dostaje wyższy sufit, nadal z przewijaniem i wskaźnikiem.
  private var maxLines: Int { CardBlockCeiling.lines(readable: card.plan, regular: sizeClass == .regular) }

  private var command: some View {
    // The line height at the view's text size, not the system's: the ceiling grows with the text it holds.
    let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(typeSize))
    let size = Fonts.text(.footnote, traits: traits, category: TextSizeCategory(typeSize)).pointSize
    let font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    let ceiling = font.lineHeight * CGFloat(maxLines) + 16
    let visual = max(1, Int(((commandHeight - 16) / font.lineHeight).rounded()))
    return VStack(alignment: .leading, spacing: 4) {
      ScrollView(.vertical) {
        // Komenda powłoki w kolorach składni — wyłącznie tu, w bloku komendy na tle `input`; tekst zostaje
        // znak w znak, więc zaznaczanie i schowek widzą to samo co bez koloru. Bez tokenów: sam atrament tekstu.
        Text(SyntaxPaint.painted(card.command, syntax: card.commandSyntax))
          .appFont(.footnote.monospaced())
          .foregroundStyle(Color(uiColor: Palette.text))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(8)
          .fixedSize(horizontal: false, vertical: true)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { commandHeight = $0 }
      }
      .scrollIndicators(.visible)
      .frame(height: commandHeight == 0 ? nil : min(commandHeight, ceiling))
      .commandBlock()
      .accessibilityLabel(UICopy.permissionCommandSpoken(card.command, plan: card.plan))
      .accessibilityIdentifier("card.command")
      if let full = card.fullInput {
        // A long input (decision 4): the block holds a preview, the window the whole text.
        Button(UICopy.consentShowFullInput(lines: full.lines), action: showFullInput)
          .appFont(.footnote)
          .buttonStyle(.borderless)
          .tint(Color(uiColor: Palette.text))
          .accessibilityIdentifier("card.showFullInput")
      } else if commandHeight > ceiling {
        Text(UICopy.commandClipped(shown: maxLines, total: visual))
          .appFont(.caption.monospaced())
          .foregroundStyle(Color(uiColor: Palette.muted))
      }
    }
    .padding(.horizontal, 12)
  }

  /// Karta kanału: pola wejścia poza komendą, ostrzeżenie o wyłączonym sandboksie, zdanie stanu od serwera
  /// i — przy planie, który da się zatwierdzić — zdanie o powrocie do trybu sprzed planu.
  private var consentDetails: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(card.consentFields.enumerated()), id: \.offset) { _, field in
        Text(UICopy.consentField(name: field.name, value: field.value))
          .appFont(.footnote.monospaced())
          .foregroundStyle(Color(uiColor: Palette.muted))
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("card.consentField")
      }
      if dockCeiling == nil, let warning = card.sandboxWarning { sandboxWarning(warning) }
      if let note = card.planNote {
        Text(note)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("card.planNote")
      }
      if let status = card.consentStatus {
        Text(status)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("card.consentStatus")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 12)
    .padding(.top, 8)
  }

  private func sandboxWarning(_ warning: String) -> some View {
    Text(warning)
      .appFont(.footnote.weight(.semibold))
      .foregroundStyle(Color(uiColor: Palette.err))
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityIdentifier("card.sandboxWarning")
  }

  private var denyOnly: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(card.approvalUnavailable ?? UICopy.denyOnly)
        .appFont(.body)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .fixedSize(horizontal: false, vertical: true)
      if let screen = card.screen, !screen.isEmpty {
        ScreenBlockView(screen: screen)
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 8)
  }

  @ViewBuilder private var footer: some View {
    if card.lockedReason == nil, card.hasFooter {
      CardFooter(status: card.footerStatus, spacing: card.risky ? 24 : 8) {
        buttons
      }
    } else {
      Spacer().frame(height: 10)
    }
  }

  @ViewBuilder private var buttons: some View {
    // Fail-closed: przy `canAllow == false` przycisk NIE ISTNIEJE.
    if let primary = card.primaryDecision {
      // Zgoda NIE jest `Button`: systemowy przycisk aktywuje też Spacja/Enter z fokusem klawiatury
      // (Full Keyboard Access), a zgoda nie wychodzi żadnym klawiszem.
      // Plan z ekranu niesie pod tytułem dosłowną opcję auto; plan kanału zgód ma sam tytuł „Zatwierdź plan”.
      // A long request before its window: greyed, without fill, like a disabled primary
      // action (`PrimaryButtonStyle`); the controller refuses the consent as well.
      let autoPlan = card.plan && !card.hookChannel
      let locked = card.consentAwaitsFullInput
      GestureOnlyButton(
        title: autoPlan ? "\(card.allowTitle)\n\(card.alwaysLabel ?? "")" : card.allowTitle,
        fill: locked ? .clear : Color(uiColor: Palette.run),
        text: Color(uiColor: locked ? Palette.muted2 : Palette.onState),
        stroke: locked ? Color(uiColor: Palette.border) : .clear,
        spoken: autoPlan ? "\(card.allowTitle): \(card.alwaysLabel ?? "")" : nil
      ) {
        decide(.allow)
      }
      .disabled(locked)
      .sensoryFeedback(.success, trigger: card.phase == .sending(primary))
      .accessibilityIdentifier("card.allow")
    }
    // „Odrzuć" — obrys, nigdy wypełnienie: odmowa nie jest głośniejsza od zgody (docs/design.md). Karta kanału
    // ma je tylko, póki hook czeka na decyzję.
    if card.canDeny {
      Button(UICopy.deny) {
        decide(.deny)
      }
      .buttonStyle(OutlineButtonStyle(color: Color(uiColor: Palette.err)))
      .sensoryFeedback(.impact, trigger: card.phase == .sending(.deny))
      .accessibilityIdentifier("card.deny")
    }
    // „Yes, and don't ask again…": WŁASNY przycisk z dosłowną etykietą — człowiek czyta dokładnie to, co
    // zatwierdzi; etykieta łamie się, nigdy nie jest ucinana. Też tylko gestem. Kafel:
    // prostokąt `inner` ZAWSZE w osobnym wierszu pod parą, od lewej, szeroki na treść — długa etykieta nie
    // rozbija pary na iPhonie. Dwa wiersze: pogrubiony znany początek, pod nim drobno
    // zakres reguły ze ścieżkami skróconymi (`~`, `$TMPDIR`) pismem stałej szerokości; nieznany początek albo brak
    // zakresu — cała etykieta jednym wierszem. Czytnik słyszy etykietę dosłownie.
    if card.primaryDecision != nil, !card.plan, let always = card.alwaysLabel {
      // Karta kanału: nagłówek apki, pod nim dosłowne zmiany z celem zapisu (etykieta z `UICopy.consentAlways`).
      let parts = card.hookChannel
        ? AlwaysLabelParts.Parts(head: UICopy.consentAlwaysHead, scope: always) : AlwaysLabelParts.split(always)
      let locked = card.consentAwaitsFullInput
      GestureOnlyButton(
        title: parts?.head ?? always, fill: locked ? .clear : Color(uiColor: Palette.surface2),
        text: Color(uiColor: locked ? Palette.muted2 : Palette.text),
        stroke: Color(uiColor: Palette.border), shape: .tile, detail: parts?.scope,
        spoken: UICopy.alwaysSpoken(always)
      ) {
        decide(.allowAlways)
      }
      .disabled(locked)
      .sensoryFeedback(.success, trigger: card.phase == .sending(.allowAlways))
      .accessibilityIdentifier("card.allowAlways")
      .cardFooterNewLine()
    }
  }
}
#endif

extension PermissionCardModel {
  /// Stopka stoi, gdy ma przycisk albo wiersz stanu. Karta kanału, której hook już nie słucha (bez zgody i bez
  /// „Odrzuć”), stoi bez niej: pusta stopka z kreską wyglądałaby jak przycisk, który nie wczytał się.
  var hasFooter: Bool { primaryDecision != nil || canDeny || footerStatus != nil }

  /// Zdanie VoiceOver po przyjętej (200) zgodzie albo odmowie z tego urządzenia. Karta kanału mówi to samo co jej
  /// stopka (decyzja poszła), bo 200 nie znaczy, że hook odpowiedź odebrał; karta ekranowa — „Zatwierdzono.” albo
  /// „Odrzucono.”.
  func acceptedSpoken(_ choice: PermissionDecision) -> String {
    if hookChannel { return choice == .deny ? UICopy.consentDenySent : UICopy.consentAllowSent }
    return choice == .deny ? UICopy.deniedSpoken : UICopy.allowedSpoken
  }

  /// Zdanie informacyjne pod kartą po wyniku decyzji; `nil` = brak (błąd mówi `UICopy.decisionResult`). Karta kanału
  /// po 409 `conflict` zostaje (rdzeń, `finishDecision`), więc pod nią stoi „decyzja zapadła na innym urządzeniu”;
  /// karta ekranowa znika, a zdanie niesie jej ślad w transkrypcie.
  func decisionNote(_ outcome: DecisionOutcome) -> String? {
    hookChannel && outcome == .alreadyDecided ? UICopy.decidedElsewhere : nil
  }

  /// Wiersz stanu w miejscu stopki: co poszło, a po przyjęciu — na karcie ekranowej, że karta czeka na ekran,
  /// na karcie kanału, że decyzja z tego urządzenia poszła (stan kanału niesie `consentStatus`).
  /// `release` z apki nie wychodzi (kontroler go odrzuca), więc nie ma wiersza.
  var footerStatus: String? {
    switch phase {
    case .idle: return nil
    case let .sending(decision):
      switch decision {
      case .deny: return UICopy.denying
      case .allow: return UICopy.allowing
      case .allowAlways: return UICopy.allowingAlways(alwaysLabel ?? "")
      case .release: return nil
      }
    case let .sent(decision) where hookChannel && decision != .release:
      // Karta kanału: każda zgoda, także „zawsze”, to „zgoda wysłana” (200 nie znaczy, że hook ją odebrał).
      return decision == .deny ? UICopy.consentDenySent : UICopy.consentAllowSent
    case let .sent(decision):
      switch decision {
      case .deny: return UICopy.deniedWaiting
      case .allow: return UICopy.allowedWaiting
      case .allowAlways: return UICopy.allowedAlwaysWaiting(alwaysLabel ?? "")
      case .release: return nil
      }
    }
  }
}
