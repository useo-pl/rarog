import Foundation

// What a collapsed card shows of an agent's message: a short text whole; a long one as its lead, the question
// block (``MarkdownQuestion``) and the number of lines hidden besides them. The lead is the agent's summary
// (``MarkdownSummary``) when one stands before the question, so a headed reply leads with its TLDR, not with its
// first heading; otherwise it is the first paragraph. A line is a source line with a visible character: blank
// lines are spacing, so they count neither towards the limit nor as hidden lines.
// One parser pass gives the blocks with their start lines, so the question block starts on the line of the block
// that ``MarkdownQuestion/start(in:)`` points at, and the work stays linear in the length of the text.
// Owner: transcript, markdown.

/// A collapsed message. `hiddenLineCount == 0` means nothing is folded: `lead` is the source untouched and
/// `question` is `nil`. Otherwise `lead` and `question` are separate markdown sources for the renderer.
public struct MarkdownFold: Sendable, Equatable {
  /// A text with at most this many lines stands whole.
  public static let wholeLineLimit = 12
  /// The lead of a text that does not start with a paragraph (a list, a heading, code).
  public static let fallbackLeadLines = 4
  /// A fold that would hide fewer lines stands whole: the "more lines" row takes as much room as it saves.
  public static let minimumHiddenLines = 2

  public var lead: String
  public var question: String?
  public var hiddenLineCount: Int

  public var isFolded: Bool { hiddenLineCount > 0 }

  public init(lead: String, question: String?, hiddenLineCount: Int) {
    self.lead = lead
    self.question = question
    self.hiddenLineCount = hiddenLineCount
  }

  public static func fold(_ source: String) -> MarkdownFold {
    let whole = MarkdownFold(lead: source, question: nil, hiddenLineCount: 0)
    let lines = MarkdownParser.lines(source)
    let content = lines.indices.filter { !isBlank(lines[$0]) }
    guard content.count > wholeLineLimit, let first = content.first, let last = content.last else { return whole }

    let (blocks, startLines) = MarkdownParser.located(lines)
    let questionIndex = MarkdownQuestion.start(in: blocks)
    let questionLine = questionIndex.map { startLines[$0] }
    let stop = questionLine ?? last + 1
    if let summary = MarkdownSummary.start(in: blocks), summary < questionIndex ?? blocks.count {
      // The summary leads wherever it stands; every other line before the question is hidden. A fold that would
      // hide too little stands whole rather than falling back to the first paragraph, which would hide the summary.
      let summaryFirst = startLines[summary]
      let summaryEnd = summary + 1 < startLines.count ? startLines[summary + 1] : lines.count
      let summaryLast = content.last { $0 < summaryEnd } ?? summaryFirst
      let hidden = content.count { $0 < stop && ($0 < summaryFirst || $0 > summaryLast) }
      guard hidden >= minimumHiddenLines else { return whole }
      return MarkdownFold(
        lead: lines[summaryFirst...summaryLast].joined(separator: "\n"),
        question: questionLine.map { lines[$0...last].joined(separator: "\n") },
        hiddenLineCount: hidden
      )
    }
    let leadLimit: Int
    if case .paragraph = blocks.first {
      leadLimit = startLines.count > 1 ? startLines[1] : lines.count
    } else {
      leadLimit = content[fallbackLeadLines - 1] + 1
    }
    // A question that starts within the lead leaves nothing between them, so the text stands whole below.
    let leadEnd = min(leadLimit, stop)
    let hidden = content.count { $0 >= leadEnd && $0 < stop }
    guard leadEnd > first, hidden >= minimumHiddenLines else { return whole }

    let leadLast = content.last { $0 < leadEnd } ?? first
    return MarkdownFold(
      lead: lines[first...leadLast].joined(separator: "\n"),
      question: questionLine.map { lines[$0...last].joined(separator: "\n") },
      hiddenLineCount: hidden
    )
  }

  private static func isBlank(_ line: String) -> Bool {
    line.allSatisfy { $0 == " " || $0 == "\t" }
  }
}
