import Foundation
import RarogContract
import RarogCore
import RarogTransport
import Synchronization

/// The Inbox routes of the base fake: card texts the test sets, every call recorded, results of remove and restore on
/// demand, and a hold that keeps a removal in flight. Owner: Inbox.
final class FakeInboxBackend: @unchecked Sendable {
  struct Call: Sendable, Equatable {
    let sessionId: String
    let body: InboxActionBody
  }

  struct State {
    /// The card JSON of each session in list order; a session missing here has no card.
    var cards: [(sessionId: String, json: String)] = []
    var listCalls = 0
    var cardCalls: [String] = []
    var removes: [Call] = []
    var restores: [Call] = []
    /// `nil` = 200 `{ok, changed: true}`.
    var removeResult: TransportError?
    var restoreResult: TransportError?
    /// 200 with `receipt: "skipped"`.
    var receiptSkipped = false
    /// Holds a removal before its answer.
    var onRemove: (@Sendable () async -> Void)?
    /// Holds a single card read after its answer was taken (a late answer of the text it had then).
    var onCard: (@Sendable () async -> Void)?
  }

  let lock = Mutex(State())

  func set(_ change: (inout State) -> Void) { lock.withLock { change(&$0) } }

  func read<T>(_ value: (State) -> T) -> T { lock.withLock { value($0) } }

  /// Sets the text of a session's card (replacing an earlier one in place).
  func card(_ json: String, for sessionId: String) {
    lock.withLock { state in
      if let index = state.cards.firstIndex(where: { $0.sessionId == sessionId }) {
        state.cards[index].json = json
      } else {
        state.cards.append((sessionId, json))
      }
    }
  }

  fileprivate func list() throws(TransportError) -> InboxList {
    let json = lock.withLock { state in
      state.listCalls += 1
      return #"{"cards":[\#(state.cards.map(\.json).joined(separator: ","))]}"#
    }
    return try decode(InboxList.self, json)
  }

  fileprivate func one(_ sessionId: String) async throws(TransportError) -> InboxCardResponse {
    let (json, hook) = lock.withLock { state in
      state.cardCalls.append(sessionId)
      let json = state.cards.first { $0.sessionId == sessionId }.map { #"{"card":\#($0.json)}"# } ?? "{}"
      return (json, state.onCard)
    }
    await hook?()
    return try decode(InboxCardResponse.self, json)
  }

  fileprivate func remove(_ call: Call) async throws(TransportError) -> InboxActionResponse {
    let (hook, skipped) = lock.withLock { state in
      state.removes.append(call)
      return (state.onRemove, state.receiptSkipped)
    }
    await hook?()
    if let error = lock.withLock({ $0.removeResult }) { throw error }
    return try answer(skipped: skipped)
  }

  fileprivate func restore(_ call: Call) throws(TransportError) -> InboxActionResponse {
    let (error, skipped) = lock.withLock { state in
      state.restores.append(call)
      return (state.restoreResult, state.receiptSkipped)
    }
    if let error { throw error }
    return try answer(skipped: skipped)
  }

  private func answer(skipped: Bool) throws(TransportError) -> InboxActionResponse {
    try decode(InboxActionResponse.self, skipped ? #"{"ok":true,"changed":true,"receipt":"skipped"}"# : #"{"ok":true,"changed":true}"#)
  }

  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws(TransportError) -> T {
    do {
      return try JSONDecoder().decode(type, from: Data(json.utf8))
    } catch {
      throw .invalidResponse("fake Inbox: \(error)")
    }
  }
}

extension FakeTransport {
  func inboxCards() async throws(TransportError) -> InboxList {
    try inbox.list()
  }

  func inboxCard(sessionId: String) async throws(TransportError) -> InboxCardResponse {
    try await inbox.one(sessionId)
  }

  func removeInboxCard(sessionId: String, _ body: InboxActionBody) async throws(TransportError) -> InboxActionResponse {
    try await check("POST", "/api/inbox/\(sessionId)/remove")
    return try await inbox.remove(FakeInboxBackend.Call(sessionId: sessionId, body: body))
  }

  func restoreInboxCard(sessionId: String, _ body: InboxActionBody) async throws(TransportError) -> InboxActionResponse {
    try await check("POST", "/api/inbox/\(sessionId)/restore")
    return try inbox.restore(FakeInboxBackend.Call(sessionId: sessionId, body: body))
  }
}
