import CoreText
import Foundation
@testable import RarogTerminal
@preconcurrency import SwiftTerm
import Testing

// Część wspólna adaptera (iOS i macOS, `swift test`): rdzeń emulatora SwiftTerm na SYNTETYCZNYCH bajtach (nigdy
// zrzut cudzej powłoki), rozpęd przewijania i kaskada pisma z glifami Nerd Font. Widok UIKit testuje
// `SwiftTermSurfaceTests` na symulatorze. Właściciel: terminal.

private final class Sink: TerminalDelegate {
  var sent: [UInt8] = []
  func send(source: Terminal, data: ArraySlice<UInt8>) { sent.append(contentsOf: data) }
}

private func screen(_ terminal: Terminal) -> [String] {
  var lines = (0..<terminal.rows).map { terminal.getLine(row: $0)?.translateToString(trimRight: true) ?? "" }
  while lines.last?.isEmpty == true { lines.removeLast() }
  return lines
}

@Suite("terminal: rdzeń SwiftTerm na syntetycznych bajtach")
struct TerminalCoreTests {
  @Test("pełna ramka herdr (`ESC[2J`, `?2026`) rysuje ekran od zera; `scrollback: 0` nie trzyma historii")
  func fullFrameAndNoScrollback() {
    let sink = Sink()
    let terminal = Terminal(delegate: sink, options: TerminalOptions(cols: 20, rows: 4, scrollback: 0))
    terminal.feed(text: "stary ekran\r\n")
    terminal.feed(text: "\u{1B}[?2026h\u{1B}[2J\u{1B}[H$ ls\r\nplik.txt\r\n$ \u{1B}[?2026l")
    // Spacja wypisana przez powłokę jest treścią komórki (`trimRight` zdejmuje tylko puste komórki).
    #expect(screen(terminal) == ["$ ls", "plik.txt", "$ "])
    for line in 1...30 { terminal.feed(text: "linia \(line)\r\n") }
    // Historia żyje w panelu herdr: bufor emulatora to dokładnie widoczny ekran.
    let buffer = String(decoding: terminal.getBufferAsData(), as: UTF8.self)
    #expect(buffer.split(separator: "\n", omittingEmptySubsequences: false).count - 1 == terminal.rows)
    #expect(screen(terminal).first == "linia 28")
  }

  @Test("reset po nowym gnieździe: tryby i ekran od zera, rozmiar zostaje")
  func reset() {
    let terminal = Terminal(delegate: Sink(), options: TerminalOptions(cols: 30, rows: 5, scrollback: 0))
    terminal.feed(text: "\u{1B}[?2004h\u{1B}[?1049hekran alternatywny")
    #expect(terminal.bracketedPasteMode)
    terminal.resetToInitialState()
    #expect(!terminal.bracketedPasteMode)
    #expect(screen(terminal).isEmpty)
    #expect(terminal.cols == 30 && terminal.rows == 5)
  }
}

@Suite("terminal: przewijanie palcem i rozpęd")
struct ScrollMomentumTests {
  @Test("akumulator: wzmocnienie 2, reszta na następne zdarzenie, znak = kierunek")
  func accumulator() {
    var scroll = ScrollAccumulator()
    #expect(scroll.push(5, cellHeight: 16) == 0)
    #expect(scroll.push(5, cellHeight: 16) == 1, "2 × (5 + 5) = 20 pt ≥ 16")
    #expect(scroll.rest == 4)
    #expect(scroll.push(-40, cellHeight: 16) == -4)
    #expect(scroll.push(.nan, cellHeight: 16) == 0 && scroll.rest == 0)
    #expect(scroll.push(10, cellHeight: 0) == 0)
  }

  @Test("rozpęd: dopiero powyżej 200 pt/s, gaśnie jak UIScrollView, kończy się poniżej 60 pt/s")
  func momentum() throws {
    #expect(ScrollMomentum(velocity: 150) == nil)
    #expect(ScrollMomentum(velocity: -199) == nil)
    var fling = try #require(ScrollMomentum(velocity: -1500))
    var total = 0.0
    var frames = 0
    var running = true
    while running, frames < 10_000 {
      let step = fling.step(seconds: 1.0 / 60)
      total += step.delta
      running = step.running
      frames += 1
    }
    #expect(!running, "rozpęd się kończy")
    #expect(total < -500 && total > -1500, "kierunek zachowany, droga skończona")
    #expect(abs(fling.velocity) < ScrollMomentum.stopSpeed)
  }
}

@Suite("terminal: zapasowe pismo z glifami Nerd Font")
struct TerminalSymbolsFontTests {
  /// Nazwa pisma, którym CoreText narysuje pierwszy znak tekstu.
  private func drawingFont(_ text: String, font: CTFont) throws -> String {
    let attributed = NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
    let line = CTLineCreateWithAttributedString(attributed)
    let runs = try #require(CTLineGetGlyphRuns(line) as? [CTRun])
    let run = try #require(runs.first)
    let attributes = try #require(CTRunGetAttributes(run) as? [String: Any])
    let used = attributes[kCTFontAttributeName as String] as! CTFont
    return CTFontCopyPostScriptName(used) as String
  }

  @Test("pismo leży w zasobach i rejestruje się w procesie (z licencją i atrybucją obok)")
  func bundled() throws {
    let url = try #require(TerminalSymbolsFont.url)
    #expect(TerminalSymbolsFont.isAvailable)
    let folder = url.deletingLastPathComponent()
    #expect(FileManager.default.fileExists(atPath: folder.appending(path: "LICENSE").path))
    #expect(FileManager.default.fileExists(atPath: folder.appending(path: "NOTICE.txt").path))
  }

  @Test("kaskada: separator Powerline i ikona z Symbols Nerd Font Mono, litery z pisma bazowego")
  func cascade() throws {
    let base = CTFontCreateWithName("Menlo-Regular" as CFString, 13, nil)
    let plain = try drawingFont("\u{E0B0}", font: base)
    #expect(plain != TerminalSymbolsFont.postScriptName, "bez kaskady system nie zna glifu Nerd Font")
    let cascading = CTFontCreateWithFontDescriptor(
      TerminalSymbolsFont.cascading(CTFontCopyFontDescriptor(base), size: 13), 13, nil)
    #expect(try drawingFont("\u{E0B0}", font: cascading) == TerminalSymbolsFont.postScriptName)
    #expect(try drawingFont("\u{F07B}", font: cascading) == TerminalSymbolsFont.postScriptName)
    #expect(try drawingFont("A", font: cascading) == "Menlo-Regular")
  }

  @Test("pismo terminala: cztery odmiany Menlo rysują ikony p10k i eza z Symbols Nerd Font Mono, litery z Menlo")
  func terminalFonts() throws {
    let names = TerminalSymbolsFont.baseNames
    for name in [names.regular, names.bold, names.italic, names.boldItalic] {
      let font = TerminalSymbolsFont.font(named: name, size: 11)
      #expect(CTFontCopyPostScriptName(font) as String == name, "Menlo w tej odmianie jest w systemie")
      // Separator Powerline, folder, gałąź gita (p10k), folder i plik Markdown (eza).
      for icon in ["\u{E0B0}", "\u{F07B}", "\u{F126}", "\u{E5FF}", "\u{F48A}"] {
        #expect(try drawingFont(icon, font: font) == TerminalSymbolsFont.postScriptName, "\(name) \(icon)")
      }
      #expect(try drawingFont("A", font: font) == name)
    }
  }
}

@Suite("terminal: przypięcie SwiftTerm")
struct TerminalPinTests {
  static let package = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent()

  @Test("manifest przypina SwiftTerm `exact: 1.19.0`, a Package.resolved ma tę wersję i rewizję tagu")
  func pinned() throws {
    let manifest = try String(contentsOf: Self.package.appending(path: "Package.swift"), encoding: .utf8)
    #expect(manifest.contains(#".package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.19.0")"#))
    let resolved = try String(contentsOf: Self.package.appending(path: "Package.resolved"), encoding: .utf8)
    #expect(resolved.contains(#""revision" : "464df5207fc2432e16c9a23abe538187196daf5f""#))
    #expect(resolved.contains(#""version" : "1.19.0""#))
  }
}
