#if os(iOS)
import SwiftUI

// Settings → Text Size page: the seven standard steps, each name drawn in its own size, a check on the stored step,
// and Use System Size only while a step is stored. While the system uses an accessibility size the list is disabled
// and shows no check. The page reads the shared `TextScale` through `TextScaleSettingsRow`, so it draws again after
// a tap or a keyboard step; the rules live in the row and are tested there. Below, the transcript width
// (`TranscriptWidth`) and spacing (`TranscriptDensity`), which stay enabled at every text size. Owner: text size.

struct TextSizeSettingsPage: View {
  var scale = TextScale.shared
  var width = TranscriptWidth.shared
  var density = TranscriptDensity.shared

  var body: some View {
    let row = TextScaleSettingsRow(scale: scale)
    Form {
      Section {
        ForEach(row.steps) { option in
          stepButton(option, row: row)
        }
      } header: {
        Text(UICopy.textSizeStepsHeader)
      } footer: {
        Text(UICopy.textSizeStepsFooter)
      }
      if row.showsUseSystem {
        Section {
          Button(UICopy.textSizeUseSystem, systemImage: "arrow.counterclockwise") { row.followSystem() }
            .accessibilityIdentifier("textSize.useSystem")
        } footer: {
          Text(UICopy.textSizeUseSystemFooter)
        }
      }
      Section {
        ForEach(TranscriptWidthMode.allCases, id: \.self) { mode in
          widthButton(mode)
        }
      } header: {
        Text(UICopy.textSizeWidthHeader)
      } footer: {
        Text(UICopy.textSizeWidthFooter)
      }
      Section {
        ForEach(TranscriptDensityMode.allCases, id: \.self) { mode in
          optionButton(
            UICopy.textSizeSpacing(mode), checked: density.mode == mode, id: "textSize.spacing.\(mode.rawValue)"
          ) { density.choose(mode) }
        }
      } header: {
        Text(UICopy.textSizeSpacingHeader)
      } footer: {
        Text(UICopy.textSizeSpacingFooter)
      }
    }
    .scrollContentBackground(.hidden)
    .background(Color(uiColor: Palette.background))
  }

  private func widthButton(_ mode: TranscriptWidthMode) -> some View {
    optionButton(UICopy.textSizeWidth(mode), checked: width.mode == mode, id: "textSize.width.\(mode.rawValue)") {
      width.choose(mode)
    }
  }

  /// One option of a transcript section: its name in body text and a check when it is the stored one.
  private func optionButton(
    _ title: String, checked: Bool, id: String, choose: @escaping () -> Void
  ) -> some View {
    Button(action: choose) {
      HStack(spacing: 8) {
        Text(title)
          .appFont(.body)
          .foregroundStyle(Color(uiColor: Palette.text))
        Spacer(minLength: 8)
        if checked {
          Image(systemName: "checkmark").accessibilityHidden(true)
        }
      }
      .contentShape(Rectangle())
    }
    .accessibilityAddTraits(checked ? .isSelected : [])
    .accessibilityIdentifier(id)
  }

  private func stepButton(_ option: TextScaleStepOption, row: TextScaleSettingsRow) -> some View {
    Button {
      row.choose(option.step)
    } label: {
      HStack(spacing: 8) {
        Text(option.name)
          .appFont(.body)
          .dynamicTypeSize(option.step.dynamicTypeSize)
          .foregroundStyle(Color(uiColor: row.stepsEnabled ? Palette.text : Palette.muted))
        Spacer(minLength: 8)
        if option.checked {
          Image(systemName: "checkmark").accessibilityHidden(true)
        }
      }
      .contentShape(Rectangle())
    }
    .disabled(!row.stepsEnabled)
    .accessibilityAddTraits(option.checked ? .isSelected : [])
    .accessibilityIdentifier("textSize.step.\(option.step.rawValue)")
  }
}
#endif
