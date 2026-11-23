import Foundation

/// Wejście w sesję na ekranie bez kontrolera sesji — stan Codexa i terminal Raroga (`ResultViewedReporter`).
/// Ekran zwalnia ręczne „nieprzeczytane” RAZ na wejście, a nie przy każdej zmianie wyniku albo powrocie apki
/// na wierzch. Pamięć żyje między trasami terminali, więc ekran bez agenta (`nil`) ją zeruje — inaczej powrót do tej
/// samej sesji przez goły terminal nie liczyłby się jako nowe wejście.
struct ResultEntryMemory: Equatable {
  private(set) var entered: String?

  /// `true` = to jest nowe wejście w tę sesję (pierwsze od zmiany ekranu).
  mutating func enters(_ sessionId: String?) -> Bool {
    guard let sessionId else {
      entered = nil
      return false
    }
    guard entered != sessionId else { return false }
    entered = sessionId
    return true
  }
}
