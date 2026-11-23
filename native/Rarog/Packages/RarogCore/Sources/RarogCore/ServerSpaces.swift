import CryptoKit
import Foundation
import RarogTransport

// Dane apki per serwer w osobnych katalogach. Izolacja nie zależy od tego,
// czy i kiedy uda się kasowanie: apka czyta i pisze WYŁĄCZNIE przestrzeń wskazaną przez trwały wskaźnik
// (`servers/.current.json`, zapis atomowy pliku — przeżywa śmierć procesu, w odróżnieniu od `UserDefaults`, które
// utrwala zapis asynchronicznie), a każdy inny katalog w `servers/` to śmieć, którego nikt nie czyta.
//
//   <Application Support>/servers/.current.json              wskaźnik bieżącej przestrzeni (JSON `ServerSpace`)
//   <Application Support>/servers/<przestrzeń>/outbox/        kolejka wysyłki (`OutboxPersistence`)
//                                             /list/          pamięć podręczna listy (`SnapshotCache`)
//                                             /drafts/        szkice pól z załącznikami (`ComposerDrafts`)
//                                             /note-drafts/   szkice notatek (`NoteDrafts`)
//   <Application Support>/servers-trash/                      kosz: przestrzenie do skasowania w tle
//
// Nazwa przestrzeni = skrót tożsamości serwera (`ServerIdentity`; dla adresu ten sam napis co znormalizowany
// `ServerOrigin`) i jednorazowy sufiks: „Zapomnij serwer” albo inny serwer zakładają NOWĄ przestrzeń także dla tego
// samego adresu, więc spóźniony zapis starej instancji (stary interfejs, odpowiedź w drodze) trafia do katalogu,
// którego już nikt nie wskazuje. Właściciel: dane apki per serwer.
//
// Wskaźnik: `{"origin"?: {"scheme", "host", "port"}, "name", "identity", "successor"?}`. Zapis niesie zawsze `identity`
// (napis `ServerIdentity.description`) i `origin` przy tożsamości po adresie, więc build bez pola `identity` czyta
// wskaźnik `.origin` jak swój (nieznany klucz pomija). Odczyt: `identity`, gdy jest i daje się przeczytać; inaczej
// tożsamość z `origin` (wskaźnik bez `identity`). Bez obu wskaźnik jest nieczytelny (`readPointer` = `nil`).
// `successor` (ten sam napis tożsamości) stoi tylko w trakcie ponownego parowania, które zostaje w przestrzeni pod nową
// tożsamością (`RarogStore+Spaces`): klucz z tą tożsamością też otwiera przestrzeń. Nieczytelny `successor` = brak
// pola, wskaźnik zostaje czytelny. Złote bajty i dekoder buildu bez `identity`:
// `Tests/RarogCoreTests/Legacy/PreIdentity*.swift`.

/// Przestrzeń danych jednego serwera — wartość wskaźnika (`servers/.current.json`). Pola spoza `origin`, `name`,
/// `identity` i `successor` dekoder pomija.
public struct ServerSpace: Sendable, Equatable, Codable {
  /// Serwer, do którego należą dane przestrzeni.
  public let identity: ServerIdentity
  /// Nazwa katalogu w `servers/`.
  public let name: String
  /// Tożsamość, pod którą przestrzeń przechodzi w trakcie ponownego parowania: zapisana PRZED kluczem
  /// w Keychainie, skreślana, gdy przejście się skończy albo klucz nie przejdzie. `nil` = poza przejściem.
  public let successor: ServerIdentity?

  public init(identity: ServerIdentity, name: String, successor: ServerIdentity? = nil) {
    self.identity = identity
    self.name = name
    self.successor = successor
  }

  public init(origin: ServerOrigin, name: String) {
    self.init(identity: .origin(origin), name: name)
  }

  /// Adres serwera przy tożsamości po adresie; `nil` dla serwera tylko przez iroh.
  public var origin: ServerOrigin? {
    if case let .origin(origin) = identity { return origin }
    return nil
  }

  /// Ten wskaźnik bez następcy (koniec albo cofnięcie przejścia).
  public var settled: ServerSpace { ServerSpace(identity: identity, name: name) }

  enum CodingKeys: String, CodingKey {
    case origin, name, identity, successor
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    if let text = try? c.decodeIfPresent(String.self, forKey: .identity), let identity = ServerIdentity(description: text) {
      self.identity = identity
    } else {
      identity = .origin(try c.decode(ServerOrigin.self, forKey: .origin))
    }
    let successor = try? c.decodeIfPresent(String.self, forKey: .successor)
    self.successor = successor.flatMap { ServerIdentity(description: $0) }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    if let origin { try c.encode(origin, forKey: .origin) }
    try c.encode(name, forKey: .name)
    try c.encode(identity.description, forKey: .identity)
    if let successor { try c.encode(successor.description, forKey: .successor) }
  }
}

/// Katalogi przestrzeni i kosz. Operacje to `rename` na tym samym wolumenie (atomowe) i kasowanie kosza w tle;
/// porażka kasowania nie łamie izolacji, bo kosza i nieskazanych przestrzeni nikt nie czyta.
public final class ServerSpaces: Sendable {
  public static let outbox = "outbox"
  public static let list = "list"
  public static let drafts = "drafts"
  public static let noteDrafts = "note-drafts"

  public let root: URL
  public let trash: URL
  /// Katalog w koszu na kolejki sesji bez przestrzeni TEGO procesu: kasowanie kosza go pomija, następny start — nie.
  private let scratchName = "scratch-\(UUID().uuidString)"
  /// Zapis treści wskaźnika do pliku (atomowy); testy podstawiają dysk, który odmawia wybranych zapisów.
  private let savePointer: @Sendable (Data, URL) throws -> Void

  public convenience init(root: URL, trash: URL) {
    self.init(root: root, trash: trash) { data, file in try data.write(to: file, options: .atomic) }
  }

  /// Przestrzenie z własnym zapisem pliku wskaźnika (testy: odmowa dysku przy wybranym wskaźniku).
  init(root: URL, trash: URL, savePointer: @escaping @Sendable (Data, URL) throws -> Void) {
    self.root = root
    self.trash = trash
    self.savePointer = savePointer
  }

  /// Katalog przestrzeni.
  public func directory(_ space: ServerSpace) -> URL {
    root.appending(path: space.name, directoryHint: .isDirectory)
  }

  /// Plik wskaźnika bieżącej przestrzeni (nazwa z kropką: sprzątanie `servers/` go pomija).
  public var pointerFile: URL { root.appending(path: ".current.json") }

  /// Wskaźnik z dysku: `nil` = brak pliku albo treść nie do odczytania jako `ServerSpace` (brak przestrzeni). Rzuca,
  /// gdy plik jest, ale dysk go nie oddaje (np. telefon przed pierwszym odblokowaniem): wtedy nie wiadomo, która
  /// przestrzeń jest bieżąca, i nic nie może iść do kosza.
  public func readPointer() throws -> ServerSpace? {
    guard FileManager.default.fileExists(atPath: pointerFile.path) else { return nil }
    let data = try Data(contentsOf: pointerFile)
    return try? JSONDecoder().decode(ServerSpace.self, from: data)
  }

  /// Zapis wskaźnika (atomowy plik) albo jego usunięcie (`nil`). `false` = dysk nie przyjął — wołający nie rusza
  /// wtedy katalogów, bo wskaźnik na dysku dalej pokazuje poprzednią przestrzeń.
  public func writePointer(_ space: ServerSpace?) -> Bool {
    guard let space else {
      do {
        try FileManager.default.removeItem(at: pointerFile)
      } catch let error as CocoaError where error.code == .fileNoSuchFile {
        return true
      } catch {
        return !FileManager.default.fileExists(atPath: pointerFile.path)
      }
      return true
    }
    guard let data = try? JSONEncoder().encode(space) else { return false }
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return (try? savePointer(data, pointerFile)) != nil
  }

  /// Nowa przestrzeń dla serwera: skrót napisu tożsamości (stała część, czytelna przy diagnozie) i jednorazowy sufiks.
  public func newSpace(for identity: ServerIdentity) -> ServerSpace {
    let digest = SHA256.hash(data: Data(identity.description.utf8)).map { String(format: "%02x", $0) }.joined()
    let suffix = UUID().uuidString.prefix(8).lowercased()
    return ServerSpace(identity: identity, name: "\(digest.prefix(16))-\(suffix)")
  }

  /// Nowa przestrzeń dla adresu (tożsamość `.origin`).
  public func newSpace(for origin: ServerOrigin) -> ServerSpace {
    newSpace(for: .origin(origin))
  }

  /// Katalog bez przestrzeni (apka bez serwera, sesja bez wskaźnika): w koszu, więc zapis tam nie przeżyje
  /// następnego startu, ale kasowanie kosza w tym procesie go nie rusza.
  public func scratch() -> URL {
    trash.appending(path: scratchName, directoryHint: .isDirectory)
      .appending(path: UUID().uuidString, directoryHint: .isDirectory)
  }

  /// Zakłada `servers/` i kosz z ochroną do pierwszego odblokowania i poza kopią zapasową (pliki dziedziczą klasę
  /// katalogu). `nil` = katalogi gotowe; inaczej opis porażki do `client.log` (bez treści).
  public func prepare() -> String? {
    var problem: String?
    for directory in [root, trash] {
      var dir = directory
      do {
        #if os(iOS)
        let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: protection)
        try FileManager.default.setAttributes(protection, ofItemAtPath: dir.path)
        #else
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        #endif
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try dir.setResourceValues(values)
      } catch {
        let error = error as NSError
        problem = "przestrzenie danych: katalog \(dir.lastPathComponent) nie gotowy (\(error.domain) \(error.code))"
      }
    }
    return problem
  }

  /// Wszystko w `servers/` poza `keeping` do kosza (`rename`), potem kosz kasowany w tle.
  public func collectGarbage(keeping: ServerSpace?) {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
    for name in names where name != keeping?.name && !name.hasPrefix(".") {
      moveToTrash(root.appending(path: name))
    }
    emptyTrashInBackground()
  }

  /// Kasowanie kosza poza głównym aktorem; porażka zostawia kosz do następnego startu (nikt go nie czyta).
  public func emptyTrashInBackground() {
    let (trash, keep) = (trash, scratchName)
    Task.detached(priority: .utility) { Self.emptyTrash(trash, keeping: keep) }
  }

  private static func emptyTrash(_ trash: URL, keeping scratch: String) {
    for name in (try? FileManager.default.contentsOfDirectory(atPath: trash.path)) ?? [] where name != scratch {
      try? FileManager.default.removeItem(at: trash.appending(path: name))
    }
  }

  /// Wszystko w `servers/` do kosza; `false` = któryś katalog został (np. `servers/` bez prawa zapisu).
  public func discardAll() -> Bool {
    collectGarbage(keeping: nil)
    let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
    return !names.contains { !$0.hasPrefix(".") }
  }

  private func moveToTrash(_ url: URL) {
    try? FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
    let target = trash.appending(path: "\(url.lastPathComponent)-\(UUID().uuidString)")
    // `rename` na tym samym wolumenie; nieudany zostawia katalog na miejscu — poza przestrzenią wskazaną nikt go
    // nie czyta, a następny start spróbuje znowu.
    _ = try? FileManager.default.moveItem(at: url, to: target)
  }
}
