import Foundation
import RarogContract

// Notatki projektu widziane z rdzenia: wyniki odczytu i zapisu oraz bit „ma notatkę” po katalogu. Dokument,
// autozapis, konflikt i szkic na dysku prowadzi model notatek w RarogUI (`ProjectNotes`); rdzeń daje mu żądania
// i sygnały ze strumienia (`notesRevision`, `notesEpoch`). Właściciel: notatki (apka natywna).

/// Dlaczego odczyt albo zapis notatki się nie udał. Rozróżnienie decyduje, co model robi dalej: przy `disabled`
/// i `badCwd` pole staje się tylko do odczytu, przy `refused` i `server` zapis NA PEWNO nie doszedł, a przy
/// `offline`, `timedOut` i `failed` nie wiadomo — tekst mógł trafić na serwer.
public enum NoteFailure: Sendable, Equatable {
  /// 404: notatki wyłączone na serwerze (`RAROG_NOTES=0`).
  case disabled
  /// 400 `cwd-not-allowed`: katalog spoza projektów albo już skasowany. Zdanie serwera.
  case badCwd(String?)
  /// Inna odmowa (4xx, 413, bramka zgodności apki). Zdanie serwera albo bramki.
  case refused(status: Int?, message: String?)
  /// 5xx: serwer nie zapisał (zapis notatek nigdy nie udaje sukcesu).
  case server(String?)
  case offline
  case timedOut
  /// Żądanie przerwane albo odpowiedź spoza kontraktu.
  case failed
  /// 401 (wylogowanie już przeprowadzone przez magazyn).
  case loggedOut

  /// Zapis mógł dojść mimo błędu: tekst trzeba pamiętać jako „wysłany bez potwierdzenia”.
  public var deliveryUnknown: Bool {
    switch self {
    case .offline, .timedOut, .failed: true
    case .disabled, .badCwd, .refused, .server, .loggedOut: false
    }
  }
}

public enum NoteFetchOutcome: Sendable, Equatable {
  case loaded(NotesDoc)
  case failed(NoteFailure)
}

public enum NoteSaveOutcome: Sendable, Equatable {
  case saved(Double)
  /// 409: wersja na serwerze jest inna; `current` to aktualny dokument.
  case conflict(NotesDoc)
  case failed(NoteFailure)
}

extension AppState {
  /// Serwer ma notatki (`notesEnabled` z `GET /api/version`). Bez tego apka nie pokazuje żadnego wejścia,
  /// także przed pierwszą sondą wersji.
  public var notesAvailable: Bool { capabilities?.notes == true }

  /// Czy projekt ma notatkę: `true`/`false` z serwera albo z odczytu apki, `nil` = nie wiadomo (projekt spoza
  /// `notesCwds`, przed sondą).
  public func hasNote(_ cwd: String) -> Bool? {
    notesPresent[ProjectPath.normalized(cwd)]
  }

  /// Licznik zmian notatki katalogu ze strony serwera (``notesRevision``).
  public func noteRevision(_ cwd: String) -> Int {
    notesRevision[ProjectPath.normalized(cwd)] ?? 0
  }
}
