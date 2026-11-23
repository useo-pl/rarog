#if os(iOS)
import SwiftUI

/// Strona zgody przed włączeniem agenta głosowego (App Store 5.1.2(i)). Właściciel: agent głosowy. Mówi,
/// co idzie do OpenAI, dokąd, gdzie zostaje klucz, ile kosztuje pytanie i jaki limit ma nowe konto. „Zgadzam się
/// i włączam” zapisuje zgodę i wraca na stronę agenta; „Anuluj” i gest powrotu zostawiają przełącznik wyłączony.
struct VoiceAgentConsentPage: View {
  let model: VoiceAgentSettingsModel

  var body: some View {
    let content = model.consent()
    Form {
      Section {
        ForEach(content.paragraphs, id: \.self) { paragraph in
          Text(paragraph)
            .appFont(.callout)
            .foregroundStyle(Color(uiColor: Palette.text))
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .accessibilityIdentifier("voiceAgent.consent.text")
      Section {
        Button(content.accept) { model.acceptConsent() }
          .accessibilityIdentifier("voiceAgent.consent.accept")
        Button(content.cancel, role: .cancel) { model.cancelConsent() }
          .accessibilityIdentifier("voiceAgent.consent.cancel")
      }
    }
    .scrollContentBackground(.hidden)
    .background(Color(uiColor: Palette.background))
    .navigationTitle(content.title)
    .navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("voiceAgent.consent")
  }
}
#endif
