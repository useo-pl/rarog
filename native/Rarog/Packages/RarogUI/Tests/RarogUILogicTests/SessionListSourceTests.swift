import Foundation
import Testing

// Strażnik źródeł listy sesji: rzeczy wycofane decyzją użytkownika nie wracają po cichu. Właściciel: lista.

@Suite("lista sesji: strażnik źródeł")
struct SessionListSourceTests {
  static let sources = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appending(path: "Sources/RarogUI")

  /// Kod bez komentarzy: zdanie o wycofanej plamie w komentarzu nie jest jej powrotem.
  static func code(_ relative: String) throws -> String {
    try String(contentsOf: sources.appending(path: relative), encoding: .utf8)
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map { line in line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? String(line) }
      .joined(separator: "\n")
  }

  @Test("wiersz bez gasnącej plamy przy zmianie rangi (czytałaby się jak zaznaczenie)")
  func noRankFlash() throws {
    for file in ["Views/List/SessionRow.swift", "Views/List/SessionListView.swift"] {
      let code = try Self.code(file)
      #expect(!code.contains("RankFlash"), "\(file)")
      #expect(!code.contains("keyframeAnimator"), "\(file): animowane tło wiersza")
      #expect(!code.contains("onChange(of: row.section"), "\(file): reakcja na zmianę piętra")
    }
  }

  /// SwiftUI counts the iPadOS shortcut bar of a hardware keyboard as the keyboard region, so a footer that the
  /// keyboard lifts jumped up whenever the pill showed (iPad). The simulator shows neither the pill nor
  /// an on-screen keyboard in a hosted test, so the source is guarded.
  @Test("the list footer ignores every bottom safe area region: the shortcut bar pill does not lift it")
  func footerIgnoresKeyboardRegion() throws {
    let code = try Self.code("Views/List/SessionListView.swift")
    let bar = try #require(code.range(of: ".safeAreaBar(edge: .bottom"), "footer bar")
    let edge = try #require(code.range(of: ".ignoresSafeArea(edges: .bottom)"), "every region at the bottom edge")
    #expect(bar.lowerBound < edge.lowerBound, "after the footer bar")
    #expect(!code.contains(".ignoresSafeArea(.container, edges: .bottom)"), "the container alone lets the keyboard lift it")
  }

  @Test("the list's bottom scroll edge under the footer card is soft: no hairline and opaque band beside a session")
  func softBottomEdge() throws {
    let code = try Self.code("Views/List/SessionListView.swift")
    let edge = try #require(code.range(of: ".scrollEdgeEffectHidden(true, for: .bottom)"), "no bottom edge effect")
    let bar = try #require(code.range(of: ".safeAreaBar(edge: .bottom"), "footer bar")
    #expect(edge.lowerBound < bar.lowerBound, "on the list, before the footer bar")
  }
}
