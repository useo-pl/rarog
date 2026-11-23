#if os(iOS)
import RarogCore
import SwiftUI

// Wires the shortcut sheet to the root of the views: the store (login, capabilities, the trace), navigation
// (the focus place) and the session switcher (an open window blocks the sheet). One line in `RarogRootView`, next to
// `SessionSwitcherHost`. Owner: shortcuts.

struct ShortcutSheetHost: ViewModifier {
  let store: RarogStore
  let navigation: RarogNavigation
  let switcher: SessionSwitcher
  @State private var controller: ShortcutSheetController?

  func body(content: Content) -> some View {
    content
      .onAppear(perform: wire)
      .onDisappear { controller?.stop() }
  }

  private func wire() {
    let controller = controller ?? Self.live(store: store, navigation: navigation, switcher: switcher)
    self.controller = controller
    controller.start()
  }

  static func live(
    store: RarogStore, navigation: RarogNavigation, switcher: SessionSwitcher
  ) -> ShortcutSheetController {
    ShortcutSheetController(environment: ShortcutSheetController.Environment(
      now: { ProcessInfo.processInfo.systemUptime },
      pressed: { HardwareKeys.commandPressed() },
      conditions: {
        ShortcutSheetController.conditions(
          window: SwitcherPresentationGate.window(), loggedIn: store.state.auth == .loggedIn,
          switcherOpen: switcher.windowShown)
      },
      place: { navigation.shortcutSheetPlace(store.state) },
      capabilities: {
        navigation.shortcutSheetCapabilities(
          store.state, voiceAgentEnabled: store.voiceAgent.enabled, sonioxAllowed: store.dictation.sonioxAllowed)
      },
      window: { SwitcherPresentationGate.window() },
      trace: { [weak store] line in store?.trace(line) }))
  }
}
#endif
