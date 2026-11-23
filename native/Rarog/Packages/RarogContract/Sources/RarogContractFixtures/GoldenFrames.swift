import Foundation

/// Złote ramki SSE z repo (`shared/fixtures/sse/`) czytane WPROST z drzewa — bez kopii plików.
///
/// Katalog repo wyznacza `#filePath` tego pliku (idąc w górę do `shared/fixtures/sse/manifest.json`),
/// więc biblioteka działa wyłącznie w `swift test` na Macu z checkoutem repo. Apka jej nie linkuje.
public struct GoldenFrames: Sendable {
  public enum Expect: String, Sendable, Decodable {
    case ok, degraded, ignored
  }

  /// Wpis manifestu — te same pola co `entrySchema` w `shared/test/sse-fixtures.test.ts`.
  public struct Entry: Sendable, Decodable {
    public let expect: Expect
    public let base: String?
    public let patch: [JSONPatchOp]?
    public let strip: [String]?
    public let result: [JSONPatchOp]?
    public let degrades: [String]?
    public let raw: Bool?
  }

  public let repoRoot: URL
  public let directory: URL
  public let entries: [String: Entry]

  /// Nazwy wpisów manifestu, posortowane (argumenty testów parametryzowanych).
  public var names: [String] { entries.keys.sorted() }

  public static let shared: GoldenFrames = {
    do {
      return try GoldenFrames.load()
    } catch {
      fatalError("złote ramki: nie da się wczytać manifestu — \(error)")
    }
  }()

  public static func load(from file: String = #filePath) throws -> GoldenFrames {
    let root = try repoRoot(from: file)
    let directory = root.appending(path: "shared/fixtures/sse", directoryHint: .isDirectory)
    let manifest = try Data(contentsOf: directory.appending(path: "manifest.json"))
    let entries = try JSONDecoder().decode([String: Entry].self, from: manifest)
    return GoldenFrames(repoRoot: root, directory: directory, entries: entries)
  }

  /// Katalog repo: pierwszy przodek pliku, który ma `shared/fixtures/sse/manifest.json`.
  public static func repoRoot(from file: String = #filePath) throws -> URL {
    var url = URL(filePath: file).deletingLastPathComponent()
    while url.path != "/" {
      let manifest = url.appending(path: "shared/fixtures/sse/manifest.json")
      if FileManager.default.fileExists(atPath: manifest.path) { return url }
      url.deleteLastPathComponent()
    }
    throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: "shared/fixtures/sse/manifest.json"])
  }

  /// Pliki katalogu ramek poza manifestem (strażnik „każdy plik ma oczekiwanie").
  public func frameFiles() throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: directory.path)
      .filter { $0 != "manifest.json" }
      .sorted()
  }

  /// Zawartość pliku ramki jako dokument JSON.
  public func document(_ name: String) throws -> JSONValue {
    try JSONValue.parse(Data(contentsOf: directory.appending(path: name)))
  }

  /// Bajty pola `data:` ramki: dla `raw` — surowy tekst zapisany w pliku jako łańcuch JSON
  /// (np. uszkodzony JSON), dla reszty — dokument zapisany zwarto, jak `JSON.stringify` serwera.
  public func dataField(_ name: String) throws -> Data {
    let document = try document(name)
    if entries[name]?.raw == true {
      guard case let .string(text) = document else {
        throw CocoaError(.fileReadCorruptFile, userInfo: [NSFilePathErrorKey: name])
      }
      return Data(text.utf8)
    }
    return document.data
  }
}
