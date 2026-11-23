import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

// Odpowiedź na kartę pytania: reguły odpowiedzi, akcja magazynu, wyniki serwera
// i spóźnione odpowiedzi po wylogowaniu. Właściciel: karty pytań.

/// Atrapa z kontrolą trasy odpowiedzi; strumienie i reszta tras z `FakeTransport`.
final class AnswerProbe: RarogTransporting, @unchecked Sendable {
  struct Calls {
    var answers: [(sessionId: String, qId: String, body: AnswersBody)] = []
    var error: TransportError?
    /// Wstrzymuje żądanie „w drodze" (wylogowanie w trakcie, karta zdjęta w trakcie).
    var onAnswer: (@Sendable () async -> Void)?
    /// Ile żądań zobaczyło anulowanie.
    var cancelled = 0
  }

  let base: FakeTransport
  let calls = Mutex(Calls())

  init(base: FakeTransport = FakeTransport()) {
    self.base = base
  }

  func set(_ change: (inout Calls) -> Void) { calls.withLock { change(&$0) } }
  func read<T>(_ value: (Calls) -> T) -> T { calls.withLock { value($0) } }

  func answerQuestion(sessionId: String, qId: String, _ body: AnswersBody) async throws(TransportError) {
    if let gate = base.gate {
      do {
        try await gate.check(method: "POST", path: "/api/sessions/\(sessionId)/answers/\(qId)")
      } catch {
        throw .refused(error)
      }
    }
    let (error, hook) = calls.withLock { state in
      state.answers.append((sessionId, qId, body))
      return (state.error, state.onAnswer)
    }
    await hook?()
    if Task.isCancelled {
      calls.withLock { $0.cancelled += 1 }
      throw .cancelled
    }
    if let error { throw error }
  }

  // Reszta protokołu — atrapa bazowa.
  var hasCredential: Bool { base.hasCredential }
  func version() async throws(TransportError) -> VersionInfo { try await base.version() }
  func usage() async throws(TransportError) -> PlanUsage { try await base.usage() }
  func sendMessage(
    sessionId: String, _ upload: MessageUpload, timeout: Duration?, progress: (@Sendable (UploadProgress) -> Void)?
  ) async throws(TransportError) -> MessageAccepted? {
    try await base.sendMessage(sessionId: sessionId, upload, timeout: timeout, progress: progress)
  }
  func decidePermission(sessionId: String, permId: String, _ body: PermissionDecisionBody) async throws(TransportError) {
    try await base.decidePermission(sessionId: sessionId, permId: permId, body)
  }
  func presence(_ body: PresenceBody) async throws(TransportError) { try await base.presence(body) }
  func clientLog(_ body: ClientLogBody) async throws(TransportError) { try await base.clientLog(body) }
  func openStream(
    _ scope: StreamScope, lastEventId: String?, watch: StreamStallGuard
  ) async throws(TransportError) -> AsyncThrowingStream<SSEParser.Output, any Error> {
    try await base.openStream(scope, lastEventId: lastEventId, watch: watch)
  }
  func recentProjects() async throws(TransportError) -> RecentProjectList { try await base.recentProjects() }
  func createSession(_ body: CreateSessionBody) async throws(TransportError) -> CreateSessionResponse {
    try await base.createSession(body)
  }
  func closeSession(sessionId: String, _ body: CloseSessionBody) async throws(TransportError) {
    try await base.closeSession(sessionId: sessionId, body)
  }
  func models() async throws(TransportError) -> ModelList { try await base.models() }
  func setSessionModel(sessionId: String, _ body: SessionModelBody) async throws(TransportError) -> SessionModelAccepted {
    try await base.setSessionModel(sessionId: sessionId, body)
  }
  func setSessionMode(sessionId: String, _ body: SessionModeBody) async throws(TransportError) {
    try await base.setSessionMode(sessionId: sessionId, body)
  }
  func restartSession(sessionId: String, resend: SessionPromptBlocked?) async throws(TransportError) -> RestartResponse {
    try await base.restartSession(sessionId: sessionId, resend: resend)
  }
  func sessionDiff(sessionId: String) async throws(TransportError) -> SessionDiff {
    try await base.sessionDiff(sessionId: sessionId)
  }
  func sessionDiffFiles(sessionId: String) async throws(TransportError) -> DiffFileList {
    try await base.sessionDiffFiles(sessionId: sessionId)
  }
  func sessionDiffFile(sessionId: String, path: String) async throws(TransportError) -> DiffFilePatch {
    try await base.sessionDiffFile(sessionId: sessionId, path: path)
  }
}

/// Dwa pytania: jednokrotny wybór z opcją „tylko w terminalu" i wielokrotny wybór.
private let form = #"""
  {"qId":"q1","sessionId":"s1","createdAt":"2026-10-03T08:00:00.000Z","customAnswer":true,
   "questions":[
    {"question":"Jak zapisujemy?","header":"Zapis","multiSelect":false,"options":[
      {"label":"JSON + rename","role":"answer"},
      {"label":"Zawsze pozwalaj","terminalOnly":true,"role":"answer"},
      {"label":"Inne","role":"custom"}]},
    {"question":"Które testy?","header":"Testy","multiSelect":true,"options":[
      {"label":"Jednostkowe"},{"label":"Integracyjne"}]}]}
  """#

/// Magazyn z atrapą odpowiedzi: zalogowany, sesja `s1` czeka na pytanie `q1` (z `form`).
@MainActor
private func answerStore(question: String = form) async throws -> (RarogStore, AnswerProbe) {
  let probe = AnswerProbe()
  let rules = MutationRules(timing: fastTiming)
  probe.base.gate = MutationGate(policy: rules)
  let store = RarogStore(transport: probe, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
  await store.start()
  await until("online") { store.state.global == .online }
  probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
  probe.base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "waiting-question"))]}"#)
  await until("lista") { store.state.sessionsLoaded }
  store.openSession("s1")
  await until("strumień sesji") { probe.base.streamCalls.contains { $0.scope == .session(id: "s1") } }
  probe.base.push(.session(id: "s1"), json: #"""
    {"type":"transcript-snapshot","sessionId":"s1","messages":[],"pendingPermissions":[],"pendingQuestions":[\#(question)]}
    """#)
  await until("karta pytania") { store.state.transcripts["s1"]?.pendingQuestions.count == 1 }
  return (store, probe)
}

@Suite("reguły odpowiedzi na pytanie")
struct AnswerRulesTests {
  private let request: QuestionRequest = {
    // swiftlint:disable:next force_try
    try! JSONDecoder().decode(QuestionRequest.self, from: Data(form.utf8))
  }()

  @Test("opcja „tylko w terminalu” wypada nawet podana programowo; puste wartości też; etykiety dosłownie")
  func sanitize() {
    let clean = AnswerRules.sanitize([["Zawsze pozwalaj", " JSON + rename "], ["", "Jednostkowe"]], for: request)
    #expect(clean == [[" JSON + rename "], ["Jednostkowe"]])
    #expect(AnswerRules.sanitize([["Zawsze pozwalaj"]], for: request) == [[], []])
    #expect(!AnswerRules.complete(AnswerRules.sanitize([["Zawsze pozwalaj"], ["Jednostkowe"]], for: request), for: request))
    #expect(AnswerRules.complete([["JSON + rename"], ["Jednostkowe"]], for: request))
  }

  @Test("notatki: pozycja na pytanie, biała = brak, przycięte; bez żadnej — brak pola")
  func notes() {
    #expect(AnswerRules.notes(nil, for: request) == nil)
    #expect(AnswerRules.notes(["  ", nil], for: request) == nil, "same białe znaki to nie notatka")
    #expect(AnswerRules.notes(["  bez paska \n"], for: request) == ["bez paska", nil], "tyle pozycji, ile pytań")
    #expect(AnswerRules.notes([nil, "x", "nadmiarowa"], for: request) == [nil, "x"])
    let long = String(repeating: "n", count: AnswerLimits.maxNoteUnits + 5)
    let clamped = AnswerRules.notes([long], for: request)?[0] ?? nil
    #expect(clamped?.utf16.count == AnswerLimits.maxNoteUnits)
  }

  @Test("podpis: wartości po przecinku w kolejności pytań")
  func summary() {
    #expect(AnswerRules.summary([["JSON + rename"], ["Jednostkowe", "Integracyjne"]]) == "JSON + rename, Jednostkowe, Integracyjne")
    #expect(AnswerRules.summary([[]]) == "")
  }
}

@MainActor
@Suite("magazyn: odpowiedź na kartę pytania")
struct StoreAnswerTests {
  @Test("przyjęta: wartości dosłownie, karta czeka na rozstrzygnięcie, drugie tapnięcie nic nie wysyła")
  func accepted() async throws {
    let (store, probe) = try await answerStore()
    let answers = [["JSON + rename"], ["Jednostkowe", "Integracyjne"]]
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: answers) == .accepted)
    #expect(probe.read { $0.answers.map(\.body) } == [AnswersBody(answers: answers)])
    #expect(store.state.transcripts["s1"]?.pendingQuestions.count == 1)
    #expect(store.state.transcripts["s1"]?.decisions["q1"]?.choice == "JSON + rename, Jednostkowe, Integracyjne")
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: answers) == .alreadyInFlight)
    probe.base.push(.session(id: "s1"), json: #"{"type":"question-resolved","sessionId":"s1","qId":"q1"}"#)
    await until("karta zdjęta") { store.state.transcripts["s1"]?.pendingQuestions.isEmpty == true }
    #expect(store.state.notices.isEmpty, "własna odpowiedź nie zostawia śladu „innego urządzenia”")
    #expect(probe.read { $0.answers.count } == 1)
    // Ślad decyzji niesie odpowiedzi per pytanie, nie spłaszczony podpis.
    #expect(store.state.transcripts["s1"]?.decisionTraces.map(\.answers) == [answers])
  }

  @Test("notatka jedzie równolegle do odpowiedzi; 422 zostawia kartę; bez notatki ciało bez notatek")
  func notesInBody() async throws {
    let (store, probe) = try await answerStore()
    let answers = [["JSON + rename"], ["Jednostkowe"]]
    let refusal = APIFailure(
      status: 422, code: "refused", message: "Nic nie doszło do panelu — sprawdź herdr i spróbuj ponownie.",
      reason: "send-failed")
    probe.set { $0.error = .http(refusal) }
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: answers, notes: ["bez paska", nil])
      == .refused(message: refusal.message))
    #expect(store.state.transcripts["s1"]?.pendingQuestions.count == 1, "po 422 karta zostaje")
    probe.set { $0.error = nil }
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: answers, notes: ["  ", nil]) == .accepted)
    #expect(probe.read { $0.answers.map(\.body) } == [
      AnswersBody(answers: answers, notes: ["bez paska", nil]),
      AnswersBody(answers: answers),
    ])
  }

  @Test("karta zdjęta przed gestem → nic nie wychodzi; tylko opcja terminalowa → nic; offline → odmowa od razu")
  func nothingSent() async throws {
    let (store, probe) = try await answerStore()
    #expect(await store.answerQuestion(sessionId: "s1", qId: "inne", answers: [["A"]]) == .cardGone)
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: [["Zawsze pozwalaj"], ["Jednostkowe"]]) == .incomplete)
    probe.base.end(.global, error: .offline(.networkConnectionLost))
    await until("offline") { store.state.global != .online }
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: [["JSON + rename"], ["Jednostkowe"]]) == .offline)
    #expect(probe.read { $0.answers.isEmpty })
    #expect(store.state.transcripts["s1"]?.decisions.isEmpty == true)
  }

  @Test("karta zdjęta między gestem a odpowiedzią serwera: 410 → ślad „wygasło”, bez drugiej próby")
  func goneInFlight() async throws {
    let (store, probe) = try await answerStore()
    probe.set { $0.error = .http(APIFailure(status: 410, code: "gone", message: "Prośba wygasła — wznów sesję.")) }
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: [["JSON + rename"], ["Jednostkowe"]]) == .expired)
    #expect(store.state.transcripts["s1"]?.pendingQuestions.isEmpty == true)
    #expect(store.state.notices.map(\.kind) == [.question])
    #expect(store.state.notices.map(\.reason) == [.expired])
  }

  @Test(
    "strumień zdjął kartę, zanim wróciła odpowiedź: 410 i 409 conflict i tak zostawiają jeden ślad",
    arguments: [
      (APIFailure(status: 410, code: "gone", message: "Prośba wygasła — wznów sesję."), AnswerOutcome.expired, CardNotice.Reason.expired),
      (APIFailure(status: 409, code: "conflict"), AnswerOutcome.alreadyDecided, CardNotice.Reason.alreadyDecided),
    ])
  func resolvedBeforeResult(failure: APIFailure, outcome: AnswerOutcome, reason: CardNotice.Reason) async throws {
    let (store, probe) = try await answerStore()
    let release = Box()
    probe.set {
      $0.error = .http(failure)
      $0.onAnswer = { while !release.value { try? await Task.sleep(for: .milliseconds(5)) } }
    }
    let flight = Task { await store.answerQuestion(sessionId: "s1", qId: "q1", answers: [["JSON + rename"], ["Jednostkowe"]]) }
    await until("żądanie w drodze") { probe.read { $0.answers.count } == 1 }
    probe.base.push(.session(id: "s1"), json: #"{"type":"question-resolved","sessionId":"s1","qId":"q1"}"#)
    await until("karta zdjęta strumieniem") { store.state.transcripts["s1"]?.pendingQuestions.isEmpty == true }
    #expect(store.state.notices.isEmpty, "rozstrzygnięcie w trakcie własnej próby nie jest jeszcze „innym urządzeniem”")
    release.set()
    #expect(await flight.value == outcome)
    #expect(store.state.notices.map(\.reason) == [reason])
    #expect(store.state.notices.map(\.kind) == [.question])
  }

  @Test("409 conflict → znika ze śladem; 409 bad-state, 422 i 400 → zostaje ze zdaniem; sieć → zostaje")
  func outcomes() async throws {
    let (store, probe) = try await answerStore()
    let answers = [["JSON + rename"], ["Jednostkowe", "Integracyjne"]]
    let multi = APIFailure(status: 409, code: "bad-state", message: "Wielokrotny wybór zrób w terminalu — Rarog wyśle jedną odpowiedź.")
    probe.set { $0.error = .http(multi) }
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: answers) == .refused(message: multi.message))
    #expect(store.state.transcripts["s1"]?.pendingQuestions.count == 1)
    #expect(store.state.transcripts["s1"]?.decisions.isEmpty == true)
    let custom = APIFailure(status: 400, code: "bad-request", message: "Własną odpowiedź wpisz w terminalu — Rarog wysyła cyfrę jednej z opcji.")
    probe.set { $0.error = .http(custom) }
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: answers) == .refused(message: custom.message))
    probe.set { $0.error = .http(APIFailure(status: 422, code: "refused", message: "Nic nie doszło do panelu.", reason: "send-failed")) }
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: answers) == .refused(message: "Nic nie doszło do panelu."))
    probe.set { $0.error = .timedOut }
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: answers) == .failed)
    #expect(store.state.notices.isEmpty)
    probe.set { $0.error = .http(APIFailure(status: 409, code: "conflict")) }
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: answers) == .alreadyDecided)
    #expect(store.state.transcripts["s1"]?.pendingQuestions.isEmpty == true)
    #expect(store.state.notices.map(\.reason) == [.alreadyDecided])
  }

  @Test("401 przy odpowiedzi → wylogowanie")
  func unauthorized() async throws {
    let (store, probe) = try await answerStore()
    probe.set { $0.error = .unauthorized(APIFailure(status: 401)) }
    #expect(await store.answerQuestion(sessionId: "s1", qId: "q1", answers: [["JSON + rename"], ["Jednostkowe"]]) == .loggedOut)
    #expect(store.state.auth == .loggedOut(.deviceUnknown))
  }

  @Test("wylogowanie w trakcie: żądanie anulowane, wynik do kosza, nowe zalogowanie nietknięte")
  func logoutInFlight() async throws {
    let (store, probe) = try await answerStore()
    // Odpowiedź „w drodze" — gdyby wróciła, przyniosłaby 401 i wylogowała nowe zalogowanie.
    probe.set {
      $0.error = .unauthorized(APIFailure(status: 401))
      $0.onAnswer = { try? await Task.sleep(for: .seconds(5)) }
    }
    let flight = Task { await store.answerQuestion(sessionId: "s1", qId: "q1", answers: [["JSON + rename"], ["Jednostkowe"]]) }
    await until("żądanie w drodze") { probe.read { $0.answers.count } == 1 }
    probe.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    store.enterLoggedIn()
    #expect(await flight.value == .discarded)
    #expect(probe.read { $0.cancelled } == 1, "wylogowanie anulowało żądanie")
    #expect(store.state.auth == .loggedIn)
  }
}
