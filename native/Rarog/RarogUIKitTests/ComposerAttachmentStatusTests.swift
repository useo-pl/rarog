@testable import RarogUI
import UIKit
import UniformTypeIdentifiers
import XCTest

/// The line under the field when an attachment is pasted: "Wczytuję zdjęcia…" does not flash under the prompt for
/// a split second. The start of loading writes nothing, but the sentence channel still gets a signal (`nil`),
/// because saving the draft after loading hangs on it (`+Drafts`). Owner: sending.
@MainActor
final class ComposerAttachmentStatusTests: XCTestCase {
  func testAttachmentLoadingWritesNothingUnderField() async throws {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
    let composer = ComposerView(frame: window.bounds)
    window.addSubview(composer)
    window.isHidden = false
    defer { window.isHidden = true }
    let shelf = AttachmentShelf()
    composer.bind(to: shelf, sessionId: "s1")
    var statuses: [String?] = []
    composer.onAttachmentStatus = { text, _ in statuses.append(text) }

    let source = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).txt")
    try Data("notatka".utf8).write(to: source)
    let gate = AsyncStream<Void>.makeStream()
    let candidate = AttachmentCandidate(kind: .file, name: "notatka.txt", type: .plainText) {
      for await _ in gate.stream { break }
      return try AttachmentStaging.copy(source)
    }
    composer.ingest([candidate])
    XCTAssertTrue(composer.isLoadingAttachments, "paczka w trakcie wczytywania")
    XCTAssertEqual(statuses, [nil], "początek wczytywania: sygnał bez zdania")
    XCTAssertFalse(
      Self.labels(in: composer).contains { ($0.text ?? "").hasPrefix("Wczytuję") && !$0.isHidden },
      "pod polem nie stoi „Wczytuję…”")

    gate.continuation.yield()
    await shelf.loaded("s1")
    XCTAssertEqual(statuses.last, .some(nil), "wczytanie bez odrzuceń gasi linię")
    XCTAssertEqual(composer.attachments.map(\.name), ["notatka.txt"], "załącznik w pasku")
    AttachmentStaging.discard(composer.attachments)
  }

  private static func labels(in view: UIView) -> [UILabel] {
    view.subviews.flatMap { ($0 as? UILabel).map { [$0] } ?? [] + labels(in: $0) }
  }
}
