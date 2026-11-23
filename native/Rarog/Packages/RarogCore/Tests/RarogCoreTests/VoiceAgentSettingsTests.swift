import Foundation
@testable import RarogCore
import Testing

// Ustawienia agenta głosowego: zgoda w wersji tekstu jako jedyna droga do włączenia,
// wyłączenie kasuje zgodę, tempo czytania Soniox. Klucz OpenAI, model i głos trzyma serwer; apka ich nie zna.

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

  @Test("no OpenAI voice choice: the keys are the consent and the reading speed; a stale stored voice changes nothing")
  func noVoiceChoice() {
    // A local name: the source guard reads `.keys ==` as a comparison with the answer channel.
    let stored = VoiceAgentPreferences.keys
    #expect(stored == [VoiceAgentPreferences.consentKey, VoiceAgentPreferences.speechSpeedKey])
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
