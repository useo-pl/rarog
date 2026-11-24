import Foundation
import RarogContract

// The list cache: read at the start with a key and at every pairing, a fresh list saved, the file deleted at logout.
// Owner: connectivity. The core calls `readListCache()` and `applyRestoredList(_:)` from `start()` and from the
// pairing's login (`switchEndpoint` in `RarogStore+Pairing`), `persistListCache()` when going to the background and
// from the `persistListCache` effect, `clearListCache()` from the `clearCaches` effect.

/// Dysk pamięci podręcznej magazynu i łańcuch jego operacji (po kolei: zapis zlecony przed
/// wylogowaniem nie wyląduje PO skasowaniu).
struct ListCacheDisk {
  var cache: SnapshotCache?
  var chain: Task<Void, Never>?
}

extension RarogStore {
  /// Lista z pliku, jeśli wolno jej zaufać. Czytana PRZED zalogowaniem stanu: pierwsza klatka po
  /// starcie z kluczem rysuje już listę, nie szkielet. Stan zmienia dopiero ``applyRestoredList(_:)``.
  func readListCache() async -> CachedList? {
    guard let cache = listCacheDisk.cache else { return nil }
    let now = clock()
    await listCacheDisk.chain?.value
    return await cache.load(now: now)
  }

  /// Wstawia listę z pamięci jako NIEŚWIEŻĄ — reduktor przyjmie ją wyłącznie przed pierwszym
  /// stanem listy ze strumienia.
  func applyRestoredList(_ list: CachedList?) {
    guard let list else { return }
    dispatch(.listCache(.restored(list)))
  }

  /// Zapis świeżej listy: tylko obraz potwierdzony przez serwer. Lista z pamięci (jeszcze bez
  /// świeżego stanu) nie jest zapisywana — przestemplowanie jej nowym czasem nie pozwoliłoby
  /// jej się zestarzeć. Pusta lista bez żywego strumienia to „nie wiem", nie „pusto" — nie nadpisuje
  /// dobrego pliku. Kolejność listy = ranga: przycinanie do sufitu gubi najmniej pilne sesje.
  func persistListCache() {
    guard let cache = listCacheDisk.cache, state.auth == .loggedIn, state.sessionsLoaded, !state.listStale else { return }
    let sessions = state.sortedSessions
    guard !sessions.isEmpty || state.global == .online else { return }
    // Po utracie sieci zegar zapisu nie może odmłodzić stanu, którego serwer nie potwierdził.
    guard let savedAt = state.listCache.confirmedAt else { return }
    chainListCache { await cache.save(sessions, at: savedAt) }
  }

  /// 401 i wylogowanie: plik znika — także zlecony wcześniej zapis nie wróci po nim.
  func clearListCache() {
    guard let cache = listCacheDisk.cache else { return }
    chainListCache { await cache.clear() }
  }

  /// Czeka, aż zlecone operacje pamięci podręcznej trafią na dysk (testy).
  public func flushListCache() async {
    await listCacheDisk.chain?.value
  }

  private func chainListCache(_ work: @escaping @Sendable () async -> Void) {
    let previous = listCacheDisk.chain
    listCacheDisk.chain = Task {
      await previous?.value
      await work()
    }
  }
}
