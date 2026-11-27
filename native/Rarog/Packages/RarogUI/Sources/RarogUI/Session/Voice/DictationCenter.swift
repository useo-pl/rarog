import Foundation
import RarogContract

// The app's one microphone: the places that record (the message field, `ComposerDictation`; a project note,
// `NoteDictation`) and the voice conversation (`VoiceAgentSession`) take it over from each other through
// `DictationCenter`. The center also reports what records (`use`, read from the host itself: what lives, what it
// does now and what it is about), tells its observers of every claim and of every change a host reports, ends what
// records as the user's own end does (`endFromLockScreen()`) and sends a message-field dictation as Send during it
// does (`sendFromLockScreen()`); the locked-phone monitor (`LockedPhoneMonitor`) and the voice Live Activity (through
// `AppMicrophone`) use them. No UIKit here, so the rule also runs in the macOS tests. Owner: dictation.

/// What records on the app's microphone and what of it lives, from the host itself. A host reports a use only
/// while it runs: a conversation past its readiness gate, a message-field dictation whose microphone opened; a start
/// that still prepares reports none.
struct MicrophoneUse: Sendable, Equatable {
  enum Kind: Sendable, Equatable {
    case conversation
    case dictation
  }

  /// A microphone frame younger than this counts as audio that runs.
  static let frameWindow: TimeInterval = 2

  var kind: Kind
  /// A microphone frame reached the host within ``frameWindow`` seconds, by the host's own clock.
  var audio: Bool
  /// A conversation's Realtime socket to OpenAI is open; a dictation has none.
  var openAI: Bool
  /// The Soniox socket is open: a conversation's speech socket, or a dictation's stream on the Soniox route while it
  /// streams (not while it reconnects); the system route has none.
  var soniox: Bool
  /// What the recording does now.
  var phase: MicrophonePhase
  /// What the recording is about: never a prompt, dictated text or a question, only a session's project and name.
  var subject: MicrophoneSubject
}

/// What a recording on the app's microphone does now, in the words of the voice Live Activity.
public enum MicrophonePhase: Sendable, Equatable {
  /// The conversation connects or thinks.
  case working
  case listening
  case answering
  /// The voice agent reads a session to answer (`ask_session`).
  case reading
  /// A prompt the voice agent showed waits for the user's spoken word.
  case prompt
  case muted
  case dictating

  /// A conversation's phase from its status. `promptWaits`: a prompt the host showed waits for the user's spoken
  /// word; it stands where the conversation listens or hears, so a prompt still read aloud is answering. `muted`:
  /// the microphone drops speech, so wherever the conversation would listen it is muted, also where the status row
  /// keeps a prompt in the field or a send. The seconds of a session check and the speech flag of listening do not
  /// change the phase.
  static func conversation(
    _ indicator: VoiceAgentIndicator?, promptWaits: Bool, muted: Bool = false
  ) -> MicrophonePhase {
    switch indicator {
    case .listening?, .hearing?, .sent?: muted ? .muted : promptWaits ? .prompt : .listening
    case .promptInField?: muted ? .muted : .prompt
    case .answering?: .answering
    case .checkingSession?: .reading
    case .muted?: .muted
    case .connecting?, .thinking?, .ended?, .closed?, nil: .working
    }
  }
}

/// What a recording is about: the conversation across sessions while it discusses no single session, or one session
/// by its project and name as the app shows them, each `nil` where the app has none.
public enum MicrophoneSubject: Sendable, Equatable {
  case allSessions
  case session(project: String?, name: String?)

  /// `session` as the app's list shows it: its project and its name, each `nil` when empty; `nil` = the app does
  /// not have the session. Both go through the secret mask: the Lock Screen shows them to anyone who holds the phone,
  /// and a session's name can be text a prompt gave it.
  static func of(_ session: SessionSummary?) -> MicrophoneSubject {
    let project = RealtimeSecretMask.apply(session?.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let name = RealtimeSecretMask.apply(session?.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return .session(project: project.isEmpty ? nil : project, name: name.isEmpty ? nil : name)
  }
}

/// Miejsce, które nagrywa: pole wiadomości (`ComposerDictation`) albo notatka projektu (`NoteDictation`).
@MainActor
protocol DictationHost: AnyObject {
  /// Mikrofon przechodzi gdzie indziej: hipoteza staje się tekstem, nagranie w dół od razu.
  func handOff()
  /// What this host records; `nil` while it does not run (ended, a start that still prepares, or a host the
  /// background never keeps, such as a note).
  var microphoneUse: MicrophoneUse? { get }
  /// End as the user's own end does (the second tap, the end button); called only while ``microphoneUse`` is set.
  func endFromLockScreen()
  /// End the recording as Send during it does and send what the field holds then; a second call while that send runs
  /// gets the same operation, also after the recording ended. `nil`: nothing to send (the default: a conversation, a
  /// note).
  func sendFromLockScreen() -> Task<LockScreenSend, Never>?
  /// The center that holds this host. A host that reports a use calls ``DictationCenter/changed(_:)`` at each
  /// change of it, and at its deinit.
  func claimed(by center: DictationCenter)
}

extension DictationHost {
  var microphoneUse: MicrophoneUse? { nil }
  func endFromLockScreen() {}
  func sendFromLockScreen() -> Task<LockScreenSend, Never>? { nil }
  func claimed(by center: DictationCenter) {}
}

/// Mikrofon jest JEDEN na apkę: start w jednym miejscu przejmuje go od poprzedniego, a przejęcie
/// utrwala tekst poprzedniego miejsca.
@MainActor
final class DictationCenter {
  static let shared = DictationCenter()

  private weak var active: (any DictationHost)?
  private var observers: [@MainActor () -> Void] = []

  /// Adds an observer of every claim and every change a host reports. Observers stay for the center's life.
  func observe(_ observer: @escaping @MainActor () -> Void) {
    observers.append(observer)
  }

  func claim(_ next: any DictationHost) {
    if let previous = active, previous !== next { previous.handOff() }
    active = next
    next.claimed(by: self)
    notify()
  }

  /// A host's use changed (a start, an end). A host that no longer holds the microphone changes nothing; when no
  /// host holds it (the last one is being deallocated, so the weak reference already reads `nil`), the observers
  /// learn it too. The host is only compared, never kept.
  func changed(_ host: any DictationHost) {
    guard active == nil || host === active else { return }
    notify()
  }

  /// What records, read from the host itself; `nil` = nothing runs.
  var use: MicrophoneUse? { active?.microphoneUse }

  /// Ends what records as the user's own end. Returns what it ended; `nil` = nothing ran, nothing changes. No
  /// screen of the app calls it: it is the entry for an end button outside the app's screens.
  @discardableResult
  func endFromLockScreen() -> MicrophoneUse.Kind? {
    guard let active, let use = active.microphoneUse else { return nil }
    active.endFromLockScreen()
    return use.kind
  }

  /// Ends a message-field dictation as Send during it does and sends its field; `nil` = nothing to send (nothing
  /// records, a conversation). The holder answers itself, not its use: a second call while its send runs, also after
  /// its recording ended, gets the same operation. No screen of the app calls it: it is the entry for a Send button
  /// outside the app's screens.
  func sendFromLockScreen() -> Task<LockScreenSend, Never>? {
    active?.sendFromLockScreen()
  }

  private func notify() {
    for observer in observers { observer() }
  }
}

extension VoiceAgentSession: DictationHost {
  /// Dictation takes the microphone: the conversation ends.
  func handOff() { end() }

  /// The conversation's use while it is ready (past its readiness gate): its phase from its status and the host's
  /// waiting prompt, its subject from the host.
  var microphoneUse: MicrophoneUse? {
    guard isReady else { return nil }
    let live = liveParts
    return MicrophoneUse(
      kind: .conversation, audio: live.audio, openAI: live.openAI, soniox: live.soniox,
      phase: .conversation(indicator, promptWaits: host.promptWaits, muted: muted),
      subject: host.microphoneSubject)
  }

  /// Ends like the end button, with `live-activity` in the conversation's end line.
  func endFromLockScreen() { end(detail: "live-activity") }

  func claimed(by center: DictationCenter) { microphoneCenter = center }
}
