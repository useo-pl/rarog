import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

@Suite("wiersze transkryptu")
struct TranscriptRowsTests {
  @Test("głos (sygnał zmiany roli) tylko przy zmianie; prompt z godziną; otwarta odpowiedź na końcu")
  func voiceLabels() {
    let messages = [
      Sample.message(seq: 1, role: "user", blocks: Sample.text("Popraw zapis")),
      Sample.message(seq: 2, role: "assistant", blocks: Sample.text("Diagnoza")),
      Sample.message(seq: 3, role: "assistant", blocks: Sample.text("Ciąg dalszy")),
      Sample.message(seq: 4, role: "system", blocks: Sample.text("Wtrącenie")),
    ]
    let state = Sample.state(session: Sample.session(), messages: messages, open: "płynie")
    let rows = TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar)
    #expect(rows == [
      .text(id: "m1.0", role: .user, voice: .user, markdown: "Popraw zapis", turn: Sample.prompt(messages[0].at)),
      .text(id: "m2.0", role: .assistant, voice: .assistant, markdown: "Diagnoza", turn: TurnMark(gap: .afterPrompt)),
      .text(id: "m3.0", role: .assistant, voice: nil, markdown: "Ciąg dalszy"),
      .text(id: "m4.0", role: .system, voice: .system, markdown: "Wtrącenie"),
      .open(voice: .assistant, markdown: "płynie"),
    ])
  }

  @Test("narzędzie = jedna linia „Nazwa: cel” ze skróconą ścieżką i bilansem diffu; blok nieznany = linia")
  func toolAndUnsupported() {
    let blocks = #"""
      [{"type":"tool-call","toolName":"Edit","summary":"/Users/d/Projects/x/src/notes.ts","detailKind":"diff",
        "detail":"  ctx\n- old\n+ new\n+ more"},{"type":"future-block","x":1}]
      """#
    let state = Sample.state(session: Sample.session(), messages: [Sample.message(seq: 7, role: "assistant", blocks: blocks)])
    let rows = TranscriptRows.build(state: state, sessionId: "s1")
    guard case let .tool(card) = rows.first else {
      Issue.record("brak karty narzędzia: \(rows)")
      return
    }
    #expect(card.id == "m7.0" && card.voice == .assistant)
    #expect(card.line == "Edit: …/x/src/notes.ts")
    #expect(card.diff?.added == 2 && card.diff?.deleted == 1)
    #expect(rows.dropFirst().elementsEqual([.unsupported(id: "m7.1", voice: nil)]))
  }

  @Test("przed pierwszym stanem szkielet; pusty transkrypt mówi zdaniem zależnym od stanu")
  func phases() {
    var state = Sample.state(session: Sample.session(state: "running"))
    #expect(TranscriptRows.build(state: state, sessionId: "s1")
      == [.empty(text: "Agent pracuje — jeszcze nic nie napisał.", sub: "Przy większym zadaniu potrafi myśleć pół minuty.")])
    state.transcripts["s1"]?.snapshots = 0
    #expect(TranscriptRows.build(state: state, sessionId: "s1") == [.loading])
  }

  @Test("kolejka: wpis w locie bez wiersza statusu, niepotwierdzony i odrzucony ze statusem")
  func outbox() {
    var state = Sample.state(session: Sample.session(), messages: [Sample.message(seq: 1, role: "user", blocks: Sample.text("a"))])
    let flying = OutboxEntry(sessionId: "s1", text: "w locie", createdAt: Sample.now)
    let lost = OutboxEntry(sessionId: "s1", text: "zgubiona", createdAt: Sample.now, state: .unconfirmed)
    let refused = OutboxEntry(sessionId: "s1", text: "odrzucona", createdAt: Sample.now, state: .refused(code: "refused", message: "Nie teraz."))
    let other = OutboxEntry(sessionId: "s2", text: "inna sesja", createdAt: Sample.now)
    state.outbox = [flying, lost, refused, other]
    let rows = Array(TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar).dropFirst())
    // Każdy wpis to osobny prompt: granica tury nad nim, także pod poprzednim promptem; godzina z `createdAt`.
    let turn = Sample.pendingPrompt()
    #expect(rows == [
      .pending(entry: flying.id, voice: nil, text: "w locie", turn: turn),
      .pending(entry: lost.id, voice: nil, text: "zgubiona", inFlight: false, turn: turn),
      .pendingStatus(entry: lost.id, status: .unconfirmed, retrying: false),
      .pending(entry: refused.id, voice: nil, text: "odrzucona", inFlight: false, turn: turn),
      .pendingStatus(entry: refused.id, status: .refused("Nie teraz."), retrying: false),
    ])
  }

  @Test("kolejka CLI: wpis przyjęty z `queued` to `pending` z `queued: true`, bez wiersza statusu")
  func queuedEntry() {
    var state = Sample.state(session: Sample.session(), messages: [Sample.message(seq: 1, role: "user", blocks: Sample.text("a"))])
    var queued = OutboxEntry(sessionId: "s1", text: "w kolejce", createdAt: Sample.now, state: .sent(acceptedAt: Sample.now))
    queued.queuedAt = Sample.now
    state.outbox = [queued]
    let rows = Array(TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar).dropFirst())
    #expect(rows == [.pending(entry: queued.id, voice: nil, text: "w kolejce", queued: true, turn: Sample.pendingPrompt())])
  }

  @Test("take-back in flight: every queued entry of the session is taking back with its status row; the answer ends it")
  func queuedEntriesWhileTakingBack() {
    var state = Sample.state(session: Sample.session(), messages: [Sample.message(seq: 1, role: "user", blocks: Sample.text("a"))])
    var first = OutboxEntry(sessionId: "s1", text: "A", createdAt: Sample.now, state: .sent(acceptedAt: Sample.now))
    first.queuedAt = Sample.now
    var second = OutboxEntry(sessionId: "s1", text: "B", createdAt: Sample.now, state: .sent(acceptedAt: Sample.now))
    second.queuedAt = Sample.now
    let lost = OutboxEntry(sessionId: "s1", text: "C", createdAt: Sample.now, state: .unconfirmed)
    var other = OutboxEntry(sessionId: "s2", text: "D", createdAt: Sample.now, state: .sent(acceptedAt: Sample.now))
    other.queuedAt = Sample.now
    state.outbox = [first, second, lost, other]
    _ = state.apply(.queueTakeBack(.started(sessionId: "s1", operationId: UUID())), now: Sample.now)
    let turn = Sample.pendingPrompt()
    let rows = { Array(TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar).dropFirst()) }
    #expect(rows() == [
      .pending(entry: first.id, voice: nil, text: "A", queued: true, takingBack: true, turn: turn),
      .pendingStatus(entry: first.id, status: .takingBack, retrying: false),
      .pending(entry: second.id, voice: nil, text: "B", queued: true, takingBack: true, turn: turn),
      .pendingStatus(entry: second.id, status: .takingBack, retrying: false),
      // A Not confirmed entry keeps its own status and buttons; the kept take-back only gives it the replay.
      .pending(entry: lost.id, voice: nil, text: "C", inFlight: false, replaysTakeBack: true, turn: turn),
      .pendingStatus(entry: lost.id, status: .unconfirmed, retrying: false),
    ])
    _ = state.apply(.queueTakeBack(.settled(sessionId: "s1", keepOperation: false)), now: Sample.now)
    #expect(rows() == [
      .pending(entry: first.id, voice: nil, text: "A", queued: true, turn: turn),
      .pending(entry: second.id, voice: nil, text: "B", queued: true, turn: turn),
      .pending(entry: lost.id, voice: nil, text: "C", inFlight: false, turn: turn),
      .pendingStatus(entry: lost.id, status: .unconfirmed, retrying: false),
    ], "a refusal: the bubbles as before the gesture")
  }

  @Test("karta zgody: nagłówek ze słownika, faza z decyzji w locie, canAllow=false z wycinkiem ekranu")
  func permissionCard() throws {
    var state = Sample.state(
      session: Sample.session(state: "waiting-permission", extra: #""herdrDialogScreen":"❯ 1. Yes""#),
      messages: [Sample.message(seq: 1, role: "user", blocks: Sample.text("a"))])
    state.transcripts["s1"]?.pendingPermissions = [
      Sample.permission(permId: "p1", risk: "red"),
      Sample.permission(permId: "p2", extra: #""canAllow":false"#),
      Sample.permission(permId: "p3", extra: #""subject":"plan""#),
    ]
    state.apply(.decisionStarted(sessionId: "s1", cardId: "p1", choice: "allow"), now: Sample.now)
    var ui = TranscriptUIState()
    let cardsOf = { (rows: [TranscriptRow]) in
      rows.compactMap { row -> PermissionCardModel? in if case let .permission(card) = row { card } else { nil } }
    }
    var built = cardsOf(TranscriptRows.build(state: state, sessionId: "s1", ui: ui))
    #expect(built.map(\.eyebrow) == ["zgoda · ryzykowna", "zgoda · Shell", "plan"])
    #expect(built[0].phase == .sending(.allow) && built[0].canAllow && built[0].screen == nil)
    #expect(!built[1].canAllow && built[1].screen == "❯ 1. Yes")
    #expect(built[0].spokenHeader == "Zgoda na narzędzie Shell, ryzykowna, katalog ~/Projects/willow")
    // Przyjęcie (200) stoi w store, nie w stanie ekranu: nowy stan ekranu (zmiana sesji) też widzi „wysłano”.
    state.apply(.decisionFinished(sessionId: "s1", cardId: "p1", kind: .permission, result: .accepted), now: Sample.now)
    ui = TranscriptUIState()
    ui.errors["p2"] = "Panel nie przyjął."
    built = cardsOf(TranscriptRows.build(state: state, sessionId: "s1", ui: ui))
    #expect(built[0].phase == .sent(.allow) && built[1].error == "Panel nie przyjął." && built[0].lockedReason == nil)
  }

  @Test("karta bez decyzji: sesja nieobsługiwana, herdr tylko do odczytu, apka niezgodna")
  func lockedCards() throws {
    var state = Sample.state(session: Sample.session(state: "zzz-nowy-stan"))
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission()]
    let lockOf = { (state: AppState) -> String? in
      TranscriptRows.build(state: state, sessionId: "s1").compactMap { row -> String?? in
        if case let .permission(card) = row { card.lockedReason } else { nil }
      }.first ?? nil
    }
    #expect(lockOf(state) == UICopy.unsupportedSession)
    state.sessions["s1"] = Sample.session(state: "waiting-permission")
    state.herdr = Sample.decode(HerdrStatus.self, #"{"available":true,"agentCount":1,"readOnly":true,"canLaunch":false}"#)
    #expect(lockOf(state) == "herdr tylko do odczytu — wysyłka do panelu wyłączona.")
    state.compat = .protocolMismatch(server: 4)
    #expect(lockOf(state) == CoreCopy.updateApp)
  }

  @Test("pytanie bez chrome CLI (rola z serwera), wyjście w stopce; ślad karty z innego urządzenia")
  func questionAndNotice() {
    var state = Sample.state(session: Sample.session(state: "waiting-question"))
    state.transcripts["s1"]?.pendingQuestions = [Sample.decode(QuestionRequest.self, #"""
      {"qId":"q1","sessionId":"s1","createdAt":"\#(Sample.iso(5))","questions":[{"question":"Który?","header":"Plik",
       "multiSelect":false,"options":[{"label":"a.ts"},{"label":"Inne","role":"custom"},{"label":"Wyjście","role":"exit"}]}]}
      """#)]
    // Ślad powstaje w rdzeniu: 409 na naszą decyzję zdejmuje kartę ze śladem.
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p9")]
    state.apply(.decisionStarted(sessionId: "s1", cardId: "p9", choice: "allow"), now: Sample.now)
    state.apply(.decisionFinished(sessionId: "s1", cardId: "p9", kind: .permission, result: .conflict), now: Sample.now)
    let rows = TranscriptRows.build(state: state, sessionId: "s1")
    guard case let .question(card) = rows[1] else {
      Issue.record("brak karty pytania: \(rows)")
      return
    }
    #expect(card.sections.first?.options.map(\.label) == ["a.ts"])
    #expect(card.eyebrow == "pytanie · Plik", "jedno pytanie: nagłówek CLI w etykiecie karty (P6)")
    #expect(card.sections.first?.head == "")
    #expect(card.exitLabel == "Wyjście")
    #expect(rows.last == .notice(id: "np9", text: "Decyzja zapadła już na innym urządzeniu."))
    // Karta pytania stoi nad polem: zdanie pod polem odsyła w górę.
    #expect(ComposerModel.make(state: state, sessionId: "s1").reason == "Agent czeka na Twoją odpowiedź — karta wyżej.")
  }

  @Test("pole wiadomości: przy decyzji bez karty zdanie o terminalu, z kartą odsyła do karty; niezgodność = czytanie")
  func composer() {
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    // Przed pełnym stanem transkryptu kart nie znamy — także karty „dialog w terminalu".
    state.transcripts["s1"]?.snapshots = 0
    #expect(ComposerModel.make(state: state, sessionId: "s1")
      == ComposerModel(editable: false, reason: "Agent czeka na decyzję — odpowiedz w terminalu albo odrzuć dialog."))
    // Po pełnym stanie bez kart stoi karta „dialog w terminalu" — zdanie odsyła do niej.
    state.transcripts["s1"]?.snapshots = 1
    #expect(ComposerModel.make(state: state, sessionId: "s1")
      == ComposerModel(editable: false, reason: "Agent czeka na Twoją zgodę — karta wyżej."))
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission()]
    // Karta stoi nad polem (na dnie transkryptu): zdanie pod polem odsyła w górę.
    #expect(ComposerModel.make(state: state, sessionId: "s1")
      == ComposerModel(editable: false, reason: "Agent czeka na Twoją zgodę — karta wyżej."))
    // Zdanie pustego transkryptu stoi nad kartą — to ono zostaje przy „niżej".
    #expect(UICopy.emptyTranscript(.waitingPermission).text == "Agent czeka na Twoją zgodę — karta niżej.")
    #expect(UICopy.emptyTranscript(.waitingQuestion).text == "Agent czeka na Twoją odpowiedź — karta niżej.")
    state.transcripts["s1"]?.pendingPermissions = []
    state.sessions["s1"] = Sample.session(state: "running")
    #expect(ComposerModel.make(state: state, sessionId: "s1") == ComposerModel(editable: true, reason: nil))
    state.compat = .tooOld(minClientBuild: 9)
    #expect(ComposerModel.make(state: state, sessionId: "s1").editable == false)
  }

  @Test("„Ponów” w toku blokuje przycisk; każdy wynik (także odmowa dysku) go zwalnia")
  func retryingFlag() {
    var state = Sample.state(session: Sample.session())
    let lost = OutboxEntry(sessionId: "s1", text: "zgubiona", createdAt: Sample.now, state: .unconfirmed)
    state.outbox = [lost]
    var ui = TranscriptUIState()
    ui.retrying.insert(lost.id)
    #expect(TranscriptRows.build(state: state, sessionId: "s1", ui: ui).last
      == .pendingStatus(entry: lost.id, status: .unconfirmed, retrying: true))
    ui.retrying.remove(lost.id)
    #expect(TranscriptRows.build(state: state, sessionId: "s1", ui: ui).last
      == .pendingStatus(entry: lost.id, status: .unconfirmed, retrying: false))
  }

  @Test("202 bez echa: wpis w locie bez statusu, po 15 s „Nie potwierdzono” z Ponów/Odrzuć")
  func acceptedWithoutEcho() {
    var state = Sample.state(session: Sample.session())
    // The session screen's stream is open: without it the entry's deadline waits (`AppState.waitsForOpenStream`).
    state.viewedSessionId = "s1"
    state.sessionStream = .online
    let entry = OutboxEntry(sessionId: "s1", text: "czy doszło?", createdAt: Sample.now)
    state.apply(.outboxEnqueued(entry), now: Sample.now)
    state.apply(.outboxAccepted(entry.id, at: Sample.now), now: Sample.now)
    #expect(TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar).last
      == .pending(entry: entry.id, voice: .user, text: "czy doszło?", turn: Sample.pendingPrompt()))
    state.apply(.outboxUnconfirmedIfStillSent(entry.id), now: Sample.now.addingTimeInterval(15))
    // Ten sam wiersz zmienia wartość (bez poświaty), więc komórka dymka się przebudowuje i pasmo gaśnie.
    #expect(TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar).suffix(2) == [
      .pending(entry: entry.id, voice: .user, text: "czy doszło?", inFlight: false, turn: Sample.pendingPrompt()),
      .pendingStatus(entry: entry.id, status: .unconfirmed, retrying: false),
    ])
  }

  @Test("otwarta wiadomość dołączona w trakcie tury stoi z akapitem „…”")
  func openWithLeadingGap() {
    var state = Sample.state(session: Sample.session(state: "running"))
    state.apply(.streamOpened(.session(id: "s1"), resumedWithCursor: true), now: Sample.now)
    state.apply(.frame(Sample.decode(ServerEvent.self, #"{"type":"delta","sessionId":"s1","text":"Delty są ulotne"}"#),
                       source: .session("s1"), cursor: nil), now: Sample.now)
    #expect(TranscriptRows.build(state: state, sessionId: "s1").last == .open(voice: .assistant, markdown: "…\n\nDelty są ulotne"))
  }

  /// Wiadomość `system` z polem `promptBlocked` to wiersz SwiftUI notki (nie tekst z bloków), z miejscem
  /// w turze jak każda notka i wyciszonym atramentem pod kartą decyzji.
  @Test("notka blokady promptu: wiersz `m<seq>.b` zamiast tekstu, niesie miejsce w turze, nie jest tekstowy")
  func promptBlockedRow() {
    let note = Sample.decode(TranscriptMessage.self, #"""
      {"seq":2,"role":"system","blocks":\#(Sample.text("⚠ Hook zablokował prompt — nie został wysłany.\npowód")),
       "at":"\#(Sample.iso(98))","promptBlocked":{"reason":"powód"}}
      """#)
    let messages = [Sample.message(seq: 1, role: "user", blocks: Sample.text("a")), note]
    let rows = TranscriptRows.build(state: Sample.state(session: Sample.session(), messages: messages), sessionId: "s1")
    #expect(rows.map(\.id) == ["m1.0", "m2.b"])
    guard var row = rows.last, case .promptBlocked = row else {
      Issue.record("brak wiersza notki: \(rows)")
      return
    }
    #expect(!row.isTextual && TranscriptDim.ink(row) == .muted)
    #expect(row.turn == TurnMark(gap: .afterPrompt))
    row.setTurn(TurnMark(gap: .turn))
    #expect(row.turn.gap == .turn && row.id == "m2.b")
  }
}
