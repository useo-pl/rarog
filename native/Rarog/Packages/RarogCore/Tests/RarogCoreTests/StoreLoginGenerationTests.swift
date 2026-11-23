import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

// A late 401 of an action from before logging in again: the result of an action from the old login does not change
// authorization (`handleUnauthorized(since:)`), so a refusal of the old login that arrives after the new one
// (pairing, key retry — `enterLoggedIn`) does not log the new one out. Actions with their own cut-off of the
// result after logout (question, dialog, "Resume", interrupt, new session, photo, dictation key) are in the same
// test: together with `since:` they do not let an old 401 through.

/// Akcja sieciowa, której odpowiedź wstrzymujemy do chwili po ponownym logowaniu.
enum LateAction: String, CaseIterable, Sendable, CustomTestStringConvertible {
  case model = "model"
  case mode = "tryb"
  case restart = "restart"
  case diff = "diff"
  case diffFiles = "lista zmian"
  case diffFile = "patch pliku"
  case models = "lista modeli"
  case create = "nowa sesja"
  case close = "zamknięcie"
  case recent = "ostatnie projekty"
  case send = "wysyłka"
  case decision = "decyzja"
  case answer = "odpowiedź na pytanie"
  case dialog = "decyzja o dialogu w panelu"
  case resume = "„Wznów”"
  case interrupt = "przerwanie"
  case launch = "start z formularza"
  case directory = "katalog formularza"
  case resumable = "rozmowy do wznowienia"
  case upload = "zdjęcie do miniatury"
  case voice = "klucz dyktowania"
  case makeDirectory = "new directory in the form"

  var testDescription: String { rawValue }

  /// Sesja `s1` taka, przy której akcja w ogóle wysyła żądanie (bramki magazynu przed siecią).
  var scenario: (state: String, extra: String, permission: Bool, question: Bool) {
    let controls = #","herdrMode":"auto","cliUpdate":{"running":"2.1.280","installed":"2.1.283"}"#
    switch self {
    // Karta „dialog w terminalu": sesja czeka, a karty z treścią nie ma.
    case .dialog: return ("waiting-permission", "", false, false)
    // Stop: tura trwa i nic nie blokuje pola.
    case .interrupt: return ("running", "", false, false)
    case .resume: return ("resumable", "", false, false)
    case .answer: return ("waiting-input", controls, true, true)
    default: return ("waiting-input", controls, true, false)
    }
  }

  @MainActor
  func run(_ store: RarogStore) async {
    switch self {
    case .model: _ = await store.setModel("s1", model: "opus", effort: nil)
    case .mode: _ = await store.toggleMode("s1")
    case .restart: _ = await store.restartCli("s1")
    case .diff: _ = await store.sessionDiff("s1")
    case .diffFiles: _ = await store.sessionDiffFiles("s1")
    case .diffFile: _ = await store.sessionDiffFile("s1", path: "a.ts")
    case .models: _ = await store.loadModels()
    case .create: _ = await store.createSession(in: "/x", defaults: NewSessionDefaults())
    case .close: _ = await store.closeSession("s1")
    case .recent: await store.refreshRecentProjects(force: true)
    case .send: _ = await store.send(text: "cześć", to: "s1")
    case .decision: _ = await store.decidePermission(sessionId: "s1", permId: "p1", decision: .allow)
    case .answer: _ = await store.answerQuestion(sessionId: "s1", qId: "q1", answers: [["A"]])
    case .dialog:
      // Bez karty dialogu (podpisu) akcja nie wychodzi, a test czeka na żądanie w drodze i padnie.
      if let seen = store.state.herdrDialogSignature(for: "s1") {
        _ = await store.decideDialog(sessionId: "s1", decision: .deny, seen: seen)
      }
    case .resume: _ = await store.resumeSession("s1")
    case .interrupt: _ = await store.interrupt("s1")
    case .launch: _ = await store.launchSession(CreateSessionBody(cwd: "/x"))
    case .directory: _ = await store.listDirectory(nil)
    case .resumable: _ = await store.resumableSessions(cwd: "/x")
    case .upload: _ = await store.uploadImage(sessionId: "s1", file: "1790000000000-0123456789abcdef.png")
    case .voice: _ = await store.mintVoiceToken()
    case .makeDirectory: _ = await store.createDirectory(parent: "/x", name: "new")
    }
  }
}

/// Atrapa: wybrana akcja wisi na „sieci" do `release()` i kończy się 401. Odpowiedź jest już na drucie:
/// anulowanie zadania przy wylogowaniu jej nie zatrzymuje (wyścig z `URLSession`), dochodzi dopiero po
/// `release()`. Reszta z `FakeTransport` (także przez `ForwardingProbe`).
final class LateAuthProbe: RarogTransporting, @unchecked Sendable {
  private struct State {
    var held: LateAction?
    var inFlight = false
    var released = false
    var waiter: CheckedContinuation<Void, Never>?
  }

  let base = FakeTransport()
  private let state = Mutex(State())

  init(holding action: LateAction) {
    state.withLock { $0.held = action }
  }

  var inFlight: Bool { state.withLock { $0.inFlight } }

  func release() {
    let waiter = state.withLock { state -> CheckedContinuation<Void, Never>? in
      state.released = true
      defer { state.waiter = nil }
      return state.waiter
    }
    waiter?.resume()
  }

  /// Wstrzymana akcja (jedna z `actions`): czeka na `release()`, potem 401.
  private func answer(_ actions: LateAction...) async throws(TransportError) {
    let held = state.withLock { state -> Bool in
      guard let held = state.held, actions.contains(held) else { return false }
      state.inFlight = true
      return true
    }
    guard held else { return }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let now = state.withLock { state -> Bool in
        if state.released { return true }
        state.waiter = continuation
        return false
      }
      if now { continuation.resume() }
    }
    throw .unauthorized(APIFailure(status: 401, code: "unauthorized"))
  }

  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws(TransportError) -> T {
    do {
      return try JSONDecoder().decode(type, from: Data(json.utf8))
    } catch {
      throw .invalidResponse("atrapa: \(error)")
    }
  }

  var hasCredential: Bool { base.hasCredential }

  func version() async throws(TransportError) -> VersionInfo { try await base.version() }
  func usage() async throws(TransportError) -> PlanUsage { try await base.usage() }

  func sendMessage(
    sessionId: String, _ upload: MessageUpload, timeout: Duration?, progress: (@Sendable (UploadProgress) -> Void)?
  ) async throws(TransportError) -> MessageAccepted? {
    try await answer(.send)
    return try await base.sendMessage(sessionId: sessionId, upload, timeout: timeout, progress: progress)
  }

  func decidePermission(sessionId: String, permId: String, _ body: PermissionDecisionBody) async throws(TransportError) {
    try await answer(.decision)
    try await base.decidePermission(sessionId: sessionId, permId: permId, body)
  }

  func presence(_ body: PresenceBody) async throws(TransportError) { try await base.presence(body) }
  func clientLog(_ body: ClientLogBody) async throws(TransportError) { try await base.clientLog(body) }

  func openStream(
    _ scope: StreamScope, lastEventId: String?, watch: StreamStallGuard
  ) async throws(TransportError) -> AsyncThrowingStream<SSEParser.Output, any Error> {
    try await base.openStream(scope, lastEventId: lastEventId, watch: watch)
  }

  func recentProjects() async throws(TransportError) -> RecentProjectList {
    try await answer(.recent)
    return try decode(RecentProjectList.self, #"{"projects":[]}"#)
  }

  func createSession(_ body: CreateSessionBody) async throws(TransportError) -> CreateSessionResponse {
    try await answer(.create, .launch)
    return try await base.createSession(body)
  }

  func closeSession(sessionId: String, _ body: CloseSessionBody) async throws(TransportError) {
    try await answer(.close)
    try await base.closeSession(sessionId: sessionId, body)
  }

  func models() async throws(TransportError) -> ModelList {
    try await answer(.models)
    return ModelList(models: [])
  }

  func setSessionModel(sessionId: String, _ body: SessionModelBody) async throws(TransportError) -> SessionModelAccepted {
    try await answer(.model)
    return try decode(SessionModelAccepted.self, #"{"ok":true}"#)
  }

  func setSessionMode(sessionId: String, _ body: SessionModeBody) async throws(TransportError) {
    try await answer(.mode)
  }

  func restartSession(sessionId: String, resend: SessionPromptBlocked?) async throws(TransportError) -> RestartResponse {
    try await answer(.restart)
    return try decode(RestartResponse.self, #"{"sessionId":"\#(sessionId)"}"#)
  }

  func sessionDiff(sessionId: String) async throws(TransportError) -> SessionDiff {
    try await answer(.diff)
    return SessionDiff(files: [], patch: "", truncated: false)
  }

  func sessionDiffFiles(sessionId: String) async throws(TransportError) -> DiffFileList {
    try await answer(.diffFiles)
    return DiffFileList(files: [], truncated: false)
  }

  func sessionDiffFile(sessionId: String, path: String) async throws(TransportError) -> DiffFilePatch {
    try await answer(.diffFile)
    return DiffFilePatch(path: path, patch: "", truncated: false)
  }

  // Trasy akcji z własnym odcięciem wyniku: wstrzymana tylko akcja testu, reszta idzie do atrapy bazowej.

  func answerQuestion(sessionId: String, qId: String, _ body: AnswersBody) async throws(TransportError) {
    try await answer(.answer)
    try await base.answerQuestion(sessionId: sessionId, qId: qId, body)
  }

  func decideDialog(sessionId: String, _ body: PermissionDecisionBody) async throws(TransportError) {
    try await answer(.dialog)
    try await base.decideDialog(sessionId: sessionId, body)
  }

  func resumeSession(sessionId: String) async throws(TransportError) -> ResumeResponse {
    try await answer(.resume)
    return try await base.resumeSession(sessionId: sessionId)
  }

  func interruptSession(sessionId: String) async throws(TransportError) -> InterruptResponse {
    try await answer(.interrupt)
    return try decode(InterruptResponse.self, #"{"ok":true}"#)
  }

  func directory(_ path: String?) async throws(TransportError) -> DirListing {
    try await answer(.directory)
    return DirListing(path: nil, parent: nil, entries: [])
  }

  func resumable(cwd: String) async throws(TransportError) -> ResumableList {
    try await answer(.resumable)
    return try decode(ResumableList.self, #"{"sessions":[]}"#)
  }

  func uploadImage(sessionId: String, file: String) async throws(TransportError) -> Data {
    try await answer(.upload)
    return try await base.uploadImage(sessionId: sessionId, file: file)
  }

  func voiceToken() async throws(TransportError) -> VoiceToken {
    try await answer(.voice)
    return try await base.voiceToken()
  }

  func makeDirectory(_ body: MakeDirBody) async throws(TransportError) -> DirEntry {
    try await answer(.makeDirectory)
    return DirEntry(name: body.name, path: "\(body.parent)/\(body.name)")
  }
}

@MainActor
@Suite("magazyn: spóźnione 401 akcji po ponownym logowaniu")
struct StoreLoginGenerationTests {
  /// Zalogowany magazyn z sesją `s1` po `hello`. Domyślnie gotowa na wiadomość, nowszy CLI, tryb auto,
  /// karta zgody `p1` w transkrypcie; akcje z własnym odcięciem wyniku dostają stan, przy którym w ogóle wysyłają
  /// żądanie (`LateAction.scenario`).
  private func loggedIn(_ probe: LateAuthProbe, for action: LateAction) async -> RarogStore {
    let rules = MutationRules(timing: fastTiming)
    probe.base.gate = MutationGate(policy: rules)
    let store = RarogStore(transport: probe, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
    await store.start()
    await until("online") { store.state.global == .online }
    let scenario = action.scenario
    let summary = Frames.summary("s1", state: scenario.state, extra: scenario.extra)
    probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    probe.base.push(.global, json: #"""
      {"type":"sessions-snapshot","sessions":[\#(summary)],
      "herdrStatus":{"available":true,"agentCount":1,"readOnly":false,"canLaunch":true}}
      """#)
    await until("lista") { store.state.sessionsLoaded && store.state.compat == .ok }
    store.openSession("s1")
    await until("strumień sesji") { probe.base.streamCalls.contains { $0.scope == .session(id: "s1") } }
    let card = scenario.permission ? Frames.permission("s1", permId: "p1") : ""
    let question = scenario.question ? #"""
      {"qId":"q1","sessionId":"s1","createdAt":"2026-10-03T08:00:00.000Z",
       "questions":[{"question":"Jak?","header":"Zapis","multiSelect":false,"options":[{"label":"A"},{"label":"B"}]}]}
      """# : ""
    probe.base.push(.session(id: "s1"), json: #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[],"pendingPermissions":[\#(card)],
       "pendingQuestions":[\#(question)]}
      """#)
    await until("transkrypt") { store.state.transcripts["s1"]?.snapshots == 1 }
    return store
  }

  @Test("401 sprzed ponownego zalogowania: stan zalogowany", arguments: LateAction.allCases)
  func lateUnauthorizedKeepsLogin(_ action: LateAction) async throws {
    let probe = LateAuthProbe(holding: action)
    let store = await loggedIn(probe, for: action)
    let pending = Task { await action.run(store) }
    await until("żądanie w drodze") { probe.inFlight }
    // Strumień dostaje 401, apka loguje się od nowa (ponowienie klucza), a dopiero potem dochodzi
    // odmowa żądania wysłanego w poprzednim zalogowaniu.
    probe.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    store.enterLoggedIn()
    probe.release()
    _ = await pending.value
    #expect(store.state.auth == .loggedIn, "stare 401 nie wylogowuje nowego logowania")
  }

  /// Wiersz aktualizacji serwera: wylogowanie zdejmuje go od razu, a sonda sprzed wylogowania, która dochodzi
  /// po nowym logowaniu, nie przywraca wersji starego połączenia.
  @Test("sonda wersji sprzed wylogowania nie przywraca wersji serwera ani wiersza aktualizacji")
  func lateVersionDoesNotRestoreServerVersion() async throws {
    let transport = ProbeTransport()
    transport.set { $0.version = .success(serverVersionInfo("0.0.1")) }
    let store = makeProbeStore(transport, timing: UsageTiming(refresh: .seconds(60), retry: .seconds(60), floor: .zero))
    await store.start()
    await connected(store, transport)
    await until("wiersz aktualizacji") { store.state.serverUpdate?.server == "0.0.1" }
    transport.set {
      $0.hold = true
      $0.holdIgnoresCancel = true
      $0.version = .success(serverVersionInfo("0.0.2"))
    }
    let before = transport.versionCalls
    transport.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    await until("sonda w drodze") { transport.versionCalls == before + 1 }
    transport.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    #expect(store.state.serverVersion == nil && store.state.serverUpdate == nil, "wylogowanie zdejmuje wiersz od razu")
    transport.set {
      $0.hold = false
      $0.version = .success(serverVersionInfo(ServerRelease.version))
    }
    store.enterLoggedIn()
    await connected(store, transport)
    await until("sonda nowego logowania") { store.state.serverVersion == ServerRelease.version }
    transport.release()
    try await Task.sleep(for: .milliseconds(80))
    #expect(store.state.serverVersion == ServerRelease.version, "stara wersja nie wraca")
    #expect(store.state.serverUpdate == nil)
  }

  @Test(
    "401 w tym samym zalogowaniu nadal wylogowuje",
    arguments: [LateAction.model, .close, .send, .answer, .dialog, .interrupt, .upload, .voice, .makeDirectory])
  func currentUnauthorizedLogsOut(_ action: LateAction) async throws {
    let probe = LateAuthProbe(holding: action)
    let store = await loggedIn(probe, for: action)
    let pending = Task { await action.run(store) }
    await until("żądanie w drodze") { probe.inFlight }
    probe.release()
    _ = await pending.value
    #expect(store.state.auth == .loggedOut(.deviceUnknown))
  }
}
