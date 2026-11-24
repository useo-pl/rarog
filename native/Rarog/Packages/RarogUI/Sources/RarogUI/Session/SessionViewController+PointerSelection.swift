#if os(iOS)
import RarogCore
import UIKit

// Selecting the transcript with a pointer (a trackpad on the iPad, a mouse or trackpad on a Mac): a press on the text
// of a message row and a drag select from the press point across rows and messages, a double click selects a word,
// a triple click a paragraph, Cmd+C and the right click menu copy what is highlighted. One selection over the rows
// (``TranscriptPointerSelection``, by row id and offset) instead of the system selection of one text field, so it
// survives cell reuse and scrolling. A finger and the pencil keep the system selection of one message with Select
// More… in its menu: the list's recognizer takes only `.indirectPointer`, and a message field refuses its own
// recognizers only for a pointer press that this screen claims (`MessageTextView.yieldsPointerPress(at:)`). Edge
// autoscroll: `+PointerAutoscroll`; the highlight in a row: `MessageContentView+PointerHighlight`. Owner: transcript.

/// The screen above a message field that runs the pointer selection across transcript rows; the field finds it in the
/// responder chain.
@MainActor protocol TranscriptPointerSelecting: AnyObject {
  /// Whether a pointer press at `point` (in `field`) belongs to the pointer selection instead of the field's gestures:
  /// a primary press where a selection starts, a secondary press on the highlight.
  func pointerSelectionClaims(_ field: MessageTextView, at point: CGPoint, secondary: Bool) -> Bool
  /// A touch of any kind began in a message field (the trace of touch kinds).
  func transcriptTouchBegan(_ type: UITouch.TouchType, in field: MessageTextView)
  /// A system selection appeared in a message field.
  func systemSelectionAppeared(in field: UITextView)
}

/// The pointer selection state of one session screen.
@MainActor
final class TranscriptPointerChrome {
  /// One press of the pointer, from the click to the release.
  struct Gesture {
    /// The press point, in the screen's view (the list scrolls under it).
    let start: CGPoint
    let clicks: Int
    /// The press point in the text as an empty selection. It goes through ``TranscriptPointerSelection/validated(in:)``
    /// on every render like the selection, so a press on the streaming answer follows the answer into its message.
    var anchor: TranscriptPointerSelection
    /// The word or paragraph of a double or triple click, or the character a single click is on (none on white space
    /// and off the glyphs), from its start to its end: the drag extends from it. It follows the rows like ``anchor``.
    var unit: TranscriptPointerSelection?
    /// The last pointer location, in the screen's view; autoscroll resolves it again every frame.
    var pointer: CGPoint
    /// The drag got past the slop of a click (or the press was a double or triple click).
    var selecting = false
    /// The link under a click without movement, opened on release.
    var link: URL?
    /// The session file the inline code under a click without movement names, when no link is there
    /// (`+FileOpen`).
    var file: String?
    /// Autoscroll frames that moved the list.
    var frames = 0
    /// A system selection appeared in a message field during the press.
    var sawSystemSelection = false
  }

  let press = UILongPressGestureRecognizer()
  let secondaryClick = UITapGestureRecognizer()
  var menu: UIEditMenuInteraction?
  var delegate: TranscriptPointerDelegate?
  var selection: TranscriptPointerSelection?
  /// The rows as the selection sees them, built once per render (`nil` = the render changed them).
  var rows: [TranscriptSelectionRow]?
  /// The highlighted range of each row: the cells read it when configured.
  var ranges: [String: NSRange] = [:]
  var gesture: Gesture?
  var clicks = TerminalClickCounter()
  var pendingLink: Task<Void, Never>?
  var openURL: @MainActor (URL) -> Void = { UIApplication.shared.open($0) }
  /// Autoscroll: the frame clock (tests drive frames by hand with it off) and the last frame's time.
  var displayLinkEnabled = true
  var link: CADisplayLink?
  var lastFrame: CFTimeInterval?
  /// The text the last pointer copy put on the clipboard (tests: the runner cannot read the clipboard back).
  var lastCopy: String?
}

/// Recognizer and menu delegate of the pointer selection; holds the screen weakly.
@MainActor
final class TranscriptPointerDelegate: NSObject, UIGestureRecognizerDelegate, @preconcurrency UIEditMenuInteractionDelegate {
  weak var controller: SessionViewController?

  init(controller: SessionViewController) {
    self.controller = controller
  }

  func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    guard let controller, let list = controller.collectionView else { return false }
    let point = touch.location(in: list)
    if recognizer === controller.pointerChrome.secondaryClick { return controller.pointerHighlightContains(point) }
    return controller.pointerPressStarts(at: point)
  }

  func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive event: UIEvent) -> Bool {
    // The selection press takes the primary button only; the right click has its own recognizer.
    guard recognizer === controller?.pointerChrome.press, event.type == .touches else { return true }
    return !event.buttonMask.contains(.secondary)
  }

  func editMenuInteraction(
    _ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration,
    suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    guard let controller, controller.pointerCopyText() != nil else { return nil }
    return UIMenu(children: controller.pointerMenuActions())
  }
}

extension SessionViewController: TranscriptPointerSelecting {
  /// A click and a drag shorter than this is a click, not a selection.
  static let pointerDragSlop: CGFloat = 4

  /// `viewDidLoad`: the list's pointer recognizers, the right click menu and the stop on going to the background.
  func buildPointerSelection() {
    let chrome = pointerChrome
    let delegate = TranscriptPointerDelegate(controller: self)
    chrome.delegate = delegate
    let pointer = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
    chrome.press.addTarget(self, action: #selector(handlePointerPress(_:)))
    chrome.press.minimumPressDuration = 0
    chrome.press.allowableMovement = .greatestFiniteMagnitude
    chrome.press.allowedTouchTypes = pointer
    chrome.press.delegate = delegate
    collectionView.addGestureRecognizer(chrome.press)
    chrome.secondaryClick.addTarget(self, action: #selector(handlePointerSecondaryClick(_:)))
    chrome.secondaryClick.buttonMaskRequired = .secondary
    chrome.secondaryClick.allowedTouchTypes = pointer
    chrome.secondaryClick.delegate = delegate
    collectionView.addGestureRecognizer(chrome.secondaryClick)
    NotificationCenter.default.addObserver(
      self, selector: #selector(pointerEnteredBackground), name: UIApplication.didEnterBackgroundNotification,
      object: nil)
  }

  // MARK: - Gesture

  @objc private func handlePointerPress(_ recognizer: UILongPressGestureRecognizer) {
    let point = recognizer.location(in: view)
    switch recognizer.state {
    case .began:
      pointerDown(at: point, count: pointerChrome.clicks.register(at: point, time: CACurrentMediaTime()))
    case .changed:
      pointerDrag(to: point)
    case .ended:
      pointerUp(at: point)
    default:
      pointerCancelled()
    }
  }

  /// The pointer pressed at `point` (in the screen's view): ×1 clears the selection and anchors there (a drag takes the
  /// character under the press), ×2 selects the word, ×3 the paragraph. A press outside the text of a message row
  /// does nothing.
  func pointerDown(at point: CGPoint, count: Int) {
    let chrome = pointerChrome
    chrome.pendingLink?.cancel()
    chrome.pendingLink = nil
    cancelTranscriptFileOpen()
    let listPoint = view.convert(point, to: collectionView)
    let rows = pointerRows()
    guard pointerPressStarts(at: listPoint), let (id, content, offset) = pressedText(at: listPoint),
      let anchor = TranscriptPointerSelection(at: TranscriptTextPoint(row: id, offset: offset), in: rows)
    else {
      chrome.gesture = nil
      return
    }
    takeListForPointer()
    clearSystemSelections()
    // Cmd+C reaches this screen through the responder chain: from the field when it has the keyboard, else directly.
    if !composer.textView.isFirstResponder, !isFirstResponder { becomeFirstResponder() }
    var gesture = TranscriptPointerChrome.Gesture(start: point, clicks: count, anchor: anchor, pointer: point)
    var selection: TranscriptPointerSelection?
    if count > 1, let range = content.pointerUnit(at: offset, granularity: count == 2 ? .word : .paragraph),
      let unit = Self.pointerRange(range, row: id, in: rows)
    {
      gesture.unit = unit
      gesture.selecting = true
      selection = unitSelection(unit, toward: .text(anchor.anchor), in: rows)
    } else if count == 1 {
      gesture.link = content.pointerLink(at: listPoint, from: collectionView)
      if gesture.link == nil { gesture.file = transcriptFileCandidate(in: content, at: listPoint) }
      // The character under the press is the unit of a single click; nothing is selected before the drag.
      if let range = content.pointerPressedCharacter(at: listPoint, from: collectionView) {
        gesture.unit = Self.pointerRange(range, row: id, in: rows)
      }
    }
    chrome.gesture = gesture
    applyPointerSelection(selection)
  }

  /// The pointer moved to `point` (in the screen's view) with the button held.
  func pointerDrag(to point: CGPoint) {
    guard var gesture = pointerChrome.gesture else { return }
    gesture.pointer = point
    if !gesture.selecting {
      guard hypot(point.x - gesture.start.x, point.y - gesture.start.y) > Self.pointerDragSlop else {
        pointerChrome.gesture = gesture
        return
      }
      gesture.selecting = true
      gesture.link = nil
      gesture.file = nil
    }
    pointerChrome.gesture = gesture
    extendPointerSelection()
    updatePointerAutoscroll()
  }

  /// The button came up: autoscroll stops, the list's pin follows where it ended, and a click without movement on a
  /// link, or on inline code that names a session file, opens it once the double click window passed (a second click
  /// selects a word instead).
  func pointerUp(at point: CGPoint) {
    guard let gesture = pointerChrome.gesture else { return }
    finishPointerGesture(gesture)
    if gesture.clicks == 1, !gesture.selecting, let url = gesture.link {
      let open = pointerChrome.openURL
      pointerChrome.pendingLink = Task { @MainActor [weak self] in
        try? await Task.sleep(for: .seconds(TerminalClickCounter.interval))
        guard !Task.isCancelled, let self else { return }
        self.pointerChrome.pendingLink = nil
        open(url)
      }
    } else if gesture.clicks == 1, !gesture.selecting, let file = gesture.file {
      openTranscriptFile(file)
    }
    if gesture.selecting {
      let trace = TranscriptPointerGestureTrace(
        listWon: !gesture.sawSystemSelection, clicks: gesture.clicks, autoscrollFrames: gesture.frames)
      if let line = Self.pointerTraceBudget.gesture(trace) { store.trace(line) }
    }
  }

  /// The gesture was cancelled (the system took the touch): the selection made so far stays.
  func pointerCancelled() {
    guard let gesture = pointerChrome.gesture else { return }
    finishPointerGesture(gesture)
  }

  private func finishPointerGesture(_ gesture: TranscriptPointerChrome.Gesture) {
    pointerChrome.gesture = nil
    stopPointerAutoscroll()
    collectionView.pointerScrolling = false
    if gesture.frames > 0 {
      endGestureOnList()
      updateJumpBar()
    } else {
      readingChrome.gesture = false
      // The list did not follow new content under the press; a pinned one goes down now.
      if pinned, !autoScrollBlocked { settleAtBottom() }
    }
  }

  /// A press takes the list like a finger: an animated jump to the bottom or to the New line stops where it is.
  private func takeListForPointer() {
    if readingChrome.jumpAnimating || readingChrome.lineJumping {
      collectionView.setContentOffset(collectionView.contentOffset, animated: false)
    }
    takeListForGesture()
    collectionView.pointerScrolling = true
  }

  /// `viewWillDisappear` (a session change): a press in progress ends where it is.
  func leavePointerSelection() {
    pointerChrome.pendingLink?.cancel()
    pointerChrome.pendingLink = nil
    cancelTranscriptFileOpen()
    pointerCancelled()
  }

  @objc private func pointerEnteredBackground() {
    pointerCancelled()
  }

  // MARK: - Where the pointer is

  /// Whether a primary press at `point` (in the list) starts a pointer selection: on the text of a message row of the
  /// transcript, not on its controls (Show All, a code block's copy icon), not in a table (its own field selects its
  /// cells), not on a queued bubble whose tap takes the queue back, and not on a card.
  func pointerPressStarts(at point: CGPoint) -> Bool {
    guard let list = collectionView, var view = list.hitTest(point, with: nil) else { return false }
    var field: MessageTextView?
    while view !== list {
      if view is UIControl || view is MarkdownTableView { return false }
      if field == nil, let text = view as? MessageTextView { field = text }
      if let content = view as? MessageContentView {
        guard let field, field === content.textView, !content.current.bare else { return false }
        if content.takesBackTap(at: list.convert(point, to: content)) { return false }
        return content.pointerOffset(at: point, from: list) != nil
      }
      guard let parent = view.superview else { return false }
      view = parent
    }
    return false
  }

  func pointerSelectionClaims(_ field: MessageTextView, at point: CGPoint, secondary: Bool) -> Bool {
    let listPoint = field.convert(point, to: collectionView)
    return secondary ? pointerHighlightContains(listPoint) : pointerPressStarts(at: listPoint)
  }

  /// Whether `point` (in the list) lies on the highlighted text of a visible row.
  func pointerHighlightContains(_ point: CGPoint) -> Bool {
    guard pointerChrome.selection != nil else { return false }
    return visibleMessageContents().contains { $0.content.pointerHighlightContains(point, from: collectionView) }
  }

  /// The visible message row whose text is under `point` (in the list), with the offset there.
  private func pressedText(at point: CGPoint) -> (String, MessageContentView, Int)? {
    for (id, content) in visibleMessageContents() where content.convert(content.bounds, to: collectionView).contains(point) {
      guard let offset = content.pointerOffset(at: point, from: collectionView) else { return nil }
      return (id, content, offset)
    }
    return nil
  }

  /// Where the pointer at `point` (in the list) stands among the rows. Outside the visible part of the list (past an
  /// edge, under the foot) it counts at that edge, so the focus follows what the screen shows; above the first or
  /// below the last row only at the real ends of the content.
  func pointerTarget(at point: CGPoint) -> TranscriptPointerTarget? {
    let list = collectionView!
    let inset = list.adjustedContentInset
    let top = list.contentOffset.y + inset.top
    let bottom = max(top, list.contentOffset.y + list.bounds.height - inset.bottom - 1)
    let probe = CGPoint(x: point.x, y: min(max(point.y, top), bottom))
    let visible = list.indexPathsForVisibleItems.sorted().compactMap { index -> (id: String, frame: CGRect)? in
      guard let id = dataSource.itemIdentifier(for: index), let frame = list.layoutAttributesForItem(at: index)?.frame
      else { return nil }
      return (id, frame)
    }
    guard let first = visible.first, let last = visible.last else { return nil }
    if let hit = visible.first(where: { $0.frame.minY <= probe.y && probe.y < $0.frame.maxY }) {
      if rows[hit.id]?.isTextual == true, let content = messageContent(hit.id),
        let offset = content.pointerOffset(at: probe, from: list)
      {
        return .text(TranscriptTextPoint(row: hit.id, offset: offset))
      }
      return .row(hit.id)
    }
    let ids = dataSource.snapshot().itemIdentifiers
    if probe.y < first.frame.minY {
      guard let index = ids.firstIndex(of: first.id), index > 0 else { return .aboveRows }
      return .gap(after: ids[index - 1])
    }
    if probe.y >= last.frame.maxY { return last.id == ids.last ? .belowRows : .gap(after: last.id) }
    let above = visible.last { $0.frame.maxY <= probe.y } ?? first
    return .gap(after: above.id)
  }

  func visibleMessageContents() -> [(id: String, content: MessageContentView)] {
    collectionView.indexPathsForVisibleItems.compactMap { index in
      guard let id = dataSource.itemIdentifier(for: index), let cell = collectionView.cellForItem(at: index),
        let content = Self.messageContent(in: cell)
      else { return nil }
      return (id, content)
    }
  }

  private func messageContent(_ id: String) -> MessageContentView? {
    guard let index = dataSource.indexPath(for: id), let cell = collectionView.cellForItem(at: index) else { return nil }
    return Self.messageContent(in: cell)
  }

  private static func messageContent(in view: UIView) -> MessageContentView? {
    if let content = view as? MessageContentView { return content }
    for child in view.subviews {
      if let found = messageContent(in: child) { return found }
    }
    return nil
  }

  // MARK: - Selection

  /// The rows as the selection sees them, in list order, with the text each message row shows: the same render
  /// styles and cache as the cells, so rows off screen have their text too.
  func pointerRows() -> [TranscriptSelectionRow] {
    if let cached = pointerChrome.rows { return cached }
    let built = dataSource.snapshot().itemIdentifiers.map { id -> TranscriptSelectionRow in
      switch rows[id] {
      case let .text(rowId, role, _, source, _):
        .text(id: rowId, message: Self.messageSeq(rowId), text: markdown.text(source, style: messageStyle(role)))
      case let .open(_, source, _):
        .text(id: id, message: nil, text: markdown.live(source, style: openMessageStyle()))
      case let .pending(_, _, text, _, _, _, _, _):
        .text(id: id, message: nil, text: markdown.text(text, style: pendingStyle()))
      default:
        .other(id: id)
      }
    }
    pointerChrome.rows = built
    return built
  }

  /// The message `seq` of a row id `m<seq>.<block>`.
  static func messageSeq(_ id: String) -> Int? {
    guard id.hasPrefix("m"), let dot = id.firstIndex(of: ".") else { return nil }
    return Int(id[id.index(after: id.startIndex)..<dot])
  }

  /// The focus follows the last pointer location.
  func extendPointerSelection() {
    guard let gesture = pointerChrome.gesture, gesture.selecting,
      let target = pointerTarget(at: view.convert(gesture.pointer, to: collectionView))
    else { return }
    let rows = pointerRows()
    if let unit = gesture.unit {
      guard let next = unitSelection(unit, toward: target, in: rows) else { return }
      applyPointerSelection(next)
      return
    }
    var selection = pointerChrome.selection ?? gesture.anchor
    selection.extend(to: target, in: rows)
    applyPointerSelection(selection)
  }

  /// The selection of `range` in the row `row`, from its start to its end.
  private static func pointerRange(
    _ range: NSRange, row: String, in rows: [TranscriptSelectionRow]
  ) -> TranscriptPointerSelection? {
    guard var selection = TranscriptPointerSelection(at: TranscriptTextPoint(row: row, offset: range.location), in: rows)
    else { return nil }
    selection.extend(to: .text(TranscriptTextPoint(row: row, offset: NSMaxRange(range))), in: rows)
    return selection
  }

  /// A drag from a unit (the pressed character, or a double or triple clicked word or paragraph, from its start to its
  /// end) keeps the whole unit: forward from its start, backward from its end, and inside it the unit itself.
  private func unitSelection(
    _ unit: TranscriptPointerSelection, toward target: TranscriptPointerTarget, in rows: [TranscriptSelectionRow]
  ) -> TranscriptPointerSelection? {
    let start = unit.anchor
    let end = unit.focus
    guard var forward = TranscriptPointerSelection(at: start, in: rows) else { return nil }
    forward.extend(to: target, in: rows)
    if let bounds = forward.ordered(in: rows), bounds.start == forward.focus, forward.focus != start {
      guard var backward = TranscriptPointerSelection(at: end, in: rows) else { return nil }
      backward.extend(to: target, in: rows)
      return backward
    }
    if forward.focus.row == start.row, forward.focus.offset < end.offset {
      var whole = TranscriptPointerSelection(at: start, in: rows)
      whole?.extend(to: .text(end), in: rows)
      return whole
    }
    return forward
  }

  /// The selection and its highlight: the ranges per row go to the visible rows now and to the others when their cells
  /// are configured.
  func applyPointerSelection(_ selection: TranscriptPointerSelection?) {
    pointerChrome.selection = selection
    var ranges: [String: NSRange] = [:]
    if let selection {
      for selected in selection.ranges(in: pointerRows()) { ranges[selected.row] = selected.range }
    }
    pointerChrome.ranges = ranges
    for (id, content) in visibleMessageContents() { content.pointerRange = ranges[id] }
  }

  /// After every render: the selection and the press in progress against the new rows; text changed before a point
  /// drops it, and the streaming answer that closed carries its points into its message.
  func refreshPointerSelection() {
    pointerChrome.rows = nil
    refreshPointerGesture()
    guard let selection = pointerChrome.selection else { return }
    let next = selection.validated(in: pointerRows())
    applyPointerSelection(next)
    if next == nil, let gesture = pointerChrome.gesture, gesture.selecting { finishPointerGesture(gesture) }
  }

  /// The press point and the double or triple clicked unit follow the rows like the selection (before the first drag
  /// there is no selection yet); a press whose point dropped ends where it is.
  private func refreshPointerGesture() {
    guard var gesture = pointerChrome.gesture else { return }
    let rows = pointerRows()
    guard let anchor = gesture.anchor.validated(in: rows) else {
      finishPointerGesture(gesture)
      return
    }
    gesture.anchor = anchor
    if let unit = gesture.unit {
      guard let next = unit.validated(in: rows) else {
        finishPointerGesture(gesture)
        return
      }
      gesture.unit = next
    }
    pointerChrome.gesture = gesture
  }

  /// A new pointer selection clears the system selection of every visible message field and table.
  private func clearSystemSelections() {
    for (_, content) in visibleMessageContents() { content.clearSystemSelection() }
  }

  func systemSelectionAppeared(in field: UITextView) {
    cancelTranscriptFileOpen()
    if pointerChrome.gesture != nil {
      pointerChrome.gesture?.sawSystemSelection = true
      return
    }
    if pointerChrome.selection != nil { applyPointerSelection(nil) }
  }

  // MARK: - Copy and menu

  /// The text Cmd+C and Copy put on the clipboard: what is highlighted (`copyText(in:)`); `nil` = nothing.
  func pointerCopyText() -> String? {
    pointerChrome.selection?.copyText(in: pointerRows())
  }

  /// `canPerformAction`: Copy reaches this screen only when the message field had no selection of its own (the field
  /// answers Copy first), and runs when the pointer selection highlights text.
  func pointerSelectionVerdict(_ action: Selector) -> Bool? {
    guard action == #selector(UIResponderStandardEditActions.copy(_:)) else { return nil }
    return pointerCopyText() != nil
  }

  /// Cmd+C and Copy in the menu: the highlighted text to the clipboard, then the keyboard back to the message field.
  override func copy(_ sender: Any?) {
    guard let text = pointerCopyText() else { return }
    guard Clipboard.copy(text) else {
      announcer.say(UICopy.copyFailed)
      return
    }
    pointerChrome.lastCopy = text
    rarogFocusComposerAfterCopy(sender)
  }

  /// The right click menu on the highlight.
  func pointerMenuActions() -> [UIAction] {
    [
      UIAction(title: UICopy.terminalCopy, image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
        self?.copy(nil)
      },
      UIAction(
        title: UICopy.transcriptSelectMore, image: UIImage(systemName: "text.viewfinder"),
        identifier: MessageContentView.selectMoreAction
      ) { [weak self] _ in
        guard let self, let start = self.pointerChrome.selection?.ordered(in: self.pointerRows())?.start else { return }
        self.openTranscriptSelection(row: start.row)
      },
    ]
  }

  @objc private func handlePointerSecondaryClick(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended, pointerCopyText() != nil else { return }
    let menu = pointerChrome.menu ?? {
      let interaction = UIEditMenuInteraction(delegate: pointerChrome.delegate)
      collectionView.addInteraction(interaction)
      pointerChrome.menu = interaction
      return interaction
    }()
    menu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: recognizer.location(in: collectionView)))
  }

  // MARK: - Trace

  /// Touch kinds and selection gestures traced in this process (`client.log`, without transcript text).
  static var pointerTraceBudget = TranscriptPointerTraceBudget()

  func transcriptTouchBegan(_ type: UITouch.TouchType, in field: MessageTextView) {
    // A new touch ends a tap's waiting open: the second tap of a double tap selects a word instead.
    cancelTranscriptFileOpen()
    let kind: TranscriptTouchKind =
      switch type {
      case .direct: .direct
      case .pencil: .pencil
      case .indirectPointer: .indirectPointer
      default: .indirect
      }
    if let line = Self.pointerTraceBudget.touch(kind) { store.trace(line) }
  }
}
#endif
