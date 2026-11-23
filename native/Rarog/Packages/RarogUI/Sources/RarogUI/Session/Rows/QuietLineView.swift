#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Właściciel: transkrypt.

/// Wyciszona linia transkryptu (blok nieobsługiwany, zdjęcie, załączniki, ślad karty).
struct QuietLineView: View {
  let voice: VoiceLabel?
  let text: String
  var identifier = "transcript.quiet"
  var gap: TurnGap = .flow
  /// Prompt z samym blokiem nieobsługiwanym: cecha nagłówka (raz na prompt) i godzina pod linią, jak przy zdjęciach.
  var header = false
  var clock: String?

  var body: some View {
    RowFrame(voice: voice, gap: gap) {
      VStack(alignment: .leading, spacing: 8) {
        Text(text)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier(identifier)
          .accessibilityAddTraits(header ? .isHeader : [])
        if let clock { PromptClockView(clock: clock) }
      }
    }
  }
}
#endif
