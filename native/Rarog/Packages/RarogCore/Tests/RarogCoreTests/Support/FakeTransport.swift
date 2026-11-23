import Foundation
import RarogContract
import RarogContractFixtures
import RarogCore
import RarogTransport
import Synchronization
import Testing

/// Atrapa transportu: strumienie sterowane z testu, zapis wywołań, wyniki mutacji na życzenie.
/// Mutacje przechodzą przez `MutationGate` z regułami magazynu — dokładnie jak w `RarogClient`.
final class FakeTransport: RarogTransporting, @unchecked Sendable {
  struct StreamCall: Sendable, Equatable {
    let scope: StreamScope
    let lastEventId: String?
  }

  struct State {
    /// Transport ma poświadczenie (atrapa klucza urządzenia: logowanie bez złącza serwera).
    var credential = true
    var streamCalls: [StreamCall] = []
    var continuations: [Int: AsyncThrowingStream<SSEParser.Output, any Error>.Continuation] = [:]
    /// Stall guard of each stream call, by call index.
    var watches: [Int: StreamStallGuard] = [:]
    /// A stream opens with headers only: no body byte until the test pushes one. Default: the server's first
    /// bytes (`retry:`) come right after the headers, as from every live stream.
    var silentOpen = false
    /// The request goes out and its headers never come; cancelling the call throws `.cancelled`, as the transport
    /// switch does for a cancelled caller.
    var hangOpen = false
    var openFailures: [TransportError] = []
    var messages: [(sessionId: String, body: SentBody)] = []
    /// Limit wysyłki podany przez magazyn (`nil` = domyślne 10 s transportu).
    var sendTimeouts: [Duration?] = []
    var decisions: [(sessionId: String, permId: String, body: PermissionDecisionBody)] = []
    var presence: [PresenceBody] = []
    var clientLogs: [ClientLogBody] = []
    var sendResult: TransportError?
    /// Odpowiedź sondy `GET /api/version`; `nil` = sonda pada jak dotąd (testy rdzenia jej nie czekają).
    var version: VersionInfo?
    var decisionResult: TransportError?
    /// Odpowiedź per rodzaj decyzji (np. inna dla `release` niż dla `allow`); brak = `decisionResult`.
    var decisionResults: [PermissionDecision: TransportError] = [:]
    /// Wstrzymuje decyzję „w drodze" (równoległa zgoda i zwolnienie tej samej karty).
    var onDecision: (@Sendable (PermissionDecision) async -> Void)?
    var clientLogResult: TransportError?
    var onSend: (@Sendable (String, SentBody) -> Void)?
    /// Wstrzymuje wysyłkę w trakcie „przesyłu": test dostaje ciało i raport postępu.
    var onSendAsync: (@Sendable (SentBody, @escaping @Sendable (UploadProgress) -> Void) async -> Void)?
    /// Ciało odpowiedzi 202; `nil` = bieżący serwer (`{ok, clientMessageId}` z wysłanym id).
    var sendReply: String?
    /// Domyślna odpowiedź 202 z `queued: true` (echo odroczone).
    var replyQueued = false
    // Katalog projektów
    var recentProjects: RecentProjectList?
    var recentResult: TransportError?
    var recentCalls = 0
    var created: [CreateSessionBody] = []
    var createResults: [Result<String, TransportError>] = []
    var closed: [(sessionId: String, body: CloseSessionBody)] = []
    var closeResult: TransportError?
    // Karty decyzji i karta stanu
    var dialogDecisions: [(sessionId: String, body: PermissionDecisionBody)] = []
    var resumes: [String] = []
    /// Wynik dialogu i „Wznów" (`nil` = sukces).
    var cardResult: TransportError?
    /// Wstrzymuje żądanie karty (test sprawdza stan w trakcie, np. wylogowanie w locie).
    var onCardRequest: (@Sendable () async -> Void)?
    /// Odpowiedź 202 na założenie sesji niesie `trustPrompt: true`.
    var createTrustPrompt = false
    // Powiadomienia APNs
    var apnsRegistrations: [ApnsRegistrationCall] = []
    var apnsRegisterResult: TransportError?
    var apnsStatusCalls: [String] = []
    var apnsStatus = #"{"enabled":true,"registered":true,"alerts":true,"degradedSince":null}"#
    var apnsStatusResult: TransportError?
    /// Wstrzymuje odczyt statusu tokenu (test sprawdza wylogowanie i logowanie w jego trakcie).
    var onApnsStatus: (@Sendable () async -> Void)?
    /// Każde wywołanie obecności — także dla wspólnego dziennika kolejności z atrapą pracy w tle.
    var onPresence: (@Sendable (PresenceBody) -> Void)?
    // Live Activity
    var liveRegistrations: [LiveActivityRegisterBody] = []
    /// Kolejne wyniki rejestracji tokenu aktywności (pierwszy zdejmowany przy każdym wywołaniu); pusto = 204.
    var liveRegisterResults: [TransportError] = []
    var liveEnds: [LiveActivityEndBody] = []
    // Slash-komendy sesji
    var commandsCalls: [String] = []
    /// Lista per sesja; brak wpisu = ``CommandList/unavailable`` (jak serwer bez trasy).
    var commandLists: [String: CommandList] = [:]
    var commandsResult: TransportError?
    /// Wstrzymuje odczyt listy komend w trakcie żądania (odmowa wysyłki w tym oknie).
    var onCommands: (@Sendable () async -> Void)?
    // Klucz urządzenia i parowanie — `Support/FakePairing.swift`.
    /// Transport z kluczem urządzenia ze złącza serwera (`FakeServer`): ma poświadczenie.
    var device = false
    var rejection: CredentialRejection?
    var pairBodies: [PairBody] = []
    var pairResult: Result<PairResponse, TransportError>?
    /// Wstrzymuje parowanie w trakcie żądania (test sprawdza stan „w drodze”).
    var onPair: (@Sendable () async -> Void)?
    var issueCalls = 0
    var issueResult: Result<PairingIssued, TransportError>?
    /// Holds `POST /api/pairings` before its answer (a screen closed while the code is being issued).
    var onIssue: (@Sendable () async -> Void)?
    var cancelCodeCalls = 0
    var cancelCodeResult: TransportError?
    /// Holds `DELETE /api/pairings` before its answer (a new code issued while the cancel is late).
    var onCancelCode: (@Sendable () async -> Void)?
    /// Pairing code operations in order: `POST`/`DELETE` when a request goes out, `… done` when its answer comes.
    var codeLog: [String] = []
    var devicesCalls = 0
    var deviceList: DeviceList?
    var devicesResult: TransportError?
    var forgetCalls = 0
    var forgetResult: TransportError?
    /// Wstrzymuje „Zapomnij serwer” w trakcie żądania (wyścig z parowaniem).
    var onForget: (@Sendable () async -> Void)?
    /// Wstrzymuje założenie sesji po zapisaniu ciała (odpowiedź przychodzi po przełączeniu serwera).
    var onCreate: (@Sendable () async -> Void)?
    /// Numer drogi (`RarogTransporting.routeStamp`); test zmienia go, udając nową generację przełącznika.
    var routeStamp: UInt64 = 0
    /// Wstrzymuje sondę wersji po odczycie odpowiedzi (spóźniona odpowiedź starej drogi).
    var onVersion: (@Sendable () async -> Void)?
  }

  struct ApnsRegistrationCall: Sendable, Equatable {
    let token: String
    let environment: ApnsEnvironment
    let topic: String?
    let alerts: Bool
    let test: Bool
  }

  let lock = Mutex(State())
  var gate: MutationGate?
  /// Terminal: `POST`/lista/gniazda — `Support/FakeTerminal.swift`.
  let terminal = FakeTerminalBackend()

  init(credential: Bool = true) {
    lock.withLock { $0.credential = credential }
  }

  // MARK: RarogTransporting

  var routeStamp: UInt64 { lock.withLock { $0.routeStamp } }

  func version() async throws(TransportError) -> VersionInfo {
    let (answer, hook) = lock.withLock { ($0.version, $0.onVersion) }
    await hook?()
    guard let version = answer else { throw .invalidResponse("nieużywane w testach rdzenia") }
    return version
  }

  func sendMessage(
    sessionId: String, _ upload: MessageUpload, timeout: Duration?, progress: (@Sendable (UploadProgress) -> Void)?
  ) async throws(TransportError) -> MessageAccepted? {
    try await check("POST", "/api/sessions/\(sessionId)/messages")
    let body = SentBody.decode(upload)
    let (hook, asyncHook, result, reply, queued) = lock.withLock { state in
      state.messages.append((sessionId, body))
      state.sendTimeouts.append(timeout)
      return (state.onSend, state.onSendAsync, state.sendResult, state.sendReply, state.replyQueued)
    }
    hook?(sessionId, body)
    if let asyncHook { await asyncHook(body, progress ?? { _ in }) }
    if let result { throw result }
    let queuedField = queued ? #","queued":true"# : ""
    let json = reply ?? body.clientMessageId.map { #"{"ok":true,"clientMessageId":"\#($0)"\#(queuedField)}"# } ?? #"{"ok":true}"#
    return try? JSONDecoder().decode(MessageAccepted.self, from: Data(json.utf8))
  }

  func decidePermission(sessionId: String, permId: String, _ body: PermissionDecisionBody) async throws(TransportError) {
    try await check("POST", "/api/sessions/\(sessionId)/permissions/\(permId)")
    let (result, hook) = lock.withLock { state in
      state.decisions.append((sessionId, permId, body))
      return (state.decisionResults[body.decision] ?? state.decisionResult, state.onDecision)
    }
    await hook?(body.decision)
    if let result { throw result }
  }

  func presence(_ body: PresenceBody) async throws(TransportError) {
    try await check("POST", "/api/presence")
    let hook = lock.withLock { state in
      state.presence.append(body)
      return state.onPresence
    }
    hook?(body)
  }

  func clientLog(_ body: ClientLogBody) async throws(TransportError) {
    try await check("POST", "/api/client-log")
    let result = lock.withLock { state in
      state.clientLogs.append(body)
      return state.clientLogResult
    }
    if let result { throw result }
  }

  func openStream(
    _ scope: StreamScope, lastEventId: String?, watch: StreamStallGuard
  ) async throws(TransportError) -> AsyncThrowingStream<SSEParser.Output, any Error> {
    let (stream, continuation) = AsyncThrowingStream<SSEParser.Output, any Error>.makeStream()
    continuation.onTermination = { _ in watch.ended() }
    // Wywołanie i jego kontynuacja w JEDNEJ sekcji zamka: test, który zobaczył wywołanie, od razu pcha
    // ramki. Dwa osobne zapisy zgubiłyby ramkę wysłaną pomiędzy nimi („nie doczekałem się:
    // transkrypt" pod obciążeniem), a drugi zapis po indeksie trafiłby w cudze wywołanie.
    let hang = lock.withLock { state in
      guard state.hangOpen else { return false }
      state.streamCalls.append(StreamCall(scope: scope, lastEventId: lastEventId))
      return true
    }
    if hang {
      watch.sent()
      try? await Task.sleep(for: .seconds(3600))
      throw .cancelled
    }
    let failure: TransportError? = lock.withLock { state in
      state.streamCalls.append(StreamCall(scope: scope, lastEventId: lastEventId))
      if !state.openFailures.isEmpty { return state.openFailures.removeFirst() }
      state.continuations[state.streamCalls.count - 1] = continuation
      state.watches[state.streamCalls.count - 1] = watch
      // In the same lock section: a test that saw the call can push bytes at once.
      watch.sent()
      if !state.silentOpen { watch.received() }
      return nil
    }
    if let failure {
      continuation.finish()
      throw failure
    }
    return stream
  }

  func check(_ method: String, _ path: String) async throws(TransportError) {
    guard let gate else { return }
    do {
      try await gate.check(method: method, path: path)
    } catch {
      throw .refused(error)
    }
  }

  // MARK: Sterowanie z testu

  var streamCalls: [StreamCall] { lock.withLock { $0.streamCalls } }

  /// Wysyła ramkę JSON ostatnim otwartym strumieniem danego zakresu (`id` = kursor bloku).
  func push(_ scope: StreamScope, json: String, id: String? = nil) {
    let event = SSEEvent(data: json, id: id, lastEventId: id ?? "")
    emit(scope, .event(event))
  }

  /// Sends any parser output (`retry:`, comment, event) on the last open stream of the scope; its bytes reach the
  /// stall guard first, as in `RarogClient`.
  func emit(_ scope: StreamScope, _ output: SSEParser.Output) {
    watch(scope)?.received()
    continuation(scope)?.yield(output)
  }

  /// Body bytes of a frame that is not complete yet: the stall guard hears them, the parser yields nothing.
  func trickle(_ scope: StreamScope) {
    watch(scope)?.received()
  }

  /// Stall guard of the last stream call of the scope.
  func watch(_ scope: StreamScope) -> StreamStallGuard? {
    lock.withLock { state in
      guard let index = state.streamCalls.lastIndex(where: { $0.scope == scope }) else { return nil }
      return state.watches[index]
    }
  }

  func pushGolden(_ scope: StreamScope, _ name: String, id: String? = nil) throws {
    let data = try GoldenFramesData.data(name)
    push(scope, json: String(decoding: data, as: UTF8.self), id: id)
  }

  /// Kończy ostatni strumień zakresu (serwer zamknął połączenie albo błąd).
  func end(_ scope: StreamScope, error: TransportError? = nil) {
    guard let continuation = continuation(scope) else { return }
    if let error { continuation.finish(throwing: error) } else { continuation.finish() }
  }

  func set(_ change: (inout State) -> Void) { lock.withLock { change(&$0) } }

  func read<T>(_ value: (State) -> T) -> T { lock.withLock { value($0) } }

  private func continuation(_ scope: StreamScope) -> AsyncThrowingStream<SSEParser.Output, any Error>.Continuation? {
    lock.withLock { state in
      guard let index = state.streamCalls.lastIndex(where: { $0.scope == scope }) else { return nil }
      return state.continuations[index]
    }
  }

  // MARK: Katalog projektów

  func recentProjects() async throws(TransportError) -> RecentProjectList {
    let (list, error) = lock.withLock { state in
      state.recentCalls += 1
      return (state.recentProjects, state.recentResult)
    }
    if let error { throw error }
    guard let list else { throw .invalidResponse("brak listy w atrapie") }
    return list
  }

  /// Kolejne wyniki z `createResults` (identyfikator sesji albo błąd); pusta lista = `new-<n>`.
  func createSession(_ body: CreateSessionBody) async throws(TransportError) -> CreateSessionResponse {
    try await check("POST", "/api/sessions")
    let (result, trust, hook): (Result<String, TransportError>, Bool, (@Sendable () async -> Void)?) = lock.withLock { state in
      state.created.append(body)
      let next = state.createResults.isEmpty ? .success("new-\(state.created.count)") : state.createResults.removeFirst()
      return (next, state.createTrustPrompt, state.onCreate)
    }
    await hook?()
    switch result {
    case let .success(id):
      let json = #"{"sessionId":"\#(id)","state":"starting"\#(trust ? #","trustPrompt":true"# : "")}"#
      do {
        return try JSONDecoder().decode(CreateSessionResponse.self, from: Data(json.utf8))
      } catch {
        throw .invalidResponse("atrapa: \(error)")
      }
    case let .failure(error):
      throw error
    }
  }

  func closeSession(sessionId: String, _ body: CloseSessionBody) async throws(TransportError) {
    try await check("POST", "/api/sessions/\(sessionId)/close")
    let result = lock.withLock { state in
      state.closed.append((sessionId, body))
      return state.closeResult
    }
    if let result { throw result }
  }
}

/// Ciało wysyłki odczytane tak, jak przeczytałby je serwer (z pamięci albo z pliku ciała).
struct SentBody: Decodable, Equatable, Sendable {
  struct File: Decodable, Equatable, Sendable {
    let name: String
    let dataUrl: String
  }

  let text: String
  let images: [String]?
  let files: [File]?
  let clientMessageId: String?
  /// Echo odroczone: `true` albo brak pola.
  var queueAware: Bool? = nil

  static func decode(_ upload: MessageUpload) -> SentBody {
    let data: Data? =
      switch upload.body {
      case let .data(data): data
      case let .file(url): try? Data(contentsOf: url)
      }
    return data.flatMap { try? JSONDecoder().decode(SentBody.self, from: $0) }
      ?? SentBody(text: "<nieczytelne ciało>", images: nil, files: nil, clientMessageId: nil)
  }

  /// Treść data URL-a po odkodowaniu base64.
  static func content(_ dataUrl: String) -> Data? {
    guard let comma = dataUrl.firstIndex(of: ",") else { return nil }
    return Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...]))
  }
}

enum GoldenFramesData {
  static func data(_ name: String) throws -> Data {
    try GoldenFrames.shared.dataField(name)
  }
}

/// Czeka (na głównym aktorze), aż warunek będzie prawdziwy; porażka testu po `timeout`.
/// The default is generous on purpose: in the full iOS gate the whole test process sometimes stalls for 3–5 s
/// at once (every waiting test times out in the same instant), and a passing test never waits for the deadline.
@MainActor
func until(
  _ what: String = "warunek", timeout: Duration = .seconds(10),
  sourceLocation: SourceLocation = #_sourceLocation, _ condition: () -> Bool
) async {
  let deadline = ContinuousClock.now + timeout
  while !condition() {
    if ContinuousClock.now > deadline {
      Issue.record("nie doczekałem się: \(what)", sourceLocation: sourceLocation)
      return
    }
    try? await Task.sleep(for: .milliseconds(5))
  }
}

/// Katalog tymczasowy na kolejkę jednego testu.
func temporaryOutbox() -> URL {
  FileManager.default.temporaryDirectory.appending(path: "rarog-core-tests/\(UUID().uuidString)", directoryHint: .isDirectory)
}

/// Szybki zegar dla testów magazynu (milisekundy zamiast sekund).
let fastTiming = CoreTiming(
  backoffMin: .milliseconds(10), backoffMax: .milliseconds(40), unconfirmedAfter: .milliseconds(150),
  attachmentUnconfirmedAfter: .milliseconds(1200), compatWait: .milliseconds(150), presenceInterval: .milliseconds(60), echoClockSkew: .seconds(60),
  noticeLifetime: .milliseconds(100), queuedIdleAfter: .milliseconds(150), queuedUnconfirmedAfter: .milliseconds(600)
)

/// Magazyn z atrapą transportu i bramką wpiętą jak w `RarogStore.live`.
@MainActor
func makeStore(
  transport: FakeTransport = FakeTransport(), outbox: URL = temporaryOutbox(), build: Int = 7,
  renderer: SentenceRenderer? = nil, timing: CoreTiming = fastTiming
) -> (RarogStore, FakeTransport) {
  let rules = MutationRules(timing: timing)
  transport.gate = MutationGate(policy: rules)
  guard let renderer else {
    let store = RarogStore(transport: transport, rules: rules, outboxDirectory: outbox, clientBuild: build, timing: timing)
    return (store, transport)
  }
  let store = RarogStore(
    transport: transport, rules: rules, outboxDirectory: outbox, clientBuild: build, timing: timing,
    renderer: renderer)
  return (store, transport)
}

// MARK: - Limity planu

extension FakeTransport {
  /// Testy limitów i sondy wersji używają `ProbeTransport` (`StoreUsageTests`); tu tylko zgodność z protokołem.
  func usage() async throws(TransportError) -> PlanUsage {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }

  /// Obciążenie Maca testują `StoreMacTests` na `ProbeTransport`; tu tylko zgodność z protokołem.
  func mac() async throws(TransportError) -> MacLoad {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }

  /// Szczegóły limitów testuje `StoreUsageDetailsTests` na `ProbeTransport`; tu tylko zgodność z protokołem.
  func usageDetails() async throws(TransportError) -> PlanUsage {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
}

// MARK: - Notatki projektu

extension FakeTransport {
  // Testy notatek używają `NotesProbe` (`StoreNotesTests`); tu tylko zgodność z protokołem.
  func notes(cwd: String) async throws(TransportError) -> NotesDoc {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }

  func saveNotes(_ body: NotesPutBody) async throws(TransportError) -> NotesSaveResult {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
}

// MARK: - Sterowanie sesją i diff

extension FakeTransport {
  // Testy sterowania sesją używają `SessionProbe` (`StoreSessionTests`); tu tylko zgodność z protokołem.
  func models() async throws(TransportError) -> ModelList {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }

  /// Slash-komendy sesji: zapis wywołania, lista z `commandLists` albo błąd z `commandsResult`.
  func commands(sessionId: String) async throws(TransportError) -> CommandList {
    let hook = lock.withLock { state in
      state.commandsCalls.append(sessionId)
      return state.onCommands
    }
    await hook?()
    // Lista i błąd z chwili ODPOWIEDZI: test podmienia je, gdy żądanie stoi w `onCommands`.
    let (list, error) = lock.withLock { state in (state.commandLists[sessionId], state.commandsResult) }
    if let error { throw error }
    return list ?? .unavailable
  }

  func setSessionModel(sessionId: String, _ body: SessionModelBody) async throws(TransportError) -> SessionModelAccepted {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }

  func setSessionMode(sessionId: String, _ body: SessionModeBody) async throws(TransportError) {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }

  func restartSession(sessionId: String, resend: SessionPromptBlocked?) async throws(TransportError) -> RestartResponse {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }

  func sessionDiff(sessionId: String) async throws(TransportError) -> SessionDiff {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }

  func sessionDiffFiles(sessionId: String) async throws(TransportError) -> DiffFileList {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }

  func sessionDiffFile(sessionId: String, path: String) async throws(TransportError) -> DiffFilePatch {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
}

// MARK: - Karty pytań

extension FakeTransport {
  // Testy odpowiedzi używają `AnswerProbe` (`StoreAnswerTests`); tu tylko zgodność z protokołem.
  func answerQuestion(sessionId: String, qId: String, _ body: AnswersBody) async throws(TransportError) {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
}

// MARK: - Karty decyzji i karta stanu

extension FakeTransport {
  func decideDialog(sessionId: String, _ body: PermissionDecisionBody) async throws(TransportError) {
    try await check("POST", "/api/sessions/\(sessionId)/permission")
    let (hook, result) = lock.withLock { state in
      state.dialogDecisions.append((sessionId, body))
      return (state.onCardRequest, state.cardResult)
    }
    await hook?()
    if let result { throw result }
  }

  func resumeSession(sessionId: String) async throws(TransportError) -> ResumeResponse {
    try await check("POST", "/api/sessions/\(sessionId)/resume")
    let (hook, result) = lock.withLock { state in
      state.resumes.append(sessionId)
      return (state.onCardRequest, state.cardResult)
    }
    await hook?()
    if let result { throw result }
    let json = #"{"sessionId":"\#(sessionId)","session":\#(Frames.summary(sessionId, state: "starting"))}"#
    do {
      return try JSONDecoder().decode(ResumeResponse.self, from: Data(json.utf8))
    } catch {
      throw .invalidResponse("atrapa: \(error)")
    }
  }

}

// MARK: - Powiadomienia APNs

extension FakeTransport {
  func registerApns(
    token: String, environment: ApnsEnvironment, topic: String?, alerts: Bool, test: Bool
  ) async throws(TransportError) {
    try await check("POST", "/api/push/apns")
    let result = lock.withLock { state in
      state.apnsRegistrations.append(
        ApnsRegistrationCall(token: token, environment: environment, topic: topic, alerts: alerts, test: test))
      return state.apnsRegisterResult
    }
    if let result { throw result }
  }

  func registerLiveActivity(_ body: LiveActivityRegisterBody) async throws(TransportError) {
    try await check("POST", "/api/push/live-activity")
    let result = lock.withLock { state -> TransportError? in
      state.liveRegistrations.append(body)
      return state.liveRegisterResults.isEmpty ? nil : state.liveRegisterResults.removeFirst()
    }
    if let result { throw result }
  }

  func endLiveActivity(_ body: LiveActivityEndBody) async throws(TransportError) {
    try await check("POST", "/api/push/live-activity/end")
    lock.withLock { $0.liveEnds.append(body) }
  }

  func apnsStatus(token: String) async throws(TransportError) -> ApnsStatus {
    try await check("POST", "/api/push/apns/status")
    let hook = lock.withLock { state in
      state.apnsStatusCalls.append(token)
      return state.onApnsStatus
    }
    await hook?()
    let (json, result) = lock.withLock { ($0.apnsStatus, $0.apnsStatusResult) }
    if let result { throw result }
    do {
      return try JSONDecoder().decode(ApnsStatus.self, from: Data(json.utf8))
    } catch {
      throw .invalidResponse("atrapa: \(error)")
    }
  }
}

// MARK: - Dyktowanie

extension FakeTransport {
  // Testy klucza dyktowania używają `VoiceProbe` (`StoreVoiceTests`); tu tylko zgodność z protokołem.
  func voiceToken() async throws(TransportError) -> VoiceToken {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }
}

// MARK: - Agent głosowy

extension FakeTransport {
  // Testy agenta głosowego używają `CompanionProbe` (`VoiceAgentSessionStoreTests`); tu tylko zgodność z protokołem.
  func companionToken() async throws(TransportError) -> CompanionToken {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }

  func companionAsk(sessionId: String, _ body: CompanionAskBody) async throws(TransportError) -> CompanionAnswer {
    throw .invalidResponse("nieużywane w testach rdzenia")
  }

  func companionSpeechToken() async throws(TransportError) -> CompanionSpeechToken {
    throw .invalidResponse("unused in core tests")
  }
}
