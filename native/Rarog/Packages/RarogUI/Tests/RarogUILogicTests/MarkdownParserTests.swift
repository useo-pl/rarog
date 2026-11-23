@testable import RarogUI
import Testing

@Suite("markdown: bloki")
struct MarkdownParserTests {
  @Test("located blocks: each top-level block carries the source line it starts on")
  func locatedStartLines() {
    let source = [
      "Intro", "wrapped", "", "## Head", "- a", "- b", "  ```", "  code", "  ```", "- c", "", "> quote",
      "> more", "---", "| x | y |", "| - | - |", "| 1 | 2 |", "", "```", "**To you:** example", "```", "Tail",
    ].joined(separator: "\r\n")
    let located = MarkdownParser.located(MarkdownParser.lines(source))
    #expect(located.blocks == MarkdownParser.blocks(source))
    #expect(located.startLines == [0, 3, 4, 6, 9, 11, 13, 14, 18, 21])
  }

  @Test("akapity, nagłówki, miękkie łamanie zostaje łamaniem, wcięcie linii akapitu odpada")
  func paragraphsAndHeadings() {
    let blocks = MarkdownParser.blocks("## Diagnoza ##\n\nZapis leci\n  po rozgłoszeniu.\n\nDrugi akapit\n# Sekcja")
    #expect(blocks == [
      .heading(level: 2, text: "Diagnoza"),
      .paragraph("Zapis leci\npo rozgłoszeniu."),
      .paragraph("Drugi akapit"),
      .heading(level: 1, text: "Sekcja"),
    ])
    #expect(MarkdownParser.blocks("#hashtag i C#") == [.paragraph("#hashtag i C#")])
  }

  @Test("listy: numer startowy, ciągłość przez pustą linię (luźna pozycja), kontynuacja, zagnieżdżenie")
  func lists() {
    let blocks = MarkdownParser.blocks("3. trzy\n4. cztery\n   ciąg dalszy\n\n9. pięć\n  - pod\n    - głębiej\n- obok")
    #expect(blocks == [
      .list([
        MarkdownListItem(number: 3, depth: 0, paragraphs: ["trzy"]),
        MarkdownListItem(number: 4, depth: 0, paragraphs: ["cztery\nciąg dalszy"]),
        MarkdownListItem(number: 5, depth: 0, paragraphs: ["pięć"], loose: true),
        MarkdownListItem(depth: 1, paragraphs: ["pod"]),
        MarkdownListItem(depth: 2, paragraphs: ["głębiej"]),
        MarkdownListItem(depth: 0, paragraphs: ["obok"]),
      ]),
    ])
  }

  @Test("lista: głębszy poziom numeruje od nowa po powrocie płytszego, punktor przerywa numerację")
  func nestedNumbering() {
    let blocks = MarkdownParser.blocks("1. a\n   1. a1\n   2. a2\n2. b\n   1. b1")
    #expect(blocks == [
      .list([
        MarkdownListItem(number: 1, depth: 0, paragraphs: ["a"]),
        MarkdownListItem(number: 1, depth: 1, paragraphs: ["a1"]),
        MarkdownListItem(number: 2, depth: 1, paragraphs: ["a2"]),
        MarkdownListItem(number: 2, depth: 0, paragraphs: ["b"]),
        MarkdownListItem(number: 1, depth: 1, paragraphs: ["b1"]),
      ]),
    ])
  }

  @Test("lista: akapit po pustej linii z wcięciem należy do pozycji; bez wcięcia kończy listę")
  func listParagraphs() {
    let blocks = MarkdownParser.blocks("1. Krok\n\n   Szczegóły kroku.\n2. Dalej\n\nPo liście.")
    #expect(blocks == [
      .list([
        MarkdownListItem(number: 1, depth: 0, paragraphs: ["Krok", "Szczegóły kroku."]),
        MarkdownListItem(number: 2, depth: 0, paragraphs: ["Dalej"]),
      ]),
      .paragraph("Po liście."),
    ])
  }

  @Test("akapit i lista bez pustej linii: lista przerywa akapit, nagłówek przerywa listę")
  func interruptions() {
    let blocks = MarkdownParser.blocks("Kroki:\n- jeden\n- dwa\n## Dalej")
    #expect(blocks == [
      .paragraph("Kroki:"),
      .list([MarkdownListItem(paragraphs: ["jeden"]), MarkdownListItem(paragraphs: ["dwa"])]),
      .heading(level: 2, text: "Dalej"),
    ])
  }

  @Test("blok kodu: język, domknięcie tym samym znakiem w liczbie ≥ otwierającej")
  func fencedCode() {
    let blocks = MarkdownParser.blocks("Przed\n````ts\nlet a = 1\n```\nlet b = 2\n`````\nPo")
    #expect(blocks == [
      .paragraph("Przed"),
      .code(language: "ts", text: "let a = 1\n```\nlet b = 2", closed: true),
      .paragraph("Po"),
    ])
    #expect(MarkdownParser.blocks("~~~\n```\n~~~") == [.code(language: nil, text: "```", closed: true)])
  }

  @Test("niedomknięty blok kodu jest kodem do końca dokumentu, od razu (strumień)")
  func unclosedFence() {
    let blocks = MarkdownParser.blocks("Zmieniam:\n\n```swift\nfunc a() {\n  # nie nagłówek\n- nie lista\n| a | b |\n|---|---|")
    #expect(blocks == [
      .paragraph("Zmieniam:"),
      .code(language: "swift", text: "func a() {\n  # nie nagłówek\n- nie lista\n| a | b |\n|---|---|", closed: false),
    ])
  }

  @Test("blok kodu w pozycji listy (wcięty o 3) zdejmuje wcięcie fence'u")
  func fenceInsideList() {
    let blocks = MarkdownParser.blocks("1. Uruchom:\n   ```bash\n   npm test\n   ```\n2. Sprawdź")
    #expect(blocks == [
      .list([MarkdownListItem(number: 1, paragraphs: ["Uruchom:"])]),
      .code(language: "bash", text: "npm test", closed: true),
      .list([MarkdownListItem(number: 2, paragraphs: ["Sprawdź"])]),
    ])
  }

  @Test("blok kodu w pozycji listy nie zeruje numeracji: same „1.” dają 1 i 2")
  func fenceInsideListKeepsNumbering() {
    let numbered: [MarkdownBlock] = [
      .list([MarkdownListItem(number: 1, paragraphs: ["Uruchom:"])]),
      .code(language: "sh", text: "echo ok", closed: true),
      .list([MarkdownListItem(number: 2, paragraphs: ["Sprawdź"])]),
    ]
    #expect(MarkdownParser.blocks("1. Uruchom:\n   ```sh\n   echo ok\n   ```\n1. Sprawdź") == numbered)
    #expect(MarkdownParser.blocks("1. Uruchom:\n\n   ```sh\n   echo ok\n   ```\n\n1. Sprawdź") == numbered)
    // Za blokiem w pozycji linia bez znacznika kończy listę i zostaje akapitem.
    #expect(MarkdownParser.blocks("1. a\n   ```\n   x\n   ```\nPo") == [
      .list([MarkdownListItem(number: 1, paragraphs: ["a"])]),
      .code(language: nil, text: "x", closed: true),
      .paragraph("Po"),
    ])
    // Blok od lewego brzegu nie należy do pozycji (CommonMark): kończy listę, nowa liczy od swojego numeru.
    #expect(MarkdownParser.blocks("1. a\n```\nx\n```\n1. b") == [
      .list([MarkdownListItem(number: 1, paragraphs: ["a"])]),
      .code(language: nil, text: "x", closed: true),
      .list([MarkdownListItem(number: 1, paragraphs: ["b"])]),
    ])
  }

  @Test("linie poziome: ---, ***, ___ i ze spacjami; nie myli się z listą")
  func rules() {
    let blocks = MarkdownParser.blocks("Wstęp\n---\n* * *\n___\n- - -\nKoniec")
    #expect(blocks == [.paragraph("Wstęp"), .rule, .rule, .rule, .rule, .paragraph("Koniec")])
    #expect(MarkdownParser.blocks("--") == [.paragraph("--")])
  }

  @Test("cytat: wnętrze to bloki (lista, cytat w cytacie); linia bez > kończy cytat")
  func quotes() {
    let blocks = MarkdownParser.blocks("> **Uwaga:** to\n> - a\n>\n>> głębiej\nPo cytacie")
    #expect(blocks == [
      .quote([
        .paragraph("**Uwaga:** to"),
        .list([MarkdownListItem(paragraphs: ["a"])]),
        .quote([.paragraph("głębiej")]),
      ]),
      .paragraph("Po cytacie"),
    ])
  }

  @Test("cytat: głębokość z wejścia ma sufit, dalsze znaczniki zostają tekstem, czas liniowy")
  func deepQuotes() {
    let limit = MarkdownParser.maxQuoteDepth
    #expect(limit >= 4)
    for (marker, count) in [(">", 40_000), ("> ", 20_000)] {
      let source = String(repeating: marker, count: count) + "x"
      var paragraphs: [MarkdownParagraph] = []
      let elapsed = ContinuousClock().measure { paragraphs = MarkdownLayout.paragraphs(source) }
      #expect(elapsed < .seconds(2))
      #expect(paragraphs.map(\.quoteDepth) == [limit])
      #expect(paragraphs.first?.spans.map(\.text).joined() == String(repeating: marker, count: count - limit) + "x")
    }
    // W limicie cytat w cytacie działa jak dotąd.
    #expect(MarkdownParser.blocks(">>> c") == [.quote([.quote([.quote([.paragraph("c")])])])])
  }

  @Test("tabela GFM: wyrównania, \\| w komórce, krzywy wiersz dopełniony, koniec na linii bez kreski")
  func tables() {
    let source = "| Plik | Linie | Stan |\n|:--|--:|:-:|\n| `a\\|b` | 12 | ok |\n| c.ts | 3 |\nPo tabeli"
    let blocks = MarkdownParser.blocks(source)
    #expect(blocks == [
      .table(MarkdownTable(
        header: ["Plik", "Linie", "Stan"],
        alignments: [.left, .right, .center],
        rows: [["`a|b`", "12", "ok"], ["c.ts", "3", ""]],
        source: "| Plik | Linie | Stan |\n|:--|--:|:-:|\n| `a\\|b` | 12 | ok |\n| c.ts | 3 |")),
      .paragraph("Po tabeli"),
    ])
  }

  @Test("tabela przerywa akapit; bez delimitera o tej samej liczbie komórek kreski zostają tekstem")
  func tableBoundaries() {
    #expect(MarkdownParser.blocks("Wynik:\na | b\n--|--") == [
      .paragraph("Wynik:"),
      .table(MarkdownTable(header: ["a", "b"], alignments: [nil, nil], rows: [], source: "a | b\n--|--")),
    ])
    #expect(MarkdownParser.blocks("| a | b |\n|---|\nx") == [.paragraph("| a | b |\n|---|\nx")])
    #expect(MarkdownParser.blocks("a | b") == [.paragraph("a | b")])
  }

  @Test("nieobsłużona składnia zostaje tekstem; HTML nie jest interpretowany")
  func unsupportedStaysText() {
    let blocks = MarkdownParser.blocks("<script>x</script>\nTytuł\n===\n[^1]: przypis")
    #expect(blocks == [.paragraph("<script>x</script>\nTytuł\n===\n[^1]: przypis")])
  }

  @Test("CRLF i CR jak LF")
  func lineEndings() {
    #expect(MarkdownParser.blocks("a\r\nb\rc") == [.paragraph("a\nb\nc")])
  }

  @Test("pytanie do użytkownika: pogrubiony „Do Ciebie:” na początku akapitu najwyższego poziomu")
  func questionMarker() {
    let start = { (source: String) in MarkdownQuestion.start(in: MarkdownParser.blocks(source)) }
    #expect(start("**Do Ciebie:** wariant A czy B?") == 0)
    #expect(start("Zrobione.\n\n**Do Ciebie: wariant A czy B?**") == 1, "cała pogrubiona linia")
    #expect(start("__Do Ciebie:__ A czy B?") == 0, "pogrubienie podkreślnikami")
    #expect(start("Wstęp\n\n**Do Ciebie:** pierwsze\n\n**Do Ciebie:** drugie") == 1, "liczy się pierwszy znacznik")
    #expect(MarkdownQuestion.contains("Zrobione.\n\n**Do Ciebie:** A czy B?"))
    #expect(!MarkdownQuestion.contains("Zwykła odpowiedź bez pytania."))
    let notQuestions = [
      "```\n**Do Ciebie:** w bloku kodu\n```",
      "`**Do Ciebie:**` w kodzie w linii",
      "- **Do Ciebie:** w liście",
      "1. **Do Ciebie:** w liście numerowanej",
      "> **Do Ciebie:** w cytacie",
      "## **Do Ciebie:** w nagłówku",
      "Do Ciebie: bez pogrubienia",
      "*Do Ciebie:* kursywą",
      "**do ciebie:** małymi literami",
      "**Do Ciebie**: dwukropek poza pogrubieniem",
      "Wstęp\n**Do Ciebie:** po pojedynczym łamaniu linii",
      "**Do Ciebie\\:** dwukropek z ucieczką",
      "**Do Ciebie\\:** ucieczka, a dosłowny znacznik dalej: `Do Ciebie:`",
    ]
    for source in notQuestions {
      #expect(start(source) == nil, "\(source)")
      #expect(!MarkdownQuestion.contains(source), "\(source)")
    }
  }

  @Test("pytanie do użytkownika: angielski „To you:” z tymi samymi regułami co „Do Ciebie:”")
  func questionMarkerEnglish() {
    let start = { (source: String) in MarkdownQuestion.start(in: MarkdownParser.blocks(source)) }
    #expect(start("**To you:** option A or B?") == 0)
    #expect(start("Done.\n\n**To you: option A or B?**") == 1, "cała pogrubiona linia")
    #expect(start("__To you:__ A or B?") == 0, "pogrubienie podkreślnikami")
    #expect(start("Intro\n\n**To you:** first\n\n**Do Ciebie:** second") == 1, "liczy się pierwszy znacznik")
    #expect(start("Intro\n\n**Do Ciebie:** pierwsze\n\n**To you:** second") == 1, "liczy się pierwszy znacznik")
    #expect(MarkdownQuestion.contains("Done.\n\n**To you:** A or B?"))
    let notQuestions = [
      "```\n**To you:** in a code block\n```",
      "`**To you:**` in inline code",
      "- **To you:** in a list",
      "1. **To you:** in a numbered list",
      "> **To you:** in a quote",
      "## **To you:** in a heading",
      "To you: not bold",
      "*To you:* italic",
      "**to you:** lowercase",
      "**TO YOU:** uppercase",
      "**To you**: colon outside bold",
      "Intro\n**To you:** after a single line break",
      "**To you\\:** escaped colon",
      "**To you\\:** escaped, with a literal marker later: `To you:`",
      "**To you\\:** escaped, with the other literal marker later: `Do Ciebie:`",
    ]
    for source in notQuestions {
      #expect(start(source) == nil, "\(source)")
      #expect(!MarkdownQuestion.contains(source), "\(source)")
    }
  }
}
