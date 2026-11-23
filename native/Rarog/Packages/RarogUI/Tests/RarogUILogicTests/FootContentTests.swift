import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Reguła stopy ekranu sesji: jedna funkcja mówi, co stoi pod
// transkryptem — nic, karta stanu, karta decyzji czy pole. Wiersze tabeli kontraktu po kolei.

private enum F {
  static func question(_ qId: String) -> QuestionRequest {
    Sample.decode(QuestionRequest.self, #"""
      {"qId":"\#(qId)","sessionId":"s1","createdAt":"\#(Sample.iso(5))",
       "questions":[{"question":"Jak odebrać?","header":"Odbiór","multiSelect":false,"options":[
         {"label":"Sprawdź aplikację"}]}]}
      """#)
  }

  static func hook(_ permId: String, state: String) -> PermissionRequest {
    Sample.permission(permId: permId, extra: #""channel":"\#(PermissionChannel.hook.rawValue)","state":"\#(state)""#)
  }

  static func foot(_ state: AppState, ui: TranscriptUIState = TranscriptUIState()) -> FootContent {
    FootContent.make(state: state, sessionId: "s1", ui: ui)
  }

  static func waiting(_ kind: String = "waiting-permission") -> AppState {
    Sample.state(session: Sample.session(state: kind))
  }

  /// Odpowiedź na pytanie z tego ekranu przyjęta, a pytania już nie ma w kolejce: trzymane potwierdzenie.
  static func held(_ qId: String) -> TranscriptUIState {
    var ui = TranscriptUIState()
    ui.questions.begin(QuestionCardModel.make(question(qId)), answers: [["Sprawdź aplikację"]])
    ui.questions.finish(qId, .accepted)
    return ui
  }
}

@Suite("reguła stopy ekranu sesji: FootContent")
struct FootContentTests {
  @Test("brak sesji na liście → nic")
  func noSession() {
    #expect(F.foot(F.waiting()) != .none)
    #expect(FootContent.make(state: F.waiting(), sessionId: "nie-ma", ui: TranscriptUIState()) == .none)
  }

  @Test("limit, przerwana, błąd, gotowe (i wznowienie) → karta stanu", arguments: [
    "limit-reached", "interrupted", "error", "done", "resumable",
  ])
  func stateCard(_ kind: String) {
    #expect(F.foot(Sample.state(session: Sample.session(state: kind))) == .stateCard)
  }

  @Test("niezgodność wersji albo lista z pamięci podręcznej → pole (tylko do odczytu), także z kartą zgody")
  func incompatibleOrStale() {
    var state = F.waiting()
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission()]
    state.compat = .tooOld(minClientBuild: 9)
    #expect(F.foot(state) == .composer)
    state.compat = .protocolMismatch(server: 9)
    #expect(F.foot(state) == .composer)
    state.compat = .ok
    state.listCache.awaitingTranscripts = ["s1"]
    #expect(F.foot(state) == .composer)
  }

  @Test("herdr niedostępny albo tylko do odczytu → pole: karta zamknięta (locked) nie jest decyzją")
  func herdrLocked() {
    var state = F.waiting()
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission()]
    state.herdr = HerdrStatus(available: false, agentCount: 0, readOnly: false, canLaunch: false, detail: "gniazdo milczy")
    #expect(F.foot(state) == .composer)
    state.herdr = HerdrStatus(available: true, agentCount: 1, readOnly: true, canLaunch: false, detail: nil)
    #expect(F.foot(state) == .composer)
    // Karta stoi, ale bez decyzji — ten sam powód, który zamyka kartę w transkrypcie.
    #expect(TranscriptRows.lockedReason(state: state, session: state.sessions["s1"]) != nil)
    // Sesja nieobsługiwana też zamyka kartę — tu wygrywa karta stanu.
    var unsupported = Sample.state(session: Sample.session(state: "waiting-permission", extra: #""engine":"zzz""#))
    unsupported.transcripts["s1"]?.pendingPermissions = [Sample.permission()]
    #expect(F.foot(unsupported) == .stateCard)
  }

  @Test("czeka: karta zgody, pytania albo „dialog w terminalu” → decyzja w kolejności ogona transkryptu")
  func waitingDecision() {
    var state = F.waiting()
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1"), Sample.permission(permId: "p2")]
    #expect(F.foot(state) == .decision(DecisionQueue([.permission(permId: "p1"), .permission(permId: "p2")])))

    var question = F.waiting("waiting-question")
    question.transcripts["s1"]?.pendingQuestions = [F.question("q1")]
    #expect(F.foot(question) == .decision(DecisionQueue([.question(qId: "q1")])))

    // Zgody przed pytaniami — jak w `TranscriptRows.tail`.
    question.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1")]
    #expect(F.foot(question) == .decision(DecisionQueue([.permission(permId: "p1"), .question(qId: "q1")])))

    // Bez kart z treścią stoi karta „dialog w terminalu”.
    let dialog = F.waiting()
    let identity = HerdrDialogCards.identity(dialog.sessions["s1"]!)
    #expect(F.foot(dialog) == .decision(DecisionQueue([.herdrDialog(identity: identity)])))
    #expect(F.foot(dialog).decisions?.first == .herdrDialog(identity: identity))
  }

  @Test("czeka, przed pierwszą migawką transkryptu → decyzja z pustą kolejką (pole schowane, dok pusty)")
  func waitingBeforeSnapshot() {
    var state = F.waiting()
    state.transcripts["s1"]?.snapshots = 0
    #expect(F.foot(state) == .decision(DecisionQueue()))
    #expect(F.foot(state).decisions?.isEmpty == true)
    var question = F.waiting("waiting-question")
    question.transcripts["s1"] = nil
    #expect(F.foot(question) == .decision(DecisionQueue()))
  }

  @Test("running z trzymanym potwierdzeniem pytania → decyzja z potwierdzeniem do końca okna")
  func runningHeldConfirmation() {
    let state = Sample.state(session: Sample.session(state: "running"))
    #expect(F.foot(state, ui: F.held("q1")) == .decision(DecisionQueue([.heldQuestion(qId: "q1")])))
    #expect(F.foot(state) == .composer)
  }

  @Test("running z kartą kanału w claimed/running → pole; karta stoi w transkrypcie jako ślad",
        arguments: ["claimed", "running"])
  func runningChannelCard(_ channelState: String) {
    var state = Sample.state(session: Sample.session(state: "running"))
    state.transcripts["s1"]?.pendingPermissions = [F.hook("k1", state: channelState)]
    #expect(F.foot(state) == .composer)
  }

  @Test("zgoda w locie (sending), sesja dalej czeka → decyzja z tą kartą")
  func permissionInFlight() {
    var state = F.waiting()
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1")]
    state.apply(.decisionStarted(sessionId: "s1", cardId: "p1", choice: "allow"), now: Sample.now)
    guard case let .permission(card) = TranscriptRows.build(state: state, sessionId: "s1").last else {
      Issue.record("brak karty zgody")
      return
    }
    #expect(card.phase == .sending(.allow))
    #expect(F.foot(state) == .decision(DecisionQueue([.permission(permId: "p1")])))
  }

  @Test("sam wpis kolejki albo sam ślad CardNotice w ogonie nie jest decyzją")
  func outboxAndNoticeAreNotDecisions() {
    var state = Sample.state(session: Sample.session(state: "running"))
    state.outbox = [OutboxEntry(sessionId: "s1", text: "w locie", createdAt: Sample.now)]
    #expect(F.foot(state) == .composer)

    var notice = Sample.state(session: Sample.session(state: "running"))
    notice.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p9")]
    notice.apply(.decisionStarted(sessionId: "s1", cardId: "p9", choice: "allow"), now: Sample.now)
    notice.apply(
      .decisionFinished(sessionId: "s1", cardId: "p9", kind: .permission, result: .conflict), now: Sample.now)
    #expect(notice.transcripts["s1"]?.pendingPermissions.isEmpty == true)
    #expect(notice.notices.contains { $0.sessionId == "s1" }, "ślad 409 stoi w ogonie")
    #expect(F.foot(notice) == .composer)

    // Przy czekającej sesji ślad nie wchodzi do kolejki — stoi w niej tylko karta „dialog w terminalu”.
    var waiting = notice
    waiting.sessions["s1"] = Sample.session(state: "waiting-permission")
    let identity = HerdrDialogCards.identity(waiting.sessions["s1"]!)
    #expect(F.foot(waiting) == .decision(DecisionQueue([.herdrDialog(identity: identity)])))
  }

  @Test("trzymane potwierdzenie pod nową kartą: kolejka ma nową kartę pierwszą, karty dialogu nie ma")
  func heldUnderNewCard() {
    var state = F.waiting("waiting-question")
    state.transcripts["s1"]?.pendingQuestions = [F.question("q2")]
    let queue = F.foot(state, ui: F.held("q1")).decisions
    #expect(queue == DecisionQueue([.question(qId: "q2"), .heldQuestion(qId: "q1")]))
    #expect(queue?.first == .question(qId: "q2"))
    // Samo potwierdzenie przy czekającej sesji: karta „dialog w terminalu” nie staje.
    var alone = F.waiting("waiting-question")
    alone.transcripts["s1"]?.pendingQuestions = []
    #expect(F.foot(alone, ui: F.held("q1")) == .decision(DecisionQueue([.heldQuestion(qId: "q1")])))
  }

  @Test("kolejka = karty decyzji z ogona transkryptu, w tej samej kolejności")
  func queueMatchesTail() {
    var state = F.waiting("waiting-question")
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1")]
    state.transcripts["s1"]?.pendingQuestions = [F.question("q2")]
    let ui = F.held("q1")
    let tail: [DecisionCard] = TranscriptRows.build(state: state, sessionId: "s1", ui: ui).compactMap { row in
      switch row {
      case let .permission(card): .permission(permId: card.permId)
      case let .question(card): card.held ? .heldQuestion(qId: card.qId) : .question(qId: card.qId)
      case let .herdrDialog(card): .herdrDialog(identity: card.identity)
      default: nil
      }
    }
    #expect(F.foot(state, ui: ui).decisions?.cards == tail)
  }

  @Test("tryb ekranu przy decyzji: domyślnie karta w transkrypcie bez pola")
  func modeSwitch() {
    #expect(DecisionDock.mode == .transcript)
  }

  // MARK: - Karta w transkrypcie, pole schowane

  @Test("transkrypt: zgoda, pytanie albo „dialog w terminalu” chowa pole; karta zostaje wierszem ogona, doku nie ma")
  func transcriptHidesComposerForWaitingCard() {
    var permission = F.waiting()
    permission.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1"), Sample.permission(permId: "p2")]
    var question = F.waiting("waiting-question")
    question.transcripts["s1"]?.pendingQuestions = [F.question("q1")]
    let dialog = F.waiting()
    for (state, row) in [(permission, "pp1"), (question, "qq1"), (dialog, "dialog")] {
      let place = DecisionDock.placement(foot: F.foot(state), snapshotLoaded: true, mode: .transcript)
      #expect(place.hidesComposer, "\(row): pole schowane")
      #expect(place.card == nil, "\(row): karta nie idzie do doku")
      #expect(!place.pending)
      #expect(place.total == 0, "\(row): bez nagłówka „1 z N”")
      // Ten sam ogon co przed dokiem: `docked: nil`, `dockedPending: false`.
      #expect(TranscriptRows.build(state: state, sessionId: "s1", docked: place.card, dockedPending: place.pending)
        == TranscriptRows.build(state: state, sessionId: "s1"))
      #expect(TranscriptRows.build(state: state, sessionId: "s1").contains { $0.id == row }, "\(row) w transkrypcie")
    }
    // Trzymane potwierdzenie pod nową kartą: nowa karta czeka, pole schowane.
    var next = F.waiting("waiting-question")
    next.transcripts["s1"]?.pendingQuestions = [F.question("q2")]
    #expect(DecisionDock.placement(foot: F.foot(next, ui: F.held("q1")), snapshotLoaded: true, mode: .transcript)
      .hidesComposer)
  }

  @Test("transkrypt: okres łaski i czas przed pierwszą migawką chowają pole, zastępnik stoi w ogonie transkryptu")
  func transcriptHidesComposerInGraceAndBeforeSnapshot() {
    let empty = FootContent.decision(DecisionQueue())
    for snapshotLoaded in [true, false] {
      let place = DecisionDock.placement(foot: empty, snapshotLoaded: snapshotLoaded, loading: true, mode: .transcript)
      #expect(place.hidesComposer, "okres łaski, migawka \(snapshotLoaded)")
      #expect(!place.pending, "zastępnik nie idzie do doku")
      #expect(place.card == nil)
    }
    #expect(DecisionDock.placement(foot: empty, snapshotLoaded: false, mode: .transcript).hidesComposer,
            "przed pierwszą migawką bez klatki z polem")
    #expect(!DecisionDock.placement(foot: empty, snapshotLoaded: true, mode: .transcript).hidesComposer,
            "po migawce bez karty pole ze zdaniem o terminalu zostaje (warunek 1 właściciela)")
    let state = Grace.waiting()
    #expect(state.decisionLoading(for: "s1", now: Sample.now))
    let place = DecisionDock.placement(
      foot: FootContent.make(state: state, sessionId: "s1", ui: TranscriptUIState(), now: Sample.now),
      snapshotLoaded: true, loading: true, mode: .transcript)
    #expect(place.hidesComposer)
    #expect(TranscriptRows.build(state: state, sessionId: "s1", dockedPending: place.pending, now: Sample.now)
      .contains(.decisionPending), "zastępnik w ogonie transkryptu")
    // Karta przyszła: staje w transkrypcie w miejscu zastępnika, pole dalej schowane.
    let card = FootContent.decision(DecisionQueue([.permission(permId: "p1")]))
    let arrived = DecisionDock.placement(foot: card, snapshotLoaded: true, loading: true, mode: .transcript)
    #expect(arrived.hidesComposer)
    #expect(arrived.card == nil)
  }

  @Test("transkrypt: samo trzymane potwierdzenie, karta zamknięta, karta stanu i pole nie chowają pola")
  func transcriptKeepsComposer() {
    let running = Sample.state(session: Sample.session(state: "running"))
    let held = F.foot(running, ui: F.held("q1"))
    #expect(held == .decision(DecisionQueue([.heldQuestion(qId: "q1")])))
    #expect(DecisionDock.placement(foot: held, snapshotLoaded: true, mode: .transcript) == .none, "sesja ruszyła")
    var alone = F.waiting("waiting-question")
    alone.transcripts["s1"]?.pendingQuestions = []
    #expect(!DecisionDock.placement(foot: F.foot(alone, ui: F.held("q1")), snapshotLoaded: true, mode: .transcript)
      .hidesComposer)

    var locked = F.waiting()
    locked.transcripts["s1"]?.pendingPermissions = [Sample.permission()]
    locked.herdr = HerdrStatus(available: false, agentCount: 0, readOnly: false, canLaunch: false, detail: "gniazdo milczy")
    #expect(F.foot(locked) == .composer)
    locked.herdr = HerdrStatus(available: true, agentCount: 1, readOnly: true, canLaunch: false, detail: nil)
    #expect(F.foot(locked) == .composer)
    for foot in [FootContent.composer, .stateCard, .none] {
      for loading in [true, false] {
        #expect(DecisionDock.placement(foot: foot, snapshotLoaded: false, loading: loading, mode: .transcript) == .none)
      }
    }
  }

  @Test("transkrypt: przygaszenie jak przed dokiem — według kart z treścią w transkrypcie")
  func transcriptDimming() {
    var channel = Sample.state(session: Sample.session(state: "running"))
    channel.transcripts["s1"]?.pendingPermissions = [F.hook("k1", state: "running")]
    var question = F.waiting("waiting-question")
    question.transcripts["s1"]?.pendingQuestions = [F.question("q1")]
    let dialog = F.waiting()
    let running = Sample.state(session: Sample.session(state: "running"))
    for state in [channel, question, dialog, running] {
      let view = state.transcripts["s1"]
      #expect(DecisionDock.dims(foot: F.foot(state), view: view, mode: .transcript)
        == DecisionDock.dims(foot: F.foot(state), view: view, mode: .readOnlyComposer))
    }
    #expect(DecisionDock.dims(foot: F.foot(question), view: question.transcripts["s1"], mode: .transcript))
  }

  // MARK: - Dok decyzji: gdzie stoi karta, pole, przygaszenie, sufit

  @Test("przełącznik wyłączony: żadna karta w doku, pole stoi przy każdej stopie")
  func dockDisabledKeepsComposer() {
    var permission = F.waiting()
    permission.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1")]
    var before = F.waiting()
    before.transcripts["s1"]?.snapshots = 0
    let feet = [F.foot(permission), F.foot(F.waiting()), F.foot(before), .composer, .stateCard, .none]
    for foot in feet {
      let place = DecisionDock.placement(foot: foot, snapshotLoaded: true, mode: .readOnlyComposer)
      #expect(place.card == nil)
      #expect(!place.hidesComposer)
      #expect(!DecisionDock.placement(foot: foot, snapshotLoaded: false, mode: .readOnlyComposer).hidesComposer)
    }
    // Ogon transkryptu bez zmian: karta zgody dalej jest jego wierszem.
    #expect(TranscriptRows.build(state: permission, sessionId: "s1").contains { $0.id == "pp1" })
  }

  @Test("dok: pierwsza karta zgody albo „dialog w terminalu” staje w doku, pole schowane; „1 z N” z kolejki")
  func dockTakesPermissionAndDialog() {
    var state = F.waiting()
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1"), Sample.permission(permId: "p2")]
    let place = DecisionDock.placement(foot: F.foot(state), snapshotLoaded: true, mode: .dock)
    #expect(place.card == .permission(permId: "p1"))
    #expect(place.hidesComposer)
    #expect(place.total == 2)

    let dialog = F.waiting()
    let identity = HerdrDialogCards.identity(dialog.sessions["s1"]!)
    let dialogPlace = DecisionDock.placement(foot: F.foot(dialog), snapshotLoaded: true, mode: .dock)
    #expect(dialogPlace.card == .herdrDialog(identity: identity))
    #expect(dialogPlace.hidesComposer)
    #expect(dialogPlace.total == 1)
  }

  @Test("dok: karta pytania (też formularz) i samo potwierdzenie stają w doku, pole schowane")
  func dockTakesQuestions() {
    var question = F.waiting("waiting-question")
    question.transcripts["s1"]?.pendingQuestions = [F.question("q1"), F.question("q2")]
    let place = DecisionDock.placement(foot: F.foot(question), snapshotLoaded: true, mode: .dock)
    #expect(place.card == .question(qId: "q1"))
    #expect(place.hidesComposer)
    #expect(place.total == 2)
    #expect(!place.pending)

    let running = Sample.state(session: Sample.session(state: "running"))
    let held = DecisionDock.placement(foot: F.foot(running, ui: F.held("q1")), snapshotLoaded: true, mode: .dock)
    #expect(held.card == .heldQuestion(qId: "q1"))
    #expect(held.hidesComposer)
    #expect(held.total == 1)

    // Trzymane potwierdzenie pod nową kartą: w doku nowa karta, potwierdzenie czeka w transkrypcie.
    var next = F.waiting("waiting-question")
    next.transcripts["s1"]?.pendingQuestions = [F.question("q2")]
    let under = DecisionDock.placement(foot: F.foot(next, ui: F.held("q1")), snapshotLoaded: true, mode: .dock)
    #expect(under.card == .question(qId: "q2"))
    #expect(under.total == 2)
  }

  @Test("przełącznik wyłączony: karta pytania i potwierdzenie zostają w transkrypcie, pole tylko do odczytu")
  func dockDisabledLeavesQuestions() {
    var question = F.waiting("waiting-question")
    question.transcripts["s1"]?.pendingQuestions = [F.question("q1")]
    let place = DecisionDock.placement(foot: F.foot(question), snapshotLoaded: true, mode: .readOnlyComposer)
    #expect(place == .none)
    #expect(TranscriptRows.build(state: question, sessionId: "s1").contains { $0.id == "qq1" })
    #expect(ComposerModel.make(state: question, sessionId: "s1").reason
      == UICopy.sendBlock(.decisionPending, session: question.sessions["s1"], cardShown: true))
    let running = Sample.state(session: Sample.session(state: "running"))
    let held = DecisionDock.placement(foot: F.foot(running, ui: F.held("q1")), snapshotLoaded: true, mode: .readOnlyComposer)
    #expect(held == .none)
  }

  @Test("karta pytania w doku nie jest wierszem ogona; wiersz doku = ten sam model co w ogonie")
  func dockedQuestionLeavesTail() {
    var state = F.waiting("waiting-question")
    state.transcripts["s1"]?.pendingQuestions = [F.question("q1"), F.question("q2")]
    let ids = TranscriptRows.build(state: state, sessionId: "s1", docked: .question(qId: "q1")).map(\.id)
    #expect(!ids.contains("qq1"))
    #expect(ids.contains("qq2"))
    let tail = TranscriptRows.build(state: state, sessionId: "s1").first { $0.id == "qq1" }
    #expect(tail != nil)
    #expect(TranscriptRows.dockRow(state: state, sessionId: "s1", ui: TranscriptUIState(), card: .question(qId: "q1"))
      == tail)
    #expect(TranscriptRows.dockRow(
      state: state, sessionId: "s1", ui: TranscriptUIState(), card: .question(qId: "nie-ma")) == nil)

    // Trzymane potwierdzenie: wiersz doku to karta `held` z wysłaną odpowiedzią, w ogonie jej nie ma.
    let running = Sample.state(session: Sample.session(state: "running"))
    let ui = F.held("q1")
    let heldRow = TranscriptRows.dockRow(state: running, sessionId: "s1", ui: ui, card: .heldQuestion(qId: "q1"))
    guard case let .question(card)? = heldRow else {
      Issue.record("brak potwierdzenia w doku")
      return
    }
    #expect(card.held)
    #expect(TranscriptRows.build(state: running, sessionId: "s1", ui: ui).contains { $0.id == "qq1" })
    #expect(!TranscriptRows.build(state: running, sessionId: "s1", ui: ui, docked: .heldQuestion(qId: "q1"))
      .contains { $0.id == "qq1" })
    // Pytanie wróciło do kolejki serwera: to już nie trzymane potwierdzenie.
    var back = running
    back.transcripts["s1"]?.pendingQuestions = [F.question("q1")]
    #expect(TranscriptRows.dockRow(state: back, sessionId: "s1", ui: ui, card: .heldQuestion(qId: "q1")) == nil)
  }

  @Test("okres łaski z dokiem: zastępnik w doku (pole schowane), w ogonie transkryptu go nie ma")
  func dockTakesGracePlaceholder() {
    let empty = FootContent.decision(DecisionQueue())
    for snapshotLoaded in [true, false] {
      let place = DecisionDock.placement(foot: empty, snapshotLoaded: snapshotLoaded, loading: true, mode: .dock)
      #expect(place.pending)
      #expect(place.card == nil)
      #expect(place.hidesComposer)
    }
    // Karta przyszła: zastępnik ustępuje karcie w tym samym miejscu.
    let card = FootContent.decision(DecisionQueue([.permission(permId: "p1")]))
    let arrived = DecisionDock.placement(foot: card, snapshotLoaded: true, loading: true, mode: .dock)
    #expect(!arrived.pending)
    #expect(arrived.card == .permission(permId: "p1"))
    // Poza stopą decyzji zastępnika w doku nie ma.
    for foot in [FootContent.composer, .stateCard, .none] {
      #expect(!DecisionDock.placement(foot: foot, snapshotLoaded: true, loading: true, mode: .dock).pending)
    }

    let state = Grace.waiting()
    #expect(state.decisionLoading(for: "s1", now: Sample.now))
    let tail = TranscriptRows.build(state: state, sessionId: "s1", now: Sample.now)
    #expect(tail.contains(.decisionPending), "bez doku zastępnik stoi w ogonie")
    #expect(!TranscriptRows.build(state: state, sessionId: "s1", dockedPending: true, now: Sample.now)
      .contains(.decisionPending), "z dokiem zastępnik stoi w doku, nie w ogonie")
  }

  @Test("okres łaski, przełącznik wyłączony: zastępnik zostaje wierszem transkryptu, pole stoi")
  func dockDisabledKeepsGracePlaceholderInTranscript() {
    let empty = FootContent.decision(DecisionQueue())
    let place = DecisionDock.placement(foot: empty, snapshotLoaded: true, loading: true, mode: .readOnlyComposer)
    #expect(place == .none)
    #expect(!place.pending)
    let state = Grace.waiting()
    #expect(TranscriptRows.build(state: state, sessionId: "s1", now: Sample.now).contains(.decisionPending))
  }

  @Test("dok: pusta kolejka przed pierwszą migawką chowa pole (dok pusty); po migawce bez karty pole zostaje")
  func dockEmptyQueue() {
    let empty = FootContent.decision(DecisionQueue())
    let before = DecisionDock.placement(foot: empty, snapshotLoaded: false, mode: .dock)
    #expect(before.card == nil)
    #expect(before.hidesComposer)
    let after = DecisionDock.placement(foot: empty, snapshotLoaded: true, mode: .dock)
    #expect(!after.hidesComposer, "bez karty pole ze zdaniem o terminalu zostaje (warunek 1 właściciela)")
    for foot in [FootContent.composer, .stateCard, .none] {
      #expect(!DecisionDock.placement(foot: foot, snapshotLoaded: true, mode: .dock).hidesComposer)
    }
  }

  @Test("karta w doku nie jest wierszem ogona; reszta kolejki zostaje w transkrypcie")
  func dockedCardLeavesTail() {
    var state = F.waiting()
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1"), Sample.permission(permId: "p2")]
    let ids = TranscriptRows.build(state: state, sessionId: "s1", docked: .permission(permId: "p1")).map(\.id)
    #expect(!ids.contains("pp1"))
    #expect(ids.contains("pp2"))
    // Wiersz doku = ten sam model, który stałby w ogonie.
    let tail = TranscriptRows.build(state: state, sessionId: "s1").first { $0.id == "pp1" }
    #expect(TranscriptRows.dockRow(state: state, sessionId: "s1", ui: TranscriptUIState(), card: .permission(permId: "p1"))
      == tail)

    let dialog = F.waiting()
    let identity = HerdrDialogCards.identity(dialog.sessions["s1"]!)
    let card = DecisionCard.herdrDialog(identity: identity)
    #expect(!TranscriptRows.build(state: dialog, sessionId: "s1", docked: card).contains { $0.id == "dialog" })
    #expect(TranscriptRows.build(state: dialog, sessionId: "s1").contains { $0.id == "dialog" })
    #expect(TranscriptRows.dockRow(state: dialog, sessionId: "s1", ui: TranscriptUIState(), card: card)?.id == "dialog")
    #expect(TranscriptRows.dockRow(
      state: dialog, sessionId: "s1", ui: TranscriptUIState(), card: .permission(permId: "nie-ma")) == nil)
  }

  @Test("przygaszenie: bez doku według kart z treścią, z dokiem według stopy")
  func dockDimming() {
    var channel = Sample.state(session: Sample.session(state: "running"))
    channel.transcripts["s1"]?.pendingPermissions = [F.hook("k1", state: "running")]
    let view = channel.transcripts["s1"]
    #expect(DecisionDock.dims(foot: F.foot(channel), view: view, mode: .readOnlyComposer), "dziś: karta kanału po decyzji")
    #expect(!DecisionDock.dims(foot: F.foot(channel), view: view, mode: .dock), "z dokiem: pole, nie decyzja")

    let dialog = F.waiting()
    #expect(!DecisionDock.dims(foot: F.foot(dialog), view: dialog.transcripts["s1"], mode: .readOnlyComposer))
    #expect(DecisionDock.dims(foot: F.foot(dialog), view: dialog.transcripts["s1"], mode: .dock))

    let running = Sample.state(session: Sample.session(state: "running"))
    #expect(!DecisionDock.dims(foot: F.foot(running, ui: F.held("q1")), view: running.transcripts["s1"], mode: .dock),
            "samo potwierdzenie nie przygasza")

    // Samo pytanie w kolejce (bez zgody i bez karty dialogu) przygasza — z dokiem i bez niego.
    var question = F.waiting("waiting-question")
    question.transcripts["s1"]?.pendingQuestions = [F.question("q1")]
    #expect(F.foot(question) == .decision(DecisionQueue([.question(qId: "q1")])))
    #expect(DecisionDock.dims(foot: F.foot(question), view: question.transcripts["s1"], mode: .dock))
    #expect(DecisionDock.dims(foot: F.foot(question), view: question.transcripts["s1"], mode: .readOnlyComposer))
    // Zastępnik okresu łaski nie przygasza (kolejka pusta).
    #expect(!DecisionDock.dims(foot: .decision(DecisionQueue()), view: nil, mode: .dock))
  }

  @Test("układ zwarty: karta nigdy ponad sufit; środek ma gwarantowane minimum, przypięte części dostają resztę",
        arguments: [
          // nagłówek, środek, zamknięcie, sufit → nagłówek, środek, zamknięcie
          (40.0, 500.0, 80.0, 360.0, 40.0, 240.0, 80.0),
          (40.0, 100.0, 80.0, 360.0, 40.0, 100.0, 80.0),
          // Sufit 360, wysłana „Własna odpowiedź” ze 100 liniami w zdaniu stanu (stopka ~1500 pt): środek trzyma
          // trzecią część sufitu, stopka (sama przewijana) resztę po nagłówku.
          (40.0, 300.0, 1500.0, 360.0, 40.0, 120.0, 200.0),
          // Duże pismo, niski sufit (telefon w poziomie z klawiaturą): nagłówek, środek i stopka po trzeciej części.
          (200.0, 300.0, 200.0, 120.0, 40.0, 40.0, 40.0),
          // Stopka wysoka, środek ponad trzecią część: środek nie spada do 0.
          (60.0, 300.0, 200.0, 300.0, 60.0, 100.0, 140.0),
          // Środek krótszy od trzeciej części: ma swoją wysokość, stopka bierze resztę.
          (200.0, 20.0, 200.0, 120.0, 40.0, 20.0, 60.0),
          (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
        ])
  func compactHeights(
    _ header: Double, _ middle: Double, _ closing: Double, _ ceiling: Double,
    _ eHeader: Double, _ eMiddle: Double, _ eClosing: Double
  ) {
    let split = DecisionDock.compactHeights(header: header, middle: middle, closing: closing, ceiling: ceiling)
    #expect(split.header == eHeader)
    #expect(split.middle == eMiddle)
    #expect(split.closing == eClosing)
    #expect(split.header + split.middle + split.closing <= ceiling)
    #expect(split.middle >= min(middle, ceiling / 3), "środek nigdy poniżej gwarantowanego minimum")
  }

  @Test("sufit doku: min(0,5 × wysokość ekranu, miejsce nad klawiaturą − 120 pt), nie niżej niż 120 pt",
        arguments: [
          (852.0, 793.0, 426.0), (852.0, 457.0, 337.0), (1194.0, 1170.0, 597.0), (393.0, 150.0, 120.0),
        ])
  func dockCeiling(_ screen: Double, _ above: Double, _ expected: Double) {
    #expect(DecisionDock.ceiling(screenHeight: screen, aboveKeyboard: above) == expected)
  }

  @Test("zdanie pod polem: „karta wyżej” tylko przy karcie TEJ decyzji, jak przed regułą stopy")
  func composerReason() {
    // Sesja czeka na pytanie, a stoi tylko karta zgody: zdanie mówi o terminalu, nie o karcie.
    var state = F.waiting("waiting-question")
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1")]
    #expect(ComposerModel.make(state: state, sessionId: "s1").reason
      == UICopy.sendBlock(.decisionPending, session: state.sessions["s1"], cardShown: false))
    state.transcripts["s1"]?.pendingQuestions = [F.question("q1")]
    #expect(ComposerModel.make(state: state, sessionId: "s1").reason
      == UICopy.sendBlock(.decisionPending, session: state.sessions["s1"], cardShown: true))
  }
}
