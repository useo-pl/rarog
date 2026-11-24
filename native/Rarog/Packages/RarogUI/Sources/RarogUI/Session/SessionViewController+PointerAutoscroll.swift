#if os(iOS)
import UIKit

// The list scrolls by itself while a pointer selection is dragged near or past its top or bottom edge, faster the
// farther the pointer is (``TranscriptPointerSelection/autoscrollVelocity(pointer:top:bottom:)``), and the selection
// grows with it every frame, also with the pointer still. The frames run on a display link and stop at the end of the
// content, on release or cancel, on leaving the session and on going to the background (`+PointerSelection`). The
// press holds the list like a finger (`PinnedCollectionView.pointerScrolling`), so the pin follows the scrolled place.
// Owner: transcript.
extension SessionViewController {
  /// The autoscroll speed for the last pointer location: negative toward the top of the content, 0 outside both bands.
  func pointerAutoscrollVelocity() -> CGFloat {
    guard let gesture = pointerChrome.gesture, gesture.selecting, let list = collectionView else { return 0 }
    let frame = list.frame
    let inset = list.adjustedContentInset
    return TranscriptPointerSelection.autoscrollVelocity(
      pointer: gesture.pointer.y, top: frame.minY + inset.top, bottom: frame.maxY - inset.bottom)
  }

  /// After the pointer moved: the frame clock runs while the pointer is in a band, and stops outside them.
  func updatePointerAutoscroll() {
    guard pointerAutoscrollVelocity() != 0 else {
      stopPointerAutoscroll()
      return
    }
    guard pointerChrome.displayLinkEnabled, pointerChrome.link == nil else { return }
    let link = CADisplayLink(target: PointerAutoscrollTicker(controller: self), selector: #selector(PointerAutoscrollTicker.tick(_:)))
    link.add(to: .main, forMode: .common)
    pointerChrome.link = link
    pointerChrome.lastFrame = nil
  }

  func stopPointerAutoscroll() {
    pointerChrome.link?.invalidate()
    pointerChrome.link = nil
    pointerChrome.lastFrame = nil
  }

  /// One autoscroll frame `seconds` after the previous one: the list moves by speed × time (at most a tenth of a
  /// second's worth after a stall), then the focus is resolved again under the still pointer. `false` = nothing moved:
  /// the pointer left the bands or the content ends there, and the clock stops.
  @discardableResult
  func pointerAutoscrollFrame(seconds: CFTimeInterval) -> Bool {
    let velocity = pointerAutoscrollVelocity()
    guard velocity != 0, seconds > 0, let list = collectionView else {
      stopPointerAutoscroll()
      return false
    }
    let inset = list.adjustedContentInset
    let minY = -inset.top
    let maxY = max(minY, list.contentSize.height + inset.bottom - list.bounds.height)
    let current = list.contentOffset.y
    let target = min(max(current + velocity * CGFloat(min(seconds, 0.1)), minY), maxY)
    guard abs(target - current) > 0.01 else {
      stopPointerAutoscroll()
      return false
    }
    list.setContentOffset(CGPoint(x: list.contentOffset.x, y: target), animated: false)
    list.layoutIfNeeded()
    pointerChrome.gesture?.frames += 1
    extendPointerSelection()
    return true
  }

  fileprivate func pointerAutoscrollTick(_ timestamp: CFTimeInterval) {
    let previous = pointerChrome.lastFrame ?? timestamp - 1.0 / 60
    pointerChrome.lastFrame = timestamp
    pointerAutoscrollFrame(seconds: timestamp - previous)
  }
}

/// The display link's target: it holds the screen weakly (a display link retains its target).
@MainActor
private final class PointerAutoscrollTicker: NSObject {
  weak var controller: SessionViewController?

  init(controller: SessionViewController) {
    self.controller = controller
  }

  @objc func tick(_ link: CADisplayLink) {
    guard let controller else {
      link.invalidate()
      return
    }
    controller.pointerAutoscrollTick(link.timestamp)
  }
}
#endif
