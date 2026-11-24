import Foundation
@testable import RarogUI
import Testing

// Prawy panel sesji na iPadzie: układ sekcji w JEDNYM przewijaniu (`InspectorPanel`). Widoku SwiftUI test logiki nie
// renderuje, więc kolejność sekcji, warunek „sekcja tylko z wierszami” i kolor linku PR-ów pilnuje strażnik źródeł;
// wygląd i drzewo dostępności sprawdza `InspectorUITests` przeciw serwerowi demo. Właściciel: panel.

@Suite("prawy panel: sekcje w jednym przewijaniu — kolejność, warunek, PULL REQUESTY w kolorze linku")
struct InspectorSectionsTests {
  static let panel = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appending(path: "Sources/RarogUI/Views/Inspector/InspectorPanel.swift")

  /// Kod bez komentarzy `//`.
  static func code() throws -> String {
    try String(contentsOf: panel, encoding: .utf8)
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map { line in line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? String(line) }
      .joined(separator: "\n")
  }

  /// Ciało typu `name` od jego deklaracji do następnej deklaracji typu w pliku.
  static func body(of name: String, in code: String) throws -> String {
    let start = try #require(code.range(of: "struct \(name):"), "brak `struct \(name)`")
    let rest = code[start.upperBound...]
    let end = rest.range(of: "\nprivate struct ")?.lowerBound ?? rest.endIndex
    return String(rest[..<end])
  }

  @Test("kolejność: W TLE, SKOŃCZONE, SCHEDULED TASKS, ARTEFAKTY, PULL REQUESTY, FILES; PR-y tylko z wierszami")
  func order() throws {
    let panel = try Self.body(of: "InspectorPanel", in: try Self.code())
    let markers = [
      "BackgroundTasksHeader(", "if !finished.isEmpty", "InspectorFinishedSection(", "if !scheduled.isEmpty",
      "InspectorScheduledSection(", "if !artifacts.isEmpty",
      "InspectorArtifactsSection(", "if !pullRequests.isEmpty", "InspectorPullRequestsSection(",
      "InspectorFilesSection(",
    ]
    var cursor = panel.startIndex
    for marker in markers {
      let hit = try #require(panel.range(of: marker, range: cursor..<panel.endIndex), "\(marker) nie stoi po poprzednim")
      cursor = hit.upperBound
    }
    #expect(panel.contains("PullRequestRows.rows(session?.pullRequests ?? [])"), "wiersze z podsumowania sesji")
    #expect(panel.contains("ScheduledTaskRows.rows(scheduledTasks, now: scheduleNow)"), "rows under the panel's clock")
  }

  @Test("sekcja PR-ów ma własną kotwicę, różną od pozostałych, i identyfikatory dla testów UI")
  func anchorAndIdentifiers() throws {
    let anchors = [
      InspectorModel.backgroundAnchor, InspectorModel.finishedAnchor, InspectorModel.scheduledAnchor,
      InspectorModel.artifactsAnchor,
      InspectorModel.pullRequestsAnchor, InspectorModel.changesAnchor,
    ]
    #expect(Set(anchors).count == anchors.count)
    let code = try Self.code()
    let section = try Self.body(of: "InspectorPullRequestsSection", in: code)
    #expect(section.contains(".id(InspectorModel.pullRequestsAnchor)"))
    #expect(section.contains("\"inspector.pullRequests.title\""))
    #expect(section.contains("UICopy.inspectorPullRequestsTitle"))
    let row = try Self.body(of: "PullRequestRowView", in: code)
    #expect(row.contains("\"inspector.pullRequest.\\(row.id)\""))
  }

  @Test("wiersz PR jak artefakt: glif i pierwsza linia w linkInk, link systemem, cecha linku, bez linku tekst")
  func rowLooksLikeArtifact() throws {
    let row = try Self.body(of: "PullRequestRowView", in: try Self.code())
    #expect(row.contains("row.link != nil ? Palette.linkInk : Palette.muted2"), "glif w kolorze linku")
    #expect(row.contains("hovered ? Palette.text : Palette.linkInk"), "pierwsza linia w kolorze linku")
    #expect(row.contains("openURL(BrowserLinks.outside(link))"), "adres idzie do systemu")
    #expect(row.contains(".accessibilityAddTraits(.isLink)") && row.contains(".accessibilityRemoveTraits(.isButton)"))
    #expect(row.contains(".accessibilityAddTraits(.isStaticText)"), "adres spoza gramatyki to tekst")
    #expect(!row.contains(".underline"), "bez podkreślenia, jak artefakt")
  }

  @Test("merged and closed PRs fold under a disclosure button after the PRs in view, split by the model")
  func settledFold() throws {
    let code = try Self.code()
    let section = try Self.body(of: "InspectorPullRequestsSection", in: code)
    let markers = [
      "PullRequestRows.split(rows)", "ForEach(split.shown)", "if !split.folded.isEmpty", "PullRequestsSettledRow(",
      "if settledOpen", "ForEach(split.folded)",
    ]
    var cursor = section.startIndex
    for marker in markers {
      let hit = try #require(section.range(of: marker, range: cursor..<section.endIndex), "\(marker) out of order")
      cursor = hit.upperBound
    }
    let row = try Self.body(of: "PullRequestsSettledRow", in: code)
    #expect(row.contains("Button(action: toggle)"))
    #expect(row.contains(".accessibilityLabel(UICopy.pullRequestsSettledSpoken(count))"))
    #expect(row.contains(".accessibilityValue(open ? UICopy.disclosureExpanded : UICopy.disclosureCollapsed)"))
    #expect(row.contains("\"inspector.pullRequests.settled\""))
  }

  @Test("the GitHub state word is its own label; the rest of the secondary line stays in muted2")
  func stateInSecondaryLine() throws {
    let row = try Self.body(of: "PullRequestRowView", in: try Self.code())
    #expect(row.contains("PullRequestStateLabel(state: state, word: word)"))
    #expect(row.contains("StateLine(parts: row.status(now: now).map { StateLine.Part(text: $0, ink: Palette.muted2) })"))
  }
}
