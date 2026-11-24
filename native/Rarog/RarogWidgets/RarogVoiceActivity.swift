import ActivityKit
import RarogActivity
import SwiftUI
import WidgetKit

/// The voice Live Activity: the running voice conversation or message-field dictation under the locked-phone trial,
/// what it does now and what it is about, with its End (Stop) button. The app starts, updates and ends it (no
/// pushes); the views come from `RarogActivity`, and the button runs `EndVoiceActivityIntent` in the app's process. A
/// tap elsewhere opens the app.
///
/// Lock Screen: one row on translucent black, pinned to the dark theme like the sessions board: the kind and the
/// timer, the phase word, the subject. Dynamic Island: compact, the glyph and the timer; minimal, the glyph;
/// expanded, the glyph and the phase word, the timer, and the subject with the button at the bottom.
struct RarogVoiceActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: VoiceActivityAttributes.self) { context in
      VoiceActivityLockScreenView(presentation: VoiceActivityPresentation(context.state))
        .environment(\.colorScheme, .dark)
        .activityBackgroundTint(.black.opacity(0.8))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      let presentation = VoiceActivityPresentation(context.state)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          VoiceActivityExpandedLeading(presentation: presentation)
            .padding(.leading, 6)
        }
        DynamicIslandExpandedRegion(.trailing) {
          VoiceActivityExpandedTrailing(presentation: presentation)
            .padding(.trailing, 6)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VoiceActivityExpandedBottom(presentation: presentation)
            .padding(.horizontal, 6)
        }
      } compactLeading: {
        VoiceActivityCompactLeading(presentation: presentation)
      } compactTrailing: {
        VoiceActivityCompactTrailing(presentation: presentation)
      } minimal: {
        VoiceActivityMinimal(presentation: presentation)
      }
      .keylineTint(presentation.color)
    }
  }
}
