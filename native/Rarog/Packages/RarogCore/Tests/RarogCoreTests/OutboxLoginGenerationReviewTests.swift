import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

/// Wstrzymany poprzedni zapis kolejki: gest musi zaczekać, zanim utrwali swój wpis.
private actor OutboxReviewLatch {
  private var released = false
  private var waiter: CheckedContinuation<Void, Never>?

  func wait() async {
    if released { return }
    await withCheckedContinuation { waiter = $0 }
  }

  func release() {
    released = true
    waiter?.resume()
    waiter = nil
  }
}

@MainActor
@Suite("kolejka: gest sprzed 401 nie wychodzi po ponownym logowaniu")
struct OutboxLoginGenerationReviewTests {
  @Test("Wyślij i Ponów czekające na zapis należą do starego zalogowania", arguments: [false, true])
  func diskWaitDoesNotAdoptNewLogin(retry: Bool) async throws {
    let (store, transport) = try await readyStore()
    var retryId: UUID?
    if retry {
      guard case let .accepted(id) = await store.send(text: "pierwsza próba", to: "s1") else {
        Issue.record("pierwsza próba nie przyjęta")
        return
      }
      retryId = id
      store.dispatch(.outboxUnconfirmedIfStillSent(id))
      await store.flushPersistence()
    }
    let requestsBefore = transport.read { $0.messages.count }
    let latch = OutboxReviewLatch()
    store.persistChain = Task { await latch.wait() }
    let entered = Mutex(false)
    let pending = Task { @MainActor in
      entered.withLock { $0 = true }
      if let retryId { return await store.retry(retryId) }
      return await store.send(text: "gest ze starego zalogowania", to: "s1")
    }
    // Flagę ustawia zadanie na tym samym aktorze: test odzyskuje sterowanie dopiero, gdy gest
    // dojdzie do pierwszego await, czyli wstrzymanego persistInOrder.
    await until("gest czeka na zapis") { entered.withLock { $0 } }
    store.handleUnauthorized()
    store.enterLoggedIn()
    await until("nowy strumień") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "waiting-input"))]}"#)
    await until("świeża lista nowego logowania") { store.state.sessionsLoaded && store.state.compat == .ok }
    await latch.release()
    let result = await pending.value
    #expect(transport.read { $0.messages.count } == requestsBefore, "stary gest nie wysyła w nowym zalogowaniu")
    guard case let .refused(id, _, message) = result else {
      Issue.record("oczekiwano odmowy starego gestu, jest \(result)")
      return
    }
    #expect(message == CoreCopy.noConnection)
    #expect(store.state.outbox.contains { $0.id == id }, "utrwalona treść zostaje do ręcznego Ponów/Odrzuć")
    await store.flushPersistence()
    let disk = await store.persistence.loadAll()
    #expect(disk.entries.contains { $0.id == id && $0.state == .refused(code: nil, message: CoreCopy.noConnection) })
    store.setScenePhase(.background)
  }
}
