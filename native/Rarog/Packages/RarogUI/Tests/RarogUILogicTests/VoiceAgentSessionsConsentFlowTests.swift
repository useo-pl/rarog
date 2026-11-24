import Foundation
import RarogCore
@testable import RarogUI
import Testing

// The consent flow of the voice conversation across sessions from the session list button
// (`VoiceAgentSessionsConsentFlow`): which pages it shows, what each accept stores, one start after the last consent,
// none after a decline. Settings in memory; a start counter instead of the owner (the owner's start with the flow:
// `VoiceAgentSessionsConversationTests`). Owner: voice agent.

@MainActor
@Suite("voice conversation across sessions: the consent flow from the session list")
struct VoiceAgentSessionsConsentFlowTests {
  /// A flow over settings in memory; `starts` counts the starts it asked for.
  @MainActor
  private final class Rig {
    let settings = VoiceAgentSettings.memory()
    private(set) var starts = 0
    private(set) var flow: VoiceAgentSessionsConsentFlow!

    init(voiceAgent: Bool, sessions: Bool = false) {
      if voiceAgent { settings.acceptConsent() }
      if sessions { settings.acceptSessionsConsent() }
      flow = VoiceAgentSessionsConsentFlow(settings: settings) { [unowned self] in self.starts += 1 }
    }
  }

  @Test("the voice agent off: its consent first, then the mode's; accepting both starts the conversation once")
  func voiceAgentOffBothPages() {
    let rig = Rig(voiceAgent: false)
    #expect(rig.flow.step == .voiceAgent)
    #expect(rig.flow.content()?.title == UICopy.voiceAgentConsentTitle())
    rig.flow.acceptVoiceAgent()
    #expect(rig.flow.step == .sessions && rig.starts == 0, "the mode's page follows; nothing starts yet")
    #expect(rig.settings.enabled && !rig.settings.sessionsEnabled)
    #expect(rig.flow.content()?.title == UICopy.voiceAgentSessionsConsentTitle())
    rig.flow.acceptSessions()
    #expect(rig.flow.step == nil && rig.starts == 1 && rig.settings.sessionsAllowed)
    rig.flow.acceptSessions()
    rig.flow.acceptVoiceAgent()
    #expect(rig.starts == 1, "an ended flow starts nothing more")
  }

  @Test("the voice agent on: only the mode's page; its accept starts the conversation once")
  func voiceAgentOnModePageOnly() {
    let rig = Rig(voiceAgent: true)
    #expect(rig.flow.step == .sessions)
    rig.flow.acceptVoiceAgent()
    #expect(rig.flow.step == .sessions && rig.starts == 0, "the voice agent's accept does not apply here")
    rig.flow.acceptSessions()
    #expect(rig.flow.step == nil && rig.starts == 1)
  }

  @Test("declining stores nothing more and starts nothing", arguments: [false, true])
  func decline(voiceAgent: Bool) {
    let rig = Rig(voiceAgent: voiceAgent)
    rig.flow.cancel()
    #expect(rig.flow.step == nil && rig.starts == 0 && !rig.settings.sessionsEnabled)
    #expect(rig.settings.enabled == voiceAgent, "the voice agent's consent untouched")
  }

  @Test("declining the mode's page after the voice agent's consent keeps only the voice agent's")
  func declineSecondPage() {
    let rig = Rig(voiceAgent: false)
    rig.flow.acceptVoiceAgent()
    rig.flow.cancel()
    #expect(rig.starts == 0 && rig.settings.enabled && !rig.settings.sessionsEnabled)
  }

  @Test("a mode's consent kept while the voice agent was off: the voice agent's consent alone starts the conversation")
  func storedModeConsent() {
    let rig = Rig(voiceAgent: false, sessions: true)
    #expect(rig.flow.step == .voiceAgent)
    rig.flow.acceptVoiceAgent()
    #expect(rig.flow.step == nil && rig.starts == 1)
  }

  @Test("the mode's page in the flow starts the conversation; on the Settings page it turns the switch on")
  func acceptLabels() {
    let rig = Rig(voiceAgent: true)
    #expect(rig.flow.content()?.accept == UICopy.voiceAgentSessionsConsentStart())
    let settings = VoiceAgentSettingsModel(settings: rig.settings).sessionsConsent()
    #expect(settings.accept == UICopy.voiceAgentConsentAccept())
    #expect(settings.paragraphs == rig.flow.content()?.paragraphs, "one text for both places")
  }
}
