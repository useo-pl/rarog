#if os(iOS)
import GameController
import RarogCore
import SwiftUI
import UIKit

// Keyboard shortcuts in Settings. The Dictation and Voice Agent pages each have a "Keyboard Shortcut" section
// (`ShortcutPageSection`): one row named after the action, with the glyphs of the shortcut in force as its value.
// A tap on a row opens a page in the Settings stack that records the next key press with modifiers from a hardware keyboard, shows its glyphs and
// saves it on Save Shortcut (`AppShortcutSettings` checks and stores it). Esc without modifiers leaves the page. The
// rows and the page read the shared settings, so they draw again after a save. Owner: shortcuts.

/// The "Keyboard Shortcut" section of the Dictation and Voice Agent pages: the page's shortcut row and a footer that
/// says how to change it.
struct ShortcutPageSection: View {
  let shortcut: AppShortcut

  var body: some View {
    Section {
      ShortcutSettingsRow(shortcut: shortcut)
    } header: {
      Text(UICopy.shortcutSettingsHeader())
    } footer: {
      Text(UICopy.shortcutSettingsFooter())
    }
  }
}

/// One shortcut on its page: the action as the label, the glyphs in muted ink as the value; a tap opens
/// `ShortcutRecorderPage`, titled with the shortcut's name.
struct ShortcutSettingsRow: View {
  let shortcut: AppShortcut
  var settings = AppShortcutSettings.shared

  var body: some View {
    let name = UICopy.shortcutSettingsName(shortcut)
    NavigationLink {
      ShortcutRecorderPage(shortcut: shortcut, settings: settings)
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
    } label: {
      LabeledContent {
        Text(verbatim: settings.combination(for: shortcut).glyphs)
          .appFont(.callout)
          .foregroundStyle(Color(uiColor: Palette.muted))
      } label: {
        Text(UICopy.shortcutSettingsAction(shortcut)).foregroundStyle(Color(uiColor: Palette.text))
      }
    }
    .accessibilityIdentifier("settings.shortcut.\(shortcut.rawValue)")
  }
}

/// The page of one shortcut: the current combination, the one just pressed, a refusal under them, Save Shortcut and
/// Restore Default.
struct ShortcutRecorderPage: View {
  let shortcut: AppShortcut
  let settings: AppShortcutSettings
  @Environment(\.dismiss) private var dismiss
  @State private var pending: AppShortcut.Combination?
  @State private var refusal: AppShortcutSettings.Refusal?
  @State private var keyboard = TerminalKeyboard.isConnected()

  var body: some View {
    let current = settings.combination(for: shortcut)
    Form {
      Section {
        Text(keyboard ? UICopy.shortcutSettingsLead : UICopy.shortcutSettingsNoKeyboard)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("shortcut.lead")
        glyphRow(UICopy.shortcutSettingsCurrent, current, identifier: "shortcut.current")
        if let pending {
          glyphRow(UICopy.shortcutSettingsNew, pending, identifier: "shortcut.new")
        }
      } footer: {
        if let refusal {
          Text(UICopy.shortcutSettingsRefusal(refusal))
            .foregroundStyle(Color(uiColor: Palette.err))
            .accessibilityIdentifier("shortcut.refusal")
        }
      }
      Section {
        Button(UICopy.shortcutSettingsSave) { save() }
          .disabled(pending == nil || refusal != nil || pending == current)
          .accessibilityIdentifier("shortcut.save")
        Button(UICopy.shortcutSettingsRestoreDefault) { restoreDefault() }
          .disabled(current == shortcut.defaultCombination)
          .accessibilityIdentifier("shortcut.restoreDefault")
      }
    }
    .scrollContentBackground(.hidden)
    .background(Color(uiColor: Palette.background))
    .background(alignment: .topLeading) {
      ShortcutCaptureField(onCapture: capture, onCancel: { dismiss() })
        .frame(width: 1, height: 1)
        .accessibilityHidden(true)
    }
    .onReceive(NotificationCenter.default.publisher(for: .GCKeyboardDidConnect)) { _ in
      keyboard = TerminalKeyboard.isConnected()
    }
    .onReceive(NotificationCenter.default.publisher(for: .GCKeyboardDidDisconnect)) { _ in
      keyboard = TerminalKeyboard.isConnected()
    }
    .accessibilityIdentifier("shortcut.page")
  }

  private func glyphRow(_ label: String, _ combination: AppShortcut.Combination, identifier: String) -> some View {
    LabeledContent(label) {
      Text(verbatim: combination.glyphs)
        .appFont(.title3.monospaced())
        .foregroundStyle(Color(uiColor: Palette.text))
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(identifier)
  }

  private func capture(_ combination: AppShortcut.Combination) {
    pending = combination
    refusal = combination == settings.combination(for: shortcut) ? nil : settings.check(combination, for: shortcut)
  }

  private func save() {
    guard let pending else { return }
    refusal = settings.save(pending, for: shortcut)
    guard refusal == nil else { return }
    UIMenuSystem.main.setNeedsRebuild()
    dismiss()
  }

  private func restoreDefault() {
    refusal = settings.restoreDefault(shortcut)
    guard refusal == nil else { return }
    pending = nil
    UIMenuSystem.main.setNeedsRebuild()
  }
}

/// An invisible responder that takes the page's key presses: a key with its modifiers becomes a combination, Esc
/// without modifiers cancels, a modifier pressed alone waits for the key.
struct ShortcutCaptureField: UIViewRepresentable {
  let onCapture: (AppShortcut.Combination) -> Void
  let onCancel: () -> Void

  func makeUIView(context: Context) -> ShortcutCaptureView {
    let view = ShortcutCaptureView()
    view.isAccessibilityElement = false
    return view
  }

  func updateUIView(_ view: ShortcutCaptureView, context: Context) {
    view.onCapture = onCapture
    view.onCancel = onCancel
  }
}

final class ShortcutCaptureView: UIView {
  var onCapture: ((AppShortcut.Combination) -> Void)?
  var onCancel: (() -> Void)?

  override var canBecomeFirstResponder: Bool { true }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else { return }
    // After the push animation: a responder taken during the transition does not stay first.
    DispatchQueue.main.async { [weak self] in _ = self?.becomeFirstResponder() }
  }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    guard let key = presses.first?.key, let combination = Self.combination(key) else {
      super.pressesBegan(presses, with: event)
      return
    }
    if combination == AppShortcut.Combination(key: .escape, modifiers: []) {
      onCancel?()
    } else {
      onCapture?(combination)
    }
  }

  /// `nil` = a modifier alone or a key without a combination form (arrows, function keys).
  static func combination(_ key: UIKey) -> AppShortcut.Combination? {
    var modifiers: AppShortcut.Modifiers = []
    if key.modifierFlags.contains(.control) { modifiers.insert(.control) }
    if key.modifierFlags.contains(.alternate) { modifiers.insert(.option) }
    if key.modifierFlags.contains(.shift) { modifiers.insert(.shift) }
    if key.modifierFlags.contains(.command) { modifiers.insert(.command) }
    switch key.keyCode {
    case .keyboardEscape: return AppShortcut.Combination(key: .escape, modifiers: modifiers)
    case .keyboardReturnOrEnter, .keypadEnter: return AppShortcut.Combination(key: .returnKey, modifiers: modifiers)
    default: break
    }
    let characters = key.charactersIgnoringModifiers
    guard characters.count == 1, let character = characters.first else { return nil }
    return AppShortcut.Combination(key: .character(character), modifiers: modifiers)
  }
}
#endif
