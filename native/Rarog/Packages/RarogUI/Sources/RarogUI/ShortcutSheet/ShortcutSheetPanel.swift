#if os(iOS)
import UIKit

// The shortcut sheet on screen (variant B): a card in the middle of the window over the app
// dimmed black; the title and "Release ⌘ to close" on top, the group of the focus place apart under "You're here"
// (rows in two columns), the other groups in three columns. A narrow window (iPhone, Slide Over) gets one column that
// scrolls inside the card. A subview of the window like the pointer tip (`ShortcutTipBubble`): over the sheets,
// without a presentation and without taking the first responder. A touch outside the card goes through; the reader
// does not see it (the menu bar of iPadOS stays its accessible path). No entry animation. Colors only from `Palette`,
// radii from `Radius`. Owner: shortcuts.

final class ShortcutSheetPanel: UIView {
  /// The card's width on an iPad in landscape; a narrower window gets less.
  static let maxWidth: CGFloat = 1000
  /// Room between the card and the window's edge.
  static let margin: CGFloat = 24
  /// Inner padding of the card.
  static let padding: CGFloat = 24
  /// Below this card width the groups stand in one column.
  static let oneColumnBelow: CGFloat = 640
  /// The black over the app under the card.
  static let dimAlpha: CGFloat = 0.55

  private static weak var current: ShortcutSheetPanel?

  /// The panel on screen now (UIKit tests).
  static var visible: ShortcutSheetPanel? { current?.superview == nil ? nil : current }

  static func show(_ content: ShortcutSheetContent, in window: UIWindow) {
    hide()
    let panel = ShortcutSheetPanel(content: content)
    panel.frame = window.bounds
    panel.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    window.addSubview(panel)
    current = panel
    panel.layoutIfNeeded()
  }

  static func hide() {
    current?.removeFromSuperview()
    current = nil
  }

  /// Back on top of the window (a sheet presented after the panel went over it).
  static func raise() {
    guard let panel = visible, let window = panel.superview, window.subviews.last !== panel else { return }
    window.bringSubviewToFront(panel)
  }

  let card = UIView()
  let scroll = UIScrollView()
  private let content: ShortcutSheetContent
  private var body: UIStackView?
  /// The groups stand in one column (decided by the card's width at the last layout).
  private(set) var oneColumn = false
  private var built = false

  private init(content: ShortcutSheetContent) {
    self.content = content
    super.init(frame: .zero)
    accessibilityIdentifier = "shortcutSheet"
    accessibilityElementsHidden = true
    isAccessibilityElement = false
    backgroundColor = UIColor.black.withAlphaComponent(Self.dimAlpha)
    card.backgroundColor = Palette.surface
    card.layer.roundCorners(Radius.block)
    card.layer.shadowColor = UIColor.black.cgColor
    card.layer.shadowOpacity = 0.3
    card.layer.shadowRadius = 24
    card.layer.shadowOffset = CGSize(width: 0, height: 8)
    scroll.layer.roundCorners(Radius.block)
    scroll.clipsToBounds = true
    scroll.alwaysBounceVertical = false
    addSubview(card)
    card.addSubview(scroll)
    // The card's height is fitted to its content in `layoutSubviews`; a new text size changes that content.
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (self: ShortcutSheetPanel, _) in
      self.setNeedsLayout()
    }
    // On the flat path (a Mac) a step of the app's text size sends no trait change: the content is built again with
    // the fonts of the new size.
    Fonts.follow(self, scale: .shared) { [weak self] in
      guard let self, TextStyleScaling.isFlat else { return }
      self.built = false
      self.setNeedsLayout()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }

  /// Only the card takes touches; everywhere else the touch reaches the app under the dimming.
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard card.frame.contains(point) else { return nil }
    return super.hitTest(point, with: event)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let room = bounds.inset(by: safeAreaInsets).insetBy(dx: Self.margin, dy: Self.margin)
    let width = max(0, min(Self.maxWidth, room.width))
    let narrow = width < Self.oneColumnBelow
    if !built || narrow != oneColumn { build(oneColumn: narrow) }
    guard let body else { return }
    let inner = max(0, width - 2 * Self.padding)
    let fitted = body.systemLayoutSizeFitting(
      CGSize(width: inner, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
    let contentHeight = ceil(fitted.height) + 2 * Self.padding
    let height = max(0, min(contentHeight, room.height))
    card.frame = CGRect(x: room.midX - width / 2, y: room.midY - height / 2, width: width, height: height).integral
    scroll.frame = card.bounds
    body.frame = CGRect(x: Self.padding, y: Self.padding, width: inner, height: ceil(fitted.height))
    scroll.contentSize = CGSize(width: card.bounds.width, height: contentHeight)
    scroll.isScrollEnabled = contentHeight > height
    card.layer.shadowPath = UIBezierPath(roundedRect: card.bounds, cornerRadius: Radius.block).cgPath
  }

  // MARK: Content

  private func build(oneColumn: Bool) {
    self.oneColumn = oneColumn
    built = true
    body?.removeFromSuperview()
    var parts: [UIView] = [header()]
    if let here = content.here { parts.append(hereSection(here, oneColumn: oneColumn)) }
    let groups: UIView
    if oneColumn {
      groups = stack(content.columns.flatMap { $0 }.map { group($0) }, axis: .vertical, spacing: 20)
    } else {
      let columns = content.columns.map { column -> UIView in
        let view = stack(column.map { group($0) }, axis: .vertical, spacing: 20)
        view.alignment = .fill
        return view
      }
      let row = stack(columns, axis: .horizontal, spacing: 32)
      row.distribution = .fillEqually
      row.alignment = .top
      groups = row
    }
    parts.append(groups)
    let body = stack(parts, axis: .vertical, spacing: 24)
    self.body = body
    scroll.addSubview(body)
  }

  private func header() -> UIView {
    let title = label(content.title, font: Fonts.text(.title3, weight: .bold), color: Palette.text)
    let hint = label(content.releaseHint, font: Fonts.text(.footnote), color: Palette.muted2)
    hint.textAlignment = .right
    hint.setContentHuggingPriority(.required, for: .horizontal)
    title.setContentCompressionResistancePriority(.required, for: .horizontal)
    let row = stack([title, hint], axis: .horizontal, spacing: 16)
    row.alignment = .firstBaseline
    return row
  }

  private func hereSection(_ group: ShortcutSheetContent.Group, oneColumn: Bool) -> UIView {
    let title = label(group.title, font: Fonts.text(.subheadline, weight: .bold), color: Palette.text)
    title.setContentHuggingPriority(.required, for: .horizontal)
    let pill = ShortcutSheetChip(
      text: content.hereTitle, font: Fonts.text(.caption1, weight: .semibold), ink: Palette.onState,
      fill: Palette.new, height: nil)
    let head = stack([title, pill, UIView()], axis: .horizontal, spacing: 10)
    head.alignment = .center
    let rows = group.rows.map {
      row($0, font: Fonts.text(.subheadline), ink: Palette.text, cap: 26, capFill: Palette.surface)
    }
    let grid: UIView
    if oneColumn {
      grid = stack(rows, axis: .vertical, spacing: 10)
    } else {
      let half = (rows.count + 1) / 2
      let left = stack(Array(rows.prefix(half)), axis: .vertical, spacing: 10)
      let right = stack(Array(rows.dropFirst(half)), axis: .vertical, spacing: 10)
      let columns = stack([left, right], axis: .horizontal, spacing: 32)
      columns.distribution = .fillEqually
      columns.alignment = .top
      grid = columns
    }
    let inner = stack([head, grid], axis: .vertical, spacing: 14)
    let section = ShortcutSheetBordered(fill: Palette.surface2, radius: Radius.block)
    inner.translatesAutoresizingMaskIntoConstraints = false
    section.addSubview(inner)
    NSLayoutConstraint.activate([
      inner.topAnchor.constraint(equalTo: section.topAnchor, constant: 16),
      inner.bottomAnchor.constraint(equalTo: section.bottomAnchor, constant: -16),
      inner.leadingAnchor.constraint(equalTo: section.leadingAnchor, constant: 18),
      inner.trailingAnchor.constraint(equalTo: section.trailingAnchor, constant: -18),
    ])
    return section
  }

  private func group(_ group: ShortcutSheetContent.Group) -> UIView {
    let title = UILabel()
    title.attributedText = Eyebrow.text(group.title, color: Palette.muted2)
    title.adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    title.numberOfLines = 0
    let rows = group.rows.map {
      row($0, font: Fonts.text(.footnote), ink: Palette.muted, cap: 20, capFill: Palette.surface2)
    }
    let view = stack([title] + rows, axis: .vertical, spacing: 8)
    view.setCustomSpacing(10, after: title)
    return view
  }

  /// A row: the label on the left, the key caps on the right; two combinations are joined by "or".
  private func row(
    _ row: ShortcutSheetContent.Row, font: UIFont, ink: UIColor, cap: CGFloat, capFill: UIColor
  ) -> UIView {
    let name = label(row.label, font: font, color: ink)
    name.setContentHuggingPriority(.defaultLow, for: .horizontal)
    name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let capFont = cap >= 26 ? Fonts.text(.footnote, weight: .medium) : Fonts.text(.caption1, weight: .medium)
    var keys: [UIView] = []
    for (index, combo) in row.combos.enumerated() {
      if index > 0 {
        let word = label(content.or, font: Fonts.text(.caption1), color: Palette.muted2)
        word.setContentHuggingPriority(.required, for: .horizontal)
        keys.append(word)
      }
      for glyph in ShortcutSheetKeycaps.split(combo) {
        keys.append(ShortcutSheetChip(text: glyph, font: capFont, ink: Palette.text, fill: capFill, height: cap))
      }
    }
    let caps = stack(keys, axis: .horizontal, spacing: 4)
    caps.alignment = .center
    caps.setContentHuggingPriority(.required, for: .horizontal)
    caps.setContentCompressionResistancePriority(.required, for: .horizontal)
    let view = stack([name, caps], axis: .horizontal, spacing: 12)
    view.alignment = .center
    return view
  }

  private func label(_ text: String, font: UIFont, color: UIColor) -> UILabel {
    let label = UILabel()
    label.text = text
    label.font = font
    label.textColor = color
    label.adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    label.numberOfLines = 0
    return label
  }

  private func stack(_ views: [UIView], axis: NSLayoutConstraint.Axis, spacing: CGFloat) -> UIStackView {
    let view = UIStackView(arrangedSubviews: views)
    view.axis = axis
    view.spacing = spacing
    return view
  }
}

/// A view with a fill and the `border` hairline, resolved again when the theme or the contrast setting changes.
class ShortcutSheetBordered: UIView {
  init(fill: UIColor, radius: CGFloat) {
    super.init(frame: .zero)
    backgroundColor = fill
    layer.roundCorners(radius)
    layer.borderWidth = 1
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) {
      (self: ShortcutSheetBordered, _: UITraitCollection) in
      self.resolveBorder()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    resolveBorder()
  }

  private func resolveBorder() {
    layer.borderColor = Palette.border.resolvedColor(with: traitCollection).cgColor
  }
}

/// A key cap (`height` set: at least as wide as tall) or the "You're here" pill (`height` `nil`: a capsule around its
/// text, no border). Sized by its own text (`intrinsicContentSize`) and hugging it, so a row's stack does not stretch
/// the caps to fill the row. `height` is the cap's height at the default text size; the cap scales it with its own
/// traits, so it follows a text size set on the scene, not only the system's.
final class ShortcutSheetChip: ShortcutSheetBordered {
  /// U+FE0E, the text presentation selector.
  static let textPresentation = Character(Unicode.Scalar(0xFE0E)!)

  let label = UILabel()
  let isKeyCap: Bool
  private let height: CGFloat?

  init(text: String, font: UIFont, ink: UIColor, fill: UIColor, height: CGFloat?) {
    self.height = height
    isKeyCap = height != nil
    super.init(fill: fill, radius: Radius.ghost)
    if !isKeyCap { layer.borderWidth = 0 }
    // ↩ and the other arrows draw as emoji without the text presentation selector.
    label.text = isKeyCap ? text + String(Self.textPresentation) : text
    label.font = font
    label.textColor = ink
    label.textAlignment = .center
    label.adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    addSubview(label)
    setContentHuggingPriority(.required, for: .horizontal)
    setContentHuggingPriority(.required, for: .vertical)
    setContentCompressionResistancePriority(.required, for: .horizontal)
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) {
      (self: ShortcutSheetChip, _: UITraitCollection) in
      self.invalidateIntrinsicContentSize()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }

  /// Padding on each side of the text.
  var side: CGFloat { isKeyCap ? 6 : 9 }

  override var intrinsicContentSize: CGSize {
    let text = label.intrinsicContentSize
    let width = ceil(text.width) + 2 * side
    guard let height else { return CGSize(width: width, height: ceil(text.height) + 6) }
    let scaled = TextStyleScaling.scale(
      height, relativeTo: .body, category: TextScale.shared.effective, traits: traitCollection)
    return CGSize(width: max(width, scaled), height: scaled)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = bounds
    if !isKeyCap { layer.cornerRadius = bounds.height / 2 }
  }
}
#endif
