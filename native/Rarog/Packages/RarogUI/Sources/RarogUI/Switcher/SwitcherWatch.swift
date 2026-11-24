#if os(iOS)
import GameController
import UIKit

/// Watches the open switcher window: the presentation gate every 250 ms (a sheet, popover or preview
/// that appeared under or over the window closes it without a jump) and the scene (Cmd+Tab, the app going to the
/// background close it at once, in the same turn of the main loop). A hardware keyboard connected while the window
/// stands goes to the window; disconnecting it does NOT close the window. Owner: shortcuts.
@MainActor
final class SwitcherWatch {
  /// Whether a keyboard connection counts. Debug build: `RAROG_UI_TEST_NO_HW_KEYBOARD=1` fakes no keyboard
  /// (`TerminalKeyboard`), so a connection the simulator reports does not either.
  static func connectCounts() -> Bool {
    #if DEBUG
    if ProcessInfo.processInfo.environment["RAROG_UI_TEST_NO_HW_KEYBOARD"] == "1" { return false }
    #endif
    return true
  }

  private let switcher: SessionSwitcher
  private let blocked: @MainActor () -> Bool
  private var poll: Task<Void, Never>?
  private var observers: [NSObjectProtocol] = []

  static let pollInterval = Duration.milliseconds(250)

  init(switcher: SessionSwitcher, blocked: @escaping @MainActor () -> Bool) {
    self.switcher = switcher
    self.blocked = blocked
  }

  func start() {
    stop()
    observers = [
      NotificationCenter.default.addObserver(
        forName: UIScene.willDeactivateNotification, object: nil, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { self?.switcher.cancel(.sceneInactive) }
      },
      // The window has no keyboard shortcut, so a keyboard connected after a tap opened it reaches the window only
      // this way. The note is the fact: the coalesced keyboard can still be `nil` right after connecting.
      NotificationCenter.default.addObserver(
        forName: .GCKeyboardDidConnect, object: nil, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          guard Self.connectCounts() else { return }
          self?.switcher.keyboardConnected()
        }
      },
    ]
    poll = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        if self.blocked() {
          self.switcher.cancel(.presentation)
          return
        }
        try? await Task.sleep(for: Self.pollInterval)
      }
    }
  }

  func stop() {
    poll?.cancel()
    poll = nil
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
  }
}
#endif
