import Foundation
import Testing

// Granice tunelu iroh w źródłach: biblioteka IrohLib wchodzi tylko do pakietu `RarogIroh` (linkuje go wyłącznie
// apka), `RarogTransport` nie zna `RarogCore` (cykl), a kod tunelu, przełącznika i koordynatora apki nie pyta
// o platformę. Wybór drogi (iroh albo HTTPS) zależy od tras poświadczenia, gotowości dzierżawy i pamięci porażki,
// więc iPhone, iPad i Mac dostają ten sam wynik każdego wiersza macierzy wyboru.

@Suite("granice tunelu iroh w źródłach")
struct IrohBoundaryTests {
  /// `native/Rarog`.
  static let native = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()

  /// Pliki `.swift` pod katalogiem, bez wyników buildu.
  static func swiftFiles(_ relative: String) throws -> [URL] {
    let root = native.appending(path: relative)
    guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return [] }
    var files: [URL] = []
    for case let url as URL in walker {
      let name = url.lastPathComponent
      if name == ".build" || name == "build" || name == "DerivedData" {
        walker.skipDescendants()
        continue
      }
      if url.pathExtension == "swift" { files.append(url) }
    }
    return files
  }

  /// Linie kodu bez komentarzy jednoliniowych.
  static func code(_ url: URL) throws -> [String] {
    try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map(String.init)
      .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
  }

  @Test("IrohLib importuje tylko pakiet RarogIroh")
  func irohLibOnlyInRarogIroh() throws {
    let files = try Self.swiftFiles(".")
    #expect(files.count > 200)
    let offenders = try files.filter { url in
      guard !url.path.contains("/Packages/RarogIroh/") else { return false }
      // Napis złożony z części: ten plik sam nie liczy się jako import.
      return try Self.code(url).contains { $0.contains("import " + "IrohLib") }
    }
    #expect(offenders.map(\.lastPathComponent) == [])
  }

  @Test("RarogTransport nie importuje RarogCore")
  func transportWithoutCore() throws {
    let files = try Self.swiftFiles("Packages/RarogTransport/Sources")
    #expect(!files.isEmpty)
    let offenders = try files.filter { url in try Self.code(url).contains { $0.contains("import RarogCore") } }
    #expect(offenders.map(\.lastPathComponent) == [])
  }

  @Test("kod tunelu, przełącznika i koordynatora nie pyta o platformę")
  func noPlatformQuestions() throws {
    let files = try Self.swiftFiles("Packages/RarogTransport/Sources/RarogTransport/Tunnel")
      + Self.swiftFiles("Packages/RarogCore/Sources/RarogCore/Transport")
      + Self.swiftFiles("Packages/RarogIroh/Sources")
      + [Self.native.appending(path: "Rarog/TunnelCoordinator.swift")]
    #expect(files.count > 10)
    for url in files {
      let lines = try Self.code(url)
      let questions = lines.filter { $0.contains("isiOSAppOnMac") || $0.contains("targetEnvironment") }
      #expect(questions == [], "\(url.lastPathComponent)")
    }
  }
}
