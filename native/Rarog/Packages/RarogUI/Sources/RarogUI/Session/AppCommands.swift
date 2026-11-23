import RarogContract
import RarogCore

// Komendy apki: tekst w polu wiadomości, który apka obsługuje SAMA.
// „Wyślij” (przycisk i Return z klawiatury sprzętowej) pyta o nią, zanim cokolwiek wyjdzie
// (`SessionViewController+AppCommands`), więc nie ma żądania, wpisu kolejki ani echa. Serwer dalej odmawia tych nazw
// w wolnym tekście: stary build apki dostaje dzisiejszą odmowę. Model bez UIKit, testowany na macOS
// (`RarogUILogicTests`, `AppCommandsTests`). Właściciel: pole.

/// Komenda apki: nazwa, którą apka przechwytuje przed wysyłką, i to, co otwiera.
struct AppCommand: Equatable, Sendable {
  /// Co komenda otwiera w apce.
  enum Action: Equatable, Sendable {
    /// Dymek „Model i effort” — ten sam, który otwiera stuknięcie w pigułkę modelu (`ComposerPills`).
    case modelSheet
    /// Arkusz „Limity”: 5 h, tydzień i tydzień per model z godziną odczytu (`UsageSheet`).
    case usageSheet
  }

  /// Nazwa bez ukośnika, małymi literami.
  let name: String
  /// Inne nazwy tej samej komendy (małymi literami, bez ukośnika): rozpoznaje je „Wyślij”, ale na liście podpowiedzi
  /// stoi tylko ``name`` — jak przy komendach serwera, lista nie podaje aliasów. `/cost` i `/stats` to w CLI
  /// aliasy `/usage` (pomiar 2.1.302, `docs/slash-commands.md`).
  var aliases: [String] = []
  let action: Action

  /// JEDYNA lista komend apki. Nowa komenda to wpis tutaj, przypadek ``Action``, jego dopisek w
  /// `UICopy.appCommandNote` i obsługa w `SessionViewController+AppCommands`.
  static let all: [AppCommand] = [
    AppCommand(name: "model", action: .modelSheet),
    AppCommand(name: "effort", action: .modelSheet),
    AppCommand(name: "usage", aliases: ["cost", "stats"], action: .usageSheet),
  ]

  /// Nazwa i aliasy — wszystko, co „Wyślij” przechwyci.
  var names: [String] { [name] + aliases }

  /// Komenda apki, gdy CAŁY tekst pola nią jest: po wiodących białych znakach serwera `/` (ta sama reguła co
  /// ``SlashCommandText`` i podpowiedzi), potem nazwa albo alias z ``all`` bez względu na wielkość liter, a po niej
  /// koniec tekstu albo biały znak i argument. Argument niczego nie zmienia: `/model opus` też tylko otwiera dymek —
  /// wartość ustawia dymek, który mówi o skutku globalnym; `/effort ultracode` i `/effort ultracode off` także,
  /// bo ultracode przełącza grupa „Ultracode” tego dymku. `/modelx`, `tekst /model` i sam `/` to nie komenda
  /// apki.
  static func recognize(_ text: String) -> AppCommand? {
    let scalars = text.unicodeScalars
    guard let slash = scalars.firstIndex(where: { !SlashCommandText.isServerWhitespace($0) }), scalars[slash] == "/"
    else { return nil }
    let rest = scalars[scalars.index(after: slash)...]
    let end = rest.firstIndex(where: SlashCommandText.isServerWhitespace) ?? rest.endIndex
    let name = String(String.UnicodeScalarView(rest[..<end])).lowercased()
    return all.first { $0.names.contains(name) }
  }

  /// Wiersz listy podpowiedzi po „/”: nazwa i dopisek „w apce”. Stuknięcie wstawia `/nazwa ` jak przy każdej
  /// komendzie, a dymek otwiera dopiero „Wyślij” (jedna droga dla palca, Tab i Return).
  var choice: CommandChoice {
    CommandChoice(name: name, kind: .local, source: .builtin, description: UICopy.appCommandNote(action))
  }

  /// Lista podpowiedzi: komendy sesji z serwera i komendy apki, po nazwie małymi literami jak u serwera. Komenda apki
  /// staje przed pierwszą komendą serwera o większej nazwie, więc kolejność serwera zostaje nietknięta. Wpis serwera
  /// o nazwie albo aliasie komendy apki (dziś serwer ich nie zwraca) ustępuje: „Wyślij” i tak by go przechwyciło.
  /// Aliasy na liście nie stoją. Bez listy z serwera (błąd, stary serwer, przed odczytem) zostają same komendy apki —
  /// działają bez niego.
  static func merged(with server: [CommandChoice]) -> [CommandChoice] {
    var out = server.filter { choice in !all.contains { $0.names.contains(choice.name.lowercased()) } }
    for command in all {
      let at = out.firstIndex { $0.name.lowercased() > command.name } ?? out.endIndex
      out.insert(command.choice, at: at)
    }
    return out
  }
}

extension AppCommand {
  /// Co „Wyślij” robi z `/model` i `/effort` — to samo, co stuknięcie w pigułkę modelu.
  enum ModelSheetRoute: Equatable, Sendable {
    /// Dymek otwiera się jak po stuknięciu w pigułkę. `clearsField`: dymek ma wybór, więc pole się czyści. Dymek
    /// zablokowany (tura, sesja przed świeżym stanem, herdr) mówi tylko powód i „Zamknij”, jak przy pigułce — tekst
    /// zostaje w polu do ponownego „Wyślij”, gdy powód minie.
    case open(clearsField: Bool)
    /// Pigułki nie ma (Codex, sesja jeszcze nieznana), więc nie ma dymku: zdanie pod polem, tekst zostaje.
    case explain(String)
  }

  /// Droga komendy dymku modelu dla sesji ekranu. Pigułka modelu stoi przy każdej znanej sesji poza Codexem
  /// (``ModelPillModel/shows(_:)``); sesja bez modelu (`model?`) też otwiera dymek z wyborem.
  static func modelSheetRoute(_ state: AppState, sessionId: String) -> ModelSheetRoute {
    guard let session = state.sessions[sessionId] else { return .explain(UICopy.staleAction) }
    guard ModelPillModel.shows(session) else { return .explain(UICopy.modelBlock(.codex)) }
    return .open(clearsField: state.modelChangeReason(for: sessionId) == nil)
  }
}
