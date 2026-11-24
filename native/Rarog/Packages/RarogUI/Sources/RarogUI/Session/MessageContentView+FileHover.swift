#if os(iOS)
import UIKit

// The pointer over inline code that names a session file: a dotted underline in the inline code ink under the run, and
// a request for a rounded rect pointer around the line of the run under it. The overlay is a view inside the message
// field, above its text: under the field the inline code background, which the layout fragment draws, would cover it.
// Over the run it is the deepest view under the pointer, and its own pointer interaction asks for the rounded rect;
// the field keeps its own interaction for the text beam. Touches pass through it to the field and the list. The text
// and its layout stay as they are, so the selection and the render cache do not change. What to underline the screen
// decides (`SessionViewController+FileHover`). Owner: transcript.
extension MessageContentView {
  /// The underlined run; `nil` = none.
  var fileHoverRange: NSRange? {
    guard let overlay = shownFileHover, !overlay.isHidden else { return nil }
    return overlay.range
  }

  /// The overlay of this row, made on the first hover.
  var fileHover: FileHoverView {
    if let overlay = shownFileHover { return overlay }
    let overlay = FileHoverView()
    textView.addSubview(overlay)
    return overlay
  }

  private var shownFileHover: FileHoverView? {
    textView.subviews.lazy.compactMap { $0 as? FileHoverView }.first
  }

  /// Underlines `range` of the text: one dotted line under each of its lines. The geometry is read again on every
  /// call, so a pointer move over the same run follows a layout that changed under it.
  func showFileHover(_ range: NSRange) {
    guard range.length > 0, NSMaxRange(range) <= textView.attributedText.length,
      let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
      let end = textView.position(from: start, offset: range.length),
      let textRange = textView.textRange(from: start, to: end)
    else { return hideFileHover() }
    let rects = textView.selectionRects(for: textRange).map(\.rect).filter { !$0.isNull && $0.width > 0 }
    guard !rects.isEmpty else { return hideFileHover() }
    let overlay = fileHover
    textView.bringSubviewToFront(overlay)
    overlay.frame = CGRect(origin: .zero, size: textView.bounds.size)
    overlay.show(range: range, rects: rects, lines: rects.map(underline(in:)))
  }

  func hideFileHover() {
    shownFileHover?.hide()
  }

  /// The height of the underline in a line's rect: just under the glyphs' descent (the bottom of the caret there),
  /// inside the inline code background, and never below the rect.
  private func underline(in rect: CGRect) -> CGFloat {
    guard let position = textView.closestPosition(to: CGPoint(x: rect.midX, y: rect.midY)) else { return rect.maxY - 1 }
    let caret = textView.caretRect(for: position)
    guard !caret.isNull, !caret.isInfinite else { return rect.maxY - 1 }
    return min(caret.maxY + 1, rect.maxY - 1)
  }
}

/// The dotted underline of a hovered inline code run and the pointer shape over it. It takes no touches: its hit test
/// answers only for events other than touches (the pointer's hover), so a click, a tap or a press reaches the field
/// under it and the list's recognizers as before.
final class FileHoverView: UIView, UIPointerInteractionDelegate {
  /// The dots: 1 pt long, 2 pt apart, 1 pt thick.
  private static let dash: [NSNumber] = [1, 2]
  /// How far the pointer's rounded rect reaches past the run's glyphs on each side.
  private static let pointerOutset: CGFloat = 2

  private let dots = CAShapeLayer()
  private(set) var range: NSRange?
  /// The run's line rects, in this view (which covers the field from its origin).
  private(set) var rects: [CGRect] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    isHidden = true
    backgroundColor = .clear
    isAccessibilityElement = false
    dots.fillColor = nil
    dots.lineWidth = 1
    dots.lineDashPattern = Self.dash
    layer.addSublayer(dots)
    addInteraction(UIPointerInteraction(delegate: self))
    // The ink is a resolved color: a theme or contrast change resolves it again.
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) {
      (self: FileHoverView, _: UITraitCollection) in
      self.paint()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }

  /// `lines`: the height of the underline in each rect.
  func show(range: NSRange, rects: [CGRect], lines: [CGFloat]) {
    self.range = range
    self.rects = rects
    let path = UIBezierPath()
    for (rect, line) in zip(rects, lines) {
      path.move(to: CGPoint(x: rect.minX, y: line))
      path.addLine(to: CGPoint(x: rect.maxX, y: line))
    }
    dots.frame = bounds
    dots.path = path.cgPath
    paint()
    isHidden = false
  }

  func hide() {
    range = nil
    rects = []
    dots.path = nil
    isHidden = true
  }

  private func paint() {
    dots.strokeColor = Palette.inlineCodeInk.resolvedColor(with: traitCollection).cgColor
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard !isHidden, event?.type != .touches, rects.contains(where: { $0.contains(point) }) else { return nil }
    return self
  }

  func pointerInteraction(
    _ interaction: UIPointerInteraction, regionFor request: UIPointerRegionRequest, defaultRegion: UIPointerRegion
  ) -> UIPointerRegion? {
    guard let range, let line = rects.firstIndex(where: { $0.contains(request.location) }) else { return nil }
    return UIPointerRegion(rect: rects[line], identifier: "\(range.location).\(range.length).\(line)")
  }

  func pointerInteraction(_ interaction: UIPointerInteraction, styleFor region: UIPointerRegion) -> UIPointerStyle? {
    let shape = region.rect.insetBy(dx: -Self.pointerOutset, dy: 0)
    return UIPointerStyle(shape: .roundedRect(shape, radius: UIPointerShape.defaultCornerRadius))
  }
}
#endif
