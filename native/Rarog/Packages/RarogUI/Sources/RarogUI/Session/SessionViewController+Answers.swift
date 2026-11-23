#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Karty pytań na ekranie sesji: widok karty, gest → odpowiedź, wynik, okno
// potwierdzenia. Stan lokalny w `ui.questions` (`Model/QuestionCardState`). Właściciel: karty
// pytań.
//
// Odpowiedź adresuje kartę z chwili gestu (`qId`), ale sprawdza ją na BIEŻĄCYM wierszu: karta
// zdjęta albo już w drodze niczego nie wysyła. Wynik trafia wyłącznie do tego ekranu — kontroler
// zamknięty w trakcie żądania go nie dostaje (słaba referencja), a magazyn i tak rozstrzyga kartę
// po swojemu (ślad, decyzja w locie).
extension SessionViewController {
  func questionCardView(_ card: QuestionCardModel) -> some View {
    QuestionCardView(card: card, drafts: ui.questions.drafts, actions: questionActions)
  }

  private var questionActions: QuestionCardActions {
    QuestionCardActions(
      pick: { [weak self] card, section, label in self?.pickQuestionOption(card.qId, section: section, label: label) },
      openCustom: { [weak self] card, section in self?.openQuestionCustom(card.qId, section: section) },
      setCustom: { [weak self] card, section, text in self?.setQuestionCustom(card.qId, section: section, text: text) },
      setNote: { [weak self] card, section, text in self?.setQuestionNote(card.qId, section: section, text: text) },
      send: { [weak self] card, answers, notes in self?.sendAnswers(card.qId, answers, notes: notes) },
      missing: { [weak self] card, message in self?.showQuestionError(card.qId, message) }
    )
  }

  /// Karta pytania z bieżącego renderu, w transkrypcie albo w doku — tylko ona może przyjąć gest.
  func liveQuestionCard(_ qId: String) -> QuestionCardModel? {
    let id = "q\(qId)"
    let docked = dockModel?.row.id == id ? dockModel?.row : nil
    guard case let .question(card)? = rows[id] ?? docked else { return nil }
    return card
  }

  /// Wybór opcji (tapnięcie albo cyfra). Karta `instant` wysyła od razu.
  func pickQuestionOption(_ qId: String, section: Int, label: String) {
    guard ui.questions.flights[qId] == nil, let card = liveQuestionCard(qId), card.interactive,
      card.sections.indices.contains(section),
      card.sections[section].options.contains(where: { $0.label == label && $0.selectable })
    else { return }
    if card.instant {
      sendAnswers(qId, [[label]])
      return
    }
    let multi = card.sections[section].multiSelect
    ui.questions.drafts.update(qId, sections: card.sections.count) { $0.toggle(label, in: section, multiSelect: multi) }
    clearQuestionError(qId)
    claimKeyboardForCards()
  }

  private func openQuestionCustom(_ qId: String, section: Int) {
    guard let card = liveQuestionCard(qId), card.interactive else { return }
    ui.questions.drafts.update(qId, sections: card.sections.count) { $0.openCustom(in: section) }
  }

  private func setQuestionCustom(_ qId: String, section: Int, text: String) {
    guard let card = liveQuestionCard(qId), card.interactive else { return }
    ui.questions.drafts.update(qId, sections: card.sections.count) { $0.setCustom(text, in: section) }
    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { clearQuestionError(qId) }
  }

  /// Notatka do wybranej opcji. Szkic jak pole własnej odpowiedzi: trzyma się `qId` karty
  /// i przeżywa odmowę serwera (422) oraz błąd sieci — karta wraca do wyboru z tym samym tekstem.
  private func setQuestionNote(_ qId: String, section: Int, text: String) {
    guard let card = liveQuestionCard(qId), card.interactive,
      card.sections.indices.contains(section), card.sections[section].notes
    else { return }
    ui.questions.drafts.update(qId, sections: card.sections.count) { $0.setNote(text, in: section) }
    clearQuestionError(qId)
  }

  /// „Odpowiedz" z klawiatury (Enter): ta sama reguła co przycisk karty.
  func submitQuestion(_ qId: String) {
    guard let card = liveQuestionCard(qId) else { return }
    let draft = ui.questions.drafts.draft(qId, sections: card.sections.count)
    switch card.submission(draft) {
    case let .send(answers, notes): sendAnswers(qId, answers, notes: notes)
    case let .missing(_, message), let .noteRejected(_, message): showQuestionError(qId, message)
    case nil: break
    }
  }

  /// Wysyłka odpowiedzi. Karta przechodzi w „Wysłano „X" → czekam na ekran" od razu; wynik
  /// zmienia ją w potwierdzenie albo wraca do wyboru z powodem.
  func sendAnswers(_ qId: String, _ answers: [[String]], notes: [String?]? = nil) {
    // Wiersz zmienia etap dopiero w najbliższym renderze — drugi gest przed nim nie wysyła.
    guard ui.questions.flights[qId] == nil, let card = liveQuestionCard(qId), card.interactive else { return }
    ui.questions.begin(card, answers: answers)
    scheduleRender()
    let store = store
    let sessionId = card.sessionId
    let scope = announcementScope
    Task { [weak self] in
      let outcome = await store.answerQuestion(sessionId: sessionId, qId: qId, answers: answers, notes: notes)
      // Ekran zamknięty w trakcie żądania: wynik nie należy do żadnej prezentacji.
      guard let self else { return }
      if let spoken = self.ui.questions.finish(qId, outcome), self.canAnnounce(in: scope) {
        self.announcer.say(spoken)
      }
      self.scheduleRender()
    }
  }

  private func showQuestionError(_ qId: String, _ message: String) {
    ui.questions.errors[qId] = message
    if canAnnounce(in: announcementScope) { announcer.say(message, priority: .urgent) }
    scheduleRender()
  }

  private func clearQuestionError(_ qId: String) {
    guard ui.questions.errors[qId] != nil else { return }
    ui.questions.errors[qId] = nil
    scheduleRender()
  }

  /// Porządki przy każdym renderze, PRZED składaniem wierszy: okno potwierdzenia liczy się od
  /// pierwszego stanu bez pytania, szkice i zdania kart, których już nie ma, znikają.
  func settleQuestions(_ state: AppState) {
    let pending = state.transcripts[sessionId]?.pendingQuestions.map(\.qId) ?? []
    let next = ui.questions.settle(pending: pending, now: Date())
    ui.questions.drafts.keep(only: Set(pending).union(ui.questions.flights.keys))
    wakeForQuestions(at: next)
    // Po renderze (wiersze i pole już nowe): klawiatura sprzętowa bez adresata trafia do karty,
    // a po kartach wraca do pola.
    if !pending.isEmpty || isFirstResponder {
      DispatchQueue.main.async { [weak self] in self?.claimKeyboardForCards() }
    }
  }

  /// Jedno przebudzenie naraz, na najbliższy koniec okna potwierdzenia (render przelicza resztę).
  private func wakeForQuestions(at next: Date?) {
    guard let next else {
      ui.questions.wakeAt = nil
      return
    }
    if let planned = ui.questions.wakeAt, planned <= next, planned > Date() { return }
    ui.questions.wakeAt = next
    let delay = max(0, next.timeIntervalSinceNow)
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard let self, self.ui.questions.wakeAt == next else { return }
      self.ui.questions.wakeAt = nil
      self.scheduleRender()
    }
  }
}
#endif
