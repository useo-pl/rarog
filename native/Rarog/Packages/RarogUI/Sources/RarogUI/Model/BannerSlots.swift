import Foundation
import RarogContract
import RarogCore

// Pas banerów w dwóch kolumnach. Właściciel: łączność.
//
// Kolejność z wymagań: niezgodność wersji, połączenie, „Transkrypt nie dochodzi", herdr, pushe.
// Połączenie to JEDNA karta: szara „Łączę z serwerem…”, dopóki żadna próba nie padła,
// potem w tym samym miejscu czerwona „Serwer nie odpowiada” (`ConnectionMemory.connectionCard`).
// The gray card has two sources: the global stream, and the viewed session's stream while the global one is online
// (`ConnectionMemory.sessionStreamCard`); the red one comes only from the global stream.
// Jedna awaria = jeden baner: przy braku serwera herdr, pushe i transkrypt milczą, bo apka nie ma
// o nich świeżej wiedzy. Banery GLOBALNE stoją w jednej kolumnie naraz — w kolumnie listy, a gdy
// listy nie widać (Cmd+B, wąskie okno), w prawej kolumnie; dwie kopie „Serwer nie odpowiada" obok
// siebie to szum, a zero kopii przy schowanej liście to ślepota. Baner transkryptu stoi tylko w prawej
// kolumnie, tylko przy otwartej sesji i tylko wtedy, gdy strumień globalny żyje.

/// Kolumna, która rysuje pas banerów.
public enum BannerColumn: Sendable, Equatable {
  /// Kolumna listy: banery globalne.
  case list
  /// Prawa kolumna: baner transkryptu otwartej sesji, a przy niewidocznej liście także globalne.
  case detail(sessionId: String?, listVisible: Bool)

  var showsGlobals: Bool {
    switch self {
    case .list: true
    case let .detail(_, listVisible): !listVisible
    }
  }
}

extension AppState {
  /// Banery jednej kolumny w kolejności z nagłówka pliku.
  /// - Parameters:
  ///   - global: pamięć strumienia globalnego (próba padła, a połączenia dalej nie ma = brak serwera).
  ///   - transcript: pamięć strumienia transkryptu otwartej sesji — ta sama reguła, więc baner nie
  ///     mruga przy każdej próbie ponownego połączenia. Every column that shows the global banners needs it: a
  ///     session stream that does not come online gives the gray card there (``ConnectionMemory/sessionStreamCard``).
  /// Karta łączenia (szara) stoi od swojej chwili `visibleFrom`: pas filtruje ją zegarem (`visible(at:)`).
  public func banners(in column: BannerColumn, global: ConnectionMemory, transcript: ConnectionMemory) -> [Banner] {
    let card = global.connectionCard
    let serverDown = card == .serverUnreachable
    var out: [Banner] = []
    if column.showsGlobals {
      switch compat {
      case .tooOld, .protocolMismatch: out.append(.incompatible(compat))
      case .unknown, .ok: break
      }
      if let card {
        out.append(card)
      } else if self.global == .online, viewedSessionId != nil,
        let sessionCard = transcript.sessionStreamCard(globalOnlineSince: global.onlineSince)
      {
        // The list arrives but the viewed session's stream does not: the same gray card, in the same place.
        out.append(sessionCard)
      }
    }
    if case let .detail(sessionId?, _) = column, sessionId == viewedSessionId, !serverDown, self.global == .online,
      transcript.showsServerUnreachable
    {
      out.append(.transcriptStalled)
    }
    guard column.showsGlobals, !serverDown else { return out }
    for banner in banners {
      switch banner {
      case .herdrUnavailable, .herdrReadOnly, .pushDegraded: out.append(banner)
      case .incompatible, .connecting, .serverUnreachable, .transcriptStalled: break
      }
    }
    return out
  }

  /// Baner „Włącz powiadomienia" stoi OSTATNI w kolumnie banerów globalnych: to zaproszenie,
  /// nie alarm. Przy braku serwera go nie ma (jedna awaria = jeden baner, a „Włącz" i tak by nie doszło).
  public func pushPromptVisible(in column: BannerColumn, global: ConnectionMemory, now: Date) -> Bool {
    column.showsGlobals && global.connectionCard != .serverUnreachable && pushPromptVisible(now: now)
  }
}

/// Ton kropki karty banera: czerwień = coś nie dochodzi albo wersja blokuje zmiany; szarość (`done`) = informacja.
/// Bursztyn ZAWSZE znaczy „ktoś czeka na Ciebie”, więc banerów nie barwi.
public enum BannerTone: Sendable, Equatable {
  case failure
  case info
}

extension Banner {
  public var tone: BannerTone {
    switch self {
    case .incompatible, .serverUnreachable, .transcriptStalled, .herdrUnavailable: .failure
    // Łączenie jeszcze nie jest awarią: szara karta, która po nieudanej próbie robi się czerwona.
    case .connecting, .herdrReadOnly, .pushDegraded: .info
    }
  }
}

extension Array where Element == Banner {
  /// Banery widoczne w chwili `now`: karta łączenia przed swoją chwilą jeszcze nie stoi, więc łączenie krótsze niż
  /// próg (start, powrót z tła) nie przesuwa listy.
  public func visible(at now: Date) -> [Banner] {
    filter {
      if case let .connecting(visibleFrom) = $0 { return visibleFrom <= now }
      return true
    }
  }

  /// Chwila, w której pas się zmieni sam (karta łączenia jeszcze czeka), albo `nil` — wtedy zegar nie jest potrzebny.
  public func pendingUntil(_ now: Date) -> Date? {
    compactMap { banner -> Date? in
      if case let .connecting(visibleFrom) = banner, visibleFrom > now { return visibleFrom }
      return nil
    }.min()
  }
}
