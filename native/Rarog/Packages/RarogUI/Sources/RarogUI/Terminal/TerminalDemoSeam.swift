#if DEBUG
import Foundation
import RarogContract

// Okno terminala i historia w demo — WYŁĄCZNIE build Debug i zmienna `RAROG_UI_TEST_FAKE_TERMINAL=1` (testy UI,
// `WindowsUITests`). Demo nie ma terminala (`termEnabled: false`), więc bez szwu żaden
// XCUITest nie otworzy okna Cmd+F/Cmd+G ani historii, a ich anatomię dałoby się sprawdzić tylko na iPadzie.
// Ze szwem okno się otwiera, ekran NIE łączy się z serwerem i pokazuje zmyślony ekran — okno powłoki (Cmd+F)
// gołą powłokę, okno lazygita (Cmd+G) program pełnoekranowy na ekranie alternatywnym (pas w kolorze
// krawędzi) — a historia zmyślony tekst. Treść jest syntetyczna i stała (nic tu nie pochodzi
// z prawdziwego terminala).
// Właściciel: terminal.

enum TerminalDemoSeam {
  static let environmentKey = "RAROG_UI_TEST_FAKE_TERMINAL"

  static let isOn = ProcessInfo.processInfo.environment[environmentKey] == "1"

  /// Id terminala, którego serwer nie zna: historia w szwie go nie odpytuje.
  static let terminalId = "demo-okno"

  /// Znacznik ostatniego wiersza ekranu: test rogów sprawdza na zrzucie, że stoi w całości przy rogu okna.
  static let bottomRowMarker = "dolny wiersz ekranu"

  /// Zmyślony ekran powłoki: prompt, kolory ANSI, komórki z własnym tłem i ostatni wiersz przy dolnej krawędzi.
  static let screen: Data = {
    let esc = "\u{1B}["
    let prompt =
      "\(esc)1;34m~/Projects/demo/\(esc)1;35mrarog\(esc)0m \(esc)32mmain\(esc)0m \(esc)33m+23 !11\(esc)0m\r\n\(esc)32m>\(esc)0m "
    var lines = ["\(esc)2J\(esc)H\(prompt)git status --short"]
    for (mark, path) in [
      ("M", "docs/architecture.md"), ("M", "native/Rarog/README.md"),
      ("A", "native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Presentation/SheetScaffold.swift"),
      ("D", "docs/old-notes.md"),
    ] {
      let color = mark == "A" ? 32 : mark == "D" ? 31 : 33
      lines.append(" \(esc)\(color)m\(mark)\(esc)0m \(path)")
    }
    lines.append("\(prompt)ls -la scripts")
    for (index, name) in ["check.sh", "ios-check.sh", "restart.sh", "serve.sh"].enumerated() {
      let size = 1200 + index * 731
      lines.append(
        "\(esc)90m-rwxr-xr-x  1 demo  staff\(esc)0m \(esc)34m\(size)\(esc)0m \(esc)90m11 paz 20:4\(index)\(esc)0m \(esc)1;32m\(name)\(esc)0m")
    }
    lines.append("\(esc)7m odwrocone \(esc)0m \(esc)41m czerwone tlo \(esc)0m \(esc)48;5;236m szare tlo \(esc)0m")
    lines.append(prompt)
    // Wiersz 999 = ostatni wiersz siatki, niezależnie od jej wysokości; pierwsza komórka pełnym blokiem.
    lines.append("\(esc)s\(esc)999;1H\(esc)7m \(esc)0m \(bottomRowMarker)\(esc)u")
    return Data(lines.joined(separator: "\r\n").utf8)
  }()

  /// Zmyślony ekran okna danej roli: lazygit to program pełnoekranowy, reszta — goła powłoka.
  static func screen(for role: TerminalRole) -> Data {
    role == .lazygit ? program : screen
  }

  /// Zmyślony program pełnoekranowy w kolorach motywu tokyonight (jak nvim albo lazygit): ekran alternatywny
  /// z tłem truecolor na całym ekranie, boczny panel w innym kolorze, wiersz kursora z palety 256 i dolny pasek
  /// statusu z segmentami w różnych kolorach — zrzut okna pokazuje pas w kolorze krawędzi, a nie gołą powłokę.
  static let program: Data = {
    let esc = "\u{1B}["
    let background = "\(esc)48;2;26;27;38m"  // #1a1b26
    let text = "\(esc)38;2;192;202;245m"  // #c0caf5
    let dim = "\(esc)38;2;59;66;97m"  // #3b4261
    // Kasowanie bierze tło bieżącego atrybutu: cały ekran w kolorze motywu.
    var out = "\(esc)?1049h\(background)\(text)\(esc)2J"
    // Panel plików z lewej (ciemniejszy) na każdym wierszu; dolny wiersz nadpisze pasek statusu.
    for row in 1...80 {
      out += "\(esc)\(row);1H\(esc)48;2;22;22;30m\(String(repeating: " ", count: 22))"
    }
    for (row, name) in ["  rarog", "  docs", "  native", "    TerminalEdges", "  scripts"].enumerated() {
      out += "\(esc)\(row + 1);1H\(esc)48;2;22;22;30m\(text)\(name)"
    }
    let code = [
      "import CoreGraphics", "", "public struct TerminalEdges: Equatable {",
      "  public var background: TerminalEdgeColor", "  public var leading: [TerminalEdgeColor]",
      "  public var bottom: [TerminalEdgeColor]?", "}",
    ]
    for (index, line) in code.enumerated() {
      out += "\(esc)\(index + 1);23H\(background)\(dim)\(String(format: "%4d ", index + 1))\(text)\(line)"
    }
    // Wiersz kursora z palety 256: kasowanie do końca wiersza bierze jego tło.
    out += "\(esc)9;23H\(esc)48;5;236m\(esc)K\(dim)   9 \(text)  let edges = surface.edgeColors\(background)"
    // Pasek statusu w ostatnim wierszu: tryb, gałąź i plik, a z prawej pozycja kursora.
    out += "\(esc)999;1H\(esc)48;2;122;162;247m\(esc)38;2;26;27;38m NORMAL "
    out += "\(esc)48;2;59;66;97m\(text)  main  TerminalEdges.swift \(esc)K"
    out += "\(esc)999;999H\(esc)12D\(esc)48;2;158;206;106m\(esc)38;2;26;27;38m  9:23   42% "
    // Kursor wraca do wiersza kursora, jak w edytorze.
    out += "\(esc)0m\(esc)9;34H"
    return Data(out.utf8)
  }()

  /// Zmyślona historia: tyle wierszy, żeby tekst się przewijał, z długim wierszem do zawijania.
  static let history: String = {
    var lines = (1...60).map { "wiersz \($0): przykladowy wynik polecenia w historii terminala" }
    lines.append(String(repeating: "dlugi-wiersz-bez-spacji-", count: 12))
    lines.append("> koniec historii")
    return lines.joined(separator: "\n")
  }()
}
#endif
