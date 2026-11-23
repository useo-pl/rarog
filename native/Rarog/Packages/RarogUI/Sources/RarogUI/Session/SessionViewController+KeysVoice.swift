#if os(iOS)
import SwiftUI
import UIKit

// Skrót dyktowania włącza i wyłącza dyktowanie — ta sama droga co mikrofon, więc
// dziedziczy jego stany (start, stop z zatwierdzeniem) i bramkę dostępności. Właściciel: dyktowanie.

/// Skrót dyktowania dla UIKit (ekran sesji) i SwiftUI (formularz notatki), oba z `AppShortcut.dictation` — tej samej
/// definicji, z której mikrofon bierze podpowiedź „(⌥⌘M)”. Dlaczego ⌥⌘M, a nie ⌘M: komentarz przy definicji.
enum DictationShortcut {
  static var input: String { AppShortcut.dictation.input }
  static var modifiers: UIKeyModifierFlags { AppShortcut.dictation.keyModifierFlags }
  static var key: KeyEquivalent { AppShortcut.dictation.keyboardShortcut.key }
  static var eventModifiers: EventModifiers { AppShortcut.dictation.keyboardShortcut.modifiers }
}

extension SessionViewController {
  var voiceKeyCommands: [UIKeyCommand] {
    let toggle = UIKeyCommand(
      title: UICopy.shortcutDictation, action: #selector(toggleDictationShortcut), input: DictationShortcut.input,
      modifierFlags: DictationShortcut.modifiers)
    toggle.discoverabilityTitle = UICopy.shortcutDictation
    toggle.wantsPriorityOverSystemBehavior = true
    return [toggle]
  }

  /// `nil` = akcja nie należy do dyktowania. Lista w `canPerformAction` kontrolera.
  func voiceKeyVerdict(_ action: Selector) -> Bool? {
    guard action == #selector(toggleDictationShortcut) else { return nil }
    return dictation.canToggle
  }

  @objc private func toggleDictationShortcut() {
    dictation.toggle()
  }
}
#endif
