import Foundation
import RarogCore

// Linia stanu ekranu terminala i uzbrojenie „×". Każdy stan
// ma zdanie i drogę dalej: „Powłoka zakończona." z „Uruchom ponownie", błąd serwera (także przejęcie przez
// OBCY kontroler) ze zdaniem serwera i „Spróbuj od nowa" bez samoczynnego łączenia, „Tego terminala już nie
// ma." (wyjście: „×" albo zmiana ekranu). Dwa klienty TEGO SAMEGO Raroga współdzielą terminal — apka nie
// udaje przejęcia. Czyste wartości, testy na macOS (`TerminalStatusTests`). Właściciel: terminal.

/// Przycisk linii stanu: wraca wyłącznie gestem (``TerminalSession/restart()``).
public enum TerminalStatusAction: Sendable, Equatable {
  case restart, retry

  public var title: String {
    switch self {
    case .restart: UICopy.terminalRestart
    case .retry: UICopy.terminalRetry
    }
  }
}

/// Co mówi linia stanu przy danym stanie połączenia.
public struct TerminalStatus: Sendable, Equatable {
  /// Zdanie; `nil` = ekran mówi sam za siebie (linia schodzi).
  public let sentence: String?
  public let action: TerminalStatusAction?

  public static func of(_ phase: TerminalPhase) -> TerminalStatus {
    switch phase {
    // `idle` trwa do pierwszego `start()`, `suspended` — w tle (nikt nie patrzy); powrót to `connecting`.
    case .idle, .live, .suspended: TerminalStatus(sentence: nil, action: nil)
    case .connecting: TerminalStatus(sentence: UICopy.terminalConnecting, action: nil)
    case .reconnecting: TerminalStatus(sentence: UICopy.terminalReconnecting, action: nil)
    case .exited: TerminalStatus(sentence: UICopy.terminalExited, action: .restart)
    case .missing: TerminalStatus(sentence: UICopy.terminalMissing, action: nil)
    case let .failed(failure): of(failure)
    }
  }

  /// `DELETE` bez odpowiedzi: sesja stoi (`idle`), a ekran nie łączy się sam — `POST` założyłby nową powłokę,
  /// gdyby stara już się zakończyła. „Spróbuj od nowa" to świadomy gest, „×" zamyka na pewno.
  /// Wyliczane, nie `let`: zdanie idzie z katalogu języka, więc nie buforujemy go w stałej typu.
  public static var closeUnknown: TerminalStatus { TerminalStatus(sentence: UICopy.terminalCloseUnknown, action: .retry) }

  private static func of(_ failure: TerminalFailure) -> TerminalStatus {
    switch failure {
    // Powód zna SERWER (limit, przejęcie przez obcy kontroler, trzy pady w 30 s) — jego zdanie idzie na ekran.
    case let .server(message): TerminalStatus(sentence: message ?? UICopy.terminalFailed, action: .retry)
    // Niezgodność trwała: zdanie bramki mówi, co zrobić (zaktualizować apkę albo serwer); ponowienie nic nie da.
    case let .incompatible(message): TerminalStatus(sentence: message, action: nil)
    // 401: magazyn wylogowuje, ekran i tak zniknie.
    case .unauthorized: TerminalStatus(sentence: UICopy.deviceKeyRejected, action: nil)
    case .newTerminalUnconfirmed: TerminalStatus(sentence: UICopy.terminalNewUnconfirmed, action: .retry)
    }
  }
}

/// Uzbrojenie „×" terminala: pierwsze naciśnięcie uzbraja na 5 s (jak „×" zakładki sesji), drugie
/// w tym oknie zamyka. Gaśnie przy dezaktywacji sceny i zejściu z ekranu.
public struct TerminalCloseArm: Sendable, Equatable {
  /// To samo okno co `RarogNavigation.closeArmWindow`.
  public static let window: TimeInterval = 5

  public private(set) var until: Date?

  public init() {}

  /// Naciśnięcie „×": `true` = zamknąć TERAZ (drugie w oknie), `false` = właśnie uzbrojone.
  public mutating func press(now: Date) -> Bool {
    if isArmed(now: now) {
      until = nil
      return true
    }
    until = now.addingTimeInterval(Self.window)
    return false
  }

  public func isArmed(now: Date) -> Bool {
    guard let until else { return false }
    return now < until
  }

  public mutating func disarm() { until = nil }
}
