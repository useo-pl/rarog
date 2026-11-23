import CryptoKit
import Foundation
import RarogContract
import RarogCore

/// Niezapisany tekst notatki projektu na urządzeniu. Notatka jest jedyną treścią w Rarogu,
/// której nikt nie odtworzy z transkryptu, a jej zapis bywa odroczony (sieć, konflikt, nagranie) — więc pole trafia
/// na dysk niezależnie od sieci: po każdej zmianie, przy zakończeniu prezentacji i w tle. Szkic znika dopiero, gdy
/// serwer potwierdził dokładnie ten tekst (albo człowiek świadomie wziął wersję z serwera).
///
/// Osobno od szkiców pola wiadomości (`ComposerDrafts`): tamte mają sufit liczby i kasują sieroty, a szkic notatki
/// bywa jedyną kopią tekstu — tu nic nie znika przy odczycie, także plik nieczytelny albo z nieznaną wersją (zostaje
/// do ręcznego odzyskania). Ta sama klasa danych i ochrona: `<przestrzeń serwera>/note-drafts/`, ochrona do pierwszego
/// odblokowania, poza kopią zapasową, zapis atomowy na kolejce katalogu (``DraftsDisk``). Bez katalogu
/// (testy) — tylko pamięć procesu.
/// Właściciel: notatki (apka natywna).
public final class NoteDrafts: @unchecked Sendable {
  /// Zapis na dysku jednego projektu.
  public struct Draft: Sendable, Equatable, Codable {
    public var version = 1
    public var cwd: String
    /// Pole w chwili zapisu.
    public var text: String
    /// Wersja, na której człowiek pisał (wspólny przodek do „Połącz” i wersja `PUT`).
    public var ancestor: NotesDoc?
    /// Wersja z drugiego urządzenia, gdy szkic powstał w konflikcie.
    public var conflict: NotesDoc?
    /// Tekst skasowany zamknięciem pustego pola — do „Przywróć” także po zabiciu apki.
    public var trash: String?
    /// Teksty wysłane bez potwierdzenia (limit czasu, zerwanie): serwer mógł je przyjąć, więc po restarcie odczyt
    /// i 409 rozpoznają je jako własne, a pole różne od nich dalej czeka na zapis.
    public var unsent: [String]?
    public var savedAt: Date

    public init(
      cwd: String, text: String, ancestor: NotesDoc?, conflict: NotesDoc? = nil, trash: String? = nil,
      unsent: [String]? = nil, savedAt: Date
    ) {
      self.cwd = cwd
      self.text = text
      self.ancestor = ancestor
      self.conflict = conflict
      self.trash = trash
      self.unsent = unsent
      self.savedAt = savedAt
    }
  }

  /// Kolejka katalogu szkiców (``DraftsDisk``) w przestrzeni serwera; `nil` = tylko pamięć procesu.
  private let disk: DraftsDisk.Ticket?
  /// Pamięć procesu: źródło prawdy dla odczytów w tym uruchomieniu (dysk jest kopią na wypadek zabicia apki).
  private var memory: [String: Draft] = [:]
  private let lock = NSLock()

  /// - Parameter directory: katalog na dysku; `nil` = tylko pamięć procesu.
  public init(directory: URL? = nil) {
    guard let directory else {
      disk = nil
      return
    }
    let (ticket, drafts) = DraftsDisk.shared.open(directory) {
      Self.prepare(directory)
      return Self.readAll(directory)
    }
    disk = ticket
    for draft in drafts { memory[draft.cwd] = draft }
  }

  /// Szkice w przestrzeni bieżącego serwera (`RarogStore.dataSpaceDirectory`); bez przestrzeni — tylko pamięć.
  public static func inSpace(_ space: URL?) -> NoteDrafts {
    NoteDrafts(directory: space?.appending(path: ServerSpaces.noteDrafts, directoryHint: .isDirectory))
  }

  /// Wszystkie szkice wczytane przy starcie i zapisane w tym uruchomieniu.
  public var all: [Draft] {
    lock.withLock { Array(memory.values) }
  }

  public func draft(_ cwd: String) -> Draft? {
    lock.withLock { memory[cwd] }
  }

  /// Zapis szkicu; `done` dostaje wynik dysku na głównym aktorze (`false` = kopii na urządzeniu nie ma).
  public func save(_ draft: Draft, done: (@MainActor @Sendable (Bool) -> Void)? = nil) {
    lock.withLock { memory[draft.cwd] = draft }
    guard let disk else {
      if let done { Task { @MainActor in done(true) } }
      return
    }
    DraftsDisk.shared.async(disk) {
      let saved = Self.write(draft, in: disk.directory)
      if let done { Task { @MainActor in done(saved) } }
    }
  }

  public func remove(_ cwd: String) {
    lock.withLock { memory[cwd] = nil }
    guard let disk else { return }
    DraftsDisk.shared.async(disk) {
      try? FileManager.default.removeItem(at: Self.file(cwd, in: disk.directory))
    }
  }

  /// Czeka, aż wszystkie zlecone zapisy trafią na dysk (zejście apki w tło, testy).
  public func flush() {
    guard let disk else { return }
    DraftsDisk.shared.flush(disk)
  }

  // MARK: - Na kolejce

  /// Nazwa pliku: `sha256(cwd)` skrócony do 16 znaków hex (ten sam kształt co na serwerze) — długa ścieżka katalogu
  /// nie przekracza 255 bajtów nazwy pliku.
  static func key(_ cwd: String) -> String {
    SHA256.hash(data: Data(cwd.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).description
  }

  private static func file(_ cwd: String, in directory: URL) -> URL {
    directory.appending(path: "\(key(cwd)).json")
  }

  private static func write(_ draft: Draft, in directory: URL) -> Bool {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .millisecondsSince1970
    guard let data = try? encoder.encode(draft) else { return false }
    return (try? data.write(to: file(draft.cwd, in: directory), options: .atomic)) != nil
  }

  /// Szkice, które da się przeczytać. Plik nieczytelny i nieznana wersja ZOSTAJĄ na dysku nietknięte.
  private static func readAll(_ directory: URL) -> [Draft] {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .millisecondsSince1970
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    return names.filter { $0.hasSuffix(".json") }.compactMap { name in
      guard let data = try? Data(contentsOf: directory.appending(path: name)),
        let draft = try? decoder.decode(Draft.self, from: data), draft.version == 1
      else { return nil }
      return draft
    }
  }

  /// Katalog z ochroną danych i poza kopią zapasową.
  private static func prepare(_ directory: URL) {
    let manager = FileManager.default
    var dir = directory
    #if os(iOS)
    let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    try? manager.createDirectory(at: dir, withIntermediateDirectories: true, attributes: protection)
    try? manager.setAttributes(protection, ofItemAtPath: dir.path)
    #else
    try? manager.createDirectory(at: dir, withIntermediateDirectories: true)
    #endif
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? dir.setResourceValues(values)
  }
}
