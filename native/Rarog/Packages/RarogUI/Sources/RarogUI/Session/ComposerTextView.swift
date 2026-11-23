#if os(iOS)
import RarogCore
import UIKit

/// Pole wiadomości z klawiszami sprzętowymi: Enter z klawiatury SPRZĘTOWEJ wysyła,
/// Shift+Enter i Cmd+Enter łamią linię. `UIKeyCommand` dostaje wyłącznie klawisze sprzętowe —
/// Return klawiatury ekranowej wstawia nową linię, bo kciuk na szkle wysyłałby pół promptu.
/// Rozstrzyga więc obecność klawiatury ekranowej, nie typ urządzenia, a pasek
/// skrótów iPadOS przy Magic Keyboard nie jest klawiaturą ekranową. W trakcie składania znaku
/// (IME, dyktowanie) Enter należy do edytora; pole tylko do odczytu nie wysyła.
final class ComposerTextView: UITextView {
  var onHardwareReturn: (() -> Void)?
  /// Wklejenie: elementy schowka, które są załącznikami (zdjęcie, plik). `true` = obsłużone.
  var onPasteAttachments: (([NSItemProvider]) -> Bool)?
  /// Szerokość pola zmieniła się (pierwszy układ, obrót) — wysokość trzeba policzyć od nowa.
  var onWidthChange: (() -> Void)?
  /// Esc z kursorem w polu (`SessionViewController+KeysInterrupt`): `canEscape` rozstrzyga, czy Esc
  /// należy do przerwania tury; bez niego Esc zostaje edytorowi i reszcie łańcucha.
  var canEscape: (() -> Bool)?
  var onEscape: (() -> Void)?
  /// Podpowiedzi komend nad polem: czy klawisz należy teraz do listy (↑/↓, Tab, Return) i jego
  /// wykonanie. Bez otwartej listy klawisze idą jak zawsze. Esc rozstrzyga `canEscape`/`onEscape` ekranu sesji.
  var suggestionTakes: ((CommandSuggestions.Key) -> Bool)?
  var onSuggestionKey: ((CommandSuggestions.Key) -> Void)?
  /// ↑ on an empty field takes the queue back (`SessionViewController+QueueTakeBack`), as in Claude Code: whether the
  /// screen has a queue to take now, and the take-back. An open suggestion list keeps ↑ first.
  var canTakeBackQueue: (() -> Bool)?
  var onTakeBackQueue: (() -> Void)?

  override var bounds: CGRect {
    didSet {
      if oldValue.width != bounds.width { onWidthChange?() }
    }
  }

  /// A disabled field adds „wyłączone” for VoiceOver only in the getter; UIKit computes the other traits.
  /// Setting `textView.accessibilityTraits` would replace them with a fixed value, and on iOS 27 XCUITest then
  /// does not see the keyboard focus in the field (UI tests with `typeText` in `composer.field`, e.g.
  /// `FlowUITests.testLoginListTranscriptSendEcho`).
  override var accessibilityTraits: UIAccessibilityTraits {
    get { isEditable ? super.accessibilityTraits : super.accessibilityTraits.union(.notEnabled) }
    set { super.accessibilityTraits = newValue }
  }

  override var keyCommands: [UIKeyCommand]? {
    let send = UIKeyCommand(title: UICopy.send, action: #selector(hardwareReturn), input: "\r")
    send.wantsPriorityOverSystemBehavior = true
    // Przytrzymany Return, który wstawił podpowiedź komendy, nie wysyła jej powtórzeniem: powtórzenie szuka
    // skrótu od nowa, a po wstawieniu lista jest już zamknięta, więc trafiłoby w wysyłkę.
    send.repeatBehavior = .nonRepeatable
    let shift = UIKeyCommand(title: UICopy.newLineCommand, action: #selector(lineBreak), input: "\r", modifierFlags: .shift)
    shift.wantsPriorityOverSystemBehavior = true
    let command = UIKeyCommand(action: #selector(lineBreak), input: "\r", modifierFlags: .command)
    command.wantsPriorityOverSystemBehavior = true
    let escape = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escapeKey))
    escape.wantsPriorityOverSystemBehavior = true
    // Przytrzymany Esc, który zamknął okno nad ekranem (okno powłoki, arkusz), nie przerywa tury pod nim.
    escape.repeatBehavior = .nonRepeatable
    // Podpowiedzi komend: bez otwartej listy `canPerformAction` mówi „nie”, a klawisz idzie dalej — kursor,
    // Tab na kartę decyzji — jak przed listą.
    let up = UIKeyCommand(input: UIKeyCommand.inputUpArrow, modifierFlags: [], action: #selector(suggestionUp))
    up.wantsPriorityOverSystemBehavior = true
    let down = UIKeyCommand(input: UIKeyCommand.inputDownArrow, modifierFlags: [], action: #selector(suggestionDown))
    down.wantsPriorityOverSystemBehavior = true
    let tab = UIKeyCommand(input: "\t", modifierFlags: [], action: #selector(suggestionTab))
    tab.wantsPriorityOverSystemBehavior = true
    tab.repeatBehavior = .nonRepeatable
    return [send, shift, command, escape, up, down, tab]
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(hardwareReturn) { return isEditable && markedTextRange == nil }
    if action == #selector(lineBreak) { return isEditable && markedTextRange == nil }
    if action == #selector(escapeKey) { return markedTextRange == nil && (canEscape?() ?? false) }
    if action == #selector(suggestionUp), !(suggestionTakes?(.up) ?? false) {
      return isEditable && markedTextRange == nil && takesBackQueue
    }
    if let key = Self.suggestionKeys[action] {
      return isEditable && markedTextRange == nil && (suggestionTakes?(key) ?? false)
    }
    // Zdjęcie i plik w schowku też da się wkleić (Cmd+V, menu) — sama obecność elementów, bez
    // czytania treści (odczyt treści przy sprawdzaniu pytałby człowieka o zgodę na schowek).
    if action == #selector(paste(_:)), isEditable, UIPasteboard.general.numberOfItems > 0 { return true }
    return super.canPerformAction(action, withSender: sender)
  }

  /// Wklejenie: zdjęcia i pliki trafiają do paska nad polem, a kursor zostaje w polu.
  /// Schowek z tekstem i adresem naraz wkleja TEKST: kod wyglądający jak URL wkleiłby
  /// się z `%20`.
  override func paste(_ sender: Any?) {
    let pasteboard = UIPasteboard.general
    if let onPasteAttachments, onPasteAttachments(pasteboard.itemProviders) { return }
    if pasteboard.hasStrings, pasteboard.hasURLs, let text = pasteboard.string {
      pasteText(text)
      return
    }
    super.paste(sender)
  }

  /// The text of a pasteboard with text and an address together, in place of the selection. A method of its own:
  /// the UIKit test host may not read the pasteboard.
  func pasteText(_ text: String) {
    insertFromCode(text)
  }

  /// An edit the field's own code makes (the paste above, Shift+Return, a picked command): `text` in place of the
  /// composed character (IME) or the selection, reported to the delegate first (`shouldChangeTextIn`) like an edit
  /// from the keyboard. `insertText` from code does not ask the delegate, and the voice conversation follows its
  /// prompt by the reported range (`ComposerView.lastEdit`).
  func insertFromCode(_ text: String) {
    var range = selectedRange
    if let marked = markedTextRange {
      range = NSRange(
        location: offset(from: beginningOfDocument, to: marked.start), length: offset(from: marked.start, to: marked.end))
    }
    guard delegate?.textView?(self, shouldChangeTextIn: range, replacementText: text) ?? true else { return }
    insertText(text)
  }

  /// Return z otwartą listą podpowiedzi wstawia zaznaczoną komendę; drugi Return (lista już zamknięta) wysyła.
  @objc private func hardwareReturn() {
    if markedTextRange == nil, suggestionTakes?(.enter) == true {
      onSuggestionKey?(.enter)
      return
    }
    onHardwareReturn?()
  }

  private static let suggestionKeys: [Selector: CommandSuggestions.Key] = [
    #selector(suggestionUp): .up, #selector(suggestionDown): .down, #selector(suggestionTab): .tab,
  ]

  /// ↑ belongs to an open suggestion list first; otherwise, on an empty field with a queue, it takes the queue back.
  @objc private func suggestionUp() {
    if suggestionTakes?(.up) ?? false {
      onSuggestionKey?(.up)
    } else if takesBackQueue {
      onTakeBackQueue?()
    }
  }

  /// An empty field (no text, nothing being composed) and a queue the screen can take back.
  private var takesBackQueue: Bool {
    (text ?? "").isEmpty && markedTextRange == nil && (canTakeBackQueue?() ?? false)
  }
  @objc private func suggestionDown() { onSuggestionKey?(.down) }
  @objc private func suggestionTab() { onSuggestionKey?(.tab) }

  @objc private func lineBreak() {
    insertFromCode("\n")
  }

  @objc private func escapeKey() {
    onEscape?()
  }

  /// Zapis całego tekstu z kodu (wysyłka, odmowa, Esc, dyktowanie). Opróżnienie pola, które ma fokus, idzie
  /// drogą Backspace'a: zaznaczenie wszystkiego i `deleteBackward()`, nie przypisanie `text`. Programowe
  /// wyczyszczenie sfokusowanego pola każe UIKit przeliczyć kontekst klawiatury i na iPadOS 26+ z klawiaturą
  /// sprzętową wystawia pod polem pigułkę „PL EN + mikrofon”; edycja jak klawiszem
  /// jej nie daje. Skutek uboczny: Cmd+Z po wysyłce oddaje wysłany tekst. W trakcie składania znaku (IME)
  /// i bez fokusu — zwykłe przypisanie.
  func replace(all newValue: String) {
    let current = text ?? ""
    if newValue.isEmpty, !current.isEmpty, isFirstResponder, isEditable, markedTextRange == nil,
      let all = textRange(from: beginningOfDocument, to: endOfDocument) {
      selectedTextRange = all
      deleteBackward()
      if (text ?? "").isEmpty { return }
    }
    text = newValue
  }
}
#endif
