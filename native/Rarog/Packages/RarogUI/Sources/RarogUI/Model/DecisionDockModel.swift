import Foundation
import RarogContract
import RarogCore

// Karta decyzji w doku, w miejscu pola wiadomości. Miejsce karty rozstrzyga
// `DecisionDock.placement` (plik reguły stopy `FootContent`), a wiersz doku składa się z tych samych funkcji co ogon
// transkryptu, więc karta w doku i karta w transkrypcie to ten sam model. Właściciel: karty.

/// Co stoi w doku: wiersz karty (zgoda, „dialog w terminalu”, pytanie albo potwierdzenie odpowiedzi; w okresie łaski
/// zastępnik `TranscriptRow.decisionPending`) i miejsce w kolejce.
public struct DecisionDockModel: Sendable, Equatable {
  public let row: TranscriptRow
  /// Liczba kart decyzji w kolejce tej sesji; dok pokazuje pierwszą.
  public let total: Int

  public init(row: TranscriptRow, total: Int) {
    self.row = row
    self.total = total
  }

  /// „1 z 3” w nagłówku doku — tylko przy kolejce.
  public var position: String? { total > 1 ? UICopy.dockPosition(1, of: total) : nil }
}

extension Optional where Wrapped == DecisionCard {
  /// W doku stoi karta „dialog w terminalu” (jedna na sesję, więc adres nie jest potrzebny).
  var isHerdrDialog: Bool {
    if case .herdrDialog? = self { return true }
    return false
  }
}

extension TranscriptRows {
  /// Wiersz karty, która stoi w doku — ten sam model, który bez doku stałby w ogonie transkryptu (`tail`). `nil`, gdy
  /// karty pod tym adresem już nie ma; wtedy dok jej nie stawia (`placeDock`).
  public static func dockRow(
    state: AppState, sessionId: String, ui: TranscriptUIState, card: DecisionCard, now: Date = Date()
  ) -> TranscriptRow? {
    guard let view = state.transcripts[sessionId] else { return nil }
    let session = state.sessions[sessionId]
    let locked = lockedReason(state: state, session: session)
    switch card {
    case let .permission(permId):
      guard let request = view.pendingPermissions.first(where: { $0.permId == permId }) else { return nil }
      return .permission(permissionCard(request, view: view, session: session, ui: ui, locked: locked))
    case let .herdrDialog(identity):
      guard !ui.questions.holdsDialogCard,
        let dialog = HerdrDialogCards.make(state: state, sessionId: sessionId, ui: ui.dialog, locked: locked, now: now),
        dialog.identity == identity
      else { return nil }
      return .herdrDialog(dialog)
    case let .question(qId):
      guard let request = view.pendingQuestions.first(where: { $0.qId == qId }) else { return nil }
      return questionRow(request, view: view, ui: ui, locked: locked)
    case let .heldQuestion(qId):
      guard !view.pendingQuestions.contains(where: { $0.qId == qId }), let flight = ui.questions.flights[qId] else {
        return nil
      }
      return heldQuestionRow(flight)
    }
  }
}
