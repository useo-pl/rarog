#if os(iOS)
import RarogCore
import SwiftUI

// The root of the iPhone's detail stack while the Inbox stands: the Inbox screen with its own header, toast, banners
// and notice card, so the session opened from a card is pushed above it and Back or the edge swipe uncovers the Inbox
// instead of the list. The header does not read the route (`DetailView`'s slots read `navigation.detail`, which names
// the pushed session until the pop ends), so the title stays "Inbox" during the pop; the lit circle of a running
// voice conversation across sessions stands after it (`InboxHeaderVoiceSlot`). Owner: Inbox.

struct InboxStackRoot: View {
  let store: RarogStore
  let navigation: RarogNavigation
  /// The global stream's memory: the "server not answering" banner, as over the other detail screens on the iPhone.
  let memory: ConnectionMemory
  let transcriptLink: TranscriptConnectionMemory
  /// The session drafts of the space: a card's reply field writes the session's draft.
  let drafts: ComposerDrafts
  /// The width of the detail column: the title's ceiling on the phone's bar (`HeaderMetrics.phoneTitleMaxWidth`).
  @State private var columnWidth: CGFloat = 0

  var body: some View {
    let state = store.state
    InboxScreen(store: store, drafts: drafts)
      // The removal's Undo toast at the bottom of the column; silent while the pushed session shows its own.
      .modifier(ToastOverlay(
        navigation: navigation, placement: ToastPlacement.resolve(navigation: navigation, state: state)))
      .safeAreaInset(edge: .top, spacing: 0) {
        let column = BannerColumn.detail(sessionId: nil, listVisible: false)
        BannerStack(
          slots: state.bannerSlots(in: column, global: memory, transcript: transcriptLink.connection(for: nil)),
          pushPrompt: state.pushPromptVisible(in: column, global: memory, now: Date()) ? store : nil)
      }
      // The notice under the bar (a refusal from a list menu, say), as the session header draws it on other screens.
      .overlay(alignment: .top) {
        if let notice = navigation.notice {
          NavigationNoticeCard(notice: notice) { navigation.clearNotice($0) }
        }
      }
      .background { Color(uiColor: Palette.background).ignoresSafeArea() }
      .navigationTitle(UICopy.inboxTitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(removing: .title)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          HeaderLeadingTitle(
            title: UICopy.inboxTitle, subtitle: "", count: HeaderTitleSlot.count(state, detail: .inbox),
            maxWidth: HeaderMetrics.phoneTitleMaxWidth(columnWidth: columnWidth))
        }
        .sharedBackgroundVisibility(.hidden)
      }
      // The lit circle of a running voice conversation across sessions after the title; the title's ceiling keeps
      // room for it, so a wide title does not push it into the bar's overflow, which does not show it.
      .modifier(InboxHeaderVoiceSlot(navigation: navigation))
      .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { columnWidth = $0 }
  }
}
#endif
