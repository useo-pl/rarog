import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

// Dyktowanie: klucz tymczasowy z magazynu i stan Soniox na serwerze.
// Właściciel: dyktowanie.

private let tokenJSON = #"""
  {"apiKey":"tmp-key","expiresAt":"2026-08-23T12:00:00.000Z",
   "webSocketUri":"wss://stt-rt.eu.soniox.com/transcribe-websocket","model":"stt-rt-v6","maxSessionSeconds":900,
   "config":{"languageHints":["pl","en"],"audioFormat":"pcm_s16le","sampleRate":16000,"numChannels":1}}
  """#

private func sampleToken() -> VoiceToken {
  // swiftlint:disable:next force_try
  try! JSONDecoder().decode(VoiceToken.self, from: Data(tokenJSON.utf8))
}

private func versionInfo(voice: String?) -> VersionInfo {
  let field = voice.map { #","voiceEnabled":\#($0)"# } ?? ""
  let json = #"{"version":"0.1.0","protocolVersion":3,"serverStartId":"s","tailnet":null\#(field)}"#
  // swiftlint:disable:next force_try
  return try! JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
}

/// Atrapa z kontrolą `POST /api/voice/token`; strumienie i reszta z `FakeTransport`. Mutacja idzie
/// przez bramkę atrapy bazowej — jak w `RarogClient`.
final class VoiceProbe: RarogTransporting, @unchecked Sendable {
  struct Probe {
    var result: Result<VoiceToken, TransportError> = .success(sampleToken())
    var calls = 0
    /// Żądanie czeka na `release()` (spóźniona odpowiedź); anulowanie kończy je `.cancelled`.
    var hold = false
    var held: [CheckedContinuation<Void, Never>] = []
    /// Agent głosowy (`VoiceAgentSessionStoreTests`): klucz krótki i pytanie o sesję; `hold` jak wyżej.
    var companion: Result<CompanionToken, TransportError> = .failure(.http(APIFailure(status: 404)))
    var companionCalls = 0
    var answer: Result<CompanionAnswer, TransportError> = .failure(.http(APIFailure(status: 404)))
    var asks: [(sessionId: String, body: CompanionAskBody)] = []
    /// Soniox speech key of the voice agent; `hold` as above.
    var speech: Result<CompanionSpeechToken, TransportError> = .failure(.http(APIFailure(status: 404)))
    var speechCalls = 0
  }

  let base: FakeTransport
  let probe = Mutex(Probe())

  init(base: FakeTransport = FakeTransport()) {
    self.base = base
  }

  var calls: Int { probe.withLock { $0.calls } }
  func set(_ change: (inout Probe) -> Void) { probe.withLock { change(&$0) } }

  func release() {
    let waiting = probe.withLock { state in
      defer { state.held = [] }
      return state.held
    }
    for continuation in waiting { continuation.resume() }
  }

  func voiceToken() async throws(TransportError) -> VoiceToken {
    if let gate = base.gate {
      do {
        try await gate.check(method: "POST", path: "/api/voice/token")
      } catch {
        throw .refused(error)
      }
    }
    let (result, hold) = probe.withLock { state in
      state.calls += 1
      return (state.result, state.hold)
    }
    if hold {
      await withCheckedContinuation { continuation in probe.withLock { $0.held.append(continuation) } }
      // Jak `URLSession`: anulowane zadanie kończy się błędem anulowania, nie odpowiedzią.
      if Task.isCancelled { throw .cancelled }
    }
    return try result.get()
  }

  func companionToken() async throws(TransportError) -> CompanionToken {
    try await gated("/api/companion/token")
    let (result, hold) = probe.withLock { state in
      state.companionCalls += 1
      return (state.companion, state.hold)
    }
    try await wait(hold)
    return try result.get()
  }

  func companionSpeechToken() async throws(TransportError) -> CompanionSpeechToken {
    try await gated("/api/companion/speech-token")
    let (result, hold) = probe.withLock { state in
      state.speechCalls += 1
      return (state.speech, state.hold)
    }
    try await wait(hold)
    return try result.get()
  }

  func companionAsk(sessionId: String, _ body: CompanionAskBody) async throws(TransportError) -> CompanionAnswer {
    try await gated("/api/sessions/\(sessionId)/companion/ask")
    let (result, hold) = probe.withLock { state in
      state.asks.append((sessionId, body))
      return (state.answer, state.hold)
    }
    try await wait(hold)
    return try result.get()
  }

  private func gated(_ path: String) async throws(TransportError) {
    guard let gate = base.gate else { return }
    do {
      try await gate.check(method: "POST", path: path)
    } catch {
      throw .refused(error)
    }
  }

  private func wait(_ hold: Bool) async throws(TransportError) {
    guard hold else { return }
    await withCheckedContinuation { continuation in probe.withLock { $0.held.append(continuation) } }
    if Task.isCancelled { throw .cancelled }
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

/// Magazyn z atrapą klucza, zalogowany, po `hello` (bramka zgodności przepuszcza mutacje).
@MainActor
private func voiceStore(
  credential: Bool = true, background: FakeBackgroundWork? = nil
) async -> (RarogStore, VoiceProbe) {
  let probe = VoiceProbe(base: FakeTransport(credential: credential))
  let rules = MutationRules(timing: fastTiming)
  probe.base.gate = MutationGate(policy: rules)
  let store = RarogStore(transport: probe, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
  if let background {
    store.attachSystem(push: FakePushSystem(), background: background, preferences: MemoryPreferences())
  }
  await store.start()
  guard credential else { return (store, probe) }
  await until("online") { store.state.global == .online }
  probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
  await until("hello") { store.state.compat == .ok }
  return (store, probe)
}

extension StoreVoiceTests {
  /// Soniox state on the server from the reducer, with "unknown" kept apart. Nested in `StoreVoiceTests` so that a
  /// test filter on `StoreVoiceTests` covers it.
  @Suite("reduktor: stan Soniox na serwerze")
  struct ServerState {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    @Test("przed sondą unknown; voiceEnabled false = unavailable; true i brak pola (starszy serwer) = available")
    func capabilities() {
      var state = AppState(clientBuild: 1)
      #expect(state.sonioxOnServer == .unknown, "przed sondą nie wiadomo")
      state.apply(.versionProbed(versionInfo(voice: "false")), now: t0)
      #expect(state.sonioxOnServer == .unavailable)
      state.apply(.versionProbed(versionInfo(voice: "true")), now: t0)
      #expect(state.sonioxOnServer == .available)
      state.apply(.versionProbed(versionInfo(voice: nil)), now: t0)
      #expect(state.sonioxOnServer == .available)
    }

    @Test("odmowa przy mincie = unavailable do restartu serwera, nie do kolejnej sondy")
    func refusalUntilRestart() throws {
      var state = AppState(clientBuild: 1)
      state.apply(.frame(try Frames.decode(#"{"type":"hello","protocolVersion":3,"serverStartId":"a"}"#), source: .global, cursor: nil), now: t0)
      state.apply(.versionProbed(versionInfo(voice: nil)), now: t0)
      state.apply(.voice(.serverDisabled), now: t0)
      #expect(state.sonioxOnServer == .unavailable)
      state.apply(.versionProbed(versionInfo(voice: nil)), now: t0)
      #expect(state.sonioxOnServer == .unavailable, "sonda tego samego procesu nie zdejmuje odmowy")
      state.apply(.frame(try Frames.decode(#"{"type":"hello","protocolVersion":3,"serverStartId":"b"}"#), source: .global, cursor: nil), now: t0)
      #expect(state.sonioxOnServer == .available, "nowy proces serwera — sonda mówi, czy klucz jest")
    }

    @Test("odmowa przy mincie przed odpowiedzią sondy = unavailable; nowy proces serwera wraca do unknown")
    func refusalBeforeProbe() throws {
      var state = AppState(clientBuild: 1)
      state.apply(.frame(try Frames.decode(#"{"type":"hello","protocolVersion":3,"serverStartId":"a"}"#), source: .global, cursor: nil), now: t0)
      #expect(state.sonioxOnServer == .unknown)
      state.apply(.voice(.serverDisabled), now: t0)
      #expect(state.sonioxOnServer == .unavailable, "mint rozstrzyga także przed sondą")
      state.apply(.frame(try Frames.decode(#"{"type":"hello","protocolVersion":3,"serverStartId":"b"}"#), source: .global, cursor: nil), now: t0)
      #expect(state.sonioxOnServer == .unknown)
    }

    @Test("wylogowanie kasuje odmowę przy mincie razem z resztą wiedzy o serwerze")
    func logoutClearsRefusal() throws {
      var state = AppState(clientBuild: 1)
      state.apply(.voice(.serverDisabled), now: t0)
      #expect(state.sonioxOnServer == .unavailable, "odmowa przed hello: proces serwera nieznany")
      state.apply(.loggedOut(.notLoggedIn), now: t0)
      #expect(state.voice.refusal == nil)
      #expect(state.sonioxOnServer == .unknown)
    }
  }
}

@MainActor
@Suite("magazyn: klucz dyktowania")
struct StoreVoiceTests {
  @Test("klucz z serwera; każde wywołanie to nowe żądanie (klucz jednorazowy)")
  func mint() async {
    let (store, probe) = await voiceStore()
    #expect(await store.mintVoiceToken() == .token(sampleToken()))
    #expect(await store.mintVoiceToken() == .token(sampleToken()))
    #expect(probe.calls == 2)
  }

  @Test("odmowę zapisuje tylko 404 i 503 voice_unconfigured; inne 503, 429, 502 i sieć = bez odmowy")
  func refusals() async {
    let cases: [(TransportError, VoiceTokenOutcome, SonioxServerState)] = [
      (.rateLimited(APIFailure(status: 429, message: "Za szybko.")), .rateLimited(message: "Za szybko."), .available),
      (.http(APIFailure(status: 502, code: "voice_upstream", message: "Soniox milczy.")), .failed(message: "Soniox milczy."), .available),
      (.offline(.notConnectedToInternet), .failed(message: nil), .available),
      // 503 bez ciała API (np. reverse proxy) i 503 z innym kodem: awaria przejściowa, nie brak klucza.
      (.http(APIFailure(status: 503)), .failed(message: nil), .available),
      (.http(APIFailure(status: 503, code: "voice_upstream", message: "Chwilowa awaria.")), .failed(message: "Chwilowa awaria."), .available),
      (.http(APIFailure(status: 503, code: "voice_unconfigured", message: "Brak klucza.")), .disabled(message: "Brak klucza."), .unavailable),
      (.http(APIFailure(status: 404)), .disabled(message: nil), .unavailable),
    ]
    for (error, expected, server) in cases {
      // Osobny magazyn na przypadek: odmowa jednego nie zasłania wyniku następnego.
      let (store, probe) = await voiceStore()
      store.areaDispatch(.versionProbed(versionInfo(voice: nil)))
      #expect(store.state.sonioxOnServer == .available)
      probe.set { $0.result = .failure(error) }
      #expect(await store.mintVoiceToken() == expected, "\(error)")
      #expect(store.state.sonioxOnServer == server, "\(error)")
    }
  }

  @Test("bez zalogowania żądanie nie wychodzi")
  func loggedOut() async {
    let (store, probe) = await voiceStore(credential: false)
    #expect(await store.mintVoiceToken() == .loggedOut)
    #expect(probe.calls == 0)
  }

  @Test("401 wylogowuje; wylogowanie w trakcie odcina spóźniony klucz i anuluje żądanie")
  func lateAfterLogout() async {
    let (store, probe) = await voiceStore()
    probe.set { $0.hold = true }
    let pending = Task { await store.mintVoiceToken() }
    await until("żądanie w drodze") { probe.calls == 1 }
    // Strumień dostaje 401: wylogowanie anuluje klucz w drodze.
    probe.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    probe.release()
    #expect(await pending.value == .loggedOut)

    // Nowe logowanie: wynik sprzed niego już niczego nie dotknie, nowe żądania działają.
    probe.set { $0.hold = false }
    store.enterLoggedIn()
    await until("online") { store.state.global == .online }
    probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    await until("hello") { store.state.compat == .ok }
    #expect(await store.mintVoiceToken() == .token(sampleToken()))

    probe.set { $0.result = .failure(.unauthorized(APIFailure(status: 401))) }
    #expect(await store.mintVoiceToken() == .loggedOut)
    #expect(store.state.auth == .loggedOut(.deviceUnknown))
  }

  @Test("każde pobranie klucza (start i ponowna próba) w osobnej pracy w tle z needsServer, na czas żądania")
  func mintInBackgroundWork() async {
    let log = EventLog()
    let work = FakeBackgroundWork(log: log)
    let (store, probe) = await voiceStore(background: work)
    probe.set { $0.hold = true }
    let first = Task { await store.mintVoiceToken() }
    await until("żądanie w drodze") { probe.calls == 1 }
    #expect(log.all == ["begin rarog.voice-token"], "praca zaczęta przed odpowiedzią, jeszcze otwarta")
    probe.release()
    #expect(await first.value == .token(sampleToken()))
    #expect(log.all == ["begin rarog.voice-token", "end 1"])

    // Ponowna próba (nowy strumień Soniox): nowy klucz, nowa praca.
    probe.set { $0.hold = false; $0.result = .failure(.offline(.notConnectedToInternet)) }
    #expect(await store.mintVoiceToken() == .failed(message: nil))
    #expect(log.all == ["begin rarog.voice-token", "end 1", "begin rarog.voice-token", "end 2"], "błąd też kończy pracę")
    #expect(work.needsServer("rarog.voice-token") == [true, true])
  }

  @Test("anulowane pobranie klucza kończy swoją pracę w tle; bez zalogowania praca nie startuje")
  func mintWorkEndsOnCancel() async {
    let log = EventLog()
    let (store, probe) = await voiceStore(background: FakeBackgroundWork(log: log))
    probe.set { $0.hold = true }
    let pending = Task { await store.mintVoiceToken() }
    await until("żądanie w drodze") { probe.calls == 1 }
    pending.cancel()
    probe.release()
    #expect(await pending.value == .cancelled)
    #expect(log.all == ["begin rarog.voice-token", "end 1"])

    let outLog = EventLog()
    let (outStore, _) = await voiceStore(credential: false, background: FakeBackgroundWork(log: outLog))
    #expect(await outStore.mintVoiceToken() == .loggedOut)
    #expect(outLog.all.isEmpty)
  }

  @Test("koniec dyktowania anuluje żądanie klucza")
  func cancelled() async {
    let (store, probe) = await voiceStore()
    probe.set { $0.hold = true }
    let pending = Task { await store.mintVoiceToken() }
    await until("żądanie w drodze") { probe.calls == 1 }
    pending.cancel()
    probe.release()
    #expect(await pending.value == .cancelled)
  }
}
