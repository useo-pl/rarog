import Foundation
import RarogContract

// Bramki nieświeżej listy. Właściciel: łączność.
//
// Lista z pamięci podręcznej to obraz sprzed uśpienia: wolno go CZYTAĆ, nie wolno na nim DZIAŁAĆ.
// Do pierwszego świeżego `sessions-snapshot`: zero kart decyzji (strumień sesji nie startuje, karta
// „dialog w terminalu" nie staje), pole wiadomości wygaszone, karta stanu bez akcji, bez Stopu
// i bez automatycznego „obejrzane". Mutacja, która mimo to wyjdzie (skrót,
// arkusz), czeka w bramce transportu na świeży stan (`MutationRules`) — granicą i tak jest serwer.
// Selektory obszarów pytają o ``AppState/listStale`` jedną linią w swoich plikach.
extension AppState {
  /// Lista pochodzi z pamięci podręcznej, a świeżego stanu jeszcze nie ma.
  public var listStale: Bool { listCache.staleSince != nil }

  /// Sesja odtworzona z cache: bez akcji i odbioru wyniku do listy ORAZ pierwszego transkryptu.
  public func sessionStale(_ sessionId: String) -> Bool {
    listStale || listCache.awaitingTranscripts.contains(sessionId)
  }

  /// Najświeższy `stateSince` wśród sesji bez kontaktu ze źródłem (`stale`) — do zdania „stany sprzed X"
  /// na banerze herdr (`herdrStaleSince` w PWA). Maksimum, nie minimum: baner mówi, jak
  /// stara jest NAJLEPSZA rzecz, którą wiemy; panel bezczynny od weekendu byłby prawdą o jednej karcie.
  public var herdrStaleSince: String? {
    var best: (at: Date, raw: String)?
    for session in sessions.values where session.stale == true {
      guard let at = ISOTime.parse(session.stateSince), at > best?.at ?? .distantPast else { continue }
      best = (at, session.stateSince)
    }
    return best?.raw
  }
}
