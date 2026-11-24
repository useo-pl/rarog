#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// One Inbox card: the list row's header (dot, project · session, state word with the clock) with Open session and
// Remove on the right, the agent's last message (folded when long: the first paragraph, "N more lines · Show all" and
// the "To you:" block), and under it the decision of a waiting session or the reply field of a result
// (`InboxReplyFieldView`). The voice agent button stands in the card's bottom row: in the reply row of a result, in a
// row of its own under a decision, beside "Open session" elsewhere; while the card talks that row is the voice strip,
// and the end sentence stands under it (`InboxVoice.swift`). The card reads the store itself, so a new text or state
// redraws it in place without a new snapshot of the list. Owner: Inbox.

struct InboxCardView: View {
  let store: RarogStore
  let card: InboxCardModel
  let expanded: Bool
  let actions: InboxCardActions
  let decisions: InboxDecisionHost
  let replies: InboxReplyHost
  let voice: VoiceAgentInboxConversation
  @Environment(RarogNavigation.self) private var navigation
  @State private var frozenAt: Date?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      header
      message
      footer
      InboxVoiceStatus(card: card, voice: voice)
    }
    .padding(.leading, 16)
    .padding(.trailing, 6)
    .padding(.top, 4)
    .padding(.bottom, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle.block.fill(Color(uiColor: Palette.surface)))
    .accessibilityElement(children: .contain)
    .accessibilityActions {
      if card.removable {
        Button(UICopy.inboxRemove) { actions.remove(card) }
      }
      if let text = card.text, MarkdownFold.fold(text).isFolded {
        Button(expanded ? UICopy.inboxShowLess : UICopy.inboxShowAll(MarkdownFold.fold(text).hiddenLineCount)) {
          actions.toggleFold(card.id)
        }
      }
      Button(UICopy.inboxOpenSession) { actions.open(card.id) }
      if voice.talks(card.id) {
        Button(voice.muted ? UICopy.voiceAgentUnmute : UICopy.voiceAgentMute) { voice.toggleMute() }
        Button(UICopy.voiceAgentEndButton) { voice.end() }
      } else if voice.offered(card) {
        Button(UICopy.voiceAgentButton) { voice.toggle(card) }
      }
    }
    .accessibilityIdentifier("inbox.card.\(card.id)")
    .onChange(of: card.row.frozen, initial: true) { _, frozen in frozenAt = frozen ? Date() : nil }
  }

  // MARK: - Header

  private var header: some View {
    HStack(alignment: .top, spacing: 10) {
      TimelineView(.periodic(from: .now, by: 1)) { timeline in
        let now = card.row.clockNow(timeline.date, frozenAt: frozenAt)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          StatusDot(tone: card.row.status.tone, pulses: card.row.freshResult)
          VStack(alignment: .leading, spacing: 1) {
            Text("\(Text(card.row.project).fontWeight(.semibold))\(Text(UICopy.inboxDot).foregroundStyle(Color(uiColor: Palette.muted2)))\(Text(card.row.treeTitle).fontWeight(.semibold))")
              .appFont(.subheadline)
              .foregroundStyle(Color(uiColor: Palette.text))
              .lineLimit(2)
            statusLine(now: now)
              .appFont(.footnote)
              .lineLimit(1)
          }
        }
        .padding(.top, 10)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(card.row.spoken(now: now))
        .accessibilityAddTraits(.isHeader)
      }
      Spacer(minLength: 0)
      HStack(spacing: 0) {
        Button { actions.open(card.id) } label: {
          Image(systemName: "arrow.up.right").frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(InboxIconButtonStyle())
        .pointerTip(UICopy.inboxOpenSession)
        .accessibilityLabel(UICopy.inboxOpenSession)
        .accessibilityIdentifier("inbox.open.\(card.id)")
        if card.removable {
          Button { actions.remove(card) } label: {
            Image(systemName: "xmark").frame(width: 44, height: 44).contentShape(Rectangle())
          }
          .buttonStyle(InboxIconButtonStyle())
          .pointerTip(UICopy.inboxRemove)
          .accessibilityLabel(UICopy.inboxRemove)
          .accessibilityIdentifier("inbox.remove.\(card.id)")
        }
      }
    }
  }

  private func statusLine(now: Date) -> Text {
    let clock = card.row.clock(now: now)
    let state = Text(card.row.status.text).foregroundStyle(Color(uiColor: Palette.tone(card.row.status.tone)))
    guard !clock.isEmpty else { return state }
    return Text("\(state)\(Text(UICopy.inboxDot + clock).foregroundStyle(Color(uiColor: Palette.muted)))")
      .monospacedDigit()
  }

  // MARK: - Message

  @ViewBuilder
  private var message: some View {
    if let text = card.text {
      VStack(alignment: .leading, spacing: 8) {
        if card.truncated {
          Text(UICopy.inboxTruncated)
            .appFont(.footnote)
            .foregroundStyle(Color(uiColor: Palette.muted))
        }
        let fold = MarkdownFold.fold(text)
        if fold.isFolded, !expanded {
          InboxMessageText(source: fold.lead, identifier: "inbox.text.\(card.id)")
          foldRow(UICopy.inboxShowAll(fold.hiddenLineCount))
          if let question = fold.question {
            InboxMessageText(source: question, identifier: "inbox.question.\(card.id)")
          }
        } else {
          InboxMessageText(source: text, identifier: "inbox.text.\(card.id)")
          if fold.isFolded { foldRow(UICopy.inboxShowLess) }
        }
      }
      .padding(.trailing, 10)
    } else {
      InboxTextSkeleton()
        .padding(.trailing, 10)
    }
  }

  private func foldRow(_ title: String) -> some View {
    Button { actions.toggleFold(card.id) } label: {
      HStack(spacing: 8) {
        Rectangle().fill(Color(uiColor: Palette.border)).frame(height: 1)
        Text(title)
          .appFont(.footnote.weight(.medium))
          .foregroundStyle(Color(uiColor: Palette.text2))
          .fixedSize()
        Rectangle().fill(Color(uiColor: Palette.border)).frame(height: 1)
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("inbox.fold.\(card.id)")
  }

  // MARK: - Footer

  @ViewBuilder
  private var footer: some View {
    let state = store.state
    switch card.footer {
    case .decision:
      switch state.inboxDecision(card.id) {
      case let .permission(request, _)?:
        VStack(alignment: .leading, spacing: 8) {
          if let model = decisions.permissionCard(request, state: state) {
            PermissionCardView(
              card: model,
              decide: { decision in decisions.decide(model, decision, store: store) },
              showFullInput: { decisions.openFullInput(model, navigation: navigation) })
              .padding(.trailing, 10)
          }
          // The permission card is the session screen's too: the voice row stands under it, never inside it.
          InboxVoiceRow(card: card, voice: voice) { EmptyView() }
        }
      case .question?, nil:
        InboxVoiceRow(card: card, voice: voice) { openSessionButton }
      }
    case .paneDialog:
      // The end of the grace before the pane dialog card comes with no frame (`AppState.decisionGraceEnds`): one
      // more render just after it, as the session screen does, or the card would wait for another change of state.
      let graceEnds = state.decisionGraceEnds(for: card.id).map { [$0.addingTimeInterval(0.02)] } ?? []
      TimelineView(.explicit(graceEnds)) { _ in
        VStack(alignment: .leading, spacing: 8) {
          if let model = decisions.dialogCard(card.id, state: state) {
            HerdrDialogCardView(
              card: model, decide: { decision in decisions.decideDialog(model, decision, store: store) }
            )
            .padding(.trailing, 10)
          }
          InboxVoiceRow(card: card, voice: voice) { openSessionButton }
        }
      }
    case .openSession:
      InboxVoiceRow(card: card, voice: voice) { openSessionButton }
    case .reply:
      InboxReplyFieldView(store: store, card: card, host: replies, voice: voice)
    case .none:
      EmptyView()
    }
  }

  private var openSessionButton: some View {
    Button(UICopy.inboxOpenSession) { actions.open(card.id) }
      .buttonStyle(NeutralButtonStyle())
      .accessibilityIdentifier("inbox.openButton.\(card.id)")
  }
}

/// What a card asks of the screen.
struct InboxCardActions {
  let open: @MainActor (String) -> Void
  let remove: @MainActor (InboxCardModel) -> Void
  let toggleFold: @MainActor (String) -> Void
}

/// A quiet icon with a 44 pt target, like the session header's icons, on the card's surface.
private struct InboxIconButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .appFont(.body)
      .foregroundStyle(Color(uiColor: configuration.isPressed ? Palette.text : Palette.muted2))
  }
}

/// The text while it loads: three bars, without flicker.
private struct InboxTextSkeleton: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach([0.92, 0.78, 0.6], id: \.self) { fraction in
        GeometryReader { proxy in
          RoundedRectangle.ghost
            .fill(Color(uiColor: Palette.surface2))
            .frame(width: proxy.size.width * fraction, height: 12)
        }
        .frame(height: 12)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(UICopy.inboxLoading)
  }
}
#endif
