import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Pasek klawiszy, pad strzałek i klawiatura sprzętowa terminala: Ctrl/Meta,
// pad, Cmd i metryka paska.
// Właściciel: terminal.

private let esc = "\u{1B}"

@Suite("terminal: pasek klawiszy — skład, bajty, modyfikatory jednorazowe")
struct TerminalKeyBarTests {
  @Test("skład jak PWA, pad przy prawym skraju, Historia na końcu: Esc, Tab, Ctrl, Cmd, Kopiuj, Wklej, pad, Historia")
  func order() {
    #expect(TerminalBarKey.allCases == [.esc, .tab, .ctrl, .cmd, .copy, .paste, .pad, .history])
    #expect(TerminalBarKey.esc.bytes == esc)
    #expect(TerminalBarKey.tab.bytes == "\t")
    for key in [TerminalBarKey.ctrl, .cmd, .pad, .copy, .paste, .history] {
      #expect(key.bytes == nil, "\(key) nic nie wysyła sam")
    }
    #expect(TerminalBarKey.allCases.filter(\.isModifier) == [.ctrl, .cmd])
    // Pad uczy gestu: czytnik słyszy, że tap nic nie wysyła.
    #expect(TerminalBarKey.pad.hint?.contains("przesuń") == true)
    #expect(TerminalBarKey.pad.hint?.contains("tapnięcie") == true)
  }

  @Test("osiem celów po 44 pt mieści się bez przewijania na najwęższym iPhonie (375 pt)")
  func fitsNarrowestPhone() {
    #expect(TerminalKeyBarMetrics.target >= 44)
    #expect(TerminalKeyBarMetrics.minimumWidth <= TerminalKeyBarMetrics.narrowestPhone)
  }

  @Test("Ctrl: C0 dla liter i @[\\]^_, spacja → NUL, ? → DEL; reszta bez zmian (PWA `ctrlChunk`)")
  func control() {
    #expect(TerminalControlBytes.control("c") == "\u{03}")
    #expect(TerminalControlBytes.control("C") == "\u{03}")
    #expect(TerminalControlBytes.control("d") == "\u{04}")
    #expect(TerminalControlBytes.control("a") == "\u{01}")
    #expect(TerminalControlBytes.control("z") == "\u{1A}")
    #expect(TerminalControlBytes.control("@") == "\u{00}")
    #expect(TerminalControlBytes.control("[") == esc)
    #expect(TerminalControlBytes.control("\\") == "\u{1C}")
    #expect(TerminalControlBytes.control("]") == "\u{1D}")
    #expect(TerminalControlBytes.control("^") == "\u{1E}")
    #expect(TerminalControlBytes.control("_") == "\u{1F}")
    #expect(TerminalControlBytes.control(" ") == "\u{00}")
    #expect(TerminalControlBytes.control("?") == "\u{7F}")
    // Kombinacja, której nie ma, przechodzi BEZ ZMIAN (udawany bajt byłby gorszy).
    #expect(TerminalControlBytes.control("\u{1B}[A") == "\u{1B}[A")
    #expect(TerminalControlBytes.control("ą") == "ą")
    #expect(TerminalControlBytes.control("wklejka") == "wklejka")
    #expect(TerminalControlBytes.control("1") == "1")
  }

  @Test("Cmd: prefiks Meta, także na bajcie z Ctrl; wklejka bez zmian (PWA `metaChunk`)")
  func meta() {
    #expect(TerminalControlBytes.meta("b") == esc + "b")
    #expect(TerminalControlBytes.meta(TerminalControlBytes.control("c")) == esc + "\u{03}")
    #expect(TerminalControlBytes.meta("wklejka") == "wklejka")
    #expect(TerminalControlBytes.meta("v") == esc + "v")
  }

  @Test("modyfikatory: tap uzbraja, drugi rozbraja; pierwszy fragment rozbraja oba; wklejka gasi")
  func modifiers() {
    var mods = TerminalModifiers()
    #expect(mods.apply("c") == "c")
    #expect(mods.toggle(.ctrl) == true)
    #expect(mods.isArmed)
    #expect(mods.apply("c") == "\u{03}")
    #expect(!mods.isArmed, "pierwszy fragment rozbraja")
    #expect(mods.apply("c") == "c")

    #expect(mods.toggle(.cmd) == true)
    #expect(mods.toggle(.cmd) == false, "drugi tap rozbraja")
    #expect(!mods.isArmed)

    mods.toggle(.ctrl)
    mods.toggle(.cmd)
    #expect(mods.apply("c") == esc + "\u{03}", "oba: ESC + C0 (M-C-c)")
    #expect(!mods.ctrl && !mods.cmd)

    // Modyfikator nie działa na fragment wieloznakowy, ale i tak gaśnie (PWA `sendInput`).
    mods.toggle(.ctrl)
    #expect(mods.apply("ls -la") == "ls -la")
    #expect(!mods.isArmed)

    mods.toggle(.cmd)
    mods.disarm()
    #expect(!mods.isArmed)
    #expect(mods.toggle(.esc) == false, "klawisz nie-modyfikator niczego nie uzbraja")
    #expect(!mods.isArmed)
  }
}

@Suite("terminal: pad strzałek — próg, oś, histereza, takt")
struct TerminalArrowPadTests {
  @Test("bajty kierunków stałe, bez DECCKM")
  func bytes() {
    #expect(PadDirection.up.bytes == "\u{1B}[A")
    #expect(PadDirection.down.bytes == "\u{1B}[B")
    #expect(PadDirection.right.bytes == "\u{1B}[C")
    #expect(PadDirection.left.bytes == "\u{1B}[D")
  }

  @Test("poniżej progu nie ma kierunku (tapnięcie nie wysyła NICZEGO)")
  func belowSlop() {
    #expect(TerminalPad.direction(dx: 0, dy: 0) == nil)
    #expect(TerminalPad.direction(dx: TerminalPad.slop - 1, dy: 0) == nil)
    #expect(TerminalPad.direction(dx: 0, dy: -(TerminalPad.slop - 1)) == nil)
  }

  @Test("cztery osie po przekroczeniu progu")
  func axes() {
    #expect(TerminalPad.direction(dx: TerminalPad.slop, dy: 0) == .right)
    #expect(TerminalPad.direction(dx: -TerminalPad.slop, dy: 0) == .left)
    #expect(TerminalPad.direction(dx: 0, dy: TerminalPad.slop) == .down)
    #expect(TerminalPad.direction(dx: 0, dy: -TerminalPad.slop) == .up)
  }

  @Test("przekątna daje dominującą oś, remis = pion")
  func dominant() {
    #expect(TerminalPad.direction(dx: 40, dy: 20) == .right)
    #expect(TerminalPad.direction(dx: 20, dy: 40) == .down)
    #expect(TerminalPad.direction(dx: -40, dy: -30) == .left)
    #expect(TerminalPad.direction(dx: 30, dy: 30) == .down)
  }

  @Test("zwrot w tej samej osi natychmiast; zmiana osi z histerezą; drgnięcie pod progiem trzyma kierunek")
  func hysteresis() {
    #expect(TerminalPad.direction(dx: -30, dy: 0, current: .right) == .left)
    #expect(TerminalPad.direction(dx: 30, dy: 0, current: .left) == .right)
    #expect(TerminalPad.direction(dx: 0, dy: 30, current: .up) == .down)
    let h = TerminalPad.hysteresis
    #expect(TerminalPad.direction(dx: 30, dy: 30 + h - 1, current: .right) == .right)
    #expect(TerminalPad.direction(dx: 30, dy: 30 + h + 1, current: .right) == .down)
    #expect(TerminalPad.direction(dx: 30 + h - 1, dy: 30, current: .down) == .down)
    #expect(TerminalPad.direction(dx: 30 + h + 1, dy: 30, current: .down) == .right)
    #expect(TerminalPad.direction(dx: 2, dy: 0, current: .right) == .right)
    #expect(TerminalPad.direction(dx: 0, dy: 0, current: .up) == .up)
    #expect(TerminalPad.direction(dx: .nan, dy: 0, current: .left) == .left)
    #expect(TerminalPad.direction(dx: 0, dy: .infinity) == nil)
  }

  @Test("takt: 70 ms przy progu, 35 ms od pełnego wychylenia, ciągle i monotonicznie między nimi")
  func interval() {
    #expect(TerminalPad.intervalMs(reach: 0) == TerminalPad.intervalMaxMs)
    #expect(TerminalPad.intervalMs(reach: TerminalPad.slop) == TerminalPad.intervalMaxMs)
    #expect(TerminalPad.intervalMs(reach: .nan) == TerminalPad.intervalMaxMs)
    #expect(TerminalPad.intervalMs(reach: TerminalPad.full) == TerminalPad.intervalMinMs)
    #expect(TerminalPad.intervalMs(reach: TerminalPad.full * 10) == TerminalPad.intervalMinMs)
    let mid = (TerminalPad.slop + TerminalPad.full) / 2
    #expect(abs(TerminalPad.intervalMs(reach: mid) - (TerminalPad.intervalMaxMs + TerminalPad.intervalMinMs) / 2) < 1e-9)
    var previous = Double.infinity
    for reach in stride(from: 0.0, through: 80, by: 2) {
      let value = TerminalPad.intervalMs(reach: reach)
      #expect(value <= previous && value >= TerminalPad.intervalMinMs)
      previous = value
    }
    #expect(TerminalPad.repeatDelay > .milliseconds(Int(TerminalPad.intervalMaxMs)), "dotyk ≠ seria")
  }

  @Test("gest: pierwsza strzałka przy przekroczeniu progu, kolejna dopiero przy zmianie kierunku; takt z wychylenia")
  func tracker() {
    var gesture = TerminalPadTracker()
    #expect(gesture.move(dx: 5, dy: 0) == nil, "tap")
    #expect(gesture.move(dx: 13, dy: 0) == .right, "przekroczenie progu — od razu")
    #expect(gesture.move(dx: 40, dy: 2) == nil, "ten sam kierunek: serię prowadzi zegar")
    #expect(gesture.reach == 40)
    #expect(gesture.repeatInterval < .milliseconds(Int(TerminalPad.intervalMaxMs)))
    #expect(gesture.move(dx: -20, dy: 0) == .left, "zwrot w osi — od razu")
    gesture.end()
    #expect(gesture.direction == nil && gesture.reach == 0)
  }
}

@Suite("terminal: klawiatura sprzętowa (wektory PWA)")
struct TerminalKeyMapTests {
  private func key(
    _ input: String, cmd: Bool = false, ctrl: Bool = false, alt: Bool = false, shift: Bool = false
  ) -> TerminalHardwareKey {
    TerminalHardwareKey(input, command: cmd, control: ctrl, option: alt, shift: shift)
  }

  @Test("Cmd+C = Kopiuj, Cmd+Y = Historia, Cmd+V = Wklej, Cmd+X = „×” terminala; w obu wielkościach litery")
  func actions() {
    #expect(TerminalKeyMap.resolve(key("x", cmd: true)) == .action(.close))
    #expect(TerminalKeyMap.resolve(key("X", cmd: true)) == .action(.close))
    #expect(TerminalKeyMap.resolve(key("x", cmd: true, shift: true)) == nil, "Cmd+Shift+X nie zamyka i nie jest Meta")
    #expect(TerminalKeyMap.resolve(key("c", cmd: true)) == .action(.copy))
    #expect(TerminalKeyMap.resolve(key("C", cmd: true)) == .action(.copy))
    #expect(TerminalKeyMap.resolve(key("y", cmd: true)) == .action(.history))
    #expect(TerminalKeyMap.resolve(key("Y", cmd: true)) == .action(.history))
    #expect(TerminalKeyMap.resolve(key("v", cmd: true)) == .action(.paste))
  }

  @Test("Cmd+K czyści ekran bajtem Ctrl+L (jak `clear` w powłoce); Cmd+Shift+K zostaje Meta")
  func clear() {
    #expect(TerminalKeyMap.resolve(key("k", cmd: true)) == .bytes("\u{0C}"))
    #expect(TerminalKeyMap.resolve(key("K", cmd: true)) == .bytes("\u{0C}"))
    #expect(TerminalKeyMap.resolve(key("k", cmd: true, shift: true)) == .bytes(esc + "K"))
    #expect(TerminalKeyMap.resolve(key("k", cmd: true, ctrl: true)) == nil)
  }

  @Test("bez Cmd nie ma akcji — Ctrl+C zostaje SIGINT-em (bajt robi SwiftTerm)")
  func noCommand() {
    #expect(TerminalKeyMap.resolve(key("c")) == nil)
    #expect(TerminalKeyMap.resolve(key("c", ctrl: true)) == nil)
  }

  @Test("Shift, Alt i Ctrl z Cmd odsiewają akcję i Meta")
  func filtered() {
    #expect(TerminalKeyMap.resolve(key("c", cmd: true, shift: true)) == nil)
    #expect(TerminalKeyMap.resolve(key("y", cmd: true, shift: true)) == nil)
    #expect(TerminalKeyMap.resolve(key("y", cmd: true, alt: true)) == nil)
    #expect(TerminalKeyMap.resolve(key("c", cmd: true, ctrl: true)) == nil)
    #expect(TerminalKeyMap.resolve(key("d", cmd: true, alt: true)) == nil)
  }

  @Test("Cmd+litera → Meta z wielkością litery; poza [bcfglnuvxy]")
  func meta() {
    #expect(TerminalKeyMap.resolve(key("d", cmd: true)) == .bytes(esc + "d"))
    #expect(TerminalKeyMap.resolve(key("a", cmd: true)) == .bytes(esc + "a"))
    #expect(TerminalKeyMap.resolve(key("d", cmd: true, shift: true)) == .bytes(esc + "D"))
    // The app has no Cmd+S shortcut, so Meta+s and Meta+S go to the shell.
    #expect(TerminalKeyMap.resolve(key("s", cmd: true)) == .bytes(esc + "s"))
    #expect(TerminalKeyMap.resolve(key("s", cmd: true, shift: true)) == .bytes(esc + "S"))
    for letter in ["b", "f", "g", "l", "n", "u"] {
      #expect(TerminalKeyMap.resolve(key(letter, cmd: true)) == nil, "Cmd+\(letter) zostaje apce")
      #expect(TerminalKeyMap.resolve(key(letter, cmd: true, shift: true)) == nil, "Cmd+Shift+\(letter) zostaje apce")
    }
    #expect(TerminalKeyMap.appLetters == ["b", "c", "f", "g", "l", "n", "u", "v", "x", "y"])
    #expect(TerminalKeyMap.resolve(key("ą", cmd: true)) == nil, "litera narodowa to nie Meta")
  }

  @Test("sam Esc w wejściu do programu: bajt ESC i kodowania protokołu kitty; inne sekwencje — nie")
  func escapeInput() {
    for text in ["\(esc)", "\(esc)[27u", "\(esc)[27;9u", "\(esc)[27;1:3u", "\(esc)[27;9:2u", "\(esc)[27;;27u"] {
      #expect(TerminalKeyMap.isEscapeInput(text), "\(text.dropFirst())")
    }
    for text in ["", "x", "\(esc)\(esc)", "\(esc)[A", "\(esc)OH", "\(esc)[5~", "\(esc)d", "\(esc)[270u", "\(esc)[27;9~",
                 "\(esc)[13;9u", "\(esc)[27;9u\(esc)[A"] {
      #expect(!TerminalKeyMap.isEscapeInput(text), "\(text.dropFirst())")
    }
  }

  @Test("Cmd+cyfra zostaje paskowi zakładek")
  func digits() {
    for digit in ["1", "5", "9"] { #expect(TerminalKeyMap.resolve(key(digit, cmd: true)) == nil) }
  }

  @Test("Cmd+. = Esc; Cmd+←/→ = Home/End jako ESC O H/F; Cmd+↑/↓ = PageUp/PageDown; z Shiftem — system")
  func commandKeys() {
    #expect(TerminalKeyMap.resolve(key(".", cmd: true)) == .bytes(esc))
    #expect(TerminalKeyMap.resolve(key(TerminalKeyMap.leftArrow, cmd: true)) == .bytes(esc + "OH"))
    #expect(TerminalKeyMap.resolve(key(TerminalKeyMap.rightArrow, cmd: true)) == .bytes(esc + "OF"))
    #expect(TerminalKeyMap.resolve(key(TerminalKeyMap.upArrow, cmd: true)) == .bytes(esc + "[5~"))
    #expect(TerminalKeyMap.resolve(key(TerminalKeyMap.downArrow, cmd: true)) == .bytes(esc + "[6~"))
    for arrow in [TerminalKeyMap.leftArrow, TerminalKeyMap.rightArrow, TerminalKeyMap.upArrow, TerminalKeyMap.downArrow] {
      #expect(TerminalKeyMap.resolve(key(arrow, cmd: true, shift: true)) == nil)
    }
  }

  @Test("klawisze programu: Home/End jako ESC O H/F (zsh nie zna CSI), PageUp/PageDown, Esc, Return, Tab, Shift+Tab")
  func programKeys() {
    #expect(TerminalKeyMap.resolve(key(TerminalKeyMap.home)) == .bytes(esc + "OH"))
    #expect(TerminalKeyMap.resolve(key(TerminalKeyMap.end)) == .bytes(esc + "OF"))
    #expect(TerminalKeyMap.resolve(key(TerminalKeyMap.pageUp)) == .bytes(esc + "[5~"))
    #expect(TerminalKeyMap.resolve(key(TerminalKeyMap.pageDown)) == .bytes(esc + "[6~"))
    #expect(TerminalKeyMap.resolve(key(TerminalKeyMap.escape)) == .bytes(esc))
    #expect(TerminalKeyMap.resolve(key("\r")) == .bytes("\r"))
    #expect(TerminalKeyMap.resolve(key("\t")) == .bytes("\t"))
    #expect(TerminalKeyMap.resolve(key("\t", shift: true)) == .bytes(esc + "[Z"))
    #expect(TerminalKeyMap.resolve(key(TerminalKeyMap.home, shift: true)) == nil)
    #expect(TerminalKeyMap.resolve(key("a")) == nil, "zwykła litera należy do SwiftTerm")
  }

  @Test("rejestrowane skróty: bez Cmd+C/Cmd+V (idą akcjami copy:/paste:), bez liter apki i cyfr; każdy ma bajty, Historię albo „×”")
  func registered() {
    let commands = TerminalKeyMap.commands
    #expect(Set(commands).count == commands.count, "bez powtórek")
    for command in commands {
      #expect(TerminalKeyMap.resolve(command) != nil, "\(command.input) zarejestrowany bez decyzji")
      #expect(TerminalKeyMap.resolve(command) != .action(.copy) && TerminalKeyMap.resolve(command) != .action(.paste))
    }
    #expect(commands.contains(key("y", cmd: true)))
    #expect(commands.contains(key("x", cmd: true)))
    #expect(!commands.contains { $0.command && TerminalKeyMap.appLetters.subtracting(["x", "y"]).contains($0.input) })
    #expect(!commands.contains { $0.command && Int($0.input) != nil })
    // 16 liter Meta (U zostaje apce), każda także z Shiftem, plus Esc, Return, Tab, Shift+Tab,
    // Cmd+., cztery strzałki, Cmd+Y i Cmd+X.
    #expect(commands.count == 16 * 2 + 11)
  }
}

@Suite("terminal: jeden `rs` na ustalony układ")
struct ResizeSettlerTests {
  /// Oczekiwany wynik ciszy: siatka (`nil` poza 1…1000) i `force`.
  private func rs(_ cols: Int, _ rows: Int, force: Bool = false) -> ResizeSettler.Settled? {
    TerminalGrid(cols: cols, rows: rows).map { ResizeSettler.Settled(grid: $0, force: force) }
  }

  @Test("seria zmian → ustala się WYŁĄCZNIE ostatnia, raz")
  func lastWins() {
    var settler = ResizeSettler()
    let first = settler.propose(cols: 104, rows: 36)
    let second = settler.propose(cols: 151, rows: 12)
    let third = settler.propose(cols: 151, rows: 40)
    #expect(settler.settled(first, sceneActive: true) == nil)
    #expect(settler.settled(second, sceneActive: true) == nil)
    #expect(settler.settled(third, sceneActive: true) == rs(151, 40))
  }

  @Test("siatka spoza 1…1000 (tło: zero wierszy) i nieaktywna scena nie dają `rs`")
  func gate() {
    var settler = ResizeSettler()
    let zero = settler.propose(cols: 104, rows: 0)
    #expect(settler.settled(zero, sceneActive: true) == nil)
    let huge = settler.propose(cols: 1001, rows: 40)
    #expect(settler.settled(huge, sceneActive: true) == nil)
    let fine = settler.propose(cols: 1000, rows: 1)
    #expect(settler.settled(fine, sceneActive: false) == nil)
    #expect(settler.settled(fine, sceneActive: true) == rs(1000, 1))
  }

  @Test("ponowny `rs` przy fokusie: bieżący rozmiar, tylko na aktywnej scenie i po pierwszym układzie")
  func reassert() {
    var settler = ResizeSettler()
    #expect(settler.current(sceneActive: true) == nil, "przed układem")
    _ = settler.propose(cols: 80, rows: 24)
    #expect(settler.current(sceneActive: true) == TerminalGrid(cols: 80, rows: 24))
    #expect(settler.current(sceneActive: false) == nil)
    #expect(ResizeSettler.quiet == .milliseconds(250))
  }

  @Test("fokus bez zmiany układu → po ciszy JEDEN `rs` z `force`, z tą samą siatką")
  func focusAlone() {
    var settler = ResizeSettler()
    let layout = settler.propose(cols: 80, rows: 24)
    #expect(settler.settled(layout, sceneActive: true) == rs(80, 24))
    let focus = settler.reassert()
    #expect(settler.settled(layout, sceneActive: true) == nil, "fokus przedłuża ciszę")
    #expect(settler.settled(focus, sceneActive: true) == rs(80, 24, force: true))
    let next = settler.propose(cols: 80, rows: 12)
    #expect(settler.settled(next, sceneActive: true) == rs(80, 12), "`force` idzie z jednym `rs`")
  }

  @Test("fokus, potem klawiatura zmienia układ w ciszy → jeden `rs` z `force` z siatką PO klawiaturze")
  func focusThenKeyboard() {
    var settler = ResizeSettler()
    _ = settler.propose(cols: 80, rows: 40)
    let focus = settler.reassert()
    let keyboard = settler.propose(cols: 80, rows: 22)
    #expect(settler.settled(focus, sceneActive: true) == nil, "bez `rs` ze starą siatką")
    #expect(settler.settled(keyboard, sceneActive: true) == rs(80, 22, force: true))
  }

  @Test("fokus na nieaktywnej scenie: nic nie wychodzi, `force` czeka; przy siatce spoza 1…1000 `force` przepada")
  func focusGate() {
    var settler = ResizeSettler()
    _ = settler.propose(cols: 80, rows: 24)
    let inactive = settler.reassert()
    #expect(settler.settled(inactive, sceneActive: false) == nil)
    #expect(settler.forced, "`force` czeka na aktywną scenę")
    let after = settler.reassert()
    #expect(settler.settled(after, sceneActive: true) == rs(80, 24, force: true))
    #expect(!settler.forced)
    let zero = settler.propose(cols: 80, rows: 0)
    let focus = settler.reassert()
    #expect(settler.settled(zero, sceneActive: true) == nil)
    #expect(settler.settled(focus, sceneActive: true) == nil)
  }
}

@Suite("terminal: linia stanu i „×”")
struct TerminalStatusTests {
  @Test("każdy stan ma zdanie i drogę dalej; przejęcie przez obcy kontroler = zdanie serwera + „Spróbuj od nowa”")
  func sentences() {
    #expect(TerminalStatus.of(.live) == TerminalStatus(sentence: nil, action: nil))
    #expect(TerminalStatus.of(.idle).sentence == nil)
    #expect(TerminalStatus.of(.suspended).sentence == nil)
    #expect(TerminalStatus.of(.connecting) == TerminalStatus(sentence: "Łączę…", action: nil))
    #expect(TerminalStatus.of(.reconnecting(attempt: 2)) == TerminalStatus(sentence: "Łączę ponownie…", action: nil))
    #expect(TerminalStatus.of(.exited) == TerminalStatus(sentence: "Powłoka zakończona.", action: .restart))
    #expect(TerminalStatus.of(.missing) == TerminalStatus(sentence: "Tego terminala już nie ma.", action: nil))
    let takenOver = TerminalStatus.of(.failed(.server("Terminal przejął inny kontroler.")))
    #expect(takenOver == TerminalStatus(sentence: "Terminal przejął inny kontroler.", action: .retry))
    #expect(TerminalStatus.of(.failed(.server(nil))) == TerminalStatus(sentence: "Terminal przestał odpowiadać.", action: .retry))
    #expect(TerminalStatus.of(.failed(.incompatible("Zaktualizuj apkę."))) == TerminalStatus(sentence: "Zaktualizuj apkę.", action: nil))
    #expect(TerminalStatus.of(.failed(.unauthorized)).action == nil)
    #expect(TerminalStatus.of(.failed(.newTerminalUnconfirmed)).action == .retry)
    #expect(TerminalStatusAction.restart.title == "Uruchom ponownie")
    #expect(TerminalStatusAction.retry.title == "Spróbuj od nowa")
  }

  @Test("„×”: pierwsze naciśnięcie uzbraja na 5 s, drugie w oknie zamyka; po oknie — znów uzbraja")
  func closeArm() {
    let start = Date(timeIntervalSince1970: 1_000)
    var arm = TerminalCloseArm()
    #expect(arm.press(now: start) == false)
    #expect(arm.isArmed(now: start.addingTimeInterval(4.9)))
    #expect(arm.press(now: start.addingTimeInterval(4.9)) == true)
    #expect(!arm.isArmed(now: start.addingTimeInterval(5)))
    #expect(arm.press(now: start.addingTimeInterval(10)) == false)
    #expect(arm.press(now: start.addingTimeInterval(15.1)) == false, "okno minęło — znów tylko uzbraja")
    arm.disarm()
    #expect(!arm.isArmed(now: start.addingTimeInterval(15.2)))
    #expect(TerminalCloseArm.window == 5)
  }

  @Test("wklejka: zdanie dla każdego losu poza „w drodze”; sufit z kontraktu")
  func pasteOutcome() {
    #expect(UICopy.terminalPasteOutcome(.queued) == nil)
    #expect(UICopy.terminalPasteOutcome(.empty) == "Schowek jest pusty.")
    #expect(UICopy.terminalPasteOutcome(.notConnected) == UICopy.terminalPasteOffline)
    #expect(UICopy.terminalPasteOutcome(.tooLarge) == "Wklejka za duża — terminal przyjmuje naraz do 512\u{00A0}kB. Nic nie wysłano.")
    #expect(TerminalFontSize.points(pad: true) == 13 && TerminalFontSize.points(pad: false) == 11)
  }
}
