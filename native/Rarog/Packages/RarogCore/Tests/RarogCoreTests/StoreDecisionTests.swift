import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Testing

extension OutboxEntry.State {
  var isSent: Bool {
    if case .sent = self { return true }
    return false
  }
}

@MainActor
@Suite("magazyn: decyzje na karcie zgody (KARTA)")
struct StoreDecisionTests {
  @Test("przyjęta decyzja: karta czeka na rozstrzygnięcie serwera, potem znika bez śladu")
  func accepted() async throws {
    let (store, transport) = try await readyStore(state: "waiting-permission")
    #expect(await store.decidePermission(sessionId: "s1", permId: "p1", decision: .allow) == .accepted)
    #expect(transport.read { $0.decisions.map(\.body.decision) } == [.allow])
    #expect(store.state.transcripts["s1"]?.pendingPermissions.count == 1)
    #expect(await store.decidePermission(sessionId: "s1", permId: "p1", decision: .allow) == .alreadyInFlight)
    transport.push(.session(id: "s1"), json: #"""
      {"type":"permission-resolved","sessionId":"s1","permId":"p1","decision":"allow","by":"test·Rarog"}
      """#)
    await until("karta zdjęta") { store.state.transcripts["s1"]?.pendingPermissions.isEmpty == true }
    #expect(store.state.notices.isEmpty)
  }

  @Test("karta zdjęta przed naciśnięciem → nic nie wychodzi; brak połączenia → odmowa od razu")
  func goneAndOffline() async throws {
    let (store, transport) = try await readyStore(state: "waiting-permission")
    #expect(await store.decidePermission(sessionId: "s1", permId: "inna", decision: .deny) == .cardGone)
    transport.end(.global, error: .offline(.networkConnectionLost))
    await until("offline") { store.state.global != .online }
    #expect(await store.decidePermission(sessionId: "s1", permId: "p1", decision: .deny) == .offline)
    #expect(transport.read { $0.decisions.isEmpty })
  }

  @Test("`canAllow: false` → zatwierdzić się nie da; odrzucić tak")
  func cannotAllow() async throws {
    let (store, transport) = try await readyStore(state: "waiting-permission")
    let card = Frames.permission("s1", permId: "p2", canAllow: false)
    transport.push(.session(id: "s1"), json: #"{"type":"permission-pending","request":\#(card)}"#)
    await until("druga karta") { store.state.transcripts["s1"]?.pendingPermissions.count == 2 }
    #expect(await store.decidePermission(sessionId: "s1", permId: "p2", decision: .allow) == .notAllowed)
    #expect(await store.decidePermission(sessionId: "s1", permId: "p2", decision: .allowAlways) == .notAllowed)
    #expect(await store.decidePermission(sessionId: "s1", permId: "p2", decision: .deny) == .accepted)
  }

  @Test("409 → znika ze śladem (6 s); 410 → wygasła; 422 i błąd sieci → karta zostaje")
  func outcomes() async throws {
    let (store, transport) = try await readyStore(state: "waiting-permission")
    let refusal = APIFailure(status: 422, code: "refused", message: "Nie wiem, która opcja.", reason: "no-digit")
    transport.set { $0.decisionResult = .http(refusal) }
    #expect(await store.decidePermission(sessionId: "s1", permId: "p1", decision: .allow) == .refused(message: "Nie wiem, która opcja."))
    transport.set { $0.decisionResult = .offline(.networkConnectionLost) }
    #expect(await store.decidePermission(sessionId: "s1", permId: "p1", decision: .allow) == .failed)
    #expect(store.state.transcripts["s1"]?.pendingPermissions.count == 1)
    transport.set { $0.decisionResult = .http(APIFailure(status: 409, code: "conflict")) }
    #expect(await store.decidePermission(sessionId: "s1", permId: "p1", decision: .allow) == .alreadyDecided)
    #expect(store.state.transcripts["s1"]?.pendingPermissions.isEmpty == true)
    #expect(store.state.notices.map(\.reason) == [.alreadyDecided])
    await until("ślad znika po czasie życia") { store.state.notices.isEmpty }

    transport.push(.session(id: "s1"), json: #"{"type":"permission-pending","request":\#(Frames.permission("s1", permId: "p3"))}"#)
    await until("nowa karta") { store.state.transcripts["s1"]?.pendingPermissions.count == 1 }
    transport.set { $0.decisionResult = .http(APIFailure(status: 410, code: "gone")) }
    #expect(await store.decidePermission(sessionId: "s1", permId: "p3", decision: .deny) == .expired)
    #expect(store.state.notices.map(\.reason) == [.expired])
  }

  @Test("401 przy decyzji → wylogowanie")
  func unauthorized() async throws {
    let (store, transport) = try await readyStore(state: "waiting-permission")
    transport.set { $0.decisionResult = .unauthorized(APIFailure(status: 401)) }
    #expect(await store.decidePermission(sessionId: "s1", permId: "p1", decision: .deny) == .loggedOut)
    #expect(store.state.auth == .loggedOut(.deviceUnknown))
  }

  @Test("409 `bad-state` to nie konflikt: karta zostaje, wynik niesie zdanie serwera")
  func badStateKeepsCard() async throws {
    let (store, transport) = try await readyStore(state: "waiting-permission")
    let badState = APIFailure(status: 409, code: "bad-state", message: "Sesja jest w stanie, który nie pozwala na tę akcję.")
    transport.set { $0.decisionResult = .http(badState) }
    let outcome = await store.decidePermission(sessionId: "s1", permId: "p1", decision: .allow)
    #expect(outcome == .refused(message: "Sesja jest w stanie, który nie pozwala na tę akcję."))
    #expect(store.state.transcripts["s1"]?.pendingPermissions.count == 1)
    #expect(store.state.transcripts["s1"]?.decisions.isEmpty == true)
    #expect(store.state.notices.isEmpty)
  }
}
