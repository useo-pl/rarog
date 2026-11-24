import Foundation
import RarogContract
import RarogContractFixtures
import RarogTransport
import Testing

// The Inbox routes and the global stream's `inbox=1` on the `URLProtocol` stub, with the server's golden answers.
// Owner: Inbox (native app).

@Suite("REST client: Inbox")
struct InboxClientTests {
  private static let body = InboxActionBody(turnId: "pX8n2cHq5zKe4uTy9bWa1f", version: "bIBuAIREwSMFhgbBviB9Mr")

  @Test("the global stream asks for the Inbox heads; a session stream does not")
  func globalStreamAsksForHeads() async throws {
    let harness = MockHarness(device: testDevice) { _ in
      MockURLProtocol.Reply(status: 200, headers: ["Content-Type": "text/event-stream"], chunks: [Data(": ping\n\n".utf8)])
    }
    for try await _ in try await harness.client.openStream(.global) {}
    for try await _ in try await harness.client.openStream(.session(id: "s1")) {}
    #expect(harness.requests.map(\.path) == ["/api/stream?inbox=1", "/api/sessions/s1/stream"])
  }

  @Test("GET /api/inbox and GET /api/inbox/<id>: golden list, one card, and no card")
  func reads() async throws {
    let list = try goldenRest("inbox.list.json")
    let card = try goldenRest("inbox.card.json")
    let none = try goldenRest("inbox.card.none.json")
    let harness = MockHarness(device: testDevice) { request in
      switch request.path {
      case "/api/inbox": .json(200, list)
      case "/api/inbox/w0%3Ad4": .json(200, card)
      default: .json(200, none)
      }
    }
    let cards = try await harness.client.inboxCards()
    guard case let .permission(_, requestId) = cards.cards.first?.dialog else {
      Issue.record("the first golden card waits for a permission")
      return
    }
    #expect(requestId == "demo-perm-willow")
    #expect(cards.cards.map(\.kind) == [.decision, .result, .decision, .decision, .failed])
    let one = try await harness.client.inboxCard(sessionId: "w0:d4")
    #expect(one.card?.version == "bIBuAIREwSMFhgbBviB9Mr")
    let empty = try await harness.client.inboxCard(sessionId: "gone")
    #expect(empty.card == nil)
    #expect(harness.requests.map(\.method) == ["GET", "GET", "GET"])
  }

  @Test("remove and restore: POST with the card's turn and version; changed, receipt skipped")
  func removeAndRestore() async throws {
    let removed = try goldenRest("inbox.removed.json")
    let skipped = try goldenRest("inbox.restored.receipt-skipped.json")
    let harness = MockHarness(device: testDevice) { request in
      request.path.hasSuffix("/remove") ? .json(200, removed) : .json(200, skipped)
    }
    let remove = try await harness.client.removeInboxCard(sessionId: "w0:d4", Self.body)
    #expect(remove.changed && remove.receipt == nil)
    let restore = try await harness.client.restoreInboxCard(sessionId: "w0:d4", Self.body)
    #expect(restore.receipt == .skipped)
    let requests = harness.requests
    #expect(requests.map(\.path) == ["/api/inbox/w0%3Ad4/remove", "/api/inbox/w0%3Ad4/restore"])
    #expect(requests.allSatisfy { $0.method == "POST" && $0.header("Origin") == "http://127.0.0.1:\(harness.port)" })
    let sent = try JSONDecoder().decode([String: String].self, from: try #require(requests.first?.body))
    #expect(sent == ["turnId": Self.body.turnId, "version": Self.body.version])
  }

  @Test("a stale card is a 409 with the server's code; the action changes nothing on the client")
  func staleCard() async throws {
    let changed = try goldenRest("error.inbox-card-changed.json")
    let harness = MockHarness(device: testDevice) { _ in .json(409, changed) }
    do {
      _ = try await harness.client.removeInboxCard(sessionId: "s1", Self.body)
      Issue.record("a 409 throws")
    } catch {
      guard case let .http(failure) = error else { Issue.record("wrong error: \(error)"); return }
      #expect(failure.status == 409 && failure.code == "inbox-card-changed")
    }
  }
}
