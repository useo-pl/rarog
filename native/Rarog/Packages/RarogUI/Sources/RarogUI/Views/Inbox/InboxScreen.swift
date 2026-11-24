#if os(iOS)
import RarogCore
import SwiftUI

// The Inbox screen in the right column (a screen on the stack on the iPhone): the cards newest first
// (`InboxViewController`), the sentence of an empty Inbox, the "N new ↑" pill when cards came above while the
// screen was not at its top, the removal with its Undo toast, the reply fields of result cards (`InboxReplyHost`)
// and the voice conversation of the cards (`VoiceAgentInboxConversation`, one card at a time). No inspector and no
// session header. Owner: Inbox.

/// The screen's memory next to the store: which cards are expanded, the new-cards pill, and the collection's scroll
/// to the top for the pill's tap.
@MainActor
@Observable
final class InboxScreenState {
  var newCards = InboxNewCards()
  var expanded: Set<String> = []
  @ObservationIgnored var scrollToTop: @MainActor () -> Void = {}

  func toggleFold(_ id: String) {
    if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
  }
}

struct InboxScreen: View {
  let store: RarogStore
  @State private var screen = InboxScreenState()
  @State private var decisions = InboxDecisionHost()
  @State private var replies: InboxReplyHost
  @State private var voice: VoiceAgentInboxConversation

  /// - Parameters:
  ///   - drafts: the session drafts of the space, shared with the session screens.
  ///   - makeVoice: builds the cards' voice conversation (app: the device's audio; tests: fakes).
  init(
    store: RarogStore, drafts: ComposerDrafts,
    makeVoice: @MainActor (RarogStore, ComposerDrafts) -> VoiceAgentInboxConversation = VoiceAgentInboxConversation.live
  ) {
    self.store = store
    _replies = State(initialValue: InboxReplyHost(drafts: drafts))
    _voice = State(initialValue: makeVoice(store, drafts))
  }
  @Environment(RarogNavigation.self) private var navigation
  @Environment(ToastCenter.self) private var toasts: ToastCenter?
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    let cards = store.state.inboxCardModels
    Group {
      if cards.isEmpty {
        InboxEmptyView()
      } else {
        InboxCollection(
          store: store, screen: screen, decisions: decisions, replies: replies, voice: voice, actions: actions)
          .ignoresSafeArea(.container, edges: .bottom)
      }
    }
    .overlay(alignment: .top) {
      if let side = screen.newCards.side(cards) {
        InboxNewPill(side: side) { screen.scrollToTop() }
          .padding(.top, 8)
      }
    }
    .onAppear {
      replies.screenAppeared()
      connectVoice()
    }
    .onDisappear {
      // The conversation ends first: its block's text goes to the draft before the fields write theirs.
      voice.observe()
      replies.screenDisappeared()
    }
    .onChange(of: scenePhase) { voice.observe() }
    .onChange(of: voice.indicator) { _, indicator in
      // An end sentence of a card no longer on the screen (removed, hidden) has no row: it shows as a notice.
      guard let indicator, !indicator.isActive, let card = voice.indicatorCard,
        !store.state.inboxCardModels.contains(where: { $0.id == card })
      else { return }
      toasts?.notice(UICopy.voiceAgentStatus(indicator))
      voice.dismissNotice()
    }
    .accessibilityIdentifier("inbox.screen")
  }

  /// The voice conversation of the cards: the reply fields, the place of the person and the navigation's voice target.
  private func connectVoice() {
    replies.store = store
    replies.voice = voice
    voice.field = replies
    voice.place = { [navigation] in
      VoiceAgentInboxPlace(
        inboxOnScreen: navigation.detail == .inbox, openedSession: navigation.selectedSessionId,
        background: UIApplication.shared.applicationState == .background)
    }
    voice.onTarget = { [navigation] in navigation.setInboxVoiceTarget($0) }
  }

  private var actions: InboxCardActions {
    InboxCardActions(
      open: { [navigation, replies, voice] id in
        // The conversation's block hands its text to the card's field first, so the draft written now carries it.
        voice.end()
        replies.flush()
        navigation.openSessionFromInbox(id)
      },
      remove: { [store, toasts] card in Self.remove(card, store: store, toasts: toasts) },
      toggleFold: { [screen] id in screen.toggleFold(id) })
  }

  /// Removal: the card goes at once, the toast offers Undo for the core's Undo window, and a removal or an Undo that
  /// did not happen says why.
  static func remove(_ card: InboxCardModel, store: RarogStore, toasts: ToastCenter?) {
    guard card.removable else { return }
    Task {
      let outcome = await store.removeInboxCard(card.id)
      if let message = UICopy.inboxRemoveMessage(outcome) { toasts?.notice(message) }
    }
    toasts?.notice(
      UICopy.inboxRemoved(card.name), action: ToastAction(label: UICopy.inboxUndo, identifier: "toast.inbox.undo"),
      lifetime: CoreTiming.production.inboxUndoWindow
    ) {
      Task {
        let outcome = await store.undoInboxRemoval(card.id)
        if let message = UICopy.inboxUndoMessage(outcome) { toasts?.notice(message) }
      }
    }
  }
}

/// An empty Inbox: one sentence from the left, like the empty transcript.
struct InboxEmptyView: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(UICopy.inboxEmptyTitle)
        .appFont(.headline)
        .foregroundStyle(Color(uiColor: Palette.text))
      Text(UICopy.inboxEmptyBody)
        .appFont(.callout)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: 560, alignment: .leading)
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("inbox.empty")
  }
}

/// The pill over the cards: "2 new ↑ · 1 waiting, 1 unread", in the list pill's look; a tap scrolls to the top.
struct InboxNewPill: View {
  let side: ListJumpPill.Side
  let scroll: () -> Void

  var body: some View {
    Button(action: scroll) {
      UICopy.inboxNewPillSegments(side).reduce(Text("")) { text, segment in
        text + Text(segment.text).foregroundStyle(Color(uiColor: Self.ink(segment.role)))
      }
      .appFont(.footnote.monospacedDigit())
      .lineLimit(1)
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(Capsule().fill(Color(uiColor: Palette.surface2).opacity(0.6)).background(.thinMaterial, in: Capsule()))
      .frame(minHeight: 44)
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(UICopy.inboxNewPillSpoken(side.count))
    .accessibilityHint(UICopy.inboxNewPillHint)
    .accessibilityIdentifier("inbox.newPill")
  }

  private static func ink(_ role: ListJumpPill.Segment.Role) -> UIColor {
    switch role {
    case let .state(attention):
      switch attention {
      case .waiting: Palette.wait
      case .failed: Palette.tone(.failed)
      case .unread: Palette.tone(.unread)
      }
    case .plain, .name: Palette.text
    }
  }
}
#endif
