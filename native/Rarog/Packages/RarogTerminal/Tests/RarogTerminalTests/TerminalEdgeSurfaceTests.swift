#if os(iOS)
import RarogContract
import RarogCore
@testable import RarogTerminal
@testable import RarogUI
@preconcurrency import SwiftTerm
import Testing
import UIKit

// Pas w kolorze krawędzi siatki na prawdziwej powierzchni SwiftTerm: liczenie tylko przy słuchaczu,
// zgodność odczytu z narysowanymi pikselami komórek krawędzi, uchwyty zaznaczenia w wąskim pasie wewnątrz
// powierzchni, ekran z nakładką (okno) i bez niej (trasa) oraz pomiar sygnałów `rangeChanged` przy pisaniu,
// przewijaniu i pełnym odświeżeniu. Treść syntetyczna. Właściciel: terminal.

/// Obraz widoku SwiftTerm z jego własnego `draw` w bitmapie sRGB 8 bitów (układ UIKit: wiersz 0 na górze).
@MainActor
struct SurfacePixels {
  let scale: CGFloat
  let width: Int
  let height: Int
  let bytes: [UInt8]

  init(_ surface: SwiftTermSurface, scale: CGFloat = 2) {
    let width = Int(surface.bounds.width * scale)
    let height = Int(surface.bounds.height * scale)
    self.scale = scale
    self.width = width
    self.height = height
    var data = [UInt8](repeating: 0, count: width * height * 4)
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    data.withUnsafeMutableBytes { buffer in
      let context = CGContext(
        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      context.translateBy(x: 0, y: CGFloat(height))
      context.scaleBy(x: scale, y: -scale)
      UIGraphicsPushContext(context)
      surface.draw(surface.bounds)
      UIGraphicsPopContext()
    }
    bytes = data
  }

  /// Kolor piksela w punkcie (punkty widoku).
  func color(at point: CGPoint) -> (r: Int, g: Int, b: Int) {
    let x = min(max(Int(point.x * scale), 0), width - 1)
    let y = min(max(Int(point.y * scale), 0), height - 1)
    let offset = (y * width + x) * 4
    return (Int(bytes[offset]), Int(bytes[offset + 1]), Int(bytes[offset + 2]))
  }

  /// Piksel w kolorze `color` (± `tolerance` na kanał) gdziekolwiek w prostokącie.
  func contains(_ color: (r: Int, g: Int, b: Int), in rect: CGRect, tolerance: Int = 24) -> Bool {
    for y in stride(from: rect.minY, to: rect.maxY, by: 1 / scale) {
      for x in stride(from: rect.minX, to: rect.maxX, by: 1 / scale) {
        let pixel = self.color(at: CGPoint(x: x, y: y))
        let near = [pixel.r - color.r, pixel.g - color.g, pixel.b - color.b].allSatisfy { abs($0) <= tolerance }
        if near { return true }
      }
    }
    return false
  }
}

extension TerminalEdgeColor {
  var rgb8: (r: Int, g: Int, b: Int) { (Int(red) / 257, Int(green) / 257, Int(blue) / 257) }
}

@MainActor
@Suite("terminal: pas w kolorze krawędzi na powierzchni SwiftTerm (iOS)")
struct TerminalEdgeSurfaceTests {
  /// Ekran programu (alternatywny: każdy wiersz się rozszerza) z krawędziami w każdym rodzaju koloru: truecolor,
  /// ANSI, 256, szarość, odwrócone domyślne, `inverse`.
  static let colored: Data = {
    let esc = "\u{1B}["
    return Data(([
      "\(esc)?1049h\(esc)2J\(esc)H",
      "\(esc)1;1H\(esc)48;2;26;27;38m\(esc)K\(esc)0m",
      "\(esc)2;1H\(esc)41m  \(esc)0m\(esc)2;999H\(esc)48;5;196m \(esc)0m",
      "\(esc)3;1H\(esc)7m  \(esc)0m\(esc)3;999H\(esc)7;34m \(esc)0m",
      "\(esc)4;1H\(esc)48;5;240m  \(esc)0m\(esc)4;999H\(esc)48;5;67m \(esc)0m",
      "\(esc)999;1H\(esc)48;2;122;162;247m\(esc)K\(esc)999;5H\(esc)48;2;59;66;97m    \(esc)0m",
      "\(esc)5;1H",
    ].joined()).utf8)
  }()

  @Test("liczy krawędzie tylko przy słuchaczu; sygnał tylko przy innym wyniku; `close()` odpina")
  func listenerOnly() async {
    let surface = makeSurface()
    let window = host(surface)
    defer { window.isHidden = true }
    #expect(!surface.notifyUpdateChanges, "trasa: SwiftTerm nie zgłasza zmian ekranu")
    surface.feed(Self.colored)
    try? await Task.sleep(for: .milliseconds(80))
    #expect(surface.edgeChecks == 0, "bez słuchacza nic się nie liczy")

    var signals = 0
    surface.onEdgesChanged = { signals += 1 }
    #expect(surface.notifyUpdateChanges)
    surface.feed(Data("\u{1B}[2J\u{1B}[H".utf8))
    await waitUntil { signals == 1 }
    #expect(signals == 1, "pierwszy wynik po włączeniu")
    surface.feed(Self.colored)
    await waitUntil { signals == 2 }
    #expect(signals == 2, "krawędzie się zmieniły")
    let checks = surface.edgeChecks
    surface.feed(Data("\u{1B}[6;6Hab".utf8))
    await waitUntil { surface.edgeChecks > checks }
    try? await Task.sleep(for: .milliseconds(50))
    #expect(surface.edgeChecks > checks, "SwiftTerm dał sygnał")
    #expect(signals == 2, "tekst w środku ekranu nie zmienia krawędzi — bez sygnału")

    surface.close()
    #expect(surface.onEdgesChanged == nil && !surface.notifyUpdateChanges, "zamknięta powierzchnia nie liczy")
  }

  @Test("zgodność z rendererem: piksele komórek krawędzi = odczyt (także 256 kolorów, szarość, `inverse`)")
  func matchesRenderer() throws {
    let surface = makeSurface()
    let window = host(surface, size: CGSize(width: 600, height: 400))
    defer { window.isHidden = true }
    surface.feed(Self.colored)
    let edges = try #require(surface.edgeColors)
    let grid = surface.gridSize
    let cell = surface.cellSize
    #expect(edges.leading.count == grid.rows && edges.trailing.count == grid.rows)
    let bottom = try #require(edges.bottom, "dolny wiersz cały w kolorze: dół się rozszerza")
    #expect(bottom.count == grid.cols)
    let pixels = SurfacePixels(surface)
    func check(_ expected: TerminalEdgeColor?, col: Int, row: Int) {
      guard let expected else {
        Issue.record("wiersz \(row) się nie rozszerza, a ekran jest alternatywny")
        return
      }
      let point = CGPoint(x: (CGFloat(col) + 0.5) * cell.width, y: (CGFloat(row) + 0.5) * cell.height)
      let drawn = pixels.color(at: point)
      let wanted = expected.rgb8
      let close = abs(drawn.r - wanted.r) <= 2 && abs(drawn.g - wanted.g) <= 2 && abs(drawn.b - wanted.b) <= 2
      #expect(close, "komórka (\(col), \(row)): narysowane \(drawn), odczyt \(expected)")
    }
    for row in 0..<grid.rows {
      check(edges.leading[row], col: 0, row: row)
      check(edges.trailing[row], col: grid.cols - 1, row: row)
    }
    for col in 0..<grid.cols { check(bottom[col], col: col, row: grid.rows - 1) }
    // Kolory, których odczyt musi dotyczyć (nie tylko tło domyślne).
    #expect(edges.leading[0] == TerminalEdgeColor(red8: 26, green8: 27, blue8: 38))
    #expect(edges.leading[2] == TerminalEdgeColor(red8: 255, green8: 255, blue8: 255), "odwrócone domyślne = biel")
    #expect(Set(edges.trailing[1...3]).count == 3 && !edges.trailing[1...3].contains(edges.background))
    #expect(!edges.trailing[1...3].contains(nil))
  }

  @Test("uchwyty zaznaczenia SwiftTerm wchodzą w wąski pas wewnątrz powierzchni; odczyt mówi o zaznaczeniu")
  func selectionHandlesReachInnerStrip() async throws {
    let surface = makeSurface()
    // 604 × 410 pt: siatka (komórka 8 × 16 pt) zostawia resztkę z prawej i u dołu; przy 600 × 400 wypełnia widok
    // co do punktu i pasa wewnątrz nie ma.
    let window = host(surface, size: CGSize(width: 604, height: 410))
    defer { window.isHidden = true }
    surface.feed(Data("\u{1B}[2J\u{1B}[999;1Hostatni wiersz".utf8))
    var signals = 0
    surface.onEdgesChanged = { signals += 1 }
    _ = surface.edgeColors
    let grid = surface.gridFrame
    #expect(surface.bounds.maxX - grid.maxX > 0 && surface.bounds.maxY - grid.maxY > 0, "resztka z prawej i u dołu")
    let rows = surface.getTerminal().rows
    surface.selection.startSelection(row: rows - 1, col: 0)
    surface.selection.dragExtend(row: rows - 1, col: surface.getTerminal().cols)
    await waitUntil { signals > 0 }
    #expect(signals > 0, "zaznaczenie zmienia odczyt")
    #expect(surface.edgeColors?.selecting == true)
    let pixels = SurfacePixels(surface)
    let handle = surface.selectionHandleColor.resolvedColor(with: surface.traitCollection)
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    handle.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    let color = (Int(red * 255), Int(green * 255), Int(blue * 255))
    let right = CGRect(x: grid.maxX, y: 0, width: surface.bounds.maxX - grid.maxX, height: surface.bounds.height)
    let below = CGRect(x: 0, y: grid.maxY, width: surface.bounds.width, height: surface.bounds.maxY - grid.maxY)
    func seen(_ rect: CGRect) -> String {
      var colors: [String: Int] = [:]
      for y in stride(from: rect.minY, to: rect.maxY, by: 0.5) {
        for x in stride(from: rect.minX, to: rect.maxX, by: 0.5) {
          let p = pixels.color(at: CGPoint(x: x, y: y))
          colors["\(p.r),\(p.g),\(p.b)", default: 0] += 1
        }
      }
      return colors.sorted { $0.value > $1.value }.prefix(6).map { "\($0.key)×\($0.value)" }.joined(separator: " ")
    }
    let inRight = pixels.contains(color, in: right)
    let inBelow = pixels.contains(color, in: below)
    #expect(inRight, "uchwyt w pasie z prawej (pomiar); \(color): \(seen(right)), siatka \(grid)")
    #expect(inBelow, "uchwyt w pasie u dołu (pomiar); \(color): \(seen(below)), siatka \(grid)")
    surface.selectNone()
    await waitUntil { surface.edgeColors?.selecting == false }
    #expect(surface.edgeColors?.selecting == false)
  }

  // MARK: - Ekran z nakładką

  private func screen(size: CGSize, paints: Bool) throws -> (TerminalScreenViewController, SwiftTermSurface, UIWindow) {
    let target = try #require(TerminalTarget.popup(cwd: "/Users/demo/Projects/rarog", role: .lazygit))
    let session = TerminalSession(target: target, transport: FakeTerminalWire())
    let surface = makeSurface()
    let screen = TerminalScreenViewController(session: session, surface: surface) { _ in .closed }
    screen.hardwareKeyboard = { true }
    screen.paintsEdges = paints
    screen.windowInsets = UIEdgeInsets(top: 0, left: 8, bottom: 12, right: 8)
    let window = UIWindow(frame: CGRect(origin: .zero, size: size))
    window.rootViewController = screen
    window.makeKeyAndVisible()
    window.layoutIfNeeded()
    return (screen, surface, window)
  }

  @Test("okno: nakładka sięga pasa okna, maluje go kolorami krawędzi i leży pod linią stanu")
  func screenPaintsWindowBand() async throws {
    let (screen, surface, window) = try screen(size: CGSize(width: 834, height: 600), paints: true)
    defer {
      screen.shutdown()
      window.isHidden = true
    }
    #expect(surface.onEdgesChanged != nil && surface.notifyUpdateChanges)
    let fill = screen.edgeFill
    #expect(!fill.isHidden && !fill.isUserInteractionEnabled && fill.accessibilityElementsHidden)
    #expect(fill.frame == CGRect(x: -8, y: 0, width: 834 + 16, height: screen.view.bounds.height + 12))
    let subviews = screen.view.subviews
    let fillIndex = try #require(subviews.firstIndex { $0 === fill })
    let statusIndex = try #require(subviews.firstIndex { $0 === screen.statusBar })
    #expect(fillIndex < statusIndex, "linia stanu nad nakładką")
    #expect(subviews.firstIndex { $0 === screen.container.superview } ?? .max < fillIndex, "nakładka nad stosem")

    surface.feed(Self.colored)
    // Odczyt bez efektu: `edgeColors` zapamiętałby wynik jako oddany, a sygnał nie poszedłby do ekranu.
    let edges = surface.readEdges()
    await waitUntil { fill.bands.contains { $0.color == edges.trailing[1] } }
    let bounds = fill.bounds
    func color(_ point: CGPoint) -> TerminalEdgeColor? { fill.bands.last { $0.rect.contains(point) }?.color }
    let grid = surface.convert(surface.gridFrame, to: fill)
    let cell = surface.cellSize
    #expect(color(CGPoint(x: 2, y: grid.minY + cell.height * 0.5)) == edges.leading[0], "pas okna z lewej")
    #expect(color(CGPoint(x: bounds.maxX - 2, y: grid.minY + cell.height * 1.5)) == edges.trailing[1], "z prawej")
    #expect(color(CGPoint(x: grid.midX, y: bounds.maxY - 2)) != nil, "pas okna u dołu")
    for band in fill.bands {
      #expect(band.rect.intersection(grid.insetBy(dx: 1, dy: 1)).isEmpty, "pas w siatce: \(band.rect)")
    }
  }

  @Test("trasa: bez nakładki i bez liczenia krawędzi")
  func routeWithoutFill() throws {
    let (screen, surface, window) = try screen(size: CGSize(width: 834, height: 600), paints: false)
    defer {
      screen.shutdown()
      window.isHidden = true
    }
    #expect(screen.edgeFill.isHidden && screen.edgeFill.bands.isEmpty)
    #expect(surface.onEdgesChanged == nil && !surface.notifyUpdateChanges)
  }

  // MARK: - Pomiar

  @Test("pomiar: sygnały `rangeChanged` przy pisaniu, przewijaniu i pełnym odświeżeniu oraz koszt odczytu")
  func measureSignals() async throws {
    let surface = makeSurface()
    let window = host(surface, size: CGSize(width: 1194, height: 760))
    defer { window.isHidden = true }
    var signals = 0
    surface.onEdgesChanged = { signals += 1 }
    let grid = surface.gridSize
    surface.feed(Self.colored)
    try await Task.sleep(for: .milliseconds(100))

    func run(_ name: String, feeds: [Data], pause: Duration) async throws -> (checks: Int, signals: Int) {
      let checks = surface.edgeChecks
      let before = signals
      for data in feeds {
        surface.feed(data)
        try await Task.sleep(for: pause)
      }
      try await Task.sleep(for: .milliseconds(100))
      let result = (surface.edgeChecks - checks, signals - before)
      print("[pomiar krawędzi] \(name): porcji \(feeds.count), rangeChanged \(result.0), zmian krawędzi \(result.1)")
      return result
    }
    let typing = try await run("pisanie", feeds: (0..<30).map { _ in Data("x".utf8) }, pause: .milliseconds(30))
    let lines = (0..<grid.rows).map { "wiersz \($0) przewijanej historii" }
    let scroll = try await run(
      "przewijanie", feeds: (0..<20).map { step in
        Data(("\u{1B}[H" + lines.map { "\u{1B}[2K\($0) \(step)" }.joined(separator: "\r\n")).utf8)
      }, pause: .milliseconds(16))
    let full = try await run("pełne odświeżenie", feeds: [Self.colored, Data("\u{1B}[2J".utf8), Self.colored],
                             pause: .milliseconds(40))
    #expect(typing.checks >= 1 && typing.checks <= 30 * 2, "jeden sygnał na porcję: \(typing.checks)")
    #expect(typing.signals == 0, "pisanie w środku ekranu nie zmienia krawędzi")
    #expect(scroll.checks <= 20 * 2)
    #expect(full.signals >= 1)

    let clock = ContinuousClock()
    let reads = 200
    func measureReads(_ name: String) -> Duration {
      let started = clock.now
      for _ in 0..<reads { _ = surface.readEdges() }
      let each = (clock.now - started) / reads
      print("[pomiar krawędzi] odczyt krawędzi \(grid.cols)×\(grid.rows), \(name): \(each) na odczyt (średnio z \(reads))")
      return each
    }
    let alternate = measureReads("ekran alternatywny")
    // Najgorszy przypadek: ekran główny cały w kolorze — reguła boków przegląda każdą komórkę każdego wiersza.
    surface.feed(Data("\u{1B}[?1049l\u{1B}[44m\u{1B}[2J\u{1B}[0m".utf8))
    #expect(surface.readEdges().leading.allSatisfy { $0 != nil }, "każdy wiersz w kolorze")
    let colored = measureReads("ekran główny cały w kolorze")
    #expect(alternate < .milliseconds(5) && colored < .milliseconds(5), "odczyt krawędzi tani")
  }
}
#endif
