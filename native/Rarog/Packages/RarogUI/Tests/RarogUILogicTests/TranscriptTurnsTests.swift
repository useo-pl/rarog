import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

/// Wiadomość z czasem `ago` sekund przed `Sample.now` i dowolnymi blokami JSON.
private func message(
  _ seq: Int, _ role: String, ago: TimeInterval, blocks: String, attachments: String? = nil
) -> TranscriptMessage {
  let extra = attachments.map { #","attachments":\#($0)"# } ?? ""
  return Sample.decode(
    TranscriptMessage.self, #"{"seq":\#(seq),"role":"\#(role)","blocks":\#(blocks),"at":"\#(Sample.iso(ago))"\#(extra)}"#)
}

/// Wiadomość z jawnym czasem ISO (granice dni).
private func message(_ seq: Int, _ role: String, at: String, blocks: String) -> TranscriptMessage {
  Sample.decode(TranscriptMessage.self, #"{"seq":\#(seq),"role":"\#(role)","blocks":\#(blocks),"at":"\#(at)"}"#)
}

private func buildRows(_ messages: [TranscriptMessage], ui: TranscriptUIState = TranscriptUIState()) -> [TranscriptRow] {
  TranscriptRows.build(
    state: Sample.state(session: Sample.session(), messages: messages), sessionId: "s1", ui: ui, calendar: Sample.calendar)
}

private func tool(_ summary: String) -> String {
  #"[{"type":"tool-call","toolName":"Grep","summary":"\#(summary)"}]"#
}

private let photo = #"[{"kind":"image","name":"","bytes":10,"mime":"image/png","file":"1790000000000-0123456789abcdef.png"}]"#

private func gaps(_ rows: [TranscriptRow]) -> [String: TurnGap] {
  Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.turn.gap) })
}

@Suite("granice tur: 32 pt nad promptem, 10 pt nad odpowiedzią")
struct TranscriptTurnsTests {
  @Test("prompt zaczyna turę, pierwszy wiersz po nim — narzędzie albo otwarta odpowiedź — trzyma się promptu")
  func textToolAndOpen() {
    let messages = [
      message(1, "user", ago: 90, blocks: Sample.text("Sprawdź import")),
      message(2, "assistant", ago: 89, blocks: tool("krok")),
      message(3, "assistant", ago: 88, blocks: Sample.text("Gotowe.")),
      message(4, "user", ago: 87, blocks: Sample.text("A testy?")),
    ]
    let state = Sample.state(session: Sample.session(), messages: messages, open: "Puszczam…")
    let rows = TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar)
    #expect(rows.map(\.id) == ["m1.0", "m2.0", "m3.0", "m4.0", "open"])
    // Pierwszy wiersz listy bez granicy: nad nim nic nie stoi.
    #expect(rows.map(\.turn.gap) == [.flow, .afterPrompt, .flow, .turn, .afterPrompt])
  }

  @Test("rozwinięta seria po prompcie: granicę niesie pierwszy krok, nie rozwijak nad ostatnim")
  func expandedRunAfterPrompt() {
    let messages = [message(1, "user", ago: 90, blocks: Sample.text("Szukaj"))]
      + (2...4).map { message($0, "assistant", ago: 90 - Double($0), blocks: tool("krok \($0)")) }
    var ui = TranscriptUIState()
    ui.reading.toggleRun(2)
    let rows = buildRows(messages, ui: ui)
    #expect(rows.map(\.id) == ["m1.0", "m2.0", "m3.0", "r2", "m4.0"])
    #expect(gaps(rows)["m2.0"] == .afterPrompt && gaps(rows)["r2"] == .flow && gaps(rows)["m3.0"] == .flow)
  }

  @Test("znacznik nad wiadomością jest pierwszym wierszem bloku: niesie granicę; nad promptem przerwy nie ma")
  func markerCarriesBoundary() {
    let messages = [
      message(1, "assistant", ago: 7_200, blocks: Sample.text("Wcześniej")),
      message(2, "user", ago: 3_600, blocks: Sample.text("Wracam")),
      message(3, "assistant", ago: 1_200, blocks: Sample.text("Po przerwie")),
    ]
    let rows = buildRows(messages)
    // Godzina po przerwie nad promptem zbędna — stoi przy dymku; nad odpowiedzią po przerwie — tak.
    #expect(rows.map(\.id) == ["m1.0", "m2.0", "t3", "m3.0"])
    #expect(rows.map(\.turn.gap) == [.flow, .turn, .afterPrompt, .flow])
  }

  @Test("zdjęcia promptu nie zużywają granicy po prompcie; samo zdjęcie też zaczyna turę")
  func photosInPrompt() {
    let messages = [
      message(1, "assistant", ago: 95, blocks: Sample.text("Pokaż")),
      message(2, "user", ago: 94, blocks: Sample.text("Zrzut"), attachments: photo),
      message(3, "assistant", ago: 93, blocks: Sample.text("Widzę")),
      message(4, "user", ago: 92, blocks: "[]", attachments: photo),
      message(5, "assistant", ago: 91, blocks: Sample.text("I to")),
    ]
    let rows = buildRows(messages)
    #expect(rows.map(\.id) == ["m1.0", "m2.0", "m2.a", "m3.0", "m4.a", "m5.0"])
    // Zdjęcia pod tekstem promptu stoją tuż pod dymkiem.
    #expect(rows.map(\.turn.gap) == [.flow, .turn, .underPlate, .afterPrompt, .turn, .afterPrompt])
  }

  @Test("cecha nagłówka na pierwszym wierszu promptu, godzina na ostatnim (tekst albo zdjęcia)")
  func promptHeadAndClock() {
    let messages = [
      message(1, "user", ago: 94, blocks: Sample.text("Zrzut"), attachments: photo),
      message(2, "user", ago: 93, blocks: Sample.text("Sam tekst")),
      message(3, "user", ago: 92, blocks: "[]", attachments: photo),
    ]
    let rows = buildRows(messages)
    let clock = { (index: Int) in ServerTime.clock(messages[index].at, timeZone: Sample.calendar.timeZone) }
    #expect(rows.map(\.id) == ["m1.0", "m1.a", "m2.0", "m3.a"])
    #expect(rows.map(\.turn.promptHead) == [true, false, true, true])
    #expect(rows.map(\.turn.clock) == [nil, clock(0), clock(1), clock(2)])

    // Prompt z dwoma blokami tekstu: nagłówek raz, godzina przy ostatnim bloku.
    let twoBlocks = message(4, "user", ago: 91, blocks: #"[{"type":"text","text":"Pierwszy"},{"type":"text","text":"Drugi"}]"#)
    let blockRows = buildRows([twoBlocks])
    #expect(blockRows.map(\.id) == ["m4.0", "m4.1"])
    #expect(blockRows.map(\.turn.promptHead) == [true, false])
    #expect(blockRows.map(\.turn.clock) == [nil, ServerTime.clock(twoBlocks.at, timeZone: Sample.calendar.timeZone)])
  }

  @Test("zmiana dnia: data nad promptem (bez godziny), nad odpowiedzią data z godziną; 10 min nad promptem — nic")
  func dayChange() {
    let messages = [
      message(1, "assistant", at: "2026-10-08T21:00:00Z", blocks: Sample.text("Wieczorem")),
      message(2, "user", at: "2026-10-09T07:15:00Z", blocks: Sample.text("Rano")),
      message(3, "assistant", at: "2026-10-09T07:16:00Z", blocks: Sample.text("Dzień dobry")),
      message(4, "user", at: "2026-10-09T08:30:00Z", blocks: Sample.text("Po przerwie")),
      message(5, "assistant", at: "2026-10-10T00:05:00Z", blocks: Sample.text("Po północy")),
    ]
    let rows = buildRows(messages)
    #expect(rows.map(\.id) == ["m1.0", "t2", "m2.0", "m3.0", "m4.0", "t5", "m5.0"])
    let friday = TimeMark(day: "pt. 9 paź", spokenDay: "Piątek, 9 października", clock: nil)
    #expect(rows[1] == .timeGap(id: "t2", mark: friday, turn: TurnMark(gap: .turn)), "nad promptem sama data")
    #expect(rows[2].turn == TurnMark(promptHead: true, clock: "07:15"), "prompt pod datą: godzina przy dymku")
    let saturday = TimeMark(day: "sob. 10 paź", spokenDay: "Sobota, 10 października", clock: "00:05")
    #expect(rows[5] == .timeGap(id: "t5", mark: saturday, turn: TurnMark(gap: .afterPrompt)))
    #expect(UICopy.timeGap(saturday) == "— sob. 10 paź · 00:05 —")
    #expect(UICopy.timeGapSpoken(saturday) == "Sobota, 10 października, od 00:05")
    #expect(UICopy.timeGapSpoken(friday) == "Piątek, 9 października")
  }

  @Test("zaległa zmiana dnia ze schowanego kroku stoi nad rozwijakiem; po rozwinięciu — nad samym krokiem")
  func dayChangeInsideCollapsedRun() {
    let messages = [
      message(1, "user", at: "2026-10-08T23:50:00Z", blocks: Sample.text("Na noc")),
      message(2, "assistant", at: "2026-10-08T23:55:00Z", blocks: tool("krok 2")),
      message(3, "assistant", at: "2026-10-09T00:04:00Z", blocks: tool("krok 3")),
      message(4, "assistant", at: "2026-10-09T00:06:00Z", blocks: tool("krok 4")),
      message(5, "assistant", at: "2026-10-09T00:07:00Z", blocks: Sample.text("Gotowe")),
    ]
    var collapsed = buildRows(messages)
    #expect(collapsed.map(\.id) == ["m1.0", "t4", "r2", "m4.0", "m5.0"])
    if case let .timeGap(_, mark, turn) = collapsed[1] {
      #expect(mark == TimeMark(day: "pt. 9 paź", spokenDay: "Piątek, 9 października", clock: "00:06"))
      #expect(turn.gap == .afterPrompt, "znacznik pierwszym wierszem po prompcie")
    } else {
      Issue.record("brak znacznika dnia: \(collapsed)")
    }
    var ui = TranscriptUIState()
    ui.reading.toggleRun(2)
    collapsed = buildRows(messages, ui: ui)
    #expect(collapsed.map(\.id) == ["m1.0", "m2.0", "t3", "m3.0", "r2", "m4.0", "m5.0"])
    #expect(PromptBar.seq(rowId: "t3") == 3)
  }

  @Test("wpis w locie z samym zdjęciem zaczyna turę wierszem miniatur, jak jego przyszłe echo")
  func pendingPhotoOnly() {
    var state = Sample.state(
      session: Sample.session(), messages: [message(1, "assistant", ago: 90, blocks: Sample.text("Czekam"))])
    let entry = OutboxEntry(sessionId: "s1", text: "", attachments: [.init(name: "", bytes: 10, kind: .image)], createdAt: Sample.now)
    state.outbox = [entry]
    let rows = TranscriptRows.build(state: state, sessionId: "s1")
    #expect(rows.first { $0.id == "a\(entry.id.uuidString)" }?.turn.gap == .turn)
  }

  @Test("a closed reply gets the time on its last agent text only, from that text's message")
  func replyClockOnLastText() {
    let messages = [
      message(1, "user", ago: 600, blocks: Sample.text("Check the import")),
      message(2, "assistant", ago: 540, blocks: Sample.text("Looking.")),
      message(3, "assistant", ago: 480, blocks: tool("step")),
      message(4, "assistant", ago: 420, blocks: Sample.text("Done.")),
      message(5, "user", ago: 360, blocks: Sample.text("And the tests?")),
    ]
    let rows = buildRows(messages)
    let clock = { (index: Int) in ServerTime.clock(messages[index].at, timeZone: Sample.calendar.timeZone) }
    #expect(rows.map(\.id) == ["m1.0", "m2.0", "m3.0", "m4.0", "m5.0"])
    #expect(rows.map(\.turn.clock) == [clock(0), nil, nil, clock(3), clock(4)])
    #expect(clock(3) != clock(1), "the value comes from the last text's message, not the reply's first")

    // Text, tool and text in one message: the time stands under the last text block.
    let mixed = message(
      2, "assistant", ago: 540,
      blocks: #"[{"type":"text","text":"First"},{"type":"tool-call","toolName":"Grep","summary":"x"},{"type":"text","text":"Last"}]"#)
    let mixedRows = buildRows([messages[0], mixed, messages[4]])
    let mixedClock = ServerTime.clock(mixed.at, timeZone: Sample.calendar.timeZone)
    #expect(mixedRows.map(\.id) == ["m1.0", "m2.0", "m2.1", "m2.2", "m5.0"])
    #expect(mixedRows.map(\.turn.clock) == [clock(0), nil, nil, mixedClock, clock(4)])
  }

  @Test("the last reply gets its time only after the turn ends, not while the agent works or waits")
  func lastReplyClockAfterTurnEnd() {
    let messages = [
      message(1, "user", ago: 120, blocks: Sample.text("Go")),
      message(2, "assistant", ago: 60, blocks: Sample.text("Working on it.")),
    ]
    let replyClock = ServerTime.clock(messages[1].at, timeZone: Sample.calendar.timeZone)
    func clock(state: String, decision: Bool = false) -> String? {
      var built = Sample.state(session: Sample.session(state: state), messages: messages)
      if decision { built.transcripts["s1"]?.pendingPermissions = [Sample.permission()] }
      let rows = TranscriptRows.build(state: built, sessionId: "s1", calendar: Sample.calendar)
      return rows.first { $0.id == "m2.0" }?.turn.clock
    }
    #expect(clock(state: "running") == nil)
    #expect(clock(state: "starting") == nil)
    #expect(clock(state: "waiting-permission") == nil)
    #expect(clock(state: "waiting-question") == nil)
    #expect(clock(state: "waiting-input", decision: true) == nil, "a card still waits for a decision")
    #expect(clock(state: "waiting-input") == replyClock)
    #expect(clock(state: "done") == replyClock)
    #expect(clock(state: "interrupted") == replyClock)
  }

  @Test("a reply without text and the streaming row get no time")
  func toolOnlyReplyAndOpenRow() {
    let toolOnly = [
      message(1, "user", ago: 120, blocks: Sample.text("Search")),
      message(2, "assistant", ago: 90, blocks: tool("step")),
      message(3, "user", ago: 60, blocks: Sample.text("Again")),
      message(4, "assistant", ago: 30, blocks: tool("step")),
    ]
    let rows = TranscriptRows.build(
      state: Sample.state(session: Sample.session(state: "waiting-input"), messages: toolOnly), sessionId: "s1",
      calendar: Sample.calendar)
    #expect(rows.filter { $0.turn.clock != nil }.map(\.id) == ["m1.0", "m3.0"], "prompt times only")

    // A streaming reply after a text: the turn is not over, so neither the text nor the open row has a time.
    let streaming = Sample.state(
      session: Sample.session(state: "waiting-input"),
      messages: [toolOnly[0], message(2, "assistant", ago: 90, blocks: Sample.text("So far"))], open: "More…")
    let openRows = TranscriptRows.build(state: streaming, sessionId: "s1", calendar: Sample.calendar)
    let promptClock = ServerTime.clock(toolOnly[0].at, timeZone: Sample.calendar.timeZone)
    #expect(openRows.map(\.id) == ["m1.0", "m2.0", "open"])
    #expect(openRows.map(\.turn.clock) == [promptClock, nil, nil])
  }
}
