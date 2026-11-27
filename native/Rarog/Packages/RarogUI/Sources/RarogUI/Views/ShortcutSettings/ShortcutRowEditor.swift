import Foundation
import Observation

// The rules of one shortcut row in Settings, without a view: the row either shows the shortcut in force or listens
// for a new one. A tap on the shortcut listens (only with a hardware keyboard, and only once the capture view took
// the keyboard); the first combination the rules accept is saved at once and the keyboard goes back; a refused one
// leaves a sentence under the row and keeps listening. Esc, a second tap, a tap beside the shortcut, the row leaving
// the screen and the keyboard disconnecting end the listening without a save. The view
// (`ShortcutSettingsSection.swift`) injects the keyboard and the menu rebuild. Owner: shortcuts.

/// The state of one shortcut row: listening or not, and the refusal shown under it.
@MainActor
@Observable
final class ShortcutRowEditor {
  let shortcut: AppShortcut
  @ObservationIgnored private let settings: AppShortcutSettings
  /// The row waits for a key press; the capture view holds the keyboard.
  private(set) var listening = false
  /// Why the last combination (or Restore Default) was not saved; cleared when listening starts or ends.
  private(set) var refusal: AppShortcutSettings.Refusal?

  /// Makes the capture view the first responder; `false` = UIKit refused (no window), and the row does not listen.
  @ObservationIgnored var takeKeyboard: () -> Bool = { false }
  /// Gives the keyboard back to whoever held it before the row listened.
  @ObservationIgnored var releaseKeyboard: () -> Void = {}
  /// Redraws the menu bar and the key commands after a save (`UIMenuSystem.main.setNeedsRebuild()`).
  @ObservationIgnored var rebuildMenus: () -> Void = {}

  static let cancelKey = AppShortcut.Combination(key: .escape, modifiers: [])

  init(shortcut: AppShortcut, settings: AppShortcutSettings) {
    self.shortcut = shortcut
    self.settings = settings
  }

  /// The combination in force; a read registers with Observation, so the row draws again after a save anywhere.
  var combination: AppShortcut.Combination { settings.combination(for: shortcut) }

  /// The row offers Restore Default.
  var differsFromDefault: Bool { combination != shortcut.defaultCombination }

  /// A tap on the shortcut: starts listening, or ends it without a save when the row already listens. Without a
  /// hardware keyboard the shortcut is only shown.
  func tap(keyboard: Bool) {
    if listening {
      stop()
      return
    }
    guard keyboard else { return }
    refusal = nil
    guard takeKeyboard() else { return }
    listening = true
  }

  /// A key press with its modifiers while listening. Esc without modifiers cancels; any other combination is saved
  /// when the rules accept it, or refused with the row still listening.
  func press(_ combination: AppShortcut.Combination) {
    guard listening else { return }
    if combination == Self.cancelKey {
      stop()
      return
    }
    if let refusal = settings.save(combination, for: shortcut) {
      self.refusal = refusal
      return
    }
    stop()
    rebuildMenus()
  }

  /// Ends listening without a save and gives the keyboard back: Esc, a second tap, a tap beside the shortcut, the
  /// row leaving the screen, the keyboard disconnecting.
  func stop() {
    guard listening else { return }
    listening = false
    refusal = nil
    releaseKeyboard()
  }

  /// Somebody else became the first responder: listening ends, and there is no keyboard left to give back.
  func keyboardLost() {
    guard listening else { return }
    listening = false
    refusal = nil
  }

  /// Gives the default back; refused (with the sentence under the row) while the other shortcut holds it.
  func restoreDefault() {
    stop()
    refusal = settings.restoreDefault(shortcut)
    if refusal == nil { rebuildMenus() }
  }
}
