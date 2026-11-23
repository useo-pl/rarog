import Foundation
import RarogContract

/// Treść pliku pamięci podręcznej listy — czysta arytmetyka, bez dysku.
///
/// Plik to obiekt `{version, protocolVersion, savedAt, sessions}`:
/// - `version` = wersja FORMATU tego pliku (nie protokołu): inna = plik nieważny;
/// - `protocolVersion` = `PROTOCOL_VERSION` z chwili zapisu: przy innym protokole `SessionSummary`
///   mogłoby znaczyć co innego, więc taki plik też jest nieważny;
/// - `sessions` = lista z ostatniego ŚWIEŻEGO `sessions-snapshot`, w kolejności rangi. Teksty serwera są już
///   w języku apki (tłumacz na wejściu reduktora): po zmianie języka lista z pamięci mówi poprzednim do
///   pierwszej świeżej listy, tak jak `lastSummary`.
///
/// Co NIE trafia na dysk (`docs/security-model.md`, „Native client"): nic
/// z transkryptu i nic o stojących decyzjach. Ramka listy nie niesie kart zgód i pytań, ale niesie
/// ich skróty i treść ekranu — te pola ``scrub(_:)`` zdejmuje przed zapisem, a lista z pamięci
/// i tak nie pokazuje linii etapu ani „na co czeka" (wiersz zamrożony).
enum SnapshotCacheFile {
  static let name = "sessions.json"
  /// Wersja formatu pliku. Zmiana kształtu = stare pliki przestają pasować (i znikają przy odczycie).
  static let version = 1
  /// Po dobie lista nic nie mówi o tym, co robi agent („czeka od 14 h" wygląda jak awaria).
  static let maxAge: TimeInterval = 24 * 60 * 60
  /// Sufit pliku; przycinanie odcina sesje od końca listy (najmniej pilne).
  static let maxBytes = 2 * 1024 * 1024

  private struct Envelope: Encodable {
    let version: Int
    let protocolVersion: Int
    let savedAt: String
    let sessions: [SessionSummary]
  }

  /// Nagłówek czytany PRZED resztą: plik nowszego formatu może mieć inny kształt listy.
  private struct Header: Decodable {
    let version: Int
    let protocolVersion: Int
    let savedAt: String
  }

  private struct Body: Decodable {
    let sessions: [SessionSummary]
  }

  /// Treść pliku albo `nil`, gdy nie ma czego zapisać (nawet pusta lista nie mieści się w sufitcie).
  ///
  /// Kolejność `sessions` jest ZNACZĄCA: lista za duża traci sesje od KOŃCA, więc wołający podaje
  /// ją w kolejności rangi (czekające pierwsze). Przycinanie proporcjonalne, nie po jednej sesji:
  /// kilka przebiegów zamiast setek, z bezpiecznikiem liczby przebiegów.
  static func encode(_ sessions: [SessionSummary], savedAt: Date, maxBytes: Int = maxBytes) -> Data? {
    var kept = sessions.map(scrub)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    func build() -> Data? {
      try? encoder.encode(Envelope(
        version: version, protocolVersion: CoreLimits.protocolVersion, savedAt: ISOTime.string(savedAt),
        sessions: kept))
    }
    guard var data = build() else { return nil }
    var guardCount = 0
    while data.count > maxBytes, !kept.isEmpty, guardCount < 8 {
      guardCount += 1
      let fit = Int(Double(kept.count) * Double(maxBytes) / Double(data.count))
      // Każdy przebieg musi coś odjąć, inaczej pętla stoi przy proporcji bliskiej 1.
      kept.removeLast(kept.count - max(0, min(kept.count - 1, fit)))
      guard let next = build() else { return nil }
      data = next
    }
    return data.count <= maxBytes ? data : nil
  }

  /// Lista z pliku, jeśli wolno jej zaufać: ten sam format i protokół, wiek ≤ doby (MODUŁ różnicy —
  /// plik „z przyszłości" to przestawiony zegar, nie proroctwo), lista przechodzi dekoder kontraktu.
  static func decode(_ data: Data, now: Date) -> CachedList? {
    guard data.count <= maxBytes, let header = try? JSONDecoder().decode(Header.self, from: data) else { return nil }
    guard header.version == version, header.protocolVersion == CoreLimits.protocolVersion,
      let savedAt = ISOTime.parse(header.savedAt), abs(now.timeIntervalSince(savedAt)) <= maxAge
    else { return nil }
    // Ten sam dekoder co strumień: nieznana wartość degraduje pole, uszkodzony kształt
    // unieważnia cały plik. Degradacji nie raportujemy — raport należy do strumienia.
    guard let body = try? JSONDecoder().decode(Body.self, from: data) else { return nil }
    return CachedList(sessions: body.sessions, savedAt: savedAt)
  }

  /// Sesja bez pól, które nie mają prawa leżeć na dysku: skrót stojącej decyzji, rozpoznany dialog
  /// z wycinkiem ekranu terminala i klasą z rejestru CLI, ulotna aktywność (komendy, ścieżki), szczegół stanu (bywa tekstem
  /// błędu z CLI), podsumowanie ostatniej tury (tekst agenta) oraz opisy i komendy zadań w tle — także treść
  /// własnych komend subagenta (`ownTasks[].command`). Reszta zadania zostaje, bo treści nie niesie: m.in.
  /// identyfikatory, rodzaj, czasy startu i `waitingSince` (od kiedy agent stoi). Artefakty sesji znikają
  /// w całości: tytuł to tekst agenta, a adres prowadzi do strony konta; sekcja wraca z pierwszą ramką. Tak samo
  /// pull requesty sesji: tytuł to tekst agenta, a adres zdradza nazwę repo, także prywatnego.
  /// Scheduled tasks go whole as well: the prompt is text the session was asked to run later.
  static func scrub(_ session: SessionSummary) -> SessionSummary {
    var copy = session
    copy.waitingFor = nil
    copy.herdrDialog = nil
    copy.herdrDialogReason = nil
    copy.herdrDialogScreen = nil
    copy.cliDialog = nil
    copy.activity = nil
    copy.stateDetail = nil
    // Kod zdania szczegółu niesie jego argumenty (np. chwilę limitu) — znika razem z tekstem.
    copy.stateDetailRef = nil
    copy.lastSummary = nil
    copy.artifacts = nil
    copy.pullRequests = nil
    copy.scheduledTasks = nil
    copy.backgroundTasks = session.backgroundTasks?.map { task in
      var bare = task
      bare.description = nil
      bare.command = nil
      bare.summary = nil
      bare.run = nil
      bare.ownTasks = task.ownTasks?.map { own in
        var quiet = own
        quiet.command = nil
        return quiet
      }
      return bare
    }
    return copy
  }
}
