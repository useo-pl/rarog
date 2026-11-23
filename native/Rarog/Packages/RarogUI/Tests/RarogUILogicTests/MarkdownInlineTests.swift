import Foundation
import RarogUI
import Testing

@Suite("markdown: w linii i linki")
struct MarkdownInlineTests {
  private func spans(_ text: String) -> [MarkdownSpan] {
    MarkdownInlineParser.spans(text)
  }

  @Test("kod w linii: zgodna liczba apostrofów, niedomknięty zostaje tekstem, treść bez markdownu")
  func inlineCode() {
    #expect(spans("Parser w `src/dates.ts` i `**nie pogrubione**`") == [
      MarkdownSpan("Parser w "), MarkdownSpan("src/dates.ts", .code), MarkdownSpan(" i "),
      MarkdownSpan("**nie pogrubione**", .code),
    ])
    #expect(spans("``a ` b`` i `otwarte") == [MarkdownSpan("a ` b", .code), MarkdownSpan(" i `otwarte")])
    #expect(spans("`` `x` ``") == [MarkdownSpan("`x`", .code)])
  }

  @Test("pogrubienie, kursywa, oba naraz, przekreślenie")
  func emphasis() {
    #expect(spans("**trzy** i *jeden* i ***oba*** i ~~stare~~") == [
      MarkdownSpan("trzy", .bold), MarkdownSpan(" i "), MarkdownSpan("jeden", .italic), MarkdownSpan(" i "),
      MarkdownSpan("oba", [.bold, .italic]), MarkdownSpan(" i "), MarkdownSpan("stare", .strike),
    ])
    #expect(spans("__mocno__ i _lekko_") == [
      MarkdownSpan("mocno", .bold), MarkdownSpan(" i "), MarkdownSpan("lekko", .italic),
    ])
    #expect(spans("**zewnątrz *w środku* dalej**") == [
      MarkdownSpan("zewnątrz ", .bold), MarkdownSpan("w środku", [.bold, .italic]), MarkdownSpan(" dalej", .bold),
    ])
  }

  @Test("emfaza nie rozpada się na kodzie ani adresie w środku")
  func emphasisAroundAtoms() {
    #expect(spans("**pogrubienie z `kodem` w środku**") == [
      MarkdownSpan("pogrubienie z ", .bold), MarkdownSpan("kodem", [.bold, .code]), MarkdownSpan(" w środku", .bold),
    ])
    let url = URL(string: "https://claude.ai/x")!
    #expect(spans("**Artefakt: https://claude.ai/x**") == [
      MarkdownSpan("Artefakt: ", .bold), MarkdownSpan("https://claude.ai/x", .bold, link: url),
    ])
  }

  @Test("bez emfazy: snake_case, a__b__c, 2*3*4, samotne gwiazdki, spacja przy ograniczniku, ucieczki")
  func notEmphasis() {
    #expect(spans("snake_case_name i self__init__x") == [MarkdownSpan("snake_case_name i self__init__x")])
    #expect(spans("2*3*4 oraz 2 ** 3 i **") == [MarkdownSpan("2*3*4 oraz 2 ** 3 i **")])
    #expect(spans("\\*nie kursywa\\* i ~pojedyncza~") == [MarkdownSpan("*nie kursywa* i ~pojedyncza~")])
  }

  @Test("złośliwe wejście: tysiące samotnych ograniczników kończą się szybko i zostają tekstem")
  func pathological() {
    let text = String(repeating: "*a _b ~~c `", count: 3_000)
    let start = Date()
    let out = spans(text)
    #expect(Date().timeIntervalSince(start) < 2)
    #expect(out.map(\.text).joined().count >= text.count - 3_000 * 2)
  }

  @Test("długie sparowane ciągi gwiazdek: bez przepełnienia stosu, w czasie liniowym, nadmiar jest tekstem")
  func deepEmphasis() {
    let stars = String(repeating: "*", count: 40_000)
    let text = stars + "x" + stars
    var out: [MarkdownSpan] = []
    let elapsed = ContinuousClock().measure { out = spans(text) }
    #expect(elapsed < .seconds(2))
    let joined = out.map(\.text).joined()
    // Kilka zewnętrznych par to pogrubienie, reszta gwiazdek zostaje w tekście.
    #expect(joined.count > text.count - 100)
    #expect(joined.count < text.count)
    #expect(out.contains { $0.text.contains("x") && $0.style.contains(.bold) })
  }

  @Test("emfaza zagnieżdżona na kilka poziomów działa w limicie")
  func nestedEmphasisWithinLimit() {
    #expect(spans("~~**_a_**~~") == [MarkdownSpan("a", [.strike, .bold, .italic])])
  }

  @Test("link z etykietą: http, https, mailto; etykieta z emfazą; tytuł pomijany")
  func labeledLinks() {
    let url = URL(string: "https://example.com/a_b")!
    #expect(spans("Patrz [**dokumentację**](https://example.com/a_b \"tytuł\").") == [
      MarkdownSpan("Patrz "), MarkdownSpan("dokumentację", .bold, link: url), MarkdownSpan("."),
    ])
    let mail = URL(string: "mailto:dev@example.com")!
    #expect(spans("[napisz](mailto:dev@example.com)") == [MarkdownSpan("napisz", link: mail)])
  }

  @Test("link odrzucony zostaje surowym zapisem; względny zostaje samą etykietą")
  func rejectedLinks() {
    #expect(spans("[klik](javascript:alert(1))") == [MarkdownSpan("[klik](javascript:alert(1))")])
    #expect(spans("[x](//evil.com)") == [MarkdownSpan("[x](//evil.com)")])
    #expect(spans("[x](data:text/html,hi)") == [MarkdownSpan("[x](data:text/html,hi)")])
    #expect(spans("[notes.ts:12](src/notes.ts#L12)") == [MarkdownSpan("notes.ts:12")])
  }

  @Test("goły adres: kropka, nawias bez pary i gwiazdki emfazy należą do zdania")
  func bareLinks() {
    let wiki = URL(string: "https://pl.wikipedia.org/wiki/Hel_(pierwiastek)")!
    #expect(spans("Serwer: http://localhost:5273. Patrz (https://x.pl/y) i https://pl.wikipedia.org/wiki/Hel_(pierwiastek)") == [
      MarkdownSpan("Serwer: "), MarkdownSpan("http://localhost:5273", link: URL(string: "http://localhost:5273")!),
      MarkdownSpan(". Patrz ("), MarkdownSpan("https://x.pl/y", link: URL(string: "https://x.pl/y")!),
      MarkdownSpan(") i "), MarkdownSpan("https://pl.wikipedia.org/wiki/Hel_(pierwiastek)", link: wiki),
    ])
    #expect(spans("koniec zdania https://") == [MarkdownSpan("koniec zdania https://")])
    #expect(spans("adres `https://w.kodzie` zostaje kodem") == [
      MarkdownSpan("adres "), MarkdownSpan("https://w.kodzie", .code), MarkdownSpan(" zostaje kodem"),
    ])
  }

  @Test("goły adres z długim ogonem nawiasów bez pary: ucięcie w czasie liniowym")
  func bareLinkLongTail() {
    let url = URL(string: "https://example.com/")!
    for closer in [")", "]"] {
      let tail = String(repeating: closer, count: 50_000)
      var out: [MarkdownSpan] = []
      let elapsed = ContinuousClock().measure { out = spans("https://example.com/" + tail) }
      #expect(elapsed < .seconds(2))
      #expect(out == [MarkdownSpan("https://example.com/", link: url), MarkdownSpan(tail)])
    }
  }

  @Test("cel linku: schematy spoza listy i znaki sterujące w schemacie odrzucone")
  func linkTargets() {
    #expect(MarkdownLinks.target("https://a.pl") == .url(URL(string: "https://a.pl")!))
    #expect(MarkdownLinks.target("java\tscript:alert(1)") == .rejected)
    #expect(MarkdownLinks.target("file:///etc/passwd") == .rejected)
    #expect(MarkdownLinks.target("") == .rejected)
    #expect(MarkdownLinks.target("docs/README.md") == .relative)
  }
}
