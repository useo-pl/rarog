import Foundation
import RarogContract

// The queue take-back: state, events and the typed result of the action (`RarogStore+QueueTakeBack`). Owner: send.

/// Take-backs of the sessions on this device. Changed only by `Reducer+QueueTakeBack`; logout and a server switch
/// reset it with the rest of the view.
public struct QueueTakeBackState: Sendable, Equatable {
  /// Sessions with a take-back request in flight: a second gesture meanwhile sends nothing.
  public internal(set) var inFlight: Set<String> = []
  /// The `operationId` of a take-back without a definitive answer (a lost network, a 5xx, an unreadable 200, a 200
  /// whose texts the draft on disk did not take), per session. The server may have taken the prompts and keeps its
  /// 200 under that id, so the next gesture asks again with the same id instead of a new one that would find the
  /// queue empty. Only a 200 with the texts durably in the draft, the route's 4xx refusal and its 404 drop it; a
  /// refusal before the route (the app's gate, 403, 429) keeps an id an earlier request may have delivered.
  public internal(set) var operations: [String: UUID] = [:]

  public init() {}
}

public enum QueueTakeBackEvent: Sendable, Equatable {
  /// A take-back request goes out with `operationId` (the kept one or a new one).
  case started(sessionId: String, operationId: UUID)
  /// The request ended; `keepOperation`: no definitive answer, the next gesture reuses the id.
  case settled(sessionId: String, keepOperation: Bool)
  /// The server took the messages with these `clientMessageId`s: their outbox entries leave, so no bubble shows
  /// text that now stands in the field.
  case taken(sessionId: String, clientMessageIds: [String])
}

/// A take-back the store started (``RarogStore/startTakeBack(_:)``) and whose request has not gone out yet: its id,
/// whether that id was kept from an earlier take-back without an answer, and the login of the gesture.
public struct QueueTakeBackTicket: Sendable, Equatable {
  public let sessionId: String
  let operationId: UUID
  let kept: Bool
  let login: Int
}

/// Result of one take-back gesture; RarogUI builds the sentence.
public enum QueueTakeBackOutcome: Sendable, Equatable {
  /// 200: the texts went durably to the draft before the entries left. An empty list: nothing was queued.
  case taken(QueueTakeBackResponse)
  /// A refusal before any key (4xx with the server's sentence, or the app's own gate); bubbles stay. A refusal from
  /// before the route keeps an id that an earlier request may have delivered.
  case refused(String?)
  /// 404: a server without the route.
  case serverTooOld
  /// No definitive answer (network, 5xx, an answer outside the contract); the next gesture asks again with the same id.
  case unsure
  /// 200, but the draft on disk did not take the texts: the entries and the id stay, and the next gesture asks again
  /// with the same id.
  case notSaved
  /// A take-back of this session is already in flight: nothing was sent.
  case inFlight
  case loggedOut
}
