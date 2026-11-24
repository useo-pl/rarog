import Foundation
import RarogContract
import RarogCore

// The voice conversation at one Claude Code session: the session screen's host of the conversation core
// (`VoiceAgentHost`). Owner: voice agent. The screen (`SessionViewController+VoiceAgent.swift`) sets the field
// closures and the app state input; the rules stand here and in `VoiceAgentRules.swift`, so the tests run on macOS.
//
// - Content: the session transcript in the phone window (`VoiceAgentBackend.transcript`), projected into the
//   instructions (`RealtimeProjector.project`, `RealtimeInstructions.full`), and after each closed utterance the
//   turns that are new since (`VoiceAgentTranscriptSource`).
// - Tools (`RealtimeInstructions+SessionHost.swift`): `ask_session` → `POST /api/sessions/<id>/companion/ask`, the
//   result for the model from `VoiceAgentToolText`; `show_prompt` → the prompt in the message field (`placePrompt` of
//   the screen, `VoiceAgentDraft`); `send_prompt` → the send operation of the field, the same as ↑ (`sendField` of the
//   screen), only while the prompt stands in the field; the result from `VoiceAgentToolText.send`.
// - End rules: `VoiceAgentWatch` over the app state the screen reports (`watchInput`): `/clear`, `/resume`, another
//   session, background, hidden field, turned off, logout, unpairing, other server.

@MainActor
final class VoiceAgentSessionHost: VoiceAgentHost {
  let sessionId: String
  /// Writes a prompt with its version into the message field (`show_prompt`); `nil` = no field, the tool refuses.
  var placePrompt: (@MainActor (String, Int) -> RealtimePromptShown)?
  /// Sends the message field while the prompt with this version stands in it (`send_prompt`): the send operation of
  /// the field, the same as ↑. `nil` result = the field no longer holds that prompt, nothing taken.
  var sendField: (@MainActor (Int) async -> ComposerSendResult?)?
  /// What of the app state counts for the end rules now; `nil` = no screen: the conversation does not start, and a
  /// running one is left to the screen's own end.
  var watchInput: (@MainActor () -> VoiceAgentWatch.Input?)?
  /// The field the prompt goes into: its edit rule stands in the instructions and the prompt tools' descriptions.
  var promptField = RealtimePromptField.messageField

  private let backend: any VoiceAgentBackend
  private var watch: VoiceAgentWatch?

  init(sessionId: String, backend: any VoiceAgentBackend) {
    self.sessionId = sessionId
    self.backend = backend
  }

  func content() -> RealtimeConversation.Content {
    .session(
      messages: { [weak self] in
        guard let self else { return [] }
        return self.backend.transcript(sessionId: self.sessionId)
      },
      askSession: { [weak self] question in await self?.ask(question) ?? VoiceAgentToolText.ask(.cancelled) },
      showPrompt: { [weak self] text, version in
        self?.place(text, version: version) ?? RealtimePromptShown(placement: .refused(reason: "the message field is gone"))
      },
      sendPrompt: { [weak self] version in await self?.send(version) ?? VoiceAgentToolText.send(nil) },
      field: promptField)
  }

  /// The watch starts from the app state of this moment: changes that end the conversation count from it.
  func startRefusal() -> VoiceAgentWatch.Reason? {
    guard let input = watchInput.flatMap({ $0() }) else { return .fieldHidden }
    var watch = VoiceAgentWatch(sessionId: sessionId, start: input)
    if let reason = watch.check(input) { return reason }
    self.watch = watch
    return nil
  }

  func endReason() -> VoiceAgentWatch.Reason? {
    guard var watch, let input = watchInput.flatMap({ $0() }) else { return nil }
    let reason = watch.check(input)
    self.watch = watch
    return reason
  }

  private func ask(_ question: String) async -> String {
    VoiceAgentToolText.ask(await backend.ask(sessionId: sessionId, question: question))
  }

  private func place(_ text: String, version: Int) -> RealtimePromptShown {
    guard let placePrompt else {
      return RealtimePromptShown(placement: .refused(reason: "the message field is not on screen"))
    }
    return placePrompt(text, version)
  }

  private func send(_ version: Int) async -> String {
    guard let sendField else { return VoiceAgentToolText.send(nil) }
    return VoiceAgentToolText.send(await sendField(version))
  }

  /// The conversation's session as the app's list names it.
  var microphoneSubject: MicrophoneSubject { .of(backend.sessionSummary(sessionId)) }
}

extension RealtimeConversation.Content {
  /// The conversation at one session: its transcript as content, `ask_session`, `show_prompt` and `send_prompt` as
  /// tools. `messages`: the transcript messages in the phone window; `showPrompt` writes the prompt with its version
  /// into the message field or refuses with a reason; `sendPrompt` sends the field while the prompt with that version
  /// stands in it → the result for the model. `field`: the field the prompt goes into, whose edit rule the
  /// instructions and the prompt tools' descriptions state.
  @MainActor
  static func session(
    messages: @escaping @MainActor () -> [TranscriptMessage],
    askSession: @escaping @MainActor (String) async -> String,
    showPrompt: @escaping @MainActor (String, Int) -> RealtimePromptShown,
    sendPrompt: @escaping @MainActor (Int) async -> String,
    field: RealtimePromptField = .messageField
  ) -> Self {
    let transcript = VoiceAgentTranscriptSource(messages: messages, field: field)
    return Self(
      budget: RealtimeProjector.budget,
      instructions: { transcript.instructions(budget: $0) },
      update: { transcript.update() },
      tools: [
        RealtimeToolSpec(
          name: RealtimeTool.askSession.rawValue, schema: schema(.askSession, field), tally: .ask,
          action: { arguments in
            guard let question = RealtimeConversation.argument(arguments, RealtimeTool.questionField) else {
              return .answer(RealtimeConversation.toolError("The question is empty."))
            }
            return .work(checking: true) { await askSession(question) }
          }),
        RealtimeToolSpec(
          name: RealtimeTool.showPrompt.rawValue, schema: schema(.showPrompt, field), tally: nil,
          action: { arguments in
            guard let text = RealtimeConversation.argument(arguments, RealtimeTool.textField) else {
              return .answer(RealtimeConversation.toolError("The prompt is empty."))
            }
            return .showPrompt { version in
              let shown = showPrompt(text, version)
              if case let .refused(reason) = shown.placement {
                let refusal =
                  switch field {
                  case .messageField:
                    "The prompt was not written: the message field is read-only now: \(reason). Tell the user."
                  case .inboxReply: RealtimeInstructions.inboxPromptRefused(reason)
                  }
                return .refused(RealtimeConversation.toolError(refusal))
              }
              return .shown(RealtimeConversation.toolResult(VoiceAgentToolText.shownText(shown)))
            }
          }),
        RealtimeToolSpec(
          name: RealtimeTool.sendPrompt.rawValue, schema: schema(.sendPrompt, field), tally: .send,
          action: { _ in .sendPrompt(refusals: promptRefusals(field), sendPrompt) }),
      ])
  }

  /// The schema of `tool` from `RealtimeInstructions.tools(field)`.
  private static func schema(_ tool: RealtimeTool, _ field: RealtimePromptField) -> [String: Any] {
    RealtimeInstructions.tools(field).first { $0["name"] as? String == tool.rawValue } ?? [:]
  }

  /// What `send_prompt` hears when nothing is sent before the send operation of `field`.
  @MainActor
  private static func promptRefusals(_ field: RealtimePromptField) -> RealtimePromptRefusals {
    let noPrompt =
      switch field {
      case .messageField: "No prompt is in the message field. Call \(RealtimeTool.showPrompt.rawValue) first."
      case .inboxReply: RealtimeInstructions.inboxNoPrompt
      }
    return RealtimePromptRefusals(
      noPrompt: RealtimeConversation.toolError(noPrompt),
      promptGone: RealtimeConversation.toolError(VoiceAgentToolText.promptGone),
      unreachable: VoiceAgentToolText.unreachable)
  }
}

/// The session transcript as the conversation's content: the projection into the instructions, then the turns that
/// are new since. Every projection starts the updates over from what it put in (a new start, the retry with half the
/// budget).
@MainActor
final class VoiceAgentTranscriptSource {
  private let messages: @MainActor () -> [TranscriptMessage]
  /// The field the prompt goes into, for the role's prompt rules.
  private let field: RealtimePromptField
  private var lastSyncedSeq: Int?
  private var knownTurns = 0

  init(messages: @escaping @MainActor () -> [TranscriptMessage], field: RealtimePromptField = .messageField) {
    self.messages = messages
    self.field = field
  }

  func instructions(budget: Int) -> String {
    let projection = RealtimeProjector.project(messages(), budget: budget)
    lastSyncedSeq = projection.lastSeq
    knownTurns = projection.turns
    return RealtimeInstructions.full(projection, field: field)
  }

  func update() -> String? {
    let messages = messages()
    guard let newest = messages.map(\.seq).max() else { return nil }
    // A server restart numbers the transcript anew: from now on the new numbering counts.
    if let last = lastSyncedSeq, newest < last {
      lastSyncedSeq = newest
      return nil
    }
    let after = lastSyncedSeq ?? Int.min
    lastSyncedSeq = newest
    guard let update = RealtimeProjector.update(messages, after: after, turnBase: knownTurns) else { return nil }
    knownTurns += update.newTurns
    return RealtimeInstructions.update(update)
  }
}
