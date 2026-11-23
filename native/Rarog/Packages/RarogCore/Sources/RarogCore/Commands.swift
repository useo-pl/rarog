import Foundation
import RarogContract

// Slash-komendy oglądanej sesji do podpowiedzi po „/” nad polem wiadomości: stan, zdarzenia,
// gałąź reduktora wołana z głównego `switch` w `Reducer.swift` i selektory. Odczyt `GET /api/sessions/<id>/commands`,
// jego rytm i odświeżenie po odmowie wysyłki prowadzi `RarogStore+Commands`. Lista to ta sama migawka katalogu,
// którą serwer sprawdza wysyłkę, więc apka nie zgaduje komend sama. Właściciel: pole.

/// Lista komend JEDNEJ sesji — tej na ekranie. Zmiana oglądanej sesji i logowanie czyszczą ją (inna sesja ma inny
/// katalog i inną listę).
public struct CommandListState: Sendable, Equatable {
  /// Sesja, której listę trzymamy; `nil` = żadnej.
  public internal(set) var sessionId: String?
  /// Ostatnia odpowiedź serwera (także ``CommandList/unavailable``: serwer bez trasy, 404, 400, zły kształt);
  /// `nil` = jeszcze żadnej.
  public internal(set) var list: CommandList?
  /// Chwila tej odpowiedzi — od niej liczy się ``CommandListTiming/refresh`` do następnego odczytu.
  public internal(set) var answeredAt: Date?
  /// Serwer odmówił (400) wysyłki tekstu-komendy tej sesji: katalog mógł się zmienić, następny odczyt bez czekania.
  public internal(set) var stale = false
  /// Licznik odmów tej sesji. Odczyt zapamiętuje go na starcie: odpowiedź odczytu, który wyszedł PRZED odmową,
  /// nie gasi `stale` (inaczej wcześniejszy GET kasowałby późniejsze unieważnienie).
  public internal(set) var refusals = 0

  public init() {}
}

/// Zdarzenie listy komend — jedna pozycja `CoreEvent.commands`.
public enum CommandListEvent: Sendable, Equatable {
  /// Odpowiedź serwera (pusta lista przy błędzie, którego nie warto ponawiać co znak). Spóźniona odpowiedź sesji,
  /// która już nie stoi na ekranie, przepada. `refusals` = ``CommandListState/refusals`` z chwili wyjścia żądania.
  case loaded(sessionId: String, CommandList, at: Date, refusals: Int)
  /// Odmowa 400 wysyłki tekstu zaczynającego się od `/` w tej sesji.
  case refused(sessionId: String)
}

/// Rytm listy komend.
public enum CommandListTiming {
  /// Najkrótszy odstęp dwóch odczytów listy tej samej sesji: najwyżej co 60 s.
  public static let refresh: TimeInterval = 60
}

extension AppState {
  mutating func applyCommands(_ event: CommandListEvent) {
    switch event {
    case let .loaded(sessionId, list, at, refusals):
      guard viewedSessionId == sessionId else { return }
      if commands.sessionId != sessionId { commands = CommandListState() }
      commands.sessionId = sessionId
      commands.list = list
      commands.answeredAt = at
      // Odmowa w trakcie odczytu: ta odpowiedź mogła powstać przed nią — lista zostaje nieświeża.
      commands.stale = commands.refusals != refusals
    case let .refused(sessionId):
      guard commands.sessionId == sessionId || viewedSessionId == sessionId else { return }
      if commands.sessionId != sessionId {
        commands = CommandListState()
        commands.sessionId = sessionId
      }
      commands.stale = true
      commands.refusals += 1
    }
  }

  /// Zmiana oglądanej sesji: lista innej sesji znika (`Reducer.swift`, `.viewSession`).
  mutating func forgetCommands(unless sessionId: String?) {
    guard commands.sessionId != sessionId else { return }
    commands = CommandListState()
  }

  /// Komendy do podpowiedzi w tej sesji, w kolejności serwera (po nazwie); pusto = nic do podpowiedzenia.
  public func commandChoices(for sessionId: String) -> [CommandChoice] {
    guard commands.sessionId == sessionId else { return [] }
    return commands.list?.commands ?? []
  }

  /// Czy pora zapytać serwer o listę tej sesji: pierwszy raz, po ``CommandListTiming/refresh`` od ostatniej
  /// odpowiedzi, po odmowie wysyłki komendy albo po cofniętym zegarze.
  public func commandListNeedsRead(_ sessionId: String, now: Date) -> Bool {
    guard commands.sessionId == sessionId, !commands.stale, let at = commands.answeredAt else { return true }
    let age = now.timeIntervalSince(at)
    return age < 0 || age >= CommandListTiming.refresh
  }
}
