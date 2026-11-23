import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Notka o prompcie zablokowanym przez hook i przycisk „Uruchom ponownie i wyślij”: wiersz z faktów serwera,
// przycisk tylko pod notką, którą wskazuje karta, stan próby i zwinięcie długiego powodu. Właściciel: transkrypt.

/// Notka tak, jak przychodzi od serwera: rola `system`, bloki z gotowym tekstem (dla starszej apki) i pole
/// `promptBlocked` z powodem i ewentualnym cytatem.
private func blockedMessage(seq: Int, reason: String, prompt: String? = nil) -> TranscriptMessage {
  let field = prompt.map { #","prompt":\#(json($0))"# } ?? ""
  return Sample.decode(TranscriptMessage.self, #"""
    {"seq":\#(seq),"role":"system","blocks":\#(Sample.text("⚠ Hook zablokował prompt — nie został wysłany.\n\(reason)")),
     "at":"\#(Sample.iso(100 - Double(seq)))","promptBlocked":{"reason":\#(json(reason))\#(field)}}
    """#)
}

private func json(_ value: String) -> String {
  String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
}

/// Karta sesji bezczynnej z blokadą o tym `seq` i `id` (albo bez blokady).
private func session(blocked: (seq: Int, id: String)? = nil) -> SessionSummary {
  let extra = blocked.map { #""promptBlocked":{"seq":\#($0.seq),"id":"\#($0.id)"}"# } ?? ""
  return Sample.session(state: "waiting-input", extra: extra)
}

private let reason = "this session must be restarted before it accepts new prompts. Restart Claude Code."

/// Wiersze notek z transkryptu (bez promptów i odpowiedzi).
private func notes(_ rows: [TranscriptRow]) -> [PromptBlockedRowModel] {
  rows.compactMap { row in
    if case let .promptBlocked(model) = row { return model }
    return nil
  }
}

@Suite("notka o prompcie zablokowanym przez hook")
struct PromptBlockedRowTests {
  @Test("wiersz z faktów serwera zamiast tekstu notki: powód, cytat tylko gdy jest; tekst z bloków nie ma wiersza")
  func rowFromFacts() {
    let messages = [
      Sample.message(seq: 1, role: "user", blocks: Sample.text("Popraw testy")),
      blockedMessage(seq: 2, reason: reason),
      blockedMessage(seq: 3, reason: "zablokowane", prompt: "ls -la\npwd"),
      blockedMessage(seq: 4, reason: "  ", prompt: nil),
    ]
    let rows = TranscriptRows.build(state: Sample.state(session: session(), messages: messages), sessionId: "s1")
    #expect(rows.map(\.id) == ["m1.0", "m2.b", "m3.b", "m4.b"], "bloki notki (tekst dla starej apki) bez wiersza")
    let models = notes(rows)
    #expect(models.map(\.detail) == [reason, "zablokowane\nPrompt: ls -la\npwd", ""])
    #expect(models.map(\.seq) == [2, 3, 4])
    #expect(models.allSatisfy { $0.action == nil && $0.fold == nil }, "karta bez blokady: bez przycisku")
    #expect(models[0].voice == .system && models[1].voice == nil, "głos systemu raz, przy zmianie")
    #expect(models[0].turn.gap == .afterPrompt, "notka trzyma się promptu nad nią")
  }

  @Test("przycisk tylko pod notką o `seq` z karty; starsza notka i notka bez wskazania stoją bez niego")
  func buttonUnderPointedNote() throws {
    let messages = [
      Sample.message(seq: 1, role: "user", blocks: Sample.text("a")),
      blockedMessage(seq: 2, reason: reason),
      Sample.message(seq: 3, role: "user", blocks: Sample.text("b")),
      blockedMessage(seq: 4, reason: reason),
    ]
    let state = Sample.state(session: session(blocked: (4, "b-1")), messages: messages)
    let models = notes(TranscriptRows.build(state: state, sessionId: "s1"))
    #expect(models.map(\.id) == ["m2.b", "m4.b"])
    #expect(models[0].action == nil, "starsza notka bez przycisku")
    let action = try #require(models[1].action)
    #expect(action.blocked.seq == 4 && action.blocked.id == "b-1")
    #expect(!action.restarting && action.error == nil)

    // Karta wskazuje notkę, której w transkrypcie już nie ma (przycięty początek) — żadna notka nie dostaje przycisku.
    let gone = Sample.state(session: session(blocked: (9, "b-2")), messages: messages)
    #expect(notes(TranscriptRows.build(state: gone, sessionId: "s1")).allSatisfy { $0.action == nil })
  }

  @Test("w toku: restart w locie z rdzenia (także z pigułki) i próba przyjęta dla TEJ blokady; nowa blokada od zera")
  func restartingState() throws {
    let messages = [blockedMessage(seq: 2, reason: reason)]
    var state = Sample.state(session: session(blocked: (2, "b-1")), messages: messages)
    func action(_ ui: TranscriptUIState = TranscriptUIState()) -> PromptBlockedAction? {
      notes(TranscriptRows.build(state: state, sessionId: "s1", ui: ui)).first?.action
    }
    _ = state.apply(
      .session(.restartStarted(sessionId: "s1", until: Sample.now.addingTimeInterval(90))), now: Sample.now)
    #expect(action()?.restarting == true, "żądanie w drodze")
    _ = state.apply(.session(.restartFinished(sessionId: "s1")), now: Sample.now)
    #expect(action()?.restarting == false)

    var ui = TranscriptUIState()
    ui.promptBlocked = PromptBlockedAttempt(id: "b-1", accepted: true)
    #expect(action(ui)?.restarting == true, "serwer przyjął — czekamy, aż karta zdejmie blokadę")
    ui.promptBlocked = PromptBlockedAttempt(id: "b-0", accepted: true)
    #expect(action(ui)?.restarting == false, "przyjęcie starszej blokady nie dotyczy nowej")
  }

  @Test("odmowa: zdanie pod przyciskiem tylko dla tej blokady, przycisk zostaje; ponowna próba zdejmuje zdanie")
  func refusalSentence() {
    let state = Sample.state(session: session(blocked: (2, "b-1")), messages: [blockedMessage(seq: 2, reason: reason)])
    var ui = TranscriptUIState()
    ui.promptBlocked = PromptBlockedAttempt(id: "b-1", error: "W tle działa zadanie — restart by je przerwał.")
    let refused = notes(TranscriptRows.build(state: state, sessionId: "s1", ui: ui)).first?.action
    #expect(refused?.error == "W tle działa zadanie — restart by je przerwał.")
    #expect(refused?.restarting == false, "przycisk zostaje czynny")

    ui.promptBlocked = PromptBlockedAttempt(id: "b-0", error: "stara odmowa")
    #expect(notes(TranscriptRows.build(state: state, sessionId: "s1", ui: ui)).first?.action?.error == nil)

    var flying = state
    _ = flying.apply(
      .session(.restartStarted(sessionId: "s1", until: Sample.now.addingTimeInterval(90))), now: Sample.now)
    ui.promptBlocked = PromptBlockedAttempt(id: "b-1", error: "stara odmowa")
    let retry = notes(TranscriptRows.build(state: flying, sessionId: "s1", ui: ui)).first?.action
    #expect(retry?.restarting == true && retry?.error == nil, "w toku bez zdania poprzedniej odmowy")
  }

  @Test("długi powód z cytatem: ponad 8 linii zwinięte z liczbą linii, rozwinięcie kluczem wiersza; krótki bez przycisku")
  func fold() {
    let long = (1...12).map { "linia \($0)" }.joined(separator: "\n")
    let messages = [blockedMessage(seq: 2, reason: long), blockedMessage(seq: 3, reason: "krótki", prompt: "p")]
    let state = Sample.state(session: session(), messages: messages)
    let folded = notes(TranscriptRows.build(state: state, sessionId: "s1"))
    #expect(folded[0].fold == PromptFold(lines: 12, expanded: false) && folded[0].clipped)
    #expect(folded[1].fold == nil && !folded[1].clipped)

    var ui = TranscriptUIState()
    ui.reading.togglePrompt("m2.b")
    let open = notes(TranscriptRows.build(state: state, sessionId: "s1", ui: ui))
    #expect(open[0].fold == PromptFold(lines: 12, expanded: true) && !open[0].clipped)
    // Rozwinięcie przeżywa przygotowanie czytania, póki wiadomość jest w transkrypcie (klucz `m<seq>.…`).
    ui.reading.prepare(state.transcripts["s1"])
    #expect(ui.reading.expandedPrompts.contains("m2.b"))

    // Granica: dokładnie 8 linii stoi całe; 801 znaków jednej linii to 9 linii ekranu.
    #expect(PromptBlockedNote.fold((1...8).map(String.init).joined(separator: "\n"), expanded: false) == nil)
    #expect(PromptBlockedNote.fold(String(repeating: "x", count: 801), expanded: false)?.lines == 9)
  }

  /// Odmowa stała tylko tekstem pod przyciskiem — czytnik musiał jej szukać sam.
  @Test("wynik tapnięcia: przyjęcie mówi „Uruchamiam ponownie…”, odmowa pilnie swoim zdaniem; stara blokada cicho")
  func tapResult() throws {
    let blocked = Sample.decode(SessionPromptBlocked.self, #"{"seq":2,"id":"b-1"}"#)
    let newer = Sample.decode(SessionPromptBlocked.self, #"{"seq":5,"id":"b-2"}"#)
    let accepted = try #require(PromptBlockedNote.result(.accepted, blocked: blocked, current: nil))
    #expect(accepted == PromptBlockedResult(
      attempt: PromptBlockedAttempt(id: "b-1", accepted: true), spoken: "Uruchamiam ponownie…", urgent: false),
      "przyjęcie mówi także, gdy karta zdjęła już blokadę przy `/exit`")

    let tasks = "W tle działa zadanie — restart by je przerwał."
    let refused = try #require(PromptBlockedNote.result(.refused(tasks), blocked: blocked, current: blocked))
    #expect(refused == PromptBlockedResult(
      attempt: PromptBlockedAttempt(id: "b-1", error: tasks), spoken: tasks, urgent: true))
    let stale = try #require(PromptBlockedNote.result(.refused(tasks), blocked: blocked, current: newer))
    #expect(stale.attempt.error == tasks && stale.spoken == nil, "odmowa starej blokady: zdania nie widać, więc cisza")

    #expect(PromptBlockedNote.result(.refused(nil), blocked: blocked, current: blocked)?.spoken
      == "Nie udało się uruchomić sesji ponownie. Spróbuj jeszcze raz.")
    #expect(PromptBlockedNote.result(.timedOut, blocked: blocked, current: blocked)?.spoken
      == "Serwer nie odpowiedział na czas — spróbuj ponownie.")
    #expect(PromptBlockedNote.result(.inFlight, blocked: blocked, current: blocked) == nil)
    #expect(PromptBlockedNote.result(.loggedOut, blocked: blocked, current: blocked) == nil)
  }

  @Test("czytnik: „Uwaga”, tytuł, powód i cytat jednym zdaniem; pusty powód — sam tytuł")
  func spoken() {
    #expect(UICopy.promptBlockedSpoken("powód\nPrompt: a")
      == "Uwaga: Prompt nie wysłany — zablokował go hook. powód\nPrompt: a")
    #expect(UICopy.promptBlockedSpoken("") == "Uwaga: Prompt nie wysłany — zablokował go hook.")
    #expect(UICopy.promptBlockedResend == "Uruchom ponownie i wyślij")
    #expect(UICopy.promptBlockedRestarting == "Uruchamiam ponownie…")
  }
}
