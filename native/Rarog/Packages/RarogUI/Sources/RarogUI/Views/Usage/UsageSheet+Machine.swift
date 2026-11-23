#if os(iOS)
import RarogCore
import SwiftUI

// Machine section of the "Usage" sheet: heading "Mac" or "VPS" with the tailnet name, the three load
// metrics with what each number means, why there are no numbers, the stale note with the machine's own reading time
// and, for an outdated server, the update command. Model: ``UsageSheetModel/MachineSection``. Owner: list.

struct UsageMachineSection: View {
  let section: UsageSheetModel.MachineSection

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(section.title)
          .eyebrow()
        if let tailnet = section.tailnet {
          Spacer(minLength: 8)
          Text(tailnet)
            .appFont(.caption)
            .foregroundStyle(Color(uiColor: Palette.muted))
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(section.spoken)
      .accessibilityAddTraits(.isHeader)
      ForEach(section.metrics) { metric in
        MacPanelRow(metric: metric)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(MacLoadModel.rowSpoken(metric))
      }
      ForEach(section.notes, id: \.self) { note in
        Text(note)
          .appFont(.caption)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
      }
      if let update = section.update {
        Text(update)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.text))
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
          .accessibilityIdentifier("usage.sheet.serverUpdate")
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("usage.sheet.machine")
  }
}

/// Metric row: name, detail and percent in one row; too narrow (large text) — the detail under the name; at
/// accessibility sizes in the narrowest sheet everything under each other, name and detail wrap.
struct MacPanelRow: View {
  let metric: MacMetricRow

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        name
        detail
        Spacer(minLength: 8)
        value
      }
      HStack(alignment: .firstTextBaseline) {
        VStack(alignment: .leading, spacing: 3) {
          name
          detail
        }
        Spacer(minLength: 8)
        value
      }
      VStack(alignment: .leading, spacing: 3) {
        name.fixedSize(horizontal: false, vertical: true)
        detail.fixedSize(horizontal: false, vertical: true)
        value.fixedSize(horizontal: false, vertical: true)
      }
    }
    .appFont(.footnote)
  }

  private var name: some View {
    Text(metric.full).foregroundStyle(Color(uiColor: Palette.text))
  }

  private var detail: some View {
    Text(metric.detail).appFont(.caption).foregroundStyle(Color(uiColor: Palette.muted))
  }

  private var value: some View {
    Group {
      if let percent = metric.percent {
        Text("\(percent)%")
          .fontWeight(UsageInk.weight(metric.tone))
          .foregroundStyle(Color(uiColor: UsageInk.color(metric.tone)))
      } else {
        Text(UICopy.macNoReading).foregroundStyle(Color(uiColor: Palette.muted))
      }
    }
    .monospacedDigit()
  }
}
#endif
