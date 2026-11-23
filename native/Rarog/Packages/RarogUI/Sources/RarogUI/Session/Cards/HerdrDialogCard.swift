#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Karta „dialog w terminalu": rozpoznany dialog (zaufanie katalogu, zmiana modelu) z zatwierdzeniem
// drugim tapnięciem albo dialog, którego Rarog nie zna (także zgoda CLI) — wtedy samo
// „Odrzuć dialog". Właściciel: karty.

struct HerdrDialogCardView: View {
  let card: HerdrDialogCardModel
  let decide: (PermissionDecision) -> Void
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    // W doku (sufit) zdanie i wycinek ekranu przewijają się między nagłówkiem a stopką (`CardDockColumn`);
    // bez sufitu karta stoi jak dotąd.
    CardDockColumn {
      header
    } content: {
      Text(card.text)
        .appFont(.subheadline)
        .foregroundStyle(Color(uiColor: Palette.text))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 12)
        .accessibilityIdentifier("dialog.text")
      if let screen = card.screen {
        ScreenBlockView(screen: screen)
          .padding(.horizontal, 12)
          .padding(.top, 8)
      }
    } footer: {
      if let locked = card.lockedReason {
        Text(locked)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 12)
          .padding(.top, 8)
          .padding(.bottom, 10)
      } else {
        CardFooter(status: statusText) { buttons }
        CardResultLine(text: card.phase == .idle ? card.status : nil, isError: card.statusIsError, identifier: "dialog.result")
      }
    }
    .cardSurface()
    .padding(.vertical, 8)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("card.dialog")
  }

  private var header: some View {
    let layout = typeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
    return layout {
      Text(card.eyebrow)
        .eyebrow(Palette.wait)
        .fixedSize(horizontal: false, vertical: true)
        .layoutPriority(2)
      if !typeSize.isAccessibilitySize { Spacer(minLength: 4) }
      // Zegar liczy od wejścia sesji w bieżący stan — to jest właśnie „czeka od".
      if let since = card.since {
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
    .accessibilityLabel(card.eyebrow)
    .accessibilityAddTraits(.isHeader)
  }

  private var statusText: String? {
    switch card.phase {
    case .idle: nil
    case .sending(.deny): UICopy.dialogDenying
    case .sending: UICopy.allowing
    }
  }

  /// Odmowa po lewej, zatwierdzenie po prawej: ta sama mapa mięśniowa co na liście.
  @ViewBuilder private var buttons: some View {
    Button(card.denyLabel) { decide(.deny) }
      .buttonStyle(OutlineButtonStyle(color: Color(uiColor: Palette.err)))
      .disabled(card.channelDead)
      .sensoryFeedback(.impact, trigger: card.phase == .sending(.deny))
      .accessibilityIdentifier("dialog.deny")
    // Fail-closed: bez rozpoznanego dialogu przycisk NIE ISTNIEJE. Zatwierdza drugie tapnięcie —
    // skutek wychodzi poza sesję (zaufanie katalogu na zawsze, domyślny model konta) — i tylko gest.
    if let label = card.allowLabel {
      CardFooterSpacer()
      GestureOnlyButton(
        title: card.allowArmed ? UICopy.dialogConfirm : label,
        fill: Color(uiColor: Palette.run), text: Color(uiColor: Palette.onState),
        spoken: card.allowArmed ? "\(UICopy.dialogConfirm): \(label)" : label
      ) {
        decide(.allow)
      }
      .sensoryFeedback(.success, trigger: card.phase == .sending(.allow))
      .accessibilityIdentifier("dialog.allow")
    }
  }
}
#endif
