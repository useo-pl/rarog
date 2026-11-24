#if os(iOS)
import AppIntents
import SwiftUI

// Views of the voice Live Activity: the Lock Screen tile and the Dynamic Island pieces. SwiftUI only, no WidgetKit:
// the `RarogWidgets` extension puts them into an `ActivityConfiguration` (background tint, dark theme), and the
// UIKit tests render them with `ImageRenderer` (`VoiceActivityViewTests`). Owner: voice agent.
//
// The tile is one row: the glyph in a circle of the phase's colour; three lines, the small "Voice agent · 0:42", the
// phase word and the muted subject ("All sessions", "atlas · demo"); and the End (Stop) button in the error tone.
// The colours are dark values (the activity is pinned to the dark theme like the board), so nothing here depends on
// the theme. The text part is one VoiceOver element with the kind, the phase and the subject in words and the timer
// as its value; the button stays its own element.

extension VoiceActivityPresentation {
  /// The tile's type stops growing at this size, so its three lines keep their row (the board's limit).
  public static let maxTypeSize = LiveActivityPresentation.maxTypeSize
  /// The Dynamic Island has a fixed physical size: its type stays at the board's island limit.
  public static let islandMaxTypeSize = LiveActivityPresentation.islandMaxTypeSize

  /// The phase's colour (``tint``), also the Dynamic Island's keyline.
  public var color: Color { Color(uiColor: LiveActivityPalette.rgb(tint)) }

  /// The End (Stop) button's tone, the same in every phase: it ends what records.
  static var endColor: Color { Color(uiColor: LiveActivityPalette.rgb(LiveActivityPalette.errPair.dark)) }
  /// The button's word: the tile's text colour over the dark error tone.
  static var endTextColor: Color { Color(uiColor: LiveActivityPalette.rgb(LiveActivityPalette.textPair.dark)) }
}

/// The glyph of the phase on a circle of its colour.
struct VoiceActivityGlyph: View {
  let presentation: VoiceActivityPresentation
  let size: CGFloat

  var body: some View {
    Image(systemName: presentation.symbol)
      .font(.system(size: size * 0.45, weight: .semibold))
      .foregroundStyle(presentation.color)
      .frame(width: size, height: size)
      .background(Circle().fill(presentation.color.opacity(0.22)))
      .accessibilityHidden(true)
  }
}

/// The system timer counting up from the recording's start.
struct VoiceActivityTimer: View {
  let startedAt: Date

  var body: some View {
    Text(startedAt, style: .timer).monospacedDigit()
  }
}

/// End (Stop for a dictation): runs ``EndVoiceActivityIntent`` in the app's process without opening the app.
struct VoiceActivityEndButton: View {
  let presentation: VoiceActivityPresentation

  var body: some View {
    Button(intent: EndVoiceActivityIntent()) {
      Text(presentation.endWord)
        .font(.subheadline.weight(.semibold))
        .lineLimit(1)
        .foregroundStyle(VoiceActivityPresentation.endTextColor)
        .padding(.horizontal, 16)
        .frame(minWidth: 64, minHeight: 44)
        .background(Capsule().fill(VoiceActivityPresentation.endColor.opacity(0.28)))
        .overlay(Capsule().strokeBorder(VoiceActivityPresentation.endColor.opacity(0.55), lineWidth: 1))
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(presentation.endWord)
  }
}

/// The tile on the Lock Screen (and the banner on a device without the Dynamic Island).
public struct VoiceActivityLockScreenView: View {
  let presentation: VoiceActivityPresentation

  public init(presentation: VoiceActivityPresentation) {
    self.presentation = presentation
  }

  public var body: some View {
    HStack(spacing: 12) {
      VoiceActivityGlyph(presentation: presentation, size: 40)
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 0) {
          Text(presentation.lead)
          VoiceActivityTimer(startedAt: presentation.state.startedAt)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.leading)
        Text(presentation.phaseWord)
          .font(.title3.weight(.semibold))
          .foregroundStyle(.primary)
        Text(presentation.subjectLine)
          .font(.caption)
          .foregroundStyle(.secondary)
          .truncationMode(.tail)
      }
      .lineLimit(1)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(presentation.spoken)
      .accessibilityValue(Text(presentation.state.startedAt, style: .timer))
      VoiceActivityEndButton(presentation: presentation)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .dynamicTypeSize(...VoiceActivityPresentation.maxTypeSize)
  }
}

/// Compact Dynamic Island, left of the camera: the glyph.
public struct VoiceActivityCompactLeading: View {
  let presentation: VoiceActivityPresentation

  public init(presentation: VoiceActivityPresentation) {
    self.presentation = presentation
  }

  public var body: some View {
    Image(systemName: presentation.symbol)
      .font(.body.weight(.semibold))
      .foregroundStyle(presentation.color)
      .dynamicTypeSize(...VoiceActivityPresentation.islandMaxTypeSize)
      .accessibilityLabel(presentation.spoken)
  }
}

/// Compact Dynamic Island, right of the camera: the timer, capped so it does not take the whole side.
public struct VoiceActivityCompactTrailing: View {
  let presentation: VoiceActivityPresentation

  public init(presentation: VoiceActivityPresentation) {
    self.presentation = presentation
  }

  public var body: some View {
    VoiceActivityTimer(startedAt: presentation.state.startedAt)
      .font(.system(.body, design: .rounded, weight: .semibold))
      .foregroundStyle(presentation.color)
      .multilineTextAlignment(.trailing)
      .frame(maxWidth: 64, alignment: .trailing)
      .dynamicTypeSize(...VoiceActivityPresentation.islandMaxTypeSize)
  }
}

/// Minimal Dynamic Island (shared with another activity): the glyph.
public struct VoiceActivityMinimal: View {
  let presentation: VoiceActivityPresentation

  public init(presentation: VoiceActivityPresentation) {
    self.presentation = presentation
  }

  public var body: some View {
    Image(systemName: presentation.symbol)
      .font(.body.weight(.semibold))
      .foregroundStyle(presentation.color)
      .dynamicTypeSize(...VoiceActivityPresentation.islandMaxTypeSize)
      .accessibilityLabel(presentation.spoken)
  }
}

/// Expanded Dynamic Island, top left: the glyph and the phase word.
public struct VoiceActivityExpandedLeading: View {
  let presentation: VoiceActivityPresentation

  public init(presentation: VoiceActivityPresentation) {
    self.presentation = presentation
  }

  public var body: some View {
    HStack(spacing: 8) {
      VoiceActivityGlyph(presentation: presentation, size: 32)
      Text(presentation.phaseWord)
        .font(.headline)
        .foregroundStyle(.white)
        .lineLimit(1)
    }
    .dynamicTypeSize(...VoiceActivityPresentation.islandMaxTypeSize)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(presentation.spoken)
  }
}

/// Expanded Dynamic Island, top right: the timer in the phase's colour.
public struct VoiceActivityExpandedTrailing: View {
  let presentation: VoiceActivityPresentation

  public init(presentation: VoiceActivityPresentation) {
    self.presentation = presentation
  }

  public var body: some View {
    VoiceActivityTimer(startedAt: presentation.state.startedAt)
      .font(.title3.weight(.semibold))
      .foregroundStyle(presentation.color)
      .multilineTextAlignment(.trailing)
      .frame(maxWidth: 96, alignment: .trailing)
      .dynamicTypeSize(...VoiceActivityPresentation.islandMaxTypeSize)
  }
}

/// Expanded Dynamic Island, bottom: the subject line and the End (Stop) button.
public struct VoiceActivityExpandedBottom: View {
  let presentation: VoiceActivityPresentation

  public init(presentation: VoiceActivityPresentation) {
    self.presentation = presentation
  }

  public var body: some View {
    HStack {
      Text(presentation.subjectLine)
        .font(.caption)
        .foregroundStyle(Color.white.opacity(0.6))
        .lineLimit(1)
        .truncationMode(.tail)
        .accessibilityHidden(true)
      Spacer(minLength: 8)
      VoiceActivityEndButton(presentation: presentation)
    }
    .dynamicTypeSize(...VoiceActivityPresentation.islandMaxTypeSize)
  }
}
#endif
