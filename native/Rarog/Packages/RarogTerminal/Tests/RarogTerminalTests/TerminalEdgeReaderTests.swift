import Foundation
@testable import RarogTerminal
import RarogUI
@preconcurrency import SwiftTerm
import Testing

// Odczyt krawędzi siatki dla pasa wokół niej na rdzeniu SwiftTerm i SYNTETYCZNYCH bajtach:
// tło domyślne, ANSI, truecolor, 256 kolorów z `.base16Lab` i szarości, `inverse`, `.defaultInvertedColor`,
// OSC 11, reguła rozszerzania boków i dołu na obu ekranach, pasek lualine ze znakami powerline (powerline nie
// blokuje, a dół pod nim ma jeden kolor). Paleta porównana co do bitu z odpowiedzią
// SwiftTerm na zapytanie OSC 4 (jedyny publiczny odczyt jego palety). Zgodność z narysowanymi pikselami sprawdza
// `TerminalEdgeSurfaceTests` na symulatorze. Właściciel: terminal.

private final class Replies: TerminalDelegate {
  var bytes: [UInt8] = []
  func send(source: Terminal, data: ArraySlice<UInt8>) { bytes.append(contentsOf: data) }
}

@Suite("terminal: odczyt krawędzi siatki")
struct TerminalEdgeReaderTests {
  static let navy = SwiftTerm.Color(red8: 0x1a, green8: 0x1b, blue8: 0x26)
  static let ink = SwiftTerm.Color(red8: 0xc0, green8: 0xca, blue8: 0xf5)

  private func terminal(cols: Int = 10, rows: Int = 4) -> (Terminal, Replies) {
    let replies = Replies()
    let terminal = Terminal(delegate: replies, options: TerminalOptions(cols: cols, rows: rows, scrollback: 0))
    terminal.silentLog = true
    terminal.backgroundColor = Self.navy
    terminal.foregroundColor = Self.ink
    return (terminal, replies)
  }

  /// Paleta, którą rysuje SwiftTerm: odpowiedzi na `OSC 4;n;?` dla wszystkich 256 indeksów.
  private func swiftTermPalette(_ terminal: Terminal, _ replies: Replies) throws -> [TerminalEdgeColor] {
    replies.bytes = []
    let query = (0..<256).map { "\($0);?" }.joined(separator: ";")
    terminal.feed(text: "\u{1B}]4;\(query)\u{1B}\\")
    let text = String(decoding: replies.bytes, as: UTF8.self)
    var colors = [TerminalEdgeColor?](repeating: nil, count: 256)
    for reply in text.components(separatedBy: "\u{1B}]4;").dropFirst() {
      // „n;rgb:rrrr/gggg/bbbb" + ST
      let parts = reply.prefix { $0 != "\u{1B}" }.split(separator: ";")
      let index = try #require(Int(parts[0]))
      let channels = parts[1].dropFirst(4).split(separator: "/").compactMap { UInt16($0, radix: 16) }
      try #require(channels.count == 3)
      colors[index] = TerminalEdgeColor(red: channels[0], green: channels[1], blue: channels[2])
    }
    return try colors.map { try #require($0, "brak odpowiedzi dla indeksu") }
  }

  private func edges(_ terminal: Terminal) -> TerminalEdges {
    let palette = TerminalPalette(
      background: terminal.backgroundColor, foreground: terminal.foregroundColor,
      strategy: terminal.ansi256PaletteStrategy)
    return TerminalEdgeReader.edges(
      of: terminal, palette: palette, background: TerminalEdgeColor(terminal.backgroundColor),
      foreground: TerminalEdgeColor(terminal.foregroundColor))
  }

  @Test("paleta 256 kolorów co do bitu jak w SwiftTerm: `.base16Lab` (ciemny i jasny motyw), harmonijna, xterm")
  func paletteMatchesSwiftTerm() throws {
    let (terminal, replies) = terminal()
    #expect(terminal.ansi256PaletteStrategy == .base16Lab, "domyślna strategia SwiftTerm 1.19.0")
    let light = (
      SwiftTerm.Color(red8: 0xf7, green8: 0xf7, blue8: 0xf2), SwiftTerm.Color(red8: 0x20, green8: 0x20, blue8: 0x20)
    )
    for strategy in [Ansi256PaletteStrategy.base16Lab, .base16LabHarmonious, .xterm] {
      terminal.ansi256PaletteStrategy = strategy
      for (background, foreground) in [(Self.navy, Self.ink), light] {
        terminal.backgroundColor = background
        terminal.foregroundColor = foreground
        let ours = TerminalPalette(background: background, foreground: foreground, strategy: strategy).colors
        let theirs = try swiftTermPalette(terminal, replies)
        #expect(ours.count == 256)
        let differing = (0..<256).filter { ours[$0] != theirs[$0] }
        #expect(differing.isEmpty, "\(strategy) tło \(TerminalEdgeColor(background)): różne indeksy \(differing)")
      }
    }
  }

  @Test("tło komórki (ekran alternatywny): domyślne, ANSI, truecolor, 256 i szarości z palety, `inverse`")
  func cellBackgrounds() {
    let (terminal, _) = terminal()
    let esc = "\u{1B}["
    terminal.feed(text: "\(esc)?1049h\(esc)1;1H\(esc)48;2;26;27;38m\(esc)K\(esc)0m")  // cały wiersz 0: truecolor
    terminal.feed(text: "\(esc)2;1H\(esc)41m \(esc)0m\(esc)2;10H\(esc)48;5;196m \(esc)0m")  // ANSI 1 | 256: 196
    terminal.feed(text: "\(esc)3;1H\(esc)7m \(esc)0m\(esc)3;10H\(esc)7;31m \(esc)0m")  // odwrócone domyślne | fg 1
    terminal.feed(text: "\(esc)4;1H\(esc)48;5;240m \(esc)0m")  // szarość 240; reszta wiersza domyślna
    let palette = TerminalPalette(background: Self.navy, foreground: Self.ink, strategy: .base16Lab).colors
    let edges = edges(terminal)
    let navy = TerminalEdgeColor(Self.navy)
    let ink = TerminalEdgeColor(Self.ink)
    let truecolor = TerminalEdgeColor(red8: 26, green8: 27, blue8: 38)
    #expect(edges.background == navy)
    #expect(edges.leading == [truecolor, palette[1], ink, palette[240]])
    #expect(edges.trailing == [truecolor, palette[196], palette[1], navy])
    #expect(palette[1] == TerminalEdgeColor(red8: 194, green8: 54, blue8: 33), "ANSI 0–15: Terminal.app")
    #expect(edges.bottom == [palette[240]] + Array(repeating: navy, count: 9), "ekran alternatywny: dół zawsze")
    #expect(!edges.selecting)
  }

  @Test("boki na ekranie głównym: wiersz z komórką tła domyślnego się nie rozszerza (odwrócony „%” zsh)")
  func sideRule() {
    let esc = "\u{1B}["
    let (terminal, _) = terminal()
    let palette = TerminalPalette(background: Self.navy, foreground: Self.ink, strategy: .base16Lab).colors
    // Wiersz 0: odwrócony „%” zsh w kolumnie 0 i prompt; wiersz 1 cały w kolorze; wiersz 2 cały w kolorze ze znakiem
    // powerline.
    terminal.feed(text: "\(esc)1;1H\(esc)7m%\(esc)0m ~/demo > ")
    terminal.feed(text: "\(esc)2;1H\(esc)44m\(esc)K\(esc)0m")
    terminal.feed(text: "\(esc)3;1H\(esc)44m\(esc)K\(esc)3;4H\u{E0B0}\(esc)0m")
    let main = edges(terminal)
    #expect(main.leading[0] == nil && main.trailing[0] == nil, "goła powłoka: bez pasa przy odwróconym „%”")
    #expect(main.leading[1] == palette[4] && main.trailing[1] == palette[4], "wiersz w całości kolorowy")
    #expect(main.leading[2] == palette[4] && main.trailing[2] == palette[4], "znak powerline nie blokuje")
    #expect(main.leading[3] == nil, "pusty wiersz")

    terminal.feed(text: "\(esc)?1049h\(esc)2J\(esc)1;1H\(esc)7m%\(esc)0m ~/demo > ")
    let alternate = edges(terminal)
    #expect(alternate.leading[0] == TerminalEdgeColor(Self.ink), "ten sam wiersz na ekranie alternatywnym")
    #expect(alternate.trailing[0] == TerminalEdgeColor(Self.navy))
    #expect(!alternate.leading.contains(nil), "ekran alternatywny: każdy wiersz")
  }

  @Test("OSC 11 programu przesuwa tło: paleta 16–255 liczy się z nowej kotwicy, jak w SwiftTerm")
  func backgroundFromProgram() throws {
    let (terminal, replies) = terminal()
    let before = TerminalPalette(
      background: terminal.backgroundColor, foreground: terminal.foregroundColor, strategy: .base16Lab)
    terminal.feed(text: "\u{1B}]11;rgb:3030/0000/3030\u{1B}\\")
    #expect(TerminalEdgeColor(terminal.backgroundColor) == TerminalEdgeColor(red8: 0x30, green8: 0, blue8: 0x30))
    let after = TerminalPalette(
      background: terminal.backgroundColor, foreground: terminal.foregroundColor, strategy: .base16Lab)
    #expect(after.key != before.key && after.colors[240] != before.colors[240], "kotwica zmieniła paletę")
    #expect(after.colors == (try swiftTermPalette(terminal, replies)))
    terminal.feed(text: "\u{1B}[?1049h\u{1B}[2J")
    let current = edges(terminal)
    #expect(current.background == TerminalEdgeColor(red8: 0x30, green8: 0, blue8: 0x30))
    #expect(current.leading.first == current.background, "tło domyślne komórki = nowe tło")
  }

  @Test("dół na ekranie głównym: tylko bez komórki tła domyślnego (powerline nie blokuje); na alternatywnym zawsze")
  func verticalRule() {
    let esc = "\u{1B}["
    let (terminal, _) = terminal()
    let palette = TerminalPalette(background: Self.navy, foreground: Self.ink, strategy: .base16Lab).colors
    terminal.feed(text: "\(esc)4;1H\(esc)44m\(esc)K\(esc)4;9H\(esc)42m  \(esc)0m")
    let filled = edges(terminal).bottom
    #expect(filled == Array(repeating: palette[4], count: 8) + [palette[2], palette[2]], "pasek statusu na dole")

    terminal.feed(text: "\(esc)4;5H\(esc)44m\u{E0B0}\(esc)0m")
    #expect(
      edges(terminal).bottom == Array(repeating: palette[4], count: 10),
      "znak powerline w dolnym wierszu nie blokuje dołu, tylko daje mu jeden kolor: najczęstsze tło wiersza")
    terminal.feed(text: "\(esc)4;5H\(esc)44m \(esc)4;6H\(esc)7m \(esc)0m")
    #expect(edges(terminal).bottom != nil, "odwrócone domyślne to nie tło domyślne")
    terminal.feed(text: "\(esc)4;6H\(esc)0m ")
    #expect(edges(terminal).bottom == nil, "jedna komórka z tłem domyślnym")

    terminal.feed(text: "\(esc)?1049h\(esc)2J")
    #expect(terminal.isCurrentBufferAlternate)
    let alternate = edges(terminal)
    #expect(alternate.bottom == Array(repeating: TerminalEdgeColor(Self.navy), count: 10), "ekran alternatywny")
    terminal.feed(text: "\(esc)4;1H\(esc)44m\u{E0B0}\(esc)0m")
    #expect(
      edges(terminal).bottom == Array(repeating: TerminalEdgeColor(Self.navy), count: 10),
      "ekran alternatywny: powerline nie blokuje dołu, pas ma najczęstsze tło wiersza")
  }

  /// Nvim z lualine w oknie Cmd+F: herdr wysyła gotowy obraz ekranu, więc nvim stoi
  /// na ekranie GŁÓWNYM, a jego pasek statusu ma jawne tło w każdej komórce i separatory U+E0B4/E0B6. Pas ma sięgnąć
  /// boków w kolorach skrajnych segmentów, a dołu jednym kolorem — najczęstszym tłem paska (kolumna po kolumnie dawał
  /// pod kapsułami kanciaste stopki, drugi zrzut tego dnia); wiersz gołej powłoki z odwróconym „%” zostaje bez pasa.
  @Test("ekran główny: pasek lualine (jawne tło, separatory U+E0B4/E0B6) się rozszerza; wiersz z odwróconym „%” nie")
  func lualineOnMainScreen() {
    let esc = "\u{1B}["
    let (terminal, _) = terminal(cols: 12, rows: 4)
    #expect(!terminal.isCurrentBufferAlternate)
    // Wiersz 0: odwrócony „%” zsh i prompt. Wiersz 3: „ N ” | E0B4 | „ main ” | E0B6 | jedna komórka segmentu z prawej.
    terminal.feed(text: "\(esc)1;1H\(esc)7m%\(esc)0m ~/demo > ")
    terminal.feed(text: "\(esc)4;1H\(esc)48;2;137;180;250m\(esc)38;2;30;30;46m N ")
    terminal.feed(text: "\(esc)48;2;49;50;68m\(esc)38;2;137;180;250m\u{E0B4}\(esc)38;2;205;214;244m main ")
    terminal.feed(text: "\(esc)38;2;166;227;161m\u{E0B6}\(esc)48;2;166;227;161m\(esc)38;2;30;30;46m \(esc)0m")
    let mode = TerminalEdgeColor(red8: 137, green8: 180, blue8: 250)
    let branch = TerminalEdgeColor(red8: 49, green8: 50, blue8: 68)
    let right = TerminalEdgeColor(red8: 166, green8: 227, blue8: 161)
    let edges = edges(terminal)
    #expect(edges.bottom == Array(repeating: branch, count: 12), "dół jednym kolorem: najczęstsze tło paska (8 z 12)")
    #expect(edges.leading[3] == mode && edges.trailing[3] == right, "boki paska statusu")
    #expect(edges.leading[0] == nil && edges.trailing[0] == nil, "goła powłoka: bez pasa przy odwróconym „%”")
  }

  @Test("zaznaczenie przechodzi do wyniku; kasowanie niesie tło bieżącego atrybutu")
  func selectionAndErase() {
    let (terminal, _) = terminal(cols: 6, rows: 2)
    terminal.feed(text: "\u{1B}[48;2;1;2;3m\u{1B}[2J")
    let palette = TerminalPalette(background: Self.navy, foreground: Self.ink, strategy: .base16Lab)
    let edges = TerminalEdgeReader.edges(
      of: terminal, palette: palette, background: TerminalEdgeColor(Self.navy), foreground: TerminalEdgeColor(Self.ink),
      selecting: true)
    let erased = TerminalEdgeColor(red8: 1, green8: 2, blue8: 3)
    #expect(edges.selecting)
    #expect(edges.leading == [erased, erased] && edges.trailing == [erased, erased])
    #expect(edges.bottom == Array(repeating: erased, count: 6), "cały dolny wiersz w tle kasowania")
  }
}
