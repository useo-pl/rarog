import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Testing

/// Sesja `s1` w danym stanie z pełnym transkryptem bez kart (karta „dialog w terminalu" stoi,
/// gdy sesja czeka, a kart decyzji nie ma).
@MainActor
private func cardsStore(state: String, extra: String = "") async throws -> (RarogStore, FakeTransport) {
  let (store, transport) = makeStore()
  await store.start()
  await until("online") { store.state.global == .online }
  transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
  transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: state, extra: extra))]}"#)
  await until("lista") { store.state.sessionsLoaded }
  store.openSession("s1")
  await until("strumień sesji") { transport.streamCalls.contains { $0.scope == .session(id: "s1") } }
  transport.push(.session(id: "s1"), json: #"""
    {"type":"transcript-snapshot","sessionId":"s1","messages":[],"pendingPermissions":[],"pendingQuestions":[]}
    """#)
  await until("transkrypt") { store.state.transcripts["s1"]?.snapshots == 1 }
  return (store, transport)
}

/// Podpis dialogu z karty, którą widzi test; karty nie ma — podpis z karty sesji (decyzja i tak
/// kończy się `.notShown`).
@MainActor
private func seen(_ store: RarogStore) -> HerdrDialogSignature {
  if let current = store.state.herdrDialogSignature(for: "s1") { return current }
  guard let session = store.state.sessions["s1"] else { preconditionFailure("test bez sesji s1") }
  return HerdrDialogSignature(session)
}

@MainActor
@Suite("magazyn: karty — eskalacja, dialog w panelu, Wznów")
struct StoreCardsTests {
  @Test("„Zatwierdź i nie pytaj…” tylko z dosłowną etykietą od serwera")
  func allowAlways() async throws {
    let (store, transport) = try await readyStore(state: "waiting-permission")
    #expect(await store.decidePermission(sessionId: "s1", permId: "p1", decision: .allowAlways) == .notAllowed)
    let always = Frames.permission("s1", permId: "p2").replacingOccurrences(
      of: #""risk":"normal""#, with: #""risk":"normal","alwaysLabel":"Yes, and don’t ask again for: npm test""#)
    transport.push(.session(id: "s1"), json: #"{"type":"permission-pending","request":\#(always)}"#)
    await until("karta z etykietą") { store.state.transcripts["s1"]?.pendingPermissions.count == 2 }
    #expect(await store.decidePermission(sessionId: "s1", permId: "p2", decision: .allowAlways) == .accepted)
    #expect(transport.read { $0.decisions.map(\.body.decision) } == [.allowAlways])
  }

  @Test("karta kanału: „zawsze” tylko z listą `always`; etykieta ekranu jej nie zastępuje")
  func hookAllowAlways() async throws {
    let (store, transport) = try await readyStore(state: "waiting-permission")
    let channel = #""risk":"normal","channel":"\#(PermissionChannel.hook.rawValue)","state":"pending","#
    let label = Frames.permission("s1", permId: "k1").replacingOccurrences(
      of: #""risk":"normal""#, with: channel + #""alwaysLabel":"Yes""#)
    let always = Frames.permission("s1", permId: "k2").replacingOccurrences(
      of: #""risk":"normal""#,
      with: channel + #""always":[{"kind":"rule","value":"Bash(npm test)","destination":"session"}]"#)
    for card in [label, always] {
      transport.push(.session(id: "s1"), json: #"{"type":"permission-pending","request":\#(card)}"#)
    }
    await until("dwie karty kanału") { store.state.transcripts["s1"]?.pendingPermissions.count == 3 }
    #expect(await store.decidePermission(sessionId: "s1", permId: "k1", decision: .allowAlways) == .notAllowed)
    #expect(await store.decidePermission(sessionId: "s1", permId: "k2", decision: .allowAlways) == .accepted)
    #expect(transport.read { $0.decisions.map(\.body.decision) } == [.allowAlways])
  }

  @Test("dialog w panelu: Odrzuć zawsze, Zatwierdź tylko rozpoznany; z kartą zgody karty dialogu nie ma")
  func dialogDecision() async throws {
    let (store, transport) = try await cardsStore(state: "waiting-permission")
    #expect(store.state.herdrDialogShown(for: "s1"))
    #expect(store.state.dialogAllowId(for: "s1") == nil)
    #expect(await store.decideDialog(sessionId: "s1", decision: .allow, seen: seen(store)) == .notAllowed)
    #expect(await store.decideDialog(sessionId: "s1", decision: .allowAlways, seen: seen(store)) == .notAllowed)
    #expect(await store.decideDialog(sessionId: "s1", decision: .deny, seen: seen(store)) == .accepted)
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-permission", extra: #","herdrDialog":"trust""#))}"#)
    await until("rozpoznany dialog") { store.state.dialogAllowId(for: "s1") == .trust }
    #expect(await store.decideDialog(sessionId: "s1", decision: .allow, seen: seen(store)) == .accepted)
    #expect(transport.read { $0.dialogDecisions.map(\.body.decision) } == [.deny, .allow])
    #expect(transport.read { $0.dialogDecisions.map(\.sessionId) } == ["s1", "s1"])

    // Karta zgody z treścią wyklucza kartę „nie wiem, co stoi" — decyzja o dialogu nic nie wysyła.
    transport.push(.session(id: "s1"), json: #"{"type":"permission-pending","request":\#(Frames.permission("s1", permId: "p1"))}"#)
    await until("karta zgody") { store.state.transcripts["s1"]?.pendingPermissions.count == 1 }
    #expect(!store.state.herdrDialogShown(for: "s1"))
    #expect(await store.decideDialog(sessionId: "s1", decision: .deny, seen: seen(store)) == .notShown)
    #expect(transport.read { $0.dialogDecisions.count } == 2)
  }

  @Test("dialog podmieniony pod tym samym `stateSince`: zatwierdzenie widzianej karty nic nie wysyła; Odrzuć tak")
  func dialogSwapped() async throws {
    let (store, transport) = try await cardsStore(state: "waiting-permission", extra: #","herdrDialog":"trust""#)
    let trust = try #require(store.state.herdrDialogSignature(for: "s1"))
    #expect(trust.dialog == .trust)
    // Serwer podmienia dialog w tym samym stanie (nowe `screen-dialog`): `stateSince` stoi.
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-permission", extra: #","herdrDialog":"model""#))}"#)
    await until("podmieniony") { store.state.dialogAllowId(for: "s1") == .model }
    let model = try #require(store.state.herdrDialogSignature(for: "s1"))
    #expect(model.stateSince == trust.stateSince && model != trust)
    #expect(await store.decideDialog(sessionId: "s1", decision: .allow, seen: trust) == .changed)
    #expect(transport.read { $0.dialogDecisions.count } == 0, "karta widziana jako zaufanie nie zatwierdza zmiany modelu")
    // Treść karty też jest tożsamością: ten sam rodzaj z innym powodem to inna karta.
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-permission", extra: #","herdrDialog":"model","herdrDialogReason":"no-digit""#))}"#)
    await until("inny powód") { store.state.herdrDialogSignature(for: "s1")?.reason == .noDigit }
    #expect(await store.decideDialog(sessionId: "s1", decision: .allow, seen: model) == .changed)
    // Esc wolno zawsze, gdy karta stoi — kierunek bezpieczny.
    #expect(await store.decideDialog(sessionId: "s1", decision: .deny, seen: trust) == .accepted)
    #expect(await store.decideDialog(sessionId: "s1", decision: .allow, seen: seen(store)) == .accepted)
    #expect(transport.read { $0.dialogDecisions.map(\.body.decision) } == [.deny, .allow])
  }

  @Test("dialog: odmowa serwera ze zdaniem, 410 = zniknął, drugi tap w locie nic nie wysyła, offline od razu")
  func dialogOutcomes() async throws {
    let (store, transport) = try await cardsStore(state: "waiting-question")
    transport.set { $0.cardResult = .http(APIFailure(status: 409, code: "bad-state", message: "Zatwierdź w terminalu.")) }
    #expect(await store.decideDialog(sessionId: "s1", decision: .deny, seen: seen(store)) == .refused(message: "Zatwierdź w terminalu."))
    transport.set { $0.cardResult = .http(APIFailure(status: 410, code: "gone", message: "Prośba wygasła — wznów sesję.")) }
    #expect(await store.decideDialog(sessionId: "s1", decision: .deny, seen: seen(store)) == .expired)

    transport.set { state in
      state.cardResult = nil
      state.onCardRequest = { try? await Task.sleep(for: .milliseconds(200)) }
    }
    async let first = store.decideDialog(sessionId: "s1", decision: .deny, seen: seen(store))
    await until("pierwsza w drodze") { transport.read { $0.dialogDecisions.count } == 3 }
    #expect(await store.decideDialog(sessionId: "s1", decision: .deny, seen: seen(store)) == .inFlight)
    #expect(await first == .accepted)
    #expect(transport.read { $0.dialogDecisions.count } == 3)

    transport.set { $0.onCardRequest = nil }
    transport.end(.global, error: .offline(.networkConnectionLost))
    await until("offline") { store.state.global != .online }
    #expect(await store.decideDialog(sessionId: "s1", decision: .deny, seen: seen(store)) == .offline)
    #expect(transport.read { $0.dialogDecisions.count } == 3)
  }

  @Test("„Wznów” tylko dla sesji bez panelu; odmowa serwera ze zdaniem")
  func resume() async throws {
    let (store, transport) = try await cardsStore(state: "limit-reached")
    #expect(!store.state.canResume("s1"))
    #expect(await store.resumeSession("s1") == .notAllowed)
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "resumable"))}"#)
    await until("do wznowienia") { store.state.canResume("s1") }
    #expect(await store.resumeSession("s1") == .accepted)
    // Odpowiedź nie przestawia stanu — nowy stan przychodzi strumieniem listy.
    #expect(store.state.sessions["s1"]?.state == .resumable)
    transport.set { $0.cardResult = .http(APIFailure(status: 409, code: "bad-state", message: "Sesja żyje w panelu.")) }
    #expect(await store.resumeSession("s1") == .refused(message: "Sesja żyje w panelu."))
    #expect(transport.read { $0.resumes } == ["s1", "s1"])
  }

  @Test("wylogowanie w trakcie żądania: anulowane, wynik nie wraca (spóźniony 401 nie wylogowuje nowego zalogowania)")
  func logoutCancels() async throws {
    let (store, transport) = try await cardsStore(state: "resumable")
    let cancelled = Box()
    transport.set { state in
      state.onCardRequest = {
        try? await Task.sleep(for: .seconds(2))
        if Task.isCancelled { cancelled.set() }
      }
    }
    async let outcome = store.resumeSession("s1")
    await until("żądanie w drodze") { transport.read { $0.resumes.count } == 1 }
    store.handleUnauthorized()
    #expect(await outcome == .loggedOut)
    await until("zadanie anulowane") { cancelled.value }
    #expect(store.state.auth == .loggedOut(.deviceUnknown))
  }

  @Test("401 przy dialogu i Wznów → wylogowanie jedną drogą")
  func unauthorized() async throws {
    let (store, transport) = try await cardsStore(state: "waiting-permission")
    transport.set { $0.cardResult = .unauthorized(APIFailure(status: 401)) }
    #expect(await store.decideDialog(sessionId: "s1", decision: .deny, seen: seen(store)) == .loggedOut)
    #expect(store.state.auth == .loggedOut(.deviceUnknown))
  }

  @Test("ostrzeżenie o zaufaniu: z odpowiedzi 202, żyje przez start i dialog, gaśnie, gdy sesja ruszy")
  func trustPrompt() async throws {
    let (store, transport) = try await readyStore()
    transport.set { $0.createTrustPrompt = true }
    let outcome = await store.createSession(in: "/Users/demo/projekt", defaults: NewSessionDefaults())
    #expect(outcome == .created(sessionId: "new-1", trustPrompt: true))
    #expect(store.state.showsTrustPrompt("new-1"))
    for (state, shown) in [("starting", true), ("waiting-permission", true), ("waiting-input", false), ("waiting-permission", false)] {
      transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("new-1", state: state))}"#)
      // Karty spoza listy strumień globalny nie tworzy — pierwsza zmiana przychodzi snapshotem.
      transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1")),\#(Frames.summary("new-1", state: state))]}"#)
      await until("stan \(state)") { store.state.sessions["new-1"]?.state.rawValue == state }
      #expect(store.state.showsTrustPrompt("new-1") == shown, "\(state)")
    }
  }
}

@Suite("reduktor: ostrzeżenie o zaufaniu katalogu")
struct ReducerTrustPromptTests {
  @Test("ustawione przed kartą sesji czeka na nią; gaśnie przy wyjściu ze startu; wylogowanie kasuje")
  func lifecycle() throws {
    var state = AppState(clientBuild: 1)
    let now = Date()
    state.apply(.cards(.trustPromptArmed(sessionId: "n1")), now: now)
    #expect(state.showsTrustPrompt("n1"))
    state.apply(.frame(try Frames.snapshot([Frames.summary("n1", state: "starting")]), source: .global, cursor: nil), now: now)
    #expect(state.showsTrustPrompt("n1"))
    state.apply(.frame(try Frames.state("n1", "running", since: "2026-10-03T08:01:00.000Z"), source: .global, cursor: nil), now: now)
    #expect(!state.showsTrustPrompt("n1"))
    state.apply(.cards(.trustPromptArmed(sessionId: "n1")), now: now)
    #expect(!state.showsTrustPrompt("n1"), "sesja już pracuje — pytania nie będzie")
    state.apply(.cards(.trustPromptArmed(sessionId: "n2")), now: now)
    state.apply(.loggedOut(.deviceUnknown), now: now)
    #expect(state.cards.trustPromptSessionId == nil)
  }

  @Test("karta dialogu: tylko przy czekaniu, po pełnym stanie i bez kart decyzji; martwy kanał")
  func dialogCardRules() throws {
    var state = AppState(clientBuild: 1)
    let now = Date()
    state.apply(.frame(try Frames.snapshot([Frames.summary("s1", state: "waiting-question")]), source: .global, cursor: nil), now: now)
    #expect(!state.herdrDialogShown(for: "s1"), "bez pełnego stanu transkryptu kart nie znamy")
    state.apply(.frame(try Frames.transcript("s1"), source: .session("s1"), cursor: nil), now: now)
    #expect(state.herdrDialogShown(for: "s1"))
    state.apply(.frame(try Frames.transcript("s1", questions: [Frames.question("s1", qId: "q1")]), source: .session("s1"), cursor: nil), now: now)
    #expect(!state.herdrDialogShown(for: "s1"))
    #expect(!state.herdrChannelDead(for: "s1"))
    state.herdr = HerdrStatus(available: true, agentCount: 1, readOnly: true, canLaunch: false)
    #expect(state.herdrChannelDead(for: "s1"))
  }
}

/// Flaga ustawiana z zadania poza głównym aktorem.
final class Box: @unchecked Sendable {
  private let lock = NSLock()
  private var flag = false
  var value: Bool { lock.withLock { flag } }
  func set() { lock.withLock { flag = true } }
}
