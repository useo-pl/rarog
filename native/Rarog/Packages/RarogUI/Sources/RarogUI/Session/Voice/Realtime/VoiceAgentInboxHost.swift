import Foundation
import RarogContract
import RarogCore

// The voice conversation at one Inbox card: the conversation core's host (`VoiceAgentHost`) for the card's session.
// Owner: voice agent. The content and `ask_session` are the session screen's (`VoiceAgentSessionHost`: the session's
// transcript), with the card's prompt rules and prompt tool descriptions (`RealtimePromptField.inboxReply`). The
// prompt pair is the card's own: `show_prompt` is work whose result comes after the app read the prompt aloud
// (`RealtimeToolAction.workAndRead`), and `send_prompt` is work that learns the moment of its call
// (`RealtimeToolAction.workAtTurn`), so the lock of the voice send stands in the card's prompt block
// (`InboxPromptBlock`, kept by `VoiceAgentInboxConversation`), not in the core. The card's own end rules stand here
// (`VoiceAgentInboxWatch`), because a card has no message field to watch and leaves with the Inbox. The rules stand
// without a view, so the tests run on macOS.

/// The route to Rarog of a card's conversation: in the app the store, in the tests a fake.
@MainActor
protocol VoiceAgentInboxBackend: VoiceAgentBackend {
  /// The app state: the Inbox cards, the session's transcript and its snapshots, the login.
  var state: AppState { get }
  /// The next transcript stream of the session opens with a `transcript-snapshot` (`RarogStore.refreshTranscript`).
  func refreshTranscript(_ sessionId: String)
  /// The card's reply: an ordinary send of the person while the card still shows `turnId`
  /// (`RarogStore.replyFromInbox`).
  func replyFromInbox(_ text: String, to sessionId: String, turnId: String) async -> InboxReplyOutcome
  /// Deletes the outbox entry of a refused send whose text stands again where the person sees it
  /// (`RarogStore.discard`).
  func discard(_ entryId: UUID)
  /// A `client.log` line of a failure the app did not expect (`RarogStore.reportUnhandled`).
  func reportUnhandled(_ summary: String)
}

extension RarogStore: VoiceAgentInboxBackend {}

/// The reply fields of the Inbox screen as a card's conversation uses them (`InboxReplyHost` in the app): where the
/// prompt block's text goes back.
@MainActor
protocol VoiceAgentInboxField: AnyObject {
  /// The block's text goes on top of the reply field of `sessionId`'s card, with `note` under it, and the field
  /// writes the session's draft at once. `false`: that card's field is not on screen, nothing taken.
  func handBack(_ text: String, note: String?, noteIsError: Bool, into sessionId: String) -> Bool
  /// The outcome of a block's send whose block is gone: the text finds its way by the field's rule, as after ↑.
  func voiceReplyFinished(_ outcome: InboxReplyOutcome, text: String, sessionId: String)
}

/// Where the person is, for the end rules of a card's conversation.
struct VoiceAgentInboxPlace: Sendable, Equatable {
  /// The Inbox screen is the right column (the iPhone's top screen).
  var inboxOnScreen: Bool
  /// The session on screen instead (`RarogNavigation.selectedSessionId`), if any.
  var openedSession: String?
  var background: Bool
}

/// When the conversation of a card ends, counted from the app state at each change.
struct VoiceAgentInboxWatch: Sendable, Equatable {
  struct Input: Sendable, Equatable {
    /// The session screen's rules: login, server, the feature on, background, `/clear` and `/resume` in the transcript
    /// of the card's session. `selected` is the card's session, `fieldShown` true: the card replaces the field.
    var app: VoiceAgentWatch.Input
    var place: VoiceAgentInboxPlace
    /// The card still stands with the voice agent button (`AppState.inboxVoiceTarget`).
    var cardStands: Bool
  }

  let sessionId: String
  private var watch: VoiceAgentWatch

  init(sessionId: String, start: Input) {
    self.sessionId = sessionId
    watch = VoiceAgentWatch(sessionId: sessionId, start: start.app)
  }

  mutating func check(_ input: Input) -> VoiceAgentWatch.Reason? {
    if let reason = watch.check(input.app) { return reason }
    if !input.place.inboxOnScreen {
      // Another session on screen keeps the session screen's sentence; the card's own session or no session is the
      // Inbox left.
      if let opened = input.place.openedSession, opened != sessionId { return .sessionChanged }
      return .inboxLeft
    }
    if !input.cardStands { return .cardGone }
    return nil
  }
}

/// The host of one conversation at an Inbox card.
@MainActor
final class VoiceAgentInboxHost: VoiceAgentHost {
  let sessionId: String
  /// The app state for the end rules now; `nil` = no screen: the conversation does not start.
  var watchInput: (@MainActor () -> VoiceAgentInboxWatch.Input?)?
  /// The card's prompt block waits for the person's spoken word (the owner's block); `nil` = no block.
  var blockWaits: (@MainActor () -> Bool)?

  /// The card's session, as the app's list names it.
  var microphoneSubject: MicrophoneSubject { tools.microphoneSubject }
  var promptWaits: Bool { blockWaits?() ?? false }

  /// The session screen's host: the transcript as content and `ask_session`, with the card's prompt rules.
  private let tools: VoiceAgentSessionHost
  private let showPrompt: @MainActor (String?, RealtimeToolTurn) -> RealtimeToolResult
  private let sendPrompt: @MainActor (RealtimeToolTurn) async -> String
  private var watch: VoiceAgentInboxWatch?

  /// `showPrompt`: the prompt text (`nil`: empty) at the call's moment → the reading or a refusal; `sendPrompt`: the
  /// voice send at the call's moment → the result for the model.
  init(
    sessionId: String, backend: any VoiceAgentBackend,
    showPrompt: @escaping @MainActor (String?, RealtimeToolTurn) -> RealtimeToolResult,
    sendPrompt: @escaping @MainActor (RealtimeToolTurn) async -> String
  ) {
    self.sessionId = sessionId
    self.showPrompt = showPrompt
    self.sendPrompt = sendPrompt
    tools = VoiceAgentSessionHost(sessionId: sessionId, backend: backend)
    tools.promptField = .inboxReply
    // The session host's own end rules are not used: this host answers them.
    tools.watchInput = { nil }
  }

  /// The session screen's content with the card's prompt pair in place of the message field's.
  func content() -> RealtimeConversation.Content {
    var content = tools.content()
    let show = showPrompt
    let send = sendPrompt
    content.tools = content.tools.map { spec in
      switch spec.name {
      case RealtimeTool.showPrompt.rawValue:
        RealtimeToolSpec(
          name: spec.name, schema: spec.schema, tally: spec.tally,
          action: { arguments in
            let text = RealtimeConversation.argument(arguments, RealtimeTool.textField)
            return .workAndRead(checking: false) { turn in show(text, turn) }
          })
      case RealtimeTool.sendPrompt.rawValue:
        RealtimeToolSpec(
          name: spec.name, schema: spec.schema, tally: spec.tally,
          action: { _ in .workAtTurn(checking: false) { turn in await send(turn) } })
      default:
        spec
      }
    }
    return content
  }

  func startRefusal() -> VoiceAgentWatch.Reason? {
    guard let input = watchInput.flatMap({ $0() }) else { return .inboxLeft }
    var watch = VoiceAgentInboxWatch(sessionId: sessionId, start: input)
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
}
