import Foundation
import RarogContract
@testable import RarogCore
import Testing

private let sent = Date(timeIntervalSince1970: 1_790_000_000)
private func iso(_ offset: TimeInterval) -> String { ISOTime.string(sent.addingTimeInterval(offset)) }

@Suite("echo wysyłki: pełny podpis, najstarszy pierwszy, tylko nowsze (WYS-03)")
struct EchoTests {
  private func state(with entries: [OutboxEntry]) throws -> AppState {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot([Frames.summary("s1")])])
    play(&state, [try Frames.transcript("s1")], source: .session("s1"))
    for entry in entries { state.apply(.outboxEnqueued(entry), now: sent) }
    return state
  }

  @Test("„ok”, „ok”: pierwsze echo gasi pierwszy wpis, drugie drugi; replay nie gasi drugiego")
  func twoIdentical() throws {
    let first = OutboxEntry(sessionId: "s1", text: "ok", createdAt: sent)
    let second = OutboxEntry(sessionId: "s1", text: "ok", createdAt: sent.addingTimeInterval(1))
    var state = try state(with: [first, second])
    let echo = try Frames.message("s1", seq: 10, role: "user", text: "ok", at: iso(2))
    let effects = state.apply(.frame(echo, source: .session("s1"), cursor: nil), now: sent)
    #expect(effects == [.forgetOutboxEntry(first.id)])
    #expect(state.outbox.map(\.id) == [second.id])
    #expect(state.echoed[first.id] == 10)
    // Powtórka tej samej ramki (replay) nie gasi drugiego wpisu.
    state.apply(.frame(echo, source: .session("s1"), cursor: nil), now: sent)
    #expect(state.outbox.map(\.id) == [second.id])
    try receive(&state, seq: 11, role: "user", text: "ok", at: iso(3))
    #expect(state.outbox.isEmpty)
  }

  @Test("podpis obejmuje nazwy i rozmiary załączników (echo bez identyfikatora: starszy serwer)")
  func attachmentsInSignature() throws {
    let text = "Porównaj zrzut z raportem i popraw manifest."
    let wrong = OutboxEntry(sessionId: "s1", text: text, createdAt: sent.addingTimeInterval(-30))
    let right = OutboxEntry(
      sessionId: "s1", text: text,
      attachments: [.init(name: "", bytes: 67, kind: .image), .init(name: "raport-kontraktu.pdf", bytes: 9)],
      createdAt: sent)
    var state = try state(with: [wrong, right])
    let echo = try Frames.message("s1", seq: 9, role: "user", text: text, at: iso(5), attachments: #"""
      {"kind":"image","name":"","bytes":67,"mime":"image/png"},
      {"kind":"file","name":"raport-kontraktu.pdf","bytes":9,"mime":"application/pdf"}
      """#)
    state.apply(.frame(echo, source: .session("s1"), cursor: nil), now: sent)
    #expect(state.outbox.map(\.id) == [wrong.id], "sam tekst bez załączników to inny podpis")
  }

  @Test("nagrane echo z `clientMessageId` gasi wpis o tym identyfikatorze, nie starszy o tym samym podpisie")
  func echoByClientMessageId() throws {
    let text = "Porównaj zrzut z raportem i popraw manifest."
    let attachments: [OutboxEntry.Attachment] = [
      .init(name: "", bytes: 67, kind: .image), .init(name: "raport-kontraktu.pdf", bytes: 9),
    ]
    let older = OutboxEntry(
      sessionId: "herdr-w1-p2", text: text, attachments: attachments, createdAt: ISOTime.parse("2026-10-03T08:00:39.000Z")!)
    let mine = OutboxEntry(
      id: try #require(UUID(uuidString: "7e1c4a92-5b3d-4f08-a6e2-9c0d1b8f4a57")), sessionId: "herdr-w1-p2", text: text,
      attachments: attachments, createdAt: ISOTime.parse("2026-10-03T08:00:40.000Z")!)
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("transcript-snapshot.min.json")], source: .session("herdr-w1-p2"))
    state.apply(.outboxEnqueued(older), now: sent)
    state.apply(.outboxEnqueued(mine), now: sent)
    play(&state, [try Frames.golden("message.max.json")], source: .session("herdr-w1-p2"))
    #expect(state.outbox.map(\.id) == [older.id], "identyfikator wygrywa z kolejnością podpisu")
    #expect(state.echoed[mine.id] == 9)
  }

  @Test("echo z OBCYM identyfikatorem (inne urządzenie) nie gasi wpisu o tym samym podpisie")
  func foreignIdDoesNotMatch() throws {
    let entry = OutboxEntry(sessionId: "s1", text: "ok", createdAt: sent)
    var state = try state(with: [entry])
    let echo = try Frames.decode(#"""
      {"type":"message","sessionId":"s1","message":{"seq":4,"role":"user","blocks":[{"type":"text","text":"ok"}],
      "at":"\#(iso(1))","clientMessageId":"\#(UUID().uuidString.lowercased())"}}
      """#)
    state.apply(.frame(echo, source: .session("s1"), cursor: nil), now: sent)
    #expect(state.outbox.map(\.id) == [entry.id])
    // To samo echo z identyfikatorem wpisu — gasi, także bez granicy czasu (identyfikator rozstrzyga).
    let mine = try Frames.decode(#"""
      {"type":"message","sessionId":"s1","message":{"seq":5,"role":"user","blocks":[{"type":"text","text":"ok"}],
      "at":"\#(iso(-3600))","clientMessageId":"\#(entry.clientMessageId)"}}
      """#)
    state.apply(.frame(mine, source: .session("s1"), cursor: nil), now: sent)
    #expect(state.outbox.isEmpty)
  }

  @Test("notka harnessu z rolą `user` nie jest echem")
  func noticeIsNotEcho() throws {
    let entry = OutboxEntry(sessionId: "s1", text: "ok", createdAt: sent)
    var state = try state(with: [entry])
    let notice = try Frames.decode(#"""
      {"type":"message","sessionId":"s1","message":{"seq":4,"role":"user","blocks":[{"type":"text","text":"ok"}],
      "at":"\#(iso(1))","notice":{"kind":"command"}}}
      """#)
    state.apply(.frame(notice, source: .session("s1"), cursor: nil), now: sent)
    #expect(state.outbox.count == 1)
  }

  @Test("echo starsze niż wpis (poza zapasem 60 s) nie gasi; wiadomość agenta nie jest echem")
  func olderEchoIgnored() throws {
    let entry = OutboxEntry(sessionId: "s1", text: "ok", createdAt: sent)
    var state = try state(with: [entry])
    try receive(&state, seq: 3, role: "user", text: "ok", at: iso(-600))
    try receive(&state, seq: 4, role: "assistant", text: "ok", at: iso(5))
    #expect(state.outbox.count == 1)
    // W zapasie rozjazdu zegarów (30 s przed wysyłką) — gasi.
    try receive(&state, seq: 5, role: "user", text: "ok", at: iso(-30))
    #expect(state.outbox.isEmpty)
  }

  @Test("`.unconfirmed` entry with an attachment is cleared by a late SSE echo with the same clientMessageId")
  func lateEchoClearsUnconfirmedAttachment() throws {
    var entry = OutboxEntry(
      sessionId: "s1", text: "photo", attachments: [.init(name: "", bytes: 67, kind: .image, mime: "image/jpeg")],
      createdAt: sent)
    entry.state = .unconfirmed
    var state = try state(with: [entry])
    let echo = try Frames.decode(#"""
      {"type":"message","sessionId":"s1","message":{"seq":4,"role":"user","blocks":[{"type":"text","text":"photo"}],
      "at":"\#(iso(75))","clientMessageId":"\#(entry.clientMessageId)",
      "attachments":[{"kind":"image","name":"","bytes":67,"mime":"image/jpeg"}]}}
      """#)
    let effects = state.apply(.frame(echo, source: .session("s1"), cursor: nil), now: sent.addingTimeInterval(75))
    #expect(effects == [.forgetOutboxEntry(entry.id)])
    #expect(state.outbox.isEmpty)
    #expect(state.echoed[entry.id] == 4)
  }

  @Test("snapshot after the stream resumes clears an `.unconfirmed` entry with an attachment by clientMessageId")
  func snapshotClearsUnconfirmedAttachment() throws {
    var entry = OutboxEntry(
      sessionId: "s1", text: "photo", attachments: [.init(name: "", bytes: 67, kind: .image, mime: "image/jpeg")],
      createdAt: sent)
    entry.state = .unconfirmed
    var state = try state(with: [entry])
    let message = #"""
      {"seq":4,"role":"user","blocks":[{"type":"text","text":"photo"}],"at":"\#(iso(75))",
      "clientMessageId":"\#(entry.clientMessageId)","attachments":[{"kind":"image","name":"","bytes":67,"mime":"image/jpeg"}]}
      """#
    let effects = state.apply(
      .frame(try Frames.transcript("s1", messages: [message]), source: .session("s1"), cursor: nil),
      now: sent.addingTimeInterval(130))
    #expect(effects == [.forgetOutboxEntry(entry.id)])
    #expect(state.outbox.isEmpty)
    #expect(state.echoed[entry.id] == 4)
  }

  @Test("pogodzenie snapshotem: gasi tylko wiadomość, której wcześniej nie było")
  func snapshotReconcile() throws {
    let entry = OutboxEntry(sessionId: "s1", text: "ok", createdAt: sent)
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.transcript("s1", messages: [Frames.messageJSON(seq: 1, role: "user", text: "ok", at: iso(5))])],
         source: .session("s1"))
    state.apply(.outboxEnqueued(entry), now: sent)
    // Ten sam snapshot ponownie: „ok” już było — nie gasi.
    play(&state, [try Frames.transcript("s1", messages: [Frames.messageJSON(seq: 1, role: "user", text: "ok", at: iso(5))])],
         source: .session("s1"))
    #expect(state.outbox.count == 1)
    // Snapshot po zerwaniu z nową wiadomością — gasi.
    let effects = state.apply(.frame(try Frames.transcript("s1", messages: [
      Frames.messageJSON(seq: 1, role: "user", text: "ok", at: iso(5)),
      Frames.messageJSON(seq: 2, role: "user", text: "ok", at: iso(8)),
    ]), source: .session("s1"), cursor: nil), now: sent)
    #expect(effects == [.forgetOutboxEntry(entry.id)])
    #expect(state.outbox.isEmpty)
  }

  @Test("odrzucony wpis nie czeka na echo; podpis rozdziela tekst od listy załączników")
  func refusedAndSignature() throws {
    var entry = OutboxEntry(sessionId: "s1", text: "ok", createdAt: sent)
    entry.state = .refused(code: "rate-limited", message: nil)
    var state = try state(with: [entry])
    try receive(&state, seq: 9, role: "user", text: "ok", at: iso(1))
    #expect(state.outbox.count == 1)
    #expect(EchoMatching.signature(text: "ab", attachments: [("", 1)]) != EchoMatching.signature(text: "a", attachments: [("b", 1)]))
  }

  @Test("granica przy wpisie: ten sam proces → po `seq`; restart serwera → po czasie serwera; eksmisja LRU")
  func boundaryRule() throws {
    let firstAt = "2026-10-03T10:00:00.000Z"
    var before = AppState(clientBuild: 7)
    play(&before, [try Frames.hello()])
    play(&before, [try Frames.transcript("s1", messages: [Frames.messageJSON(seq: 1, role: "user", text: "ok", at: firstAt)])],
         source: .session("s1"))
    let boundary = try #require(before.echoBoundary(for: "s1"))
    #expect(boundary == OutboxEntry.EchoBoundary(serverStartId: "s1", maxSeq: 1, lastAt: firstAt))
    var entry = OutboxEntry(sessionId: "s1", text: "ok", createdAt: ISOTime.parse(firstAt)!.addingTimeInterval(10), boundary: boundary)
    entry.state = .unconfirmed

    // Zimny start apki, ten sam proces serwera: snapshot z samym starym echem nie gasi wpisu.
    var cold = AppState(clientBuild: 7)
    cold.apply(.outboxRestored([entry]), now: sent)
    play(&cold, [try Frames.hello()])
    play(&cold, [try Frames.transcript("s1", messages: [Frames.messageJSON(seq: 1, role: "user", text: "ok", at: firstAt)])],
         source: .session("s1"))
    #expect(cold.outbox.count == 1)

    // Restart serwera (inny `serverStartId`, `seq` od nowa): stare echo pod nowym numerem nie gasi,
    // nowe echo (czas serwera późniejszy) gasi.
    var restarted = AppState(clientBuild: 7)
    restarted.apply(.outboxRestored([entry]), now: sent)
    play(&restarted, [try Frames.decode(#"{"type":"hello","protocolVersion":3,"serverStartId":"s2"}"#)])
    play(&restarted, [try Frames.transcript("s1", messages: [Frames.messageJSON(seq: 7, role: "user", text: "ok", at: firstAt)])],
         source: .session("s1"))
    #expect(restarted.outbox.count == 1)
    play(&restarted, [try Frames.message("s1", seq: 8, role: "user", text: "ok", at: "2026-10-03T10:00:12.000Z")],
         source: .session("s1"))
    #expect(restarted.outbox.isEmpty)

    // Eksmisja z LRU w tym samym życiu apki: ponowny snapshot (puste „przed") nie gasi.
    var evicted = before
    evicted.apply(.outboxEnqueued(entry), now: sent)
    evicted.transcripts["s1"] = nil
    play(&evicted, [try Frames.transcript("s1", messages: [Frames.messageJSON(seq: 1, role: "user", text: "ok", at: firstAt)])],
         source: .session("s1"))
    #expect(evicted.outbox.count == 1)
  }
}

/// Echo-kandydat w strumieniu sesji `s1`.
private func receive(_ state: inout AppState, seq: Int, role: String, text: String, at: String) throws {
  state.apply(.frame(try Frames.message("s1", seq: seq, role: role, text: text, at: at), source: .session("s1"), cursor: nil), now: sent)

}
