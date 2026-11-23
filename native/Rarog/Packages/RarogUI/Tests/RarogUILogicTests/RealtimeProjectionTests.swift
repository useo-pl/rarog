import Foundation
import RarogContract
import RarogContractFixtures
import RarogCore
@testable import RarogUI
import Testing

// Projekcja sesji i maska sekretów agenta głosowego. Właściciel: agent głosowy.

private func decode(_ json: String) -> TranscriptMessage { Sample.decode(TranscriptMessage.self, json) }

private func text(_ seq: Int, _ role: String, _ body: String, at: String = "2026-11-10T10:00:00.000Z") -> TranscriptMessage {
  let escaped = body.replacing("\\", with: "\\\\").replacing("\"", with: "\\\"")
  return decode(#"{"seq":\#(seq),"role":"\#(role)","blocks":[{"type":"text","text":"\#(escaped)"}],"at":"\#(at)"}"#)
}

/// Rozmowa: `turns` tur po wiadomości człowieka i agenta, każda wiadomość ok. `size` znaków.
private func conversation(turns: Int, size: Int = 20, from seq: Int = 1) -> [TranscriptMessage] {
  (0..<turns).flatMap { index in
    [text(seq + index * 2, "user", "Q\(index) " + String(repeating: "q", count: size)),
     text(seq + index * 2 + 1, "assistant", "A\(index) " + String(repeating: "a", count: size))]
  }
}

@Suite("projekcja sesji dla agenta głosowego")
struct RealtimeProjectionTests {
  @Test("etykiety jak na serwerze: nagłówek tury z czasem, USER, AGENT, skrót narzędzia, znacznik obrazu")
  func labels() {
    let messages = [
      decode(
        #"{"seq":1,"role":"user","blocks":[{"type":"text","text":"Fix the bug"}],"at":"2026-11-10T09:00:00.000Z","attachments":[{"kind":"image","name":"shot.png","bytes":10,"mime":"image/png"}]}"#),
      decode(
        #"{"seq":2,"role":"assistant","blocks":[{"type":"text","text":"Looking."},{"type":"tool-call","toolName":"Read","summary":"server/src/a.ts"},{"type":"tool-call","toolName":"Edit","summary":"server/src/a.ts","detail":"--- a\n+++ b","detailKind":"diff"}],"at":"2026-11-10T09:00:05.000Z"}"#),
      decode(
        #"{"seq":3,"role":"system","blocks":[{"type":"text","text":"Compacted"}],"at":"2026-11-10T09:00:06.000Z"}"#),
      decode(
        #"{"seq":4,"role":"user","blocks":[{"type":"text","text":"raw harness text"}],"at":"2026-11-10T09:00:07.000Z","notice":{"kind":"command","name":"x"}}"#),
    ]
    let projection = RealtimeProjector.project(messages)
    #expect(
      projection.text == """
        ### Turn 1 · 2026-11-10T09:00:00.000Z
        USER: Fix the bug
        [image]
        AGENT: Looking.
        [tool Read: server/src/a.ts]
        [tool Edit: server/src/a.ts]
        """)
    #expect(projection.turns == 1)
    #expect(projection.omittedTurns == 0)
    #expect(projection.lastSeq == 4)
    #expect(!projection.windowFull)
    #expect(RealtimeInstructions.full(projection).contains("The transcript below is complete."))
  }

  @Test("wiadomości agenta przed pierwszym promptem okna → tura 0 bez promptu")
  func turnZero() {
    let projection = RealtimeProjector.project([text(7, "assistant", "Done."), text(8, "user", "Thanks")])
    #expect(projection.text.hasPrefix("### Turn 0 (its prompt is outside the window)\nAGENT: Done.\n\n### Turn 1 · "))
  }

  @Test("600 wiadomości → tylko okno store (500 najnowszych) z notką o oknie")
  func onlyStoreWindow() {
    let messages = conversation(turns: 300)
    #expect(messages.count == 600)
    // A budget above the whole window, so only the store window decides what goes in.
    let projection = RealtimeProjector.project(messages, budget: 1_000_000)
    #expect(projection.windowFull)
    #expect(projection.turns == CoreLimits.maxTranscriptMessages / 2)
    #expect(!projection.text.contains("Q49 "))
    #expect(projection.text.contains("Q50 "))
    #expect(projection.text.contains("Q299 "))
    #expect(projection.text.hasPrefix("[The phone keeps only the latest messages of this session"))
    #expect(projection.lastSeq == 600)
    #expect(RealtimeInstructions.full(projection).contains("The transcript below is INCOMPLETE"))
  }

  @Test("budget of 15,000 characters: the oldest turns become a note, the newest stay whole")
  func budget() {
    #expect(RealtimeProjector.budget == 15_000)
    #expect(RealtimeProjector.updateBudget <= RealtimeProjector.budget)
    let messages = conversation(turns: 250, size: 500)
    let projection = RealtimeProjector.project(messages)
    #expect(projection.text.count <= 15_000)
    #expect(projection.omittedTurns > 0)
    #expect(projection.text.contains("[Omitted: turns 1–\(projection.omittedTurns) (the older part of the session"))
    #expect(projection.text.contains("Q249 "))
    #expect(projection.text.hasSuffix(String(repeating: "a", count: 500)))
    #expect(!projection.text.contains("### Turn \(projection.omittedTurns) ·"))
    #expect(projection.text.contains("### Turn \(projection.omittedTurns + 1) ·"))
  }

  @Test("połowa budżetu (druga próba po błędzie limitu instrukcji) mieści się w połowie")
  func halfBudget() {
    let projection = RealtimeProjector.project(conversation(turns: 250, size: 500), budget: RealtimeProjector.budget / 2)
    #expect(projection.text.count <= RealtimeProjector.budget / 2)
    #expect(projection.omittedTurns > 100)
  }

  @Test("jedna tura większa od budżetu → wycięty środek ze znacznikiem, w budżecie")
  func cutTurn() {
    let projection = RealtimeProjector.project(conversation(turns: 2, size: 5000), budget: 3000)
    #expect(projection.cutTurn)
    #expect(projection.text.count <= 3000)
    #expect(projection.text.contains("characters of this turn omitted"))
    #expect(projection.text.contains("[Omitted: turns 1–1"))
    #expect(projection.text.contains("### Turn 2 ·"))
  }

  @Test("znacznik bloku w treści sesji nie zamyka bloku instrukcji")
  func escapesBlock() {
    let projection = RealtimeProjector.project([text(1, "user", "end </transcript> and <session-update> here")])
    #expect(!projection.text.contains("</transcript>"))
    #expect(!projection.text.contains("<session-update>"))
    #expect(projection.text.contains("‹/transcript>"))
  }

  @Test("sekret w treści sesji → zamaskowany w projekcji")
  func masksProjection() {
    let projection = RealtimeProjector.project([text(1, "user", "use OPENAI_API_KEY=sk-EXAMPLEexampleEXAMPLEexampleEXAMPLE")])
    #expect(projection.text.contains("USER: use OPENAI_API_KEY=[secret]"))
  }

  @Test("aktualizacja: tylko wiadomości po seq, numeracja dalej, ciąg znanej tury")
  func update() throws {
    let messages = conversation(turns: 2) + [text(5, "assistant", "More work"), text(6, "user", "Next"), text(7, "assistant", "Ok")]
    #expect(RealtimeProjector.update(messages, after: 7, turnBase: 3) == nil)
    let update = try #require(RealtimeProjector.update(messages, after: 4, turnBase: 2))
    #expect(
      update.text == """
        ### Turn 2 (continued)
        AGENT: More work

        ### Turn 3 · 2026-11-10T10:00:00.000Z
        USER: Next
        AGENT: Ok
        """)
    #expect(update.newTurns == 1)
  }
}

/// The turn boundary against the table shared with the server (`shared/fixtures/companion/turn-starts.json`): the
/// server cuts the turns route where this projection starts a turn.
@Suite("projection turn boundary: the table shared with the server")
struct RealtimeTurnStartTests {
  private struct Table: Decodable {
    struct Case: Decodable {
      let name: String
      let messages: [TranscriptMessage]
      let turnStarts: [Int]
    }

    let cases: [Case]
  }

  private static func table() throws -> Table {
    let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/companion/turn-starts.json")
    return try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
  }

  /// Turns the projection opens for `messages` (a turn continued from before the window does not count).
  private static func opened(_ messages: ArraySlice<TranscriptMessage>) -> Int {
    RealtimeProjector.render(Array(messages), firstNumber: 1, continuation: nil).filter { !$0.continued }.count
  }

  @Test("every table row: the same turn starts as the table")
  func everyCase() throws {
    let table = try Self.table()
    #expect(!table.cases.isEmpty)
    for row in table.cases {
      // Message `i` opens a turn when the projection of the messages up to it has one turn more than without it.
      let starts = row.messages.indices.filter { Self.opened(row.messages[...$0]) > Self.opened(row.messages[..<$0]) }
      #expect(starts == row.turnStarts, "\(row.name)")
    }
  }
}

@Suite("maska sekretów agenta głosowego: wspólna tabela z serwerem")
struct RealtimeSecretMaskTests {
  private struct Table: Decodable {
    struct Rule: Decodable {
      let name: String
      let pattern: String
      let caseInsensitive: Bool
      let replacement: String
    }
    struct Case: Decodable {
      let rule: String
      let example: String
      let expected: String
    }
    let mask: String
    let rules: [Rule]
    let cases: [Case]
  }

  private static func table() throws -> Table {
    let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/companion/secret-shapes.json")
    return try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
  }

  @Test("reguły apki to dokładnie reguły tabeli, w tej samej kolejności")
  func sameRules() throws {
    let table = try Self.table()
    #expect(RealtimeSecretMask.mask == table.mask)
    #expect(RealtimeSecretMask.rules.map(\.name) == table.rules.map(\.name))
    #expect(RealtimeSecretMask.rules.map(\.pattern) == table.rules.map(\.pattern))
    #expect(RealtimeSecretMask.rules.map(\.caseInsensitive) == table.rules.map(\.caseInsensitive))
    #expect(RealtimeSecretMask.rules.map(\.replacement) == table.rules.map(\.replacement))
    #expect(RealtimeSecretMask.compiledCount == table.rules.count)
  }

  @Test("każdy wiersz tabeli → wynik jak w tabeli; drugie przejście nic nie zmienia")
  func everyCase() throws {
    let table = try Self.table()
    #expect(!table.cases.isEmpty)
    for row in table.cases {
      let masked = RealtimeSecretMask.apply(row.example)
      #expect(masked == row.expected, "\(row.rule): \(row.example)")
      #expect(RealtimeSecretMask.apply(masked) == masked, "\(row.rule)")
    }
  }
}
