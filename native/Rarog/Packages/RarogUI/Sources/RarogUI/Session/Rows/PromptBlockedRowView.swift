#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Notka o prompcie zablokowanym przez hook `UserPromptSubmit` z przyciskiem „Uruchom ponownie i wyślij”.
// Model i reguły: `Model/PromptBlockedRows.swift`. Właściciel: transkrypt.

/// Notka: trójkąt w kolorze „czeka na Ciebie” (`wait`), stały tytuł atramentem tekstu, pod nim powód od hooka
/// i ewentualny cytat promptu wyciszonym atramentem, krojem notki (`footnote`) — do 8 linii, dłuższe zwinięte
/// „Pokaż całość”. Pod nią przycisk w obrysie (wzór: `PendingStatusView`), tylko gdy karta wskazuje tę notkę: w toku
/// mówi „Uruchamiam ponownie…”, odmowa stoi pod nim w `err`, a przycisk zostaje. Czerwień należy się tylko odmowie.
struct PromptBlockedRowView: View {
  let model: PromptBlockedRowModel
  let toggleFold: () -> Void
  let resend: (SessionPromptBlocked) -> Void

  var body: some View {
    RowFrame(voice: model.voice, gap: model.turn.gap) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: "exclamationmark.triangle")
          .imageScale(.small)
          .appFont(.subheadline)
          .foregroundStyle(Color(uiColor: Palette.wait))
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 4) {
          note
          if let fold = model.fold { foldButton(fold) }
          if let action = model.action { actionArea(action) }
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("promptBlocked.row")
    }
  }

  /// Tytuł z powodem i cytatem — dla czytnika jedno zdanie z „Uwaga”.
  private var note: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(UICopy.promptBlockedTitle)
        .appFont(.subheadline)
        .foregroundStyle(Color(uiColor: Palette.text))
        .fixedSize(horizontal: false, vertical: true)
      if !model.detail.isEmpty {
        Text(verbatim: model.detail)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .lineLimit(model.clipped ? PromptBlockedNote.visibleLines : nil)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(UICopy.promptBlockedSpoken(model.detail))
    .accessibilityIdentifier("promptBlocked.\(model.id)")
  }

  /// „Pokaż całość · N linii” ↔ „Zwiń” — ta sama reguła i te same słowa co pod długim promptem.
  private func foldButton(_ fold: PromptFold) -> some View {
    Button(action: toggleFold) {
      HStack(spacing: 6) {
        Text(fold.expanded ? UICopy.promptFoldHide : UICopy.promptFoldShow(lines: fold.lines))
        Image(systemName: fold.expanded ? "chevron.up" : "chevron.down")
          .appFont(.caption)
          .accessibilityHidden(true)
      }
      .appFont(.footnote)
      .foregroundStyle(Color(uiColor: Palette.muted))
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("promptBlocked.fold")
  }

  /// Jedno tapnięcie: bramki stanu (tura, pole na Macu, praca w tle) liczy serwer i odpowiada zdaniem.
  private func actionArea(_ action: PromptBlockedAction) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Button {
        resend(action.blocked)
      } label: {
        HStack(spacing: 6) {
          if action.restarting { ProgressView().controlSize(.mini) }
          Text(action.restarting ? UICopy.promptBlockedRestarting : UICopy.promptBlockedResend)
        }
      }
      .buttonStyle(OutlineButtonStyle(color: Color(uiColor: Palette.text)))
      .disabled(action.restarting)
      .accessibilityHint(action.restarting ? "" : UICopy.promptBlockedResendHint)
      .accessibilityIdentifier("promptBlocked.resend")
      if let error = action.error {
        Text(verbatim: error)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.err))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("promptBlocked.error")
      }
    }
    .padding(.top, 2)
  }
}
#endif
