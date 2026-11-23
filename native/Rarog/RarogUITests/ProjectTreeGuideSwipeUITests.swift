import UIKit
import XCTest

/// The tree guide stays in place while an agent row is swiped (swipe actions: right = read toggle, left = close).
/// UIKit moves the whole list cell, so a guide drawn in the row content used to travel with the row. Checked on real
/// screenshots: the guide's pixel column, found on the row at rest, keeps the guide colour across the row height with
/// the actions open (both edges) and in every frame captured while the actions close. The leading pill stands next
/// to the row's card with the same gap as the trailing pill, not at the column edge over the guide
/// (`TreeSwipeActionsShift`).
///
/// Screenshots of the row at rest and of the open actions go to `RAROG_SCREENSHOT_DIR` when it is set
/// (`prowadnica-<name>.png`).
final class ProjectTreeGuideSwipeUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testGuideStaysWhileRowIsSwiped() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    // An idle session joins the `rarog` project next to two demo agents: it has both swipe actions.
    let id = try await control.create("idle", label: "Prowadnica")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "session list")
    DemoServer.hideKeyboard(app)
    XCTAssertTrue(DemoServer.row(app, id).waitForAppearance(timeout: 15), "idle session on the list")
    let row = DemoServer.reveal(app, id)
    XCTAssertTrue(row.exists, "idle session revealed")
    DemoServer.waitUntilStill(row)
    let frame = row.frame
    let rest = GuideProbe(app.screenshot(), row: frame)
    let guide = try XCTUnwrap(rest.findGuide(), "guide column in the row at rest: \(frame)")
    print("guide: column \(guide.column) px, colour \(guide.colour), background \(guide.background), row \(frame)")
    try check(app, guide, row: frame, name: "spoczynek")

    let origin = app.coordinate(withNormalizedOffset: .zero)
    func drag(from x: CGFloat, by dx: CGFloat) {
      origin.withOffset(CGVector(dx: x, dy: frame.midY)).press(
        forDuration: 0.1, thenDragTo: origin.withOffset(CGVector(dx: x + dx, dy: frame.midY)),
        withVelocity: 150, thenHoldForDuration: 0.5)
    }

    // Left: the close action opens on the right, the row moves ~80 pt left.
    let close = app.buttons["Zamknij panel w herdr"].firstMatch
    drag(from: frame.midX, by: -80)
    XCTAssertTrue(close.waitForAppearance(timeout: 5), "close action open")
    sleep(1)
    try check(app, guide, row: frame, name: "lewo")
    // The system keeps its own gap between the trailing pill and the row's card (the card ends at the cell's edge).
    let trailingGap = close.frame.minX - row.frame.maxX
    print("swipe: trailing pill \(close.frame), cell \(row.frame), gap \(trailingGap) pt")
    // Icon-only pill: the row moves ~80 pt, not ~196 pt with the label inside the pill (a short title left the screen).
    XCTAssertLessThanOrEqual(frame.minX - row.frame.minX, Self.maxSwipeShift, "row shift with the close action open")

    // Closing animates the row back: every captured frame keeps the guide in its column.
    origin.withOffset(CGVector(dx: frame.minX + frame.width * 0.3, dy: frame.midY)).tap()
    var frames = 0
    let deadline = Date().addingTimeInterval(1.2)
    while Date() < deadline {
      let probe = GuideProbe(app.screenshot(), row: frame)
      XCTAssertNil(probe.mismatch(guide), "frame \(frames) while the actions close")
      frames += 1
    }
    print("guide: \(frames) frames checked while the actions closed")
    DemoServer.waitUntilStill(row)
    XCTAssertNil(GuideProbe(app.screenshot(), row: frame).mismatch(guide), "guide after the row settled")

    // Right: the read toggle opens on the left. Its pill stands next to the card with the same gap as the trailing
    // pill, clear of the guide's column (the cell begins `agentPlateInset` before the card, at the column edge).
    drag(from: frame.midX - 40, by: 80)
    sleep(1)
    try check(app, guide, row: frame, name: "prawo")
    let read = app.buttons.matching(NSPredicate(format: "label IN %@", ["Przeczytane", "Nieprzeczytane"])).firstMatch
    XCTAssertTrue(read.exists, "read toggle open")
    let card = row.frame.minX + Self.agentPlateInset
    let leadingGap = card - read.frame.maxX
    print("swipe: leading pill \(read.frame), cell \(row.frame), card from \(card), gap \(leadingGap) pt")
    XCTAssertEqual(leadingGap, trailingGap, accuracy: 1.5, "leading pill next to the card like the trailing one")
    XCTAssertGreaterThan(read.frame.minX, frame.minX + Self.guideAxis + 8, "leading pill clear of the guide")
    XCTAssertLessThanOrEqual(row.frame.minX - frame.minX, Self.maxSwipeShift, "row shift with the read toggle open")

    // The list reuses its actions view: the trailing pill keeps its place after a leading swipe.
    origin.withOffset(CGVector(dx: frame.maxX - 12, dy: frame.midY)).tap()
    DemoServer.waitUntilStill(row)
    XCTAssertEqual(row.frame.minX, frame.minX, accuracy: 0.5, "row back at rest")
    drag(from: frame.midX, by: -80)
    XCTAssertTrue(close.waitForAppearance(timeout: 5), "close action open again")
    sleep(1)
    XCTAssertEqual(close.frame.minX - row.frame.maxX, trailingGap, accuracy: 1.5, "trailing pill after a leading swipe")
    XCTAssertNil(GuideProbe(app.screenshot(), row: frame).mismatch(guide), "guide in place, second left swipe")
  }

  /// The agent's card (selection plate) starts this far into its cell: `ProjectTreeRows.agentPlateInset`
  /// (8 + 37 − 12 pt).
  private static let agentPlateInset: CGFloat = 33
  /// The guide's axis from the cell's leading edge: half the chevron target (`ProjectTreeHeaderRow.chevronTarget`).
  private static let guideAxis: CGFloat = 22
  /// The furthest an open swipe action may move the row: an icon-only pill (60 pt) and the system's gaps.
  private static let maxSwipeShift: CGFloat = 100

  @MainActor
  private func check(_ app: XCUIApplication, _ guide: GuideProbe.Guide, row: CGRect, name: String) throws {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = "prowadnica-\(name)"
    attachment.lifetime = .keepAlways
    add(attachment)
    if let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] {
      try screenshot.pngRepresentation.write(
        to: URL(filePath: path, directoryHint: .isDirectory).appending(path: "prowadnica-\(name).png"))
    }
    XCTAssertNil(GuideProbe(screenshot, row: row).mismatch(guide), "guide in place with the row swiped (\(name))")
  }
}

/// Pixels of an app screenshot around one list row: the guide column and its colour.
struct GuideProbe {
  struct Guide {
    let column: Int
    let colour: [Int]
    let background: [Int]
  }

  private let bytes: [UInt8]
  private let width: Int
  private let height: Int
  private let scale: CGFloat
  private let row: CGRect

  init(_ screenshot: XCUIScreenshot, row: CGRect) {
    let image = screenshot.image
    let cg = image.cgImage!
    width = cg.width
    height = cg.height
    scale = CGFloat(cg.width) / image.size.width
    var buffer = [UInt8](repeating: 0, count: width * height * 4)
    buffer.withUnsafeMutableBytes { raw in
      let context = CGContext(
        data: raw.baseAddress, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
    }
    bytes = buffer
    self.row = row
  }

  /// Sample heights in the upper half of the row: the guide of the last agent ends at its text block.
  private var samples: [Int] {
    [0.15, 0.25, 0.35, 0.45].map { Int(((row.minY + row.height * $0) * scale).rounded(.down)) }
  }

  private func pixel(_ x: Int, _ y: Int) -> [Int] {
    let offset = (y * width + x) * 4
    return [Int(bytes[offset]), Int(bytes[offset + 1]), Int(bytes[offset + 2])]
  }

  private static func distance(_ a: [Int], _ b: [Int]) -> Int {
    zip(a, b).map { abs($0 - $1) }.max() ?? 0
  }

  /// The one-pixel guide between the cell's edge and the agent's dot: the column that differs from the background
  /// (8 pt into the row) at every sample height, the same colour in all of them.
  func findGuide() -> Guide? {
    let background = Int(((row.minX + 8) * scale).rounded(.down))
    let range = Int(((row.minX + 12) * scale).rounded(.down))...Int(((row.minX + 34) * scale).rounded(.down))
    for x in range {
      let colours = samples.map { pixel(x, $0) }
      let backs = samples.map { pixel(background, $0) }
      let apart = zip(colours, backs).allSatisfy { Self.distance($0, $1) > 8 }
      let same = colours.allSatisfy { Self.distance($0, colours[0]) <= 4 }
      if apart, same { return Guide(column: x, colour: colours[0], background: backs[0]) }
    }
    return nil
  }

  /// `nil` when the guide's column keeps the guide colour at every sample height; otherwise what was there.
  func mismatch(_ guide: Guide) -> String? {
    let found = samples.map { pixel(guide.column, $0) }
    let ok = found.allSatisfy { Self.distance($0, guide.colour) <= 6 }
    return ok ? nil : "column \(guide.column) px: \(found), guide \(guide.colour)"
  }
}
