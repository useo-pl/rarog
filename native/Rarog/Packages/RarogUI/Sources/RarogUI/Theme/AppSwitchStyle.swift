#if os(iOS)
import SwiftUI
import UIKit

/// The system switch with the `switchOn` track. Containers that tint their controls with `text` set this style, so
/// a switch that is on does not turn into a near-white track under the white knob; other controls keep `text`.
struct AppSwitchStyle: ToggleStyle {
  func makeBody(configuration: Configuration) -> some View {
    // `.switch` inside, otherwise the toggle would resolve this style again and recurse.
    Toggle(configuration)
      .toggleStyle(.switch)
      .tint(Color(uiColor: Palette.switchOn))
  }
}

extension ToggleStyle where Self == AppSwitchStyle {
  /// The app's switch: the system switch with the `switchOn` track.
  static var appSwitch: AppSwitchStyle { AppSwitchStyle() }
}
#endif
