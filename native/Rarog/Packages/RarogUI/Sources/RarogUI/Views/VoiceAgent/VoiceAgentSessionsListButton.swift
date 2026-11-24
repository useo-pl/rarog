#if os(iOS)
import SwiftUI

/// The waveform glyph in the session list bar, before New Session and Settings: the voice conversation across
/// sessions. Owner: voice agent. What it does follows `VoiceAgentSessionsListAction` over the root's owner: no button
/// where the mode is not offered, the consent sheet while a consent is missing, otherwise a start. While a
/// conversation runs the lit circle stands in the glyph's place (`VoiceAgentSessionsLitCircle`, from the root's
/// `voiceAgentSessionsFeed`) and a tap ends the conversation. The look of the other list bar glyphs: the quiet
/// `HeaderIconButtonStyle` with its 44 pt target.
struct VoiceAgentSessionsListButton: View {
  let navigation: RarogNavigation
  @Environment(VoiceAgentSessionsConversation.self) private var owner: VoiceAgentSessionsConversation?
  @Environment(\.voiceAgentSessionsFeed) private var feed

  var body: some View {
    switch VoiceAgentSessionsListHeader.make(
      content: feed?.content, action: owner.map(VoiceAgentSessionsListAction.of)
    ).trailing {
    case .none:
      EmptyView()
    case let .circle(indicator):
      VoiceAgentSessionsLitCircle(indicator: indicator, owner: owner) { tap() }
    case .glyph:
      Button { tap() } label: {
        Label(UICopy.voiceAgentSessionsTitle(), systemImage: "waveform")
      }
      .buttonStyle(HeaderIconButtonStyle())
      .pointerTip(UICopy.voiceAgentSessionsTitle())
      .accessibilityIdentifier("list.voiceAgentSessions")
    }
  }

  private func tap() {
    if let owner { VoiceAgentSessionsListAction.tap(owner, navigation: navigation) }
  }
}
#endif
