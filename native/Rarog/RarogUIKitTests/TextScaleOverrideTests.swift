import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Text paths that must follow a text size set on the window or scene (`traitOverrides.preferredContentSizeCategory`)
/// rather than the system's size. The bug each test catches: a font, line height or key cap height computed without
/// the view's traits (`UIFont.preferredFont(forTextStyle:)`, `UIFontMetrics.scaledValue(for:)` with no traits)
/// returns the SYSTEM category, so it stays put while the rest of the screen grows; a render cached per category
/// redraws only for a new view. Each path is checked at three moments: built under the override, existing when the
/// override changes, and taken off the window and put back after the change. The host of these tests has no scene,
/// so the override goes on the window, which gives views the same traits as the scene does.
@MainActor
final class TextScaleOverrideTests: XCTestCase {
  static let smallest = UIContentSizeCategory.extraSmall
  static let largest = UIContentSizeCategory.extraExtraExtraLarge
  /// The seven standard steps, smallest first.
  static let steps: [UIContentSizeCategory] = [
    .extraSmall, .small, .medium, .large, .extraLarge, .extraExtraLarge, .extraExtraExtraLarge,
  ]
  /// List column widths of the accessibility layout tests: the narrowest column, the usual iPad column, the iPhone.
  static let widths: [CGFloat] = [300, 320, 393]

  /// A path on screen: placed in a window, taken off it, and measured (a font size or a height in points).
  struct Probe {
    let name: String
    let attach: (UIWindow) -> Void
    let detach: () -> Void
    let measure: () throws -> CGFloat
    /// Text and selection of a field that must survive a size change; `nil` when the path has no field.
    var field: (() -> (String, NSRange))?
  }

  override func setUp() async throws {
    try await super.setUp()
    // The override must differ from the system's size at both ends, or a path reading the system would pass.
    let system = UIScreen.main.traitCollection.preferredContentSizeCategory
    XCTAssertNotEqual(system, Self.smallest, "system text size must differ from the smallest override")
    XCTAssertNotEqual(system, Self.largest, "system text size must differ from the largest override")
  }

  override func tearDown() async throws {
    ShortcutSheetPanel.hide()
    try await super.tearDown()
  }

  // MARK: - Three moments

  func testScreenBlockCeilingFollowsTheOverride() throws {
    try checkThreeMoments { Self.screenBlock(width: 390) }
  }

  func testPermissionCommandCeilingFollowsTheOverride() throws {
    try checkThreeMoments { Self.permissionCommand(width: 390) }
  }

  func testVoiceSettingsTitleFollowsTheOverride() throws {
    try checkThreeMoments { Self.voiceSettings(width: 390).probe }
  }

  func testNoteReaderFollowsTheOverride() throws {
    try checkThreeMoments { Self.noteReader(width: 390) }
  }

  func testShortcutSheetKeyCapsFollowTheOverride() throws {
    try checkThreeMoments { Self.shortcutKeyCaps(width: 1180) }
  }

  private func checkThreeMoments(_ make: () -> Probe, file: StaticString = #filePath, line: UInt = #line) throws {
    // Built under each override.
    let small = make()
    let smallWindow = Self.window(width: 1180, category: Self.smallest)
    small.attach(smallWindow)
    Self.settle(smallWindow)
    let atSmallest = try small.measure()
    small.detach()
    smallWindow.isHidden = true
    let large = make()
    let largeWindow = Self.window(width: 1180, category: Self.largest)
    large.attach(largeWindow)
    Self.settle(largeWindow)
    let atLargest = try large.measure()
    large.detach()
    largeWindow.isHidden = true
    XCTAssertGreaterThan(atLargest, atSmallest, "\(small.name), built: \(atSmallest) → \(atLargest)", file: file, line: line)

    // Existing: the override changes under a view already on screen, and back.
    let live = make()
    let window = Self.window(width: 1180, category: Self.smallest)
    defer { window.isHidden = true }
    live.attach(window)
    Self.settle(window)
    let before = live.field?()
    window.traitOverrides.preferredContentSizeCategory = Self.largest
    Self.settle(window)
    let grown = try live.measure()
    XCTAssertEqual(grown, atLargest, accuracy: 0.5, "\(live.name), existing grows: \(grown)", file: file, line: line)
    window.traitOverrides.preferredContentSizeCategory = Self.smallest
    Self.settle(window)
    let shrunk = try live.measure()
    XCTAssertEqual(shrunk, atSmallest, accuracy: 0.5, "\(live.name), existing back: \(shrunk)", file: file, line: line)
    if let before, let after = live.field?() {
      XCTAssertEqual(after.0, before.0, "\(live.name): the text stays", file: file, line: line)
      XCTAssertEqual(after.1, before.1, "\(live.name): the selection stays", file: file, line: line)
    }

    // Reattached: taken off the window, the override changes, put back.
    live.detach()
    window.traitOverrides.preferredContentSizeCategory = Self.largest
    live.attach(window)
    Self.settle(window)
    let back = try live.measure()
    XCTAssertEqual(back, atLargest, accuracy: 0.5, "\(live.name), reattached: \(back)", file: file, line: line)
    live.detach()
  }

  // MARK: - Frames at every step

  /// Each fixed path at every standard step and list width: it fits its container and its parts do not overlap.
  /// The table of measured values goes to the result's attachment.
  func testFixedPathsFitAtEveryStep() throws {
    var table: [String] = []
    for width in Self.widths {
      for category in Self.steps {
        let window = Self.window(width: width, category: category)
        defer { window.isHidden = true }
        let label = "\(width) pt, \(category.rawValue)"
        var row: [String] = []

        for probe in [Self.screenBlock(width: width), Self.permissionCommand(width: width)] {
          probe.attach(window)
          Self.settle(window)
          let block = try XCTUnwrap(Self.blockFrame(in: window), "\(probe.name), \(label): block")
          XCTAssertGreaterThanOrEqual(block.minX, -0.5, "\(probe.name), \(label): \(block)")
          XCTAssertLessThanOrEqual(block.maxX, width + 0.5, "\(probe.name), \(label): \(block)")
          row.append("\(probe.name) \(Int(block.height.rounded()))")
          probe.detach()
        }

        let voice = Self.voiceSettings(width: width)
        voice.probe.attach(window)
        Self.settle(window)
        let status = voice.view
        let button = try XCTUnwrap(Self.views(of: UIButton.self, in: status).first, "\(label): settings button")
        let text = try XCTUnwrap(Self.views(of: UILabel.self, in: status).first { $0.accessibilityIdentifier == "composer.voice.status" })
        let buttonFrame = button.convert(button.bounds, to: status)
        let textFrame = text.convert(text.bounds, to: status)
        XCTAssertLessThanOrEqual(buttonFrame.maxX, status.bounds.width + 0.5, "voice, \(label): \(buttonFrame)")
        XCTAssertLessThanOrEqual(textFrame.maxX, buttonFrame.minX + 0.5, "voice, \(label): \(textFrame) \(buttonFrame)")
        XCTAssertLessThanOrEqual(buttonFrame.height, status.bounds.height + 0.5, "voice, \(label): \(buttonFrame)")
        row.append("voice title \(try voice.probe.measure())")
        voice.probe.detach()

        let note = Self.noteReader(width: width)
        note.attach(window)
        Self.settle(window)
        let reader = try XCTUnwrap(Self.views(of: UITextView.self, in: window).first)
        let readerFrame = reader.convert(reader.bounds, to: window)
        XCTAssertLessThanOrEqual(readerFrame.maxX, width + 0.5, "note, \(label): \(readerFrame)")
        let used = reader.sizeThatFits(CGSize(width: reader.bounds.width, height: .greatestFiniteMagnitude)).height
        XCTAssertGreaterThanOrEqual(reader.bounds.height + 0.5, used, "note, \(label): the whole text shows")
        row.append("note \(try note.measure())")
        note.detach()

        let sheet = Self.shortcutKeyCaps(width: width)
        sheet.attach(window)
        Self.settle(window)
        let panel = try XCTUnwrap(ShortcutSheetPanel.visible)
        XCTAssertTrue(window.bounds.contains(panel.card.frame), "sheet, \(label): \(panel.card.frame)")
        for caps in Self.views(of: UIStackView.self, in: panel.card)
        where caps.axis == .horizontal && caps.arrangedSubviews.contains(where: { $0 is ShortcutSheetChip }) {
          let frames = caps.arrangedSubviews.map { $0.convert($0.bounds, to: panel.card) }
          for frame in frames {
            XCTAssertLessThanOrEqual(frame.maxX, panel.card.bounds.width + 0.5, "sheet, \(label): cap outside \(frame)")
          }
          for (left, right) in zip(frames, frames.dropFirst()) {
            XCTAssertLessThanOrEqual(left.maxX, right.minX + 0.5, "sheet, \(label): caps overlap \(left) \(right)")
          }
        }
        row.append("key cap \(try sheet.measure())")
        sheet.detach()

        table.append("\(label): " + row.joined(separator: ", "))
      }
    }
    let attachment = XCTAttachment(string: table.joined(separator: "\n"))
    attachment.name = "Text-scale-frames"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  // MARK: - Paths

  /// "What the terminal shows" block with more lines than its ceiling: the block's height is the ceiling.
  static func screenBlock(width: CGFloat) -> Probe {
    let screen = (1...30).map { "line \($0) of the panel" }.joined(separator: "\n")
    return hosted("screen block", width: width, ScreenBlockView(screen: screen))
  }

  /// The command block of a consent card with more lines than its ceiling: the block's height is the ceiling.
  static func permissionCommand(width: CGFloat) -> Probe {
    let command = (1...40).map { "echo step \($0)" }.joined(separator: "\n")
    let card = PermissionCardModel(
      permId: "p1", sessionId: "s1", eyebrow: UICopy.permissionEyebrow(toolName: "Edit", risky: false, plan: false),
      toolName: "Edit", risky: false, plan: false, cwd: "~/Projects/demo", command: command, commandSyntax: [],
      createdAt: nil, canAllow: true, screen: nil, cliDialog: nil, phase: .idle, error: nil, lockedReason: nil,
      alwaysLabel: nil, note: nil)
    return hosted("permission command", width: width, PermissionCardView(card: card, decide: { _ in }))
  }

  /// SwiftUI view in a hosting controller that is the window's root; measured by its only scroll view's height.
  private static func hosted(_ name: String, width: CGFloat, _ view: some View) -> Probe {
    let host = UIHostingController(rootView: AnyView(view.frame(width: width)))
    host.safeAreaRegions = []
    var window: UIWindow?
    return Probe(
      name: name,
      attach: { target in
        window = target
        target.rootViewController = host
        host.view.frame = target.bounds
      },
      detach: { window?.rootViewController = nil },
      measure: {
        let blocks = scrollViews(in: host.view)
        XCTAssertEqual(blocks.count, 1, "\(name): one scrolled block")
        return try XCTUnwrap(blocks.first).bounds.height
      })
  }

  /// The frame of the only scrolled block under the window's root view.
  private static func blockFrame(in window: UIWindow) -> CGRect? {
    guard let root = window.rootViewController?.view, let block = scrollViews(in: root).first else { return nil }
    return block.convert(block.bounds, to: root)
  }

  /// The dictation status row with its "Settings" button (a refused microphone); measured by the title's point size.
  static func voiceSettings(width: CGFloat) -> (probe: Probe, view: VoiceStatusView) {
    let view = VoiceStatusView(frame: .zero)
    view.renderAgent(.ended(.microphone(.denied)))
    return (Probe(
      name: "voice settings",
      attach: { window in
        view.frame = CGRect(x: 0, y: 0, width: width, height: 0)
        window.addSubview(view)
        let height = view.systemLayoutSizeFitting(
          CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
          withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel).height
        view.frame.size.height = ceil(height)
      },
      detach: { view.removeFromSuperview() },
      measure: {
        let button = try XCTUnwrap(views(of: UIButton.self, in: view).first)
        XCTAssertFalse(button.isHidden, "the settings button shows")
        return try XCTUnwrap(button.titleLabel?.font).pointSize
      }), view)
  }

  /// A project note being read, with a selection; measured by the point size of its first character.
  static func noteReader(width: CGFloat) -> Probe {
    let text = "# Notes\n\nThe reader keeps **this text** selected while the size changes.\n\n- one\n- two"
    let host = UIHostingController(rootView: NoteReader(text: text).frame(width: width))
    host.safeAreaRegions = []
    var window: UIWindow?
    func reader() -> UITextView? {
      views(of: UITextView.self, in: host.view).first { $0.accessibilityIdentifier == "note.reader" }
    }
    var selected = false
    return Probe(
      name: "note reader",
      attach: { target in
        window = target
        target.rootViewController = host
        host.view.frame = target.bounds
        host.view.layoutIfNeeded()
        if !selected, let view = reader() {
          view.selectedRange = NSRange(location: 9, length: 10)
          selected = true
        }
      },
      detach: { window?.rootViewController = nil },
      measure: {
        let view = try XCTUnwrap(reader(), "note reader")
        let font = try XCTUnwrap(view.attributedText.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
        return font.pointSize
      },
      field: {
        guard let view = reader() else { return ("", NSRange()) }
        return (view.attributedText.string, view.selectedRange)
      })
  }

  /// The shortcut sheet in the window; measured by the height of its tallest key cap.
  static func shortcutKeyCaps(width: CGFloat) -> Probe {
    let content = ShortcutSheetContent(
      place: .session,
      capabilities: ShortcutSheetCapabilities(notes: true, terminal: true, voiceAgent: true, wideIPad: width > 640))
    // The window holds the panel only while it is on it; the probe keeps it across a detach.
    var panel: ShortcutSheetPanel?
    return Probe(
      name: "shortcut key caps",
      attach: { window in
        if let panel {
          panel.frame = window.bounds
          window.addSubview(panel)
        } else {
          ShortcutSheetPanel.show(content, in: window)
          panel = ShortcutSheetPanel.visible
        }
      },
      detach: { panel?.removeFromSuperview() },
      measure: {
        let shown = try XCTUnwrap(panel, "shortcut sheet")
        let caps = views(of: ShortcutSheetChip.self, in: shown).filter(\.isKeyCap)
        XCTAssertFalse(caps.isEmpty, "key caps")
        return caps.map(\.bounds.height).max() ?? 0
      })
  }

  // MARK: - Helpers

  static func window(width: CGFloat, category: UIContentSizeCategory) -> UIWindow {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 900))
    window.traitOverrides.preferredContentSizeCategory = category
    window.isHidden = false
    return window
  }

  /// Layout, then a short wait: SwiftUI blocks take their height in a second pass (`onGeometryChange`).
  static func settle(_ window: UIWindow) {
    for _ in 0..<3 {
      window.setNeedsLayout()
      window.layoutIfNeeded()
      for view in window.subviews { view.layoutIfNeeded() }
      RunLoop.current.run(until: Date().addingTimeInterval(0.08))
    }
    window.layoutIfNeeded()
  }

  static func scrollViews(in view: UIView) -> [UIScrollView] {
    let own = (view as? UIScrollView).map { [$0] } ?? []
    return own + view.subviews.flatMap(scrollViews(in:))
  }

  static func views<T: UIView>(of type: T.Type, in view: UIView) -> [T] {
    let own = (view as? T).map { [$0] } ?? []
    return own + view.subviews.flatMap { views(of: type, in: $0) }
  }
}
