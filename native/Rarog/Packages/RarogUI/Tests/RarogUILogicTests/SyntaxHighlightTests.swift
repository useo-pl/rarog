import Foundation
@testable import RarogUI
import Testing

// Kolorowanie składni: tekst wejściowy i oczekiwane klasy tokenów, także dla shella. Niezmienniki
// HTML z PWA (escaping, brak surowego `<`) nie mają tu sensu, bo skaner nie produkuje tekstu; w ich miejscu:
// zakresy posortowane, rozłączne i w granicach, brak koloru = pusta lista, tekst sklejony z odcinków == wejście. Właściciel: transkrypt, markdown.

/// Zapis tokenów do porównań: `<k>const</k> a = …` — klasa jako znacznik, tekst surowy (bez escapingu HTML,
/// więc `&quot;x&quot;` z PWA to tu `"x"`).
private func marked(_ code: String, _ language: String) -> String {
  let units = Array(code.utf16)
  var out = ""
  var at = 0
  for token in SyntaxHighlight.tokens(code, language: language) {
    out += String(decoding: units[at..<token.range.lowerBound], as: UTF16.self)
    out += "<\(token.kind.rawValue)>" + String(decoding: units[token.range], as: UTF16.self) + "</\(token.kind.rawValue)>"
    at = token.range.upperBound
  }
  return out + String(decoding: units[at...], as: UTF16.self)
}

/// Ile razy `needle` stoi w `text`.
private func count(_ needle: String, in text: String) -> Int {
  text.components(separatedBy: needle).count - 1
}

/// Tekst tokenów danej klasy, w kolejności (przez `NSString`, niezależnie od `marked`).
private func texts(_ code: String, _ language: String, _ kind: SyntaxClass) -> [String] {
  let string = code as NSString
  return SyntaxHighlight.tokens(code, language: language).filter { $0.kind == kind }.map {
    string.substring(with: NSRange(location: $0.range.lowerBound, length: $0.range.count))
  }
}

/// Generator pseudolosowy z ziarnem (SplitMix64): ten sam ciąg przypadków w każdym przebiegu.
private struct SeededRandom: RandomNumberGenerator {
  var state: UInt64

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}

@Suite("kolorowanie składni: niezmienniki")
struct SyntaxHighlightInvariantTests {
  static let languages = ["ts", "json", "bash", "python", "ruby", "yaml", "css", "html", "sql", "diff", "go", "rust", "swift"]

  /// Kawałki, z których losujemy tekst: znaki składni każdej rodziny, słowa kluczowe, NUL, emoji (para
  /// zastępcza w UTF-16), znak złożony i znaki spoza ASCII — tam, gdzie port mógłby pomylić jednostki.
  static let pieces = [
    "a", "Z", "_", "$", "0", "7", "x", " ", "\t", "\n", "\"", "'", "`", "\\", "#", "/", "*", "-", "+", "<", ">", "=",
    ":", ";", "|", "&", "(", ")", "{", "}", "@", "!", "?", ".", "~", "%", "<<", "<<-", "EOF", "<!--", "-->", "/*",
    "*/", "//", "--", "+++", "@@", "if", "then", "fi", "const", "true", "null", "def", "end", "SELECT", "\u{0}",
    "👍🏽", "é", "e\u{301}", "ą", "\u{2028}", "\u{A0}",
  ]

  @Test("zakresy posortowane, rozłączne, niepuste i w granicach; tekst z odcinków == wejście")
  func randomInputs() {
    var random = SeededRandom(state: 2026_10_08)
    for _ in 0..<600 {
      let length = Int.random(in: 0...40, using: &random)
      let code = (0..<length).map { _ in Self.pieces.randomElement(using: &random)! }.joined()
      let units = Array(code.utf16)
      for language in Self.languages {
        let tokens = SyntaxHighlight.tokens(code, language: language)
        var at = 0
        var rebuilt: [UInt16] = []
        for token in tokens {
          #expect(token.range.lowerBound >= at, "\(language): nakładka albo kolejność w \(code.debugDescription)")
          #expect(!token.range.isEmpty && token.range.upperBound <= units.count, "\(language): \(code.debugDescription)")
          guard token.range.lowerBound >= at, token.range.upperBound <= units.count else { break }
          rebuilt += units[at..<token.range.lowerBound]
          rebuilt += units[token.range]
          at = token.range.upperBound
        }
        rebuilt += units[min(at, units.count)...]
        #expect(rebuilt == units, "\(language): tekst nie wrócił w \(code.debugDescription)")
      }
    }
  }

  @Test("brak koloru = pusta lista: nieznany język, fence bez języka, blok ponad sufitem")
  func noColor() {
    #expect(SyntaxHighlight.tokens("cokolwiek <tu> jest", language: "kaszanka").isEmpty)
    #expect(SyntaxHighlight.tokens("const a = 1;", language: "").isEmpty)
    #expect(SyntaxHighlight.tokens("const a = 1;", language: nil).isEmpty)
    #expect(SyntaxHighlight.tokens(String(repeating: "x", count: SyntaxHighlight.maxLength + 1), language: "ts").isEmpty)
    #expect(SyntaxHighlight.tokens("", language: "sh").isEmpty)
  }

  @Test("sufit liczony jak w PWA: od tekstu po escapingu HTML, nie od surowych znaków")
  func ceilingCountsEscapedText() {
    #expect(SyntaxHighlight.escapedLength(Array("<&\"'>a".utf16)) == 4 + 5 + 6 + 5 + 4 + 1)
    // `1<` po escapingu to 5 znaków: 8000 powtórzeń = dokładnie sufit, 8001 = ponad (surowo tylko 16 002).
    #expect(!SyntaxHighlight.tokens(String(repeating: "1<", count: 8000), language: "ts").isEmpty)
    #expect(SyntaxHighlight.tokens(String(repeating: "1<", count: 8001), language: "ts").isEmpty)
  }

  @Test("zakresy w jednostkach UTF-16: emoji i znak złożony przed tokenem nie przesuwają koloru")
  func utf16Ranges() {
    // 👍🏽 to 4 jednostki UTF-16 i jeden znak; „é" z akcentem łączonym to 2 jednostki i jeden znak.
    let code = "x = \"👍🏽\" // é\ne\u{301} 42 ą foo(1)"
    #expect(texts(code, "ts", .s) == ["\"👍🏽\""])
    #expect(texts(code, "ts", .c) == ["// é"])
    #expect(texts(code, "ts", .n) == ["42", "1"])
    #expect(texts(code, "ts", .f) == ["foo"])
    let shell = "echo 👍🏽 && git status # ąę"
    #expect(texts(shell, "sh", .f) == ["git"])
    #expect(texts(shell, "sh", .k) == ["echo"])
    #expect(texts(shell, "sh", .c) == ["# ąę"])
  }

  @Test("knownLang: nazwa z fence'a ma gramatykę, wielkość liter bez znaczenia")
  func knownLanguages() {
    #expect(SyntaxHighlight.isKnown("TypeScript"))
    #expect(SyntaxHighlight.isKnown("bash"))
    #expect(SyntaxHighlight.isKnown("Ruby"))
    #expect(!SyntaxHighlight.isKnown("wynik"))
    #expect(!SyntaxHighlight.isKnown(""))
  }
}

@Suite("kolorowanie składni: przypadki z PWA")
struct SyntaxHighlightCaseTests {
  @Test("treść z znacznikami HTML zostaje napisem albo znacznikiem, nigdy niczym więcej")
  func markupInContent() {
    #expect(marked(#"const a = "<img src=x onerror=alert(1)>";"#, "ts").contains(#"<s>"<img src=x onerror=alert(1)>"</s>"#))
    #expect(marked("<script>alert(1)</script>", "html").contains("<k>script</k>"))
  }

  @Test("TypeScript: słowo kluczowe, liczba, napisy, literał, wołana nazwa, komentarze")
  func typescript() {
    let first = marked("const n = 42;", "ts")
    #expect(first.contains("<k>const</k>") && first.contains("<n>42</n>"))
    #expect(marked("const a = 'x';", "js").contains("<s>'x'</s>"))
    #expect(marked("const a = `x`;", "js").contains("<s>`x`</s>"))
    let literal = marked("let ok = true;", "ts")
    #expect(literal.contains("<k>let</k>") && literal.contains("<l>true</l>"))
    #expect(marked("foo(1)", "ts").contains("<f>foo</f>"))
    #expect(marked("// nota\nlet a;", "ts").contains("<c>// nota</c>"))
    #expect(marked("/* nota */", "ts").contains("<c>/* nota */</c>"))
  }

  @Test("słowo kluczowe w napisie zostaje napisem; urwany napis kończy się na linii")
  func stringsStayStrings() {
    let inside = marked(#"const a = "const";"#, "ts")
    #expect(inside.contains(#"<s>"const"</s>"#))
    #expect(count("<k>", in: inside) == 1)
    // Drugie `const` dalej jest słowem kluczowym — apostrof w komentarzu nie przemalowuje reszty odpowiedzi.
    let broken = marked("const a = \"x\nconst b = 1;", "ts")
    #expect(count("<k>const</k>", in: broken) == 2)
  }

  @Test("niedomknięty komentarz blokowy bierze resztę bloku i niczego nie gubi")
  func unclosedComment() {
    #expect(marked("/* bez końca\nx", "ts") == "<c>/* bez końca\nx</c>")
  }

  @Test("JSON i YAML: klucz innym kolorem niż wartość, literały, liczby")
  func jsonAndYaml() {
    let json = marked(#"{"a": "b"}"#, "json")
    #expect(json.contains(#"<f>"a"</f>"#) && json.contains(#"<s>"b"</s>"#))
    #expect(marked(#"{"a": null}"#, "json").contains("<l>null</l>"))
    let yaml = marked("port: 8930\ndebug: true", "yaml")
    #expect(yaml.contains("<f>port</f>") && yaml.contains("<n>8930</n>") && yaml.contains("<l>true</l>"))
  }

  @Test("shell: słowo kluczowe, zmienna, napis ze zmienną, `#` w słowie i po spacji")
  func shellBasics() {
    let html = marked("if [ -n $HOME ]; then echo x; fi", "bash")
    #expect(html.contains("<k>if</k>") && html.contains("<f>$HOME</f>"))
    // Świadome uproszczenie z PWA: zmienna w cudzysłowie zostaje częścią napisu.
    #expect(marked(#"echo "$HOME""#, "sh").contains(#"<s>"$HOME"</s>"#))
    #expect(!marked(#"echo "${VAR#pre}""#, "sh").contains("<c>"))
    #expect(marked("ls  # lista", "sh").contains("<c># lista</c>"))
  }

  @Test("shell: słowo w pozycji komendy — początek, za `|`, `;`, `&&`, nowa linia, `sudo`/`then`")
  func shellCommandPosition() {
    #expect(marked("git add a b", "sh").contains("<f>git</f> add a b"))
    let chain = marked("cat a | grep x; ls && ./run.sh\npnpm test", "sh")
    for word in ["cat", "grep", "ls", "./run.sh", "pnpm"] { #expect(chain.contains("<f>\(word)</f>"), "\(word)") }
    #expect(!chain.contains("<f>test</f>"))
    let prefixes = marked("sudo make; if x; then brew up; fi; echo make", "sh")
    #expect(prefixes.contains("<f>make</f>") && prefixes.contains("<f>brew</f>"))
    #expect(count("<f>make</f>", in: prefixes) == 1)
  }

  @Test("shell: przypisanie przed komendą nie zabiera jej pozycji, także przed separatorem bez spacji")
  func shellAssignments() {
    let html = marked(#"FOO=1 BAR="x" cmd arg"#, "sh")
    #expect(html.contains("FOO=") && !html.contains("<f>FOO") && html.contains("<f>cmd</f>"))
    #expect(marked("FOO=1;git status", "sh").contains("<f>git</f> status"))
    #expect(marked("FOO=1|cat file", "sh").contains("<f>cat</f> file"))
    #expect(marked("FOO=1&&git status", "sh").contains("<f>git</f> status"))
  }

  @Test("shell: zamykający backtick nie otwiera pozycji komendy")
  func shellBackticks() {
    let html = marked("echo `date` plik", "sh")
    #expect(html.contains("<f>date</f>") && !html.contains("<f>plik"))
  }

  @Test("shell: ciało heredoca jest danymi aż do terminatora, potem znów kod")
  func shellHeredoc() {
    let code = "git commit -F - <<'EOF'\nfeat(web): if test 42 \"x\"\n\nzero $HOME\nEOF\ngit log -1"
    let html = marked(code, "sh")
    #expect(html.contains("<s>'EOF'</s>"))
    for absent in ["<k>if", "<f>zero", "<f>$HOME", "<n>42"] { #expect(!html.contains(absent), "\(absent)") }
    #expect(html.contains("EOF\n<f>git</f> log -<n>1</n>"))
    let dashed = marked("cat <<-EOF\n\tif x\n\tEOF\nls", "sh")
    #expect(!dashed.contains("<k>if") && dashed.contains("<f>ls</f>"))
    #expect(marked(#"a <<< "here"; ls"#, "sh").contains("<f>ls</f>"))
    #expect(!marked("cat <<EOF\nif a\nthen b", "sh").contains("<k>if"))
  }

  @Test("shell: słowo kluczowe i liczba wewnątrz ścieżki są tekstem; flaga i liczba po `=` są liczbami")
  func shellPaths() {
    let html = marked("git add web/test/kolor-2026-09-10.test.ts styles/56-a.css", "sh")
    for absent in ["<k>test", "<n>2026", "<n>56", "<n>10"] { #expect(!html.contains(absent), "\(absent)") }
    #expect(marked("git log -1", "sh").contains("-<n>1</n>"))
    #expect(marked("head -n 20 x", "sh").contains("<n>20</n>"))
    #expect(marked("FOO=1 cmd", "sh").contains("FOO=<n>1</n>"))
    #expect(marked("pnpm test", "sh").contains("<k>test</k>"))
  }

  @Test("komenda karty narzędzia: tokeny shella, encje HTML w komendzie to zwykły tekst napisu")
  func toolCommand() {
    let command = #"if [ -f "$HOME/x" ]; then echo 42; fi # koniec"#
    #expect(texts(command, "sh", .k).first == "if")
    #expect(texts(command, "sh", .s).first == #""$HOME/x""#)
    #expect(texts(command, "sh", .n).first == "42")
    #expect(texts(command, "sh", .c).first == "# koniec")
    #expect(texts(#"echo "&lt;b&gt; &amp;amp; if""#, "sh", .s) == [#""&lt;b&gt; &amp;amp; if""#])
    #expect(SyntaxHighlight.tokens(String(repeating: "echo ", count: SyntaxHighlight.maxLength / 5 + 1), language: "sh").isEmpty)
  }

  @Test("CSS, SQL, HTML i diff")
  func otherFamilies() {
    let css = marked("@media x { color: #fff; }", "css")
    #expect(css.contains("<k>@media</k>") && css.contains("<f>color</f>") && css.contains("<n>#fff</n>"))
    #expect(marked("SELECT * FROM t", "sql").contains("<k>SELECT</k>"))
    #expect(marked("select * from t", "sql").contains("<k>select</k>"))
    let html = marked(#"<a href="/x">tekst</a>"#, "html")
    #expect(html.contains("<k>a</k>") && html.contains("<f>href</f>") && html.contains(#"<s>"/x"</s>"#))
    // Tekst między znacznikami zostaje bez koloru — to treść, nie składnia.
    #expect(html.contains(">tekst<"))
    #expect(marked("<!-- nota -->", "html").contains("<c><!-- nota --></c>"))
    let diff = marked("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-stare\n+nowe\n kontekst", "diff")
    for part in ["<c>--- a/x</c>", "<c>+++ b/x</c>", "<f>@@ -1 +1 @@</f>", "<del>-stare</del>", "<add>+nowe</add>"] {
      #expect(diff.contains(part), "\(part)")
    }
  }

  @Test("Ruby: słowa kluczowe z `?`, literał `nil`, napis, komentarz")
  func ruby() {
    let html = marked("def ok?\n  defined?(x) ? nil : \"a\" # nota\nend", "ruby")
    for part in ["<k>def</k>", "<k>defined?</k>", "<l>nil</l>", #"<s>"a"</s>"#, "<c># nota</c>", "<k>end</k>"] {
      #expect(html.contains(part), "\(part)")
    }
  }
}

@Suite("kolorowanie składni w transkrypcie: blok kodu i karta narzędzia")
struct SyntaxHighlightTranscriptTests {
  @Test("blok kodu koloruje się w całości i tnie na linie: komentarz przechodzi przez granicę linii")
  func codeBlockLines() {
    let lines = codeLines("```ts\n/* a\nb */ const x = 1\n```")
    #expect(lines.count == 2)
    #expect(lines[0].syntax == [SyntaxToken(0..<4, .c)])
    #expect(lines[1].syntax == [SyntaxToken(0..<4, .c), SyntaxToken(5..<10, .k), SyntaxToken(15..<16, .n)])
  }

  @Test("blok shella: ciało heredoca w środkowych liniach bez koloru, komenda po terminatorze w kolorze")
  func codeBlockHeredoc() {
    let lines = codeLines("```sh\ncat <<EOF\nif a\nEOF\nls\n```")
    #expect(lines.map(\.syntax) == [[SyntaxToken(0..<3, .f)], [], [], [SyntaxToken(0..<2, .f)]])
  }

  @Test("nieznany język i blok bez języka: linie kodu bez koloru")
  func codeBlockWithoutLanguage() {
    for source in ["```wynik\nconst a = 1\n```", "```\nconst a = 1\n```"] {
      let syntax = MarkdownLayout.paragraphs(source).map(\.syntax)
      #expect(syntax.allSatisfy { $0.isEmpty }, "\(source)")
    }
  }

  /// Linie kodu wiadomości (bez paska bloku).
  private func codeLines(_ source: String, cache: SyntaxCache = SyntaxCache()) -> [MarkdownParagraph] {
    MarkdownLayout.paragraphs(source, syntax: cache).filter { if case .codeLine = $0.kind { true } else { false } }
  }

  @Test("CRLF: parser zamienia końce linii, kolor taki sam jak przy LF")
  func crlf() {
    let lf = codeLines("```ts\n/* a\nb */ const x\n```")
    let crlf = codeLines("```ts\r\n/* a\r\nb */ const x\r\n```")
    #expect(crlf.map(\.syntax) == lf.map(\.syntax))
    #expect(crlf.map(\.spans) == lf.map(\.spans))
    #expect(lf.map(\.syntax) == [[SyntaxToken(0..<4, .c)], [SyntaxToken(0..<4, .c), SyntaxToken(5..<10, .k)]])
  }

  @Test("otwarty blok w strumieniu: niedomknięty komentarz koloruje wszystkie linie do końca")
  func openComment() {
    let lines = codeLines("Tekst\n\n```ts\nconst a = 1 /* od tu\nwciąż komentarz\nkoniec")
    #expect(lines.map(\.syntax) == [
      [SyntaxToken(0..<5, .k), SyntaxToken(10..<11, .n), SyntaxToken(12..<20, .c)],
      [SyntaxToken(0..<15, .c)], [SyntaxToken(0..<6, .c)],
    ])
  }

  @Test("literalne encje HTML w kodzie zostają tekstem: `&lt;` to cztery znaki, nie znacznik")
  func literalEntities() {
    let html = codeLines("```html\n&lt;b&gt; <i>x</i>\n```")
    #expect(html[0].spans.map(\.text).joined() == "&lt;b&gt; <i>x</i>")
    let units = Array("&lt;b&gt; <i>x</i>".utf16)
    let words = html[0].syntax.map { String(decoding: units[$0.range], as: UTF16.self) }
    #expect(words == ["i", "/i"], "kolor dostaje tylko prawdziwy znacznik")
    let ts = codeLines("```ts\nconst s = \"&lt;\";\n```")
    #expect(ts[0].syntax.contains(SyntaxToken(10..<16, .s)))
  }

  @Test("blok przerastający sufit w strumieniu traci kolor, a tekst i układ akapitów zostają te same")
  func ceilingDuringStreaming() {
    let unit = "x = 1\n"
    let under = String(repeating: unit, count: SyntaxHighlight.maxLength / unit.utf16.count)
    let over = under + String(repeating: "y", count: 10)
    let below = MarkdownLayout.paragraphs("```ts\n" + under, syntax: SyntaxCache())
    let above = MarkdownLayout.paragraphs("```ts\n" + over, syntax: SyntaxCache())
    #expect(below.contains { !$0.syntax.isEmpty })
    #expect(above.allSatisfy { $0.syntax.isEmpty })
    #expect(below.dropLast().map(\.spans) == above.dropLast().map(\.spans))
    #expect(below.dropFirst().dropLast().map(\.kind) == above.dropFirst().dropLast().map(\.kind))
  }

  @Test("cięcie na linie: zakres liczony od początku linii, token na samym `\\n` znika, linie bez tokenów puste")
  func split() {
    let tokens = [SyntaxToken(0..<9, .c), SyntaxToken(10..<12, .k)]
    // Linie: „abcd" (0..<4), „efgh" (5..<9), „" (10..<10), „ij" (11..<13).
    #expect(SyntaxHighlight.split(tokens, lineLengths: [4, 4, 0, 2]) == [
      [SyntaxToken(0..<4, .c)], [SyntaxToken(0..<4, .c)], [], [SyntaxToken(0..<1, .k)],
    ])
    #expect(SyntaxHighlight.split([], lineLengths: [3, 0]) == [[], []])
  }

  @Test("karta narzędzia: komenda powłoki w kolorach w linii i w rozwinięciu, inne wejście bez koloru")
  func toolCard() {
    func card(_ summary: String, detail: String?, shell: Bool) -> ToolRowModel {
      ToolRowModel(
        id: "m1.0", voice: .assistant, toolName: "Shell", summary: summary, detail: detail, diff: nil, shell: shell,
        expanded: true, diffTailOpen: false)
    }
    let command = card("git status && echo 👍 1", detail: "git status && echo 👍 1\n# koniec", shell: true)
    let line = command.line as NSString
    let lineWords = command.lineSyntax.map { line.substring(with: NSRange(location: $0.range.lowerBound, length: $0.range.count)) }
    #expect(lineWords == ["git", "echo", "1"], "tylko cel, zakresy przesunięte o „Shell: ”")
    #expect(command.detailSyntax.map(\.kind) == [.f, .k, .n, .c])
    let json = card("/x/a.ts", detail: #"{"file_path": "/x/a.ts", "limit": 20}"#, shell: false)
    #expect(json.lineSyntax.isEmpty && json.detailSyntax.isEmpty)
    #expect(card("ls", detail: nil, shell: true).detailSyntax.isEmpty)
  }
}

@Suite("kolorowanie składni: koszt")
struct SyntaxHighlightCostTests {
  /// Blok tuż pod sufitem (`maxLength` po escapingu) z powtórzonego kawałka kodu.
  static func block(_ unit: String) -> String {
    let size = SyntaxHighlight.escapedLength(Array(unit.utf16))
    return String(repeating: unit, count: SyntaxHighlight.maxLength / size)
  }

  /// Realistyczny TypeScript (~1 token na 17 znaków).
  static let typescript = """
    // Odczyt sesji z pamięci podręcznej (komentarz z „cudzysłowem" i 'apostrofem').
    export async function load(id: string, limit = 500): Promise<Session | null> {
      const hit = cache.get(id); /* blokowy */ if (hit !== undefined) return hit;
      const rows = await db.query(`SELECT * FROM t WHERE id = ${id} LIMIT ${limit}`, [0x1f, 1_000, 2.5e3]);
      return rows.length > 0 ? { id, rows, ok: true, at: Date.now() } : null;
    }

    """

  /// Najgęstszy przypadek: shell, w którym prawie każde słowo jest tokenem (~1 token na 3 znaki).
  static let denseShell = "x=1; ls -l 2 \"a\" $B # c\nif f; then g 3; fi\n"

  /// Koszt skanu i układu wiadomości z OTWARTYM blokiem pod sufitem (jak w strumieniu: bez pamięci skanów).
  /// Zmierzone na Macu (Apple Silicon), najlepszy z 5 przebiegów, build release (jak apka na
  /// urządzeniu): TS 37 620 znaków, 2 250 tokenów — skan 0,7 ms, układ wiadomości (parser, linie, skan) 2,3 ms;
  /// gęsty shell 32 422 znaki, 9 048 tokenów — 1,0 / 2,8 ms. Build debug ~15 / ~18 ms. Render płynącej
  /// odpowiedzi idzie najwyżej co 60 ms, więc sufit apki zostaje 40 000. Progi z dużym
  /// zapasem na build debug i równoległe testy: łapią koszt kwadratowy, nie wahania.
  @Test("blok pod sufitem: skan i układ wiadomości mieszczą się w budżecie płynącej odpowiedzi")
  func blockUnderCeiling() {
    let clock = ContinuousClock()
    for (language, unit, minimumTokens) in [("ts", Self.typescript, 1_500), ("sh", Self.denseShell, 8_000)] {
      let code = Self.block(unit)
      #expect(SyntaxHighlight.escapedLength(Array(code.utf16)) <= SyntaxHighlight.maxLength)
      var tokens: [SyntaxToken] = []
      let scan = (0..<5).map { _ in clock.measure { tokens = SyntaxHighlight.tokens(code, language: language) } }.min()!
      #expect(tokens.count > minimumTokens, "\(language): \(tokens.count) tokenów")
      // Blok otwarty, jak w strumieniu: skan przy każdym układzie, bez pamięci skanów.
      let source = "Wynik:\n\n```\(language)\n\(code)"
      var paragraphs: [MarkdownParagraph] = []
      let layout = (0..<5).map { _ in clock.measure { paragraphs = MarkdownLayout.paragraphs(source) } }.min()!
      #expect(paragraphs.count > 300)
      #expect(scan < .milliseconds(300), "\(language): skan \(scan)")
      #expect(layout < .milliseconds(500), "\(language): układ \(layout)")
    }
  }

  /// Płynąca odpowiedź z pięcioma domkniętymi blokami i szóstym, który rośnie: każda delta to nowy układ całej
  /// wiadomości. Domknięte bloki skanują się RAZ (pamięć skanów), rosnący przy każdej delcie.
  @Test("strumień: domknięte bloki z pamięci skanów, skanuje się tylko blok rosnący")
  func streamingReusesClosedBlocks() {
    let cache = SyntaxCache()
    let closed = (0..<5).map { index in
      "Krok \(index):\n\n```ts\n// blok \(index)\n" + String(repeating: Self.typescript, count: 15) + "```\n\n"
    }.joined()
    let clock = ContinuousClock()
    var open = ""
    var slowest = Duration.zero
    let deltas = 100
    for delta in 0..<deltas {
      open += "const v\(delta) = load(\"s\(delta)\"); // krok \(delta)\n"
      let source = closed + "Teraz:\n\n```ts\n" + open
      let time = clock.measure { _ = MarkdownLayout.paragraphs(source, syntax: cache) }
      if delta > 0 { slowest = max(slowest, time) }
    }
    #expect(cache.scans == 5 + deltas, "domknięte bloki skanują się raz, rosnący przy każdej delcie")
    #expect(cache.footprint.entries == 5)
    // Zmierzone (Mac, ~35 000 znaków kodu w wiadomości): najwolniejsza delta 2,5 ms release, ~5 ms debug.
    #expect(slowest < .milliseconds(500), "najwolniejsza delta \(slowest)")
  }

  @Test("pamięć skanów rozróżnia zapisy NFC i NFD tego samego tekstu (zakresy UTF-16 nie mogą się przesunąć)")
  func cacheKeepsUnicodeForms() {
    let nfc = "const x = \"\u{E9}\"; const n = 1;"
    let nfd = "const x = \"e\u{301}\"; const n = 1;"
    #expect(nfc == nfd, "String uznaje oba zapisy za równe — stąd klucz po bajtach")
    for (first, second) in [(nfc, nfd), (nfd, nfc)] {
      let cache = SyntaxCache()
      _ = cache.tokens(first, language: "ts", closed: true)
      let cached = cache.tokens(second, language: "ts", closed: true)
      #expect(cached == SyntaxHighlight.scan(second, family: SyntaxHighlight.family("ts")!))
    }
  }

  @Test("pamięć skanów ma sufit wpisów i tokenów; blok bez koloru nie zajmuje miejsca")
  func cacheCeiling() {
    let cache = SyntaxCache(maxEntries: 3, maxTokens: 10)
    for index in 0..<5 { _ = cache.tokens("a\(index) = 1", language: "ts", closed: true) }
    #expect(cache.footprint.entries == 3)
    #expect(cache.footprint.tokens <= 10)
    _ = cache.tokens(String(repeating: "1 ", count: 20), language: "ts", closed: true)
    #expect(cache.footprint.tokens <= 10, "wynik większy niż cały sufit nie wchodzi")
    let before = cache.footprint
    _ = cache.tokens(String(repeating: "x", count: SyntaxHighlight.maxLength + 1), language: "ts", closed: true)
    _ = cache.tokens("tekst", language: "wynik", closed: true)
    #expect(cache.footprint == before)
    // Ostatnio użyty wpis zostaje, najdawniej użyty wypada.
    let fresh = SyntaxCache(maxEntries: 2)
    _ = fresh.tokens("a = 1", language: "ts", closed: true)
    _ = fresh.tokens("b = 2", language: "ts", closed: true)
    _ = fresh.tokens("a = 1", language: "ts", closed: true)
    _ = fresh.tokens("c = 3", language: "ts", closed: true)
    let scans = fresh.scans
    _ = fresh.tokens("a = 1", language: "ts", closed: true)
    #expect(fresh.scans == scans, "„a” użyte niedawno zostało w pamięci")
    _ = fresh.tokens("b = 2", language: "ts", closed: true)
    #expect(fresh.scans == scans + 1, "„b” wypadło jako najdawniej użyte")
  }
}
