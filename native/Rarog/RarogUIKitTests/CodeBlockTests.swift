@testable import RarogUI
import UIKit
import XCTest

/// Code block in an agent reply: text in the block can be selected with the pointer and the selection stays visible.
/// An opaque block background drawn by a TextKit 2 layout fragment would hide it, because fragment views lie ABOVE
/// the `UITextView` selection highlight. Owner: transcript, markdown.
@MainActor
final class CodeBlockTests: XCTestCase {
  /// Zaznaczony tekst bloku kodu ma podświetlenie widoczne na tle bloku, a bez zaznaczenia tło stoi.
  func testSelectionShowsOverCodeBlock() throws {
    let (window, view, textView) = try Self.host()
    defer { window.isHidden = true }
    let fill = Self.hex(Palette.codeBlockFill.resolvedColor(with: window.traitCollection))
    let lines = try Self.codeLineRects(textView, in: window)
    XCTAssertEqual(lines.count, 2, "dwie linie kodu")

    let plain = try XCTUnwrap(Self.render(window))
    for line in lines {
      XCTAssertGreaterThan(plain.share(of: fill, in: line), 0.6, "tło bloku pod linią kodu \(line)")
    }

    XCTAssertTrue(textView.becomeFirstResponder())
    textView.selectedRange = NSRange(location: 0, length: textView.attributedText.length)
    window.layoutIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    let selected = try XCTUnwrap(Self.render(window))
    for line in lines {
      // Podświetlenie (odcień z kryciem) zmienia piksele tła bloku pod całą linią.
      XCTAssertLessThan(selected.share(of: fill, in: line), 0.3, "zaznaczenie widoczne w linii kodu \(line)")
    }
    _ = view
  }

  /// Każdy blok kodu ma własne tło pod wszystkimi swoimi liniami — także drugi blok, blok w cytacie i blok
  /// w dymku człowieka — a ponowne wpięcie krótszej treści chowa nadmiarowe tła.
  func testEveryCodeBlockGetsItsOwnBackground() throws {
    let markdown = "Pierwszy:\n\n```\nlet a = 1\n```\n\n> Cytat z kodem:\n>\n> ```\n> let b = 2\n> let c = 3\n> ```\n\nKoniec."
    for plate in [false, true] {
      let (window, view, textView) = try Self.host(markdown: markdown, plate: plate)
      defer { window.isHidden = true }
      let boxes = Self.views(of: CodeBlockBox.self, in: view).filter { !$0.isHidden }
      XCTAssertEqual(boxes.count, 2, "plate=\(plate): dwa bloki, dwa tła")
      for line in try Self.codeLineRects(textView, in: window) {
        XCTAssertTrue(boxes.contains { $0.convert($0.bounds, to: nil).contains(line) }, "plate=\(plate): linia \(line) na tle bloku")
      }
      // Krótsza treść w tej samej komórce: zostaje jedno tło.
      let style = MarkdownRenderer.Style(textColor: Palette.text, base: MarkdownRenderer.transcriptStyle, traits: view.traitCollection)
      (view as? UIContentView)?.configuration = MessageContentConfiguration(
        voice: "agent", text: MarkdownCache().text("```\nlet z = 0\n```", style: style), plate: plate, dimmed: false,
        accessibilityIdentifier: "message.m1.0", accessibilityPrefix: nil)
      view.setNeedsLayout()
      view.layoutIfNeeded()
      XCTAssertEqual(Self.views(of: CodeBlockBox.self, in: view).filter { !$0.isHidden }.count, 1, "plate=\(plate): po zmianie treści")
    }
  }

  /// Tło i pasek bloku nie łapią dotyku: przeciągnięcie kursorem po kodzie trafia w tekst, a ikona kopiowania
  /// (nad paskiem) dalej odbiera stuknięcie.
  func testCodeBlockBackgroundLeavesHitsToTextAndCopyIcon() throws {
    let (window, view, textView) = try Self.host()
    defer { window.isHidden = true }
    let lines = try Self.codeLineRects(textView, in: window)
    for line in lines {
      let hit = window.hitTest(CGPoint(x: line.midX, y: line.midY), with: nil)
      XCTAssertTrue(hit === textView || hit?.isDescendant(of: textView) == true, "linia kodu trafia w tekst: \(String(describing: hit))")
    }
    let copy = try XCTUnwrap(Self.views(of: CopyIconButton.self, in: view).first)
    let center = copy.convert(CGPoint(x: copy.bounds.midX, y: copy.bounds.midY), to: window)
    XCTAssertTrue(window.hitTest(center, with: nil) === copy, "ikona kopiowania bloku odbiera stuknięcie")
    XCTAssertEqual(copy.payload?(), "let alpha = 1\nlet beta = 2", "ikona kopiuje kod bloku")
  }

  /// Tło bloku idzie za motywem bez przebudowy komórki (kolory dynamiczne widoku).
  func testCodeBlockBackgroundFollowsTheme() throws {
    let (window, view, _) = try Self.host()
    defer { window.isHidden = true }
    let box = try XCTUnwrap(Self.views(of: CodeBlockBox.self, in: view).first { !$0.isHidden })
    for style in [UIUserInterfaceStyle.light, .dark] {
      window.overrideUserInterfaceStyle = style
      window.layoutIfNeeded()
      let traits = UITraitCollection(userInterfaceStyle: style)
      XCTAssertEqual(box.backgroundColor?.resolvedColor(with: box.traitCollection), Palette.codeBlockFill.resolvedColor(with: traits))
    }
  }

  /// A code block at the end of a message fits in its row together with the box's bottom inset (otherwise the
  /// transcript edge cuts off the bottom of the block) and does not get a double breath.
  func testTrailingCodeBlockFitsInRow() throws {
    let (window, view, _) = try Self.host(markdown: "Możesz budować:\n\n```\nbash scripts/ios-publish.sh\n```")
    defer { window.isHidden = true }
    let size = view.systemLayoutSizeFitting(
      CGSize(width: 600, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
    view.frame = CGRect(x: 0, y: 0, width: 600, height: size.height)
    view.layoutIfNeeded()
    let box = try XCTUnwrap(Self.views(of: CodeBlockBox.self, in: view).first { !$0.isHidden })
    let bottom = box.convert(box.bounds, to: view).maxY
    XCTAssertLessThanOrEqual(bottom, view.bounds.maxY + 0.5, "dół bloku w wierszu")
    XCTAssertGreaterThanOrEqual(view.bounds.maxY - bottom, 1.5, "pod blokiem zwykły margines wiersza")
    XCTAssertLessThanOrEqual(view.bounds.maxY - bottom, 4, "bez podwójnego odstępu")
    XCTAssertTrue(MessageContentView.endsWithCode((view as? UIContentView).flatMap {
      ($0.configuration as? MessageContentConfiguration)?.text } ?? NSAttributedString()))
  }

  /// A link in the text is PAINTED soft blue, not only carries it in its attributes (the colour in the attributes
  /// alone leaves the link white): `UITextView` takes the link range colour from `linkTextAttributes`. Under a
  /// pending decision (`plainSyntax`) the link returns to the text colour, like syntax colours.
  func testLinkPaintsSoftBlue() throws {
    let markdown = "Zobacz [dokumentację progów kafla Live Activity](https://example.com) tutaj."
    let (window, view, _) = try Self.host(markdown: markdown)
    defer { window.isHidden = true }
    let ink = Self.hex(Palette.linkInk.resolvedColor(with: window.traitCollection))
    let frame = view.convert(view.bounds, to: window)
    let shown = try XCTUnwrap(Self.render(window))
    XCTAssertGreaterThan(shown.share(of: ink, in: frame), 0.001, "piksele linku w kolorze `linkInk`")

    let content = try XCTUnwrap(view as? UIContentView)
    var plain = try XCTUnwrap(content.configuration as? MessageContentConfiguration)
    plain.plainSyntax = true
    content.configuration = plain
    window.layoutIfNeeded()
    let muted = try XCTUnwrap(Self.render(window))
    XCTAssertEqual(muted.share(of: ink, in: frame), 0, "pod decyzją link bez niebieskiego")
  }

  /// Kod w linii: zaokrąglone tło rysuje fragment układu, z równym
  /// oddechem z obu stron litery — w środku linii przed przecinkiem, na początku linii, na końcu akapitu i w tabeli.
  /// Litera `o` w piśmie stałej szerokości stoi w środku swojej komórki, więc oddech mierzy się od jej atramentu.
  func testInlineCodeHasRoundedBackgroundWithEvenSideBreath() throws {
    let markdown = "`o` na początku, w środku `o`, i na końcu `o`\n\n| `o` | b |\n| --- | --- |\n| tekst | `o` |"
    let (window, view, textView) = try Self.host(markdown: markdown)
    defer { window.isHidden = true }
    let background = Self.hex(Palette.background.resolvedColor(with: window.traitCollection))
    let plain = try XCTUnwrap(Self.render(window))
    let table = try XCTUnwrap(Self.views(of: MarkdownTableView.self, in: view).first)
    let prose = try Self.inlineCodeBoxes(textView, in: window)
    let cells = try Self.inlineCodeBoxes(table.textView, in: window)
    XCTAssertEqual(prose.count, 3, "trzy kawałki kodu w akapicie")
    XCTAssertEqual(cells.count, 2, "dwa kawałki kodu w tabeli")
    let side = Int(MarkdownLayoutFragment.inlineCodeSide * plain.scale)
    for (index, box) in (prose + cells).enumerated() {
      let breath = try XCTUnwrap(plain.breath(around: box), "tło i litera kawałka \(index) widać")
      XCTAssertEqual(breath.left, breath.right, accuracy: 1, "kawałek \(index): oddech z obu stron równy (\(breath))")
      XCTAssertGreaterThanOrEqual(min(breath.left, breath.right), side, "kawałek \(index): oddech co najmniej 2 pt")
    }
    let box = try XCTUnwrap(prose.last)
    XCTAssertEqual(plain.share(of: background, in: CGRect(x: box.minX, y: box.minY, width: 0.5, height: 0.5)), 1, "róg zaokrąglony")
  }

  // MARK: - Pomocnicze

  /// Tła kodu w linii (``MarkdownLayoutFragment/inlineCodeBoxes``) w układzie okna.
  private static func inlineCodeBoxes(_ textView: UITextView, in window: UIWindow) throws -> [CGRect] {
    let manager = try XCTUnwrap(textView.textLayoutManager)
    var rects: [CGRect] = []
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      guard let fragment = fragment as? MarkdownLayoutFragment else { return true }
      // Układ fragmentu → kontener tekstu → pole (wstawka pola: w tabeli górna, w treści zero).
      let origin = fragment.layoutFragmentFrame.origin
      let inset = textView.textContainerInset
      rects += fragment.inlineCodeBoxes.map {
        textView.convert($0.offsetBy(dx: origin.x + inset.left, dy: origin.y + inset.top), to: window)
      }
      return true
    }
    return rects
  }

  private static func host(
    markdown: String = "Akapit przed kodem.\n\n```ts\nlet alpha = 1\nlet beta = 2\n```\n\nAkapit po kodzie.", plate: Bool = false
  ) throws -> (UIWindow, UIView, UITextView) {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 600, height: 500))
    window.overrideUserInterfaceStyle = .dark
    let root = UIViewController()
    root.view.backgroundColor = Palette.background
    window.rootViewController = root
    window.makeKeyAndVisible()
    let style = MarkdownRenderer.Style(textColor: Palette.text, base: MarkdownRenderer.transcriptStyle, traits: root.traitCollection)
    let text = MarkdownCache().text(markdown, style: style)
    let config = MessageContentConfiguration(
      voice: "agent", text: text, plate: plate, dimmed: false, accessibilityIdentifier: "message.m1.0",
      accessibilityPrefix: nil)
    let view = config.makeContentView()
    view.frame = CGRect(x: 0, y: 0, width: 600, height: 400)
    root.view.addSubview(view)
    window.layoutIfNeeded()
    view.layoutIfNeeded()
    let textView = try XCTUnwrap(views(of: UITextView.self, in: view).first)
    return (window, view, textView)
  }

  /// Linie kodu (typograficzne granice glifów) w układzie okna.
  private static func codeLineRects(_ textView: UITextView, in window: UIWindow) throws -> [CGRect] {
    let manager = try XCTUnwrap(textView.textLayoutManager)
    var rects: [CGRect] = []
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      guard let fragment = fragment as? MarkdownLayoutFragment, case .codeLine = fragment.decoration?.kind else { return true }
      for line in fragment.textLineFragments {
        let rect = line.typographicBounds.offsetBy(dx: fragment.layoutFragmentFrame.minX, dy: fragment.layoutFragmentFrame.minY)
        rects.append(textView.convert(rect, to: window).insetBy(dx: 0, dy: 2))
      }
      return true
    }
    return rects
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
      var hits = 0
      for y in y0..<y1 {
        for x in x0..<x1 {
          let i = (y * width + x) * 4
          let target = [Int((rgb >> 16) & 0xFF), Int((rgb >> 8) & 0xFF), Int(rgb & 0xFF)]
          if (0..<3).allSatisfy({ abs(Int(bytes[i + $0]) - target[$0]) <= 3 }) { hits += 1 }
        }
      }
      return Double(hits) / Double((x1 - x0) * (y1 - y0))
    }

    /// Oddech tła kodu w pikselach, w wierszu przez środek tła: od brzegu tła do pierwszego piksela atramentu i od
    /// ostatniego do drugiego brzegu. Tło jaśniejsze od tła strony (ciemny motyw), atrament dużo jaśniejszy od tła kodu.
    func breath(around box: CGRect) -> (left: Int, right: Int)? {
      let row = min(height - 1, max(0, Int(box.midY * scale)))
      let x0 = max(0, Int((box.minX - 3) * scale)), x1 = min(width, Int((box.maxX + 3) * scale))
      let lumas = (x0..<x1).map { x in
        let i = (row * width + x) * 4
        return (Int(bytes[i]) * 299 + Int(bytes[i + 1]) * 587 + Int(bytes[i + 2]) * 114) / 1000
      }
      guard let fillStart = lumas.firstIndex(where: { $0 >= 20 }), let fillEnd = lumas.lastIndex(where: { $0 >= 20 }),
        let inkStart = lumas.firstIndex(where: { $0 >= 90 }), let inkEnd = lumas.lastIndex(where: { $0 >= 90 })
      else { return nil }
      return (inkStart - fillStart, fillEnd - inkEnd)
    }
  }
}
