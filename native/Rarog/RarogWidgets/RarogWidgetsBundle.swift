import SwiftUI
import WidgetKit

/// Rozszerzenie `ai.rarog.app.widgets`: dziś jedna zbiorcza Live Activity. Kolejny widżet
/// dołącza tu jako następny element paczki.
@main
struct RarogWidgetsBundle: WidgetBundle {
  var body: some Widget {
    RarogLiveActivity()
  }
}
