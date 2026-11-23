import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest


// The stop in the center of the progress ring on a real `SessionViewController`: the stop target takes
// the touch over the dimming of the thumbnail (`PendingOverlay` does not take touches), ends the request in flight
// before its first byte and leaves the entry "Sending stopped" with Retry, and the field stays empty. The rules
// without a view have package tests (`StoreSendCancelTests`, `PendingMediaTests`, `SendRecoveryTests`).
// Owner: send.

@MainActor
final class PendingMediaStopTests: XCTestCase {
  /// A photo with text is sent; while the transport holds the request before its first byte, the stop over the
  /// decoded thumbnail takes the touch (and only there: a corner of the dimmed photo does not), the transport sees the
  /// cancellation, the send ends stopped (the refusal `cancelled`, with Retry) and the stop is gone. The text and the
  /// photo do not come back to the field.
  func testStopTakesTheTouchOverTheDimmedPhotoAndEndsTheRequest() async throws {
    let rig = try Rig()
    defer { rig.close() }
    let photoData = try PendingMediaRowTests.photo(width: 1200, height: 900)
    let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).jpg")
    try photoData.write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }
    let photo = ComposerAttachment(kind: .image, name: "sky.jpg", mime: "image/jpeg", bytes: photoData.count, file: url)
    AttachmentShelf.shared.restore([photo], for: "s1")
    defer { AttachmentShelf.shared.remove([photo.id], for: "s1") }
    rig.controller.composer.text = "Look"
    await rig.wait("the photo on the shelf") { rig.controller.composer.attachments.count == 1 }

    let send = rig.controller.sendField()
    await rig.wait("the request at the transport") { rig.log.read(\.calls) == 1 }
    let entry = try XCTUnwrap(rig.store.state.outbox.first)
    let tile = try XCTUnwrap(PendingMediaModel.make(entry: entry, voice: nil, progress: nil)?.photos.first?.tile)
    await rig.wait("the decoded thumbnail") {
      ThumbnailImageCache.shared.thumbnail(for: tile.cacheKey(sessionId: "s1"), login: rig.store.uploadLogin) != nil
    }
    // The tile shows the photo with the dimming once it renders again after decoding.
    await rig.settle()

    let buttons = rig.stopButtons()
    XCTAssertEqual(buttons.count, 1, "one stop on the one photo")
    let button = try XCTUnwrap(buttons.first)
    XCTAssertFalse(button.isAccessibilityElement, "VoiceOver gets the action on the thumbnail, not the button")
    XCTAssertEqual(button.accessibilityIdentifier, PendingStopButton.identifier)
    let frame = button.convert(button.bounds, to: rig.window)
    XCTAssertEqual(frame.size, CGSize(width: PendingStopButton.side, height: PendingStopButton.side))
    let center = CGPoint(x: frame.midX, y: frame.midY)
    let hit = rig.window.hitTest(center, with: nil)
    XCTAssertTrue(hit === button, "the stop takes the touch over the dimming, hit: \(String(describing: hit))")
    // A corner of the dimmed photo (128 × 96 pt around the stop) is not the stop.
    let corner = CGPoint(x: center.x - 56, y: center.y - 40)
    XCTAssertFalse(rig.window.hitTest(corner, with: nil) is PendingStopButton, "the dimming outside the stop")

    button.sendActions(for: .touchUpInside)
    let result = await send.value
    XCTAssertEqual(result, .stopped)
    XCTAssertEqual(
      rig.store.state.outbox.first?.state, .refused(code: OutboxEntry.RefusalCode.cancelled, message: nil))
    XCTAssertEqual(rig.store.state.outbox.first?.isRetryable, true)
    // The send returns at the stop; the transport notices the cancellation of its request right after.
    await rig.wait("the transport saw the cancellation") { rig.log.read(\.sawCancel) }
    XCTAssertEqual(rig.controller.composer.text, "", "nothing back in the field")
    XCTAssertEqual(rig.controller.composer.attachments, [], "nothing back on the shelf")
    await rig.wait("the stop gone with the send") { rig.stopButtons().isEmpty }
    XCTAssertEqual(UICopy.cancelSend, "Anuluj wysyłkę")
  }
}

extension PendingMediaStopTests {
  /// What the transport saw: the requests, and whether one was cancelled.
  final class StopLog: @unchecked Sendable {
    struct Calls {
      var calls = 0
      var sawCancel = false
    }

    private let lock = NSLock()
    private var calls = Calls()

    func record(_ change: (inout Calls) -> Void) { lock.withLock { change(&calls) } }
    func read<T>(_ value: (Calls) -> T) -> T { lock.withLock { value(calls) } }
  }

  /// The screen of session `s1` in a window; the transport holds a send until its task is cancelled (at most 10 s),
  /// then throws `cancelled` as `RarogClient` does.
  @MainActor
  struct Rig {
    let store: RarogStore
    let controller: SessionViewController
    let window: UIWindow
    let log: StopLog

    init() throws {
      let log = StopLog()
      self.log = log
      let transport = UIKitTransport(onSend: { _, _ throws(TransportError) in
        log.record { $0.calls += 1 }
        let deadline = ContinuousClock.now + .seconds(10)
        while !Task.isCancelled, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        guard Task.isCancelled else { return nil }
        log.record { $0.sawCancel = true }
        throw .cancelled
      })
      store = RarogStore(
        transport: transport, rules: MutationRules(),
        outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), clientBuild: 1)
      store.dispatch(.loggedIn)
      store.dispatch(.streamOpened(.global, resumedWithCursor: false))
      try SessionToastTests.frame(
        store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#, source: .global)
      let session = #"""
        {"id":"s1","cwd":"/Users/demo/project","title":"project","state":"waiting-input",
         "stateSince":"2026-11-13T10:00:00.000Z","createdAt":"2026-11-13T10:00:00.000Z",
         "lastActivityAt":"2026-11-13T10:00:00.000Z"}
        """#
      try SessionToastTests.frame(store, #"{"type":"sessions-snapshot","sessions":[\#(session)]}"#, source: .global)
      store.dispatch(.viewSession("s1"))
      store.dispatch(.streamOpened(.session(id: "s1"), resumedWithCursor: false))
      try SessionToastTests.frame(store, #"""
        {"type":"transcript-snapshot","sessionId":"s1","messages":[
         {"seq":1,"role":"assistant","at":"2026-11-13T10:00:00.000Z","blocks":[{"type":"text","text":"Done."}]}],
         "pendingPermissions":[],"pendingQuestions":[]}
        """#, source: .session("s1"))
      controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
      window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
      window.rootViewController = controller
      window.makeKeyAndVisible()
      controller.view.layoutIfNeeded()
    }

    func close() {
      window.isHidden = true
    }

    /// The stop targets in the window now.
    func stopButtons() -> [PendingStopButton] {
      window.layoutIfNeeded()
      return TranscriptLeadingTests.views(of: PendingStopButton.self, in: window)
    }

    /// Time for the render of the transcript and the SwiftUI rows. A suspension, not a nested run loop: the send
    /// and the render are main-actor tasks, which a run loop inside this test's job would not run.
    func settle() async {
      try? await Task.sleep(for: .milliseconds(300))
      window.layoutIfNeeded()
    }

    func wait(_ what: String, timeout: Duration = .seconds(5), _ condition: () -> Bool) async {
      let deadline = ContinuousClock.now + timeout
      while !condition(), ContinuousClock.now < deadline {
        try? await Task.sleep(for: .milliseconds(20))
        window.layoutIfNeeded()
      }
      XCTAssertTrue(condition(), "timed out waiting for \(what)")
    }
  }
}
