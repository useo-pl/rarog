#if os(iOS)
import CoreText
import Foundation
@testable import RarogTerminal
import RarogUI
// `@testable`: the four fonts SwiftTerm draws with (`fontSet`) are internal.
@preconcurrency @testable import SwiftTerm
import Testing
import UIKit

// The terminal's font at the app's text size: the points of every step for the iPad and the phone, and a step on a
// live surface, also one parked outside the window. Bytes are SYNTHETIC. Owner: terminal.

@MainActor
@Suite("terminal: font at the app's text size")
struct TerminalFontScaleTests {
  /// One row of the table: the points of the seven steps, Extra Small to Extra Extra Extra Large, and the neighbouring
  /// steps that round to the same whole point.
  struct Row: CustomTestStringConvertible, Sendable {
    let pad: Bool
    let system: TextSizeCategory
    let points: [CGFloat]
    let merged: [[TextSizeCategory]]

    var testDescription: String { "\(pad ? "iPad" : "phone"), system \(system)" }
  }

  nonisolated static let table: [Row] = [
    Row(pad: true, system: .large, points: [11, 11, 12, 13, 15, 16, 18], merged: [[.extraSmall, .small]]),
    Row(pad: false, system: .large, points: [9, 10, 10, 11, 12, 14, 15], merged: [[.small, .medium]]),
    Row(pad: true, system: .small, points: [12, 13, 14, 15, 16, 18, 20], merged: []),
    Row(pad: false, system: .small, points: [10, 11, 12, 12, 14, 15, 17], merged: [[.medium, .large]]),
  ]

  @Test("category → points: whole points scaled like body text, the system's own step keeps 13 and 11 pt", arguments: table)
  func points(_ row: Row) {
    let base = TerminalFontSize.points(pad: row.pad)
    let points = TextSizeCategory.steps.map {
      TerminalFontSize.points(base, effective: $0, system: row.system)
    }
    #expect(points == row.points)
    #expect(points[TextSizeCategory.steps.firstIndex(of: row.system)!] == base)
    let merged = zip(TextSizeCategory.steps, TextSizeCategory.steps.dropFirst()).filter { pair in
      TerminalFontSize.points(base, effective: pair.0, system: row.system)
        == TerminalFontSize.points(base, effective: pair.1, system: row.system)
    }.map { [$0.0, $0.1] }
    #expect(merged == row.merged, "neighbouring steps with the same points")
  }

  /// Where every text style has one size (a Mac), body text grows by the table: 13 · 19 / 17 rounds to 15 at
  /// Extra Large. `preferredFont` would give the same size at every step there and leave the terminal at 13.
  @Test("flat text styles: the terminal scales by the table, Extra Large over Large gives 15 pt")
  func flatPathUsesTheTable() {
    #expect(TerminalFontSize.points(13, effective: .extraLarge, system: .large, flat: true) == 15)
    #expect(TerminalFontSize.points(13, effective: .large, system: .large, flat: true) == 13)
    let scale = Self.scale(system: .large)
    scale.grow()
    #expect(TerminalFontSize.points(13, scale: scale, flat: true) == 15)
    let points: [CGFloat] = TextSizeCategory.steps.map { step in
      TerminalFontSize.points(13, effective: step, system: .large, flat: true)
    }
    #expect(points == points.sorted(), "never shrinks with a step: \(points)")
    #expect(points[0] < points[points.count - 1], "grows across the steps: \(points)")
  }

  @Test("nothing stored, or the system at an accessibility size: exactly 13 and 11 pt")
  func nothingStored() {
    for system in [TextSizeCategory.small, .large, .accessibilityMedium] {
      let scale = Self.scale(system: system)
      for pad in [true, false] {
        let base = TerminalFontSize.points(pad: pad)
        #expect(TerminalFontSize.points(base, scale: scale) == base, "\(system), pad \(pad)")
      }
    }
    let lifted = Self.scale(system: .large)
    lifted.grow()
    lifted.systemChanged(.accessibilityMedium)
    #expect(TerminalFontSize.points(13, scale: lifted) == 13, "a stored step under an accessibility size")
    #expect(TerminalFontSize.points(13, scale: nil) == 13)
  }

  @Test("a step on a live surface swaps the four Menlo fonts with the glyph cascade and ends in one resize; content and modes stay")
  func liveStep() async throws {
    let scale = Self.scale(system: .large)
    let surface = Self.surface(scale)
    let window = host(surface)
    defer { window.isHidden = true }
    #expect(surface.font.pointSize == 13)
    // Application cursor keys: a reset of the terminal's modes would turn them off.
    surface.feed(Data("\u{1B}[?1h\u{1B}[2J\u{1B}[Hraz\r\ndwa".utf8))
    let grid = surface.gridSize
    var sizes: [[Int]] = []
    surface.onResize = { cols, rows in sizes.append([cols, rows]) }

    scale.grow()
    try await Self.waitForFont(surface, 15)
    surface.layoutIfNeeded()
    try Self.expectFonts(surface, size: 15)
    let expected = Self.grid(fontSize: 15)
    #expect(surface.gridSize == expected, "the grid of a surface made at 15 pt: \(surface.gridSize)")
    #expect(sizes == [[expected.cols, expected.rows]], "one resize with the new grid: \(sizes)")
    #expect(surface.visibleText == "raz\ndwa")
    #expect(surface.getTerminal().applicationCursor, "the terminal's modes stay")
    let cursor = surface.getTerminal().getCursorLocation()
    #expect(cursor.x == 3 && cursor.y == 1, "the cursor stays after the second word: \(cursor)")

    scale.reset()
    try await Self.waitForFont(surface, 13)
    surface.layoutIfNeeded()
    #expect(surface.gridSize == grid, "⌘0: the first grid back")
    #expect(sizes.count == 2 && sizes.last == [grid.cols, grid.rows], "one more resize: \(sizes)")
    #expect(surface.visibleText == "raz\ndwa")
  }

  @Test("the system's size moves under a stored step: the terminal follows the ratio")
  func systemMovesUnderStep() async throws {
    let scale = Self.scale(system: .large)
    scale.grow()
    let surface = Self.surface(scale)
    let window = host(surface)
    defer { window.isHidden = true }
    #expect(surface.font.pointSize == 15, "a new surface starts at the effective size")
    scale.systemChanged(.small)
    try await Self.waitForFont(surface, 16)
    try Self.expectFonts(surface, size: 16)
  }

  @Test("a parked surface: no resize outside the window, the current size and one resize on return; content stays")
  func parkedSurface() async throws {
    let scale = Self.scale(system: .large)
    let surface = Self.surface(scale)
    let window = host(surface)
    defer { window.isHidden = true }
    surface.feed(Data("\u{1B}[2J\u{1B}[Hraz\r\ndwa".utf8))
    var sizes: [[Int]] = []
    surface.onResize = { cols, rows in sizes.append([cols, rows]) }

    surface.removeFromSuperview()
    scale.grow()
    scale.grow()
    try await Task.sleep(for: .milliseconds(100))
    #expect(sizes.isEmpty, "no resize while parked: \(sizes)")

    window.addSubview(surface)
    surface.layoutIfNeeded()
    try await Self.waitForFont(surface, 16)
    surface.layoutIfNeeded()
    try Self.expectFonts(surface, size: 16)
    let expected = Self.grid(fontSize: 16)
    #expect(surface.gridSize == expected)
    #expect(sizes == [[expected.cols, expected.rows]], "one resize after the return: \(sizes)")
    #expect(surface.visibleText == "raz\ndwa")
  }

  /// A forced layout while parked (the Cmd+F/G window lays out its stack when edge colours change) must not resize
  /// the emulator: the server keeps sending bytes for the grid it knows.
  @Test("parked inside a container: a step and forced layouts change nothing until the return, then one resize")
  func parkedForcedLayout() async throws {
    let scale = Self.scale(system: .large)
    let surface = Self.surface(scale)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 600, height: 400))
    let container = UIView(frame: window.bounds)
    surface.frame = container.bounds
    container.addSubview(surface)
    window.addSubview(container)
    window.isHidden = false
    container.layoutIfNeeded()
    defer { window.isHidden = true }
    surface.feed(Data("\u{1B}[2J\u{1B}[Hraz\r\ndwa".utf8))
    let grid = surface.gridSize
    var sizes: [[Int]] = []
    surface.onResize = { cols, rows in sizes.append([cols, rows]) }

    container.removeFromSuperview()
    #expect(surface.window == nil)
    scale.grow()
    try await Task.sleep(for: .milliseconds(100))
    container.setNeedsLayout()
    container.layoutIfNeeded()
    surface.setNeedsLayout()
    surface.layoutIfNeeded()
    #expect(sizes.isEmpty, "no resize while parked: \(sizes)")
    #expect(surface.gridSize == grid, "the grid stays while parked")
    #expect(surface.font.pointSize == 13, "the font waits for the return")

    window.addSubview(container)
    container.layoutIfNeeded()
    try await Self.waitForFont(surface, 15)
    surface.layoutIfNeeded()
    let expected = Self.grid(fontSize: 15)
    #expect(surface.gridSize == expected)
    #expect(sizes == [[expected.cols, expected.rows]], "one resize after the return: \(sizes)")
    #expect(surface.visibleText == "raz\ndwa")
  }

  @Test("a closed surface ignores a step")
  func closedSurface() async throws {
    let scale = Self.scale(system: .large)
    let surface = Self.surface(scale)
    let window = host(surface)
    defer { window.isHidden = true }
    surface.close()
    scale.grow()
    try await Task.sleep(for: .milliseconds(100))
    surface.layoutIfNeeded()
    #expect(surface.font.pointSize == 13)
  }

  // MARK: - Helpers

  /// A text size of its own (a fresh defaults domain, nothing stored).
  static func scale(system: TextSizeCategory) -> TextScale {
    let suite = "rarog-test-terminal-font-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return TextScale(defaults: defaults, system: system)
  }

  static func surface(_ scale: TextScale) -> SwiftTermSurface {
    SwiftTermSurface(
      configuration: TerminalSurfaceConfiguration(
        fontSize: TerminalFontSize.pad, background: .black, foreground: .white, textScale: scale))
  }

  /// The grid of a surface made at `fontSize` in the window of `host(_:)`.
  static func grid(fontSize: CGFloat) -> (cols: Int, rows: Int) {
    let surface = SwiftTermSurface(
      configuration: TerminalSurfaceConfiguration(fontSize: fontSize, background: .black, foreground: .white))
    let window = host(surface)
    defer { window.isHidden = true }
    return surface.gridSize
  }

  /// The change reaches the surface through Observation on the next turn of the main actor.
  static func waitForFont(_ surface: SwiftTermSurface, _ size: CGFloat) async throws {
    for _ in 0..<100 where surface.font.pointSize != size {
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(surface.font.pointSize == size)
  }

  static func expectFonts(_ surface: SwiftTermSurface, size: CGFloat) throws {
    let set = surface.fontSet
    let fonts = [set.normal, set.bold, set.italic, set.boldItalic]
    let names = TerminalSymbolsFont.baseNames
    #expect(fonts.map(\.fontName) == [names.regular, names.bold, names.italic, names.boldItalic])
    for font in fonts {
      #expect(font.pointSize == size)
      let cascade = try #require(
        CTFontCopyAttribute(font as CTFont, kCTFontCascadeListAttribute) as? [CTFontDescriptor])
      let cascadeNames = cascade.compactMap { CTFontDescriptorCopyAttribute($0, kCTFontNameAttribute) as? String }
      #expect(cascadeNames.contains(TerminalSymbolsFont.postScriptName), "\(font.fontName): the glyph cascade")
    }
  }
}
#endif
