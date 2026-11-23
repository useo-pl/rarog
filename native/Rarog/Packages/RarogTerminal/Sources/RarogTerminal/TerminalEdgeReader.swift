import Foundation
import RarogUI
@preconcurrency import SwiftTerm

// Odczyt krawędzi siatki dla pasa wokół niej, bez UIKit — testy na macOS (`TerminalEdgeReaderTests`) na
// syntetycznych bajtach. Kolor tła komórki liczy się tak jak w rendererze SwiftTerm 1.19.0
// (`AppleTerminalView.swift`: `getAttributes` i `mapColor`): `inverse` zamienia pierwszy plan z tłem, a domyślny
// kolor po zamianie to `.defaultInvertedColor`; tło domyślne → efektywne tło, `.defaultInvertedColor` → pierwszy
// plan, `.trueColor` wprost, `.ansi256` z palety 256 kolorów. Paletę SwiftTerm trzyma wewnętrznie, więc jest tu
// powtórzona (`TerminalPalette`). Tego, co program zmieni sam, odczyt nie widzi: paleta po OSC 4/104 i globalne
// odwrócenie ekranu (DECSCNM) zostają w SwiftTerm prywatne — znane ograniczenie.
// Reguła rozszerzania (pionowa jak w Ghostty `window-padding-color = extend`, ta sama dla boków): na ekranie
// alternatywnym wiersz rozszerza się zawsze, na głównym tylko, gdy nie ma komórki z tłem domyślnym. Na bokach to
// nasza reguła, a nie Ghostty: zsh stawia odwrócony „%” w kolumnie 0 po wyjściu bez końca linii, a nasz pas ma 16 pt,
// nie 2 px — goła powłoka ma wyglądać jak bez pasa. Reguły powerline z Ghostty nie ma: herdr wysyła
// gotowy obraz ekranu, więc nvim jest u nas zawsze na ekranie GŁÓWNYM, a pasek lualine (jawne tło w każdej komórce,
// separatory U+E0B4/E0B6) przez nią nie sięgał dołu ani boków. Znak powerline zmienia za to KOLOR pasa pod dolnym
// wierszem: jeden, najczęstsze tło wiersza, zamiast kolumna po kolumnie (``bottomBand``). Właściciel: terminal.

/// Odczyt kolorów krawędzi siatki z emulatora.
enum TerminalEdgeReader {
  /// Znaki powerline (Nerd Fonts, U+E0A0–U+E0D7): pod wierszem z nimi pas dołu ma jeden kolor.
  static let powerline: ClosedRange<UInt32> = 0xE0A0...0xE0D7

  /// Krawędzie widocznego ekranu.
  /// - Parameters:
  ///   - background: efektywne tło terminala (`nativeBackgroundColor`, po OSC 11 programu też).
  ///   - foreground: efektywny pierwszy plan (kolor tła komórki odwróconej przy domyślnych kolorach).
  ///   - selecting: zaznaczenie aktywne (``TerminalEdges/selecting``).
  static func edges(
    of terminal: Terminal, palette: TerminalPalette, background: TerminalEdgeColor, foreground: TerminalEdgeColor,
    selecting: Bool = false
  ) -> TerminalEdges {
    let rows = terminal.rows
    let cols = terminal.cols
    guard rows > 0, cols > 0 else {
      return TerminalEdges(background: background, leading: [], trailing: [], bottom: nil, selecting: selecting)
    }
    let alternate = terminal.isCurrentBufferAlternate
    func resolve(_ data: CharData) -> TerminalEdgeColor {
      switch backgroundKind(data.attribute) {
      case .defaultColor: background
      case .defaultInvertedColor: foreground
      case let .ansi256(code): palette.colors[Int(code)]
      case let .trueColor(red, green, blue): TerminalEdgeColor(red8: red, green8: green, blue8: blue)
      }
    }
    /// Wiersz do rozszerzenia; `nil` = się nie rozszerza.
    func extended(_ row: Int) -> BufferLine? {
      guard let line = terminal.getLine(row: row) else { return nil }
      guard !alternate else { return line }
      for col in 0..<cols where backgroundKind(line[col].attribute) == .defaultColor { return nil }
      return line
    }
    var leading: [TerminalEdgeColor?] = []
    var trailing: [TerminalEdgeColor?] = []
    var last: BufferLine?
    for row in 0..<rows {
      let line = extended(row)
      leading.append(line.map { resolve($0[0]) })
      trailing.append(line.map { resolve($0[cols - 1]) })
      if row == rows - 1 { last = line }
    }
    return TerminalEdges(
      background: background, leading: leading, trailing: trailing,
      bottom: last.map { bottomBand($0, cols: cols, resolve: resolve) }, selecting: selecting)
  }

  /// Pas pod dolnym wierszem: kolumna po kolumnie, a pod wierszem ze znakiem powerline jeden kolor — najczęstsze tło
  /// wiersza (przy remisie to, które wcześniej doszło do tej liczby). Kapsułę lualine rysuje sam znak, a tło jego
  /// komórki to kolor
  /// SĄSIEDNIEGO segmentu, więc pas kolumna po kolumnie dawałby pod zaokrągleniami kanciaste stopki przesunięte
  /// o komórkę. Boki wiersza zostają w kolorach skrajnych komórek.
  static func bottomBand(
    _ line: BufferLine, cols: Int, resolve: (CharData) -> TerminalEdgeColor
  ) -> [TerminalEdgeColor] {
    let colors = (0..<cols).map { resolve(line[$0]) }
    let hasPowerline = (0..<cols).contains { col in
      line[col].getCharacter().unicodeScalars.contains { powerline.contains($0.value) }
    }
    guard hasPowerline else { return colors }
    var counts: [TerminalEdgeColor: Int] = [:]
    var dominant = colors[0]
    for color in colors {
      counts[color, default: 0] += 1
      if counts[color, default: 0] > counts[dominant, default: 0] { dominant = color }
    }
    return Array(repeating: dominant, count: cols)
  }

  /// Rodzaj koloru tła po `inverse` — jak `getAttributes` SwiftTerm.
  static func backgroundKind(_ attribute: Attribute) -> Attribute.Color {
    guard attribute.style.contains(.inverse) else { return attribute.bg }
    return attribute.fg == .defaultColor ? .defaultInvertedColor : attribute.fg
  }
}

extension TerminalEdgeColor {
  /// Kolor SwiftTerm (16 bitów na kanał) bez strat.
  init(_ color: SwiftTerm.Color) {
    self.init(red: color.red, green: color.green, blue: color.blue)
  }
}

/// Paleta 256 kolorów, którą rysuje SwiftTerm: 0–15 to kolory zainstalowane (apka nic nie instaluje, więc
/// `Color.terminalAppColors`), 16–255 liczy strategia terminala (`ansi256PaletteStrategy`, domyślnie `.base16Lab`)
/// z kolorów 0–7 oraz tła i pierwszego planu. Przeliczana tylko przy zmianie któregoś z nich.
struct TerminalPalette: Equatable {
  struct Key: Equatable {
    var background: TerminalEdgeColor
    var foreground: TerminalEdgeColor
    var strategy: Ansi256PaletteStrategy
  }

  let key: Key
  let colors: [TerminalEdgeColor]

  /// - Parameters:
  ///   - background, foreground: kotwice strategii — `Terminal.backgroundColor` i `foregroundColor`, tak jak
  ///     w `rebuildAnsiPalette` SwiftTerm.
  init(
    background: SwiftTerm.Color, foreground: SwiftTerm.Color, strategy: Ansi256PaletteStrategy,
    base: [SwiftTerm.Color] = SwiftTerm.Color.terminalAppColors
  ) {
    key = Key(background: TerminalEdgeColor(background), foreground: TerminalEdgeColor(foreground), strategy: strategy)
    let installed = base.map(TerminalEdgeColor.init)
    switch strategy {
    case .xterm:
      colors = Self.xterm(installed)
    case .base16Lab:
      colors = Self.base16Lab(installed, background: key.background, foreground: key.foreground, harmonious: false)
    case .base16LabHarmonious:
      colors = Self.base16Lab(installed, background: key.background, foreground: key.foreground, harmonious: true)
    }
  }

  // Dalej: przepisane z `Sources/SwiftTerm/Colors.swift` SwiftTerm 1.19.0 (`generateXtermPalette`,
  // `generateBase16LabPalette`, `LabColor`). SwiftTerm trzyma je jako prywatne, a pas musi mieć kolor komórki co do
  // bitu (`TerminalEdgeReaderTests` porównuje całą paletę z odpowiedzią SwiftTerm na OSC 4). Nota licencji portu stoi
  // niżej po angielsku (cudzy tekst prawny), od `SPDX-SnippetBegin` do `SPDX-SnippetEnd`; wpis: `THIRD-PARTY-NOTICES`.
  //
  // SPDX-SnippetBegin
  // SPDX-SnippetName: SwiftTerm palette generation (Sources/SwiftTerm/Colors.swift, SwiftTerm 1.19.0)
  // SPDX-SnippetCopyrightText: Copyright (c) 2019-2026 Miguel de Icaza (https://github.com/migueldeicaza)
  // SPDX-SnippetCopyrightText: Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
  // SPDX-SnippetCopyrightText: Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
  // SPDX-SnippetCopyrightText: Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
  // SPDX-SnippetCopyrightText: Copyright © 2020 Miguel de Icaza (header of Colors.swift)
  // SPDX-License-Identifier: MIT
  //
  // Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
  // documentation files (the "Software"), to deal in the Software without restriction, including without limitation
  // the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
  // to permit persons to whom the Software is furnished to do so, subject to the following conditions:
  //
  // The above copyright notice and this permission notice shall be included in all copies or substantial portions
  // of the Software.
  //
  // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
  // THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  // AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
  // CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
  // DEALINGS IN THE SOFTWARE.

  private static func xterm(_ installed: [TerminalEdgeColor]) -> [TerminalEdgeColor] {
    var colors = installed
    let steps: [UInt8] = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]
    for index in 0..<216 {
      colors.append(
        TerminalEdgeColor(red8: steps[(index / 36) % 6], green8: steps[(index / 6) % 6], blue8: steps[index % 6]))
    }
    for index in 0..<24 {
      let level = UInt8(8 + index * 10)
      colors.append(TerminalEdgeColor(red8: level, green8: level, blue8: level))
    }
    return colors
  }

  private static func base16Lab(
    _ installed: [TerminalEdgeColor], background: TerminalEdgeColor, foreground: TerminalEdgeColor, harmonious: Bool
  ) -> [TerminalEdgeColor] {
    guard installed.count >= 8 else { return xterm(installed) }
    // Kotwice: kolory 0–7, a w miejscu 0 i 7 tło i pierwszy plan.
    var anchors = installed.prefix(8).map(Lab.init)
    anchors[0] = Lab(background)
    anchors[7] = Lab(foreground)
    // Jasny motyw: kotwice zamienione, żeby rampa szła od ciemnego do jasnego.
    if anchors[7].l < anchors[0].l, !harmonious { anchors.swapAt(0, 7) }
    var colors = installed
    // 16…231: sześcian 6×6×6 interpolowany trójliniowo w LAB.
    for r in 0..<6 {
      let tr = Double(r) / 5
      let c0 = Lab.lerp(tr, anchors[0], anchors[1])
      let c1 = Lab.lerp(tr, anchors[2], anchors[3])
      let c2 = Lab.lerp(tr, anchors[4], anchors[5])
      let c3 = Lab.lerp(tr, anchors[6], anchors[7])
      for g in 0..<6 {
        let tg = Double(g) / 5
        let c4 = Lab.lerp(tg, c0, c1)
        let c5 = Lab.lerp(tg, c2, c3)
        for b in 0..<6 {
          colors.append(Lab.lerp(Double(b) / 5, c4, c5).color)
        }
      }
    }
    // 232…255: szarości od ciemnego do jasnego.
    for index in 0..<24 {
      colors.append(Lab.lerp(Double(index + 1) / 25, anchors[0], anchors[7]).color)
    }
    return colors
  }

  private struct Lab {
    let l: Double
    let a: Double
    let b: Double

    init(l: Double, a: Double, b: Double) {
      self.l = l
      self.a = a
      self.b = b
    }

    init(_ color: TerminalEdgeColor) {
      func linear(_ component: UInt16) -> Double {
        // Najpierw do 8 bitów, jak `normalizedComponent` SwiftTerm.
        let value = max(0, min(255, (Double(component) / 65535 * 255).rounded())) / 255
        return value > 0.04045 ? pow((value + 0.055) / 1.055, 2.4) : value / 12.92
      }
      let r = linear(color.red)
      let g = linear(color.green)
      let b = linear(color.blue)
      // Liniowe RGB → XYZ.
      var x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
      var y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750
      var z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883
      x = x > 0.008856 ? pow(x, 1.0 / 3.0) : 7.787 * x + 16.0 / 116.0
      y = y > 0.008856 ? pow(y, 1.0 / 3.0) : 7.787 * y + 16.0 / 116.0
      z = z > 0.008856 ? pow(z, 1.0 / 3.0) : 7.787 * z + 16.0 / 116.0
      self.init(l: 116.0 * y - 16.0, a: 500.0 * (x - y), b: 200.0 * (y - z))
    }

    var color: TerminalEdgeColor {
      let y = (l + 16.0) / 116.0
      let x = a / 500.0 + y
      let z = y - b / 200.0
      let x3 = x * x * x
      let y3 = y * y * y
      let z3 = z * z * z
      let xf = (x3 > 0.008856 ? x3 : (x - 16.0 / 116.0) / 7.787) * 0.95047
      let yf = y3 > 0.008856 ? y3 : (y - 16.0 / 116.0) / 7.787
      let zf = (z3 > 0.008856 ? z3 : (z - 16.0 / 116.0) / 7.787) * 1.08883
      var r = xf * 3.2404542 - yf * 1.5371385 - zf * 0.4985314
      var g = -xf * 0.9692660 + yf * 1.8760108 + zf * 0.0415560
      var b = xf * 0.0556434 - yf * 0.2040259 + zf * 1.0572252
      r = r > 0.0031308 ? 1.055 * pow(r, 1.0 / 2.4) - 0.055 : 12.92 * r
      g = g > 0.0031308 ? 1.055 * pow(g, 1.0 / 2.4) - 0.055 : 12.92 * g
      b = b > 0.0031308 ? 1.055 * pow(b, 1.0 / 2.4) - 0.055 : 12.92 * b
      func quantized(_ value: Double) -> UInt8 { UInt8(max(0, min(1, value)) * 255 + 0.5) }
      return TerminalEdgeColor(red8: quantized(r), green8: quantized(g), blue8: quantized(b))
    }

    static func lerp(_ t: Double, _ from: Lab, _ to: Lab) -> Lab {
      Lab(l: from.l + t * (to.l - from.l), a: from.a + t * (to.a - from.a), b: from.b + t * (to.b - from.b))
    }
  }
  // SPDX-SnippetEnd
}
