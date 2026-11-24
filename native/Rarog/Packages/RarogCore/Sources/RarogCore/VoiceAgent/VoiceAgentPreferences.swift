import Foundation
import Synchronization

// Preferencje agenta głosowego na urządzeniu. Właściciel: agent głosowy.
//
// The consent (the version of the text agreed to), the consent of the mode across sessions (its own text and version)
// and the Soniox reading speed. They belong to the device, not to the server: logout, Forget Server and a new server
// do not clear them (like the dictation choice). The app keeps
// no OpenAI key and no model: the server has them. The voice is set on the server too (Soniox); a voice stored by
// an older build under `rarog.voiceAgent.voice` stays unread.

/// Odczyt i zapis preferencji pod kluczami `rarog.voiceAgent.*` (`UserDefaults` apki albo pamięć testu).
public final class VoiceAgentPreferences: Sendable {
  public static let consentKey = "rarog.voiceAgent.consent"
  /// The consent of the voice conversation across sessions: the version of its own text.
  public static let sessionsConsentKey = "rarog.voiceAgent.sessionsConsent"
  /// Soniox reading speed (`speed` of the Soniox start frame).
  public static let speechSpeedKey = "rarog.voiceAgent.speechSpeed"
  /// Wszystkie klucze — porządki testów UI.
  public static let keys = [consentKey, speechSpeedKey, sessionsConsentKey]

  /// `nil` = pamięć (testy, tryb testów UI). `nonisolated(unsafe)`: SDK nie oznacza `UserDefaults` jako `Sendable`,
  /// a według dokumentacji Apple jest bezpieczny wątkowo; pole jest stałe (jak w `DictationChoiceStore`).
  nonisolated(unsafe) private let defaults: UserDefaults?
  private let memory = Mutex<(consent: Int?, speechSpeed: Double?, sessionsConsent: Int?)>((nil, nil, nil))

  public init(defaults: UserDefaults) {
    self.defaults = defaults
  }

  private init() {
    defaults = nil
  }

  /// Preferencje w pamięci, nigdy w prawdziwych `UserDefaults`.
  public static func memory() -> VoiceAgentPreferences {
    VoiceAgentPreferences()
  }

  /// Wersja tekstu zgody, na który użytkownik się zgodził; `nil` = brak zgody.
  public var consent: Int? {
    get {
      guard let defaults else { return memory.withLock { $0.consent } }
      return defaults.object(forKey: Self.consentKey) as? Int
    }
    set {
      guard let defaults else { return memory.withLock { $0.consent = newValue } }
      if let newValue { defaults.set(newValue, forKey: Self.consentKey) } else {
        defaults.removeObject(forKey: Self.consentKey)
      }
    }
  }

  /// The version of the consent text of the mode across sessions the user agreed to; `nil` = no consent.
  public var sessionsConsent: Int? {
    get {
      guard let defaults else { return memory.withLock { $0.sessionsConsent } }
      return defaults.object(forKey: Self.sessionsConsentKey) as? Int
    }
    set {
      guard let defaults else { return memory.withLock { $0.sessionsConsent = newValue } }
      if let newValue { defaults.set(newValue, forKey: Self.sessionsConsentKey) } else {
        defaults.removeObject(forKey: Self.sessionsConsentKey)
      }
    }
  }

  /// The stored Soniox reading speed; `nil` = never chosen. `VoiceAgentSettings` checks it against its list.
  public var speechSpeed: Double? {
    get {
      guard let defaults else { return memory.withLock { $0.speechSpeed } }
      return defaults.object(forKey: Self.speechSpeedKey) as? Double
    }
    set {
      guard let defaults else { return memory.withLock { $0.speechSpeed = newValue } }
      if let newValue { defaults.set(newValue, forKey: Self.speechSpeedKey) } else {
        defaults.removeObject(forKey: Self.speechSpeedKey)
      }
    }
  }
}
