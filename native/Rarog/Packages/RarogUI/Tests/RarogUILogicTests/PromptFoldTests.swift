import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Zwijanie długich promptów: reguła linii z modelu, zwinięcie w wierszach echa i wpisu
// w locie, stan rozwinięcia w `TranscriptReading`. Właściciel: transkrypt.

private func prompt(_ seq: Int, _ text: String, role: String = "user", ago: TimeInterval = 60) -> TranscriptMessage {
  Sample.decode(
    TranscriptMessage.self,
    #"{"seq":\#(seq),"role":"\#(role)","blocks":\#(Sample.text(text)),"at":"\#(Sample.iso(ago))"}"#)
}

private func long(_ count: Int) -> String {
  (1...count).map { "Linia \($0) długiego promptu" }.joined(separator: "\n")
}

private func folds(_ rows: [TranscriptRow]) -> [String: PromptFold] {
  Dictionary(uniqueKeysWithValues: rows.compactMap { row in row.turn.fold.map { (row.id, $0) } })
}

@Suite("długi prompt zwinięty do 6 linii")
struct PromptFoldTests {
  @Test("linie z tekstu: linia źródła ⌈znaki / 100⌉, pusta 1, koniec bez białych znaków, CRLF i emoji")
  func lineRule() {
    #expect(PromptFolds.lines("") == 0)
    #expect(PromptFolds.lines("jedna") == 1)
    #expect(PromptFolds.lines("a\nb") == 2)
    #expect(PromptFolds.lines("a\n\nb") == 3, "pusta linia w środku liczy się")
    #expect(PromptFolds.lines("a\nb\n\n\n  ") == 2, "białe znaki na końcu nie")
    #expect(PromptFolds.lines(String(repeating: "x", count: 100)) == 1)
    #expect(PromptFolds.lines(String(repeating: "x", count: 101)) == 2)
    #expect(PromptFolds.lines(String(repeating: "x", count: 250) + "\nkrótka") == 4)
    #expect(PromptFolds.lines("a\r\nb\r\nc") == 3, "CRLF to jeden grafem — podział go widzi")
    #expect(PromptFolds.lines(String(repeating: "👩‍💻", count: 100)) == 1, "emoji z łącznikiem to jeden znak")
    #expect(PromptFolds.fold(long(15), expanded: false) == nil, "15 linii stoi całe")
    #expect(PromptFolds.fold(long(16), expanded: false) == PromptFold(lines: 16, expanded: false))
    #expect(PromptFolds.fold(String(repeating: "słowo ", count: 300), expanded: true) == PromptFold(lines: 18, expanded: true))
  }

  @Test("echo długiego promptu zwinięte; krótki, odpowiedź agenta i system — bez zwijania")
  func echoRows() {
    let messages = [
      prompt(1, long(20), ago: 90), prompt(2, long(30), role: "assistant", ago: 80), prompt(3, "Krótko", ago: 70),
      prompt(4, long(25), role: "system", ago: 60),
    ]
    let state = Sample.state(session: Sample.session(), messages: messages)
    let rows = TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar)
    #expect(folds(rows) == ["m1.0": PromptFold(lines: 20, expanded: false)])
    // Zwinięcie nie rusza reszty miejsca w turze: nagłówek i godzina zostają.
    let first = rows.first { $0.id == "m1.0" }
    #expect(first?.turn.promptHead == true && first?.turn.clock != nil)
  }

  @Test("rozwinięcie kluczem wiersza; przestawienie każe zapisać miejsce czytania")
  func toggle() {
    var ui = TranscriptUIState()
    ui.reading.togglePrompt("m1.0")
    let moved = ui.reading.takeMoved()
    #expect(moved, "rozwinięcie przestawia treść ręką")
    let state = Sample.state(session: Sample.session(), messages: [prompt(1, long(20))])
    var rows = TranscriptRows.build(state: state, sessionId: "s1", ui: ui, calendar: Sample.calendar)
    #expect(folds(rows)["m1.0"] == PromptFold(lines: 20, expanded: true))
    ui.reading.togglePrompt("m1.0")
    rows = TranscriptRows.build(state: state, sessionId: "s1", ui: ui, calendar: Sample.calendar)
    #expect(folds(rows)["m1.0"] == PromptFold(lines: 20, expanded: false))
  }

  @Test("wpis w locie zwija się tą samą regułą co jego echo; rozwinięty przenosi rozwinięcie na echo")
  func pendingAndEcho() {
    var state = Sample.state(session: Sample.session(), messages: [prompt(1, "Wcześniej", role: "assistant", ago: 90)])
    let entry = OutboxEntry(sessionId: "s1", text: long(20), attachments: [], createdAt: Sample.now)
    state.outbox = [entry]
    var ui = TranscriptUIState()
    var rows = TranscriptRows.build(state: state, sessionId: "s1", ui: ui, calendar: Sample.calendar)
    let pendingId = "o\(entry.id.uuidString)"
    #expect(folds(rows)[pendingId] == PromptFold(lines: 20, expanded: false))

    ui.reading.togglePrompt(pendingId)
    rows = TranscriptRows.build(state: state, sessionId: "s1", ui: ui, calendar: Sample.calendar)
    #expect(folds(rows)[pendingId]?.expanded == true)

    // Echo przyszło: wpis zgasł, wiadomość 2 to jego echo — rozwinięcie przechodzi na nią.
    state.outbox = []
    state.echoed[entry.id] = 2
    state.transcripts["s1"]?.messages.append(prompt(2, long(20), ago: 10))
    ui.reading.prepare(state.transcripts["s1"], echoed: state.echoed)
    rows = TranscriptRows.build(state: state, sessionId: "s1", ui: ui, calendar: Sample.calendar)
    #expect(folds(rows)["m2.0"] == PromptFold(lines: 20, expanded: true))
  }

  @Test("rozwinięcie wiadomości, której już nie ma, wypada; istniejącej zostaje")
  func prune() {
    var view = TranscriptState()
    view.messages = [prompt(1, long(20)), prompt(2, long(20))]
    view.snapshots = 1
    var reading = TranscriptReading()
    reading.togglePrompt("m1.0")
    reading.togglePrompt("m2.0")
    view.messages = [prompt(2, long(20))]
    reading.prepare(view)
    #expect(reading.expandedPrompts == ["m2.0"])
  }

  @Test("napis przycisku: liczba linii z odmianą, „Zwiń” po rozwinięciu")
  func copy() {
    #expect(UICopy.promptFoldShow(lines: 16) == "Pokaż całość · 16\u{00A0}linii")
    #expect(UICopy.promptFoldShow(lines: 22) == "Pokaż całość · 22\u{00A0}linie")
    #expect(UICopy.promptFoldHide == "Zwiń")
  }
}
