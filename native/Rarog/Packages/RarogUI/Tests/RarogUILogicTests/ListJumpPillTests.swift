import CoreGraphics
import Foundation
import RarogCore
@testable import RarogUI
import Testing

// The jump pill of the session list: which rows that need the human count above and below the visible part, and
// where a tap scrolls. Texts: `ListJumpPillCopyTests`. Owner: list.

@Suite("list jump pill: rows off screen")
struct ListJumpPillTests {
  private typealias Pill = ListJumpPill
  private typealias Row = ListJumpPill.Row

  /// Rows 60 pt high, one after another from 0; a project header first.
  private static func frames(_ rows: [Row]) -> [Pill.Span] {
    rows.indices.map { Pill.Span(minY: CGFloat($0) * 60, maxY: CGFloat($0) * 60 + 60) }
  }

  /// A 300 pt visible part without insets, scrolled to `offset`.
  private static func viewport(
    offset: CGFloat = 0, height: CGFloat = 300, insetTop: CGFloat = 0, insetBottom: CGFloat = 0
  ) -> Pill.Viewport {
    Pill.Viewport(
      offset: offset, boundsHeight: height, contentHeight: 5000, insetTop: insetTop, insetBottom: insetBottom)
  }

  private static let pills = Pill.PillHeights(above: 44, below: 44)

  /// `count` rows: a header, then quiet sessions "s1"…, with the states from `states` by row index.
  private static func rows(_ count: Int, _ states: [Int: StatusTone]) -> [Row] {
    [Row.project("/p")] + (1..<count).map { Row.session("s\($0)", tone: states[$0] ?? .quiet, name: "name \($0)") }
  }

  private func evaluate(
    _ rows: [Row], frames: [Pill.Span]? = nil, applied: [ProjectTreeID]? = nil, items: Int? = nil,
    viewport: Pill.Viewport = Self.viewport(), pills: Pill.PillHeights = Self.pills
  ) -> Pill.Result? {
    let spans = frames ?? Self.frames(rows)
    return Pill.evaluate(
      rows: rows, applied: applied ?? rows.map(\.id), items: items ?? rows.count,
      frame: { spans.indices.contains($0) ? spans[$0] : nil }, viewport: viewport, pillHeights: pills)
  }

  @Test("one waiting row under the visible part: below 1 with its name, the target is that row; nothing above")
  func oneBelow() throws {
    let result = try #require(evaluate(Self.rows(8, [6: .waiting])))
    #expect(result.below == Pill.Side(waiting: 1, name: "name 6", target: "s6"))
    #expect(result.above == nil)
  }

  @Test("waiting and error under the visible part, unread over it: below 2 without a name, above 1 with its name")
  func bothSides() throws {
    let rows = Self.rows(13, [1: .unread, 11: .waiting, 12: .failed])
    let result = try #require(evaluate(rows, viewport: Self.viewport(offset: 300)))
    #expect(result.below == Pill.Side(waiting: 1, failed: 1, name: nil, target: "s11"))
    #expect(result.above == Pill.Side(unread: 1, name: "name 1", target: "s1"))
  }

  @Test("waiting row visible whole just above the bottom edge, nothing below: no pill (pass 1)")
  func wholeAboveEdge() throws {
    let result = try #require(evaluate(Self.rows(8, [4: .waiting])))
    #expect(result == .none, "the row spans 240…300 in a 0…300 visible part")
  }

  @Test("the same row plus an error under the visible part: below 2, the covered row counts; the target is the error")
  func coveredRowCounts() throws {
    let result = try #require(evaluate(Self.rows(9, [4: .waiting, 7: .failed])))
    #expect(result.below == Pill.Side(waiting: 1, failed: 1, target: "s7"))
    #expect(result.above == nil)
  }

  @Test("under the pill means not on screen without its band: 48 of 60 pt above the band stays, 28 of 60 pt counts")
  func bandBoundary() throws {
    // The band of a 44 pt pill is its measured frame, which stands on the edge: the visible part without it runs
    // 0…256.
    let rows = Self.rows(9, [3: .waiting, 7: .failed])
    var frames = Self.frames(rows)
    frames[3] = Pill.Span(minY: 220, maxY: 280)
    #expect(try #require(evaluate(rows, frames: frames)).below?.count == 1, "36 pt above the band: visible")
    frames[3] = Pill.Span(minY: 230, maxY: 290)
    #expect(try #require(evaluate(rows, frames: frames)).below?.count == 2, "26 pt above the band: covered")
  }

  @Test("a tall pill in a short visible part covers a row whose center lies in the other half: it still counts")
  func tallPillCoversOtherHalf() throws {
    let span = { (minY: CGFloat, maxY: CGFloat) in Pill.Span(minY: minY, maxY: maxY) }
    let rows = Self.rows(3, [1: .waiting, 2: .failed])
    let below = try #require(evaluate(
      rows, frames: [span(0, 44), span(44, 104), span(164, 224)], viewport: Self.viewport(height: 160),
      pills: Pill.PillHeights(above: 44, below: 100)))
    #expect(below.below == Pill.Side(waiting: 1, failed: 1, name: nil, target: "s2"))
    #expect(below.above == nil)

    let mirrored = Self.rows(3, [1: .failed, 2: .waiting])
    let above = try #require(evaluate(
      mirrored, frames: [span(0, 60), span(136, 196), span(256, 316)],
      viewport: Self.viewport(offset: 200, height: 160),
      pills: Pill.PillHeights(above: 100, below: 44)))
    #expect(above.above == Pill.Side(waiting: 1, failed: 1, name: nil, target: "s1"))
    #expect(above.below == nil)
  }

  @Test("each side's band uses that side's pill height")
  func bandPerSide() throws {
    // Above: an unread row far over the visible part, a waiting row at 10…70 just under the top edge of 0…300.
    let rows = Self.rows(9, [1: .unread, 2: .waiting])
    var frames = Self.frames(rows)
    frames[1] = Pill.Span(minY: -400, maxY: -340)
    frames[2] = Pill.Span(minY: 10, maxY: 70)
    let short = try #require(evaluate(rows, frames: frames, pills: Pill.PillHeights(above: 12, below: 44)))
    #expect(short.above?.count == 1, "band 0…20: the row is visible")
    let tall = try #require(evaluate(rows, frames: frames, pills: Pill.PillHeights(above: 80, below: 44)))
    #expect(tall.above?.count == 2, "band 0…88: the row is covered")
    #expect(tall.above?.target == "s1", "the target stays the row off screen")
  }

  @Test("a waiting row visible by half does not count; visible by 40 percent it does")
  func halfVisible() throws {
    let rows = Self.rows(8, [5: .waiting])
    var frames = Self.frames(rows)
    frames[5] = Pill.Span(minY: 270, maxY: 330)
    #expect(try #require(evaluate(rows, frames: frames)) == .none, "30 of 60 pt in the visible part")
    frames[5] = Pill.Span(minY: 276, maxY: 336)
    #expect(try #require(evaluate(rows, frames: frames)).below == Pill.Side(waiting: 1, name: "name 5", target: "s5"),
            "24 of 60 pt in the visible part")
  }

  @Test("a 500 pt row that fills the whole visible part is on screen")
  func tallRowOnScreen() throws {
    let rows = Self.rows(3, [1: .waiting])
    let frames = [Pill.Span(minY: -160, maxY: -100), Pill.Span(minY: -100, maxY: 400), Pill.Span(minY: 400, maxY: 460)]
    #expect(try #require(evaluate(rows, frames: frames)) == .none)
  }

  @Test("a visible part of zero or negative height: no pill on either side")
  func emptyVisiblePart() throws {
    let rows = Self.rows(8, [6: .waiting, 1: .failed])
    #expect(try #require(evaluate(rows, viewport: Self.viewport(height: 120, insetTop: 60, insetBottom: 60))) == .none)
    #expect(try #require(evaluate(rows, viewport: Self.viewport(height: 100, insetTop: 60, insetBottom: 60))) == .none)
  }

  @Test("only working, quiet and background-wait rows off screen: no pill")
  func workDoesNotCount() throws {
    let rows = Self.rows(10, [6: .working, 7: .working, 8: .quiet, 9: .backgroundWait])
    #expect(try #require(evaluate(rows)) == .none)
    // A long wait is only a warning: it has the waiting color but makes no pill.
    let long = Self.rows(10, [8: .backgroundWaitLong, 9: .backgroundWaitLong])
    #expect(try #require(evaluate(long)) == .none)
  }

  @Test("several rows below: the target is the first under the visible part; several above: the last over it")
  func nearestTarget() throws {
    let rows = Self.rows(16, [1: .waiting, 2: .failed, 3: .unread, 12: .unread, 13: .waiting, 15: .failed])
    let result = try #require(evaluate(rows, viewport: Self.viewport(offset: 360)))
    #expect(result.below == Pill.Side(waiting: 1, failed: 1, unread: 1, target: "s12"))
    #expect(result.above == Pill.Side(waiting: 1, failed: 1, unread: 1, target: "s3"))
  }

  @Test("the collection holds another tree: same count with other ids, or another count — no result")
  func otherTree() {
    let rows = Self.rows(8, [6: .waiting])
    var applied = rows.map(\.id)
    applied.swapAt(5, 6)
    #expect(evaluate(rows, applied: applied) == nil)
    #expect(evaluate(rows, items: rows.count - 1) == nil)
  }

  @Test("the tone decides the state: held results are quiet, an unread result with working background task is work")
  func attentionFromTone() {
    #expect(Pill.Attention(.waiting) == .waiting)
    #expect(Pill.Attention(.failed) == .failed)
    #expect(Pill.Attention(.unread) == .unread)
    #expect(Pill.Attention(.working) == nil)
    #expect(Pill.Attention(.quiet) == nil)
    #expect(Pill.Attention(.backgroundWait) == nil)
    #expect(Pill.Attention(.backgroundWaitLong) == nil)
  }

  @Test("tree rows: an agent row takes its dot's tone and the name the tree row draws; the sentence row is nothing")
  func rowsFromTree() {
    let session = SessionRowModel(Sample.session(id: "w", state: "waiting-permission"), ordinal: 2)
    let row = Row(ProjectTreeRow.session(session))
    #expect(row == Row.session("w", tone: .waiting, name: session.treeTitle))
    #expect(session.treeTitle.hasSuffix(" #2"))
    #expect(Row(ProjectTreeRow.emptyFilter(.needsYou)) == Row(id: .emptyFilter, attention: nil, name: ""))
  }

  @Test("an unread result counts only with a pulsing dot; one marked unread by hand keeps a still dot and does not")
  func unreadOnlyWhenPulsing() {
    let summary = Sample.session(id: "u", state: "waiting-input")
    let pulsing = SessionRowModel(summary, ordinal: nil, freshResult: true)
    let still = SessionRowModel(summary, ordinal: nil, freshResult: false)
    #expect(Row(ProjectTreeRow.session(pulsing)).attention == .unread)
    #expect(Row(ProjectTreeRow.session(still)).attention == nil)
  }
}

/// The pills stand only while they leave the list room to scroll: together they cover at most half of the visible part.
@Suite("list jump pill: room left to scroll")
struct ListJumpPillFitTests {
  private typealias Pill = ListJumpPill

  private static let both = Pill.Result(
    above: Pill.Side(waiting: 1, target: "a"), below: Pill.Side(failed: 1, target: "b"))
  private static let belowOnly = Pill.Result(below: Pill.Side(failed: 1, target: "b"))

  private func fits(_ result: Pill.Result, above: CGFloat, below: CGFloat, visible: CGFloat) -> Bool {
    Pill.fits(result, pillHeights: Pill.PillHeights(above: above, below: below), visibleHeight: visible)
  }

  @Test("regular text in a tall list: both one-line pills stand")
  func regularTextTallList() {
    #expect(fits(Self.both, above: 44, below: 44, visible: 600))
    #expect(fits(Self.belowOnly, above: 44, below: 44, visible: 600))
  }

  @Test("largest text in landscape: two 125 pt pills over a 200 pt visible part go, one of them alone goes too")
  func largestTextLandscape() {
    #expect(!fits(Self.both, above: 125, below: 125, visible: 200))
    #expect(!fits(Self.belowOnly, above: 125, below: 125, visible: 200))
  }

  @Test("pills covering exactly half of the visible part stand; a half point more and they go")
  func exactlyHalf() {
    #expect(fits(Self.both, above: 50, below: 50, visible: 200))
    #expect(!fits(Self.both, above: 50, below: 50.5, visible: 200))
  }

  @Test("only the sides with a pill count: one 125 pt pill fits a 380 pt visible part, two do not")
  func onlyShownSidesCount() {
    #expect(fits(Self.belowOnly, above: 125, below: 125, visible: 380))
    #expect(!fits(Self.both, above: 125, below: 125, visible: 380))
  }

  @Test("no pill: nothing to hide, also in a visible part of no height")
  func noPill() {
    #expect(fits(.none, above: 125, below: 125, visible: 0))
  }
}
