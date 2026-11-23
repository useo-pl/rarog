import Foundation

// Klawiatura sprzętowa w terminalu (wektory w `TerminalKeyMapTests`).
// Terminal NIE ZNA klawisza Cmd, więc każdy Cmd albo dostaje bajty (Esc, Home/End, PageUp/PageDown, Ctrl+L, Meta),
// albo akcję paska (Kopiuj, Wklej, Historia), albo „×" ekranu (Cmd+X), albo zostaje apce i systemowi
// (Cmd+B/F/G/L/N/S, cyfry).
//
// Skróty mieszkają w KONTENERZE powierzchni, nie w podklasie widoku SwiftTerm: jej `canPerformAction` jest
// `public`, nie `open`, i odpowiada `false` na każdą akcję spoza edycji — klawisz przepadał.
// Home/End/PageUp/PageDown bez modyfikatorów (fn+strzałki na Magic Keyboard) przechwytuje powierzchnia
// w `pressesBegan`, bo SwiftTerm przewijałby nimi lokalny bufor. Część bez UIKit testuje się na macOS.
// Właściciel: terminal.

/// Klawisz sprzętowy w kształcie `UIKeyCommand`: wejście (znak albo stała UIKit) i modyfikatory.
public struct TerminalHardwareKey: Sendable, Hashable {
  public var input: String
  public var command: Bool
  public var control: Bool
  public var option: Bool
  public var shift: Bool

  public init(_ input: String, command: Bool = false, control: Bool = false, option: Bool = false, shift: Bool = false) {
    self.input = input
    self.command = command
    self.control = control
    self.option = option
    self.shift = shift
  }
}

/// Akcja ekranu wywołana klawiszem (ta sama funkcja co tap w pasek, pozycja menu „⋯" i „×" w pasku nawigacji).
public enum TerminalKeyAction: Sendable, Equatable {
  case copy, paste, history
  /// Cmd+X: „×" terminala, dwa naciśnięcia jak przy zakładce sesji.
  case close
}

/// Co zrobić z klawiszem.
public enum TerminalKeyResolution: Sendable, Equatable {
  /// Bajty do powłoki (tą samą drogą co pisanie).
  case bytes(String)
  case action(TerminalKeyAction)
}

public enum TerminalKeyMap {
  // Wejścia specjalne — wartości stałych `UIKeyCommand.input*` (zgodność pilnuje test na symulatorze).
  public static let upArrow = "UIKeyInputUpArrow"
  public static let downArrow = "UIKeyInputDownArrow"
  public static let leftArrow = "UIKeyInputLeftArrow"
  public static let rightArrow = "UIKeyInputRightArrow"
  public static let escape = "UIKeyInputEscape"
  public static let home = "UIKeyInputHome"
  public static let end = "UIKeyInputEnd"
  public static let pageUp = "UIKeyInputPageUp"
  public static let pageDown = "UIKeyInputPageDown"
  public static let returnKey = "\r"
  public static let tab = "\t"

  /// Litery Cmd, które zostają apce i systemowi (PWA `[bcfglnvxy]`, do tego S i U): B lista, C/V schowek,
  /// F/G okna terminala, L poprzedni projekt, N nowa sesja/terminal, S przełącznik aktywnych sesji, U przeczytane /
  /// nieprzeczytane (agent w terminalu Raroga), X zamknięcie zakładki (tu: terminala), Y historia. Kosztem jest Meta
  /// tych liter z klawiatury sprzętowej — pigułka „Cmd" paska wysyła je dalej.
  public static let appLetters: Set<String> = ["b", "c", "f", "g", "l", "n", "s", "u", "v", "x", "y"]

  /// Home/End w kodowaniu SS3 — tak je zna `xterm-256color` w panelu herdr i tablica zsh użytkownika (CSI
  /// `ESC[H`/`ESC[F` w zsh NIE działa, zmierzone); nvim rozumie oba.
  public static let homeBytes = "\u{1B}OH"
  public static let endBytes = "\u{1B}OF"
  /// PageUp/PageDown (`kpp`/`knp` bez wariantu SS3): w powłoce bezczynne, nvim użytkownika mapuje je na pół strony.
  public static let pageUpBytes = "\u{1B}[5~"
  public static let pageDownBytes = "\u{1B}[6~"
  public static let backTabBytes = "\u{1B}[Z"
  /// Ctrl+L: Cmd+K (clear screen).
  public static let clearScreenBytes = "\u{0C}"

  /// Czy wejście do programu to sam klawisz Esc: bajt ESC albo Esc w protokole klawiatury kitty, którym SwiftTerm
  /// koduje klawisze, gdy program o to poprosi (`ESC[27u`, z modyfikatorami `ESC[27;9u`, z rodzajem zdarzenia —
  /// powtórzenie, puszczenie — `ESC[27;9:3u`). Tak koduje m.in. Claude Code. Pyta o to strażnik przełącznika sesji:
  /// Esc w trakcie jego gestu nie idzie do programu w żadnym kodowaniu.
  public static func isEscapeInput(_ text: String) -> Bool {
    if text == "\u{1B}" { return true }
    guard text.hasPrefix("\u{1B}[27"), text.hasSuffix("u") else { return false }
    let middle = text.dropFirst(4).dropLast()
    return middle.isEmpty || (middle.first == ";" && middle.dropFirst().allSatisfy { $0.isNumber || $0 == ":" || $0 == ";" })
  }

  /// Decyzja dla klawisza; `nil` = klawisz nie należy do terminala jako skrót (litera, Ctrl+…, Option+…
  /// obsługuje SwiftTerm; Cmd+cyfra, Cmd+B/F/G/L/N/S apka; Cmd+Shift+strzałka system).
  public static func resolve(_ key: TerminalHardwareKey) -> TerminalKeyResolution? {
    if key.command { return resolveCommand(key) }
    guard !key.control, !key.option else { return nil }
    switch key.input {
    case tab: return .bytes(key.shift ? backTabBytes : "\t")
    case _ where key.shift: return nil
    case escape: return .bytes("\u{1B}")
    case returnKey: return .bytes("\r")
    case home: return .bytes(homeBytes)
    case end: return .bytes(endBytes)
    case pageUp: return .bytes(pageUpBytes)
    case pageDown: return .bytes(pageDownBytes)
    default: return nil
    }
  }

  private static func resolveCommand(_ key: TerminalHardwareKey) -> TerminalKeyResolution? {
    // Ctrl i Option z Cmd to nie nasza sprawa (Cmd+Ctrl+C nie jest „Kopiuj", Ctrl+C musi zostać SIGINT-em).
    guard !key.control, !key.option else { return nil }
    switch key.input {
    case ".": return key.shift ? nil : .bytes("\u{1B}")  // Cmd+. = Esc Apple (Magic Keyboard nie ma Esc)
    // Shift+Cmd+strzałka to systemowe zaznaczanie.
    case leftArrow: return key.shift ? nil : .bytes(homeBytes)
    case rightArrow: return key.shift ? nil : .bytes(endBytes)
    case upArrow: return key.shift ? nil : .bytes(pageUpBytes)
    case downArrow: return key.shift ? nil : .bytes(pageDownBytes)
    default: break
    }
    let scalars = key.input.unicodeScalars
    guard scalars.count == 1, let scalar = scalars.first, scalar.isASCII, CharacterSet.letters.contains(scalar)
    else { return nil }
    let letter = key.input.lowercased()
    if !key.shift {
      switch letter {
      case "c": return .action(.copy)
      case "v": return .action(.paste)
      case "y": return .action(.history)
      case "x": return .action(.close)
      // Cmd+K = clear screen, as in a Mac terminal: Ctrl+L, which zsh and bash bind to clear-screen (the typed line
      // stays) and full-screen programs to a redraw. The text `clear⏎` would also be typed into nvim or Claude Code.
      case "k": return .bytes(clearScreenBytes)
      default: break
      }
    }
    guard !appLetters.contains(letter) else { return nil }
    // Meta z wielkością litery: M-D i M-d to różne skróty.
    return .bytes("\u{1B}" + (key.shift ? letter.uppercased() : letter))
  }

  /// Strzałka z klawiatury sprzętowej, którą powierzchnia wysyła i powtarza SAMA (``TerminalKeyRepeat``) —
  /// kopia ścieżki legacy SwiftTerm 1.19.0 (`pressesBegan` + `KittyKeyboardEncoder.legacyNavigationSequence`),
  /// żeby bajty nie zmieniły się przy przejęciu powtarzania. `nil` = strzałki nie przejmujemy (Cmd: skróty
  /// kontenera i systemowe zaznaczanie). Option+←/→ to słowo wstecz/naprzód (`ESC b`/`ESC f`, emacs), a
  /// Option+↑/↓ — zwykła strzałka: tak robi SwiftTerm przy `optionAsMetaKey = false` i tak zostaje. Shift
  /// i Ctrl dają `ESC[1;{1+s+4c}X`; bez modyfikatora `ESC[X`, a przy DECCKM (tryb kursorów aplikacji) `ESC O X`.
  public static func arrowBytes(
    direction: PadDirection, shift: Bool = false, control: Bool = false, option: Bool = false,
    command: Bool = false, applicationCursor: Bool = false
  ) -> String? {
    guard !command else { return nil }
    let letter =
      switch direction {
      case .up: "A"
      case .down: "B"
      case .right: "C"
      case .left: "D"
      }
    let plain = applicationCursor ? "\u{1B}O\(letter)" : "\u{1B}[\(letter)"
    if option {
      switch direction {
      case .left: return "\u{1B}b"
      case .right: return "\u{1B}f"
      case .up, .down: return plain
      }
    }
    let modifier = 1 + (shift ? 1 : 0) + (control ? 4 : 0)
    return modifier == 1 ? plain : "\u{1B}[1;\(modifier)\(letter)"
  }

  /// Klawisze, które kontener powierzchni rejestruje jako `UIKeyCommand`. Bez Cmd+C i Cmd+V: te idą
  /// systemowymi akcjami `copy:`/`paste:` (menu Edycja apki), a ich odbiorcą jest powierzchnia albo ekran.
  /// Esc, Return, Tab i Shift+Tab stoją tu, żeby `.cancelAction`/`.defaultAction` i fokus systemu nie
  /// zjadły ich przed terminalem (zestaw sprawdzony na iPadzie z Magic Keyboard).
  public static var commands: [TerminalHardwareKey] {
    var keys: [TerminalHardwareKey] = [
      TerminalHardwareKey(escape),
      TerminalHardwareKey(returnKey),
      TerminalHardwareKey(tab),
      TerminalHardwareKey(tab, shift: true),
      TerminalHardwareKey(".", command: true),
      TerminalHardwareKey(leftArrow, command: true),
      TerminalHardwareKey(rightArrow, command: true),
      TerminalHardwareKey(upArrow, command: true),
      TerminalHardwareKey(downArrow, command: true),
      TerminalHardwareKey("y", command: true),
      TerminalHardwareKey("x", command: true),
    ]
    for value in UInt8(ascii: "a")...UInt8(ascii: "z") {
      let letter = String(UnicodeScalar(value))
      guard !appLetters.contains(letter) else { continue }
      keys.append(TerminalHardwareKey(letter, command: true))
      keys.append(TerminalHardwareKey(letter, command: true, shift: true))
    }
    return keys
  }
}

#if os(iOS)
import UIKit

extension TerminalHardwareKey {
  /// Klawisz z `UIKeyCommand` (wejście i flagi modyfikatorów).
  init(_ command: UIKeyCommand) {
    let flags = command.modifierFlags
    self.init(
      command.input ?? "", command: flags.contains(.command), control: flags.contains(.control),
      option: flags.contains(.alternate), shift: flags.contains(.shift))
  }

  /// The `UIKeyCommand` of this key with the container's action. No title: the iPadOS menu bar names only History
  /// and Close Terminal (Meta for 16 letters would clutter it). The shortcut sheet under a held Cmd lists
  /// its own rows (`ShortcutSheetContent`), not the key commands.
  func keyCommand(action: Selector) -> UIKeyCommand {
    var flags: UIKeyModifierFlags = []
    if command { flags.insert(.command) }
    if control { flags.insert(.control) }
    if option { flags.insert(.alternate) }
    if shift { flags.insert(.shift) }
    let keyCommand = UIKeyCommand(input: input, modifierFlags: flags, action: action)
    keyCommand.wantsPriorityOverSystemBehavior = true
    // Esc bywa decyzją (zamyka historię albo okno powłoki): przytrzymany klawisz nie zamyka kolejnej warstwy
    // i nie sypie bajtami ESC do programu, który został pod spodem.
    if self == TerminalHardwareKey(TerminalKeyMap.escape) { keyCommand.repeatBehavior = .nonRepeatable }
    switch TerminalKeyMap.resolve(self) {
    case .action(.history)?: keyCommand.discoverabilityTitle = UICopy.terminalHistory
    case .action(.close)?: keyCommand.discoverabilityTitle = UICopy.terminalClose
    default: break
    }
    return keyCommand
  }
}

extension TerminalKeyMap {
  /// Klawisz naciśnięcia, który powierzchnia przechwytuje w `pressesBegan` (Home, End, PageUp, PageDown bez
  /// modyfikatorów — fn+strzałki na Magic Keyboard); `nil` = oddać SwiftTerm.
  public static func pressBytes(_ key: UIKey) -> String? {
    let flags = key.modifierFlags.intersection([.command, .control, .alternate, .shift])
    guard flags.isEmpty else { return nil }
    let input: String
    switch key.keyCode {
    case .keyboardHome: input = home
    case .keyboardEnd: input = end
    case .keyboardPageUp: input = pageUp
    case .keyboardPageDown: input = pageDown
    default: return nil
    }
    guard case let .bytes(bytes)? = resolve(TerminalHardwareKey(input)) else { return nil }
    return bytes
  }

  /// Kierunek strzałki z kodu klawisza; `nil` dla każdego innego klawisza.
  public static func arrowDirection(_ keyCode: UIKeyboardHIDUsage) -> PadDirection? {
    switch keyCode {
    case .keyboardUpArrow: .up
    case .keyboardDownArrow: .down
    case .keyboardLeftArrow: .left
    case .keyboardRightArrow: .right
    default: nil
    }
  }

  /// Strzałka z modyfikatorami UIKit → bajty
  /// (``arrowBytes(direction:shift:control:option:command:applicationCursor:)``).
  public static func arrowBytes(
    _ keyCode: UIKeyboardHIDUsage, modifiers: UIKeyModifierFlags, applicationCursor: Bool
  ) -> String? {
    guard let direction = arrowDirection(keyCode) else { return nil }
    return arrowBytes(
      direction: direction, shift: modifiers.contains(.shift), control: modifiers.contains(.control),
      option: modifiers.contains(.alternate), command: modifiers.contains(.command),
      applicationCursor: applicationCursor)
  }
}
#endif
