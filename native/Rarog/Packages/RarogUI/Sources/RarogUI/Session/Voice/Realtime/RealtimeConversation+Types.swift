import Foundation
import RarogContract

// Types of the voice conversation (`RealtimeConversation`): phases, end reasons, diagnostics, dependencies, the
// host's content and tools, event handlers. Owner: voice agent. Rules: `RealtimeConversation.swift`.

extension RealtimeConversation {
  enum Phase: Sendable, Equatable {
    case idle
    /// Klucz krótki, gniazdo, konfiguracja sesji, start audio.
    case connecting
    case listening
    /// Wypowiedź zamknięta, odpowiedź w drodze.
    case thinking
    case speaking
    /// The `ask_session` tool is running.
    case checkingSession
    case ended(End)
  }

  enum End: Sendable, Equatable {
    /// Zamknięcie z zewnątrz: „Zakończ”, `/clear`, zmiana sesji, tło, usunięcie klucza, wylogowanie…
    case closed
    /// Serwer nie ma klucza OpenAI.
    case keyMissing
    /// OpenAI odrzucił klucz serwera.
    case keyRejected
    /// Limit konta OpenAI (429 przy kluczu krótkim, `error` albo nieudana odpowiedź z kodem limitu).
    case openAILimit
    /// Serwer Raroga dławi pobieranie kluczy krótkich.
    case throttled
    /// Klucza krótkiego nie dało się pobrać (sieć, serwer).
    case unavailable
    /// Instrukcje ponad limit także po próbie z połową budżetu.
    case instructionsTooLong
    /// Błąd konfiguracji sesji po stronie OpenAI.
    case failed
    /// Gniazdo zamknięte przez drugą stronę albo sieć.
    case dropped
    case microphone(VoiceMicError)
    /// System przerwał audio (rozmowa telefoniczna, Siri, zmiana trasy).
    case audioInterrupted
    /// Soniox speech is off on the server, or its Soniox key does not work (404, `companion-speech-unconfigured`).
    case speechOff
    /// The Soniox speech key could not be fetched (network, server, Soniox) or does not fit the app.
    case speechUnavailable
    /// Soniox speech failed during the conversation (a dropped socket, an error frame, a refused key).
    case speechFailed
  }

  /// Zdarzenie diagnostyczne bez treści, do `client.log` (`RarogStore.trace`) przez ekran rozmowy.
  enum Diagnostic: Sendable, Equatable {
    /// From the end of the user's speech (VAD) to the start of the answer's playback, output latency included.
    case firstAudio(milliseconds: Int)
    /// Błąd serwera, który nie kończy rozmowy; sam kod.
    case serverError(code: String)
    /// Instrukcje ponad limit: druga próba z połową budżetu.
    case instructionsRetry
    /// `session.created` z innym modelem niż ten, który serwer Raroga związał z kluczem krótkim. Model ustawia
    /// serwer, ale klient z kluczem krótkim mógłby go nadpisać.
    case modelMismatch(expected: String, actual: String)
    /// Co przerwało audio: zdarzenie systemu z jego polami i trasa.
    case audioInterrupted(cause: String)
    /// Silnik audio wystartował od nowa po zmianie konfiguracji (rozmowa trwa).
    case audioRestarted(cause: String)
    /// The model `session.created` names (`nil`: the event names none).
    case session(model: String?)
    /// The audio engine runs: input port, sample rate and channels, output port (no device names).
    case audioStarted(format: String)
    /// The conversation got ready (`RealtimeConversation+Start.swift`), with the stage times from the tap.
    case ready(StartTimes)
    /// The audio engine did not start: the step and the system error code (`RealtimeAudioHandlers.startFailed`).
    case audioStartFailed(cause: String)
    /// Server VAD heard the start and the end of speech.
    case speechStarted
    case speechStopped
    /// The composer mic muted or unmuted the conversation (`RealtimeConversation+Mute.swift`).
    case muted
    case unmuted
    /// VAD heard speech over the answer end within the window: noise, the answer goes on
    /// (`RealtimeConversation+Noise.swift`).
    case noiseIgnored
    /// Tokens and price of one response (`RealtimeConversation+Usage.swift`).
    case response(UsageLine)
    /// End of the conversation with its reason, time, counters and total.
    case ended(EndSummary)
    /// Soniox speech: the first text of an answer item went to Soniox.
    case speechStart
    /// From the end of the user's speech (VAD) to the first PCM from Soniox.
    case speechFirstPCM(milliseconds: Int)
    /// Soniox finished the synthesis of an answer item.
    case speechEnd
    /// Speech over the answer stopped the synthesis of an answer item (Soniox `cancel`, or it never started).
    case speechCancel
    /// Soniox failed (`SonioxSpeech.Failure.logCode`); the conversation ends, except at the stream limit.
    case speechError(code: String)
    /// Characters, generated audio and price of the Soniox speech of one response.
    case speechResponse(number: Int, SpeechCount)

    var traceLine: String {
      switch self {
      case let .firstAudio(milliseconds): "voice-agent: first audio \(milliseconds) ms"
      case let .serverError(code): "voice-agent: server error \(code)"
      case .instructionsRetry: "voice-agent: instructions over the limit, retry with half the budget"
      case let .modelMismatch(expected, actual):
        "voice-agent: session model \(Self.name(actual)) differs from the key model \(Self.name(expected))"
      case let .audioInterrupted(cause): "voice-agent: audio ended by \(cause)"
      case let .audioRestarted(cause): "voice-agent: audio restarted after \(cause)"
      case let .session(model): "voice-agent: session \(model.map(Self.name) ?? "unknown")"
      case let .audioStarted(format): "voice-agent: audio started (\(format))"
      case let .ready(times): times.traceLine
      case let .audioStartFailed(cause): "voice-agent: audio start failed at \(cause)"
      case .speechStarted: "voice-agent: speech started"
      case .speechStopped: "voice-agent: speech stopped"
      case .muted: "voice-agent: muted"
      case .unmuted: "voice-agent: unmuted"
      case .noiseIgnored: "voice-agent: noise ignored"
      case let .response(line): line.traceLine
      case let .ended(summary): summary.traceLine
      case .speechStart: "voice-agent: tts start"
      case let .speechFirstPCM(milliseconds): "voice-agent: tts first pcm \(milliseconds) ms"
      case .speechEnd: "voice-agent: tts end"
      case .speechCancel: "voice-agent: tts cancel"
      case let .speechError(code): "voice-agent: tts error \(code)"
      case let .speechResponse(number, count): "voice-agent: response \(number) \(count.traceText)"
      }
    }

    /// A name from OpenAI (model, response status) for the log: name characters only, at most 64, so the field
    /// cannot carry other content.
    static func name(_ model: String) -> String {
      let allowed = model.unicodeScalars.prefix(64).filter {
        CharacterSet.alphanumerics.contains($0) || "-._".unicodeScalars.contains($0)
      }
      return String(String.UnicodeScalarView(allowed))
    }
  }

  struct Dependencies {
    var keys: any RealtimeEphemeralKeyProvider
    var socket: RealtimeSocketFactory
    var audio: any RealtimeAudio
    var scheduler: any VoiceScheduler
    var socketAuth: RealtimeEndpoint.SocketAuth
    /// Soniox speaks the answers (`RealtimeConversation+Speech.swift`); there is no OpenAI voice.
    var speech: Speech

    init(
      keys: any RealtimeEphemeralKeyProvider, socket: @escaping RealtimeSocketFactory, audio: any RealtimeAudio,
      scheduler: any VoiceScheduler, socketAuth: RealtimeEndpoint.SocketAuth = RealtimeEndpoint.socketAuth,
      speech: Speech
    ) {
      self.keys = keys
      self.socket = socket
      self.audio = audio
      self.scheduler = scheduler
      self.socketAuth = socketAuth
      self.speech = speech
    }

    /// Gniazdo produkcyjne (`RealtimeNetwork`); klucze, audio i zegar podaje ekran rozmowy.
    static func production(
      keys: any RealtimeEphemeralKeyProvider, audio: any RealtimeAudio, scheduler: any VoiceScheduler, speech: Speech
    ) -> Dependencies {
      Dependencies(keys: keys, socket: RealtimeNetwork.socket, audio: audio, scheduler: scheduler, speech: speech)
    }
  }

  /// What the conversation talks about and what the model can do in it, from its host (`VoiceAgentHost`): the
  /// instructions with the opening content, the content that arrives later, and the tools. The conversation knows
  /// no session, field or screen; the session screen's host is `VoiceAgentSessionHost`.
  struct Content {
    /// Character budget of the opening content; the conversation halves it once when OpenAI refuses the
    /// instructions as too long.
    var budget: Int
    /// The instructions of `session.update` with the opening content in `budget` characters. Every call starts the
    /// later content over from what it put in.
    var instructions: @MainActor (_ budget: Int) -> String
    /// The text of a system item with the content that is new since the instructions or the last update, sent after
    /// each closed utterance before the answer is ordered; `nil` = nothing new.
    var update: @MainActor () -> String?
    /// The tools in the order of the `session.update` schema.
    var tools: [RealtimeToolSpec]
  }

  struct Handlers {
    var phase: @MainActor (Phase) -> Void
    /// Server VAD heard speech start (`true`) or its end (`false`); the end of the conversation also gives `false`.
    var speech: @MainActor (Bool) -> Void
    /// Input and output levels, at most one event per ``RealtimeLevelMeter/interval``.
    var levels: @MainActor (RealtimeLevels) -> Void
    var diagnostic: @MainActor (Diagnostic) -> Void
  }
}

/// Where `show_prompt` put the prompt (`VoiceAgentDraft`); the conversation tells the model without the field
/// content.
enum RealtimePromptPlacement: Sendable, Equatable {
  /// The field was empty: the prompt stands alone in it.
  case alone
  /// The prompt stands on a new line under the user's text.
  case underUserText
  /// The previous prompt, untouched, stood alone in the field: the new one took its place.
  case replacedAlone
  /// The previous prompt, untouched, stood under the user's text: the new one took its place.
  case replacedUnderUserText
  /// The user edited the previous prompt: the new one goes on a new line under it, nothing removed.
  case underEditedPrompt
  /// Nothing written: the field is hidden or read-only; the reason goes to the model.
  case refused(reason: String)

  /// The prompt stands alone in the field, so a send takes only it (and the attachments).
  var alone: Bool { self == .alone || self == .replacedAlone }
}

/// What `show_prompt` did in the message field: where the prompt went, and whether attachments wait in the bar
/// (a send takes them too).
struct RealtimePromptShown: Sendable, Equatable {
  let placement: RealtimePromptPlacement
  let attachments: Bool

  init(placement: RealtimePromptPlacement, attachments: Bool = false) {
    self.placement = placement
    self.attachments = attachments
  }
}

/// One tool of a conversation host: its name and schema for `session.update`, the counter it adds to in the end line
/// of `client.log`, and what a call does.
struct RealtimeToolSpec {
  enum Tally: Sendable, Equatable {
    /// A question that checks content (`asks` in the end line).
    case ask
    /// A send of a prompt (`sends` in the end line).
    case send
  }

  let name: String
  /// The function schema (`type`, `name`, `description`, `parameters`) in `session.update`.
  let schema: [String: Any]
  let tally: Tally?
  /// What a call with these JSON arguments does. The conversation asks when the call comes (before speech over the
  /// answer may hold it), so it must have no effect; the effects live in the returned action, which the conversation
  /// performs once nothing holds the call.
  let action: @MainActor (_ arguments: String) -> RealtimeToolAction
}

/// What the conversation does with a tool call. The prompt pair keeps its rules in the conversation (the version,
/// a send only after an utterance that followed the prompt, once per prompt); the host gives the effects and the
/// words.
enum RealtimeToolAction {
  /// The result for the model at once (encoded result or error), e.g. a missing argument.
  case answer(String)
  /// Work that ends with the result for the model. `checking`: the phase is `checkingSession` while it runs,
  /// otherwise `thinking`.
  case work(checking: Bool, @MainActor () async -> String)
  /// Shows a prompt to the user with the next version.
  case showPrompt(@MainActor (_ version: Int) -> RealtimePromptOutcome)
  /// Sends the prompt of the last `showPrompt` with its version → the result for the model. `refusals`: the answers
  /// when nothing is sent.
  case sendPrompt(refusals: RealtimePromptRefusals, @MainActor (_ version: Int) async -> String)
}

/// What a `showPrompt` effect did, as the encoded result for the model.
enum RealtimePromptOutcome {
  /// The prompt stands where the user sees it; the send waits for the user's answer.
  case shown(String)
  /// Nothing shown; the prompt state does not change.
  case refused(String)
}

/// The host's encoded answers of a `sendPrompt` call that sends nothing.
struct RealtimePromptRefusals {
  /// No prompt was shown in this conversation.
  let noPrompt: String
  /// The last prompt no longer stands (sent, cleared, replaced).
  let promptGone: String
  /// The app lost the target since the start (logout, unpairing, another server).
  let unreachable: String
}
