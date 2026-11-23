#if os(iOS)
import GameController
import RarogContract
import RarogCore
import UIKit

// Slash command suggestions of the message field: the model, the list above the card and
// its keys. Owner: send.
extension ComposerView {
  /// Komendy oglądanej sesji (każdy render ekranu sesji); ta sama lista nic nie zmienia.
  func setCommandChoices(_ choices: [CommandChoice]) {
    guard choices != commandChoices else { return }
    commandChoices = choices
    refreshSuggestions()
  }

  /// Esc z arbitrażu ekranu sesji (`+KeysInterrupt`): zamyka otwartą listę i nic więcej. `false` = listy nie było.
  func dismissCommandSuggestions() -> Bool {
    guard suggestions.dismiss() else { return false }
    showSuggestions()
    return true
  }

  /// Model listy po zmianie tekstu, fokusu, wygaszenia albo komend. Token z fokusem, którego przed chwilą nie było,
  /// prosi ekran o listę sesji (``onCommandToken``).
  func refreshSuggestions(focused: Bool? = nil) {
    let hadToken = suggestions.focused && suggestions.token != nil
    let previous = suggestions.matches
    let focused = (focused ?? textView.isFirstResponder) && isEditable
    suggestions.update(text: textView.text ?? "", commands: commandChoices, focused: focused)
    if focused, suggestions.token != nil, !hadToken { onCommandToken?() }
    // Nowe wiersze pod wyborem z klawiatury: przebudowa przewija listę na górę, więc wybrany wiersz wraca w widok.
    showSuggestions(reveal: suggestions.picked != nil && suggestions.matches != previous)
  }

  /// Widok za modelem. Zaznaczenie widać tylko przy klawiaturze sprzętowej — tylko z nią Return i Tab wstawiają
  /// zaznaczoną komendę; palec wybiera stuknięciem.
  private func showSuggestions(reveal: Bool = false) {
    let open = suggestions.isOpen
    if !open { suggestionKeysUsed = false }
    suggestionsView.show(
      open ? suggestions.matches : [], selected: suggestions.selected,
      showsSelection: suggestionKeysUsed || GCKeyboard.coalesced != nil, reveal: reveal)
    guard suggestionsView.isHidden == open else { return }
    suggestionsView.isHidden = !open
    onSuggestionsShown?(open)
  }

  func suggestionKey(_ key: CommandSuggestions.Key) {
    switch suggestions.handle(key, composing: textView.markedTextRange != nil) {
    case .pass: break
    case .moved:
      suggestionKeysUsed = true
      showSuggestions(reveal: true)
    case .dismissed: showSuggestions()
    case let .insert(insertion): insert(insertion)
    }
  }

  func pickSuggestion(_ index: Int) {
    guard let insertion = suggestions.insertion(at: index) else { return }
    insert(insertion)
  }

  /// `/nazwa ` w miejsce tokenu edycją jak z klawiatury (zaznaczenie tokenu i `insertFromCode`): wpis ma cofanie,
  /// a pole zgłasza go jak pisanie człowieka (`textViewDidChange` → spacja zamyka listę).
  private func insert(_ insertion: CommandSuggestions.Insertion) {
    if textView.markedTextRange != nil { textView.unmarkText() }
    guard let start = textView.position(from: textView.beginningOfDocument, offset: insertion.from),
      let token = textView.textRange(from: start, to: textView.endOfDocument)
    else { return }
    textView.selectedTextRange = token
    textView.insertFromCode(insertion.text)
  }
}
#endif
