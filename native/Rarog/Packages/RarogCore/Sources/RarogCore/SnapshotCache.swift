import Foundation
import RarogContract

// Pamięć podręczna listy sesji na dysku urządzenia (`docs/security-model.md`, „List cache”).
// Właściciel: łączność. Treść pliku i jego reguły: `SnapshotCacheFile`.

/// Lista sesji odczytana z pamięci podręcznej przy zimnym starcie — obraz NIEŚWIEŻY.
public struct CachedList: Sendable, Equatable {
  public let sessions: [SessionSummary]
  /// Chwila zapisu, czyli ostatni moment, w którym ta lista była świeża.
  public let savedAt: Date
}

/// Dysk pamięci podręcznej: JEDEN plik `sessions.json` w katalogu podanym przez apkę.
///
/// - Zapis atomowy z klasą ochrony `completeUntilFirstUserAuthentication`, plik i katalog poza kopią
///   zapasową. Porażka dysku nie jest błędem apki: pamięć to wygoda, nie funkcja — zapis się po
///   prostu nie liczy, a odczyt zwraca „brak".
/// - Odczyt jest niezaufany jak strumień (dekoder kontraktu); plik nieważny, za stary, za duży albo
///   z innej wersji formatu znika przy odczycie, żeby nie wracał przy każdym starcie.
public actor SnapshotCache {
  public nonisolated let directory: URL

  public init(directory: URL) {
    self.directory = directory
  }

  public nonisolated var fileURL: URL {
    directory.appending(path: SnapshotCacheFile.name, directoryHint: .notDirectory)
  }

  /// Zapisuje listę (już przyciętą do sufitu i oczyszczoną z treści). `false` = nic nie trafiło na dysk.
  @discardableResult
  public func save(_ sessions: [SessionSummary], at savedAt: Date) -> Bool {
    guard let data = SnapshotCacheFile.encode(sessions, savedAt: savedAt) else { return false }
    do {
      try prepareDirectory()
      try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      var url = fileURL
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try? url.setResourceValues(values)
      return true
    } catch {
      return false
    }
  }

  /// Ostatnia lista, jeśli wolno jej zaufać (`now` = zegar magazynu).
  public func load(now: Date) -> CachedList? {
    let manager = FileManager.default
    guard manager.fileExists(atPath: fileURL.path) else { return nil }
    let size = (try? manager.attributesOfItem(atPath: fileURL.path)[.size] as? Int) ?? 0
    guard size <= SnapshotCacheFile.maxBytes, let data = try? Data(contentsOf: fileURL),
      let list = SnapshotCacheFile.decode(data, now: now)
    else {
      clear()
      return nil
    }
    return list
  }

  /// Kasuje pamięć (401, wylogowanie): obraz sprzed wylogowania nie ma prawa mignąć.
  public func clear() {
    try? FileManager.default.removeItem(at: fileURL)
  }

  private func prepareDirectory() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    // Klasa ochrony katalogu (nowe pliki ją dziedziczą); na macOS (testy) atrybut nie istnieje — stąd `try?`.
    let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    try? FileManager.default.setAttributes(protection, ofItemAtPath: directory.path)
    var url = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? url.setResourceValues(values)
  }
}
