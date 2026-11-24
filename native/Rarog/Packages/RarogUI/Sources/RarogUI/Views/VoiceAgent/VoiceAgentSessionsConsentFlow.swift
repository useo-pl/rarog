import Foundation
import Observation
import RarogContract
import RarogCore

// The consent flow of the voice conversation across sessions from the session list button. Owner: voice agent.
// Without UIKit, so `swift test` checks it on macOS (`VoiceAgentSessionsConsentFlowTests`); the sheet that shows it:
// `VoiceAgentSessionsConsentSheet.swift`.
//
// - With the voice agent turned off the flow shows the voice agent's consent first, then the mode's; with it on, only
//   the mode's. Each consent is stored by its own accept button: "Agree and Turn On" turns the voice agent on, as on
//   the Settings page, even when the mode's consent is declined after it.
// - A mode's consent that stays stored while the voice agent is off (`VoiceAgentSettings.disable()` keeps it) is not
//   asked again: after the voice agent's consent the conversation starts.
// - The flow ends with a start exactly once, after the last consent; a decline or the close button ends it with no
//   start and stores nothing more.

@MainActor
@Observable
final class VoiceAgentSessionsConsentFlow {
  /// The consent page on screen.
  enum Step: Sendable, Equatable {
    /// The voice agent's consent (the Settings page's text).
    case voiceAgent
    /// The mode's own consent.
    case sessions
  }

  /// The page on screen; `nil` = the flow ended (the sheet closes).
  private(set) var step: Step?

  @ObservationIgnored private let settings: VoiceAgentSettings
  @ObservationIgnored private let start: @MainActor () -> Void

  /// `start`: the conversation's start, called once when the last consent is given.
  init(settings: VoiceAgentSettings, start: @escaping @MainActor () -> Void) {
    self.settings = settings
    self.start = start
    step = Self.firstStep(settings)
  }

  /// The first page the flow needs; `nil` when both consents are given.
  static func firstStep(_ settings: VoiceAgentSettings) -> Step? {
    if !settings.enabled { return .voiceAgent }
    if !settings.sessionsEnabled { return .sessions }
    return nil
  }

  /// "Agree and Turn On" on the voice agent's page: the voice agent is on; the mode's page follows unless its consent
  /// is stored.
  func acceptVoiceAgent() {
    guard step == .voiceAgent else { return }
    settings.acceptConsent()
    if settings.sessionsEnabled {
      finish()
    } else {
      step = .sessions
    }
  }

  /// "Agree and Start" on the mode's page: the consent is stored and the conversation starts.
  func acceptSessions() {
    guard step == .sessions else { return }
    settings.acceptSessionsConsent()
    finish()
  }

  /// Cancel on either page, the close button or the dismiss gesture: no start.
  func cancel() {
    step = nil
  }

  /// The page's text: the voice agent's consent with its own accept button, or the mode's with "Agree and Start".
  func content(language: CopyLanguage = .current) -> VoiceAgentConsentContent? {
    switch step {
    case .voiceAgent:
      VoiceAgentConsentContent(
        title: UICopy.voiceAgentConsentTitle(language: language),
        paragraphs: UICopy.voiceAgentConsentParagraphs(language: language),
        accept: UICopy.voiceAgentConsentAccept(language: language),
        cancel: UICopy.voiceAgentConsentCancel(language: language))
    case .sessions:
      VoiceAgentConsentContent(
        title: UICopy.voiceAgentSessionsConsentTitle(language: language),
        paragraphs: UICopy.voiceAgentSessionsConsentParagraphs(language: language),
        accept: UICopy.voiceAgentSessionsConsentStart(language: language),
        cancel: UICopy.voiceAgentConsentCancel(language: language))
    case nil:
      nil
    }
  }

  private func finish() {
    step = nil
    start()
  }
}
