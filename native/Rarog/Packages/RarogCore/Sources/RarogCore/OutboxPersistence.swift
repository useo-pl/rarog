import Foundation

/// Dysk trwałej kolejki wysyłki. Właściciel: wysyłka.
///
/// Układ katalogu:
/// - `<id>.json` — manifest wpisu (``OutboxEntry``), zapis atomowy;
/// - `<id>/` — pliki treści załączników (`0.jpg`, `1.pdf`…), nazwy w `Attachment.file`.
///
/// Kolejność zapisów jest regułą odzyskiwania po awarii: przy zakładaniu NAJPIERW pliki treści,
/// POTEM manifest; przy kasowaniu NAJPIERW manifest, POTEM pliki. Awaria w środku zostawia więc
/// najwyżej katalog bez manifestu (sierota, sprzątana przy starcie), nigdy manifest bez treści.
/// Manifest, któremu plik treści jednak zniknął, wraca jako ``OutboxLoad/missing``.
///
/// Katalog wstrzykuje magazyn: `outbox/` w przestrzeni bieżącego serwera (`ServerSpaces`, która ustawia ochronę
/// danych i wyłączenie z kopii zapasowej). Uszkodzony albo obcy plik jest pomijany, nie przewraca
/// startu — cena: wpis znika z ekranu, ale nie blokuje kolejki.
public actor OutboxPersistence {
  public nonisolated let directory: URL
  private let encoder: JSONEncoder
  private let decoder = JSONDecoder()

  public init(directory: URL) {
    self.directory = directory
    encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
  }

  /// Zapisuje manifest wpisu (tworzy katalog przy pierwszym zapisie) w bieżącej wersji formatu.
  /// Rzuca, gdy dysk odmówił — wtedy wiadomość NIE wychodzi (najpierw dysk, potem bajt).
  /// The version is v3 for an entry with the voice agent's sender pair and v2 for any other.
  public func save(_ entry: OutboxEntry) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var current = entry
    current.version = OutboxEntry.diskVersion(sender: entry.sender)
    try encoder.encode(current).write(to: manifestURL(entry.id), options: .atomic)
  }

  /// Zakłada wpis z plikami treści: kopie `payloads` (po jednym na załącznik, w tej kolejności)
  /// do `<id>/`, potem manifest. Porażka sprząta katalog treści i rzuca. Zwraca wpis z nazwami plików.
  ///
  /// Kopia, nie przeniesienie: plik wołającego (pasek nad polem) zostaje, bo odmowa oddaje
  /// załączniki do pola. Na APFS kopia to klon — bez podwójnego miejsca na dysku.
  public func stage(_ entry: OutboxEntry, payloads: [URL]) throws -> OutboxEntry {
    precondition(payloads.count == entry.attachments.count, "jeden plik treści na załącznik")
    var staged = entry
    let folder = payloadDirectory(entry.id)
    if !payloads.isEmpty {
      do {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for (index, source) in payloads.enumerated() {
          let name = Self.payloadName(index: index, source: source)
          let target = folder.appending(path: name)
          try? FileManager.default.removeItem(at: target)
          try FileManager.default.copyItem(at: source, to: target)
          staged.attachments[index].file = name
        }
      } catch {
        try? FileManager.default.removeItem(at: folder)
        throw error
      }
    }
    do {
      try save(staged)
    } catch {
      try? FileManager.default.removeItem(at: folder)
      throw error
    }
    return staged
  }

  /// Kasuje wpis: manifest, potem pliki treści.
  public func delete(_ id: UUID) {
    try? FileManager.default.removeItem(at: manifestURL(id))
    try? FileManager.default.removeItem(at: payloadDirectory(id))
  }

  /// Wszystkie czytelne wpisy; sprząta katalogi treści bez manifestu (awaria przy zakładaniu).
  public func loadAll() -> OutboxLoad {
    let manager = FileManager.default
    let names = (try? manager.contentsOfDirectory(atPath: directory.path)) ?? []
    var entries: [OutboxEntry] = []
    var skipped = 0
    var manifests: Set<String> = []
    for name in names where name.hasSuffix(".json") {
      manifests.insert(String(name.dropLast(".json".count)))
      guard let data = try? Data(contentsOf: directory.appending(path: name)),
        let entry = try? decoder.decode(OutboxEntry.self, from: data),
        OutboxEntry.readableVersions.contains(entry.version)
      else {
        skipped += 1
        continue
      }
      entries.append(entry)
    }
    var orphans = 0
    for name in names where UUID(uuidString: name) != nil && !manifests.contains(name) {
      var isDirectory: ObjCBool = false
      let url = directory.appending(path: name)
      guard manager.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else { continue }
      try? manager.removeItem(at: url)
      orphans += 1
    }
    let missing = Set(entries.filter { !payloadsPresent($0) }.map(\.id))
    return OutboxLoad(
      entries: entries.sorted { $0.createdAt < $1.createdAt }, skipped: skipped, missing: missing, orphansRemoved: orphans)
  }

  /// Plik treści załącznika wpisu (`nil` = załącznik bez zapisanego pliku).
  public nonisolated func payloadURL(_ entry: OutboxEntry, _ attachment: OutboxEntry.Attachment) -> URL? {
    attachment.file.map { payloadDirectory(entry.id).appending(path: $0) }
  }

  public nonisolated func payloadDirectory(_ id: UUID) -> URL {
    directory.appending(path: id.uuidString, directoryHint: .isDirectory)
  }

  /// Czy każdy załącznik wpisu ma swój plik treści na dysku.
  public nonisolated func payloadsPresent(_ entry: OutboxEntry) -> Bool {
    entry.attachments.allSatisfy { attachment in
      payloadURL(entry, attachment).map { FileManager.default.fileExists(atPath: $0.path) } ?? false
    }
  }

  private nonisolated func manifestURL(_ id: UUID) -> URL {
    directory.appending(path: "\(id.uuidString).json")
  }

  /// `<indeks>.<rozszerzenie źródła>` — rozszerzenie tylko dla czytelności katalogu.
  static func payloadName(index: Int, source: URL) -> String {
    let ext = source.pathExtension.lowercased().filter { $0.isLetter || $0.isNumber }
    return ext.isEmpty ? "\(index).bin" : "\(index).\(ext.prefix(8))"
  }
}

/// Wynik odczytu kolejki przy starcie.
public struct OutboxLoad: Sendable, Equatable {
  public let entries: [OutboxEntry]
  /// Pliki pominięte: uszkodzone, obce albo z nowszej wersji formatu.
  public let skipped: Int
  /// Wpisy, którym brakuje pliku treści załącznika — nie da się ich ponowić tymi samymi bajtami.
  public let missing: Set<UUID>
  /// Katalogi treści bez manifestu skasowane przy odczycie.
  public let orphansRemoved: Int
}
