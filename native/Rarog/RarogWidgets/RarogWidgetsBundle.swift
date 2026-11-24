import SwiftUI
import WidgetKit

/// The `ai.rarog.app.widgets` extension: the sessions board Live Activity and the voice Live Activity of the
/// locked-phone trial. Another widget joins here as the next element of the bundle.
@main
struct RarogWidgetsBundle: WidgetBundle {
  var body: some Widget {
    RarogLiveActivity()
    RarogVoiceActivity()
  }
}
