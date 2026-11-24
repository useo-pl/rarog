import Foundation
import RarogContract
import RarogCore

// The prompt pair of the voice conversation across sessions: `show_prompt` binds a prompt to one session of the list
// and has the conversation read it aloud; `send_prompt` sends it (`VoiceAgentSessionsHost+PromptSend.swift`) only
// after the user confirmed in an utterance that began after the reading ended. Owner: voice agent. A sent prompt runs
// at once and cannot be taken back, so every doubt ends in a refusal with nothing sent, and a prompt never goes out
// twice. The sentences for the model: `VoiceAgentSessionsHost+PromptText.swift`.
//
// - `show_prompt(handle, text)`: the text is the argument trimmed, at most `promptMaxCharacters` characters, not
//   masked or trimmed further: what is read, shown and sent is the same string. A send in flight refuses it and keeps
//   its prompt. Any other call binds first, before its first `await`: the waiting prompt goes (the instructions tell
//   the model that a new `show_prompt` replaces it), a waiting announcement of `check_open_requests` goes too, and the
//   call's response is stamped. Then it is refused, with nothing shown or read and nothing waiting, for an empty text,
//   a longer one, the end rules (`blocked()`) and a handle not on the list, and after the catalog read for a session
//   that left the list, one with the same project and name as another row (also one the list numbers with `#n`), one
//   that waits on a dialog, a binding a newer show or the check replaced, and a call a cut overtook. Otherwise it
//   captures from the target's row the server's session id, the catalog's `conversation` token, the project and the
//   name, with the exact text and a new `clientMessageId`; the send uses only these values. The prompt goes to the
//   owner for the bar (``onPrompt``), the target becomes the discussed session, and the call reads exactly
//   `UICopy.voiceAgentSessionsPromptReading`.
// - The reading's end: played out whole marks the prompt read and gives the measured sentence; not read leaves it
//   unread and tells the model to call `show_prompt` again. A cut never reaches the host, so a prompt is unread until
//   its reading played out whole. The end of a prompt that a newer one replaced changes nothing.
// - One consent waits at a time: `show_prompt` drops the check's announcement, the check's announcement drops a
//   waiting prompt, and while a send is in flight the check announces nothing (`VoiceAgentSessionsHost+Check.swift`).
// - The last send's outcome stays with its session, token, text and id (``VoiceAgentPromptLock/sent``) until an answer
//   plays out whole with no cut since the call that returned it, because the conversation drops tool results on a cut.
//   Until then a `show_prompt` of the same session, token and text keeps that id when the prompt went out or may have,
//   and its result says so; one for other content notes how the last send ended. A result with such a note counts as
//   that outcome returned again.
// - The end of the conversation drops the waiting prompt and the kept outcome; nothing goes out for them.
// - `client.log`: `voice-agent: prompt shown`, `prompt read whole`, `prompt not read`, `prompt refused (<code>)`,
//   `prompt dropped (check)`, never the text, a name or an id.

/// What the bar shows of the waiting prompt: the project and the session name as the list gave them to the model, and
/// the exact text that was read and that a send sends.
struct VoiceAgentShownPrompt: Sendable, Equatable {
  let project: String
  let name: String
  let text: String
}

/// The prompt lock of one conversation across sessions: the binding of a `show_prompt` in flight, the prompt it bound
/// and the last send's outcome. Every change is synchronous; the host awaits around it.
struct VoiceAgentPromptLock: Sendable, Equatable {
  /// A prompt `show_prompt` bound: what was read and what a send sends, captured once.
  struct Prompt: Sendable, Equatable {
    /// The binding: a newer show, the check's announcement and the end change it.
    let number: Int
    /// The response that called `show_prompt`.
    let response: String
    let sessionId: String
    let project: String
    let name: String
    /// The catalog's `conversation` token of the session at the show.
    let conversation: String
    let text: String
    let clientMessageId: UUID
    /// The session worked (`working`) at the show.
    let working: Bool
    /// Its reading played out whole.
    var read = false
    /// The kept utterances at the call of the last send whose outcome is not known; `nil`: no such send.
    var attempt: Int?
  }

  /// How a send ended, with its `client.log` code.
  enum SendEnd: String, Sendable, Equatable {
    case sent
    case queued
    case conversationChanged = "conversation-changed"
    case refused
    case loggedOut = "logged-out"
    case timedOut = "timeout"
    case failed
    case cancelled

    /// Not known whether the prompt arrived: the prompt stays with its id.
    var uncertain: Bool { self == .timedOut || self == .failed || self == .cancelled }
    /// The prompt went out or may have.
    var wentOut: Bool { self == .sent || self == .queued || uncertain }
  }

  /// The last send's outcome and what it sent.
  struct Sent: Sendable, Equatable {
    let sessionId: String
    let conversation: String
    let text: String
    let clientMessageId: UUID
    let end: SendEnd
    /// The plain sentence for the model, and the encoded result.
    let sentence: String
    let output: String
    /// The cut count at the start of the last call that returned it.
    var since: Int
  }

  /// A `show_prompt` bound before its catalog read: no prompt waits yet.
  struct Pending: Sendable, Equatable {
    let number: Int
    let response: String
  }

  private(set) var numbers = 0
  private(set) var pending: Pending?
  private(set) var prompt: Prompt?
  private(set) var sent: Sent?

  var shown: VoiceAgentShownPrompt? {
    prompt.map { VoiceAgentShownPrompt(project: $0.project, name: $0.name, text: $0.text) }
  }

  /// A `show_prompt` of `response` binds: the waiting prompt goes. Returns the binding's number.
  mutating func bind(response: String) -> Int {
    numbers += 1
    prompt = nil
    pending = Pending(number: numbers, response: response)
    return numbers
  }

  /// `number` is still the binding in progress.
  func binding(_ number: Int) -> Bool { pending?.number == number }

  /// The `show_prompt` of binding `number` was refused: when it is still the binding in progress, nothing waits.
  mutating func release(_ number: Int) {
    if binding(number) { pending = nil }
  }

  /// The binding in progress becomes the waiting prompt.
  mutating func show(_ prompt: Prompt) {
    guard binding(prompt.number) else { return }
    self.prompt = prompt
    pending = nil
  }

  /// The reading of prompt `number` played out whole; false when another prompt or none waits.
  mutating func read(_ number: Int) -> Bool {
    guard prompt?.number == number else { return false }
    prompt?.read = true
    return true
  }

  /// The waiting prompt and a binding in progress go.
  mutating func drop() {
    numbers += 1
    prompt = nil
    pending = nil
  }

  /// A send of prompt `number`, called at `utterances` kept utterances, ended without knowing whether it arrived.
  mutating func attempted(_ number: Int, utterances: Int) {
    guard prompt?.number == number else { return }
    prompt?.attempt = utterances
  }

  mutating func keep(_ sent: Sent) { self.sent = sent }

  /// `send_prompt` returned the kept outcome again, in a call that started at cut count `since`. The latest call
  /// counts, in whatever order the calls come back.
  mutating func reported(since: Int) {
    if let kept = sent?.since { sent?.since = max(kept, since) }
  }

  /// An answer played out whole at cut count `cuts`: with no cut since the call that returned it, the model got the
  /// kept outcome, and it goes.
  mutating func playedWhole(cuts: Int) {
    if sent?.since == cuts { sent = nil }
  }

  /// The end of the conversation: nothing waits and nothing is kept.
  mutating func end() {
    drop()
    sent = nil
  }

  /// The last send of this exact prompt, when it went out or may have: its id names the same message.
  func lastSend(sessionId: String, conversation: String, text: String) -> Sent? {
    guard let sent, sent.end.wentOut, sent.sessionId == sessionId, sent.conversation == conversation, sent.text == text
    else { return nil }
    return sent
  }
}

extension VoiceAgentSessionsHost {
  /// The longest prompt `show_prompt` takes, in characters: Soniox reads one stream for at most 180 s.
  nonisolated static let promptMaxCharacters = 1000

  /// `show_prompt` at `turn`.
  func showPrompt(handle: String?, text: String?, at turn: RealtimeToolTurn) async -> RealtimeToolResult {
    // The prompt of a send in flight stays with it: an outcome that does not say whether it arrived keeps it.
    guard sendRun == nil else { return refusedShow(nil, VoiceAgentPromptText.sending, "sending") }
    // Bound before every other refusal and before the first `await`: a new `show_prompt` replaces the waiting prompt,
    // as the instructions tell the model, and a `send_prompt` while the catalog is read finds no older prompt.
    let start = discussion.cuts
    let number = prompts.bind(response: turn.response)
    if check != VoiceAgentCheck() {
      check = VoiceAgentCheck()
      trace("voice-agent: check ended (prompt)")
    }
    guard let text else { return refusedShow(number, VoiceAgentPromptText.empty, "empty") }
    guard text.count <= Self.promptMaxCharacters else {
      return refusedShow(number, VoiceAgentPromptText.tooLong, "too-long")
    }
    if let refusal = blocked() { return refusedShow(number, output: refusal.output, refusal.code) }
    guard let handle, rows.contains(where: { $0.handle == handle }) else {
      return refusedShow(number, VoiceAgentPromptText.unknownHandle, "unknown-handle")
    }
    if case let .refused(output, code) = await refresh() { return refusedShow(number, output: output, code) }
    if let refusal = blocked() { return refusedShow(number, output: refusal.output, refusal.code) }
    guard let row = rows.first(where: { $0.handle == handle }), let conversation = conversations[row.sessionId] else {
      return refusedShow(number, VoiceAgentPromptText.unknownHandle, "unknown-handle")
    }
    guard !ambiguous(row) else { return refusedShow(number, VoiceAgentPromptText.ambiguous, "ambiguous") }
    guard !onDialog(row) else { return refusedShow(number, VoiceAgentPromptText.dialog, "dialog") }
    guard prompts.binding(number) else { return refusedShow(number, VoiceAgentPromptText.replaced, "newer") }
    guard !discussion.overtaken(since: start) else {
      return refusedShow(number, VoiceAgentPromptText.spokenOver, "cut")
    }
    let last = prompts.sent
    let same = prompts.lastSend(sessionId: row.sessionId, conversation: conversation, text: text)
    prompts.show(
      VoiceAgentPromptLock.Prompt(
        number: number, response: turn.response, sessionId: row.sessionId, project: row.project, name: row.name,
        conversation: conversation, text: text, clientMessageId: same?.clientMessageId ?? UUID(),
        working: row.state == .working))
    point(at: row, since: start)
    trace("voice-agent: prompt shown")
    let note = same.map { VoiceAgentPromptText.sameAsLastSend($0.end) }
      ?? last.map { VoiceAgentPromptText.lastSend($0.sentence) }
    let reading = UICopy.voiceAgentSessionsPromptReading(project: row.project, name: row.name, text: text)
    return .read(reading) { [weak self] outcome in
      self?.promptRead(number, outcome, note: note) ?? RealtimeConversation.toolError(VoiceAgentPromptText.replaced)
    }
  }

  /// The reading of prompt `number` ended.
  private func promptRead(_ number: Int, _ outcome: RealtimeReadingOutcome, note: String?) -> String {
    guard prompts.prompt?.number == number else {
      trace("voice-agent: prompt refused (newer)")
      return RealtimeConversation.toolError(VoiceAgentPromptText.replaced)
    }
    switch outcome {
    case .whole:
      _ = prompts.read(number)
      trace("voice-agent: prompt read whole")
      // The note tells the model how the last send ended, so it counts as that outcome returned again.
      if note != nil { prompts.reported(since: discussion.cuts) }
      let sentence = [VoiceAgentPromptText.shown, note].compactMap(\.self).joined(separator: " ")
      return RealtimeConversation.toolResult(sentence)
    case .notRead:
      trace("voice-agent: prompt not read")
      return RealtimeConversation.toolError(VoiceAgentPromptText.notReadAloud)
    }
  }

  /// Another row has the same project and name, or the list numbers this one with `#n` (another catalog session with
  /// the same project and label): the reading could mean either.
  private func ambiguous(_ row: VoiceAgentSessionRow) -> Bool {
    var listed = backend.state
    listed.sessions = listed.sessions.filter { conversations[$0.key] != nil }
    if listed.duplicateOrdinals[row.sessionId] != nil { return true }
    return rows.contains { $0.sessionId != row.sessionId && $0.project == row.project && $0.name == row.name }
  }

  /// A permission or a question waits on the session.
  func onDialog(_ row: VoiceAgentSessionRow) -> Bool {
    row.state == .dialog || backend.state.sessions[row.sessionId]?.isWaitingForDecision == true
  }

  /// A refused `show_prompt` shows and reads nothing; its binding `number` (`nil`: none) waits no more.
  private func refusedShow(_ number: Int?, _ sentence: String, _ code: String) -> RealtimeToolResult {
    refusedShow(number, output: RealtimeConversation.toolError(sentence), code)
  }

  private func refusedShow(_ number: Int?, output: String, _ code: String) -> RealtimeToolResult {
    if let number { prompts.release(number) }
    trace("voice-agent: prompt refused (\(code))")
    return .output(output)
  }
}
