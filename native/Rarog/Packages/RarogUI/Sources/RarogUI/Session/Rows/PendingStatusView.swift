#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Status wpisu kolejki pod tekstem. Właściciel: wysyłka — wyjątek w `Rows/`, bo to stan kolejki.

/// The status of an outbox entry when the user has something to do: "Not confirmed." or "Sending stopped." with
/// Retry/Discard, or a refusal with its reason; and "Taking back…" without buttons under a queued entry while the
/// session's queue take-back waits for the server. Otherwise an entry in flight has no row: the glow of the bubble
/// tells about it (`PlateShimmer`).
struct PendingStatusView: View {
  let status: PendingStatus
  /// „Ponów" w toku — stan trzyma ekran sesji i zwalnia go po KAŻDYM wyniku (także odmowie dysku).
  let retrying: Bool
  /// Dlaczego „Ponów" teraz nie wyjdzie (sesja przed świeżym stanem); `nil` = wolno. Odczyt w body
  /// obserwuje także zmianę stanu po snapshotcie.
  let retryBlocked: () -> String?
  let retry: () -> Void
  let discard: () -> Void

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 12) { message; Spacer(minLength: 8); buttons }
      VStack(alignment: .leading, spacing: 6) { message; HStack(spacing: 12) { buttons } }
    }
    .padding(.top, 2)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("pending.status")
  }

  private var message: some View {
    Group {
      switch status {
      case .unconfirmed:
        Text(UICopy.unconfirmed)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .accessibilityLabel(UICopy.unconfirmedSpoken)
      case .stopped:
        // The user's own stop, not an error (red only for an error).
        Text(UICopy.sendStopped).foregroundStyle(Color(uiColor: Palette.muted))
      case .takingBack:
        // VoiceOver hears it in the label of the bubble above (`transcript.takingBackRolePrefix`), not twice.
        Text(UICopy.queuedTakingBack)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .accessibilityHidden(true)
      case let .refused(reason), let .refusedFinal(reason):
        Text(reason).foregroundStyle(Color(uiColor: Palette.err))
      }
    }
    .appFont(.footnote)
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityIdentifier("pending.message")
  }

  @ViewBuilder private var buttons: some View {
    // „Ponów" blokuje się od razu — drugie tapnięcie nic nie wysyła. Przy odmowie
    // ostatecznej (brak pliku treści, konflikt identyfikatora) „Ponów" nie istnieje. Przed świeżym
    // stanem sesji jest wyciszone, ale klikalne: tap i podpowiedź czytnika mówią dlaczego.
    switch status {
    case .takingBack:
      // Nothing to do while the take-back waits for the server: its answer ends the state either way.
      EmptyView()
    case .refusedFinal:
      discardButton
    case .unconfirmed, .stopped, .refused:
      let blocked = retryBlocked()
      Button(UICopy.retry, action: retry)
        .buttonStyle(OutlineButtonStyle(color: Color(uiColor: blocked == nil ? Palette.text : Palette.muted)))
        .disabled(retrying)
        .accessibilityHint(blocked ?? "")
        .accessibilityIdentifier("pending.retry")
      discardButton
    }
  }

  private var discardButton: some View {
    Button(UICopy.discard, action: discard)
      .buttonStyle(OutlineButtonStyle(color: Color(uiColor: Palette.text)))
      .accessibilityIdentifier("pending.discard")
  }
}
#endif
