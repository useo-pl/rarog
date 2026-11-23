import Foundation
import RarogContract
import RarogCore
import RarogTransport
import Synchronization

// The one `RarogTransporting` of the UIKit test target, with its shared behaviours: a held close
// (`CloseHold`) and the results of the dictation token in order (`VoiceTokenScript`). A new route of the protocol
// changes this file only (a refusal, plus an `on<Route>` handler when a test needs the route); a new test file uses
// this transport instead of its own copy. Tests: `UIKitTransportTests`. Owner: UIKit tests.

/// Test transport for a real `RarogStore`: a test gives the routes it needs as handlers. A route without a handler
/// refuses with `TransportError.invalidResponse` naming the route, so nothing reaches the network and an unexpected
/// call shows up in the test. Presence and the client log, which the store sends on its own, are accepted silently;
/// the transport has a credential.
struct UIKitTransport: RarogTransporting {
  var onCommands: (@Sendable (_ sessionId: String) async throws(TransportError) -> CommandList)?
  var onSend: (@Sendable (_ sessionId: String, _ upload: MessageUpload) async throws(TransportError) -> MessageAccepted?)?
  var onInterrupt: (@Sendable (_ sessionId: String) async throws(TransportError) -> InterruptResponse)?
  var onDecidePermission: (@Sendable (_ body: PermissionDecisionBody) async throws(TransportError) -> Void)?
  var onCloseSession: (@Sendable (_ sessionId: String) async throws(TransportError) -> Void)?
  var onVoiceToken: (@Sendable () async throws(TransportError) -> VoiceToken)?
  var onIssuePairingCode: (@Sendable () async throws(TransportError) -> PairingIssued)?
  var onCancelPairingCode: (@Sendable () async throws(TransportError) -> Void)?
  var onTakeBackQueue: (@Sendable (_ sessionId: String, _ operationId: UUID) async throws(TransportError) -> QueueTakeBackResponse)?

  /// Every close waits in `hold` until the test releases it by its session id.
  static func holdingCloses(_ hold: CloseHold) -> UIKitTransport {
    UIKitTransport(onCloseSession: { sessionId in await hold.pause(sessionId) })
  }

  /// `voiceToken()` answers from `script`, one result per call.
  static func scriptedVoiceTokens(_ script: VoiceTokenScript) -> UIKitTransport {
    UIKitTransport(onVoiceToken: { () throws(TransportError) -> VoiceToken in try script.next() })
  }

  var hasCredential: Bool { true }
  func presence(_ body: PresenceBody) async throws(TransportError) {}
  func clientLog(_ body: ClientLogBody) async throws(TransportError) {}

  func commands(sessionId: String) async throws(TransportError) -> CommandList {
    guard let onCommands else { return try refused() }
    return try await onCommands(sessionId)
  }
  func sendMessage(
    sessionId: String, _ upload: MessageUpload, timeout: Duration?, progress: (@Sendable (UploadProgress) -> Void)?
  ) async throws(TransportError) -> MessageAccepted? {
    guard let onSend else { return try refused() }
    return try await onSend(sessionId, upload)
  }
  func interruptSession(sessionId: String) async throws(TransportError) -> InterruptResponse {
    guard let onInterrupt else { return try refused() }
    return try await onInterrupt(sessionId)
  }
  func decidePermission(sessionId: String, permId: String, _ body: PermissionDecisionBody) async throws(TransportError) {
    guard let onDecidePermission else { return try refused() }
    try await onDecidePermission(body)
  }
  func closeSession(sessionId: String, _ body: CloseSessionBody) async throws(TransportError) {
    guard let onCloseSession else { return try refused() }
    try await onCloseSession(sessionId)
  }
  func voiceToken() async throws(TransportError) -> VoiceToken {
    guard let onVoiceToken else { return try refused() }
    return try await onVoiceToken()
  }

  func version() async throws(TransportError) -> VersionInfo { try refused() }
  func usage() async throws(TransportError) -> PlanUsage { try refused() }
  func usageDetails() async throws(TransportError) -> PlanUsage { try refused() }
  func mac() async throws(TransportError) -> MacLoad { try refused() }
  func openStream(
    _ scope: StreamScope, lastEventId: String?, watch: StreamStallGuard
  ) async throws(TransportError) -> AsyncThrowingStream<SSEParser.Output, any Error> { try refused() }
  func recentProjects() async throws(TransportError) -> RecentProjectList { try refused() }
  func createSession(_ body: CreateSessionBody) async throws(TransportError) -> CreateSessionResponse { try refused() }
  func models() async throws(TransportError) -> ModelList { try refused() }
  func setSessionModel(sessionId: String, _ body: SessionModelBody) async throws(TransportError) -> SessionModelAccepted {
    try refused()
  }
  func setSessionMode(sessionId: String, _ body: SessionModeBody) async throws(TransportError) { try refused() as Void }
  func restartSession(sessionId: String, resend: SessionPromptBlocked?) async throws(TransportError) -> RestartResponse {
    try refused()
  }
  func sessionDiff(sessionId: String) async throws(TransportError) -> SessionDiff { try refused() }
  func sessionDiffFiles(sessionId: String) async throws(TransportError) -> DiffFileList { try refused() }
  func sessionDiffFile(sessionId: String, path: String) async throws(TransportError) -> DiffFilePatch { try refused() }
  func notes(cwd: String) async throws(TransportError) -> NotesDoc { try refused() }
  func saveNotes(_ body: NotesPutBody) async throws(TransportError) -> NotesSaveResult { try refused() }
  func answerQuestion(sessionId: String, qId: String, _ body: AnswersBody) async throws(TransportError) {
    try refused() as Void
  }
  func decideDialog(sessionId: String, _ body: PermissionDecisionBody) async throws(TransportError) {
    try refused() as Void
  }
  func resumeSession(sessionId: String) async throws(TransportError) -> ResumeResponse { try refused() }
  func markSeen(sessionId: String) async throws(TransportError) { try refused() as Void }
  func markUnseen(sessionId: String) async throws(TransportError) { try refused() as Void }
  func directory(_ path: String?) async throws(TransportError) -> DirListing { try refused() }
  func resumable(cwd: String) async throws(TransportError) -> ResumableList { try refused() }
  func recentResumable(cwd: String) async throws(TransportError) -> ResumableList { try refused() }
  func makeDirectory(_ body: MakeDirBody) async throws(TransportError) -> DirEntry { try refused() }
  func uploadImage(sessionId: String, file: String) async throws(TransportError) -> Data { try refused() }
  func issuePairingCode() async throws(TransportError) -> PairingIssued {
    guard let onIssuePairingCode else { return try refused() }
    return try await onIssuePairingCode()
  }
  func cancelPairingCode() async throws(TransportError) {
    guard let onCancelPairingCode else { return try refused() }
    try await onCancelPairingCode()
  }

  func companionToken() async throws(TransportError) -> CompanionToken { try refused() }
  func companionSpeechToken() async throws(TransportError) -> CompanionSpeechToken { try refused() }
  func takeBackQueue(sessionId: String, operationId: UUID) async throws(TransportError) -> QueueTakeBackResponse {
    guard let onTakeBackQueue else { return try refused() }
    return try await onTakeBackQueue(sessionId, operationId)
  }
  func companionAsk(sessionId: String, _ body: CompanionAskBody) async throws(TransportError) -> CompanionAnswer {
    try refused()
  }
  func registerApns(
    token: String, environment: ApnsEnvironment, topic: String?, alerts: Bool, test: Bool
  ) async throws(TransportError) {
    try refused() as Void
  }
  func apnsStatus(token: String) async throws(TransportError) -> ApnsStatus { try refused() }
  func registerLiveActivity(_ body: LiveActivityRegisterBody) async throws(TransportError) { try refused() as Void }
  func endLiveActivity(_ body: LiveActivityEndBody) async throws(TransportError) { try refused() as Void }

  /// The refusal of a route the test did not give: `invalidResponse` with the route's name.
  static func refusal(_ route: String) -> TransportError { .invalidResponse("unexpected call in a UIKit test: \(route)") }

  private func refused<T>(_ route: String = #function) throws(TransportError) -> T { throw Self.refusal(route) }
}

/// Held close requests: each waits until the test releases it by its session id.
actor CloseHold {
  /// Session ids in the order their closes reached the transport.
  private(set) var requested: [String] = []
  private var waiting: [String: CheckedContinuation<Void, Never>] = [:]

  func pause(_ sessionId: String) async {
    requested.append(sessionId)
    await withCheckedContinuation { waiting[sessionId] = $0 }
  }

  func release(_ sessionId: String) {
    waiting.removeValue(forKey: sessionId)?.resume()
  }

  func releaseAll() {
    for continuation in waiting.values { continuation.resume() }
    waiting = [:]
  }
}

/// Results of `voiceToken()` in order: the queue first, then `otherwise` for every further call; counts the calls.
final class VoiceTokenScript: Sendable {
  private struct Plan {
    var queue: [Result<VoiceToken, TransportError>] = []
    var otherwise: Result<VoiceToken, TransportError>
    var calls = 0
  }

  private let fallback: Result<VoiceToken, TransportError>
  private let plan: Mutex<Plan>

  /// `otherwise`: the result while no script is set, and after a `script` without its own `otherwise`.
  init(otherwise: Result<VoiceToken, TransportError>) {
    fallback = otherwise
    plan = Mutex(Plan(otherwise: otherwise))
  }

  /// Calls of `voiceToken()` so far.
  var mints: Int { plan.withLock { $0.calls } }

  /// Replaces the queue; `otherwise` (default: the result from `init`) answers once the queue is empty.
  func script(_ queue: [Result<VoiceToken, TransportError>], otherwise: Result<VoiceToken, TransportError>? = nil) {
    plan.withLock {
      $0.queue = queue
      $0.otherwise = otherwise ?? fallback
    }
  }

  func next() throws(TransportError) -> VoiceToken {
    let result = plan.withLock { plan in
      plan.calls += 1
      return plan.queue.isEmpty ? plan.otherwise : plan.queue.removeFirst()
    }
    return try result.get()
  }
}
