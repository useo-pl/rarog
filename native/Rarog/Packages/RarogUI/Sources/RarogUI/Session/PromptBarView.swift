#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// The prompt quote bar over the transcript and the "Prompts in This Session" popover. The bar lies ON the content (it
// does not move the layout), tucked under the session header's bottom edge, and covers neither the field nor the card
// foot; touch target 44 pt. Owner: session control.

/// The bar: a quote icon and one line of the prompt on the prompt bubble's background: a full `userPlate` without
/// glass or a frame, the bubble's text insets, as wide as its content and at most the bubble's cap
/// (``MessageContentView/plateCap(_:spacing:)``). It hangs from the header's bottom edge: square top corners, the
/// bubble's radius on the bottom two, a shade along the top edge as if tucked under the header and a drop shadow below.
/// It slides out from under the edge and back (``setShown(_:animated:settled:)``); whatever stands above the edge is
/// masked off.
/// The session screen gives its leading edge and the column's cap. A tap opens the list of turns.
final class PromptBarView: UIControl {
  /// Visible height: 14 pt text with a tight vertical inset. The touch target stays 44 pt
  /// (`point(inside:with:)`).
  static let visibleHeight: CGFloat = 39
  /// The content inset from the left and right edge of the plate, as the text in the prompt bubble.
  static let inset: CGFloat = MessageContentView.plateHorizontal
  /// The quote's font: `footnote` + 1 pt (14 pt at the default size), scaled by `footnote` with the text size.
  static func quoteFont() -> UIFont {
    Fonts.scaled(.systemFont(ofSize: Fonts.base(.footnote) + 1), relativeTo: .footnote)
  }

  /// How far the drop shadow reaches below and beside the bar (offset 6 pt plus the blur).
  private static let shadowReach: CGFloat = 20
  /// Depth of the shade along the top edge.
  private static let shadeDepth: CGFloat = 6
  /// Slide in: 180 ms, decelerating (the curve cubic-bezier(0.2, 0.8, 0.2, 1)); slide out: shorter, accelerating.
  private static let showDuration: TimeInterval = 0.18
  private static let hideDuration: TimeInterval = 0.12

  private let icon = UIImageView(image: UIImage(systemName: "text.quote"))
  private let label = UILabel()
  private let topShade = CAGradientLayer()
  /// The mask: everything at or below the header's edge, so the part of a sliding bar above it stays hidden.
  private let edgeMask = UIView()
  private var slide: UIViewPropertyAnimator?
  /// Whether the bar should stand. `isHidden` follows it at once on the way in and at the end of the slide on the way
  /// out, so a scroll tick during the slide out does not start it again.
  private(set) var isShown = false
  /// The width cap: the bubble's cap at the current text size, again after a change of text size or density.
  private var widthCap: NSLayoutConstraint!
  /// The transcript's density: the bar ends where the prompt bubble does. The session screen sets it.
  var spacing: TranscriptSpacing = .standard {
    didSet {
      guard spacing != oldValue else { return }
      applyCap()
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    build()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  var quote: String = "" {
    didSet {
      label.text = quote.replacingOccurrences(of: "\n", with: " ")
      accessibilityLabel = UICopy.promptBarSpoken(quote)
    }
  }

  private func build() {
    isAccessibilityElement = true
    accessibilityTraits = .button
    accessibilityHint = UICopy.promptBarHint
    accessibilityIdentifier = "transcript.promptBar"
    // A full background, so Reduce Transparency changes nothing here: there is no variant for it.
    backgroundColor = Palette.userPlate
    layer.roundCorners(Radius.block)
    layer.maskedCorners = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.45
    layer.shadowOffset = CGSize(width: 0, height: 6)
    layer.shadowRadius = 7
    topShade.colors = [UIColor.black.withAlphaComponent(0.45).cgColor, UIColor.black.withAlphaComponent(0).cgColor]
    layer.insertSublayer(topShade, at: 0)
    edgeMask.backgroundColor = .black
    mask = edgeMask
    icon.tintColor = Palette.muted
    icon.setContentHuggingPriority(.required, for: .horizontal)
    icon.setContentCompressionResistancePriority(.required, for: .horizontal)
    label.adjustsFontForContentSizeCategory = true
    label.textColor = Palette.text
    label.lineBreakMode = .byTruncatingTail
    label.numberOfLines = 1
    // As wide as its content: the label keeps its width and gives way with an ellipsis past the column's or the
    // bubble's cap.
    label.setContentHuggingPriority(.defaultHigh, for: .horizontal)
    label.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
    for view in [icon, label] as [UIView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      view.isUserInteractionEnabled = false
    }
    addSubview(icon)
    addSubview(label)
    widthCap = widthAnchor.constraint(
      lessThanOrEqualToConstant: MessageContentView.plateCap(traitCollection, spacing: spacing))
    NSLayoutConstraint.activate([
      widthCap,
      heightAnchor.constraint(greaterThanOrEqualToConstant: Self.visibleHeight),
      icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.inset),
      icon.centerYAnchor.constraint(equalTo: centerYAnchor),
      label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
      label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.inset),
      label.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: 5),
      label.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -5),
      label.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (self: PromptBarView, _: UITraitCollection) in
      self.applyCap()
    }
    applyFonts()
    Fonts.follow(self) { [weak self] in
      guard let self else { return }
      self.applyFonts()
      self.applyCap()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    topShade.frame = CGRect(x: 0, y: 0, width: bounds.width, height: Self.shadeDepth)
    layer.shadowPath = UIBezierPath(
      roundedRect: bounds, byRoundingCorners: [.bottomLeft, .bottomRight],
      cornerRadii: CGSize(width: Radius.block, height: Radius.block)
    ).cgPath
    CATransaction.commit()
    placeEdgeMask()
  }

  /// The header's edge in the bar's own coordinates: the bar's top when it stands, lower while it is pushed up. Room
  /// for the drop shadow below and beside.
  private func placeEdgeMask() {
    let reach = Self.shadowReach
    edgeMask.frame = CGRect(
      x: -reach, y: -transform.ty, width: bounds.width + 2 * reach, height: bounds.height + 2 * reach)
  }

  /// Shows or hides the bar. Animated only on screen (a window with a scene): it slides down from under the header's
  /// edge and back up; with Reduce Motion it fades in place. `settled` runs once the bar has its final state (at once
  /// when nothing animates), and not when a newer call took over the slide.
  func setShown(_ shown: Bool, animated: Bool, settled: @escaping () -> Void = {}) {
    guard shown != isShown else { return }
    isShown = shown
    slide?.stopAnimation(true)
    slide = nil
    guard animated, window?.windowScene != nil else {
      isHidden = !shown
      rest()
      settled()
      return
    }
    let still = UIAccessibility.isReduceMotionEnabled
    // Fully under the edge, the shadow included.
    let tucked = CGAffineTransform(translationX: 0, y: -(max(bounds.height, Self.visibleHeight) + Self.shadowReach))
    let animator: UIViewPropertyAnimator
    if shown {
      if isHidden {
        UIView.performWithoutAnimation {
          if still { alpha = 0 } else { transform = tucked }
          placeEdgeMask()
        }
        isHidden = false
      }
      animator = UIViewPropertyAnimator(
        duration: Self.showDuration, controlPoint1: CGPoint(x: 0.2, y: 0.8), controlPoint2: CGPoint(x: 0.2, y: 1))
      animator.addAnimations { [weak self] in self?.rest() }
      animator.addCompletion { position in if position == .end { settled() } }
    } else {
      animator = UIViewPropertyAnimator(duration: Self.hideDuration, curve: .easeIn)
      animator.addAnimations { [weak self] in
        guard let self else { return }
        if still { self.alpha = 0 } else { self.transform = tucked }
        self.placeEdgeMask()
      }
      animator.addCompletion { [weak self] position in
        guard let self, position == .end, !self.isShown else { return }
        self.isHidden = true
        self.rest()
        settled()
      }
    }
    slide = animator
    animator.startAnimation()
  }

  /// The standing state: in place and opaque.
  private func rest() {
    transform = .identity
    alpha = 1
    placeEdgeMask()
  }

  private func applyCap() {
    widthCap.constant = MessageContentView.plateCap(traitCollection, spacing: spacing)
  }

  /// The quote's font and icon at the text size; again after a step on the flat path, where no trait change comes.
  private func applyFonts() {
    icon.preferredSymbolConfiguration =
      TextStyleScaling.isFlat
      ? UIImage.SymbolConfiguration(font: Fonts.text(.footnote))
      : UIImage.SymbolConfiguration(textStyle: .footnote)
    label.font = Self.quoteFont()
  }

  /// A 44 pt touch target despite the lower bar. The header above the edge takes its own touches, so the area grows
  /// downward by the whole difference (the part under the edge alone is 44 pt); above it grows by half, as when the bar
  /// stood free.
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    let missing = max(0, 44 - bounds.height)
    return bounds.inset(by: UIEdgeInsets(top: -missing / 2, left: 0, bottom: -missing, right: 0)).contains(point)
  }

  /// VoiceOver and Full Keyboard Access: activation is a tap.
  override func accessibilityActivate() -> Bool {
    sendActions(for: .touchUpInside)
    return true
  }

  /// A finger: the bubble's background a tone lighter (dark) or darker (light), not a scale.
  override var isHighlighted: Bool {
    didSet { backgroundColor = isHighlighted ? Palette.userPlatePressed : Palette.userPlate }
  }
}

/// The "Prompts in This Session" popover as a timeline: the newest on top, each prompt a dot on a vertical rail with
/// its time above the text, the current one with a filled `ahead` dot on the bubble's background; a tap on a row jumps
/// to the turn. The list starts at the top, so at the newest, without scrolling, and keyboard focus stands on the
/// first row: the down arrow goes into the past. A full `surface` background, not the popover's glass (the system
/// glass over a dark transcript turns into a grey smear and muted times get lost).
struct PromptListView: View {
  /// Prompts from the oldest (`PromptBar.entries`).
  let entries: [PromptEntry]
  /// The message number of the prompt whose result is on screen.
  let currentSeq: Int?
  let select: (Int) -> Void
  @FocusState private var focused: Int?

  /// The popover's background: full, under the popover's arrow too (the session screen sets it on the controller).
  static let background = Palette.surface
  /// The row's time: `muted`, not `muted2` as at the bubble: `muted2` on the current row's bubble background is ~4.2:1.
  static let clockInk = Palette.muted
  /// A row at the default text size: the time line, two lines of the prompt and the row's padding. The session screen
  /// scales it with the text size for the popover's height.
  static let rowHeight: CGFloat = 76
  /// The title line with its padding at the default text size.
  static let headerHeight: CGFloat = 48
  /// The rows' inset from the popover's edges.
  private static let rowInset: CGFloat = 8
  /// The timeline column: the rail and the dot.
  private static let markWidth: CGFloat = 12
  private static let dot: CGFloat = 10

  var body: some View {
    let ordered = PromptBar.listOrder(entries)
    let numbers = Dictionary(entries.enumerated().map { ($0.element.seq, $0.offset + 1) }) { first, _ in first }
    VStack(alignment: .leading, spacing: 0) {
      if !PopoverLayout.sheetBar {
        // The iPad popover has no title bar: the title stands in the content, with the prompt count.
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(UICopy.promptsTitle)
            .appFont(.headline)
            .foregroundStyle(Color(uiColor: Palette.text))
            .accessibilityAddTraits(.isHeader)
          if !entries.isEmpty {
            // Each row says "Prompt N of M" to VoiceOver, so the bare number is only for the eye.
            Text(entries.count, format: .number)
              .appFont(.footnote.monospacedDigit())
              .foregroundStyle(Color(uiColor: Palette.muted))
              .accessibilityHidden(true)
          }
        }
        .padding(.horizontal, PopoverLayout.contentInset)
        .padding(.top, 16)
        .padding(.bottom, 8)
      }
      if entries.isEmpty {
        Text(UICopy.promptsEmpty)
          .appFont(.body)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        List(Array(ordered.enumerated()), id: \.element.seq) { index, entry in
          row(
            entry, number: numbers[entry.seq] ?? 0, current: entry.seq == currentSeq,
            railAbove: index > 0, railBelow: index < ordered.count - 1)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 0)
        .defaultFocus($focused, ordered.first?.seq)
      }
    }
    .popoverSheetChrome(title: UICopy.promptsTitle)
    .frame(minWidth: PopoverLayout.minWidth, idealWidth: PopoverLayout.idealWidth)
    .accessibilityIdentifier("prompts.sheet")
  }

  private func row(_ entry: PromptEntry, number: Int, current: Bool, railAbove: Bool, railBelow: Bool) -> some View {
    Button { select(entry.seq) } label: {
      HStack(alignment: .timelineDot, spacing: 12) {
        dot(current: current)
          .frame(width: Self.markWidth)
          .anchorPreference(key: TimelineDotKey.self, value: .center) { $0 }
        VStack(alignment: .leading, spacing: 2) {
          Text(ServerTime.clock(entry.at) ?? "")
            .appFont(.caption.monospacedDigit())
            .foregroundStyle(Color(uiColor: Self.clockInk))
            .alignmentGuide(.timelineDot) { $0[VerticalAlignment.center] }
          Text(entry.text)
            .appFont(.subheadline.weight(current ? .semibold : .regular))
            .foregroundStyle(Color(uiColor: Palette.text))
            .lineLimit(2)
            .multilineTextAlignment(.leading)
        }
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(.horizontal, 12)
      // The rail runs through the whole row height, from the dot up and down, so the rows join into one line; none
      // above the newest and none below the oldest.
      .backgroundPreferenceValue(TimelineDotKey.self) { anchor in
        GeometryReader { proxy in
          if let anchor {
            let center = proxy[anchor]
            Path { path in
              if railAbove {
                path.move(to: CGPoint(x: center.x, y: 0))
                path.addLine(to: center)
              }
              if railBelow {
                path.move(to: center)
                path.addLine(to: CGPoint(x: center.x, y: proxy.size.height))
              }
            }
            .stroke(Color(uiColor: Palette.text).opacity(0.12), lineWidth: 2)
          }
        }
      }
      .background {
        if current {
          RoundedRectangle(cornerRadius: Radius.block, style: .continuous).fill(Color(uiColor: Palette.userPlate))
        }
      }
      .contentShape(Rectangle())
      // The pointer over another row: the shared delicate wash in the current row's shape; the current row keeps
      // its plate.
      .rarogHover(.fill, in: RoundedRectangle(cornerRadius: Radius.block, style: .continuous), enabled: !current)
    }
    .buttonStyle(.plain)
    .focused($focused, equals: entry.seq)
    .listRowInsets(EdgeInsets(top: 0, leading: Self.rowInset, bottom: 0, trailing: Self.rowInset))
    .listRowSeparator(.hidden)
    .listRowBackground(Color.clear)
    .accessibilityLabel(UICopy.promptRowSpoken(entry, number: number, count: entries.count, current: current))
    .accessibilityAddTraits(current ? .isSelected : [])
    .accessibilityIdentifier("prompts.row.\(entry.seq)")
  }

  /// The dot on the rail: a ring on the popover's background, or for the current turn an `ahead` dot with a soft halo
  /// of the same color.
  private func dot(current: Bool) -> some View {
    let ahead = Color(uiColor: Palette.ahead)
    return ZStack {
      if current {
        Circle().fill(ahead.opacity(0.45)).frame(width: Self.dot + 4, height: Self.dot + 4)
        Circle().fill(ahead).frame(width: Self.dot, height: Self.dot)
      } else {
        Circle().fill(Color(uiColor: Self.background))
          .overlay { Circle().strokeBorder(Color(uiColor: Palette.text).opacity(0.28), lineWidth: 2) }
          .frame(width: Self.dot, height: Self.dot)
      }
    }
    .accessibilityHidden(true)
  }
}

/// The center of a row's timeline dot, for the rail drawn behind the row.
private struct TimelineDotKey: PreferenceKey {
  static let defaultValue: Anchor<CGPoint>? = nil
  static func reduce(value: inout Anchor<CGPoint>?, nextValue: () -> Anchor<CGPoint>?) { value = value ?? nextValue() }
}

extension VerticalAlignment {
  /// The timeline dot stands at the middle of the row's time line.
  private enum TimelineDot: AlignmentID {
    static func defaultValue(in context: ViewDimensions) -> CGFloat { context[VerticalAlignment.center] }
  }
  fileprivate static let timelineDot = VerticalAlignment(TimelineDot.self)
}
#endif
