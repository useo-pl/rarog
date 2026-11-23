import RarogContract
import RarogCore

// Podpowiedzi slash-komend nad polem wiadomości — model bez UIKit, testowany na macOS
// (`RarogUILogicTests`). Widok: `CommandSuggestionsView`; klawisze i wstawianie: `ComposerView`. Właściciel: pole.

/// Lista komend sesji przefiltrowana tokenem na początku pola, zaznaczony wiersz i maszyna klawiszy.
///
/// Token to tekst od `/` (po wiodących białych znakach serwera, ``SlashCommandText``) do końca pola — bez białego
/// znaku w środku, więc spacja albo nowa linia po nazwie zamyka listę. Filtr idzie PREFIKSEM po nazwie, bez względu
/// na wielkość liter (serwer porównuje nazwę małymi literami), bez rozmytych trafień i bez aliasów — serwer
/// ich nie przepuszcza i ich nie podaje. Esc zamyka listę dla tego tokenu; inny token otwiera ją znowu.
struct CommandSuggestions: Equatable, Sendable {
  /// Token komendy w polu.
  struct Token: Equatable, Sendable {
    /// Białe znaki przed ukośnikiem (zostają w polu przy wstawieniu).
    let leading: String
    /// Nazwa po ukośniku do końca pola; pusta przy samym „/”.
    let name: String
  }

  /// Klawisze pola, które lista bierze, gdy stoi.
  enum Key: Sendable, Equatable {
    case up, down, tab, enter, escape
  }

  /// Wstawienie wybranej komendy: `/nazwa ` (ze spacją) od początku tokenu do końca pola.
  struct Insertion: Equatable, Sendable {
    /// Początek tokenu w jednostkach UTF-16 (pozycje `UITextInput`).
    let from: Int
    let text: String
  }

  /// Wynik klawisza.
  enum Action: Equatable, Sendable {
    /// Klawisz nie należy do listy — idzie dalej (wysyłka, kursor, przerwanie tury), jak bez listy.
    case pass
    case moved
    case dismissed
    case insert(Insertion)
  }

  /// Ile wierszy widać naraz; reszta przewija się w liście.
  static let visibleRows = 6

  private(set) var token: Token?
  private(set) var matches: [CommandChoice] = []
  private(set) var selected = 0
  /// Pole ma fokus i przyjmuje tekst — bez tego listy nie ma (klawiatura schowana, pole wygaszone).
  private(set) var focused = false
  /// Token, dla którego Esc zamknął listę.
  private var dismissed: Token?
  /// Nazwa wiersza wybranego klawiszem (↑/↓) dla tego tokenu: zostaje wybrana, gdy pod otwartą listą zmienią się
  /// komendy (lista sesji dochodzi po komendach apki, albo się odświeża) — Return wstawia to, co człowiek
  /// zaznaczył. Inny token albo zniknięcie wiersza ją zdejmuje.
  private(set) var picked: String?

  var isOpen: Bool { focused && token != nil && token != dismissed && !matches.isEmpty }

  /// Token komendy w tekście pola albo `nil` (to nie komenda albo po nazwie stoi już biały znak).
  static func token(in text: String) -> Token? {
    let scalars = text.unicodeScalars
    guard let slash = scalars.firstIndex(where: { !SlashCommandText.isServerWhitespace($0) }), scalars[slash] == "/"
    else { return nil }
    let name = scalars[scalars.index(after: slash)...]
    guard !name.contains(where: SlashCommandText.isServerWhitespace) else { return nil }
    return Token(leading: String(scalars[..<slash]), name: String(name))
  }

  /// Komendy, których nazwa zaczyna się od `prefix` (bez względu na wielkość liter), w kolejności serwera.
  static func filter(_ commands: [CommandChoice], prefix: String) -> [CommandChoice] {
    let wanted = prefix.lowercased()
    return commands.filter { $0.name.lowercased().hasPrefix(wanted) }
  }

  /// Nowy stan pola albo listy. Zaznaczenie wraca na pierwszy wiersz, gdy zmienił się zestaw trafień — chyba że
  /// przy tym samym tokenie stoi dalej wiersz wybrany klawiszem (``picked``).
  mutating func update(text: String, commands: [CommandChoice], focused: Bool) {
    let next = Self.token(in: text)
    if next != dismissed { dismissed = nil }
    if next != token { picked = nil }
    let found = next.map { Self.filter(commands, prefix: $0.name) } ?? []
    if let picked, let kept = found.firstIndex(where: { $0.name == picked }) {
      selected = kept
    } else {
      picked = nil
      if found.map(\.name) != matches.map(\.name) { selected = 0 }
    }
    token = next
    matches = found
    self.focused = focused
    selected = min(selected, max(0, found.count - 1))
  }

  /// Czy klawisz należy do listy. W trakcie składania znaku (IME) klawisze zostają edytorowi.
  func takes(_ key: Key, composing: Bool) -> Bool {
    isOpen && !composing
  }

  /// Klawisz przy otwartej liście: ↑/↓ przesuwają zaznaczenie w koło, Tab i Return wstawiają zaznaczoną komendę,
  /// Esc zamyka listę i nic więcej.
  mutating func handle(_ key: Key, composing: Bool) -> Action {
    guard takes(key, composing: composing) else { return .pass }
    switch key {
    case .up:
      selected = (selected - 1 + matches.count) % matches.count
      picked = matches[selected].name
      return .moved
    case .down:
      selected = (selected + 1) % matches.count
      picked = matches[selected].name
      return .moved
    case .tab, .enter:
      return insertion(at: selected).map(Action.insert) ?? .pass
    case .escape:
      dismissed = token
      return .dismissed
    }
  }

  /// Esc z arbitrażu ekranu sesji: zamyka otwartą listę. `false` = listy nie było.
  mutating func dismiss() -> Bool {
    guard isOpen else { return false }
    dismissed = token
    return true
  }

  /// Wstawienie wiersza `index` (stuknięcie albo klawisz).
  func insertion(at index: Int) -> Insertion? {
    guard let token, isOpen, matches.indices.contains(index) else { return nil }
    return Insertion(from: token.leading.utf16.count, text: "/\(matches[index].name) ")
  }
}

extension CommandSuggestions.Insertion {
  /// Tekst pola po wstawieniu (token biegnie do końca pola).
  func applied(to text: String) -> String {
    let utf16 = text.utf16
    let cut = utf16.index(utf16.startIndex, offsetBy: min(from, utf16.count))
    return String(text[..<cut]) + self.text
  }
}
