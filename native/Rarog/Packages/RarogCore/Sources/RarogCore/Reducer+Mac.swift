import Foundation
import RarogContract

// Obciążenie Maca w stopce listy. Gałąź reduktora wołana z głównego `switch` w `Reducer.swift`; odczyty,
// termin ważności i bramkę „serwer zna trasę" prowadzi `RarogStore+Mac` w jednym harmonogramie z limitami.

/// Stan linii Maca w stopce. Liczby żyją ``UsageTiming/macTTL`` od ostatniego UDANEGO odczytu (także po powrocie
/// z tła): potem szkielet, nie stare liczby — Mac zmienia się co sekundę, a liczba sprzed kwadransa podana jak
/// bieżąca kłamałaby bardziej niż limit planu.
public struct MacLoadState: Sendable, Equatable {
  public enum Phase: Sendable, Equatable {
    /// Pierwszy odczyt w drodze — szkielet.
    case loading
    /// Bez liczb: odczyt padł, liczby się przeterminowały albo serwer nic nie wie (`{}`) — szkielet bez pulsu.
    case unavailable
    /// Liczby z ostatniego odczytu.
    case ready
    /// Liczby są (w terminie ważności), ale ostatnie odświeżenie padło — znak zegara i notka w panelu.
    case stale
    /// Serwer nie zna trasy (404, starszy serwer): linii Maca nie ma.
    case unsupported
  }

  /// Ostatni udany odczyt w terminie ważności (może być pusty `{}`); `nil` = żadnego albo po terminie.
  public internal(set) var load: MacLoad?
  /// Kiedy przyszedł ostatni udany odczyt — od niego liczy się termin ważności i godzina w notce panelu.
  public internal(set) var receivedAt: Date?
  /// Ostatni odczyt padł (sieć, 5xx, odpowiedź spoza kontraktu).
  public internal(set) var refreshFailed = false
  /// Ostatnia odpowiedź to 404: serwer nie ma funkcji. Rdzeń nie pyta ponownie aż do innego `serverStartId`
  /// (aktualizacja serwera) albo nowego logowania — bez pętli błędów do starego serwera.
  public internal(set) var unsupported = false
  /// `serverStartId` z chwili 404 (`nil`, gdy odczyt wyprzedził `hello`).
  public internal(set) var unsupportedServer: String?
  /// Był już jakikolwiek wynik odczytu w tym zalogowaniu (odróżnia „ładuję" od „niedostępne").
  public internal(set) var settled = false

  public init() {}

  public var phase: Phase {
    if unsupported { return .unsupported }
    guard let load, !load.isEmpty else { return settled ? .unavailable : .loading }
    return refreshFailed ? .stale : .ready
  }
}

/// Wynik odczytu `GET /api/mac` albo upływ terminu ważności.
public enum MacLoadEvent: Sendable, Equatable {
  /// 200 — liczby (także `{}`); `at` = chwila odbioru.
  case loaded(MacLoad, at: Date)
  /// Sieć, limit czasu, 5xx, odpowiedź spoza kontraktu — liczby zostają do terminu ważności.
  case failed
  /// 404 — starszy serwer; `serverStartId` z chwili odpowiedzi.
  case unsupported(serverStartId: String?)
  /// Minął termin ważności ostatniego udanego odczytu — liczby znikają (szkielet).
  case expired
}

extension AppState {
  mutating func applyMac(_ event: MacLoadEvent) {
    switch event {
    case let .loaded(load, at):
      macLoad.load = load
      macLoad.receivedAt = at
      macLoad.refreshFailed = false
      macLoad.unsupported = false
      macLoad.unsupportedServer = nil
      macLoad.settled = true
    case .failed:
      macLoad.refreshFailed = true
      macLoad.settled = true
    case let .unsupported(server):
      macLoad = MacLoadState()
      macLoad.unsupported = true
      macLoad.unsupportedServer = server
      macLoad.settled = true
    case .expired:
      macLoad.load = nil
      macLoad.refreshFailed = false
      macLoad.settled = true
    }
  }
}
