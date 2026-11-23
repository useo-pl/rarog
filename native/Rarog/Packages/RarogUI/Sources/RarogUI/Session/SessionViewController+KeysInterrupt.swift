#if os(iOS)
import RarogCore
import UIKit

// Esc z klawiatury sprzętowej przerywa turę — mapa mięśniowa z Claude Code w terminalu.
// Esc ma kilku właścicieli i rozstrzyga ich `EscapeInterruptRule`: karta z fokusem (Esc =
// „Odrzuć", `+KeysCards`, obszar kart), otwarte okno (arkusz, popover), składanie znaku w polu i lista
// podpowiedzi komend nad polem (`+CommandSuggestions`) — dopiero potem tura. Dwie drogi:
// - kursor w polu wiadomości: skrót samego pola (`ComposerTextView.canEscape`/`onEscape`) — pole
//   jest pierwsze w łańcuchu respondera, więc ani edytor, ani nic pod nim nie zabierze Esc;
// - bez kursora w polu: skrót ekranu, na liście ZA kartami — przy fokusie na karcie jego werdykt
//   jest `false`, więc Esc karty zostaje nietknięty.
// Przytrzymany klawisz nie jest drugą decyzją (`repeatBehavior`, bramka gestu w rdzeniu).
// Właściciel: przerwanie.
extension SessionViewController {
  var interruptKeyCommands: [UIKeyCommand] {
    let escape = UIKeyCommand(
      title: UICopy.shortcutInterrupt, action: #selector(escapeInterrupt), input: UIKeyCommand.inputEscape)
    escape.wantsPriorityOverSystemBehavior = true
    escape.repeatBehavior = .nonRepeatable
    return [escape]
  }

  /// Esc z kursorem w polu wiadomości (woła `installTurnControl`). Otwarta lista podpowiedzi komend bierze Esc
  /// przed turą: zamyka się i nic więcej, a drugi Esc w oknie łaski (``EscapeGrace``) też tury nie przerywa.
  func installInterruptKeys() {
    composer.textView.canEscape = { [weak self] in
      guard let self else { return false }
      return self.switcherAbsorbsEscape || self.suggestionsTakeEscape || self.escapeInterrupts
    }
    composer.textView.onEscape = { [weak self] in
      guard let self, !self.takeEscapeForSwitcher() else { return }
      if self.suggestionsTakeEscape, self.composer.dismissCommandSuggestions() {
        EscapeGrace.closedByEscape()
        return
      }
      self.interruptTurn(trigger: .escape)
    }
  }

  /// Esc należy do listy podpowiedzi komend: lista stoi, a nad ekranem nie ma okna (popover modelu przy kursorze
  /// w polu — Esc zamyka okno), fokus nie stoi na karcie i nie trwa okno łaski po innym Esc.
  private var suggestionsTakeEscape: Bool {
    composer.commandSuggestionsOpen && !overlayPresented && !transcriptHasFocus && !EscapeGrace.swallows()
  }

  /// `nil` = akcja nie należy do przerwania.
  func interruptKeyVerdict(_ action: Selector) -> Bool? {
    guard action == #selector(escapeInterrupt) else { return nil }
    return switcherAbsorbsEscape || escapeInterrupts
  }

  private var escapeInterrupts: Bool {
    EscapeInterruptRule.allows(
      cardFocused: transcriptHasFocus,
      overlayPresented: overlayPresented,
      composing: composer.textView.isFirstResponder && composer.textView.markedTextRange != nil,
      afterEscapeClose: EscapeGrace.swallows(),
      switcherAbsorbs: switcherAbsorbsEscape,
      suggestionsOpen: composer.commandSuggestionsOpen,
      availability: store.state.interruptAvailability(for: sessionId))
  }

  /// The session switcher owns Esc while its window is open. Its overlay is not a presented window, so
  /// `overlayPresented` does not see it.
  var switcherAbsorbsEscape: Bool { switcher?.absorbsEscape ?? false }

  /// Esc with the switcher window open closes it and does NOTHING else: no turn interrupt, no card dismissal.
  /// `true` = Esc taken. A safety net: the window's own responder normally takes Esc first.
  func takeEscapeForSwitcher() -> Bool {
    guard let switcher, switcher.absorbsEscape else { return false }
    switcher.cancel(.escapeKey)
    return true
  }

  /// Fokus klawiatury stoi w transkrypcie — tam przyjmują go wyłącznie karty decyzji.
  private var transcriptHasFocus: Bool {
    guard let item = UIFocusSystem.focusSystem(for: view)?.focusedItem as? UIView else { return false }
    return item.isDescendant(of: collectionView)
  }

  /// Okno nad ekranem (arkusz, popover z rzędu pod polem): Esc należy do niego, nigdy do tury pod spodem. Ten sam
  /// warunek nie wpuszcza arkusza „Limity” nad inne okno (`+UsageSheet`).
  var overlayPresented: Bool {
    if presentedViewController != nil || children.contains(where: { $0.presentedViewController != nil }) { return true }
    return view.window?.rootViewController?.presentedViewController != nil
  }

  @objc private func escapeInterrupt() {
    if takeEscapeForSwitcher() { return }
    guard escapeInterrupts else { return }
    interruptTurn(trigger: .escape)
  }
}
#endif
