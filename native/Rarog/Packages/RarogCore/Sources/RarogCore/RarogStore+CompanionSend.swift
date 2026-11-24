import Foundation
import RarogContract
import RarogTransport

// The voice agent across sessions sends a prompt it read out and the user confirmed. Owner: voice agent; the outbox
// it goes through belongs to the send area (`RarogStore+Send.swift`).
//
// The prompt is an ordinary text-only send (`queueAware`) of the message route through the durable outbox, with the
// voice agent's sender pair (`source`, `expectedConversation`) saved in the entry, so every attempt carries it. The
// caller gives the `clientMessageId` and keeps it: a repeat after a lost answer reuses it, and the server takes the
// message at most once.

/// Result of a voice agent's prompt send, after the server's answer. RarogUI builds the text for the model.
public enum CompanionSendOutcome: Sendable, Equatable {
  /// 202: the server took the message (also a repeat of an accepted id).
  case sent
  /// 202 with `queued: true`: the message waits in the server's queue until Claude Code takes it.
  case queued
  /// 409 `session.conversation-changed`: the session writes another engine conversation than the token names;
  /// nothing reached the pane. The entry stays as a final refusal with the server's sentence (Discard only).
  case conversationChanged(message: String?)
  case refused(CompanionSendRefusal)
  /// 401, or logout, unpairing or a server change during the send.
  case loggedOut
  /// The caller's task was cancelled, or a person stopped the send on the session screen.
  case cancelled
  /// No answer within the send's limit: not known whether the message arrived. A repeat with the same
  /// `clientMessageId` is safe.
  case timedOut
  /// The connection dropped, the answer was unreadable, or the outbox could not save the entry: not known whether
  /// the message arrived (or it did not go out). A repeat with the same `clientMessageId` is safe.
  case failed
}

/// Why a voice agent's prompt was refused.
public enum CompanionSendRefusal: Sendable, Equatable {
  /// The app's send gate: the session's state or mode takes no message (`AppState.sendBlock(for:)`). Nothing went out.
  case sendBlock(SendBlock)
  /// The client gate (compatibility, a stale list) or the server refused, with the code and the sentence to show.
  case refusal(code: String?, message: String?)
}

/// What one `clientMessageId` names for the voice agent: the session, the exact text and the sender pair. The id's
/// first prompt stays with its send in flight (`RarogStore.companionSends`), in its outbox entry and, after the echo,
/// in ``AppState/echoedPrompts``; a call with the same id and another prompt is another message.
struct CompanionPrompt: Sendable, Equatable {
  let sessionId: String
  let text: String
  let sender: OutboxEntry.Sender

  init(sessionId: String, text: String, sender: OutboxEntry.Sender) {
    self.sessionId = sessionId
    self.text = text
    self.sender = sender
  }

  /// The prompt of a voice agent's entry; `nil` for a typed one.
  init?(_ entry: OutboxEntry) {
    guard let sender = entry.sender else { return nil }
    self.init(sessionId: entry.sessionId, text: entry.text, sender: sender)
  }
}

extension RarogStore {
  /// Sends the voice agent's prompt `text` (exactly as given) to `sessionId` with the `conversation` token the agent
  /// read. `clientMessageId` is the outbox entry's id and the message's `clientMessageId`. A call with the id of an
  /// entry already accepted answers from that entry; a call while another with the same id runs shares its outcome;
  /// a call with the id of an entry left Not confirmed or refused sends that same entry again (its text and pair).
  /// Each of these answers only a call with the id's first session, text and token; any other is refused as
  /// `client-id-conflict` without a request.
  public func sendCompanionPrompt(
    sessionId: String, text: String, conversation: String, clientMessageId: UUID
  ) async -> CompanionSendOutcome {
    let sender = OutboxEntry.Sender(MessageSender(source: .voiceAgent, expectedConversation: conversation))
    let prompt = CompanionPrompt(sessionId: sessionId, text: text, sender: sender)
    if let running = companionSends[clientMessageId] {
      guard running.prompt == prompt else { return Self.idConflict }
      return await Self.shared(running.task)
    }
    let task = Task { await self.companionSend(prompt, id: clientMessageId) }
    companionSends[clientMessageId] = (prompt, task)
    let outcome = await Self.shared(task)
    if companionSends[clientMessageId]?.task == task { companionSends[clientMessageId] = nil }
    return outcome
  }

  /// The same id names the same message: another text, session or token under it is a different message.
  private static let idConflict = CompanionSendOutcome.refused(
    .refusal(code: OutboxEntry.RefusalCode.clientIdConflict, message: nil))

  /// The answer of the echo that settled `id`, if one did: `sent` for the same prompt, the id conflict for another.
  private func echoedAnswer(_ id: UUID, _ prompt: CompanionPrompt) -> CompanionSendOutcome? {
    guard state.echoed[id] != nil else { return nil }
    return state.echoedPrompts[id] == prompt ? .sent : Self.idConflict
  }

  /// Every caller of one send waits for it; a caller's cancellation cancels the send.
  private static func shared(_ task: Task<CompanionSendOutcome, Never>) async -> CompanionSendOutcome {
    await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      task.cancel()
    }
  }

  private func companionSend(_ prompt: CompanionPrompt, id: UUID) async -> CompanionSendOutcome {
    guard state.auth == .loggedIn else { return .loggedOut }
    let login = currentLogin
    if let entry = state.outbox.first(where: { $0.id == id }) {
      guard CompanionPrompt(entry) == prompt else { return Self.idConflict }
      return await repeatCompanionSend(entry, prompt: prompt, login: login)
    }
    // The echo already settled this id: the message is in the conversation.
    if let answer = echoedAnswer(id, prompt) { return answer }
    guard !prompt.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return .refused(.refusal(code: nil, message: nil))
    }
    let sessionId = prompt.sessionId
    if let block = state.sendBlock(for: sessionId) { return .refused(.sendBlock(block)) }
    var entry = OutboxEntry(
      id: id, sessionId: sessionId, text: prompt.text, createdAt: clock(), boundary: state.echoBoundary(for: sessionId),
      sender: prompt.sender)
    entry.queueAware = true
    let fresh = entry
    let spaceChanges = serverRuntime.spaceChanges
    let staged: OutboxEntry
    do {
      staged = try await persistInOrder { try await $0.stage(fresh, payloads: []) }
    } catch {
      return .failed
    }
    // Forget Server or another server during the write: the entry lies in the previous space.
    guard spaceChanges == serverRuntime.spaceChanges else { return .loggedOut }
    dispatch(.outboxEnqueued(staged))
    let (outcome, flight) = await deliverReporting(staged, login: login)
    return companionOutcome(outcome, id: id, prompt: prompt, flight: flight, login: login)
  }

  /// A call with the id of an entry already in the outbox, whose prompt is `prompt`: nothing new is created.
  private func repeatCompanionSend(
    _ entry: OutboxEntry, prompt: CompanionPrompt, login: Int
  ) async -> CompanionSendOutcome {
    // A person's Retry of this entry runs, its manifest write included: its outcome is this call's.
    if let running = retrying[entry.id] {
      let outcome = await running.outcome()
      return companionOutcome(outcome, id: entry.id, prompt: prompt, flight: running, login: login)
    }
    switch entry.state {
    case .sent:
      return entry.isQueued ? .queued : .sent
    case .queued:
      // An attempt of this entry is in flight: its outcome is this call's.
      guard let flight = sendFlights[entry.id] else { return .failed }
      let outcome = await flight.outcome()
      return companionOutcome(outcome, id: entry.id, prompt: prompt, flight: flight, login: login)
    case let .refused(code, message) where !entry.isRetryable:
      // A final refusal (a changed conversation, a conflicting id) answers again without a request.
      let refusal = SendOutcome.refused(entry.id, code: code, message: message)
      return companionOutcome(refusal, id: entry.id, prompt: prompt, flight: nil, login: login)
    case .unconfirmed, .refused:
      let (outcome, flight) = await retryReporting(entry.id)
      return companionOutcome(outcome, id: entry.id, prompt: prompt, flight: flight, login: login)
    }
  }

  /// The outcome of the send of `id`; `flight` is the attempt that went out (`nil`: none). An end that does not know
  /// whether the message arrived (no answer, the entry gone while a repeat's manifest was written, a write refused)
  /// asks the echo: with it the message is in the conversation, so the caller does not send it again under a new id.
  /// An attempt a person stopped answers `cancelled`; its entry stays Not confirmed, as the prompt may have arrived.
  private func companionOutcome(
    _ outcome: SendOutcome, id: UUID, prompt: CompanionPrompt, flight: SendFlight?, login: Int
  ) -> CompanionSendOutcome {
    guard isCurrentLogin(login), state.auth == .loggedIn else { return .loggedOut }
    if Task.isCancelled { return .cancelled }
    switch outcome {
    case .unconfirmed, .ignored, .notPersisted:
      if let answer = echoedAnswer(id, prompt) { return answer }
    case .accepted, .refused, .blocked, .empty:
      break
    }
    switch outcome {
    case .accepted:
      if case .accepted(queued: true)? = flight?.answer { return .queued }
      return .sent
    case .unconfirmed:
      if flight?.stopped != nil { return .cancelled }
      switch flight?.answer {
      case .failed(.timedOut)?: return .timedOut
      case .failed(.cancelled)?: return .cancelled
      default: return .failed
      }
    case let .refused(_, code, message):
      switch code {
      case OutboxEntry.RefusalCode.conversationChanged?: return .conversationChanged(message: message)
      case OutboxEntry.RefusalCode.cancelled?: return .cancelled
      default: return .refused(.refusal(code: code, message: message))
      }
    case let .blocked(block):
      return .refused(.sendBlock(block))
    case .empty:
      return .refused(.refusal(code: nil, message: nil))
    case .notPersisted, .ignored:
      return .failed
    }
  }
}
