@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Pytanie do użytkownika w odpowiedzi agenta: akapit od pogrubionego „Do Ciebie:” i wszystko pod nim
/// do końca tekstu stoi za pomarańczową kreską (`wait`, 3 pt), wcięte jak cytat, w atramencie prozy. Kreska jest
/// zawsze taka sama (bez stanu „odpowiedziane”). Dymek człowieka i notatka projektu bez rozpoznawania.
/// Właściciel: transkrypt, markdown.
@MainActor
final class TranscriptQuestionTests: XCTestCase {
  /// Pytanie z listą numerowaną, blokiem kodu i tabelą pod znacznikiem; akapit nad nim zostaje zwykłą prozą.
  static let source = """
    Build przeszedł, testy zielone.

    **Do Ciebie:** publikujemy apkę?

    1. tak — publikuję
    2. nie — czekamy

    ```bash
    bash scripts/ios-publish.sh
    ```

    | Krok | Czas |
    | --- | --- |
    | build | 4 min |
    """

  /// Każdy akapit od znacznika ma ozdobę pytania (także pasek i linia kodu, tabela), kreska ciągnie się od drugiego
  /// akapitu, lewa krawędź treści przesuwa się o krok cytatu, a atrament prozy i pogrubienia zostaje.
  func testQuestionParagraphsStandBehindBarInProseInk() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    let text = fixture.controller.textConfiguration(
      .text(id: "m1.0", role: .assistant, voice: .assistant, markdown: Self.source)).text
    let paragraphs = Self.paragraphs(text)
    XCTAssertEqual(paragraphs.count, 7, paragraphs.map(\.text).description)

    let lead = try XCTUnwrap(paragraphs.first)
    XCTAssertNil(lead.decoration, "akapit nad pytaniem bez ozdoby")
    XCTAssertEqual(lead.style?.headIndent ?? -1, 0, "akapit nad pytaniem bez wcięcia")

    let step = MarkdownRenderer.quoteStep
    let asked = Array(paragraphs.dropFirst())
    for (index, paragraph) in asked.enumerated() {
      let decoration = try XCTUnwrap(paragraph.decoration, "\(paragraph.text): ozdoba pytania")
      XCTAssertTrue(decoration.question, "\(paragraph.text): akapit pytania")
      XCTAssertEqual(decoration.questionJoins, index > 0, "\(paragraph.text): kreska ciągnie się od drugiego akapitu")
      XCTAssertEqual(decoration.leftIndent, step, "\(paragraph.text): lewa krawędź za kreską")
    }
    func indent(_ fragment: String) -> CGFloat? {
      paragraphs.first { $0.text.contains(fragment) }?.style?.firstLineHeadIndent
    }
    XCTAssertEqual(indent("Do Ciebie:"), step, "akapit ze znacznikiem")
    XCTAssertEqual(indent("tak — publikuję"), step, "pozycja listy od krawędzi pytania")
    XCTAssertEqual(indent("bash scripts"), step + MarkdownRenderer.codeInset, "linia kodu")
    XCTAssertEqual(indent("\u{FFFC}"), step, "tabela")
    guard case .codeBar = asked[3].decoration?.kind else { return XCTFail("pasek bloku kodu: \(asked[3].text)") }
    guard case .codeLine = asked[4].decoration?.kind else { return XCTFail("linia kodu: \(asked[4].text)") }

    func ink(_ fragment: String) -> UIColor? {
      let range = (text.string as NSString).range(of: fragment)
      XCTAssertNotEqual(range.location, NSNotFound, fragment)
      return text.attribute(.foregroundColor, at: range.location, effectiveRange: nil) as? UIColor
    }
    XCTAssertEqual(ink("publikujemy"), Palette.prose, "proza pytania nie przygasa")
    XCTAssertEqual(ink("Do Ciebie:"), Palette.strong, "znacznik w atramencie pogrubienia")
    XCTAssertEqual(ink("czekamy"), Palette.prose, "lista pytania")

    // Kreska to ozdoba: kopia zaznaczenia i tekst czytnika te same co bez rozpoznawania.
    let plain = MarkdownRenderer.render(Self.source, style: MarkdownRenderer.Style(
      textColor: Palette.prose, strongColor: Palette.strong, base: MarkdownRenderer.transcriptStyle,
      traits: fixture.controller.traitCollection))
    XCTAssertEqual(MarkdownPlainText.copy(text), MarkdownPlainText.copy(plain), "kopia")
    XCTAssertEqual(MarkdownPlainText.spoken(text), MarkdownPlainText.spoken(plain), "czytnik")
    XCTAssertTrue(MarkdownPlainText.spoken(text).contains("Do Ciebie: publikujemy"), "czytnik czyta znacznik z tekstu")
  }

  /// Bez znacznika odpowiedź agenta nie dostaje żadnej ozdoby pytania ani wcięcia; dymek człowieka i notatka projektu
  /// nie rozpoznają znacznika wcale.
  func testNoQuestionWithoutMarkerInHumanMessageAndInNote() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    let plain = Self.source.replacingOccurrences(of: "**Do Ciebie:** ", with: "")
    let agent = fixture.controller.textConfiguration(
      .text(id: "m1.0", role: .assistant, voice: .assistant, markdown: plain)).text
    let human = fixture.controller.textConfiguration(
      .text(id: "m2.0", role: .user, voice: .user, markdown: Self.source)).text
    let host = UIHostingController(rootView: NoteReader(text: Self.source).frame(width: 400))
    fixture.window.rootViewController = host
    host.view.layoutIfNeeded()
    let note = try XCTUnwrap(Self.views(of: UITextView.self, in: host.view).first { $0.accessibilityIdentifier == "note.reader" })
    for (name, text) in [("agent bez znacznika", agent), ("człowiek", human), ("notatka", note.attributedText ?? NSAttributedString())] {
      let paragraphs = Self.paragraphs(text)
      XCTAssertGreaterThan(paragraphs.count, 5, name)
      XCTAssertFalse(paragraphs.contains { $0.decoration?.question == true }, "\(name): bez ozdoby pytania")
      for paragraph in paragraphs where paragraph.decoration == nil {
        XCTAssertEqual(paragraph.style?.firstLineHeadIndent ?? 0, 0, "\(name): \(paragraph.text) od lewej krawędzi")
      }
    }
  }

  /// Płynąca odpowiedź ze znacznikiem ma kreskę od razu, a domknięcie z tym samym tekstem bierze TEN SAM render
  /// (klucz pamięci renderu: źródło + styl, `questions` w stylu obu komórek).
  func testStreamingAnswerHasBarAndClosingReusesItsRender() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    let open = fixture.controller.textConfiguration(.open(voice: .assistant, markdown: Self.source)).text
    XCTAssertEqual(Self.paragraphs(open).filter { $0.decoration?.question == true }.count, 6, "kreska w trakcie strumienia")
    let closed = fixture.controller.textConfiguration(
      .text(id: "m1.0", role: .assistant, voice: .assistant, markdown: Self.source)).text
    XCTAssertTrue(open === closed, "domknięcie bierze render strumienia")

    // Ten sam tekst w stylu bez rozpoznawania to INNY wpis pamięci renderu, w obu kolejnościach.
    for questionsFirst in [true, false] {
      let cache = MarkdownCache()
      let asked = MarkdownRenderer.Style(
        textColor: Palette.prose, strongColor: Palette.strong, base: MarkdownRenderer.transcriptStyle,
        traits: fixture.controller.traitCollection, questions: true)
      var plain = asked
      plain.questions = false
      let order = questionsFirst ? [asked, plain] : [plain, asked]
      let texts = order.map { cache.text(Self.source, style: $0) }
      XCTAssertFalse(texts[0] === texts[1], "questionsFirst=\(questionsFirst): osobne wpisy")
      for (style, text) in zip(order, texts) {
        let marked = Self.paragraphs(text).contains { $0.decoration?.question == true }
        XCTAssertEqual(marked, style.questions, "questionsFirst=\(questionsFirst): kreska tylko w stylu z pytaniami")
      }
    }
  }

  /// Cytat, lista zagnieżdżona, blok kodu w cytacie i linia pozioma pod znacznikiem: wszystko stoi za kreską pytania
  /// (kreska cytatu, pudełko kodu z ikoną kopiowania i linia przesunięte o krok), a kreska pytania idzie bez przerwy.
  func testQuoteNestedListCodeInQuoteAndRuleStandBehindBar() throws {
    let source = """
      **Do Ciebie:** który wariant?

      - pierwszy
        - zagnieżdżony

      > Cytat z kodem:
      >
      > ```bash
      > ls -la
      > ```

      ---

      Koniec pytania.
      """
    let (window, view, textView) = try Self.host(source)
    defer { window.isHidden = true }
    let step = MarkdownRenderer.quoteStep
    var bars: [CGRect] = [], quoteBars: [CGRect] = [], boxes: [CGRect] = [], rules: [CGRect] = []
    let manager = try XCTUnwrap(textView.textLayoutManager)
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      guard let fragment = fragment as? MarkdownLayoutFragment, let decoration = fragment.decoration else { return true }
      let origin = fragment.layoutFragmentFrame.origin
      if let bar = fragment.questionBar { bars.append(bar.offsetBy(dx: origin.x, dy: origin.y)) }
      quoteBars += fragment.quoteBars.map { $0.offsetBy(dx: origin.x, dy: origin.y) }
      if let box = fragment.codeBoxInContainer { boxes.append(box) }
      if decoration.kind == .rule { rules.append(fragment.ruleLine.offsetBy(dx: origin.x, dy: origin.y)) }
      return true
    }
    let paragraphs = Self.paragraphs(textView.attributedText ?? NSAttributedString())
    XCTAssertEqual(bars.count, paragraphs.count, "kreska przy każdym akapicie: \(paragraphs.map(\.text))")
    bars.sort { $0.minY < $1.minY }
    for (above, below) in zip(bars, bars.dropFirst()) {
      XCTAssertLessThanOrEqual(below.minY, above.maxY + 0.5, "kreska bez przerwy: \(above) → \(below)")
    }
    XCTAssertFalse(quoteBars.isEmpty, "kreska cytatu")
    for bar in quoteBars { XCTAssertEqual(bar.minX, step, accuracy: 0.5, "kreska cytatu za kreską pytania") }
    XCTAssertEqual(boxes.count, 2, "pasek i linia kodu w cytacie")
    for box in boxes { XCTAssertEqual(box.minX, 2 * step, accuracy: 0.5, "pudełko kodu za kreską pytania i cytatu") }
    let copy = try XCTUnwrap(Self.views(of: CopyIconButton.self, in: view).first)
    XCTAssertEqual(
      copy.convert(copy.bounds, to: textView).minX, 2 * step + MarkdownRenderer.codeInset - 7, accuracy: 0.5, "ikona kopiowania")
    let rule = try XCTUnwrap(rules.first, "linia pozioma")
    XCTAssertEqual(rule.minX, step, accuracy: 0.5, "linia pozioma za kreską")
    XCTAssertEqual(rule.maxX, textView.textContainer.size.width, accuracy: 0.5, "linia do prawej krawędzi")
    let nested = try XCTUnwrap(paragraphs.first { $0.text.contains("zagnieżdżony") })
    XCTAssertGreaterThan(nested.style?.firstLineHeadIndent ?? 0, step, "lista zagnieżdżona głębiej niż krawędź pytania")
    let first = try XCTUnwrap(paragraphs.first { $0.text.contains("pierwszy") })
    XCTAssertEqual(first.style?.firstLineHeadIndent ?? 0, step, accuracy: 0.5, "pozycja listy od krawędzi pytania")
  }

  /// Kreska idzie bez przerwy od znacznika przez listę, blok kodu i tabelę, a pudełko kodu, jego ikona kopiowania
  /// i tabela stoją za nią. Na ekranie (render warstw) kolumna kreski jest cała w `wait`; bez znacznika ani piksela.
  func testBarRunsUnbrokenPastListCodeAndTable() throws {
    let (window, view, textView) = try Self.host(Self.source)
    defer { window.isHidden = true }
    let step = MarkdownRenderer.quoteStep
    var bars: [CGRect] = []
    var boxes: [CGRect] = []
    let manager = try XCTUnwrap(textView.textLayoutManager)
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      guard let fragment = fragment as? MarkdownLayoutFragment else { return true }
      if let bar = fragment.questionBar {
        bars.append(bar.offsetBy(dx: fragment.layoutFragmentFrame.minX, dy: fragment.layoutFragmentFrame.minY))
      }
      if let box = fragment.codeBoxInContainer { boxes.append(box) }
      return true
    }
    XCTAssertEqual(bars.count, 6, "kreska przy każdym akapicie pytania")
    bars.sort { $0.minY < $1.minY }
    for (above, below) in zip(bars, bars.dropFirst()) {
      XCTAssertLessThanOrEqual(below.minY, above.maxY + 0.5, "kreska bez przerwy: \(above) → \(below)")
    }
    for bar in bars {
      XCTAssertEqual(bar.minX, 0, accuracy: 0.5, "kreska przy lewej krawędzi")
      XCTAssertEqual(bar.width, MarkdownRenderer.questionBarWidth, "grubość kreski")
    }
    XCTAssertEqual(boxes.count, 2, "pasek i linia bloku kodu")
    for box in boxes {
      XCTAssertEqual(box.minX, step, accuracy: 0.5, "pudełko kodu za kreską")
      XCTAssertEqual(box.maxX, textView.textContainer.size.width, accuracy: 0.5, "pudełko kodu do prawej krawędzi")
    }
    let copy = try XCTUnwrap(Self.views(of: CopyIconButton.self, in: view).first)
    XCTAssertEqual(
      copy.convert(copy.bounds, to: textView).minX, step + MarkdownRenderer.codeInset - 7, accuracy: 0.5,
      "ikona kopiowania przesunięta razem z pudełkiem")
    let table = try XCTUnwrap(Self.views(of: MarkdownTableView.self, in: view).first)
    let tableFrame = table.convert(table.bounds, to: textView)
    XCTAssertEqual(tableFrame.minX, step, accuracy: 0.5, "tabela za kreską")
    XCTAssertEqual(tableFrame.maxX, textView.bounds.width, accuracy: 0.5, "tabela kończy się z kolumną tekstu")
    // Ta sama reguła szerokości w cytacie: tabela nie wystaje o wcięcie za prawą krawędź pola.
    let (quoteWindow, quoteView, quoteText) = try Self.host("> | a | b |\n> | --- | --- |\n> | 1 | 2 |")
    defer { quoteWindow.isHidden = true }
    let quoted = try XCTUnwrap(Self.views(of: MarkdownTableView.self, in: quoteView).first)
    XCTAssertEqual(quoted.convert(quoted.bounds, to: quoteText).maxX, quoteText.bounds.width, accuracy: 0.5, "tabela w cytacie")

    let wait = Self.hex(Palette.wait.resolvedColor(with: window.traitCollection))
    let shown = try XCTUnwrap(Self.render(window))
    let first = try XCTUnwrap(bars.first), last = try XCTUnwrap(bars.last)
    let column = textView.convert(
      CGRect(x: 0.5, y: first.minY + 1, width: MarkdownRenderer.questionBarWidth - 1, height: last.maxY - first.minY - 2),
      to: window)
    XCTAssertGreaterThan(shown.share(of: wait, in: column), 0.98, "kolumna kreski w `wait` od znacznika do tabeli")

    let (plainWindow, plainView, _) = try Self.host(Self.source.replacingOccurrences(of: "**Do Ciebie:** ", with: ""))
    defer { plainWindow.isHidden = true }
    let plain = try XCTUnwrap(Self.render(plainWindow))
    XCTAssertEqual(plain.share(of: wait, in: plainView.convert(plainView.bounds, to: plainWindow)), 0, "bez znacznika bez kreski")
  }

  // MARK: - Pomocnicze

  private struct Paragraph {
    let text: String
    let decoration: MarkdownDecoration?
    let style: NSParagraphStyle?
  }

  /// Akapity tekstu (podział na `\n`) z ozdobą i stylem akapitu z pierwszego znaku.
  private static func paragraphs(_ text: NSAttributedString) -> [Paragraph] {
    var out: [Paragraph] = []
    let string = text.string as NSString
    string.enumerateSubstrings(in: NSRange(location: 0, length: string.length), options: .byParagraphs) { part, range, _, _ in
      guard let part, range.length > 0 else { return }
      out.append(Paragraph(
        text: part, decoration: text.attribute(.rarogDecoration, at: range.location, effectiveRange: nil) as? MarkdownDecoration,
        style: text.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle))
    }
    return out
  }

  /// Komórka wiadomości agenta w stylu transkryptu (jak `.text` agenta na ekranie sesji), ciemny motyw, 600 pt.
  private static func host(_ markdown: String) throws -> (UIWindow, UIView, UITextView) {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 600, height: 700))
    window.overrideUserInterfaceStyle = .dark
    let root = UIViewController()
    root.view.backgroundColor = Palette.background
    window.rootViewController = root
    window.makeKeyAndVisible()
    let style = MarkdownRenderer.Style(
      textColor: Palette.prose, strongColor: Palette.strong, base: MarkdownRenderer.transcriptStyle,
      traits: root.traitCollection, questions: true)
    let config = MessageContentConfiguration(
      voice: "agent", text: MarkdownCache().text(markdown, style: style), plate: false, dimmed: false,
      accessibilityIdentifier: "message.m1.0", accessibilityPrefix: nil)
    let view = config.makeContentView()
    view.frame = CGRect(x: 0, y: 0, width: 600, height: 600)
    root.view.addSubview(view)
    window.layoutIfNeeded()
    view.layoutIfNeeded()
    let textView = try XCTUnwrap(views(of: UITextView.self, in: view).first)
    return (window, view, textView)
  }

  private static func views<T: UIView>(of type: T.Type, in view: UIView) -> [T] {
    view.subviews.flatMap { ($0 as? T).map { [$0] } ?? [] + views(of: type, in: $0) }
  }

  private static func hex(_ color: UIColor) -> UInt32 {
    var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
    color.getRed(&r, green: &g, blue: &b, alpha: &a)
    return UInt32((r * 255).rounded()) << 16 | UInt32((g * 255).rounded()) << 8 | UInt32((b * 255).rounded())
  }

  /// Render okna przez warstwę (bez ekranu) do bitmapy sRGB.
  private static func render(_ window: UIWindow) -> Bitmap? {
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in window.layer.render(in: context.cgContext) }
    guard let cg = image.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    var bytes = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4,
        space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
      return true
    }
    return drawn ? Bitmap(width: cg.width, height: cg.height, scale: CGFloat(cg.width) / window.bounds.width, bytes: bytes) : nil
  }

  private struct Bitmap {
    let width: Int
    let height: Int
    let scale: CGFloat
    let bytes: [UInt8]

    /// Udział pikseli kadru w kolorze `rgb` (±3 na kanał).
    func share(of rgb: UInt32, in frame: CGRect) -> Double {
      let x0 = max(0, Int(frame.minX * scale)), x1 = min(width, Int(frame.maxX * scale))
      let y0 = max(0, Int(frame.minY * scale)), y1 = min(height, Int(frame.maxY * scale))
      guard x1 > x0, y1 > y0 else { return 0 }
      let target = [Int((rgb >> 16) & 0xFF), Int((rgb >> 8) & 0xFF), Int(rgb & 0xFF)]
      var hits = 0
      for y in y0..<y1 {
        for x in x0..<x1 {
          let i = (y * width + x) * 4
          if (0..<3).allSatisfy({ abs(Int(bytes[i + $0]) - target[$0]) <= 3 }) { hits += 1 }
        }
      }
      return Double(hits) / Double((x1 - x0) * (y1 - y0))
    }
  }
}
