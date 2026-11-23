import Foundation
import RarogContract
import RarogTransport
import Synchronization

// Przełącznik transportu sparowanego serwera: jeden obiekt `RarogTransporting` i `TerminalTransporting` na
// tożsamość serwera, także tylko-HTTPS, bo nadzorcy SSE i terminala trzymają transport przez całe życie
// poświadczenia. Pod spodem generacje runtime'u tunelu (iroh albo HTTPS); przełącznik klientów nie buduje, tylko
// pożycza klienta generacji przez bilet.
//
// Reguły:
// - Bramka gotowości: każde wywołanie czeka na generację runtime'u. Generacji nie ma (tło bez pracy, przerwa po
//   nieudanej próbie) → `.offline` bez żądania; runtime wycofany → `.cancelled`.
// - Bilet: klient generacji wołany wyłącznie między `begin() == true` i `end()`; strumień SSE i gniazdo terminala
//   trzymają bilet do swojego końca. `begin() == false` (generacja w zamykaniu) → czekanie na następną generację;
//   na kliencie po `startClosing()` nie startuje żadne żądanie.
// - Mapowanie: anulowane zadanie wołającego → `.cancelled` (sprawdzane przed resztą, także gdy generacja zamyka
//   się w tej samej chwili); `.cancelled` z generacji zamkniętej przez runtime → `.offline`, bo dla konsumenta to
//   zerwanie, nie rezygnacja (nadzorca SSE wraca wtedy do pętli). Reset strumienia iroh (serwer zamiast 400/408
//   resetuje strumień) klient zgłasza jako `.offline`.
// - Bez ponowień: przełącznik nigdy sam nie powtarza żądania, odczytu ani mutacji, na tej samej ani na innej
//   trasie; ponawiają konsumenci.
// - Wysyłka z załącznikiem na generacji iroh idzie własnymi drzwiami uploadu (osobne połączenie). Limit całej
//   wysyłki liczy się od wejścia w `sendMessage`: czekanie na generację i otwarcie drzwi schodzą z budżetu.
//   Anulowanie albo limit w trakcie zamyka drzwi kodem 1, koniec z odpowiedzią serwera kodem 0.
// - Odmowa klucza: wszyscy klienci poświadczenia (HTTPS, generacje, drzwi) dzielą jeden zatrzask, a przełącznik
//   czyta ten sam obiekt, więc 401 `device-revoked` z dowolnej trasy widzi magazyn.
// - `routeStamp`: najwyższy numer generacji, którą przełącznik dostał; rośnie z każdą nową generacją.
// - `afterPair`: transport parowania jest jednorazowy, więc właściciel runtime'u dostaje sygnał zaraz
//   po powrocie `pair` — z odpowiedzią, z błędem i po anulowaniu — i zamyka połączenie od razu.
//
// Strażnik `TunnelForwardingTests` pilnuje, że każda funkcja i zmienna protokołów ma tu odpowiednik o tej samej
// sygnaturze: domyślne odpowiedzi rozszerzeń protokołu (404, brak odmowy, trasa 0) zgubiłyby wywołanie po cichu.

/// Źródło generacji i drzwi uploadu (runtime tunelu; w testach także runtime z wstrzykniętym zdarzeniem).
struct GenerationSource: Sendable {
  var generation: @Sendable () async -> TunnelGenerationOutcome
  var openUploadDoor: @Sendable (_ budget: Duration) async throws -> UploadDoor

  init(generation: @escaping @Sendable () async -> TunnelGenerationOutcome,
       openUploadDoor: @escaping @Sendable (_ budget: Duration) async throws -> UploadDoor) {
    self.generation = generation
    self.openUploadDoor = openUploadDoor
  }

  init(_ runtime: TunnelRuntime) {
    generation = { await runtime.generation() }
    openUploadDoor = { budget in try await runtime.openUploadDoor(budget: budget) }
  }
}

/// Transport sparowanego serwera nad generacjami runtime'u tunelu.
public final class SwitchingTransport: RarogTransporting, TerminalTransporting, Sendable {
  /// Brak generacji: żądanie nie wyszło.
  static let noGeneration = TransportError.offline(.cannotConnectToHost)

  private struct State {
    /// Najwyższy numer generacji, którą dostało jakiekolwiek wywołanie.
    var stamp: UInt64 = 0
    /// Ostatnia generacja z udanego czekania: z niej gniazdo terminala, które musi powstać synchronicznie.
    var current: TunnelGeneration?
  }

  private let source: GenerationSource
  private let rejections: CredentialRejectionLatch
  private let requestTimeout: Duration
  private let timing: TunnelRuntime.Timing
  private let afterPair: (@Sendable () -> Void)?
  private let state = Mutex(State())

  /// - Parameters:
  ///   - runtime: runtime tunelu tej tożsamości serwera (generacje i drzwi uploadu).
  ///   - rejections: zatrzask odmowy klucza, ten sam, który fabryka klientów podaje każdemu klientowi poświadczenia.
  ///   - requestTimeout: limit wysyłki bez podanego `timeout` (jak `RarogConfig.requestTimeout` klienta).
  ///   - timing: zegar limitu wysyłki (testy: zegar sztuczny runtime'u).
  ///   - afterPair: wołane raz po każdym powrocie `pair` (odpowiedź, błąd, anulowanie); transport parowania.
  public convenience init(runtime: TunnelRuntime,
                          rejections: CredentialRejectionLatch,
                          requestTimeout: Duration = .seconds(10),
                          timing: TunnelRuntime.Timing = .system,
                          afterPair: (@Sendable () -> Void)? = nil) {
    self.init(source: GenerationSource(runtime), rejections: rejections, requestTimeout: requestTimeout, timing: timing,
              afterPair: afterPair)
  }

  init(source: GenerationSource, rejections: CredentialRejectionLatch, requestTimeout: Duration,
       timing: TunnelRuntime.Timing, afterPair: (@Sendable () -> Void)? = nil) {
    self.source = source
    self.rejections = rejections
    self.requestTimeout = requestTimeout
    self.timing = timing
    self.afterPair = afterPair
  }

  // MARK: - Trasa i poświadczenie

  /// Przełącznik istnieje tylko dla sparowanego serwera, więc zawsze ma klucz urządzenia.
  public var hasCredential: Bool { true }

  public var credentialRejection: CredentialRejection? { rejections.value }

  public var routeStamp: UInt64 { state.withLock { $0.stamp } }

  // MARK: - Bramka, bilet i mapowanie

  /// Generacja z wziętym biletem (`begin() == true`); bilet oddaje wołający przez `end()`.
  private func admitted() async throws(TransportError) -> TunnelGeneration {
    var refused: UInt64?
    while true {
      if Task.isCancelled { throw .cancelled }
      switch await source.generation() {
      case .cancelled:
        // Anulowane zadanie wołającego albo runtime wycofany: w obu razach `.cancelled`, ale tylko wycofanie
        // mówi coś o generacji.
        if !Task.isCancelled { forgetCurrent() }
        throw .cancelled
      case .offline:
        if Task.isCancelled { throw .cancelled }
        forgetCurrent()
        throw Self.noGeneration
      case let .ready(generation):
        remember(generation)
        if generation.ticket.begin() { return generation }
        // Generacja zaczęła się zamykać między wydaniem a wejściem: czekamy na następną. Ta sama generacja drugi
        // raz w zamykaniu to niezgodność źródła; bez generacji, zamiast pętli.
        if let refused, generation.number <= refused { throw Self.noGeneration }
        refused = generation.number
      }
    }
  }

  private func remember(_ generation: TunnelGeneration) {
    state.withLock { state in
      if generation.number >= state.stamp {
        state.stamp = generation.number
        state.current = generation
      }
    }
  }

  private func forgetCurrent() {
    state.withLock { $0.current = nil }
  }

  /// Błąd wywołania na kliencie generacji → błąd dla konsumenta.
  static func mapped(_ error: TransportError, _ ticket: GenerationTicket) -> TransportError {
    if Task.isCancelled { return .cancelled }
    if error == .cancelled, ticket.closedByRuntime { return .offline(.networkConnectionLost) }
    return error
  }

  /// Jedno wywołanie na kliencie bieżącej generacji, między `begin()` i `end()` biletu.
  private func call<T>(
    _ work: (RarogClient) async throws(TransportError) -> T
  ) async throws(TransportError) -> T {
    let generation = try await admitted()
    defer { generation.ticket.end() }
    do {
      return try await work(generation.client)
    } catch {
      throw Self.mapped(error, generation.ticket)
    }
  }

  // MARK: - REST

  public func version() async throws(TransportError) -> VersionInfo {
    try await call { client throws(TransportError) in try await client.version() }
  }

  public func decidePermission(
    sessionId: String, permId: String, _ body: PermissionDecisionBody
  ) async throws(TransportError) {
    try await call { client throws(TransportError) in
      try await client.decidePermission(sessionId: sessionId, permId: permId, body)
    }
  }

  public func presence(_ body: PresenceBody) async throws(TransportError) {
    try await call { client throws(TransportError) in try await client.presence(body) }
  }

  public func clientLog(_ body: ClientLogBody) async throws(TransportError) {
    try await call { client throws(TransportError) in try await client.clientLog(body) }
  }

  public func usage() async throws(TransportError) -> PlanUsage {
    try await call { client throws(TransportError) in try await client.usage() }
  }

  public func usageDetails() async throws(TransportError) -> PlanUsage {
    try await call { client throws(TransportError) in try await client.usageDetails() }
  }

  public func recentProjects() async throws(TransportError) -> RecentProjectList {
    try await call { client throws(TransportError) in try await client.recentProjects() }
  }

  public func createSession(_ body: CreateSessionBody) async throws(TransportError) -> CreateSessionResponse {
    try await call { client throws(TransportError) in try await client.createSession(body) }
  }

  public func closeSession(sessionId: String, _ body: CloseSessionBody) async throws(TransportError) {
    try await call { client throws(TransportError) in try await client.closeSession(sessionId: sessionId, body) }
  }

  public func models() async throws(TransportError) -> ModelList {
    try await call { client throws(TransportError) in try await client.models() }
  }

  public func commands(sessionId: String) async throws(TransportError) -> CommandList {
    try await call { client throws(TransportError) in try await client.commands(sessionId: sessionId) }
  }

  public func setSessionModel(
    sessionId: String, _ body: SessionModelBody
  ) async throws(TransportError) -> SessionModelAccepted {
    try await call { client throws(TransportError) in try await client.setSessionModel(sessionId: sessionId, body) }
  }

  public func setSessionMode(sessionId: String, _ body: SessionModeBody) async throws(TransportError) {
    try await call { client throws(TransportError) in try await client.setSessionMode(sessionId: sessionId, body) }
  }

  public func restartSession(
    sessionId: String, resend: SessionPromptBlocked?
  ) async throws(TransportError) -> RestartResponse {
    try await call { client throws(TransportError) in
      try await client.restartSession(sessionId: sessionId, resend: resend)
    }
  }

  public func sessionDiff(sessionId: String) async throws(TransportError) -> SessionDiff {
    try await call { client throws(TransportError) in try await client.sessionDiff(sessionId: sessionId) }
  }

  public func sessionDiffFiles(sessionId: String) async throws(TransportError) -> DiffFileList {
    try await call { client throws(TransportError) in try await client.sessionDiffFiles(sessionId: sessionId) }
  }

  public func sessionDiffFile(sessionId: String, path: String) async throws(TransportError) -> DiffFilePatch {
    try await call { client throws(TransportError) in
      try await client.sessionDiffFile(sessionId: sessionId, path: path)
    }
  }

  public func answerQuestion(sessionId: String, qId: String, _ body: AnswersBody) async throws(TransportError) {
    try await call { client throws(TransportError) in
      try await client.answerQuestion(sessionId: sessionId, qId: qId, body)
    }
  }

  public func decideDialog(sessionId: String, _ body: PermissionDecisionBody) async throws(TransportError) {
    try await call { client throws(TransportError) in try await client.decideDialog(sessionId: sessionId, body) }
  }

  public func resumeSession(sessionId: String) async throws(TransportError) -> ResumeResponse {
    try await call { client throws(TransportError) in try await client.resumeSession(sessionId: sessionId) }
  }

  public func interruptSession(sessionId: String) async throws(TransportError) -> InterruptResponse {
    try await call { client throws(TransportError) in try await client.interruptSession(sessionId: sessionId) }
  }

  public func markSeen(sessionId: String) async throws(TransportError) {
    try await call { client throws(TransportError) in try await client.markSeen(sessionId: sessionId) }
  }

  public func markUnseen(sessionId: String) async throws(TransportError) {
    try await call { client throws(TransportError) in try await client.markUnseen(sessionId: sessionId) }
  }

  public func directory(_ path: String?) async throws(TransportError) -> DirListing {
    try await call { client throws(TransportError) in try await client.directory(path) }
  }

  public func resumable(cwd: String) async throws(TransportError) -> ResumableList {
    try await call { client throws(TransportError) in try await client.resumable(cwd: cwd) }
  }

  public func makeDirectory(_ body: MakeDirBody) async throws(TransportError) -> DirEntry {
    try await call { client throws(TransportError) in try await client.makeDirectory(body) }
  }

  public func recentResumable(cwd: String) async throws(TransportError) -> ResumableList {
    try await call { client throws(TransportError) in try await client.recentResumable(cwd: cwd) }
  }

  public func uploadImage(sessionId: String, file: String) async throws(TransportError) -> Data {
    try await call { client throws(TransportError) in try await client.uploadImage(sessionId: sessionId, file: file) }
  }

  public func voiceToken() async throws(TransportError) -> VoiceToken {
    try await call { client throws(TransportError) in try await client.voiceToken() }
  }

  public func companionToken() async throws(TransportError) -> CompanionToken {
    try await call { client throws(TransportError) in try await client.companionToken() }
  }

  public func companionAsk(
    sessionId: String, _ body: CompanionAskBody
  ) async throws(TransportError) -> CompanionAnswer {
    try await call { client throws(TransportError) in try await client.companionAsk(sessionId: sessionId, body) }
  }

  public func companionSpeechToken() async throws(TransportError) -> CompanionSpeechToken {
    try await call { client throws(TransportError) in try await client.companionSpeechToken() }
  }

  public func takeBackQueue(sessionId: String, operationId: UUID) async throws(TransportError) -> QueueTakeBackResponse {
    try await call { client throws(TransportError) in
      try await client.takeBackQueue(sessionId: sessionId, operationId: operationId)
    }
  }

  public func registerApns(
    token: String, environment: ApnsEnvironment, topic: String?, alerts: Bool, test: Bool
  ) async throws(TransportError) {
    try await call { client throws(TransportError) in
      try await client.registerApns(token: token, environment: environment, topic: topic, alerts: alerts, test: test)
    }
  }

  public func apnsStatus(token: String) async throws(TransportError) -> ApnsStatus {
    try await call { client throws(TransportError) in try await client.apnsStatus(token: token) }
  }

  public func registerLiveActivity(_ body: LiveActivityRegisterBody) async throws(TransportError) {
    try await call { client throws(TransportError) in try await client.registerLiveActivity(body) }
  }

  public func endLiveActivity(_ body: LiveActivityEndBody) async throws(TransportError) {
    try await call { client throws(TransportError) in try await client.endLiveActivity(body) }
  }

  public func notes(cwd: String) async throws(TransportError) -> NotesDoc {
    try await call { client throws(TransportError) in try await client.notes(cwd: cwd) }
  }

  public func saveNotes(_ body: NotesPutBody) async throws(TransportError) -> NotesSaveResult {
    try await call { client throws(TransportError) in try await client.saveNotes(body) }
  }

  public func mac() async throws(TransportError) -> MacLoad {
    try await call { client throws(TransportError) in try await client.mac() }
  }

  public func pair(_ body: PairBody) async throws(TransportError) -> PairResponse {
    defer { afterPair?() }
    return try await call { client throws(TransportError) in try await client.pair(body) }
  }

  public func issuePairingCode() async throws(TransportError) -> PairingIssued {
    try await call { client throws(TransportError) in try await client.issuePairingCode() }
  }

  public func cancelPairingCode() async throws(TransportError) {
    try await call { client throws(TransportError) in try await client.cancelPairingCode() }
  }

  public func devices() async throws(TransportError) -> DeviceList {
    try await call { client throws(TransportError) in try await client.devices() }
  }

  public func forgetDevice() async throws(TransportError) {
    try await call { client throws(TransportError) in try await client.forgetDevice() }
  }

  // MARK: - Strumień SSE

  /// Strumień trzyma bilet generacji do swojego końca. Błąd w trakcie iteracji przy zamknięciu generacji przez
  /// runtime przychodzi jako `.offline`, więc nadzorca wraca do pętli i dostaje następną generację.
  public func openStream(
    _ scope: StreamScope, lastEventId: String?, watch: StreamStallGuard
  ) async throws(TransportError) -> AsyncThrowingStream<SSEParser.Output, any Error> {
    let generation = try await admitted()
    let ticket = generation.ticket
    let inner: AsyncThrowingStream<SSEParser.Output, any Error>
    do {
      inner = try await generation.client.openStream(scope, lastEventId: lastEventId, watch: watch)
    } catch {
      ticket.end()
      throw Self.mapped(error, ticket)
    }
    let (stream, continuation) = AsyncThrowingStream<SSEParser.Output, any Error>.makeStream()
    let forward = Task {
      defer { ticket.end() }
      do {
        for try await output in inner { continuation.yield(output) }
        continuation.finish()
      } catch {
        let failure = error as? TransportError ?? .invalidResponse(String(describing: error))
        continuation.finish(throwing: Self.mapped(failure, ticket))
      }
    }
    continuation.onTermination = { _ in forward.cancel() }
    return stream
  }

  // MARK: - Wysyłka

  public func sendMessage(
    sessionId: String, _ upload: MessageUpload, timeout: Duration?, progress: (@Sendable (UploadProgress) -> Void)?
  ) async throws(TransportError) -> MessageAccepted? {
    let deadline = timing.now() + (timeout ?? requestTimeout)
    return try await bounded(by: deadline) { [self] () async throws(TransportError) -> MessageAccepted? in
      let generation = try await admitted()
      if case .file = upload.body, generation.choice == .iroh {
        generation.ticket.end()
        return try await sendThroughDoor(sessionId: sessionId, upload, deadline: deadline, progress: progress)
      }
      defer { generation.ticket.end() }
      do throws(TransportError) {
        return try await generation.client.sendMessage(
          sessionId: sessionId, upload, timeout: left(until: deadline), progress: progress)
      } catch {
        throw Self.mapped(error, generation.ticket)
      }
    }
  }

  /// Wysyłka z załącznikiem własnymi drzwiami uploadu; drzwi zamyka zawsze przed powrotem.
  private func sendThroughDoor(
    sessionId: String, _ upload: MessageUpload, deadline: ContinuousClock.Instant,
    progress: (@Sendable (UploadProgress) -> Void)?
  ) async throws(TransportError) -> MessageAccepted? {
    let door: UploadDoor
    do {
      door = try await source.openUploadDoor(left(until: deadline))
    } catch {
      if Task.isCancelled { throw .cancelled }
      if let failure = error as? TunnelFailure, failure == .timedOut { throw .timedOut }
      throw Self.noGeneration
    }
    guard door.ticket.begin() else {
      await Self.close(door, code: 0)
      throw Self.noGeneration
    }
    let result: Result<MessageAccepted?, TransportError>
    do {
      result = .success(try await door.client.sendMessage(
        sessionId: sessionId, upload, timeout: left(until: deadline), progress: progress))
    } catch {
      result = .failure(Self.mapped(error, door.ticket))
    }
    door.ticket.end()
    await Self.close(door, code: Self.interrupted(result) ? 1 : 0)
    return try result.get()
  }

  /// Upload przerwany przed odpowiedzią serwera (anulowanie, limit, zerwanie).
  private static func interrupted(_ result: Result<MessageAccepted?, TransportError>) -> Bool {
    guard case let .failure(error) = result else { return false }
    switch error {
    case .cancelled, .timedOut, .offline: return true
    case .unauthorized, .forbidden, .rateLimited, .http, .refused, .invalidResponse: return false
    }
  }

  /// Zamknięcie drzwi w osobnym zadaniu: anulowanie wołającego nie skraca terminów zamykania.
  private static func close(_ door: UploadDoor, code: UInt64) async {
    await Task { await door.close(code) }.value
  }

  private func left(until deadline: ContinuousClock.Instant) -> Duration {
    max(.zero, timing.now().duration(to: deadline))
  }

  /// Praca z limitem całego czasu na zegarze przełącznika: po terminie zadanie jest anulowane, a błąd to
  /// `.timedOut`; anulowanie wołającego anuluje pracę (`.cancelled`).
  private func bounded<T: Sendable>(
    by deadline: ContinuousClock.Instant,
    _ work: @escaping @Sendable () async throws(TransportError) -> T
  ) async throws(TransportError) -> T {
    let budget = left(until: deadline)
    guard budget > .zero else { throw .timedOut }
    let expired = Mutex(false)
    let task = Task { () async -> Result<T, TransportError> in
      do throws(TransportError) {
        return .success(try await work())
      } catch {
        return .failure(error)
      }
    }
    let sleep = timing.sleep
    let timer = Task {
      do { try await sleep(budget) } catch { return }
      expired.withLock { $0 = true }
      task.cancel()
    }
    defer { timer.cancel() }
    let result = await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      task.cancel()
    }
    switch result {
    case let .success(value):
      return value
    case let .failure(error):
      if Task.isCancelled { throw .cancelled }
      if expired.withLock({ $0 }) { throw .timedOut }
      throw error
    }
  }

  // MARK: - Terminal

  public func openTerminal(_ body: TerminalOpenBody) async throws(TransportError) -> TerminalOpenResponse {
    try await call { client throws(TransportError) in try await client.openTerminal(body) }
  }

  public func terminals() async throws(TransportError) -> TerminalList {
    try await call { client throws(TransportError) in try await client.terminals() }
  }

  public func terminalHistory(id: String, lines: Int) async throws(TransportError) -> TerminalHistory {
    try await call { client throws(TransportError) in try await client.terminalHistory(id: id, lines: lines) }
  }

  public func closeTerminal(id: String) async throws(TransportError) {
    try await call { client throws(TransportError) in try await client.closeTerminal(id: id) }
  }

  /// Bramka zgodności wejścia terminala na kliencie bieżącej generacji. Czekanie na generację przerwane albo
  /// nieudane NIE jest niezgodnością: metoda wraca bez błędu, a ``terminalSocket(id:fresh:direct:grid:)`` rzuca
  /// błąd transportu, więc terminal ponawia.
  public func checkTerminalInput() async throws(MutationRefusal) {
    let generation: TunnelGeneration
    do {
      generation = try await admitted()
    } catch {
      return
    }
    defer { generation.ticket.end() }
    try await generation.client.checkTerminalInput()
  }

  /// Gniazdo na generacji z ostatniego udanego czekania (``checkTerminalInput()`` je poprzedza). Bez żywej generacji
  /// rzuca `.offline`; gniazdo trzyma bilet do swojego końca.
  public func terminalSocket(
    id: String, fresh: Bool, direct: Bool, grid: TerminalGrid?
  ) throws(TransportError) -> any TerminalSocketing {
    guard let generation = state.withLock({ $0.current }), generation.ticket.begin() else { throw Self.noGeneration }
    do {
      let socket = try generation.client.terminalSocket(id: id, fresh: fresh, direct: direct, grid: grid)
      return TicketedTerminalSocket(socket, ticket: generation.ticket)
    } catch {
      generation.ticket.end()
      throw Self.mapped(error, generation.ticket)
    }
  }
}

/// Gniazdo terminala z biletem generacji: bilet wraca po końcu zdarzeń gniazda (`closed`).
final class TicketedTerminalSocket: TerminalSocketing {
  let events: AsyncStream<TerminalSocketEvent>
  private let inner: any TerminalSocketing

  init(_ inner: any TerminalSocketing, ticket: GenerationTicket) {
    self.inner = inner
    let (events, continuation) = AsyncStream<TerminalSocketEvent>.makeStream()
    self.events = events
    Task {
      for await event in inner.events { continuation.yield(event) }
      continuation.finish()
      ticket.end()
    }
  }

  func send(_ frame: TerminalClientFrame) async -> Bool {
    await inner.send(frame)
  }

  func close() {
    inner.close()
  }
}
