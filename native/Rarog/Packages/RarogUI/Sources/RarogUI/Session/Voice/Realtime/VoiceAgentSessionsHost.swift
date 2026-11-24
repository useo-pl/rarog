import Foundation
import RarogContract
import RarogCore

// The voice conversation across sessions: the second host of the conversation core (`VoiceAgentHost`), next to the
// session screen's `VoiceAgentSessionHost`. Owner: voice agent. Its owner, above navigation, is
// `VoiceAgentSessionsConversation`; the rules stand here, in `VoiceAgentSessionList.swift` and
// `VoiceAgentSessionReads.swift`, so the tests run on macOS.
//
// - One host per conversation. Its owner awaits ``VoiceAgentSessionsHost/prepare()`` (the opening session list from
//   the voice agent's catalog, `GET /api/companion/sessions`), then builds `VoiceAgentSession` with the host, sets
//   ``VoiceAgentSessionsHost/requestEndCheck`` to the session's `observe()` and starts it.
// - Content: the instructions with the opening session list (`RealtimeInstructions+SessionsHost.swift`); nothing
//   arrives on its own during the conversation: the model calls `list_sessions` when the list may have changed.
// - Tools: `list_sessions` (the list), `read_sessions` (the turns route, `GET /api/sessions/<id>/companion/turns`),
//   `discuss_session` (the discussed session) and `ask_session` (the question route,
//   `POST /api/sessions/<id>/companion/ask`, at most ``questionCeiling`` per conversation) and `check_open_requests`
//   (`VoiceAgentSessionsHost+Check.swift`; its questions count toward the same ceiling), and the prompt pair
//   `show_prompt` and `send_prompt` (`VoiceAgentSessionsHost+Prompt.swift`, the message route through
//   `RarogStore.sendCompanionPrompt`). Before every tool the host reads the catalog again; a session outside it does
//   not reach the model in any form, not even as a `#n`, and a handle that is not on the list is a refusal. Before
//   every request to Rarog and before an answer goes to the model, a tool checks the end rules below: after a logout,
//   another login, the mode not offered or a read session's new conversation it refuses and asks nothing. A refusal
//   is a fixed sentence: the server's message never goes to the model, except the sentence of a refused prompt.
// - Handles (`s1`, `s2`…) stand for sessions in this conversation; the server's session id never goes to the model
//   or to `client.log`. Each read leaves a ``VoiceAgentSessionRead`` with the turns answer's `conversation` and
//   `readMark` as the server sent them.
// - The discussed session and the pick-up of its result: `VoiceAgentSessionsHost+Discussion.swift`.
// - End rules: logout, another login, the mode not offered, the owner's reasons (`ownerReason`), and a new engine
//   conversation (`conversation`) of a session read in this conversation, seen in a catalog or a turns answer.
// - The owner tells the host every end of its conversation (`conversationEnded()`): after it no tool asks Rarog,
//   a tool in flight keeps nothing, and the handles and the reads are gone.
// - `client.log`: `voice-agent:` lines with counts of sessions, reads and questions, never names, handles' targets
//   or text.

/// The route of the conversation across sessions to Rarog: the store in the app, a fake in the tests.
@MainActor
protocol VoiceAgentSessionsBackend: VoiceAgentBackend {
  /// The app state: the session list, the server's capabilities, the login.
  var state: AppState { get }
  /// `GET /api/companion/sessions`: the sessions the voice agent may see.
  func loadCompanionSessions() async -> CompanionSessionsOutcome
  /// `GET /api/sessions/<id>/companion/turns?count=<count>`: the last turns of one session.
  func loadCompanionTurns(sessionId: String, count: Int) async -> CompanionTurnsOutcome
  /// `POST /api/sessions/<id>/seen` with `by: voice-agent`: the pick-up of the result one turns read returned.
  func pickUpCompanionResult(sessionId: String, conversation: String, readMark: String) async
    -> CompanionPickUpOutcome
  /// `POST /api/sessions/<id>/messages` with `source: voice-agent` and the `conversation` token the agent read: the
  /// prompt the user confirmed, through the outbox, under the caller's `clientMessageId`.
  func sendCompanionPrompt(sessionId: String, text: String, conversation: String, clientMessageId: UUID) async
    -> CompanionSendOutcome
}

extension RarogStore: VoiceAgentSessionsBackend {}

@MainActor
final class VoiceAgentSessionsHost: VoiceAgentHost {
  /// Why ``prepare()`` gave no opening list; the owner shows it and does not start the conversation.
  enum PrepareRefusal: Sendable, Equatable {
    case loggedOut
    /// The mode across sessions is not offered (``AppState/companionSessionsOffered(sonioxAllowed:)``) or the server
    /// turned it off.
    case off
    /// The catalog could not be read (network, server).
    case unavailable
  }

  /// Questions through the question route in one conversation.
  static let questionCeiling = 30

  /// Asks the conversation core to check the end rules now (`VoiceAgentSession.observe()`): a tool saw a read
  /// session's new conversation.
  var requestEndCheck: (@MainActor () -> Void)?
  /// What the owner adds to the end rules (the app in the background, the mode's consent withdrawn, a lost server
  /// connection); `nil` = nothing. It counts after a logout, another login and the mode not offered.
  var ownerReason: (@MainActor () -> VoiceAgentWatch.Reason?)?
  /// The newest read of each session in this conversation, by the server's session id.
  private(set) var reads: [String: VoiceAgentSessionRead] = [:]
  /// The discussed session and its pick-up (`VoiceAgentSessionsHost+Discussion.swift`); a change of the discussed
  /// session reaches ``onDiscussed``.
  var discussion = VoiceAgentDiscussion() {
    didSet { if discussion.session != oldValue.session { onDiscussed?(discussion.session) } }
  }
  /// The owner shows the discussed session on the bar; `nil` = none (cleared, or the conversation ended).
  var onDiscussed: (@MainActor (VoiceAgentDiscussed?) -> Void)?

  let backend: any VoiceAgentSessionsBackend
  private let sonioxAllowed: Bool
  private let now: @MainActor () -> Date
  private(set) var handles = VoiceAgentHandles()
  /// The list as the model last got it (the opening list, then each catalog read before a tool).
  private(set) var rows: [VoiceAgentSessionRow] = []
  /// The list of the instructions; `nil` until ``prepare()`` gave it.
  private var opening: String?
  /// The login of ``prepare()``.
  private var login: Int?
  /// Questions through the question route in this conversation: `ask_session` and the check count them.
  var questions = 0
  /// The announcement of `check_open_requests` that waits for the user's word (`VoiceAgentSessionsHost+Check.swift`).
  var check = VoiceAgentCheck()
  /// The check's run in flight; a cut and the end of the conversation cancel it, and its request with it.
  var checkRun: Task<String, Never>?
  /// The prompt of `show_prompt` and the last send's outcome (`VoiceAgentSessionsHost+Prompt.swift`); a change of the
  /// prompt the bar shows reaches ``onPrompt``.
  var prompts = VoiceAgentPromptLock() {
    didSet { if prompts.shown != oldValue.shown { onPrompt?(prompts.shown) } }
  }
  /// The owner shows the waiting prompt on the bar; `nil` = none (sent, dropped, or the conversation ended).
  var onPrompt: (@MainActor (VoiceAgentShownPrompt?) -> Void)?
  /// The send in flight. Nothing in the host cancels it: a cut and the end leave it to the outbox.
  var sendRun: Task<String, Never>?
  /// The count of the user's kept utterances when the last sound over a playing answer came; `nil`: none came
  /// (`VoiceAgentSessionsHost+PromptSend.swift`).
  var soundAt: Int?
  /// The `conversation` token of each catalog session at the last catalog read, by the server's session id.
  private(set) var conversations: [String: String] = [:]
  private var sessionReads = 0
  /// A tool saw a read session's new conversation.
  private var conversationChanged = false
  /// The owner said the conversation ended (``conversationEnded()``); a host serves one conversation, so it stays.
  private var ended = false

  init(backend: any VoiceAgentSessionsBackend, sonioxAllowed: Bool, now: @escaping @MainActor () -> Date = Date.init) {
    self.backend = backend
    self.sonioxAllowed = sonioxAllowed
    self.now = now
  }

  /// The newest read of the session behind `handle` in this conversation.
  func read(handle: String) -> VoiceAgentSessionRead? {
    reads.values.first { $0.handle == handle }
  }

  /// A new conversation: the handles, reads, questions and end reason start over, and the opening list comes from
  /// the catalog. `nil` = ready to start.
  func prepare() async -> PrepareRefusal? {
    handles = VoiceAgentHandles()
    rows = []
    reads = [:]
    opening = nil
    questions = 0
    sessionReads = 0
    conversationChanged = false
    discussion = VoiceAgentDiscussion()
    check = VoiceAgentCheck()
    prompts = VoiceAgentPromptLock()
    conversations = [:]
    guard backend.state.auth == .loggedIn else { return .loggedOut }
    guard backend.state.companionSessionsOffered(sonioxAllowed: sonioxAllowed) else { return .off }
    login = backend.loginEpoch
    switch await loadRows() {
    case .listed:
      opening = VoiceAgentSessionList.text(rows)
      trace("voice-agent: start with \(count(rows.count, "session"))")
      return nil
    case let .refused(_, code):
      trace("voice-agent: start refused (\(code))")
      switch code {
      case Refusal.off.code: return .off
      case Refusal.unreachable.code: return .loggedOut
      default: return .unavailable
      }
    }
  }

  /// The owner's word that its conversation ended, whatever ended it (the end button, the background, the audio,
  /// Soniox, an end rule). From then on every tool refuses and asks nothing, a tool in flight asks nothing more and
  /// keeps no read, and the handles, the reads, the list and the opening list are gone. A waiting prompt goes, unsent;
  /// a send in flight is not cancelled (`VoiceAgentSessionsHost+Prompt.swift`).
  func conversationEnded() {
    ended = true
    reads = [:]
    handles = VoiceAgentHandles()
    rows = []
    conversations = [:]
    opening = nil
    discussion = VoiceAgentDiscussion()
    check = VoiceAgentCheck()
    checkRun?.cancel()
    prompts.end()
  }

  func content() -> RealtimeConversation.Content {
    RealtimeConversation.Content(
      budget: RealtimeProjector.budget,
      // The list is small next to the budget: the retry with half the budget sends the same list.
      instructions: { [weak self] _ in RealtimeInstructions.sessionsFull(list: self?.opening ?? "[]") },
      update: { nil },
      tools: [
        RealtimeToolSpec(
          name: VoiceAgentSessionsTool.listSessions.rawValue, schema: Self.schema(.listSessions), tally: nil,
          action: { [weak self] _ in .work(checking: false) { await self?.list() ?? Refusal.unreachable.output } }),
        RealtimeToolSpec(
          name: VoiceAgentSessionsTool.readSessions.rawValue, schema: Self.schema(.readSessions), tally: nil,
          action: { [weak self] arguments in
            let request = VoiceAgentReadRequest(arguments: arguments)
            return .work(checking: true) { await self?.readSessions(request) ?? Refusal.unreachable.output }
          }),
        RealtimeToolSpec(
          name: VoiceAgentSessionsTool.discussSession.rawValue, schema: Self.schema(.discussSession), tally: nil,
          action: { [weak self] arguments in
            let handle = RealtimeConversation.argument(arguments, VoiceAgentSessionsTool.handleField)
            return .work(checking: false) { await self?.discuss(handle: handle) ?? Refusal.unreachable.output }
          }),
        RealtimeToolSpec(
          name: VoiceAgentSessionsTool.askSession.rawValue, schema: Self.schema(.askSession), tally: .ask,
          action: { [weak self] arguments in
            let handle = RealtimeConversation.argument(arguments, VoiceAgentSessionsTool.handleField)
            let question = RealtimeConversation.argument(arguments, VoiceAgentSessionsTool.questionField)
            return .work(checking: true) {
              await self?.ask(handle: handle, question: question) ?? Refusal.unreachable.output
            }
          }),
        RealtimeToolSpec(
          name: VoiceAgentSessionsTool.checkOpenRequests.rawValue, schema: Self.schema(.checkOpenRequests),
          tally: nil,
          action: { [weak self] _ in
            .workAtTurn(checking: true) { turn in
              await self?.checkOpenRequests(at: turn) ?? Refusal.unreachable.output
            }
          }),
        RealtimeToolSpec(
          name: VoiceAgentSessionsTool.showPrompt.rawValue, schema: Self.schema(.showPrompt), tally: nil,
          action: { [weak self] arguments in
            let handle = RealtimeConversation.argument(arguments, VoiceAgentSessionsTool.handleField)
            let text = RealtimeConversation.argument(arguments, VoiceAgentSessionsTool.textField)
            return .workAndRead(checking: false) { turn in
              await self?.showPrompt(handle: handle, text: text, at: turn) ?? .output(Refusal.unreachable.output)
            }
          }),
        RealtimeToolSpec(
          name: VoiceAgentSessionsTool.sendPrompt.rawValue, schema: Self.schema(.sendPrompt), tally: .send,
          action: { [weak self] _ in
            .workAtTurn(checking: false) { turn in await self?.sendPrompt(at: turn) ?? Refusal.unreachable.output }
          }),
      ])
  }

  /// Not logged in, another login since ``prepare()``, the mode not offered, the owner's reason, or no opening list.
  func startRefusal() -> VoiceAgentWatch.Reason? {
    if let reason = appReason() { return reason }
    return opening == nil ? .disabled : nil
  }

  func endReason() -> VoiceAgentWatch.Reason? {
    if conversationChanged { return .sessionCleared }
    return appReason()
  }

  // MARK: - Tools

  private func list() async -> String {
    if case let .refused(output, code) = await refresh() {
      trace("voice-agent: list refused (\(code))")
      return output
    }
    if let refusal = blocked() {
      trace("voice-agent: list refused (\(refusal.code))")
      return refusal.output
    }
    trace("voice-agent: list \(count(rows.count, "session"))")
    return #"{"sessions":\#(VoiceAgentSessionList.text(rows))}"#
  }

  private func readSessions(_ request: VoiceAgentReadRequest) async -> String {
    let start = discussion.cuts
    if case let .refused(output, code) = await refresh() { return refusedRead(output, code) }
    let picked: [VoiceAgentSessionRow]
    switch request.target {
    case let .handles(given)?:
      let unknown = given.filter { handle in !rows.contains { $0.handle == handle } }
      guard unknown.isEmpty else { return refusedRead(Self.unknownHandles(unknown), "unknown-handle") }
      picked = given.compactMap { handle in rows.first { $0.handle == handle } }
    case let .filter(filter)?:
      picked = VoiceAgentSessionReads.pick(filter, from: rows)
      guard !picked.isEmpty else {
        let output = RealtimeConversation.toolError("No session matches the filter \(filter.rawValue).")
        return refusedRead(output, "no-match")
      }
    case nil:
      let output = RealtimeConversation.toolError("Give handles or a filter (finished, asks_owner).")
      return refusedRead(output, "arguments")
    }
    var answers: [(row: VoiceAgentSessionRow, turns: CompanionTurns)] = []
    for row in picked {
      if let refusal = blocked() { return refusedRead(refusal.output, refusal.code) }
      switch await backend.loadCompanionTurns(sessionId: row.sessionId, count: request.turns) {
      case let .turns(turns):
        // Checked at each answer: a failed read of a later session must not keep a conversation that holds the
        // left conversation's turns.
        if let refusal = blocked() { return refusedRead(refusal.output, refusal.code) }
        if let earlier = reads[row.sessionId], earlier.conversation != turns.conversation {
          return endForNewConversation()
        }
        answers.append((row, turns))
      case .outsideCatalog: return refusedRead(Self.unknownHandles([row.handle]), "unknown-handle")
      case .disabled: return refusedRead(Refusal.off.output, Refusal.off.code)
      case .loggedOut, .cancelled: return refusedRead(Refusal.unreachable.output, Refusal.unreachable.code)
      case .failed: return refusedRead(Refusal.turnsFailed.output, Refusal.turnsFailed.code)
      }
    }
    // Speech cut in while the turns were read: the conversation drops this result, so the model never gets these
    // turns. No read record (its mark would let the agent pick up a result it did not see) and no pointing.
    guard !discussion.overtaken(since: start) else {
      trace("voice-agent: read dropped (cut)")
      return VoiceAgentSessionReads.text(answers, count: request.turns)
    }
    for (row, turns) in answers {
      reads[row.sessionId] = VoiceAgentSessionRead(
        sessionId: row.sessionId, handle: row.handle, conversation: turns.conversation, readMark: turns.readMark,
        hadMessages: !turns.messages.isEmpty)
    }
    sessionReads += answers.count
    discussion.read(answers.map(\.row.sessionId))
    if case let .handles(given)? = request.target, given.count == 1, let only = answers.first, answers.count == 1 {
      point(at: only.row, since: start)
    } else {
      point(at: nil, since: start)
    }
    trace("voice-agent: read \(count(answers.count, "session")), \(sessionReads) reads in this conversation")
    return VoiceAgentSessionReads.text(answers, count: request.turns)
  }

  /// `discuss_session`: a session read in this conversation becomes the discussed one
  /// (`VoiceAgentSessionsHost+Discussion.swift`).
  private func discuss(handle: String?) async -> String {
    let start = discussion.cuts
    if case let .refused(output, code) = await refresh() {
      trace("voice-agent: discuss refused (\(code))")
      return output
    }
    if let refusal = blocked() {
      trace("voice-agent: discuss refused (\(refusal.code))")
      return refusal.output
    }
    guard let handle, let row = rows.first(where: { $0.handle == handle }) else {
      trace("voice-agent: discuss refused (unknown-handle)")
      return RealtimeConversation.toolError("Unknown handle. Use handles from the session list.")
    }
    guard reads[row.sessionId] != nil else {
      trace("voice-agent: discuss refused (not-read)")
      return RealtimeConversation.toolError(
        "Read this session first; then call \(VoiceAgentSessionsTool.discussSession.rawValue) again.")
    }
    guard !discussion.overtaken(since: start) else {
      trace("voice-agent: discuss dropped (cut)")
      return RealtimeConversation.toolError(
        "The user spoke over this call. Call \(VoiceAgentSessionsTool.discussSession.rawValue) again.")
    }
    point(at: row, since: start)
    trace("voice-agent: discuss")
    return RealtimeConversation.toolResult("The app shows this session as the one under discussion.")
  }

  private func ask(handle: String?, question: String?) async -> String {
    if case let .refused(output, code) = await refresh() {
      trace("voice-agent: question refused (\(code))")
      return output
    }
    guard let handle, let row = rows.first(where: { $0.handle == handle }) else {
      trace("voice-agent: question refused (unknown-handle)")
      return RealtimeConversation.toolError("Unknown handle. Use handles from the session list.")
    }
    guard let question else { return RealtimeConversation.toolError("The question is empty.") }
    guard questions < Self.questionCeiling else {
      trace("voice-agent: question refused (ceiling)")
      return Self.ceilingRefusal
    }
    if let refusal = blocked() {
      trace("voice-agent: question refused (\(refusal.code))")
      return refusal.output
    }
    questions += 1
    trace("voice-agent: question \(questions) of \(Self.questionCeiling)")
    let outcome = await backend.ask(sessionId: row.sessionId, question: question)
    if let refusal = blocked() {
      trace("voice-agent: question refused (\(refusal.code))")
      return refusal.output
    }
    switch outcome {
    case let .answer(answer): return RealtimeConversation.toolResult(answer.answer)
    case let outcome: return VoiceAgentToolText.ask(outcome)
    }
  }

  /// The refusal of a question past ``questionCeiling``.
  static var ceilingRefusal: String { RealtimeConversation.toolError(ceilingSentence) }
  static var ceilingSentence: String {
    "This conversation reached its limit of \(questionCeiling) questions about sessions. Tell the user."
  }

  // MARK: - Catalog

  enum Refreshed {
    case listed
    case refused(output: String, code: String)
  }

  /// Fixed sentences of a refused tool, catalog or turns read, with their `client.log` code.
  private enum Refusal {
    case off, unreachable, catalogFailed, turnsFailed, newConversation

    var code: String {
      switch self {
      case .off: "off"
      case .unreachable: "unreachable"
      case .catalogFailed: "catalog-failed"
      case .turnsFailed: "turns-failed"
      case .newConversation: "conversation-changed"
      }
    }

    @MainActor
    var output: String {
      switch self {
      case .off: RealtimeConversation.toolError("Reading sessions is turned off on the server. Tell the user.")
      case .unreachable: RealtimeConversation.toolError("The app cannot reach the sessions now.")
      case .catalogFailed:
        RealtimeConversation.toolError("The session list could not be read now. Tell the user it can be tried again.")
      case .turnsFailed:
        RealtimeConversation.toolError("The sessions could not be read now. Tell the user it can be tried again.")
      case .newConversation:
        RealtimeConversation.toolError("A session you read started a new conversation, so this conversation ends.")
      }
    }
  }

  /// Why a tool must not ask Rarog now: the conversation ended, a read session started a new conversation, the app or
  /// the owner gives an end reason (logout, another login, the mode not offered, ``ownerReason``), or ``prepare()``
  /// gave no opening list. The refusal is a fixed sentence with its `client.log` code; `nil` = the tool may ask. A
  /// tool checks it before every request and before its answer goes to the model, so a change while a request is in
  /// flight counts too.
  func blocked() -> (output: String, code: String)? {
    if ended { return (Refusal.unreachable.output, "ended") }
    if conversationChanged { return (Refusal.newConversation.output, Refusal.newConversation.code) }
    switch appReason() {
    case .disabled?: return (Refusal.off.output, VoiceAgentWatch.Reason.disabled.traceName)
    case let reason?: return (Refusal.unreachable.output, reason.traceName)
    case nil: return opening == nil ? (Refusal.unreachable.output, "not-started") : nil
    }
  }

  /// The catalog again before a tool, unless ``blocked()`` gives a reason.
  func refresh() async -> Refreshed {
    if let refusal = blocked() { return .refused(output: refusal.output, code: refusal.code) }
    return await loadRows()
  }

  /// The catalog, joined with the app's sessions into ``rows``. A read session whose conversation changed ends the
  /// conversation; an end while the catalog was read keeps nothing of it.
  private func loadRows() async -> Refreshed {
    let outcome = await backend.loadCompanionSessions()
    if ended { return .refused(output: Refusal.unreachable.output, code: "ended") }
    switch outcome {
    case let .sessions(catalog):
      let changed = catalog.contains { entry in reads[entry.id].map { $0.conversation != entry.conversation } ?? false }
      if changed { return .refused(output: endForNewConversation(), code: Refusal.newConversation.code) }
      rows = VoiceAgentSessionList.rows(catalog: catalog, state: backend.state, handles: &handles, now: now())
      conversations = Dictionary(catalog.map { ($0.id, $0.conversation) }, uniquingKeysWith: { first, _ in first })
      return .listed
    case .disabled: return .refused(output: Refusal.off.output, code: Refusal.off.code)
    case .loggedOut, .cancelled: return .refused(output: Refusal.unreachable.output, code: Refusal.unreachable.code)
    case .failed: return .refused(output: Refusal.catalogFailed.output, code: Refusal.catalogFailed.code)
    }
  }

  /// A read session started a new engine conversation (`/clear`, `/resume`, a server restart): what the model knows
  /// of it does not hold for the new one, so the conversation ends. A prompt that the server refused because its
  /// session writes another conversation ends it the same way (`VoiceAgentSessionsHost+Prompt.swift`).
  @discardableResult
  func endForNewConversation() -> String {
    conversationChanged = true
    trace("voice-agent: a read session changed its conversation")
    requestEndCheck?()
    return Refusal.newConversation.output
  }

  private func refusedRead(_ output: String, _ code: String) -> String {
    if code != Refusal.newConversation.code { trace("voice-agent: read refused (\(code))") }
    return output
  }

  private func appReason() -> VoiceAgentWatch.Reason? {
    let state = backend.state
    if state.auth != .loggedIn { return .loggedOut }
    if let login, backend.loginEpoch != login { return .serverChanged }
    if !state.companionSessionsOffered(sonioxAllowed: sonioxAllowed) { return .disabled }
    return ownerReason?()
  }

  private static func unknownHandles(_ handles: [String]) -> String {
    RealtimeConversation.toolError(
      "Unknown handle: \(handles.joined(separator: ", ")). Use handles from the session list.")
  }

  /// The schema of `tool` from `RealtimeInstructions.sessionsTools()`.
  private static func schema(_ tool: VoiceAgentSessionsTool) -> [String: Any] {
    RealtimeInstructions.sessionsTools().first { $0["name"] as? String == tool.rawValue } ?? [:]
  }

  func trace(_ line: String) { backend.trace(line, budget: .voiceAgent) }

  private func count(_ number: Int, _ noun: String) -> String { number == 1 ? "1 \(noun)" : "\(number) \(noun)s" }
}
