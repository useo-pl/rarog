import RarogContract
@testable import RarogUI
import Testing

// Podpowiedzi slash-komend nad polem wiadomości: token, filtr prefiksem, zamiana tokenu
// i maszyna klawiszy (↑/↓, Tab, Return, Esc, IME). Zachowanie w polu z fokusem: `RarogUIKitTests`
// (`CommandSuggestionsKeysTests`), lista po „/” w demo: XCUITest `CommandSuggestionsUITests`. Właściciel: pole.

private let catalog = [
  CommandChoice(name: "claude-api", kind: .prompt, source: .builtin),
  CommandChoice(name: "clear", kind: .local, source: .builtin),
  CommandChoice(name: "code-review", kind: .prompt, source: .builtin),
  CommandChoice(name: "compact", kind: .local, source: .builtin),
  CommandChoice(name: "context", kind: .local, source: .builtin),
  CommandChoice(name: "handoff", kind: .prompt, source: .skill, description: "Zrzut stanu", argumentHint: "[cel]"),
  CommandChoice(name: "pr-review-toolkit:review-pr", kind: .prompt, source: .plugin),
]

private func open(_ text: String, commands: [CommandChoice] = catalog) -> CommandSuggestions {
  var model = CommandSuggestions()
  model.update(text: text, commands: commands, focused: true)
  return model
}

@Suite("podpowiedzi komend po „/” (CommandSuggestions)")
struct CommandSuggestionsTests {
  @Test("token: „/” po wiodących białych znakach serwera do końca pola, bez białego znaku w środku")
  func token() {
    #expect(CommandSuggestions.token(in: "/") == .init(leading: "", name: ""))
    #expect(CommandSuggestions.token(in: "/co") == .init(leading: "", name: "co"))
    #expect(CommandSuggestions.token(in: "  /co") == .init(leading: "  ", name: "co"))
    #expect(CommandSuggestions.token(in: "\u{FEFF}\n/co") == .init(leading: "\u{FEFF}\n", name: "co"), "BOM i nowa linia")
    #expect(CommandSuggestions.token(in: "/pr-review-toolkit:rev") == .init(leading: "", name: "pr-review-toolkit:rev"))
    #expect(CommandSuggestions.token(in: "/compact ") == nil, "spacja po nazwie zamyka")
    #expect(CommandSuggestions.token(in: "/compact\n") == nil, "nowa linia po nazwie zamyka")
    #expect(CommandSuggestions.token(in: "/compact\u{3000}") == nil, "spacja ideograficzna (Zs) też")
    #expect(CommandSuggestions.token(in: "co") == nil)
    #expect(CommandSuggestions.token(in: "tekst /co") == nil, "ukośnik w środku")
    #expect(CommandSuggestions.token(in: "") == nil)
    #expect(CommandSuggestions.token(in: "\u{85}/co") == nil, "NEL: `trimStart` serwera go nie zdejmuje — to prompt")
  }

  @Test("filtr PREFIKSEM po nazwie, bez względu na wielkość liter, w kolejności serwera, bez rozmytych trafień")
  func prefix() {
    #expect(CommandSuggestions.filter(catalog, prefix: "c").map(\.name)
      == ["claude-api", "clear", "code-review", "compact", "context"])
    #expect(CommandSuggestions.filter(catalog, prefix: "CO").map(\.name) == ["code-review", "compact", "context"])
    #expect(CommandSuggestions.filter(catalog, prefix: "comp").map(\.name) == ["compact"])
    #expect(CommandSuggestions.filter(catalog, prefix: "cmp").isEmpty, "bez rozmytych trafień")
    #expect(CommandSuggestions.filter(catalog, prefix: "review").isEmpty, "środek nazwy się nie liczy")
    #expect(CommandSuggestions.filter(catalog, prefix: "pr-review-toolkit:").map(\.name) == ["pr-review-toolkit:review-pr"])
    #expect(CommandSuggestions.filter(catalog, prefix: "").count == catalog.count, "sam „/” = cała lista")
  }

  @Test("lista stoi tylko z fokusem i trafieniami; spacja, usunięcie „/” i puste pole ją zamykają")
  func openAndClose() {
    #expect(open("/c").isOpen)
    #expect(open("/c").matches.count == 5)
    #expect(open("/").matches.count == catalog.count)
    var model = open("/c")
    model.update(text: "/c", commands: catalog, focused: false)
    #expect(!model.isOpen, "bez fokusu (klawiatura schowana) listy nie ma")
    #expect(!open("/zzz").isOpen, "brak trafień = brak listy, bez komunikatu")
    #expect(!open("/c", commands: []).isOpen, "pusta lista sesji (błąd, stary serwer) = brak listy")
    model = open("/compact")
    model.update(text: "/compact ", commands: catalog, focused: true)
    #expect(!model.isOpen, "spacja po nazwie")
    model.update(text: "compact", commands: catalog, focused: true)
    #expect(!model.isOpen, "usunięty ukośnik")
    model.update(text: "", commands: catalog, focused: true)
    #expect(!model.isOpen, "wysłane: puste pole")
    #expect(CommandSuggestions.visibleRows == 6)
  }

  @Test("↑/↓ przesuwają zaznaczenie w koło; nowy zestaw trafień wraca na pierwszy wiersz, ten sam je trzyma")
  func selection() {
    var action = CommandSuggestions.Action.pass
    var model = open("/c")
    #expect(model.selected == 0)
    action = model.handle(.down, composing: false)
    #expect(action == .moved)
    action = model.handle(.down, composing: false)
    #expect(action == .moved)
    #expect(model.selected == 2)
    action = model.handle(.up, composing: false)
    #expect(action == .moved)
    #expect(model.selected == 1)
    model.update(text: "/c", commands: catalog, focused: true)
    #expect(model.selected == 1, "ten sam zestaw (odświeżona lista, render) trzyma zaznaczenie")
    model.update(text: "/co", commands: catalog, focused: true)
    #expect(model.selected == 0, "inny zestaw zaczyna od pierwszego wiersza")
    action = model.handle(.up, composing: false)
    #expect(action == .moved)
    #expect(model.selected == 2, "↑ z pierwszego idzie na ostatni")
    action = model.handle(.down, composing: false)
    #expect(action == .moved)
    #expect(model.selected == 0, "↓ z ostatniego wraca na pierwszy")
  }

  /// Komendy apki stoją od razu, lista sesji dochodzi chwilę później: nowe wiersze pod otwartą listą nie mogą
  /// przestawić wyboru z klawiatury, bo Return wstawiłby inną komendę.
  @Test("lista sesji dochodzi pod otwartą listą: wiersz wybrany klawiszem zostaje, bez wyboru — pierwszy wiersz")
  func pickSurvivesNewRows() {
    let early = AppCommand.merged(with: [])
    let full = AppCommand.merged(with: catalog)
    var model = open("/", commands: early)
    #expect(model.matches.map(\.name) == ["effort", "model", "usage"])
    _ = model.handle(.down, composing: false)
    #expect(model.picked == "model")
    model.update(text: "/", commands: full, focused: true)
    #expect(model.matches[model.selected].name == "model", "wybór z klawiatury zostaje na nowym miejscu")
    #expect(model.handle(.enter, composing: false) == .insert(.init(from: 0, text: "/model ")))

    var untouched = open("/", commands: early)
    untouched.update(text: "/", commands: full, focused: true)
    #expect(untouched.selected == 0 && untouched.picked == nil, "bez klawisza zaznaczenie stoi na pierwszym wierszu")

    var gone = open("/", commands: full)
    _ = gone.handle(.down, composing: false)
    #expect(gone.picked == "clear")
    gone.update(text: "/", commands: early, focused: true)
    #expect(gone.selected == 0 && gone.picked == nil, "wybrany wiersz zniknął: od pierwszego")

    var typed = open("/", commands: full)
    _ = typed.handle(.down, composing: false)
    typed.update(text: "/c", commands: full, focused: true)
    #expect(typed.selected == 0 && typed.picked == nil, "inny token zdejmuje wybór")
  }

  @Test("Tab i Return wstawiają `/nazwa ` ze spacją w miejsce tokenu; wiodące białe znaki zostają")
  func insert() throws {
    var model = open("  /co")
    _ = model.handle(.down, composing: false)
    guard case let .insert(insertion) = model.handle(.enter, composing: false) else {
      Issue.record("Return przy otwartej liście wstawia")
      return
    }
    #expect(insertion == .init(from: 2, text: "/compact "))
    #expect(insertion.applied(to: "  /co") == "  /compact ")
    var tab = open("/ha")
    let action = tab.handle(.tab, composing: false)
    #expect(action == .insert(.init(from: 0, text: "/handoff ")))
    let wide = open("\u{3000}/cl")
    #expect(wide.insertion(at: 1)?.from == 1, "pozycja w UTF-16, jak `UITextInput`")
    #expect(wide.insertion(at: 1)?.applied(to: "\u{3000}/cl") == "\u{3000}/clear ")
    #expect(open("/c").insertion(at: 9) == nil, "poza listą")
  }

  @Test("pierwszy Return wstawia, drugi idzie dalej (wysyłka): po wstawieniu lista jest zamknięta")
  func secondReturnPasses() throws {
    var model = open("/comp")
    guard case let .insert(insertion) = model.handle(.enter, composing: false) else {
      Issue.record("pierwszy Return wstawia")
      return
    }
    model.update(text: insertion.applied(to: "/comp"), commands: catalog, focused: true)
    #expect(!model.isOpen)
    let action = model.handle(.enter, composing: false)
    #expect(action == .pass, "drugi Return należy do wysyłki")
    #expect(!model.takes(.enter, composing: false))
  }

  @Test("Esc zamyka listę dla tego tokenu; inny token otwiera ją znowu, ten sam po powrocie fokusu nie")
  func escape() {
    var action = CommandSuggestions.Action.pass
    var model = open("/co")
    #expect(model.takes(.escape, composing: false))
    action = model.handle(.escape, composing: false)
    #expect(action == .dismissed)
    #expect(!model.isOpen)
    action = model.handle(.escape, composing: false)
    #expect(action == .pass, "drugi Esc idzie dalej (arbitraż ekranu)")
    model.update(text: "/co", commands: catalog, focused: false)
    model.update(text: "/co", commands: catalog, focused: true)
    #expect(!model.isOpen, "ten sam token po powrocie fokusu zostaje zamknięty")
    model.update(text: "/com", commands: catalog, focused: true)
    #expect(model.isOpen, "dopisana litera otwiera listę znowu")
    var closed = model.dismiss()
    #expect(closed)
    closed = model.dismiss()
    #expect(!closed, "zamkniętej nie ma czego zamykać")
    model.update(text: "/co", commands: catalog, focused: true)
    #expect(model.isOpen, "Backspace to inny token")
  }

  @Test("przy zamkniętej liście i w trakcie składania znaku (IME) żaden klawisz nie należy do listy")
  func passThrough() {
    var action = CommandSuggestions.Action.pass
    var closed = open("tekst")
    var composing = open("/c")
    for key in [CommandSuggestions.Key.up, .down, .tab, .enter, .escape] {
      #expect(!closed.takes(key, composing: false), "\(key) bez listy")
      action = closed.handle(key, composing: false)
      #expect(action == .pass)
      #expect(!composing.takes(key, composing: true), "\(key) w trakcie IME")
      action = composing.handle(key, composing: true)
      #expect(action == .pass)
    }
    #expect(composing.isOpen && composing.selected == 0, "IME niczego w liście nie przestawił")
  }

  @Test("lista stoi w hierarchii pola, nie w regionie klawiatury, i staje bez animacji")
  func sources() throws {
    let composer = try SessionListSourceTests.code("Session/ComposerView.swift")
    #expect(composer.contains("addSubview(suggestionsView)"))
    for keyboardRegion in ["inputAccessoryView", "inputView ="] {
      #expect(!composer.contains(keyboardRegion), "pole: \(keyboardRegion)")
    }
    let view = try SessionListSourceTests.code("Session/CommandSuggestionsView.swift")
    for motion in ["UIView.animate", "UIViewPropertyAnimator", "animated: true", "CABasicAnimation"] {
      #expect(!view.contains(motion), "lista: \(motion)")
    }
  }
}
