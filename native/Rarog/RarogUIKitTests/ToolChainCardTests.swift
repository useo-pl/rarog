@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Sąsiednie wywołania narzędzi jako jedna karta: rogi zaokrąglone tylko na zewnątrz
/// karty, kreska `border` na styku wierszy, bez odstępu między nimi; rozwijak serii to wiersz tej samej karty. Render
/// `ImageRenderer` w skali 1 (piksel = punkt). Właściciel: transkrypt.
@MainActor
final class ToolChainCardTests: XCTestCase {
  private static let width: CGFloat = 400

  private static func tool(
    _ id: String, _ place: ToolChainPlace, gap: TurnGap = .flow, detail: String? = "grep -rn krok src", expanded: Bool = false
  ) -> ToolCardView {
    ToolCardView(
      model: ToolRowModel(
        id: id, voice: nil, toolName: "Grep", summary: "krok \(id)", detail: detail, diff: nil, shell: false,
        expanded: expanded, diffTailOpen: false, turn: TurnMark(gap: gap), chain: place),
      plainSyntax: false, toggle: {}, openDiffTail: {})
  }

  private static func chip(_ place: ToolChainPlace, expanded: Bool = false) -> ToolRunChipView {
    ToolRunChipView(model: ToolRunModel(id: 2, voice: nil, hidden: 3, expanded: expanded, chain: place), toggle: {})
  }

  private static func height(_ view: some View) -> CGFloat {
    UIHostingController(rootView: view.frame(width: width)).sizeThatFits(in: CGSize(width: width, height: 2_000)).height
  }

  /// Środek karty bez odstępu nad i pod wierszem (dawne 2 + 2 pt), pierwszy wiersz zachowuje odstęp nad kartą (także
  /// granicę tury), ostatni — 2 pt pod nią; rozwijak serii tak samo.
  func testRowsInsideCardHaveNoGap() {
    let alone = Self.height(Self.tool("m2.0", .alone))
    XCTAssertEqual(Self.height(Self.tool("m2.0", .first)), alone - 2, accuracy: 0.5, "pierwszy: bez dolnych 2 pt")
    XCTAssertEqual(Self.height(Self.tool("m2.0", .middle)), alone - 4, accuracy: 0.5, "środek: bez odstępów")
    XCTAssertEqual(Self.height(Self.tool("m2.0", .last)), alone - 2, accuracy: 0.5, "ostatni: bez górnych 2 pt")
    XCTAssertEqual(
      Self.height(Self.tool("m2.0", .first, gap: .afterPrompt)) - Self.height(Self.tool("m2.0", .first)), 8, accuracy: 0.5,
      "pierwszy wiersz karty po prompcie trzyma 10 pt")
    XCTAssertEqual(Self.height(Self.chip(.first)), Self.height(Self.chip(.alone)) - 2, accuracy: 0.5, "rozwijak w karcie")
    XCTAssertEqual(Self.height(Self.chip(.middle)), Self.height(Self.chip(.alone)) - 4, accuracy: 0.5)
  }

  /// Karta z trzech wierszy: od jej górnej do dolnej krawędzi ani piksela tła (wiersze się stykają), dokładnie dwie kreski
  /// grubości piksela na stykach, rogi zewnętrzne zaokrąglone, styki przy krawędzi proste. Pojedyncza karta — okrągła
  /// z obu stron, bez kreski. Oba motywy.
  func testOuterCornersRoundAndHairlinesAtJoins() throws {
    let card = VStack(spacing: 0) {
      Self.tool("m2.0", .first)
      Self.tool("m3.0", .middle)
      Self.tool("m4.0", .last)
    }
    for scheme in [ColorScheme.light, .dark] {
      let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
      let fill = TranscriptLeadingTests.hex(Palette.toolCard.resolvedColor(with: traits))
      let bitmap = try XCTUnwrap(Self.render(card, scheme: scheme), "\(scheme)")
      // Kolumna po prawej, z dala od napisów.
      let x = Int(Self.width) - 40
      let column = (0..<bitmap.height).map { bitmap.pixel(x, $0) }
      let top = try XCTUnwrap(column.firstIndex { $0 != 0 }, "\(scheme): karta narysowana")
      let bottom = try XCTUnwrap(column.lastIndex { $0 != 0 })
      XCTAssertEqual(top, 2, "\(scheme): odstęp nad kartą (pierwszy wiersz)")
      XCTAssertEqual(bitmap.height - 1 - bottom, 2, "\(scheme): 2 pt pod kartą (ostatni wiersz)")
      XCTAssertFalse(column[top...bottom].contains(0), "\(scheme): między wierszami karty ani piksela tła")
      let joins = column[top...bottom].indices.filter { !Self.near(column[$0], fill) }
      XCTAssertEqual(joins.count, 2, "\(scheme): dwie kreski na stykach, bez kreski u góry karty: \(joins)")
      for join in joins {
        XCTAssertNotEqual(bitmap.pixel(0, join - 1), 0, "\(scheme): styk przy lewej krawędzi prosty (nad kreską)")
        XCTAssertNotEqual(bitmap.pixel(0, join + 1), 0, "\(scheme): styk przy lewej krawędzi prosty (pod kreską)")
        XCTAssertNotEqual(bitmap.pixel(Int(Self.width) - 1, join + 1), 0, "\(scheme): styk przy prawej krawędzi prosty")
      }
      XCTAssertEqual(bitmap.pixel(0, top), 0, "\(scheme): górny lewy róg zaokrąglony")
      XCTAssertEqual(bitmap.pixel(Int(Self.width) - 1, top), 0, "\(scheme): górny prawy róg zaokrąglony")
      XCTAssertEqual(bitmap.pixel(0, bottom), 0, "\(scheme): dolny lewy róg zaokrąglony")
      XCTAssertEqual(bitmap.pixel(Int(Self.width) - 1, bottom), 0, "\(scheme): dolny prawy róg zaokrąglony")

      let single = try XCTUnwrap(Self.render(Self.tool("m2.0", .alone), scheme: scheme))
      let lone = (0..<single.height).map { single.pixel(x, $0) }
      let loneTop = try XCTUnwrap(lone.firstIndex { $0 != 0 })
      let loneBottom = try XCTUnwrap(lone.lastIndex { $0 != 0 })
      XCTAssertTrue(lone[loneTop...loneBottom].allSatisfy { Self.near($0, fill) }, "\(scheme): karta sama bez kreski")
      XCTAssertEqual(single.pixel(0, loneTop), 0, "\(scheme): sama — góra zaokrąglona")
      XCTAssertEqual(single.pixel(0, loneBottom), 0, "\(scheme): sama — dół zaokrąglony")
    }
  }

  /// Ekran sesji: krok, który doszedł na koniec, przekonfigurowuje POPRZEDNI (sam → pierwszy) — jego komórka traci
  /// dolne 2 pt, a identyfikatory wierszy stoją.
  func testNewStepReconfiguresPreviousRow() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    let controller = fixture.controller
    func snapshot(_ steps: Int) throws {
      let prompt = #"{"seq":1,"role":"user","at":"2026-10-06T10:00:00.000Z","blocks":[{"type":"text","text":"Szukaj"}]}"#
      let tools = (2..<(2 + steps)).map { seq in
        #"{"seq":\#(seq),"role":"assistant","at":"2026-10-06T10:00:0\#(seq).000Z","blocks":"#
          + #"[{"type":"tool-call","toolName":"Grep","summary":"krok \#(seq)"}]}"#
      }
      try SessionToastTests.frame(fixture.store, #"""
        {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(([prompt] + tools).joined(separator: ","))],
         "pendingPermissions":[],"pendingQuestions":[]}
        """#, source: .session("s1"))
      SessionToastTests.spin(0.3)
      for _ in 0..<3 {
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        controller.collectionView.layoutIfNeeded()
        SessionToastTests.spin(0.05)
      }
    }
    func cellHeight(_ id: String) throws -> CGFloat {
      let index = try XCTUnwrap(controller.dataSource.indexPath(for: id), id)
      return try XCTUnwrap(controller.collectionView.layoutAttributesForItem(at: index)).frame.height
    }
    try snapshot(1)
    XCTAssertEqual(controller.rows["m2.0"]?.toolChain, .alone)
    let alone = try cellHeight("m2.0")
    try snapshot(2)
    XCTAssertEqual(controller.dataSource.snapshot().itemIdentifiers.filter { $0.hasPrefix("m") }, ["m1.0", "m2.0", "m3.0"])
    XCTAssertEqual(controller.rows["m2.0"]?.toolChain, .first)
    XCTAssertEqual(controller.rows["m3.0"]?.toolChain, .last)
    let cells = controller.collectionView.visibleCells.map { "\($0.frame.minY)…\($0.frame.maxY)" }
    let report = "sam \(alone), po: \(try cellHeight("m2.0")) / \(try cellHeight("m3.0")), komórki \(cells)"
    XCTAssertEqual(try cellHeight("m2.0"), alone - 2, accuracy: 0.5, "komórka przekonfigurowana: bez dolnych 2 pt; \(report)")
    // Pierwszy krok stał pod promptem (10 pt nad nim); ostatni nie ma odstępu nad sobą wcale.
    XCTAssertEqual(try cellHeight("m3.0"), alone - 10, accuracy: 0.5, "ostatni: bez odstępu nad sobą; \(report)")
  }

  /// Zrzuty do oceny wyglądu (oba motywy, skala 2): zwinięta seria w karcie, rozwinięta z wejściem, karta sama.
  func testLookAttachments() throws {
    let look = VStack(spacing: 0) {
      Self.chip(.first)
      Self.tool("m4.0", .last)
      Color.clear.frame(height: 16)
      Self.tool("m5.0", .first, gap: .afterPrompt)
      Self.tool("m6.0", .middle, expanded: true)
      Self.chip(.middle, expanded: true)
      Self.tool("m7.0", .last)
      Color.clear.frame(height: 16)
      Self.tool("m8.0", .alone)
    }
    .padding(16)
    for scheme in [ColorScheme.light, .dark] {
      let renderer = ImageRenderer(content: look.frame(width: Self.width + 32)
        .background(Color(uiColor: Palette.background)).environment(\.colorScheme, scheme))
      renderer.scale = 2
      let image = try XCTUnwrap(renderer.uiImage)
      let attachment = XCTAttachment(image: image)
      attachment.name = "karta-narzedzi-\(scheme == .dark ? "ciemny" : "jasny")"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }

  /// Zrzut prawdziwego ekranu sesji (lista, komórki, minimalna wysokość wiersza) w obu motywach: tekst, zwinięta seria
  /// w karcie, karta z edycją, karta sama.
  func testSessionLookAttachments() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    func message(_ seq: Int, _ role: String, _ blocks: String) -> String {
      #"{"seq":\#(seq),"role":"\#(role)","at":"2026-10-06T10:00:\#(String(format: "%02d", seq)).000Z","blocks":\#(blocks)}"#
    }
    func text(_ value: String) -> String { #"[{"type":"text","text":"\#(value)"}]"# }
    func tool(_ name: String, _ summary: String, extra: String = "") -> String {
      #"[{"type":"tool-call","toolName":"\#(name)","summary":"\#(summary)"\#(extra)}]"#
    }
    let messages = [
      message(1, "user", text("Sprawdź import klientów i popraw raport.")),
      message(2, "assistant", text("Zaczynam od danych wejściowych.")),
      message(3, "assistant", tool("Read", "data/klienci.csv", extra: #","detail":"data/klienci.csv""#)),
      message(4, "assistant", tool("Grep", "import src", extra: #","detail":"grep -rn import src""#)),
      message(5, "assistant", tool("Grep", "duplikat src/import")),
      message(6, "assistant", tool("Shell", "npm test -- import", extra: #","detail":"npm test -- import","inputKind":"shell""#)),
      message(7, "assistant", text("Testy przechodzą. Poprawiam zapis raportu.")),
      message(8, "assistant", tool("Edit", "src/import/report.ts", extra: #","detail":"- stare\n+ nowe","detailKind":"diff""#)),
      message(9, "assistant", tool("Grep", "report src")),
      message(10, "assistant", text("Sprawdzam jeszcze jedno miejsce.")),
      message(11, "assistant", tool("Read", "src/import/report.ts")),
      message(12, "assistant", text("Gotowe — raport liczy klientów bez duplikatów.")),
    ]
    try SessionToastTests.frame(fixture.store, #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(messages.joined(separator: ","))],
       "pendingPermissions":[],"pendingQuestions":[]}
      """#, source: .session("s1"))
    SessionToastTests.spin(0.3)
    for style in [UIUserInterfaceStyle.light, .dark] {
      fixture.window.overrideUserInterfaceStyle = style
      for _ in 0..<3 {
        fixture.controller.view.setNeedsLayout()
        fixture.controller.view.layoutIfNeeded()
        SessionToastTests.spin(0.1)
      }
      let format = UIGraphicsImageRendererFormat()
      format.scale = 2
      let image = UIGraphicsImageRenderer(bounds: fixture.window.bounds, format: format).image { context in
        fixture.window.layer.render(in: context.cgContext)
      }
      let attachment = XCTAttachment(image: image)
      attachment.name = "sesja-karta-narzedzi-\(style == .dark ? "ciemny" : "jasny")"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
    XCTAssertEqual(fixture.controller.rows["r3"]?.toolChain, .first)
  }

  // MARK: - Pomocnicze

  private struct Bitmap {
    let width: Int
    let height: Int
    let bytes: [UInt8]

    /// Kolor piksela `0xRRGGBB`.
    func pixel(_ x: Int, _ y: Int) -> UInt32 {
      guard x >= 0, x < width, y >= 0, y < height else { return 0 }
      let i = (y * width + x) * 4
      return UInt32(bytes[i]) << 16 | UInt32(bytes[i + 1]) << 8 | UInt32(bytes[i + 2])
    }
  }

  /// Ten sam kolor z dokładnością do 3 na kanał (zaokrąglenia renderu).
  private static func near(_ a: UInt32, _ b: UInt32) -> Bool {
    [16, 8, 0].allSatisfy { abs(Int((a >> $0) & 0xFF) - Int((b >> $0) & 0xFF)) <= 3 }
  }

  /// Render na czarnym tle w skali 1, w szerokości `width`.
  private static func render(_ view: some View, scheme: ColorScheme) -> Bitmap? {
    let renderer = ImageRenderer(content: view.frame(width: width).background(Color.black).environment(\.colorScheme, scheme))
    renderer.scale = 1
    guard let image = renderer.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: image.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
      return true
    }
    return drawn ? Bitmap(width: image.width, height: image.height, bytes: bytes) : nil
  }
}
