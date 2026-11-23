#if os(iOS)
import SwiftUI

/// The numbered setup steps (`ServerSetupSteps`) as rows of a form section: each step with its number and the commands
/// under it in a monospaced, selectable line, then the link to the provider's page. The link has its own identifier
/// and stays outside the combined steps, so VoiceOver reaches it as a link. Owner: settings.
struct ServerSetupStepsView: View {
  let setup: ServerSetupSteps
  /// Prefix of the identifiers: `<identifier>.steps` and `<identifier>.link`.
  let identifier: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(setup.steps.enumerated()), id: \.offset) { index, step in
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(verbatim: "\(index + 1).")
            .monospacedDigit()
            .foregroundStyle(Color(uiColor: Palette.muted))
          VStack(alignment: .leading, spacing: 4) {
            Text(step.text)
              .foregroundStyle(Color(uiColor: Palette.text))
            ForEach(step.commands, id: \.self) { command in
              Text(verbatim: command)
                .appFont(.caption.monospaced())
                .foregroundStyle(Color(uiColor: Palette.text))
                .textSelection(.enabled)
            }
          }
        }
        .appFont(.footnote)
      }
    }
    .fixedSize(horizontal: false, vertical: true)
    .padding(.vertical, 2)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("\(identifier).steps")
    Link(destination: setup.linkURL) {
      HStack {
        Text(setup.linkLabel).foregroundStyle(Color(uiColor: Palette.text))
        Spacer(minLength: 8)
        Image(systemName: "arrow.up.right")
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .accessibilityHidden(true)
      }
      .contentShape(Rectangle())
    }
    .accessibilityIdentifier("\(identifier).link")
  }
}
#endif
