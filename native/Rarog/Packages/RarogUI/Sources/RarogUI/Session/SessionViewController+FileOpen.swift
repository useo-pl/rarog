#if os(iOS)
import RarogCore
import UIKit

// A path in inline code of a transcript message opens the session file in the Files tree's preview. Agents name files
// in inline code far more often than in links, so the text of the inline code run under a click or a finger tap is the
// candidate (`TranscriptFilePath`), resolved against the session's file index by the screen's one
// `TranscriptFileOpener`. A pointer click without movement gets it in `+PointerSelection`, next to the link of the
// same character; a finger or pencil tap gets it from a tap recognizer on the list. Both wait for the double click
// window like a link, so a double click or a double tap selects a word instead. A link on the character wins, a queued
// bubble keeps its take-back tap, and Show All, a code block's copy icon, tables, cards and Inbox cards (no session
// screen above them) open nothing. Inline code looks as before; the pointer's hover marks the runs that open
// (`+FileHover`). Owner: transcript.

/// The file open of one session screen: the finger's tap recognizer and the opener. The screen shows one session for
/// its whole life, so the index the opener keeps never serves another session.
@MainActor
final class TranscriptFileChrome {
  let tap = UITapGestureRecognizer()
  var delegate: TranscriptFileTapDelegate?
  /// A click's or tap's open waiting for the double click window.
  var pending: Task<Void, Never>?
  /// Built on the first open.
  var opener: TranscriptFileOpener?
  /// Shows the preview from the screen's own view controller, as the Files tree shows it from the panel's.
  let presenter = FilePreviewPresenter()
  /// When the finger of the tap being recognized touched down (the clock of `UITouch.timestamp`).
  var touchedAt: TimeInterval?
  /// The pointer's hover over the list (`+FileHover`).
  let hover = UIHoverGestureRecognizer()
  var hoverDelegate: TranscriptFileHoverDelegate?
  /// Where the pointer hovers, in the screen's view; `nil` = it left, or a scroll or a press took the underline away.
  var hoverPoint: CGPoint?
  /// The row whose run is underlined.
  weak var underlined: MessageContentView?
}

/// Delegate of the finger's tap recognizer; holds the screen weakly.
@MainActor
final class TranscriptFileTapDelegate: NSObject, UIGestureRecognizerDelegate {
  weak var controller: SessionViewController?

  init(controller: SessionViewController) {
    self.controller = controller
  }

  /// Every new touch on the list ends a waiting open; the tap takes only a touch that lands on a candidate of a list
  /// at rest while no system selection stands. The field's own tap clears a standing selection, and that is all this
  /// touch does.
  func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    guard let controller, let list = controller.collectionView else { return false }
    controller.cancelTranscriptFileOpen()
    // A touch on a moving list stops it; that is not a tap on what passes under the finger.
    guard !list.isDragging, !list.isDecelerating,
      controller.fileTapCandidate(at: touch.location(in: controller.view)) != nil
    else { return false }
    controller.fileChrome.touchedAt = touch.timestamp
    return true
  }

  /// The field keeps its own taps (a link, clearing a selection), and the list its scrolling.
  func gestureRecognizer(
    _ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    true
  }
}

extension SessionViewController {
  /// A touch held this long is a long press (the system's text selection), not a tap; the long press recognizer's
  /// default.
  static let fileTapLongPress: TimeInterval = 0.5

  /// `viewDidLoad`: the finger's tap recognizer on the list, which takes no touch from the views under it.
  func buildFileOpen() {
    let chrome = fileChrome
    let delegate = TranscriptFileTapDelegate(controller: self)
    chrome.delegate = delegate
    chrome.tap.addTarget(self, action: #selector(handleFileTap(_:)))
    chrome.tap.allowedTouchTypes = [
      NSNumber(value: UITouch.TouchType.direct.rawValue), NSNumber(value: UITouch.TouchType.pencil.rawValue),
    ]
    chrome.tap.cancelsTouchesInView = false
    chrome.tap.delaysTouchesEnded = false
    chrome.tap.delegate = delegate
    collectionView.addGestureRecognizer(chrome.tap)
    chrome.presenter.anchor = view
    buildFileHover()
  }

  @objc private func handleFileTap(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended else { return }
    let touchedAt = fileChrome.touchedAt
    fileChrome.touchedAt = nil
    if let touchedAt, ProcessInfo.processInfo.systemUptime - touchedAt >= Self.fileTapLongPress { return }
    guard !collectionView.isDragging, !collectionView.isDecelerating else { return }
    fileTap(at: recognizer.location(in: view))
  }

  /// The finger tap's decision and action by point (in the screen's view), without a touch event (the recognizer and
  /// tests): a candidate under it opens once the double tap window passed.
  func fileTap(at point: CGPoint) {
    guard let candidate = fileTapCandidate(at: point) else { return }
    openTranscriptFile(candidate)
  }

  /// The candidate under a finger at `point` (in the screen's view): on the text of a message row where a pointer
  /// press would start a selection (not a control, a table, a card or a queued bubble), while no system selection
  /// stands in a visible message.
  func fileTapCandidate(at point: CGPoint) -> String? {
    let listPoint = view.convert(point, to: collectionView)
    guard pointerPressStarts(at: listPoint) else { return nil }
    let contents = visibleMessageContents().map(\.content)
    guard !contents.contains(where: \.hasSystemSelection),
      let content = contents.first(where: { $0.convert($0.bounds, to: collectionView).contains(listPoint) })
    else { return nil }
    return transcriptFileCandidate(in: content, at: listPoint)
  }

  /// The session file the inline code under `point` (in the list) of `content` names; `nil` off inline code, on a
  /// link and for code that is no path of the session directory.
  func transcriptFileCandidate(in content: MessageContentView, at point: CGPoint) -> String? {
    guard let code = content.inlineCode(at: point, from: collectionView) else { return nil }
    return TranscriptFilePath.candidate(code, cwd: store.state.sessions[sessionId]?.cwd ?? "")
  }

  /// A click or tap on a candidate: it opens once the double click window passed, unless a new touch, a system
  /// selection, a scroll or leaving the screen ended it first.
  func openTranscriptFile(_ candidate: String) {
    fileChrome.pending?.cancel()
    fileChrome.pending = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(TerminalClickCounter.interval))
      guard !Task.isCancelled, let self else { return }
      self.fileChrome.pending = nil
      self.transcriptFileOpener().open(candidate: candidate)
    }
  }

  /// The waiting click or tap and the opener's open in flight end; a copy that still arrives is deleted. Every reason
  /// for that (a new touch or press, a system selection, a scroll, leaving the screen) also takes the hover's
  /// underline away.
  func cancelTranscriptFileOpen() {
    fileChrome.pending?.cancel()
    fileChrome.pending = nil
    fileChrome.opener?.cancel()
    clearFileHover()
  }

  /// The screen's one opener, made on the first click, tap or hover.
  func transcriptFileOpener() -> TranscriptFileOpener {
    if let opener = fileChrome.opener { return opener }
    let sessionId = sessionId
    let presenter = fileChrome.presenter
    let opener = TranscriptFileOpener(
      index: { [weak store] in await store?.sessionFileIndex(sessionId) ?? .unavailable },
      fetch: { [weak store] path, maxBytes in
        await store?.fetchSessionFile(sessionId, path: path, maxBytes: maxBytes) ?? .unavailable
      },
      present: { presenter.present($0) },
      notice: { NotificationCenter.default.post(name: .rarogAppNotice, object: $0) },
      trace: { [weak store] line in store?.trace(line) })
    fileChrome.opener = opener
    return opener
  }
}
#endif
