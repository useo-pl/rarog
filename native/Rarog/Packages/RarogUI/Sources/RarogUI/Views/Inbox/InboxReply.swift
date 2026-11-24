#if os(iOS)
import Observation
import RarogContract
import RarogCore
import SwiftUI

// The reply field of an Inbox result card. The host keeps the fields' texts (`InboxReplies`), reads each from the
// session's draft (`ComposerDrafts`, the draft the session screen's field takes, read without taking it) when it
// first shows, writes it back after a typing pause, on ↑, before "Open session" and when the screen leaves, taking
// first the texts that came into the draft after its read, and sends with `RarogStore.replyFromInbox`: an ordinary
// send of the person, as from the session screen. A reply that did not go out comes back into the field with its
// reason while the card still has the field on screen; otherwise the text goes to the session's draft
// (`MessageSendRecovery`, the session screen's rule). The mic in the row records into the field (`InboxDictation`),
// which hears of every change of a field from here; the voice agent button beside it starts the card's conversation,
// whose voice strip and prompt block take the row's place while it runs (`InboxVoice.swift`). Owner: Inbox.

@MainActor
@Observable
final class InboxReplyHost {
  /// The fields' state. Kept out of observation: the first read of a field loads it from the draft during the body,
  /// and a change of observed state there would draw again. `revision` carries the changes to the views.
  @ObservationIgnored private var replies = InboxReplies()
  private var revision = 0
  @ObservationIgnored let drafts: ComposerDrafts
  /// Draft writes waiting for a typing pause, by session.
  @ObservationIgnored private var saves: [String: Task<Void, Never>] = [:]
  /// What each field read from the session's draft when it first showed; `.held` once it wrote the draft.
  @ObservationIgnored private var read: [String: ComposerDrafts.Shown] = [:]
  /// The turn each field's card showed last: a waiting text that joins an emptied field answers it.
  @ObservationIgnored private var shownTurns: [String: String] = [:]
  /// Sessions whose draft attachments were brought back to the shelf before the first write (after the app was
  /// killed the shelf is empty, and a write without them would drop them from the draft).
  @ObservationIgnored private var shelvesChecked: Set<String> = []
  /// The Inbox screen stands where the person sees it.
  @ObservationIgnored private(set) var screenVisible = false
  /// The store and the voice conversation of the cards, set by the screen: the conversation hands its block's text
  /// back into a field at its end and leaves a late send's outcome to the field's rule (`VoiceAgentInboxField`).
  @ObservationIgnored weak var store: RarogStore?
  @ObservationIgnored weak var voice: VoiceAgentInboxConversation?

  /// Dictation into the fields: one card records at a time. Every change of a field below tells it, so a recording
  /// takes the change as its new starting point.
  @ObservationIgnored let dictation = InboxDictation()

  init(drafts: ComposerDrafts) {
    self.drafts = drafts
    dictation.onSettled = { [weak self] sessionId in self?.save(sessionId) }
  }

  /// The card's voice conversation runs or connects: it holds the microphone, so the field's mic does not record.
  func conversationRuns(_ cardId: String) -> Bool {
    voice?.talks(cardId) == true
  }

  /// The mic of a card's field: records into it by the dictation route, or ends its recording.
  func toggleDictation(_ card: InboxCardModel, navigation: RarogNavigation?) {
    guard let store, !conversationRuns(card.id) else { return }
    _ = field(card)
    dictation.toggle(
      card.id, store: store, navigation: navigation,
      read: { [weak self] sessionId in self?.replies.field(sessionId)?.text ?? "" },
      write: { [weak self] sessionId, text in self?.writeDictation(text, into: sessionId) })
  }

  /// The recording's text goes into the field as typed text: the turn and the typing pause's draft write hear of it.
  /// A field the host let go takes nothing (its text went to the draft).
  private func writeDictation(_ text: String, into sessionId: String) {
    guard replies.field(sessionId) != nil else { return }
    replies.edit(sessionId, text: text, shownTurn: shownTurns[sessionId] ?? "")
    revision += 1
    scheduleSave(sessionId)
  }

  /// The field of a card, read from the session's draft the first time it shows.
  func field(_ card: InboxCardModel) -> InboxReplyField {
    _ = revision
    shownTurns[card.id] = card.turnId
    if let field = replies.field(card.id) { return field }
    let shown = drafts.peek(for: card.id)
    read[card.id] = shown
    replies.load(card.id, draft: shown.draft?.text ?? "", note: shown.draft?.note, shownTurn: card.turnId)
    return replies.field(card.id) ?? InboxReplyField()
  }

  func edit(_ card: InboxCardModel, _ text: String) {
    _ = field(card)
    guard replies.field(card.id)?.text != text else { return }
    replies.edit(card.id, text: text, shownTurn: card.turnId)
    revision += 1
    scheduleSave(card.id)
    dictation.fieldChanged(card.id, byPerson: true)
  }

  /// ↑ of a card's field; during its recording ↑ waits for the last words and sends the whole text once.
  func send(_ card: InboxCardModel, store: RarogStore) {
    dictation.send(card.id) { [weak self] in self?.sendField(card, store: store) }
  }

  private func sendField(_ card: InboxCardModel, store: RarogStore) {
    _ = field(card)
    guard let taken = replies.take(card.id) else { return }
    revision += 1
    save(card.id)
    dictation.fieldChanged(card.id, byPerson: false)
    // The outcome finds the text a place also when the screen let this host go meanwhile: then no field is left,
    // and the text goes to the session's draft.
    Task { [weak self, drafts] in
      let outcome = await store.replyFromInbox(taken.text, to: card.id, turnId: taken.turnId)
      if let self {
        self.finish(outcome, text: taken.text, sessionId: card.id, store: store)
      } else {
        Self.recoverOffScreen(outcome, text: taken.text, sessionId: card.id, store: store, drafts: drafts)
      }
    }
  }

  func screenAppeared() {
    screenVisible = true
  }

  /// The screen left (another detail, back to the list, a session pushed above it): pending writes go now, and each
  /// field is read again from the draft when it next shows, because the session screen may change that draft.
  func screenDisappeared() {
    screenVisible = false
    flush()
    replies.forgetAll()
    read = [:]
    revision += 1
  }

  /// Writes the drafts waiting for a typing pause now: before "Open session", whose screen reads the draft as it opens.
  /// A recording ends first, its hypothesis as the field's text: the session screen opens with its own field.
  func flush() {
    dictation.handOff()
    for id in Array(saves.keys) { save(id) }
  }

  private func finish(_ outcome: InboxReplyOutcome, text: String, sessionId: String, store: RarogStore) {
    defer { revision += 1 }
    guard let shown = shownCard(sessionId, state: store.state) else {
      // The text typed since goes to the draft first: the reply's recovery below stacks on it.
      release(sessionId)
      Self.recoverOffScreen(outcome, text: text, sessionId: sessionId, store: store, drafts: drafts)
      return
    }
    // A field off screen in the list was never read: it takes the draft before it writes over it.
    _ = field(shown)
    switch outcome {
    case .cardChanged:
      replies.giveBack(
        sessionId, text: text, note: UICopy.inboxReplyCardChanged, isError: false, shownTurn: shown.turnId)
      dictation.fieldChanged(sessionId, byPerson: false)
    case let .sent(sent):
      let note = MessageSendRecovery.recover(
        sent, raw: text, attachments: [], sessionId: sessionId, screenAttached: true, store: store, drafts: drafts
      ) { raw, _ in
        replies.giveBack(sessionId, text: raw, note: nil, isError: false, shownTurn: shown.turnId)
        dictation.fieldChanged(sessionId, byPerson: false)
      }
      if let note { replies.setNote(sessionId, note.text, isError: note.isError) }
    }
    save(sessionId)
  }

  /// The card that still has the field of `sessionId` on screen, where a reply's text can come back.
  private func shownCard(_ sessionId: String, state: AppState) -> InboxCardModel? {
    guard screenVisible, state.auth == .loggedIn else { return nil }
    return state.inboxCardModels.first { $0.id == sessionId && $0.footer == .reply }
  }

  /// The card no longer has the field on screen: the typed text goes to the session's draft now, with its pending
  /// write, and the field is read again from the draft when it next shows.
  private func release(_ sessionId: String) {
    // A recording into this field ends first: its hypothesis goes to the draft with the field.
    dictation.handOff(sessionId)
    save(sessionId)
    replies.forget(sessionId)
    read[sessionId] = nil
  }

  /// A reply's text when no card has its field on screen, or no host is left: into the session's draft, by the session
  /// screen's rule.
  private static func recoverOffScreen(
    _ outcome: InboxReplyOutcome, text: String, sessionId: String, store: RarogStore, drafts: ComposerDrafts
  ) {
    switch outcome {
    case .cardChanged:
      drafts.save(text, note: UICopy.inboxReplyCardChanged, for: sessionId)
    case let .sent(sent):
      _ = MessageSendRecovery.recover(
        sent, raw: text, attachments: [], sessionId: sessionId, screenAttached: false, store: store, drafts: drafts
      ) { _, _ in }
    }
  }

  private func scheduleSave(_ sessionId: String) {
    saves[sessionId]?.cancel()
    saves[sessionId] = Task { @MainActor [weak self] in
      try? await Task.sleep(for: SessionViewController.draftDebounce)
      guard !Task.isCancelled else { return }
      self?.save(sessionId)
    }
  }

  /// Writes the field as the session's draft, with the session's unsent attachments, which the field does not show.
  /// The write replaces the draft, so texts that came into it since the field read it (a send that came back, a late
  /// queue take-back) join the field first, as on the session screen; the first write takes the draft over. A field
  /// no longer here writes nothing: its text went to the draft when it was let go, and an empty write would delete
  /// the draft.
  private func save(_ sessionId: String) {
    saves[sessionId]?.cancel()
    saves[sessionId] = nil
    guard replies.field(sessionId) != nil else { return }
    if let waiting = drafts.takeWaiting(for: sessionId, after: read[sessionId] ?? .held) {
      replies.placeWaiting(sessionId, text: waiting.text, note: waiting.note, shownTurn: shownTurns[sessionId] ?? "")
      revision += 1
      dictation.fieldChanged(sessionId, byPerson: false)
    }
    read[sessionId] = .held
    guard let field = replies.field(sessionId) else { return }
    let shelf = AttachmentShelf.shared
    if shelvesChecked.insert(sessionId).inserted, shelf.attachments(for: sessionId).isEmpty,
      !shelf.isLoading(sessionId)
    {
      let restored = drafts.restoreAttachments(for: sessionId)
      if !restored.isEmpty { shelf.restore(restored, for: sessionId) }
    }
    drafts.persist(text: field.text, attachments: shelf.attachments(for: sessionId), for: sessionId)
  }
}

/// The voice conversation of a card keeps its prompt in its own block; the reply field only takes the block's text
/// back at the end of the conversation, and the outcome of a voice send whose block is already gone.
extension InboxReplyHost: VoiceAgentInboxField {
  /// The block's text on top of the field's text, with the send's reason when one came back, saved as the session's
  /// draft at once. A card without its field on screen takes nothing (`false`): the text goes to the draft.
  func handBack(_ text: String, note: String?, noteIsError: Bool, into sessionId: String) -> Bool {
    guard let store, let card = shownCard(sessionId, state: store.state) else { return false }
    _ = field(card)
    replies.giveBack(sessionId, text: text, note: note, isError: noteIsError, shownTurn: card.turnId)
    revision += 1
    dictation.fieldChanged(sessionId, byPerson: false)
    save(sessionId)
    return true
  }

  func voiceReplyFinished(_ outcome: InboxReplyOutcome, text: String, sessionId: String) {
    guard let store else { return }
    finish(outcome, text: text, sessionId: sessionId, store: store)
  }
}

/// The field under a result card's message: the text, the dictation mic, the voice agent button, ↑, the dictation's
/// state line and the sentence why a reply came back. While the card talks, the prompt block and the voice strip
/// stand in the row's place; the field keeps its text for the end of the conversation.
struct InboxReplyFieldView: View {
  let store: RarogStore
  let card: InboxCardModel
  let host: InboxReplyHost
  let voice: VoiceAgentInboxConversation
  @FocusState private var focused: Bool
  @Environment(RarogNavigation.self) private var navigation

  var body: some View {
    let field = host.field(card)
    VStack(alignment: .leading, spacing: 6) {
      if voice.talks(card.id) {
        VStack(alignment: .leading, spacing: 8) {
          if let block = voice.block {
            InboxPromptBlockView(card: card, voice: voice, block: block)
          }
          InboxVoiceStrip(card: card, voice: voice)
        }
      } else {
        row(field)
      }
      if let line = host.dictation.statusLine(card.id) {
        Text(line.text)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: line.isError ? Palette.tone(.failed) : Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
          .contentShape(Rectangle())
          // A refused permission is fixed in the iOS Settings: the line opens them.
          .onTapGesture { if line.opensSettings { host.dictation.openSettings() } }
          .accessibilityAddTraits(line.opensSettings ? .isButton : [])
          .accessibilityHint(line.opensSettings ? UICopy.voiceSettingsHint : "")
          .accessibilityIdentifier("inbox.replyDictation.\(card.id)")
      }
      if let note = field.note {
        Text(note)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: field.noteIsError ? Palette.tone(.failed) : Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("inbox.replyNote.\(card.id)")
      }
    }
    .padding(.trailing, 10)
  }

  /// The row at rest: the field, the mic, the voice agent button (where the app offers it) and ↑, 44 pt each.
  private func row(_ field: InboxReplyField) -> some View {
    let recording = host.dictation.records(card.id)
    // A running recording is an entry: ↑ ends it and sends the whole text, also from an empty field.
    let sendable = recording || !field.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    return HStack(alignment: .bottom, spacing: 8) {
      TextField(
        UICopy.inboxReplyPlaceholder, text: Binding(get: { host.field(card).text }, set: { host.edit(card, $0) }),
        axis: .vertical
      )
      .lineLimit(1...6)
      .appFont(.callout)
      .foregroundStyle(Color(uiColor: Palette.text))
      .focused($focused)
      .onKeyPress(.escape) {
        focused = false
        return .handled
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(minHeight: 44)
      .background(RoundedRectangle.block.fill(Color(uiColor: Palette.surface2)))
      .accessibilityLabel(UICopy.inboxReplyPlaceholder)
      .accessibilityIdentifier("inbox.reply.\(card.id)")
      InboxDictationMic(card: card, recording: recording) {
        host.toggleDictation(card, navigation: navigation)
      }
      if voice.offered(card) {
        InboxVoiceButton(card: card, voice: voice)
      }
      Button { host.send(card, store: store) } label: {
        Image(systemName: "arrow.up")
          .font(.system(size: 15, weight: .bold))
          .foregroundStyle(Color(uiColor: sendable ? Palette.onState : Palette.muted))
          .frame(width: 40, height: 40)
          .background(Circle().fill(Color(uiColor: sendable ? Palette.accent : .clear)))
          .overlay(Circle().stroke(Color(uiColor: sendable ? .clear : Palette.border), lineWidth: 1))
          .frame(width: 44, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!sendable)
      .pointerTip(UICopy.inboxReplySend)
      .accessibilityLabel(UICopy.inboxReplySend)
      .accessibilityIdentifier("inbox.replySend.\(card.id)")
    }
  }
}

/// The dictation mic of a card's reply row, before the voice agent button: a plain ring, lit in the error tone while
/// it records (the message field's mic). The card's conversation replaces the whole row, so the mic never stands
/// beside a running conversation of its card.
struct InboxDictationMic: View {
  let card: InboxCardModel
  let recording: Bool
  let action: () -> Void

  var body: some View {
    let tone = recording ? Palette.err : Palette.muted
    Button(action: action) {
      Image(systemName: recording ? "mic.fill" : "mic")
        .font(.system(size: 17, weight: .medium))
        .foregroundStyle(Color(uiColor: tone))
        .frame(width: 40, height: 40)
        .overlay(Circle().stroke(Color(uiColor: recording ? Palette.err : Palette.border), lineWidth: 1))
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .pointerTip(UICopy.inboxReplyMic)
    .accessibilityLabel(UICopy.inboxReplyMic)
    .accessibilityHint(recording ? UICopy.voiceMicStopHint : UICopy.voiceMicHint)
    .accessibilityAddTraits(recording ? .isSelected : [])
    .accessibilityIdentifier("inbox.replyMic.\(card.id)")
  }
}
#endif
