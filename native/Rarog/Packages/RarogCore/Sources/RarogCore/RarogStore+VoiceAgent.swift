import Foundation

// Agent głosowy przy magazynie. Właściciel: agent głosowy. Reguły ustawień:
// `VoiceAgent/VoiceAgentSettings.swift`; ekran: `RarogUI/Views/VoiceAgent/`.

extension RarogStore {
  /// Ustawienia z apki (produkcja: `UserDefaults`; testy: pamięć). Bez podpięcia magazyn ma ustawienia w pamięci.
  public func attachVoiceAgent(_ settings: VoiceAgentSettings) {
    voiceAgent = settings
  }
}
