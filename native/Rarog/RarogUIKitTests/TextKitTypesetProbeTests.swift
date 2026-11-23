@testable import RarogUI
import UIKit
import XCTest

/// TextKit 2 measurements behind the transcript's line spacing and bubble width; the tests guard the facts the chosen
/// method stands on:
/// - line spacing: `lineSpacing` versus `minimumLineHeight` alone versus `lineHeightMultiple` — baseline distance,
///   inline code background, selection rectangles, glyph overlap (emoji, combining marks), room above the first
///   and below the last line;
/// - a positive `tailIndent` larger than the container;
/// - `usageBoundsForTextContainer` with wrapping, code, a table and a horizontal rule.
/// Owner: transcript, markdown.
@MainActor
final class TextKitTypesetProbeTests: XCTestCase {
  /// Docelowa wysokość linii prozy: 1,5 stopnia pisma.
  private static let ratio: CGFloat = 1.5

  private enum Variant: String, CaseIterable {
    case natural, lineSpacing, minimumLineHeight, lineHeightMultiple
  }

  /// Trzy metody na tym samym akapicie (kod w linii, emoji, znaki łączące) i zaznaczeniu.
  func testLineHeightMethods() throws {
    var report: [String] = []
    var results: [Variant: Measure] = [:]
    for variant in Variant.allCases {
      let measure = try Self.measure(variant)
      results[variant] = measure
      report.append("\(variant.rawValue): \(measure)")
    }
    // Naturalny odstęp linii bazowych bez emoji i kodu, w kilku rozmiarach pisma: od niego liczy się dopełnienie.
    for category in [UIContentSizeCategory.small, .large, .extraExtraExtraLarge, .accessibilityExtraExtraExtraLarge] {
      for sample in Sample.allCases {
        let measure = try Self.measure(.natural, sample: sample, category: category)
        report.append("naturalny \(sample.rawValue) \(category.rawValue): pismo \(Self.f(measure.font)), "
          + "UIFont.lineHeight \(Self.f(measure.natural)), odstęp \(measure.pitches.map(Self.f))")
      }
    }
    let text = report.joined(separator: "\n")
    print(text)
    let attachment = XCTAttachment(string: text)
    attachment.name = "interlinia"
    attachment.lifetime = .keepAlways
    add(attachment)
    // Każda metoda daje równy odstęp linii bazowych (emoji nie rozpycha swojej linii).
    for variant in [Variant.lineSpacing, .minimumLineHeight, .lineHeightMultiple] {
      let pitches = try XCTUnwrap(results[variant]).pitches
      XCTAssertGreaterThanOrEqual(pitches.count, 2, "\(variant): kilka linii")
      XCTAssertLessThan((pitches.max() ?? 0) - (pitches.min() ?? 0), 1, "\(variant): równy odstęp linii \(pitches)")
    }
    // Fakty, na których stoi wybór `lineSpacing`: pierwsza linia bez dopełnienia nad sobą (wstawka dymku i odstęp
    // akapitu bez zmian), tło kodu w linii nie rośnie z interlinią, zaznaczenie bez szczelin między liniami.
    let natural = try XCTUnwrap(results[.natural])
    let chosen = try XCTUnwrap(results[.lineSpacing])
    XCTAssertEqual(chosen.above, natural.above, accuracy: 0.5, "lineSpacing: nic nad pierwszą linią")
    XCTAssertEqual(chosen.codeBand, natural.codeBand, accuracy: 0.5, "lineSpacing: tło kodu w linii bez zmian")
    XCTAssertTrue(chosen.selectionGaps.allSatisfy { abs($0) <= 0.5 }, "lineSpacing: zaznaczenie ciągłe \(chosen.selectionGaps)")
    XCTAssertGreaterThan(try XCTUnwrap(results[.minimumLineHeight]).above, 1, "minimumLineHeight dokłada miejsce NAD pierwszą linią")
  }

  /// `lineSpacing` między akapitami: czy doliczany jest też po ostatniej linii akapitu (przed następnym akapitem).
  func testLineSpacingBetweenParagraphs() throws {
    let font = UIFont.preferredFont(forTextStyle: .callout, compatibleWith: UITraitCollection(preferredContentSizeCategory: .large))
    var report: [String] = []
    for spacing in [CGFloat(0), 3] {
      let para = NSMutableParagraphStyle()
      para.lineSpacing = spacing
      let text = NSAttributedString(
        string: "Pierwszy akapit\nDrugi akapit", attributes: [.font: font, .paragraphStyle: para])
      let (window, view) = Self.host(text, width: 300)
      defer { window.isHidden = true }
      let lines = Self.lines(view)
      let pitch = lines.count == 2 ? lines[1].baseline - lines[0].baseline : -1
      report.append("lineSpacing \(Self.f(spacing)) między akapitami: odstęp linii bazowych \(Self.f(pitch)), "
        + "wysokość pola \(Self.f(view.bounds.height))")
    }
    let text = report.joined(separator: "\n")
    print(text)
    add(Self.keep(text, name: "lineSpacing między akapitami"))
  }

  /// `tailIndent` dodatni (od początku linii) większy od kontenera: linie łamią się na kontenerze czy wychodzą poza?
  func testPositiveTailIndentWiderThanContainer() throws {
    let font = UIFont.preferredFont(forTextStyle: .callout)
    let para = NSMutableParagraphStyle()
    para.tailIndent = 2_000
    let text = NSAttributedString(
      string: String(repeating: "Długi akapit, który musi się zawinąć w wąskim kontenerze. ", count: 6),
      attributes: [.font: font, .paragraphStyle: para])
    let (window, view) = Self.host(text, width: 300)
    defer { window.isHidden = true }
    let lines = Self.lines(view)
    let widest = lines.map(\.bounds.maxX).max() ?? 0
    let line = "tailIndent=2000 w kontenerze 300: linii \(lines.count), najszersza do x=\(Self.f(widest))"
    print(line)
    add(Self.keep(line, name: "tailIndent"))
    XCTAssertGreaterThan(lines.count, 1, "akapit się zawija")
    XCTAssertLessThanOrEqual(widest, 300.5, "linia nie wychodzi poza kontener")
  }

  /// `tailIndent` dodatni przy wcięciu (`headIndent`: pozycja listy zagnieżdżonej, cytat) liczy się od krawędzi
  /// kontenera, nie od wcięcia: linie z wcięciem i bez kończą się w tej samej kolumnie (limit szerokości prozy).
  func testPositiveTailIndentCountsFromContainerEdge() throws {
    let font = UIFont.preferredFont(forTextStyle: .callout)
    var report: [String] = []
    for indent in [CGFloat(0), 80] {
      let para = NSMutableParagraphStyle()
      para.firstLineHeadIndent = indent
      para.headIndent = indent
      para.tailIndent = 500
      let text = NSAttributedString(
        string: String(repeating: "Długi akapit, który zawija się przed sufitem linii. ", count: 8),
        attributes: [.font: font, .paragraphStyle: para])
      let (window, view) = Self.host(text, width: 900)
      defer { window.isHidden = true }
      let lines = Self.lines(view)
      let left = lines.map(\.bounds.minX).min() ?? -1
      let widest = lines.map(\.bounds.maxX).max() ?? 0
      report.append("tailIndent=500 headIndent=\(Self.f(indent)) w kontenerze 900: linii \(lines.count), "
        + "od x=\(Self.f(left)) do x=\(Self.f(widest))")
      XCTAssertGreaterThan(lines.count, 2, "akapit się zawija")
      XCTAssertEqual(left, indent, accuracy: 0.5, "wcięcie \(indent)")
      XCTAssertLessThanOrEqual(widest, 500.5, "wcięcie \(indent): koniec linii od krawędzi kontenera, nie od wcięcia")
      XCTAssertGreaterThan(widest, 440, "wcięcie \(indent): linie dochodzą do sufitu")
    }
    let text = report.joined(separator: "\n")
    print(text)
    add(Self.keep(text, name: "tailIndent przy wcięciu"))
  }

  /// `usageBoundsForTextContainer` przy zawijaniu, kodzie, tabeli, linii poziomej i krótkim tekście, w kontenerze
  /// 560 pt (dymek na iPadzie po odjęciu wstawek), obok najszerszej linii z fragmentów.
  func testUsageBoundsInPlateWidth() throws {
    let style = MarkdownRenderer.Style(
      textColor: Palette.text, base: MarkdownRenderer.transcriptStyle, traits: UITraitCollection(preferredContentSizeCategory: .large))
    let sources: [(String, String)] = [
      ("krótki", "Krótko."),
      ("dwie krótkie linie", "Pierwsza\nDruga, dłuższa linia"),
      ("zawijany", String(repeating: "Akapit, który zawija się w dymku na kilka linii. ", count: 8)),
      ("lista", "- jeden\n- dwa, dłuższy punkt"),
      ("kod", "Zobacz:\n\n```\nlet x = 1\n```"),
      ("tabela", "| a | b |\n|---|---|\n| 1 | 2 |"),
      ("linia pozioma", "Nad\n\n---\n\nPod"),
    ]
    var report: [String] = []
    var usages: [String: CGFloat] = [:]
    for (name, source) in sources {
      let (window, view) = Self.host(MarkdownCache().text(source, style: style), width: 560)
      defer { window.isHidden = true }
      let manager = try XCTUnwrap(view.textLayoutManager)
      manager.ensureLayout(for: manager.documentRange)
      let usage = manager.usageBoundsForTextContainer
      let widest = Self.lines(view).map(\.bounds.maxX).max() ?? 0
      var fragments: CGFloat = 0
      manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
        fragments = max(fragments, fragment.layoutFragmentFrame.maxX)
        return true
      }
      usages[name] = usage.maxX
      report.append("usageBounds \(name): usage.width=\(Self.f(usage.width)) usage.maxX=\(Self.f(usage.maxX)) "
        + "fragmenty.maxX=\(Self.f(fragments)) linie.maxX=\(Self.f(widest))")
      // Szerokość użyta = najszersza linia (nie kontener): na tym stoi tło dymku szerokie jak treść.
      XCTAssertEqual(usage.maxX, widest, accuracy: 0.5, "\(name): usage = najszersza linia")
    }
    let text = report.joined(separator: "\n")
    print(text)
    add(Self.keep(text, name: "usageBounds"))
    XCTAssertLessThan(try XCTUnwrap(usages["krótki"]), 100, "krótki tekst: wąsko")
    // Tło bloku kodu i linia pozioma mają szerokość kontenera, ale usage tego nie widzi — dymek z nimi bierze pełną
    // dozwoloną szerokość z reguły, nie z pomiaru.
    XCTAssertLessThan(try XCTUnwrap(usages["kod"]), 560, "kod: usage = tekst kodu, nie pudełko")
    XCTAssertEqual(try XCTUnwrap(usages["tabela"]), 560, accuracy: 0.5, "tabela: pełna szerokość")
  }

  // MARK: - Pomiar akapitu

  private struct Line {
    let bounds: CGRect
    let baseline: CGFloat
  }

  private struct Measure: CustomStringConvertible {
    var font: CGFloat = 0
    var natural: CGFloat = 0
    var pitches: [CGFloat] = []
    /// Od górnej krawędzi pola do linii bazowej pierwszej linii minus wznoszenie pisma.
    var above: CGFloat = 0
    /// Od linii bazowej ostatniej linii plus zejście pisma do dolnej krawędzi pola.
    var below: CGFloat = 0
    var codeBand: CGFloat = 0
    var selection: [CGFloat] = []
    var selectionGaps: [CGFloat] = []
    var lineOverlap: CGFloat = 0
    var inkOutside: CGFloat = 0

    var description: String {
      "pismo \(f(font)) pt (naturalna linia \(f(natural))), odstępy linii bazowych \(pitches.map(f)), "
        + "nad pierwszą \(f(above)), pod ostatnią \(f(below)), tło kodu w linii \(f(codeBand)), "
        + "zaznaczenie wysokości \(selection.map(f)) przerwy \(selectionGaps.map(f)), "
        + "nachodzenie linii \(f(lineOverlap)), atrament poza liniami \(f(inkOutside))"
    }

    private func f(_ value: CGFloat) -> String { TextKitTypesetProbeTests.f(value) }
  }

  /// Treść akapitu: wszystko naraz albo osobno (czysty tekst, z emoji, z kodem w linii).
  private enum Sample: String, CaseIterable {
    case mixed, latin, emoji, code
  }

  private static func measure(
    _ variant: Variant, sample: Sample = .mixed, category: UIContentSizeCategory = .large
  ) throws -> Measure {
    let font = UIFont.preferredFont(forTextStyle: .callout, compatibleWith: UITraitCollection(preferredContentSizeCategory: category))
    let target = (font.pointSize * ratio).rounded()
    let para = NSMutableParagraphStyle()
    switch variant {
    case .natural: break
    case .lineSpacing: para.lineSpacing = target - font.lineHeight
    case .minimumLineHeight: para.minimumLineHeight = target
    case .lineHeightMultiple: para.lineHeightMultiple = target / font.lineHeight
    }
    let code = UIFont.monospacedSystemFont(ofSize: (font.pointSize * 0.9).rounded(), weight: .regular)
    let magenta = UIColor(red: 1, green: 0, blue: 1, alpha: 1)
    let text = NSMutableAttributedString()
    let plain: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.black, .paragraphStyle: para]
    let filler = " Zwykłe słowa akapitu, które zawijają się w kilka linii w wąskim polu, i jeszcze kilka słów na koniec."
    text.append(NSAttributedString(string: "Pierwsza linia akapitu niesie ", attributes: plain))
    if sample == .mixed || sample == .code {
      var codeAttributes = plain
      codeAttributes[.font] = code
      codeAttributes[.backgroundColor] = magenta
      text.append(NSAttributedString(string: "kod w linii", attributes: codeAttributes))
    }
    switch sample {
    case .mixed:
      text.append(NSAttributedString(
        string: " i dalej słowa. Druga ma emoji 🙂🚀🎉 i jeszcze słowa. Trzecia: e\u{301}\u{301} a\u{328} "
          + "Ż\u{307}ó\u{301}\u{323}łć gęślą jaźń, koniec.", attributes: plain))
    case .latin, .code:
      text.append(NSAttributedString(string: filler, attributes: plain))
    case .emoji:
      text.append(NSAttributedString(string: " emoji 🙂🚀🎉" + filler, attributes: plain))
    }
    let (window, view) = host(text, width: 300)
    defer { window.isHidden = true }

    var out = Measure(font: font.pointSize, natural: font.lineHeight)
    let lines = lines(view)
    out.pitches = zip(lines.dropFirst(), lines).map { $0.baseline - $1.baseline }
    if let first = lines.first, let last = lines.last {
      out.above = first.baseline - font.ascender
      out.below = view.bounds.height - (last.baseline - font.descender)
    }
    out.lineOverlap = zip(lines.dropFirst(), lines).map { $1.bounds.maxY - $0.bounds.minY }.max() ?? 0

    let bitmap = try XCTUnwrap(Bitmap(view))
    let codeRange = (text.string as NSString).range(of: "kod w linii")
    if let rect = segment(view, codeRange) {
      let column = Int(rect.midX)
      out.codeBand = CGFloat(bitmap.run(of: 0xFF00FF, column: column, around: Int(rect.midY)))
    }
    if let start = view.position(from: view.beginningOfDocument, offset: 0),
      let end = view.position(from: view.beginningOfDocument, offset: text.length),
      let whole = view.textRange(from: start, to: end)
    {
      let rects = view.selectionRects(for: whole).map(\.rect).filter { $0.height > 0 && $0.width > 0 }.sorted { $0.minY < $1.minY }
      out.selection = rects.map(\.height)
      out.selectionGaps = zip(rects.dropFirst(), rects).map { $0.minY - $1.maxY }
    }
    let union = lines.reduce(CGRect.null) { $0.union($1.bounds) }
    if let ink = bitmap.inkBounds() {
      out.inkOutside = max(0, union.minY - ink.minY, ink.maxY - union.maxY)
    }
    return out
  }

  // MARK: - Pomocnicze

  private static func host(_ text: NSAttributedString, width: CGFloat) -> (UIWindow, UITextView) {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width + 40, height: 900))
    window.overrideUserInterfaceStyle = .light
    let root = UIViewController()
    root.view.backgroundColor = .white
    window.rootViewController = root
    window.isHidden = false
    let view = UITextView(usingTextLayoutManager: true)
    view.isScrollEnabled = false
    view.isEditable = false
    view.backgroundColor = .white
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.attributedText = text
    let size = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    view.frame = CGRect(x: 0, y: 0, width: width, height: size.height)
    root.view.addSubview(view)
    window.layoutIfNeeded()
    view.layoutIfNeeded()
    return (window, view)
  }

  /// Linie tekstu w układzie pola: granice typograficzne i linia bazowa.
  private static func lines(_ view: UITextView) -> [Line] {
    guard let manager = view.textLayoutManager else { return [] }
    var out: [Line] = []
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      let frame = fragment.layoutFragmentFrame
      for line in fragment.textLineFragments where line.characterRange.length > 0 {
        let bounds = line.typographicBounds.offsetBy(dx: frame.minX, dy: frame.minY)
        out.append(Line(bounds: bounds, baseline: bounds.minY + line.glyphOrigin.y))
      }
      return true
    }
    return out
  }

  /// Prostokąt pierwszego odcinka zakresu (ramka segmentu TextKit 2) w układzie pola.
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

  private static func keep(_ text: String, name: String) -> XCTAttachment {
    let attachment = XCTAttachment(string: text)
    attachment.name = name
    attachment.lifetime = .keepAlways
    return attachment
  }

  nonisolated static func f(_ value: CGFloat) -> String { String(format: "%.2f", Double(value)) }

  /// Render pola przez warstwę do bitmapy sRGB w skali 1 punkt = 1 piksel.
  private struct Bitmap {
    let width: Int
    let height: Int
    let bytes: [UInt8]

    @MainActor
    init?(_ view: UIView) {
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { context in
        view.layer.render(in: context.cgContext)
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

    private func pixel(_ x: Int, _ y: Int) -> (Int, Int, Int) {
      let i = (y * width + x) * 4
      return (Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]))
    }

    private func matches(_ x: Int, _ y: Int, _ rgb: UInt32) -> Bool {
      let (r, g, b) = pixel(x, y)
      return abs(r - Int((rgb >> 16) & 0xFF)) <= 8 && abs(g - Int((rgb >> 8) & 0xFF)) <= 8 && abs(b - Int(rgb & 0xFF)) <= 8
    }

    /// Długość ciągłego pasa koloru w kolumnie, przez punkt `around` (albo najbliższy trafiony w ±20).
    func run(of rgb: UInt32, column: Int, around: Int) -> Int {
      guard column >= 0, column < width else { return 0 }
      let hit = (max(0, around - 20)...min(height - 1, around + 20)).first { matches(column, $0, rgb) }
      guard let start = hit else { return 0 }
      var top = start
      while top > 0, matches(column, top - 1, rgb) { top -= 1 }
      var bottom = start
      while bottom < height - 1, matches(column, bottom + 1, rgb) { bottom += 1 }
      return bottom - top + 1
    }

    /// Granice pikseli nie-białych (atrament glifów i tło kodu).
    func inkBounds() -> CGRect? {
      var box = CGRect.null
      for y in 0..<height {
        for x in 0..<width {
          let (r, g, b) = pixel(x, y)
          if r < 200 || g < 200 || b < 200 { box = box.union(CGRect(x: x, y: y, width: 1, height: 1)) }
        }
      }
      return box.isNull ? nil : box
    }
  }
}
