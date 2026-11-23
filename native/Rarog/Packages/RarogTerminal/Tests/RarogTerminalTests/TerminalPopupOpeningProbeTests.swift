#if os(iOS)
import RarogContract
import RarogCore
@testable import RarogTerminal
import RarogTransport
@testable import RarogUI
@preconcurrency import SwiftTerm
import SwiftUI
import Testing
import UIKit

// Pomiar: okno terminala Cmd+F pokazuje treść „sekundę po skończonej animacji”, tab — od razu (odbiór
// na iPadzie z klawiaturą sprzętową; „od zawsze”, także drugie Cmd+F z parkingu: „tak jakby terminal się
// załadował pusty i po animacji dociąga historię”). Test stawia PRAWDZIWĄ powierzchnię SwiftTerm w ekranie terminala
// i co ~8 ms zapisuje jej stan: rozmiar, przewinięcie (`contentOffset` wobec dołu liczonego jak w SwiftTerm), wstawki,
// siatkę, stan emulatora, pas krawędzi nad siatką i to, czy dolny wiersz z `PROMPT>` jest NARYSOWANY (piksele
// warstwy powierzchni i całego okna, `layer.render`).
// Proces testów nie ma `UIApplication` ani sceny: `present` UIKit nie wstawia okna do hierarchii (zmierzone
// okno 834×0, `completion` nie przychodzi), a `.sheet` SwiftUI zawisa (README, „Tests”). Arkusz jest
// więc UDAWANY tak, jak robi to UIKit: kontener w oknie, przejście wyglądu (`beginAppearanceTransition` →
// `viewIsAppearing` w pierwszym układzie → `viewDidAppear` na końcu), wjazd od dołu 500 ms. Prawdziwego zamknięcia
// arkusza ten test nie ma — a to ono psuje ekran z parkingu.
// Prawdziwą prezentację zmierzyła jednorazowa sonda w apce (build Debug, symulator iPad Pro 11" M5,
// iOS 27.0; `.sheet(item:)` z treścią jak `TerminalPopupSheet` i `present` UIKit `.formSheet`, ta sama atrapa
// serwera): przy ZAMKNIĘCIU okna (`UISheetPresentationController._transitionWillBegin` → układ ekranu)
// `keyboardLayoutGuide` ekranu ma ramkę (x, 0, szer., 0), dół stosu staje na górze ekranu, powierzchnia ma 0 pt
// wysokości, a SwiftTerm schodził do 1 wiersza — z `scrollback: 0` reszta ekranu przepadała. Także bez fokusu
// i bez klawiatury ekranowej; tab przy zejściu tego nie robi. Ekran szedł do parkingu pusty, a ponowne Cmd+F
// pokazywało pusty terminal, aż herdr przerysował panel po `rs` — wymuszone `rs` wychodzi dopiero z `viewDidAppear`,
// na końcu animacji. Poprawka (ten sam dzień): powierzchnia nie zmienia siatki w ramce mniejszej niż komórka
// (`SwiftTermSurface.layoutSubviews`); ta sama sonda pokazała potem `PROMPT>` od startu przejścia. Mechanizm
// (prowadnica klawiatury o ramce zero → zero wierszy) odtwarza tu `layoutOutsideWindow`, a pilnuje go też
// `SwiftTermSurfaceTests.degenerateFrameKeepsScreen`. `contentOffset` i `adjustedContentInset` powierzchni były
// zero w każdej próbce (sonda i ten test): przewinięcie widoku nie gra roli.
// Atrapa serwera odpowiada od razu pełnym ekranem i NIE przerysowuje po `rs` — widać więc wyłącznie stronę apki;
// ramki `rs` i rozmiar z upgrade'u idą do zdarzeń. Wynik w konsoli testu (`print`, prefiks `[pomiar]`). Zrzuty okna
// w kluczowych chwilach idą do katalogu z `RAROG_PROBE_DIR` (xcodebuild: `TEST_RUNNER_RAROG_PROBE_DIR`), gdy jest.
// Treść syntetyczna. Właściciel: terminal.

// MARK: - Atrapa serwera ze stemplami czasu

final class ProbeSocket: TerminalSocketing, @unchecked Sendable {
  let events: AsyncStream<TerminalSocketEvent>
  private let continuation: AsyncStream<TerminalSocketEvent>.Continuation
  private let lock = NSLock()
  private var frames: [(at: CFTimeInterval, frame: TerminalClientFrame)] = []

  init() {
    (events, continuation) = AsyncStream<TerminalSocketEvent>.makeStream()
  }

  var sent: [(at: CFTimeInterval, frame: TerminalClientFrame)] { lock.withLock { frames } }

  func emit(_ event: TerminalSocketEvent) { continuation.yield(event) }

  func send(_ frame: TerminalClientFrame) async -> Bool {
    lock.withLock { frames.append((CACurrentMediaTime(), frame)) }
    return true
  }

  func close() {
    continuation.yield(.closed)
    continuation.finish()
  }
}

/// `POST` przyjęty, gniazdo od razu otwarte i od razu pełny ekran (najlepszy przypadek sieci).
final class ProbeWire: TerminalTransporting, @unchecked Sendable {
  typealias Opened = (at: CFTimeInterval, grid: TerminalGrid?, socket: ProbeSocket)
  static let id = "0123456789abcdef"
  private let lock = NSLock()
  private var opened: [Opened] = []
  private let fullScreen: Data

  init(fullScreen: Data) { self.fullScreen = fullScreen }

  var sockets: [Opened] { lock.withLock { opened } }

  func openTerminal(_ body: TerminalOpenBody) async throws(TransportError) -> TerminalOpenResponse {
    do {
      return try JSONDecoder().decode(
        TerminalOpenResponse.self, from: Data(#"{"id":"\#(Self.id)","slot":0,"role":"popup"}"#.utf8))
    } catch {
      throw .invalidResponse("atrapa")
    }
  }

  func terminals() async throws(TransportError) -> TerminalList { throw .invalidResponse("atrapa") }

  func terminalHistory(id: String, lines: Int) async throws(TransportError) -> TerminalHistory {
    throw .invalidResponse("atrapa")
  }

  func closeTerminal(id: String) async throws(TransportError) {}

  func checkTerminalInput() async throws(MutationRefusal) {}

  func terminalSocket(
    id: String, fresh: Bool, direct: Bool, grid: TerminalGrid?
  ) throws(TransportError) -> any TerminalSocketing {
    let socket = ProbeSocket()
    lock.withLock { opened.append((CACurrentMediaTime(), grid, socket)) }
    socket.emit(.opened)
    socket.emit(.frame(.hello(backend: "herdr")))
    socket.emit(.bytes(fullScreen))
    return socket
  }
}

// MARK: - Piksele

/// Obraz warstwy (z jej bieżącą zawartością — tym, co stoi na ekranie w tej chwili) w bitmapie sRGB, skala 1.
struct ProbeBitmap {
  let width: Int
  let height: Int
  let bytes: [UInt8]

  @MainActor
  init(_ layer: CALayer, rect: CGRect) {
    let width = max(1, Int(rect.width.rounded(.up)))
    let height = max(1, Int(rect.height.rounded(.up)))
    var data = [UInt8](repeating: 0, count: width * height * 4)
    data.withUnsafeMutableBytes { buffer in
      guard
        let context = CGContext(
          data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return }
      context.translateBy(x: 0, y: CGFloat(height))
      context.scaleBy(x: 1, y: -1)
      context.translateBy(x: -rect.minX, y: -rect.minY)
      layer.render(in: context)
    }
    self.width = width
    self.height = height
    bytes = data
  }

  /// Piksele „atramentu” (jasne litery na czarnym tle) w prostokącie, co drugi piksel w obu osiach.
  func ink(in rect: CGRect) -> Int {
    let x0 = max(0, Int(rect.minX)), x1 = min(width, Int(rect.maxX))
    let y0 = max(0, Int(rect.minY)), y1 = min(height, Int(rect.maxY))
    guard x0 < x1, y0 < y1 else { return 0 }
    let width = width
    return bytes.withUnsafeBufferPointer { pixels in
      var count = 0
      for y in stride(from: y0, to: y1, by: 2) {
        for x in stride(from: x0, to: x1, by: 2) {
          let offset = (y * width + x) * 4
          if max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 110 { count += 1 }
        }
      }
      return count
    }
  }

  func png() -> Data? {
    guard let provider = CGDataProvider(data: Data(bytes) as CFData),
      let image = CGImage(
        width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider,
        decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { return nil }
    return UIImage(cgImage: image).pngData()
  }
}

// MARK: - Próbnik

/// Zapis stanu powierzchni co ~8 ms od chwili zero (pokazanie okna albo wstawienie taba).
@MainActor
final class OpeningProbe {
  struct Sample {
    var t: Double
    var dy: CGFloat
    var inWindow: Bool
    var size: CGSize
    var offsetY: CGFloat
    var bottomY: CGFloat
    var contentH: CGFloat
    var adjusted: UIEdgeInsets
    var inset: UIEdgeInsets
    var safeTop: CGFloat
    var cols: Int
    var rows: Int
    var yDisp: Int
    var emuPrompt: Bool
    var emuRows: Int
    var layerPrompt: Int
    var layerRows: Int
    var shownPrompt: Int
    var shownRows: Int
    var bandsOverGrid: Double
    var phase: String
    var focused: Bool
    var suspended: Bool

    /// Wszystko poza czasem i przesunięciem animacji — zmiana daje wiersz w logu.
    var signature: String {
      "\(inWindow) \(size) \(offsetY) \(bottomY) \(contentH) \(adjusted) \(inset) \(safeTop) \(cols)x\(rows) \(yDisp) "
        + "\(emuPrompt) \(emuRows) \(layerPrompt > 0) \(layerRows) \(shownPrompt > 0) \(shownRows) "
        + "\(bandsOverGrid > 0.01) \(phase) \(focused) \(suspended)"
    }

    var line: String {
      func f(_ v: CGFloat) -> String { String(format: "%.1f", v) }
      func insets(_ i: UIEdgeInsets) -> String { "\(f(i.top))/\(f(i.bottom))" }
      return String(format: "%7.1f ms", t)
        + " | anim dy=\(f(dy)) okno=\(inWindow ? "T" : "n")"
        + " | pow \(Int(size.width))x\(Int(size.height)) off.y=\(f(offsetY)) dół=\(f(bottomY)) cont.h=\(f(contentH))"
        + " adj=\(insets(adjusted)) ins=\(insets(inset)) safe.top=\(f(safeTop))"
        + " | siatka \(cols)x\(rows) yDisp=\(yDisp)"
        + " | emu PROMPT=\(emuPrompt ? "T" : "n") wiersze=\(emuRows)"
        + " | warstwa PROMPT=\(layerPrompt) wiersze=\(layerRows) | okno PROMPT=\(shownPrompt) wiersze=\(shownRows)"
        + " | pas/siatka=\(String(format: "%.2f", bandsOverGrid))"
        + " | faza=\(phase) fokus=\(focused ? "T" : "n") wstrzym=\(suspended ? "T" : "n")"
    }
  }

  static var current: OpeningProbe?

  let name: String
  let screen: TerminalScreenViewController
  let surface: SwiftTermSurface
  /// Korzeń obrazu „całego okna” (kontener nawigacji okna, treść SwiftUI albo kontener taba).
  let root: UIView
  /// Przesunięcie animacji wjazdu w tej chwili (0 = okno na miejscu).
  var offset: () -> CGFloat = { 0 }
  let origin: CFTimeInterval
  private(set) var samples: [Sample] = []
  private(set) var events: [(t: Double, text: String)] = []
  private var timer: Timer?
  private var tick = 0
  private var drawnNow: (prompt: Int, rows: Int, shownPrompt: Int, shownRows: Int) = (0, 0, 0, 0)
  private var snapshots: [(at: Double, label: String)] = []
  private let snapshotDir = ProcessInfo.processInfo.environment["RAROG_PROBE_DIR"]

  init(name: String, screen: TerminalScreenViewController, surface: SwiftTermSurface, root: UIView) {
    self.name = name
    self.screen = screen
    self.surface = surface
    self.root = root
    origin = CACurrentMediaTime()
  }

  func ms(_ time: CFTimeInterval) -> Double { (time - origin) * 1000 }

  func event(_ text: String) { events.append((ms(CACurrentMediaTime()), text)) }

  /// Zrzut całego okna przy pierwszej próbce od `at` ms.
  func snapshot(at: Double, _ label: String) {
    snapshots.append((at, label))
    snapshots.sort { $0.at < $1.at }
  }

  func start() {
    OpeningProbe.current = self
    sample()
    let timer = Timer(timeInterval: 0.008, repeats: true) { _ in
      MainActor.assumeIsolated { OpeningProbe.current?.sample() }
    }
    RunLoop.main.add(timer, forMode: .common)
    self.timer = timer
  }

  func stop() {
    timer?.invalidate()
    timer = nil
    if OpeningProbe.current === self { OpeningProbe.current = nil }
  }

  func sample() {
    tick += 1
    let now = ms(CACurrentMediaTime())
    let terminal = surface.getTerminal()
    let cell = surface.cellSize
    let rows = terminal.rows
    func text(_ row: Int) -> String { terminal.getLine(row: row)?.translateToString(trimRight: true) ?? "" }
    // Rysunek co czwartą próbkę (~33 ms): warstwa powierzchni i całe okno z nakładkami (pas krawędzi, linia stanu).
    // Tylko w oknie: `layer.render` woła `layoutIfNeeded`, a układ ekranu POZA oknem (prowadnica klawiatury 0×0)
    // ściska siatkę do zera wierszy — próbnik sam zepsułby to, co mierzy (zmierzone).
    if tick % 4 == 1 {
      drawnNow = surface.window == nil ? (0, 0, 0, 0) : drawn(cell: cell, rows: rows, cols: terminal.cols)
    }
    let grid = surface.convert(surface.gridFrame, to: screen.edgeFill)
    let covered = screen.edgeFill.isHidden ? 0 : screen.edgeFill.bands.reduce(0.0) { sum, band in
      let cut = band.rect.intersection(grid)
      return cut.isNull ? sum : sum + Double(cut.width * cut.height)
    }
    let area = Double(grid.width * grid.height)
    samples.append(
      Sample(
        t: now, dy: offset(), inWindow: surface.window != nil, size: surface.bounds.size,
        offsetY: surface.contentOffset.y,
        bottomY: max(0, surface.contentSize.height - surface.bounds.height + surface.adjustedContentInset.bottom),
        contentH: surface.contentSize.height, adjusted: surface.adjustedContentInset, inset: surface.contentInset,
        safeTop: surface.safeAreaInsets.top, cols: terminal.cols, rows: rows, yDisp: terminal.buffer.yDisp,
        emuPrompt: text(rows - 1).hasPrefix("PROMPT>"), emuRows: (0..<rows).filter { !text($0).isEmpty }.count,
        layerPrompt: drawnNow.prompt, layerRows: drawnNow.rows, shownPrompt: drawnNow.shownPrompt,
        shownRows: drawnNow.shownRows, bandsOverGrid: area > 0 ? covered / area : 0,
        phase: "\(screen.session.phase)", focused: surface.isFirstResponder, suspended: screen.inputSuspended))
    while let due = snapshots.first, now >= due.at {
      snapshots.removeFirst()
      save(due.label, at: now)
    }
  }

  /// Atrament „PROMPT>” w dolnym wierszu i liczba wierszy z atramentem: w warstwie powierzchni i w obrazie okna.
  private func drawn(cell: CGSize, rows: Int, cols: Int) -> (Int, Int, Int, Int) {
    guard cell.height > 0, rows > 0, surface.bounds.width > 0, surface.bounds.height > 0 else { return (0, 0, 0, 0) }
    let visible = surface.bounds
    let own = ProbeBitmap(surface.layer, rect: visible)
    let shown = ProbeBitmap(root.layer, rect: surface.convert(visible, to: root))
    let width = CGFloat(cols) * cell.width
    // „PROMPT>” = kolumny 0…6 dolnego wiersza (kursor stoi w kolumnie 8 i do atramentu się nie liczy).
    let prompt = CGRect(x: 0, y: CGFloat(rows - 1) * cell.height, width: 7 * cell.width, height: cell.height)
    func inkedRows(_ bitmap: ProbeBitmap) -> Int {
      (0..<rows).filter {
        bitmap.ink(in: CGRect(x: 0, y: CGFloat($0) * cell.height, width: width, height: cell.height)) > 2
      }.count
    }
    return (own.ink(in: prompt), inkedRows(own), shown.ink(in: prompt), inkedRows(shown))
  }

  private func save(_ label: String, at now: Double) {
    guard let snapshotDir, root.window != nil, root.bounds.width > 0, root.bounds.height > 0 else { return }
    let file = "\(snapshotDir)/\(name)-\(label)-\(Int(now))ms.png"
    guard let data = ProbeBitmap(root.layer, rect: root.bounds).png() else { return }
    do { try data.write(to: URL(fileURLWithPath: file)) } catch { print("[pomiar] zrzut nie zapisany: \(error)") }
  }

  /// Pierwsza próbka nie wcześniejsza niż `at` ms.
  func sample(at: Double) -> Sample? { samples.first { $0.t >= at } ?? samples.last }

  /// Pierwsza chwila, od której dolny wiersz z `PROMPT>` jest narysowany w obrazie okna (i już nie znika).
  var promptShownSince: Double? {
    guard samples.last?.shownPrompt ?? 0 > 0 else { return nil }
    return samples.reversed().first { $0.shownPrompt == 0 }.flatMap { gone in samples.first { $0.t > gone.t }?.t }
      ?? samples.first?.t
  }

  func report(milestones: [(String, Double)], sockets: [ProbeWire.Opened]) {
    print("[pomiar] ===== \(name) =====")
    for socket in sockets {
      print("[pomiar] \(name): upgrade \(String(format: "%.1f", ms(socket.at))) ms, siatka w zapytaniu: "
        + (socket.grid.map { "\($0.cols)x\($0.rows)" } ?? "brak"))
      for sent in socket.socket.sent {
        if case let .resize(grid) = sent.frame {
          print("[pomiar] \(name): rs \(grid.cols)x\(grid.rows) w \(String(format: "%.1f", ms(sent.at))) ms")
        }
      }
    }
    for event in events { print("[pomiar] \(name): zdarzenie \(String(format: "%7.1f", event.t)) ms: \(event.text)") }
    var previous = ""
    for sample in samples where sample.signature != previous {
      previous = sample.signature
      print("[pomiar] \(name): Δ \(sample.line)")
    }
    for (label, at) in milestones {
      guard let sample = sample(at: at) else { continue }
      print("[pomiar] \(name): ★ \(label) (≥\(Int(at)) ms) \(sample.line)")
    }
    let since = promptShownSince.map { String(format: "%.1f ms", $0) } ?? "nigdy"
    print("[pomiar] \(name): PROMPT> narysowany w oknie od \(since)")
  }
}

// MARK: - Udawany arkusz

/// Arkusz jak w UIKit, bez sceny: kontener na środku okna z promieniem rogu, przejście wyglądu prezentowanego
/// kontrolera i wjazd od dołu w 500 ms (krzywa „ease-out”). Klatki animacji ustawia zegar co 8 ms.
@MainActor
final class EmulatedSheet {
  static let duration: Double = 0.5
  let container = UIView()
  let presented: UIViewController
  private weak var root: UIViewController?
  private var timer: Timer?

  init(_ presented: UIViewController, in root: UIViewController, size: CGSize) {
    self.presented = presented
    self.root = root
    let bounds = root.view.bounds
    container.frame = CGRect(
      x: (bounds.width - size.width) / 2, y: bounds.height - size.height, width: size.width, height: size.height)
    container.layer.cornerRadius = Radius.systemSheet
    container.clipsToBounds = true
    container.backgroundColor = .systemBackground
  }

  /// Przesunięcie wjazdu w tej chwili (model warstwy — animację robi zegar, nie Core Animation).
  var offset: CGFloat { container.transform.ty }

  /// Pokazanie jak UIKit: `viewWillAppear` (widok jeszcze poza oknem) → wstawienie do kontenera, który JUŻ stoi
  /// w oknie, i układ (`viewIsAppearing`) → wjazd → `viewDidAppear`.
  func present(completion: @escaping @MainActor () -> Void) {
    guard let root else { return }
    let travel = container.frame.height
    container.transform = CGAffineTransform(translationX: 0, y: travel)
    root.view.addSubview(container)
    root.addChild(presented)
    presented.beginAppearanceTransition(true, animated: true)
    presented.view.frame = container.bounds
    presented.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    container.addSubview(presented.view)
    root.view.layoutIfNeeded()
    animate(from: travel, to: 0) { [self] in
      presented.endAppearanceTransition()
      presented.didMove(toParent: root)
      completion()
    }
  }

  /// Zamknięcie: `viewWillDisappear` → zjazd → `viewDidDisappear`, kontroler zdjęty z okna.
  func dismiss(completion: @escaping @MainActor () -> Void) {
    presented.willMove(toParent: nil)
    presented.beginAppearanceTransition(false, animated: true)
    animate(from: 0, to: container.frame.height) { [self] in
      presented.view.removeFromSuperview()
      presented.endAppearanceTransition()
      presented.removeFromParent()
      container.removeFromSuperview()
      completion()
    }
  }

  private var motion: (start: CFTimeInterval, from: CGFloat, to: CGFloat, done: @MainActor () -> Void)?

  private func animate(from: CGFloat, to: CGFloat, done: @escaping @MainActor () -> Void) {
    timer?.invalidate()
    motion = (CACurrentMediaTime(), from, to, done)
    let timer = Timer(timeInterval: 0.008, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.step() }
    }
    RunLoop.main.add(timer, forMode: .common)
    self.timer = timer
  }

  private func step() {
    guard let motion else { return }
    let progress = min(1, (CACurrentMediaTime() - motion.start) / Self.duration)
    let eased = 1 - pow(1 - progress, 3)
    container.transform = CGAffineTransform(translationX: 0, y: motion.from + (motion.to - motion.from) * eased)
    guard progress >= 1 else { return }
    timer?.invalidate()
    timer = nil
    self.motion = nil
    motion.done()
  }
}

// MARK: - Testy

@MainActor
@Suite("terminal: pomiar pokazania okna Cmd+F i taba (iOS)", .serialized)
struct TerminalPopupOpeningProbeTests {
  static let cwd = "/Users/demo/Projects/rarog"
  /// iPad Pro 11" poziomo (klawiatura sprzętowa) — okno apki na cały ekran.
  static let windowSize = CGSize(width: 1194, height: 834)
  static let sheetSize = CGSize(
    width: WindowLayout.sheetWidth(window: windowSize.width, compact: false) ?? 1000, height: 780)

  /// Pełny ekran serwera: 200 linii „historii” i rozpoznawalny dolny wiersz.
  static let fullScreen: Data = {
    var text = "\u{1B}[2J\u{1B}[H"
    for line in 1...200 { text += "linia \(line)\r\n" }
    text += "PROMPT> "
    return Data(text.utf8)
  }()

  struct Built {
    let screen: TerminalScreenViewController
    let surface: SwiftTermSurface
  }

  /// Ekran z prawdziwą powierzchnią SwiftTerm (pismo iPada, czarne tło, biały tekst) na atrapie serwera.
  private func build(_ target: TerminalTarget, wire: ProbeWire) -> Built {
    let session = TerminalSession(target: target, transport: wire)
    let surface = SwiftTermSurface(
      configuration: TerminalSurfaceConfiguration(fontSize: TerminalFontSize.pad, background: .black, foreground: .white))
    let screen = TerminalScreenViewController(session: session, surface: surface) { _ in .closed }
    // iPad z klawiaturą sprzętową (odbiór). Proces testów nie ma sceny — w apce scena jest aktywna.
    screen.hardwareKeyboard = { true }
    screen.sceneIsActive = { true }
    screen.announcer = Announcer(sink: { _ in }, now: Date.init)
    return Built(screen: screen, surface: surface)
  }

  /// Zdarzenia powierzchni i sesji do próbnika bieżącego przebiegu (po `viewDidLoad` ekranu: wywołania są już jego).
  private func hook(_ built: Built) {
    let surface = built.surface
    let screen = built.screen
    let resized = surface.onResize
    surface.onResize = { cols, rows in
      OpeningProbe.current?.event("onResize \(cols)x\(rows), powierzchnia \(surface.bounds.size)")
      if OpeningProbe.current == nil || rows < 2 {
        // Zmiana siatki poza przebiegiem próbnika albo do zera wierszy: kto ją zrobił i jak stał układ ekranu.
        let guide = screen.view.keyboardLayoutGuide.layoutFrame
        print("[pomiar] onResize \(cols)x\(rows) [\(OpeningProbe.current?.name ?? "poza próbnikiem")]: "
          + "powierzchnia \(surface.bounds.size), ekran \(screen.view.frame), okno=\(screen.view.window != nil), "
          + "rodzic \(String(describing: screen.parent.map { type(of: $0) })), prowadnica klawiatury \(guide), "
          + "kontener \(screen.container.frame)")
        for symbol in Thread.callStackSymbols.prefix(28) { print("[pomiar]   stos: \(symbol)") }
      }
      resized?(cols, rows)
    }
    let focused = surface.onFocus
    surface.onFocus = {
      OpeningProbe.current?.event("onFocus (rs z force)")
      focused?()
    }
    let session = built.screen.session
    let bytes = session.onBytes
    session.onBytes = { data in
      OpeningProbe.current?.event("bajty z gniazda: \(data.count) B")
      bytes?(data)
    }
  }

  private func window() -> (UIWindow, UIViewController) {
    let window = UIWindow(frame: CGRect(origin: .zero, size: Self.windowSize))
    let root = UIViewController()
    root.view.backgroundColor = .darkGray
    window.rootViewController = root
    window.makeKeyAndVisible()
    window.layoutIfNeeded()
    Self.warmUp(in: window)
    return (window, root)
  }

  private static var warmed = false

  /// Zimny start (pismo, SwiftTerm, pierwszy rysunek) wstrzymywał główny wątek na ~2 s w pierwszym teście
  /// przebiegu i rozjeżdżał jego czasy: raz na proces powierzchnia rysuje ekran poza pomiarem.
  private static func warmUp(in window: UIWindow) {
    guard !warmed else { return }
    warmed = true
    let surface = SwiftTermSurface(
      configuration: TerminalSurfaceConfiguration(fontSize: TerminalFontSize.pad, background: .black, foreground: .white))
    surface.frame = CGRect(x: 0, y: 0, width: 600, height: 400)
    window.addSubview(surface)
    surface.layoutIfNeeded()
    surface.feed(fullScreen)
    _ = ProbeBitmap(surface.layer, rect: surface.bounds)
    surface.close()
    surface.removeFromSuperview()
  }

  /// Czeka na warunek (sufit `limit` s), potem jeszcze `then` s.
  private func run(until condition: () -> Bool, limit: Double = 5, then: Double) async {
    let start = CACurrentMediaTime()
    while !condition(), CACurrentMediaTime() - start < limit {
      try? await Task.sleep(for: .milliseconds(5))
    }
    try? await Task.sleep(for: .seconds(then))
  }

  /// Próbnik zbiera jeszcze co najmniej 1,5 s od `since`, a dłużej (do 6 s), dopóki dolny wiersz nie stoi
  /// w obrazie okna. Pełny przebieg pakietu potrafi wstrzymać główny wątek na ponad sekundę (inne zestawy
  /// mierzą na nim czasy): stałe okno pomiaru dawało wtedy porażki bez związku z kodem.
  private func settle(_ probe: OpeningProbe, since: CFTimeInterval) async {
    while CACurrentMediaTime() - since < 6,
      CACurrentMediaTime() - since < 1.5 || (probe.samples.last?.shownPrompt ?? 0) == 0
    {
      try? await Task.sleep(for: .milliseconds(10))
    }
  }

  /// Okno pokazane udawanym arkuszem, z próbnikiem od chwili pokazania do 1,5 s po końcu animacji.
  private func show(
    _ name: String, _ presented: UIViewController, root: UIViewController, built: Built,
    sockets: @escaping () -> [ProbeWire.Opened]
  ) async -> (EmulatedSheet, OpeningProbe) {
    let sheet = EmulatedSheet(presented, in: root, size: Self.sheetSize)
    let probe = OpeningProbe(name: name, screen: built.screen, surface: built.surface, root: presented.view)
    probe.offset = { sheet.offset }
    let end = EmulatedSheet.duration * 1000
    let shots = [(end / 2, "polowa"), (end + 20, "koniec"), (end + 250, "koniec+250ms"), (end + 1000, "koniec+1s")]
    for (at, label) in shots { probe.snapshot(at: at, label) }
    probe.start()
    var completed = false
    sheet.present {
      probe.event("animacja: koniec (viewDidAppear)")
      completed = true
    }
    probe.event("animacja: start (po viewIsAppearing)")
    await run(until: { completed }, then: 0)
    await settle(probe, since: CACurrentMediaTime())
    probe.stop()
    probe.report(
      milestones: [
        ("przed animacją", 0), ("połowa animacji", end / 2), ("koniec animacji", end), ("koniec +250 ms", end + 250),
        ("koniec +1 s", end + 1000),
      ], sockets: sockets())
    return (sheet, probe)
  }

  /// Okno Cmd+F: kontener nawigacji z `TerminalPopupController` jako korzeniem (`TerminalPopupController.window`).
  private func popupWindow(_ popup: TerminalPopupController) -> UINavigationController {
    let navigation = TerminalPopupController.window(popup)
    // Widok okna (a z nim ekranu) ładuje się przed pokazaniem — układu jeszcze nie ma (ramki zero).
    navigation.loadViewIfNeeded()
    popup.loadViewIfNeeded()
    return navigation
  }

  @Test("okno Cmd+F, nowy ekran: kontener nawigacji w udawanym arkuszu")
  func newScreenWindow() async throws {
    let (window, root) = window()
    defer { window.isHidden = true }
    let wire = ProbeWire(fullScreen: Self.fullScreen)
    let target = try #require(TerminalTarget.popup(cwd: Self.cwd, role: .popup))
    let built = build(target, wire: wire)
    defer { built.screen.shutdown() }
    let popup = TerminalPopupController(screen: built.screen, request: TerminalPopupRequest(cwd: Self.cwd, role: .popup))
    let navigation = popupWindow(popup)
    hook(built)
    let (_, probe) = await show("okno-nowe", navigation, root: root, built: built, sockets: { wire.sockets })
    #expect(probe.promptShownSince != nil, "dolny wiersz narysowany w oknie")
  }

  /// Treść SwiftUI jak w apce (`TerminalPopupSheet`: reprezentacja kontenera nawigacji, `.ignoresSafeArea()`,
  /// `windowFrame`) w kontrolerze SwiftUI, pokazanym udawanym arkuszem.
  @Test("okno Cmd+F, nowy ekran: treść SwiftUI jak w apce w udawanym arkuszu")
  func newScreenHostedWindow() async throws {
    let (window, root) = window()
    defer { window.isHidden = true }
    let wire = ProbeWire(fullScreen: Self.fullScreen)
    let target = try #require(TerminalTarget.popup(cwd: Self.cwd, role: .popup))
    let built = build(target, wire: wire)
    defer { built.screen.shutdown() }
    let popup = TerminalPopupController(screen: built.screen, request: TerminalPopupRequest(cwd: Self.cwd, role: .popup))
    let navigation = popupWindow(popup)
    hook(built)
    let hosting = UIHostingController(
      rootView: HostedWindow(navigation: navigation).ignoresSafeArea().windowFrame(width: Self.windowSize.width))
    let (_, probe) = await show("okno-swiftui", hosting, root: root, built: built, sockets: { wire.sockets })
    #expect(probe.promptShownSince != nil, "dolny wiersz narysowany w oknie")
  }

  /// Drugie Cmd+F w ciągu 2 min: okno zamknięte, ekran w parkingu z żywym gniazdem, NOWE okno wokół TEGO
  /// SAMEGO ekranu. Żadnych nowych bajtów — emulator ma ekran od pierwszego okna.
  @Test("okno Cmd+F z parkingu: nowe okno wokół tego samego ekranu")
  func parkedScreen() async throws {
    let (window, root) = window()
    defer { window.isHidden = true }
    let wire = ProbeWire(fullScreen: Self.fullScreen)
    let parking = TerminalScreenParking(isLoggedIn: { true }, sceneActive: { true })
    defer { parking.shutdownAll() }
    let request = TerminalPopupRequest(cwd: Self.cwd, role: .popup)
    var made: Built?
    let first = try #require(
      TerminalPopupController.make(request: request, parking: parking) { target in
        let built = build(target, wire: wire)
        made = built
        return built.screen
      })
    let built = try #require(made)
    let firstWindow = popupWindow(first)
    hook(built)
    let (sheet, _) = await show(
      "parking-pierwsze-okno", firstWindow, root: root, built: built, sockets: { wire.sockets })
    func state(_ label: String) {
      let terminal = built.surface.getTerminal()
      let bottom = terminal.getLine(row: terminal.rows - 1)?.translateToString(trimRight: true) ?? ""
      print("[pomiar] parking: \(label): powierzchnia \(built.surface.bounds.size), "
        + "siatka \(terminal.cols)x\(terminal.rows), dolny wiersz „\(bottom)”, ekran \(built.screen.view.frame), "
        + "okno=\(built.screen.view.window != nil)")
    }
    state("przed zamknięciem")
    var dismissed = false
    sheet.dismiss { dismissed = true }
    await run(until: { dismissed }, then: 0)
    state("po zjeździe arkusza")
    first.dismantle()
    state("po dismantle (parking)")
    #expect(built.screen.parent == nil, "ekran wyjęty z okna")
    #expect(parking.count == 1, "ekran w parkingu")
    try await Task.sleep(for: .seconds(1))
    state("po 1 s w parkingu")
    let second = try #require(TerminalPopupController.make(request: request, parking: parking) { _ in nil })
    #expect(second.screen === built.screen, "ten sam ekran z parkingu")
    state("po make (z parkingu)")
    let secondWindow = popupWindow(second)
    state("po załadowaniu widoku nowego okna")
    let (_, probe) = await show(
      "parking-drugie-okno", secondWindow, root: root, built: built, sockets: { wire.sockets })
    #expect(wire.sockets.count == 1, "bez nowego gniazda")
    #expect(probe.samples.first?.emuPrompt == true, "emulator ma ekran od pierwszego okna")
    #expect(probe.promptShownSince != nil, "dolny wiersz narysowany w oknie")
  }

  /// Kontrola: ten sam ekran w układzie taba — kontener `TerminalScreenHolder` w kontenerze nawigacji, siatka
  /// w obszarze bezpiecznym, bez pasa krawędzi i bez animacji.
  @Test("kontrola: tab bez arkusza")
  func tab() async throws {
    let (window, _) = window()
    defer { window.isHidden = true }
    let wire = ProbeWire(fullScreen: Self.fullScreen)
    let target = try #require(TerminalTarget.shell(cwd: Self.cwd))
    var made: Built?
    let holder = try #require(
      TerminalScreenHolder.make(target: target, parking: nil) {
        let built = build(target, wire: wire)
        made = built
        return built.screen
      })
    let built = try #require(made)
    defer { built.screen.shutdown() }
    let navigation = UINavigationController(rootViewController: holder)
    navigation.loadViewIfNeeded()
    holder.loadViewIfNeeded()
    hook(built)
    let probe = OpeningProbe(name: "tab", screen: built.screen, surface: built.surface, root: navigation.view)
    probe.snapshot(at: 250, "po-250ms")
    probe.snapshot(at: 1000, "po-1s")
    probe.start()
    window.rootViewController = navigation
    probe.event("tab: w oknie")
    await settle(probe, since: CACurrentMediaTime())
    probe.stop()
    probe.report(
      milestones: [("wstawienie", 0), ("+250 ms", 250), ("+500 ms", 500), ("+1 s", 1000)], sockets: wire.sockets)
    #expect(probe.promptShownSince != nil, "dolny wiersz narysowany w oknie")
  }

  /// Ekran z żywą treścią ułożony w hierarchii, która NIE stoi w oknie (nowe okno Cmd+F przed wstawieniem): prowadnica
  /// klawiatury ma wtedy ramkę zero i dół stosu staje na górze ekranu, jak przy zamykaniu arkusza w apce.
  /// Siatka nie może tu spaść do jednego wiersza, bo zginęłaby z nią treść; powierzchnia nie zmienia siatki
  /// w ramce mniejszej niż komórka (`SwiftTermSurface.layoutSubviews`).
  @Test("układ ekranu poza oknem (prowadnica klawiatury zero) nie zmienia siatki ani treści")
  func layoutOutsideWindow() async throws {
    let (window, root) = window()
    defer { window.isHidden = true }
    let wire = ProbeWire(fullScreen: Self.fullScreen)
    let target = try #require(TerminalTarget.popup(cwd: Self.cwd, role: .popup))
    let built = build(target, wire: wire)
    defer { built.screen.shutdown() }
    let request = TerminalPopupRequest(cwd: Self.cwd, role: .popup)
    let first = TerminalPopupController(screen: built.screen, request: request)
    let firstWindow = popupWindow(first)
    hook(built)
    root.addChild(firstWindow)
    firstWindow.view.frame = CGRect(origin: .zero, size: Self.sheetSize)
    root.view.addSubview(firstWindow.view)
    firstWindow.didMove(toParent: root)
    await run(until: { built.surface.visibleText.contains("PROMPT>") }, limit: 6, then: 0.3)
    let terminal = built.surface.getTerminal()
    func bottom() -> String { terminal.getLine(row: terminal.rows - 1)?.translateToString(trimRight: true) ?? "" }
    let inWindow = (grid: "\(terminal.cols)x\(terminal.rows)", visible: built.surface.visibleText)
    print("[pomiar] poza oknem: w oknie: siatka \(inWindow.grid), dolny „\(bottom())”")
    #expect(bottom().hasPrefix("PROMPT>"), "w oknie treść stoi")
    var resized: [(cols: Int, rows: Int)] = []
    let previous = built.surface.onResize
    built.surface.onResize = { cols, rows in
      resized.append((cols, rows))
      previous?(cols, rows)
    }
    // Okno schodzi, ekran przechodzi do NOWEGO okna (jak z parkingu), układ przed wstawieniem do okna.
    firstWindow.willMove(toParent: nil)
    firstWindow.view.removeFromSuperview()
    firstWindow.removeFromParent()
    first.dismantle()
    let second = TerminalPopupController(screen: built.screen, request: request)
    let secondWindow = popupWindow(second)
    secondWindow.view.frame = CGRect(origin: .zero, size: Self.sheetSize)
    print("[pomiar] poza oknem: prowadnica klawiatury przed układem \(built.screen.view.keyboardLayoutGuide.layoutFrame)")
    secondWindow.view.layoutIfNeeded()
    let outside = (grid: "\(terminal.cols)x\(terminal.rows)", bottom: bottom(), visible: built.surface.visibleText)
    print("[pomiar] poza oknem: po układzie poza oknem: siatka \(outside.grid), powierzchnia \(built.surface.bounds.size), "
      + "dolny „\(outside.bottom)”, kontener \(built.screen.container.frame)")
    root.addChild(secondWindow)
    root.view.addSubview(secondWindow.view)
    secondWindow.didMove(toParent: root)
    secondWindow.view.layoutIfNeeded()
    print("[pomiar] poza oknem: po wstawieniu do okna: siatka \(terminal.cols)x\(terminal.rows), "
      + "powierzchnia \(built.surface.bounds.size), dolny „\(bottom())”, niepustych wierszy "
      + "\(built.surface.visibleText.split(separator: "\n", omittingEmptySubsequences: true).count)")
    try await Task.sleep(for: .milliseconds(400))
    let resizes = wire.sockets.flatMap(\.socket.sent).compactMap { sent -> String? in
      if case let .resize(grid) = sent.frame { "\(grid.cols)x\(grid.rows)" } else { nil }
    }
    print("[pomiar] poza oknem: ramki rs na gnieździe: \(resizes)")
    // Serwer o takim układzie się nie dowiaduje (rozmiar końcowy = wysłany, ustalacz nie wysyła `rs`), więc treść
    // musi przetrwać w samym emulatorze.
    #expect(outside.grid == inWindow.grid, "układ poza oknem nie zmienia siatki")
    #expect(outside.visible == inWindow.visible, "układ poza oknem nie zmienia treści")
    #expect(bottom().hasPrefix("PROMPT>"), "po wstawieniu do okna dolny wiersz z PROMPT> stoi")
    #expect(built.surface.visibleText == inWindow.visible, "po wstawieniu do okna ta sama treść")
    #expect(!resized.contains { $0.rows < 2 }, "żadnego `onResize` z zerem wierszy: \(resized)")
    #expect(resized.isEmpty, "w tej samej ramce siatka się nie zmienia: \(resized)")
    #expect(resizes.count == 1, "jedyne rs to rozmiar przy otwarciu: \(resizes)")
  }

  /// Co robi z ekranem emulatora rozmiar pośredni: ramka zmienia się w locie i wraca.
  /// - Wysokość 0 (zamykanie arkusza): siatka i treść zostają — powierzchnia nie zmienia siatki w ramce mniejszej
  ///   niż komórka.
  /// - −5 pt (ten sam rachunek wierszy) i sama szerokość: treść cała.
  /// - Połowa wysokości (np. klawiatura ekranowa): stan zastany, nie wada — to zwykła zmiana siatki. Bez historii
  ///   (`scrollback: 0`) wiersze, które wypadną górą, przepadają, a po powrocie dół jest pusty, aż serwer przerysuje
  ///   panel po `rs` (ustalacz wyśle go, bo siatka się zmieniła).
  @Test("charakterystyka: siatka przez rozmiar pośredni i z powrotem")
  func intermediateGrid() async throws {
    let wire = ProbeWire(fullScreen: Self.fullScreen)
    let target = try #require(TerminalTarget.popup(cwd: Self.cwd, role: .popup))
    let built = build(target, wire: wire)
    defer { built.screen.shutdown() }
    let full = CGSize(width: 1080, height: 745)
    let window = UIWindow(frame: CGRect(origin: .zero, size: CGSize(width: 1194, height: 834)))
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    let surface = built.surface
    surface.frame = CGRect(origin: .zero, size: full)
    window.addSubview(surface)
    surface.layoutIfNeeded()
    let terminal = surface.getTerminal()
    @discardableResult
    func state(_ label: String) -> String {
      let rows = terminal.rows
      let lines = (0..<rows).map { terminal.getLine(row: $0)?.translateToString(trimRight: true) ?? "" }
      let bottom = lines.last ?? ""
      let first = lines.first { !$0.isEmpty } ?? "—"
      print("[pomiar] pośredni: \(label): siatka \(terminal.cols)x\(rows), "
        + "niepuste \(lines.filter { !$0.isEmpty }.count), pierwszy niepusty „\(first)”, dolny „\(bottom)”")
      return lines.joined(separator: "\n")
    }
    var restored: [Bool] = []
    let intermediates = [
      CGSize(width: full.width, height: 0), CGSize(width: full.width, height: full.height - 5),
      CGSize(width: full.width, height: full.height / 2), CGSize(width: 802, height: full.height),
    ]
    for intermediate in intermediates {
      surface.reset()
      surface.frame.size = full
      surface.layoutIfNeeded()
      surface.feed(Self.fullScreen)
      let before = state("pełny \(Int(full.width))x\(Int(full.height))")
      surface.frame.size = intermediate
      surface.layoutIfNeeded()
      state("  pośredni \(Int(intermediate.width))x\(Int(intermediate.height))")
      surface.frame.size = full
      surface.layoutIfNeeded()
      restored.append(state("  z powrotem \(Int(full.width))x\(Int(full.height))") == before)
    }
    #expect(restored[0], "wysokość 0: ekran bez zmian")
    #expect(restored[1], "−5 pt: ekran bez zmian")
    #expect(restored[3], "sama szerokość: ekran bez zmian")
    // Połowa wysokości gubi górne wiersze (stan zastany, opis wyżej) — bez oczekiwania.
  }
}

/// Kontener okna jako treść SwiftUI (jak `TerminalPopupRepresentable`).
private struct HostedWindow: UIViewControllerRepresentable {
  let navigation: UINavigationController

  func makeUIViewController(context: Context) -> UINavigationController { navigation }
  func updateUIViewController(_ controller: UINavigationController, context: Context) {}
}
#endif
