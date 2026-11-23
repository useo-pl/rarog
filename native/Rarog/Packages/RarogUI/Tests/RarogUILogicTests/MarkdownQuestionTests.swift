import Foundation
import RarogContractFixtures
import RarogUI
import Testing

// The question marker against the table shared with the server (`shared/fixtures/companion/asks-owner.json`): the
// server tells the voice agent that a session asks the owner exactly when the app marks the question in its
// transcript. Owner: transcript, markdown.

@Suite("markdown: the question marker by the table shared with the server")
struct MarkdownQuestionTests {
  private struct Table: Decodable {
    struct Case: Decodable {
      let name: String
      let text: String
      let asksOwner: Bool
    }

    let markers: [String]
    let cases: [Case]
  }

  private static func table() throws -> Table {
    let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/companion/asks-owner.json")
    return try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
  }

  @Test("the app's markers are the table's markers")
  func sameMarkers() throws {
    #expect(MarkdownQuestion.markers == (try Self.table()).markers)
  }

  @Test("every table row: a question or none, as the table says")
  func everyCase() throws {
    let table = try Self.table()
    #expect(!table.cases.isEmpty)
    for row in table.cases {
      #expect(MarkdownQuestion.contains(row.text) == row.asksOwner, "\(row.name)")
    }
  }
}
