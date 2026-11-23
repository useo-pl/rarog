#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

// Lines of the list footer card: on the left the account e-mail, under it the machine line
// ("Mac · example.ts.net") and under that the usage line with two limit fields of equal width; on the right, beside
// the whole left column, a vertical divider and three machine columns (number on top, a vertical bar taking the
// column's height, label at the bottom). Draws `ListFooterCardModel`; the card around it (glass, update row) is
// `ListFooter`. Owner: list.
//
// Stages (`ViewThatFits`, the first that fits): limits with the machine columns → limits side by side without the
// columns → limits under each other. Accessibility text sizes always take the last one; without the machine feature
// (404) there are no columns and no divider. Machine numbers missing from the card are in the "Usage" sheet. The
// card's height doesn't change between the skeleton and the numbers: ghosts stand in the same places as the text,
// the account lines reserve their space, and the ideal width of every stage is measured on templates, never on the
// numbers.

/// Threshold colors of the card. Above the calm threshold the label, the number and the bar of that field take the
/// threshold color (amber, red); calm fields stay quiet.
enum FooterInk {
  static func label(_ tone: UsageTone?) -> UIColor {
    tone.flatMap(threshold) ?? Palette.muted
  }

  static func value(_ tone: UsageTone?) -> UIColor {
    guard let tone else { return Palette.muted2 }
    return threshold(tone) ?? Palette.text2
  }

  static func bar(_ tone: UsageTone?) -> UIColor {
    tone.flatMap(threshold) ?? Palette.text2
  }

  /// Reset line, machine name and tailnet.
  static let quiet = Palette.muted2

  private static func threshold(_ tone: UsageTone) -> UIColor? {
    switch tone {
    case .calm: nil
    case .warn: Palette.wait
    case .hot: Palette.err
    }
  }
}

/// Text of the card: a size at the default text size, scaled with Dynamic Type relative to `caption` (it also
/// shrinks below the default, unlike `caption2`). Monospaced for labels and numbers.
private struct CardFont: ViewModifier {
  @AppScaledMetric private var size: CGFloat
  let monospaced: Bool
  let weight: Font.Weight

  init(_ size: CGFloat, monospaced: Bool, weight: Font.Weight) {
    _size = AppScaledMetric(wrappedValue: size, relativeTo: .caption)
    self.monospaced = monospaced
    self.weight = weight
  }

  func body(content: Content) -> some View {
    content.font(.system(size: size, weight: weight, design: monospaced ? .monospaced : .default))
  }
}

extension View {
  fileprivate func cardFont(_ size: CGFloat, monospaced: Bool = false, weight: Font.Weight = .regular) -> some View {
    modifier(CardFont(size, monospaced: monospaced, weight: weight))
  }
}

/// Sizes of the card's text at the default text size.
private enum CardType {
  static let account: CGFloat = 13
  static let label: CGFloat = 12.5
  static let percent: CGFloat = 14.5
  static let reset: CGFloat = 13
  static let machineValue: CGFloat = 13
  /// On the iPhone the left column (account lines and limit fields) is 1 pt larger; the machine columns keep their
  /// size.
  static let phoneLeftBoost: CGFloat = 1

  /// A size of the left column: the base size, plus `phoneLeftBoost` on the iPhone.
  @MainActor static func left(_ size: CGFloat) -> CGFloat {
    UIDevice.current.userInterfaceIdiom == .phone ? size + phoneLeftBoost : size
  }
}

/// Ghosts of the skeleton: they pulse only while the first reading is on its way (Reduce Motion stops the pulse)
/// and are dimmed when the reading is unavailable.
private struct Ghost: Equatable {
  var pulses = false
  var opacity: Double = 1
}

private struct GhostPlate: View {
  let ghost: Ghost
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let plate = RoundedRectangle.ghost.fill(Color(uiColor: Palette.border))
    Group {
      if ghost.pulses && !reduceMotion {
        plate.phaseAnimator([1.0, 0.45]) { view, phase in view.opacity(phase) } animation: { _ in
          .easeInOut(duration: 0.8)
        }
      } else {
        plate
      }
    }
    .opacity(ghost.opacity)
  }
}

/// A text, or its ghost in the skeleton, in the frame of `template` (hidden): the width never follows the number.
private struct TemplatedText: View {
  let text: String?
  let template: String
  var alignment: Alignment = .leading
  var ghost = Ghost()

  var body: some View {
    Text(template)
      .hidden()
      .overlay(alignment: alignment) {
        if let text {
          Text(text).fixedSize()
        } else {
          GhostPlate(ghost: ghost).accessibilityHidden(true)
        }
      }
      .fixedSize()
  }
}

/// The card's content: the left column (account lines, usage line) and the machine columns beside it.
struct FooterCardLines: View {
  let model: ListFooterCardModel
  @Environment(\.dynamicTypeSize) private var typeSize

  /// Stage of the usage line (read by the probe in UIKit tests).
  enum Stage: String, CaseIterable, Hashable {
    case full, limits, stack
  }

  var body: some View {
    Group {
      if typeSize.isAccessibilitySize {
        stack
      } else if let machine = model.machine {
        ViewThatFits(in: .horizontal) {
          full(machine)
          limitsRow
          stack
        }
      } else {
        ViewThatFits(in: .horizontal) {
          limitsRow
          stack
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// The left column: the account lines, then the usage line.
  private func leftColumn(_ usage: some View) -> some View {
    VStack(alignment: .leading, spacing: ListFooterMetrics.lineGap) {
      accountLines
      usage
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var limitsGhost: Ghost {
    Ghost(pulses: model.limitsPulse, opacity: model.limitsGhostOpacity)
  }

  /// The e-mail (cut at the end) and under it the machine and tailnet (cut in the middle), at every text size
  /// (side by side, the machine line would squeeze the e-mail). Neither drives the stage of the usage
  /// line: their ideal width is zero. Each line reserves its space (one line, two at accessibility sizes), so the
  /// card's height doesn't follow the data.
  private var accountLines: some View {
    let lines = typeSize.isAccessibilitySize ? 2 : 1
    return VStack(alignment: .leading, spacing: ListFooterMetrics.fieldInnerGap) {
      Text(model.account ?? " ")
        .foregroundStyle(Color(uiColor: Palette.muted))
        .cardFont(CardType.left(CardType.account))
        .lineLimit(lines, reservesSpace: true)
        .truncationMode(.tail)
      Text(model.machineLine)
        .foregroundStyle(Color(uiColor: FooterInk.quiet))
        .cardFont(CardType.left(CardType.account), monospaced: true)
        .lineLimit(lines, reservesSpace: true)
        .truncationMode(.middle)
    }
    .frame(minWidth: 0, idealWidth: 0, maxWidth: .infinity, alignment: .leading)
    .probed("card.account")
  }

  /// The left column beside the machine columns, which span its whole height: the bars take the extra height.
  private func full(_ machine: [FooterMachineColumn]) -> some View {
    HStack(alignment: .top, spacing: ListFooterMetrics.fieldGap) {
      leftColumn(limitFields)
      Rectangle()
        .fill(Color(uiColor: Palette.text).opacity(0.12))
        .frame(width: ListFooterMetrics.dividerWidth)
        .frame(maxHeight: .infinity)
        .accessibilityHidden(true)
      HStack(spacing: ListFooterMetrics.machineColumnGap) {
        ForEach(machine) { column in
          FooterMachineView(column: column, ghost: Ghost(pulses: model.machinePulses))
        }
      }
      .fixedSize(horizontal: true, vertical: false)
      .frame(maxHeight: .infinity)
    }
    .fixedSize(horizontal: false, vertical: true)
    .probedStage(.full)
  }

  private var limitsRow: some View {
    leftColumn(limitFields).probedStage(.limits)
  }

  private var stack: some View {
    leftColumn(
      VStack(alignment: .leading, spacing: ListFooterMetrics.lineGap) {
        ForEach(model.limits) { field in FooterLimitView(field: field, ghost: limitsGhost) }
      }
    )
    .probedStage(.stack)
  }

  /// The two limit fields side by side.
  private var limitFields: some View {
    HStack(alignment: .top, spacing: ListFooterMetrics.fieldGap) {
      ForEach(model.limits) { field in FooterLimitView(field: field, ghost: limitsGhost) }
    }
  }
}

/// Limit field: label and percent in one row, the bar under it, the reset line under that.
struct FooterLimitView: View {
  let field: FooterLimitField
  fileprivate var ghost = Ghost()
  @AppScaledMetric(relativeTo: .caption) private var resetGhostWidth: CGFloat = 44

  /// Templates: two characters of the label, the widest percent.
  static let labelTemplate = "5H"
  static let percentTemplate = "100%"

  var body: some View {
    VStack(alignment: .leading, spacing: ListFooterMetrics.fieldInnerGap) {
      // Label, bar and percent in one row (compact bar); the reset line under it.
      HStack(alignment: .center, spacing: ListFooterMetrics.fieldInnerGap) {
        TemplatedText(text: field.label, template: Self.labelTemplate)
          .foregroundStyle(Color(uiColor: FooterInk.label(field.tone)))
          .cardFont(CardType.left(CardType.label), monospaced: true, weight: .medium)
          .probed("card.\(field.id).label")
        BarGauge(fraction: field.fraction, fill: FooterInk.bar(field.tone))
          .probed("card.\(field.id).bar")
        TemplatedText(text: field.percent, template: Self.percentTemplate, alignment: .trailing, ghost: ghost)
          .foregroundStyle(Color(uiColor: FooterInk.value(field.tone)))
          // The threshold is also carried by the weight, not the color alone.
          .cardFont(
            CardType.left(CardType.percent), monospaced: true, weight: field.tone.map(UsageInk.weight) ?? .regular)
          .probed("card.\(field.id).percent")
      }
      // One line of the reset's height in every state; the text is cut at the end and never widens the field.
      Text(verbatim: " ")
        .hidden()
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) {
          if let reset = field.reset {
            Text(reset)
              .foregroundStyle(Color(uiColor: FooterInk.quiet))
              .lineLimit(1)
              .truncationMode(.tail)
          } else if field.percent == nil {
            GhostPlate(ghost: ghost).frame(width: resetGhostWidth).accessibilityHidden(true)
          }
        }
        .cardFont(CardType.left(CardType.reset))
      .frame(minWidth: 0, idealWidth: 0, maxWidth: .infinity, alignment: .leading)
      .probed("card.\(field.id).reset")
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .probed("card.\(field.id)")
  }
}

/// Machine column: number on top, the vertical bar taking the column's height (at least
/// `ListFooterMetrics.machineBarHeight`), the label at the bottom.
struct FooterMachineView: View {
  let column: FooterMachineColumn
  fileprivate var ghost = Ghost()
  @AppScaledMetric(relativeTo: .caption) private var width: CGFloat = ListFooterMetrics.machineColumnWidth

  var body: some View {
    VStack(spacing: ListFooterMetrics.machineInnerGap) {
      TemplatedText(
        text: column.value ?? (ghost.pulses ? nil : UICopy.usageSlotMissingMark), template: "100", alignment: .center,
        ghost: ghost)
        .foregroundStyle(Color(uiColor: FooterInk.value(column.value == nil ? nil : column.tone)))
        .cardFont(CardType.machineValue, monospaced: true, weight: column.value == nil ? .regular : UsageInk.weight(column.tone))
      ColumnGauge(fraction: column.fraction, fill: FooterInk.bar(column.tone))
        .probed("card.\(column.id).bar")
      TemplatedText(text: column.label, template: "CPU", alignment: .center)
        .foregroundStyle(Color(uiColor: FooterInk.label(column.value == nil ? nil : column.tone)))
        .cardFont(CardType.label, monospaced: true, weight: .medium)
    }
    .frame(minWidth: width, maxHeight: .infinity)
    .probed("card.\(column.id)")
  }
}

// MARK: - Layout probe (UIKit tests)

/// Probe for UIKit tests: which stage `ViewThatFits` drew and where the parts stand
/// (`AccessibilityRegressionTests`). The app has none (`nil`), so no measurement enters the view tree.
@MainActor
final class FooterCardProbe {
  var stages: Set<FooterCardLines.Stage> = []
  var frames: [String: CGRect] = [:]
}

extension EnvironmentValues {
  @Entry var footerCardProbe: FooterCardProbe? = nil
}

private struct Probed: ViewModifier {
  let key: String
  @Environment(\.footerCardProbe) private var probe

  func body(content: Content) -> some View {
    if let probe {
      content.onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { probe.frames[key] = $0 }
    } else {
      content
    }
  }
}

private struct ProbedStage: ViewModifier {
  let stage: FooterCardLines.Stage
  @Environment(\.footerCardProbe) private var probe

  func body(content: Content) -> some View {
    if let probe {
      content.onGeometryChange(for: Bool.self) { _ in true } action: { _ in probe.stages.insert(stage) }
    } else {
      content
    }
  }
}

extension View {
  fileprivate func probed(_ key: String) -> some View {
    modifier(Probed(key: key))
  }

  fileprivate func probedStage(_ stage: FooterCardLines.Stage) -> some View {
    modifier(ProbedStage(stage: stage))
  }
}
#endif
