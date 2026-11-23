import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

// Zdjęcia do miniatur: pamięć procesu, 404, wylogowanie i spóźnione odpowiedzi.
// Właściciel: notki i miniatury.

private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1])
private let photo = "1790000000000-0123456789abcdef.png"

/// Atrapa z kontrolą `GET …/uploads/<plik>`; strumienie i reszta protokołu z `FakeTransport`.
final class UploadProbe: RarogTransporting, @unchecked Sendable {
  struct Script {
    /// Kolejne odpowiedzi; ostatnia powtarza się w nieskończoność.
    var replies: [Result<Data, TransportError>] = [.success(png)]
    var calls: [String] = []
    /// Odczyt czeka na `release()` (odpowiedź w drodze).
    var hold = false
    /// Odpowiedź już w drodze: anulowanie zadania jej nie zatrzyma (wyścig z `URLSession`).
    var holdIgnoresCancel = false
    var held: [UUID: CheckedContinuation<Void, Never>] = [:]
    var cancelledHolds: Set<UUID> = []
    var cancelled = 0
  }

  let base = FakeTransport()
  let script = Mutex(Script())

  func set(_ change: (inout Script) -> Void) { script.withLock { change(&$0) } }
  func read<T>(_ value: (Script) -> T) -> T { script.withLock { value($0) } }

  func release() {
    let waiting = script.withLock { state in
      defer { state.held = [:] }
      return Array(state.held.values)
    }
    for continuation in waiting { continuation.resume() }
  }

  func uploadImage(sessionId: String, file: String) async throws(TransportError) -> Data {
    let (result, hold, ignoresCancel) = script.withLock { state in
      state.calls.append(file)
      let reply = state.replies.count > 1 ? state.replies.removeFirst() : state.replies[0]
      return (reply, state.hold, state.holdIgnoresCancel)
    }
    if hold {
      let id = UUID()
      await withTaskCancellationHandler {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
          let cancelled = script.withLock { state in
            if state.cancelledHolds.contains(id) { return true }
            state.held[id] = continuation
            return false
          }
          if cancelled { continuation.resume() }
        }
      } onCancel: {
        guard !ignoresCancel else { return }
        let continuation = script.withLock { state in
          state.cancelled += 1
          if let waiting = state.held.removeValue(forKey: id) { return Optional(waiting) }
          state.cancelledHolds.insert(id)
          return nil
        }
        continuation?.resume()
      }
      if !ignoresCancel, Task.isCancelled { throw .cancelled }
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

// Atrapa bazowa też musi znać trasę zdjęć — nieużywaną w testach rdzenia; atrapy obszarów oddają ją
// atrapie bazowej przez `ForwardingProbe`.
extension FakeTransport {
  func uploadImage(sessionId: String, file: String) async throws(TransportError) -> Data {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
}

/// Zalogowany magazyn z atrapą zdjęć.
@MainActor
private func uploadStore() async -> (RarogStore, UploadProbe) {
  let probe = UploadProbe()
  let rules = MutationRules(timing: fastTiming)
  probe.base.gate = MutationGate(policy: rules)
  let store = RarogStore(transport: probe, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
  await store.start()
  return (store, probe)
}

@Suite("magazyn: zdjęcia do miniatur")
@MainActor
struct StoreUploadsTests {
  @Test("drugie pokazanie tego samego zdjęcia bierze bajty z pamięci, bez żądania")
  func cacheHit() async {
    let (store, probe) = await uploadStore()
    #expect(await store.uploadImage(sessionId: "s1", file: photo) == .loaded(png))
    #expect(await store.uploadImage(sessionId: "s1", file: photo) == .loaded(png))
    #expect(probe.read(\.calls) == [photo])
    // Klucz to para (sesja, plik): inna sesja pyta serwer.
    #expect(await store.uploadImage(sessionId: "s2", file: photo) == .loaded(png))
    #expect(probe.read(\.calls).count == 2)
  }

  @Test("404 → brak zapamiętany do końca zalogowania; sieć → porażka i ponowna próba")
  func missingAndFailed() async {
    let (store, probe) = await uploadStore()
    probe.set { $0.replies = [.failure(.http(APIFailure(status: 404, code: "not-found")))] }
    #expect(await store.uploadImage(sessionId: "s1", file: "a.png") == .missing)
    #expect(await store.uploadImage(sessionId: "s1", file: "a.png") == .missing)
    #expect(probe.read(\.calls) == ["a.png"])
    probe.set { $0.replies = [.failure(.offline(.notConnectedToInternet)), .success(png)] }
    #expect(await store.uploadImage(sessionId: "s1", file: "b.png") == .failed)
    #expect(await store.uploadImage(sessionId: "s1", file: "b.png") == .loaded(png))
    #expect(probe.read(\.calls) == ["a.png", "b.png", "b.png"])
  }

  @Test("401 bieżącego zalogowania wylogowuje: ekran „Serwer nie rozpoznał tego urządzenia”")
  func unauthorizedLogsOut() async {
    let (store, probe) = await uploadStore()
    probe.set { $0.replies = [.failure(.unauthorized(APIFailure(status: 401)))] }
    #expect(await store.uploadImage(sessionId: "s1", file: photo) == .dropped)
    #expect(store.state.auth == .loggedOut(.deviceUnknown))
    // Wylogowany nie pyta serwera wcale.
    #expect(await store.uploadImage(sessionId: "s1", file: photo) == .dropped)
    #expect(probe.read(\.calls).count == 1)
  }

  @Test("spóźniony 401 sprzed wylogowania nie wylogowuje nowego zalogowania i nie trafia do pamięci")
  func lateResponseAfterRelogin() async {
    let (store, probe) = await uploadStore()
    probe.set {
      $0.hold = true
      $0.holdIgnoresCancel = true
      $0.replies = [.failure(.unauthorized(APIFailure(status: 401)))]
    }
    let late = Task { await store.uploadImage(sessionId: "s1", file: photo) }
    await until("odczyt w drodze") { probe.read { !$0.held.isEmpty } }
    store.handleUnauthorized()
    store.enterLoggedIn()
    probe.release()
    #expect(await late.value == .dropped)
    #expect(store.state.auth == .loggedIn)

    // Udana spóźniona odpowiedź też ginie: nowe zalogowanie pyta serwer od nowa.
    probe.set {
      $0.hold = true
      $0.replies = [.success(png)]
    }
    let lateImage = Task { await store.uploadImage(sessionId: "s1", file: "c.png") }
    await until("drugi odczyt w drodze") { probe.read { !$0.held.isEmpty } }
    store.handleUnauthorized()
    store.enterLoggedIn()
    probe.release()
    #expect(await lateImage.value == .dropped)
    probe.set { $0.hold = false }
    #expect(await store.uploadImage(sessionId: "s1", file: "c.png") == .loaded(png))
    #expect(probe.read(\.calls) == [photo, "c.png", "c.png"])
  }

  @Test("wylogowanie anuluje odczyt w drodze i czyści pamięć zdjęć")
  func logoutCancelsAndForgets() async {
    let (store, probe) = await uploadStore()
    #expect(await store.uploadImage(sessionId: "s1", file: photo) == .loaded(png))
    probe.set { $0.hold = true }
    let pending = Task { await store.uploadImage(sessionId: "s1", file: "d.png") }
    await until("odczyt w drodze") { probe.read { !$0.held.isEmpty } }
    store.handleUnauthorized()
    #expect(await pending.value == .dropped)
    #expect(probe.read(\.cancelled) == 1)
    store.enterLoggedIn()
    probe.set { $0.hold = false }
    #expect(await store.uploadImage(sessionId: "s1", file: photo) == .loaded(png))
    #expect(probe.read(\.calls) == [photo, "d.png", photo], "pamięć sprzed wylogowania zniknęła")
  }

  @Test("zamknięty widok (anulowane zadanie wołającego) anuluje żądanie; wynik nie wraca")
  func callerCancellation() async {
    let (store, probe) = await uploadStore()
    probe.set { $0.hold = true }
    let view = Task { await store.uploadImage(sessionId: "s1", file: photo) }
    await until("odczyt w drodze") { probe.read { !$0.held.isEmpty } }
    view.cancel()
    #expect(await view.value == .dropped)
    #expect(probe.read(\.cancelled) == 1)
    #expect(store.state.auth == .loggedIn)
    #expect(store.uploadReads.inFlight.isEmpty)
  }
}
