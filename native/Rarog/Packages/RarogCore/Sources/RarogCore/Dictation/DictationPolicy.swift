import Foundation

// Trasa dyktowania: który silnik bierze następne stuknięcie mikrofonu. Czyste typy bez skutków;
// wejścia to wybór na urządzeniu (`DictationChoiceStore`), stan Soniox na serwerze (`AppState.sonioxOnServer`)
// i flaga builda `RAROG_VOICE_SONIOX` (`DictationServices.sonioxAllowed`). Apka nigdy sama nie przełącza
// dostawcy: Soniox niedostępny daje ekran wyboru, nie trasę systemową.

/// Wybór dostawcy dyktowania zapisany na urządzeniu.
public enum DictationChoice: String, Sendable, CaseIterable {
  /// Rozpoznawanie mowy Apple.
  case system
  /// Soniox z kluczem krótkotrwałym od serwera użytkownika.
  case soniox
}

/// Czy serwer daje drogę „Soniox przez Twój serwer”.
public enum SonioxServerState: Sendable, Equatable {
  /// Sonda wersji jeszcze nie odpowiedziała.
  case unknown
  case available
  /// Serwer bez klucza, `RAROG_VOICE=0`, tryb recenzji albo odmowa przy mincie w tym procesie serwera.
  case unavailable
}

/// Co zrobi stuknięcie mikrofonu.
public enum DictationRoute: Sendable, Equatable {
  /// Ekran „Dyktowanie”: wybór albo informacja, że Soniox nie jest dostępny.
  case ask(AskReason)
  case system
  case soniox
}

/// Dlaczego stuknięcie otwiera ekran „Dyktowanie”.
public enum AskReason: Sendable, Equatable {
  /// Na tym urządzeniu nikt jeszcze nie wybrał.
  case noChoice
  /// Wybrany Soniox, ale serwer go nie daje albo build go nie pozwala.
  case sonioxUnavailable
}

/// Opcja Soniox na ekranie wyboru.
public enum SonioxOption: Sendable, Equatable {
  /// Build bez Soniox (`RAROG_VOICE_SONIOX = NO`): opcji nie ma.
  case hidden
  /// Serwer jeszcze nie odpowiedział na sondę wersji.
  case checking
  case unavailable
  case available
}

public enum DictationPolicy {
  /// Trasa następnego stuknięcia. Brak wyboru → ekran; systemowe zawsze systemowe; Soniox tylko przy fladze
  /// i serwerze, który go nie odrzucił (`unknown` przepuszcza: mint rozstrzyga).
  public static func route(choice: DictationChoice?, server: SonioxServerState, sonioxAllowed: Bool) -> DictationRoute {
    switch choice {
    case nil:
      return .ask(.noChoice)
    case .system:
      return .system
    case .soniox:
      guard sonioxAllowed, server != .unavailable else { return .ask(.sonioxUnavailable) }
      return .soniox
    }
  }

  public static func sonioxOption(server: SonioxServerState, sonioxAllowed: Bool) -> SonioxOption {
    guard sonioxAllowed else { return .hidden }
    switch server {
    case .unknown: return .checking
    case .unavailable: return .unavailable
    case .available: return .available
    }
  }
}
