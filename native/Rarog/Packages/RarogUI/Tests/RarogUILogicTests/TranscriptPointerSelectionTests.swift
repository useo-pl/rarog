import CoreGraphics
import Foundation
@testable import RarogUI
import Testing

// Pointer selection across transcript rows as a pure model: order of the anchor and the focus, snapping of a focus
// over a card or a gap, the copy text ("what is highlighted"), revalidation against a new snapshot of rows (including
// the streaming answer that closes into a message row) and the speed curve of the edge autoscroll.
@Suite("transcript pointer selection")
struct TranscriptPointerSelectionTests {
  // MARK: - Fixtures

  static func text(_ id: String, _ message: Int?, _ string: String) -> TranscriptSelectionRow {
    .text(id: id, message: message, text: NSAttributedString(string: string))
  }

  static func other(_ id: String, _ message: Int? = nil) -> TranscriptSelectionRow {
    .other(id: id, message: message)
  }

  static func point(_ row: String, _ offset: Int) -> TranscriptTextPoint {
    TranscriptTextPoint(row: row, offset: offset)
  }

  /// A transcript of three messages with a tool between two text blocks of the first, a card, then the streaming
  /// answer and a queued prompt.
  static func rows() -> [TranscriptSelectionRow] {
    [
      text("m3.0", 3, "Alpha beta gamma delta"),
      other("m3.1", 3),
      text("m3.2", 3, "Second block here"),
      text("m4.0", 4, "Middle message"),
      text("m4.1", 4, "Its second paragraph"),
      text("m5.0", 5, "Last message text"),
      other("pP1"),
      text("m7.0", 7, "Before the stream"),
      text("open", nil, "Streaming answer so far"),
      text("o11111111-2222-3333-4444-555555555555", nil, "Queued prompt"),
      text("o66666666-7777-8888-9999-000000000000", nil, "Another queued one"),
    ]
  }

  static func select(
    _ anchor: TranscriptTextPoint, _ focus: TranscriptTextPoint, in rows: [TranscriptSelectionRow] = rows()
  ) -> TranscriptPointerSelection {
    var selection = TranscriptPointerSelection(at: anchor, in: rows)!
    selection.extend(to: .text(focus), in: rows)
    return selection
  }

  // MARK: - Copy text: the contract table

  @Test("within one row the copy is the substring between the two points")
  func copyWithinOneRow() {
    #expect(Self.select(Self.point("m3.0", 6), Self.point("m3.0", 16)).copyText(in: Self.rows()) == "beta gamma")
  }

  @Test("rows of the same message join with one newline and the tool between them stays out")
  func copyAcrossToolInOneMessage() {
    let copy = Self.select(Self.point("m3.0", 17), Self.point("m3.2", 6)).copyText(in: Self.rows())
    #expect(copy == "delta\nSecond")
  }

  @Test("rows of different messages join with an empty line and a whole middle message is copied")
  func copyAcrossThreeMessages() {
    let copy = Self.select(Self.point("m3.2", 7), Self.point("m5.0", 4)).copyText(in: Self.rows())
    #expect(copy == "block here\n\nMiddle message\nIts second paragraph\n\nLast")
  }

  @Test("a message row and the streaming answer join with an empty line")
  func copyIntoStreamingAnswer() {
    let copy = Self.select(Self.point("m7.0", 11), Self.point("open", 9)).copyText(in: Self.rows())
    #expect(copy == "stream\n\nStreaming")
  }

  @Test("a card between two messages stays out of the copy")
  func copySkipsCard() {
    let copy = Self.select(Self.point("m5.0", 5), Self.point("m7.0", 6)).copyText(in: Self.rows())
    #expect(copy == "message text\n\nBefore")
  }

  @Test("a queued prompt copies alone, and two queued prompts are two messages")
  func copyQueuedPrompts() {
    let first = "o11111111-2222-3333-4444-555555555555"
    let second = "o66666666-7777-8888-9999-000000000000"
    #expect(Self.select(Self.point(first, 0), Self.point(first, 6)).copyText(in: Self.rows()) == "Queued")
    #expect(Self.select(Self.point(first, 7), Self.point(second, 7)).copyText(in: Self.rows()) == "prompt\n\nAnother")
  }

  @Test("a focus before the anchor copies the same text as after swapping them")
  func copyBackwards() {
    let forward = Self.select(Self.point("m3.2", 7), Self.point("m5.0", 4))
    let backward = Self.select(Self.point("m5.0", 4), Self.point("m3.2", 7))
    #expect(backward.copyText(in: Self.rows()) == forward.copyText(in: Self.rows()))
    #expect(backward.ordered(in: Self.rows())?.start == Self.point("m3.2", 7))
    #expect(backward.ordered(in: Self.rows())?.end == Self.point("m5.0", 4))
  }

  @Test("anchor equal to focus has no copy")
  func emptySelectionHasNoCopy() {
    let selection = TranscriptPointerSelection(at: Self.point("m3.0", 5), in: Self.rows())!
    #expect(selection.isEmpty)
    #expect(selection.copyText(in: Self.rows()) == nil)
    #expect(selection.ranges(in: Self.rows()).isEmpty)
  }

  @Test("an anchor at the end of a row adds no leading separator, and nothing highlighted means no copy")
  func anchorAtRowEnd() {
    let end = ("Alpha beta gamma delta" as NSString).length
    #expect(Self.select(Self.point("m3.0", end), Self.point("m3.2", 6)).copyText(in: Self.rows()) == "Second")
    let nothing = Self.select(Self.point("m3.0", end), Self.point("m3.2", 0))
    #expect(!nothing.isEmpty)
    #expect(nothing.copyText(in: Self.rows()) == nil)
  }

  @Test("an emoji or a combining mark on a boundary is taken whole, never split")
  func composedCharactersStayWhole() {
    // "a👍b e\u{301}x": the emoji is two UTF-16 units at 1..<3, "e\u{301}" one character of two units at 5..<7.
    let rows = [Self.text("m1.0", 1, "a👍b e\u{301}x")]
    #expect(Self.select(Self.point("m1.0", 2), Self.point("m1.0", 4), in: rows).copyText(in: rows) == "👍b")
    #expect(Self.select(Self.point("m1.0", 3), Self.point("m1.0", 6), in: rows).copyText(in: rows) == "b e\u{301}")
    #expect(Self.select(Self.point("m1.0", 6), Self.point("m1.0", 2), in: rows).ranges(in: rows) == [
      TranscriptSelectedRange(row: "m1.0", range: NSRange(location: 1, length: 6)),
    ])
  }

  @Test("the copy goes through the plain text of the rendered row: a table object copies as its replacement")
  func copyUsesRenderedReplacements() {
    let rendered = NSMutableAttributedString(string: "Intro\u{2028}line \u{FFFC} after")
    let object = (rendered.string as NSString).range(of: "\u{FFFC}")
    rendered.addAttribute(.rarogReplacement, value: MarkdownReplacement(copy: "| A |\n|---|\n| 1 |"), range: object)
    let rows: [TranscriptSelectionRow] = [
      .text(id: "m2.0", message: 2, text: rendered), Self.text("m3.0", 3, "Next"),
    ]
    let copy = Self.select(Self.point("m2.0", 0), Self.point("m3.0", 4), in: rows).copyText(in: rows)
    #expect(copy == "Intro\nline | A |\n|---|\n| 1 | after\n\nNext")
  }

  // MARK: - Highlight ranges

  @Test("highlight ranges come per text row in list order, cards and empty edges excluded")
  func highlightRanges() {
    let ranges = Self.select(Self.point("m5.0", 5), Self.point("m3.2", 7)).ranges(in: Self.rows())
    #expect(ranges == [
      TranscriptSelectedRange(row: "m3.2", range: NSRange(location: 7, length: 10)),
      TranscriptSelectedRange(row: "m4.0", range: NSRange(location: 0, length: 14)),
      TranscriptSelectedRange(row: "m4.1", range: NSRange(location: 0, length: 20)),
      TranscriptSelectedRange(row: "m5.0", range: NSRange(location: 0, length: 5)),
    ])
  }

  // MARK: - Start

  @Test("a selection starts only on a text row known to the snapshot, offset clamped to the text")
  func startOnlyOnTextRow() {
    #expect(TranscriptPointerSelection(at: Self.point("m3.1", 0), in: Self.rows()) == nil)
    #expect(TranscriptPointerSelection(at: Self.point("pP1", 0), in: Self.rows()) == nil)
    #expect(TranscriptPointerSelection(at: Self.point("m99.0", 0), in: Self.rows()) == nil)
    let clamped = TranscriptPointerSelection(at: Self.point("m4.0", 500), in: Self.rows())
    #expect(clamped?.anchor == Self.point("m4.0", 14))
    #expect(clamped?.focus == Self.point("m4.0", 14))
  }

  // MARK: - Snapping of the focus

  @Test("a focus over a card after the anchor stands at the end of the nearest earlier text row")
  func snapOverCardAfterAnchor() {
    var selection = TranscriptPointerSelection(at: Self.point("m3.0", 6), in: Self.rows())!
    selection.extend(to: .row("pP1"), in: Self.rows())
    #expect(selection.focus == Self.point("m5.0", 17))
  }

  @Test("a focus over a card before the anchor stands at the start of the nearest later text row")
  func snapOverCardBeforeAnchor() {
    var selection = TranscriptPointerSelection(at: Self.point("open", 4), in: Self.rows())!
    selection.extend(to: .row("pP1"), in: Self.rows())
    #expect(selection.focus == Self.point("m7.0", 0))
  }

  @Test("a focus over a tool inside the anchor's message snaps by the same rule in both directions")
  func snapOverToolInMessage() {
    var after = TranscriptPointerSelection(at: Self.point("m3.0", 6), in: Self.rows())!
    after.extend(to: .row("m3.1"), in: Self.rows())
    #expect(after.focus == Self.point("m3.0", 22))
    var before = TranscriptPointerSelection(at: Self.point("m4.0", 3), in: Self.rows())!
    before.extend(to: .row("m3.1"), in: Self.rows())
    #expect(before.focus == Self.point("m3.2", 0))
  }

  @Test("a focus in the gap right below or right above the anchor row snaps to that row's end or the next start")
  func snapInGaps() {
    var below = TranscriptPointerSelection(at: Self.point("m4.0", 3), in: Self.rows())!
    below.extend(to: .gap(after: "m4.0"), in: Self.rows())
    #expect(below.focus == Self.point("m4.0", 14))
    var above = TranscriptPointerSelection(at: Self.point("m4.0", 3), in: Self.rows())!
    above.extend(to: .gap(after: "m3.2"), in: Self.rows())
    #expect(above.focus == Self.point("m4.0", 0))
    var overCard = TranscriptPointerSelection(at: Self.point("m3.0", 3), in: Self.rows())!
    overCard.extend(to: .gap(after: "pP1"), in: Self.rows())
    #expect(overCard.focus == Self.point("m5.0", 17))
  }

  @Test("above all rows the focus stands at the start of the first text row, below them at the end of the last")
  func snapBeyondRows() {
    let rows = [Self.other("m1.0", 1), Self.text("m1.1", 1, "First"), Self.text("m2.0", 2, "Last"), Self.other("pX")]
    var selection = TranscriptPointerSelection(at: Self.point("m2.0", 2), in: rows)!
    selection.extend(to: .aboveRows, in: rows)
    #expect(selection.focus == Self.point("m1.1", 0))
    selection.extend(to: .belowRows, in: rows)
    #expect(selection.focus == Self.point("m2.0", 4))
  }

  @Test("a text point on a row that is not text snaps like that row; an unknown row leaves the focus")
  func textPointOnOtherRow() {
    var selection = TranscriptPointerSelection(at: Self.point("m3.0", 6), in: Self.rows())!
    selection.extend(to: .text(Self.point("pP1", 3)), in: Self.rows())
    #expect(selection.focus == Self.point("m5.0", 17))
    selection.extend(to: .row("gone"), in: Self.rows())
    #expect(selection.focus == Self.point("m5.0", 17))
  }

  // MARK: - New snapshot

  @Test("a snapshot that keeps the text up to both points keeps the selection, also when the text grows")
  func revalidateKeepsGrowingText() {
    let selection = Self.select(Self.point("m7.0", 7), Self.point("open", 9))
    var rows = Self.rows()
    rows[8] = Self.text("open", nil, "Streaming answer so far, and more")
    let kept = selection.validated(in: rows)
    #expect(kept?.anchor == selection.anchor)
    #expect(kept?.focus == selection.focus)
  }

  @Test("the selection disappears when the anchor row disappears or stops being text")
  func revalidateAnchorRowGone() {
    let selection = Self.select(Self.point("m4.0", 3), Self.point("m5.0", 4))
    var removed = Self.rows()
    removed.remove(at: 3)
    #expect(selection.validated(in: removed) == nil)
    var retyped = Self.rows()
    retyped[3] = Self.other("m4.0", 4)
    #expect(selection.validated(in: retyped) == nil)
  }

  @Test("the selection disappears when the text of the anchor row before its offset changes")
  func revalidateAnchorTextChanged() {
    let selection = Self.select(Self.point("open", 12), Self.point("m7.0", 3))
    var shortened = Self.rows()
    // A closing link re-renders the streaming answer shorter than the stored offset.
    shortened[8] = Self.text("open", nil, "Streaming")
    #expect(selection.validated(in: shortened) == nil)
    var edited = Self.rows()
    edited[8] = Self.text("open", nil, "Streamed answer so far")
    #expect(selection.validated(in: edited) == nil)
  }

  @Test("the selection disappears when the focus row loses its text")
  func revalidateFocusGone() {
    let selection = Self.select(Self.point("m3.0", 3), Self.point("m5.0", 8))
    var rows = Self.rows()
    rows[5] = Self.text("m5.0", 5, "Last")
    #expect(selection.validated(in: rows) == nil)
  }

  @Test("the streaming answer closing into a message row moves the point when the new row starts with the same text")
  func revalidateMovesOpenToClosedRow() {
    let selection = Self.select(Self.point("m7.0", 11), Self.point("open", 9))
    var closed = Array(Self.rows()[0 ..< 8])
    closed += [
      Self.text("m8.0", 8, "Streaming answer so far, finished."),
      Self.other("m8.1", 8),
      Self.text("m8.2", 8, "After the tool"),
    ]
    closed += Self.rows()[9...]
    let moved = selection.validated(in: closed)
    #expect(moved?.anchor == Self.point("m7.0", 11))
    #expect(moved?.focus == Self.point("m8.0", 9))
    #expect(moved?.copyText(in: closed) == "stream\n\nStreaming")
  }

  @Test("an anchor at the start of the streaming answer moves to the first text row of the new message")
  func revalidateMovesOpenStart() {
    let selection = Self.select(Self.point("open", 0), Self.point("open", 9))
    var closed = Array(Self.rows()[0 ..< 8])
    closed += [Self.other("m8.0", 8), Self.text("m8.1", 8, "Streaming answer so far.")]
    let moved = selection.validated(in: closed)
    #expect(moved?.anchor == Self.point("m8.1", 0))
    #expect(moved?.focus == Self.point("m8.1", 9))
  }

  @Test("the streaming answer closing into a row with other text drops the selection")
  func revalidateOpenClosedDifferently() {
    let selection = Self.select(Self.point("m7.0", 11), Self.point("open", 9))
    var closed = Array(Self.rows()[0 ..< 8])
    closed += [Self.text("m8.0", 8, "Streamed differently")]
    #expect(selection.validated(in: closed) == nil)
  }

  @Test("a vanished streaming answer never moves onto a message that was already on screen")
  func revalidateOpenIgnoresOlderMessages() {
    let selection = Self.select(Self.point("open", 0), Self.point("open", 9))
    let withoutOpen = Self.rows().filter { $0.id != "open" }
    #expect(selection.validated(in: withoutOpen) == nil)
  }

  @Test("a message that arrived while the answer still streamed is not taken for the closed answer")
  func revalidateOpenIgnoresMessageSeenWhileStreaming() {
    let selection = Self.select(Self.point("open", 0), Self.point("open", 9))
    var streaming = Self.rows()
    streaming.insert(Self.text("m8.0", 8, "Streaming answer elsewhere"), at: 8)
    let kept = selection.validated(in: streaming)
    #expect(kept != nil)
    var closed = streaming.filter { $0.id != "open" }
    closed.insert(Self.text("m9.0", 9, "Streaming answer so far"), at: 9)
    let moved = kept?.validated(in: closed)
    #expect(moved?.anchor == Self.point("m9.0", 0))
    #expect(moved?.focus == Self.point("m9.0", 9))
  }

  @Test("both points on the streaming answer move onto the same closed row, even after an unrelated new message")
  func revalidateMovesBothOpenPointsTogether() {
    let selection = Self.select(Self.point("open", 0), Self.point("open", 9))
    var closed = Array(Self.rows()[0 ..< 8])
    closed += [Self.text("m8.0", 8, "Unrelated prompt"), Self.text("m9.0", 9, "Streaming answer so far.")]
    let moved = selection.validated(in: closed)
    #expect(moved?.anchor == Self.point("m9.0", 0))
    #expect(moved?.focus == Self.point("m9.0", 9))
    #expect(moved?.copyText(in: closed) == "Streaming")
  }

  @Test("a drag over a snapshot that lost the anchor row changes nothing, and validation still moves the point")
  func extendWithoutAnchorRowKeepsState() {
    let selection = Self.select(Self.point("open", 4), Self.point("open", 9))
    var closed = Array(Self.rows()[0 ..< 8])
    closed += [Self.text("m8.0", 8, "Streaming answer so far.")]
    var dragged = selection
    dragged.extend(to: .belowRows, in: closed)
    #expect(dragged == selection)
    #expect(dragged.validated(in: closed)?.anchor == Self.point("m8.0", 4))
  }

  @Test("a snapshot with the closed answer and a new streaming answer moves the point onto the closed row")
  func revalidateClosedAnswerWithNewStream() {
    let selection = Self.select(Self.point("m7.0", 11), Self.point("open", 3))
    var next = Array(Self.rows()[0 ..< 8])
    next += [Self.text("m8.0", 8, "Streaming answer so far."), Self.text("open", nil, "Next")]
    let moved = selection.validated(in: next)
    #expect(moved?.focus == Self.point("m8.0", 3))
    #expect(moved?.copyText(in: next) == "stream\n\nStr")
  }

  @Test("a point at the start of the streaming answer stays off a new streaming answer and moves onto the closed row")
  func revalidateOpenStartWithNewStream() {
    let queued = "o11111111-2222-3333-4444-555555555555"
    let selection = Self.select(Self.point("open", 0), Self.point(queued, 6))
    var next = Array(Self.rows()[0 ..< 8])
    next += [Self.text("m8.0", 8, "Streaming answer so far."), Self.text("open", nil, "Next")]
    next += Self.rows()[9...]
    let moved = selection.validated(in: next)
    #expect(moved?.anchor == Self.point("m8.0", 0))
    #expect(moved?.copyText(in: next) == "Streaming answer so far.\n\nNext\n\nQueued")
  }

  @Test("a point at the start of the streaming answer skips a newer unrelated message for the closed answer")
  func revalidateOpenStartSkipsUnrelatedMessage() {
    let queued = "o11111111-2222-3333-4444-555555555555"
    let selection = Self.select(Self.point("open", 0), Self.point(queued, 6))
    var next = Array(Self.rows()[0 ..< 8])
    next += [Self.text("m8.0", 8, "Unrelated prompt"), Self.text("m9.0", 9, "Streaming answer so far")]
    next += Self.rows()[9...]
    let moved = selection.validated(in: next)
    #expect(moved?.anchor == Self.point("m9.0", 0))
    #expect(moved?.copyText(in: next) == "Streaming answer so far\n\nQueued")
  }

  // MARK: - Autoscroll speed

  @Test("autoscroll speed is zero at the inner boundary of the band and inside the list")
  func autoscrollZeroInside() {
    #expect(TranscriptPointerSelection.autoscrollSpeed(depth: 0) == 0)
    #expect(TranscriptPointerSelection.autoscrollSpeed(depth: -100) == 0)
  }

  @Test("autoscroll speed grows through the band and past the edge, without a jump at the edge, up to a ceiling")
  func autoscrollCurve() {
    let band = TranscriptPointerSelection.autoscrollBand
    let depths = stride(from: 1.0, through: 400.0, by: 1.0).map { CGFloat($0) }
    let speeds = depths.map(TranscriptPointerSelection.autoscrollSpeed(depth:))
    #expect(zip(speeds, speeds.dropFirst()).allSatisfy { $0 <= $1 })
    #expect(speeds[0] > 0)
    let atEdge = TranscriptPointerSelection.autoscrollSpeed(depth: band)
    #expect(TranscriptPointerSelection.autoscrollSpeed(depth: band + 20) > atEdge)
    let justInside = TranscriptPointerSelection.autoscrollSpeed(depth: band - 0.5)
    let justOutside = TranscriptPointerSelection.autoscrollSpeed(depth: band + 0.5)
    #expect(justOutside - justInside < TranscriptPointerSelection.autoscrollCeiling / 100)
    let far = TranscriptPointerSelection.autoscrollSpeed(depth: 100_000)
    #expect(far == TranscriptPointerSelection.autoscrollCeiling)
    #expect(speeds.allSatisfy { $0 <= far })
  }

  @Test("autoscroll velocity is negative toward the top edge, positive toward the bottom, zero in the middle")
  func autoscrollVelocity() {
    let band = TranscriptPointerSelection.autoscrollBand
    func velocity(_ y: CGFloat) -> CGFloat {
      TranscriptPointerSelection.autoscrollVelocity(pointer: y, top: 100, bottom: 900)
    }
    #expect(velocity(500) == 0)
    #expect(velocity(100 + band) == 0)
    #expect(velocity(900 - band) == 0)
    #expect(velocity(110) < 0)
    #expect(velocity(40) < velocity(110))
    #expect(velocity(890) > 0)
    #expect(velocity(960) > velocity(890))
    #expect(velocity(110) == -velocity(890))
  }

  @Test("in a list shorter than two bands the nearer edge decides the direction")
  func autoscrollShortList() {
    func velocity(_ y: CGFloat) -> CGFloat {
      TranscriptPointerSelection.autoscrollVelocity(pointer: y, top: 0, bottom: 60)
    }
    #expect(velocity(10) < 0)
    #expect(velocity(50) > 0)
    #expect(velocity(30) == 0)
  }
}
