import Foundation
import RarogContract
import RarogCore

// Rules of the voice conversation at a session without a view: when the entry button stands, when the conversation
// ends, and the text of the tool results for the model. Owner: voice agent. Tests: `VoiceAgentSessionTests`.

/// Przycisk rozmowy w rzędzie kontrolek pola wiadomości sesji Claude Code.
enum VoiceAgentEntry: Sendable, Equatable {
  /// No button: the feature is off in the app, the voice agent is not offered (``VoiceAgentAvailability``), a Codex
  /// session, or no transcript screen.
  case hidden
  /// Przycisk stoi, ale nie rusza: trwa dyktowanie (mikrofon jest jeden).
  case disabled
  case enabled

  static func make(
    state: AppState, sessionId: String, enabled: Bool, sonioxAllowed: Bool, dictating: Bool
  ) -> VoiceAgentEntry {
    guard enabled, VoiceAgentAvailability.offered(state: state, sonioxAllowed: sonioxAllowed),
      let session = state.sessions[sessionId], session.engine == nil, session.showsTranscript
    else { return .hidden }
    return dictating ? .disabled : .enabled
  }
}

/// ⌥⌘V at a session (`AppShortcut.voiceAgent`): what the shortcut does now, the same as a tap on the button.
enum VoiceAgentKey: Sendable, Equatable {
  /// No conversation: start one.
  case start
  /// Dictation records: the shortcut stands but does nothing, like the dimmed button.
  case unavailable
  /// A conversation runs: end it.
  case end

  /// `nil`: the shortcut is not registered, so the iPadOS menu bar does not name the voice agent where the server
  /// does not offer it; the shortcut sheet drops its row there by its own rule. `fieldShown`: a
  /// decision card hides the message field with the button, and a conversation does not start then; a running one
  /// can still be ended.
  static func make(entry: VoiceAgentEntry, active: Bool, fieldShown: Bool) -> VoiceAgentKey? {
    if active { return .end }
    guard fieldShown else { return nil }
    switch entry {
    case .hidden: return nil
    case .disabled: return .unavailable
    case .enabled: return .start
    }
  }
}

/// Whether the app offers the voice agent at all: the server announces it (`companionEnabled` in `/api/version`)
/// with Soniox speech (`companionSpeech`), and the build has Soniox (`RAROG_VOICE_SONIOX`). Soniox speaks every
/// answer and there is no OpenAI voice, so without Soniox there is no voice agent: an older server that announces
/// only `companionEnabled` gets none. One rule for the button (``VoiceAgentEntry``), ⌥⌘V, the Settings row
/// (`VoiceAgentSettingsModel.shown`) and the end of a running conversation (``VoiceAgentWatch``). A missing field or
/// no answer from the server yet reads as false. The rule itself stands in RarogCore
/// (`AppState.voiceAgentOffered(sonioxAllowed:)`), so the mode across sessions builds on the same definition.
enum VoiceAgentAvailability {
  static func offered(state: AppState, sonioxAllowed: Bool) -> Bool {
    state.voiceAgentOffered(sonioxAllowed: sonioxAllowed)
  }
}

/// Kiedy rozmowa się kończy, liczone ze stanu apki przy każdej zmianie (ekran rozmowy woła ``check(_:)``).
struct VoiceAgentWatch: Sendable, Equatable {
  /// Co z apki liczy się dla rozmowy; porównywalne, więc ekran przelicza je tylko przy zmianie.
  struct Input: Sendable, Equatable {
    var loggedIn: Bool
    /// Numer zalogowania (`RarogStore.loginEpoch`): wylogowanie, odpięcie i zmiana serwera go podnoszą.
    var login: Int
    /// The feature is on in the app and offered (``VoiceAgentAvailability``).
    var enabled: Bool
    var selected: String?
    var background: Bool
    /// The background keeps this conversation: it runs past its readiness gate and the background rule keeps it
    /// (`BackgroundRecording.keeps(running:)` with `VoiceAgentSession.isReady`). A start is never kept.
    var keepsInBackground: Bool
    /// The message field of the session screen is on screen. The status row and the button live in it, so
    /// without it the microphone would run without a visible indicator.
    var fieldShown: Bool
    /// Proces serwera, który ponumerował transkrypt (restart numeruje od nowa).
    var epoch: String?
    /// `seq` ostatniej granicy rozmowy silnika w transkrypcie (`transcript.repoint-clear`, `-resume`).
    var boundary: Int?

    init(
      loggedIn: Bool, login: Int, enabled: Bool, selected: String?, background: Bool,
      keepsInBackground: Bool = false, fieldShown: Bool = true, epoch: String?, boundary: Int?
    ) {
      self.loggedIn = loggedIn
      self.login = login
      self.enabled = enabled
      self.selected = selected
      self.background = background
      self.keepsInBackground = keepsInBackground
      self.fieldShown = fieldShown
      self.epoch = epoch
      self.boundary = boundary
    }

    init(
      state: AppState, sessionId: String, login: Int, enabled: Bool, sonioxAllowed: Bool, selected: String?,
      background: Bool, keepsInBackground: Bool = false, fieldShown: Bool = true
    ) {
      let transcript = state.transcripts[sessionId]
      self.init(
        loggedIn: state.auth == .loggedIn, login: login,
        enabled: enabled && VoiceAgentAvailability.offered(state: state, sonioxAllowed: sonioxAllowed),
        selected: selected, background: background, keepsInBackground: keepsInBackground, fieldShown: fieldShown,
        epoch: transcript?.messagesEpoch, boundary: transcript.flatMap { VoiceAgentWatch.boundary(in: $0.messages) })
    }
  }

  /// Dlaczego rozmowa się zamknęła (zdanie: `UICopy.voiceAgentClosed`).
  enum Reason: Sendable, Equatable {
    case loggedOut
    case serverChanged
    case sessionChanged
    /// `/clear` albo `/resume` w panelu: nowa rozmowa silnika, stara projekcja już nie ta.
    case sessionCleared
    case disabled
    case background
    /// The message field went away (state card, decision dock, no session): the status row and the button with it.
    case fieldHidden
    /// The app's stream to the server dropped (`AppState.global` offline): the conversation across sessions ends.
    case connectionLost
    /// The Inbox card of the conversation left the visible cards: removed, its session works, it stopped.
    case cardGone
    /// The Inbox card changed (another turn) while its conversation waited for the session's transcript.
    case cardChanged
    /// The Inbox left the screen (another screen, back to the list, the card's own session opened).
    case inboxLeft

    /// Name in the end line of `client.log`.
    var traceName: String {
      switch self {
      case .loggedOut: "logged-out"
      case .serverChanged: "server-changed"
      case .sessionChanged: "session-changed"
      case .sessionCleared: "session-cleared"
      case .disabled: "disabled"
      case .background: "background"
      case .fieldHidden: "field-hidden"
      case .connectionLost: "connection-lost"
      case .cardGone: "card-gone"
      case .cardChanged: "card-changed"
      case .inboxLeft: "inbox-left"
      }
    }
  }

  /// Kody zdań serwera, które znaczą nową rozmowę silnika w tym samym panelu (`server/src/herdr/jsonl-follow.ts`).
  static let boundaryCodes: Set<String> = ["transcript.repoint-clear", "transcript.repoint-resume"]

  let sessionId: String
  private var start: Input
  /// The first check (the start check) passed. Only a started conversation can be kept in the background: the start
  /// check refuses the background whatever ``Input/keepsInBackground`` says, so nothing opens the microphone there.
  private var started = false

  init(sessionId: String, start: Input) {
    self.sessionId = sessionId
    self.start = start
  }

  /// The end reason, or `nil` while the conversation goes on. The first call is the start check.
  mutating func check(_ input: Input) -> Reason? {
    let reason = reason(input)
    if reason == nil { started = true }
    return reason
  }

  private mutating func reason(_ input: Input) -> Reason? {
    if !input.loggedIn { return .loggedOut }
    if input.login != start.login { return .serverChanged }
    if input.selected != sessionId { return .sessionChanged }
    if !input.enabled { return .disabled }
    if input.background, !(started && input.keepsInBackground) { return .background }
    if !input.fieldShown { return .fieldHidden }
    // Restart serwera numeruje transkrypt od nowa: granica z nowej numeracji liczy się od niej.
    if input.epoch != start.epoch {
      start = input
      return nil
    }
    if let boundary = input.boundary, boundary > (start.boundary ?? Int.min) { return .sessionCleared }
    return nil
  }

  static func boundary(in messages: [TranscriptMessage]) -> Int? {
    messages.last { message in
      message.role == .system && message.blocks.contains { block in
        if case let .text(_, ref) = block, let code = ref?.code { return boundaryCodes.contains(code) }
        return false
      }
    }?.seq
  }
}

/// Wyniki narzędzi dla modelu. Po angielsku, jak instrukcja: model mówi w języku rozmówcy sam.
enum VoiceAgentToolText {
  static func ask(_ outcome: CompanionAskOutcome) -> String {
    guard case let .answer(answer) = outcome else { return error(refusal(outcome)) }
    var object: [String: Any] = ["answer": answer.answer, "found": answer.found]
    if let prompt = answer.prompt { object["prompt"] = prompt }
    return RealtimeClientEvent.encode(object)
  }

  /// The plain sentence of a question that brought no answer (`.answer` gives the sentence of a lost session).
  static func refusal(_ outcome: CompanionAskOutcome) -> String {
    switch outcome {
    case .limit:
      "The Claude subscription limit is reached, so the session cannot be checked now. Tell the user and do not retry."
    case .busy:
      "Another question about this session is still being checked. Wait for it, then ask again."
    case .disabled:
      "Questions about the session are turned off on the server. Tell the user."
    case .answer, .refused, .loggedOut, .cancelled:
      unreachableSentence
    case let .failed(code, _):
      timedOut(code)
        ? "Checking the session took too long. Tell the user it can be asked again."
        : "Checking the session failed. Tell the user it can be asked again."
    }
  }

  /// A failure code of the question route that means a timeout (the app's or the server's).
  static func timedOut(_ code: String?) -> Bool { code == "timeout" || code == "companion-timeout" }

  private static let unreachableSentence = "The app cannot reach the session now."

  /// The app lost the session (logout, unpairing, another server since the start): nothing was asked or sent.
  static var unreachable: String { error(unreachableSentence) }

  /// Why the message field does not take a send now, as a fixed name for the model. Never the sentence under the
  /// field: it can carry server text (the error detail of a session), and tool results go to OpenAI.
  static func closedField(state: AppState, sessionId: String) -> String {
    switch state.compat {
    case .tooOld, .protocolMismatch: return "the app and the server versions do not match"
    case .unknown, .ok: break
    }
    if state.sessionStale(sessionId) { return "the session list is not current" }
    guard let block = state.sendBlock(for: sessionId) else { return "the session does not take messages now" }
    return blockName(block)
  }

  /// `send_prompt`: the result of the send operation of the message field; `nil` = the field no longer holds the
  /// prompt, nothing taken.
  static func send(_ result: ComposerSendResult?) -> String {
    switch result {
    case nil:
      return error(promptGone)
    case .accepted(queued: false)?:
      return self.result("sent: the session received the message field")
    case .accepted(queued: true)?:
      return self.result("queued: the session takes the message field after its current turn")
    case .unconfirmed?:
      return error(
        "The send is not confirmed: it is not known whether the message arrived. It stays in the session's queue for "
          + "the user to retry by hand.")
    case let .refused(code, _)?:
      // The code and a fixed sentence only: the server's message can quote the field (an unknown command).
      return error(
        "The session refused the message (\(refusalName(code))). The text is back in the field as the user's, nothing "
          + "was sent. Tell the user the reason stands under the field.")
    case .stopped?:
      return error(
        "The user stopped the send before it went out, so nothing was sent. It stays in the session's queue for the "
          + "user to retry by hand.")
    case let .blocked(block)?:
      return error(
        "The session does not take messages right now (\(blockName(block))), so nothing was sent. The text is back in "
          + "the field.")
    case .notSent?:
      return error("The message was not sent. Tell the user.")
    case let .readOnly(reason)?:
      return error("The message field is read-only now: \(reason). Nothing was sent; tell the user.")
    case .appCommand?:
      return error(
        "The field holds an app command; not sent. The app ran the command itself, nothing went to the session.")
    case .attachmentsLoading?:
      return error("Attachments are still loading, so nothing was sent. Tell the user to wait and confirm again.")
    case .attachmentsOverLimit?:
      return error("The field has too many attachments for one message, so nothing was sent. Tell the user.")
    }
  }

  /// `send_prompt` while the field no longer holds the prompt of the last `show_prompt`.
  static let promptGone =
    "The message field no longer holds your prompt (it was sent, cleared or replaced), so nothing was sent. "
    + "Tell the user."

  /// The result of `show_prompt` for the model: where the prompt went and what a send takes, never the field text.
  static func shownText(_ shown: RealtimePromptShown) -> String {
    let place =
      switch shown.placement {
      case .alone, .refused: "prompt alone in the field"
      case .underUserText: "under the user's text"
      case .replacedAlone: "replaced your previous prompt, alone in the field"
      case .replacedUnderUserText: "replaced your previous prompt, under the user's text"
      case .underEditedPrompt: "under the user's text and your earlier edited prompt"
      }
    let attachments = shown.attachments ? "; attachments will go too" : ""
    let takes: String
    let ask: String
    if shown.placement.alone {
      takes = shown.attachments ? "A send takes this prompt and the attachments." : "A send takes only this prompt."
      ask =
        shown.attachments
        ? "Read the prompt aloud, say that the attachments go with it, and ask whether to send it."
        : "Read the prompt aloud and ask whether to send it."
    } else {
      takes =
        "A send takes the whole field, the user's text above the prompt too"
        + (shown.attachments ? ", and the attachments." : ".")
      ask = "Read the prompt aloud, say what else goes with it, and ask whether to send it."
    }
    return "The prompt is in the user's message field (\(place)\(attachments)). \(takes) \(ask)"
  }

  /// The refusal code of the server when it is an identifier (`bad-request`), otherwise a fixed name.
  static func refusalName(_ code: String?) -> String {
    guard let code, (1...64).contains(code.count),
      code.allSatisfy({ ($0.isASCII && ($0.isLowercase || $0.isNumber)) || $0 == "-" || $0 == "_" || $0 == "." })
    else { return "unknown code" }
    return code
  }

  /// Name of the reason a session does not take messages, without content.
  static func blockName(_ block: SendBlock) -> String {
    switch block {
    case .codex: "Codex session"
    case .unsupported: "unsupported session"
    case .outOfScope: "session out of scope"
    case .herdrUnavailable: "terminal unavailable"
    case .herdrReadOnly: "terminal read-only"
    case .decisionPending: "a permission or a question waits"
    case .starting: "the agent is starting"
    case let .stateCard(state): "session \(state.rawValue)"
    }
  }

  private static func error(_ message: String) -> String { RealtimeClientEvent.encode(["error": message]) }
  private static func result(_ message: String) -> String { RealtimeClientEvent.encode(["result": message]) }
}
