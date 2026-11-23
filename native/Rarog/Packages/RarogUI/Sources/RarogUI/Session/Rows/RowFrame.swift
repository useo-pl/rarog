#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Rama wiersza transkryptu SwiftUI (`UIHostingConfiguration`): odstęp tury. Etykiet ról na ekranie nie ma —
// granicę tury niesie odstęp i dymek promptu. Właściciel: transkrypt.

/// The row wrapper: the turn gap (in Standard 32 pt above a prompt, 10 pt above a reply, 4 pt above photos under the
/// bubble; outside a turn boundary 12 pt at a voice change and 2 pt in a run of one voice; the density's tokens in
/// `TranscriptSpacing`). A row inside a card of adjacent tools has no gap to a neighbour of the same card: the card's
/// first row keeps its gap above the card, the last one the row's bottom margin under it.
struct RowFrame<Content: View>: View {
  let voice: VoiceLabel?
  var gap: TurnGap = .flow
  var chain: ToolChainPlace = .alone
  @ViewBuilder let content: Content
  @Environment(\.transcriptSpacing) private var spacing

  var body: some View {
    content
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, chain.joinsAbove ? 0 : Self.top(voice: voice, gap: gap, spacing: spacing))
      .padding(.bottom, chain.joinsBelow ? 0 : spacing.rowBottom)
  }

  /// The gap above the row: the turn boundary, or the row rule (a voice change, a run of one voice).
  static func top(voice: VoiceLabel?, gap: TurnGap, spacing: TranscriptSpacing) -> CGFloat {
    gap.points(spacing) ?? (voice == nil ? spacing.runTop : spacing.voiceChange)
  }
}

extension EnvironmentValues {
  /// The spacing tokens of the transcript's density; the session screen sets them on every hosted row.
  @Entry var transcriptSpacing: TranscriptSpacing = .standard
}

/// Godzina promptu pod jego zdjęciami (ostatni wiersz wiadomości człowieka to wiersz zdjęć): `caption` stałej
/// szerokości w `muted2`, jak godzina przy dymku (`MessageContentView`).
struct PromptClockView: View {
  let clock: String

  var body: some View {
    Text(verbatim: clock)
      .appFont(.caption.monospaced())
      .foregroundStyle(Color(uiColor: Palette.muted2))
      .accessibilityLabel(UICopy.promptClockSpoken(clock))
      .accessibilityIdentifier("transcript.promptClock")
  }
}
#endif
