import RarogUI
import Testing

@Suite("markdown: collapsed card fold")
struct MarkdownFoldTests {
  /// `count` one-line paragraphs separated by blank lines, numbered from `from`.
  private func paragraphs(_ count: Int, from start: Int = 1) -> [String] {
    (start..<(start + count)).flatMap { ["Middle paragraph \($0)."] + ($0 < start + count - 1 ? [""] : []) }
  }

  private func whole(_ source: String) -> MarkdownFold {
    MarkdownFold(lead: source, question: nil, hiddenLineCount: 0)
  }

  @Test("a short text stands whole, untouched")
  func shortTextIsWhole() {
    let source = (1...8).map { "Line \($0) of a short reply." }.joined(separator: "\n") + "\n"
    let fold = MarkdownFold.fold(source)
    #expect(fold == whole(source))
    #expect(!fold.isFolded)
  }

  @Test("twelve content lines stand whole, thirteen fold; blank lines do not count")
  func lineLimitBoundary() {
    let twelve = paragraphs(12).joined(separator: "\n")
    #expect(MarkdownFold.fold(twelve) == whole(twelve))

    let thirteen = paragraphs(13).joined(separator: "\n")
    let folded = MarkdownFold(lead: "Middle paragraph 1.", question: nil, hiddenLineCount: 12)
    #expect(MarkdownFold.fold(thirteen) == folded)
  }

  @Test("a long reply with a question at the end: first paragraph, the question block, hidden lines in between")
  func longReplyWithQuestion() {
    let lead = ["Intro line one,", "continued on line two."]
    let question = ["**Do Ciebie:** merge the branch?", "Say \"merge\" and I will push it."]
    let middle = paragraphs(36, from: 1)
    let source = (lead + [""] + middle + [""] + question).joined(separator: "\n")
    #expect(source.split(separator: "\n").count == 40)

    let fold = MarkdownFold.fold(source)
    #expect(fold == MarkdownFold(
      lead: lead.joined(separator: "\n"),
      question: question.joined(separator: "\n"),
      hiddenLineCount: 36
    ))
    #expect(fold.isFolded)
  }

  @Test("the question block runs to the end of the text, past blank lines and other blocks")
  func questionBlockRunsToTheEnd() {
    let question = ["**Do Ciebie:** which option?", "", "1. keep the cache", "2. drop it", "", "Either is safe."]
    let source = (["Done with the migration."] + [""] + paragraphs(12) + [""] + question).joined(separator: "\n")
    #expect(MarkdownFold.fold(source) == MarkdownFold(
      lead: "Done with the migration.",
      question: question.joined(separator: "\n"),
      hiddenLineCount: 12
    ))
  }

  @Test("the lead paragraph ends where a heading interrupts it")
  func leadEndsAtInterruptingBlock() {
    let source = (["Short intro.", "## Details"] + paragraphs(14)).joined(separator: "\n")
    #expect(MarkdownFold.fold(source) == MarkdownFold(lead: "Short intro.", question: nil, hiddenLineCount: 15))
  }

  @Test("a marker inside a code fence is not a question block")
  func markerInCodeFenceIsNotAQuestion() {
    let fence = ["```markdown", "**To you:** an example question", "```"]
    let source = (["Here is the format."] + [""] + fence + [""] + paragraphs(12)).joined(separator: "\n")
    let fold = MarkdownFold.fold(source)
    #expect(fold.question == nil)
    #expect(fold.lead == "Here is the format.")
  }

  @Test("with a marker in a code fence and a real question later, the question starts at the real one")
  func realQuestionAfterFencedMarker() {
    let fence = ["```", "**To you:** an example question", "```"]
    let question = ["**To you:** ship it?"]
    let source = (["Here is the format."] + [""] + fence + [""] + paragraphs(12) + [""] + question)
      .joined(separator: "\n")
    #expect(MarkdownFold.fold(source) == MarkdownFold(
      lead: "Here is the format.",
      question: "**To you:** ship it?",
      hiddenLineCount: 15
    ))
  }

  @Test("a text that starts with a list leads with its first four lines")
  func listOnlyLeadsWithFourLines() {
    let items = (1...20).map { "- item \($0)" }
    let fold = MarkdownFold.fold(items.joined(separator: "\n"))
    #expect(fold == MarkdownFold(lead: items.prefix(4).joined(separator: "\n"), question: nil, hiddenLineCount: 16))
  }

  @Test("a question that starts within the four-line lead leaves nothing to fold: whole text")
  func questionWithinFourLineLeadIsWhole() {
    let items = ["- one", "- two"]
    let question = ["**Do Ciebie:** which one?"] + paragraphs(12).filter { !$0.isEmpty }
    let source = (items + [""] + question).joined(separator: "\n")
    #expect(MarkdownFold.fold(source) == whole(source))
  }

  @Test("a question in the first block leaves nothing to fold: whole text")
  func questionFirstIsWhole() {
    let source = (["**To you:** pick one of these options:", ""] + paragraphs(14)).joined(separator: "\n")
    #expect(MarkdownFold.fold(source) == whole(source))
  }

  @Test("a fold that would hide fewer than two lines stands whole")
  func tinyFoldIsWhole() {
    let lead = (1...6).map { "Lead line \($0)." }
    let question = ["**Do Ciebie:** ok?"] + (1...6).map { "Question line \($0)." }
    let oneHidden = (lead + ["", "Hidden line."] + [""] + question).joined(separator: "\n")
    #expect(MarkdownFold.fold(oneHidden) == whole(oneHidden))

    let twoHidden = (lead + ["", "Hidden one.", "", "Hidden two."] + [""] + question).joined(separator: "\n")
    #expect(MarkdownFold.fold(twoHidden) == MarkdownFold(
      lead: lead.joined(separator: "\n"),
      question: question.joined(separator: "\n"),
      hiddenLineCount: 2
    ))
  }

  @Test("CRLF line endings count as one line break")
  func crlfLineEndings() {
    let source = paragraphs(13).joined(separator: "\r\n")
    let expected = MarkdownFold(lead: "Middle paragraph 1.", question: nil, hiddenLineCount: 12)
    #expect(MarkdownFold.fold(source) == expected)
  }

  @Test("many marker lines in a long code fence: the real question after it, found in linear time")
  func manyFencedMarkersStayLinear() {
    let fence = ["```"] + Array(repeating: "**To you:** an example question", count: 20000) + ["```"]
    let source = (["Format:", ""] + fence + ["", "**Do Ciebie:** ship it?"]).joined(separator: "\n")
    let clock = ContinuousClock()
    var fold: MarkdownFold?
    // A search that re-parses the text for each marker line parses about 400 million lines here and takes over
    // a minute; one pass stays far below the budget, so the budget only catches quadratic work.
    let elapsed = clock.measure { fold = MarkdownFold.fold(source) }
    #expect(fold == MarkdownFold(lead: "Format:", question: "**Do Ciebie:** ship it?", hiddenLineCount: 20002))
    #expect(elapsed < .seconds(2))
  }

  // MARK: - The agent's summary paragraph

  @Test("a headed reply with a TLDR quote before the question: the TLDR leads, the sections fold")
  func tldrQuoteBeforeQuestionLeads() {
    let sections = [
      "## Changes", "", "Line one of the changes.", "Line two of the changes.", "Line three of the changes.", "",
      "## Checks", "", "Line one of the checks.", "Line two of the checks.", "Line three of the checks.",
      "Line four of the checks.",
    ]
    let summary = ["> **TLDR:** the fold now shows the summary,", "> and the question stays below."]
    let question = ["**Do Ciebie:**", "", "1. merge the branch?", "2. ship the build?"]
    let source = (sections + [""] + summary + [""] + question).joined(separator: "\n")
    #expect(MarkdownFold.fold(source) == MarkdownFold(
      lead: summary.joined(separator: "\n"),
      question: question.joined(separator: "\n"),
      hiddenLineCount: 9
    ))
  }

  @Test("a one-line TLDR quote leads the same way")
  func oneLineTldrQuoteLeads() {
    let summary = "> **TLDR:** a b"
    let question = ["**To you:** ship it?", "- yes", "- no"]
    let source = (["## Done"] + paragraphs(12) + ["", summary, ""] + question).joined(separator: "\n")
    #expect(MarkdownFold.fold(source) == MarkdownFold(
      lead: summary,
      question: question.joined(separator: "\n"),
      hiddenLineCount: 13
    ))
  }

  @Test("a TL;DR paragraph in the middle leads; the lines before and after it are hidden")
  func tldrParagraphInTheMiddleLeads() {
    let summary = "**TL;DR:** the summary sits in the middle."
    let source = (paragraphs(6) + ["", summary, ""] + paragraphs(6, from: 7)).joined(separator: "\n")
    #expect(MarkdownFold.fold(source) == MarkdownFold(lead: summary, question: nil, hiddenLineCount: 12))
  }

  @Test("a text that opens with a two-line TLDR quote leads with those two lines, not four")
  func openingTldrQuoteLeadsWithItsLines() {
    let summary = ["> **TLDR:** first line of the summary,", "> second line of the summary."]
    let items = (1...12).map { "- item \($0)" }
    let source = (summary + [""] + items).joined(separator: "\n")
    #expect(MarkdownFold.fold(source) == MarkdownFold(
      lead: summary.joined(separator: "\n"),
      question: nil,
      hiddenLineCount: 12
    ))
  }

  @Test("a marker that is not a summary leaves the first-paragraph fold: plain, in a list, a heading, code")
  func markerThatIsNotASummaryKeepsTheFold() {
    let lead = ["Intro.", ""]
    let before = paragraphs(6)
    let after = paragraphs(6, from: 7)
    for (name, marker) in [
      ("not bold", ["TLDR: plain text."]),
      ("in a list item", ["- **TLDR:** inside a list."]),
      ("in a heading", ["## **TLDR:** inside a heading"]),
    ] {
      let source = (lead + before + [""] + marker + [""] + after).joined(separator: "\n")
      #expect(
        MarkdownFold.fold(source) == MarkdownFold(lead: "Intro.", question: nil, hiddenLineCount: 13), "\(name)")
    }
    let fence = ["```markdown", "**TLDR:** an example summary", "```"]
    let fenced = (lead + before + [""] + fence + [""] + after).joined(separator: "\n")
    #expect(MarkdownFold.fold(fenced) == MarkdownFold(lead: "Intro.", question: nil, hiddenLineCount: 15))
  }

  @Test("a TLDR inside the question block leaves the first-paragraph fold")
  func tldrAfterQuestionKeepsTheFold() {
    let question = ["**Do Ciebie:** ok?", "", "> **TLDR:** written after the question."]
    let source = (["Intro.", ""] + paragraphs(12) + [""] + question).joined(separator: "\n")
    #expect(MarkdownFold.fold(source) == MarkdownFold(
      lead: "Intro.",
      question: question.joined(separator: "\n"),
      hiddenLineCount: 12
    ))
  }

  @Test("a short text with a TLDR stands whole")
  func shortTextWithTldrIsWhole() {
    let source = (paragraphs(10) + ["", "> **TLDR:** short."]).joined(separator: "\n")
    #expect(MarkdownFold.fold(source) == whole(source))
  }

  @Test("a TLDR fold that would hide fewer than two lines stands whole, so the summary is never hidden")
  func tinyTldrFoldIsWhole() {
    let question = ["**Do Ciebie:** ok?"] + (1...10).map { "Question line \($0)." }
    let source = (["Intro.", "", "> **TLDR:** one,", "> two.", ""] + question).joined(separator: "\n")
    #expect(MarkdownFold.fold(source) == whole(source))
  }
}
