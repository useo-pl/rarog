import Foundation

// Reducer branches of the queue take-back. Called from the main `switch` in `Reducer.swift`. Owner: send.
extension AppState {
  mutating func applyQueueTakeBack(_ event: QueueTakeBackEvent) -> [CoreEffect] {
    switch event {
    case let .started(sessionId, operationId):
      queueTakeBack.inFlight.insert(sessionId)
      queueTakeBack.operations[sessionId] = operationId
    case let .settled(sessionId, keepOperation):
      queueTakeBack.inFlight.remove(sessionId)
      if !keepOperation { queueTakeBack.operations[sessionId] = nil }
    case let .taken(sessionId, clientMessageIds):
      // By the returned ids, whatever the entry's state: the server took exactly these messages. An entry of another
      // session never matches, and an entry the server did not name stays with its bubble.
      let taken = Set(clientMessageIds)
      let ids = outbox.filter { $0.sessionId == sessionId && taken.contains($0.clientMessageId) }.map(\.id)
      outbox.removeAll { ids.contains($0.id) }
      for id in ids { sendProgress[id] = nil }
      return ids.map(CoreEffect.forgetOutboxEntry)
    }
    return []
  }
}
