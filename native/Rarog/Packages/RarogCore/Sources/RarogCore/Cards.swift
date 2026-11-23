import Foundation
import RarogContract

// Karty decyzji i karta stanu: stan obszaru, zdarzenia reduktora i wyniki akcji magazynu
// Zdania składa RarogUI. Właściciel: karty.

/// Stan obszaru kart, który musi przeżyć ekran sesji (pole na końcu `AppState`).
public struct CardsState: Sendable, Equatable {
  /// Sesja założona z TEGO urządzenia w katalogu, którego Claude Code jeszcze nie znał
  /// (`trustPrompt` w odpowiedzi 202). Transkrypt pokazuje ostrzeżenie, że start MOŻE poprosić
  /// o zaufanie. Gaśnie, gdy sesja wyjdzie ze startu albo oczekiwania na decyzję —
  /// wtedy pytania już nie ma (`settleTrustPrompt`).
  public var trustPromptSessionId: String?
  /// Wejście w czekanie na decyzję widziane przez TĘ apkę, po sesji — początek okresu łaski przed kartą
  /// „dialog w terminalu” (``DecisionGraceTiming``). Zmienia wyłącznie reduktor (`noteDecisionWaits`).
  public internal(set) var decisionWaits: [String: DecisionWaitStart] = [:]

  public init() {}
}

/// Okres łaski przed kartą „dialog w terminalu”: stan „czeka” przychodzi
/// strumieniem globalnym od razu po `blocked` z herdr, a karta z treścią strumieniem sesji później (kanał hooka
/// mediana 614 ms, max 1501 ms; ścieżka drivera najwcześniej 800 ms, typowo ok. 1,3 s). Bez okresu łaski karta
/// zapasowa z „Odrzuć dialog” migała przed kartą docelową, a tap w nią przerywał turę agenta (Esc).
public enum DecisionGraceTiming {
  /// Ile czeka zastępnik bez przycisków, zanim stanie karta zapasowa (pomiar: p90 kanału 1,1 s, driver do ok. 2,1 s).
  public static let window: TimeInterval = 2.0
}

/// Jedno czekanie sesji (``SessionSummary/stateSince``) i chwila, od której apka liczy okres łaski: odbiór przejścia
/// na żywo (czas lokalny) albo `stateSince` sesji zastanej z pełnego stanu. `at == nil` = czas niepewny (zegar
/// serwera w przyszłości, nieczytelny `stateSince`) — wtedy okresu łaski nie ma.
public struct DecisionWaitStart: Sendable, Equatable {
  public let stateSince: String
  public let at: Date?
}

/// Zdarzenie obszaru kart — jedna pozycja `CoreEvent.cards`, gałęzie w `Reducer+Decisions`.
public enum CardsEvent: Sendable, Equatable {
  /// Odpowiedź 202 na założenie sesji niosła `trustPrompt: true`.
  case trustPromptArmed(sessionId: String)
}

/// Który dialog pokazuje karta „dialog w terminalu": czekanie sesji (`stateSince`),
/// rodzaj rozpoznanego dialogu i treść karty (powód, wycinek ekranu, klasa z rejestru CLI). Serwer podmienia dialog pod tym
/// samym `stateSince` (nowe `screen-dialog` w tym samym stanie), a `POST …/permission` zatwierdza
/// to, co stoi W CHWILI żądania — więc uzbrojenie i zatwierdzenie wiążą się z tym podpisem, nie z
/// samym czekaniem.
public struct HerdrDialogSignature: Sendable, Equatable, Hashable {
  public let stateSince: String
  public let dialog: KnownDialogID?
  public let reason: RefuseReason?
  public let screen: String?
  public let cliDialog: CliDialogClass?

  public init(_ session: SessionSummary) {
    stateSince = session.stateSince
    dialog = session.herdrDialog
    reason = session.herdrDialogReason
    screen = session.herdrDialogScreen
    cliDialog = session.cliDialog
  }
}

/// Wynik decyzji o dialogu stojącym w panelu (`POST /api/sessions/:id/permission`).
public enum DialogDecisionOutcome: Sendable, Equatable {
  /// Serwer przyjął (`Odrzuć` = Esc do panelu, `Zatwierdź` = opcja twierdząca rozpoznanego dialogu).
  /// Karta zniknie, gdy sesja ruszy dalej — wynik przychodzi strumieniem.
  case accepted
  /// Karty dialogu w chwili naciśnięcia już nie było — nic nie wyszło.
  case notShown
  /// Zatwierdzenie karty, która pokazywała INNY dialog niż ten, który stoi teraz (podpis się
  /// zmienił) — nic nie wyszło; decyzja należy do świeżej karty.
  case changed
  /// Zatwierdzenie dialogu, którego Rarog nie rozpoznał (albo kanał do panelu jest zamknięty).
  case notAllowed
  /// Decyzja o tym dialogu już leci z tego urządzenia.
  case inFlight
  /// Brak połączenia — decyzji nie kolejkujemy.
  case offline
  /// Odmowa serwera (409 „zatwierdź w terminalu", 400 poza zasięgiem, 422 z powodem) albo bramki
  /// klienta — zdanie do pokazania wprost; `nil` = zdanie zapasowe UI.
  case refused(message: String?)
  /// 410: dialog zniknął, zanim decyzja doszła.
  case expired
  case failed
  case loggedOut
}

/// Wynik „Wznów" na karcie stanu.
public enum CardActionOutcome: Sendable, Equatable {
  /// Serwer przyjął; skutek (nowy panel) przychodzi strumieniem.
  case accepted
  /// Akcja nie należy się tej sesji (nie `resumable`, sesji nie ma) — nic nie wyszło.
  case notAllowed
  /// Ta sama akcja tej sesji już leci.
  case inFlight
  /// Odmowa serwera albo bramki klienta, ze zdaniem; `nil` = zdanie zapasowe UI.
  case refused(message: String?)
  case offline
  case timedOut
  case failed
  case loggedOut
}

/// Żądania kart w drodze (pole magazynu `cardRequests`). Wylogowanie anuluje je i podbija numer
/// zalogowania: spóźniony 401 nie wyloguje NOWEGO zalogowania, a wynik sprzed wylogowania nie ma prawa
/// wrócić na ekran.
struct CardRequests {
  var login = 0
  /// Klucz akcji (`perm:<permId>`, `dialog:<sesja>`, `resume:<sesja>`) → anulowanie.
  var cancel: [String: @Sendable () -> Void] = [:]
}
