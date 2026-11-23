#if os(iOS)
import SwiftUI

/// Footer of the New Session sheet while the directory browser is open: in place of the
/// summary and Launch it holds the hint, Cancel (when there is a chosen project to go back to) and "Choose <name>", so
/// the choice stays on screen however long the directory list is. After Choose on a directory without `git` and
/// history the warning sentence with Cancel and Choose Anyway takes the place of the hint and the actions.
///
/// Layout, the first that fits (`ViewThatFits`, measured, because the width of "Choose <name>" depends on the name):
/// the hint and the actions on one line → the hint above the actions side by side → the actions one under the other,
/// full width, with the label wrapping up to three lines and a longer name cut in the middle. The footer stands
/// below the form, so a layout change moves nothing under it. Owner: session control.
struct NewSessionChooseBar: View {
  /// Warning before the choice (``ChoiceWarning/sentence``); `nil` = browsing.
  let warning: String?
  /// Name for "Choose <name>"; `nil` = nothing to choose (the roots level, a listing on its way).
  let targetName: String?
  let canCancel: Bool
  /// Height ceiling of the warning sentence; above it the sentence scrolls (the footer must not cover the form).
  var textCeiling: CGFloat = .infinity
  let cancel: () -> Void
  let choose: () -> Void
  let dismissWarning: () -> Void
  let chooseAnyway: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let warning { warningSentence(warning) }
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .center, spacing: 10) {
          if warning == nil { hint.frame(maxWidth: .infinity, alignment: .leading) } else { Spacer(minLength: 0) }
          actions(stacked: false)
        }
        VStack(alignment: .leading, spacing: 8) {
          if warning == nil { hint.fixedSize(horizontal: false, vertical: true) }
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
              Spacer(minLength: 0)
              actions(stacked: false)
            }
            VStack(spacing: 8) { actions(stacked: true) }
          }
        }
      }
    }
  }

  private var hint: some View {
    Text(UICopy.browseHint)
      .appFont(.footnote)
      .foregroundStyle(Color(uiColor: Palette.muted))
      .accessibilityIdentifier("newSession.browseHint")
  }

  /// The sentence scrolls above its ceiling; the ideal scroll height is the sentence's, so a short one does not look
  /// like a scroll view.
  private func warningSentence(_ sentence: String) -> some View {
    ScrollView {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Image(systemName: "exclamationmark.triangle")
          .foregroundStyle(Color(uiColor: Palette.wait))
          .accessibilityHidden(true)
        Text(sentence)
          .appFont(.subheadline)
          .foregroundStyle(Color(uiColor: Palette.text))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("newSession.chooseWarning")
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollBounceBehavior(.basedOnSize)
    .frame(maxHeight: textCeiling)
    .fixedSize(horizontal: false, vertical: true)
    .onAppear { Announcer.shared.say(sentence) }
  }

  /// Side by side each button keeps its natural width (the layout is chosen only when it fits); stacked they take the
  /// full width and the label wraps.
  @ViewBuilder
  private func actions(stacked: Bool) -> some View {
    if warning != nil {
      outline(UICopy.cancel, id: "newSession.warningCancel", stacked: stacked, action: dismissWarning)
      Button(action: chooseAnyway) { label(UICopy.chooseAnyway, stacked: stacked) }
        .buttonStyle(FilledButtonStyle(fill: Color(uiColor: Palette.wait), text: Color(uiColor: Palette.background)))
        .fixedSize(horizontal: !stacked, vertical: true)
        .accessibilityIdentifier("newSession.chooseAnyway")
    } else {
      if canCancel { outline(UICopy.cancel, id: "newSession.browseCancel", stacked: stacked, action: cancel) }
      if let targetName {
        Button(action: choose) {
          Text(UICopy.choose(targetName))
            .lineLimit(stacked ? 3 : 1)
            .truncationMode(.middle)
        }
        .buttonStyle(PrimaryButtonStyle(size: stacked ? .fullWidth : .inline))
        .fixedSize(horizontal: !stacked, vertical: true)
        .accessibilityIdentifier("newSession.choose")
      }
    }
  }

  private func outline(_ title: String, id: String, stacked: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) { label(title, stacked: stacked) }
      .buttonStyle(OutlineButtonStyle(color: Color(uiColor: Palette.muted)))
      .fixedSize(horizontal: !stacked, vertical: true)
      .accessibilityIdentifier(id)
  }

  private func label(_ title: String, stacked: Bool) -> some View {
    Text(title).frame(maxWidth: stacked ? .infinity : nil)
  }
}
#endif
