import RarogContract
@testable import RarogCore
@testable import RarogUI
import UIKit
import XCTest

/// The pointer selection on a real session screen, driven through the gesture hooks (`pointerDown(at:count:)`,
/// `pointerDrag(to:)`, `pointerUp(at:)`) and one autoscroll frame at a time (`pointerAutoscrollFrame(seconds:)`),
/// because XCTest in this target cannot synthesize a pointer touch: a drag across three messages and its copy, a drag
/// to the bottom edge that scrolls with the pointer still, a drag up while an answer streams that keeps the list off
/// the growing bottom and leaves it unpinned, the autoscroll clock that stops with the press, a press on the streaming
/// answer that closes under it, the controls of a row that keep their clicks, Cmd+C with a selection in the message
/// field, a drag that takes the character under the press either way and a click on a letter that selects nothing,
/// a word and a paragraph by double and triple click, a link click, the mutual clearing with the system
/// selection (also in a table), and the right click below a folded prompt. That a real click and drag reaches the
/// list's recognizer and Cmd+C copies: `TranscriptPointerSelectionUITests`. The selection model:
/// `TranscriptPointerSelectionTests` (RarogUI). Owner: transcript.
@MainActor
final class TranscriptPointerSelectionTests: XCTestCase {
  override func setUp() {
    super.setUp()
    // A gesture that scrolled keeps the reading place of `s1`; the next screen would return there.
    TranscriptMemory.positions = TranscriptPositionMemory()
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
  }

  // MARK: - Drag and copy

  func testDragAcrossThreeMessagesCopiesTheirText() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: [
      ("user", "Prompt one."), ("assistant", "Second reply text."), ("assistant", "Third reply text."),
      ("assistant", "Fourth reply text."),
    ])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let second = try Self.content("m2.0", in: controller)
    let fourth = try Self.content("m4.0", in: controller)
    controller.pointerDown(at: Self.point(second, offset: 7, in: controller.view), count: 1)
    XCTAssertNil(controller.pointerCopyText(), "a press alone selects nothing")
    controller.pointerDrag(to: Self.point(fourth, offset: 6, in: controller.view))
    controller.pointerUp(at: Self.point(fourth, offset: 6, in: controller.view))

    let expected = "reply text.\n\nThird reply text.\n\nFourth"
    XCTAssertEqual(controller.pointerCopyText(), expected)
    XCTAssertTrue(controller.canPerformAction(#selector(UIResponderStandardEditActions.copy(_:)), withSender: nil))
    let before = UIPasteboard.general.changeCount
    controller.copy(nil)
    XCTAssertGreaterThan(UIPasteboard.general.changeCount, before, "the copy went to the clipboard")
    XCTAssertEqual(controller.pointerChrome.lastCopy, expected)

    let third = try Self.content("m3.0", in: controller)
    XCTAssertEqual(second.pointerRange, NSRange(location: 7, length: second.textView.attributedText.length - 7))
    XCTAssertEqual(third.pointerRange, NSRange(location: 0, length: third.textView.attributedText.length))
    XCTAssertEqual(fourth.pointerRange, NSRange(location: 0, length: 6))
    XCTAssertFalse(third.pointerHighlight.isHidden, "the middle message is highlighted")
    XCTAssertNil(try Self.content("m1.0", in: controller).pointerRange, "the prompt above stays out")
  }

  func testDoubleClickSelectsWordAndTripleClickParagraph() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: [
      ("user", "Prompt one."), ("assistant", "First paragraph here.\n\nSecond paragraph there."),
    ])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let reply = try Self.content("m2.0", in: controller)
    let word = (reply.textView.text as NSString).range(of: "paragraph")
    let inside = Self.point(reply, offset: word.location + 2, in: controller.view)
    controller.pointerDown(at: inside, count: 2)
    controller.pointerUp(at: inside)
    XCTAssertEqual(controller.pointerCopyText(), "paragraph")
    controller.pointerDown(at: inside, count: 3)
    controller.pointerUp(at: inside)
    XCTAssertEqual(controller.pointerCopyText()?.trimmingCharacters(in: .whitespacesAndNewlines), "First paragraph here.")
  }

  func testClickWithoutMovementClearsSelectionAndOpensLink() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: [
      ("user", "Prompt one."), ("assistant", "Read [the guide](https://example.com/guide) first."),
    ])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    var opened: [URL] = []
    controller.pointerChrome.openURL = { opened.append($0) }
    let reply = try Self.content("m2.0", in: controller)
    controller.pointerDown(at: Self.point(reply, offset: 0, in: controller.view), count: 1)
    controller.pointerDrag(to: Self.point(reply, offset: 4, in: controller.view))
    controller.pointerUp(at: Self.point(reply, offset: 4, in: controller.view))
    XCTAssertEqual(controller.pointerCopyText(), "Read")

    let link = (reply.textView.text as NSString).range(of: "guide")
    let onLink = Self.point(reply, offset: link.location + 2, in: controller.view)
    controller.pointerDown(at: onLink, count: 1)
    controller.pointerUp(at: onLink)
    XCTAssertNil(controller.pointerCopyText(), "a click clears the selection")
    XCTAssertTrue(opened.isEmpty, "the link waits for the double click window")
    SessionToastTests.until { !opened.isEmpty }
    XCTAssertEqual(opened.map(\.host), ["example.com"])
  }

  // MARK: - The character under the press

  func testDragTakesTheCharacterUnderThePress() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: [
      ("user", "Prompt one."), ("assistant", "Select every word here."),
    ])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let reply = try Self.content("m2.0", in: controller)
    let list = try XCTUnwrap(controller.collectionView)
    let word = (reply.textView.text as NSString).range(of: "every")
    let wordStart = Self.point(reply, offset: word.location, in: controller.view)
    let wordEnd = Self.point(reply, offset: NSMaxRange(word), in: controller.view)
    let last = NSMaxRange(word) - 1
    // The closest caret of each press (`caret`) shows which side of the glyph it is on.
    let cases: [(name: String, glyph: Int, fraction: CGFloat, caret: Int, drag: CGPoint)] = [
      ("the right part of the first letter, dragged forward", word.location, 0.75, word.location + 1, wordEnd),
      ("the left part of the last letter, dragged backward", last, 0.25, last, wordStart),
      ("the right part of the last letter, dragged backward", last, 0.75, last + 1, wordStart),
      ("the right part of the space before the word, dragged forward", word.location - 1, 0.75, word.location, wordEnd),
    ]
    for item in cases {
      let press = Self.point(reply, glyph: item.glyph, at: item.fraction, in: controller.view)
      XCTAssertEqual(
        reply.pointerOffset(at: controller.view.convert(press, to: list), from: list), item.caret,
        "\(item.name): the closest caret of the press")
      controller.pointerDown(at: press, count: 1)
      controller.pointerDrag(to: item.drag)
      controller.pointerUp(at: item.drag)
      XCTAssertEqual(controller.pointerCopyText(), "every", item.name)
      // A pause past the double click window, so the next press is a single click again.
      SessionToastTests.spin(TerminalClickCounter.interval + 0.1)
    }
  }

  func testClickOnALetterSelectsNothing() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: [
      ("user", "Prompt one."), ("assistant", "Select every word here."),
    ])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let reply = try Self.content("m2.0", in: controller)
    let word = (reply.textView.text as NSString).range(of: "every")
    let press = Self.point(reply, glyph: word.location, at: 0.75, in: controller.view)
    controller.pointerDown(at: press, count: 1)
    controller.pointerDrag(to: CGPoint(x: press.x + SessionViewController.pointerDragSlop - 1, y: press.y))
    XCTAssertNil(controller.pointerCopyText(), "a move within the slop selects nothing")
    XCTAssertNil(reply.pointerRange, "and highlights nothing")
    controller.pointerUp(at: press)
    XCTAssertNil(controller.pointerCopyText(), "a click selects nothing")
    XCTAssertNil(reply.pointerRange)
  }

  // MARK: - Autoscroll

  func testDragToBottomEdgeScrollsWithPointerStill() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: Self.longTranscript(30))
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let list = try XCTUnwrap(controller.collectionView)
    controller.pointerChrome.displayLinkEnabled = false
    controller.pinned = false
    controller.setClampedOffset(-list.adjustedContentInset.top)
    list.layoutIfNeeded()
    let first = try Self.content("m1.0", in: controller)

    controller.pointerDown(at: Self.point(first, offset: 2, in: controller.view), count: 1)
    let bottom = list.frame.maxY - list.adjustedContentInset.bottom
    let still = CGPoint(x: first.convert(first.bounds, to: controller.view).midX, y: bottom + 60)
    controller.pointerDrag(to: still)
    XCTAssertGreaterThan(controller.pointerAutoscrollVelocity(), 0, "the pointer past the bottom edge scrolls down")
    let startOffset = list.contentOffset.y
    let startFocus = try Self.focusIndex(controller)
    for _ in 0..<10 { controller.pointerAutoscrollFrame(seconds: 0.05) }
    XCTAssertGreaterThan(list.contentOffset.y, startOffset + 1, "the list scrolled with the pointer still")
    XCTAssertGreaterThan(try Self.focusIndex(controller), startFocus, "the selection grew with the list")
    XCTAssertTrue(controller.collectionView.isUserScrolling, "the press holds the list like a finger")
    XCTAssertEqual(controller.pointerChrome.gesture?.frames, 10)

    controller.pointerUp(at: still)
    XCTAssertFalse(controller.collectionView.isUserScrolling)
    XCTAssertFalse(controller.pinned, "the list stopped far from the bottom")
    XCTAssertNotNil(controller.pointerCopyText())
    XCTAssertFalse(controller.pointerAutoscrollFrame(seconds: 0.05), "no frame after the release")
  }

  func testDragUpWhileAnswerStreamsLeavesListStillAfterRelease() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: Self.longTranscript(30))
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let list = try XCTUnwrap(controller.collectionView)
    controller.pointerChrome.displayLinkEnabled = false
    try Self.delta(store, "Streaming answer, first words.")
    SessionToastTests.until { controller.rows["open"] != nil }
    SessionToastTests.spin(0.2)
    list.layoutIfNeeded()
    XCTAssertTrue(controller.pinned, "the transcript follows the answer at the bottom")
    let reply = try Self.content("m30.0", in: controller)

    let start = Self.point(reply, offset: 3, in: controller.view)
    controller.pointerDown(at: start, count: 1)
    // Past the top edge of the list, so ten frames carry the list out of the pin zone (a pointer just inside the band
    // creeps and would leave the list pinned, which is right, but not this case).
    let top = CGPoint(x: start.x, y: list.frame.minY + list.adjustedContentInset.top - 20)
    controller.pointerDrag(to: top)
    XCTAssertLessThan(controller.pointerAutoscrollVelocity(), 0, "the pointer past the top edge scrolls up")
    let before = list.contentOffset.y
    controller.pointerAutoscrollFrame(seconds: 0.05)
    XCTAssertLessThan(list.contentOffset.y, before, "the first frame scrolled up")
    XCTAssertTrue(controller.pinned, "a first frame within the pin zone keeps the pin")

    // The answer grows while the press holds the still pinned list: the list does not go down to the new bottom.
    let held = list.contentOffset.y
    let heldHeight = list.contentSize.height
    let heldRenders = controller.readingChrome.counters.renders
    try Self.delta(store, "\n\nA new paragraph of the answer while the pointer holds the list.")
    SessionToastTests.until { controller.readingChrome.counters.renders > heldRenders }
    SessionToastTests.spin(0.2)
    list.layoutIfNeeded()
    XCTAssertGreaterThan(list.contentSize.height, heldHeight, "the answer grew under the press")
    XCTAssertEqual(list.contentOffset.y, held, accuracy: 0.5, "the press keeps the list off the new bottom")

    for _ in 0..<9 { controller.pointerAutoscrollFrame(seconds: 0.05) }
    XCTAssertLessThan(list.contentOffset.y, held, "the list scrolled up")
    XCTAssertGreaterThan(controller.distanceFromBottom(), SessionViewController.pinThreshold, "out of the pin zone")
    controller.pointerUp(at: top)
    XCTAssertFalse(controller.pinned, "the scroll up unpinned the transcript")
    XCTAssertNotNil(controller.pointerCopyText())

    let resting = list.contentOffset.y
    let renders = controller.readingChrome.counters.renders
    try Self.delta(store, " More words of the answer.")
    SessionToastTests.until { controller.readingChrome.counters.renders > renders }
    SessionToastTests.spin(0.3)
    list.layoutIfNeeded()
    XCTAssertEqual(list.contentOffset.y, resting, accuracy: 0.5, "a new delta leaves the list where it stands")
    XCTAssertNotNil(controller.pointerCopyText(), "the selection above the answer stays")
  }

  func testAutoscrollClockStopsOnCancelBackgroundAndLeavingTheSession() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: Self.longTranscript(30))
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let list = try XCTUnwrap(controller.collectionView)
    controller.pinned = false
    controller.setClampedOffset(-list.adjustedContentInset.top)
    list.layoutIfNeeded()
    let first = try Self.content("m1.0", in: controller)
    let press = Self.point(first, offset: 2, in: controller.view)
    let below = CGPoint(x: press.x, y: list.frame.maxY - list.adjustedContentInset.bottom + 60)
    // No run loop turn between the steps: the display link never ticks, so the list and the press point stay put.
    let exits: [(name: String, run: () -> Void)] = [
      ("cancel", { controller.pointerCancelled() }),
      ("background", { NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil) }),
      ("session change", {
        controller.beginAppearanceTransition(false, animated: false)
        controller.endAppearanceTransition()
      }),
    ]
    for exit in exits {
      controller.pointerDown(at: press, count: 1)
      controller.pointerDrag(to: below)
      XCTAssertNotNil(controller.pointerChrome.link, "\(exit.name): the clock runs with the pointer past the bottom edge")
      exit.run()
      XCTAssertNil(controller.pointerChrome.link, "\(exit.name): the clock stopped")
      XCTAssertNil(controller.pointerChrome.gesture, "\(exit.name): the press ended")
    }
  }

  // MARK: - The streaming answer closes under the press

  func testPressOnStreamingAnswerDragsFromItsMessageAfterTheAnswerClosed() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: [("user", "Prompt one."), ("assistant", "Reply two.")])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let answer = "Streaming answer, first words."
    try Self.delta(store, answer)
    SessionToastTests.until { controller.rows["open"] != nil }
    let open = try Self.content("open", in: controller)
    controller.pointerDown(at: Self.point(open, offset: 10, in: controller.view), count: 1)

    try Self.close(store, seq: 3, text: answer)
    SessionToastTests.until { controller.rows["open"] == nil && controller.rows["m3.0"] != nil }
    let closed = try Self.content("m3.0", in: controller)
    XCTAssertTrue(closed.textView.text.hasPrefix(answer), "the message starts with the answer's text")
    let end = Self.point(closed, offset: 23, in: controller.view)
    controller.pointerDrag(to: end)
    controller.pointerUp(at: end)
    XCTAssertEqual(controller.pointerCopyText(), "answer, first", "the drag runs from the press point in the message")
  }

  func testPressOnStreamingAnswerEndsWhenItsTextIsGone() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: [("user", "Prompt one."), ("assistant", "Reply two.")])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    try Self.delta(store, "Streaming answer, first words.")
    SessionToastTests.until { controller.rows["open"] != nil }
    let open = try Self.content("open", in: controller)
    controller.pointerDown(at: Self.point(open, offset: 10, in: controller.view), count: 1)
    XCTAssertTrue(controller.collectionView.isUserScrolling, "the press holds the list")

    try Self.close(store, seq: 3, text: "A different final text.")
    SessionToastTests.until { controller.rows["open"] == nil && controller.rows["m3.0"] != nil }
    XCTAssertNil(controller.pointerChrome.gesture, "the text under the press is gone, so the press ends")
    XCTAssertFalse(controller.collectionView.isUserScrolling, "the list is free again")
    let closed = try Self.content("m3.0", in: controller)
    controller.pointerDrag(to: Self.point(closed, offset: 12, in: controller.view))
    controller.pointerUp(at: Self.point(closed, offset: 12, in: controller.view))
    XCTAssertNil(controller.pointerCopyText(), "a drag after it selects nothing")
  }

  func testDoubleClickDragOnStreamingAnswerKeepsTheWordWhenTheAnswerCloses() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: [("user", "Prompt one."), ("assistant", "Reply two.")])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let answer = "Streaming answer with several words in it."
    let text = answer as NSString
    try Self.delta(store, answer)
    SessionToastTests.until { controller.rows["open"] != nil }
    let open = try Self.content("open", in: controller)
    controller.pointerDown(at: Self.point(open, offset: text.range(of: "several").location + 2, in: controller.view), count: 2)
    controller.pointerDrag(to: Self.point(open, offset: NSMaxRange(text.range(of: " in ")) - 1, in: controller.view))
    XCTAssertEqual(controller.pointerCopyText(), "several words in")

    try Self.close(store, seq: 3, text: answer)
    SessionToastTests.until { controller.rows["open"] == nil && controller.rows["m3.0"] != nil }
    XCTAssertEqual(controller.pointerCopyText(), "several words in", "the selection moved into the message")
    let closed = try Self.content("m3.0", in: controller)
    let back = Self.point(closed, offset: NSMaxRange(text.range(of: "words")), in: controller.view)
    controller.pointerDrag(to: back)
    controller.pointerUp(at: back)
    XCTAssertEqual(controller.pointerCopyText(), "several words", "the drag still extends from the double-clicked word")
  }

  // MARK: - Controls keep their clicks

  func testClicksOnFoldButtonCodeIconAndQueuedBubbleWorkAsToday() throws {
    let long = (1...24).map { "Line \($0) of a long prompt" }.joined(separator: "\n")
    let store = try TranscriptSelectionSheetTests.store(messages: [
      ("user", long), ("assistant", "Here is the code:\n\n```swift\nlet answer = 42\n```\n\nDone."),
    ])
    let entry = OutboxEntry(sessionId: "s1", text: "A queued follow-up", createdAt: Date())
    store.dispatch(.outboxEnqueued(entry))
    store.dispatch(.outboxQueued(entry.id, at: Date()))
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let list = try XCTUnwrap(controller.collectionView)
    SessionToastTests.until { controller.rows["o\(entry.id.uuidString)"] != nil }
    SessionToastTests.spin(0.2)
    controller.pinned = false
    controller.setClampedOffset(-list.adjustedContentInset.top)
    list.layoutIfNeeded()

    let prompt = try Self.content("m1.0", in: controller)
    XCTAssertFalse(prompt.foldButton.isHidden)
    let fold = prompt.convert(prompt.foldButton.center, to: list)
    XCTAssertFalse(controller.pointerPressStarts(at: fold), "Show All keeps its click")
    prompt.foldButton.sendActions(for: .primaryActionTriggered)
    SessionToastTests.until { controller.rows["m1.0"]?.turn.fold?.expanded == true }

    controller.setClampedOffset(list.contentSize.height)
    list.layoutIfNeeded()
    let code = try Self.content("m2.0", in: controller)
    let icon = try XCTUnwrap(code.codeButtons.first { !$0.isHidden }, "the copy icon of the code block")
    let iconPoint = code.convert(icon.center, to: list)
    XCTAssertTrue(list.hitTest(iconPoint, with: nil)?.isDescendant(of: icon) == true, "the click lands on the icon")
    XCTAssertFalse(controller.pointerPressStarts(at: iconPoint), "the code copy icon keeps its click")
    code.textView.recordTouchForTesting(.indirectPointer)
    XCTAssertFalse(code.textView.yieldsPointerPress(at: code.convert(icon.center, to: code.textView)))
    let text = Self.point(code, offset: 2, in: list)
    XCTAssertTrue(controller.pointerPressStarts(at: text), "the reply's text starts a selection")

    let bubble = try Self.content("o\(entry.id.uuidString)", in: controller)
    let onBubble = CGPoint(x: bubble.plateView.frame.minX + 8, y: bubble.plateView.frame.minY + 8)
    XCTAssertTrue(bubble.takesBackTap(at: onBubble))
    XCTAssertFalse(controller.pointerPressStarts(at: bubble.convert(onBubble, to: list)), "the queued bubble keeps its tap")
    controller.pointerDown(at: bubble.convert(onBubble, to: controller.view), count: 1)
    XCTAssertNil(controller.pointerChrome.gesture, "no selection gesture on the queued bubble")
  }

  // MARK: - Keyboard

  func testCommandCWithSelectionInMessageFieldCopiesTheField() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: [
      ("user", "Prompt one."), ("assistant", "Second reply text."),
    ])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    window.makeKeyAndVisible()
    let reply = try Self.content("m2.0", in: controller)
    controller.pointerDown(at: Self.point(reply, offset: 0, in: controller.view), count: 1)
    controller.pointerDrag(to: Self.point(reply, offset: 6, in: controller.view))
    controller.pointerUp(at: Self.point(reply, offset: 6, in: controller.view))
    XCTAssertEqual(controller.pointerCopyText(), "Second")

    let field = controller.composer.textView
    field.text = "typed words"
    XCTAssertTrue(field.becomeFirstResponder())
    field.selectedRange = NSRange(location: 0, length: 5)
    // Cmd+C goes to the first responder and up its chain to the first one that can copy (the test window has no
    // scene, so the system's own dispatch is replayed by `target(forAction:withSender:)`).
    let copy = #selector(UIResponderStandardEditActions.copy(_:))
    let before = UIPasteboard.general.changeCount
    let fieldTarget = field.target(forAction: copy, withSender: nil) as AnyObject?
    XCTAssertTrue(fieldTarget === field, "the field's selection wins over the transcript's")
    _ = fieldTarget?.perform(copy, with: nil)
    XCTAssertGreaterThan(UIPasteboard.general.changeCount, before, "the field copied its selection")
    XCTAssertNil(controller.pointerChrome.lastCopy)

    field.selectedRange = NSRange(location: 11, length: 0)
    let screenTarget = field.target(forAction: copy, withSender: nil) as AnyObject?
    XCTAssertTrue(screenTarget === controller, "without it Copy reaches the session screen")
    _ = screenTarget?.perform(copy, with: nil)
    XCTAssertEqual(controller.pointerChrome.lastCopy, "Second", "the transcript's selection is copied")
    XCTAssertTrue(field.isFirstResponder, "the keyboard stays in the message field")
  }

  // MARK: - Finger and system selection

  func testFingerDoesNotStartPointerSelection() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: [
      ("user", "Prompt one."), ("assistant", "Second reply text."),
    ])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let press = controller.pointerChrome.press
    XCTAssertEqual(press.allowedTouchTypes, [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)])
    XCTAssertEqual(press.minimumPressDuration, 0)
    XCTAssertTrue(press.view === controller.collectionView)
    let reply = try Self.content("m2.0", in: controller)
    let point = Self.point(reply, offset: 3, in: reply.textView)
    for type in [UITouch.TouchType.direct, .pencil] {
      reply.textView.recordTouchForTesting(type)
      XCTAssertFalse(reply.textView.yieldsPointerPress(at: point), "\(type.rawValue) keeps the system selection")
    }
    reply.textView.recordTouchForTesting(.indirectPointer)
    XCTAssertTrue(reply.textView.yieldsPointerPress(at: point), "the pointer gives the press to the list")
    reply.textView.recordTouchForTesting(.indirectPointer, buttons: .secondary)
    XCTAssertFalse(reply.textView.yieldsPointerPress(at: point), "a right click without a highlight stays the field's")
  }

  func testPointerAndSystemSelectionClearEachOther() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: [
      ("user", "Prompt one."), ("assistant", "Second reply text."), ("assistant", "Third reply text."),
    ])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let second = try Self.content("m2.0", in: controller)
    let third = try Self.content("m3.0", in: controller)
    third.textView.selectedRange = NSRange(location: 0, length: 5)
    controller.pointerDown(at: Self.point(second, offset: 0, in: controller.view), count: 1)
    XCTAssertEqual(third.textView.selectedRange.length, 0, "a pointer press clears the system selection")
    controller.pointerDrag(to: Self.point(second, offset: 6, in: controller.view))
    controller.pointerUp(at: Self.point(second, offset: 6, in: controller.view))
    XCTAssertNotNil(controller.pointerCopyText())

    // The right click menu on the highlight.
    let highlighted = Self.point(second, offset: 2, in: controller.collectionView)
    XCTAssertTrue(controller.pointerHighlightContains(highlighted))
    second.textView.recordTouchForTesting(.indirectPointer, buttons: .secondary)
    XCTAssertTrue(second.textView.yieldsPointerPress(at: Self.point(second, offset: 2, in: second.textView)))
    XCTAssertEqual(controller.pointerMenuActions().map(\.title), [UICopy.terminalCopy, UICopy.transcriptSelectMore])

    third.textView.selectedRange = NSRange(location: 0, length: 5)
    third.textViewDidChangeSelection(third.textView)
    XCTAssertNil(controller.pointerCopyText(), "a system selection clears the pointer selection")
    XCTAssertNil(second.pointerRange)
  }

  func testTableSelectionAndPointerSelectionClearEachOther() throws {
    let store = try TranscriptSelectionSheetTests.store(messages: [
      ("user", "Prompt one."), ("assistant", "| Name | Value |\n|---|---|\n| first | 1 |\n| second | 2 |"),
      ("assistant", "Third reply text."),
    ])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let row = try Self.content("m2.0", in: controller)
    var table: MarkdownTableView?
    SessionToastTests.until {
      table = TranscriptLeadingTests.views(of: MarkdownTableView.self, in: row).first
      return table != nil
    }
    let cells = try XCTUnwrap(table, "the table's view").textView
    let third = try Self.content("m3.0", in: controller)

    cells.selectedRange = NSRange(location: 0, length: 4)
    controller.pointerDown(at: Self.point(third, offset: 0, in: controller.view), count: 1)
    XCTAssertEqual(cells.selectedRange.length, 0, "a pointer press clears the selection in a table")
    controller.pointerDrag(to: Self.point(third, offset: 5, in: controller.view))
    controller.pointerUp(at: Self.point(third, offset: 5, in: controller.view))
    XCTAssertEqual(controller.pointerCopyText(), "Third")

    cells.selectedRange = NSRange(location: 0, length: 4)
    cells.delegate?.textViewDidChangeSelection?(cells)
    XCTAssertNil(controller.pointerCopyText(), "a selection in a table clears the pointer selection")
    XCTAssertNil(third.pointerRange)
  }

  func testRightClickBelowFoldedPromptMissesItsHiddenHighlight() throws {
    let long = (1...24).map { "Line \($0) of a long prompt" }.joined(separator: "\n")
    let store = try TranscriptSelectionSheetTests.store(messages: [("user", long), ("assistant", "Reply under the prompt.")])
    let (controller, window) = TranscriptSelectionSheetTests.host(store)
    defer { window.isHidden = true }
    let list = try XCTUnwrap(controller.collectionView)
    controller.pinned = false
    controller.setClampedOffset(-list.adjustedContentInset.top)
    list.layoutIfNeeded()
    let prompt = try Self.content("m1.0", in: controller)
    let reply = try Self.content("m2.0", in: controller)
    XCTAssertTrue(prompt.clipView.clipsToBounds, "the prompt is folded")
    controller.pointerDown(at: Self.point(prompt, offset: 0, in: controller.view), count: 1)
    controller.pointerDrag(to: Self.point(reply, offset: 0, in: controller.view))
    controller.pointerUp(at: Self.point(reply, offset: 0, in: controller.view))
    list.layoutIfNeeded()
    XCTAssertEqual(prompt.pointerRange, NSRange(location: 0, length: prompt.textView.attributedText.length))
    XCTAssertNil(reply.pointerRange, "the reply stays out")

    let line = (prompt.textView.text as NSString).range(of: "Line 10 ")
    let hidden = Self.point(prompt, offset: line.location + 2, in: list)
    XCTAssertGreaterThan(hidden.y, prompt.clipView.convert(prompt.clipView.bounds, to: list).maxY, "line 10 is folded away")
    let underHighlight = list.convert(hidden, to: prompt.pointerHighlight)
    XCTAssertTrue(prompt.pointerHighlight.rects.contains { $0.contains(underHighlight) }, "a highlight rect runs there")
    XCTAssertFalse(controller.pointerHighlightContains(hidden), "a right click below the fold opens no pointer menu")
    XCTAssertTrue(controller.pointerHighlightContains(Self.point(prompt, offset: 2, in: list)), "the visible part does")
  }

  // MARK: - Helpers

  /// Thirty-odd messages of several paragraphs: taller than the screen.
  private static func longTranscript(_ count: Int) -> [(role: String, text: String)] {
    (1...count).map { seq in
      let body = Array(repeating: "Paragraph of message \(seq) that wraps over a few lines in the window.", count: 3)
        .joined(separator: "\n\n")
      return (seq == 1 ? "user" : "assistant", body)
    }
  }

  private static func delta(_ store: RarogStore, _ text: String) throws {
    let encoded = String(decoding: try JSONEncoder().encode(text), as: UTF8.self)
    try SessionToastTests.frame(store, #"{"type":"delta","sessionId":"s1","text":\#(encoded)}"#, source: .session("s1"))
  }

  /// The streaming answer closes into the agent's message `seq` with `text`.
  private static func close(_ store: RarogStore, seq: Int, text: String) throws {
    let encoded = String(decoding: try JSONEncoder().encode(text), as: UTF8.self)
    let message = #"{"seq":\#(seq),"role":"assistant","at":"2026-10-06T10:30:00.000Z","blocks":[{"type":"text","text":\#(encoded)}]}"#
    try SessionToastTests.frame(store, #"{"type":"message","sessionId":"s1","message":\#(message)}"#, source: .session("s1"))
  }

  /// The row's content view once the list shows it.
  static func content(_ id: String, in controller: SessionViewController) throws -> MessageContentView {
    var found: MessageContentView?
    SessionToastTests.until {
      controller.view.layoutIfNeeded()
      guard let index = controller.dataSource.indexPath(for: id), let cell = controller.collectionView.cellForItem(at: index)
      else { return false }
      found = TranscriptLeadingTests.views(of: MessageContentView.self, in: cell).first
      return found != nil
    }
    return try XCTUnwrap(found, "row \(id) on screen")
  }

  /// The middle of the caret at `offset` in the row's text, in `view`.
  static func point(_ content: MessageContentView, offset: Int, in view: UIView) -> CGPoint {
    let field = content.textView
    guard let position = field.position(from: field.beginningOfDocument, offset: offset) else { return .zero }
    let caret = field.caretRect(for: position)
    return field.convert(CGPoint(x: caret.midX, y: caret.midY), to: view)
  }

  /// A point `fraction` of the way across the glyph of the character at `offset`, level with its middle, in `view`.
  private static func point(_ content: MessageContentView, glyph offset: Int, at fraction: CGFloat, in view: UIView)
    -> CGPoint
  {
    let field = content.textView
    guard let start = field.position(from: field.beginningOfDocument, offset: offset),
      let end = field.position(from: start, offset: 1), let range = field.textRange(from: start, to: end)
    else { return .zero }
    let box = field.firstRect(for: range)
    return field.convert(CGPoint(x: box.minX + box.width * fraction, y: box.midY), to: view)
  }

  /// The position of the selection's focus row among the rows.
  private static func focusIndex(_ controller: SessionViewController) throws -> Int {
    let selection = try XCTUnwrap(controller.pointerChrome.selection)
    return try XCTUnwrap(controller.pointerRows().firstIndex { $0.id == selection.focus.row })
  }
}
