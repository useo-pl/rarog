import Foundation
import RarogContract
import RarogTransport

// The queue take-back: the prompts queued in Claude Code and in the server's paste queue come back to the message
// field, as Up on an empty field does in the terminal. The request goes through `tracked` (logout cancels it, a result
// from an older login goes to the bin). Owner: send.
extension RarogStore {
  /// One take-back gesture of `sessionId` (Up on an empty field, a tap on a queued bubble, the VoiceOver action):
  /// ``startTakeBack(_:)`` and then ``finishTakeBack(_:handOver:)``.
  ///
  /// - A second gesture while a request is in flight sends nothing (`.inFlight`).
  /// - One id per take-back: a network failure retries once with the same `operationId`, and an id without a
  ///   definitive answer stays for the next gesture (``QueueTakeBackState/operations``), because the server may have
  ///   taken the prompts and answers a retry with the same id with the same body.
  /// - `handOver` gets the 200 BEFORE the outbox entries of the taken messages leave, and answers whether the texts
  ///   are durably in the draft (the live field written to disk, or the stored draft). Only `true` removes the entries
  ///   and frees the id; `false` keeps both (`.notSaved`), so the next gesture asks again with the same id and gets the
  ///   same texts. A refusal leaves the entries and the bubbles as they were.
  public func takeBackQueue(
    _ sessionId: String, handOver: @MainActor (QueueTakeBackResponse) async -> Bool
  ) async -> QueueTakeBackOutcome {
    guard state.auth == .loggedIn else { return .loggedOut }
    guard let ticket = startTakeBack(sessionId) else { return .inFlight }
    return await finishTakeBack(ticket, handOver: handOver)
  }

  /// The synchronous half of a gesture: the gate, the id and `.started`, so the screen shows the take-back in flight
  /// in the same turn as the gesture, long before the server answers. `nil`: the gesture is ignored (logged out, or
  /// a take-back of the session is already in flight) and nothing changed. The caller hands the ticket to
  /// ``finishTakeBack(_:handOver:)`` at once: until then the session counts as taking back.
  public func startTakeBack(_ sessionId: String) -> QueueTakeBackTicket? {
    guard state.auth == .loggedIn, !state.isTakingBackQueue(sessionId) else { return nil }
    let kept = state.queueTakeBack.operations[sessionId]
    let operationId = kept ?? UUID()
    dispatch(.queueTakeBack(.started(sessionId: sessionId, operationId: operationId)))
    return QueueTakeBackTicket(sessionId: sessionId, operationId: operationId, kept: kept != nil, login: currentLogin)
  }

  /// The request of a started take-back, its retry and the hand-over (rules: ``takeBackQueue(_:handOver:)``).
  public func finishTakeBack(
    _ ticket: QueueTakeBackTicket, handOver: @MainActor (QueueTakeBackResponse) async -> Bool
  ) async -> QueueTakeBackOutcome {
    let sessionId = ticket.sessionId
    let operationId = ticket.operationId
    let login = ticket.login
    // A logout between the two halves reset the take-back state; nothing of the old login goes out.
    guard isCurrentLogin(login), state.auth == .loggedIn else { return .loggedOut }
    // A request with this id may have reached the server, which then holds its 200 under the id for a replay.
    var delivered = ticket.kept
    var result = await tracked { try await $0.takeBackQueue(sessionId: sessionId, operationId: operationId) }
    if case let .failure(error)? = result, Self.isNetworkFailure(error) {
      delivered = true
      try? await Task.sleep(for: TurnControlTiming.interruptRetryDelay)
      // The retry belongs to the login of the gesture: after a logout in the pause nothing goes out.
      guard isCurrentLogin(login), state.auth == .loggedIn else { return .loggedOut }
      result = await tracked { try await $0.takeBackQueue(sessionId: sessionId, operationId: operationId) }
    }
    guard let result else { return .loggedOut }
    switch result {
    case let .success(reply):
      let saved = await handOver(reply)
      // A logout during the write reset the take-back state, and the entries of the old login stay untouched; a
      // gesture of a new login may already be in flight, so nothing of this one is dispatched.
      guard isCurrentLogin(login), state.auth == .loggedIn else { return .loggedOut }
      guard saved else {
        dispatch(.queueTakeBack(.settled(sessionId: sessionId, keepOperation: true)))
        return .notSaved
      }
      dispatch(.queueTakeBack(.taken(sessionId: sessionId, clientMessageIds: reply.items.compactMap(\.clientMessageId))))
      dispatch(.queueTakeBack(.settled(sessionId: sessionId, keepOperation: false)))
      return .taken(reply)
    case let .failure(error):
      let (outcome, settlement) = takeBackVerdict(error, login: login)
      let keep = switch settlement {
      case .free: false
      case .keep: true
      case .keepIfDelivered: delivered
      }
      dispatch(.queueTakeBack(.settled(sessionId: sessionId, keepOperation: keep)))
      return outcome
    }
  }

  /// What a failed request does to the take-back's id.
  private enum TakeBackSettlement {
    /// The route answered: the operation is decided, the id goes.
    case free
    /// No definitive answer: the server may have taken the prompts.
    case keep
    /// This request decided nothing; the id stays if an earlier request with it may have reached the server.
    case keepIfDelivered
  }

  /// Error → verdict and the id's fate. Only the route's own answer decides the operation: a 4xx refusal (the server
  /// freed the id too) or a 404 (a server without the route). The app's gate sent nothing, and a 403 (the origin
  /// check, the proxy) or a 429 (the auth throttle) stopped the request before the route, so they decide nothing. A
  /// network failure, a 5xx and an answer outside the contract do not prove nothing was taken.
  private func takeBackVerdict(_ error: TransportError, login: Int) -> (QueueTakeBackOutcome, TakeBackSettlement) {
    switch error {
    case let .http(failure) where failure.status == 404: return (.serverTooOld, .free)
    case let .http(failure) where failure.status < 500: return (.refused(failure.message), .free)
    case let .forbidden(failure), let .rateLimited(failure): return (.refused(failure.message), .keepIfDelivered)
    case let .refused(refusal): return (.refused(refusal.message), .keepIfDelivered)
    case .unauthorized:
      handleUnauthorized(since: login)
      return (.loggedOut, .keepIfDelivered)
    case .http, .offline, .timedOut, .cancelled, .invalidResponse: return (.unsure, .keep)
    }
  }
}
