import RarogUI
import Testing

// Which block is the agent's summary. The fold tests cover where the summary leads; these cover the marker forms
// and positions the fold tests do not reach. Owner: transcript, markdown.

@Suite("markdown: the summary marker")
struct MarkdownSummaryTests {
  @Test(
    "the summary block by marker form and position",
    arguments: [
      ("bold TLDR paragraph", "**TLDR:** done.", 0),
      ("bold TL;DR paragraph", "**TL;DR:** done.", 0),
      ("underscore bold", "__TLDR:__ done.", 0),
      ("whole bold line", "**TLDR: done.**", 0),
      ("in a quote", "> **TLDR:** done.", 0),
      ("after other blocks", "Intro.\n\n## Details\n\n> **TLDR:** done.", 2),
      ("the first of two counts", "Intro.\n\n**TLDR:** one.\n\n**TLDR:** two.", 1),
    ] as [(String, String, Int?)]
  )
  func summaryBlock(name: String, text: String, expected: Int?) {
    #expect(MarkdownSummary.start(in: MarkdownParser.blocks(text)) == expected, "\(name)")
  }

  @Test(
    "no summary when the marker is not a top-level bold opening",
    arguments: [
      ("not bold", "TLDR: done."),
      ("without the colon", "**TLDR** done."),
      ("lower case", "**tldr:** done."),
      ("escaped colon", "**TLDR\\:** done."),
      ("after a soft line break", "Intro,\n**TLDR:** done."),
      ("in a list item", "- **TLDR:** done."),
      ("in a heading", "## **TLDR:** done."),
      ("in a code block", "```\n**TLDR:** done.\n```"),
      ("in a quote inside a quote", "> > **TLDR:** done."),
      ("not the first block of the quote", "> Intro.\n>\n> **TLDR:** done."),
    ]
  )
  func noSummary(name: String, text: String) {
    #expect(MarkdownSummary.start(in: MarkdownParser.blocks(text)) == nil, "\(name)")
  }
}
