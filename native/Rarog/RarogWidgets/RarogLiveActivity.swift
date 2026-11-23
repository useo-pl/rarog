import ActivityKit
import RarogActivity
import RarogContract
import SwiftUI
import WidgetKit

/// Zbiorcza Live Activity urządzenia: ekran blokady i Dynamic Island.
///
/// Rozszerzenie tylko rysuje. Stan przychodzi z ActivityKit (start z apki, potem wyłącznie pushem z serwera)
/// jako `LiveActivityContentState`, copy i adresy tapnięcia składa `LiveActivityPresentation`, widoki
/// mieszkają w `RarogActivity` (testy renderują je do zrzutów). Zero akcji na kaflu — tap w liczbę większą od zera
/// otwiera pierwszą sesję tego rodzaju (`Link`, ekran blokady i rozwinięta wyspa), tap w resztę kafla i w zwiniętą
/// wyspę — listę agentów (`widgetURL`).
///
/// Wyspa (wariant A): rozwinięta — limit 5 h i limit tygodniowy w górnych rogach, liczniki i przebiegi na
/// dole; zwinięta — przy przebiegach czekające i pracujące z lewej, pierścień postępu pierwszego przebiegu
/// z prawej, bez przebiegów czekające | pracujące; minimalna — czekające, a bez nich pracujące.
struct RarogLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: RarogActivityAttributes.self) { context in
      let presentation = LiveActivityPresentation(context.state, machine: context.attributes.machine)
      LiveActivityLockScreenView(presentation: presentation, isStale: context.isStale)
        .widgetURL(presentation.link)
        // Translucent black over the Lock Screen. With a custom tint the system no longer adapts the content
        // colors, so the tile is pinned to the dark theme its colors are made for, light mode included.
        .environment(\.colorScheme, .dark)
        .activityBackgroundTint(.black.opacity(0.8))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      let presentation = LiveActivityPresentation(context.state, machine: context.attributes.machine)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          LiveActivityExpandedLeading(presentation: presentation)
            .padding(.leading, 6)
        }
        DynamicIslandExpandedRegion(.trailing) {
          LiveActivityExpandedTrailing(presentation: presentation)
            .padding(.trailing, 6)
        }
        DynamicIslandExpandedRegion(.bottom) {
          LiveActivityExpandedBottom(presentation: presentation, isStale: context.isStale)
            .padding(.horizontal, 6)
        }
      } compactLeading: {
        LiveActivityCompactLeading(presentation: presentation)
      } compactTrailing: {
        LiveActivityCompactTrailing(presentation: presentation)
      } minimal: {
        LiveActivityMinimal(presentation: presentation)
      }
      .widgetURL(presentation.link)
      .keylineTint(LiveActivityPalette.islandTone(presentation.tone))
    }
  }
}

// MARK: - Podgląd (Xcode): ekran blokady i wyspa, oba motywy z ustawień podglądu

private enum PreviewStates {
  static let now = Int(Date().timeIntervalSince1970)
  /// Komplet: trzy liczniki, dwa przebiegi (z planem faz i bez), „+1", oba limity (7d nad progiem), Mac.
  static let full = LiveActivityContentState(
    waiting: 2, working: 3, finished: 4, top: .init(sessionId: "demo-willow"),
    workflows: [
      .init(
        sessionId: "demo-rarog", project: "rarog", name: "audyt-ux", agents: 7, done: 3,
        phase: .init(index: 2, count: 4, title: "Weryfikacja"), segments: [100, 60, 0, 0]),
      .init(sessionId: "demo-atlas", project: "atlas-web", name: "review-changes", agents: 3, done: 1, segments: [33]),
    ],
    moreWorkflows: 1, limits: .init(fiveHour: 42, weekly: 81), mac: .init(cpu: 35, ram: 70, disk: 60),
    updatedEpoch: now)
  /// Sam przebieg w tle po turze („odpaliłem, dam znać"), limit tygodniowy krytyczny.
  static let workflow = LiveActivityContentState(
    waiting: 0, working: 0, finished: 1, top: nil,
    workflows: [
      .init(
        sessionId: "demo-rarog", project: "rarog", name: "audyt-docs", agents: 4, done: 3,
        phase: .init(index: 2, count: 3, title: "A2 Weryfikacja"), segments: [100, 50, 0]),
    ],
    limits: .init(fiveHour: 12, weekly: 93), mac: .init(cpu: 15, ram: 65, disk: 60), updatedEpoch: now)
  /// Same liczniki — stan startowy z apki, zanim serwer dośle resztę.
  static let start = LiveActivityContentState(
    waiting: 1, working: 2, finished: 0, top: .init(sessionId: "demo-willow"), updatedEpoch: now)
  static let quiet = LiveActivityContentState(
    waiting: 0, working: 0, finished: 0, limits: .init(fiveHour: 20, weekly: 40), updatedEpoch: now)
}

#Preview("Ekran blokady", as: .content, using: RarogActivityAttributes()) {
  RarogLiveActivity()
} contentStates: {
  PreviewStates.full
  PreviewStates.workflow
  PreviewStates.start
  PreviewStates.quiet
}

#Preview("Wyspa zwinięta", as: .dynamicIsland(.compact), using: RarogActivityAttributes()) {
  RarogLiveActivity()
} contentStates: {
  PreviewStates.full
  PreviewStates.start
}

#Preview("Wyspa rozwinięta", as: .dynamicIsland(.expanded), using: RarogActivityAttributes()) {
  RarogLiveActivity()
} contentStates: {
  PreviewStates.full
  PreviewStates.workflow
  PreviewStates.start
  PreviewStates.quiet
}

#Preview("Wyspa minimalna", as: .dynamicIsland(.minimal), using: RarogActivityAttributes()) {
  RarogLiveActivity()
} contentStates: {
  PreviewStates.full
}
