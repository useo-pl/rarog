#if os(iOS)
import UIKit

/// Watches the open switcher window: the presentation gate every 250 ms (a sheet, popover or preview
/// that appeared under or over the window closes it without a jump) and the scene (Cmd+Tab, the app going to the
/// background close it at once, in the same turn of the main loop). Disconnecting the hardware keyboard does NOT
/// close the window. Owner: shortcuts.
@MainActor
final class SwitcherWatch {
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
