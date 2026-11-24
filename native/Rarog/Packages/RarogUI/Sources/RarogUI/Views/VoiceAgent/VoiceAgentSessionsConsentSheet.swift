#if os(iOS)
import RarogCore
import SwiftUI

/// The consent sheet of the voice conversation across sessions from the session list button. Owner: voice agent. One
/// form through `SheetHost`; the pages follow `VoiceAgentSessionsConsentFlow`: the voice agent's consent first when it
/// is off, then the mode's, swapped in place. The last consent closes the sheet and starts the conversation; Cancel,
/// the close button, Esc and the dismiss gesture close it with no start.
struct VoiceAgentSessionsConsentSheet: View {
  let request: VoiceAgentSessionsConsentRequest
  let close: () -> Void
  @State private var flow: VoiceAgentSessionsConsentFlow

  init(
    settings: VoiceAgentSettings, request: VoiceAgentSessionsConsentRequest, close: @escaping () -> Void,
    start: @escaping @MainActor () -> Void
  ) {
    self.request = request
    self.close = close
    _flow = State(initialValue: VoiceAgentSessionsConsentFlow(settings: settings, start: start))
  }

  var body: some View {
    let content = flow.content()
    FormSheet(
      title: content?.title ?? "",
      close: SheetClose(
        label: UICopy.voiceAgentSessionsConsentClose(), identifier: "voiceAgent.sessions.consent.close"
      ) {
        flow.cancel()
      }
    ) {
      if let content {
        switch flow.step {
        case .voiceAgent:
          VoiceAgentConsentPage(
            content: content, identifier: "voiceAgent.consent", accept: { flow.acceptVoiceAgent() },
            cancel: { flow.cancel() })
        default:
          VoiceAgentConsentPage(
            content: content, identifier: "voiceAgent.sessions.consent", accept: { flow.acceptSessions() },
            cancel: { flow.cancel() })
        }
      }
    }
    .onChange(of: flow.step == nil, initial: true) { _, ended in
      if ended { close() }
    }
  }
}
#endif
