import RarogCore
@testable import RarogUI
import UIKit
import XCTest

/// Szerokość prozy: akapit, lista, cytat i nagłówek kończą się najwyżej 47,5 em pisma
/// treści od krawędzi treści, a blok kodu, tabela i linia pozioma idą przez całą kolumnę. Pomiar z fragmentów linii
/// TextKit 2 w komórce wiadomości, nie z metryk pisma. Właściciel: transkrypt.
@MainActor
final class TranscriptProseWidthTests: XCTestCase {
  private static let paragraph = String(
    repeating: "Akapit odpowiedzi agenta, który na szerokiej kolumnie iPada w poziomie ciągnąłby się przez cały ekran. ",
    count: 5)
  private static let item = "pozycja listy, która też jest długa i na pełnej szerokości kolumny miałaby ponad sto pięćdziesiąt "
    + "znaków w linii, czyli o wiele za dużo, żeby czytać ją jednym spojrzeniem"
  private static let quote = "Cytat z dokumentacji, równie długi jak akapit, żeby było widać, że kreska cytatu i wcięcie nie "
    + "przesuwają końca linii: proza kończy się w tej samej kolumnie co reszta odpowiedzi, a nie o wcięcie dalej."
  /// Linia kodu ze spacjami, szersza niż 47,5 em: blok kodu zawija się dopiero na krawędzi kolumny.
  private static let codeLine = "let wynik = try parser.notatki(z: plik, kodowanie: .utf8, końceLinii: .crlf)"
    + ".filter { $0.czyPusta == false }.map { $0.przytnij() }.sorted(by: <)  // komentarz na koniec"
  static let markdown = """
    ## Nagłówek sekcji odpowiedzi, który przy szerokiej kolumnie też nie może się ciągnąć bez końca w prawo

    \(paragraph)

    - \(item)
      - zagnieżdżona \(item)
        - jeszcze głębiej \(item)

    > \(quote)

    ```swift
    \(codeLine)
    ```

    | Kolumna | Opis |
    |---|---|
    | parser | dzieli linie |

    ---

    Ostatni akapit.
    """

  /// Kolumna iPada 13" w poziomie (1330 pt): linie prozy kończą się najwyżej na 47,5 em (760 pt) od krawędzi treści —
  /// także pozycja zagnieżdżona i cytat, choć zaczynają się z wcięciem — i do tej granicy dochodzą. Blok kodu (tło
  /// i linia), tabela i linia pozioma zostają na pełnej szerokości.
  func testProseStopsAtMeasureInWideColumn() throws {
    let style = Self.style(.large)
    let measure = CGFloat(TranscriptSpacing.standard.readableEm)
      * Fonts.text(MarkdownRenderer.transcriptStyle, traits: style.traits).pointSize
    XCTAssertEqual(measure, 760, accuracy: 0.01, "47,5 em przy 16 pt")
    let (window, view, textView) = try Self.host(MarkdownCache().text(Self.markdown, style: style), width: 1_330)
    defer { window.isHidden = true }
    let full = textView.bounds.width
    XCTAssertEqual(full, 1_330 - 32, accuracy: 0.5, "pole tekstu na całą kolumnę")

    let paragraphs = Self.paragraphs(textView)
    let prose = paragraphs.filter { $0.kind == .prose }
    XCTAssertGreaterThanOrEqual(prose.count, 6, "nagłówek, akapit, trzy pozycje, cytat, ostatni akapit")
    var report: [String] = []
    for paragraph in prose {
      report.append("proza od x=\(Self.f(paragraph.minX)) do x=\(Self.f(paragraph.maxX)), linii \(paragraph.lines)")
      XCTAssertLessThanOrEqual(paragraph.maxX, measure + 0.5, "proza najwyżej 47,5 em: \(paragraph.text.prefix(40))")
      if paragraph.lines >= 2 {
        XCTAssertGreaterThan(paragraph.maxX, measure - 80, "zawinięta proza dochodzi do granicy: \(paragraph.text.prefix(40))")
      }
    }
    // Wcięcie nie przesuwa końca linii: najgłębsza pozycja listy i cytat startują dalej, kończą się tak samo.
    let deepest = try XCTUnwrap(prose.first { $0.text.contains("jeszcze głębiej") })
    XCTAssertGreaterThan(deepest.minX, 40, "pozycja zagnieżdżona z wcięciem")
    XCTAssertGreaterThan(deepest.maxX, measure - 80)
    let quoted = try XCTUnwrap(prose.first { $0.text.contains("Cytat z dokumentacji") })
    XCTAssertGreaterThan(quoted.minX, 10, "cytat z wcięciem")

    let code = try XCTUnwrap(paragraphs.first { $0.kind == .code }, "linia kodu")
    report.append("kod do x=\(Self.f(code.maxX))")
    XCTAssertGreaterThan(code.maxX, measure + 200, "kod bez limitu prozy")
    let box = try XCTUnwrap(TranscriptLeadingTests.views(of: CodeBlockBox.self, in: view).first { !$0.isHidden })
    XCTAssertEqual(box.frame.width, full, accuracy: 0.5, "tło bloku kodu na całą kolumnę")
    let table = try XCTUnwrap(TranscriptLeadingTests.views(of: MarkdownTableView.self, in: view).first)
    XCTAssertEqual(table.frame.width, full, accuracy: 0.5, "tabela na całą kolumnę")
    let rule = try XCTUnwrap(paragraphs.first { $0.kind == .rule }, "linia pozioma")
    XCTAssertEqual(rule.decorationWidth, full, accuracy: 0.5, "linia pozioma do prawej krawędzi kolumny")
    report.append("kolumna \(Self.f(full)), tło kodu \(Self.f(box.frame.width)), tabela \(Self.f(table.frame.width))")
    add(Self.keep(report.joined(separator: "\n"), name: "linie przy kolumnie 1330"))
  }

  /// Full width mode: the same reply in the 1330 pt column runs its prose to the column's edge, past 47.5 em.
  func testFullWidthProseRunsAcrossColumn() throws {
    var style = Self.style(.large)
    style.fullWidth = true
    let (window, _, textView) = try Self.host(MarkdownCache().text(Self.markdown, style: style), width: 1_330)
    defer { window.isHidden = true }
    let column = textView.bounds.width
    let prose = Self.paragraphs(textView).filter { $0.kind == .prose && $0.lines >= 2 }
    XCTAssertFalse(prose.isEmpty, "wrapped prose")
    for paragraph in prose {
      XCTAssertGreaterThan(paragraph.maxX, column - 120, "prose reaches the column's edge: \(paragraph.text.prefix(40))")
      XCTAssertLessThanOrEqual(paragraph.maxX, column + 0.5)
    }
  }

  /// Settings switches the mode while the session screen is open: the reply renders again, from 47.5 em to the whole
  /// column and back, without reopening the session.
  func testModeChangeRendersSessionAgain() throws {
    let suite = "rarog-test-transcript-width-\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let width = TranscriptWidth(defaults: defaults)
    let (controller, window) = try Self.sessionScreen(size: CGSize(width: 1_376, height: 1_032), theme: .dark, width: width)
    defer { window.isHidden = true }
    func widest() throws -> CGFloat {
      let answer = try XCTUnwrap(
        Self.textViews(in: controller.collectionView).first { $0.accessibilityIdentifier == "message.m2.0" })
      return Self.paragraphs(answer).filter { $0.kind == .prose }.map(\.maxX).max() ?? 0
    }
    XCTAssertLessThanOrEqual(try widest(), 760.5, "readable by default")
    width.choose(.full)
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    window.layoutIfNeeded()
    XCTAssertGreaterThan(try widest(), 1_000, "full width without reopening the session")
    width.choose(.readable)
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    window.layoutIfNeeded()
    XCTAssertLessThanOrEqual(try widest(), 760.5, "readable again")
  }

  /// iPhone (kolumna węższa od limitu): limit się nie włącza — linie łamią się dokładnie tak jak bez niego.
  func testNarrowColumnBreaksLikeWithoutLimit() throws {
    let text = MarkdownCache().text(Self.markdown, style: Self.style(.large))
    let (window, _, textView) = try Self.host(text, width: 390)
    defer { window.isHidden = true }
    let (bareWindow, _, bareView) = try Self.host(Self.withoutProseLimit(text), width: 390)
    defer { bareWindow.isHidden = true }
    let limited = Self.paragraphs(textView)
    let bare = Self.paragraphs(bareView)
    XCTAssertEqual(limited.map(\.lines), bare.map(\.lines), "te same linie")
    XCTAssertEqual(limited.map(\.maxX), bare.map(\.maxX), "te same końce linii")
    XCTAssertEqual(textView.bounds.height, bareView.bounds.height, accuracy: 0.5, "ta sama wysokość wiadomości")
  }

  /// Zmiana szerokości kolumny (obrót, okno, lista sesji) nie przebudowuje stylu: ten sam tekst w polu układa się
  /// w nowej szerokości — szerzej niż limit linie stoją na 47,5 em, węziej wypełniają kolumnę — a zaznaczenie zostaje.
  func testWidthChangeKeepsStyleAndSelection() throws {
    let text = MarkdownCache().text(Self.markdown, style: Self.style(.large))
    let (window, view, textView) = try Self.host(text, width: 1_330)
    defer { window.isHidden = true }
    let shown = try XCTUnwrap(textView.textLayoutManager?.textContentManager as? NSTextContentStorage).attributedString
    textView.selectedRange = NSRange(location: 3, length: 120)
    var report: [String] = []
    for width in [CGFloat(1_000), 600, 1_330] {
      Self.resize(view, in: window, width: width)
      let column = textView.bounds.width
      let limit = min(column, 760)
      let prose = Self.paragraphs(textView).filter { $0.kind == .prose }
      let widest = prose.map(\.maxX).max() ?? 0
      report.append("kolumna \(Self.f(column)): proza do x=\(Self.f(widest))")
      XCTAssertLessThanOrEqual(widest, limit + 0.5, "kolumna \(column)")
      XCTAssertGreaterThan(widest, limit - 80, "kolumna \(column): proza wypełnia miejsce do granicy")
      XCTAssertEqual(textView.selectedRange, NSRange(location: 3, length: 120), "zaznaczenie po zmianie na \(width)")
    }
    let after = try XCTUnwrap(textView.textLayoutManager?.textContentManager as? NSTextContentStorage).attributedString
    XCTAssertTrue(after === shown, "tekst w polu bez przebudowy")
    add(Self.keep(report.joined(separator: "\n"), name: "zmiana szerokości"))
  }

  /// Ten sam limit na każdej ścieżce prozy przez renderer: płynąca odpowiedź, wiadomość systemu (47,5 em JEJ pisma)
  /// i wpis w locie (dymek ma węższy kontener, więc limit go nie zmienia).
  func testLimitOnEveryProsePath() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    let controller = fixture.controller
    let traits = controller.traitCollection
    let body = Fonts.text(MarkdownRenderer.transcriptStyle, traits: traits).pointSize
    let notice = Fonts.text(MarkdownRenderer.noticeStyle, traits: traits).pointSize
    let em = CGFloat(TranscriptSpacing.standard.readableEm)
    let cases: [(String, MessageContentConfiguration, CGFloat)] = [
      ("płynąca", controller.textConfiguration(.open(voice: nil, markdown: Self.paragraph)), em * body),
      ("system", controller.textConfiguration(.text(id: "m3.0", role: .system, voice: .system, markdown: Self.paragraph)),
       em * notice),
      ("w locie", controller.pendingConfiguration(entry: UUID(), voice: .user, text: Self.paragraph),
       MessageContentView.plateCap(traits, spacing: .standard) - 2 * MessageContentView.plateHorizontal),
    ]
    for (name, config, limit) in cases {
      let (window, _, textView) = try Self.host(config, width: 1_330)
      defer { window.isHidden = true }
      let widest = Self.paragraphs(textView).map(\.maxX).max() ?? 0
      XCTAssertLessThanOrEqual(widest, limit + 0.5, name)
      XCTAssertGreaterThan(widest, limit - 80, "\(name): linie dochodzą do granicy")
    }
  }

  /// Ekran sesji z promptami i długimi odpowiedziami, odjechany od dna: iPad 13" w poziomie i wąskie okno, oba motywy.
  /// Proza w komórce odpowiedzi kończy się 16 pt + 47,5 em od lewej krawędzi ekranu, blok kodu idzie dalej. Zrzuty idą
  /// do załączników wyniku i do katalogu z `RAROG_SHOTS` (`TEST_RUNNER_RAROG_SHOTS` przy `xcodebuild`), gdy jest.
  func testSessionScreens() throws {
    for (name, size) in [("ipad-poziomo", CGSize(width: 1_376, height: 1_032)), ("waskie", CGSize(width: 420, height: 912))] {
      for theme in [UIUserInterfaceStyle.dark, .light] {
        let (controller, window) = try Self.sessionScreen(size: size, theme: theme)
        defer { window.isHidden = true }
        let column = controller.collectionView.bounds.width - 32
        let limit = min(column, 760)
        let answer = try XCTUnwrap(
          Self.textViews(in: controller.collectionView).first { $0.accessibilityIdentifier == "message.m2.0" },
          "odpowiedź z prozą i kodem na ekranie")
        let prose = Self.paragraphs(answer).filter { $0.kind == .prose }
        XCTAssertLessThanOrEqual(prose.map(\.maxX).max() ?? 0, limit + 0.5, "\(name): proza ≤ 47,5 em")
        XCTAssertEqual(answer.convert(answer.bounds, to: window).minX, 16, accuracy: 0.5, "\(name): treść 16 pt od krawędzi")
        Self.shoot(window, name: "transkrypt-\(name)-\(theme == .dark ? "ciemny" : "jasny")", test: self)
      }
    }
  }

  /// Ekran sesji `s1` z trzema turami (prompt + odpowiedź z prozą, listą, cytatem, kodem i tabelą), odjechany od dna tak,
  /// że u góry stoi pasek cytatu promptu. Pamięć miejsca czytania wraca po teście do pustej.
  static func sessionScreen(
    size: CGSize, theme: UIUserInterfaceStyle, width: TranscriptWidth = .shared, density: TranscriptDensity = .shared
  ) throws -> (SessionViewController, UIWindow) {
    let store = try SessionToastTests.makeStore(messages: 1)
    var messages: [[String: Any]] = []
    let prompts = [
      "Popraw parser notatek tak, żeby dzielił linie po znaku nowej linii, a nie po średniku, i dopisz test.",
      "Dobrze. Teraz sprawdź, czy import CSV też łamie linie w ten sam sposób.",
      "Puść bramkę.",
    ]
    for (index, prompt) in prompts.enumerated() {
      let at = "2026-10-09T10:0\(index):00.000Z"
      messages.append(["seq": 2 * index + 1, "role": "user", "at": at, "blocks": [["type": "text", "text": prompt]]])
      messages.append(["seq": 2 * index + 2, "role": "assistant", "at": at, "blocks": [["type": "text", "text": markdown]]])
    }
    let frame: [String: Any] = [
      "type": "transcript-snapshot", "sessionId": "s1", "messages": messages, "pendingPermissions": [],
      "pendingQuestions": [],
    ]
    let json = try XCTUnwrap(String(data: JSONSerialization.data(withJSONObject: frame), encoding: .utf8))
    try SessionToastTests.frame(store, json, source: .session("s1"))
    let controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
    controller.transcriptWidth = width
    controller.transcriptDensity = density
    let window = UIWindow(frame: CGRect(origin: .zero, size: size))
    window.overrideUserInterfaceStyle = theme
    window.rootViewController = controller
    window.isHidden = false
    window.layoutIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    // Druga odpowiedź tuż pod paskiem: prompt pierwszej tury nad krawędzią, pasek cytuje go.
    controller.pinned = false
    let list = controller.collectionView!
    if let index = controller.dataSource.indexPath(for: "m2.0"), let row = list.layoutAttributesForItem(at: index) {
      controller.setClampedOffset(row.frame.minY + 120 - list.adjustedContentInset.top)
    }
    window.layoutIfNeeded()
    controller.renderPromptBar(nil)
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    return (controller, window)
  }

  /// Zrzut okna do załącznika i do katalogu `RAROG_SHOTS`. Render warstwy, nie `drawHierarchy`: target testów nie ma
  /// hosta apki, więc okno nie trafia na ekran, a `drawHierarchy` oddawało pustą biel (rozmycia warstwa nie odda).
  static func shoot(_ window: UIWindow, name: String, test: XCTestCase) {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 2
    let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
      window.layer.render(in: context.cgContext)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    test.add(attachment)
    guard let directory = ProcessInfo.processInfo.environment["RAROG_SHOTS"], let data = image.pngData() else { return }
    try? data.write(to: URL(fileURLWithPath: directory).appending(path: "\(name).png"))
  }

  static func textViews(in view: UIView) -> [UITextView] {
    view.subviews.flatMap { ($0 as? UITextView).map { [$0] } ?? textViews(in: $0) }
  }

  // MARK: - Pomocnicze

  enum Kind {
    case prose, code, table, rule
  }

  /// Akapit w układzie pola: rodzaj, liczba linii, skrajne x linii i szerokość kreski linii poziomej.
  struct Paragraph {
    let kind: Kind
    let text: String
    let lines: Int
    let minX: CGFloat
    let maxX: CGFloat
    let decorationWidth: CGFloat
  }

  static func paragraphs(_ textView: UITextView) -> [Paragraph] {
    guard let manager = textView.textLayoutManager else { return [] }
    var out: [Paragraph] = []
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      guard let paragraph = fragment.textElement as? NSTextParagraph, paragraph.attributedString.length > 0 else { return true }
      let text = paragraph.attributedString
      let decoration = text.attribute(.rarogDecoration, at: 0, effectiveRange: nil) as? MarkdownDecoration
      var kind = Kind.prose
      switch decoration?.kind {
      case .codeBar: return true
      case .codeLine: kind = .code
      case .rule: kind = .rule
      default: if text.attribute(.attachment, at: 0, effectiveRange: nil) != nil { kind = .table }
      }
      let frame = fragment.layoutFragmentFrame
      let lines = fragment.textLineFragments.filter { $0.characterRange.length > 0 }
        .map { $0.typographicBounds.offsetBy(dx: frame.minX, dy: frame.minY) }
      let width = kind == .rule ? frame.minX + fragment.renderingSurfaceBounds.maxX : 0
      out.append(Paragraph(
        kind: kind, text: text.string, lines: lines.count, minX: lines.map(\.minX).min() ?? 0,
        maxX: lines.map(\.maxX).max() ?? 0, decorationWidth: width))
      return true
    }
    return out
  }

  static func style(_ category: UIContentSizeCategory) -> MarkdownRenderer.Style {
    MarkdownRenderer.Style(
      textColor: Palette.text, base: MarkdownRenderer.transcriptStyle,
      traits: UITraitCollection(traitsFrom: [
        UITraitCollection(preferredContentSizeCategory: category), UITraitCollection(userInterfaceStyle: .dark),
      ]))
  }

  /// Ten sam tekst bez limitu prozy (dodatni `tailIndent` zdjęty) — porównanie bez limitu.
  private static func withoutProseLimit(_ text: NSAttributedString) -> NSAttributedString {
    let out = NSMutableAttributedString(attributedString: text)
    out.enumerateAttribute(.paragraphStyle, in: NSRange(location: 0, length: out.length)) { value, range, _ in
      guard let style = value as? NSParagraphStyle, style.tailIndent > 0,
        let copy = style.mutableCopy() as? NSMutableParagraphStyle
      else { return }
      copy.tailIndent = 0
      out.addAttribute(.paragraphStyle, value: copy, range: range)
    }
    return out
  }

  private static func host(_ text: NSAttributedString, width: CGFloat) throws -> (UIWindow, UIView, UITextView) {
    try host(MessageContentConfiguration(
      voice: nil, text: text, plate: false, dimmed: false, accessibilityIdentifier: "message.m2.0",
      accessibilityPrefix: UICopy.rolePrefix(.assistant)), width: width)
  }

  /// Komórka wiadomości w oknie o szerokości `width`, wysokim na cały tekst (wąska kolumna: kilka tysięcy punktów).
  /// Za niskie okno zostawiało w porównaniu linii nieułożony ostatni akapit.
  private static func host(_ config: MessageContentConfiguration, width: CGFloat) throws -> (UIWindow, UIView, UITextView) {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 4_000))
    window.overrideUserInterfaceStyle = .dark
    let root = UIViewController()
    root.view.backgroundColor = Palette.background
    window.rootViewController = root
    window.makeKeyAndVisible()
    let view = config.makeContentView()
    root.view.addSubview(view)
    resize(view, in: window, width: width)
    let textView = try XCTUnwrap(TranscriptLeadingTests.views(of: UITextView.self, in: view).first)
    return (window, view, textView)
  }

  /// Nowa szerokość komórki: jak przy układzie listy — najpierw szerokość, potem wysokość z samowymiarowania.
  private static func resize(_ view: UIView, in window: UIWindow, width: CGFloat) {
    window.frame.size.width = width
    view.frame = CGRect(x: 0, y: 0, width: width, height: 3_000)
    window.layoutIfNeeded()
    view.layoutIfNeeded()
    let size = view.systemLayoutSizeFitting(
      CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
    view.frame = CGRect(x: 0, y: 0, width: width, height: size.height)
    window.layoutIfNeeded()
    view.layoutIfNeeded()
  }

  private static func keep(_ text: String, name: String) -> XCTAttachment {
    let attachment = XCTAttachment(string: text)
    attachment.name = name
    attachment.lifetime = .keepAlways
    return attachment
  }

  private static func f(_ value: CGFloat) -> String { String(format: "%.1f", Double(value)) }
}
