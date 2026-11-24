#if os(iOS)
import SwiftUI

// The card under the tab bar while a session's or a terminal's close is armed. Owner: projects and tabs.

/// The sentence of what the next press of the "×" (or Cmd+X, or the state card's button) does, on the surface of
/// the notice under the bar (`NavigationNoticeCard`). The card has no clock of its own: `HeaderTabsSlot` draws it
/// from the arming (``RarogNavigation/closeArmCard(_:terminal:)``) under the bar, so it goes when the arming goes,
/// and an error notice shows instead of it. It says nothing to the screen reader: the arming spoke when it armed.
struct CloseArmCard: View {
  let card: CloseArmCardModel

  var body: some View {
    Text(card.text)
      .underTabBarCard()
      .accessibilityIdentifier("tabs.closeArmed")
  }
}
#endif
