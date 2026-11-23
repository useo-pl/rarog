#if os(iOS)
import CoreText
import RarogContract
import RarogCore
@testable import RarogTerminal
import RarogUI
@preconcurrency import SwiftTerm
import Testing
import UIKit

// Powierzchnia SwiftTerm na symulatorze (UIKit): konfiguracja, wklejka z każdej drogi wyłącznie do
// `onPaste` (zero ramek `in`), bajty SYNTETYCZNE, rozmiar z układu. Uruchamia je `xcodebuild test`
// schematu pakietu `RarogTerminal` na symulatorze iOS (README: „Tests"). Właściciel: terminal.

@MainActor
func makeSurface() -> SwiftTermSurface {
  SwiftTermSurface(
    configuration: TerminalSurfaceConfiguration(fontSize: 13, background: .black, foreground: .white))
}

@MainActor
func host(_ view: UIView, size: CGSize = CGSize(width: 600, height: 400)) -> UIWindow {
  let window = UIWindow(frame: CGRect(origin: .zero, size: size))
  view.frame = window.bounds
  window.addSubview(view)
  window.isHidden = false
  view.layoutIfNeeded()
  return window
}

@MainActor
@Suite("terminal: powierzchnia SwiftTerm (iOS)")
struct SwiftTermSurfaceTests {
  @Test("konfiguracja: bez scrollbacku, bez myszy, Option ≠ Meta, bez akcesorium SwiftTerm, cichy rdzeń")
  func configuration() {
    let surface = makeSurface()
    let terminal = surface.getTerminal()
    #expect(terminal.options.scrollback == 0)
    #expect(terminal.silentLog, "w buildzie Debug SwiftTerm wypisywałby nieznane sekwencje z treścią")
    #expect(!surface.optionAsMetaKey)
    #expect(!surface.allowMouseReporting)
    #expect(!surface.isScrollEnabled)
    #expect(!surface.allowsKeyboardScrolling)
    #expect(surface.inputAccessoryView == nil)
    #expect(surface.pasteConfiguration?.acceptableTypeIdentifiers.isEmpty == false)
    #expect(surface.gestureRecognizers?.contains { $0 === surface.scrollPan } == true)
    surface.reset()
    #expect(surface.getTerminal().silentLog, "reset nie włącza z powrotem gadatliwego rdzenia")
  }

  @Test("pismo: monospace z kaskadą Symbols Nerd Font Mono we wszystkich czterech odmianach")
  func fonts() throws {
    let fonts = SwiftTermSurface.fonts(size: 13)
    for font in [fonts.normal, fonts.bold, fonts.italic, fonts.boldItalic] {
      #expect(font.pointSize == 13)
      let cascade = try #require(CTFontCopyAttribute(font as CTFont, kCTFontCascadeListAttribute) as? [CTFontDescriptor])
      let names = cascade.compactMap { CTFontDescriptorCopyAttribute($0, kCTFontNameAttribute) as? String }
      #expect(names.contains(TerminalSymbolsFont.postScriptName))
      // Kaskada musi DZIAŁAĆ, nie tylko stać w atrybutach: pismo systemowe ją miało i rysowało „?" (build 1284).
      let line = CTLineCreateWithAttributedString(
        NSAttributedString(string: "\u{F126}", attributes: [.font: font]))
      let run = try #require((CTLineGetGlyphRuns(line) as? [CTRun])?.first)
      let used = try #require((CTRunGetAttributes(run) as? [String: Any])?[kCTFontAttributeName as String])
      #expect(CTFontCopyPostScriptName(used as! CTFont) as String == TerminalSymbolsFont.postScriptName)
    }
  }

  @Test("bajty syntetyczne → widoczny ekran; reset czyści ekran i tryby")
  func feedAndReset() {
    let surface = makeSurface()
    let window = host(surface)
    defer { window.isHidden = true }
    surface.feed(Data("\u{1B}[2J\u{1B}[Hhello\r\nworld\u{1B}[?2004h".utf8))
    #expect(surface.visibleText == "hello\nworld")
    #expect(surface.getTerminal().bracketedPasteMode)
    #expect(surface.selectedText == nil)
    surface.reset()
    #expect(surface.visibleText.isEmpty)
    #expect(!surface.getTerminal().bracketedPasteMode)
  }

  /// Odpowiedź SwiftTerm na komendę grafiki idzie do programu przez `onInput`: jej brak przy `t=f` znaczy, że komenda
  /// nie doszła do emulatora (rdzeń i próby kontrolne: `KittyFileTransmissionFilterTests`).
  @Test("grafika Kitty przez `feed`: t=f odcięta (zero bajtów do `onInput`, tekst dalej), t=d odpowiada OK")
  func kittyFileTransmissionCut() throws {
    let surface = makeSurface()
    let window = host(surface)
    defer { window.isHidden = true }
    var input: [String] = []
    surface.onInput = { input.append($0) }
    surface.feed(Data(kittyCommand("a=T,f=100,t=f,i=2", base64("/brak/obraz.png")) + Array("dalej".utf8)))
    #expect(input.isEmpty)
    #expect(surface.visibleText == "dalej")
    surface.feed(Data(kittyCommand("a=T,f=100,t=d,i=3", try kittyTestImage().base64EncodedString())))
    #expect(input.joined().contains("Gi=3;OK"))
  }

  @Test("układ w oknie: siatka z rozmiaru i wywołanie `onResize`; komórka pod palcem od 1")
  func resize() {
    let surface = makeSurface()
    var sizes: [[Int]] = []
    surface.onResize = { cols, rows in sizes.append([cols, rows]) }
    let window = host(surface, size: CGSize(width: 600, height: 400))
    defer { window.isHidden = true }
    let grid = surface.gridSize
    #expect(grid.cols > 40 && grid.rows > 10)
    #expect(sizes.last == [grid.cols, grid.rows])
    #expect(surface.cell(at: .zero) == TerminalCell(col: 1, row: 1))
    #expect(surface.cell(at: CGPoint(x: 10_000, y: 10_000)) == TerminalCell(col: grid.cols, row: grid.rows))
  }

  /// Ramka mniejsza niż komórka (zamykanie okna Cmd+F: prowadnica klawiatury o wysokości 0) nie
  /// zmienia siatki: bez historii (`scrollback: 0`) zejście do jednego wiersza kasowało ekran, a ekran z parkingu
  /// wracał pusty. Po powrocie do poprzedniej ramki ekran jest ten sam i rysuje się od nowa.
  @Test("ramka o wysokości albo szerokości zero: siatka i treść zostają, bez `onResize`; powrót niczego nie zmienia")
  func degenerateFrameKeepsScreen() async throws {
    let surface = makeSurface()
    let window = host(surface, size: CGSize(width: 600, height: 400))
    defer { window.isHidden = true }
    let lines = (1...40).map { "linia \($0)" }.joined(separator: "\r\n")
    surface.feed(Data(("\u{1B}[2J\u{1B}[H" + lines + "\r\nPROMPT> ").utf8))
    let full = surface.frame
    let grid = surface.gridSize
    let screen = surface.visibleText
    #expect(screen.split(separator: "\n").last?.hasPrefix("PROMPT>") == true, "dolny wiersz: \(screen)")
    #expect(screen.split(separator: "\n").count == grid.rows, "pełny ekran: \(grid)")
    var sizes: [[Int]] = []
    surface.onResize = { cols, rows in sizes.append([cols, rows]) }
    /// Rysowanie przychodzi z pętlą układu (do 2 s, jak w `SwiftTermSurfaceParkingTests`).
    func drawn() async throws -> Bool {
      for _ in 0..<100 where surface.layer.needsDisplay() { try await Task.sleep(for: .milliseconds(20)) }
      return !surface.layer.needsDisplay()
    }
    let degenerates = [
      CGSize(width: full.width, height: 0), CGSize(width: 0, height: full.height), CGSize(width: 3, height: 5),
    ]
    for degenerate in degenerates {
      #expect(try await drawn(), "\(degenerate): przed przerwą ekran narysowany")
      surface.frame.size = degenerate
      surface.layoutIfNeeded()
      #expect(surface.gridSize == grid, "\(degenerate): siatka bez zmian")
      #expect(surface.visibleText == screen, "\(degenerate): treść bez zmian")
      surface.frame = full
      surface.layoutIfNeeded()
      #expect(surface.gridSize == grid, "\(degenerate): po powrocie ta sama siatka")
      #expect(surface.visibleText == screen, "\(degenerate): po powrocie ta sama treść")
      #expect(surface.layer.needsDisplay(), "\(degenerate): po powrocie warstwa rysuje się od nowa")
    }
    // Bajty w czasie ramki zero (program pisze dalej): po powrocie są w emulatorze i na pikselach dolnego wiersza.
    #expect(try await drawn(), "przed bajtami w ramce zero ekran narysowany")
    surface.frame.size = CGSize(width: full.width, height: 0)
    surface.layoutIfNeeded()
    surface.feed(Data("\r\nNOWE".utf8))
    try await Task.sleep(for: .milliseconds(100))
    surface.frame = full
    surface.layoutIfNeeded()
    #expect(surface.gridSize == grid, "bajty w ramce zero: siatka bez zmian")
    #expect(surface.visibleText.split(separator: "\n").last == "NOWE", "nowy dolny wiersz w emulatorze")
    #expect(try await drawn(), "po powrocie narysowane")
    let cell = surface.cellSize
    let bottom = CGRect(x: 0, y: CGFloat(grid.rows - 1) * cell.height, width: 4 * cell.width, height: cell.height)
    #expect(ProbeBitmap(surface.layer, rect: surface.bounds).ink(in: bottom) > 0, "„NOWE” na pikselach dolnego wiersza")
    #expect(sizes.isEmpty, "żadnego `onResize` w całej serii: \(sizes)")
    // Zwykła zmiana rozmiaru (choćby jeden wiersz mniej) dalej przelicza siatkę.
    surface.frame.size = CGSize(width: full.width, height: full.height / 2)
    surface.layoutIfNeeded()
    #expect(sizes.last.map { $0[1] < grid.rows } == true, "mniejsza ramka: mniej wierszy, `onResize` \(sizes)")
  }

  /// Powierzchnia z ponumerowanymi wierszami do samego dołu (kursor w ostatnim) w ramce na ``rows`` wierszy.
  private func numberedSurface(rows: Int) -> (surface: SwiftTermSurface, window: UIWindow, full: CGRect, half: CGRect) {
    let surface = makeSurface()
    let cell = surface.cellSize
    let width: CGFloat = 600
    let window = host(surface, size: CGSize(width: width, height: cell.height * CGFloat(rows) + 1))
    let lines = (1...rows).map { "wiersz \($0)" }.joined(separator: "\r\n")
    surface.feed(Data(("\u{1B}[2J\u{1B}[H" + lines).utf8))
    let full = surface.frame
    let half = CGRect(x: 0, y: 0, width: width, height: cell.height * CGFloat(rows / 2) + 1)
    return (surface, window, full, half)
  }

  private func firstRow(_ surface: SwiftTermSurface) -> String {
    surface.visibleText.components(separatedBy: "\n").first ?? ""
  }

  /// Powrót z tła (nagranie iPada, build 3549): ekran wracał z dawną dolną połową u góry i pustą resztą, aż do
  /// pierwszego ekranu z serwera. Bez historii (`scrollback: 0`) SwiftTerm przy zmniejszeniu z kursorem w ostatnim
  /// wierszu wyrzuca wiersze z góry, a przy powiększeniu dopisuje puste na dole; test bierze najprostszy taki
  /// układ, połowę wysokości. Nieaktywna scena: układ nie dochodzi do SwiftTerm.
  @Test("scena nieaktywna: chwilowa połowa wysokości nie dochodzi do SwiftTerm — siatka i wiersz 1 zostają, bez `onResize`")
  func inactiveSceneKeepsScreen() throws {
    let (surface, window, full, half) = numberedSurface(rows: 51)
    defer { window.isHidden = true }
    let grid = surface.gridSize
    #expect(grid.rows == 51, "pełny ekran: \(grid)")
    #expect(surface.getTerminal().getCursorLocation().y == 50, "kursor w ostatnim wierszu")
    var sizes: [[Int]] = []
    var skipped: [CGFloat] = []
    surface.onResize = { cols, rows in sizes.append([cols, rows]) }
    surface.onLayoutSkipped = { skipped.append($0) }
    surface.sceneIsActive = { false }
    surface.frame = half
    surface.layoutIfNeeded()
    #expect(surface.gridSize == grid, "w połowie: siatka bez zmian")
    surface.frame = full
    surface.layoutIfNeeded()
    #expect(surface.gridSize == grid, "po powrocie: siatka bez zmian")
    #expect(firstRow(surface) == "wiersz 1", "wiersz 1: \(firstRow(surface))")
    #expect(sizes.isEmpty, "żadnego `onResize`: \(sizes)")
    #expect(skipped == [half.height, full.height], "pominięte układy z wysokością widoku: \(skipped)")
  }

  /// Zachowanie SwiftTerm, przed którym chroni pominięcie układu nieaktywnej sceny.
  @Test("scena aktywna (albo bez sceny): połowa wysokości i powrót — wiersz 1 to dawny wiersz z połowy ekranu")
  func activeSceneShrinkDropsTopRows() {
    let (surface, window, full, half) = numberedSurface(rows: 51)
    defer { window.isHidden = true }
    surface.frame = half
    surface.layoutIfNeeded()
    let halfRows = surface.gridSize.rows
    #expect(halfRows < 51, "mniejsza siatka: \(surface.gridSize)")
    surface.frame = full
    surface.layoutIfNeeded()
    #expect(surface.gridSize.rows == 51)
    #expect(firstRow(surface) == "wiersz \(51 - halfRows + 1)", "wiersz 1: \(firstRow(surface))")
  }

  @Test("scena nieaktywna, ramka zmienia się i zostaje: po aktywacji układ dochodzi, jedno `onResize` z nową siatką")
  func activationLaysOutPendingFrame() {
    let (surface, window, _, half) = numberedSurface(rows: 51)
    defer { window.isHidden = true }
    let grid = surface.gridSize
    var sizes: [[Int]] = []
    surface.onResize = { cols, rows in sizes.append([cols, rows]) }
    var active = false
    surface.sceneIsActive = { active }
    surface.frame = half
    surface.layoutIfNeeded()
    #expect(surface.gridSize == grid, "przed aktywacją siatka bez zmian")
    #expect(sizes.isEmpty)
    active = true
    NotificationCenter.default.post(name: UIScene.didActivateNotification, object: nil)
    surface.layoutIfNeeded()
    let next = surface.gridSize
    #expect(next.rows < grid.rows, "nowa siatka: \(next)")
    #expect(sizes == [[next.cols, next.rows]], "jedno `onResize`: \(sizes)")
    surface.layoutIfNeeded()
    #expect(sizes.count == 1, "kolejny układ w tej samej ramce nic nie zgłasza: \(sizes)")
  }

  @Test("nowa powierzchnia na nieaktywnej scenie: pierwszy układ dochodzi — jedno `onResize` z siatką z ramki")
  func firstLayoutOnInactiveScene() {
    let surface = makeSurface()
    var sizes: [[Int]] = []
    var skipped: [CGFloat] = []
    surface.onResize = { cols, rows in sizes.append([cols, rows]) }
    surface.onLayoutSkipped = { skipped.append($0) }
    surface.sceneIsActive = { false }
    let window = host(surface)
    defer { window.isHidden = true }
    let grid = surface.gridSize
    #expect(grid.rows > 10, "siatka z ramki: \(grid)")
    #expect(sizes == [[grid.cols, grid.rows]], "jedno `onResize`: \(sizes)")
    #expect(skipped.isEmpty, "pierwszy układ nie jest pominięty: \(skipped)")
    surface.frame.size.height /= 2
    surface.layoutIfNeeded()
    #expect(surface.gridSize == grid, "następny układ na nieaktywnej scenie już nie dochodzi")
    #expect(skipped.count == 1)
  }

  /// Nowa powierzchnia, której pierwszy układ ma ramkę bez wysokości: siatka zostaje domyślna (jak przed jakimkolwiek
  /// układem) i `onResize` nie wychodzi — wcześniej szło `onResize` z zerem wierszy. Pierwszy zwykły układ daje jedno
  /// `onResize` z prawdziwą siatką (ono, nie ramka zero, trafia potem do `rs`).
  @Test("nowa powierzchnia: pierwszy układ bez wysokości nie zmienia siatki; pierwszy zwykły — jedno `onResize`")
  func degenerateFirstLayout() {
    let surface = makeSurface()
    var sizes: [[Int]] = []
    surface.onResize = { cols, rows in sizes.append([cols, rows]) }
    let initial = surface.gridSize
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 600, height: 400))
    window.isHidden = false
    defer { window.isHidden = true }
    surface.frame = CGRect(x: 0, y: 0, width: 600, height: 0)
    window.addSubview(surface)
    surface.layoutIfNeeded()
    #expect(surface.gridSize == initial, "siatka domyślna: \(surface.gridSize)")
    #expect(sizes.isEmpty, "bez `onResize`: \(sizes)")
    surface.frame.size = CGSize(width: 600, height: 400)
    surface.layoutIfNeeded()
    let grid = surface.gridSize
    #expect(grid.rows > 10, "prawdziwa siatka: \(grid)")
    #expect(sizes == [[grid.cols, grid.rows]], "jedno `onResize` z prawdziwą siatką: \(sizes)")
  }

  @Test("wklejka z menu edycji i Cmd+V (`paste(_:)`): surowy tekst do `onPaste`, nic do `onInput` — także przy 2004")
  func pasteMenu() {
    let surface = makeSurface()
    var pasted: [String] = []
    var typed: [String] = []
    surface.onPaste = { pasted.append($0) }
    surface.onInput = { typed.append($0) }
    let clip = "echo raz\r\necho dwa\n\u{1B}[201~echo trzy"
    surface.pasteboardText = { clip }
    // Program włączył bracketed paste: własny `paste(_:)` SwiftTerm owinąłby tekst i wysłał go `send`.
    surface.feed(Data("\u{1B}[?2004h".utf8))
    surface.paste(nil)
    #expect(pasted == [clip], "surowy tekst schowka — czyści i owija serwer")
    #expect(typed.isEmpty, "ani bajt wklejki przez ramki `in`")
    surface.pasteboardText = { "" }
    surface.paste(nil)
    #expect(pasted.count == 1, "pusty schowek nic nie wkleja")
  }

  @Test("wklejka z `UIPasteControl` i upuszczenia (`paste(itemProviders:)`): surowy tekst, zero `onInput`")
  func pasteItemProviders() async {
    let surface = makeSurface()
    var pasted: [String] = []
    var typed: [String] = []
    surface.onPaste = { pasted.append($0) }
    surface.onInput = { typed.append($0) }
    let provider = NSItemProvider(object: "a\nb" as NSString)
    #expect(surface.canPaste([provider]))
    surface.paste(itemProviders: [provider])
    await waitUntil { !pasted.isEmpty }
    #expect(pasted == ["a\nb"])
    #expect(typed.isEmpty)
  }

  @Test("pisanie (`insertText`) idzie `onInput`, nie jako wklejka")
  func typing() {
    let surface = makeSurface()
    let window = host(surface)
    defer { window.isHidden = true }
    var typed: [String] = []
    var pasted: [String] = []
    surface.onInput = { typed.append($0) }
    surface.onPaste = { pasted.append($0) }
    surface.insertText("ls")
    #expect(typed.joined() == "ls")
    #expect(pasted.isEmpty)
  }

  @Test("`close()` zwalnia powierzchnię: `CADisplayLink` SwiftTerm nie trzyma widoku z emulatorem")
  func closeReleasesSurface() async {
    weak var released: SwiftTermSurface?
    do {
      let surface = makeSurface()
      released = surface
      let window = host(surface)
      surface.feed(Data("$ echo raz\r\nraz\r\n".utf8))
      surface.onInput = { _ in }
      surface.close()
      surface.close()  // drugi raz nic nie psuje
      #expect(surface.onInput == nil, "wywołania zwrotne odpięte")
      surface.removeFromSuperview()
      window.isHidden = true
    }
    await waitUntil { released == nil }
    #expect(released == nil, "powierzchnia została w pamięci po zamknięciu")
  }

  @Test("ekran z prawdziwą powierzchnią: wklejka z każdej drogi = ramki `pa`, zero ramek `in`")
  func screenPasteFrames() async throws {
    let wire = FakeTerminalWire()
    let target = try #require(TerminalTarget.shell(cwd: "/Users/demo/Projects/rarog"))
    let session = TerminalSession(target: target, transport: wire)
    let surface = makeSurface()
    let clip = "raz\ndwa\ntrzy"
    surface.pasteboardText = { clip }
    let screen = TerminalScreenViewController(session: session, surface: surface) { _ in .closed }
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
    window.rootViewController = screen
    window.makeKeyAndVisible()
    defer {
      screen.shutdown()
      window.isHidden = true
    }
    session.start()
    await waitUntil { !wire.sockets.isEmpty }
    let socket = try #require(wire.sockets.first)
    socket.emit(.opened)
    await waitUntil { session.phase == .live }
    // Otwarcie wysyła `rs` z rozmiarem z upgrade'u, a zapis ramki do atrapy jest asynchroniczny: pod obciążeniem
    // (pełny przebieg pakietu) wpadał już PO odczycie `before` i udawał ramkę wklejki.
    await waitUntil { socket.sent.contains { if case .resize = $0 { true } else { false } } }
    socket.emit(.bytes(Data("\u{1B}[?2004h$ ".utf8)))
    let before = socket.sent.count

    surface.paste(nil)  // menu edycji, Cmd+V
    surface.paste(itemProviders: [NSItemProvider(object: clip as NSString)])  // UIPasteControl, upuszczenie
    await waitUntil { socket.sent.count >= before + 2 }

    let frames = Array(socket.sent.dropFirst(before))
    #expect(frames == [.paste(clip, end: true), .paste(clip, end: true)], "wszystkie ramki: \(socket.sent)")
    #expect(socket.sent.filter { if case .resize = $0 { true } else { false } }.count == 1, "jedno `rs`: \(socket.sent)")
    #expect(!socket.sent.contains { if case .input = $0 { true } else { false } })
  }
}
#endif
