#if os(iOS)
import RarogCore
import SwiftUI

/// List footer: a translucent bar docked to the bottom of the list column, edge to
/// edge, that always shows everything at once — the account and under it the server machine with its tailnet, the 5 h and week limits with their resets,
/// and the machine load in three columns beside them (`FooterCardLines`). The card is not a control:
/// no tap, no popover, no pointer effect; VoiceOver hears it as one static element. The details (per-model
/// window, reading times, what each machine number means) are in the "Usage" sheet of the `/usage` app command. The
/// list scrolls under the bar and shows faintly through it (`SessionListView`, `safeAreaBar`). Polling is the core's (`RarogStore+Usage`,
/// `RarogStore+Mac`): in the foreground only. Owner: list.
///
/// A server older than the app's release (``AppState/serverUpdate``): the card's first line is a quiet
/// "Server update available" row, the card's one tap target, that opens the "Usage" sheet with the update command
/// (the only place that shows it).
struct ListFooter: View {
  let store: RarogStore
  /// Split view collapsed to a stack (iPhone, narrow iPad window) — the WINDOW size from `MainSplitView` through
  /// `SessionListView`, like `ListNoticeOverlay.stacked`. `horizontalSizeClass` in the list column is `compact` also
  /// beside the detail.
  let stacked: Bool
  /// Distance between the content and the bottom edge of the screen (`ListFooterMetrics.bottomGap`). The bar's
  /// surface reaches the screen edge: the container takes the safe area off it, and the content keeps its distance.
  var bottomGap: CGFloat = ListFooterMetrics.bottomGap(safeBottom: 0)
  @State private var sheetOpen = false

  var body: some View {
    let usage = PlanUsageModel.make(store.state.planUsage, now: Date())
    let mac = MacLoadModel.make(store.state.macLoad, tailnet: store.state.tailnet, machine: store.state.serverMachine)
    let resets = usage.isSkeleton ? [] : usage.slots.compactMap { $0.segment?.resetsAt }
    card(resets: resets, mac: mac)
      // The update row's sheet: beside the detail a popover, in the stack a sheet.
      .popover(isPresented: $sheetOpen, arrowEdge: .bottom) {
        usageSheet
          .popoverSurface()
          .presentationCompactAdaptation(.sheet)
      }
      // The surface fills the whole bar to the edges. The bar keeps the floating card's height, and the content sits
      // `contentDrop` lower in it: more air under the top line, less over the screen edge.
      .padding(.horizontal, ListFooterMetrics.cardSide)
      .padding(.top, ListFooterMetrics.contentDrop)
      .padding(.bottom, bottomGap - ListFooterMetrics.contentDrop)
      .background { FooterBarSurface() }
  }

  private func card(resets: [Date], mac: MacLoadModel) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      if store.state.serverUpdate != nil {
        updateRow
      }
      // The reset lines count down without a new reading, at the moments they change (like the sheet).
      TimelineView(FooterResetTicks(resets: resets)) { context in
        let now = max(context.date, Date())
        let model = ListFooterCardModel.make(
          usage: PlanUsageModel.make(store.state.planUsage, now: now), mac: mac, now: now)
        FooterCardLines(model: model)
          .padding(.top, store.state.serverUpdate == nil ? ListFooterMetrics.cardPaddingTop : ListFooterMetrics.lineGap)
          .padding(.horizontal, ListFooterMetrics.cardPaddingSide)
          .padding(.bottom, ListFooterMetrics.cardPaddingBottom)
          .frame(maxWidth: .infinity, alignment: .leading)
          // One static element for VoiceOver: one sentence of limits and machine, no button, no hint.
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(model.spoken)
          .accessibilityAddTraits(.isStaticText)
          .accessibilityIdentifier("list.usage")
      }
    }
  }

  /// Update row: quiet ink, one line, its own tap target ≥ 44 pt. The row keeps the card's usual top padding
  /// and line gap; the target reaches down over the gap and the next line (`updateRowTargetReach`) instead of a
  /// 44 pt frame, which put all the spare height above the text.
  private var updateRow: some View {
    Button {
      sheetOpen = true
    } label: {
      HStack(spacing: 6) {
        Image(systemName: "arrow.down.circle").accessibilityHidden(true)
        Text(UICopy.serverUpdate).lineLimit(1)
      }
      .appFont(.caption)
      .foregroundStyle(Color(uiColor: Palette.muted))
      .padding(.top, ListFooterMetrics.cardPaddingTop)
      .padding(.horizontal, ListFooterMetrics.cardPaddingSide)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.bottom, ListFooterMetrics.updateRowTargetReach)
      .contentShape(Rectangle())
      .padding(.bottom, -ListFooterMetrics.updateRowTargetReach)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("list.serverUpdate")
  }

  /// The "Usage" sheet of the update row. Beside the detail a popover sized to its content
  /// (600 pt ceiling), in the stack a sheet with detents.
  var usageSheet: UsageSheet {
    UsageSheet(store: store, compact: stacked, ownSurface: false) { sheetOpen = false }
  }
}

/// The bar's surface, a translucent container that does not float, cut off by a delicate line on top: a system
/// blur, which draws no rim, under the `footerCardLayer` color, so the list shows
/// faintly, and a one-pixel `border` line along the top edge. No shadow, no corners. Reduce Transparency: the solid
/// footer color.
private struct FooterBarSurface: View {
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    Group {
      if reduceTransparency {
        Color(uiColor: Palette.footerCardSolid)
      } else {
        ZStack {
          Rectangle().fill(.ultraThinMaterial)
          Color(uiColor: Palette.footerCardLayer)
        }
      }
    }
    .overlay(alignment: .top) {
      Rectangle()
        .fill(Color(uiColor: Palette.border))
        .frame(height: 1 / max(1, displayScale))
    }
    .accessibilityHidden(true)
  }
}

/// Ticks of the card's reset lines (``PlanUsageModel/nextResetTick(after:resets:)``).
private struct FooterResetTicks: TimelineSchedule {
  let resets: [Date]

  func entries(from startDate: Date, mode: TimelineScheduleMode) -> UnfoldFirstSequence<Date> {
    sequence(first: startDate) { PlanUsageModel.nextResetTick(after: $0, resets: resets) }
  }
}
#endif
