#if os(iOS)
import GameController
import UIKit

// The shortcut sheet in the app: key events from `HardwareKeys` go to the hold (`CommandHold`), a timer asks it
// at `nextCheck`, and its changes put the panel (`ShortcutSheetPanel`) on the window or take it off, with a line in
// `client.log`. The panel is a subview of the window, not a presentation: it stands over the sheets, leaves the first
// responder alone and does not silence the session switcher (`SwitcherPresentationGate`). Everything the controller reads comes
// through `Environment`, so UIKit tests pass key events and a clock themselves. Owner: shortcuts.

@MainActor
final class ShortcutSheetController {
  struct Environment {
    /// Seconds of a monotonic clock.
    var now: () -> TimeInterval
    /// Whether the keyboard reports a Cmd down (`HardwareKeys.commandPressed`); `nil` = no keyboard.
    var pressed: () -> Bool?
    var conditions: () -> CommandHold.Conditions
    var place: () -> ShortcutSheetPlace?
    var capabilities: () -> ShortcutSheetCapabilities
    /// The window the panel goes on.
    var window: () -> UIWindow?
    var trace: (String) -> Void
  }

  private let environment: Environment
  private var hold = CommandHold()
  private var timer: Task<Void, Never>?
  private var observers: [NSObjectProtocol] = []
  /// Places whose first countdown since the keyboard came went to the trace. One line per place answers whether the
  /// events reach the app there; a line per Cmd press (every ⌘1 starts a countdown) would eat the shared budget.
  private var tracedStarts: Set<String> = []

  init(environment: Environment) {
    self.environment = environment
  }

  /// The conditions of the moment: `window` is the key window, the app is logged in, the session switcher is closed
  /// and the app does not run on a Mac.
  static func conditions(window: UIWindow?, loggedIn: Bool, switcherOpen: Bool) -> CommandHold.Conditions {
    CommandHold.Conditions(
      keyWindow: window?.isKeyWindow == true, loggedIn: loggedIn, switcherOpen: switcherOpen,
      onMac: ProcessInfo.processInfo.isiOSAppOnMac)
  }

  // MARK: Wiring

  /// Listens to the keys and to the scene, the window and the keyboard going away. On a Mac it does not listen: the
  /// menu bar always lists the shortcuts there (the hold blocks the sheet there too).
  func start() {
    stop()
    guard !ProcessInfo.processInfo.isiOSAppOnMac else { return }
    HardwareKeys.addKeyListener(self) { [weak self] event in self?.receive(event) }
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.reset(.appInactive) }
      },
      center.addObserver(forName: UIWindow.didResignKeyNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.windowResigned() }
      },
      center.addObserver(forName: .GCKeyboardDidDisconnect, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.reset(.keyboardDisconnected) }
      },
    ]
  }

  func stop() {
    HardwareKeys.removeKeyListener(self)
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
    timer?.cancel()
    timer = nil
    if hold.shown { ShortcutSheetPanel.hide() }
    hold = CommandHold()
  }

  // MARK: Events

  func receive(_ event: CommandKeyEvent) {
    apply(hold.receive(event, at: environment.now()))
  }

  func reset(_ reason: CommandHold.ResetReason) {
    if reason == .keyboardDisconnected { tracedStarts = [] }
    apply(hold.reset(reason))
  }

  /// The timer at `nextCheck`; tests call it after moving their clock.
  func check() {
    apply(hold.tick(at: environment.now(), pressed: environment.pressed(), conditions: environment.conditions()))
    // A sheet presented while the panel stands goes on top of the window; the panel comes back over it.
    if hold.shown { ShortcutSheetPanel.raise() }
  }

  private func windowResigned() {
    guard environment.window()?.isKeyWindow != true else { return }
    reset(.windowResigned)
  }

  private func apply(_ change: CommandHold.Change?) {
    if let change {
      let place = environment.place()
      switch change {
      case .started:
        if tracedStarts.insert(ShortcutSheetTrace.name(place)).inserted { trace(change, place: place) }
      case .shown:
        if let window = environment.window() {
          ShortcutSheetPanel.show(
            ShortcutSheetContent(place: place, capabilities: environment.capabilities()), in: window)
        }
        trace(change, place: place)
      case .hidden:
        ShortcutSheetPanel.hide()
        trace(change, place: place)
      case .dropped:
        trace(change, place: place)
      }
    }
    schedule()
  }

  private func trace(_ change: CommandHold.Change, place: ShortcutSheetPlace?) {
    environment.trace(ShortcutSheetTrace.line(change, place: place, conditions: environment.conditions()))
  }

  private func schedule() {
    timer?.cancel()
    timer = nil
    let now = environment.now()
    guard let next = hold.nextCheck(after: now) else { return }
    let wait = max(0, next - now)
    timer = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(wait))
      guard !Task.isCancelled, let self else { return }
      self.check()
    }
  }
}
#endif
