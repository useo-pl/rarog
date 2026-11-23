import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// The voice agent at a session in the store: the OpenAI ephemeral key and the question about the session.
// Refusals by code; a result belongs to the login in which the request went out. Fake: `VoiceProbe` (routes of the
// key and the question). A voice send of the message field is the ordinary send of the field (`RarogStore+Send`).
// Owner: voice agent.

private let tokenJSON = #"{"value":"ek_test_zzzzzzzz","expiresAt":"2026-11-10T12:01:00.000Z","model":"gpt-realtime-2.1"}"#

private func sampleCompanionToken() -> CompanionToken {
  // swiftlint:disable:next force_try
  try! JSONDecoder().decode(CompanionToken.self, from: Data(tokenJSON.utf8))
}

private let speechJSON =
  #"{"apiKey":"temp:test-qqqqqqqq","expiresAt":"2026-11-11T12:10:00.000Z","#
  + #""webSocketUri":"wss://tts-rt.eu.soniox.com/tts-websocket","model":"tts-rt-v2","voice":"Maya","sampleRate":24000}"#

private func sampleSpeechToken() -> CompanionSpeechToken {
  // swiftlint:disable:next force_try
  try! JSONDecoder().decode(CompanionSpeechToken.self, from: Data(speechJSON.utf8))
}

private func sampleAnswer(_ json: String = #"{"answer":"It was fixed in turn 2.","found":true}"#) -> CompanionAnswer {
  // swiftlint:disable:next force_try
  try! JSONDecoder().decode(CompanionAnswer.self, from: Data(json.utf8))
}

/// Magazyn z atrapą tras agenta, zalogowany, po `hello` (bramka zgodności przepuszcza mutacje).
@MainActor
private func companionStore() async -> (RarogStore, VoiceProbe) {
  let probe = VoiceProbe(base: FakeTransport())
  let rules = MutationRules(timing: fastTiming)
  probe.base.gate = MutationGate(policy: rules)
  let store = RarogStore(transport: probe, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
  await store.start()
  await until("online") { store.state.global == .online }
  probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
  await until("hello") { store.state.compat == .ok }
  probe.set {
    $0.companion = .success(sampleCompanionToken())
    $0.speech = .success(sampleSpeechToken())
    $0.answer = .success(sampleAnswer())
  }
  return (store, probe)
}

@MainActor
private func relogin(_ store: RarogStore, _ probe: VoiceProbe) async {
  store.enterLoggedIn()
  await until("online") { store.state.global == .online }
  probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
  await until("hello") { store.state.compat == .ok }
}

@MainActor
@Suite("magazyn: agent głosowy przy sesji (VoiceAgentSession)")
struct VoiceAgentSessionStoreTests {
  @Test("companionEnabled true = rozmowa dostępna; false i brak pola (starszy serwer) = brak przycisku")
  func capability() throws {
    func caps(_ field: String) throws -> Capabilities {
      let json = #"{"version":"1","protocolVersion":3,"serverStartId":"s"\#(field)}"#
      return Capabilities(try JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8)))
    }
    #expect(try caps(#","companionEnabled":true"#).companion)
    #expect(try !caps(#","companionEnabled":false"#).companion)
    #expect(try !caps("").companion)
  }

  @Test("companionSpeech true = Soniox voice; false and a missing field (older server) = the OpenAI voice")
  func speechCapability() throws {
    func caps(_ field: String) throws -> Capabilities {
      let json = #"{"version":"1","protocolVersion":3,"serverStartId":"s","companionEnabled":true\#(field)}"#
      return Capabilities(try JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8)))
    }
    #expect(try caps(#","companionSpeech":true"#).companionSpeech)
    #expect(try !caps(#","companionSpeech":false"#).companionSpeech)
    #expect(try !caps("").companionSpeech)
  }

  @Test("speech key from the server; every call is a new request; its description hides the key")
  func speechMint() async {
    let (store, probe) = await companionStore()
    #expect(await store.mintCompanionSpeechToken() == .token(sampleSpeechToken()))
    #expect(await store.mintCompanionSpeechToken() == .token(sampleSpeechToken()))
    #expect(probe.probe.withLock { $0.speechCalls } == 2)
    let outcome = await store.mintCompanionSpeechToken()
    for text in [String(describing: outcome), String(reflecting: outcome)] {
      #expect(!text.contains(sampleSpeechToken().apiKey), "key in the description: \(text)")
    }
  }

  @Test("speech key refusals by code: off, throttle and an upstream failure are different outcomes")
  func speechRefusals() async {
    let cases: [(TransportError, CompanionSpeechTokenOutcome)] = [
      (
        .http(APIFailure(status: 503, code: "companion-speech-unconfigured", message: "Off.")),
        .disabled(message: "Off.")
      ),
      (.http(APIFailure(status: 404)), .disabled(message: nil)),
      (
        .rateLimited(APIFailure(status: 429, code: "companion-speech-throttled", message: "Soon.")),
        .throttled(message: "Soon.")
      ),
      (
        .http(APIFailure(status: 502, code: "companion-speech-upstream", message: "No key.")),
        .unavailable(message: "No key.")
      ),
      // A 503 without a code (reverse proxy) is a passing failure, not a feature switched off.
      (.http(APIFailure(status: 503)), .unavailable(message: nil)),
      (.offline(.notConnectedToInternet), .unavailable(message: nil)),
      (.timedOut, .unavailable(message: nil)),
    ]
    for (error, expected) in cases {
      let (store, probe) = await companionStore()
      probe.set { $0.speech = .failure(error) }
      #expect(await store.mintCompanionSpeechToken() == expected, "\(error)")
      #expect(store.state.auth == .loggedIn)
    }
  }

  @Test("speech key 401 logs out like the OpenAI key")
  func speech401() async {
    let unauthorized = TransportError.unauthorized(APIFailure(status: 401))
    let (openAI, openAIProbe) = await companionStore()
    openAIProbe.set { $0.companion = .failure(unauthorized) }
    #expect(await openAI.mintCompanionToken() == .loggedOut)
    let (soniox, sonioxProbe) = await companionStore()
    sonioxProbe.set { $0.speech = .failure(unauthorized) }
    #expect(await soniox.mintCompanionSpeechToken() == .loggedOut)
    #expect(soniox.state.auth == openAI.state.auth)
    #expect(soniox.state.auth != .loggedIn)
  }

  @Test("a late speech key 200 after logout: the conversation does not get a key of the old login")
  func lateSpeechTokenAfterLogout() async {
    let (store, probe) = await companionStore()
    probe.set { $0.hold = true }
    let pending = Task { await store.mintCompanionSpeechToken() }
    await until("request in flight") { probe.probe.withLock { $0.speechCalls } == 1 }
    probe.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("logout") { store.state.auth != .loggedIn }
    probe.release()
    #expect(await pending.value == .loggedOut)
  }

  @Test("a late speech key 200 after a new login: the key belongs to the old login")
  func lateSpeechTokenAfterRelogin() async {
    let (store, probe) = await companionStore()
    probe.set { $0.hold = true }
    let pending = Task { await store.mintCompanionSpeechToken() }
    await until("request in flight") { probe.probe.withLock { $0.speechCalls } == 1 }
    probe.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("logout") { store.state.auth != .loggedIn }
    await relogin(store, probe)
    probe.release()
    #expect(await pending.value == .loggedOut)
    #expect(store.state.auth == .loggedIn)
  }

  @Test("a late speech key 401 after a new login does not log out the new login")
  func lateSpeech401DoesNotLogOutNewLogin() async {
    let (store, probe) = await companionStore()
    probe.set {
      $0.hold = true
      $0.speech = .failure(.unauthorized(APIFailure(status: 401)))
    }
    let pending = Task { await store.mintCompanionSpeechToken() }
    await until("request in flight") { probe.probe.withLock { $0.speechCalls } == 1 }
    probe.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("logout") { store.state.auth != .loggedIn }
    await relogin(store, probe)
    probe.release()
    #expect(await pending.value == .loggedOut)
    #expect(store.state.auth == .loggedIn, "the late 401 belongs to the old login")
  }

  @Test("klucz krótki z serwera; każde wywołanie to nowe żądanie")
  func mint() async {
    let (store, probe) = await companionStore()
    #expect(await store.mintCompanionToken() == .token(sampleCompanionToken()))
    #expect(await store.mintCompanionToken() == .token(sampleCompanionToken()))
    #expect(probe.probe.withLock { $0.companionCalls } == 2)
  }

  @Test("odmowy klucza po kodzie: wyłączone, zły klucz, dławik, limit OpenAI i 502 to różne wyniki")
  func tokenRefusals() async {
    let cases: [(TransportError, CompanionTokenOutcome)] = [
      (.http(APIFailure(status: 503, code: "companion-disabled", message: "Off.")), .disabled(message: "Off.")),
      (.http(APIFailure(status: 404)), .disabled(message: nil)),
      (.http(APIFailure(status: 503, code: "companion-openai-key", message: "Bad key.")), .keyRejected(message: "Bad key.")),
      (.rateLimited(APIFailure(status: 429, code: "companion-throttled", message: "Soon.")), .throttled(message: "Soon.")),
      (
        .rateLimited(APIFailure(status: 429, code: "companion-openai-limit", message: "Limit.")),
        .openAILimit(message: "Limit.")
      ),
      (.http(APIFailure(status: 502, code: "companion-openai", message: "No key.")), .unavailable(message: "No key.")),
      // 503 bez kodu (reverse proxy) to awaria przejściowa, nie wyłączona funkcja.
      (.http(APIFailure(status: 503)), .unavailable(message: nil)),
      (.offline(.notConnectedToInternet), .unavailable(message: nil)),
    ]
    for (error, expected) in cases {
      let (store, probe) = await companionStore()
      probe.set { $0.companion = .failure(error) }
      #expect(await store.mintCompanionToken() == expected, "\(error)")
      #expect(store.state.auth == .loggedIn)
    }
  }

  @Test("spóźnione 200 po wylogowaniu: rozmowa nie dostaje klucza starego zalogowania")
  func lateTokenAfterLogout() async {
    let (store, probe) = await companionStore()
    probe.set { $0.hold = true }
    let pending = Task { await store.mintCompanionToken() }
    await until("żądanie w drodze") { probe.probe.withLock { $0.companionCalls } == 1 }
    probe.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("wylogowanie") { store.state.auth != .loggedIn }
    probe.release()
    #expect(await pending.value == .loggedOut)
  }

  @Test("spóźnione 401 po ponownym zalogowaniu (inny serwer, nowe urządzenie) nie wylogowuje nowego zalogowania")
  func late401DoesNotLogOutNewLogin() async {
    let (store, probe) = await companionStore()
    let epoch = store.loginEpoch
    probe.set {
      $0.hold = true
      $0.companion = .failure(.unauthorized(APIFailure(status: 401)))
    }
    let pending = Task { await store.mintCompanionToken() }
    await until("żądanie w drodze") { probe.probe.withLock { $0.companionCalls } == 1 }
    probe.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("wylogowanie") { store.state.auth != .loggedIn }
    await relogin(store, probe)
    #expect(store.loginEpoch != epoch, "numer zalogowania rośnie — rozmowa wie, że to nie to samo zalogowanie")
    probe.release()
    #expect(await pending.value == .loggedOut)
    #expect(store.state.auth == .loggedIn, "spóźnione 401 należy do starego zalogowania")
  }

  @Test("pytanie o sesję: trasa sesji z pytaniem i identyfikatorem żądania; odpowiedź z propozycją promptu")
  func ask() async {
    let (store, probe) = await companionStore()
    probe.set {
      $0.answer = .success(sampleAnswer(#"{"answer":"Not in the session.","found":false,"prompt":"Check it."}"#))
    }
    let outcome = await store.askCompanion(sessionId: "s1", question: "Which key?")
    #expect(outcome == .answer(sampleAnswer(#"{"answer":"Not in the session.","found":false,"prompt":"Check it."}"#)))
    let asks = probe.probe.withLock { $0.asks }
    #expect(asks.count == 1)
    #expect(asks.first?.sessionId == "s1" && asks.first?.body.question == "Which key?")
    #expect(UUID(uuidString: asks.first?.body.clientRequestId ?? "") != nil)
  }

  @Test("pytanie dłuższe niż sufit kontraktu jest przycięte, nie odrzucone")
  func askCeiling() {
    let long = String(repeating: "ą", count: CompanionAskBody.maxQuestionUnits + 10)
    #expect(RarogStore.companionQuestion(long).utf16.count == CompanionAskBody.maxQuestionUnits)
    #expect(RarogStore.companionQuestion("krótkie") == "krótkie")
  }

  @Test("odmowy pytania: limit subskrypcji, zajęte, wyłączone i błąd CLI to różne wyniki")
  func askRefusals() async {
    let cases: [(TransportError, CompanionAskOutcome)] = [
      (.rateLimited(APIFailure(status: 429, code: "companion-limit", message: "Limit.")), .limit(message: "Limit.")),
      (.rateLimited(APIFailure(status: 429, code: "companion-busy", message: "Busy.")), .busy(message: "Busy.")),
      (.http(APIFailure(status: 503, code: "companion-disabled", message: "Off.")), .disabled(message: "Off.")),
      (
        .http(APIFailure(status: 503, code: "companion-cli", message: "No CLI.")),
        .failed(code: "companion-cli", message: "No CLI.")
      ),
      (.timedOut, .failed(code: "timeout", message: nil)),
      (.offline(.networkConnectionLost), .failed(code: nil, message: nil)),
    ]
    for (error, expected) in cases {
      let (store, probe) = await companionStore()
      probe.set { $0.answer = .failure(error) }
      #expect(await store.askCompanion(sessionId: "s1", question: "q") == expected, "\(error)")
    }
  }

}
