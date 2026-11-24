#if os(iOS)
import RarogCore
import UIKit

// The pointer's hover shows which inline code opens a file: over a run whose path resolves to a session file, the run
// gets a dotted underline and a view whose pointer interaction asks for a rounded rect around it
// (`MessageContentView+FileHover`); elsewhere nothing is added and the field's text beam stays. The decision is the
// click's (`+FileOpen`): the same run, the same "not over" rules (a link, a control, a table, a card, a queued bubble,
// an Inbox card) and the same opener, which answers from the index it keeps. Without
// an index the hover starts its load, and when it ends the decision runs again where the pointer is. The underline
// goes when the pointer leaves the run, the list scrolls, a press or a touch begins, or the row shows other text.
// Owner: transcript.

/// Delegate of the hover recognizer: it runs beside every other recognizer of the list and of the fields.
@MainActor
final class TranscriptFileHoverDelegate: NSObject, UIGestureRecognizerDelegate {
  func gestureRecognizer(
    _ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    true
  }
}

extension SessionViewController {
  /// `buildFileOpen()`: the hover recognizer on the list.
  func buildFileHover() {
    let chrome = fileChrome
    let delegate = TranscriptFileHoverDelegate()
    chrome.hoverDelegate = delegate
    chrome.hover.addTarget(self, action: #selector(handleFileHover(_:)))
    chrome.hover.delegate = delegate
    collectionView.addGestureRecognizer(chrome.hover)
  }

  @objc private func handleFileHover(_ recognizer: UIHoverGestureRecognizer) {
    switch recognizer.state {
    case .began, .changed: fileHover(at: recognizer.location(in: view))
    default: fileHover(at: nil)
    }
  }

  /// The hover's decision and action by point (in the screen's view), without a hover event (the recognizer and
  /// tests); `nil` = the pointer left the list.
  func fileHover(at point: CGPoint?) {
    fileChrome.hoverPoint = point
    guard let point, pointerChrome.gesture == nil, !collectionView.isDragging, !collectionView.isDecelerating else {
      return showFileHover(nil)
    }
    let listPoint = view.convert(point, to: collectionView)
    guard pointerPressStarts(at: listPoint),
      let content = visibleMessageContents().map(\.content)
        .first(where: { $0.convert($0.bounds, to: collectionView).contains(listPoint) }),
      let run = content.inlineCodeRun(at: listPoint, from: collectionView),
      let candidate = TranscriptFilePath.candidate(run.text, cwd: store.state.sessions[sessionId]?.cwd ?? "")
    else { return showFileHover(nil) }
    let answer = transcriptFileOpener().hover(candidate) { [weak self] in
      guard let self, let point = self.fileChrome.hoverPoint else { return }
      self.fileHover(at: point)
    }
    guard case .file = answer else { return showFileHover(nil) }
    showFileHover((content, run.range))
  }

  /// A scroll, a press, a touch or leaving the screen: the underline goes, and an index that arrives later does not
  /// bring it back until the pointer moves again.
  func clearFileHover() {
    fileChrome.hoverPoint = nil
    showFileHover(nil)
  }

  /// The underline on `run` of its row, and on no other row.
  private func showFileHover(_ run: (content: MessageContentView, range: NSRange)?) {
    if let shown = fileChrome.underlined, shown !== run?.content { shown.hideFileHover() }
    fileChrome.underlined = run?.content
    if let run { run.content.showFileHover(run.range) }
  }
}
#endif
