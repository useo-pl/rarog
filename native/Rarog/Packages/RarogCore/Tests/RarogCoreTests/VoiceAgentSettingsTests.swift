import Foundation
@testable import RarogCore
import Testing

// Voice agent settings: the consent to a version of the text as the only way to turn it on, turning it off removes
// the consent, the own consent of the mode across sessions, the Soniox reading speed. The server keeps the OpenAI
// key, the model and the voice; the app does not know them.

@MainActor
@Suite("agent głosowy: zgoda i tempo czytania")
struct VoiceAgentSettingsTests {
  private func make(_ scratch: ScratchDefaults) -> VoiceAgentSettings {
    VoiceAgentSettings(preferences: VoiceAgentPreferences(defaults: scratch.defaults))
  }

  @Test("bez zgody wyłączone; zgoda włącza i przeżywa nowe ustawienia z tych samych preferencji")
  func consent() {
    let scratch = ScratchDefaults()
    let settings = make(scratch)
    #expect(!settings.enabled)
    #expect(scratch.defaults.object(forKey: VoiceAgentPreferences.consentKey) == nil)
    settings.acceptConsent()
    #expect(settings.enabled)
    #expect(scratch.defaults.integer(forKey: VoiceAgentPreferences.consentKey) == VoiceAgentSettings.consentVersion)
    #expect(make(scratch).enabled, "zgoda zapisana na urządzeniu")
  }

  @Test(
    "consent to an older text (1: key on the phone, 2: OpenAI only, 3: Soniox on some servers) is none at launch",
    arguments: [1, 2, 3])
  func oldConsent(stored: Int) {
    #expect(VoiceAgentSettings.consentVersion == 4)
    let scratch = ScratchDefaults()
    scratch.defaults.set(stored, forKey: VoiceAgentPreferences.consentKey)
    let settings = make(scratch)
    #expect(!settings.enabled)
    settings.acceptConsent()
    #expect(settings.enabled && scratch.defaults.integer(forKey: VoiceAgentPreferences.consentKey) == 4)
    #expect(make(scratch).enabled, "consent to version 4 survives new settings")
  }

  @Test("wyłączenie kasuje zgodę; ponowne włączenie wymaga zgody")
  func disable() {
    let scratch = ScratchDefaults()
    let settings = make(scratch)
    settings.acceptConsent()
    settings.disable()
    #expect(!settings.enabled)
    #expect(scratch.defaults.object(forKey: VoiceAgentPreferences.consentKey) == nil)
    #expect(!make(scratch).enabled)
  }

  @Test("the mode across sessions has its own consent: the voice agent's consent and the mode's leave each other alone")
  func sessionsConsent() {
    let scratch = ScratchDefaults()
    let settings = make(scratch)
    settings.acceptConsent()
    #expect(!settings.sessionsEnabled, "the voice agent's consent does not turn the mode on")
    settings.acceptSessionsConsent()
    #expect(settings.sessionsEnabled && settings.enabled)
    #expect(make(scratch).sessionsEnabled, "the mode's consent is stored on the device")
    settings.disable()
    #expect(!settings.enabled && settings.sessionsEnabled, "turning the voice agent off leaves the mode's consent")
    settings.acceptConsent()
    settings.withdrawSessionsConsent()
    #expect(!settings.sessionsEnabled && settings.enabled, "withdrawing the mode's consent leaves the voice agent's")
    #expect(!make(scratch).sessionsEnabled && make(scratch).enabled)
    #expect(scratch.defaults.object(forKey: VoiceAgentPreferences.sessionsConsentKey) == nil)
  }

  @Test("a consent to an older text of the mode across sessions is none at launch")
  func oldSessionsConsent() {
    let scratch = ScratchDefaults()
    let older = VoiceAgentSettings.sessionsConsentVersion - 1
    scratch.defaults.set(older, forKey: VoiceAgentPreferences.sessionsConsentKey)
    let settings = make(scratch)
    #expect(!settings.sessionsEnabled)
    settings.acceptSessionsConsent()
    #expect(make(scratch).sessionsEnabled)
  }

  @Test("no OpenAI voice choice: the keys are two consents and the reading speed; a stale stored voice stays unread")
  func noVoiceChoice() {
    // A local name: the source guard reads `.keys ==` as a comparison with the answer channel.
    let stored = VoiceAgentPreferences.keys
    #expect(
      stored == [
        VoiceAgentPreferences.consentKey, VoiceAgentPreferences.speechSpeedKey,
        VoiceAgentPreferences.sessionsConsentKey,
      ])
    let scratch = ScratchDefaults()
    scratch.defaults.set("cedar", forKey: "rarog.voiceAgent.voice")
    let settings = make(scratch)
    settings.acceptConsent()
    #expect(make(scratch).enabled && make(scratch).speechSpeed == 1.0)
    #expect(scratch.defaults.string(forKey: "rarog.voiceAgent.voice") == "cedar", "left alone, never read")
  }

  @Test("Soniox reading speed: 1.0 by default, a choice from the list is stored, others change nothing")
  func speechSpeed() {
    #expect(VoiceAgentSettings.speechSpeeds == [1.0, 1.1, 1.2, 1.3])
    #expect(VoiceAgentPreferences.keys.contains(VoiceAgentPreferences.speechSpeedKey))
    let scratch = ScratchDefaults()
    let settings = make(scratch)
    #expect(settings.speechSpeed == 1.0)
    #expect(scratch.defaults.object(forKey: VoiceAgentPreferences.speechSpeedKey) == nil)
    settings.choose(speechSpeed: 1.2)
    #expect(settings.speechSpeed == 1.2)
    #expect(make(scratch).speechSpeed == 1.2, "stored on the device")
    settings.choose(speechSpeed: 1.5)
    #expect(settings.speechSpeed == 1.2 && make(scratch).speechSpeed == 1.2, "outside the list: no change")
    scratch.defaults.set(0.9, forKey: VoiceAgentPreferences.speechSpeedKey)
    #expect(make(scratch).speechSpeed == 1.0, "a stored value outside the list reads as 1.0")
    let memory = VoiceAgentSettings.memory()
    memory.choose(speechSpeed: 1.3)
    #expect(memory.speechSpeed == 1.3)
  }

  @Test("magazyn: ustawienia w pamięci bez podpięcia, podpięte zastępują je")
  func attach() {
    let (store, _) = makeStore()
    #expect(!store.voiceAgent.enabled)
    let settings = VoiceAgentSettings.memory()
    store.attachVoiceAgent(settings)
    #expect(store.voiceAgent === settings)
  }
}
