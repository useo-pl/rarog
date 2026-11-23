#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Karty decyzji w transkrypcie: zgoda, dialog w panelu, ślad karty zdjętej nie z naszej decyzji,
// i same decyzje (żądanie, zdanie po wyniku, sprzątanie śladów). Karta pytania: `+Answers`.
// Właściciel: karty.
extension SessionViewController {
  func permissionCardView(_ card: PermissionCardModel) -> some View {
    PermissionCardView(
      card: card,
      decide: { [weak self] decision in self?.decide(card, decision) },
      showFullInput: { [weak self] in self?.openFullInput(card) })
  }

  /// The window with the whole input of a card whose block shows a preview (decision 4); a window like the
  /// transcript text: it gives way to a form. Opening only notes the presentation for the card; its consent unlocks
  /// once that presentation's content appeared on screen (``fullInputAppeared(_:)``).
  /// A window closed or replaced before its content appeared, or kept out by a form, never reports and marks nothing.
  func openFullInput(_ card: PermissionCardModel) {
    guard let navigation, let full = card.fullInput else { return }
    let request = ConsentInputRequest(
      toolName: card.toolName, text: full.text, appeared: { [weak self] in self?.fullInputAppeared($0) })
    ui.fullInputRead.open(request.id, permId: card.permId)
    navigation.openSheet(.consentInput(request))
  }

  /// The content of a full-input window appeared on screen (`ConsentInputSheet`): the card this screen opened it for
  /// unlocks its consent. A presentation of a card already gone, or one this screen did not open, marks nothing.
  func fullInputAppeared(_ presentation: UUID) {
    guard ui.fullInputRead.appeared(presentation) else { return }
    scheduleRender()
  }

  func herdrDialogView(_ card: HerdrDialogCardModel) -> some View {
    HerdrDialogCardView(
      card: card,
      decide: { [weak self] decision in self?.decideDialog(card, decision) })
  }

  func noticeView(_ text: String) -> some View {
    QuietLineView(voice: nil, text: text, identifier: "transcript.notice")
  }

  /// Krok renderu kart po złożeniu wierszy: karta stanu zamiast pola, ratunek fokusu po zniknięciu
  /// karty, klawisze przy stojącej decyzji. Woła go rdzeń jedną linią na końcu renderu.
  func renderCards(_ state: AppState) {
    renderStateCard(state)
    rescueCardFocus()
    claimKeyboardForCards()
  }

  /// Ślady kart, których już nie ma, nie wiszą w pamięci ekranu.
  func pruneCards(_ state: AppState) {
    let live = Set(state.transcripts[sessionId]?.pendingPermissions.map(\.permId) ?? [])
    ui.errors = ui.errors.filter { live.contains($0.key) }
    ui.notes = ui.notes.filter { live.contains($0.key) }
    ui.fullInputRead.keep(live)
    settleQuestions(state)
    // Stan karty dialogu dotyczy jednego czekania sesji; nowe czekanie (albo brak karty) zaczyna od
    // zera, a inny dialog pod tym samym czekaniem rozbraja zatwierdzenie.
    let settled = HerdrDialogCards.settle(ui.dialog, state: state, sessionId: sessionId)
    if settled != ui.dialog { ui.dialog = settled }
  }

  // MARK: - Karta zgody

  func decide(_ card: PermissionCardModel, _ decision: PermissionDecision) {
    guard card.phase == .idle, card.lockedReason == nil else { return }
    // Apka nie oddaje karty do terminala (`release` służy komendzie `rarog dialogs release` i przerwaniu sesji);
    // „Odrzuć” (także Esc) tylko tam, gdzie karta je pokazuje.
    if decision == .release || (decision == .deny && !card.canDeny) { return }
    // A consent of a long request leaves only after its window appeared, whatever path
    // calls this. The mark comes from this screen's state, not from the card captured at its render.
    var current = card
    current.fullInputRead = ui.fullInputRead.contains(card.permId)
    guard current.permits(decision) else { return }
    let choice: PermissionDecision
    if decision == .allow {
      guard let primary = card.primaryDecision else {
        ui.errors[card.permId] = card.approvalUnavailable
        if let message = card.approvalUnavailable, canAnnounce(in: announcementScope) {
          announcer.say(message, priority: .urgent)
        }
        scheduleRender()
        return
      }
      choice = primary
    } else {
      choice = decision
    }
    ui.errors[card.permId] = nil
    ui.notes[card.permId] = nil
    scheduleRender()
    let scope = announcementScope
    Task { [weak self] in
      guard let self else { return }
      // Decyzja adresuje kartę z chwili naciśnięcia (`permId`); zdjęta w trakcie = nic nie wychodzi.
      let outcome = await self.store.decidePermission(sessionId: card.sessionId, permId: card.permId, decision: choice)
      switch outcome {
      case .accepted:
        // Fazę „wysłano” niesie wpis decyzji w store (`DecisionAttempt.accepted`), nie stan tego ekranu.
        if self.canAnnounce(in: scope) { self.announcer.say(card.acceptedSpoken(choice)) }
      default:
        if let note = card.decisionNote(outcome) {
          // Karta kanału po 409 `conflict` zostaje: zdanie informacyjne pod nią, nie błąd.
          self.ui.notes[card.permId] = note
          if self.canAnnounce(in: scope) { self.announcer.say(note) }
        } else if let message = UICopy.decisionResult(outcome) {
          self.ui.errors[card.permId] = message
          if self.canAnnounce(in: scope) { self.announcer.say(message, priority: .urgent) }
        }
      }
      self.scheduleRender()
    }
  }

  // MARK: - Dialog w panelu

  /// Decyzja o dialogu w panelu. Zatwierdzenie rozpoznanego dialogu jest DWUTAPOWE:
  /// pierwszy tap uzbraja na 5 s, drugi wysyła — skutek wychodzi poza sesję, drugi tap jest tańszy
  /// niż cofanie go z telefonu. Odpowiedź dotyczy tylko czekania, z którego wyszła (`identity`).
  /// Uzbrojenie i zatwierdzenie dotyczą dialogu z karty (`signature`): podmieniony dialog wymaga
  /// własnych dwóch tapnięć, a rdzeń nie wyśle zgody, gdy stoi już inny (`.changed`).
  func decideDialog(_ card: HerdrDialogCardModel, _ decision: PermissionDecision) {
    guard card.phase == .idle, card.lockedReason == nil else { return }
    var local = ui.dialog?.identity == card.identity ? ui.dialog! : DialogCardUI(identity: card.identity)
    if decision == .allow {
      guard card.allowLabel != nil else { return }
      if !card.allowArmed {
        local.arm(card.signature, until: Date().addingTimeInterval(RarogNavigation.closeArmWindow))
        ui.dialog = local
        announcer.say(UICopy.dialogConfirmSpoken)
        scheduleRender()
        Task { [weak self] in
          try? await Task.sleep(for: .seconds(RarogNavigation.closeArmWindow))
          self?.scheduleRender()
        }
        return
      }
    } else if card.channelDead {
      return
    }
    local.disarm()
    local.phase = .sending(decision)
    local.status = nil
    ui.dialog = local
    scheduleRender()
    let allowSpoken = UICopy.herdrDialog(card.signature.dialog, reason: nil).allowSpoken
    let scope = announcementScope
    Task { [weak self] in
      guard let self else { return }
      let outcome = await self.store.decideDialog(sessionId: card.sessionId, decision: decision, seen: card.signature)
      guard self.ui.dialog?.identity == card.identity else { return }
      self.ui.dialog?.phase = .idle
      if let result = UICopy.dialogResult(outcome, decision: decision, allowSpoken: allowSpoken) {
        self.ui.dialog?.status = result.text
        self.ui.dialog?.statusIsError = result.isError
        if self.canAnnounce(in: scope) {
          self.announcer.say(result.text, priority: result.isError ? .urgent : .normal)
        }
      }
      self.scheduleRender()
    }
  }
}
#endif
