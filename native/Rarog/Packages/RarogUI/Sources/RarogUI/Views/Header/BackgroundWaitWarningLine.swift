#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

// The warning line of a subagent that has waited long on its own command, in the place of the row's state line in
// the "in the background" section (popover and right panel): the mark of the stage in the warning colour, then
// "waiting 47m on: pgrep, sleep" in full text ink, and after an hour "since 20:33" quieter. The text and the reader's
// sentence come from `BackgroundWaitWarning`; the row speaks for the line (`BackgroundTaskRow.spoken`). Without contact
// with the source the mark fades like the row's own mark. Owner: header.
struct BackgroundWaitWarningLine: View {
  let warning: BackgroundWaitWarning
  let now: Date
  /// "since 20:33" after an hour of standby (`BackgroundTaskRow.since(now:)`).
  let since: String?
  let frozen: Bool

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      Image(systemName: warning.mark)
        .appFont(.caption.weight(.semibold))
        .imageScale(.small)
        .foregroundStyle(Color(uiColor: Palette.tone(frozen ? .quiet : warning.tone)))
        .accessibilityHidden(true)
      StateLine(parts: [StateLine.Part(text: warning.text(now: now), ink: Palette.text)]
        + (since.map { [StateLine.Part(text: $0, ink: Palette.muted2)] } ?? []))
    }
  }
}
#endif
