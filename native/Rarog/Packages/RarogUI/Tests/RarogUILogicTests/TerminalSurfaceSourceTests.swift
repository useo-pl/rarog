import Foundation
import Testing

// Granica renderera terminala: `RarogUI` nie zna SwiftTerm — zna go
// wyłącznie pakiet `RarogTerminal`, a apka wstrzykuje fabrykę powierzchni. Dzięki temu `swift test` tego
// pakietu nie buduje SwiftTerm (ani shadera Metal), a wymiana renderera to jeden pakiet. Właściciel: terminal.

@Suite("terminal: RarogUI bez SwiftTerm")
struct TerminalSurfaceSourceTests {
  static let package = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent()

  @Test("żaden plik RarogUI nie importuje SwiftTerm, manifest RarogUI go nie wymienia")
  func noSwiftTerm() throws {
    let sources = Self.package.appending(path: "Sources/RarogUI")
    let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
      .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    #expect(files.count > 50, "skan widzi za mało plików źródeł")
    #expect(files.contains { $0.lastPathComponent == "TerminalSurface.swift" }, "skan obejmuje katalog Terminal/")
    var offenders: [String] = []
    for file in files {
      let text = try String(contentsOf: file, encoding: .utf8)
      for line in text.split(separator: "\n") where line.contains("import") && line.contains("SwiftTerm") {
        offenders.append("\(file.lastPathComponent): \(line)")
      }
    }
    #expect(offenders.isEmpty, "\(offenders)")
    let manifest = try String(contentsOf: Self.package.appending(path: "Package.swift"), encoding: .utf8)
    #expect(!manifest.contains("SwiftTerm"))
  }
}
