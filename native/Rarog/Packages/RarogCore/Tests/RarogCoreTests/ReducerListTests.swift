import Foundation
import RarogContract
@testable import RarogCore
import Testing

private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

/// Nakłada ciąg ramek jednego źródła na stan.
func play(_ state: inout AppState, _ frames: [ServerEvent], source: FrameSource = .global, at now: Date = t0) {
  for frame in frames { state.apply(.frame(frame, source: source, cursor: nil), now: now) }
}

@Suite("reduktor: lista sesji (LISTA, SIEC, ZGOD)")
struct ReducerListTests {
  @Test("nagrany start: hello → snapshot → zmiana sesji; snapshot podmienia CAŁOŚĆ")
  func recordedStart() throws {
    // `hello.max.json` niesie `minClientBuild: 12`: build 11 jest za stary, 12 przechodzi.
    var old = AppState(clientBuild: 11)
    play(&old, [try Frames.golden("hello.max.json")])
    #expect(old.compat == .tooOld(minClientBuild: 12))
    var state = AppState(clientBuild: 12)
    play(&state, [try Frames.golden("hello.max.json"), try Frames.golden("sessions-snapshot.max.json")])
    #expect(state.compat == .ok)
    #expect(state.sessionsLoaded)
    #expect(state.sessions.count == 10)
    #expect(state.herdr != nil)

    play(&state, [try Frames.golden("session-changed.max.json")])
    #expect(state.sessions["herdr-w1-p1"]?.cliUpdate?.installed == "2.1.283")

    // Pusty snapshot zdejmuje wszystko — także banery i notatki (brak pola gasi stan).
    play(&state, [try Frames.golden("sessions-snapshot.min.json")])
    #expect(state.sessions.isEmpty)
    #expect(state.herdr == nil)
  }

  @Test("spóźniona ramka strumienia sesji nie wskrzesza karty zdjętej przez snapshot")
  func lateSessionFrameDoesNotResurrect() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("sessions-snapshot.min.json")])
    play(&state, [try Frames.golden("session-changed.max.json")], source: .session("herdr-w1-p1"))
    #expect(state.sessions["herdr-w1-p1"] == nil)
    // Ta sama ramka strumieniem globalnym tworzy kartę — listę zna wyłącznie globalny.
    play(&state, [try Frames.golden("session-changed.max.json")])
    #expect(state.sessions["herdr-w1-p1"] != nil)
  }

  @Test("powtórzony stan nie zeruje „czeka od”; nowy stan przesuwa oba znaczniki; nieznana sesja pomijana")
  func repeatedStateKeepsSince() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot([Frames.summary("s1", state: "waiting-permission")])])
    play(&state, [try Frames.state("s1", "waiting-permission", since: "2026-10-03T09:00:00.000Z")])
    #expect(state.sessions["s1"]?.stateSince == "2026-10-03T08:00:00.000Z")
    play(&state, [try Frames.state("s1", "running", since: "2026-10-03T09:05:00.000Z")])
    #expect(state.sessions["s1"]?.stateSince == "2026-10-03T09:05:00.000Z")
    #expect(state.sessions["s1"]?.lastActivityAt == "2026-10-03T09:05:00.000Z")
    play(&state, [try Frames.state("nieznana", "running", since: "2026-10-03T09:05:00.000Z")])
    #expect(state.sessions["nieznana"] == nil)
  }

  @Test("aktywność trafia do karty listy; `idle` ją zdejmuje; wiadomość też ją zdejmuje")
  func activityOnList() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot([Frames.summary("s1")]), try Frames.activity("s1", kind: "thinking")])
    #expect(state.sessions["s1"]?.activity?.kind == .thinking)
    #expect(state.transcripts["s1"] == nil, "aktywność nie zakłada transkryptu (LRU)")
    play(&state, [try Frames.activity("s1", kind: "idle")])
    #expect(state.sessions["s1"]?.activity == nil)
    play(&state, [try Frames.activity("s1", kind: "tool"), try Frames.message("s1", seq: 1, text: "gotowe")])
    #expect(state.sessions["s1"]?.activity == nil)
  }

  @Test("herdr-status bez `canLaunch` zostawia ostatnią znaną wartość")
  func herdrStatusMerge() throws {
    var state = AppState(clientBuild: 7)
    let herdr = #""herdrStatus":{"available":true,"agentCount":2,"readOnly":false,"canLaunch":true,"version":"0.9.3"}"#
    play(&state, [try Frames.snapshot([], extra: "," + herdr)])
    play(&state, [try Frames.decode(#"{"type":"herdr-status","available":false,"agentCount":0,"readOnly":false}"#)])
    #expect(state.herdr?.canLaunch == true)
    #expect(state.herdr?.available == false)
    #expect(state.herdr?.version == "0.9.3")
  }

  @Test("git-status i usage aktualizują kartę; notatki: brak pola w snapshocie czyści mapę")
  func gitUsageNotes() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("sessions-snapshot.max.json"), try Frames.golden("git-status.max.json"),
                  try Frames.golden("usage.max.json"), try Frames.golden("notes.max.json")])
    #expect(state.sessions["herdr-w1-p1"]?.branch == "feat/kontrakt-semantyczny")
    #expect(state.sessions["herdr-w1-p1"]?.usage?.contextTokens == 412_000)
    #expect(state.notesPresent["/Users/demo/Projects/nowy"] == true)
    play(&state, [try Frames.snapshot([])])
    #expect(state.notesPresent.isEmpty)
  }

  @Test("hello: zgodność ok / za stara / inny protokół; kolejne hello przełącza od razu")
  func compatFromHello() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.hello(minClientBuild: 12)])
    #expect(state.compat == .tooOld(minClientBuild: 12))
    play(&state, [try Frames.hello(protocolVersion: 4)])
    #expect(state.compat == .protocolMismatch(server: 4))
    #expect(state.compat.serverIsNewer)
    play(&state, [try Frames.hello(protocolVersion: 2)])
    #expect(!state.compat.serverIsNewer)
    play(&state, [try Frames.hello(minClientBuild: 7)])
    #expect(state.compat == .ok)
  }

  @Test("wylogowanie kasuje obraz widoku, ale nie kolejkę wysyłki")
  func logoutClearsView() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("sessions-snapshot.max.json"), try Frames.golden("transcript-snapshot.max.json")])
    state.apply(.outboxEnqueued(OutboxEntry(sessionId: "herdr-w1-p2", text: "x", createdAt: t0)), now: t0)
    let effects = state.apply(.loggedOut(.deviceUnknown), now: t0)
    #expect(effects == [.clearCaches])
    #expect(state.sessions.isEmpty && state.transcripts.isEmpty && !state.sessionsLoaded)
    #expect(state.outbox.count == 1)
    #expect(state.auth == .loggedOut(.deviceUnknown))
  }
}
