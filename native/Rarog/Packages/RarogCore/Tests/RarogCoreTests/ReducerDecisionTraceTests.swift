import Foundation
import RarogContract
@testable import RarogCore
import Testing

private let t0 = Date(timeIntervalSince1970: 1_790_000_000)
private let sid = "herdr-w1-p2"
private let qsid = "herdr-w2-p4"

/// Ślad własnej decyzji w transkrypcie: rdzeń trzyma fakty decyzji, która doszła (200), w pamięci apki.
@Suite("reduktor: ślad decyzji")
struct ReducerDecisionTraceTests {
  private func loaded() throws -> AppState {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("sessions-snapshot.max.json")])
    play(&state, [try Frames.golden("transcript-snapshot.max.json")], source: .session(sid))
    return state
  }

  private func traces(_ state: AppState, _ id: String = sid) -> [DecisionTrace] {
    state.transcripts[id]?.decisionTraces ?? []
  }

  @Test("zgoda przyjęta (200) → ślad z narzędziem, komendą i miejscem po ostatniej wiadomości z chwili decyzji")
  func allowAccepted() throws {
    var state = try loaded()
    // Nazwa narzędzia z ramki złotej, nie literał (strażnik źródeł `SourceGuardTests`).
    let toolName = try #require(state.transcripts[sid]?.pendingPermissions.first { $0.permId == "toolu_21" }?.toolName)
    state.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow"), now: t0)
    #expect(traces(state).isEmpty, "w locie jeszcze bez śladu")
    state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .accepted), now: t0)
    #expect(traces(state) == [DecisionTrace(
      cardId: "toolu_21", outcome: .allowed, toolName: toolName, plan: false,
      command: "pnpm test shared/test/sse-fixtures.test.ts", answers: [], afterSeq: 15,
      afterAt: state.transcripts[sid]?.messages.last?.at, at: t0)])
    let view = try #require(state.transcripts[sid])
    #expect(view.traceSlots() == [view.messages.count])
  }

  @Test("odmowa przyjęta → ślad `denied`; opcja „zawsze” to też zgoda")
  func denyAndAlways() throws {
    var state = try loaded()
    state.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "deny"), now: t0)
    state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .accepted), now: t0)
    #expect(traces(state).map(\.outcome) == [.denied])

    var always = try loaded()
    always.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow-always"), now: t0)
    always.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .accepted), now: t0)
    #expect(traces(always).map(\.outcome) == [.allowed])
  }

  @Test("decyzja, która nie doszła (422/błąd, 409, 410), nie zostawia śladu; ponowiona i przyjęta — jeden ślad")
  func failedDecisions() throws {
    for result in [DecisionResultKind.keep, .conflict, .gone] {
      var state = try loaded()
      state.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow"), now: t0)
      state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: result), now: t0)
      #expect(traces(state).isEmpty, "\(result)")
      #expect(state.transcripts[sid]?.traceDrafts.isEmpty == true, "\(result): szkic śladu sprzątnięty")
    }
    var state = try loaded()
    state.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow"), now: t0)
    state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .keep), now: t0)
    state.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow"), now: t0)
    state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .accepted), now: t0)
    state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .accepted), now: t0)
    #expect(traces(state).count == 1)
  }

  @Test("strumień zdejmuje kartę przed odpowiedzią 200 → ślad i tak staje, z miejscem z chwili decyzji")
  func resolvedBeforeAccepted() throws {
    var state = try loaded()
    state.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow"), now: t0)
    play(&state, [try Frames.golden("permission-resolved.max.json")], source: .session(sid))
    state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .accepted), now: t0)
    #expect(traces(state).map(\.cardId) == ["toolu_21"])
    #expect(state.notices.isEmpty)
  }

  @Test("ślad przetrwa kolejne pełne stany transkryptu i nie dubluje się")
  func survivesSnapshots() throws {
    var state = try loaded()
    state.apply(.decisionStarted(sessionId: sid, cardId: "toolu_21", choice: "allow"), now: t0)
    state.apply(.decisionFinished(sessionId: sid, cardId: "toolu_21", kind: .permission, result: .accepted), now: t0)
    play(&state, [try Frames.golden("transcript-snapshot.max.json")], source: .session(sid))
    play(&state, [try Frames.golden("transcript-snapshot.max.json")], source: .session(sid))
    #expect(traces(state).map(\.cardId) == ["toolu_21"])
    state.apply(.pruneNotices(olderThan: t0.addingTimeInterval(3600)), now: t0)
    #expect(traces(state).count == 1, "ślad to nie `CardNotice`: nie gaśnie po 6 s")
  }

  /// Karta kanału zgód po `decision`: `permission-resolved` od hooka (zdjęcie przy `running`).
  private func hookResolved(_ permId: String, _ decision: String) throws -> ServerEvent {
    try Frames.decode(#"""
      {"type":"permission-resolved","sessionId":"\#(sid)","permId":"\#(permId)","decision":"\#(decision)","by":"\#(PermissionChannel.hook.rawValue)"}
      """#)
  }

  private func hookLoaded() throws -> (AppState, String) {
    var state = try loaded()
    play(&state, [try Frames.golden("transcript-snapshot.hook.json")], source: .session(sid))
    return (state, try #require(state.transcripts[sid]?.pendingPermissions.first?.permId))
  }

  @Test("karta kanału zgód: po 200 bez śladu, póki karta stoi; zdjęta od hooka → ślad „zgoda wysłana”")
  func hookChannel() throws {
    var (state, permId) = try hookLoaded()
    state.apply(.decisionStarted(sessionId: sid, cardId: permId, choice: "allow"), now: t0)
    state.apply(.decisionFinished(sessionId: sid, cardId: permId, kind: .permission, result: .accepted), now: t0)
    #expect(traces(state).isEmpty, "karta stoi ze stopką „wysłana”: ślad dopiero, gdy zniknie")
    play(&state, [try hookResolved(permId, "allow")], source: .session(sid))
    #expect(traces(state).map(\.cardId) == [permId])
    #expect(traces(state).map(\.outcome) == [.allowed])
    #expect(traces(state).map(\.hookChannel) == [true], "zdanie „wysłana”, nigdy „Zatwierdzono”")
    #expect(state.notices.isEmpty, "bez śladu „wygasła” i „na innym urządzeniu”")
    #expect(state.transcripts[sid]?.decisions[permId] == nil)
  }

  @Test("karta kanału: `permission-resolved` od hooka przed 200 → ślad po 200, wpis decyzji nie wraca")
  func hookChannelResolvedFirst() throws {
    var (state, permId) = try hookLoaded()
    state.apply(.decisionStarted(sessionId: sid, cardId: permId, choice: "allow"), now: t0)
    play(&state, [try hookResolved(permId, "allow")], source: .session(sid))
    #expect(traces(state).isEmpty, "decyzja jeszcze nie przyjęta")
    state.apply(.decisionFinished(sessionId: sid, cardId: permId, kind: .permission, result: .accepted), now: t0)
    #expect(traces(state).map(\.cardId) == [permId])
    #expect(traces(state).map(\.hookChannel) == [true])
    #expect(state.notices.isEmpty)
    #expect(state.transcripts[sid]?.decisions[permId] == nil, "200 nie odtwarza wpisu skasowanego przez strumień")
  }

  @Test("karta kanału: odmowa → ślad odmowy wysłanej; zdjęcie `expired` po naszej decyzji → ślad, bez „wygasła”")
  func hookChannelDenyAndExpired() throws {
    var (state, permId) = try hookLoaded()
    state.apply(.decisionStarted(sessionId: sid, cardId: permId, choice: "deny"), now: t0)
    state.apply(.decisionFinished(sessionId: sid, cardId: permId, kind: .permission, result: .accepted), now: t0)
    play(&state, [try hookResolved(permId, "deny")], source: .session(sid))
    #expect(traces(state).map(\.outcome) == [.denied])
    #expect(traces(state).map(\.hookChannel) == [true])

    var (expired, expiredId) = try hookLoaded()
    expired.apply(.decisionStarted(sessionId: sid, cardId: expiredId, choice: "allow"), now: t0)
    expired.apply(.decisionFinished(sessionId: sid, cardId: expiredId, kind: .permission, result: .accepted), now: t0)
    play(&expired, [try hookResolved(expiredId, "expired")], source: .session(sid))
    #expect(traces(expired).map(\.outcome) == [.allowed])
    #expect(expired.notices.isEmpty)
  }

  @Test("karta kanału zniknęła z pełnego stanu po 200 (zgubiona ramka) → ślad jak przy `permission-resolved`")
  func hookChannelGoneFromSnapshot() throws {
    var (state, permId) = try hookLoaded()
    state.apply(.decisionStarted(sessionId: sid, cardId: permId, choice: "allow"), now: t0)
    state.apply(.decisionFinished(sessionId: sid, cardId: permId, kind: .permission, result: .accepted), now: t0)
    play(&state, [try Frames.golden("transcript-snapshot.max.json")], source: .session(sid))
    #expect(traces(state).map(\.cardId) == [permId])
    #expect(state.transcripts[sid]?.traceDrafts[permId] == nil)
  }

  @Test("karta kanału: decyzja, która nie doszła (409, 410, błąd), nie zostawia śladu po zdjęciu")
  func hookChannelFailed() throws {
    for result in [DecisionResultKind.keep, .conflict, .gone] {
      var (state, permId) = try hookLoaded()
      state.apply(.decisionStarted(sessionId: sid, cardId: permId, choice: "allow"), now: t0)
      state.apply(.decisionFinished(sessionId: sid, cardId: permId, kind: .permission, result: result), now: t0)
      play(&state, [try hookResolved(permId, "allow")], source: .session(sid))
      #expect(traces(state).isEmpty, "\(result)")
      #expect(state.transcripts[sid]?.traceDrafts.isEmpty == true, "\(result)")
    }
  }

  @Test("cudza decyzja (terminal, inne urządzenie) → ślad `CardNotice` jak dziś, bez śladu decyzji")
  func foreignDecision() throws {
    var state = try loaded()
    play(&state, [try Frames.golden("permission-resolved.max.json")], source: .session(sid))
    #expect(traces(state).isEmpty)
    #expect(state.notices.map(\.reason) == [.resolvedElsewhere(by: "iPad")])
  }

  @Test("odpowiedź na pytanie → ślad z odpowiedziami per pytanie; pusty transkrypt = ślad bez kotwicy")
  func answer() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("transcript-snapshot.question.json")], source: .session(qsid))
    let answers = [["shared/fixtures/sse"], ["PWA", "Swift"]]
    state.apply(
      .decisionStarted(sessionId: qsid, cardId: "toolu_31", choice: AnswerRules.summary(answers), answers: answers),
      now: t0)
    state.apply(.decisionFinished(sessionId: qsid, cardId: "toolu_31", kind: .question, result: .accepted), now: t0)
    #expect(traces(state, qsid) == [DecisionTrace(
      cardId: "toolu_31", outcome: .answered, toolName: nil, plan: false, command: nil, answers: answers,
      afterSeq: nil, at: t0)])
  }

  @Test("sufit śladów na sesję: najstarsze wypadają")
  func ceiling() throws {
    var view = TranscriptState()
    for index in 0..<(CoreLimits.maxDecisionTraces + 3) {
      view.record(DecisionTrace(
        cardId: "c\(index)", outcome: .allowed, toolName: "X", plan: false, command: nil, answers: [], afterSeq: index,
        at: t0))
    }
    #expect(view.decisionTraces.count == CoreLimits.maxDecisionTraces)
    #expect(view.decisionTraces.first?.cardId == "c3")
  }

  @Test("restart serwera (nowy `serverStartId`, numeracja od nowa): ślad trzyma epokę i czas kotwicy, stoi pod tą samą wiadomością")
  func serverRestart() throws {
    func message(_ seq: Int, _ at: String) -> TranscriptMessage {
      // swiftlint:disable:next force_try
      try! JSONDecoder().decode(TranscriptMessage.self, from: Data(#"""
        {"seq":\#(seq),"role":"assistant","blocks":[{"type":"text","text":"m"}],"at":"\#(at)"}
        """#.utf8))
    }
    func times(_ seconds: ClosedRange<Int>) -> [String] {
      seconds.map { ISOTime.string(t0.addingTimeInterval(Double($0))) }
    }
    var view = TranscriptState()
    view.messagesEpoch = "start-a"
    view.messages = zip(99...100, times(1...2)).map { message($0, $1) }
    view.pendingPermissions = try loaded().transcripts[sid]?.pendingPermissions ?? []
    let permId = try #require(view.pendingPermissions.first?.permId)
    let trace = try #require(view.traceDraft(cardId: permId, choice: "allow", answers: [], at: t0))
    #expect(trace.afterSeq == 100 && trace.afterAt == times(2...2).first && trace.epoch == "start-a")
    view.record(trace)

    // Ta sama rozmowa po restarcie: seq 19–20 to dawne 99–100, 21–30 doszły po decyzji.
    view.messagesEpoch = "start-b"
    view.messages = zip(19...30, times(1...12)).map { message($0, $1) }
    #expect(view.traceSlots() == [2], "nad seq 21, pod seq 20")
    #expect(view.traceBreaks() == [21])
    #expect(view.decisionTraces.count == 1)

    // W tej samej numeracji decyduje `seq`, nie czas.
    view.messagesEpoch = "start-a"
    #expect(view.traceSlots() == [view.messages.count])
  }
}
