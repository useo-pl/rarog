#if os(iOS)
import Foundation
import RarogContract
import RarogCore
import UIKit

// The queue take-back on the session screen, as in Claude Code ("Take back what you queued"): ↑ on an empty field
// with no open suggestion list, a tap on a queued bubble and its VoiceOver action bring every queued prompt back into
// the message field; the turn runs on, and Esc still interrupts it (`+KeysInterrupt`). The texts stand one per line
// before the draft (`QueueTakeBackField`). Owner: send.
extension SessionViewController {
  /// From `installTurnControl`. ↑ takes the queue back only while the session has a queued bubble or keeps a take-back
  /// without an answer (`AppState.canTakeBackQueue`); otherwise it keeps its meaning (the cursor, the suggestion list).
  func installQueueTakeBack() {
    // The answer of a take-back goes to the screen of the session that stands at answer time (`takeBackQueue`).
    drafts.registerScreen(self, for: sessionId)
    composer.textView.canTakeBackQueue = { [weak self] in
      guard let self else { return false }
      return !self.composer.commandSuggestionsOpen && self.store.state.canTakeBackQueue(self.sessionId)
    }
    composer.textView.onTakeBackQueue = { [weak self] in self?.takeBackQueue(tapped: nil) }
  }

  /// One take-back gesture. `tapped`: the bubble's outbox entry, whose text the cursor follows; `nil` (↑) puts the
  /// cursor at the end of the field. A gesture while a take-back is in flight sends nothing (the store's gate) and
  /// gives no feedback.
  ///
  /// The server answers after a second or more, so a started take-back shows at once: the store starts it in this
  /// turn, the screen renders the queued bubbles taking back before returning, and a light haptic tap confirms the
  /// gesture. The answer ends the state through the store.
  ///
  /// The texts go where they will not be lost, decided at answer time: the screen of the gesture may have closed, and
  /// a new screen of the session may stand with its own live field. A live field writes the session's draft next, so
  /// the texts go into the field of the screen that will (`receivingScreen`), merged once; only with no screen of the
  /// session alive do they go on top of the stored draft. Either way the store frees the bubbles and the id only after
  /// the disk confirmed the write.
  func takeBackQueue(tapped: UUID?) {
    let store = store
    let sessionId = sessionId
    // The draft store of this screen's space, which also knows the session's screens.
    let drafts = drafts
    guard let ticket = store.startTakeBack(sessionId) else { return }
    queueTakeBackFeedback()
    renderNow()
    Task {
      let outcome = await store.finishTakeBack(ticket) { response in
        guard !response.items.isEmpty else { return true }
        if let screen = Self.receivingScreen(of: sessionId, drafts: drafts, state: store.state) {
          return await screen.receiveTaken(response.items, tapped: tapped)
        }
        return await drafts.saveTaken(QueueTakeBackField.taken(response.items), for: sessionId)
      }
      let screens = Self.screens(of: sessionId, drafts: drafts)
      screens.last { $0.isScreenAttached(store.state) }?.showTakeBackResult(outcome)
    }
  }

  /// The session's live screens, the latest registered last.
  private static func screens(of sessionId: String, drafts: ComposerDrafts) -> [SessionViewController] {
    drafts.screens(for: sessionId).compactMap { $0 as? SessionViewController }
  }

  /// The screen whose live field writes the session's draft next: the latest one in a window, or else the latest one
  /// still alive. A screen out of the window (under a full-screen presentation, or closed and not yet released) keeps
  /// its field and writes it again when it changes, without taking the stored draft back, so texts put only into the
  /// stored draft would be overwritten. `nil`: no screen of the session lives.
  private static func receivingScreen(
    of sessionId: String, drafts: ComposerDrafts, state: AppState
  ) -> SessionViewController? {
    let screens = screens(of: sessionId, drafts: drafts)
    return screens.last { $0.isScreenAttached(state) } ?? screens.last
  }

  /// The texts into the live field, then a confirmed write of the field to the durable draft: `true` once the disk
  /// took it. That write replaces the draft, so a failed send's text that waits for this screen joins the field
  /// first, and the taken texts stand before it. A refused write takes the taken texts out of the field again, unless
  /// it changed meanwhile, so the replay of the same take-back brings them once; the bubbles still hold them, and the
  /// failed send's text stays in the field for its next write. A tap brings the keyboard focus to the field, so the
  /// cursor stands where the tapped text ends.
  private func receiveTaken(_ items: [QueueTakeBackItem], tapped: UUID?) async -> Bool {
    takeWaitingDraft()
    let before = composer.text
    let selection = composer.textView.selectedRange
    let merged = QueueTakeBackField.merge(items, into: before, tapped: tapped.map { $0.uuidString.lowercased() })
    if tapped != nil, view.window != nil, composer.isEditable, !composer.textView.isFirstResponder {
      composer.textView.becomeFirstResponder()
    }
    composer.text = merged.text
    composer.textView.selectedRange = NSRange(location: merged.cursor, length: 0)
    composer.textView.scrollRangeToVisible(composer.textView.selectedRange)
    guard await persistDraftConfirmed() else {
      if composer.text == merged.text {
        composer.text = before
        composer.textView.selectedRange = selection
      }
      return false
    }
    return true
  }

  /// The sentence under the field: a note when part of the queue stayed in the terminal, the refusal, the server
  /// update, no connection or a draft the disk refused. Shown by the screen of the session in a window at answer
  /// time; with none nothing shows. A disabled field (a standing decision, when a tap or VoiceOver still reach the
  /// bubble) shows it until the next render puts its own reason back, as after a send, and VoiceOver hears it.
  private func showTakeBackResult(_ outcome: QueueTakeBackOutcome) {
    guard let result = UICopy.queueTakeBackResult(outcome) else { return }
    transientHint = composer.isEditable
    composer.setHint(result.text, isError: result.isError)
    if !composer.isEditable, canAnnounce(in: announcementScope) {
      announcer.say(result.text, priority: result.isError ? .urgent : .normal)
    }
  }
}
#endif
