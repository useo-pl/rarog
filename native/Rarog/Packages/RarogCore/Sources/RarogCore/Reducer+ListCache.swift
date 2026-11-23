import Foundation
import RarogContract

// Lista z pamięci podręcznej przy zimnym starcie. Właściciel: łączność.
// Dysk: `SnapshotCache`; akcje magazynu: `RarogStore+Cache`; selektory: `Selectors+Stale`.

/// Stan listy z pamięci podręcznej. Pusty = lista świeża albo jeszcze żadnej nie było.
public struct ListCacheState: Sendable, Equatable {
  /// Chwila, w której lista z pamięci była ostatnio świeża (zapis pliku); `nil` = lista nie z pamięci.
  /// Gaśnie WYŁĄCZNIE przy pierwszym `sessions-snapshot` ze strumienia i przy wylogowaniu.
  public var staleSince: Date?
  /// Sesje z cache czekające jeszcze na pierwszy świeży transkrypt. Stan listy nie jest
  /// dowodem przeczytania wyniku; wpis Codexa ma tylko stan i nie potrzebuje transkryptu.
  public var awaitingTranscripts: Set<String> = []
  /// Ostatni potwierdzony obraz listy, używany przy zapisie po utracie sieci (TTL bez odmładzania).
  public var confirmedAt: Date?

  public init() {}
}

/// Zdarzenia pamięci podręcznej listy (gałąź `CoreEvent.listCache`).
public enum ListCacheEvent: Sendable, Equatable {
  /// Odczyt pliku przy starcie z kluczem: lista sprzed uśpienia, rysowana jako nieświeża.
  case restored(CachedList)
}

extension AppState {
  mutating func applyListCache(_ event: ListCacheEvent) {
    switch event {
    case let .restored(list):
      // Pamięć NIGDY nie przykrywa prawdy: wchodzi tylko przed pierwszym stanem listy ze strumienia
      // i tylko po zalogowaniu. Pustej listy nie pokazujemy — „nie wiem" nie może wyglądać jak „pusto".
      guard auth == .loggedIn, !sessionsLoaded, !list.sessions.isEmpty else { return }
      sessions = Dictionary(list.sessions.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
      sessionsLoaded = true
      listCache.staleSince = list.savedAt
      listCache.awaitingTranscripts = Set(list.sessions.filter(\.showsTranscript).map(\.id))
      listCache.confirmedAt = list.savedAt
    }
  }
}
