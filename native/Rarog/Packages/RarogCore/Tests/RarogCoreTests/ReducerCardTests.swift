import Foundation
import RarogContract
@testable import RarogCore
import Testing

private let t0 = Date(timeIntervalSince1970: 1_790_000_000)
private let sid = "herdr-w1-p2"

@Suite("reduktor: karty decyzji (KARTA)")
struct ReducerCardTests {
  private func loaded() throws -> AppState {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("sessions-snapshot.max.json")])
    play(&state, [try Frames.golden("transcript-snapshot.max.json")], source: .session(sid))
    return state
  }

  @Test("nagrane: karta z transkryptu, rozstrzygnięta na innym urządzeniu → znika ze śladem `by`")
  func resolvedElsewhere() throws {
    var state = try loaded()
    #expect(state.transcripts[sid]?.pendingPermissions.map(\.permId) == ["toolu_21"])
    play(&state, [try Frames.golden("permission-pending.max.json")], source: .session(sid))
    #expect(state.transcripts[sid]?.pendingPermissions.count == 1, "ta sama karta drugi raz nie dubluje")
    play(&state, [try Frames.golden("permission-resolved.max.json")], source: .session(sid))
    #expect(state.transcripts[sid]?.pendingPermissions.isEmpty == true)
    #expect(state.notices.map(\.reason) == [.resolvedElsewhere(by: "iPad")])
  }

  @Test("rozstrzygnięcie NASZEJ decyzji zdejmuje kartę bez śladu")
  func ownDecisionResolved() throws {
    var state = try loaded()
    state.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow"), now: t0)
    state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .accepted), now: t0)
    #expect(state.transcripts[sid]?.pendingPermissions.count == 1, "karta czeka na rozstrzygnięcie serwera")
    play(&state, [try Frames.golden("permission-resolved.max.json")], source: .session(sid))
    #expect(state.transcripts[sid]?.pendingPermissions.isEmpty == true)
    #expect(state.notices.isEmpty)
    #expect(state.transcripts[sid]?.decisions.isEmpty == true)
  }

  @Test("wpis decyzji niesie przyjęcie (200): w locie bez, po 200 z; 200 po zdjęciu karty wpisu nie odtwarza")
  func acceptedInStore() throws {
    var state = try loaded()
    state.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow"), now: t0)
    #expect(state.transcripts[sid]?.decisions["toolu_21"]?.accepted == false, "w drodze")
    state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .accepted), now: t0)
    #expect(state.transcripts[sid]?.decisions["toolu_21"]?.accepted == true, "serwer przyjął")
    #expect(state.transcripts[sid]?.decisions["toolu_21"]?.choice == "allow")

    var early = try loaded()
    early.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow"), now: t0)
    play(&early, [try Frames.golden("permission-resolved.max.json")], source: .session(sid))
    early.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .accepted), now: t0)
    #expect(early.transcripts[sid]?.decisions.isEmpty == true, "rozstrzygnięcie przed 200: wpis nie wraca")
    #expect(early.notices.isEmpty)
  }

  @Test("409 i 410 zdejmują kartę ze śladem; 422 i błąd sieci zostawiają kartę")
  func decisionResults() throws {
    var state = try loaded()
    state.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow"), now: t0)
    state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .keep), now: t0)
    #expect(state.transcripts[sid]?.pendingPermissions.count == 1)
    #expect(state.transcripts[sid]?.decisions.isEmpty == true)
    state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .conflict), now: t0)
    #expect(state.transcripts[sid]?.pendingPermissions.isEmpty == true)
    #expect(state.notices.map(\.reason) == [.alreadyDecided])

    var other = try loaded()
    other.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .gone), now: t0)
    #expect(other.notices.map(\.reason) == [.expired])
    other.apply(.pruneNotices(olderThan: t0), now: t0)
    #expect(other.notices.isEmpty)
  }

  @Test("karta zdjęta strumieniem w trakcie naszej próby: 409/410 i tak zostawiają ślad, jeden na kartę")
  func resultAfterStreamResolved() throws {
    var state = try loaded()
    state.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow"), now: t0)
    play(&state, [try Frames.golden("permission-resolved.max.json")], source: .session(sid))
    #expect(state.notices.isEmpty, "rozstrzygnięcie w trakcie własnej próby — jeszcze bez śladu")
    state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .conflict), now: t0)
    #expect(state.notices.map(\.reason) == [.alreadyDecided])
    // Ślad „innego urządzenia" już stoi (próba zgubiona przez pełny stan) — 409 nie dokłada drugiego.
    var other = try loaded()
    play(&other, [try Frames.golden("permission-resolved.max.json")], source: .session(sid))
    other.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .conflict), now: t0)
    #expect(other.notices.map(\.reason) == [.resolvedElsewhere(by: "iPad")])
    // Sesji nie ma już na liście (zamknięta): karta zdjęta wcześniej nie zostawia „wygasło".
    var closed = try loaded()
    closed.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow"), now: t0)
    play(&closed, [try Frames.golden("permission-resolved.max.json")], source: .session(sid))
    closed.sessions[sid] = nil
    closed.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .gone), now: t0)
    #expect(closed.notices.isEmpty)
  }

  @Test("`expired` i wartownik `unsupported` od serwera zdejmują kartę jak wygasłą")
  func expiredFromServer() throws {
    var state = try loaded()
    play(&state, [try Frames.golden("permission-resolved.unknown-decision.json")], source: .session(sid))
    #expect(state.notices.map(\.reason) == [.expired])
  }

  @Test("karta dla sesji bez transkryptu nie zakłada go; pytanie: pending i resolved")
  func questions() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("question-pending.max.json")], source: .session("herdr-w2-p4"))
    #expect(state.transcripts["herdr-w2-p4"] == nil)
    play(&state, [try Frames.golden("transcript-snapshot.question.json")], source: .session("herdr-w2-p4"))
    #expect(state.transcripts["herdr-w2-p4"]?.pendingQuestions.map(\.qId) == ["toolu_31"])
    play(&state, [try Frames.golden("question-resolved.max.json")], source: .session("herdr-w2-p4"))
    #expect(state.transcripts["herdr-w2-p4"]?.pendingQuestions.isEmpty == true)
    #expect(state.notices.map(\.reason) == [.resolvedElsewhere(by: nil)])
  }
}
