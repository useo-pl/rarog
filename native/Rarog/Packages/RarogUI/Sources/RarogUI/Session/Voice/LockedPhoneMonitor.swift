import Foundation
import RarogCore

// The locked-phone monitor: around what records on the app's microphone it holds the server connection and writes
// the `client.log` lines that measure what lives in the background. Owner: voice agent. No UIKit here, so the rules
// run in the macOS tests (`LockedPhoneMonitorTests`); the app builds it through `live` and feeds it the scene.
//
// - What records comes from the app's one microphone (`DictationCenter.use`, read from the host itself). The monitor
//   starts no microphone, conversation or dictation; it only reads.
// - The hold: one rule, `evaluate()`, asks for the server connection while `LockedPhoneTrial.keeps(running:)` says
//   yes for what records, in the foreground too (there the tunnel's hold changes nothing), and lets go when it says
//   no: the recording ended (or its host went away), or the trial is off. It runs at every change the microphone
//   reports, at every scene change and at every heartbeat, and passes only a changed answer on.
// - The heartbeat: every ``heartbeatSeconds`` while the app is in the background and the hold stands. Each one asks
//   the server once (`server=online|offline`); while that question is out, the next heartbeat writes
//   `server=waiting` and asks nothing more. An answer writes its line only within the same background stay and
//   while the hold still stands, with what lives at that moment.
// - Lines, with the prefix of what records (`voice-agent` or `dictation`), never any content: the scene change while
//   something records (`<prefix>: background, trial on|off`, `<prefix>: foreground, trial on|off`, with the trial
//   on or off) and the heartbeat (`<prefix>: background <s> s: audio=… openai=… soniox=… server=…`, `<s>` =
//   seconds since the app left the foreground, at the moment of the line).

/// The locked-phone monitor around the app's microphone.
@MainActor
public final class LockedPhoneMonitor {
  /// Everything the monitor reads and does outside itself.
  struct Parts {
    /// The device's trial switch.
    var trial: LockedPhoneTrial
    /// What records now (the app: `DictationCenter.use`); `nil` = nothing runs.
    var use: @MainActor () -> MicrophoneUse?
    var scheduler: any VoiceScheduler
    /// Hold the server connection (`true`) or let it go (the app: `TunnelCoordinator.holdForVoice`).
    var holdServer: @MainActor (Bool) -> Void
    /// Whether the server answers now (the app: `RarogStore.serverAnswers()`).
    var serverAnswers: @MainActor () async -> Bool
    /// One `client.log` line (the app: `RarogStore.trace` on the voice agent budget).
    var trace: @MainActor (String) -> Void
  }

  /// Seconds between two heartbeats in the background.
  static let heartbeatSeconds: TimeInterval = 30

  private let parts: Parts
  private var background = false
  /// Counts background stays, so an answer from an earlier stay writes nothing in a later one.
  private var stay = 0
  private var backgroundSince: TimeInterval = 0
  private var held = false
  private var heartbeat: VoiceTimer?
  /// A server question is out.
  private var asking = false

  init(_ parts: Parts) {
    self.parts = parts
  }

  /// The app's scene phase. Only leaving the foreground and coming back count: the `inactive` step of a lock or an
  /// unlock changes nothing.
  public func scene(_ phase: ScenePhase) {
    let background = phase == .background
    guard background != self.background else { return }
    self.background = background
    if background {
      stay += 1
      backgroundSince = parts.scheduler.now
    }
    if let use = parts.use() {
      let place = background ? "background" : "foreground"
      parts.trace("\(Self.prefix(use.kind)): \(place), trial \(parts.trial.on ? "on" : "off")")
    }
    evaluate()
  }

  /// The one rule of the hold and the heartbeat; a repeat with the same answer changes nothing.
  func evaluate() {
    let hold = parts.trial.keeps(running: parts.use() != nil)
    if hold != held {
      held = hold
      parts.holdServer(hold)
    }
    if background, hold {
      guard heartbeat == nil else { return }
      heartbeat = parts.scheduler.schedule(after: Self.heartbeatSeconds) { [weak self] in self?.beat() }
    } else {
      heartbeat?.cancel()
      heartbeat = nil
    }
  }

  private func beat() {
    heartbeat = nil
    evaluate()
    guard background, held, let use = parts.use() else { return }
    guard !asking else {
      parts.trace(heartbeatLine(use, server: "waiting"))
      return
    }
    asking = true
    let stay = stay
    let ask = parts.serverAnswers
    Task { [weak self] in
      let answers = await ask()
      self?.answered(answers, stay: stay)
    }
  }

  private func answered(_ answers: Bool, stay: Int) {
    asking = false
    // The recording may have ended or the app come back while the question was out.
    let use = parts.use()
    guard background, stay == self.stay, parts.trial.keeps(running: use != nil), let use else { return }
    parts.trace(heartbeatLine(use, server: answers ? "online" : "offline"))
  }

  private func heartbeatLine(_ use: MicrophoneUse, server: String) -> String {
    func open(_ value: Bool) -> String { value ? "open" : "closed" }
    let seconds = Int((parts.scheduler.now - backgroundSince).rounded())
    return "\(Self.prefix(use.kind)): background \(seconds) s: audio=\(use.audio ? "running" : "stopped") "
      + "openai=\(open(use.openAI)) soniox=\(open(use.soniox)) server=\(server)"
  }

  private static func prefix(_ kind: MicrophoneUse.Kind) -> String {
    switch kind {
    case .conversation: "voice-agent"
    case .dictation: "dictation"
    }
  }
}
