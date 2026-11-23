import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Nagłówek sesji renderowany w oknie (ciemny motyw) i mierzony z pikseli — bez hosta apki i sieci.
/// Magazyn nie startuje, więc nic nie wychodzi do serwera.
@MainActor
final class HeaderChromeTests: XCTestCase {
  /// Szerokości kolumny: iPhone Air (420 pt) i kolumna szczegółu iPada Pro 11" obok listy 320 pt.
  private static let widths: [CGFloat] = [420, 514]

  /// Pierścień kontekstu zaczyna się, a kapsuła pigułki „↑ CLI" kończy 16 pt od krawędzi kolumny —
  /// tam, gdzie tekst transkryptu. Liczy się atrament, nie ramka: kreska pierścienia wystaje poza ramkę.
  func testStatusLineInkSitsOnHeaderInset() throws {
    for width in Self.widths {
      let (store, session) = try Self.store(session: #"""
        "branch":"main","ahead":271,"usage":{"contextTokens":24000,"contextLimit":200000},
        "cliUpdate":{"running":"2.1.290","installed":"2.1.292"}
        """#)
      let navigation = RarogNavigation(prefs: MemoryPreferences())
      let pixels = try XCTUnwrap(Self.render(
        SessionStatusBar(store: store, session: session).environment(navigation), width: width))
      attach(pixels, "linia-statusu-\(Int(width))")
      // Bez ostatnich 2 pt: tam stoi kreska pod linią, przez całą szerokość.
      let ink = try XCTUnwrap(pixels.ink(rows: 0..<(pixels.height - 6), threshold: 12), "linia statusu")
      XCTAssertEqual(ink.minX, HeaderMetrics.contentInset, accuracy: 0.5, "\(width) pt: pierścień od lewej")
      XCTAssertEqual(width - ink.maxX, HeaderMetrics.contentInset, accuracy: 0.5, "\(width) pt: pigułka od prawej")
    }
  }

  /// Wciśnięta zakładka nie dostaje prostokąta tła, bo błyskałby przy każdym tapnięciu. Odpowiedzią na palec jest
  /// delikatnie przygaszona etykieta, bez skali. Płytka bieżącej
  /// stoi też w spoczynku, więc pod palcem nic nie może się od niej odciąć mocniej.
  func testPressedTabHasNoBackgroundAndDimsLabel() throws {
    for tab in [
      ProjectTabModel(
        id: "t1", kind: .session, target: .session("t1"), label: "native", tone: .quiet, current: true, spoken: "native"),
      ProjectTabModel(
        id: "t2", kind: .session, target: .session("t2"), label: "Błędne informacje", tone: .quiet, current: false,
        spoken: "siostra"),
    ] {
      let rest = try XCTUnwrap(Self.render(TabPressLook(label: ProjectTabLabel(tab: tab, showsMark: false), pressed: false)))
      let pressed = try XCTUnwrap(Self.render(TabPressLook(label: ProjectTabLabel(tab: tab, showsMark: false), pressed: true)))
      attach(pressed, "zakladka-wcisnieta-\(tab.id)")
      // Cel dotyku poza treścią: pasy po bokach (treść zaczyna się 8 pt od brzegu) i nad płytką (zaczyna się 10 pt
      // pod górą celu). U siostry to tło kolumny; u bieżącej po bokach płytka, która pod palcem najwyżej przygasa.
      let probes = [CGPoint(x: 3, y: rest.heightPoints / 2), CGPoint(x: rest.widthPoints - 3, y: rest.heightPoints / 2),
                    CGPoint(x: rest.widthPoints / 2, y: 4)]
      for probe in probes {
        let before = RenderedPixels.distance(rest.color(at: probe), rest.background)
        XCTAssertLessThanOrEqual(
          RenderedPixels.distance(pressed.color(at: probe), pressed.background), before + 2,
          "\(tab.id): pod palcem bez dodatkowego tła w \(probe)")
        if !tab.current {
          XCTAssertLessThanOrEqual(before, 2, "\(tab.id): siostra bez tła w \(probe)")
        }
      }
      let restInk = rest.brightest
      let pressedInk = pressed.brightest
      XCTAssertLessThan(pressedInk, restInk - 20, "\(tab.id): etykieta przygasa pod palcem (\(pressedInk) z \(restInk))")
      XCTAssertGreaterThan(pressedInk, restInk / 2, "\(tab.id): przygaszenie jest delikatne (\(pressedInk) z \(restInk))")
    }
  }

  /// Wskaźnik nad zakładką-siostrą: etykieta w pełnym tekście na płytce
  /// w połowie krycia, jak wiersz agenta pod kursorem. Stan wskaźnika przychodzi środowiskiem
  /// (`RarogHoverReader` w stylu).
  func testHoveredSiblingTabLightsLabelOnHalfPlate() throws {
    let tab = ProjectTabModel(
      id: "t2", kind: .session, target: .session("t2"), label: "siostra", tone: .working, current: false,
      spoken: "siostra")
    let rest = try XCTUnwrap(Self.render(ProjectTabLabel(tab: tab, showsMark: false)))
    let hovered = try XCTUnwrap(Self.render(
      ProjectTabLabel(tab: tab, showsMark: false).environment(\.rarogHovered, true)))
    attach(hovered, "zakladka-pod-wskaznikiem")
    var text: CGFloat = 0
    Palette.text.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark)).getRed(nil, green: nil, blue: &text, alpha: nil)
    // Szare piksele: kwadracik „pracuje” ma pełną zieleń kropki listy, jaśniejszą od cichej etykiety.
    XCTAssertGreaterThan(
      hovered.brightestGray, rest.brightestGray + 40, "etykieta jaśnieje (\(rest.brightestGray) → \(hovered.brightestGray))")
    XCTAssertGreaterThanOrEqual(hovered.brightestGray, Int(text * 255) - 12, "pełny tekst")
    // Nad płytką samo tło; w osi etykiety przy brzegu (poza treścią) płytka w kolorze wiersza agenta pod kursorem.
    let above = CGPoint(x: hovered.widthPoints / 2, y: 4)
    XCTAssertLessThanOrEqual(RenderedPixels.distance(hovered.color(at: above), hovered.background), 2, "nad płytką tło")
    let edge = CGPoint(x: 2, y: hovered.heightPoints / 2 + HeaderMetrics.tabLabelDrop)
    let half = HoverTokens.agentRow(selected: false, hovered: true, dark: true)
    XCTAssertLessThanOrEqual(RenderedPixels.distance(hovered.color(at: edge), half), 2, "płytka w połowie krycia")
    XCTAssertLessThanOrEqual(RenderedPixels.distance(rest.color(at: edge), rest.background), 2, "bez wskaźnika bez płytki")
  }

  /// Znak stanu przed etykietą zakładki stoi tylko przy „Rozróżniaj bez koloru" — na co dzień stan niesie
  /// kolor kafelka albo kwadracika. Bez znaku
  /// pierwszy atrament (kwadracik) stoi 8 pt od brzegu celu dotyku, czyli z paskiem (8 pt) na 16 pt od krawędzi
  /// kolumny.
  func testTabStateMarkOnlyWhenDifferentiatingWithoutColor() throws {
    for tone in [StatusTone.working, .waiting, .failed, .unread, .backgroundWait] {
      let tab = ProjectTabModel(
        id: "t", kind: .session, target: .session("t"), label: "Claude Code", tone: tone, current: true,
        spoken: "Claude Code")
      let plain = try XCTUnwrap(Self.render(ProjectTabLabel(tab: tab, showsMark: false)))
      let marked = try XCTUnwrap(Self.render(ProjectTabLabel(tab: tab, showsMark: true)))
      attach(marked, "zakladka-ze-znakiem-\(tone)")
      let all = 0..<plain.height
      let ink = Palette.tone(tone).resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
      XCTAssertGreaterThan(
        marked.count(rows: all, near: ink), plain.count(rows: all, near: ink) + 10,
        "\(tone): znak w kolorze stanu przy „Rozróżniaj bez koloru”")
      XCTAssertGreaterThan(marked.widthPoints, plain.widthPoints + 6, "\(tone): znak poszerza zakładkę")
      // Siostra (bez płytki): pierwszy atrament to kwadracik, 8 pt od brzegu celu.
      let sibling = ProjectTabModel(
        id: "t", kind: .session, target: .session("t"), label: "Claude Code", tone: tone, current: false,
        spoken: "Claude Code")
      let siblingPixels = try XCTUnwrap(Self.render(ProjectTabLabel(tab: sibling, showsMark: false)))
      let first = try XCTUnwrap(siblingPixels.ink(rows: 0..<siblingPixels.height, threshold: 12), "\(tone): kwadracik")
      XCTAssertEqual(first.minX, HeaderMetrics.tabLabelInset, accuracy: 1, "\(tone): kwadracik od brzegu celu")
    }
  }

  /// Zaproszenie do terminala: sam glif, bez napisu, który w największym piśmie
  /// spychałby „+" poza ekran. Wygaszone (`termEnabled: false`) ma atrament sióstr (`muted2`, ≥ 4,5:1) zamiast
  /// `idleInk` (audyt kontrastu: 2,77:1). Żadne zaproszenie nie ma znaku stanu: ani kafelka, ani
  /// kwadracika, a kreski pod glifem nie ma nigdzie.
  func testTerminalInviteIsGlyphWithAAInk() throws {
    var muted: CGFloat = 0
    Palette.muted2.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
      .getRed(nil, green: nil, blue: &muted, alpha: nil)
    for enabled in [true, false] {
      let tab = ProjectTabModel(
        id: "terminal-invite", kind: .invite(enabled: enabled), target: nil, label: UICopy.terminalTabFallback,
        tone: .quiet, current: false, spoken: enabled ? UICopy.terminalInviteSpoken : UICopy.terminalOff)
      let pixels = try XCTUnwrap(Self.render(ProjectTabLabel(tab: tab, showsMark: false)))
      attach(pixels, "zaproszenie-\(enabled ? "czynne" : "wygaszone")")
      XCTAssertEqual(pixels.widthPoints, 44, accuracy: 1, "\(enabled): sam glif w celu 44 pt, bez napisu")
      XCTAssertGreaterThanOrEqual(pixels.brightest, Int(muted * 255) - 12, "\(enabled): atrament muted2, nie idleInk")
      // Cały atrament to glif (~14 pt): kwadracik z odstępem przed nim dałby co najmniej 30 pt, kreska — pas pod nim.
      let ink = try XCTUnwrap(pixels.ink(rows: 0..<pixels.height, threshold: 12), "\(enabled): glif")
      XCTAssertLessThan(ink.width, 20, "\(enabled): bez kwadracika przed glifem")
      XCTAssertLessThan(ink.maxY, pixels.heightPoints - 8, "\(enabled): bez kreski pod glifem")
    }
  }

  /// Kafelek skrótu Cmd przed etykietą: płytka bez obrysu zaczyna się tam, gdzie
  /// bez cyfry stoi kwadracik (8 pt od brzegu celu), i jest od niego szersza o cyfrę.
  func testShortcutKeyIsBorderlessPlateBeforeLabel() throws {
    let tab = ProjectTabModel(
      id: "t2", kind: .session, target: .session("t2"), label: "siostra", tone: .quiet, current: false,
      spoken: "siostra")
    let plain = try XCTUnwrap(Self.render(ProjectTabLabel(tab: tab, showsMark: false)))
    let keyed = try XCTUnwrap(Self.render(ProjectTabLabel(tab: tab, showsMark: false, digit: 3)))
    attach(keyed, "zakladka-z-klawiszem")
    // Kafelek ~17 pt (cyfra i po 5 pt z boków) zamiast kwadracika 10 pt.
    XCTAssertGreaterThan(keyed.widthPoints, plain.widthPoints + 4, "kafelek szerszy niż kwadracik")
    XCTAssertLessThan(keyed.widthPoints, plain.widthPoints + 12, "kafelek szerszy niż kwadracik tylko o cyfrę")
    XCTAssertEqual(keyed.heightPoints, plain.heightPoints, accuracy: 0.5, "wysokość celu bez zmian")

    // Próg 12 łapie też płytkę kafelka (biel 13 % na tle kolumny).
    let rows = 0..<keyed.height
    let ink = try XCTUnwrap(keyed.ink(rows: rows, threshold: 12), "kafelek i etykieta")
    XCTAssertEqual(ink.minX, HeaderMetrics.tabLabelInset, accuracy: 1, "kafelek od brzegu celu")
    let text = try XCTUnwrap(plain.ink(rows: rows, threshold: 48), "tekst etykiety bez kafelka")
    XCTAssertGreaterThan(ink.height, text.height + 2, "kafelek wyższy niż pismo etykiety")

    // Bez obrysu: tuż przy lewej i górnej krawędzi kafelek ma kolor swojego wnętrza, różny od tła.
    let edge = keyed.color(at: CGPoint(x: ink.minX + 1.5, y: ink.midY))
    let top = keyed.color(at: CGPoint(x: ink.minX + 8.5, y: ink.minY + 1.2))
    XCTAssertLessThanOrEqual(RenderedPixels.distance(edge, top), 3, "krawędź kafelka bez jaśniejszej kreski")
    XCTAssertGreaterThan(RenderedPixels.distance(edge, keyed.background), 12, "kafelek odcina się od tła")
  }

  /// Bieżąca zakładka stoi na płytce — pełna szerokość celu, od 10 pt pod
  /// jego górą do 6 pt nad dołem, róg 8 pt; siostra tła nie ma, a kreski stanu nie ma u nikogo.
  func testCurrentTabStandsOnPlateWithoutUnderline() throws {
    let plate = Self.hex(Palette.tabPlate)
    for tone in [StatusTone.quiet, .working, .waiting] {
      let current = ProjectTabModel(
        id: "t1", kind: .session, target: .session("t1"), label: "Claude Code", tone: tone, current: true,
        spoken: "Claude Code")
      let pixels = try XCTUnwrap(Self.render(ProjectTabLabel(tab: current, showsMark: false, digit: 2)))
      attach(pixels, "zakladka-biezaca-\(tone)")
      XCTAssertEqual(pixels.heightPoints, 44, accuracy: 0.5, "cel dotyku 44 pt")
      // Pion płytki w osi środka zakładki (poza zaokrąglonymi rogami; etykieta stoi tylko w środkowym pasie).
      let x = Int(pixels.widthPoints / 2 * pixels.scale)
      let column = (0..<pixels.height).filter { RenderedPixels.distance(pixels.pixel(x, $0), plate) <= 2 }
      let top = CGFloat(try XCTUnwrap(column.first)) / pixels.scale
      let bottom = CGFloat(try XCTUnwrap(column.last) + 1) / pixels.scale
      XCTAssertEqual(top, TabTokens.plateTopInset, accuracy: 0.7, "\(tone): płytka 10 pt pod górą celu")
      XCTAssertEqual(pixels.heightPoints - bottom, TabTokens.plateBottomInset, accuracy: 0.7, "\(tone): 6 pt nad dołem")
      // Pełna szerokość celu: płytka dochodzi do obu brzegów w osi etykiety, róg jest zaokrąglony.
      let mid = pixels.heightPoints / 2 + HeaderMetrics.tabLabelDrop
      for x in [CGFloat(0.4), pixels.widthPoints - 0.4] {
        XCTAssertLessThanOrEqual(RenderedPixels.distance(pixels.color(at: CGPoint(x: x, y: mid)), plate), 2,
                                 "\(tone): płytka przy brzegu \(x)")
      }
      XCTAssertLessThanOrEqual(
        RenderedPixels.distance(pixels.color(at: CGPoint(x: 0.4, y: TabTokens.plateTopInset + 0.4)), pixels.background),
        8, "\(tone): róg płytki zaokrąglony")

      let sibling = ProjectTabModel(
        id: "t2", kind: .session, target: .session("t2"), label: "Claude Code", tone: tone, current: false,
        spoken: "Claude Code")
      let siblingPixels = try XCTUnwrap(Self.render(ProjectTabLabel(tab: sibling, showsMark: false, digit: 2)))
      XCTAssertLessThanOrEqual(
        RenderedPixels.distance(siblingPixels.color(at: CGPoint(x: 2, y: mid)), siblingPixels.background), 2,
        "\(tone): siostra bez płytki")
      // Pas pod treścią (dolne 8 pt celu, gdzie stała kreska): u siostry samo tło.
      let below = Int(((siblingPixels.heightPoints - 8) * siblingPixels.scale).rounded())..<siblingPixels.height
      XCTAssertEqual(siblingPixels.offBackground(row: below.lowerBound + 3, threshold: 6), 0, "\(tone): bez kreski")
      XCTAssertEqual(siblingPixels.offBackground(row: below.upperBound - 4, threshold: 6), 0, "\(tone): bez kreski")
    }
  }

  /// Drabina pilności: kafelek ma kolor `TabTokens.key` i jest kryjący — u siostry
  /// i na płytce bieżącej to ten sam kolor; bez cyfry stoi kwadracik `TabTokens.square`.
  func testTileAndSquareCarryStateColor() throws {
    for tone in [StatusTone.quiet, .working, .unread, .waiting, .failed, .backgroundWait] {
      let fill = TabTokens.key(tone).fill.dark
      for current in [false, true] {
        let tab = ProjectTabModel(
          id: "t", kind: .session, target: .session("t"), label: "Claude Code", tone: tone, current: current, spoken: "x")
        let keyed = try XCTUnwrap(Self.render(ProjectTabLabel(tab: tab, showsMark: false, digit: 4)))
        attach(keyed, "kafelek-\(tone)-\(current ? "biezaca" : "siostra")")
        // Wnętrze kafelka tuż za jego lewą krawędzią (8 pt od brzegu celu), w osi treści, przed cyfrą.
        let probe = CGPoint(x: HeaderMetrics.tabLabelInset + 1.5, y: keyed.heightPoints / 2 + HeaderMetrics.tabLabelDrop)
        XCTAssertLessThanOrEqual(RenderedPixels.distance(keyed.color(at: probe), fill), 3,
                                 "\(tone) \(current): kafelek #\(String(fill, radix: 16)) ma " +
                                 "#\(String(keyed.color(at: probe), radix: 16))")
      }
      let look = TabTokens.square(tone)
      let expected = PaletteTokens.over(look.color.dark, alpha: look.alpha.dark, on: PaletteTokens.background.dark)
      let tab = ProjectTabModel(
        id: "t", kind: .session, target: .session("t"), label: "Claude Code", tone: tone, current: false, spoken: "x")
      // Etykieta dłuższa niż cel 44 pt: przy krótszej treść stoi wyśrodkowana w celu, nie 8 pt od brzegu.
      let square = try XCTUnwrap(Self.render(ProjectTabLabel(tab: tab, showsMark: false)))
      attach(square, "kwadracik-\(tone)")
      let center = CGPoint(
        x: HeaderMetrics.tabLabelInset + TabTokens.squareSide / 2, y: square.heightPoints / 2 + HeaderMetrics.tabLabelDrop)
      XCTAssertLessThanOrEqual(RenderedPixels.distance(square.color(at: center), expected), 3,
                               "\(tone): kwadracik #\(String(expected, radix: 16)) ma " +
                               "#\(String(square.color(at: center), radix: 16))")
      let ink = try XCTUnwrap(square.ink(rows: 0..<square.height, threshold: 6), "\(tone): kwadracik")
      XCTAssertEqual(ink.minX, HeaderMetrics.tabLabelInset, accuracy: 0.7, "\(tone): kwadracik od brzegu celu")
    }
  }

  /// Zmiana stanu nie przesuwa paska: szerokość zakładki z kafelkiem i z kwadracikiem jest ta sama w każdym tonie
  /// (cyfra półgruba i medium w mono ma tę samą szerokość; kwadracik stoi też w ciszy).
  func testTabWidthDoesNotDependOnTone() throws {
    for digit in [Int?.none, 1, 8] {
      var widths: [CGFloat] = []
      for tone in [StatusTone.quiet, .working, .unread, .waiting, .failed, .backgroundWait] {
        let tab = ProjectTabModel(
          id: "t", kind: .session, target: .session("t"), label: "Claude Code", tone: tone, current: false,
          spoken: "Claude Code")
        widths.append(try XCTUnwrap(Self.render(ProjectTabLabel(tab: tab, showsMark: false, digit: digit))).widthPoints)
      }
      XCTAssertEqual(widths.max()! - widths.min()!, 0, accuracy: 0.01, "cyfra \(String(describing: digit)): \(widths)")
    }
  }

  // MARK: - Pomocnicze

  /// Kolor palety w ciemnym motywie jako 0xRRGGBB.
  static func hex(_ color: UIColor) -> UInt32 {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0
    color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark)).getRed(&r, green: &g, blue: &b, alpha: nil)
    return UInt32((r * 255).rounded()) << 16 | UInt32((g * 255).rounded()) << 8 | UInt32((b * 255).rounded())
  }

  private func attach(_ pixels: RenderedPixels, _ name: String) {
    let attachment = XCTAttachment(image: UIImage(cgImage: pixels.image))
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// Magazyn z jedną sesją `s1` (pola podsumowania dopisane do minimalnego JSON-a).
  static func store(session fields: String) throws -> (RarogStore, SessionSummary) {
    let store = RarogStore.live(
      config: .test(port: 9),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
    store.dispatch(.loggedIn)
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    try frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#)
    let session = #"""
      {"id":"s1","cwd":"/Users/demo/rarog","title":"rarog","state":"idle",
       "stateSince":"2026-10-06T10:00:00.000Z","createdAt":"2026-10-06T10:00:00.000Z",
       "lastActivityAt":"2026-10-06T10:00:00.000Z"\#(fields.isEmpty ? "" : ",")\#(fields)}
      """#
    try frame(store, #"{"type":"sessions-snapshot","sessions":[\#(session)]}"#)
    return (store, try XCTUnwrap(store.state.sessions["s1"]))
  }

  private static func frame(_ store: RarogStore, _ json: String) throws {
    let event = try EventDecoder.decode(Data(json.utf8)).get().event
    store.dispatch(.frame(event, source: .global, cursor: nil))
  }

  /// Widok o zadanej szerokości (`nil` = własny rozmiar) i wysokości z treści, w ciemnym motywie, na tle kolumny.
  static func render(_ view: some View, width: CGFloat? = nil) -> RenderedPixels? {
    let renderer = ImageRenderer(content: view
      .frame(width: width)
      .fixedSize(horizontal: width == nil, vertical: true)
      .background(Color(uiColor: Palette.background))
      .environment(\.colorScheme, .dark))
    renderer.scale = 3
    return renderer.cgImage.flatMap { RenderedPixels($0, scale: 3) }
  }
}

/// Bitmapa sRGB z renderu: gdzie stoi atrament (piksele odróżnialne od tła w lewym górnym rogu).
struct RenderedPixels {
  let width: Int
  let height: Int
  let scale: CGFloat
  let image: CGImage
  private let bytes: [UInt8]

  init?(_ image: CGImage, scale: CGFloat) {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    let width = image.width
    let height = image.height
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
      else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard drawn else { return nil }
    self.width = width
    self.height = height
    self.scale = scale
    self.image = image
    self.bytes = bytes
  }

  /// Rozmiar w punktach.
  var heightPoints: CGFloat { CGFloat(height) / scale }
  var widthPoints: CGFloat { CGFloat(width) / scale }

  func color(at point: CGPoint) -> UInt32 {
    pixel(min(width - 1, Int(point.x * scale)), min(height - 1, Int(point.y * scale)))
  }

  /// Najjaśniejszy kanał w całym obrazie (atrament tekstu na ciemnym tle).
  var brightest: Int {
    var top = 0
    for y in 0..<height {
      for x in 0..<width {
        let rgb = pixel(x, y)
        top = max(top, Int(rgb >> 16 & 0xFF), Int(rgb >> 8 & 0xFF), Int(rgb & 0xFF))
      }
    }
    return top
  }

  /// Najjaśniejszy kanał wśród pikseli szarych (kanały różnią się najwyżej o 12): atrament etykiety bez barwnego
  /// znaku stanu obok.
  var brightestGray: Int {
    var top = 0
    for y in 0..<height {
      for x in 0..<width {
        let rgb = pixel(x, y)
        let channels = [Int(rgb >> 16 & 0xFF), Int(rgb >> 8 & 0xFF), Int(rgb & 0xFF)]
        if let high = channels.max(), let low = channels.min(), high - low <= 12 { top = max(top, high) }
      }
    }
    return top
  }

  /// Tło: kolor lewego górnego piksela.
  var background: UInt32 { pixel(0, 0) }

  func pixel(_ x: Int, _ y: Int) -> UInt32 {
    let i = (y * width + x) * 4
    return UInt32(bytes[i]) << 16 | UInt32(bytes[i + 1]) << 8 | UInt32(bytes[i + 2])
  }

  /// Ramka atramentu (w punktach) w podanych rzędach pikseli; próg to największa różnica kanału od tła.
  func ink(rows: Range<Int>, threshold: Int) -> CGRect? {
    let background = background
    var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
    for y in rows {
      for x in 0..<width where Self.distance(pixel(x, y), background) > threshold {
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
      }
    }
    guard maxX >= 0 else { return nil }
    return CGRect(x: CGFloat(minX) / scale, y: CGFloat(minY) / scale,
                  width: CGFloat(maxX - minX + 1) / scale, height: CGFloat(maxY - minY + 1) / scale)
  }

  /// Liczba pikseli w rzędach, których kolor leży blisko podanego (±40 na kanał; krawędzie wygładzone odpadają).
  func count(rows: Range<Int>, near color: UIColor) -> Int {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    color.getRed(&r, green: &g, blue: &b, alpha: &a)
    let target = UInt32(r * 255) << 16 | UInt32(g * 255) << 8 | UInt32(b * 255)
    var n = 0
    for y in rows {
      for x in 0..<width where Self.distance(pixel(x, y), target) <= 40 { n += 1 }
    }
    return n
  }

  /// Ułamek pikseli rzędu `y`, które odstają od tła o więcej niż próg.
  func offBackground(row y: Int, threshold: Int) -> Double {
    let background = background
    let off = (0..<width).filter { Self.distance(pixel($0, y), background) > threshold }.count
    return Double(off) / Double(width)
  }

  static func distance(_ a: UInt32, _ b: UInt32) -> Int {
    [16, 8, 0].map { shift in abs(Int((a >> UInt32(shift)) & 0xFF) - Int((b >> UInt32(shift)) & 0xFF)) }.max() ?? 0
  }
}
