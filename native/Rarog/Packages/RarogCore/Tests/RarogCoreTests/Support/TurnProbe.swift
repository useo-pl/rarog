import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

// Atrapa tras przerwania, „obejrzane" i formularza nowej sesji. Strumienie,
// zakładanie sesji i reszta protokołu — z `FakeTransport`; trasy innych obszarów oddaje atrapie
// bazowej `ForwardingProbe`. Atrapa bazowa dostaje tu zgodność z trasami przerwania i nowej sesji. Właściciel: sterowanie sesją.

final class TurnProbe: RarogTransporting, @unchecked Sendable {
  struct Calls {
    var interrupts: [String] = []
    /// Kolejne odpowiedzi przerwania: ciało JSON albo błąd; pusta lista = `{"ok":true}`.
    var interruptResults: [Result<String, TransportError>] = []
    /// Przebieg N-tego żądania przerwania (od zera) — może je wstrzymać.
    var onInterrupt: (@Sendable (Int) async -> Void)?
    var seen: [String] = []
    var seenResult: TransportError?
    /// Ręczne „nieprzeczytane”.
    var unseen: [String] = []
    var unseenResult: TransportError?
    var directories: [String?] = []
    var directoryResult: Result<String, TransportError> =
      .success(#"{"path":null,"parent":null,"entries":[],"truncated":false}"#)
    var resumable: [(cwd: String, recent: Bool)] = []
    var resumableResult: Result<String, TransportError> = .success(#"{"sessions":[]}"#)
    /// Bodies of New Directory requests and the reply to each: a JSON row or an error.
    var made: [MakeDirBody] = []
    var makeResult: Result<String, TransportError> =
      .success(#"{"name":"new","path":"/r/new","git":false,"history":false}"#)

    /// Queue take-backs: session and `operationId` of every request, in order.
    var takeBacks: [(sessionId: String, operationId: UUID)] = []
    /// Successive take-back answers: a JSON body or an error; an empty list = `{"items":[]}`.
    var takeBackResults: [Result<String, TransportError>] = []
    /// Runs the N-th take-back request (from zero) before its answer; it may hold it.
    var onTakeBack: (@Sendable (Int) async -> Void)?
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

  private static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws(TransportError) -> T {
    do {
      return try JSONDecoder().decode(type, from: Data(json.utf8))
    } catch {
      throw .invalidResponse("atrapa: \(error)")
    }
  }

  // MARK: Przerwanie, obejrzane i nowa sesja

  func interruptSession(sessionId: String) async throws(TransportError) -> InterruptResponse {
    try await gate("/api/sessions/\(sessionId)/interrupt")
    let (index, result, hook) = calls.withLock { state in
      state.interrupts.append(sessionId)
      let result = state.interruptResults.isEmpty ? .success(#"{"ok":true}"#) : state.interruptResults.removeFirst()
      return (state.interrupts.count - 1, result, state.onInterrupt)
    }
    await hook?(index)
    return try Self.decode(InterruptResponse.self, try result.get())
  }

  func takeBackQueue(sessionId: String, operationId: UUID) async throws(TransportError) -> QueueTakeBackResponse {
    try await gate("/api/sessions/\(sessionId)/queue/take-back")
    let (index, result, hook) = calls.withLock { state in
      state.takeBacks.append((sessionId, operationId))
      let result = state.takeBackResults.isEmpty ? .success(#"{"items":[]}"#) : state.takeBackResults.removeFirst()
      return (state.takeBacks.count - 1, result, state.onTakeBack)
    }
    await hook?(index)
    return try Self.decode(QueueTakeBackResponse.self, try result.get())
  }

  func markSeen(sessionId: String) async throws(TransportError) {
    try await gate("/api/sessions/\(sessionId)/seen")
    let error = calls.withLock { state in
      state.seen.append(sessionId)
      return state.seenResult
    }
    if let error { throw error }
  }

  func markUnseen(sessionId: String) async throws(TransportError) {
    try await gate("/api/sessions/\(sessionId)/unseen")
    let error = calls.withLock { state in
      state.unseen.append(sessionId)
      return state.unseenResult
    }
    if let error { throw error }
  }

  func directory(_ path: String?) async throws(TransportError) -> DirListing {
    let result = calls.withLock { state in
      state.directories.append(path)
      return state.directoryResult
    }
    return try Self.decode(DirListing.self, try result.get())
  }

  func resumable(cwd: String) async throws(TransportError) -> ResumableList {
    let result = calls.withLock { state in
      state.resumable.append((cwd, false))
      return state.resumableResult
    }
    return try Self.decode(ResumableList.self, try result.get())
  }

  func recentResumable(cwd: String) async throws(TransportError) -> ResumableList {
    let result = calls.withLock { state in
      state.resumable.append((cwd, true))
      return state.resumableResult
    }
    return try Self.decode(ResumableList.self, try result.get())
  }

  func makeDirectory(_ body: MakeDirBody) async throws(TransportError) -> DirEntry {
    try await gate("/api/fs/mkdir")
    let result = calls.withLock { state in
      state.made.append(body)
      return state.makeResult
    }
    return try Self.decode(DirEntry.self, try result.get())
  }

  // MARK: Reszta protokołu — atrapa bazowa

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

/// Magazyn z atrapą przerwania i nowej sesji, zalogowany, ze strumieniem globalnym i podanymi sesjami na liście.
@MainActor
func turnStore(_ summaries: [String], herdr: String = "") async throws -> (RarogStore, TurnProbe) {
  let probe = TurnProbe()
  let rules = MutationRules(timing: fastTiming)
  probe.base.gate = MutationGate(policy: rules)
  let store = RarogStore(transport: probe, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
  await store.start()
  await until("online") { store.state.global == .online }
  probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
  probe.base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(summaries.joined(separator: ","))]\#(herdr)}"#)
  await until("lista") { store.state.sessionsLoaded }
  return (store, probe)
}

// MARK: - Zgodność pozostałych atrap z protokołem (trasy przerwania i nowej sesji nieużywane w ich testach)

extension FakeTransport {
  func interruptSession(sessionId: String) async throws(TransportError) -> InterruptResponse {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
  func takeBackQueue(sessionId: String, operationId: UUID) async throws(TransportError) -> QueueTakeBackResponse {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
  func markSeen(sessionId: String) async throws(TransportError) {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
  func markUnseen(sessionId: String) async throws(TransportError) {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
  func directory(_ path: String?) async throws(TransportError) -> DirListing {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
  func resumable(cwd: String) async throws(TransportError) -> ResumableList {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
  func recentResumable(cwd: String) async throws(TransportError) -> ResumableList {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
  func makeDirectory(_ body: MakeDirBody) async throws(TransportError) -> DirEntry {
    throw .invalidResponse("unused in core tests")
  }
}
