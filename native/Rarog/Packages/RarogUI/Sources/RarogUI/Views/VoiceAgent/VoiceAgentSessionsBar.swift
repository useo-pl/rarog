#if os(iOS)
import SwiftUI

// What the voice conversation across sessions puts above the screen. Owner: voice agent. Where the session list's
// header is on screen the header carries the conversation (`VoiceAgentSessionsHeader.swift`). Where the header of
// the detail column's screen carries it instead (the session header, or the Inbox's own header at the root of the
// iPhone's stack), the lit circle in that header shows the running state, and above the screen stand only the
// waiting prompt's card and the end sentence's line (`VoiceAgentSessionsPlacement`). The root stacks them above the
// split view (`VoiceAgentSessionsBarSlot`). The split view starts under them, so they take room instead of covering
// the navigation bars and their buttons (a top `safeAreaInset` on the split view does not move its navigation bars:
// a view there stood over them on iOS 27); the keyboard does not reach the top of the window. What they show:
// `VoiceAgentSessionsBarContent`.

/// The root's slot over the owner. It reads the owner in its own body, so a change of the conversation's state
/// redraws the slot and not the root.
struct VoiceAgentSessionsBarHost: ViewModifier {
  let owner: VoiceAgentSessionsConversation
  let navigation: RarogNavigation

  func body(content: Content) -> some View {
    content.modifier(VoiceAgentSessionsBarSlot(
      content: VoiceAgentSessionsBarContent.of(owner), navigation: navigation, dismiss: { owner.dismissNotice() }))
  }
}

/// The waiting prompt's card or the end sentence's line over the screen while the place of the conversation puts
/// one there (`VoiceAgentSessionsPlacement.above`); the screen under it keeps its identity when it comes and goes
/// (an optional first child of the stack). The same conversation and its place go to the list header, the session
/// header and the Inbox's header below as `voiceAgentSessionsFeed`; the lit circle there ends it through the owner
/// (`VoiceAgentSessionsListAction`).
struct VoiceAgentSessionsBarSlot: ViewModifier {
  let content: VoiceAgentSessionsBarContent?
  let navigation: RarogNavigation
  let dismiss: @MainActor @Sendable () -> Void
  /// The window's size class, as the split view reads it: `compact` collapses it to a stack.
  @Environment(\.horizontalSizeClass) private var sizeClass

  func body(content screen: Content) -> some View {
    let placement = VoiceAgentSessionsPlacement.of(
      stacked: sizeClass == .compact, detailOnTop: navigation.compactShowsDetail,
      listHidden: navigation.listHidden, inboxOnTop: navigation.detail == .inbox)
    VStack(spacing: 0) {
      switch placement.above(content) {
      case let .notice(indicator)?:
        VoiceAgentSessionsNoticeLine(indicator: indicator, dismiss: dismiss)
          // The line's strip reaches the top edge, so nothing of the screen shows through behind the status bar.
          .background { Color(uiColor: Palette.background).ignoresSafeArea(edges: .top) }
      case let .prompt(prompted)?:
        VoiceAgentSessionsBar(content: prompted)
      case nil:
        EmptyView()
      }
      screen
    }
    .environment(
      \.voiceAgentSessionsFeed, VoiceAgentSessionsFeed(content: content, placement: placement, dismiss: dismiss))
  }
}

/// The card of the prompt that waits for the user's spoken word (`VoiceAgentPromptCard`) above the screen, on a
/// block in the banners' look (`BannerCard`), its caption opened by the question as under the list header, while the
/// lit circle in the header shows the state.
struct VoiceAgentSessionsBar: View {
  let content: VoiceAgentSessionsBarContent

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let prompt = content.prompt {
        let caption = content.stripPromptCaption
        VoiceAgentPromptCard(
          caption: caption?.tail ?? "", question: caption?.question, spokenLabel: content.promptSpokenLabel ?? "",
          text: prompt.text)
          .padding(12)
      }
    }
    .background(Color(uiColor: Palette.surface), in: .block)
    .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity)
    // The strip under the card reaches the top edge, so nothing of the screen shows through behind the status bar.
    .background { Color(uiColor: Palette.background).ignoresSafeArea(edges: .top) }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("voiceAgent.sessions.bar")
  }
}

/// The waiting prompt above the screen and in the strip under the list header: the question in the `run` tone, then
/// a muted caption with its project and session name, over its exact text, on the strip's background. The text
/// stands as it will be sent (no markdown, no trimming); up to six lines show and the rest scrolls inside, so a long
/// prompt does not push the screen under the card away. A text past the six lines
/// fades out at the bottom edge of the text area and its scroll indicator flashes when the card appears or its text
/// changes: the user confirms the send after reading the card and must see that more follows. No buttons: the user
/// confirms by voice. One VoiceOver element whose value is the whole text.
struct VoiceAgentPromptCard: View {
  static let visibleLines = 6

  let caption: String
  /// The question that opens the caption in the `run` tone, before the muted `caption` (which then starts with the
  /// list's glue); `nil` = the caption alone.
  var question: String? = nil
  let spokenLabel: String
  let text: String
  /// The height of the fade over the bottom edge of a text that scrolls. The scrolled text ends with an empty margin
  /// of the same height, so at the end the fade lies over that margin and the last line reads in full.
  @AppScaledMetric(relativeTo: .callout) private var fadeHeight: CGFloat = 24

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      // One line: the muted place truncates before the question.
      Text(captionText)
        .appFont(.footnote)
        .lineLimit(1)
      // The hidden copy cut at six lines gives the box its height at the current text size. Over it stands the whole
      // text: as it is when it fits the box, otherwise in a scroll view under the fade.
      promptText
        .lineLimit(Self.visibleLines)
        .hidden()
        .overlay(alignment: .topLeading) {
          ViewThatFits(in: .vertical) {
            promptText
              .fixedSize(horizontal: false, vertical: true)
            scrollingText
          }
        }
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(uiColor: Palette.background), in: .inner)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(spokenLabel)
    .accessibilityValue(text)
    .accessibilityIdentifier("voiceAgent.sessions.bar.prompt")
  }

  private var scrollingText: some View {
    ScrollView(.vertical) {
      promptText
        .fixedSize(horizontal: false, vertical: true)
        .padding(.bottom, fadeHeight)
    }
    .scrollIndicators(.visible)
    .scrollIndicatorsFlash(onAppear: true)
    .scrollIndicatorsFlash(trigger: text)
    .overlay(alignment: .bottom) {
      LinearGradient(
        colors: [Color(uiColor: Palette.background).opacity(0), Color(uiColor: Palette.background)],
        startPoint: .top, endPoint: .bottom)
        .frame(height: fadeHeight)
        .allowsHitTesting(false)
    }
  }

  private var captionText: AttributedString {
    var place = AttributedString(caption)
    place.foregroundColor = Color(uiColor: Palette.muted)
    guard let question else { return place }
    var asked = AttributedString(question)
    asked.foregroundColor = Color(uiColor: Palette.run)
    return asked + place
  }

  private var promptText: some View {
    Text(verbatim: text)
      .appFont(.callout)
      .foregroundStyle(Color(uiColor: Palette.text))
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}
#endif
