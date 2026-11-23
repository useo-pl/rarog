import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Testing

private let t0 = Date(timeIntervalSince1970: 1_790_000_000)
private let sid = "herdr-w1-p2"

@Suite("reduktor: transkrypt (TR, SIEC)")
struct ReducerTranscriptTests {
  private func loaded() throws -> AppState {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("sessions-snapshot.max.json")])
    play(&state, [try Frames.golden("transcript-snapshot.max.json")], source: .session(sid))
    return state
  }

  @Test("nagrany transkrypt: snapshot podmienia, replay `message` z tym samym `seq` nie dubluje")
  func snapshotThenReplay() throws {
    var state = try loaded()
    #expect(state.transcripts[sid]?.messages.map(\.seq) == [5, 6, 9, 13, 15])
    #expect(state.transcripts[sid]?.snapshots == 1)
    play(&state, [try Frames.golden("message.max.json"), try Frames.golden("message.unicode.json")], source: .session(sid))
    #expect(state.transcripts[sid]?.messages.map(\.seq) == [5, 6, 9, 13, 15])
    // Inna treść pod tym samym numerem (restart serwera) przebudowuje wiadomość.
    play(&state, [try Frames.message(sid, seq: 15, text: "nowa treść")], source: .session(sid))
    guard case let .text(text, _)? = state.transcripts[sid]?.messages.last?.blocks.first else {
      Issue.record("brak bloku")
      return
    }
    #expect(text == "nowa treść")
  }

  @Test("delta po wiadomości systemowej/użytkownika trafia do OTWARTEJ wiadomości agenta")
  func deltaIntoOpenMessage() throws {
    var state = try loaded()
    play(&state, [try Frames.delta(sid, "Zaczynam "), try Frames.message(sid, seq: 20, role: "system", text: "git pull: ok"),
                  try Frames.delta(sid, "od testów"), try Frames.message(sid, seq: 21, role: "user", text: "pośpiesz się"),
                  try Frames.delta(sid, ".")], source: .session(sid))
    #expect(state.transcripts[sid]?.open?.text == "Zaczynam od testów.")
    // Ostatnia komórka to wiadomość użytkownika — delta jej nie dopisała.
    #expect(state.transcripts[sid]?.messages.last?.role == .user)
    // Domknięta wiadomość agenta zastępuje strumień.
    play(&state, [try Frames.message(sid, seq: 22, text: "Zaczynam od testów.")], source: .session(sid))
    #expect(state.transcripts[sid]?.open == nil)
  }

  @Test("powrót z ważnym kursorem: otwarta wiadomość zamknięta „…” do domkniętej; snapshot zaczyna od nowa")
  func resumeWithCursorMarksGap() throws {
    var state = try loaded()
    play(&state, [try Frames.delta(sid, "Połowa akapitu")], source: .session(sid))
    state.apply(.streamOpened(.session(id: sid), resumedWithCursor: true), now: t0)
    #expect(state.transcripts[sid]?.open == OpenAgentMessage(text: "Połowa akapitu…", gap: true))
    // Drugie zerwanie bez nowego tekstu nie dokłada drugiego „…”.
    state.apply(.streamOpened(.session(id: sid), resumedWithCursor: true), now: t0)
    #expect(state.transcripts[sid]?.open?.text == "Połowa akapitu…")
    play(&state, [try Frames.delta(sid, " dalej")], source: .session(sid))
    #expect(state.transcripts[sid]?.open == OpenAgentMessage(text: "Połowa akapitu… dalej", gap: false))
    play(&state, [try Frames.golden("transcript-snapshot.max.json")], source: .session(sid))
    #expect(state.transcripts[sid]?.open == nil)
  }

  @Test("dołączenie w trakcie tury: otwarta wiadomość zaczyna się akapitem „…” do domkniętej")
  func joinMidTurnMarksLeadingGap() throws {
    var state = try loaded()
    play(&state, [try Frames.state(sid, "running", since: "2026-10-03T09:00:00.000Z")])
    // Powrót z ważnym kursorem: bufor odtwarza domkniętą wiadomość (przed pierwszą deltą),
    // a delty bieżącej wiadomości przychodzą od środka — jej początek przepadł.
    state.apply(.streamOpened(.session(id: sid), resumedWithCursor: true), now: t0)
    play(&state, [try Frames.message(sid, seq: 30, text: "Starsza, domknięta przy nieobecności.")], source: .session(sid))
    #expect(state.transcripts[sid]?.open == nil)
    play(&state, [try Frames.delta(sid, "Delty są ulotne"), try Frames.delta(sid, " — dalej.")], source: .session(sid))
    #expect(state.transcripts[sid]?.open == OpenAgentMessage(text: "…\n\nDelty są ulotne — dalej.", leadingGap: true))
    // Domknięta wiadomość zastępuje częściową; następna zaczyna się od początku, bez znacznika.
    play(&state, [try Frames.message(sid, seq: 31, text: "Pełna wiadomość. Delty są ulotne — dalej.")], source: .session(sid))
    #expect(state.transcripts[sid]?.open == nil)
    play(&state, [try Frames.delta(sid, "Nowa wiadomość")], source: .session(sid))
    #expect(state.transcripts[sid]?.open == OpenAgentMessage(text: "Nowa wiadomość"))
  }

  @Test("znacznik dołączenia: pierwsze otwarcie przy pracy (pełny stan), bez pracy go nie ma, koniec tury go gasi")
  func joinMarkerRules() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("sessions-snapshot.max.json")])
    play(&state, [try Frames.state(sid, "running", since: "2026-10-03T09:00:00.000Z")])
    play(&state, [try Frames.golden("transcript-snapshot.max.json")], source: .session(sid))
    play(&state, [try Frames.delta(sid, "środek")], source: .session(sid))
    #expect(state.transcripts[sid]?.open?.leadingGap == true)
    // Koniec tury: następna tura zaczyna się przy nas.
    play(&state, [try Frames.message(sid, seq: 40, text: "koniec"),
                  try Frames.state(sid, "waiting-input", since: "2026-10-03T09:01:00.000Z"),
                  try Frames.state(sid, "running", since: "2026-10-03T09:02:00.000Z"),
                  try Frames.delta(sid, "od początku")], source: .session(sid))
    #expect(state.transcripts[sid]?.open == OpenAgentMessage(text: "od początku"))
    // Sesja, która nie pracuje przy otwarciu strumienia, nie dostaje znacznika.
    var idle = AppState(clientBuild: 7)
    play(&idle, [try Frames.golden("sessions-snapshot.max.json")])
    play(&idle, [try Frames.golden("transcript-snapshot.max.json")], source: .session(sid))
    play(&idle, [try Frames.delta(sid, "x")], source: .session(sid))
    #expect(idle.transcripts[sid]?.open == OpenAgentMessage(text: "x"))
  }

  @Test("kursor `id:` ramek strumienia sesji trafia do transkryptu")
  func cursorStored() throws {
    var state = try loaded()
    state.apply(.frame(try Frames.message(sid, seq: 30, text: "x"), source: .session(sid), cursor: "s1:30"), now: t0)
    #expect(state.transcripts[sid]?.cursor == "s1:30")
  }

  @Test("aktywność transkryptu: snapshot ją niesie, treść ją kasuje, stan spoza pracy gasi")
  func transcriptActivity() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("transcript-snapshot.running.json")], source: .session("herdr-w1-p1"))
    #expect(state.transcripts["herdr-w1-p1"]?.activity != nil)
    play(&state, [try Frames.delta("herdr-w1-p1", "x")], source: .session("herdr-w1-p1"))
    #expect(state.transcripts["herdr-w1-p1"]?.activity == nil)
    play(&state, [try Frames.activity("herdr-w1-p1", kind: "thinking")])
    #expect(state.transcripts["herdr-w1-p1"]?.activity?.kind == .thinking)
    play(&state, [try Frames.state("herdr-w1-p1", "waiting-input", since: "2026-10-03T09:00:00.000Z")])
    #expect(state.transcripts["herdr-w1-p1"]?.activity == nil)
  }

  @Test("ogon serwera: najwyżej 500 wiadomości, najstarsze wypadają")
  func messageCap() throws {
    var state = AppState(clientBuild: 7)
    for seq in 1...505 { play(&state, [try Frames.message("s1", seq: seq, text: "m\(seq)")], source: .session("s1")) }
    #expect(state.transcripts["s1"]?.messages.count == CoreLimits.maxTranscriptMessages)
    #expect(state.transcripts["s1"]?.messages.first?.seq == 6)
  }

  @Test("w pamięci najwyżej 12 transkryptów; oglądany jest nietykalny")
  func transcriptLRU() throws {
    #expect(CoreLimits.maxTranscripts == 12, "powrót do niedawno otwartej sesji bez szkieletu i snapshotu")
    var state = AppState(clientBuild: 7)
    state.apply(.viewSession("s0"), now: t0)
    let ids = (0..<15).map { "s\($0)" }
    for id in ids {
      play(&state, [try Frames.transcript(id)], source: .session(id))
    }
    #expect(state.transcripts.count == CoreLimits.maxTranscripts)
    #expect(state.transcripts["s0"] != nil, "oglądany zostaje")
    #expect(Set(state.transcripts.keys) == Set(["s0"] + ids.suffix(11)), "wypadają najdawniej użyte")
  }

  /// Another edit of an already changed file leaves the git summary as it was, so a patch kept under the summary
  /// alone would not be invalidated.
  @Test("rewizja repozytorium: każda ramka git-status i usage (także tej samej treści) i zmiana kontekstu")
  func repoRevision() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot([Frames.summary("s1")])])
    play(&state, [try Frames.transcript("s1")], source: .session("s1"))
    let start = try #require(state.transcripts["s1"]?.repoRevision)
    let git = try Frames.decode(#"""
      {"type":"git-status","sessionId":"s1","branch":"main","dirtyCount":1,"files":["a.ts"],
      "fileKinds":{"added":0,"modified":1,"deleted":0}}
      """#)
    play(&state, [git, git], source: .session("s1"))
    #expect(state.transcripts["s1"]?.repoRevision == start + 2, "ta sama treść to nadal nowa ramka")
    let usage = try Frames.decode(#"{"type":"usage","sessionId":"s1","contextTokens":900,"contextLimit":200000}"#)
    play(&state, [usage], source: .session("s1"))
    #expect(state.transcripts["s1"]?.repoRevision == start + 3)
    // Sesja z nieznanym limitem nie dostaje ramek `usage`: pracę agenta widać po kontekście w podsumowaniu.
    let context = #","context":{"kind":"unknown","tokens":5000}"#
    play(&state, [try Frames.sessionChanged(Frames.summary("s1", extra: context))])
    #expect(state.transcripts["s1"]?.repoRevision == start + 4)
    play(&state, [try Frames.sessionChanged(Frames.summary("s1", state: "waiting-input", extra: context))])
    #expect(state.transcripts["s1"]?.repoRevision == start + 4, "zmiana stanu bez zmiany kontekstu to nie praca w repo")
    let other = try Frames.decode(#"{"type":"usage","sessionId":"inna","contextTokens":1,"contextLimit":2}"#)
    play(&state, [other], source: .session("inna"))
    #expect(state.transcripts["s1"]?.repoRevision == start + 4, "ramka innej sesji")
  }

  @Test("szczegóły plików: ramka git-status z `fileDetails` je niesie, następna BEZ pola je gasi")
  func gitFileDetailsReplaced() throws {
    let atlas = "herdr-w1-p1"
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("sessions-snapshot.max.json")])
    play(&state, [try Frames.golden("git-status.max.json")], source: .session(atlas))
    let details = try #require(state.transcripts[atlas]?.git?.fileDetails)
    #expect(details.map(\.path) == state.transcripts[atlas]?.git?.files, "kolejność jak `files`")
    #expect(details.map(\.kind) == [.modified, .modified, .added])
    #expect(details.first?.linesAdded == 42 && details[1].binary == true && details[2].linesAdded == nil)
    let revision = state.transcripts[atlas]?.repoRevision
    play(&state, [try Frames.golden("git-status.without-file-details.json")], source: .session(atlas))
    #expect(state.transcripts[atlas]?.git?.fileDetails == nil, "stan z poprzedniej ramki znika")
    #expect(state.transcripts[atlas]?.git?.files.count == 3, "reszta ramki jak była")
    #expect(state.transcripts[atlas]?.repoRevision == revision.map { $0 + 1 })
  }

  /// After a return from the background a full `sessions-snapshot` brings a new commit or counter while the revision
  /// stays put; the diff sheet would keep the old patch under the new header until the session stream brought
  /// `git-status` or `usage`. The same holds for git metadata in `session-changed`.
  @Test("rewizja repozytorium: pełny stan listy i session-changed ze zmienionym gitem albo kontekstem")
  func repoRevisionFromSummaries() throws {
    func commit(_ hash: String) -> String {
      #","lastCommit":{"hash":"\#(hash)","subject":"zmiana","at":"2026-10-03T08:00:00.000Z"}"#
    }
    let before = #","branch":"main","dirtyCount":1"# + commit("aaa1111")
    let context = #","context":{"kind":"unknown","tokens":5000}"#
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot([Frames.summary("s1", extra: before), Frames.summary("s2", extra: before)])])
    play(&state, [try Frames.transcript("s1")], source: .session("s1"))
    let start = try #require(state.transcripts["s1"]?.repoRevision)
    func revision() -> Int? { state.transcripts["s1"]?.repoRevision }

    play(&state, [try Frames.snapshot([Frames.summary("s1", state: "waiting-input", extra: before)])])
    #expect(revision() == start, "ten sam git i kontekst: patch zostaje ważny")
    let committed = #","branch":"main","dirtyCount":0"# + commit("bbb2222")
    play(&state, [try Frames.snapshot(["s1", "s2"].map { Frames.summary($0, extra: committed) })])
    #expect(revision() == start + 1, "nowy commit i licznik z pełnego stanu")
    play(&state, [try Frames.snapshot([Frames.summary("s1", extra: committed + context)])])
    #expect(revision() == start + 2, "kontekst z pełnego stanu")
    let dirty = #","branch":"main","dirtyCount":2"# + commit("bbb2222") + context
    play(&state, [try Frames.sessionChanged(Frames.summary("s1", extra: dirty))])
    #expect(revision() == start + 3, "licznik z session-changed")
    let ahead = #","branch":"main","dirtyCount":2,"ahead":1"# + commit("bbb2222") + context
    play(&state, [try Frames.sessionChanged(Frames.summary("s1", state: "waiting-input", extra: ahead))])
    #expect(revision() == start + 4, "gałąź przed upstreamem z session-changed")
    #expect(state.transcripts["s2"] == nil, "bez transkryptu nie ma czego unieważniać")
  }
}
