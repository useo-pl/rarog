import Foundation

// Where the state of the voice conversation across sessions stands, without a view. Owner: voice agent. Where the
// session list's header is on screen, the header carries it (`VoiceAgentSessionsListHeader`): "AGENTS (N)" stays,
// and while the conversation runs a circle lit in the state's tone stands in place of the waveform glyph and ends it
// on a tap; the waiting prompt's card and the end sentence stand in a strip under the header. Where it is not, the
// header of the screen on top of the detail column carries the same lit circle (`VoiceAgentSessionsHeaderCircle`):
// the session screen's header (`SessionHeader`, on every route of `DetailView`) or the Inbox's own header at the root
// of the iPhone's stack (`InboxStackRoot`). There only the waiting prompt's card and the end sentence's line stand
// above the screen, so the screen does not move while the conversation only runs. One rule for the three places, so
// a running conversation always shows its circle once, and an end sentence and a waiting prompt stay reachable once;
// `swift test` checks it on macOS (`VoiceAgentSessionsBarPlacementTests`).

/// Which header shows the conversation now.
enum VoiceAgentSessionsPlacement: Sendable, Equatable {
  /// The session list's header: the lit circle and the strip under the header.
  case listHeader
  /// The session screen's header: the lit circle in its icon group, the waiting prompt's card and the end sentence
  /// above the screen.
  case sessionHeader
  /// The Inbox's own header at the root of the iPhone's stack: the lit circle after its title, the waiting prompt's
  /// card and the end sentence above the screen.
  case inboxHeader

  /// Whether the session list's header is on screen. In the stack (iPhone, a narrow window) the list is on top while
  /// no detail route stands; beside the detail (iPad) the list column shows unless it is hidden.
  /// - Parameters:
  ///   - stacked: the split view collapsed to a stack, from the window's size class.
  ///   - detailOnTop: a detail route stands (`RarogNavigation.compactShowsDetail`).
  ///   - listHidden: the list column is hidden beside the detail (`RarogNavigation.listHidden`).
  static func listHeaderOnScreen(stacked: Bool, detailOnTop: Bool, listHidden: Bool) -> Bool {
    stacked ? !detailOnTop : !listHidden
  }

  /// The header on screen that shows the conversation; the list header wins, so on iPad with both columns the circle
  /// stands once, in the list header. Every screen of the detail column has a header: `DetailView` puts the session
  /// header on each of its routes (also the Inbox on iPad), and in the stack the Inbox at the root has its own, under
  /// the session header of a session opened from a card.
  /// - Parameters:
  ///   - inboxOnTop: the Inbox is the detail route (`RarogNavigation.detail == .inbox`), not a session opened from it.
  static func of(
    stacked: Bool, detailOnTop: Bool, listHidden: Bool, inboxOnTop: Bool
  ) -> VoiceAgentSessionsPlacement {
    if listHeaderOnScreen(stacked: stacked, detailOnTop: detailOnTop, listHidden: listHidden) { return .listHeader }
    return stacked && inboxOnTop ? .inboxHeader : .sessionHeader
  }

  /// What stands above the screen for the conversation's `content` (`nil` = none and no end sentence).
  func above(_ content: VoiceAgentSessionsBarContent?) -> VoiceAgentSessionsAbove? {
    guard let content, self != .listHeader else { return nil }
    if !content.running { return .notice(content.indicator) }
    return content.prompt == nil ? nil : .prompt(content)
  }

  /// The state of the lit circle in the session screen's header: only while the conversation runs and this header
  /// shows it.
  func sessionHeaderCircle(_ content: VoiceAgentSessionsBarContent?) -> VoiceAgentIndicator? {
    guard self == .sessionHeader, let content, content.running else { return nil }
    return content.indicator
  }

  /// The state of the lit circle in the Inbox's header at the root of the stack: while the conversation runs and the
  /// list header is off screen. It also stands under a session opened from a card, whose navigation bar covers the
  /// Inbox's (a stack shows the top screen's bar alone), so the circle does not appear late while Back pops the
  /// session: the route names the session until the pop ends.
  func inboxHeaderCircle(_ content: VoiceAgentSessionsBarContent?) -> VoiceAgentIndicator? {
    guard self != .listHeader, let content, content.running else { return nil }
    return content.indicator
  }
}

/// What stands above the screen (`VoiceAgentSessionsBarSlot`).
enum VoiceAgentSessionsAbove: Sendable, Equatable {
  /// The end sentence's line, removed by a tap (`VoiceAgentSessionsNoticeLine`), as under the list header.
  case notice(VoiceAgentIndicator)
  /// The waiting prompt's card, its caption opened by the question, while the lit circle in the header shows the
  /// state.
  case prompt(VoiceAgentSessionsBarContent)
}

/// What the session list's header shows of the conversation. The title "AGENTS (N)" stands in every state.
struct VoiceAgentSessionsListHeader: Sendable, Equatable {
  /// The place before New Session.
  enum Trailing: Sendable, Equatable {
    /// Nothing: the mode is not offered and no conversation runs.
    case none
    /// The waveform glyph (`VoiceAgentSessionsListAction`).
    case glyph
    /// The running conversation: a circle filled with the state's tone, with the voice bars inside; a tap ends it.
    case circle(VoiceAgentIndicator)
  }

  /// The strip under the header line, above the list filter.
  enum Strip: Sendable, Equatable {
    case none
    /// The card of the prompt that waits for the user's spoken word.
    case prompt(VoiceAgentShownPrompt)
    /// The end sentence's line; a tap removes it.
    case notice(VoiceAgentIndicator)
  }

  let trailing: Trailing
  let strip: Strip

  /// The header for the conversation's `content` (`nil` = none and no end sentence) and the list button's `action`
  /// (`nil` = no owner). A running conversation takes the glyph's place whatever the entry says, so the circle that
  /// ends it stands as long as it runs. Without content (no root slot above the list) the owner's own `running`
  /// decides, with connecting as the state.
  static func make(
    content: VoiceAgentSessionsBarContent?, action: VoiceAgentSessionsListAction?
  ) -> VoiceAgentSessionsListHeader {
    if content?.running ?? (action == .running) {
      return VoiceAgentSessionsListHeader(
        trailing: .circle(content?.indicator ?? .connecting), strip: content?.prompt.map(Strip.prompt) ?? .none)
    }
    let trailing: Trailing = (action ?? .hidden) == .hidden ? .none : .glyph
    return VoiceAgentSessionsListHeader(trailing: trailing, strip: content.map { .notice($0.indicator) } ?? .none)
  }
}

extension VoiceAgentSessionsBarContent {
  /// The caption of the waiting prompt's card, where no state sentence stands above it: the question the user
  /// answers by voice, then, with the list's glue in front, the prompt's project and session name, so the caption
  /// reads as one dotted list ("Send the prompt? · <project> · <name>").
  var stripPromptCaption: (question: String, tail: String)? {
    prompt.map { (UICopy.voiceAgentSessionsPromptQuestion, UICopy.list(["", $0.project, $0.name], .dot)) }
  }
}
