#if os(iOS)
import UIKit

// A message row's part in the transcript's pointer selection: the highlight under its text, drawn from the field's own
// selection rects in the color of the system selection, and the geometry the session screen asks while the pointer
// drags (the offset under the pointer, the word or paragraph around it, a link under a click). The selection itself
// lives in the session screen, so a reused cell gets its highlight back from the configuration. Owner: transcript.
extension MessageContentView {
  /// The UTF-16 offset in the text closest to `point` (in `view`), when the point is level with the visible text:
  /// the field's height, cut by the window of a folded prompt; `nil` above or below it. A point left or right of the
  /// text takes the start or end of the line at that height.
  func pointerOffset(at point: CGPoint, from view: UIView) -> Int? {
    let local = view.convert(point, to: textView)
    let visible = textView.bounds.intersection(clipView.convert(clipView.bounds, to: textView))
    guard !visible.isNull, local.y >= visible.minY, local.y <= visible.maxY else { return nil }
    let probe = CGPoint(x: min(max(local.x, 0), textView.bounds.width), y: local.y)
    guard let position = textView.closestPosition(to: probe) else { return nil }
    return textView.offset(from: textView.beginningOfDocument, to: position)
  }

  /// The word (`.word`) or paragraph (`.paragraph`) around `offset`, for a double or triple click; `nil` when the
  /// offset is on no word (a space between words selects nothing on a double click).
  func pointerUnit(at offset: Int, granularity: UITextGranularity) -> NSRange? {
    guard let position = textView.position(from: textView.beginningOfDocument, offset: offset) else { return nil }
    let tokenizer = textView.tokenizer
    let range =
      tokenizer.rangeEnclosingPosition(position, with: granularity, inDirection: .storage(.forward))
      ?? tokenizer.rangeEnclosingPosition(position, with: granularity, inDirection: .storage(.backward))
    guard let range else { return nil }
    let start = textView.offset(from: textView.beginningOfDocument, to: range.start)
    let end = textView.offset(from: textView.beginningOfDocument, to: range.end)
    return end > start ? NSRange(location: start, length: end - start) : nil
  }

  /// The link of the character right under `point` (in `view`), as a click on it opens it today.
  func pointerLink(at point: CGPoint, from view: UIView) -> URL? {
    let local = view.convert(point, to: textView)
    guard let position = textView.closestPosition(to: local) else { return nil }
    let offset = textView.offset(from: textView.beginningOfDocument, to: position)
    let length = textView.attributedText.length
    // The closest caret stands between two characters: the one whose box holds the point is under the pointer.
    for index in [offset, offset - 1] where index >= 0 && index < length {
      guard let start = textView.position(from: textView.beginningOfDocument, offset: index),
        let end = textView.position(from: start, offset: 1), let range = textView.textRange(from: start, to: end),
        textView.firstRect(for: range).insetBy(dx: -1, dy: -1).contains(local)
      else { continue }
      return textView.attributedText.attribute(.link, at: index, effectiveRange: nil) as? URL
    }
    return nil
  }

  /// Whether `point` (in `view`) lies on this row's highlighted text.
  func pointerHighlightContains(_ point: CGPoint, from view: UIView) -> Bool {
    guard pointerRange != nil, !pointerHighlight.isHidden else { return false }
    return pointerHighlight.contains(view.convert(point, to: pointerHighlight))
  }

  /// The highlight right under the text, inside the text window: above the code block backgrounds (opaque views under
  /// the text) and clipped with the text of a folded prompt.
  func placePointerHighlight() {
    guard let range = pointerRange, range.length > 0, NSMaxRange(range) <= textView.attributedText.length,
      let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
      let end = textView.position(from: start, offset: range.length),
      let textRange = textView.textRange(from: start, to: end)
    else {
      pointerHighlight.isHidden = true
      return
    }
    if pointerHighlight.superview !== clipView || clipView.subviews.firstIndex(of: pointerHighlight)
      != clipView.subviews.firstIndex(of: textView).map({ $0 - 1 })
    {
      clipView.insertSubview(pointerHighlight, belowSubview: textView)
    }
    pointerHighlight.frame = clipView.bounds
    let rects = textView.selectionRects(for: textRange).map(\.rect).filter { !$0.isEmpty }
      .map { textView.convert($0, to: clipView) }
    pointerHighlight.show(rects)
  }
}

extension MessageContentView {
  /// A system selection made in this field (a finger, or the pencil) ends the transcript's pointer selection, as a new
  /// pointer selection clears the field's.
  func textViewDidChangeSelection(_ textView: UITextView) {
    Self.systemSelectionChanged(in: textView)
  }

  /// The selection of a field in the transcript changed (this message's field, or the cell field of a table in it):
  /// a non-empty one tells the screen above, found in the responder chain.
  static func systemSelectionChanged(in textView: UITextView) {
    guard textView.selectedRange.length > 0, let owner = pointerOwner(from: textView) else { return }
    owner.systemSelectionAppeared(in: textView)
  }

  /// A new pointer selection clears the system selection of this message's field and of the cell fields of its tables.
  func clearSystemSelection() {
    let fields = [textView] + Self.tables(in: textView).map(\.textView)
    for field in fields where field.selectedRange.length > 0 {
      field.selectedRange = NSRange(location: 0, length: 0)
    }
  }

  /// The table views in the message text (the attachment views of its tables), at any depth.
  private static func tables(in view: UIView) -> [MarkdownTableView] {
    view.subviews.flatMap { child -> [MarkdownTableView] in
      if let table = child as? MarkdownTableView { return [table] }
      return tables(in: child)
    }
  }

  static func pointerOwner(from view: UIResponder) -> TranscriptPointerSelecting? {
    var next = view.next
    while let responder = next {
      if let owner = responder as? TranscriptPointerSelecting { return owner }
      next = responder.next
    }
    return nil
  }
}

/// The highlight of a pointer selection in one row: filled rects in the color of the system's text selection, under the
/// text, not taking touches.
final class PointerHighlightView: UIView {
  /// The fill of the system text selection in a message field with the default tint, read from the field's own
  /// highlight on iOS 27.2: one blue in both appearances, more opaque in dark.
  static let fill = UIColor { traits in
    UIColor(red: 0, green: 0.33, blue: 0.65, alpha: traits.userInterfaceStyle == .dark ? 0.35 : 0.2)
  }
  private let shape = CAShapeLayer()
  private(set) var rects: [CGRect] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    layer.addSublayer(shape)
    // The fill is a resolved color: a theme change resolves it again.
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) {
      (self: PointerHighlightView, _: UITraitCollection) in
      self.paint()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }

  func show(_ rects: [CGRect]) {
    self.rects = rects
    isHidden = rects.isEmpty
    let path = UIBezierPath()
    for rect in rects { path.append(UIBezierPath(rect: rect)) }
    shape.frame = bounds
    shape.path = path.cgPath
    paint()
  }

  private func paint() {
    shape.fillColor = Self.fill.resolvedColor(with: traitCollection).cgColor
  }

  /// Whether `point` (in this view) lies on the visible highlight. The view covers the text window
  /// (`placePointerHighlight()`), and the rects of a folded prompt run on below it, where the window hides them.
  func contains(_ point: CGPoint) -> Bool {
    bounds.contains(point) && rects.contains { $0.contains(point) }
  }
}
#endif
