@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Interlinia prozy i odstępy tury w transkrypcie. Interlinia mierzona z układu akapitu
/// w komórce wiadomości, nie z `UIFont.lineHeight` (TextKit 2 układa luźniej niż metryka pisma
/// `TextKitTypesetProbeTests`). Właściciel: transkrypt.
@MainActor
final class TranscriptLeadingTests: XCTestCase {
  private static let prose = "Akapit odpowiedzi agenta, dość długi, żeby zawinął się w kilka linii w wąskiej kolumnie i pokazał "
    + "interlinię prozy. Drugie zdanie dokłada jeszcze kilka słów, a trzecie zamyka akapit."
  private static let list = "- pozycja listy, która też zawija się w dwie albo trzy linie przy tej szerokości kolumny transkryptu"
  /// Krótkie linie: w piśmie dostępności kod nie zawija się w kolumnie 360 pt.
  private static let code = "```\nlet a = 1\nlet b = 2\n```"

  /// Proza (akapit, lista, cytat, nagłówek) stoi co ~1,5 stopnia pisma w każdym rozmiarze; linie kodu w bloku zostają
  /// przy naturalnym odstępie swojego pisma.
  func testProseLineHeightIsOneAndAHalfAtEveryTextSize() throws {
    let fixture = try session()
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    let markdown = "## Nagłówek sekcji, który przy dużym piśmie łamie się w dwie linie\n\n\(Self.prose)\n\n\(Self.list)\n\n"
      + "> Cytat, który również zawija się w kilka linii w kolumnie tej szerokości, żeby było co mierzyć.\n\n\(Self.code)"
    var report: [String] = []
    for category in [UIContentSizeCategory.extraSmall, .large, .extraExtraExtraLarge, .accessibilityExtraExtraExtraLarge] {
      controller.traitOverrides.preferredContentSizeCategory = category
      controller.view.layoutIfNeeded()
      let config = controller.textConfiguration(.text(id: "m2.0", role: .assistant, voice: .assistant, markdown: markdown))
      let (window, _, textView) = try Self.host(config, width: 360)
      defer { window.isHidden = true }
      var checked = 0
      for paragraph in Self.paragraphs(textView) where paragraph.lines.count >= 2 {
        let pitches = zip(paragraph.lines.dropFirst(), paragraph.lines).map { $0 - $1 }
        if paragraph.code {
          // Linia kodu to osobny akapit: w jednym akapicie kodu dwóch linii nie ma — sprawdzamy niżej.
          continue
        }
        for pitch in pitches {
          XCTAssertEqual(pitch, paragraph.font.pointSize * ProseLeading.ratio, accuracy: 0.5,
                         "\(category.rawValue): \(paragraph.font.pointSize) pt, odstęp \(pitch)")
        }
        checked += 1
        report.append("\(category.rawValue) \(paragraph.font.pointSize) pt: \(pitches.map { String(format: "%.2f", $0) })")
      }
      XCTAssertGreaterThanOrEqual(checked, 3, "\(category.rawValue): akapit, lista i cytat zawinięte")
      // Kod: kolejne linie bloku (osobne akapity bez odstępu) stoją co naturalny odstęp — pisma kodu albo pisma treści
      // znaku końca akapitu — bez interlinii prozy.
      let paragraphs = Self.paragraphs(textView)
      let codeLines = paragraphs.filter(\.code).flatMap(\.lines)
      let codeFont = try XCTUnwrap(paragraphs.first(where: \.code)?.font)
      // Pismo treści: akapit pod nagłówkiem.
      let body = try XCTUnwrap(paragraphs.dropFirst().first?.font)
      XCTAssertEqual(codeLines.count, 2, "\(category.rawValue): dwie linie kodu")
      if codeLines.count == 2 {
        let natural = max(ProseLeading.naturalPitch(codeFont), ProseLeading.naturalPitch(body))
        XCTAssertLessThanOrEqual(codeLines[1] - codeLines[0], natural + 0.5, "\(category.rawValue): kod bez interlinii prozy")
        report.append("\(category.rawValue) kod \(codeFont.pointSize) pt: \(String(format: "%.2f", codeLines[1] - codeLines[0]))")
      }
    }
    let attachment = XCTAttachment(string: report.joined(separator: "\n"))
    attachment.name = "odstępy linii prozy"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// Tło kodu w linii nie rośnie z interlinią (pas tła niższy od odstępu linii), a zaznaczenie przechodzi przez
  /// interlinię bez szczelin (piksele, ciemny motyw).
  func testInlineCodeBackgroundAndSelectionThroughLeading() throws {
    let markdown = "Akapit z `kodem w linii` i dalej słowa, które zawijają się w kilka linii w wąskiej kolumnie transkryptu, "
      + "żeby było widać interlinię między nimi."
    let style = MarkdownRenderer.Style(
      textColor: Palette.text, base: MarkdownRenderer.transcriptStyle, traits: UITraitCollection(userInterfaceStyle: .dark))
    let config = MessageContentConfiguration(
      voice: nil, text: MarkdownCache().text(markdown, style: style), plate: false, dimmed: false,
      accessibilityIdentifier: "message.m1.0", accessibilityPrefix: nil)
    let (window, _, textView) = try Self.host(config, width: 320)
    defer { window.isHidden = true }
    let background = Self.hex(Palette.background.resolvedColor(with: window.traitCollection))
    let lines = try XCTUnwrap(Self.paragraphs(textView).first).lines
    guard lines.count >= 3 else { return XCTFail("akapit niezawinięty: \(lines)") }
    XCTAssertGreaterThanOrEqual(lines.count, 3, "akapit zawinięty")
    let pitch = lines[1] - lines[0]

    // Pas tła kodu w kolumnie spacji między „kodem” a „w”: same piksele tła kodu, bez glifów.
    let text = textView.attributedText.string as NSString
    let space = text.range(of: "kodem w").location + 5
    let spaceRect = try XCTUnwrap(Self.segment(textView, NSRange(location: space, length: 1)))
    let plain = try XCTUnwrap(Bitmap(window))
    let column = textView.convert(CGPoint(x: spaceRect.midX, y: spaceRect.midY), to: window)
    let band = CGFloat(plain.run(differentFrom: background, x: column.x, aroundY: column.y))
    XCTAssertGreaterThan(band, 10, "tło kodu w linii widać")
    XCTAssertLessThan(band, pitch - 2, "tło kodu w linii (\(band) pt) nie wypełnia interlinii (\(pitch) pt)")

    // Bez zaznaczenia między liniami prześwituje tło; z zaznaczeniem — nie.
    let first = textView.convert(CGPoint(x: 20, y: lines[0]), to: window)
    let last = textView.convert(CGPoint(x: 20, y: lines[lines.count - 1]), to: window)
    let gapsBefore = plain.rows(equalTo: background, x: first.x, from: first.y, to: last.y)
    XCTAssertGreaterThan(gapsBefore, 0, "między liniami widać tło (interlinia)")
    XCTAssertTrue(textView.becomeFirstResponder())
    textView.selectedRange = NSRange(location: 0, length: textView.attributedText.length)
    window.layoutIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    let selected = try XCTUnwrap(Bitmap(window))
    let gapsAfter = selected.rows(equalTo: background, x: first.x, from: first.y, to: last.y)
    XCTAssertEqual(gapsAfter, 0, "zaznaczenie bez szczelin w interlinii (przed zaznaczeniem tła: \(gapsBefore) px)")
  }

  /// Kreska cytatu przechodzi przez odstęp i interlinię między akapitami cytatu bez przerwy.
  func testQuoteBarJoinsAcrossLeading() throws {
    let markdown = "> Pierwszy akapit cytatu.\n>\n> Drugi akapit cytatu."
    let style = MarkdownRenderer.Style(
      textColor: Palette.text, base: MarkdownRenderer.transcriptStyle, traits: UITraitCollection(userInterfaceStyle: .dark))
    let config = MessageContentConfiguration(
      voice: nil, text: MarkdownCache().text(markdown, style: style), plate: false, dimmed: false,
      accessibilityIdentifier: "message.m1.0", accessibilityPrefix: nil)
    let (window, _, textView) = try Self.host(config, width: 320)
    defer { window.isHidden = true }
    let background = Self.hex(Palette.background.resolvedColor(with: window.traitCollection))
    let paragraphs = Self.paragraphs(textView)
    XCTAssertEqual(paragraphs.count, 2)
    let bitmap = try XCTUnwrap(Bitmap(window))
    let top = textView.convert(CGPoint(x: 1, y: try XCTUnwrap(paragraphs.first?.lines.first)), to: window)
    let bottom = textView.convert(CGPoint(x: 1, y: try XCTUnwrap(paragraphs.last?.lines.last)), to: window)
    XCTAssertEqual(bitmap.rows(equalTo: background, x: top.x, from: top.y, to: bottom.y), 0, "kreska cytatu bez przerwy")
  }

  /// Odstępy tury w komórce tekstu: 32 pt nad promptem, 10 pt nad pierwszym wierszem odpowiedzi (także płynącej),
  /// poza granicą tury reguła wiersza (12 pt przy zmianie głosu).
  func testTurnGapsInTextCells() throws {
    let fixture = try session()
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    func top(_ row: TranscriptRow) -> CGFloat {
      let view = controller.textConfiguration(row).makeContentView()
      return view.directionalLayoutMargins.top
    }
    XCTAssertEqual(top(.text(id: "m3.0", role: .user, voice: .user, markdown: "Prompt", turn: TurnMark(gap: .turn))), 32)
    XCTAssertEqual(top(.text(id: "m4.0", role: .assistant, voice: .assistant, markdown: "Odpowiedź",
                             turn: TurnMark(gap: .afterPrompt))), 10)
    XCTAssertEqual(top(.open(voice: .assistant, markdown: "Płynie…", turn: TurnMark(gap: .afterPrompt))), 10, "otwarta odpowiedź")
    XCTAssertEqual(top(.pending(entry: UUID(), voice: .user, text: "W drodze", turn: TurnMark(gap: .turn))), 32, "wpis w locie")
    XCTAssertEqual(top(.text(id: "m5.0", role: .system, voice: .system, markdown: "Wtrącenie")), 12, "zmiana głosu poza turą")
  }

  /// Odstępy tury w wierszach SwiftUI: narzędzie i rozwijak serii jako pierwszy wiersz po prompcie, znacznik nad promptem.
  func testTurnGapsInHostedRows() {
    func height(_ view: some View) -> CGFloat {
      UIHostingController(rootView: view.frame(width: 400)).sizeThatFits(in: CGSize(width: 400, height: 2_000)).height
    }
    func tool(_ gap: TurnGap) -> ToolCardView {
      ToolCardView(
        model: ToolRowModel(
          id: "m2.0", voice: nil, toolName: "Grep", summary: "krok", detail: nil, diff: nil, shell: false, expanded: false,
          diffTailOpen: false, turn: TurnMark(gap: gap)),
        plainSyntax: false, toggle: {}, openDiffTail: {})
    }
    func run(_ gap: TurnGap) -> ToolRunChipView {
      ToolRunChipView(model: ToolRunModel(id: 2, voice: nil, hidden: 3, expanded: false, turn: TurnMark(gap: gap)), toggle: {})
    }
    XCTAssertEqual(height(tool(.afterPrompt)) - height(tool(.flow)), 8, accuracy: 0.5, "narzędzie po prompcie: 10 pt zamiast 2")
    XCTAssertEqual(height(tool(.turn)) - height(tool(.flow)), 30, accuracy: 0.5, "narzędzie na granicy tury: 32 pt")
    XCTAssertEqual(height(run(.afterPrompt)) - height(run(.flow)), 8, accuracy: 0.5, "rozwijak po prompcie")
    let day = TimeMark(day: "pt. 9 paź", spokenDay: "piątek, 9 października", clock: nil)
    XCTAssertEqual(height(TimeGapView(mark: day, gap: .turn)) - height(TimeGapView(mark: day)), 18, accuracy: 0.5,
                   "data nad promptem: 32 pt zamiast 14")
    XCTAssertEqual(height(NewMarkerView(gap: .afterPrompt)) - height(NewMarkerView()), -4, accuracy: 0.5, "„NOWE” po prompcie")
  }

  /// Na prawdziwym ekranie sesji komórka wiersza SwiftUI jest wysoka jak jego treść: bez systemowej minimalnej
  /// wysokości wiersza listy (52 pt w symulatorze iOS 27), w której niski wiersz stał wyśrodkowany i odsuwał sąsiadów
  /// dalej, niż mówią odstępy tury. Sprawdzane: znacznik dnia nad promptem i karta narzędzia.
  func testHostedRowCellsHaveNoSystemMinimumHeight() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    let controller = fixture.controller
    func message(_ seq: Int, _ role: String, _ at: String, _ blocks: String) -> String {
      #"{"seq":\#(seq),"role":"\#(role)","at":"\#(at)","blocks":\#(blocks)}"#
    }
    let messages = [
      message(1, "user", "2026-10-08T10:00:00.000Z", #"[{"type":"text","text":"Wczoraj"}]"#),
      message(2, "assistant", "2026-10-08T10:00:05.000Z", #"[{"type":"text","text":"Odpowiedź."}]"#),
      message(3, "user", "2026-10-09T10:00:00.000Z", #"[{"type":"text","text":"Dziś"}]"#),
      message(4, "assistant", "2026-10-09T10:00:05.000Z", #"[{"type":"tool-call","toolName":"Grep","summary":"krok"}]"#),
      message(5, "assistant", "2026-10-09T10:00:09.000Z", #"[{"type":"text","text":"Gotowe."}]"#),
    ]
    try SessionToastTests.frame(fixture.store, #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(messages.joined(separator: ","))],
       "pendingPermissions":[],"pendingQuestions":[]}
      """#, source: .session("s1"))
    SessionToastTests.spin(0.3)
    for _ in 0..<3 {
      controller.view.setNeedsLayout()
      controller.view.layoutIfNeeded()
      controller.collectionView.layoutIfNeeded()
      SessionToastTests.spin(0.05)
    }
    let width = controller.collectionView.bounds.width - 32
    var checked: [String] = []
    for id in controller.dataSource.snapshot().itemIdentifiers {
      guard let row = controller.rows[id], !row.isTextual, let index = controller.dataSource.indexPath(for: id),
            let cell = controller.collectionView.layoutAttributesForItem(at: index)?.frame
      else { continue }
      let content = UIHostingController(rootView: controller.hostedView(row).frame(width: width))
        .sizeThatFits(in: CGSize(width: width, height: 2_000)).height
      XCTAssertEqual(cell.height, content, accuracy: 0.5, "komórka \(id) = treść")
      checked.append(id)
    }
    XCTAssertTrue(checked.contains("m4.0"), "karta narzędzia: \(checked)")
    XCTAssertTrue(checked.contains { $0.hasPrefix("t") }, "znacznik dnia: \(checked)")
    XCTAssertTrue(checked.contains { id in
      guard let index = controller.dataSource.indexPath(for: id),
            let frame = controller.collectionView.layoutAttributesForItem(at: index)?.frame else { return false }
      return frame.height < 52
    }, "co najmniej jeden wiersz niższy niż dawne minimum 52 pt: \(checked)")
  }

  /// Wpis w locie stoi tym samym renderem co jego echo: ten sam tekst z atrybutami
  /// (interlinia, kod w linii, blok kodu, lista) i ta sama wysokość dymku — przy potwierdzeniu dymek nie skacze.
  func testPendingEntryRendersLikeItsEcho() throws {
    let fixture = try session()
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    let markdown = "Popraw `parser.ts` w dwóch miejscach, bo dzieli linie złym znakiem:\n\n\(Self.code)\n\n- i dodaj test"
    let pending = controller.pendingConfiguration(entry: UUID(), voice: .user, text: markdown, turn: TurnMark(gap: .turn))
    let echo = controller.textConfiguration(
      .text(id: "m9.0", role: .user, voice: .user, markdown: markdown, turn: TurnMark(gap: .turn)))
    XCTAssertTrue(pending.plate && echo.plate)
    XCTAssertEqual(pending.text, echo.text, "ten sam render markdownu")
    XCTAssertNotEqual(pending.text.string, markdown, "markdown wyrenderowany, nie dosłowny")
    let (pendingWindow, pendingView, _) = try Self.host(pending, width: 400)
    defer { pendingWindow.isHidden = true }
    let (echoWindow, echoView, _) = try Self.host(echo, width: 400)
    defer { echoWindow.isHidden = true }
    XCTAssertEqual(pendingView.bounds.height, echoView.bounds.height, accuracy: 0.5, "ta sama wysokość dymku")
  }

  // MARK: - Pomocnicze

  /// Ekran sesji `s1`; po teście pamięć miejsca czytania wraca do pustej — schowane okno zapisuje kotwicę sesji, a ta
  /// odpinałaby ekran `s1` w następnych klasach (`TranscriptSettleTests` czeka na dno po wejściu).
  private func session() throws -> SessionLayoutTests.Fixture {
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    return try SessionLayoutTests.makeSession(safeBottom: 0)
  }

  /// Akapit tekstu z liniami bazowymi (w układzie pola) i pismem pierwszego znaku.
  private struct Paragraph {
    let lines: [CGFloat]
    let font: UIFont
    let code: Bool
  }

  private static func paragraphs(_ textView: UITextView) -> [Paragraph] {
    guard let manager = textView.textLayoutManager else { return [] }
    var out: [Paragraph] = []
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      guard let paragraph = fragment.textElement as? NSTextParagraph, paragraph.attributedString.length > 0 else { return true }
      let text = paragraph.attributedString
      // Pierwszy znak treści: pozycja listy zaczyna się tabulatorem znacznika.
      let index = text.string.firstIndex { !$0.isWhitespace }.map { text.string.distance(from: text.string.startIndex, to: $0) } ?? 0
      guard let font = text.attribute(.font, at: min(index, text.length - 1), effectiveRange: nil) as? UIFont else { return true }
      let decoration = text.attribute(.rarogDecoration, at: 0, effectiveRange: nil) as? MarkdownDecoration
      var code = false
      if case .codeLine = decoration?.kind { code = true }
      if case .codeBar = decoration?.kind { return true }
      let frame = fragment.layoutFragmentFrame
      let lines = fragment.textLineFragments.filter { $0.characterRange.length > 0 }.map {
        frame.minY + $0.typographicBounds.minY + $0.glyphOrigin.y
      }
      out.append(Paragraph(lines: lines, font: font, code: code))
      return true
    }
    return out
  }

  private static func segment(_ view: UITextView, _ range: NSRange) -> CGRect? {
    guard let manager = view.textLayoutManager, let content = manager.textContentManager,
      let start = content.location(content.documentRange.location, offsetBy: range.location),
      let end = content.location(start, offsetBy: range.length),
      let textRange = NSTextRange(location: start, end: end)
    else { return nil }
    var found: CGRect?
    manager.enumerateTextSegments(in: textRange, type: .standard, options: []) { _, frame, _, _ in
      found = frame
      return false
    }
    return found
  }

  static func host(_ config: MessageContentConfiguration, width: CGFloat) throws -> (UIWindow, UIView, UITextView) {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 1_200))
    window.overrideUserInterfaceStyle = .dark
    let root = UIViewController()
    root.view.backgroundColor = Palette.background
    window.rootViewController = root
    window.makeKeyAndVisible()
    let view = config.makeContentView()
    // Najpierw w oknie i w pełnej szerokości: pole tekstu liczy wysokość z szerokości, którą już ma (kontener TextKit 2
    // idzie za ramką pola, także wysokością — za niski kontener układa tylko pierwsze linie).
    view.frame = CGRect(x: 0, y: 0, width: width, height: 1_000)
    root.view.addSubview(view)
    window.layoutIfNeeded()
    view.layoutIfNeeded()
    let size = view.systemLayoutSizeFitting(
      CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
    view.frame = CGRect(x: 0, y: 0, width: width, height: size.height)
    window.layoutIfNeeded()
    view.layoutIfNeeded()
    let textView = try XCTUnwrap(views(of: UITextView.self, in: view).first)
    return (window, view, textView)
  }

  static func views<T: UIView>(of type: T.Type, in view: UIView) -> [T] {
    view.subviews.flatMap { ($0 as? T).map { [$0] } ?? [] + views(of: type, in: $0) }
  }

  static func hex(_ color: UIColor) -> UInt32 {
    var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
    color.getRed(&r, green: &g, blue: &b, alpha: &a)
    return UInt32((r * 255).rounded()) << 16 | UInt32((g * 255).rounded()) << 8 | UInt32((b * 255).rounded())
  }

  /// Render okna w skali 1 punkt = 1 piksel.
  struct Bitmap {
    let width: Int
    let height: Int
    let bytes: [UInt8]

    init?(_ window: UIWindow) {
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
        window.layer.render(in: context.cgContext)
      }
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
      guard drawn else { return nil }
      width = cg.width
      height = cg.height
      self.bytes = bytes
    }

    func matches(_ x: Int, _ y: Int, _ rgb: UInt32) -> Bool {
      guard x >= 0, x < width, y >= 0, y < height else { return false }
      let i = (y * width + x) * 4
      let target = [Int((rgb >> 16) & 0xFF), Int((rgb >> 8) & 0xFF), Int(rgb & 0xFF)]
      return (0..<3).allSatisfy { abs(Int(bytes[i + $0]) - target[$0]) <= 3 }
    }

    /// Ciągły pas pikseli innych niż `rgb` w kolumnie `x` przez wiersz `aroundY`.
    func run(differentFrom rgb: UInt32, x: CGFloat, aroundY: CGFloat) -> Int {
      let column = Int(x), start = Int(aroundY)
      guard !matches(column, start, rgb) else { return 0 }
      var top = start
      while top > 0, !matches(column, top - 1, rgb) { top -= 1 }
      var bottom = start
      while bottom < height - 1, !matches(column, bottom + 1, rgb) { bottom += 1 }
      return bottom - top + 1
    }

    /// Ile wierszy kolumny `x` między `from` a `to` ma dokładnie kolor `rgb`.
    func rows(equalTo rgb: UInt32, x: CGFloat, from: CGFloat, to: CGFloat) -> Int {
      let column = Int(x)
      return (Int(from)...Int(to)).filter { matches(column, $0, rgb) }.count
    }
  }
}
