import Foundation
@testable import RarogUI
import Testing

// „Lustro" markdownu w polu notatki: zakresy ról w jednostkach UTF-16, bez zmiany tekstu.

@Suite("notatka projektu: lustro markdownu w polu")
struct NoteMirrorTests {
  private func roles(_ text: String, _ role: NoteMirror.Role) -> [String] {
    let ns = text as NSString
    return NoteMirror.spans(text).filter { $0.role == role }.map { ns.substring(with: $0.range) }
  }

  @Test("nagłówek: cała linia półgruba, `#` ze spacją to znacznik; bez spacji albo siedem `#` — zwykły tekst")
  func heading() {
    let text = "## Przed deployem\n#hashtag\n####### za dużo"
    #expect(roles(text, .heading) == ["## Przed deployem"])
    #expect(roles(text, .marker) == ["## "])
  }

  @Test("lista: znacznik po wcięciu, wiszące wcięcie = wcięcie + znacznik; numerowana z kropką i nawiasem")
  func lists() {
    let text = "- punkt\n  * wcięty\n12. dwunasty\n3) trzeci\n-bez spacji\n1.5 litra"
    let spans = NoteMirror.spans(text)
    let items = spans.compactMap { span -> Int? in
      if case let .listItem(prefix) = span.role { return prefix }
      return nil
    }
    #expect(items == [2, 4, 4, 3])
    #expect(roles(text, .marker) == ["- ", "* ", "12. ", "3) "])
  }

  @Test("kod w linii: backticki to znaczniki, kod obejmuje parę; `**` w kodzie to kod; ``` to sam znacznik")
  func code() {
    let text = "- `pnpm run restart` po `**nie bold**`\n```swift"
    #expect(roles(text, .code) == ["`pnpm run restart`", "`**nie bold**`"])
    #expect(roles(text, .bold).isEmpty)
    #expect(roles(text, .marker) == ["- ", "`", "`", "`", "`", "```"])
    #expect(roles("pusty `` i `x", .code).isEmpty, "pusta para i niesparowany backtick zostają tekstem")
  }

  @Test("pogrubienie: wnętrze półgrube, `**` znacznikami; bez wnętrza, ze spacją przy znaczniku albo bez pary — tekst")
  func bold() {
    #expect(roles("a **b** i **dwa słowa** c", .bold) == ["b", "dwa słowa"])
    #expect(roles("a **b** c", .marker) == ["**", "**"])
    #expect(roles("**** i ** spacja ** i **otwarte", .bold).isEmpty)
  }

  @Test("goły adres: reguły końca adresu z transkryptu (kropka zdania poza adresem); w kodzie nie")
  func links() {
    #expect(roles("Changelog herdr: https://herdr.dev.", .link) == ["https://herdr.dev"])
    #expect(roles("(https://x.pl/a_(b)) i `https://kod.pl`", .link) == ["https://x.pl/a_(b)"])
    #expect(roles("nothttps://x.pl", .link).isEmpty, "adres zaczyna słowo")
  }

  @Test("zakresy w jednostkach UTF-16: emoji i polskie litery przed znacznikiem nie przesuwają ról")
  func utf16() {
    let text = "😀👍🏽 zażółć **gęś** `jaźń`\n# Ąę"
    #expect(roles(text, .bold) == ["gęś"])
    #expect(roles(text, .code) == ["`jaźń`"])
    #expect(roles(text, .heading) == ["# Ąę"])
    let ns = text as NSString
    #expect(NoteMirror.spans(text).allSatisfy { NSMaxRange($0.range) <= ns.length })
  }

  @Test("notatka przy suficie w jednej linii z tysiącami fragmentów kodu liczy się liniowo, nie kwadratowo")
  func ceilingLine() {
    let text = String(repeating: "`x` h **b** ", count: 4096)
    let clock = ContinuousClock()
    var spans: [NoteMirror.Span] = []
    let elapsed = clock.measure { spans = NoteMirror.spans(text) }
    #expect(spans.filter { $0.role == .code }.count == 4096 && spans.filter { $0.role == .bold }.count == 4096)
    #expect(elapsed < .seconds(2), "przeliczenie na każdy znak na głównym wątku: \(elapsed)")
  }

  @Test("notatka z zasiewu demo: każda rola tam, gdzie człowiek jej szuka")
  func seed() {
    let text = "## Przed deployem\n- `pnpm run restart` po każdej zmianie w `server/`\n- sprawdź `/health`: `herdr: true`\n\nChangelog herdr: https://herdr.dev"
    #expect(roles(text, .heading) == ["## Przed deployem"])
    #expect(roles(text, .code) == ["`pnpm run restart`", "`server/`", "`/health`", "`herdr: true`"])
    #expect(roles(text, .link) == ["https://herdr.dev"])
    #expect(NoteMirror.spans("").isEmpty && NoteMirror.spans("\n\n").isEmpty)
  }
}
