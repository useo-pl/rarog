#if os(iOS)
import SwiftUI
import UIKit

// The voice conversation across sessions in the session list's header, in the session screen's header and in the
// Inbox's header at the root of the iPhone's stack. Owner: voice agent. The root's slot (`VoiceAgentSessionsBarSlot`)
// gives the conversation and its place to the views below as `voiceAgentSessionsFeed`; the list button
// (`VoiceAgentSessionsListButton`, the glyph or the lit circle), the header line's room for it (`ListHeaderLine`),
// the strip under the header (`VoiceAgentSessionsListStrip`), the session header's icon group (`HeaderSessionSlot`,
// with `VoiceAgentSessionsHeaderCircle`) and the Inbox's header (`InboxHeaderVoiceSlot`) read it in their own
// bodies, so a change of the state redraws them and not the list, the session screen or the Inbox. The end
// sentence's line (`VoiceAgentSessionsNoticeLine`) stands under the list header and above the screen alike. What
// each shows: `VoiceAgentSessionsListHeader`, `VoiceAgentSessionsPlacement`.

/// The conversation as the root's slot gives it: its content (`nil` = none and no end sentence), the place that
/// shows it now and the removal of the end sentence. Equal by content and place: the action calls the same owner.
struct VoiceAgentSessionsFeed: Equatable, Sendable {
  let content: VoiceAgentSessionsBarContent?
  let placement: VoiceAgentSessionsPlacement
  let dismiss: @MainActor @Sendable () -> Void

  static func == (lhs: Self, rhs: Self) -> Bool { lhs.content == rhs.content && lhs.placement == rhs.placement }

  /// The state of the lit circle in the session screen's header, `nil` = no circle there.
  var sessionHeaderCircle: VoiceAgentIndicator? { placement.sessionHeaderCircle(content) }
}

extension EnvironmentValues {
  /// The voice conversation across sessions for the list header, the session header and the Inbox's header; `nil`
  /// outside the logged-in interface.
  @Entry var voiceAgentSessionsFeed: VoiceAgentSessionsFeed? = nil
}

/// The running conversation in the list bar's button group, where the waveform glyph stands otherwise, and where the
/// list header is off screen first in the session header's icon group or after the Inbox's title: a circle filled
/// with the state's tone with five voice bars inside in the background colour, as the message field's agent button
/// and End on an Inbox card show a conversation. A tap ends the conversation (`VoiceAgentSessionsListAction`). The
/// header icons' 44 pt target, so the icons beside it keep their places. One VoiceOver button: End voice
/// conversation, with the state's sentence as its value.
struct VoiceAgentSessionsLitCircle: View {
  static let diameter: CGFloat = 32
  /// The bars' heights from `VoiceAgentBars` (drawn for the Inbox's 40 pt circle) scaled to this circle.
  static let barScale = 0.75

  let indicator: VoiceAgentIndicator
  let owner: VoiceAgentSessionsConversation?
  /// The list bar's circle, the session header's or the Inbox header's (UI tests tell them apart).
  var identifier = "list.voiceAgentSessions.end"
  let end: () -> Void

  var body: some View {
    Button(action: end) {
      VoiceAgentSessionsCircleBars(owner: owner, motion: indicator.motion)
        .frame(width: Self.diameter, height: Self.diameter)
        // A colour clipped to a circle, not a filled shape: the list column's bar on iPad draws a filled shape white
        // whatever its colour (iOS 27), and the circle would lose the state's tone.
        .background(Color(uiColor: VoiceStatusView.color(indicator.tone)).clipShape(Circle()))
        .frame(width: HeaderMetrics.iconTarget, height: HeaderMetrics.iconTarget)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .pointerTip(UICopy.voiceAgentEndButton)
    .accessibilityLabel(UICopy.voiceAgentEndButton)
    .accessibilityValue(UICopy.voiceAgentStatus(indicator))
    .accessibilityAddTraits(.updatesFrequently)
    .accessibilityIdentifier(identifier)
  }
}

/// The lit circle first in the session header's icon group (`HeaderSessionSlot`) or in the Inbox's header
/// (`InboxHeaderVoiceSlot`), where the list header is off screen. The tap goes through the list button's action over
/// the root's owner, which ends the running conversation.
struct VoiceAgentSessionsHeaderCircle: View {
  let indicator: VoiceAgentIndicator
  let navigation: RarogNavigation
  var identifier = "header.voiceAgentSessions.end"
  @Environment(VoiceAgentSessionsConversation.self) private var owner: VoiceAgentSessionsConversation?

  var body: some View {
    VoiceAgentSessionsLitCircle(indicator: indicator, owner: owner, identifier: identifier) {
      if let owner { VoiceAgentSessionsListAction.tap(owner, navigation: navigation) }
    }
  }
}

/// Five bars from the conversation's levels (`VoiceAgentBars`), the only view that reads them, so the 50 ms updates
/// redraw the bars alone, not the header or the list. They stand still for a state without motion and with reduced
/// motion.
struct VoiceAgentSessionsCircleBars: View {
  let owner: VoiceAgentSessionsConversation?
  let motion: VoiceAgentIndicator.Motion
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let level = VoiceAgentBars.level(owner?.levels ?? .zero, motion: motion)
    let heights = VoiceAgentBars.heights(level: level, motion: motion, reduceMotion: reduceMotion)
    HStack(spacing: 2.5) {
      // Colours clipped to capsules, for the same reason as the circle's fill.
      ForEach(heights.indices, id: \.self) { index in
        Color(uiColor: Palette.background)
          .frame(width: 2.5, height: heights[index] * VoiceAgentSessionsLitCircle.barScale)
          .clipShape(Capsule())
      }
    }
    .accessibilityHidden(true)
  }
}

/// The lit circle after the title of the Inbox's own header at the root of the iPhone's stack
/// (`InboxStackRoot`), its only trailing item, while the list header is off screen. It reads the feed in its own
/// body, so a change of the state redraws the header's item and not the Inbox.
struct InboxHeaderVoiceSlot: ViewModifier {
  let navigation: RarogNavigation
  @Environment(\.voiceAgentSessionsFeed) private var feed

  func body(content: Content) -> some View {
    let circle = feed.flatMap { $0.placement.inboxHeaderCircle($0.content) }
    content
      .toolbar {
        if let circle {
          ToolbarItem(placement: .topBarTrailing) {
            VoiceAgentSessionsHeaderCircle(
              indicator: circle, navigation: navigation, identifier: "inbox.voiceAgentSessions.end")
          }
          // A quiet circle without the bar's glass capsule, as in the session header's icon group.
          .sharedBackgroundVisibility(.hidden)
        }
      }
  }
}

/// The end sentence in one line under the list header and above the screen where the detail column's header shows
/// the conversation: the dot in the state's tone and the whole sentence, a 44 pt target; a tap removes it.
struct VoiceAgentSessionsNoticeLine: View {
  let indicator: VoiceAgentIndicator
  let dismiss: @MainActor @Sendable () -> Void

  var body: some View {
    HStack(spacing: 8) {
      Color(uiColor: VoiceStatusView.color(indicator.tone))
        .frame(width: 8, height: 8)
        .clipShape(Circle())
      Text(UICopy.voiceAgentStatus(indicator))
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.muted))
        // The whole sentence: an end can carry how to fix it, and the tap that would show more removes the line.
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, ListFilterBar.rise)
    .frame(minHeight: HeaderMetrics.iconTarget)
    .contentShape(Rectangle())
    .onTapGesture { dismiss() }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(UICopy.voiceAgentSessionsBarSpoken)
    .accessibilityValue(UICopy.voiceAgentStatus(indicator))
    .accessibilityHint(UICopy.voiceAgentSessionsBarDismissHint)
    .accessibilityAddTraits(.isButton)
    .accessibilityAction { dismiss() }
    .accessibilityIdentifier("voiceAgent.sessions.bar.state")
  }
}

/// The strip under the list header, above the list filter: the waiting prompt's card while one waits, the end
/// sentence after an end (a tap removes it), otherwise nothing, so the list does not move while the conversation
/// only runs.
struct VoiceAgentSessionsListStrip: View {
  @Environment(\.voiceAgentSessionsFeed) private var feed

  var body: some View {
    if let feed, let content = feed.content {
      switch VoiceAgentSessionsListHeader.make(content: content, action: nil).strip {
      case .none:
        EmptyView()
      case let .prompt(prompt):
        // The card on the block it has above the screen: its own fill is the screen's background. Its caption opens
        // with the question the user answers, since the header names no state.
        let caption = content.stripPromptCaption
        VoiceAgentPromptCard(
          caption: caption?.tail ?? "", question: caption?.question, spokenLabel: content.promptSpokenLabel ?? "",
          text: prompt.text)
          .padding(12)
          .background(Color(uiColor: Palette.surface), in: .block)
          .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
          .padding(.horizontal, ListFilterBar.glassEdge)
          .padding(.top, ListFilterBar.rise + 4)
      case let .notice(indicator):
        VoiceAgentSessionsNoticeLine(indicator: indicator, dismiss: feed.dismiss)
      }
    }
  }
}
#endif
