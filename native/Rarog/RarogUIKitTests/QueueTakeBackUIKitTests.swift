import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

/// The queue take-back on a real `SessionViewController`: ↑ on an empty field with a queued bubble takes the queue
/// back, and keeps its meaning on a field with text, with the suggestion list open and without a queued bubble; a tap
/// on a queued bubble takes the queue back with the cursor after the tapped text, while "Show all" in that bubble
/// still expands it; VoiceOver has the action on the queued bubble only; a refusal leaves the bubbles and says why.
/// The bubbles and the `operationId` go only after the draft on disk took the texts, the answer goes to the screen of
/// the session that stands at answer time (taking a failed send's text that waits there into the field first), and a
/// kept take-back keeps the gestures on Not confirmed bubbles.
/// The text and cursor rules: `QueueTakeBackFieldTests` (RarogUI); the store: `StoreQueueTakeBackTests` (RarogCore).
/// Owner: send.
@MainActor
final class QueueTakeBackUIKitTests: XCTestCase {
  private typealias Fixture = CommandSuggestionsKeysTests.Fixture

  /// An entry accepted with a held echo: the queued bubble.
  @discardableResult
  private func queue(_ fixture: Fixture, _ text: String) -> OutboxEntry {
    let entry = OutboxEntry(sessionId: "s1", text: text, createdAt: Date())
    fixture.store.dispatch(.outboxEnqueued(entry))
    fixture.store.dispatch(.outboxQueued(entry.id, at: Date()))
    return entry
  }

  private func reply(_ items: [(String, OutboxEntry?)], incomplete: Bool = false) throws -> String {
    let list = try items.map { text, entry in
      let encoded = String(decoding: try JSONEncoder().encode(text), as: UTF8.self)
      return entry.map { #"{"text":\#(encoded),"clientMessageId":"\#($0.clientMessageId)"}"# } ?? #"{"text":\#(encoded)}"#
    }
    return #"{"items":[\#(list.joined(separator: ","))]\#(incomplete ? #","incomplete":true"# : "")}"#
  }

  /// The row's content view of a transcript row by its accessibility identifier, once the list shows it.
  private func messageView(_ fixture: Fixture, _ identifier: String) throws -> MessageContentView {
    var found: MessageContentView?
    fixture.wait("row \(identifier)") {
      fixture.controller.view.layoutIfNeeded()
      found = fixture.controller.collectionView.visibleCells
        .flatMap { TranscriptLeadingTests.views(of: MessageContentView.self, in: $0) }
        .first { $0.current.accessibilityIdentifier == identifier }
      return found != nil
    }
    return try XCTUnwrap(found)
  }

  private func hint(_ fixture: Fixture) -> UILabel? {
    TranscriptLeadingTests.views(of: UILabel.self, in: fixture.composer).first { $0.accessibilityIdentifier == "composer.hint" }
  }

  func testUpOnEmptyFieldTakesQueueBackWithCursorAtEnd() throws {
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    let first = queue(fixture, "A")
    let second = queue(fixture, "B")
    let body = try reply([("A", first), ("B", second)], incomplete: true)
    fixture.calls.record { $0.takeBackReply = .success(body) }
    _ = try messageView(fixture, "pending.\(first.id.uuidString)")
    XCTAssertEqual(fixture.composer.text, "")
    try fixture.press(.up)
    fixture.wait("texts in the field") { fixture.composer.text == "A\nB" }
    XCTAssertEqual(fixture.composer.textView.selectedRange, NSRange(location: 3, length: 0), "↑: cursor at the end")
    XCTAssertTrue(fixture.store.state.outbox.isEmpty, "the taken bubbles leave")
    XCTAssertEqual(fixture.calls.read(\.takeBacks).count, 1)
    XCTAssertEqual(hint(fixture)?.text, UICopy.queueTakeBackResult(.taken(try JSONDecoder().decode(
      QueueTakeBackResponse.self, from: Data(#"{"items":[],"incomplete":true}"#.utf8))))?.text,
      "part of the queue stayed in the terminal: a note under the field")
    XCTAssertFalse(fixture.can(.up), "no queued bubble left: ↑ goes back to the editor")
  }

  /// The bubble's view as the list shows it now, without waiting: the taking-back state must stand in the gesture's
  /// own turn, long before the server answers.
  private func shownBubble(_ fixture: Fixture, _ entry: OutboxEntry) -> MessageContentView? {
    fixture.controller.view.layoutIfNeeded()
    return fixture.controller.collectionView.visibleCells
      .flatMap { TranscriptLeadingTests.views(of: MessageContentView.self, in: $0) }
      .first { $0.current.accessibilityIdentifier == "pending.\(entry.id.uuidString)" }
  }

  /// Every queued bubble shows the take-back in flight: dimmed below a queued bubble, "Taking back…" under it, and
  /// the same in its VoiceOver label.
  private func assertTakingBack(_ fixture: Fixture, _ entries: [OutboxEntry], line: UInt = #line) throws {
    for entry in entries {
      let bubble = try XCTUnwrap(shownBubble(fixture, entry), line: line)
      XCTAssertTrue(bubble.current.takingBack, "the bubble is taking back", line: line)
      XCTAssertLessThan(bubble.alpha, MessageContentView.alpha(dimmed: true, takingBack: false), line: line)
      XCTAssertEqual(
        bubble.textView.accessibilityLabel?.hasPrefix(UICopy.takingBackRolePrefix), true,
        "VoiceOver hears the state: \(bubble.textView.accessibilityLabel ?? "")", line: line)
      XCTAssertEqual(
        fixture.controller.rows["s\(entry.id.uuidString)"],
        .pendingStatus(entry: entry.id, status: .takingBack, retrying: false), "the status under the bubble", line: line)
    }
  }

  func testUpShowsTakingBackAtOnceUntilTheTakenAnswer() throws {
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    var felt = 0
    fixture.controller.queueTakeBackFeedback = { felt += 1 }
    let first = queue(fixture, "A")
    let second = queue(fixture, "B")
    let body = try reply([("A", first), ("B", second)])
    fixture.calls.record {
      $0.takeBackReply = .success(body)
      $0.holdTakeBack = true
    }
    _ = try messageView(fixture, "pending.\(second.id.uuidString)")
    XCTAssertFalse(try XCTUnwrap(shownBubble(fixture, first)).current.takingBack)
    try fixture.press(.up)
    try assertTakingBack(fixture, [first, second])
    XCTAssertEqual(felt, 1, "one light tap for the gesture")
    try fixture.press(.up)
    XCTAssertEqual(felt, 1, "a gesture while one is in flight is ignored, without a tap")
    fixture.wait("request out") { fixture.calls.read(\.takeBacks).count == 1 }
    fixture.calls.record { $0.holdTakeBack = false }
    fixture.wait("texts in the field") { fixture.composer.text == "A\nB" }
    fixture.wait("bubbles gone") { self.shownBubble(fixture, first) == nil && self.shownBubble(fixture, second) == nil }
    XCTAssertFalse(fixture.controller.rows.values.contains { $0 == .pendingStatus(entry: first.id, status: .takingBack, retrying: false) })
    XCTAssertEqual(fixture.calls.read(\.takeBacks).count, 1)
  }

  func testTapShowsTakingBackAtOnceAndARefusalRestoresTheBubble() throws {
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    var felt = 0
    fixture.controller.queueTakeBackFeedback = { felt += 1 }
    let entry = queue(fixture, "A")
    let sentence = "A dialog stands in the terminal. Answer it, then take the queue back."
    fixture.calls.record {
      $0.takeBackReply = .failure(.http(APIFailure(status: 409, code: "bad-state", message: sentence)))
      $0.holdTakeBack = true
    }
    let bubble = try messageView(fixture, "pending.\(entry.id.uuidString)")
    let queuedAlpha = bubble.alpha
    let point = CGPoint(x: bubble.plateView.frame.minX + 8, y: bubble.plateView.frame.minY + 8)
    bubble.takeBackTap(at: point)
    try assertTakingBack(fixture, [entry])
    XCTAssertEqual(felt, 1)
    try XCTUnwrap(shownBubble(fixture, entry)).takeBackTap(at: point)
    XCTAssertEqual(felt, 1, "a second tap in flight is ignored, without a tap")
    fixture.wait("request out") { fixture.calls.read(\.takeBacks).count == 1 }
    fixture.calls.record { $0.holdTakeBack = false }
    fixture.wait("refusal under the field") { self.hint(fixture)?.text == sentence }
    fixture.wait("bubble back") { self.shownBubble(fixture, entry)?.current.takingBack == false }
    let back = try XCTUnwrap(shownBubble(fixture, entry))
    XCTAssertEqual(back.alpha, queuedAlpha, "as before the gesture")
    XCTAssertEqual(back.textView.accessibilityLabel?.hasPrefix(UICopy.queuedRolePrefix), true)
    XCTAssertNil(fixture.controller.rows["s\(entry.id.uuidString)"], "no status row under a queued bubble")
    XCTAssertEqual(fixture.store.state.outbox.map(\.id), [entry.id], "the bubble stays")
  }

  func testUpKeepsItsMeaningWithTextOpenListOrNoQueuedBubble() throws {
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    XCTAssertFalse(fixture.can(.up), "no queued bubble")
    queue(fixture, "A")
    XCTAssertTrue(fixture.can(.up), "empty field with a queued bubble")
    fixture.composer.textView.insertText("hej")
    XCTAssertFalse(fixture.can(.up), "a field with text keeps ↑ for the cursor")
    fixture.composer.text = ""
    try fixture.type("/c")
    try fixture.press(.down)
    try fixture.press(.up)
    XCTAssertTrue(fixture.composer.commandSuggestionsOpen, "↑ moved the selection in the list")
    XCTAssertEqual(fixture.composer.text, "/c")
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    XCTAssertEqual(fixture.calls.read(\.takeBacks), [], "an open list keeps ↑")
  }

  func testTapOnQueuedBubbleTakesBackAndShowAllStillExpands() throws {
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    let long = (1...24).map { "Line \($0) of a long queued prompt" }.joined(separator: "\n")
    let first = queue(fixture, "Fix 👩‍💻 first")
    let second = queue(fixture, long)
    let body = try reply([("Fix 👩‍💻 first", first), (long, second), ("Typed at the Mac", nil)])
    fixture.calls.record { $0.takeBackReply = .success(body) }
    fixture.composer.text = "draft"

    let bubble = try messageView(fixture, "pending.\(second.id.uuidString)")
    XCTAssertEqual(bubble.textView.accessibilityCustomActions?.map(\.name), [UICopy.queuedTakeBackAction])
    let reply = try messageView(fixture, "message.m1.0")
    XCTAssertNil(reply.textView.accessibilityCustomActions, "an agent reply has no take-back")
    XCTAssertFalse(reply.takeBackTap.isEnabled)

    // "Show all" in the queued bubble expands it and takes nothing back.
    XCTAssertFalse(bubble.foldButton.isHidden)
    XCTAssertFalse(bubble.takesBackTap(at: bubble.foldButton.center), "the fold control is not part of the tap")
    bubble.takeBackTap(at: bubble.foldButton.center)
    bubble.foldButton.sendActions(for: .primaryActionTriggered)
    fixture.wait("expanded") { fixture.controller.rows["o\(second.id.uuidString)"]?.turn.fold?.expanded == true }
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    XCTAssertEqual(fixture.calls.read(\.takeBacks), [], "Show all sends nothing")

    // A tap on the first (higher) bubble: everything comes back, the cursor after its text.
    let higher = try messageView(fixture, "pending.\(first.id.uuidString)")
    let point = CGPoint(x: higher.plateView.frame.minX + 8, y: higher.plateView.frame.minY + 8)
    XCTAssertTrue(higher.takesBackTap(at: point))
    // A finger there reaches the bubble's row (its text or padding), where the take-back recognizer listens; the
    // recognizer itself needs a real touch, which XCTest in this target cannot synthesize.
    let hit = fixture.window.hitTest(higher.convert(point, to: nil), with: nil)
    XCTAssertTrue(hit?.isDescendant(of: higher) == true, "the tap point lands in the bubble: \(String(describing: hit))")
    XCTAssertTrue(higher.takeBackTap.isEnabled)
    higher.takeBackTap(at: point)
    let expected = "Fix 👩‍💻 first\n\(long)\nTyped at the Mac\ndraft"
    fixture.wait("texts before the draft") { fixture.composer.text == expected }
    XCTAssertEqual(fixture.composer.textView.selectedRange.location, ("Fix 👩‍💻 first" as NSString).length)
    XCTAssertTrue(fixture.composer.textView.isFirstResponder)
    XCTAssertTrue(fixture.store.state.outbox.isEmpty)
  }

  func testRefusalLeavesBubblesAndSaysWhy() throws {
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    let entry = queue(fixture, "A")
    let sentence = "A dialog stands in the terminal. Answer it, then take the queue back."
    fixture.calls.record {
      $0.takeBackReply = .failure(.http(APIFailure(status: 409, code: "bad-state", message: sentence)))
    }
    try fixture.press(.up)
    fixture.wait("refusal under the field") { self.hint(fixture)?.text == sentence }
    XCTAssertEqual(fixture.composer.text, "")
    XCTAssertEqual(fixture.store.state.outbox.map(\.id), [entry.id], "the bubble stays")
  }

  /// A refusal on a disabled field (a standing decision, the bubble still takes a tap) is heard, not lost.
  func testRefusalOnDisabledFieldIsAnnounced() throws {
    let said = DecisionDockTests.Said()
    let fixture = try Fixture(
      state: "waiting-permission", announcer: Announcer(sink: { said.items.append($0) }, now: Date.init))
    defer { fixture.close() }
    let entry = queue(fixture, "A")
    let sentence = "A dialog stands in the terminal. Answer it, then take the queue back."
    fixture.calls.record {
      $0.takeBackReply = .failure(.http(APIFailure(status: 409, code: "bad-state", message: sentence)))
    }
    XCTAssertFalse(fixture.composer.isEditable, "the decision disables the field")
    let bubble = try messageView(fixture, "pending.\(entry.id.uuidString)")
    bubble.takeBackTap(at: CGPoint(x: bubble.plateView.frame.minX + 8, y: bubble.plateView.frame.minY + 8))
    fixture.wait("refusal announced") { said.items.contains { $0.text == sentence && $0.priority == .urgent } }
    XCTAssertEqual(fixture.store.state.outbox.map(\.id), [entry.id], "the bubble stays")
  }

  /// The texts reach the durable draft before the bubbles leave; an answer after the screen closed lands in the
  /// session's draft.
  func testTakenTextsReachDraftAlsoAfterScreenCloses() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "queue-take-back-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let drafts = ComposerDrafts(directory: directory)
    let fixture = try Fixture(state: "running", drafts: drafts)
    defer { fixture.close() }
    let first = queue(fixture, "A")
    let second = queue(fixture, "B")
    let body = try reply([("A", first), ("B", second)])
    fixture.calls.record { $0.takeBackReply = .success(body) }
    try fixture.press(.up)
    fixture.wait("bubbles gone") { fixture.store.state.outbox.isEmpty }
    drafts.flush()
    XCTAssertEqual(drafts.take(for: "s1")?.text, "A\nB", "the live field went to the draft on disk")

    let late = queue(fixture, "C")
    let lateBody = try reply([("C", late)])
    fixture.composer.text = ""
    fixture.calls.record {
      $0.takeBackReply = .success(lateBody)
      $0.holdTakeBack = true
    }
    try fixture.press(.up)
    fixture.wait("request out") { fixture.calls.read(\.takeBacks).count == 2 }
    fixture.window.rootViewController = nil
    fixture.calls.record { $0.holdTakeBack = false }
    fixture.wait("late bubble gone") { fixture.store.state.outbox.isEmpty }
    XCTAssertEqual(drafts.take(for: "s1")?.text.hasPrefix("C"), true, "a closed screen hands the texts to the draft")
  }

  /// The bubbles leave and the id goes only once the draft on disk took the texts: a refused write keeps both, so the
  /// next gesture replays the same `operationId` and the texts reach the field once.
  func testRefusedDraftWriteKeepsBubblesAndOperation() throws {
    let manager = FileManager.default
    let directory = manager.temporaryDirectory.appending(path: "queue-take-back-\(UUID().uuidString)")
    defer { try? manager.removeItem(at: directory) }
    let drafts = ComposerDrafts(directory: directory)
    let fixture = try Fixture(state: "running", drafts: drafts)
    defer { fixture.close() }
    let entry = queue(fixture, "A")
    let body = try reply([("A", entry)])
    fixture.calls.record { $0.takeBackReply = .success(body) }
    drafts.flush()
    try manager.setAttributes([.posixPermissions: 0o555], ofItemAtPath: directory.path)
    defer { try? manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path) }
    try fixture.press(.up)
    fixture.wait("answer settled") {
      fixture.calls.read(\.takeBacks).count == 1 && !fixture.store.state.isTakingBackQueue("s1")
    }
    XCTAssertEqual(fixture.store.state.outbox.map(\.id), [entry.id], "the disk refused the draft: the bubble stays")
    XCTAssertEqual(fixture.store.state.queueTakeBack.operations["s1"], fixture.calls.read(\.takeBacks).first)
    XCTAssertEqual(fixture.composer.text, "", "the field goes back, so the replay does not bring the texts twice")
    fixture.wait("sentence under the field") { self.hint(fixture)?.text == UICopy.queueTakeBackResult(.notSaved)?.text }

    try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
    try fixture.press(.up)
    fixture.wait("bubble gone") { fixture.store.state.outbox.isEmpty }
    XCTAssertEqual(fixture.composer.text, "A")
    let ids = fixture.calls.read(\.takeBacks)
    XCTAssertEqual(ids.count, 2)
    XCTAssertEqual(ids.first, ids.last, "the replay carries the kept id")
    XCTAssertTrue(fixture.store.state.queueTakeBack.operations.isEmpty)
    drafts.flush()
    XCTAssertEqual(drafts.take(for: "s1")?.text, "A")
  }

  /// The same after the screen left the window: a refused write keeps bubble and id, and the replay from that screen
  /// brings the texts to the draft once. (With no screen of the session alive the texts go on top of the stored draft:
  /// `DraftPersistenceTests`.)
  func testRefusedDraftWriteAfterScreenClosedKeepsBubblesAndOperation() throws {
    let manager = FileManager.default
    let directory = manager.temporaryDirectory.appending(path: "queue-take-back-\(UUID().uuidString)")
    defer { try? manager.removeItem(at: directory) }
    let drafts = ComposerDrafts(directory: directory)
    let fixture = try Fixture(state: "running", drafts: drafts)
    defer { fixture.close() }
    let entry = queue(fixture, "A")
    let body = try reply([("A", entry)])
    fixture.calls.record {
      $0.takeBackReply = .success(body)
      $0.holdTakeBack = true
    }
    try fixture.press(.up)
    fixture.wait("request out") { fixture.calls.read(\.takeBacks).count == 1 }
    fixture.window.rootViewController = nil
    drafts.flush()
    try manager.setAttributes([.posixPermissions: 0o555], ofItemAtPath: directory.path)
    defer { try? manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path) }
    fixture.calls.record { $0.holdTakeBack = false }
    fixture.wait("answer settled") { !fixture.store.state.isTakingBackQueue("s1") }
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    XCTAssertEqual(fixture.store.state.outbox.map(\.id), [entry.id], "the disk refused the draft: the bubble stays")
    XCTAssertEqual(fixture.store.state.queueTakeBack.operations["s1"], fixture.calls.read(\.takeBacks).first)

    try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
    fixture.controller.takeBackQueue(tapped: nil)
    fixture.wait("bubble gone") { fixture.store.state.outbox.isEmpty }
    let ids = fixture.calls.read(\.takeBacks)
    XCTAssertEqual(ids.count, 2)
    XCTAssertEqual(ids.first, ids.last, "the replay carries the kept id")
    XCTAssertEqual(drafts.take(for: "s1")?.text, "A", "the texts stand in the stored draft once")
  }

  /// Field "s", a tap on the queued bubble, the screen closes and the session opens again before the answer: the
  /// answer goes to the screen that stands now, merged once with its live field.
  func testAnswerAfterReopenGoesToTheNewScreenOnce() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "queue-take-back-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let drafts = ComposerDrafts(directory: directory)
    let fixture = try Fixture(state: "running", drafts: drafts)
    defer { fixture.close() }
    let entry = queue(fixture, "A")
    let body = try reply([("A", entry)])
    fixture.calls.record {
      $0.takeBackReply = .success(body)
      $0.holdTakeBack = true
    }
    fixture.composer.text = "s"
    let bubble = try messageView(fixture, "pending.\(entry.id.uuidString)")
    bubble.takeBackTap(at: CGPoint(x: bubble.plateView.frame.minX + 8, y: bubble.plateView.frame.minY + 8))
    fixture.wait("request out") { fixture.calls.read(\.takeBacks).count == 1 }

    fixture.window.rootViewController = nil
    let reopened = SessionViewController(store: fixture.store, sessionId: "s1", drafts: drafts)
    fixture.window.rootViewController = reopened
    reopened.view.layoutIfNeeded()
    XCTAssertEqual(reopened.composer.text, "s", "the new screen restores the draft")
    fixture.calls.record { $0.holdTakeBack = false }
    fixture.wait("bubble gone") { fixture.store.state.outbox.isEmpty }
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    XCTAssertEqual(reopened.composer.text, "A\ns", "the texts once, before the live field")
    XCTAssertEqual(fixture.composer.text, "s", "the closed screen's field stays as it was")
    drafts.flush()
    XCTAssertEqual(drafts.take(for: "s1")?.text, "A\ns")
  }

  /// The answer lands while a full-screen presentation covers the session screen (out of the window, alive): the
  /// texts go to its live field, because that field writes the session's draft next; the stored draft alone would be
  /// overwritten by the first edit after the screen comes back.
  func testAnswerWhileScreenIsCoveredReachesItsField() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "queue-take-back-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let drafts = ComposerDrafts(directory: directory)
    let fixture = try Fixture(state: "running", drafts: drafts)
    defer { fixture.close() }
    let entry = queue(fixture, "A")
    let body = try reply([("A", entry)])
    fixture.calls.record {
      $0.takeBackReply = .success(body)
      $0.holdTakeBack = true
    }
    try fixture.press(.up)
    fixture.wait("request out") { fixture.calls.read(\.takeBacks).count == 1 }
    // Out of the window and back without a new `viewDidLoad`, as under a full-screen presentation.
    fixture.window.rootViewController = UIViewController()
    fixture.wait("screen covered") { fixture.controller.view.window == nil }
    fixture.calls.record { $0.holdTakeBack = false }
    fixture.wait("bubble gone") { fixture.store.state.outbox.isEmpty }
    fixture.window.rootViewController = fixture.controller
    fixture.wait("screen back") { fixture.controller.view.window != nil }
    fixture.composer.textView.insertText("x")
    RunLoop.main.run(until: Date().addingTimeInterval(0.6))
    drafts.flush()
    XCTAssertTrue(fixture.composer.text.hasPrefix("A"), "the texts stand in the field: \(fixture.composer.text)")
    XCTAssertEqual(drafts.take(for: "s1")?.text, fixture.composer.text, "and the field's next write keeps them")
  }

  /// A send that failed under the presentation left its text waiting in the draft store's memory: the answer takes it
  /// into the covered screen's field before the taken texts go before the field's text, so the write that replaces the
  /// draft keeps both, each once, and the session opened again shows the same.
  func testAnswerWhileScreenIsCoveredKeepsAFailedSendThatWaitsInMemory() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "queue-take-back-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let drafts = ComposerDrafts(directory: directory)
    let fixture = try Fixture(state: "running", drafts: drafts)
    defer { fixture.close() }
    let entry = queue(fixture, "A")
    let body = try reply([("A", entry)])
    fixture.calls.record {
      $0.takeBackReply = .success(body)
      $0.holdTakeBack = true
    }
    try fixture.press(.up)
    fixture.wait("request out") { fixture.calls.read(\.takeBacks).count == 1 }
    try fixture.failSendUnderCover("B")
    fixture.calls.record { $0.holdTakeBack = false }
    fixture.wait("bubble gone") { fixture.store.state.outbox.isEmpty }
    XCTAssertEqual(fixture.composer.text, "A\nB", "the taken text before the failed one, each once")
    XCTAssertEqual(hint(fixture)?.text, UICopy.notPersisted, "with the reason the failed text came back")
    drafts.flush()
    XCTAssertEqual(ComposerDrafts(directory: directory).take(for: "s1")?.text, "A\nB", "the same on disk")
    let reopened = SessionViewController(store: fixture.store, sessionId: "s1", drafts: drafts)
    fixture.window.rootViewController = reopened
    reopened.view.layoutIfNeeded()
    XCTAssertEqual(reopened.composer.text, "A\nB", "the session opened again restores it")
  }

  /// Without a failed send waiting, the field's own copy on disk is no text to take: the answer merges the taken text
  /// once with the covered screen's field.
  func testAnswerWhileScreenIsCoveredMergesOnceWithTheFieldsStoredCopy() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "queue-take-back-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let drafts = ComposerDrafts(directory: directory)
    let fixture = try Fixture(state: "running", drafts: drafts)
    defer { fixture.close() }
    let entry = queue(fixture, "A")
    let body = try reply([("A", entry)])
    fixture.calls.record {
      $0.takeBackReply = .success(body)
      $0.holdTakeBack = true
    }
    try fixture.press(.up)
    fixture.wait("request out") { fixture.calls.read(\.takeBacks).count == 1 }
    fixture.composer.textView.insertText("s")
    fixture.window.rootViewController = UIViewController()
    fixture.wait("the field's copy on disk") {
      drafts.flush()
      return drafts.take(for: "s1")?.text == "s"
    }
    fixture.calls.record { $0.holdTakeBack = false }
    fixture.wait("bubble gone") { fixture.store.state.outbox.isEmpty }
    XCTAssertEqual(fixture.composer.text, "A\ns")
    drafts.flush()
    XCTAssertEqual(ComposerDrafts(directory: directory).take(for: "s1")?.text, "A\ns")
  }

  /// A take-back without an answer keeps its id; once the bubble turned Not confirmed (15 s idle), ↑ on the empty
  /// field, the bubble's tap and its VoiceOver action still replay it.
  func testUnresolvedTakeBackKeepsGesturesOnNotConfirmedBubble() throws {
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    let entry = OutboxEntry(sessionId: "s1", text: "A", createdAt: Date())
    fixture.store.dispatch(.outboxEnqueued(entry))
    // Accepted an hour ago: the ceiling check below turns the bubble Not confirmed, as 15 s of idle would.
    fixture.store.dispatch(.outboxQueued(entry.id, at: Date(timeIntervalSinceNow: -3600)))
    fixture.calls.record { $0.takeBackReply = .failure(.timedOut) }
    try fixture.press(.up)
    fixture.wait("no answer after the retry") {
      fixture.calls.read(\.takeBacks).count == 2 && !fixture.store.state.isTakingBackQueue("s1")
    }
    let kept = try XCTUnwrap(fixture.store.state.queueTakeBack.operations["s1"])
    fixture.store.dispatch(.outboxUnconfirmedIfQueued(entry.id))
    XCTAssertEqual(fixture.store.state.outbox.first?.state, .unconfirmed)
    fixture.controller.view.layoutIfNeeded()
    XCTAssertTrue(fixture.can(.up), "↑ on the empty field replays the kept take-back")

    var bubble: MessageContentView?
    // The cell shows the Not confirmed state (no shimmer) before its actions count.
    fixture.wait("Not confirmed bubble on screen") {
      fixture.controller.view.layoutIfNeeded()
      bubble = fixture.controller.collectionView.visibleCells
        .flatMap { TranscriptLeadingTests.views(of: MessageContentView.self, in: $0) }
        .first { $0.current.accessibilityIdentifier == "pending.\(entry.id.uuidString)" && !$0.current.inFlight }
      return bubble != nil
    }
    let notConfirmed = try XCTUnwrap(bubble)
    XCTAssertTrue(notConfirmed.takeBackTap.isEnabled, "the tap replays the kept take-back")
    XCTAssertEqual(notConfirmed.textView.accessibilityCustomActions?.map(\.name), [UICopy.queuedTakeBackAction])
    let body = try reply([("A", entry)])
    fixture.calls.record { $0.takeBackReply = .success(body) }
    notConfirmed.takeBackTap(
      at: CGPoint(x: notConfirmed.plateView.frame.minX + 8, y: notConfirmed.plateView.frame.minY + 8))
    fixture.wait("texts in the field") { fixture.composer.text == "A" }
    XCTAssertEqual(Set(fixture.calls.read(\.takeBacks)), [kept], "every request carries the kept id")
    XCTAssertTrue(fixture.store.state.outbox.isEmpty)
    XCTAssertTrue(fixture.store.state.queueTakeBack.operations.isEmpty)
  }

  /// One iPhone screenshot of the field with taken texts, for review of the look.
  func testLookTakenTexts() throws {
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    let first = queue(fixture, "Also check the log parser")
    let second = queue(fixture, "Then run the notes tests 🧪")
    let body = try reply([("Also check the log parser", first), ("Then run the notes tests 🧪", second)])
    fixture.calls.record { $0.takeBackReply = .success(body) }
    _ = try messageView(fixture, "pending.\(first.id.uuidString)")
    try fixture.press(.up)
    fixture.wait("texts in the field") { fixture.store.state.outbox.isEmpty }
    fixture.controller.view.layoutIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    let bounds = fixture.window.bounds
    let format = UIGraphicsImageRendererFormat()
    format.scale = 3
    let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { context in
      fixture.window.layer.render(in: context.cgContext)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = "queue-take-back-field"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// One iPhone screenshot of queued bubbles while the take-back waits for the answer, for review of the look.
  func testLookTakingBack() throws {
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    let first = queue(fixture, "Also check the log parser")
    let second = queue(fixture, "Then run the notes tests 🧪")
    let body = try reply([("Also check the log parser", first), ("Then run the notes tests 🧪", second)])
    fixture.calls.record {
      $0.takeBackReply = .success(body)
      $0.holdTakeBack = true
    }
    _ = try messageView(fixture, "pending.\(second.id.uuidString)")
    try fixture.press(.up)
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    fixture.controller.view.layoutIfNeeded()
    let format = UIGraphicsImageRendererFormat()
    format.scale = 3
    let list = try XCTUnwrap(fixture.controller.collectionView)
    let image = UIGraphicsImageRenderer(bounds: fixture.window.bounds, format: format).image { context in
      fixture.window.layer.render(in: context.cgContext)
      // The window's layer render leaves the list's cells out in this process (a blank transcript), so each visible
      // cell is drawn on top at its place.
      for cell in list.visibleCells {
        let origin = cell.convert(CGPoint.zero, to: fixture.window)
        context.cgContext.saveGState()
        context.cgContext.translateBy(x: origin.x, y: origin.y)
        cell.layer.render(in: context.cgContext)
        context.cgContext.restoreGState()
      }
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = "queue-take-back-taking-back"
    attachment.lifetime = .keepAlways
    add(attachment)
    fixture.calls.record { $0.holdTakeBack = false }
    fixture.wait("bubbles gone") { fixture.store.state.outbox.isEmpty }
  }
}
