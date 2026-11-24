#if os(iOS)
import RarogCore
import SwiftUI

/// The header of the right column (the session screen). It is made of slots in files of their own; each has one
/// owner and adds its own navigation bar items (placement, `toolbar`, insets):
/// - `HeaderTitleSlot`: the title, project · session name;
/// - `HeaderStatusSlot`: the status line, context, git, CLI pills and "in background";
/// - `HeaderTabsSlot`: the project's tabs, the "×" in the current tab and the card under the bar;
/// - `HeaderSessionSlot`: the icon group in the top right corner, "Pop-Up Terminal", the right panel toggle, the
///   terminal's "⋯" (`TerminalChrome`; its "×" only without a tab bar), as one bar item (`Views/SessionControl/`).
/// An inset added later stands higher: the status line is under the tab bar, because it speaks of the session chosen
/// on the bar. A slot without content returns the view unchanged, so an empty slot does not touch the layout.
struct SessionHeader: ViewModifier {
  let store: RarogStore
  let selection: String?
  let terminal: TerminalChrome

  func body(content: Content) -> some View {
    content
      .modifier(HeaderTitleSlot(store: store, selection: selection, terminal: terminal))
      .modifier(HeaderStatusSlot(store: store, selection: selection))
      .modifier(HeaderTabsSlot(store: store, selection: selection, terminal: terminal))
      .modifier(HeaderSessionSlot(store: store, terminal: terminal))
  }
}
#endif
