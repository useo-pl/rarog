import Foundation
import Testing

// Pismo za Dynamic Type w całym zakresie. Właściciel: dostępność.

@Suite("pismo rośnie i maleje z Dynamic Type w całym zakresie")
struct DynamicTypeSourceTests {
  /// Ikony SF Symbols — audyt mierzy tekst, a symbol w `caption2` jest celowo drobny. Jedyny tekst na liście to
  /// cyfra kafelka skrótu na zakładce: ozdobnik ukryty przed czytnikiem (`accessibilityHidden`).
  static let exemptLines: Set<String> = [
    "Views/Projects/ProjectTabBar.swift: .appFont(.caption2.weight(.bold))",
    // Glif terminala przed etykietą zakładki terminala — etykieta stoi w `caption`.
    "Views/Projects/ProjectTabBar.swift: tab.showsLabel ? .caption2.weight(tab.current ? .semibold : .regular) : .caption",
    // Cyfra kafelka skrótu Cmd (`TabShortcutKey`): o 1 pt mniejsza od etykiety;
    // półgruba w kafelku w kolorze stanu (`TabTokens.key`).
    "Views/Projects/ProjectTabBar.swift: .appFont(.caption2.monospaced().weight(look.semibold ? .semibold : .medium))",
    // The same digit in an agent row of the active project (`TreeTabKey`): the size of the strip's key.
    "Views/List/SessionRow.swift: .appFont(.caption2.monospaced().weight(.medium))",
  ]

  /// The text scaling contract names every text style (the size table, the style maps, `AppFont.caption2`) and sets
  /// no text itself.
  static let exemptFiles: Set<String> = [
    "Theme/TextStyle/TextStyleTable.swift",
    "Theme/TextStyle/AppFont.swift",
  ]

  /// `caption2` stoi na 11 pt od xSmall do Large, więc tekst w nim nie maleje z ustawieniem systemu:
  /// audyt XCUITest (iOS 27) zgłaszał go jako „Dynamic Type font sizes are partially
  /// unsupported" („5H", „7D", „FAB", „TY"), a ten sam tekst w `caption` i `footnote` przechodził.
  @Test("tekst nie stoi w caption2 (11 pt od xSmall do Large); wolno tylko liniom z listy")
  func noCaption2Text() throws {
    let root = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appending(path: "Sources/RarogUI")
    let files = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
      .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    #expect(files.count > 50, "skan widzi za mało plików źródeł")
    var offenders: [String] = []
    for file in files {
      let relative = String(file.path.dropFirst(root.path.count + 1))
      if Self.exemptFiles.contains(relative) { continue }
      for line in try String(contentsOf: file, encoding: .utf8).split(separator: "\n") {
        let code = line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? String(line)
        guard code.contains("caption2") else { continue }
        let entry = "\(relative): \(code.trimmingCharacters(in: .whitespaces))"
        if !Self.exemptLines.contains(entry) { offenders.append(entry) }
      }
    }
    #expect(offenders.isEmpty, "tekst w caption2:\n\(offenders.sorted().joined(separator: "\n"))")
  }
}
