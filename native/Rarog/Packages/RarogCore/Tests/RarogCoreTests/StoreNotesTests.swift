import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

// Notatki projektu: bit „ma notatkę” po znormalizowanym katalogu, sygnały dla modelu notatek (`notesRevision`,
// `notesEpoch`) i wyniki odczytu oraz zapisu w magazynie. Właściciel: notatki (apka natywna).

/// Atrapa tras notatek; strumienie i reszta z `FakeTransport`.
final class NotesProbe: ForwardingProbe, @unchecked Sendable {
  struct Calls {
    var reads: [String] = []
    var saves: [NotesPutBody] = []
    var readResult: Result<NotesDoc, TransportError> = .success(.empty)
    var saveResult: Result<NotesSaveResult, TransportError> = .success(.saved(1))
    /// Wstrzymuje odczyt (test sprawdza stan w trakcie).
    var onRead: (@Sendable () async -> Void)?
  }

  let base: FakeTransport
  let calls = Mutex(Calls())

  init(base: FakeTransport = FakeTransport()) {
    self.base = base
  }

  func set(_ change: (inout Calls) -> Void) { calls.withLock { change(&$0) } }
  func read<T>(_ value: (Calls) -> T) -> T { calls.withLock { value($0) } }

  func notes(cwd: String) async throws(TransportError) -> NotesDoc {
    let (result, hook) = calls.withLock { state in
      state.reads.append(cwd)
      return (state.readResult, state.onRead)
    }
    await hook?()
    return try result.get()
  }

  func saveNotes(_ body: NotesPutBody) async throws(TransportError) -> NotesSaveResult {
    let result = calls.withLock { state in
      state.saves.append(body)
      return state.saveResult
    }
    return try result.get()
  }

  // Pozostałe trasy: atrapa bazowa (`ForwardingProbe` nie obejmuje tras podstawowych, sterowania sesją i katalogu projektów).
  func version() async throws(TransportError) -> VersionInfo { try await base.version() }
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
  var hasCredential: Bool { base.hasCredential }
  func usage() async throws(TransportError) -> PlanUsage { try await base.usage() }
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
  func mac() async throws(TransportError) -> MacLoad { try await base.mac() }
}

/// Bramka jednego żądania: czeka do `open()` (otwarta wcześniej — przepuszcza od razu).
final class NoteGate: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Never>?
  private var opened = false

  func wait() async {
    await withCheckedContinuation { continuation in
      let pass = lock.withLock {
        if opened { return true }
        self.continuation = continuation
        return false
      }
      if pass { continuation.resume() }
    }
  }

  func open() {
    let waiting = lock.withLock {
      opened = true
      let waiting = continuation
      continuation = nil
      return waiting
    }
    waiting?.resume()
  }
}

/// Magazyn z atrapą notatek, zalogowany, z jedną sesją `s1` w `/Users/demo/projekt` i podanymi `notesCwds`.
@MainActor
private func notesStore(notesCwds: String = #","notesCwds":[]"#) async throws -> (RarogStore, NotesProbe) {
  let probe = NotesProbe()
  let rules = MutationRules(timing: fastTiming)
  probe.base.gate = MutationGate(policy: rules)
  let store = RarogStore(transport: probe, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
  await store.start()
  await until("online") { store.state.global == .online }
  probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
  probe.base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1"))]\#(notesCwds)}"#)
  await until("lista") { store.state.sessionsLoaded }
  return (store, probe)
}

@Suite("reduktor: notatki projektu")
struct ReducerNotesTests {
  private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

  private func apply(_ state: inout AppState, _ json: String) throws {
    state.apply(.frame(try Frames.decode(json), source: .global, cursor: nil), now: t0)
  }

  private func snapshot(_ cwd: String, notes: [String]?) -> String {
    let field = notes.map { #","notesCwds":[\#($0.map { "\"\($0)\"" }.joined(separator: ","))]"# } ?? ""
    let summary = Frames.summary("s1").replacingOccurrences(of: "/Users/demo/projekt", with: cwd)
    return #"{"type":"sessions-snapshot","sessions":[\#(summary)]\#(field)}"#
  }

  @Test("klucz bitu to katalog znormalizowany: ukośnik na końcu ścieżki sesji i eventu nie robi drugiego projektu")
  func normalizedKeys() throws {
    var state = AppState(clientBuild: 1)
    try apply(&state, snapshot("/Users/demo/projekt/", notes: ["/Users/demo/projekt/"]))
    #expect(state.notesPresent == ["/Users/demo/projekt": true])
    #expect(state.hasNote("/Users/demo/projekt/") == true && state.hasNote("/Users/demo/inny") == nil)
    try apply(&state, #"{"type":"notes","cwd":"/Users/demo/projekt/","empty":true}"#)
    #expect(state.notesPresent == ["/Users/demo/projekt": false])
  }

  @Test("event `notes` podbija licznik zmian katalogu; własny odczyt apki ustawia bit bez podbicia")
  func revisionOnEvent() throws {
    var state = AppState(clientBuild: 1)
    try apply(&state, snapshot("/Users/demo/projekt", notes: []))
    #expect(state.noteRevision("/Users/demo/projekt") == 0)
    try apply(&state, #"{"type":"notes","cwd":"/Users/demo/projekt","empty":false}"#)
    try apply(&state, #"{"type":"notes","cwd":"/Users/demo/projekt","empty":false}"#)
    #expect(state.noteRevision("/Users/demo/projekt") == 2)
    state.apply(.notesProbed(cwd: "/Users/demo/inny/", present: true), now: t0)
    #expect(state.hasNote("/Users/demo/inny") == true && state.noteRevision("/Users/demo/inny") == 0)
  }

  @Test("każdy snapshot to nowa epoka; bit ze snapshotu INNY niż znany podbija licznik, ten sam nie")
  func epochAndSnapshotBit() throws {
    var state = AppState(clientBuild: 1)
    try apply(&state, snapshot("/Users/demo/projekt", notes: []))
    let first = state.notesEpoch
    try apply(&state, snapshot("/Users/demo/projekt", notes: []))
    #expect(state.notesEpoch == first + 1 && state.noteRevision("/Users/demo/projekt") == 0)
    try apply(&state, snapshot("/Users/demo/projekt", notes: ["/Users/demo/projekt"]))
    #expect(state.notesEpoch == first + 2 && state.noteRevision("/Users/demo/projekt") == 1)
    // Serwer bez notatek (killswitch): pole znika, bity gasną.
    try apply(&state, snapshot("/Users/demo/projekt", notes: nil))
    #expect(state.notesPresent.isEmpty)
  }

  @Test("wylogowanie zdejmuje bity i liczniki, epoka nie wraca do zera (model porównuje ją równością)")
  func logoutKeepsEpoch() throws {
    var state = AppState(clientBuild: 1)
    try apply(&state, snapshot("/Users/demo/projekt", notes: ["/Users/demo/projekt"]))
    try apply(&state, #"{"type":"notes","cwd":"/Users/demo/projekt","empty":false}"#)
    let epoch = state.notesEpoch
    state.apply(.loggedOut(.deviceUnknown), now: t0)
    #expect(state.notesPresent.isEmpty && state.notesRevision.isEmpty && state.notesEpoch == epoch)
  }
}

@Suite("magazyn: odczyt i zapis notatki")
@MainActor
struct StoreNotesTests {
  @Test("udany odczyt oddaje dokument i ustawia bit projektu spoza `notesCwds`")
  func loadSetsBit() async throws {
    let (store, probe) = try await notesStore()
    probe.set { $0.readResult = .success(NotesDoc(text: "## Deploy", updatedAt: 5)) }
    #expect(store.state.hasNote("/Users/demo/historia") == nil)
    #expect(await store.loadNote(cwd: "/Users/demo/historia") == .loaded(NotesDoc(text: "## Deploy", updatedAt: 5)))
    #expect(store.state.hasNote("/Users/demo/historia") == true)
    probe.set { $0.readResult = .success(NotesDoc(text: " \n", updatedAt: 6)) }
    _ = await store.loadNote(cwd: "/Users/demo/historia")
    #expect(store.state.hasNote("/Users/demo/historia") == false)
    #expect(probe.read(\.reads) == ["/Users/demo/historia", "/Users/demo/historia"])
  }

  @Test("zapis: ciało z wersją bazową; sukces to nowa wersja i bit, konflikt niesie aktualny dokument")
  func save() async throws {
    let (store, probe) = try await notesStore()
    probe.set { $0.saveResult = .success(.saved(9)) }
    #expect(await store.saveNote(cwd: "/Users/demo/projekt", text: "dopisek", base: 5) == .saved(9))
    #expect(probe.read(\.saves) == [NotesPutBody(cwd: "/Users/demo/projekt", text: "dopisek", updatedAt: 5)])
    #expect(store.state.hasNote("/Users/demo/projekt") == true)
    let current = NotesDoc(text: "tamta", updatedAt: 10)
    probe.set { $0.saveResult = .success(.conflict(current)) }
    #expect(await store.saveNote(cwd: "/Users/demo/projekt", text: "moja", base: 9) == .conflict(current))
    // Konflikt niczego nie zapisał: bit zostaje taki, jaki był.
    #expect(store.state.hasNote("/Users/demo/projekt") == true)
  }

  @Test(
    "porażki: 404 = wyłączone, 400 katalogu, inne 4xx i bramka = odmowa, 5xx = serwer, sieć i limit = nie wiadomo",
    arguments: [
      (TransportError.http(APIFailure(status: 404, code: "not-found")), NoteFailure.disabled),
      (.http(APIFailure(status: 400, code: "cwd-not-allowed", message: "Nie ma katalogu.")), .badCwd("Nie ma katalogu.")),
      (.http(APIFailure(status: 400, code: "bad-request", message: "Za długa.")), .refused(status: 400, message: "Za długa.")),
      (.http(APIFailure(status: 413, code: nil)), .refused(status: 413, message: nil)),
      (.refused(MutationRefusal(gate: .compatibility, message: "Zaktualizuj apkę.")), .refused(status: nil, message: "Zaktualizuj apkę.")),
      (.http(APIFailure(status: 500, code: "internal", message: "Nie udało się zapisać notatek.")),
       .server("Nie udało się zapisać notatek.")),
      (.offline(.notConnectedToInternet), .offline),
      (.timedOut, .timedOut),
      (.invalidResponse("x"), .failed),
      (.cancelled, .failed),
    ])
  func failures(error: TransportError, expected: NoteFailure) async throws {
    let (store, probe) = try await notesStore()
    probe.set {
      $0.readResult = .failure(error)
      $0.saveResult = .failure(error)
    }
    #expect(await store.loadNote(cwd: "/Users/demo/projekt") == .failed(expected))
    #expect(await store.saveNote(cwd: "/Users/demo/projekt", text: "x", base: 1) == .failed(expected))
    #expect(expected.deliveryUnknown == [.offline, .timedOut, .failed].contains(expected))
  }

  @Test("odpowiedź starsza niż wiadomość ze strumienia nie nadpisuje bitu; po wylogowaniu nie zmienia stanu")
  func lateResponses() async throws {
    let (store, probe) = try await notesStore()
    let gate = NoteGate()
    probe.set {
      $0.readResult = .success(NotesDoc(text: "treść", updatedAt: 5))
      $0.onRead = { await gate.wait() }
    }
    let read = Task { await store.loadNote(cwd: "/Users/demo/projekt") }
    await until("odczyt w drodze") { probe.read(\.reads).count == 1 }
    // W trakcie odczytu drugie urządzenie skasowało notatkę: event mówi „pusta".
    probe.base.push(.global, json: #"{"type":"notes","cwd":"/Users/demo/projekt","empty":true}"#)
    await until("event") { store.state.hasNote("/Users/demo/projekt") == false }
    gate.open()
    #expect(await read.value == .loaded(NotesDoc(text: "treść", updatedAt: 5)))
    #expect(store.state.hasNote("/Users/demo/projekt") == false, "starsza odpowiedź nie zapala bitu")

    let second = NoteGate()
    probe.set { $0.onRead = { await second.wait() } }
    let late = Task { await store.loadNote(cwd: "/Users/demo/inny") }
    await until("drugi odczyt") { probe.read(\.reads).count == 2 }
    store.handleUnauthorized()
    second.open()
    #expect(await late.value == .failed(.loggedOut))
    #expect(store.state.hasNote("/Users/demo/inny") == nil)
  }

  @Test("401 przy zapisie wylogowuje (bieżące zalogowanie) i mówi `loggedOut`")
  func unauthorized() async throws {
    let (store, probe) = try await notesStore()
    probe.set { $0.saveResult = .failure(.unauthorized(APIFailure(status: 401, code: "bad-token"))) }
    #expect(await store.saveNote(cwd: "/Users/demo/projekt", text: "x", base: 1) == .failed(.loggedOut))
    #expect(store.state.auth == .loggedOut(.deviceUnknown))
  }
}
