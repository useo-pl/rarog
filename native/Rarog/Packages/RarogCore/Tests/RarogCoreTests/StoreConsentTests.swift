import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Synchronization
import Testing

// Karta kanału zgód w magazynie: zastąpienie po stałym `permId`, `permission-settled` w miejscu, zwolnienie
// do terminala (`release`) osobną drogą od zgody i odmowy. Kanał bierze się z kontraktu
// (`PermissionChannel.hook.rawValue`), nie z literału.

/// Karta kanału na drucie: `state` i `extra` (dodatkowe pola JSON, z przecinkiem na początku).
private func hookCard(
  _ sessionId: String = "s1", permId: String = "k1", state: String = "pending", canAllow: Bool = true,
  displayText: String = "{}", extra: String = ""
) -> String {
  #"""
    {"permId":"\#(permId)","sessionId":"\#(sessionId)","toolName":"Write","displayText":"\#(displayText)",
    "risk":"normal","cwd":"/Users/demo/projekt","createdAt":"2026-11-07T10:00:00.000Z","canAllow":\#(canAllow),
    "channel":"\#(PermissionChannel.hook.rawValue)","state":"\#(state)"\#(extra)}
    """#
}

private func settled(_ permId: String = "k1", state: String, canAllow: Bool = false, extra: String = "") -> String {
  #"""
    {"type":"permission-settled","sessionId":"s1","permId":"\#(permId)","state":"\#(state)","canAllow":\#(canAllow),
    "at":"2026-11-07T10:00:05.000Z"\#(extra)}
    """#
}

/// Bramka do wstrzymania żądania w drodze: `wait` czeka, aż test zawoła `open`.
private final class Latch: Sendable {
  private let state = Mutex<(open: Bool, waiters: [CheckedContinuation<Void, Never>])>((false, []))

  func wait() async {
    await withCheckedContinuation { continuation in
      let resume = state.withLock { value -> Bool in
        if value.open { return true }
        value.waiters.append(continuation)
        return false
      }
      if resume { continuation.resume() }
    }
  }

  func open() {
    let waiters = state.withLock { value in
      value.open = true
      defer { value.waiters = [] }
      return value.waiters
    }
    for waiter in waiters { waiter.resume() }
  }
}

@MainActor
@Suite("magazyn: karta kanału zgód")
struct StoreConsentTests {
  /// Magazyn z otwartym transkryptem `s1` i jedną kartą kanału `k1`.
  private func storeWithHookCard(
    state: String = "pending", canAllow: Bool = true
  ) async throws -> (RarogStore, FakeTransport) {
    let (store, transport) = try await readyStore(state: "waiting-permission")
    transport.push(.session(id: "s1"), json: #"""
      {"type":"permission-pending","request":\#(hookCard(state: state, canAllow: canAllow))}
      """#)
    await until("karta kanału") { store.state.transcripts["s1"]?.pendingPermissions.count == 2 }
    return (store, transport)
  }

  private func card(_ store: RarogStore, _ permId: String = "k1") -> PermissionRequest? {
    store.state.transcripts["s1"]?.pendingPermissions.first { $0.permId == permId }
  }

  @Test("druga karta kanału o tym samym `permId` zastępuje poprzednią; powtórzona karta ekranowa zostaje")
  func hookCardReplaces() async throws {
    let (store, transport) = try await storeWithHookCard()
    transport.push(.session(id: "s1"), json: #"""
      {"type":"permission-pending","request":\#(hookCard(state: "sent", canAllow: false, displayText: "nowa"))}
      """#)
    await until("zastąpiona") { self.card(store)?.state == .sent }
    #expect(card(store)?.displayText == "nowa")
    #expect(store.state.transcripts["s1"]?.pendingPermissions.map(\.permId) == ["p1", "k1"])
    let screenAgain = #"{"permId":"p1","sessionId":"s1","toolName":"Read","displayText":"inna","#
      + #""risk":"normal","cwd":"/x","createdAt":"2026-10-03T08:00:00.000Z"}"#
    transport.push(.session(id: "s1"), json: #"{"type":"permission-pending","request":\#(screenAgain)}"#)
    transport.push(.session(id: "s1"), json: settled(state: "claimed"))
    await until("kolejna ramka przetrawiona") { self.card(store)?.state == .claimed }
    #expect(card(store, "p1")?.displayText == "cat plik")
  }

  @Test("`permission-settled` zmienia stan, przyciski i powód w miejscu; karta ekranowa i obcy `permId` bez zmian")
  func settledInPlace() async throws {
    let (store, transport) = try await storeWithHookCard()
    transport.push(.session(id: "s1"), json: settled(state: "pending", extra: #","unavailable":"no-proof""#))
    await until("zmiana w miejscu") { self.card(store)?.canAllow == false }
    #expect(card(store)?.unavailable == .noProof)
    #expect(store.state.transcripts["s1"]?.pendingPermissions.map(\.permId) == ["p1", "k1"])
    transport.push(.session(id: "s1"), json: settled("p1", state: "running"))
    transport.push(.session(id: "s1"), json: settled("obca", state: "running"))
    transport.push(.session(id: "s1"), json: settled(state: "sent"))
    await until("następna ramka") { self.card(store)?.state == .sent }
    #expect(card(store, "p1")?.state == nil)
    #expect(store.state.transcripts["s1"]?.pendingPermissions.count == 2)
  }

  @Test("spóźniony `permission-settled` po `unknown`, drugie urządzenie i reconnect: zdjęta karta nie wraca")
  func lateSettled() async throws {
    let (store, transport) = try await readyStore(state: "waiting-permission")
    // Reconnect: pełny stan niesie kartę w stanie `unknown`.
    transport.push(.session(id: "s1"), json: #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[],
      "pendingPermissions":[\#(hookCard(state: "unknown", canAllow: false))],"pendingQuestions":[]}
      """#)
    await until("snapshot") { self.card(store)?.state == .unknown }
    transport.push(.session(id: "s1"), json: settled(state: "pending", canAllow: true))
    transport.push(.session(id: "s1"), json: settled(state: "applied"))
    await until("spóźniony dowód skutku") { self.card(store)?.state == .applied }
    transport.push(.session(id: "s1"), json: settled(state: "pending", canAllow: true))
    transport.push(.session(id: "s1"), json: #"""
      {"type":"permission-resolved","sessionId":"s1","permId":"k1","decision":"allow","by":"iPad"}
      """#)
    await until("zdjęta") { self.card(store) == nil }
    transport.push(.session(id: "s1"), json: settled(state: "pending", canAllow: true))
    transport.push(.session(id: "s1"), json: #"{"type":"permission-pending","request":\#(Frames.permission("s1", permId: "p9"))}"#)
    await until("kolejna ramka") { self.card(store, "p9") != nil }
    #expect(card(store) == nil)
    #expect(store.state.notices.map(\.cardId) == ["k1"])
  }

  @Test("`release` przez magazyn: pending 200, sent 200, claimed 409, running 409, unknown 409 `too-late`", arguments: [
    ("pending", nil, ReleaseOutcome.accepted),
    ("sent", nil, .accepted),
    ("claimed", APIFailure(status: 409, code: "bad-state", message: "Odebrana."), .refused(message: "Odebrana.")),
    ("running", APIFailure(status: 409, code: "bad-state", message: "Odebrana."), .refused(message: "Odebrana.")),
    ("unknown", APIFailure(status: 409, code: "too-late", message: "Za późno."), .tooLate(message: "Za późno.")),
  ] as [(String, APIFailure?, ReleaseOutcome)])
  func releaseByState(_ state: String, _ failure: APIFailure?, _ expected: ReleaseOutcome) async throws {
    let (store, transport) = try await storeWithHookCard(state: state, canAllow: false)
    transport.set { $0.decisionResult = failure.map { .http($0) } }
    #expect(await store.releasePermission(sessionId: "s1", permId: "k1") == expected)
    #expect(transport.read { $0.decisions.map(\.body.decision) } == [.release])
    #expect(card(store) != nil)
    // Przyjęte zwolnienie zostaje w stanie do zdjęcia karty przez serwer; odmowa je kasuje.
    #expect((store.state.transcripts["s1"]?.releases["k1"] != nil) == (expected == .accepted))
    // Przyjęte zwolnienie nie jest zgodą: na karcie nie ma decyzji w locie ani śladu.
    #expect(store.state.transcripts["s1"]?.decisions.isEmpty == true)
    #expect(store.state.notices.isEmpty)
  }

  @Test("`release` omija `canAllow` i trwającą zgodę; karta ekranowa i karta w nieznanym stanie go nie mają")
  func releaseBypassesAllowGate() async throws {
    let (store, transport) = try await storeWithHookCard(canAllow: false)
    #expect(await store.decidePermission(sessionId: "s1", permId: "k1", decision: .allow) == .notAllowed)
    #expect(await store.decidePermission(sessionId: "s1", permId: "k1", decision: .release) == .notAllowed)
    #expect(await store.releasePermission(sessionId: "s1", permId: "p1") == .notAllowed)
    #expect(await store.releasePermission(sessionId: "s1", permId: "k1") == .accepted)
    transport.push(.session(id: "s1"), json: #"""
      {"type":"permission-pending","request":\#(hookCard(permId: "k2", state: "deciding"))}
      """#)
    await until("karta w nieznanym stanie") { self.card(store, "k2") != nil }
    #expect(card(store, "k2")?.state == .unsupported)
    #expect(await store.releasePermission(sessionId: "s1", permId: "k2") == .notAllowed)
    #expect(await store.decidePermission(sessionId: "s1", permId: "k2", decision: .deny) == .notAllowed)
  }

  @Test("równoległe `allow` i `release`: koniec zwolnienia nie kasuje zgody w locie, 200 na `release` nie udaje zgody")
  func parallelAllowAndRelease() async throws {
    let (store, transport) = try await storeWithHookCard()
    let latch = Latch()
    transport.set { $0.onDecision = { choice in if choice == .allow { await latch.wait() } } }
    let allow = Task { await store.decidePermission(sessionId: "s1", permId: "k1", decision: .allow) }
    await until("zgoda w locie") { store.state.transcripts["s1"]?.decisions["k1"] != nil }
    #expect(await store.releasePermission(sessionId: "s1", permId: "k1") == .accepted)
    #expect(store.state.transcripts["s1"]?.decisions["k1"]?.choice == "allow")
    #expect(store.cardRequests.cancel[RarogStore.decisionRequestKey("k1")] != nil)
    #expect(store.state.transcripts["s1"]?.releases["k1"] != nil)
    latch.open()
    #expect(await allow.value == .accepted)
  }

  @Test("`allow` kończy się, gdy `release` tej karty jest w toku: wpis `release` w żądaniach i w stanie zostaje")
  func allowFinishesDuringRelease() async throws {
    let (store, transport) = try await storeWithHookCard()
    let latch = Latch()
    transport.set { $0.onDecision = { choice in if choice == .release { await latch.wait() } } }
    let release = Task { await store.releasePermission(sessionId: "s1", permId: "k1") }
    await until("zwolnienie w locie") { store.state.transcripts["s1"]?.releases["k1"] != nil }
    #expect(await store.releasePermission(sessionId: "s1", permId: "k1") == .alreadyInFlight)
    #expect(await store.decidePermission(sessionId: "s1", permId: "k1", decision: .allow) == .accepted)
    #expect(store.cardRequests.cancel[RarogStore.releaseRequestKey("k1")] != nil)
    #expect(store.state.transcripts["s1"]?.releases["k1"] != nil)
    latch.open()
    #expect(await release.value == .accepted)
    #expect(store.cardRequests.cancel[RarogStore.releaseRequestKey("k1")] == nil)
  }

  @Test("własne `release` przyjęte przed i po `permission-resolved` (`expired`): ten sam ślad, bez „wygasła”",
    arguments: [true, false])
  func ownReleaseThenResolved(_ resolvedFirst: Bool) async throws {
    let (store, transport) = try await storeWithHookCard()
    let latch = Latch()
    transport.set { $0.onDecision = { choice in if choice == .release { await latch.wait() } } }
    let release = Task { await store.releasePermission(sessionId: "s1", permId: "k1") }
    await until("zwolnienie w locie") { store.state.transcripts["s1"]?.releases["k1"] != nil }
    let resolved = #"{"type":"permission-resolved","sessionId":"s1","permId":"k1","decision":"expired","by":"iPad"}"#
    if resolvedFirst {
      transport.push(.session(id: "s1"), json: resolved)
      await until("zdjęta przed odpowiedzią") { self.card(store) == nil }
      latch.open()
      #expect(await release.value == .accepted)
    } else {
      latch.open()
      #expect(await release.value == .accepted)
      #expect(card(store) != nil)
      transport.push(.session(id: "s1"), json: resolved)
      await until("zdjęta po odpowiedzi") { self.card(store) == nil }
    }
    #expect(store.state.notices.isEmpty)
    #expect(store.state.transcripts["s1"]?.releases.isEmpty == true)
  }

  @Test("409 `conflict` na karcie kanału: karta zostaje bez próby i śladu, przyjmuje `permission-settled` i `release`")
  func hookConflictKeepsCard() async throws {
    let (store, transport) = try await storeWithHookCard()
    transport.set { $0.decisionResults[.deny] = .http(APIFailure(status: 409, code: "conflict")) }
    #expect(await store.decidePermission(sessionId: "s1", permId: "k1", decision: .deny) == .alreadyDecided)
    #expect(card(store) != nil)
    #expect(store.state.transcripts["s1"]?.decisions.isEmpty == true)
    #expect(store.state.notices.isEmpty)
    // Zgoda z innego urządzenia idzie dalej strumieniem: karta w miejscu, zwolnienie do terminala wciąż wolno.
    transport.push(.session(id: "s1"), json: settled(state: "sent"))
    await until("stan w miejscu") { self.card(store)?.state == .sent }
    #expect(await store.releasePermission(sessionId: "s1", permId: "k1") == .accepted)
    transport.push(.session(id: "s1"), json: settled(state: "claimed"))
    await until("kolejny stan") { self.card(store)?.state == .claimed }
    transport.push(.session(id: "s1"), json: #"""
      {"type":"permission-resolved","sessionId":"s1","permId":"k1","decision":"allow","by":"iPad"}
      """#)
    await until("zdjęta rozstrzygnięciem") { self.card(store) == nil }
  }

  @Test("409 `conflict`, potem 410 na karcie kanału: 410 zdejmuje kartę ze śladem „wygasła”")
  func hookConflictThenGone() async throws {
    let (store, transport) = try await storeWithHookCard()
    transport.set { $0.decisionResults[.allow] = .http(APIFailure(status: 409, code: "conflict")) }
    #expect(await store.decidePermission(sessionId: "s1", permId: "k1", decision: .allow) == .alreadyDecided)
    #expect(card(store) != nil)
    transport.set { $0.decisionResults[.deny] = .http(APIFailure(status: 410, code: "gone")) }
    #expect(await store.decidePermission(sessionId: "s1", permId: "k1", decision: .deny) == .expired)
    #expect(card(store) == nil)
    #expect(store.state.notices.map(\.reason) == [.expired])
  }

  @Test("409 `conflict` na karcie ekranowej obok karty kanału: znika ze śladem jak dotąd")
  func screenConflictRemovesCard() async throws {
    let (store, transport) = try await storeWithHookCard()
    transport.set { $0.decisionResults[.allow] = .http(APIFailure(status: 409, code: "conflict")) }
    #expect(await store.decidePermission(sessionId: "s1", permId: "p1", decision: .allow) == .alreadyDecided)
    #expect(card(store, "p1") == nil)
    #expect(card(store) != nil)
    #expect(store.state.notices.map(\.reason) == [.alreadyDecided])
  }

  @Test("410 na `release` → karta znika ze śladem „wygasła”")
  func releaseGone() async throws {
    let (store, transport) = try await storeWithHookCard()
    transport.set { $0.decisionResults[.release] = .http(APIFailure(status: 410, code: "gone")) }
    #expect(await store.releasePermission(sessionId: "s1", permId: "k1") == .expired)
    #expect(card(store) == nil)
    #expect(store.state.notices.map(\.reason) == [.expired])
  }
}
