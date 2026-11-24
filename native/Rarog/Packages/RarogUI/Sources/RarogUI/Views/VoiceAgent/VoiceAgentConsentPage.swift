#if os(iOS)
import SwiftUI

/// A consent page of the voice agent (App Store 5.1.2(i)). Owner: voice agent. One view for both consents: the voice
/// agent's (what goes to OpenAI, where, where the key stays, the cost of a question and the new account's limit) and
/// the mode across sessions' (what it adds). The accept button stores the consent; Cancel and the back gesture store
/// nothing. Settings push it over the Voice Agent page (`VoiceAgentSettingsPage`); the session list shows it in the
/// consent sheet (`VoiceAgentSessionsConsentSheet`).
struct VoiceAgentConsentPage: View {
  let content: VoiceAgentConsentContent
  /// Prefix of the accessibility identifiers: `voiceAgent.consent` or `voiceAgent.sessions.consent`.
  let identifier: String
  let accept: () -> Void
  let cancel: () -> Void

  var body: some View {
    Form {
      Section {
        ForEach(content.paragraphs, id: \.self) { paragraph in
          Text(paragraph)
            .appFont(.callout)
            .foregroundStyle(Color(uiColor: Palette.text))
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .accessibilityIdentifier("\(identifier).text")
      Section {
        Button(content.accept, action: accept)
          .accessibilityIdentifier("\(identifier).accept")
        Button(content.cancel, role: .cancel, action: cancel)
          .accessibilityIdentifier("\(identifier).cancel")
      }
    }
    .scrollContentBackground(.hidden)
    .background(Color(uiColor: Palette.background))
    .navigationTitle(content.title)
    .navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier(identifier)
  }
}
#endif
