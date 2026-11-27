import ActivityKit
import RarogActivity
import SwiftUI
import WidgetKit

/// The voice Live Activity: the running voice conversation or message-field dictation,
/// what it does now and what it is about, with its buttons: End for a conversation, Stop and Send for a dictation,
/// none while a dictation is sent or after its send failed. The app starts, updates and ends it (no pushes); the views
/// come from `RarogActivity`, and the buttons run `EndVoiceActivityIntent` and `SendDictationActivityIntent` in the
/// app's process with the activity's id, so the app acts only on the activity the button stood on. The content's
/// stale flag reaches the presentation, so a send whose outcome never came reads as not confirmed. A tap elsewhere
/// opens the app.
///
/// Lock Screen: one row on translucent black, pinned to the dark theme like the sessions board: the kind and the
/// timer, the phase word, the subject. Dynamic Island: compact, the glyph and the timer; minimal, the glyph;
/// expanded, the glyph and the phase word, the timer, and the subject with the buttons at the bottom.
struct RarogVoiceActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: VoiceActivityAttributes.self) { context in
      VoiceActivityLockScreenView(
        presentation: VoiceActivityPresentation(context.state, isStale: context.isStale),
        activityID: context.activityID)
        .environment(\.colorScheme, .dark)
        .activityBackgroundTint(.black.opacity(0.8))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      let presentation = VoiceActivityPresentation(context.state, isStale: context.isStale)
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
          VoiceActivityExpandedBottom(presentation: presentation, activityID: context.activityID)
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
