import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

// Sterowanie żywą sesją z nagłówka: model i effort, tryb, restart na
// nowszym CLI, diff — reduktor, selektory i akcje magazynu.
// Właściciel: nagłówek.

/// Atrapa z kontrolą tras sterowania sesją; strumienie i reszta mutacji z `FakeTransport`.
/// Mutacje przechodzą przez bramkę atrapy bazowej — jak w `RarogClient`.
final class SessionProbe: RarogTransporting, @unchecked Sendable {
  struct Calls {
    var models = 0
    var model: [(sessionId: String, body: SessionModelBody)] = []
    var mode: [(sessionId: String, body: SessionModeBody)] = []
    var restarts: [String] = []
    /// Ciało `resend` każdego restartu, w kolejności (`nil` = pigułka „↑”).
    var resends: [SessionPromptBlocked?] = []
    var diffs: [String] = []
    var modelsResult: Result<ModelList, TransportError> = .success(ModelList(models: []))
    var mutationError: TransportError?
    var diffResult: Result<SessionDiff, TransportError> = .success(SessionDiff(files: [], patch: "", truncated: false))
    var diffLists: [String] = []
    var diffFiles: [(sessionId: String, path: String)] = []
    var diffListResult: Result<DiffFileList, TransportError> = .success(DiffFileList(files: [], truncated: false))
    var diffFileResult: Result<DiffFilePatch, TransportError> = .success(DiffFilePatch(path: "", patch: "", truncated: false))
    /// Wstrzymuje restart w trakcie żądania (drugi tap w tym oknie).
    var onRestart: (@Sendable () async -> Void)?
    /// Przebieg N-tego żądania trybu (od zera): może je wstrzymać i zwrócić własny błąd.
    var onMode: (@Sendable (Int) async -> TransportError?)?
    /// Run of the N-th model request (from zero): it can hold it and return its own error.
    var onModel: (@Sendable (Int) async -> TransportError?)?
  }

  let base: FakeTransport
  let calls = Mutex(Calls())

  init(base: FakeTransport = FakeTransport()) {
    self.base = base
  }

  func set(_ change: (inout Calls) -> Void) { calls.withLock { change(&$0) } }
  func read<T>(_ value: (Calls) -> T) -> T { calls.withLock { value($0) } }

  private func gate(_ path: String) async throws(TransportError) {
    guard let gate = base.gate else { return }
    do {
      try await gate.check(method: "POST", path: path)
    } catch {
      throw .refused(error)
    }
  }

  func models() async throws(TransportError) -> ModelList {
    let result = calls.withLock { state in
      state.models += 1
      return state.modelsResult
    }
    return try result.get()
  }

  func setSessionModel(sessionId: String, _ body: SessionModelBody) async throws(TransportError) -> SessionModelAccepted {
    try await gate("/api/sessions/\(sessionId)/model")
    let (error, index, hook) = calls.withLock { state in
      state.model.append((sessionId, body))
      return (state.mutationError, state.model.count - 1, state.onModel)
    }
    if let late = await hook?(index) { throw late }
    if let error { throw error }
    do {
      return try JSONDecoder().decode(SessionModelAccepted.self, from: Data(#"{"ok":true,"warning":"w"}"#.utf8))
    } catch {
      throw .invalidResponse("atrapa: \(error)")
    }
  }

  func setSessionMode(sessionId: String, _ body: SessionModeBody) async throws(TransportError) {
    try await gate("/api/sessions/\(sessionId)/mode")
    let (error, index, hook) = calls.withLock { state in
      state.mode.append((sessionId, body))
      return (state.mutationError, state.mode.count - 1, state.onMode)
    }
    if let late = await hook?(index) { throw late }
    if let error { throw error }
  }

  func restartSession(sessionId: String, resend: SessionPromptBlocked?) async throws(TransportError) -> RestartResponse {
    try await gate("/api/sessions/\(sessionId)/restart")
    let (error, hook) = calls.withLock { state in
      state.restarts.append(sessionId)
      state.resends.append(resend)
      return (state.mutationError, state.onRestart)
    }
    await hook?()
    if let error { throw error }
    do {
      return try JSONDecoder().decode(RestartResponse.self, from: Data(#"{"sessionId":"\#(sessionId)"}"#.utf8))
    } catch {
      throw .invalidResponse("atrapa: \(error)")
    }
  }

  func sessionDiff(sessionId: String) async throws(TransportError) -> SessionDiff {
    let result = calls.withLock { state in
      state.diffs.append(sessionId)
      return state.diffResult
    }
    return try result.get()
  }

  func sessionDiffFiles(sessionId: String) async throws(TransportError) -> DiffFileList {
    let result = calls.withLock { state in
      state.diffLists.append(sessionId)
      return state.diffListResult
    }
    return try result.get()
  }

  func sessionDiffFile(sessionId: String, path: String) async throws(TransportError) -> DiffFilePatch {
    let result = calls.withLock { state in
      state.diffFiles.append((sessionId, path))
      return state.diffFileResult
    }
    return try result.get()
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
}

// Atrapa limitów (`StoreUsageTests`) też musi znać trasy sterowania — nieużywane tam.
extension ProbeTransport {
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

/// Magazyn z atrapą sterowania, zalogowany, z jedną sesją `s1` na liście.
@MainActor
private func sessionStore(_ summary: String) async throws -> (RarogStore, SessionProbe) {
  let probe = SessionProbe()
  let rules = MutationRules(timing: fastTiming)
  probe.base.gate = MutationGate(policy: rules)
  let store = RarogStore(transport: probe, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
  await store.start()
  await until("online") { store.state.global == .online }
  probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
  probe.base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(summary)]}"#)
  await until("lista") { store.state.sessionsLoaded }
  return (store, probe)
}

/// The list brings `s1` with `extra` and the model change in flight ends on it.
@MainActor
private func confirm(_ store: RarogStore, _ probe: SessionProbe, _ extra: String) async throws {
  probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input", extra: extra))}"#)
  await until("the target on the list") { !store.state.modelChangeInFlight("s1", now: Date()) }
}

@Suite("reduktor i selektory: sterowanie sesją")
struct ReducerSessionTests {
  private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

  private func state(_ summaries: [String], herdr: String = "") throws -> AppState {
    var state = AppState(clientBuild: 1)
    state.apply(.frame(try Frames.snapshot(summaries, extra: herdr), source: .global, cursor: nil), now: t0)
    return state
  }

  @Test("cel pigułki trybu: plan ↔ auto, manual → plan; bypass, nieznany i brak — bez celu")
  func toggleTarget() {
    #expect(ModeCycleTarget.toggle(from: .plan) == .auto)
    #expect(ModeCycleTarget.toggle(from: .auto) == .plan)
    #expect(ModeCycleTarget.toggle(from: .manual) == .plan)
    #expect(ModeCycleTarget.toggle(from: .bypass) == nil)
    #expect(ModeCycleTarget.toggle(from: .unknown) == nil)
    #expect(ModeCycleTarget.toggle(from: nil) == nil)
  }

  @Test("blokada modelu: tura, start i decyzja zajęte; kanał przed stanem; done i gotowe wolne")
  func modelBlock() throws {
    let summaries = [
      Frames.summary("ready", state: "waiting-input"),
      Frames.summary("run", state: "running"),
      Frames.summary("ask", state: "waiting-permission"),
      Frames.summary("start", state: "starting"),
      Frames.summary("done", state: "done"),
      Frames.summary("codex", state: "running", extra: #","engine":"codex""#),
      Frames.summary("far", state: "waiting-input", extra: #","outOfScope":true"#),
      Frames.summary("odd", state: "nowy-stan"),
    ]
    let state = try state(summaries)
    #expect(state.modelChangeBlock(for: "ready") == nil)
    #expect(state.modelChangeBlock(for: "done") == nil)
    #expect(state.modelChangeBlock(for: "run") == .busy)
    #expect(state.modelChangeBlock(for: "ask") == .busy)
    #expect(state.modelChangeBlock(for: "start") == .busy)
    #expect(state.modelChangeBlock(for: "codex") == .codex, "silnik przed turą")
    #expect(state.modelChangeBlock(for: "far") == .outOfScope)
    #expect(state.modelChangeBlock(for: "odd") == .unsupported)
    #expect(state.modelChangeBlock(for: "nie-ma") == .busy)

    let readOnly = try self.state(
      [Frames.summary("ready", state: "waiting-input")],
      herdr: #","herdrStatus":{"available":true,"agentCount":1,"readOnly":true,"canLaunch":false}"#)
    #expect(readOnly.modelChangeBlock(for: "ready") == .herdrReadOnly)
  }

  @Test("przełączenie w locie: do celu albo terminu; tryb pośredni go nie zwalnia; nowszy wpis przeżywa stary termin")
  func modeToggle() throws {
    var state = try state([Frames.summary("s1", state: "waiting-input", extra: #","herdrMode":"auto""#)])
    let until = t0.addingTimeInterval(8)
    state.apply(.session(.modeToggleStarted(sessionId: "s1", target: .plan, until: until)), now: t0)
    #expect(state.modeToggleInFlight("s1", now: t0))
    #expect(!state.modeToggleInFlight("s1", now: until), "termin minął")

    state.apply(.frame(try Frames.sessionChanged(
      Frames.summary("s1", state: "waiting-input", extra: #","herdrMode":"manual""#)), source: .global, cursor: nil), now: t0)
    #expect(state.modeToggleInFlight("s1", now: t0), "tryb pośredni nie jest celem")
    state.apply(.frame(try Frames.sessionChanged(
      Frames.summary("s1", state: "waiting-input", extra: #","herdrMode":"plan""#)), source: .global, cursor: nil), now: t0)
    #expect(!state.modeToggleInFlight("s1", now: t0), "cel osiągnięty")

    let later = until.addingTimeInterval(5)
    state.apply(.session(.modeToggleStarted(sessionId: "s1", target: .auto, until: later)), now: t0)
    state.apply(.session(.modeToggleExpired(sessionId: "s1", until: until)), now: t0)
    #expect(state.sessionControls.modeToggles["s1"]?.until == later, "wygasa tylko wpis z tym terminem")
    state.apply(.session(.modeToggleSettled(sessionId: "s1", until: until)), now: t0)
    #expect(state.sessionControls.modeToggles["s1"]?.until == later, "odmowa starszej próby nie zdejmuje nowszej")
    state.apply(.session(.modeToggleSettled(sessionId: "s1", until: later)), now: t0)
    #expect(state.sessionControls.modeToggles.isEmpty)
  }

  private func changed(_ extra: String) throws -> CoreEvent {
    .frame(try Frames.sessionChanged(Frames.summary("s1", state: "waiting-input", extra: extra)), source: .global,
           cursor: nil)
  }

  @Test("model change in flight: part of the target holds, the whole target releases, a later engine id does not return")
  func modelChangeLatch() throws {
    var state = try state([Frames.summary("s1", state: "waiting-input", extra: #","model":"fable","effort":"low""#)])
    let until = t0.addingTimeInterval(SessionControlTiming.modelChangeWait)
    let target = try #require(SessionModelBody(model: "opus[1m]", effort: .high))
    state.apply(.session(.modelChangeStarted(sessionId: "s1", target: target, until: until)), now: t0)
    #expect(state.modelChangeInFlight("s1", now: t0))
    #expect(state.modelChangeTarget("s1", now: t0) == target)
    #expect(!state.modelChangeInFlight("s1", now: until), "the deadline passed")

    state.apply(try changed(#","model":"opus[1m]","effort":"low""#), now: t0)
    #expect(state.modelChangeInFlight("s1", now: t0), "the model alone is part of the target")
    state.apply(try changed(#","model":"opus[1m]","effort":"high""#), now: t0)
    #expect(!state.modelChangeInFlight("s1", now: t0), "the whole target")
    #expect(state.sessionControls.modelChanges.isEmpty)
    state.apply(try changed(#","model":"claude-opus-5-5","effort":"high""#), now: t0)
    #expect(!state.modelChangeInFlight("s1", now: t0), "the engine id after the first turn does not bring it back")
  }

  @Test("model change in flight: `ultracode: false` needs false, nil does not confirm; other fields are not compared")
  func modelChangeUltracodeOff() throws {
    var state = try state([Frames.summary("s1", state: "waiting-input", extra: #","model":"opus[1m]","ultracode":true"#)])
    let until = t0.addingTimeInterval(SessionControlTiming.modelChangeWait)
    let target = try #require(SessionModelBody(model: nil, effort: nil, ultracode: false))
    state.apply(.session(.modelChangeStarted(sessionId: "s1", target: target, until: until)), now: t0)
    state.apply(try changed(#","model":"opus[1m]""#), now: t0)
    #expect(state.modelChangeInFlight("s1", now: t0), "nil is not false")
    state.apply(try changed(#","model":"fable","effort":"max","ultracode":false"#), now: t0)
    #expect(!state.modelChangeInFlight("s1", now: t0), "fields outside the target do not hold it")
  }

  @Test("model change in flight: expiry and refusal remove only their own attempt; a missing session keeps it")
  func modelChangeOwnAttempt() throws {
    var state = try state([Frames.summary("s1", state: "waiting-input", extra: #","model":"fable""#)])
    let until = t0.addingTimeInterval(SessionControlTiming.modelChangeWait)
    let later = until.addingTimeInterval(5)
    let first = try #require(SessionModelBody(model: "opus[1m]", effort: nil))
    let second = try #require(SessionModelBody(model: "haiku", effort: nil))
    state.apply(.session(.modelChangeStarted(sessionId: "s1", target: first, until: until)), now: t0)
    state.apply(.frame(try Frames.snapshot([]), source: .global, cursor: nil), now: t0)
    #expect(state.modelChangeInFlight("s1", now: t0), "a session missing from the list waits for the deadline")

    state.apply(.session(.modelChangeStarted(sessionId: "s1", target: second, until: later)), now: t0)
    state.apply(.session(.modelChangeExpired(sessionId: "s1", until: until)), now: t0)
    #expect(state.sessionControls.modelChanges["s1"]?.until == later, "only the entry with this deadline expires")
    state.apply(.session(.modelChangeSettled(sessionId: "s1", until: until)), now: t0)
    #expect(state.sessionControls.modelChanges["s1"]?.until == later, "a late refusal of the older attempt")
    state.apply(.session(.modelChangeSettled(sessionId: "s1", until: later)), now: t0)
    #expect(state.sessionControls.modelChanges.isEmpty)

    state.apply(.session(.modelChangeStarted(sessionId: "s1", target: second, until: later)), now: t0)
    state.apply(.session(.modelChangeExpired(sessionId: "s1", until: later)), now: later)
    #expect(state.sessionControls.modelChanges.isEmpty, "the deadline removes it")
  }
}

@MainActor
@Suite("magazyn: model, tryb, restart i diff sesji")
struct StoreSessionTests {
  @Test("model: różnica jednym żądaniem; odmowa serwera wraca jego zdaniem; tura blokuje bez żądania")
  func setModel() async throws {
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input"))
    #expect(await store.setModel("s1", model: "opus[1m]", effort: .xhigh) == .accepted)
    #expect(probe.read { $0.model.map(\.body) } == [SessionModelBody(model: "opus[1m]", effort: .xhigh)])
    // The list brings the whole target, so the next change may go out.
    try await confirm(store, probe, #","model":"opus[1m]","effort":"xhigh""#)

    let busy = APIFailure(status: 409, code: "bad-state", message: "Agent pracuje albo czeka na decyzję — zmień model, gdy skończy turę.")
    probe.set { $0.mutationError = .http(busy) }
    #expect(await store.setModel("s1", model: nil, effort: .low) == .refused(busy.message))
    #expect(await store.setModel("s1", model: nil, effort: nil) == .notAllowed, "pusta różnica nie wychodzi")

    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "running"))}"#)
    await until("tura") { store.state.sessions["s1"]?.state == .running }
    #expect(await store.setModel("s1", model: "fable", effort: nil) == .notAllowed)
    #expect(probe.read { $0.model.count } == 2)
  }

  @Test("model: ultracode w tym samym żądaniu; false to zmiana, nil nie")
  func setUltracode() async throws {
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input"))
    #expect(await store.setModel("s1", model: nil, effort: nil, ultracode: false) == .accepted, "samo wyłączenie wychodzi")
    try await confirm(store, probe, #","ultracode":false"#)
    #expect(await store.setModel("s1", model: "fable", effort: nil, ultracode: true) == .accepted)
    #expect(await store.setModel("s1", model: nil, effort: nil, ultracode: nil) == .notAllowed, "pusta różnica nie wychodzi")
    #expect(probe.read { $0.model.map(\.body) } == [
      SessionModelBody(model: nil, effort: nil, ultracode: false), SessionModelBody(model: "fable", effort: nil, ultracode: true),
    ])
  }

  @Test("lista modeli ze złotego `rest/models.json` wraca przetłumaczona: `Model domyślny konta`")
  func modelsTranslated() async throws {
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input"))
    let url = GoldenFrames.shared.repoRoot.appending(path: "shared/fixtures/rest/models.json")
    let list = try JSONDecoder().decode(ModelList.self, from: Data(contentsOf: url))
    #expect(list.models.first?.label == "Account Default Model", "złoty plik po angielsku")
    probe.set { $0.modelsResult = .success(list) }
    let models = try #require(await store.loadModels())
    #expect(models.first?.label == "Model domyślny konta")
    #expect(models.first?.description == "Bez flagi --model: dokładnie to, co masz ustawione w Claude Code.")
    #expect(models.first?.labelRef == SentenceRef(code: "model.default-label"))
    #expect(store.state.sessionControls.models?.first?.label == "Model domyślny konta", "pamięć arkusza też po polsku")
    #expect(models.dropFirst().first?.label == "Fable", "nazwa modelu bez `ref` bez zmian")
  }

  @Test("lista modeli: odpowiedź do pamięci; porażka zostawia ostatnią znaną")
  func models() async throws {
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input"))
    let fable = ModelChoice(value: "fable", label: "Fable", effortLevels: [.high])
    probe.set { $0.modelsResult = .success(ModelList(models: [fable])) }
    #expect(await store.loadModels() == [fable])
    #expect(store.state.sessionControls.models == [fable])
    probe.set { $0.modelsResult = .failure(.offline(.notConnectedToInternet)) }
    #expect(await store.loadModels() == [fable])
  }

  @Test("model: the in-flight entry stands before the request; a second Apply sends nothing; a refusal removes it")
  func setModelInFlight() async throws {
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input", extra: #","model":"fable""#))
    // The request passes only when the entry already stands; otherwise it fails with a time-out.
    probe.set { calls in
      calls.onModel = { _ in
        let inFlight = await MainActor.run { store.state.modelChangeInFlight("s1", now: Date()) }
        return inFlight ? nil : .timedOut
      }
    }
    #expect(await store.setModel("s1", model: "opus[1m]", effort: .high, ultracode: false) == .accepted,
            "the entry stands before the request")
    probe.set { $0.onModel = nil }
    #expect(store.state.modelChangeTarget("s1", now: Date())
      == SessionModelBody(model: "opus[1m]", effort: .high, ultracode: false), "the target is the sent body")
    #expect(await store.setModel("s1", model: "haiku", effort: nil) == .inFlight)
    #expect(probe.read { $0.model.count } == 1)

    try await confirm(store, probe, #","model":"opus[1m]","effort":"high","ultracode":false"#)
    let busy = APIFailure(status: 409, code: "bad-state", message: "Agent pracuje.")
    probe.set { $0.mutationError = .http(busy) }
    #expect(await store.setModel("s1", model: "haiku", effort: nil) == .refused(busy.message))
    #expect(store.state.sessionControls.modelChanges["s1"] == nil, "a refusal removes the entry at once")
    probe.set { $0.mutationError = .offline(.notConnectedToInternet) }
    #expect(await store.setModel("s1", model: "haiku", effort: nil) == .offline)
    #expect(store.state.sessionControls.modelChanges["s1"] == nil, "offline too")
  }

  /// Race: request A runs long, the list brings A's target, the human applies B, then A fails late. Removing the entry
  /// by session alone would drop B's spinner and let a third Apply queue up behind B.
  @Test("model: a late refusal of the older attempt does not remove the newer one")
  func lateModelRefusalKeepsNewer() async throws {
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input", extra: #","model":"fable""#))
    let gate = AsyncStream<Void>.makeStream()
    probe.set { calls in
      calls.onModel = { index in
        guard index == 0 else { return nil }
        for await _ in gate.stream { break }
        return .timedOut
      }
    }
    let first = Task { await store.setModel("s1", model: "opus[1m]", effort: nil) }
    await until("A in flight") { probe.read { $0.model.count } == 1 }
    try await confirm(store, probe, #","model":"opus[1m]""#)
    #expect(await store.setModel("s1", model: "haiku", effort: nil) == .accepted, "B")

    gate.continuation.yield()
    #expect(await first.value == .timedOut)
    #expect(store.state.modelChangeInFlight("s1", now: Date()), "A's refusal does not remove B")
    #expect(store.state.modelChangeTarget("s1", now: Date())?.model == "haiku")
    #expect(await store.setModel("s1", model: "fable", effort: nil) == .inFlight)
    #expect(probe.read { $0.model.count } == 2)
  }

  @Test("tryb: wpis w locie przed żądaniem, drugi tap nic nie wysyła; odmowa zdejmuje wpis; bypass bez żądania")
  func toggleMode() async throws {
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input", extra: #","herdrMode":"auto""#))
    #expect(await store.toggleMode("s1") == .accepted)
    #expect(probe.read { $0.mode.map(\.body.mode) } == [.plan])
    #expect(store.state.modeToggleInFlight("s1", now: Date()))
    #expect(await store.toggleMode("s1") == .inFlight)
    #expect(probe.read { $0.mode.count } == 1)

    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input", extra: #","herdrMode":"plan""#))}"#)
    await until("cel z listy") { store.state.sessions["s1"]?.herdrMode == .plan }
    #expect(!store.state.modeToggleInFlight("s1", now: Date()))

    let busy = APIFailure(status: 409, code: "bad-state", message: "Agent pracuje albo czeka na decyzję — zmień tryb, gdy skończy turę.")
    probe.set { $0.mutationError = .http(busy) }
    #expect(await store.toggleMode("s1") == .refused(busy.message))
    #expect(probe.read { $0.mode.last?.body.mode } == .auto)
    #expect(store.state.sessionControls.modeToggles["s1"] == nil, "odmowa oddaje pigułkę od razu")

    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input", extra: #","herdrMode":"bypass""#))}"#)
    await until("bypass") { store.state.sessions["s1"]?.herdrMode == .bypass }
    #expect(await store.toggleMode("s1") == .notAllowed)
    #expect(probe.read { $0.mode.count } == 2)
  }

  /// Wyścig: POST A leci dłużej niż okno pigułki (limit żądania 10 s > 8 s),
  /// lista przynosi cel A, człowiek tapie B — spóźniona odmowa A zdejmowała blokadę B i trzeci tap
  /// ustawiał w kolejce panelu powrót.
  @Test("tryb: spóźniona odmowa starszej próby nie zdejmuje blokady nowszej")
  func lateRefusalKeepsNewerToggle() async throws {
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input", extra: #","herdrMode":"auto""#))
    let gate = AsyncStream<Void>.makeStream()
    probe.set { calls in
      calls.onMode = { index in
        guard index == 0 else { return nil }
        for await _ in gate.stream { break }
        return .timedOut
      }
    }
    let first = Task { await store.toggleMode("s1") }
    await until("A w locie") { probe.read { $0.mode.count } == 1 }
    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input", extra: #","herdrMode":"plan""#))}"#)
    await until("cel A z listy") { store.state.sessions["s1"]?.herdrMode == .plan }
    #expect(await store.toggleMode("s1") == .accepted, "B: plan → auto")
    #expect(probe.read { $0.mode.map(\.body.mode) } == [.plan, .auto])

    gate.continuation.yield()
    #expect(await first.value == .timedOut)
    #expect(store.state.modeToggleInFlight("s1", now: Date()), "odmowa A nie zdejmuje blokady B")
    #expect(await store.toggleMode("s1") == .inFlight)
    #expect(probe.read { $0.mode.count } == 2)
  }

  @Test("restart: tylko przy nowszym CLI, drugi tap w trakcie nic nie wysyła, odmowa serwera jego zdaniem")
  func restart() async throws {
    let update = #","cliUpdate":{"running":"2.1.280","installed":"2.1.283"}"#
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input", extra: update))
    let gate = AsyncStream<Void>.makeStream()
    probe.set { calls in
      calls.onRestart = {
        for await _ in gate.stream { return }
      }
    }
    let first = Task { await store.restartCli("s1") }
    await until("restart w locie") { store.state.sessionControls.restarting.contains("s1") }
    #expect(await store.restartCli("s1") == .inFlight)
    gate.continuation.yield()
    #expect(await first.value == .accepted)
    #expect(store.state.sessionControls.restarting.isEmpty)
    #expect(probe.read(\.restarts) == ["s1"])
    #expect(store.state.restartInProgress("s1"), "accepted: in progress until the list shows the end")
    #expect(await store.restartCli("s1") == .inFlight)
    let canceled = #","stateDetail":"x","stateDetailRef":{"code":"restart.exit-timeout"}"#
    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input", extra: update + canceled))}"#)
    await until("restart canceled") { !store.state.restartInProgress("s1") }

    let tasks = APIFailure(status: 409, code: "bad-state", message: "W tle działa zadanie — restart by je przerwał.")
    probe.set { $0.onRestart = nil; $0.mutationError = .http(tasks) }
    #expect(await store.restartCli("s1") == .refused(tasks.message))
    #expect(!store.state.restartInProgress("s1"), "a refusal gives the pill back")

    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input"))}"#)
    await until("aktualne CLI") { store.state.sessions["s1"]?.cliUpdate == nil }
    #expect(await store.restartCli("s1") == .notAllowed)
  }

  /// „Uruchom ponownie i wyślij” spod notki blokady — całe `promptBlocked` karty w ciele, ten sam stan
  /// `restarting` co pigułka „↑” (jeden restart sesji naraz), odmowa serwera jego zdaniem.
  @Test("restart z ponowną wysyłką: blokada karty w ciele, wspólny stan w locie z pigułką, odmowa jego zdaniem")
  func restartAndResend() async throws {
    let blockedJSON = #"{"seq":4,"id":"b-1"}"#
    let (store, probe) = try await sessionStore(
      Frames.summary("s1", state: "waiting-input", extra: #","promptBlocked":\#(blockedJSON)"#))
    let blocked = try #require(store.state.sessions["s1"]?.promptBlocked)
    let gate = AsyncStream<Void>.makeStream()
    probe.set { calls in
      calls.onRestart = {
        for await _ in gate.stream { return }
      }
    }
    let first = Task { await store.restartAndResend("s1", blocked: blocked) }
    await until("restart w locie") { store.state.sessionControls.restarting.contains("s1") }
    #expect(await store.restartAndResend("s1", blocked: blocked) == .inFlight, "drugie tapnięcie nic nie wysyła")
    gate.continuation.yield()
    #expect(await first.value == .accepted)
    #expect(store.state.sessionControls.restarting.isEmpty)
    #expect(probe.read(\.resends) == [blocked])
    let asked = #","stateDetail":"x","stateDetailRef":{"code":"restart.exit-asked"}"#
    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input", extra: #","promptBlocked":\#(blockedJSON)"# + asked))}"#)
    await until("restart canceled") { !store.state.restartInProgress("s1") }

    let stale = APIFailure(status: 409, code: "bad-state", message: "Ten prompt już nie czeka na ponowne wysłanie.")
    probe.set { $0.onRestart = nil; $0.mutationError = .http(stale) }
    #expect(await store.restartAndResend("s1", blocked: blocked) == .refused(stale.message))
    #expect(store.state.sessionControls.restarting.isEmpty, "odmowa oddaje przycisk")
    // Sama blokada nie daje restartu bez ponownej wysyłki: pigułki „↑” nie ma, a serwer odmówiłby bez `resend`.
    #expect(await store.restartCli("s1") == .notAllowed)
    #expect(probe.read(\.restarts).count == 2)

    // Nowa blokada na karcie (inny `id`): spóźnione tapnięcie spod starej notki nie wychodzi.
    let newer = #","promptBlocked":{"seq":4,"id":"b-2"}"#
    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input", extra: newer))}"#)
    await until("nowa blokada") { store.state.sessions["s1"]?.promptBlocked?.id == "b-2" }
    #expect(await store.restartAndResend("s1", blocked: blocked) == .notAllowed)
    #expect(probe.read(\.restarts).count == 2)
  }

  @Test("restart: bez nowszego CLI i bez blokady promptu nic nie wychodzi; z obiema pigułka wysyła puste ciało")
  func restartGates() async throws {
    let blocked = try JSONDecoder().decode(SessionPromptBlocked.self, from: Data(#"{"seq":2,"id":"b-9"}"#.utf8))
    let (bare, bareProbe) = try await sessionStore(Frames.summary("s1", state: "waiting-input"))
    #expect(await bare.restartCli("s1") == .notAllowed)
    #expect(await bare.restartAndResend("s1", blocked: blocked) == .notAllowed)
    #expect(await bare.restartAndResend("nie-ma", blocked: blocked) == .notAllowed)
    #expect(bareProbe.read(\.restarts).isEmpty)

    let both = #","cliUpdate":{"running":"2.1.280","installed":"2.1.283"},"promptBlocked":{"seq":2,"id":"b-9"}"#
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input", extra: both))
    #expect(await store.restartCli("s1") == .accepted)
    #expect(await store.restartAndResend("s1", blocked: blocked) == .inFlight, "one restart of a session at a time")
    let canceled = #","stateDetail":"x","stateDetailRef":{"code":"restart.exit-timeout"}"#
    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input", extra: both + canceled))}"#)
    await until("restart canceled") { !store.state.restartInProgress("s1") }
    #expect(await store.restartAndResend("s1", blocked: blocked) == .accepted)
    #expect(probe.read(\.resends) == [nil, blocked], "pigułka „↑” bez `resend`, przycisk notki z blokadą")
  }

  @Test("sesja nieobsługiwana: bramka klienta odmawia, nic nie wychodzi")
  func unsupportedGate() async throws {
    let update = #","cliUpdate":{"running":"2.1.280","installed":"2.1.283"}"#
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "nowy-stan", extra: update))
    guard case .refused = await store.restartCli("s1") else {
      Issue.record("bramka powinna odmówić")
      return
    }
    #expect(probe.read(\.restarts).isEmpty, "bramka odcina przed serwerem")
  }

  @Test("diff: odczyt, odmowa Codexa zdaniem serwera, sieć osobno")
  func diff() async throws {
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input"))
    let sample = SessionDiff(files: [DiffFile(path: "a.ts", status: .modified, linesAdded: 2, linesDeleted: 1)], patch: "p", truncated: false)
    probe.set { $0.diffResult = .success(sample) }
    #expect(await store.sessionDiff("s1") == .loaded(sample))
    probe.set { $0.diffResult = .failure(.http(APIFailure(status: 400, code: "bad-request", message: "Codex: bez diffa."))) }
    #expect(await store.sessionDiff("s1") == .refused("Codex: bez diffa."))
    probe.set { $0.diffResult = .failure(.offline(.notConnectedToInternet)) }
    #expect(await store.sessionDiff("s1") == .offline)
  }

  /// Okno diffa rozróżnia przypadki po statusie i kodzie odmowy, więc wynik niesie oba, nie samo zdanie.
  @Test("diff per plik, lista: odczyt; 405 starszego serwera i 400 ze statusem i kodem; sieć i limit czasu osobno")
  func diffFiles() async throws {
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input"))
    let sample = DiffFileList(
      files: [DiffListEntry(path: "a.ts", status: .modified, linesAdded: 2, linesDeleted: 1)], truncated: true)
    probe.set { $0.diffListResult = .success(sample) }
    #expect(await store.sessionDiffFiles("s1") == .loaded(sample))
    #expect(probe.read(\.diffLists) == ["s1"])
    probe.set {
      $0.diffListResult = .failure(.http(APIFailure(status: 405, code: "method-not-allowed", message: "Niedozwolona metoda.")))
    }
    let outdated = DiffRefusal(status: 405, code: "method-not-allowed", message: "Niedozwolona metoda.")
    #expect(await store.sessionDiffFiles("s1") == .refused(outdated))
    #expect(outdated.serverOutdated && !outdated.fileGone && !outdated.badPath)
    probe.set { $0.diffListResult = .failure(.http(APIFailure(status: 400, code: "bad-request", message: "Codex: bez diffa."))) }
    #expect(await store.sessionDiffFiles("s1") == .refused(DiffRefusal(status: 400, code: "bad-request", message: "Codex: bez diffa.")))
    probe.set { $0.diffListResult = .failure(.offline(.notConnectedToInternet)) }
    #expect(await store.sessionDiffFiles("s1") == .offline)
    probe.set { $0.diffListResult = .failure(.timedOut) }
    #expect(await store.sessionDiffFiles("s1") == .timedOut)
    probe.set { $0.diffListResult = .failure(.cancelled) }
    #expect(await store.sessionDiffFiles("s1") == .failed, "anulowane żądanie zamykanego okna")
    #expect(store.state.auth == .loggedIn)
  }

  @Test("diff per plik, patch: ścieżka dochodzi do transportu; 404 „lista się zmieniła”, 503 i 400 z kodem; sieć osobno")
  func diffFile() async throws {
    let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input"))
    let sample = DiffFilePatch(path: "src/a+b.ts", patch: "diff --git a/x b/x\n", truncated: false)
    probe.set { $0.diffFileResult = .success(sample) }
    #expect(await store.sessionDiffFile("s1", path: "src/a+b.ts") == .loaded(sample))
    #expect(probe.read(\.diffFiles).map(\.path) == ["src/a+b.ts"], "ścieżka bez zmian — koduje ją transport")
    func refusal(_ status: Int, _ code: String) async -> DiffRefusal? {
      probe.set { $0.diffFileResult = .failure(.http(APIFailure(status: status, code: code, message: "zdanie"))) }
      guard case let .refused(refusal) = await store.sessionDiffFile("s1", path: "a.ts") else { return nil }
      return refusal
    }
    let gone = await refusal(404, "diff-file-not-found")
    #expect(gone == DiffRefusal(status: 404, code: "diff-file-not-found", message: "zdanie") && gone?.fileGone == true)
    let noSession = await refusal(404, "session-not-found")
    #expect(noSession?.fileGone == false, "brak sesji to nie „lista się zmieniła”")
    let git = await refusal(503, "git-failed")
    #expect(git?.status == 503 && git?.code == "git-failed" && git?.serverOutdated == false)
    #expect(await refusal(400, "bad-path")?.badPath == true)
    probe.set { $0.diffFileResult = .failure(.offline(.networkConnectionLost)) }
    #expect(await store.sessionDiffFile("s1", path: "a.ts") == .offline)
  }

  @Test("diff per plik: 401 listy i 401 patcha wylogowują i mówią o tym wynikiem")
  func diffUnauthorized() async throws {
    for file in [false, true] {
      let (store, probe) = try await sessionStore(Frames.summary("s1", state: "waiting-input"))
      let expired = TransportError.unauthorized(APIFailure(status: 401, code: "unauthorized"))
      probe.set {
        $0.diffListResult = .failure(expired)
        $0.diffFileResult = .failure(expired)
      }
      if file {
        #expect(await store.sessionDiffFile("s1", path: "a.ts") == .loggedOut)
      } else {
        #expect(await store.sessionDiffFiles("s1") == .loggedOut)
      }
      #expect(store.state.auth != .loggedIn, "wygasłe logowanie kończy zalogowany interfejs")
    }
  }
}
