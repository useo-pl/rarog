import Foundation
@testable import RarogUI
import Testing

// Strzałki klawiatury sprzętowej, które powierzchnia wysyła i powtarza sama: bajty
// 1:1 ze ścieżką legacy SwiftTerm 1.19.0 (`iOSTerminalView.pressesBegan`, `KittyKeyboardEncoder`
// `legacyNavigationSequence`), takt serii i ślad końca serii bez treści klawiszy. Właściciel: terminal.

@Suite("terminal: strzałki sprzętowe i ich seria")
struct TerminalKeyRepeatTests {
  private static let esc = "\u{1B}"

  @Test("bez modyfikatora: ESC[X, przy DECCKM ESC O X")
  func plainArrows() {
    let letters: [(PadDirection, String)] = [(.up, "A"), (.down, "B"), (.right, "C"), (.left, "D")]
    for (direction, letter) in letters {
      #expect(TerminalKeyMap.arrowBytes(direction: direction) == "\(Self.esc)[\(letter)")
      #expect(TerminalKeyMap.arrowBytes(direction: direction, applicationCursor: true) == "\(Self.esc)O\(letter)")
      // Pad paska ma te same bajty w trybie normalnym (DECCKM herdr i tak nie przepuszcza).
      #expect(TerminalKeyMap.arrowBytes(direction: direction) == direction.bytes)
    }
  }

  @Test("Shift i Ctrl: ESC[1;{1+s+4c}X niezależnie od DECCKM")
  func shiftAndControl() {
    for cursor in [false, true] {
      #expect(TerminalKeyMap.arrowBytes(direction: .up, shift: true, applicationCursor: cursor) == "\(Self.esc)[1;2A")
      #expect(TerminalKeyMap.arrowBytes(direction: .left, control: true, applicationCursor: cursor) == "\(Self.esc)[1;5D")
      #expect(
        TerminalKeyMap.arrowBytes(direction: .right, shift: true, control: true, applicationCursor: cursor)
          == "\(Self.esc)[1;6C")
      #expect(TerminalKeyMap.arrowBytes(direction: .down, control: true, applicationCursor: cursor) == "\(Self.esc)[1;5B")
    }
  }

  @Test("Option: ←/→ to słowo (ESC b / ESC f), ↑/↓ to zwykła strzałka — jak SwiftTerm, bez „poprawiania”")
  func option() {
    #expect(TerminalKeyMap.arrowBytes(direction: .left, option: true) == "\(Self.esc)b")
    #expect(TerminalKeyMap.arrowBytes(direction: .right, option: true) == "\(Self.esc)f")
    #expect(TerminalKeyMap.arrowBytes(direction: .left, shift: true, control: true, option: true) == "\(Self.esc)b")
    #expect(TerminalKeyMap.arrowBytes(direction: .up, option: true) == "\(Self.esc)[A")
    #expect(TerminalKeyMap.arrowBytes(direction: .down, shift: true, option: true) == "\(Self.esc)[B")
    #expect(TerminalKeyMap.arrowBytes(direction: .up, option: true, applicationCursor: true) == "\(Self.esc)OA")
  }

  @Test("Cmd: strzałki nie przejmujemy (skróty kontenera Home/End/strony, systemowe zaznaczanie)")
  func command() {
    for direction in PadDirection.allCases {
      #expect(TerminalKeyMap.arrowBytes(direction: direction, command: true) == nil)
      #expect(TerminalKeyMap.arrowBytes(direction: direction, shift: true, command: true) == nil)
    }
  }

  @Test("takt: 300 ms pauzy, ~30 na sekundę, sufit 20 s")
  func timing() {
    #expect(TerminalKeyRepeat.delay == .milliseconds(300))
    #expect(TerminalKeyRepeat.interval == .milliseconds(33))
    #expect(TerminalKeyRepeat.ceiling == .seconds(20))
    #expect(TerminalKeyRepeat.delay < .milliseconds(400), "szybciej niż własny zegar SwiftTerm (0,4 s)")
  }

  @Test("ślad końca serii: powód, czas i liczba powtórzeń — bez klawisza i bajtów")
  func traceLine() {
    let line = TerminalKeyRepeatEnd(reason: .released, repeats: 16, heldMilliseconds: 812).traceLine
    #expect(line == "terminal: seria strzałki stanęła — klawisz puszczony (pressesEnded kontenera); 812 ms, 16 powtórzeń")
    for reason in TerminalKeyRepeatStop.allCases {
      let text = TerminalKeyRepeatEnd(reason: reason, repeats: 1, heldMilliseconds: 1).traceLine
      #expect(!text.contains("\u{1B}"), "\(reason)")
      #expect(text.count <= 200, "jedna linia śladu ma sufit 200 znaków")
    }
    #expect(TerminalKeyRepeatStop.allCases.filter(\.isFallback) == [.gameController, .ceiling])
  }

  @Test("budżet śladów: każdy zapas (do 5), z drogi głównej tylko 3 pierwsze serie z powtórzeniami")
  func budget() {
    var budget = TerminalKeyRepeatTraceBudget()
    func admit(_ reason: TerminalKeyRepeatStop, repeats: Int) -> Bool {
      budget.admit(TerminalKeyRepeatEnd(reason: reason, repeats: repeats, heldMilliseconds: 500))
    }
    let tap = admit(.released, repeats: 0)
    #expect(!tap, "tap bez serii")
    let other = admit(.newKey, repeats: 4)
    #expect(!other)
    let confirmations = (0..<4).map { _ in admit(.released, repeats: 5) }
    #expect(confirmations == [true, true, true, false], "trzy potwierdzenia drogi głównej")
    let fallbacks = [TerminalKeyRepeatStop.gameController, .ceiling, .gameController, .ceiling, .gameController, .ceiling]
      .map { admit($0, repeats: 0) }
    #expect(fallbacks == [true, true, true, true, true, false], "pięć zapasów")
  }
}
