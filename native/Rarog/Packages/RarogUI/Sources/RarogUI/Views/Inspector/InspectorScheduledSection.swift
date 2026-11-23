#if os(iOS)
import RarogContract
import SwiftUI
import UIKit

/// SCHEDULED TASKS: the crons the session's Claude Code has armed (`SessionSummary.scheduledTasks`), in server order,
/// between RECENTLY FINISHED and ARTIFACTS. The panel places the section only with visible rows (`ScheduledTaskRows`
/// drops expired ones under the panel's clock). A rule over the label as over ARTIFACTS; rows flat, without a
/// container, so each one is a target of the panel anchor. Rows have no action. Owner: panel.
struct InspectorScheduledSection: View {
  let rows: [ScheduledTaskRow]

  var body: some View {
    Rectangle()
      .fill(Color(uiColor: Palette.border))
      .frame(height: 1)
      .padding(.top, 22)
      .accessibilityHidden(true)
    BackgroundSectionTitle(text: UICopy.inspectorScheduledTitle)
      .padding(.top, 18)
      .padding(.bottom, 10)
      .id(InspectorModel.scheduledAnchor)
      .accessibilityIdentifier("inspector.scheduled.title")
    ForEach(rows) { row in
      ScheduledTaskRowView(row: row)
    }
  }
}

/// A task row in the grammar of the Recently finished rows (`FinishedTaskRowView`): a glyph in the mark column
/// (a clock for a task that runs once, a loop for a repeating one), the prompt in `footnote` up to two lines, under it
/// the muted line (`StateLine`: "once · 19 Nov 22:13", "every 5 min · next 22:14"). VoiceOver hears one sentence.
private struct ScheduledTaskRowView: View {
  let row: ScheduledTaskRow
  @AppScaledMetric(relativeTo: .footnote) private var capMid: CGFloat = 4.6

  var body: some View {
    // A clock per row, like `FinishedTaskRowView`: "next" turns into "last" once the run has passed, and the row
    // stays a direct child of the stack with the panel anchor.
    TimelineView(.periodic(from: .now, by: FinishedTaskRowView.refresh)) { context in
      content(now: context.date)
    }
  }

  private func content(now: Date) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: RowGrid.gap) {
      RowMark(capMid: capMid) {
        Image(systemName: row.recurring ? "repeat" : "clock")
          .appFont(.caption.weight(.medium))
          .imageScale(.small)
          .foregroundStyle(Color(uiColor: Palette.muted2))
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(row.prompt)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.text2))
          .lineLimit(2)
          .truncationMode(.tail)
          .fixedSize(horizontal: false, vertical: true)
        StateLine(parts: row.status(now: now).map { StateLine.Part(text: $0, ink: Palette.muted2) })
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 6)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(row.spoken(now: now))
    .accessibilityAddTraits(.isStaticText)
    .accessibilityIdentifier("inspector.scheduled.\(row.id)")
  }
}

/// The panel's clock of the Scheduled Tasks section: every half minute, outside the lazy stack, it checks which rows
/// are still visible (an `expiresAt` may pass without a new frame) and moves the panel's moment only when that set
/// changes, so the section header goes with its last row. Invisible.
struct ScheduledTasksClock: View {
  let tasks: [SessionScheduledTask]
  let settle: (Date) -> Void

  var body: some View {
    TimelineView(.periodic(from: .now, by: FinishedTaskRowView.refresh)) { context in
      Color.clear
        .onChange(of: ScheduledTaskRows.visibleIds(tasks, now: context.date), initial: true) { _, _ in
          settle(Date())
        }
    }
    .accessibilityHidden(true)
  }
}
#endif
