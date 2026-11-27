#if os(iOS)
import GameController
import RarogCore
import SwiftUI
import UIKit

// Keyboard shortcuts in Settings. The Dictation and Voice Agent pages each have a "Keyboard Shortcut" section
// (`ShortcutPageSection`): one row named after the action, with the shortcut in force in a capsule. A tap on the
// capsule makes the row listen: the capsule says "Press shortcut…" and an invisible capture view over it takes the
// hardware keyboard (`ShortcutCaptureView`). The first combination the rules accept is saved at once; a refusal shows
// one sentence under the row and the row keeps listening. The rules of the row live in `ShortcutRowEditor`, the checks
// and the store in `AppShortcutSettings`. Owner: shortcuts.

/// The "Keyboard Shortcut" section of the Dictation and Voice Agent pages: the page's shortcut row and a footer that
/// says how to change it (or that a hardware keyboard is needed).
struct ShortcutPageSection: View {
  let shortcut: AppShortcut
  @State private var keyboard = TerminalKeyboard.isConnected()

  var body: some View {
    Section {
      ShortcutSettingsRow(shortcut: shortcut, keyboard: keyboard)
    } header: {
      Text(UICopy.shortcutSettingsHeader())
    } footer: {
      Text(keyboard ? UICopy.shortcutSettingsHint() : UICopy.shortcutSettingsNoKeyboard)
    }
    .onReceive(NotificationCenter.default.publisher(for: .GCKeyboardDidConnect)) { _ in
      keyboard = TerminalKeyboard.isConnected()
    }
    .onReceive(NotificationCenter.default.publisher(for: .GCKeyboardDidDisconnect)) { _ in
      keyboard = TerminalKeyboard.isConnected()
    }
  }
}

/// One shortcut on its page: the action as the label, the shortcut in a capsule that listens on a tap, Restore
/// Default (an arrow in a circle) while the shortcut differs from its default, and a refusal under the row.
struct ShortcutSettingsRow: View {
  let shortcut: AppShortcut
  let keyboard: Bool
  @State private var editor: ShortcutRowEditor

  init(shortcut: AppShortcut, keyboard: Bool, settings: AppShortcutSettings = .shared) {
    self.shortcut = shortcut
    self.keyboard = keyboard
    _editor = State(initialValue: ShortcutRowEditor(shortcut: shortcut, settings: settings))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      LabeledContent {
        HStack(spacing: 10) {
          if editor.differsFromDefault {
            Button {
              editor.restoreDefault()
            } label: {
              Image(systemName: "arrow.counterclockwise.circle")
                .foregroundStyle(Color(uiColor: Palette.muted))
                .hitTarget(horizontal: 12, vertical: 12)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(UICopy.shortcutSettingsRestoreDefault)
            .accessibilityIdentifier("settings.shortcut.\(shortcut.rawValue).restore")
          }
          capsule
        }
      } label: {
        Text(UICopy.shortcutSettingsAction(shortcut)).foregroundStyle(Color(uiColor: Palette.text))
      }
      if let refusal = editor.refusal {
        Text(UICopy.shortcutSettingsRefusal(refusal))
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.err))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("settings.shortcut.\(shortcut.rawValue).refusal")
      }
    }
    .onChange(of: keyboard) { _, connected in
      if !connected { editor.stop() }
    }
    .onDisappear { editor.stop() }
  }

  @ViewBuilder private var capsule: some View {
    let listening = editor.listening
    let label = Text(verbatim: listening ? UICopy.shortcutSettingsListening : editor.combination.glyphs)
      .appFont(.callout)
      .foregroundStyle(Color(uiColor: listening ? Palette.text : Palette.muted))
      .padding(.horizontal, 10)
      .padding(.vertical, 4)
      .background(Capsule().fill(Color(uiColor: Palette.surface2)))
      .overlay(Capsule().strokeBorder(Color(uiColor: Palette.text), lineWidth: listening ? 1.5 : 0))
      .hitTarget(horizontal: 0, vertical: 8)
    if keyboard {
      Button {
        editor.tap(keyboard: keyboard)
      } label: {
        label
      }
      .buttonStyle(.plain)
      .accessibilityHint(UICopy.shortcutSettingsChangeHint)
      .overlay { ShortcutCaptureField(editor: editor).allowsHitTesting(false).accessibilityHidden(true) }
      .accessibilityIdentifier("settings.shortcut.\(shortcut.rawValue)")
    } else {
      label.accessibilityIdentifier("settings.shortcut.\(shortcut.rawValue)")
    }
  }
}

/// Places the capture view over the capsule and wires it to the row's editor.
struct ShortcutCaptureField: UIViewRepresentable {
  let editor: ShortcutRowEditor

  func makeUIView(context: Context) -> ShortcutCaptureView {
    let view = ShortcutCaptureView()
    Self.wire(view, to: editor)
    return view
  }

  func updateUIView(_ view: ShortcutCaptureView, context: Context) {
    Self.wire(view, to: editor)
  }

  /// The key presses and the loss of the keyboard go to the editor; the editor takes and releases the keyboard
  /// through the view.
  static func wire(_ view: ShortcutCaptureView, to editor: ShortcutRowEditor) {
    view.onPress = { [weak editor] in editor?.press($0) }
    view.onLost = { [weak editor] in editor?.keyboardLost() }
    view.onEnd = { [weak editor] in editor?.stop() }
    editor.takeKeyboard = { [weak view] in view?.take() ?? false }
    editor.releaseKeyboard = { [weak view] in view?.release(restore: true) }
    editor.rebuildMenus = { UIMenuSystem.main.setNeedsRebuild() }
  }
}

private extension View {
  /// Grows the tap area by the given insets without moving anything: touch targets stay at least 44 pt while the
  /// glyph and the capsule keep their drawn size and place.
  func hitTarget(horizontal: CGFloat, vertical: CGFloat) -> some View {
    padding(.horizontal, horizontal)
      .padding(.vertical, vertical)
      .contentShape(Rectangle())
      .padding(.horizontal, -horizontal)
      .padding(.vertical, -vertical)
  }
}
#endif
