import Foundation
import RarogUI
import Testing

@Suite("markdown: układ renderera")
struct MarkdownLayoutTests {
  private func kinds(_ source: String) -> [MarkdownParagraphKind] {
    MarkdownLayout.paragraphs(source).map(\.kind)
  }

  private func gaps(_ source: String) -> [MarkdownGap] {
    MarkdownLayout.paragraphs(source).map(\.gap)
  }

  @Test("odstęp po liście: akapit nie klei się do listy numerowanej, pozycje stoją ciasno")
  func gapAfterList() {
    #expect(gaps("1. a\n2. b\nAkapit po liście? Nie — kontynuacja.\n\nAkapit") == [.none, .item, .paragraph])
    #expect(gaps("Wstęp:\n\n1. a\n2. b\n\nPo liście") == [.none, .paragraph, .item, .paragraph])
    #expect(MarkdownGap.paragraph.em > MarkdownGap.item.em * 2)
  }

  @Test("nagłówek po wypunktowaniu dostaje dużo powietrza od góry, mało od dołu")
  func gapAroundHeadings() {
    #expect(gaps("- a\n- b\n\n## Sekcja\nTreść\n### Podsekcja\n#### Niżej") == [
      .none, .item, .section, .paragraph, .section, .paragraph,
    ])
    #expect(MarkdownGap.section.em > MarkdownGap.paragraph.em * 2)
  }

  @Test("bloki z tłem lub obrysem mają większy odstęp z obu stron; linie kodu bez odstępu")
  func gapAroundFramedBlocks() {
    let paragraphs = MarkdownLayout.paragraphs("Tekst\n```\na\nb\n```\nPo\n\n---\n\n> cytat\n\nKoniec")
    #expect(paragraphs.map(\.gap) == [.none, .block, .none, .none, .block, .block, .block, .block])
    #expect(paragraphs.map(\.quoteDepth) == [0, 0, 0, 0, 0, 0, 1, 0])
  }

  @Test("odstęp nad kolejną wiadomością tego samego głosu: jak wewnątrz tekstu, po zwykłym akapicie")
  func leadGap() {
    #expect(MarkdownLayout.leadGap(MarkdownLayout.paragraphs("## Sekcja\nTreść")) == .section)
    #expect(MarkdownLayout.leadGap(MarkdownLayout.paragraphs("Zmieniam kolejność:")) == .paragraph)
    #expect(MarkdownLayout.leadGap(MarkdownLayout.paragraphs("1. a")) == .paragraph)
    #expect(MarkdownLayout.leadGap(MarkdownLayout.paragraphs("```\nx\n```")) == .block)
    #expect(MarkdownLayout.leadGap(MarkdownLayout.paragraphs("> cytat")) == .block)
    #expect(MarkdownLayout.leadGap([]) == .none)
  }

  @Test("hierarchia nagłówków: # i ## większe od treści, ### o włos, #### tylko wagą")
  func headingScale() {
    let scales = (1...6).map(MarkdownLayout.headingScale)
    #expect(scales[0] > scales[1] && scales[1] > scales[2] && scales[2] > scales[3])
    #expect(scales[0] >= 1.3 && scales[1] >= 1.15)
    #expect(scales[3...].allSatisfy { $0 == 1 })
    #expect(kinds("# A\n###### F") == [.heading(level: 1), .heading(level: 6)])
  }

  @Test("znaczniki list: numer ze źródła, punktor wg głębokości; kopia jako markdown z wcięciem")
  func listMarkers() {
    let paragraphs = MarkdownLayout.paragraphs("7. siedem\n   - pod\n     - głębiej\n\n   dalszy akapit")
    #expect(paragraphs.map(\.kind) == [
      .listItem(marker: "7.", depth: 0, ordered: true),
      .listItem(marker: "◦", depth: 1, ordered: false),
      .listItem(marker: "▪", depth: 2, ordered: false),
      .listParagraph(depth: 2),
    ])
    #expect(paragraphs.map(\.gap) == [.none, .item, .item, .paragraph])
    #expect(MarkdownLayout.copiedMarker(paragraphs[0].kind) == "7. ")
    #expect(MarkdownLayout.copiedMarker(paragraphs[2].kind) == "    - ")
    #expect(MarkdownLayout.copiedMarker(.text) == nil)
  }

  @Test("blok kodu: pasek z językiem tylko dla znanego języka, linie kodu z pozycją i bez emfazy")
  func codeBlocks() {
    #expect(kinds("```swift\nlet a = **1**\n\nlet b\n```") == [
      .codeBar(language: "swift", code: "let a = **1**\n\nlet b"),
      .codeLine(first: true, last: false), .codeLine(first: false, last: false), .codeLine(first: false, last: true),
    ])
    let lines = MarkdownLayout.paragraphs("```wynik\nok\n```")
    #expect(lines.map(\.kind) == [.codeBar(language: nil, code: "ok"), .codeLine(first: true, last: true)])
    #expect(lines[1].spans == [MarkdownSpan("ok", .code)])
    // Strumień: otwarty fence od razu jest blokiem z paskiem (ikona kopiowania kopiuje to, co już jest).
    #expect(kinds("```ts\nconst") == [.codeBar(language: "ts", code: "const"), .codeLine(first: true, last: true)])
  }

  @Test("cytat w cytacie i lista w cytacie niosą głębokość; tabela zostaje jednym akapitem")
  func quotesAndTables() {
    let paragraphs = MarkdownLayout.paragraphs("> a\n> - b\n>> c\n\n| x | y |\n|---|---|\n| 1 | 2 |")
    #expect(paragraphs.map(\.quoteDepth) == [1, 1, 2, 0])
    guard case let .table(table) = paragraphs[3].kind else {
      Issue.record("tabela")
      return
    }
    #expect(table.rows == [["1", "2"]])
    #expect(MarkdownLayout.spokenTable(table) == "Tabela, 1\u{00A0}wiersz: x, y; 1, 2")
  }

  @Test("pytanie do użytkownika: akapity od znacznika do końca tekstu — lista, kod, tabela, cytat")
  func questionArea() {
    let source = """
      Zrobione.

      **Do Ciebie:** który wariant?

      1. A
      2. B

      ```sh
      ls
      ```

      | a | b |
      |---|---|
      | 1 | 2 |

      > cytat
      """
    let asked = MarkdownLayout.paragraphs(source, questions: true)
    #expect(asked.map(\.question) == [false, true, true, true, true, true, true, true])
    #expect(asked.last?.quoteDepth == 1)
    // Poza `question` układ jest ten sam co bez rozpoznawania: rytm odstępów, role, cytat.
    let plain = MarkdownLayout.paragraphs(source)
    #expect(plain.allSatisfy { !$0.question })
    #expect(asked.map { paragraph in
      var copy = paragraph
      copy.question = false
      return copy
    } == plain)
  }

  @Test("bez parametru rozpoznawania nic się nie zmienia; bez znacznika nie ma pytania")
  func questionRecognitionOff() {
    #expect(MarkdownLayout.paragraphs("**Do Ciebie:** A czy B?").map(\.question) == [false])
    #expect(MarkdownLayout.paragraphs(blocks: MarkdownParser.blocks("**Do Ciebie:** A czy B?")).map(\.question) == [false])
    #expect(MarkdownLayout.paragraphs("**Do Ciebie:** A czy B?", questions: true).map(\.question) == [true])
    #expect(MarkdownLayout.paragraphs("Zwykły akapit\n\n- lista", questions: true).map(\.question) == [false, false])
    #expect(MarkdownLayout.paragraphs("> **Do Ciebie:** w cytacie\n\nPo", questions: true).map(\.question) == [false, false])

    #expect(MarkdownLayout.paragraphs("**To you:** A or B?").map(\.question) == [false])
    #expect(MarkdownLayout.paragraphs("Done.\n\n**To you:** A or B?\n\n- A\n- B", questions: true).map(\.question)
      == [false, true, true, true])
    #expect(MarkdownLayout.paragraphs("> **To you:** in a quote\n\nAfter", questions: true).map(\.question)
      == [false, false])
  }

  @Test("tabela: kolumna szeroka jak najszersza komórka, ale nie szersza niż sufit (wtedy zawija)")
  func tableColumns() {
    let widths = MarkdownTableGeometry.columnWidths(natural: [[40, 120.2], [80, 2_000]], available: 600)
    #expect(widths == [80, MarkdownTableGeometry.columnCap(available: 600)])
    #expect(MarkdownTableGeometry.columnCap(available: 600) < 600)
    #expect(MarkdownTableGeometry.columnCap(available: 200) == 220)
    #expect(MarkdownTableGeometry.columnWidths(natural: [[10], [20, 30]], available: 600) == [20, 30])
  }

  @Test("tekst do schowka: zastępstwa (znacznik, linia, tabela, pasek) zamiast znaków układu")
  func plainText() {
    let text = NSMutableAttributedString()
    text.append(NSAttributedString(string: "1.\t", attributes: [.rarogReplacement: MarkdownReplacement(copy: "1. ")]))
    text.append(NSAttributedString(string: "Krok\u{2028}dalej\n"))
    text.append(NSAttributedString(string: "\u{00A0}\n", attributes: [.rarogReplacement: MarkdownReplacement(copy: "---\n", spoken: "")]))
    text.append(NSAttributedString(string: "swift\n", attributes: [.rarogReplacement: MarkdownReplacement(copy: "")]))
    text.append(NSAttributedString(string: " \n", attributes: [.rarogReplacement: MarkdownReplacement(copy: "\n")]))
    text.append(NSAttributedString(string: " \n", attributes: [.rarogReplacement: MarkdownReplacement(copy: "\n")]))
    text.append(NSAttributedString(string: "\u{FFFC}", attributes: [.rarogReplacement: MarkdownReplacement(copy: "| a |", spoken: "Tabela")]))
    #expect(MarkdownPlainText.copy(text) == "1. Krok\ndalej\n---\n\n\n| a |")
    #expect(MarkdownPlainText.spoken(text) == "1. Krok\ndalej\n\n\nTabela")
    // Fragment zaznaczenia: z zastępstwa idzie całość, nawet gdy zaznaczona jest jego część.
    #expect(MarkdownPlainText.copy(text.attributedSubstring(from: NSRange(location: 1, length: 5))) == "1. Kro")
  }
}
