#if os(iOS)
import Observation
import RarogContract
import RarogCore
import SwiftUI

// Decisions taken on Inbox cards without opening the session: the permission card and the pane dialog card of the
// transcript, built by the same model functions (`TranscriptRows.permissionCard`, `HerdrDialogCards.make`) and sent
// by the same store actions. The rules of a decision live on the card models (`permits`, `primaryDecision`, `canDeny`,
// the full-input window, the two taps of a recognized dialog); this host keeps what the session screen keeps for its
// cards (the sentence under a card, the full-input marks, the dialog card's arming) and holds the card in place
// before the request leaves. Owner: Inbox.

@MainActor
@Observable
final class InboxDecisionHost {
  /// The sentence under a permission card after a failed decision, by `permId`.
  private(set) var errors: [String: String] = [:]
  /// The informational sentence under a permission card, by `permId`.
  private(set) var notes: [String: String] = [:]
  /// Cards whose full-input window appeared from the Inbox.
  private var fullInputRead = FullInputMarks()
  /// The pane dialog cards' local state, by session.
  private var dialogs: [String: DialogCardUI] = [:]
  @ObservationIgnored private let announcer: Announcer

  init(announcer: Announcer = .shared) {
    self.announcer = announcer
  }

  // MARK: - Permission card

  func permissionCard(_ request: PermissionRequest, state: AppState) -> PermissionCardModel? {
    guard let view = state.transcripts[request.sessionId] else { return nil }
    let session = state.sessions[request.sessionId]
    var ui = TranscriptUIState()
    ui.errors = errors
    ui.notes = notes
    ui.fullInputRead = fullInputRead
    return TranscriptRows.permissionCard(
      request, view: view, session: session, ui: ui, locked: TranscriptRows.lockedReason(state: state, session: session))
  }

  func decide(_ card: PermissionCardModel, _ decision: PermissionDecision, store: RarogStore) {
    guard card.phase == .idle, card.lockedReason == nil else { return }
    // As on the session screen: the app never releases a card to the terminal, and Deny only where the card shows it.
    if decision == .release || (decision == .deny && !card.canDeny) { return }
    var current = card
    current.fullInputRead = fullInputRead.contains(card.permId)
    guard current.permits(decision) else { return }
    let choice: PermissionDecision
    if decision == .allow {
      guard let primary = card.primaryDecision else {
        errors[card.permId] = card.approvalUnavailable
        if let message = card.approvalUnavailable { announcer.say(message, priority: .urgent) }
        return
      }
      choice = primary
    } else {
      choice = decision
    }
    errors[card.permId] = nil
    notes[card.permId] = nil
    store.holdInboxCard(card.sessionId)
    Task {
      let outcome = await store.decidePermission(sessionId: card.sessionId, permId: card.permId, decision: choice)
      switch outcome {
      case .accepted:
        announcer.say(card.acceptedSpoken(choice))
      default:
        if let note = card.decisionNote(outcome) {
          notes[card.permId] = note
          announcer.say(note)
        } else if let message = UICopy.decisionResult(outcome) {
          errors[card.permId] = message
          announcer.say(message, priority: .urgent)
        }
      }
    }
  }

  /// The window with the whole input of a long request; its consent unlocks once that window's content appeared.
  func openFullInput(_ card: PermissionCardModel, navigation: RarogNavigation) {
    guard let full = card.fullInput else { return }
    let request = ConsentInputRequest(
      toolName: card.toolName, text: full.text, appeared: { [weak self] presentation in
        _ = self?.fullInputRead.appeared(presentation)
      })
    fullInputRead.open(request.id, permId: card.permId)
    navigation.openSheet(.consentInput(request))
  }

  // MARK: - Pane dialog card

  /// The pane dialog card of a `decision` card whose dialog has no card, by the session screen's rule: it stands once
  /// the Inbox's transcript read gave the transcript (`AppState.herdrDialogShown`), the same snapshot whose
  /// signature the dismiss request needs. Until then the card offers "Open session" only.
  func dialogCard(_ sessionId: String, state: AppState, now: Date = Date()) -> HerdrDialogCardModel? {
    let session = state.sessions[sessionId]
    let settled = HerdrDialogCards.settle(dialogs[sessionId], state: state, sessionId: sessionId)
    return HerdrDialogCards.make(
      state: state, sessionId: sessionId, ui: settled,
      locked: TranscriptRows.lockedReason(state: state, session: session), now: now)
  }

  /// Approving a recognized dialog takes two taps within the arming window, as on the session screen.
  func decideDialog(_ card: HerdrDialogCardModel, _ decision: PermissionDecision, store: RarogStore) {
    guard card.phase == .idle, card.lockedReason == nil else { return }
    var local = dialogs[card.sessionId].flatMap { $0.identity == card.identity ? $0 : nil }
      ?? DialogCardUI(identity: card.identity)
    if decision == .allow {
      guard card.allowLabel != nil else { return }
      if !card.allowArmed {
        local.arm(card.signature, until: Date().addingTimeInterval(RarogNavigation.closeArmWindow))
        dialogs[card.sessionId] = local
        announcer.say(UICopy.dialogConfirmSpoken)
        Task {
          try? await Task.sleep(for: .seconds(RarogNavigation.closeArmWindow))
          // Redraw when the arming ends: the button stops asking "Sure?".
          if let current = dialogs[card.sessionId] { dialogs[card.sessionId] = current }
        }
        return
      }
    } else if card.channelDead {
      return
    }
    local.disarm()
    local.phase = .sending(decision)
    local.status = nil
    dialogs[card.sessionId] = local
    store.holdInboxCard(card.sessionId)
    let allowSpoken = UICopy.herdrDialog(card.signature.dialog, reason: nil).allowSpoken
    Task {
      let outcome = await store.decideDialog(sessionId: card.sessionId, decision: decision, seen: card.signature)
      guard dialogs[card.sessionId]?.identity == card.identity else { return }
      dialogs[card.sessionId]?.phase = .idle
      if let result = UICopy.dialogResult(outcome, decision: decision, allowSpoken: allowSpoken) {
        dialogs[card.sessionId]?.status = result.text
        dialogs[card.sessionId]?.statusIsError = result.isError
        announcer.say(result.text, priority: result.isError ? .urgent : .normal)
      }
    }
  }
}
#endif
