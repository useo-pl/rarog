#if os(iOS)
import RarogCore
import UIKit

// Klawiatura sprzętowa na karcie pytania: 1–9 wybiera n-tą WIDOCZNĄ opcję pytania,
// które ma klawiaturę, Enter = „Odpowiedz". Listy `answerKeyCommands` i `answerKeyVerdict`
// wchodzą do `keyCommands` i `canPerformAction` kontrolera. Właściciel: karty pytań.
//
// Bramki, każda z powodu: cyfra w polu tekstowym (pole wiadomości, „Własna odpowiedź") jest
// TEKSTEM, nigdy decyzją; modyfikator oddaje klawisz apce (Cmd+1 to zakładki — skróty mają
// `modifierFlags: []`, więc Cmd+cyfra ich nie trafia); przytrzymanie nie jest drugą decyzją.
// Fokus klawiatury na komórce karty albo na doku z kartą pytania (`+Dock`) wskazuje kartę; fokus na
// czymkolwiek innym (karta zgody, przycisk, lista) zabiera klawisze kartom pytań. Bez fokusu
// klawiatury cyfry idą do pierwszej karty pytania, która czeka — najpierw tej w doku (pierwsza decyzja
// kolejki), potem w transkrypcie.
extension SessionViewController {
  var answerKeyCommands: [UIKeyCommand] {
    // Przy pisaniu nie wystawiamy skrótów wcale — nie polegamy na tym, czy wyłączony skrót odda
    // klawisz edytorowi.
    guard !typingInTextField, keyQuestionCard() != nil else { return [] }
    let digits = (1...9).map { UIKeyCommand(input: String($0), modifierFlags: [], action: #selector(answerDigitKey(_:))) }
    // Enter na skupionej komórce karty to dla systemu „wybierz komórkę" (tu: nic) — skrót karty
    // musi go wyprzedzić. Fokus na czymkolwiek innym (przycisk, pole) skrótów nie wystawia wcale,
    // więc Enter na przycisku zostaje jego aktywacją.
    let enter = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(answerEnterKey))
    enter.wantsPriorityOverSystemBehavior = true
    // Przytrzymany klawisz nie dosyła powtórzeń: karta `instant` odpowiada pierwszym naciśnięciem
    // i gaśnie, a powtórzenie trafiłoby w NASTĘPNĄ kartę. Druga zapora: `QuestionKeyRepeat`.
    let commands = digits + [enter]
    for command in commands { command.repeatBehavior = .nonRepeatable }
    return commands
  }

  /// `nil` = akcja nie należy do kart pytań.
  func answerKeyVerdict(_ action: Selector) -> Bool? {
    guard action == #selector(answerDigitKey(_:)) || action == #selector(answerEnterKey) else { return nil }
    return !typingInTextField && keyQuestionCard() != nil
  }

  // Ekran sesji przyjmuje klawisze sam, gdy nikt inny ich nie ma: karta pytania czeka, pole
  // wiadomości zgasło, a klawiatura sprzętowa nie ma adresata — cyfry i Enter dochodzą do karty bez
  // szukania jej Tabem. Jedna reguła dla wszystkich kart: `claimKeyboardForCards` (`+KeysCards`).

  /// Komórka karty pytania, do której idą cyfry i Enter — karta czekająca na wybór.
  func focusableQuestionCard(at indexPath: IndexPath) -> QuestionCardModel? {
    guard let id = dataSource.itemIdentifier(for: indexPath), case let .question(card)? = rows[id], card.interactive
    else { return nil }
    return card
  }

  @objc private func answerDigitKey(_ command: UIKeyCommand) {
    guard let input = command.input, let number = Int(input) else { return }
    handleAnswerKey(.digit(number), input: input)
  }

  @objc private func answerEnterKey() {
    handleAnswerKey(.enter, input: "\r")
  }

  private func handleAnswerKey(_ key: QuestionKey, input: String) {
    guard !typingInTextField, let card = keyQuestionCard() else { return }
    let now = Date()
    let accepted = QuestionKeyRepeat.accepts(input, previous: ui.questions.lastKey, now: now)
    ui.questions.lastKey = QuestionKeyRepeat.Stamp(input: input, at: now)
    guard accepted else { return }
    let draft = ui.questions.drafts.draft(card.qId, sections: card.sections.count)
    switch card.keyAction(key, draft: draft) {
    case let .pick(section, label): pickQuestionOption(card.qId, section: section, label: label)
    case .submit: submitQuestion(card.qId)
    case nil: break
    }
  }

  /// Karta, do której idą klawisze: ta z fokusem klawiatury; bez fokusu klawiatury — pierwsza
  /// karta pytania czekająca na wybór. Fokus na czymkolwiek innym (karta zgody, przycisk, lista)
  /// = żadna: klawisz należy do tego, co ma fokus.
  private func keyQuestionCard() -> QuestionCardModel? {
    if let focused = UIFocusSystem.focusSystem(for: view)?.focusedItem {
      if focused === decisionSlot { return dockedQuestionCard() }
      guard let cell = focused as? UICollectionViewCell, let indexPath = collectionView.indexPath(for: cell) else {
        return nil
      }
      return focusableQuestionCard(at: indexPath)
    }
    if let docked = dockedQuestionCard() { return docked }
    for id in dataSource.snapshot().itemIdentifiers where id.hasPrefix("q") {
      if case let .question(card)? = rows[id], card.interactive { return card }
    }
    return nil
  }

  /// Karta pytania w doku, która czeka na wybór (`dockedCard`, `+KeysCards`).
  private func dockedQuestionCard() -> QuestionCardModel? {
    guard case let .question(card)? = dockedCard(), card.interactive else { return nil }
    return card
  }

  /// Fokus w polu tekstowym: klawisze należą do pisania.
  private var typingInTextField: Bool {
    FirstResponder.current() is UITextInput
  }
}
#endif
